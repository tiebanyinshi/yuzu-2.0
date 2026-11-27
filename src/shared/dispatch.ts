// 物料发配记录（8.2.5，《汤崎 ERP｜采购商城模块 需求变更文档 v0.2》第 5、6 章，docs/MALL_V825.md）：
// 部门申请的物料一次给不完的，先给库存里有的（核库领用），剩下的采购到货以后在这里「补发物料」，直到待发配量为 0。

export const DISPATCH_TABS = ['open', 'unissued', 'done', 'ended', 'all'] as const;
export type DispatchTab = (typeof DISPATCH_TABS)[number];
export const DISPATCH_TAB_LABELS: Record<DispatchTab, string> = {
  open: '未完成',
  unissued: '未发配申请',
  done: '已完成',
  ended: '已终止',
  all: '全部',
};

export const DISPATCH_RANGES = ['today', 'week', 'month', 'all', 'custom'] as const;
export type DispatchRange = (typeof DISPATCH_RANGES)[number];
export const DISPATCH_RANGE_LABELS: Record<DispatchRange, string> = { today: '今天', week: '近一周', month: '本月', all: '全部', custom: '自定义' };

/** 申请行的发配状态：pending 待发配（库存没有、也没在途）、partial 部分发配、awaiting 待到货（在途）、ready 可发配（库存有）、done 已完成、ended 已终止 */
export const DISPATCH_STATUSES = ['pending', 'partial', 'awaiting', 'ready', 'done', 'ended'] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];
export const DISPATCH_STATUS_LABELS: Record<DispatchStatus, string> = {
  pending: '待发配',
  partial: '部分发配',
  awaiting: '待到货',
  ready: '可发配',
  done: '已完成',
  ended: '已终止',
};

export const DISPATCH_KIND_LABELS = { stock: '库存发配', arrival: '到货后发配' } as const;
export type DispatchKind = keyof typeof DISPATCH_KIND_LABELS;

export interface DispatchIssue {
  id: number;
  docId: number;
  docNo: string;
  /** 这一次发配的数量（需求行的单位） */
  qtyMilli: number;
  kind: DispatchKind;
  note: string;
  at: string;
  byName: string;
  /** 领料单作废了：这一条不算已发配 */
  voided: boolean;
}

export interface DispatchRow {
  lineId: number;
  requestId: number;
  docNo: string;
  source: string;
  departmentId: number;
  departmentName: string;
  requesterName: string;
  submittedAt: string;
  name: string;
  details: string;
  /** 申请行的单位 */
  unit: string;
  materialId: number | null;
  materialName: string | null;
  /** 物料的库存单位（库存可发量、在途量按它写） */
  inventoryUnit: string | null;
  /** 申请行的单位能换算成库存单位：inventory 一样、purchase 是采购单位、null 换不了（补发时另填库存单位的数量） */
  unitMode: 'inventory' | 'purchase' | null;
  appliedMilli: number;
  issuedMilli: number;
  pendingMilli: number;
  /** 总仓按先申请先给分到这一行的可发量（库存单位） */
  availableMilli: number;
  /** 关联采购单还没到的（库存单位） */
  inTransitMilli: number;
  expectedDate: string | null;
  lastIssue: DispatchIssue | null;
  issueCount: number;
  status: DispatchStatus;
  /** 时间筛选用的时间：最近一次发配，没发过的按申请提交时间 */
  activityAt: string;
}

export interface DispatchBoard {
  rows: DispatchRow[];
  counts: Record<DispatchTab, number>;
  /** 从哪天起记（升级到 8.2.5 那天；之前的需求单照原来手工开领料单） */
  since: string | null;
  truncated: boolean;
}

export interface DispatchDetail {
  row: DispatchRow;
  issues: DispatchIssue[];
}
