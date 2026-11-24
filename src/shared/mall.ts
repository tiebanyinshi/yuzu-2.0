// 采购商城 V1.1 对接（8.1.31，docs/MALL_V8131.md）：商城后端调 yuzu 的 /api/erp/mall/* 时双方用的格式。
// 金额一律整数分，数量千分之一单位（与需求单一样）。

import type { MallPaymentIntent, RequestPriority, RequestStatus, StockCheckState } from './requests';

/** 商城的接口前缀与请求头 */
export const MALL_PREFIX = '/api/erp/mall';
export const MALL_KEY_HEADER = 'x-mall-key';
export const MALL_STAFF_HEADER = 'x-mall-staff-id';
export const MALL_STORE_HEADER = 'x-mall-store-id';
/** 一次批量查状态最多几张 */
export const MALL_BATCH_LIMIT = 100;
/** 列表一次最多几张 */
export const MALL_LIST_LIMIT = 200;

/** 登录校验、账号刷新返回的身份 */
export interface MallIdentity {
  staff: { id: number; username: string; displayName: string; active: boolean; role: string; position: string | null };
  department: { id: number; name: string } | null;
  /** 我当主管的部门 */
  headOf: number[];
  stores: { id: number; code: string; name: string; entityId: number | null; entityName: string | null }[];
  /** 还要先去 ERP 网页改密码、选岗位的（这期间商城的业务接口一律拒绝） */
  mustChangePassword: boolean;
  needsPosition: boolean;
  capabilities: {
    canCreateRequest: boolean;
    canReviewRequest: boolean;
    canStockCheck: boolean;
    canReadInventory: boolean;
    canManagePurchase: boolean;
  };
}

/**
 * 给商城看的状态（由需求单的状态、主管确认、核库与各行进度合出来，名字固定）：
 * dept_pending 待主管确认 · stock_check 待核库 · stock_confirming 待部门确认替代 · reviewing 待采购审核 · returned 已退回（看原因）·
 * rejected 不采购（看原因）· cancelled 已撤回 · issued 已转领用 · approved 已通过、待下单 · sourcing 询价中 · ordered 已下单 ·
 * partial 部分到货 · received 已到货（全部到齐或领用）· closed 采购单已关闭（没到齐的不再到）
 */
export type MallDisplayStatus =
  | 'dept_pending'
  | 'stock_check'
  | 'stock_confirming'
  | 'reviewing'
  | 'returned'
  | 'rejected'
  | 'cancelled'
  | 'issued'
  | 'approved'
  | 'sourcing'
  | 'ordered'
  | 'partial'
  | 'received'
  | 'closed';

export const MALL_DISPLAY_LABELS: Record<MallDisplayStatus, string> = {
  dept_pending: '待主管确认',
  stock_check: '待核库',
  stock_confirming: '待部门确认替代',
  reviewing: '待采购审核',
  returned: '已退回',
  rejected: '不采购',
  cancelled: '已撤回',
  issued: '已转领用',
  approved: '已通过，待下单',
  sourcing: '询价中',
  ordered: '已下单',
  partial: '部分到货',
  received: '已到货',
  closed: '已关闭',
};

export type MallLineState = 'none' | 'sourcing' | 'ordered' | 'partial' | 'received' | 'closed' | 'issued';

export interface MallRequestLine {
  id: number;
  lineNo: number;
  materialId: number | null;
  name: string;
  purpose: string;
  qtyMilli: number;
  unit: string;
  /** 部门填的参考价（不是采购的成交价；成交价不给商城，店主 2026-11-24 定：可看供应商、不看价） */
  refPriceCents: number | null;
  link: string;
  details: string;
  note: string;
  /** 意向供应商 */
  supplier: { id: number; name: string } | null;
  skuCode: string;
  priceVersion: string;
  brandModel: string;
  expectedCategory: string;
  reasonText: string;
  imageIds: number[];
  progress: {
    state: MallLineState;
    /** 采购单号与供应商（没下单的为空） */
    poNo: string | null;
    supplierName: string | null;
    sourcingNo: string | null;
    orderedMilli: number;
    receivedMilli: number;
    returnedMilli: number;
    inventoryUnit: string | null;
  };
}

export interface MallRequest {
  id: number;
  docNo: string;
  externalNo: string | null;
  source: 'form' | 'import' | 'sheet' | 'mall';
  status: RequestStatus;
  displayStatus: MallDisplayStatus;
  displayLabel: string;
  /** 退回、不采购、撤回的原因 */
  reason: string | null;
  department: { id: number; name: string };
  requester: { id: number; name: string };
  contactName: string;
  priority: RequestPriority;
  needBy: string | null;
  createdAt: string;
  submittedAt: string;
  updatedAt: string;
  /** 进度最后一次变（审核、转采购单、收货、退货、询价都算），商城按它判断要不要刷新 */
  progressUpdatedAt: string;
  deptConfirm: { state: 'none' | 'pending' | 'confirmed'; headName: string | null };
  stockCheck: StockCheckState;
  store: { id: number; name: string } | null;
  entity: { id: number; name: string } | null;
  budgetProject: string;
  deliveryAddress: string;
  paymentIntent: MallPaymentIntent | null;
  note: string;
  approvals: { action: string; actorName: string; reason: string; createdAt: string }[];
  lines: MallRequestLine[];
}

/** 列表、批量查状态的一行（不带明细） */
export interface MallRequestBrief {
  id: number;
  docNo: string;
  externalNo: string | null;
  source: MallRequest['source'];
  status: RequestStatus;
  displayStatus: MallDisplayStatus;
  displayLabel: string;
  reason: string | null;
  department: { id: number; name: string };
  priority: RequestPriority;
  needBy: string | null;
  createdAt: string;
  updatedAt: string;
  progressUpdatedAt: string;
  lineCount: number;
  orderedLines: number;
  receivedLines: number;
  summary: string;
}

export interface MallCreateResult {
  request: MallRequest;
  /** 同一个操作编号原样重提：返回的是第一次建好的那张 */
  replayed: boolean;
}
