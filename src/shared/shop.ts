// 采购商城（8.1.32，店主 2026-11-24：商城模块并进柚子、由我们开发，docs/MALL_V8132.md）：商品目录与多供应商比选、采购清单、
// 商城外自主申请、我的采购需求、供应链需求池、SKU 维护与审核。提交生成同一种采购需求单（XQ，来源「商城」）。
// 金额一律整数分，数量千分之一单位；含税价 = 未税价 ×（1 + 税率），按分四舍五入。

import { shiftDate } from './labels';
import { formatYuan } from './money';
import { parseQty } from './quantity';

export type ShopSkuStatus = 'draft' | 'pending' | 'approved' | 'disabled';
export const SHOP_SKU_STATUS_LABELS: Record<ShopSkuStatus, string> = { draft: '草稿', pending: '待审核', approved: '已上架', disabled: '已停用' };

/** 为什么不能采购（按这个顺序取第一个）；全都不是 = 可采购 */
export type ShopBlock = 'core_pending' | 'draft' | 'pending' | 'disabled' | 'supplier' | 'unit' | 'expired' | 'store';
export const SHOP_BLOCK_LABELS: Record<ShopBlock, string> = {
  core_pending: '改价审核中',
  draft: '草稿',
  pending: '待审核上架',
  disabled: '已停用',
  supplier: '供应商未准入',
  unit: '物料的采购单位改过了，要重新审核上架',
  expired: '价格已过期',
  store: '这家门店不适用',
};

/** 比价页含起订量不足的阻断原因 */
export type ShopCompareBlock = ShopBlock | 'below_moq';
export const SHOP_COMPARE_BLOCK_LABELS: Record<ShopCompareBlock, string> = {
  ...SHOP_BLOCK_LABELS,
  below_moq: '未达起订量',
};

/** 含税单价（分）：未税 ×（1 + 税率），整数四舍五入到分（避免浮点误差） */
export function grossCents(priceCents: number, taxRateBp: number): number {
  if (priceCents <= 0) return 0;
  return Number((BigInt(priceCents) * BigInt(10_000 + taxRateBp) + 5_000n) / 10_000n);
}

/** 货款含税额（分）：ceil(未税单价 × 数量 × (1 + 税率))，纯整数运算，禁止浮点累加 */
export function lineGoodsCents(priceCents: number, taxRateBp: number, qtyMilli: number): number {
  if (priceCents <= 0 || qtyMilli <= 0) return 0;
  const num = BigInt(priceCents) * BigInt(qtyMilli) * BigInt(10_000 + taxRateBp);
  const den = 10_000_000n;
  return Number((num + den - 1n) / den);
}

/** 一行的含税总成本（分）：ceil(未税单价 × 数量 × (1 + 税率)) + 运费（运费每次采购固定一笔，不随数量叠加）；比价页与清单复用同一个函数，保证 0 分误差 */
export function lineGrossCents(priceCents: number, taxRateBp: number, qtyMilli: number, freightCents: number): number {
  return lineGoodsCents(priceCents, taxRateBp, qtyMilli) + freightCents;
}

/** 税率（基点）格式化，如 1300 → "13%"、350 → "3.5%"、0 → "0%" */
export function formatTaxRate(taxRateBp: number): string {
  const whole = Math.floor(taxRateBp / 100);
  const frac = taxRateBp % 100;
  if (frac === 0) return `${whole}%`;
  return `${whole}.${String(frac).padStart(2, '0').replace(/0+$/, '')}%`;
}

export interface ShopOffer {
  skuId: number;
  skuCode: string;
  priceVersion: number;
  supplier: { id: number; name: string; admission: string };
  priceCents: number;
  taxRateBp: number;
  grossCents: number;
  moqMilli: number;
  leadDays: number;
  freightCents: number;
  validUntil: string;
  /** 适用门店（空 = 全部） */
  stores: { id: number; name: string }[];
  status: ShopSkuStatus;
  corePending: boolean;
  /** 在选的门店能不能采购；不能的写原因 */
  block: ShopBlock | null;
}

export interface ShopItem {
  material: { id: number; code: string; name: string; category: string; specification: string; unit: string; note: string };
  offers: ShopOffer[];
  /** 可采购的报价里最低的含税单价（没有可采购的为空） */
  fromGrossCents: number | null;
  purchasable: number;
}

export interface ShopCatalog {
  storeId: number;
  stores: { id: number; name: string; entityId: number | null }[];
  entities: { id: number; name: string }[];
  /** 能替别的部门提的（店主、采购审核）选部门用；其他人为空 */
  departments: { id: number; name: string }[];
  categories: { name: string; count: number }[];
  items: ShopItem[];
  purposes: string[];
  me: { departmentId: number | null; departmentName: string | null; canPickDepartment: boolean; canPool: boolean; canManageSku: boolean; canApproveSku: boolean };
  today: string;
}

export const SHOP_CUSTOM_UNITS = ['个', '条', '件', '套', '箱', '台', '卷', '瓶', '包', '批', '其他'] as const;

export interface ShopSku {
  id: number;
  skuCode: string;
  material: { id: number; code: string; name: string; unit: string };
  supplier: { id: number; name: string; admission: string };
  priceCents: number;
  taxRateBp: number;
  grossCents: number;
  moqMilli: number;
  leadDays: number;
  freightCents: number;
  validUntil: string;
  stores: { id: number; name: string }[];
  priceVersion: number;
  status: ShopSkuStatus;
  corePending: boolean;
  note: string;
  submittedByName: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  version: number;
  /** 待审的核心改动 */
  pendingChange: { id: number; after: ShopSkuCore; reason: string; requestedByName: string; requestedAt: string } | null;
}

/** 核心信息（改了要审核） */
export interface ShopSkuCore {
  priceCents: number;
  taxRateBp: number;
  moqMilli: number;
  freightCents: number;
  validUntil: string;
  storeIds: number[];
}

export const SHOP_TAX_RATES = [1300, 900, 600, 300, 100, 0] as const;

/** 比价页单条报价（结构对齐 FR-01 第 6 条，后端切 GET /api/erp/shop/offers 时前端零改动） */
export interface ShopCompareOffer {
  skuId: number;
  skuCode: string;
  priceVersion: number;
  supplierId: number;
  supplierName: string;
  admission: string;
  admitted: boolean;
  priceCents: number;
  taxRateBp: number;
  grossCents: number;
  freightCents: number;
  moqMilli: number;
  leadDays: number;
  estimatedArrival: string;
  validUntil: string;
  storeIds: number[];
  stores: { id: number; name: string }[];
  purchasable: boolean;
  blockReason: ShopCompareBlock | null;
  /** 货款含税额（不含运费） */
  goodsCents: number;
  /** 含税总成本 = lineGoodsCents + freightCents */
  totalCents: number;
}

export interface ShopCompareResult {
  material: ShopItem['material'] | null;
  storeId: number;
  storeName: string;
  today: string;
  updatedAt: string;
  offers: ShopCompareOffer[];
  recommendedSkuId: number | null;
  recommendReason: string | null;
}

/** 比价页初始数量：优先取 URL ?qty=，否则取可采购报价最小起订量（无则全部报价最小起订量），兜底 1 单位 */
export function defaultCompareQtyMilli(item: ShopItem | undefined, queryQty: string | null): number {
  if (queryQty) {
    const parsed = parseQty(queryQty);
    if (parsed !== null && parsed > 0) return parsed;
  }
  if (!item || item.offers.length === 0) return 1000;
  const ok = item.offers.filter((o) => o.block === null);
  const pool = ok.length > 0 ? ok : item.offers;
  return Math.min(...pool.map((o) => o.moqMilli));
}

/** 构造推荐解释（只解释，不自动选中、不隐藏其他行） */
function recommendReasonOf(sortedPurchasable: readonly ShopCompareOffer[]): string | null {
  const best = sortedPurchasable[0];
  if (!best) return null;
  const second = sortedPurchasable[1];
  if (!second) return '当前唯一可采购报价';
  const saved = second.totalCents - best.totalCents;
  const leadDiff = best.leadDays - second.leadDays;
  const leadText = leadDiff > 0 ? `，交期多 ${leadDiff} 天` : leadDiff < 0 ? `，交期少 ${Math.abs(leadDiff)} 天` : '，交期相同';
  if (saved > 0) return `比次低省 ${formatYuan(saved)}${leadText}`;
  if (leadDiff < 0) return `与次低总成本相同，交期少 ${Math.abs(leadDiff)} 天`;
  return '当前含税总成本最低';
}

/** 将 catalog 已返回的报价聚合成比价页结构；默认按「可采购优先 → 含税总成本升序 → 交期升序」排序 */
export function buildCompareOffers(catalog: ShopCatalog, materialId: number, qtyMilli: number, updatedAt: string): ShopCompareResult {
  const storeName = catalog.stores.find((s) => s.id === catalog.storeId)?.name ?? `门店 ${catalog.storeId}`;
  const item = catalog.items.find((i) => i.material.id === materialId);
  if (!item) {
    return { material: null, storeId: catalog.storeId, storeName, today: catalog.today, updatedAt, offers: [], recommendedSkuId: null, recommendReason: null };
  }
  const offers: ShopCompareOffer[] = item.offers.map((o) => {
    const blockReason: ShopCompareBlock | null = o.block ?? (qtyMilli < o.moqMilli ? 'below_moq' : null);
    const goodsCents = lineGoodsCents(o.priceCents, o.taxRateBp, qtyMilli);
    const totalCents = lineGrossCents(o.priceCents, o.taxRateBp, qtyMilli, o.freightCents);
    return {
      skuId: o.skuId,
      skuCode: o.skuCode,
      priceVersion: o.priceVersion,
      supplierId: o.supplier.id,
      supplierName: o.supplier.name,
      admission: o.supplier.admission,
      admitted: o.supplier.admission === 'approved',
      priceCents: o.priceCents,
      taxRateBp: o.taxRateBp,
      grossCents: o.grossCents,
      freightCents: o.freightCents,
      moqMilli: o.moqMilli,
      leadDays: o.leadDays,
      estimatedArrival: shiftDate(catalog.today, o.leadDays),
      validUntil: o.validUntil,
      storeIds: o.stores.map((s) => s.id),
      stores: o.stores,
      purchasable: blockReason === null,
      blockReason,
      goodsCents,
      totalCents,
    };
  });
  offers.sort((a, b) => {
    if (a.purchasable !== b.purchasable) return a.purchasable ? -1 : 1;
    if (a.totalCents !== b.totalCents) return a.totalCents - b.totalCents;
    if (a.leadDays !== b.leadDays) return a.leadDays - b.leadDays;
    return a.skuId - b.skuId;
  });
  const ok = offers.filter((o) => o.purchasable);
  return {
    material: item.material,
    storeId: catalog.storeId,
    storeName,
    today: catalog.today,
    updatedAt,
    offers,
    recommendedSkuId: ok[0]?.skuId ?? null,
    recommendReason: recommendReasonOf(ok),
  };
}
