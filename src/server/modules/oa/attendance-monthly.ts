// OA-09 考勤月报（docs/OA.md 第 12 节；需求文档四（五））：按 OA-08 的每日结算结果汇总每人一个月。
//   · 后台「考勤设置 → 考勤月报」：人事看本店全员、可按部门筛；部门负责人只看本部门。导出 Excel（记审计）。
//   · 员工「我的考勤」顶上的本月汇总（attendance-daily.ts 的 /api/oa/me/attendance 调 staffMonthStats）。
//   · 加班时长与请假明细要等 OA-13 的审批联动，那时加列。只读，不加锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { departmentOfPosition, EMPTY_MONTH_STATS, MONTH_STAT_COLUMNS, type AttendanceMonth, type AttendanceMonthRow, type AttendanceMonthStats } from '@shared/oa';
import { can } from '@shared/permissions';
import { ORG_DEPARTMENTS, type OrgDepartment, type PositionKey } from '@shared/positions';
import { shiftDate } from '@shared/labels';
import type { Db, Fragment } from '../../db';
import { guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import { attachment } from '../../lib/csv';
import type { Actor, Deps } from '../../lib/context';
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

/** 按员工汇总（where 里能用 d = oa_attendance_daily、s = staff） */
async function aggregate(db: Db, where: Fragment): Promise<StatRow[]> {
  const rows = await db<StatRow[]>`
    SELECT d.staff_id, s.display_name AS staff_name, p.emp_no AS employee_no, s.position,
           count(DISTINCT d.business_date)::int AS scheduled_days,
           count(DISTINCT d.business_date) FILTER (WHERE d.status <> 'absent' AND NOT (d.outwork AND NOT d.outwork_counted))::int AS attended_days,
           count(*) FILTER (WHERE d.late_minutes > 0)::int AS late_count,
           COALESCE(sum(d.late_minutes), 0)::int AS late_minutes,
           count(*) FILTER (WHERE d.early_minutes > 0)::int AS early_count,
           COALESCE(sum(d.early_minutes), 0)::int AS early_minutes,
           COALESCE(sum(CASE WHEN d.status = 'absent' THEN 0 ELSE d.missing_in::int + d.missing_out::int END), 0)::int AS missing_count,
           count(*) FILTER (WHERE d.status = 'absent')::int AS absent_count,
           count(*) FILTER (WHERE d.outwork)::int AS outwork_count
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
  if (!r) return { ...EMPTY_MONTH_STATS };
  const { staffId: _s, staffName: _n, employeeNo: _e, position: _p, ...stats } = r;
  return stats;
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
  const rows = await aggregate(
    db,
    db`d.store_id = ${currentStoreId()} AND d.business_date BETWEEN ${from} AND ${to} AND ${deptFilter(db, actor)}
       ${q.dept ? db`AND ${inDepartment(db, q.dept)}` : db``}`,
  );
  return {
    month,
    departments,
    rows: rows.map(({ position, ...r }): AttendanceMonthRow => ({ ...r, department: deptName(departmentOfPosition(position) ?? '') })),
  };
}

export function registerOaAttendanceMonthlyRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const view = guardAny('hr.attendance', 'hr.attendanceDept');

  app.get('/api/oa/attendance/monthly', { preHandler: view }, async (req): Promise<AttendanceMonth> => loadMonth(sql, deps, req.actor, parse(MonthQuery, req.query ?? {})));

  app.get('/api/oa/attendance/monthly.xlsx', { preHandler: view }, async (req, reply) => {
    const q = parse(MonthQuery, req.query ?? {});
    const m = await loadMonth(sql, deps, req.actor, q);
    const buffer = buildXlsx({
      name: `考勤月报 ${m.month}`,
      columns: [{ header: '工号', width: 10 }, { header: '姓名', width: 12 }, { header: '部门', width: 14 }, ...MONTH_STAT_COLUMNS.map((c) => ({ header: c.label, width: 12 }))],
      rows: m.rows.map((r) => [r.employeeNo ?? '', r.staffName, r.department, ...MONTH_STAT_COLUMNS.map((c) => r[c.key])]),
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
