// 采购单与流程进度的排序（8.2.6，《采购模块需求补充：单号搜索 / 排序 / 无供应商自购》R2）：
// 排序在服务端做（全量，不是只排当前页）；空值排最后；同值按单号再排；点同一列：降序 → 升序 → 恢复默认（三态）

export const PO_SORTS = ['order_date', 'created', 'expected', 'priority', 'total', 'status', 'doc_no', 'supplier'] as const;
export type PoSort = (typeof PO_SORTS)[number];
export const PO_SORT_LABELS: Record<PoSort, string> = {
  order_date: '下单日期',
  created: '提交时间',
  expected: '预计到货',
  priority: '紧急程度',
  total: '金额',
  status: '状态',
  doc_no: '单号',
  supplier: '供应商',
};

export const FLOW_SORTS = ['moved', 'started', 'priority', 'dwell', 'doc_no'] as const;
export type FlowSort = (typeof FLOW_SORTS)[number];
export const FLOW_SORT_LABELS: Record<FlowSort, string> = {
  moved: '节点更新时间',
  started: '发起时间',
  priority: '紧急程度',
  dwell: '停留时长',
  doc_no: '单号',
};

export type SortDir = 'asc' | 'desc';

/** 三态：换一列从降序开始；同一列降序 → 升序 → 恢复默认（null） */
export function nextSort<K extends string>(cur: { key: K | null; dir: SortDir }, key: K): { key: K | null; dir: SortDir } {
  if (cur.key !== key) return { key, dir: 'desc' };
  if (cur.dir === 'desc') return { key, dir: 'asc' };
  return { key: null, dir: 'desc' };
}

/** 紧急程度的权重（按权重排，不按拼音）：紧急 3、较急 2、普通 1 */
export const PRIORITY_WEIGHT = { urgent: 3, high: 2, normal: 1 } as const;

/** 采购单列表一页的张数（满一页时页面上有「再加载 300 张」） */
export const PO_PAGE_SIZE = 300;
