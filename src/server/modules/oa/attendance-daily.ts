// OA-08 考勤结算与异常（docs/OA.md 第 11 节；需求文档四（五））。
//   · 每条排班在下班窗口结束以后结算成一条 oa_attendance_daily：按 OA-06 的有效卡（上班第一次、下班最后一次）算
//     旷工 / 缺上班卡 / 缺下班卡 / 迟到 / 早退 / 正常，标外勤、人脸待人工核对。
//   · 后台任务每 10 分钟看最近 3 天：还没结算的、结算以后又有新打卡的重新结算（覆盖文档的 02:00 跑前一天、04:00 补跑跨天班）；
//     人事也可以对某一天「重新结算」。重新结算只重写计算出来的那几列，人事对外勤的决定保留。
//   · 第一次算成异常给员工发「打卡异常」站内通知（attendance_exception）。
//   · 后台「考勤设置 → 考勤结果」：按日期看、只看异常、按考勤组筛；外勤「算出勤 / 不算出勤」；部门负责人只看本部门。
//   · 员工「办公 → 我的考勤」：本人一个月。
//   · OA-13：审批通过的考勤覆盖（oa_attendance_covers）。出差那天记「出差」；请假整天（或上午、下午都有）记「请假」，
//     只有上午的不判上班这一头（迟到、缺上班卡），只有下午的不判下班这一头（早退、缺下班卡）。审批通过时当场对覆盖的日子重新结算（resettleStaffDays）。
// 加锁（docs/LOCKING.md「考勤结算」）：员工的考勤锁（lockStaffAttendance，与打卡、保存排班串行）→ 这位员工的结果行。

import { every } from '../../lib/throttle';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { attendanceIssues, punchWindows, type AttendanceCover, type AttendanceDailyRow, type AttendanceDay, type AttendanceStatus, type MyAttendance, type OaShiftTimes } from '@shared/oa';
import { shiftDate } from '@shared/labels';
import { can } from '@shared/permissions';
import type { Db, Fragment, Sql, Tx } from '../../db';
import { guard, guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { currentStoreId } from '../../lib/store-context';
import { dateSchema, parse } from '../../lib/validate';
import { staffMonthStats } from './attendance-monthly';
import { notify } from './notifications';
import { localMinute } from './punches';
import { liveSchedule, lockStaffAttendance } from './schedule-overlap';
import { deptFilter } from './schedules';

/** 后台任务看最近几天的排班 */
const SETTLE_LOOKBACK_DAYS = 3;
/** 后台任务多久跑一次 */
const SETTLE_EVERY_MS = 10 * 60_000;

type Slot = OaShiftTimes & { storeId: number; staffId: number; workDate: string; shiftId: number; shiftName: string };

/**
 * 要结算的排班：下班窗口已经结束的；force 以外只要还没结算或结算以后有新打卡的。
 * 员工现在还在排班门店的照常算；调到别的门店以后，原门店那一班有打卡或已经结算过的也照常（重）算，
 * 没打卡也没结算过的当作调店以后不再生效的排班（后台任务每 10 分钟结算一次，调店前结束的那一班一般已经结算过）。
 */
async function candidates(db: Db, timeZone: string, at: Date, where: Fragment, force: boolean): Promise<Slot[]> {
  const rows = await db<(Slot & { needs: boolean })[]>`
    SELECT o.store_id, o.staff_id, o.work_date::text AS work_date, o.shift_id, sh.name AS shift_name,
           sh.start_minute, sh.end_minute, sh.rest_start_minute, sh.rest_end_minute, sh.in_advance_minutes, sh.late_grace_minutes,
           sh.in_after_minutes, sh.out_before_minutes, sh.out_delay_minutes,
           (d.id IS NULL OR EXISTS (SELECT 1 FROM oa_punches p WHERE p.staff_id = o.staff_id AND p.store_id = o.store_id
                                    AND p.business_date = o.work_date AND p.shift_id = o.shift_id AND p.created_at > d.settled_at)
            -- OA-13：结算以后又有审批覆盖（请假、出差）的也重算（审批通过时一般已经当场重算过）
            OR EXISTS (SELECT 1 FROM oa_attendance_covers c WHERE c.staff_id = o.staff_id AND c.work_date = o.work_date AND c.created_at > d.settled_at)) AS needs
    FROM oa_schedules o
    JOIN oa_shifts sh ON sh.id = o.shift_id
    LEFT JOIN oa_attendance_daily d ON d.staff_id = o.staff_id AND d.business_date = o.work_date AND d.shift_id = o.shift_id
    WHERE ${where}
      AND o.status = 'published'
      AND (${liveSchedule(db)}
           -- 调店以后原门店已经发生的那一班照常结算：有打卡或已经结算过的不因为现在不在那家店就丢掉
           OR d.id IS NOT NULL
           OR EXISTS (SELECT 1 FROM oa_punches p WHERE p.staff_id = o.staff_id AND p.store_id = o.store_id AND p.business_date = o.work_date AND p.shift_id = o.shift_id))
    ORDER BY o.staff_id, o.work_date, o.shift_id`;
  const now = localMinute(at, timeZone).minute;
  return rows
    .filter((r) => (force || r.needs) && punchWindows(r.workDate, r).outTo < now)
    .map(({ needs: _n, ...r }) => ({ ...r, staffId: Number(r.staffId), storeId: Number(r.storeId), shiftId: Number(r.shiftId) }));
}

type Effective = { id: number; lateMinutes: number; earlyMinutes: number; outwork: boolean; facePending: boolean };
type CoverRow = { workDate: string; kind: 'leave' | 'trip'; part: 'full' | 'am' | 'pm'; approvalId: number };

/** 一天的覆盖合起来：出差；请假免上班这一头、免下班这一头 */
function coverOf(covers: CoverRow[]): { cover: AttendanceCover | null; approvalId: number | null; trip: boolean; skipIn: boolean; skipOut: boolean } {
  const trip = covers.find((c) => c.kind === 'trip');
  if (trip) return { cover: 'trip', approvalId: Number(trip.approvalId), trip: true, skipIn: true, skipOut: true };
  const leave = covers.filter((c) => c.kind === 'leave');
  const skipIn = leave.some((c) => c.part !== 'pm');
  const skipOut = leave.some((c) => c.part !== 'am');
  const cover: AttendanceCover | null = skipIn && skipOut ? 'leave' : skipIn ? 'leave_am' : skipOut ? 'leave_pm' : null;
  return { cover, approvalId: leave.length ? Number(leave[0]!.approvalId) : null, trip: false, skipIn, skipOut };
}

/** 结算一位员工的几条排班（一个事务）；返回结算了几条 */
async function settleStaff(db: Sql, staffId: number, slots: Slot[], actorId: number | null): Promise<number> {
  return db.begin((tx) => settleSlots(tx, staffId, slots, actorId));
}

/** 在调用方的事务里结算（先取员工的考勤锁） */
async function settleSlots(tx: Tx, staffId: number, slots: Slot[], actorId: number | null): Promise<number> {
  await lockStaffAttendance(tx, [staffId]);
  // 锁内再核对已发布的排班还在：读候选到取锁之间人事可能刚把这一班发布去掉（连同结果一起删了），不能再插回去（Codex 审查 199b9dd）
  const still = await tx<{ workDate: string; shiftId: number }[]>`
      SELECT work_date::text AS work_date, shift_id FROM oa_schedules
      WHERE staff_id = ${staffId} AND status = 'published' AND work_date IN ${tx([...new Set(slots.map((s) => s.workDate))])}`;
  const live = new Set(still.map((r) => `${r.workDate}|${Number(r.shiftId)}`));
  const kept = slots.filter((s) => live.has(`${s.workDate}|${s.shiftId}`));
  const covers = kept.length
    ? await tx<CoverRow[]>`
          SELECT work_date::text AS work_date, kind, part, approval_id FROM oa_attendance_covers
          WHERE staff_id = ${staffId} AND work_date IN ${tx([...new Set(kept.map((s) => s.workDate))])} ORDER BY id`
    : [];
  for (const s of kept) {
    const eff = async (kind: 'in' | 'out') => {
      const [p] = await tx<Effective[]>`
          SELECT id, late_minutes, early_minutes, outwork, face_result = 'pending' AS face_pending FROM oa_punches
          WHERE staff_id = ${staffId} AND store_id = ${s.storeId} AND business_date = ${s.workDate} AND shift_id = ${s.shiftId} AND kind = ${kind}
          ORDER BY punched_at ${kind === 'in' ? tx`ASC` : tx`DESC`}, id ${kind === 'in' ? tx`ASC` : tx`DESC`} LIMIT 1`;
      return p ?? null;
    };
    const pin = await eff('in');
    const pout = await eff('out');
    // 审批覆盖：请假免掉的那一头不判迟到早退缺卡；出差、整天请假直接记出差 / 请假
    const c = coverOf(covers.filter((x) => x.workDate === s.workDate));
    const late = c.skipIn ? 0 : (pin?.lateMinutes ?? 0);
    const early = c.skipOut ? 0 : (pout?.earlyMinutes ?? 0);
    const missingIn = !pin && !c.skipIn;
    const missingOut = !pout && !c.skipOut;
    const status: AttendanceStatus = c.trip
      ? 'trip'
      : c.skipIn && c.skipOut
        ? 'leave'
        : !pin && !pout && !c.skipIn && !c.skipOut
          ? 'absent'
          : missingIn || missingOut || late > 0 || early > 0
            ? 'abnormal'
            : 'normal';
    const outwork = !!pin?.outwork || !!pout?.outwork;
    const facePending = !!pin?.facePending || !!pout?.facePending;
    const [row] = await tx<{ id: number; notified: boolean }[]>`
        INSERT INTO oa_attendance_daily (store_id, staff_id, business_date, shift_id, status, late_minutes, early_minutes, missing_in, missing_out,
                                         in_punch_id, out_punch_id, outwork, face_pending, cover, cover_approval_id, settled_at)
        VALUES (${s.storeId}, ${staffId}, ${s.workDate}, ${s.shiftId}, ${status}, ${late}, ${early}, ${missingIn}, ${missingOut},
                ${pin?.id ?? null}, ${pout?.id ?? null}, ${outwork}, ${facePending}, ${c.cover}, ${c.approvalId}, now())
        ON CONFLICT (staff_id, business_date, shift_id) DO UPDATE SET
          store_id = EXCLUDED.store_id, status = EXCLUDED.status, late_minutes = EXCLUDED.late_minutes, early_minutes = EXCLUDED.early_minutes,
          missing_in = EXCLUDED.missing_in, missing_out = EXCLUDED.missing_out, in_punch_id = EXCLUDED.in_punch_id, out_punch_id = EXCLUDED.out_punch_id,
          outwork = EXCLUDED.outwork, face_pending = EXCLUDED.face_pending, cover = EXCLUDED.cover, cover_approval_id = EXCLUDED.cover_approval_id,
          settled_at = now()
        RETURNING id, notified`;
    // 第一次算成异常：给员工发「打卡异常」
    if ((status === 'abnormal' || status === 'absent') && !row!.notified) {
      const issues = attendanceIssues({ status, lateMinutes: late, earlyMinutes: early, missingIn, missingOut });
      await notify(tx, [staffId], {
        kind: 'attendance_exception',
        title: `考勤异常：${s.workDate} ${s.shiftName}`,
        body: `${issues.join('、')}。有请假、出差或漏打卡的，请走审批或补卡`,
        link: '/oa/attendance',
        ref: { type: 'oa_attendance_daily', id: Number(row!.id) },
      });
      await tx`UPDATE oa_attendance_daily SET notified = true WHERE id = ${row!.id}`;
    }
  }
  if (actorId !== null && kept.length) {
    await writeAudit(tx, {
      staffId: actorId,
      action: 'oa_attendance_settled',
      targetType: 'staff',
      targetId: staffId,
      detail: { dates: [...new Set(kept.map((s) => s.workDate))], summary: `重新结算考勤 ${kept.length} 条` },
    });
  }
  return kept.length;
}

/**
 * OA-13 审批通过（请假、出差、补卡）以后，在同一个事务里把这位员工 from ～ to 已经下班的排班重新结算（覆盖、补卡当场生效）。
 * 还没下班的照旧等后台任务结算（到时也会读覆盖）
 */
export async function resettleStaffDays(tx: Tx, timeZone: string, at: Date, staffId: number, from: string, to: string): Promise<number> {
  const slots = await candidates(tx, timeZone, at, tx`o.staff_id = ${staffId} AND o.work_date BETWEEN ${from} AND ${to}`, true);
  return slots.length ? settleSlots(tx, staffId, slots, null) : 0;
}

async function settle(db: Sql, slots: Slot[], actorId: number | null): Promise<number> {
  const byStaff = new Map<number, Slot[]>();
  for (const s of slots) byStaff.set(s.staffId, [...(byStaff.get(s.staffId) ?? []), s]);
  let n = 0;
  for (const [staffId, list] of [...byStaff].sort((a, b) => a[0] - b[0])) n += await settleStaff(db, staffId, list, actorId);
  return n;
}

const settleDue = every(SETTLE_EVERY_MS);
/** 后台任务（每分钟调一次，10 分钟真跑一次）：最近 3 天下班窗口结束了的、还没结算或结算后又有新打卡的排班 */
export async function runAttendanceSettlement(deps: Pick<Deps, 'sql' | 'config'>, at = new Date(), force = false): Promise<number> {
  if (!force && !settleDue(at.getTime())) return 0;
  const today = localMinute(at, deps.config.timezone).date;
  const slots = await candidates(deps.sql, deps.config.timezone, at, deps.sql`o.work_date BETWEEN ${shiftDate(today, -SETTLE_LOOKBACK_DAYS)} AND ${today}`, false);
  return settle(deps.sql, slots, null);
}

type ViewRow = Omit<AttendanceDailyRow, 'inAt' | 'outAt' | 'settledAt'> & { inDate: string | null; inTime: string | null; outDate: string | null; outTime: string | null; settledAt: Date };

async function loadRows(db: Db, timeZone: string, where: Fragment): Promise<AttendanceDailyRow[]> {
  const rows = await db<ViewRow[]>`
    SELECT d.id, d.staff_id, s.display_name AS staff_name, d.business_date::text AS business_date, d.shift_id, sh.name AS shift_name,
           sh.start_minute, sh.end_minute, d.status, d.late_minutes, d.early_minutes, d.missing_in, d.missing_out,
           to_char(pi.punched_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS in_date, to_char(pi.punched_at AT TIME ZONE ${timeZone}, 'HH24:MI') AS in_time,
           to_char(po.punched_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS out_date, to_char(po.punched_at AT TIME ZONE ${timeZone}, 'HH24:MI') AS out_time,
           d.outwork, d.outwork_counted, d.face_pending, d.cover, d.cover_approval_id, d.settled_at
    FROM oa_attendance_daily d
    JOIN staff s ON s.id = d.staff_id
    JOIN oa_shifts sh ON sh.id = d.shift_id
    LEFT JOIN oa_punches pi ON pi.id = d.in_punch_id
    LEFT JOIN oa_punches po ON po.id = d.out_punch_id
    WHERE ${where}
    ORDER BY d.business_date, sh.start_minute, s.id`;
  return rows.map(({ inDate, inTime, outDate, outTime, settledAt, ...r }) => ({
    ...r,
    id: Number(r.id),
    staffId: Number(r.staffId),
    shiftId: Number(r.shiftId),
    coverApprovalId: r.coverApprovalId === null ? null : Number(r.coverApprovalId),
    inAt: inDate && inTime ? { date: inDate, time: inTime } : null,
    outAt: outDate && outTime ? { date: outDate, time: outTime } : null,
    settledAt: new Date(settledAt).toISOString(),
  }));
}

const DayQuery = z.object({
  date: dateSchema('日期').optional(),
  groupId: z.coerce.number().int().positive().optional(),
  abnormal: z.enum(['1', '0']).optional(),
});
const SettleInput = z.object({ date: dateSchema('日期'), storeId: z.number().int().positive() });
const OutworkInput = z.object({ counted: z.boolean(), expected: z.boolean() });
const MonthQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式应为 YYYY-MM')
    .optional(),
});
const idParam = z.object({ id: z.coerce.number().int().positive() });

export function registerOaAttendanceDailyRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const tz = deps.config.timezone;

  app.get('/api/oa/attendance/daily', { preHandler: guardAny('hr.attendance', 'hr.attendanceDept') }, async (req): Promise<AttendanceDay> => {
    const q = parse(DayQuery, req.query ?? {});
    const date = q.date ?? shiftDate(localMinute(new Date(), tz).date, -1);
    const store = currentStoreId();
    const groups = await sql<{ id: number; name: string }[]>`SELECT id, name FROM oa_attendance_groups WHERE store_id = ${store} AND active ORDER BY id`;
    const rows = await loadRows(
      sql,
      tz,
      sql`d.store_id = ${store} AND d.business_date = ${date} AND ${deptFilter(sql, req.actor)}
          ${q.groupId ? sql`AND EXISTS (SELECT 1 FROM oa_group_members m WHERE m.staff_id = d.staff_id AND m.group_id = ${q.groupId})` : sql``}
          ${q.abnormal === '1' ? sql`AND d.status IN ('abnormal', 'absent')` : sql``}`,
    );
    return { date, groups: groups.map((g) => ({ id: Number(g.id), name: g.name })), rows, editable: can(req.actor, 'hr.attendance') };
  });

  // 重新结算某一天（这家门店）：按现在的打卡明细重算，人事对外勤的决定保留；重算是幂等的，结果不确定时再点一次即可
  app.post('/api/oa/attendance/daily/settle', { preHandler: guard('hr.attendance') }, async (req): Promise<{ settled: number }> => {
    const input = parse(SettleInput, req.body);
    if (input.storeId !== currentStoreId()) throw conflict('STORE_SWITCHED', '这是在别的门店的页面上点的：请换回那家门店再结算');
    const today = localMinute(new Date(), tz).date;
    if (input.date > today) throw unprocessable('SETTLE_FUTURE', '还没到的日子不能结算');
    const slots = await candidates(sql, tz, new Date(), sql`o.store_id = ${input.storeId} AND o.work_date = ${input.date}`, true);
    return { settled: await settle(sql, slots, req.actor.id) };
  });

  // 外勤算不算出勤（人事决定，带着页面上看到的原值，别人先改过就拒绝；已经是要的样子照常成功）
  app.post('/api/oa/attendance/daily/:id/outwork', { preHandler: guard('hr.attendance') }, async (req): Promise<AttendanceDailyRow> => {
    const { id } = parse(idParam, req.params);
    const input = parse(OutworkInput, req.body);
    await sql.begin(async (tx) => {
      const [d] = await tx<{ staffId: number; outwork: boolean; outworkCounted: boolean; businessDate: string }[]>`
        SELECT staff_id, outwork, outwork_counted, business_date::text AS business_date FROM oa_attendance_daily
        WHERE id = ${id} AND store_id = ${currentStoreId()} FOR UPDATE`;
      if (!d) throw notFound('考勤结果不存在');
      if (!d.outwork) throw unprocessable('NOT_OUTWORK', '这一条没有外勤打卡');
      if (d.outworkCounted === input.counted) return;
      if (d.outworkCounted !== input.expected) throw conflict('OUTWORK_CHANGED', '这一条刚被别人改过，请刷新');
      await tx`UPDATE oa_attendance_daily SET outwork_counted = ${input.counted}, outwork_by = ${req.actor.id}, outwork_at = now() WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_attendance_outwork',
        targetType: 'staff',
        targetId: Number(d.staffId),
        detail: { dailyId: id, counted: input.counted, summary: `${d.businessDate} 外勤${input.counted ? '算出勤' : '不算出勤'}` },
        ip: req.ip,
      });
    });
    const [row] = await loadRows(sql, tz, sql`d.id = ${id}`);
    return row!;
  });

  // 员工「我的考勤」：本人一个月（各门店的都算）
  app.get('/api/oa/me/attendance', { preHandler: guard() }, async (req): Promise<MyAttendance> => {
    const q = parse(MonthQuery, req.query ?? {});
    const today = localMinute(new Date(), tz).date;
    const month = q.month ?? today.slice(0, 7);
    const [y, m] = month.split('-').map(Number) as [number, number];
    const from = `${month}-01`;
    const end = shiftDate(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1);
    const rows = await loadRows(sql, tz, sql`d.staff_id = ${req.actor.id} AND d.business_date BETWEEN ${from} AND ${end}`);
    const pendingRows = await sql<{ id: number; date: string; shiftId: string; kind: string }[]>`
      SELECT id, form->>'date' AS date, form->>'shiftId' AS shift_id, form->>'kind' AS kind
      FROM oa_approvals
      WHERE applicant_id = ${req.actor.id} AND template_code = 'makeup' AND status = 'pending'
        AND form->>'date' BETWEEN ${from} AND ${end}
      ORDER BY id DESC`;
    const pendingMakeups = pendingRows
      .filter((r) => /^\d+$/.test(r.shiftId ?? '') && !!r.date)
      .map((r) => ({
        date: r.date,
        shiftId: Number(r.shiftId),
        kind: (r.kind === '下班卡' ? 'out' : 'in') as 'in' | 'out',
        approvalId: Number(r.id),
      }));
    return { month, today, rows, summary: await staffMonthStats(sql, req.actor.id, month), pendingMakeups };
  });
}
