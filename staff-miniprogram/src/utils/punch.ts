// 打卡页的样子（docs/STAFF_MP.md 第 2.2、2.8 节，SP13、SP15）：一律照门店系统回的「下一张卡」（nextPunch）——小程序不另写一套考勤判断。
//   · 上班卡：主按钮「上班打卡」；
//   · 下班卡：已到下班时间才是主按钮「下班打卡」；没到下班时间只有文字按钮「提前下班」，点了先确认「会记早退」（SP15）；
//   · 待打、打完、休息、没进考勤组：不给按钮，写清楚；
//   · 考勤组要刷脸：小程序里不做人脸，写「请在 WCP 网页上打卡」（SP13）；
//   · 页面开着跨过了「下一张卡」的时间段（能打的窗口关了、等的窗口开了）：门店系统回的那一张不作数了，不给按钮，
//     页面去门店系统重新取（hintExpiresAt；Codex 审查 #53）。

import type { NextPunchHint, OaPunch, PunchSlotView, PunchToday } from '../../../src/shared/oa';

export interface PunchView {
  /** 门店的此刻，HH:MM（大字） */
  clock: string;
  label: string;
  detail: string;
  /** 实心主按钮：上班打卡 / 下班打卡；不给按钮为 null */
  primary: 'in' | 'out' | null;
  /** 文字按钮「提前下班」（会记早退） */
  early: boolean;
  /** 早退会记多少分钟（提前下班的确认框里写） */
  earlyMinutes: number;
  /** 不能在小程序里打卡的原因（要刷脸、没进考勤组） */
  blocked: string;
  /** 要定位 */
  needGps: boolean;
  outworkAllowed: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const mod = (m: number) => ((m % 1440) + 1440) % 1440;
/** 「1970-01-01 起第几分钟」→ HH:MM */
export const clockOfEpochMinute = (m: number) => `${pad(Math.floor(mod(m) / 60))}:${pad(mod(m) % 60)}`;

/** 下一张卡对应的那一条排班 */
export function slotOf(today: Pick<PunchToday, 'slots'>, hint: Pick<NextPunchHint, 'shiftId' | 'businessDate'>): PunchSlotView | null {
  return today.slots.find((s) => s.shiftId === hint.shiftId && s.date === hint.businessDate) ?? null;
}

/**
 * 门店系统回的「下一张卡」从哪一分钟起不作数（要重新取）：能打的（上班、下班）过了窗口的最后一分钟，待打的到了窗口开始；
 * 打完、休息、没进考勤组的没有时间段，返回 null
 */
export function hintExpiresAt(hint: Pick<NextPunchHint, 'action' | 'windowFrom' | 'windowTo'>): number | null {
  if ((hint.action === 'in' || hint.action === 'out') && hint.windowTo !== null) return hint.windowTo + 1;
  if (hint.action === 'wait' && hint.windowFrom !== null) return hint.windowFrom;
  return null;
}

/** 过了时间段、还没重新取到的那一句 */
export const HINT_STALE = '打卡时间段变了，正在重新取；一直没变就下拉刷新';

/** 打卡页显示什么（纯函数；now 是门店的「第几分钟」，按本机时钟往前走） */
export function punchView(today: PunchToday, now: number = today.now): PunchView {
  const hint = today.nextPunch;
  const base: PunchView = {
    clock: clockOfEpochMinute(now),
    label: hint.label,
    detail: hint.detail,
    primary: null,
    early: false,
    earlyMinutes: 0,
    blocked: '',
    needGps: !!today.group?.gpsRequired,
    outworkAllowed: hint.outworkAllowed,
  };
  if (!today.group || hint.action === 'no_group') return { ...base, blocked: '你还没进考勤组，打不了卡：请找人事把你加进考勤组' };
  if (today.group.faceRequired) return { ...base, blocked: '这个考勤组要刷脸，请在 WCP 网页上打卡' };
  const expires = hintExpiresAt(hint);
  if (expires !== null && now >= expires) return { ...base, detail: HINT_STALE };
  if (hint.action === 'in') return { ...base, primary: 'in' };
  if (hint.action === 'out') {
    const slot = slotOf(today, hint);
    const end = slot ? slot.windows.end : null;
    if (end !== null && now < end) return { ...base, early: true, earlyMinutes: end - now };
    return { ...base, primary: 'out' };
  }
  return base;
}

/** 打卡结果的一句话：09:02 上班卡 · 准时 / 迟到 3 分钟 / 早退 10 分钟 */
export function punchResultText(p: Pick<OaPunch, 'localTime' | 'kind' | 'lateMinutes' | 'earlyMinutes' | 'outwork'>): string {
  const kind = p.kind === 'in' ? '上班卡' : p.kind === 'out' ? '下班卡' : p.kind === 'outside' ? '窗口外打卡' : '休息日打卡';
  const tail = p.lateMinutes ? `迟到 ${p.lateMinutes} 分钟` : p.earlyMinutes ? `早退 ${p.earlyMinutes} 分钟` : p.kind === 'in' || p.kind === 'out' ? '准时' : '已记下';
  return `${p.localTime} ${kind} · ${tail}${p.outwork ? ' · 外勤' : ''}`;
}

/** 这一张卡算不算有问题（迟到、早退：结果用陶土红） */
export const punchIsLate = (p: Pick<OaPunch, 'lateMinutes' | 'earlyMinutes'>) => p.lateMinutes > 0 || p.earlyMinutes > 0;
