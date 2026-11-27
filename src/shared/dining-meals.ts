// 8.2.8 餐厅入口、含餐与裸票时段价（docs/V8228_DINING_MEALS.md）：前后端共用。

export const MEAL_PERIOD_KEYS = ['breakfast', 'lunch', 'dinner', 'supper'] as const;
export type MealPeriodKey = (typeof MEAL_PERIOD_KEYS)[number];
export const MEAL_PERIOD_LABELS: Record<MealPeriodKey, string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', supper: '夜宵' };

/** 一个餐段：起止是一天里的第几分钟（end 小于 start 的跨过午夜），price 是裸票的餐费（分，0 = 这一段不供餐） */
export interface MealPeriod {
  key: MealPeriodKey;
  start: number;
  end: number;
  price: number;
}

/** 店主 2026-11-27 走场：早餐 / 夜宵 99、午餐 199、晚餐 299（时间是先定的，后台可改；8.2.8-1） */
export const DEFAULT_MEAL_PERIODS: readonly MealPeriod[] = [
  { key: 'breakfast', start: 6 * 60, end: 10 * 60 + 30, price: 9900 },
  { key: 'lunch', start: 11 * 60, end: 14 * 60 + 30, price: 19900 },
  { key: 'dinner', start: 17 * 60, end: 21 * 60, price: 29900 },
  { key: 'supper', start: 22 * 60, end: 2 * 60, price: 9900 },
];

/** 自动折扣的规则（单项打折表里档 auto 的那几条） */
export type AutoDiscountRule = 'included_meal' | 'buffet' | 'first_cup';
export const AUTO_DISCOUNT_LABELS: Record<AutoDiscountRule, string> = { included_meal: '含餐', buffet: '自助', first_cup: '首杯赠' };

const inPeriod = (p: MealPeriod, minute: number) => (p.start <= p.end ? minute >= p.start && minute < p.end : minute >= p.start || minute < p.end);

/** 一天里第几分钟落在哪个餐段（不供餐的段不算）；不在任何餐段为 null */
export function mealPeriodAt(periods: readonly MealPeriod[], minute: number): MealPeriod | null {
  return periods.find((p) => p.price > 0 && inPeriod(p, minute)) ?? null;
}

/** 这次来访能用几餐：在店不到 12 小时按 12 小时档，满了按 24 小时档（门票的档数 segments） */
export function mealAllowance(ticket: { meals12h: number; meals24h: number } | null, segments: number): number {
  if (!ticket) return 0;
  return segments >= 2 ? ticket.meals24h : ticket.meals12h;
}

/** 餐段的时间写成「06:00–10:30」 */
export function mealPeriodRange(p: { start: number; end: number }): string {
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${hm(p.start)}–${p.end < p.start ? '次日 ' : ''}${hm(p.end)}`;
}

/** 入口刷手牌看到的：这位客人、此刻的餐段、这一餐收多少 */
export interface MealEntryPreview {
  visitId: number;
  tagCode: string;
  guest: string;
  ticketName: string | null;
  period: { key: MealPeriodKey; label: string; range: string; price: number } | null;
  /** 这次来访能用几餐、已经用了几餐（含餐的） */
  allowance: number;
  used: number;
  /** 这一餐已经登记过了 */
  entered: boolean;
  /** 登记会怎么收：含餐抵扣（0 元）还是裸票照价 */
  kind: 'included' | 'paid' | null;
}

/** 当天登记过的一条 */
export interface MealEntryRow {
  id: number;
  visitId: number;
  tagCode: string;
  guest: string;
  period: MealPeriodKey;
  kind: 'included' | 'paid';
  price: number;
  staffName: string;
  at: string;
  /** 那一行餐费作废了 */
  voided: boolean;
}

// ───────────── 8.2.18 水吧取餐叫号 ─────────────

/** 一单的状态：制作中 / 请取餐 / 已取 / 已退 */
export type PickupState = 'making' | 'ready' | 'served' | 'cancelled';
export const PICKUP_STATE_LABELS: Record<PickupState, string> = { making: '制作中', ready: '请取餐', served: '已取', cancelled: '已退' };

/** 客人扫码看的进度 */
export interface PickupProgress {
  pickupNo: number;
  state: PickupState;
  /** 前面还有几单在做（自己在做的时候才算） */
  ahead: number;
  items: { name: string; quantity: number; status: string }[];
}

/** 叫号屏：今天制作中、请取餐的号 */
export interface PickupBoard {
  date: string;
  making: number[];
  ready: number[];
}

/** 取餐号写成 3 位（A001 的样子：前面加 A 表示水吧） */
export const pickupLabel = (n: number) => `A${String(n).padStart(3, '0')}`;
