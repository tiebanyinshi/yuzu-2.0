// 采购商城（8.1.32，店主 2026-11-24：商城模块并进柚子、由我们开发，docs/MALL_V8132.md）：商品目录与多供应商比选、采购清单、
// 商城外自主申请、我的采购需求、供应链需求池、SKU 维护与审核。提交生成同一种采购需求单（XQ，来源「商城」）。
// 金额一律整数分，数量千分之一单位；含税价 = 未税价 ×（1 + 税率），按分四舍五入。

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

/** 含税单价（分）：未税 ×（1 + 税率），四舍五入到分 */
export const grossCents = (priceCents: number, taxRateBp: number) => Math.round((priceCents * (10_000 + taxRateBp)) / 10_000);
/** 一行的含税小计（分）：含税单价 × 数量 + 这一行的运费（运费按行固定一笔，不随数量变） */
export const lineGrossCents = (priceCents: number, taxRateBp: number, qtyMilli: number, freightCents: number) => Math.round((grossCents(priceCents, taxRateBp) * qtyMilli) / 1000) + freightCents;

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
