// OA-11 六类审批模板的挂接点（docs/OA.md 第 14 节；需求文档五（二））：提交时核对、补算时长并定标题。
// 与考勤、假期余额的联动（通过以后扣余额、覆盖考勤、补卡消缺卡、计加班）在 OA-13 的 onApproved / onClosed。
//   · 请假：时长按排班算（半天为单位），休息日、没排班的日子不算；不在任何考勤组的按日历天算；不跨年；要证明的假种必须带附件；
//     管余额的假种：剩余 − 还在审批中的同假种请假 ≥ 这次时长（锁住余额行再核对，几张同时提交也不会超）（OA13）。
//   · 加班：结束晚于开始，最长 24 小时。出差：结束不早于开始。报销：关联出差单在引擎里按「自己已通过的」核对。
//   · 补卡：今天及以前 30 天内、自己那天排了的班。

import { shiftDate } from '@shared/labels';
import { formAttachmentIds, halfDayKey, type ApprovalField, type ApprovalForm, type HalfDay } from '@shared/oa-approval';
import type { Tx } from '../../db';
import type { Actor } from '../../lib/context';
import { unprocessable } from '../../lib/errors';
import { formatYuan } from '@shared/money';
import { lockBalance, lockLeaveType } from './leave';

/** 补卡最多补几天以前的 */
const MAKEUP_BACK_DAYS = 30;

export interface PrepareContext {
  applicant: Actor;
  form: ApprovalForm;
  fields: readonly ApprovalField[];
  /** 门店所在地的今天 */
  today: string;
}
export interface ApprovalHooks {
  /** 提交前：核对与补算，可以改写表单与标题；不通过就抛错 */
  prepare?: (tx: Tx, ctx: PrepareContext) => Promise<{ form?: ApprovalForm; title?: string } | void>;
  onApproved?: (tx: Tx, approval: { id: number; applicantId: number; form: ApprovalForm }) => Promise<void>;
  onClosed?: (tx: Tx, approval: { id: number; applicantId: number; form: ApprovalForm; status: 'rejected' | 'withdrawn' }) => Promise<void>;
}

const bad = (message: string) => unprocessable('FORM_INVALID', message);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** 请假时长（半天）：有排班的日子算（不在任何考勤组的每天都算），开始那天选下午、结束那天选上午各算半天 */
async function leaveHalves(tx: Tx, staffId: number, start: HalfDay, end: HalfDay): Promise<number> {
  const [grouped] = await tx`
    SELECT 1 FROM oa_group_members m JOIN oa_attendance_groups g ON g.id = m.group_id WHERE m.staff_id = ${staffId} AND g.active LIMIT 1`;
  const scheduled = grouped
    ? new Set((await tx<{ d: string }[]>`SELECT DISTINCT work_date::text AS d FROM oa_schedules WHERE staff_id = ${staffId} AND work_date BETWEEN ${start.date} AND ${end.date}`).map((r) => r.d))
    : null;
  let halves = 0;
  for (let d = start.date; d <= end.date; d = shiftDate(d, 1)) {
    if (scheduled && !scheduled.has(d)) continue;
    halves += 2;
    if (d === start.date && start.half === 'pm') halves -= 1;
    if (d === end.date && end.half === 'am') halves -= 1;
  }
  return halves;
}

/** 各模板的挂接点（按模板编码） */
export const TEMPLATE_HOOKS: Record<string, ApprovalHooks> = {
  leave: {
    async prepare(tx, { applicant, form, fields }) {
      const start = form.start as HalfDay;
      const end = form.end as HalfDay;
      if (halfDayKey(end) < halfDayKey(start)) throw bad('结束不能早于开始');
      if (start.date.slice(0, 4) !== end.date.slice(0, 4)) throw bad('一张请假单不能跨年，请分成两张');
      if (daysBetween(start.date, end.date) > 366) throw bad('请假最长一年');
      // 锁住假种（与修改假种的设置串行），管余额的再锁余额行（几张同时提交也不会超）
      const leaveTypeId = form.leaveTypeId as number;
      const t = await lockLeaveType(tx, leaveTypeId);
      if (!t || !t.active) throw bad('假种不存在或已停用，请刷新');
      if (t.proofRequired && formAttachmentIds(fields, form).length === 0) throw bad(`${t.name}要上传证明附件`);
      const halves = await leaveHalves(tx, applicant.id, start, end);
      if (halves <= 0) throw unprocessable('LEAVE_NO_SCHEDULE', '这几天都没有排班，不用请假');
      if (t.hasBalance) {
        const year = Number(start.date.slice(0, 4));
        const b = await lockBalance(tx, applicant.id, leaveTypeId, year);
        const [p] = await tx<{ halves: number }[]>`
          SELECT COALESCE(sum((form->>'durationHalves')::int), 0)::int AS halves FROM oa_approvals
          WHERE applicant_id = ${applicant.id} AND template_code = 'leave' AND status = 'pending'
            AND (form->>'leaveTypeId')::bigint = ${leaveTypeId} AND left(form->'start'->>'date', 4) = ${String(year)}`;
        const left = b.grantedHalves - b.usedHalves - p!.halves;
        if (left < halves) {
          throw unprocessable('LEAVE_BALANCE_SHORT', `${year} 年${t.name}还能请 ${Math.max(0, left) / 2} 天（已扣掉审批中的），这次要 ${halves / 2} 天`);
        }
      }
      return { form: { ...form, durationHalves: halves }, title: `请假 · ${t.name} ${halves / 2} 天` };
    },
  },
  overtime: {
    async prepare(_tx, { form }) {
      const start = form.start as string;
      const end = form.end as string;
      const minutes = Math.round((Date.parse(`${end}:00Z`) - Date.parse(`${start}:00Z`)) / 60_000);
      if (minutes <= 0) throw bad('结束要晚于开始');
      if (minutes > 24 * 60) throw bad('一张加班单最长 24 小时');
      return { form: { ...form, minutes }, title: `加班 · ${form.kind as string} ${Math.round((minutes / 60) * 10) / 10} 小时` };
    },
  },
  trip: {
    async prepare(_tx, { form }) {
      const days = daysBetween(form.startDate as string, form.endDate as string) + 1;
      if (days < 1) throw bad('结束日期不能早于开始日期');
      if (days > 366) throw bad('出差最长一年');
      return { form: { ...form, days }, title: `出差 · ${form.destination as string} ${days} 天` };
    },
  },
  expense: {
    async prepare(_tx, { form }) {
      return { title: `报销 · ${[form.category, formatYuan(form.amount as number)].filter(Boolean).join(' ')}` };
    },
  },
  makeup: {
    async prepare(tx, { applicant, form, today }) {
      const date = form.date as string;
      if (date > today) throw bad('还没到的日子不用补卡');
      if (date < shiftDate(today, -MAKEUP_BACK_DAYS)) throw bad(`只能补 ${MAKEUP_BACK_DAYS} 天以内的卡`);
      const [s] = await tx<{ name: string }[]>`
        SELECT sh.name FROM oa_schedules o JOIN oa_shifts sh ON sh.id = o.shift_id
        WHERE o.staff_id = ${applicant.id} AND o.work_date = ${date} AND o.shift_id = ${form.shiftId as number}`;
      if (!s) throw bad('那天没有排这个班，请重新选');
      return { title: `补卡 · ${date} ${s.name}${form.kind as string}` };
    },
  },
};
