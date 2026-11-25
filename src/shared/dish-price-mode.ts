// 8.1.39 菜品的计价方式（docs/V8139.md 第 2 节）：按价目 / 时价、杂项（点的时候填价）/ 称重（点的时候填斤数，单价可改）。前后端共用。

export const PRICE_MODES = ['fixed', 'open', 'weight'] as const;
export type PriceMode = (typeof PRICE_MODES)[number];
export const PRICE_MODE_LABELS: Record<PriceMode, string> = { fixed: '按价目', open: '时价 / 杂项', weight: '称重' };
export const PRICE_MODE_HINTS: Record<PriceMode, string> = {
  fixed: '按价目的价计价，点的时候不能改',
  open: '点的时候填这一项多少钱（开瓶费、赔偿费、加工费、清洁费、时价菜）；退的时候整行退',
  weight: '点的时候填几斤，每斤单价默认是价目的价、可以改；按单价 × 斤数记一份',
};

/** 时价、称重单价的上限（分）：¥99,999 */
export const MAX_OPEN_PRICE = 9_999_900;
/** 一份最多几斤（按 0.01 斤）：99.99 斤 */
export const MAX_WEIGHT_CENTI_JIN = 9_999;

/** 135 → 「1.35斤」 */
export const weightText = (centiJin: number) => `${(centiJin / 100).toFixed(2).replace(/\.?0+$/, '')}斤`;

/** 「1.35」→ 135；不是正的两位以内小数的为 null */
export function parseWeight(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  const v = Math.round(Number(t) * 100);
  return v > 0 && v <= MAX_WEIGHT_CENTI_JIN ? v : null;
}

/** 称重这一份多少钱（与服务端同一个算法：四舍五入到分） */
export const weighedAmount = (perJin: number, centiJin: number) => Math.round((perJin * centiJin) / 100);
