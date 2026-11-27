// 「今天」首页的样子（docs/STAFF_MP.md 第 2.2 节）：纯函数，tests/today.test.ts 核对。
//   · 此刻卡只写状态：按设计稿表里的先后取第一条成立的；考勤一律照门店系统回的「下一张卡」（nextPunch），小程序不另算；
//   · 待办只放要我动手的事，最急的在上面；没有待办写「都处理完了」。

import type { PunchSlotView, PunchToday } from '../../../src/shared/oa';
import { clockOfEpochMinute, slotOf } from './punch';
import { hhmm } from './format';

export type CardTone = 'normal' | 'late' | 'calm';

export interface TodayCard {
  /** 卡片上的小字：上班 / 下班 / 巡场 / 吃饭 / 在班 / 休息 / 考勤 */
  eyebrow: string;
  title: string;
  detail: string;
  /** 补充的几行（这一轮没巡的场所、今天的菜） */
  lines: string[];
  tone: CardTone;
  /** 点卡片去哪 */
  page: string;
  /** 卡片上的文字按钮（在班时「提前下班」） */
  action: { label: string; page: string } | null;
}

export interface PatrolNow {
  roundText: string;
  missing: string[];
}

export interface MealNow {
  /** 「午餐 10:30–14:30」 */
  window: string;
  dishes: string[];
}

export interface TodayInput {
  punch: PunchToday | null;
  /** 门店的此刻（1970 起第几分钟，按打卡接口回的 now 往前走） */
  now: number;
  /** 巡场部门的人、这一轮还没巡完的（不是巡场部门、巡完了、读不到为 null） */
  patrol: PatrolNow | null;
  /** 在开饭时间里、能用饭堂（不在开饭时间为 null） */
  meal: MealNow | null;
}

const PUNCH_PAGE = '/pages/punch/index';

/** 今天在不在班：今天的某一格上班卡打了、下班卡还没打 */
function onDutySlot(punch: PunchToday): PunchSlotView | null {
  return punch.slots.find((s) => s.in && !s.out) ?? null;
}

const minutesText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}` : `${m} 分钟`);

export function todayCard(input: TodayInput): TodayCard {
  const { punch, now, patrol, meal } = input;
  const base = { lines: [] as string[], tone: 'normal' as CardTone, action: null };
  const hint = punch ? punch.nextPunch : null;
  const slot = punch && hint ? slotOf(punch, hint) : null;

  // 1. 上班卡、在打卡窗口里
  if (punch && hint && hint.action === 'in' && hint.inWindow && slot) {
    const w = slot.windows;
    const late = now > w.lateAfter;
    const rel = now < w.start ? `还有 ${minutesText(w.start - now)}` : late ? `已迟到 ${minutesText(now - w.start)}` : '已到上班时间';
    return { ...base, eyebrow: '上班', title: `${hhmm(slot.startMinute)} 上班 · ${slot.name}`, detail: rel, tone: late ? 'late' : 'normal', page: PUNCH_PAGE };
  }
  // 2. 下班卡、已到下班时间
  if (punch && hint && hint.action === 'out' && slot && now >= slot.windows.end) {
    return { ...base, eyebrow: '下班', title: `${clockOfEpochMinute(slot.windows.end)} 下班 · 已到下班时间`, detail: slot.name, page: PUNCH_PAGE };
  }
  const duty = punch ? onDutySlot(punch) : null;
  // 3. 在班、巡场这一轮还没巡完
  if (duty && patrol && patrol.missing.length) {
    return {
      ...base,
      eyebrow: '巡场',
      title: `${patrol.roundText} · 还有 ${patrol.missing.length} 处没巡`,
      detail: '',
      lines: [patrol.missing.slice(0, 4).join('、') + (patrol.missing.length > 4 ? ' 等' : '')],
      page: '/pages/patrol/index',
    };
  }
  // 4. 在开饭时间里
  if (meal) {
    return {
      ...base,
      eyebrow: '吃饭',
      title: meal.window,
      detail: meal.dishes.length ? '' : '今天的菜单还没发布',
      lines: meal.dishes.length ? [meal.dishes.slice(0, 5).join(' · ')] : [],
      tone: 'calm',
      page: '/pages/meal/index',
    };
  }
  // 5. 在班（下班时间还没到）
  if (duty) {
    const early = hint && hint.action === 'out' && slot && now < slot.windows.end;
    return {
      ...base,
      eyebrow: '在班',
      title: `在班 · ${clockOfEpochMinute(duty.windows.end)} 下班`,
      detail: duty.name,
      tone: 'calm',
      page: PUNCH_PAGE,
      action: early ? { label: '提前下班', page: PUNCH_PAGE } : null,
    };
  }
  if (!punch || !hint) return { ...base, eyebrow: '考勤', title: '读不到今天的考勤', detail: '连上门店系统以后再看', tone: 'calm', page: PUNCH_PAGE };
  // 6、7. 休息、没有排班（门店系统的说法）
  if (hint.action === 'rest') return { ...base, eyebrow: '休息', title: '今天休息', detail: '这几天没有排班的，问问主管', tone: 'calm', page: '/pages/schedule/index' };
  // 8. 没进考勤组、缺卡、待打、打完：原样写门店系统的话，带出路
  if (hint.action === 'no_group') return { ...base, eyebrow: '考勤', title: hint.label, detail: hint.detail, page: PUNCH_PAGE };
  if (hint.action === 'done' && /缺卡/.test(hint.detail))
    return { ...base, eyebrow: '考勤', title: hint.label, detail: hint.detail, tone: 'late', page: '/pages/attendance/index', action: { label: '去补卡', page: '/pages/apply/index' } };
  return { ...base, eyebrow: '考勤', title: hint.label, detail: hint.detail, tone: 'calm', page: PUNCH_PAGE };
}

/** 今天的班次一行：「09:00–18:00 · 前厅早班」；没有排班为空 */
export function shiftLine(punch: PunchToday | null): string {
  if (!punch) return '';
  const mine = punch.slots.filter((s) => s.date === punch.today);
  return mine.map((s) => `${hhmm(s.startMinute)}–${s.endMinute <= s.startMinute ? '次日 ' : ''}${hhmm(s.endMinute)} · ${s.name}`).join('；');
}

export interface TodoRow {
  key: string;
  icon: string;
  text: string;
  sub: string;
  page: string;
  urgent: boolean;
}

export interface TodoInput {
  /** 手机上留着的、没收到回复的打卡 */
  pendingPunchAt: string | null;
  approvalsTodo: number;
  ccUnread: number;
  /** 今天有缺卡（门店系统的说法里有「缺卡」） */
  missedPunch: boolean;
  unsignedPayslips: { id: number; title: string }[];
}

/** 待办：最急的在上面 */
export function todoRows(t: TodoInput): TodoRow[] {
  const rows: TodoRow[] = [];
  if (t.pendingPunchAt) rows.push({ key: 'pending', icon: 'punch', text: '上一次打卡没收到门店系统的回复', sub: `${t.pendingPunchAt} · 去确认，不会重复打`, page: PUNCH_PAGE, urgent: true });
  if (t.missedPunch) rows.push({ key: 'missed', icon: 'attendance', text: '今天有缺卡', sub: '可以提交补卡', page: '/pages/apply/index', urgent: true });
  if (t.approvalsTodo > 0) rows.push({ key: 'approvals', icon: 'approvals', text: `待我审批 ${t.approvalsTodo} 件`, sub: '', page: '/pages/approvals/index', urgent: false });
  if (t.unsignedPayslips.length === 1)
    rows.push({ key: 'payslip', icon: 'payslips', text: `${t.unsignedPayslips[0]!.title}待确认`, sub: '', page: `/pages/payslip/index?id=${t.unsignedPayslips[0]!.id}`, urgent: false });
  else if (t.unsignedPayslips.length > 1) rows.push({ key: 'payslip', icon: 'payslips', text: `${t.unsignedPayslips.length} 张工资条待确认`, sub: '', page: '/pages/payslips/index', urgent: false });
  if (t.ccUnread > 0) rows.push({ key: 'cc', icon: 'approvals', text: `抄送我的 ${t.ccUnread} 条没看`, sub: '', page: '/pages/approvals/index?box=cc', urgent: false });
  return rows;
}

/** 首页「扫一扫」扫到的码去哪 */
export type ScanRoute = { kind: 'patrol'; code: string } | { kind: 'meal'; code: string } | { kind: 'refuse'; message: string };

export function routeScan(raw: string, can: { patrol: boolean; canteenScan: boolean }, parse: { patrol: (s: string) => string | null; isMeal: (s: string) => boolean }): ScanRoute {
  const text = (raw || '').trim();
  const patrol = parse.patrol(text);
  if (patrol && text.length >= 12 && !parse.isMeal(text)) {
    return can.patrol ? { kind: 'patrol', code: patrol } : { kind: 'refuse', message: '这是巡场的场所码：你不在巡场名单里，扫不了' };
  }
  if (parse.isMeal(text)) return can.canteenScan ? { kind: 'meal', code: text.toUpperCase() } : { kind: 'refuse', message: '这是饭卡码：请给食堂负责人扫' };
  return { kind: 'refuse', message: '这不是店里的码' };
}
