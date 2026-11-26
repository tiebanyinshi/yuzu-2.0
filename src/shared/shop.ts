// 采购商城（8.1.32，店主 2026-11-24：商城模块并进柚子、由我们开发，docs/MALL_V8132.md）：商品目录与多供应商比选、采购清单、
// 商城外自主申请、我的采购需求、供应链需求池、SKU 维护与审核。提交生成同一种采购需求单（XQ，来源「商城」）。
// 金额一律整数分，数量千分之一单位；含税价 = 未税价 ×（1 + 税率），按分四舍五入。

import { shiftDate } from './labels';
import { formatYuan } from './money';
import { formatQty, parseQty } from './quantity';

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
  /** imageIds：商品图（8.1.47，最多 6 张，第 1 张是封面；地址 shopImageUrl(id)，没有为空） */
  material: { id: number; code: string; name: string; category: string; specification: string; unit: string; note: string; imageIds: number[] };
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
  me: {
    departmentId: number | null;
    departmentName: string | null;
    canPickDepartment: boolean;
    canPool: boolean;
    canManageSku: boolean;
    canApproveSku: boolean;
    canEditMaster: boolean;
  };
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
/** 与服务端 CatalogSubmit / CustomSubmit 一致的数量上限：1,000,000 单位（1,000,000,000 milli） */
export const SHOP_MAX_QTY_MILLI = 1_000_000_000;

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
  qtyMilli: number;
  offers: ShopCompareOffer[];
  recommendedSkuId: number | null;
  recommendReason: string | null;
}

/** 比价页初始数量（与提交上限一致）：优先取 URL ?qty=（超上限按 SHOP_MAX_QTY_MILLI 截断并标记 clamped），否则取可采购报价最小起订量，兜底 1 单位 */
export function resolveCompareQtyMilli(item: ShopItem | undefined, queryQty: string | null): { qtyMilli: number; clamped: boolean } {
  if (queryQty) {
    const parsed = parseQty(queryQty);
    if (parsed !== null && parsed > 0) {
      if (parsed > SHOP_MAX_QTY_MILLI) return { qtyMilli: SHOP_MAX_QTY_MILLI, clamped: true };
      return { qtyMilli: parsed, clamped: false };
    }
  }
  if (!item || item.offers.length === 0) return { qtyMilli: 1000, clamped: false };
  const ok = item.offers.filter((o) => o.block === null);
  const pool = ok.length > 0 ? ok : item.offers;
  return { qtyMilli: Math.min(SHOP_MAX_QTY_MILLI, Math.min(...pool.map((o) => o.moqMilli))), clamped: false };
}

export interface ShopCartLine {
  skuId: number;
  priceVersion: number;
  qtyMilli: number;
}

export interface ShopCart {
  storeId: number | null;
  lines: ShopCartLine[];
}

export type ShopCompareSort = 'total' | 'unit' | 'lead';

export interface ShopCompareFilters {
  freeShippingOnly: boolean;
  purchasableOnly: boolean;
  admittedOnly: boolean;
}

/** 构造推荐解释（只解释，不自动选中、不隐藏其他行）；服务端 GET /api/erp/shop/offers 与前端聚合共用 */
export function compareRecommendReason(sortedPurchasable: readonly ShopCompareOffer[]): string | null {
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

/** 比价页排序与筛选（可采购行始终排在阻断行之前） */
export function filterAndSortCompareOffers(offers: readonly ShopCompareOffer[], sort: ShopCompareSort, filters: ShopCompareFilters): ShopCompareOffer[] {
  const filtered = offers.filter((o) => {
    if (filters.freeShippingOnly && o.freightCents !== 0) return false;
    if (filters.purchasableOnly && !o.purchasable) return false;
    if (filters.admittedOnly && !o.admitted) return false;
    return true;
  });
  return [...filtered].sort((a, b) => {
    if (a.purchasable !== b.purchasable) return a.purchasable ? -1 : 1;
    if (sort === 'unit') {
      if (a.grossCents !== b.grossCents) return a.grossCents - b.grossCents;
      if (a.totalCents !== b.totalCents) return a.totalCents - b.totalCents;
    } else if (sort === 'lead') {
      if (a.leadDays !== b.leadDays) return a.leadDays - b.leadDays;
      if (a.totalCents !== b.totalCents) return a.totalCents - b.totalCents;
    } else {
      if (a.totalCents !== b.totalCents) return a.totalCents - b.totalCents;
      if (a.leadDays !== b.leadDays) return a.leadDays - b.leadDays;
    }
    return a.skuId - b.skuId;
  });
}

/** 查清单里是否已有该物料的某家报价（仅同门店有效） */
export function findMaterialCartLine(cart: ShopCart, storeId: number, materialSkuIds: readonly number[]): ShopCartLine | null {
  if (cart.storeId !== null && cart.storeId !== storeId) return null;
  const set = new Set(materialSkuIds);
  return cart.lines.find((l) => set.has(l.skuId)) ?? null;
}

/**
 * 比价页「选这家」写入清单（纯函数）：
 * - 清单属于另一门店且非空 → 除非 allowResetOtherStore 为 true，否则返回 cross_store（不静默覆写）；
 * - 该物料已在清单 → 原位替换（保留 1 行、不重复计运费，去掉同物料可能残留的其他 SKU）；
 * - 该物料不在清单 → 追加一行。
 */
export function applyCompareCartSelection(
  cart: ShopCart,
  offer: Pick<ShopCompareOffer, 'skuId' | 'priceVersion'>,
  materialSkuIds: readonly number[],
  qtyMilli: number,
  storeId: number,
  allowResetOtherStore = false,
): { kind: 'cross_store' } | { kind: 'added' | 'updated' | 'replaced'; cart: ShopCart; replacedSkuId?: number } {
  const otherStore = cart.lines.length > 0 && cart.storeId !== null && cart.storeId !== storeId;
  if (otherStore && !allowResetOtherStore) return { kind: 'cross_store' };
  const baseLines = otherStore ? [] : cart.lines;
  const matSet = new Set(materialSkuIds);
  const existingIdx = baseLines.findIndex((l) => matSet.has(l.skuId));
  const nextLine: ShopCartLine = { skuId: offer.skuId, priceVersion: offer.priceVersion, qtyMilli };
  if (existingIdx >= 0) {
    const prev = baseLines[existingIdx]!;
    const lines: ShopCartLine[] = [];
    for (let i = 0; i < baseLines.length; i += 1) {
      if (i === existingIdx) lines.push(nextLine);
      else if (!matSet.has(baseLines[i]!.skuId)) lines.push(baseLines[i]!);
    }
    return {
      kind: prev.skuId === offer.skuId ? 'updated' : 'replaced',
      cart: { storeId, lines },
      replacedSkuId: prev.skuId === offer.skuId ? undefined : prev.skuId,
    };
  }
  return {
    kind: 'added',
    cart: { storeId, lines: [...baseLines, nextLine] },
  };
}

/** 将 catalog 已返回的报价聚合成比价页结构；默认按「可采购优先 → 含税总成本升序 → 交期升序」排序 */
export function buildCompareOffers(catalog: ShopCatalog, materialId: number, qtyMilli: number, updatedAt: string): ShopCompareResult {
  const storeName = catalog.stores.find((s) => s.id === catalog.storeId)?.name ?? `门店 ${catalog.storeId}`;
  const item = catalog.items.find((i) => i.material.id === materialId);
  if (!item) {
    return { material: null, storeId: catalog.storeId, storeName, today: catalog.today, updatedAt, qtyMilli, offers: [], recommendedSkuId: null, recommendReason: null };
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
  const sorted = filterAndSortCompareOffers(offers, 'total', { freeShippingOnly: false, purchasableOnly: false, admittedOnly: false });
  const ok = sorted.filter((o) => o.purchasable);
  return {
    material: item.material,
    storeId: catalog.storeId,
    storeName,
    today: catalog.today,
    updatedAt,
    qtyMilli,
    offers: sorted,
    recommendedSkuId: ok[0]?.skuId ?? null,
    recommendReason: compareRecommendReason(ok),
  };
}

export interface ShopCardMeta {
  fastestLeadDays: number | null;
  hasFreeShipping: boolean;
  minMoqMilli: number | null;
}

/** 商品卡摘要信息（FR-09）：只统计当前门店可采购报价的最快交期、是否含包邮与最小起订量 */
export function catalogCardSummary(item: ShopItem): ShopCardMeta {
  const ok = item.offers.filter((o) => o.block === null);
  if (ok.length === 0) return { fastestLeadDays: null, hasFreeShipping: false, minMoqMilli: null };
  return {
    fastestLeadDays: Math.min(...ok.map((o) => o.leadDays)),
    hasFreeShipping: ok.some((o) => o.freightCents === 0),
    minMoqMilli: Math.min(...ok.map((o) => o.moqMilli)),
  };
}

export type ShopCartIssueKind = 'store' | 'missing' | 'blocked' | 'price_changed' | 'below_moq';

export interface ShopCartIssue {
  key: string;
  skuId: number | null;
  kind: ShopCartIssueKind;
  label: string;
  detail: string;
}

export interface ShopCartGroupedRow {
  line: ShopCartLine;
  item: ShopItem | null;
  offer: ShopOffer | null;
  unit: string;
  goodsCents: number;
  freightCents: number;
  totalCents: number;
  moqReached: boolean;
  moqShortfallMilli: number;
  moqPercent: number;
  problemKind: Exclude<ShopCartIssueKind, 'store'> | null;
  problem: string | null;
}

export interface ShopCartSupplierGroup {
  key: string;
  supplierId: number | null;
  supplierName: string;
  admission: string | null;
  rows: ShopCartGroupedRow[];
  goodsCents: number;
  freightCents: number;
  subtotalCents: number;
}

export interface ShopCartSummary {
  sameStore: boolean;
  groups: ShopCartSupplierGroup[];
  issues: ShopCartIssue[];
  lineCount: number;
  goodsCents: number;
  freightCents: number;
  totalCents: number;
  priceChangedSkuIds: number[];
}

/** 采购清单按供应商分组并汇总问题与金额（FR-06）：复用 lineGoodsCents / lineGrossCents，保证组小计之和严格等于总计且与比价页 0 分误差 */
export function groupShopCart(catalog: ShopCatalog, cart: ShopCart): ShopCartSummary {
  const sameStore = cart.storeId === null || cart.storeId === catalog.storeId;
  const issues: ShopCartIssue[] = [];
  if (!sameStore) {
    const cartStoreName = catalog.stores.find((s) => s.id === cart.storeId)?.name;
    issues.push({
      key: 'store',
      skuId: null,
      kind: 'store',
      label: '门店不一致',
      detail: cartStoreName ? `这份清单是按「${cartStoreName}」加的，请切回该门店或清空重选` : '这份清单是按另一家门店加的，请在首页把门店换回来再提交，或清空重选',
    });
  }

  const groupMap = new Map<string, ShopCartSupplierGroup>();
  const priceChangedSkuIds: number[] = [];

  for (const line of cart.lines) {
    const item = catalog.items.find((i) => i.offers.some((o) => o.skuId === line.skuId)) ?? null;
    const offer = item?.offers.find((o) => o.skuId === line.skuId) ?? null;
    const unit = item?.material.unit ?? '';
    const goodsCents = offer ? lineGoodsCents(offer.priceCents, offer.taxRateBp, line.qtyMilli) : 0;
    const freightCents = offer?.freightCents ?? 0;
    const totalCents = offer ? lineGrossCents(offer.priceCents, offer.taxRateBp, line.qtyMilli, freightCents) : 0;

    let problemKind: Exclude<ShopCartIssueKind, 'store'> | null = null;
    let problem: string | null = null;
    if (!offer) {
      problemKind = 'missing';
      problem = '这条报价已经没有了';
    } else if (offer.block) {
      problemKind = 'blocked';
      problem = SHOP_BLOCK_LABELS[offer.block];
    } else if (offer.priceVersion !== line.priceVersion) {
      problemKind = 'price_changed';
      problem = '加清单以后改过价：请确认新价';
      priceChangedSkuIds.push(line.skuId);
    } else if (line.qtyMilli < offer.moqMilli) {
      problemKind = 'below_moq';
      problem = `低于起订量 ${formatQty(offer.moqMilli)}${unit ? ` ${unit}` : ''}`;
    }

    const moqMilli = offer?.moqMilli ?? 0;
    const moqReached = !offer || line.qtyMilli >= moqMilli;
    const moqShortfallMilli = offer && line.qtyMilli < moqMilli ? moqMilli - line.qtyMilli : 0;
    const moqPercent = !offer || moqMilli <= 0 ? 100 : Math.min(100, Math.floor((line.qtyMilli * 100) / moqMilli));

    const name = item?.material.name ?? `SKU ${line.skuId}`;
    if (problem && problemKind) {
      issues.push({
        key: `${problemKind}-${line.skuId}`,
        skuId: line.skuId,
        kind: problemKind,
        label: name,
        detail: problem,
      });
    }

    const gKey = offer ? `sup-${offer.supplier.id}` : 'unknown';
    let group = groupMap.get(gKey);
    if (!group) {
      group = {
        key: gKey,
        supplierId: offer?.supplier.id ?? null,
        supplierName: offer?.supplier.name ?? '失效或已下架报价',
        admission: offer?.supplier.admission ?? null,
        rows: [],
        goodsCents: 0,
        freightCents: 0,
        subtotalCents: 0,
      };
      groupMap.set(gKey, group);
    }
    group.rows.push({
      line,
      item,
      offer,
      unit,
      goodsCents,
      freightCents,
      totalCents,
      moqReached,
      moqShortfallMilli,
      moqPercent,
      problemKind,
      problem,
    });
    group.goodsCents += goodsCents;
    group.freightCents += freightCents;
    group.subtotalCents += totalCents;
  }

  const groups = [...groupMap.values()];
  const goodsCents = groups.reduce((s, g) => s + g.goodsCents, 0);
  const freightCents = groups.reduce((s, g) => s + g.freightCents, 0);
  const totalCents = groups.reduce((s, g) => s + g.subtotalCents, 0);

  return {
    sameStore,
    groups,
    issues,
    lineCount: cart.lines.length,
    goodsCents,
    freightCents,
    totalCents,
    priceChangedSkuIds,
  };
}

/** 供应商档案列表行（FR-03）：复用 ERP suppliers + supplier_licenses + mall_skus 单一数据源 */
export interface ShopSupplierRow {
  id: number;
  code: string;
  name: string;
  active: boolean;
  admission: string;
  admissionNote: string;
  categories: string[];
  activeSkuCount: number;
  totalSkuCount: number;
  lastPriceChangeAt: string | null;
  avgLeadDays: number | null;
  /** 字段级权限受控：无权限时为 null，页面展示「联系采购获取」 */
  contact: string | null;
  phone: string | null;
  note: string;
}

export interface ShopSupplierDetail extends ShopSupplierRow {
  admissionByName: string | null;
  admissionAt: string | null;
  licenses: { id: number; kind: string; name: string; licenseNo: string; validUntil: string | null; mediaUrl: string | null; addedByName: string; addedAt: string }[];
  skus: {
    id: number;
    skuCode: string;
    materialId: number;
    materialCode: string;
    materialName: string;
    unit: string;
    priceCents: number;
    taxRateBp: number;
    grossCents: number;
    moqMilli: number;
    leadDays: number;
    freightCents: number;
    validUntil: string;
    status: ShopSkuStatus;
    corePending: boolean;
  }[];
  history: { orderCount: number; totalAmountCents: number };
}

/** 集团物料主档列表行（FR-04）：复用 ERP materials + mall_skus 单一数据源；单位变更仍走原 ERP 档案并触发关联 SKU 重审 */
export interface ShopMaterialRow {
  id: number;
  code: string;
  name: string;
  category: string;
  specification: string;
  unit: string;
  inventoryUnit: string;
  note: string;
  active: boolean;
  skuCount: number;
  activeSkuCount: number;
  supplierCount: number;
  lowestGrossCents: number | null;
  /** 商品图（8.1.47）：第 1 张是封面 */
  imageIds: number[];
}

/** 每样物料最多几张商品图（8.1.47，迁移 480） */
export const SHOP_MAX_MATERIAL_IMAGES = 6;
/** 商品图的地址：采购商城的人都能看（只给挂在物料上的图） */
export const shopImageUrl = (imageId: number) => `/api/erp/shop/images/${imageId}`;

/** 提交前审批路由预览（FR-02）：由 ERP 后端按真实采购规则、部门主管与总仓结存计算，前端只展示 */
export interface ShopRoutePreviewNode {
  key: 'dept_confirm' | 'stock_check' | 'purchase_review' | 'po_order' | 'receive';
  label: string;
  role: string;
  status: 'active' | 'auto' | 'skipped' | 'blocked';
}

export interface ShopRoutePreviewHint {
  code: string;
  tone: 'info' | 'warning' | 'neutral';
  text: string;
}

export interface ShopRoutePreview {
  nodes: ShopRoutePreviewNode[];
  hints: ShopRoutePreviewHint[];
  estimateCents: number | null;
  hasUnpriced: boolean;
}

/** 供应链后台总览（FR-05 & FR-10 & UX-10）：一次返回 4 统计卡、近 7 日增量与待办明细 */
export interface ShopOverview {
  counts: {
    materials: number;
    activeMaterials: number;
    suppliers: number;
    admittedSuppliers: number;
    activeSkus: number;
    totalSkus: number;
    pendingSkus: number;
    pendingSkuChanges: number;
    pendingSuppliers: number;
    totalTodos: number;
  };
  recent: {
    materialsWeek: number;
    suppliersWeek: number;
    skusWeek: number;
    requestsWeek: number;
  };
  todos: {
    pendingSkus: number;
    pendingSkuChanges: number;
    pendingSuppliers: number;
  };
}
