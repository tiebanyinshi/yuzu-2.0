// 价目表第四批：前台试算（需求说明第三节 5「开 1 间 SPA 房 + 1 个康疗项目 + 1 张门票，核对小计与 10% 服务费」）。
// 只读生效中的价目表算一笔，不开单、不写库；页面与用例共用这一份算法（docs/PRICE_CATALOG.md 第 6 节，PC15–PC17）。
// 金额一律整数分。

import type { PriceCatalogEntry } from './price-catalog';

/** 双价取哪一档：专业价 / 资深价（PC7：专业价 → 专业技师、资深价 → 优选技师） */
export type QuoteTier = 'pro' | 'senior';

export interface QuotePick {
  entry: PriceCatalogEntry;
  /** 双价项目取哪一档；不填取专业价 */
  tier?: QuoteTier;
  /** 分档项目选哪一档（variants 的下标）；不填按主价格 */
  variant?: number;
  /** 计时项目（娱乐、房间）用了多少分钟；不填按基础价含的时长 */
  minutes?: number;
  /** 份数 / 台数 / 间数 / 人数 */
  quantity: number;
}

export interface QuoteLine {
  name: string;
  /** 这一行怎么算的：「含 2 小时」「超时 2 × ¥199.00」「封顶」 */
  detail: string[];
  unitCents: number;
  quantity: number;
  amountCents: number;
}

export interface Quote {
  lines: QuoteLine[];
  /** 算不了的（待定价、不可下单、已停用），写明是哪一项 */
  problems: string[];
  subtotalCents: number;
  /** 服务费比例（万分之几）；价目表里没有服务费或已停用时为 null */
  feeRateBp: number | null;
  feeCents: number;
  totalCents: number;
}

/** 服务费：小计 × 比例，四舍五入到分（整数运算，不用浮点） */
export const serviceFeeOf = (subtotalCents: number, rateBp: number) => Math.floor((subtotalCents * rateBp + 5000) / 10000);

const money = (cents: number) => `¥${(cents / 100).toFixed(2)}`;

/** 一项的单价（一间 / 一台 / 一份 / 一位）：基础价（或所选分档）+ 超时（加钟），有封顶的不超过封顶 */
export function quoteUnit(p: Omit<QuotePick, 'quantity'>): { unitCents: number; detail: string[] } | string {
  const e = p.entry;
  if (!e.active) return `「${e.name}」已停用`;
  if (e.priceMode === 'rate') return `「${e.name}」是比例，不单独计价`;
  if (e.kind === 'dish' && !e.orderable) return `「${e.name}」不可下单`;
  const detail: string[] = [];
  let base: number | null;
  let baseMinutes: number | null;
  const v = p.variant === undefined ? undefined : e.variants[p.variant];
  if (p.variant !== undefined && !v) return `「${e.name}」没有这一档`;
  if (v) {
    base = v.priceCents;
    baseMinutes = v.minutes;
    detail.push(v.label);
  } else {
    base = e.priceMode === 'dual' && p.tier === 'senior' ? e.price2Cents : e.priceCents;
    baseMinutes = e.durationMinutes;
    if (e.priceMode === 'dual') detail.push(p.tier === 'senior' ? '资深价' : '专业价');
  }
  if (e.priceMode === 'none' || base === null) return `「${e.name}」待定价，不能计价`;
  if (baseMinutes !== null && e.sheet !== 'massage') detail.push(`含 ${baseMinutes % 60 === 0 ? `${baseMinutes / 60} 小时` : `${baseMinutes} 分钟`}`);
  let unit = base;
  const over = p.minutes !== undefined && baseMinutes !== null ? p.minutes - baseMinutes : 0;
  if (over > 0 && e.extraPriceCents !== null && e.extraMinutes) {
    const steps = Math.ceil(over / e.extraMinutes);
    unit += steps * e.extraPriceCents;
    detail.push(`${e.sheet === 'entertainment' ? '加钟' : '超时'} ${steps} × ${money(e.extraPriceCents)}`);
  }
  if (e.capCents !== null && unit > e.capCents && e.capCents >= base) {
    unit = e.capCents;
    detail.push(`封顶 ${money(e.capCents)}`);
  }
  return { unitCents: unit, detail };
}

/** 试算一笔：逐行单价 × 数量，小计，再按价目表里的服务费比例加服务费（PC3：开瓶费、赔偿费不收服务费，不在价目表里） */
export function priceQuote(picks: QuotePick[], fee: Pick<PriceCatalogEntry, 'priceMode' | 'rateBp' | 'active'> | null): Quote {
  const lines: QuoteLine[] = [];
  const problems: string[] = [];
  for (const p of picks) {
    const q = Math.trunc(p.quantity);
    if (!(q >= 1 && q <= 999)) {
      problems.push(`「${p.entry.name}」数量要在 1–999 之间`);
      continue;
    }
    const u = quoteUnit(p);
    if (typeof u === 'string') {
      problems.push(u);
      continue;
    }
    lines.push({ name: p.entry.name, detail: u.detail, unitCents: u.unitCents, quantity: q, amountCents: u.unitCents * q });
  }
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const feeRateBp = fee && fee.active && fee.priceMode === 'rate' && fee.rateBp !== null ? fee.rateBp : null;
  const feeCents = feeRateBp === null ? 0 : serviceFeeOf(subtotalCents, feeRateBp);
  return { lines, problems, subtotalCents, feeRateBp, feeCents, totalCents: subtotalCents + feeCents };
}
