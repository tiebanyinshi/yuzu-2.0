// 排班、考勤记录、假期余额的显示（纯函数，单元测试核对）。规则都在门店系统里，这里只把它回的东西写成一行一行。

import type { AttendanceDailyRow, LeaveBalance, LeaveEntry, MyAttendance, MySchedule } from '../../../src/shared/oa';
import { dayOfMonthLabel, shiftRange } from './month';

const DAY_STATUS: Record<string, string> = { work: '上班', rest: '休息', leave: '请假', absent: '缺勤' };

export interface DayRow {
  date: string;
  day: string;
  status: string;
  statusText: string;
  shifts: string;
  isToday: boolean;
  past: boolean;
}

/** 我的排班：一天一行 */
export function dayRows(s: MySchedule): DayRow[] {
  return s.days.map((d) => ({
    date: d.date,
    day: dayOfMonthLabel(d.date),
    status: d.status,
    statusText: d.status === 'leave' && d.leavePart && d.leavePart !== 'full' ? `请假（${d.leavePart === 'am' ? '上午' : '下午'}）` : (DAY_STATUS[d.status] ?? d.status),
    shifts: d.items.map((i) => `${i.name} ${shiftRange(i.startMinute, i.endMinute)}`).join('；'),
    isToday: d.date === s.today,
    past: d.date < s.today,
  }));
}

/** 补卡最多补几天以前的（与门店系统同一口径：MAKEUP_BACK_DAYS） */
export const MAKEUP_BACK_DAYS = 30;

const COVER: Record<string, string> = { leave: '请假', leave_am: '请假（上午）', leave_pm: '请假（下午）', trip: '出差' };
const STATUS: Record<string, string> = { normal: '正常', abnormal: '异常', absent: '旷工', leave: '请假', trip: '出差' };

export interface AttendanceRowView {
  id: number;
  day: string;
  shift: string;
  times: string;
  statusText: string;
  issues: string;
  bad: boolean;
  /** 能补的卡（还在补卡期限内、没有审批中的补卡单） */
  makeup: { kind: 'in' | 'out'; date: string; shiftId: number } | null;
  /** 审批中的补卡单 */
  pendingApprovalId: number | null;
}

/** 一班的异常写成短语（与门店系统 attendanceIssues 同一口径） */
export function issuesOf(r: Pick<AttendanceDailyRow, 'status' | 'lateMinutes' | 'earlyMinutes' | 'missingIn' | 'missingOut'>): string[] {
  if (r.status === 'absent') return ['旷工'];
  if (r.status === 'leave' || r.status === 'trip') return [];
  const out: string[] = [];
  if (r.missingIn) out.push('缺上班卡');
  if (r.lateMinutes) out.push(`迟到 ${r.lateMinutes} 分钟`);
  if (r.missingOut) out.push('缺下班卡');
  if (r.earlyMinutes) out.push(`早退 ${r.earlyMinutes} 分钟`);
  return out;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** 我的考勤：一班一行；缺卡、还在 30 天补卡期限内、没有审批中的补卡单的给「补卡」 */
export function attendanceRows(a: MyAttendance): AttendanceRowView[] {
  return a.rows
    .slice()
    .sort((x, y) => y.businessDate.localeCompare(x.businessDate) || y.startMinute - x.startMinute)
    .map((r) => {
      const issues = issuesOf(r);
      const pending = a.pendingMakeups.find((p) => p.date === r.businessDate && p.shiftId === r.shiftId);
      const inWindow = daysBetween(r.businessDate, a.today) <= MAKEUP_BACK_DAYS && r.businessDate <= a.today;
      const kind: 'in' | 'out' | null = r.missingIn ? 'in' : r.missingOut ? 'out' : null;
      return {
        id: r.id,
        day: dayOfMonthLabel(r.businessDate),
        shift: `${r.shiftName} ${shiftRange(r.startMinute, r.endMinute)}`,
        times: `${r.inAt ? r.inAt.time : '--:--'} – ${r.outAt ? r.outAt.time : '--:--'}`,
        statusText: r.cover ? (COVER[r.cover] ?? '') : (STATUS[r.status] ?? r.status),
        issues: issues.join('、'),
        bad: r.status === 'abnormal' || r.status === 'absent',
        makeup: kind && inWindow && !pending ? { kind, date: r.businessDate, shiftId: r.shiftId } : null,
        pendingApprovalId: pending ? pending.approvalId : null,
      };
    });
}

export interface BalanceRow {
  id: number;
  name: string;
  left: string;
  detail: string;
}

/** 余额（半天为单位）→「还剩 2.5 天」 */
export const daysText = (halves: number) => `${halves / 2} 天`;

export function balanceRows(balances: LeaveBalance[]): BalanceRow[] {
  return balances.map((b) => ({
    id: b.leaveTypeId,
    name: b.name,
    left: daysText(b.grantedHalves - b.usedHalves),
    detail: `共 ${daysText(b.grantedHalves)} · 用了 ${daysText(b.usedHalves)}`,
  }));
}

const ENTRY: Record<string, string> = { grant: '按规则发放', adjust: '人事调整', use: '请假扣减', restore: '撤销退回' };

export function entryText(e: Pick<LeaveEntry, 'kind' | 'halves' | 'leaveTypeName'>): string {
  const sign = e.halves > 0 ? '+' : '';
  return `${e.leaveTypeName} · ${ENTRY[e.kind] ?? e.kind} ${sign}${e.halves / 2} 天`;
}
