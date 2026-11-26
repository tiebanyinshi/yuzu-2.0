// OA-13 考勤与审批联动（docs/OA.md 第 16 节；需求文档四（五）表 4-1、五（二））：审批通过（OA-10 的「通过以后」）在同一个事务里
// 接考勤与假期余额，覆盖的日子当场重新结算。
//   · 请假：管余额的假种按提交时算好的时长扣余额（这期间被减到不够的拒绝通过）；每一天记一条考勤覆盖（整天 / 上午 / 下午）。
//   · 出差：每一天记一条整天的覆盖。
//   · 补卡：给那一班写一张补卡（时间记班次的上 / 下班时间），已经有那张卡的不再写。
//   · 加班：不在这里（月报直接按通过的加班单算）；提交时按节假日表核对加班类型（checkOvertimeKind）。
// 加锁（docs/LOCKING.md「办公审批」）：审批单行（调用方已 FOR UPDATE）→ 假种（FOR SHARE）→ 余额行 → 员工的考勤锁 → 结果行。

import { punchWindows, OVERTIME_KINDS, type OaShiftTimes } from '@shared/oa';
import { shiftDate } from '@shared/labels';
import type { ApprovalForm, HalfDay } from '@shared/oa-approval';
import type { Tx } from '../../db';
import { unprocessable } from '../../lib/errors';
import { resettleStaffDays } from './attendance-daily';
import { changeBalance, lockBalance, lockLeaveType } from './leave';
import { localMinute } from './punches';
import { lockStaffAttendance } from './schedule-overlap';

/** 审批通过时的环境：门店所在地的时区、现在 */
export interface LinkEnv {
  timeZone: string;
  at: Date;
}
type Approved = { id: number; applicantId: number; title: string; form: ApprovalForm };

const bad = (message: string) => unprocessable('FORM_INVALID', message);

/** 补卡单上的「补哪张卡」 */
export const makeupKind = (form: ApprovalForm): 'in' | 'out' => (form.kind === '下班卡' ? 'out' : 'in');

/**
 * 请假的每一天：整天 / 上午 / 下午（开始那天选下午、结束那天选上午各只算半天），与这一天算几个半天：
 * 有排班的日子才算（不在任何考勤组的员工每天都算）。提交时合计成时长，通过时逐天记成考勤覆盖
 */
export async function leaveDays(tx: Tx, staffId: number, start: HalfDay, end: HalfDay): Promise<{ date: string; part: 'full' | 'am' | 'pm'; halves: number }[]> {
  const [grouped] = await tx`
    SELECT 1 FROM oa_group_members m JOIN oa_attendance_groups g ON g.id = m.group_id WHERE m.staff_id = ${staffId} AND g.active LIMIT 1`;
  const scheduled = grouped
    ? new Set(
        (
          await tx<{ d: string }[]>`SELECT DISTINCT work_date::text AS d FROM oa_schedules WHERE staff_id = ${staffId} AND status = 'published' AND work_date BETWEEN ${start.date} AND ${end.date}`
        ).map((r) => r.d),
      )
    : null;
  const out: { date: string; part: 'full' | 'am' | 'pm'; halves: number }[] = [];
  for (let d = start.date; d <= end.date; d = shiftDate(d, 1)) {
    const fromPm = d === start.date && start.half === 'pm';
    const toAm = d === end.date && end.half === 'am';
    // 开始那天下午、结束那天上午是同一天（下午开始、上午结束）不会出现：结束不早于开始
    const part = fromPm ? 'pm' : toAm ? 'am' : 'full';
    out.push({ date: d, part, halves: scheduled && !scheduled.has(d) ? 0 : part === 'full' ? 2 : 1 });
  }
  return out;
}

/** 记考勤覆盖（每天一行）再把这几天已经下班的排班重新结算 */
async function cover(tx: Tx, env: LinkEnv, a: Approved, kind: 'leave' | 'trip', days: { date: string; part: 'full' | 'am' | 'pm'; halves: number }[], leaveTypeId: number | null) {
  if (!days.length) return;
  await tx`
    INSERT INTO oa_attendance_covers (staff_id, work_date, kind, part, halves, leave_type_id, approval_id)
    SELECT ${a.applicantId}, d, ${kind}, p, h, ${leaveTypeId}, ${a.id}
    FROM unnest(${days.map((x) => x.date)}::date[], ${days.map((x) => x.part)}::text[], ${days.map((x) => x.halves)}::int[]) AS t(d, p, h)
    ON CONFLICT (approval_id, work_date) DO NOTHING`;
  await resettleStaffDays(tx, env.timeZone, env.at, a.applicantId, days[0]!.date, days.at(-1)!.date);
}

/** 请假通过：扣余额、覆盖考勤 */
export async function onLeaveApproved(tx: Tx, a: Approved, env: LinkEnv): Promise<void> {
  const start = a.form.start as HalfDay;
  const end = a.form.end as HalfDay;
  const leaveTypeId = a.form.leaveTypeId as number;
  const halves = a.form.durationHalves as number;
  const t = await lockLeaveType(tx, leaveTypeId);
  if (!t) throw unprocessable('LEAVE_TYPE_GONE', '这张单的假种不存在了，请驳回');
  // 提交以后排班被改过、按现在的排班算出来的时长与提交时不一样：不通过（扣的余额、记的覆盖、月报的请假天数要是同一个数）
  const days = await leaveDays(tx, a.applicantId, start, end);
  const now = days.reduce((n, d) => n + d.halves, 0);
  if (now !== halves) {
    throw unprocessable('LEAVE_SCHEDULE_CHANGED', `提交以后排班改过了：按现在的排班这张假是 ${now / 2} 天，提交时是 ${halves / 2} 天，请驳回让发起人重新提交`);
  }
  if (t.hasBalance && halves > 0) {
    const year = Number(start.date.slice(0, 4));
    const b = await lockBalance(tx, a.applicantId, leaveTypeId, year);
    const left = b.grantedHalves - b.usedHalves;
    if (left < halves) {
      throw unprocessable('LEAVE_BALANCE_SHORT', `${year} 年${t.name}只剩 ${Math.max(0, left) / 2} 天，不够扣这次的 ${halves / 2} 天（提交以后余额被调整过），请驳回让发起人改`);
    }
    await changeBalance(tx, { staffId: a.applicantId, leaveTypeId, year, kind: 'use', halves: -halves, reason: a.title.slice(0, 200), refType: 'oa_approval', refId: a.id, actorId: null });
  }
  await cover(tx, env, a, 'leave', days, leaveTypeId);
}

/** 出差通过：那几天整天覆盖 */
export async function onTripApproved(tx: Tx, a: Approved, env: LinkEnv): Promise<void> {
  const days: { date: string; part: 'full'; halves: number }[] = [];
  for (let d = a.form.startDate as string; d <= (a.form.endDate as string); d = shiftDate(d, 1)) days.push({ date: d, part: 'full', halves: 0 });
  await cover(tx, env, a, 'trip', days, null);
}

type SlotRow = OaShiftTimes & { storeId: number };

async function slotOf(tx: Tx, staffId: number, date: string, shiftId: number): Promise<SlotRow | null> {
  const [s] = await tx<SlotRow[]>`
    SELECT o.store_id, sh.start_minute, sh.end_minute, sh.rest_start_minute, sh.rest_end_minute, sh.in_advance_minutes, sh.late_grace_minutes,
           sh.in_after_minutes, sh.out_before_minutes, sh.out_delay_minutes
    FROM oa_schedules o JOIN oa_shifts sh ON sh.id = o.shift_id
    WHERE o.staff_id = ${staffId} AND o.work_date = ${date} AND o.shift_id = ${shiftId} AND o.status = 'published'`;
  return s ? { ...s, storeId: Number(s.storeId) } : null;
}

const hasCard = async (tx: Tx, staffId: number, date: string, shiftId: number, kind: 'in' | 'out') =>
  !!(await tx`SELECT 1 FROM oa_punches WHERE staff_id = ${staffId} AND business_date = ${date} AND shift_id = ${shiftId} AND kind = ${kind} LIMIT 1`)[0];

/** 补卡提交时多核对：那张卡的打卡窗口已经过了、还没有那张卡、同一张卡没有审批中的补卡单 */
export async function checkMakeup(tx: Tx, staffId: number, form: ApprovalForm, env: LinkEnv): Promise<void> {
  const date = form.date as string;
  const shiftId = form.shiftId as number;
  const kind = makeupKind(form);
  const slot = await slotOf(tx, staffId, date, shiftId);
  if (!slot) throw bad('那天没有排这个班，请重新选');
  const w = punchWindows(date, slot);
  if (localMinute(env.at, env.timeZone).minute <= (kind === 'in' ? w.inTo : w.outTo)) {
    throw unprocessable('MAKEUP_TOO_EARLY', `这一班的${form.kind as string}还能直接打，打卡窗口过了还没打的再补`);
  }
  if (await hasCard(tx, staffId, date, shiftId, kind)) throw unprocessable('MAKEUP_NOT_NEEDED', `那一班已经有${form.kind as string}了，不用补`);
  const [dup] = await tx`
    SELECT 1 FROM oa_approvals
    WHERE applicant_id = ${staffId} AND template_code = 'makeup' AND status = 'pending'
      AND form->>'date' = ${date} AND (form->>'shiftId')::bigint = ${shiftId} AND form->>'kind' = ${form.kind as string}`;
  if (dup) throw unprocessable('MAKEUP_PENDING', `那一班的${form.kind as string}已经有一张补卡单在审批了`);
}

/** 补卡通过：写一张补卡（已经有那张卡的不再写），重新结算那一天 */
export async function onMakeupApproved(tx: Tx, a: Approved, env: LinkEnv): Promise<void> {
  const date = a.form.date as string;
  const shiftId = a.form.shiftId as number;
  const kind = makeupKind(a.form);
  await lockStaffAttendance(tx, [a.applicantId]);
  const slot = await slotOf(tx, a.applicantId, date, shiftId);
  if (!slot) throw unprocessable('MAKEUP_SLOT_GONE', '那天这一班的排班已经去掉了，补不了卡，请驳回');
  if (!(await hasCard(tx, a.applicantId, date, shiftId, kind))) {
    const w = punchWindows(date, slot);
    // 班次的上 / 下班时间（门店所在地）换成时间点
    const local = new Date((kind === 'in' ? w.start : w.end) * 60_000).toISOString().slice(0, 16).replace('T', ' ');
    await tx`
      INSERT INTO oa_punches (store_id, staff_id, punched_at, kind, business_date, shift_id, location_ok, device_info, makeup_approval_id)
      VALUES (${slot.storeId}, ${a.applicantId}, ${local}::timestamp AT TIME ZONE ${env.timeZone}, ${kind}, ${date}, ${shiftId}, true, '补卡（审批通过）', ${a.id})`;
  }
  await resettleStaffDays(tx, env.timeZone, env.at, a.applicantId, date, date);
}

/** 加班提交时按节假日表核对加班类型：表里是节假日的那天必须选「节假日」，不是的不能选（OA15） */
export async function checkOvertimeKind(tx: Tx, form: ApprovalForm): Promise<void> {
  const date = (form.start as string).slice(0, 10);
  const [h] = await tx<{ kind: string; name: string }[]>`SELECT kind, name FROM oa_holidays WHERE day = ${date}`;
  if (h?.kind === 'holiday' && form.kind !== OVERTIME_KINDS.holiday) throw bad(`${date} 是节假日（${h.name}），加班类型要选「节假日」`);
  if (form.kind === OVERTIME_KINDS.holiday && h?.kind !== 'holiday') throw bad(`${date} 不在节假日表里，不能选「节假日」（节假日表由人事在「考勤设置 → 节假日」维护）`);
}
