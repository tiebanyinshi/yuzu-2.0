// 8.1.39（餐饮 B，docs/V8139_DINING_B.md）：分时段自动沽清、出品档口按时段切换、同组账单只看餐饮。前后端共用。
//
//   · 售卖时段（R3）：一道菜可以只在几个时段里卖（service_items.sale_windows，空为全天）；不在时段里的，任何点单入口都下不了单
//     （DISH_NOT_ON_SALE），点单页上灰掉、写着几点到几点卖——到点自己停，不用人手去沽清；
//   · 档口时段（《门店系统需求梳理》）：同一道菜在不同的时段到不同的出品档口（dish_station_windows），不用为换档口重复建菜；
//     不在任何一段里的按菜品自己的档口。出品单记下单那一刻算出来的档口，以后改了时段也不动已经下的单；
//   · 时段都按门店时区的「一天里第几分钟」（0–1439）记：开始 < 结束为当天，开始 > 结束为跨过零点（22:00–次日 02:00），
//     含开始那一分钟、不含结束那一分钟。

/** 一个时段：一天里的第几分钟（0–1439）；start > end 为跨零点 */
export interface DishWindow {
  start: number;
  end: number;
}

/** 档口时段：这一段到哪个档口出品 */
export interface DishStationWindow extends DishWindow {
  stationId: number;
  /** 档口名（读的时候带上，写的时候不用） */
  stationName?: string;
}

/** 一道菜最多设几段售卖时段、几段档口时段 */
export const MAX_SALE_WINDOWS = 4;
export const MAX_STATION_WINDOWS = 4;

export const isMinute = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1440;

/** 这一分钟在不在这一段里（含开始、不含结束；跨零点的照算） */
export const inWindow = (w: DishWindow, minute: number): boolean => (w.start < w.end ? minute >= w.start && minute < w.end : minute >= w.start || minute < w.end);

/** 现在卖不卖：没设时段为全天都卖 */
export const onSaleAt = (windows: readonly DishWindow[] | null | undefined, minute: number): boolean => !windows || windows.length === 0 || windows.some((w) => inWindow(w, minute));

/** 这一刻到哪个档口出品：落在哪一段就是那一段的档口，都不在的用菜品自己的档口 */
export const stationAt = (defaultStationId: number, windows: readonly DishStationWindow[] | null | undefined, minute: number): number =>
  windows?.find((w) => inWindow(w, minute))?.stationId ?? defaultStationId;

export const formatMinute = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** "11:00" → 660；格式不对返回 null */
export function parseMinute(text: string): number | null {
  const m = /^([01]?\d|2[0-3])[:：]([0-5]\d)$/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 「11:00–14:00」「22:00–次日 02:00」 */
export const windowText = (w: DishWindow) => `${formatMinute(w.start)}–${w.end <= w.start ? '次日 ' : ''}${formatMinute(w.end)}`;
/** 「11:00–14:00、17:00–21:00」；没设为「全天」 */
export const windowsText = (ws: readonly DishWindow[] | null | undefined) => (ws && ws.length ? ws.map(windowText).join('、') : '全天');

/** 一段覆盖的分钟（跨零点的拆成两截） */
const minutesOf = (w: DishWindow): [number, number][] =>
  w.start < w.end
    ? [[w.start, w.end]]
    : w.end > 0
      ? [
          [w.start, 1440],
          [0, w.end],
        ]
      : [[w.start, 1440]];

/** 几段之间有没有重叠的（档口时段重叠了就说不清这一刻到哪个档口） */
export function windowsOverlap(ws: readonly DishWindow[]): boolean {
  const spans = ws.flatMap(minutesOf).sort((a, b) => a[0] - b[0]);
  return spans.some((s, i) => i > 0 && s[0] < spans[i - 1]![1]);
}

/**
 * 核对一组时段（保存菜品时，前后端同一个）：每段开始、结束都在 0–1439、不相同；段数不超过上限；
 * 档口时段不能互相重叠。没问题返回 null，否则返回给人看的原因
 */
export function windowsProblem(ws: readonly DishWindow[], what: '售卖时段' | '档口时段', max: number): string | null {
  if (ws.length > max) return `${what}最多 ${max} 段`;
  for (const w of ws) {
    if (!isMinute(w.start) || !isMinute(w.end)) return `${what}的时间不对，请按「11:00」这样写`;
    if (w.start === w.end) return `${what}「${formatMinute(w.start)}」开始与结束不能一样（全天卖就不用设时段）`;
  }
  if (what === '档口时段' && windowsOverlap(ws)) return '档口时段有重叠的：同一时刻只能到一个档口';
  return null;
}

/** 下单时不在售卖时段的提示（DISH_NOT_ON_SALE） */
export const notOnSaleText = (label: string, ws: readonly DishWindow[]) => `${label}现在不在售卖时段（${windowsText(ws)}），到点自动停售，请换一道菜`;

// ───────────── 同组账单只看餐饮（R10）：前台结账核对时，几张手牌各自与合起来的餐饮小计（只读） ─────────────

export interface DiningSubtotalLine {
  id: number;
  name: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface DiningSubtotals {
  visits: { visitId: number; tagCode: string; amount: number; quantity: number; lines: DiningSubtotalLine[] }[];
  /** 几张手牌的餐饮合计（分） */
  total: number;
}
