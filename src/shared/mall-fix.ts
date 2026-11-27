// 退回补资料（8.2.6，《汤崎 ERP｜采购商城模块 需求变更文档 v0.2》第 4 章，docs/MALL_V826.md）：
//   · 退回时逐项标「本次必补」（哪一行、哪一项、要补什么），不允许只写一句整体意见（商城来的需求单）
//   · 补资料两种模式：fix 只补必补项（其余锁定）；rewrite 重新填写（业务字段都能改）。两种都不换单号，每次提交存一版完整快照
//   · 终止申购：提单人申请，部门负责人或供应链 BP 确认；负责人、BP、店主自己提的直接终止

/** 行上的项（spec.* 只对定制的行有意义） */
export const MALL_FIX_LINE_FIELDS = [
  'name',
  'qty',
  'unit',
  'details',
  'brandModel',
  'link',
  'reasonText',
  'images',
  'spec.size',
  'spec.material',
  'spec.tolerance',
  'spec.color',
  'spec.craft',
  'spec.drawing',
  'spec.designVersion',
] as const;
/** 整张单的项 */
export const MALL_FIX_HEADER_FIELDS = ['needBy', 'deliveryAddress', 'budgetProject', 'contactName', 'note'] as const;
export const MALL_FIX_FIELDS = [...MALL_FIX_LINE_FIELDS, ...MALL_FIX_HEADER_FIELDS] as const;
export type MallFixHeaderField = (typeof MALL_FIX_HEADER_FIELDS)[number];
export type MallFixField = (typeof MALL_FIX_FIELDS)[number];

export const MALL_FIX_FIELD_LABELS: Record<MallFixField, string> = {
  name: '物品名称',
  qty: '数量',
  unit: '单位',
  details: '规格 / 说明',
  brandModel: '品牌型号',
  link: '参考链接',
  reasonText: '申请理由',
  images: '参考图片',
  'spec.size': '尺寸 / 规格',
  'spec.material': '材质',
  'spec.tolerance': '允许误差',
  'spec.color': '颜色 / 表面',
  'spec.craft': '工艺要求',
  'spec.drawing': '图纸文件或链接',
  'spec.designVersion': '设计版本',
  needBy: '期望到货日',
  deliveryAddress: '收货地点',
  budgetProject: '预算项目 / 费用归属',
  contactName: '经办人',
  note: '备注',
};

export const isMallFixHeaderField = (f: string): f is MallFixHeaderField => (MALL_FIX_HEADER_FIELDS as readonly string[]).includes(f);

export const MALL_RESUBMIT_MODES = ['fix', 'rewrite'] as const;
export type MallResubmitMode = (typeof MALL_RESUBMIT_MODES)[number];
export const MALL_RESUBMIT_MODE_LABELS: Record<MallResubmitMode, string> = { fix: '仅补必补项', rewrite: '重新填写' };

/** 退回时标的一项（审核页发给服务端的） */
export interface MallFixItemInput {
  /** 整张单的项为空 */
  lineId: number | null;
  field: MallFixField;
  requirement: string;
}

/** 一项必补（商城详情里看） */
export interface MallFixItem {
  id: number;
  round: number;
  lineId: number | null;
  lineLabel: string;
  field: MallFixField;
  fieldLabel: string;
  originalValue: string;
  requirement: string;
  suppliedValue: string | null;
  returnedByName: string;
  returnedAt: string;
  resolvedAt: string | null;
}

export const MALL_VERSION_MODE_LABELS = { submit: '首次提交', fix: '补齐后重新提交', rewrite: '重新填写后提交', baseline: '原版本（补记）' } as const;
export type MallVersionMode = keyof typeof MALL_VERSION_MODE_LABELS;

export interface MallVersionBrief {
  versionNo: number;
  mode: MallVersionMode;
  createdAt: string;
  createdByName: string;
}

/** 版本快照：提交那一刻的整张单 */
export interface MallVersionSnapshot {
  header: { needBy: string | null; deliveryAddress: string; budgetProject: string; contactName: string; priority: string; note: string };
  lines: {
    id: number;
    lineNo: number;
    name: string;
    qtyMilli: number;
    unit: string;
    details: string;
    brandModel: string;
    link: string;
    reasonText: string;
    customKind: string | null;
    customSpec: Record<string, unknown> | null;
    imageIds: number[];
  }[];
}

export interface MallVersion extends MallVersionBrief {
  snapshot: MallVersionSnapshot;
}

export const MALL_TERMINATION_STATUS_LABELS = { pending: '终止待确认', approved: '已终止', declined: '终止被驳回' } as const;
export type MallTerminationStatus = keyof typeof MALL_TERMINATION_STATUS_LABELS;

export interface MallTermination {
  status: MallTerminationStatus;
  reason: string;
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decideNote: string;
}

/** 终止申购的原因写进需求单 reason 的前缀（撤回、不采购另有前缀） */
export const MALL_TERMINATE_PREFIX = '终止：';
