// 福田店整改（2026-11-26《福田店餐饮与房态中心整改需求文档》，docs/FUTIAN_1126.md）：房态中心后台可配置的参数——
// 三个时限（换技师 FT-06、撤房免费 FT-09、下钟后免房费 FT-10），房间按时间计费的规则（FT-17 ④），虫洞的清洁时段（FT-18）。
// 存在 settings 表的 room_center_rules 一行；没设过的按下面的默认（默认建议都是 15 分钟，房间计费默认不开）。

import { HHMM, minuteOfDay } from './business-date';
import { chargedUsageMinutes } from './usages';

export const ROOM_CENTER_RULES_KEY = 'room_center_rules';

/** 房间按时间计费（FT-17 ④）：按业态设；计费项目的价格是每小时多少（与派对房一样），封顶 0 为不封顶 */
export interface RoomFeeRule {
  businessType: string;
  enabled: boolean;
  /** 房费记在哪个项目上（价目表里的项目，价格 = 每小时多少；项目的分类就是部门营业额里的部门） */
  feeItemId: number | null;
  /** 起步时长（分钟）：计费以后不足起步的按起步算 */
  minMinutes: number;
  /** 计费单位（分钟）：之后每多少分钟计一次，不足一个单位按一个单位 */
  stepMinutes: number;
  /** 封顶（分）：0 不封顶 */
  capCents: number;
}

/** 虫洞清洁时段（FT-18）：每天几点到几点（HH:MM，门店时区）；跨零点的写成 22:00–02:00 */
export interface CleanWindow {
  start: string;
  end: string;
}

export interface RoomCenterRules {
  /** FT-06：技师上钟后多少分钟内可以在房态中心换技师（0 = 不让换） */
  swapTechMinutes: number;
  /** FT-09：登记（开房）后多少分钟内可以撤房，撤房不收费（0 = 不让撤） */
  revokeMinutes: number;
  /** FT-10：技师下钟后多少分钟内不收房间费用 */
  freeAfterClockOffMinutes: number;
  /** FT-17 ④：房间按时间计费的规则（按业态）；没设的业态不收房费 */
  roomFees: RoomFeeRule[];
  /** FT-18：虫洞位（这几种业态）与清洁时段 */
  wormhole: { businessTypes: string[]; cleanWindows: CleanWindow[]; feeItemId: number | null };
  /** FT-17 ②③：房间里能挂的零售商品与杂项费——这几个分类里的项目（项目在后台「价目」里维护名称、编号、价格） */
  goodsCategories: string[];
}

export const DEFAULT_ROOM_CENTER_RULES: RoomCenterRules = {
  swapTechMinutes: 15,
  revokeMinutes: 15,
  freeAfterClockOffMinutes: 15,
  roomFees: [],
  wormhole: { businessTypes: ['虫洞'], cleanWindows: [], feeItemId: null },
  goodsCategories: ['零售', '杂项'],
};

export const MAX_RULE_MINUTES = 240;
export const ROOM_FEE_STEP_OPTIONS = [15, 30, 60] as const;
export const MAX_ROOM_FEE_MIN_MINUTES = 600;
export const MAX_CLEAN_WINDOWS = 6;

/** 读出来的设置补齐默认（旧数据、少了几项的都照默认） */
export function normalizeRoomCenterRules(raw: unknown): RoomCenterRules {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<RoomCenterRules>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_RULE_MINUTES ? v : d);
  const w = (r.wormhole ?? {}) as Partial<RoomCenterRules['wormhole']>;
  return {
    swapTechMinutes: num(r.swapTechMinutes, DEFAULT_ROOM_CENTER_RULES.swapTechMinutes),
    revokeMinutes: num(r.revokeMinutes, DEFAULT_ROOM_CENTER_RULES.revokeMinutes),
    freeAfterClockOffMinutes: num(r.freeAfterClockOffMinutes, DEFAULT_ROOM_CENTER_RULES.freeAfterClockOffMinutes),
    roomFees: Array.isArray(r.roomFees) ? r.roomFees.filter((f) => f && typeof f.businessType === 'string') : [],
    wormhole: {
      businessTypes: Array.isArray(w.businessTypes) ? w.businessTypes.filter((t) => typeof t === 'string' && t.trim()) : [...DEFAULT_ROOM_CENTER_RULES.wormhole.businessTypes],
      cleanWindows: Array.isArray(w.cleanWindows) ? w.cleanWindows.filter((c) => c && HHMM.test(c.start) && HHMM.test(c.end)) : [],
      feeItemId: typeof w.feeItemId === 'number' ? w.feeItemId : null,
    },
    goodsCategories: Array.isArray(r.goodsCategories) ? r.goodsCategories.filter((c) => typeof c === 'string' && c.trim()) : [...DEFAULT_ROOM_CENTER_RULES.goodsCategories],
  };
}

/** 这种业态的房费规则（开着、设了项目的才算） */
export function roomFeeRuleOf(rules: RoomCenterRules, businessType: string): RoomFeeRule | null {
  const r = rules.roomFees.find((f) => f.businessType === businessType);
  return r && r.enabled && r.feeItemId ? r : null;
}

/**
 * 房费从什么时候开始算（FT-10）：最后一位技师下钟的时刻 + 免费时长；还有钟没下的、一个钟都没做完的不算房费（null）
 */
export function roomFeeStartsAt(lastClockOff: string | null, freeMinutes: number): Date | null {
  if (!lastClockOff) return null;
  return new Date(new Date(lastClockOff).getTime() + freeMinutes * 60_000);
}

/**
 * 房费（FT-17 ④）：从开始计费到现在的分钟（向下取整）——不到开始计费的为 0（不收）；
 * 收的按起步与计费单位取整（与派对房同一个算法），单价 = 每小时价 × 单位 ÷ 60，四舍五入到分；超过封顶的按封顶。
 */
export function roomTimeFee(startsAt: Date | null, at: Date, rule: Pick<RoomFeeRule, 'minMinutes' | 'stepMinutes' | 'capCents'>, hourPrice: number) {
  const minutes = startsAt ? Math.max(0, Math.floor((at.getTime() - startsAt.getTime()) / 60_000)) : 0;
  if (minutes <= 0 || hourPrice <= 0) return { minutes, chargedMinutes: 0, amount: 0, capped: false };
  const charged = chargedUsageMinutes(minutes, rule);
  const steps = Math.ceil(charged / rule.stepMinutes);
  const raw = Math.round((hourPrice * rule.stepMinutes) / 60) * steps;
  const capped = rule.capCents > 0 && raw > rule.capCents;
  return { minutes, chargedMinutes: steps * rule.stepMinutes, amount: capped ? rule.capCents : raw, capped };
}

/** 时限还剩几分钟（换技师、撤房按钮上写）；过了为 0 */
export function minutesLeft(since: string | null, limit: number, now: number): number {
  if (!since || limit <= 0) return 0;
  return Math.max(0, Math.ceil((new Date(since).getTime() + limit * 60_000 - now) / 60_000));
}

/** 现在是不是在某个清洁时段里（FT-18；HH:MM 按门店时区，跨零点的时段照算） */
export function inCleanWindow(windows: readonly CleanWindow[], at: Date, timeZone: string): boolean {
  const now = minuteOfDay(at, timeZone);
  const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return windows.some((w) => {
    const [s, e] = [toMin(w.start), toMin(w.end)];
    return s <= e ? now >= s && now < e : now >= s || now < e;
  });
}

/** 是不是虫洞位（FT-18） */
export const isWormholeType = (rules: Pick<RoomCenterRules, 'wormhole'>, businessType: string) => rules.wormhole.businessTypes.includes(businessType);
