// OA-09 考勤月报（docs/OA.md 第 12 节；需求文档四（五））：按 OA-08 的每日结算结果汇总每人一个月。
//   · 后台「考勤设置 → 考勤月报」：人事看本店全员、可按部门筛；部门负责人只看本部门。导出 Excel（记审计）。
//   · 员工「我的考勤」顶上的本月汇总（attendance-daily.ts 的 /api/oa/me/attendance 调 staffMonthStats）。
//   · OA-13：出差天数（结果为出差）、请假（考勤覆盖这个月的半天，按假种）、加班（通过的加班单按开始时间所在的月份，分工作日 / 休息日 / 节假日）；
//     实际出勤不算整天请假。这个月只有加班、请假、没有结算过排班的本店员工也列出来。只读，不加锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { departmentOfPosition, EMPTY_MONTH_STATS, MONTH_STAT_COLUMNS, monthStatValue, OVERTIME_KINDS, type AttendanceMonth, type AttendanceMonthRow, type AttendanceMonthStats } from '@shared/oa';
import { can } from '@shared/permissions';
import { ORG_DEPARTMENTS, type OrgDepartment, type PositionKey } from '@shared/positions';
import { shiftDate } from '@shared/labels';
import type { Db, Fragment } from '../../db';
import { guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import { attachment } from '../../lib/csv';
import type { Actor, Deps } from '../../lib/context';
import { storeEmployee } from './attendance-setup';
import { currentStoreId } from '../../lib/store-context';
import { parse } from '../../lib/validate';
import { buildXlsx } from '../../lib/xlsx';
import { localMinute } from './punches';
import { deptFilter } from './schedules';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式应为 YYYY-MM')
  .optional();

/** 这个月的第一天与最后一天 */
export function monthRange(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return [`${month}-01`, shiftDate(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1)];
}

/** 某个部门的员工（s 是 staff 表） */
function inDepartment(db: Db, dept: OrgDepartment): Fragment {
  if (dept === 'company') return db`s.position = 'president'`;
  if (dept === 'gmo') return db`s.position = 'gmo'`;
  return db`(s.position = ${`${dept}.lead`} OR s.position = ${`${dept}.staff`})`;
}

type StatRow = AttendanceMonthStats & { staffId: number; staffName: string; employeeNo: string | null; position: PositionKey | null };
type DailyStats = Omit<AttendanceMonthStats, 'leaveHalves' | 'overtimeWorkdayMinutes' | 'overtimeRestMinutes' | 'overtimeHolidayMinutes'>;
type Extras = Pick<AttendanceMonthStats, 'leaveHalves' | 'overtimeWorkdayMinutes' | 'overtimeRestMinutes' | 'overtimeHolidayMinutes'> & { leave: { name: string; halves: number }[] };
const NO_EXTRAS: Extras = { leaveHalves: 0, overtimeWorkdayMinutes: 0, overtimeRestMinutes: 0, overtimeHolidayMinutes: 0, leave: [] };

/**
 * OA-13：几位员工这个月的请假（按考勤覆盖，按假种）与加班（通过的加班单，按开始时间所在的月份）。
 * storeId：门店的月报只算在这家门店提交的单（一人挂几家门店时不重复算到别家）；本人的汇总不限门店
 */
async function extrasOf(db: Db, staffIds: number[], month: string, storeId: number | null): Promise<Map<number, Extras>> {
  const out = new Map<number, Extras>();
  if (!staffIds.length) return out;
  const [from, to] = monthRange(month);
  const get = (id: number) => out.get(id) ?? (out.set(id, { ...NO_EXTRAS, leave: [] }), out.get(id)!);
  const leave = await db<{ staffId: number; name: string; halves: number }[]>`
    SELECT c.staff_id, t.name, sum(c.halves)::int AS halves
    FROM oa_attendance_covers c JOIN oa_leave_types t ON t.id = c.leave_type_id JOIN oa_approvals a ON a.id = c.approval_id
    WHERE c.kind = 'leave' AND c.staff_id IN ${db(staffIds)} AND c.work_date BETWEEN ${from} AND ${to} ${storeId === null ? db`` : db`AND a.store_id = ${storeId}`}
    GROUP BY c.staff_id, t.id, t.name, t.sort
    HAVING sum(c.halves) > 0
    ORDER BY c.staff_id, t.sort, t.id`;
  for (const l of leave) {
    const e = get(Number(l.staffId));
    e.leave.push({ name: l.name, halves: l.halves });
    e.leaveHalves += l.halves;
  }
  const overtime = await db<{ staffId: number; kind: string; minutes: number }[]>`
    SELECT applicant_id AS staff_id, form->>'kind' AS kind, sum((form->>'minutes')::int)::int AS minutes
    FROM oa_approvals
    WHERE template_code = 'overtime' AND status = 'approved' AND applicant_id IN ${db(staffIds)} AND left(form->>'start', 7) = ${month}
      ${storeId === null ? db`` : db`AND store_id = ${storeId}`}
    GROUP BY applicant_id, form->>'kind'`;
  for (const o of overtime) {
    const e = get(Number(o.staffId));
    if (o.kind === OVERTIME_KINDS.holiday) e.overtimeHolidayMinutes += o.minutes;
    else if (o.kind === OVERTIME_KINDS.rest) e.overtimeRestMinutes += o.minutes;
    else e.overtimeWorkdayMinutes += o.minutes;
  }
  return out;
}

/** 按员工汇总（where 里能用 d = oa_attendance_daily、s = staff） */
async function aggregate(db: Db, where: Fragment): Promise<(DailyStats & Omit<StatRow, keyof AttendanceMonthStats>)[]> {
  const rows = await db<(DailyStats & Omit<StatRow, keyof AttendanceMonthStats>)[]>`
    SELECT d.staff_id, s.display_name AS staff_name, p.emp_no AS employee_no, s.position,
           count(DISTINCT d.business_date)::int AS scheduled_days,
           -- 出差算出勤（不管那天的外勤算不算）；其余的整天请假、旷工、外勤定为不算出勤的不算
           count(DISTINCT d.business_date) FILTER (WHERE d.status = 'trip' OR (d.status NOT IN ('absent', 'leave') AND NOT (d.outwork AND NOT d.outwork_counted)))::int AS attended_days,
           count(*) FILTER (WHERE d.late_minutes > 0)::int AS late_count,
           COALESCE(sum(d.late_minutes), 0)::int AS late_minutes,
           count(*) FILTER (WHERE d.early_minutes > 0)::int AS early_count,
           COALESCE(sum(d.early_minutes), 0)::int AS early_minutes,
           COALESCE(sum(CASE WHEN d.status = 'absent' THEN 0 ELSE d.missing_in::int + d.missing_out::int END), 0)::int AS missing_count,
           count(*) FILTER (WHERE d.status = 'absent')::int AS absent_count,
           count(*) FILTER (WHERE d.outwork)::int AS outwork_count,
           count(DISTINCT d.business_date) FILTER (WHERE d.status = 'trip')::int AS trip_days
    FROM oa_attendance_daily d
    JOIN staff s ON s.id = d.staff_id
    LEFT JOIN staff_profiles p ON p.staff_id = d.staff_id
    WHERE ${where}
    GROUP BY d.staff_id, s.display_name, p.emp_no, s.position, s.id
    ORDER BY s.id`;
  return rows.map((r) => ({ ...r, staffId: Number(r.staffId) }));
}

/** 本人一个月的汇总（各门店的都算，同「我的考勤」） */
export async function staffMonthStats(db: Db, staffId: number, month: string): Promise<AttendanceMonthStats> {
  const [from, to] = monthRange(month);
  const [r] = await aggregate(db, db`d.staff_id = ${staffId} AND d.business_date BETWEEN ${from} AND ${to}`);
  const { leave: _l, ...extras } = (await extrasOf(db, [staffId], month, null)).get(staffId) ?? NO_EXTRAS;
  if (!r) return { ...EMPTY_MONTH_STATS, ...extras };
  const { staffId: _s, staffName: _n, employeeNo: _e, position: _p, ...stats } = r;
  return { ...stats, ...extras };
}

const deptName = (key: string) => ORG_DEPARTMENTS.find((d) => d.key === key)?.name ?? '';

const MonthQuery = z.object({
  month: monthSchema,
  dept: z.enum(ORG_DEPARTMENTS.map((d) => d.key) as [OrgDepartment, ...OrgDepartment[]]).optional(),
});

async function loadMonth(db: Db, deps: Deps, actor: Actor, q: z.infer<typeof MonthQuery>): Promise<AttendanceMonth> {
  const month = q.month ?? localMinute(new Date(), deps.config.timezone).date.slice(0, 7);
  const [from, to] = monthRange(month);
  const all = can(actor, 'hr.attendance');
  const own = departmentOfPosition(actor.position);
  const departments = all ? ORG_DEPARTMENTS.map((d) => ({ key: d.key, name: d.name })) : own ? [{ key: own, name: deptName(own) }] : [];
  const scope = db`${deptFilter(db, actor)} ${q.dept ? db`AND ${inDepartment(db, q.dept)}` : db``}`;
  const store = currentStoreId();
  const daily = await aggregate(db, db`d.store_id = ${store} AND d.business_date BETWEEN ${from} AND ${to} AND ${scope}`);
  // 这个月只有加班、请假（没有结算过本店排班）的本店员工也列出来
  const others = await db<Omit<StatRow, keyof AttendanceMonthStats>[]>`
    SELECT s.id AS staff_id, s.display_name AS staff_name, p.emp_no AS employee_no, s.position
    FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
    WHERE ${storeEmployee(db)} AND ${scope} AND NOT (s.id = ANY(${daily.map((r) => r.staffId)}::bigint[]))
      AND (EXISTS (SELECT 1 FROM oa_approvals a WHERE a.applicant_id = s.id AND a.store_id = ${store} AND a.template_code = 'overtime' AND a.status = 'approved'
                     AND left(a.form->>'start', 7) = ${month})
           OR EXISTS (SELECT 1 FROM oa_attendance_covers c JOIN oa_approvals a ON a.id = c.approval_id
                      WHERE c.staff_id = s.id AND a.store_id = ${store} AND c.kind = 'leave' AND c.halves > 0 AND c.work_date BETWEEN ${from} AND ${to}))
    ORDER BY s.id`;
  const base = [
    ...daily,
    ...others.map((o) => {
      const { leaveHalves: _l, overtimeWorkdayMinutes: _w, overtimeRestMinutes: _r, overtimeHolidayMinutes: _h, ...empty } = EMPTY_MONTH_STATS;
      return { ...empty, ...o, staffId: Number(o.staffId) };
    }),
  ].sort((a, b) => a.staffId - b.staffId);
  const extras = await extrasOf(
    db,
    base.map((r) => r.staffId),
    month,
    store,
  );
  return {
    month,
    departments,
    rows: base.map(({ position, ...r }): AttendanceMonthRow => ({ ...r, ...(extras.get(r.staffId) ?? NO_EXTRAS), department: deptName(departmentOfPosition(position) ?? '') })),
  };
}

export function registerOaAttendanceMonthlyRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const view = guardAny('hr.attendance', 'hr.attendanceDept');

  app.get('/api/oa/attendance/monthly', { preHandler: view }, async (req): Promise<AttendanceMonth> => loadMonth(sql, deps, req.actor, parse(MonthQuery, req.query ?? {})));

  app.get('/api/oa/attendance/monthly.xlsx', { preHandler: view }, async (req, reply) => {
    const q = parse(MonthQuery, req.query ?? {});
    const m = await loadMonth(sql, deps, req.actor, q);
    // 请假明细按假种各一列（这个月有人请过的假种）
    const leaveNames = [...new Set(m.rows.flatMap((r) => r.leave.map((l) => l.name)))];
    const buffer = buildXlsx({
      name: `考勤月报 ${m.month}`,
      columns: [
        { header: '工号', width: 10 },
        { header: '姓名', width: 12 },
        { header: '部门', width: 14 },
        ...MONTH_STAT_COLUMNS.map((c) => ({ header: c.label, width: 12 })),
        ...leaveNames.map((n) => ({ header: `${n}（天）`, width: 10 })),
      ],
      rows: m.rows.map((r) => [
        r.employeeNo ?? '',
        r.staffName,
        r.department,
        ...MONTH_STAT_COLUMNS.map((c) => monthStatValue(c, r)),
        ...leaveNames.map((n) => (r.leave.find((l) => l.name === n)?.halves ?? 0) / 2),
      ]),
    });
    await writeAudit(sql, {
      staffId: req.actor.id,
      action: 'export',
      targetType: 'oa_attendance_monthly',
      detail: { month: m.month, dept: q.dept ?? null, count: m.rows.length },
      ip: req.ip,
    });
    attachment(reply, `考勤月报_${m.month}${q.dept ? `_${deptName(q.dept)}` : ''}.xlsx`, XLSX_TYPE);
    return reply.send(buffer);
  });
}
