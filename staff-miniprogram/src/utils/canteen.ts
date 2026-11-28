// 吃饭与巡场（员工小程序线 E，docs/STAFF_MP.md 第 5.4 节）：员工账号对上的饭堂身份在门店系统里，规则照柚子饭堂与巡场原来的。
//   · 饭卡码：码钥匙与服务器时间差存在手机上（按员工存），没信号、登录过期都照样能亮（第 2.8 节）；
//   · 负责人扫码、巡场打卡：扫到的先存在手机上（读回核对，存不下就不发），交给门店系统；没收到明确结果的留着，
//     之后按原来的操作编号原样补交（只收 24 小时内扫到的，按扫到的时刻核对）。打卡（考勤）不这样排队，见打卡页。

import type { CanteenMe, CanteenMenu, CanteenPerson, CanteenToday, CheckinResult } from '../../../src/shared/canteen';
import type { PatrolCheckinResult, PatrolPortalDay } from '../../../src/shared/patrol';
import type { StaffMpCanteenStatus } from '../../../src/shared/staffmp';
import type { ApiError } from './api';
import { call, isApiError } from './api';
import { dayLabel } from './format';

// ── 接口 ──

export const canteenStatus = () => call<StaffMpCanteenStatus>('GET', '/canteen/status');
export const linkCanteen = (account: string, password: string) => call<StaffMpCanteenStatus>('POST', '/canteen/link', { account, password });
export const createCanteen = () => call<StaffMpCanteenStatus>('POST', '/canteen/create', {});
export const loadMenus = (from: string, to: string) => call<CanteenMenu[]>('GET', `/canteen/menus?from=${from}&to=${to}`);
export const likeDish = (menuId: number, dishId: string, liked: boolean) => call<{ likes: number; liked: boolean }>('PUT', '/canteen/likes', { menuId, dishId, liked });
export const canteenToday = () => call<CanteenToday>('GET', '/canteen/today');
export const searchPeople = (q: string) => call<CanteenPerson[]>('GET', `/canteen/people?q=${encodeURIComponent(q)}`);
export const voidCheckin = (id: number, reason: string) => call<unknown>('POST', `/canteen/checkins/${id}/void`, { reason });
export const patrolDay = (date?: string) => call<PatrolPortalDay>('GET', `/canteen/patrol/day${date ? `?date=${date}` : ''}`);

// ── 饭卡码的钥匙（按员工存在手机上） ──

export interface MealKey {
  staffId: number;
  me: CanteenMe;
  /** 服务器时间 − 手机时间（毫秒）：手机时间不准时按它修正 */
  offsetMs: number;
  savedAt: number;
}

const KEY_PREFIX = 'wcp_meal_key:';

export function loadMealKey(staffId: number): MealKey | null {
  try {
    const v = wx.getStorageSync(KEY_PREFIX + staffId) as MealKey | '';
    return v && v.me && typeof v.me.codeKey === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** 饭卡解开了（后台解开、对错了人）：删掉手机上存着的码钥匙，不再亮码 */
export function dropMealKey(staffId: number): void {
  try {
    wx.removeStorageSync(KEY_PREFIX + staffId);
  } catch {
    // 删不掉也不要紧：解开时门店系统已经让那把钥匙作废
  }
}

/** 饭卡码里的饭堂员工编号（YZC1:<编号36进制>:…）；不是饭卡码为 null */
export function mealCodeEmployee(raw: string): number | null {
  if (!isMealCode(raw)) return null;
  const id = parseInt(raw.trim().toUpperCase().split(':')[1]!, 36);
  return isFinite(id) && id > 0 ? id : null;
}

/** 取「吃饭的我是谁」并把码钥匙存下（下次没信号也能亮码） */
export async function refreshMealKey(staffId: number): Promise<MealKey> {
  const sent = Date.now();
  const me = await call<CanteenMe>('GET', '/canteen/me');
  const received = Date.now();
  // 服务器时间按请求来回的中点算
  const offsetMs = Date.parse(me.serverTime) - Math.round((sent + received) / 2);
  const key: MealKey = { staffId, me, offsetMs: isFinite(offsetMs) ? offsetMs : 0, savedAt: received };
  try {
    wx.setStorageSync(KEY_PREFIX + staffId, key);
  } catch {
    // 存不了：这次照样亮，只是下次没信号时没有
  }
  return key;
}

/** 门店此刻是哪一餐的开饭时间（餐次的起止是 HH:MM；跨午夜的夜宵算开始那天） */
export function mealNow<W extends { start: string; end: string; enabled: boolean }>(meals: readonly W[], hhmm: string): W | null {
  for (const m of meals) {
    if (!m.enabled) continue;
    if (m.start <= m.end ? hhmm >= m.start && hhmm < m.end : hhmm >= m.start || hhmm < m.end) return m;
  }
  return null;
}

// ── 扫到的先存下、再交（负责人扫码、巡场打卡） ──

export type ScanKind = 'checkin' | 'patrol';

export interface QueuedScan {
  kind: ScanKind;
  body: { clientKey: string; code?: string; employeeId?: number; scannedAt: string; note?: string; via?: 'scan' | 'link' };
  /** 给人看的：扫到的是什么、手动登记的是谁 */
  label: string;
  savedAt: number;
}

/** queued：结果不明，留在手机上等补交；expired 为登录过期（重新登录以后补交） */
export type ScanOutcome<T> = { kind: 'done'; result: T } | { kind: 'rejected'; error: ApiError } | { kind: 'queued'; expired: boolean };

const qKey = (kind: ScanKind, employeeId: number) => `wcp_scan_q:${kind}:${employeeId}`;

export function loadQueue(kind: ScanKind, employeeId: number): QueuedScan[] {
  try {
    const v = wx.getStorageSync(qKey(kind, employeeId)) as QueuedScan[] | '';
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveQueue(kind: ScanKind, employeeId: number, list: QueuedScan[]): boolean {
  try {
    wx.setStorageSync(qKey(kind, employeeId), list);
    // 读回核对：存下的与要存的笔数一样才算存好
    const back = wx.getStorageSync(qKey(kind, employeeId)) as QueuedScan[] | '';
    return Array.isArray(back) && back.length === list.length;
  } catch {
    return false;
  }
}

/** 先存下（存不下返回 false：调用方不得发出请求） */
export function enqueue(employeeId: number, item: QueuedScan): boolean {
  const list = loadQueue(item.kind, employeeId).filter((x) => x.body.clientKey !== item.body.clientKey);
  return saveQueue(item.kind, employeeId, [...list, item]);
}

function dequeue(kind: ScanKind, employeeId: number, clientKey: string): void {
  saveQueue(
    kind,
    employeeId,
    loadQueue(kind, employeeId).filter((x) => x.body.clientKey !== clientKey),
  );
}

const PATHS: Record<ScanKind, string> = { checkin: '/canteen/checkins', patrol: '/canteen/patrol/checkins' };
const inFlight: Record<string, true> = {};

/** 交一笔：明确结果（成功、已打过、明确拒绝）就从手机上删掉；结果不明（连不上、正忙、饭堂暂时关着、登录过期）就留着等补交 */
export async function submitScan<T extends CheckinResult | PatrolCheckinResult>(employeeId: number, item: QueuedScan): Promise<ScanOutcome<T>> {
  const k = item.body.clientKey;
  inFlight[k] = true;
  try {
    const result = await call<T>('POST', PATHS[item.kind], item.body);
    dequeue(item.kind, employeeId, k);
    return { kind: 'done', result };
  } catch (e) {
    if (isApiError(e) && e.status === 401) return { kind: 'queued', expired: true };
    if (!isApiError(e) || e.code === 'NETWORK' || e.status >= 500 || ['BUSY', 'OVERLOADED', 'RATE_LIMITED'].indexOf(e.code) >= 0) return { kind: 'queued', expired: false };
    dequeue(item.kind, employeeId, k);
    return { kind: 'rejected', error: e };
  } finally {
    delete inFlight[k];
  }
}

/** 按顺序补交手机上留着的；正在交的跳过；遇到还是结果不明的就停，等下一轮。返回还等着补交的笔数 */
export async function flushQueue<T extends CheckinResult | PatrolCheckinResult>(kind: ScanKind, employeeId: number, onSettled: (item: QueuedScan, outcome: ScanOutcome<T>) => void): Promise<number> {
  for (const item of loadQueue(kind, employeeId)) {
    if (inFlight[item.body.clientKey]) continue;
    // 另一轮补交已经交掉的不再发（这一轮拿的是开始时的名单）
    if (!loadQueue(kind, employeeId).some((x) => x.body.clientKey === item.body.clientKey)) continue;
    const outcome = await submitScan<T>(employeeId, item);
    if (outcome.kind === 'queued') break;
    onSettled(item, outcome);
  }
  return loadQueue(kind, employeeId).filter((x) => !inFlight[x.body.clientKey]).length;
}

/**
 * 巡场点的码（与主线 src/shared/patrol.ts 的 parsePatrolToken 同一个认法）：贴着的是网址（…#patrol=<12 位场所码>，也认 #/patrol=），
 * 或者只有场所码；微信扫一扫打开小程序时码在启动参数 q 里（编码过的网址）。不是巡场码的返回 null
 */
export function patrolCodeOf(raw: string): string | null {
  const t = decodeURIComponentSafe(raw.trim());
  const m = /#\/?patrol[=/]([A-Za-z2-7]{12})(?:$|[&?#/])/.exec(t);
  const token = (m ? m[1]! : t).toUpperCase();
  return /^[A-Z2-7]{12}$/.test(token) ? token : null;
}

/** 饭卡码长什么样：YZC1:…（负责人扫员工的码） */
export const isMealCode = (raw: string) => /^YZC1:[0-9A-Z]{1,10}:[0-9A-Z]{1,10}:[A-Z2-7]{8}$/.test(raw.trim().toUpperCase());

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ── 文字 ──

export const MEAL_LABELS: Record<string, string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', supper: '夜宵' };
export const TAG_LABELS: Record<string, string> = { spicy: '辣', veg: '素', new: '新', star: '招牌' };

/** 2026-11-27 往后挪几天 */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** 「午餐 10:30–14:30」 */
export function mealWindowText(w: { meal: string; start: string; end: string }): string {
  return `${MEAL_LABELS[w.meal] ?? ''} ${w.start}–${w.end <= w.start ? '次日 ' : ''}${w.end}`;
}

// ── 菜单 ──

export interface DishView {
  key: string;
  menuId: number;
  id: string;
  name: string;
  emoji: string;
  tags: string;
  likes: number;
  liked: boolean;
}
export interface MealView {
  key: string;
  meal: string;
  note: string;
  dishes: DishView[];
}
export interface DayView {
  date: string;
  label: string;
  meals: MealView[];
}

const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'supper'];

/** 菜单按天、按餐排好（纯函数，测试用） */
export function menuDays(menus: CanteenMenu[], today: string): DayView[] {
  const byDate: Record<string, CanteenMenu[]> = {};
  for (const m of menus) (byDate[m.date] = byDate[m.date] || []).push(m);
  return Object.keys(byDate)
    .sort()
    .map((date) => ({
      date,
      label: (date === today ? '今天 · ' : date === shiftDate(today, 1) ? '明天 · ' : '') + dayLabel(date),
      meals: byDate[date]!.sort((a, b) => MEAL_ORDER.indexOf(a.meal) - MEAL_ORDER.indexOf(b.meal)).map((m) => ({
        key: `${m.id}`,
        meal: MEAL_LABELS[m.meal] ?? m.meal,
        note: m.note,
        dishes: m.dishes.map((d) => ({
          key: `${m.id}:${d.id}`,
          menuId: m.id,
          id: d.id,
          name: d.name,
          emoji: d.emoji || '🍚',
          tags: d.tags
            .map((t) => TAG_LABELS[t] ?? '')
            .filter((t) => t)
            .join(' · '),
          likes: m.likes[d.id] ?? 0,
          liked: m.myLikes.indexOf(d.id) >= 0,
        })),
      })),
    }));
}
