// 巡场页与巡场记录页的样子（员工小程序线 E，docs/STAFF_MP.md 第 5.4 节）：一律照门店系统回的这一天（轮次、各场所每一轮的打卡），
// 小程序不另算轮次。纯函数，tests/patrol-view.test.ts 核对。

import type { PatrolCheckinResult, PatrolPortalDay, PatrolScan } from '../../../src/shared/patrol';
import { shortTime } from './format';

export interface PatrolPointView {
  id: number;
  name: string;
  area: string;
  /** done 巡过 / todo 还没巡 / off 这一轮不用巡 */
  state: 'done' | 'todo' | 'off';
  text: string;
}

export interface PatrolRoundView {
  no: number;
  time: string;
  state: 'past' | 'current' | 'future';
  done: number;
  expected: number;
  /** 已经结束、还有没巡的 */
  missed: boolean;
}

export interface PatrolView {
  /** 看的是哪一轮（今天：正在巡的这一轮；以前：最后一轮） */
  roundNo: number | null;
  roundText: string;
  /** 「这一轮还差 3 个场所」/「这一轮都巡过了」 */
  progress: string;
  allDone: boolean;
  points: PatrolPointView[];
  rounds: PatrolRoundView[];
  mine: number;
  total: number;
  missed: number;
  people: { employeeId: number; name: string; count: number }[];
}

const hm = (iso: string) => shortTime(iso, new Date(iso));
const scanText = (s: PatrolScan) => `${hm(s.at)} ${s.name}${s.late ? ' · 补登' : ''}`;

export function patrolView(day: PatrolPortalDay, pick: number | null = null): PatrolView {
  const roundNo = pick ?? day.currentRound ?? (day.rounds.length ? day.rounds[day.rounds.length - 1]!.no : null);
  const idx = day.rounds.findIndex((r) => r.no === roundNo);
  const round = idx >= 0 ? day.rounds[idx]! : null;
  const points: PatrolPointView[] = day.points
    .map((p) => {
      const scans = idx >= 0 ? p.byRound[idx] : null;
      if (scans === null || scans === undefined) return { id: p.id, name: p.name, area: p.area, state: 'off' as const, text: '这一轮不用巡' };
      if (scans.length) return { id: p.id, name: p.name, area: p.area, state: 'done' as const, text: scanText(scans[0]!) };
      return { id: p.id, name: p.name, area: p.area, state: 'todo' as const, text: round && round.state === 'past' ? '漏巡' : '还没巡' };
    })
    .filter((p) => p.state !== 'off')
    .sort((a, b) => (a.state === b.state ? 0 : a.state === 'todo' ? -1 : 1));
  const left = points.filter((p) => p.state === 'todo').length;
  const isCurrent = round !== null && round.state === 'current';
  return {
    roundNo,
    roundText: round ? `第 ${round.no} 轮 · ${hm(round.start)}–${hm(round.end)}` : '这一天没有轮次',
    progress: !round
      ? ''
      : left === 0
        ? points.length
          ? '这一轮都巡过了'
          : '这一轮没有要巡的场所'
        : isCurrent
          ? `这一轮还差 ${left} 个场所`
          : round.state === 'past'
            ? `这一轮漏了 ${left} 个场所`
            : `这一轮有 ${left} 个场所要巡`,
    allDone: !!round && left === 0,
    points,
    rounds: day.rounds.map((r) => ({ no: r.no, time: `${hm(r.start)}–${hm(r.end)}`, state: r.state, done: r.done, expected: r.expected, missed: r.state === 'past' && r.done < r.expected })),
    mine: day.mine,
    total: day.total,
    missed: day.missed,
    people: day.people.map((p) => ({ employeeId: p.employeeId, name: p.name, count: p.count })),
  };
}

/** 扫完一个场所的一句话 */
export function patrolResultText(r: PatrolCheckinResult): { tone: 'ok' | 'already'; title: string; sub: string } {
  const c = r.checkin;
  const round = r.round ? `第 ${r.round.no} 轮` : '';
  if (r.status === 'ok') return { tone: 'ok', title: `✓ ${c.pointName}`, sub: [round, c.area, `今天这里巡了 ${r.pointCount} 次`].filter((x) => x).join(' · ') };
  return { tone: 'already', title: `${c.pointName} 这一轮已经巡过`, sub: `${c.mine ? '你' : c.employeeName}在 ${hm(c.at)} 打过卡，不再多记` };
}

// ── 交给巡场页的码：微信扫一扫直接打开巡场页（码在启动参数 q 里）、首页「扫一扫」扫到的 ──

/** 登录、读完再交（存在手机上，10 分钟内有效）；via 是扫码方式（首页扫的是 scan，微信扫一扫打开的是 link） */
const LINK_KEY = 'wcp_patrol_link';
const LINK_TTL_MS = 10 * 60 * 1000;

export function savePatrolLink(code: string, via: 'scan' | 'link' = 'link'): void {
  try {
    wx.setStorageSync(LINK_KEY, { code, at: Date.now(), via });
  } catch {
    // 存不下：这一下没记上，页面上照样能再扫
  }
}

export function takePatrolLink(): { code: string; at: number; via: 'scan' | 'link' } | null {
  try {
    const v = wx.getStorageSync(LINK_KEY) as { code: string; at: number; via?: 'scan' | 'link' } | '';
    wx.removeStorageSync(LINK_KEY);
    return v && typeof v.code === 'string' && Date.now() - v.at < LINK_TTL_MS ? { code: v.code, at: v.at, via: v.via === 'scan' ? 'scan' : 'link' } : null;
  } catch {
    return null;
  }
}

/** 手机上有没有等着交的巡场码（不取走）：登录以后首页看到就转去巡场页 */
export function hasPatrolLink(): boolean {
  try {
    const v = wx.getStorageSync(LINK_KEY) as { code: string; at: number } | '';
    return !!v && typeof v.code === 'string' && Date.now() - v.at < LINK_TTL_MS;
  } catch {
    return false;
  }
}
