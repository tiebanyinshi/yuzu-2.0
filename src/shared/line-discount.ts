// 单项打折（8.2.1，docs/V8221_CASHIER.md 第 1 节）：账单的一行按折扣或折后价打折，按岗位分四档设下限（后台「手牌与前台」可改）；
// 超过自己那一档的下限要当场授权（授权人那一档的下限够才行）。前后端共用。

import type { Role } from './permissions';
import type { PositionKey } from './positions';

/** 折扣档：前台收银、值班经理、部门负责人（含店总、总经办）、店主 */
export const LINE_DISCOUNT_TIERS = ['cashier', 'duty', 'lead', 'owner'] as const;
export type LineDiscountTier = (typeof LINE_DISCOUNT_TIERS)[number];
export const LINE_DISCOUNT_TIER_LABELS: Record<LineDiscountTier, string> = {
  cashier: '前台收银等员工',
  duty: '值班经理',
  lead: '部门负责人、店总',
  owner: '店主',
};

/** 每一档最低能打到收原价的百分之几（90 = 九折；0 = 能免单） */
export type LineDiscountFloors = Record<LineDiscountTier, number>;
/** 默认（待店主确认，docs/PENDING_DECISIONS.md 8.2.1-1）：前台收银九折、值班经理七折、部门负责人五折、店主能免单 */
export const DEFAULT_LINE_DISCOUNT_FLOORS: LineDiscountFloors = { cashier: 90, duty: 70, lead: 50, owner: 0 };

/** 这位员工在哪一档：店主（总裁）→ 店主；店总、总经办、部门负责人岗位 → 部门负责人；值班经理 → 值班经理；其余 → 前台收银 */
export function lineDiscountTierOf(a: { role: Role; position?: PositionKey | null }): LineDiscountTier {
  if (a.role === 'owner' || a.position === 'president') return 'owner';
  if (a.role === 'store_manager' || a.position === 'gmo' || (a.position ?? '').endsWith('.lead')) return 'lead';
  if (a.role === 'duty_manager') return 'duty';
  return 'cashier';
}

/** 按折扣算折后价：四舍五入到分 */
export const discountedAmount = (listAmount: number, rate: number) => Math.floor((listAmount * rate + 50) / 100);

/** 折后价在不在这个下限以内（折后价 ≥ 原价 × 下限 ÷ 100） */
export const withinFloor = (listAmount: number, finalAmount: number, floorPct: number) => finalAmount * 100 >= listAmount * floorPct;

/** 「8 折」「8.5 折」「免单」：rate 是收原价的百分之几 */
export function rateLabel(rate: number): string {
  if (rate === 0) return '免单';
  const zhe = rate / 10;
  return `${Number.isInteger(zhe) ? zhe : zhe.toFixed(1)} 折`;
}

/** 下限的说法：「最低 9 折」「能免单」 */
export const floorLabel = (floorPct: number) => (floorPct === 0 ? '能免单' : floorPct >= 100 ? '不能打折' : `最低 ${rateLabel(floorPct)}`);

/** 账单一行上的折扣（明细金额照旧是原价；结账时按折后价收） */
export interface LineDiscountInfo {
  id: number;
  listAmount: number;
  finalAmount: number;
  /** 按折扣打的几折（百分比）；按折后价填的为 null */
  rate: number | null;
  reason: string;
  byName: string;
  byEmpNo: string | null;
  approvedByName: string | null;
  at: string;
  /** 系统按规则打的自动折扣（8.2.8 / 8.2.18：含餐、自助、首杯赠）；人工打的为 null */
  rule?: import('./dining-meals').AutoDiscountRule | null;
}

/** 当场授权单项打折的对象：这一行、此刻的原价、要打到多少 */
export interface LineDiscountScope {
  lineId: number;
  name: string;
  listAmount: number;
  finalAmount: number;
  reason: string;
}
