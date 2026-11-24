// 8.0.9 安保巡场（docs/PATROL_V809.md）：员工端（柚子饭堂「工作台 → 巡场」）与后台（ERP「员工工作台 → 安保巡场」）共用的格式与数据。
// 8.0.11 巡场轮次（店主 2026-11-11，docs/PATROL_V809.md 第 11 节）：营业日按巡场间隔分成几轮，同一个场所每轮只记一次打卡。

import { businessDateOf, businessDayStart } from './business-date';

/** 场所码：12 位 base32（大写字母与 2–7），随机生成；印在二维码里 */
export const PATROL_TOKEN_LENGTH = 12;
export const PATROL_TOKEN_PATTERN = /^[A-Z2-7]{12}$/;
export const MAX_PATROL_POINT_NAME = 20;
export const MAX_PATROL_POINT_AREA = 40;
/** 巡场间隔（XC13）：默认 3 小时一轮；可以设 30 分钟到 24 小时，按半小时调 */
export const PATROL_ROUND_DEFAULT_MINUTES = 180;
export const PATROL_ROUND_MIN_MINUTES = 30;
export const PATROL_ROUND_MAX_MINUTES = 1440;
export const PATROL_ROUND_STEP_MINUTES = 30;
/** 扫到与入库差这么多分钟以上的标「离线补登」（XC7） */
export const PATROL_LATE_MINUTES = 2;
/** 只收这么多小时内扫到的（断网补交，XC7） */
export const PATROL_MAX_LATE_HOURS = 24;
/** 记录一次最多查多少天、手机上最多看多少天以前（XC2） */
export const PATROL_MAX_DAYS = 92;
export const MAX_PATROL_VOID_REASON = 100;

export const PATROL_VIAS = ['scan', 'link', 'photo'] as const;
export type PatrolVia = (typeof PATROL_VIAS)[number];
export const PATROL_VIA_LABELS: Record<PatrolVia, string> = { scan: '工作台扫码', link: '直接扫码', photo: '拍照识别' };

/** 二维码里的地址：员工入口地址 + #patrol=场所码（用手机相机、微信直接扫开就是柚子饭堂的巡场页） */
export function patrolLink(portalUrl: string, token: string): string {
  return `${portalUrl.replace(/\/+$/, '')}/#patrol=${token}`;
}

/**
 * 从扫到的文字里认出场所码：整个地址（…#patrol=码，也认 #/patrol=码）或单独的码。
 * 不是巡场码的返回 null（例如扫到了饭卡码、别的网址）。
 */
export function parsePatrolToken(text: string): string | null {
  const t = text.trim();
  const m = /#\/?patrol[=/]([A-Za-z2-7]{12})(?:$|[&?#/])/.exec(t);
  const raw = m ? m[1]! : t;
  const token = raw.toUpperCase();
  return PATROL_TOKEN_PATTERN.test(token) ? token : null;
}

// ── 巡场轮次（XC13–XC15） ──

/**
 * 巡场间隔从哪个营业日起是多少分钟（改间隔时记一条，从改的那个营业日起按新的分轮）。
 * 安保巡场起始时间（店主 2026-11-24，XC17）：startHour 是巡查起始的整点（0–23），没有（null）就照原来从营业日切换时间起；
 * at 是改起始时间的那一刻——那一天在这一刻以前的轮次照旧，正在巡的那一轮到新起点算出的下一个整点为止，之后按新的排（XC18）。
 * 只改间隔的照原来：从这一天的营业日开始起整天按新的分（没有 at）。
 */
export interface PatrolRoundChange {
  from: string;
  minutes: number;
  startHour?: number | null;
  at?: string;
}

export const PATROL_START_HOURS = Array.from({ length: 24 }, (_, h) => h);
/** 「09:00」 */
export const patrolStartHourText = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** 某个营业日开始时用的巡场设置：最后一条早于这一天的，加上这一天里没有 at 的（照原来整天生效）；一条都没有用默认的 3 小时、不设起始时间 */
function patrolConfigBefore(changes: readonly PatrolRoundChange[], date: string): { minutes: number; startHour: number | null } {
  let cfg = { minutes: PATROL_ROUND_DEFAULT_MINUTES, startHour: null as number | null };
  for (const c of sortedChanges(changes)) {
    if (c.from > date || (c.from === date && c.at)) continue;
    cfg = { minutes: c.minutes, startHour: c.startHour ?? null };
  }
  return cfg;
}

/** 按营业日、同一天按改的时刻排（没有 at 的排在这一天最前） */
function sortedChanges(changes: readonly PatrolRoundChange[]): PatrolRoundChange[] {
  return [...changes].sort((a, b) => a.from.localeCompare(b.from) || (a.at ?? '').localeCompare(b.at ?? ''));
}

/** 某个营业日用的巡场间隔：最后一条不晚于这一天的；一条都没有用默认的 3 小时 */
export function patrolRoundMinutesOn(changes: readonly PatrolRoundChange[], date: string): number {
  return patrolSettingOn(changes, date).minutes;
}

/** 某个营业日最后用的巡场设置（间隔与起始时间；这一天当中改过的取改后的） */
export function patrolSettingOn(changes: readonly PatrolRoundChange[], date: string): { minutes: number; startHour: number | null } {
  let cfg = { minutes: PATROL_ROUND_DEFAULT_MINUTES, startHour: null as number | null };
  for (const c of sortedChanges(changes)) if (c.from <= date) cfg = { minutes: c.minutes, startHour: c.startHour ?? null };
  return cfg;
}

export interface PatrolRoundSpan {
  /** 第几轮（从 1 起） */
  no: number;
  start: string;
  end: string;
}

const shiftDay = (date: string, days: number) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const plusOneDay = (date: string) => shiftDay(date, 1);

/**
 * 巡场的一天从几点起（店主 2026-11-24，XC19）：设了巡查起始时间的，巡场的一天就从起始整点起 24 小时（起始 00:00 就是自然日），
 * 每一轮都是整的间隔、不被营业日切换截短；没设的照原来跟营业日（XC4）。用这一天开始时的设置（前几天的改动、这一天整天生效的改动）。
 */
function naturalStartMs(changes: readonly PatrolRoundChange[], date: string, timeZone: string, businessDayStartHour: number): number {
  return businessDayStart(date, timeZone, patrolConfigBefore(changes, date).startHour ?? businessDayStartHour).getTime();
}

/** 这一天实际从哪一刻开始：前一天改起始时间的那一刻晚于新的开始时（例如凌晨 3 点改成 00:00 起），这一天从改的那一刻开始，已经过去的不挪 */
function dayStartMs(changes: readonly PatrolRoundChange[], date: string, timeZone: string, businessDayStartHour: number): number {
  const prev = shiftDay(date, -1);
  const ats = changes.filter((c) => c.from === prev && c.at).map((c) => Date.parse(c.at!));
  return Math.max(naturalStartMs(changes, date, timeZone, businessDayStartHour), ...ats);
}

/** 某一刻记到巡场的哪一天（XC4、XC19）：这一天的开始不晚于这一刻的那一天 */
export function patrolDateAt(changes: readonly PatrolRoundChange[], at: Date | string, timeZone: string, businessDayStartHour: number): string {
  const t = new Date(at).getTime();
  const day = businessDateOf(new Date(t), timeZone, 0);
  // 任何一天都在当天 00:00–23:00 之间开始：不是这一天就是前一天
  return dayStartMs(changes, day, timeZone, businessDayStartHour) <= t ? day : shiftDay(day, -1);
}

/** [from, end) 里按起点 anchor、每 step 一轮的分界：第一轮从 from 起，到 from 之后的第一个分界 */
function spansFrom(from: number, end: number, anchor: number, step: number): [number, number][] {
  const out: [number, number][] = [];
  let b = anchor + Math.floor((from - anchor) / step) * step;
  if (b <= from) b += step;
  let t = from;
  while (t < end) {
    const next = Math.min(b, end);
    out.push([t, next]);
    t = next;
    b += step;
  }
  return out;
}

/**
 * 一个巡场日的各轮（设置一直不变时）：从这一天的开始起每 minutes 分钟一轮；间隔除不尽 24 小时时最后一轮短一些。
 * 这一天的开始：设了巡查起始整点（patrolStartHour）就是那个整点（XC19），没设就是营业日切换时间 startHour。
 */
export function patrolRoundsOf(date: string, timeZone: string, startHour: number, minutes: number, patrolStartHour: number | null = null): PatrolRoundSpan[] {
  const hour = patrolStartHour ?? startHour;
  const start = businessDayStart(date, timeZone, hour).getTime();
  const end = businessDayStart(plusOneDay(date), timeZone, hour).getTime();
  return spansFrom(start, end, start, minutes * 60_000).map(([a, b], i) => ({
    no: i + 1,
    start: new Date(a).toISOString(),
    end: new Date(b).toISOString(),
  }));
}

/**
 * 某个巡场日的各轮（按改动记录，XC13–XC19）与每一轮按的巡场间隔（打卡记下它，同一个场所同一轮只记一次）。
 * 这一天从这一天开始时的设置算起，到下一天的开始为止（下一天按改过的设置开始，所以改起始时间的那一天会长一些或短一些）。
 * 这一天改过起始时间（有 at）的：at 以前开始的轮照旧；at 那一刻正在巡的那一轮到新设置的下一个分界为止；之后按新的排，最后一轮正好到第二天的开始。
 */
export function patrolDayRounds(
  changes: readonly PatrolRoundChange[],
  date: string,
  timeZone: string,
  dayStartHour: number,
): { rounds: PatrolRoundSpan[]; minutes: number; minutesOf: (round: PatrolRoundSpan) => number } {
  const start = dayStartMs(changes, date, timeZone, dayStartHour);
  const end = dayStartMs(changes, plusOneDay(date), timeZone, dayStartHour);
  const base = patrolConfigBefore(changes, date);
  let spans = spansFrom(start, end, naturalStartMs(changes, date, timeZone, dayStartHour), base.minutes * 60_000).map(([a, b]) => ({ a, b, minutes: base.minutes }));
  for (const c of sortedChanges(changes)) {
    if (c.from !== date || !c.at) continue;
    const at = Math.min(Math.max(Date.parse(c.at), start), end);
    const step = c.minutes * 60_000;
    // 新设置的分界：按新起始整点在第二天的那一刻往回排（这一天改过以后，第二天就从那一刻开始）
    const anchor = businessDayStart(plusOneDay(date), timeZone, c.startHour ?? dayStartHour).getTime();
    const kept = spans.filter((s) => s.a < at);
    let from = start;
    const last = kept.at(-1);
    if (last && last.b > at) {
      // 正在巡的这一轮：开始照旧，到新设置在这一刻以后的第一个分界为止（已经结束的轮一点不动）
      let b = anchor + Math.floor((at - anchor) / step) * step;
      if (b <= at) b += step;
      last.b = Math.min(b, end);
      from = last.b;
    } else if (last) {
      from = last.b;
    }
    spans = [...kept, ...spansFrom(from, end, anchor, step).map(([a, b]) => ({ a, b, minutes: c.minutes }))];
  }
  const rounds = spans.map((s, i) => ({ no: i + 1, start: new Date(s.a).toISOString(), end: new Date(s.b).toISOString() }));
  const byStart = new Map(spans.map((s) => [new Date(s.a).toISOString(), s.minutes]));
  const last = patrolSettingOn(changes, date);
  return { rounds, minutes: last.minutes, minutesOf: (r) => byStart.get(r.start) ?? last.minutes };
}

/**
 * 设置页的轮次时间表预览（XC17、XC19）：从巡查起始整点（没设就是营业日切换整点）起的一天，每隔 minutes 一轮的开始、结束（「09:00」，跨午夜照写钟点）。
 * 与 patrolRoundsOf 同一个分法，只是按钟点算、不看日期与时区。
 */
export function patrolRoundPreview(dayStartHour: number, minutes: number, startHour: number | null): { no: number; start: string; end: string; minutes: number }[] {
  const from = (startHour ?? dayStartHour) * 60;
  const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return spansFrom(from, from + 1440, from, minutes).map(([a, b], i) => ({ no: i + 1, start: clock(a), end: clock(b), minutes: b - a }));
}

/** 某一刻在这一天的第几轮（不在这一天里返回 null） */
export function patrolRoundAt(rounds: readonly PatrolRoundSpan[], at: Date | string): PatrolRoundSpan | null {
  const t = new Date(at).getTime();
  return rounds.find((r) => t >= Date.parse(r.start) && t < Date.parse(r.end)) ?? null;
}

/** 「3 小时」「1.5 小时」「30 分钟」 */
export function patrolIntervalText(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Number((minutes / 60).toFixed(1))} 小时`;
}

// ── 后台 ──

export interface PatrolPoint {
  id: number;
  name: string;
  area: string;
  token: string;
  active: boolean;
  sortOrder: number;
  version: number;
  createdAt: string;
  tokenChangedAt: string | null;
  /** 今天（营业日）巡了几次 */
  todayCount: number;
}

/** 巡场记录筛选用的场所（含停用的、不含场所码；有「看记录」权限就能取，Codex 审查 41a2fbb） */
export interface PatrolPointOption {
  id: number;
  name: string;
  area: string;
  active: boolean;
}

export interface PatrolPointsAdmin {
  points: PatrolPoint[];
  /** 员工入口地址（「员工食堂 → 设置」里填的）：打印二维码用；没填为空 */
  portalUrl: string;
  today: string;
}

export interface PatrolSettings {
  /** 巡场部门（XC1） */
  departmentIds: number[];
  /** 手机上能看巡场记录的员工（柚子饭堂的员工账号，XC2） */
  viewerIds: number[];
  /** 现在（今天起）的巡场间隔，分钟（XC13） */
  roundMinutes: number;
  /** 现在的巡查起始整点（0–23，XC17）；没设为 null，照原来从营业日切换时间起 */
  startHour: number | null;
  /** 巡场间隔改过的记录：过去的营业日按当时的间隔分轮 */
  roundChanges: PatrolRoundChange[];
  /** 版本号：两个人同时改，后保存的拒绝 */
  rev: number;
}

export interface PatrolSettingsAdmin extends PatrolSettings {
  departments: { id: number; name: string; active: boolean }[];
  employees: { id: number; empNo: string; name: string; department: string; active: boolean }[];
  /** 现在巡场部门里有几位启用的员工 */
  patrolStaffCount: number;
  /** 营业日切换的整点（预览轮次时间表用，XC17） */
  businessDayStartHour: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PatrolCheckinRow {
  id: number;
  pointId: number;
  pointName: string;
  employeeId: number;
  empNo: string;
  name: string;
  department: string;
  businessDate: string;
  scannedAt: string;
  recordedAt: string;
  via: PatrolVia;
  /** 离线补登：扫到与入库差 2 分钟以上 */
  late: boolean;
  /** 扫到的时间在这一天的第几轮（按这一天的巡场间隔） */
  roundNo: number | null;
  voidedAt: string | null;
  voidReason: string | null;
  voidedByName: string | null;
}

export interface PatrolScan {
  id: number;
  at: string;
  employeeId: number;
  name: string;
  empNo: string;
  via: PatrolVia;
  late: boolean;
}

/** 一轮：过去的（已经结束）、正在巡的这一轮、还没到的 */
export interface PatrolRound extends PatrolRoundSpan {
  state: 'past' | 'current' | 'future';
  /** 这一轮要巡的场所数（这一轮结束前建的启用场所，加上这一轮巡过的停用场所） */
  expected: number;
  /** 这一轮巡过的场所数 */
  done: number;
}

/** 一天的巡场清单（后台「今天」与手机「巡场记录」共用） */
export interface PatrolDay {
  date: string;
  today: string;
  /** 这一天的巡场间隔（分钟） */
  roundMinutes: number;
  rounds: PatrolRound[];
  /** 今天正在巡的是第几轮（看的不是今天时为 null） */
  currentRound: number | null;
  points: {
    id: number;
    name: string;
    area: string;
    active: boolean;
    count: number;
    /** 这一天巡过的（没作废的，按时间） */
    scans: PatrolScan[];
    /** 每一轮的打卡（与 rounds 一一对应）：null 是这一轮不用巡（那时还没建这个场所，或停用了、这一轮也没人巡） */
    byRound: (PatrolScan[] | null)[];
  }[];
  /** 这一天巡场的人与次数 */
  people: { employeeId: number; name: string; empNo: string; count: number }[];
  total: number;
  /** 已经结束的各轮里漏巡的（场所 × 轮）个数 */
  missed: number;
  /** 正在巡的这一轮还没巡的场所数（看的不是今天时为 null） */
  currentMissing: number | null;
}

export interface PatrolRecords {
  rows: PatrolCheckinRow[];
  /** 没作废的条数 */
  total: number;
  voided: number;
}

// ── 员工端（柚子饭堂） ──

/** 员工端工作台里的应用（巡场相关的由门店系统按部门、名单算，食堂的按角色在手机上算） */
export const PATROL_APPS = ['patrol', 'patrolLog'] as const;
export type PatrolApp = (typeof PATROL_APPS)[number];

export interface PatrolCheckinResult {
  /** ok：记上了；already：这个场所这一轮已经有人打过卡（XC14），不另记 */
  status: 'ok' | 'already';
  /** status 为 already 时是这一轮之前打的那一笔（可能是别人打的） */
  checkin: { id: number; pointName: string; area: string; at: string; late: boolean; employeeName: string; mine: boolean };
  /** 这一笔落在这一天的第几轮 */
  round: PatrolRoundSpan | null;
  /** 今天（营业日）这个场所一共巡了几次 */
  pointCount: number;
}

/** 员工端「今天」：巡场部门的人看今天，能看记录的人可以看任何一天 */
export interface PatrolPortalDay extends PatrolDay {
  /** 这位员工这一天巡了几次 */
  mine: number;
  canViewHistory: boolean;
}
