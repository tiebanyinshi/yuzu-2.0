// 采购模块按单号查（8.2.12 R1，服务端 src/server/modules/purchase-lookup.ts）

export type DocLookupKind = 'po' | 'request' | 'receipt';
export const DOC_LOOKUP_KIND_LABELS: Record<DocLookupKind, string> = { po: '采购单', request: '需求单', receipt: '收货单' };

export interface DocLookupHit {
  kind: DocLookupKind;
  id: number;
  docNo: string;
  status: string;
  /** 采购单、收货单是供应商；需求单是申请部门 */
  party: string;
  /** 物料摘要（前三项） */
  summary: string;
  at: string;
  /** 完整单号命中（不管大小写与分隔符） */
  exact: boolean;
  /** 反查到的采购单（需求单还没转采购单、直接收货的为空） */
  poId: number | null;
  requestId: number | null;
}

export interface DocLookupResult {
  query: string;
  /** 有精确命中时只给精确的；没有时给后缀、包含命中的候选（最多 20 条） */
  hits: DocLookupHit[];
  exact: boolean;
}
