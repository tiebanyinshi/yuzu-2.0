// 业财法 P04：七类合同审批（docs/APPROVAL_V4.md 第 8 节）。两端共用的类型判定、金额口径、档位路由。
//   · 七类：采购 / 服务 / 工程 / 租赁及资产使用 / 经营合作 / 无金额 / 其他，按经济实质判定；混合合同能拆则拆；「其他」由财法确认归属，未确认不得签署；
//   · 审批按不含税金额（框架 / 按量 / 租赁 / 经营合作按全合同期口径）；实际付款按含税；
//   · 档位：< 1 万财总、1–5 万 CFO、5–30 万 CEO、≥ 30 万董事长；重大风险 / 预付款 / 超预算至少 CFO；工程任何金额至少 CEO，≥ 30 万 CEO → 董事长；
//   · 链：部门负责人 → 内部履约执行人（+1）→ 财务、法务并行分审 →（内控）→ 金额 / 风险 / 工程终审 → 知会财总、CFO → 定稿签署 → 用印 → 1 个工作日内归档。

import { WAN, type GfNode, type GfRole } from './govflow';

export const CONTRACT_TYPES = ['purchase', 'service', 'engineering', 'lease', 'cooperation', 'no_amount', 'other'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  purchase: '采购',
  service: '服务',
  engineering: '工程',
  lease: '租赁及资产使用',
  cooperation: '经营合作',
  no_amount: '无金额',
  other: '其他',
};
export const CONTRACT_TYPE_HINTS: Record<ContractType, string> = {
  purchase: '取得物资所有权',
  service: '取得劳务成果',
  engineering: '施工与工程验收',
  lease: '一段期间的使用权',
  cooperation: '联营、共担收益与风险',
  no_amount: '没有金额（框架无价且下单也无价）',
  other: '以上都不是，财法确认归属后才能签署',
};

/** 经济实质（经办人勾选），用来判定类型、提示混合合同怎么拆 */
export interface ContractSubstance {
  ownership: boolean;
  laborResult: boolean;
  construction: boolean;
  periodUse: boolean;
  jointOperation: boolean;
  /** 施工里附带的设备与施工不可分 */
  equipmentInseparable: boolean;
  /** 设备采购附带的只是一般安装 */
  generalInstallOnly: boolean;
  /** 框架合同本身没有价格，但订单有价 */
  frameworkOrdersPriced: boolean;
  hasAmount: boolean;
}

export interface Classification {
  type: ContractType;
  /** 能拆的提示拆开签 */
  splitAdvice: string | null;
  reason: string;
}

/** 按经济实质判定（场景 36）；同时有几种实质且没有归并规则的，提示拆分 */
export function classifyContract(s: ContractSubstance): Classification {
  if (s.construction && s.ownership && s.equipmentInseparable) return { type: 'engineering', splitAdvice: null, reason: '施工附带设备且不可分，归工程' };
  if (s.ownership && s.construction && s.generalInstallOnly) return { type: 'purchase', splitAdvice: null, reason: '设备采购附带一般安装，归采购' };
  if (s.periodUse && s.jointOperation) return { type: 'cooperation', splitAdvice: null, reason: '资产使用但实质是共同经营，归经营合作' };
  if (!s.hasAmount && s.frameworkOrdersPriced) return { type: s.laborResult ? 'service' : 'purchase', splitAdvice: null, reason: '框架无价但订单有价，不归无金额' };
  const hits: ContractType[] = [];
  if (s.construction) hits.push('engineering');
  if (s.ownership) hits.push('purchase');
  if (s.laborResult) hits.push('service');
  if (s.jointOperation) hits.push('cooperation');
  else if (s.periodUse) hits.push('lease');
  if (hits.length === 0)
    return s.hasAmount ? { type: 'other', splitAdvice: null, reason: '没有匹配的经济实质，归其他（要财法确认归属）' } : { type: 'no_amount', splitAdvice: null, reason: '没有金额' };
  const splitAdvice = hits.length > 1 ? `同时有${hits.map((t) => CONTRACT_TYPE_LABELS[t]).join('、')}的实质：能拆的拆成几份合同分别审批` : null;
  return { type: hits[0]!, splitAdvice, reason: `按经济实质：${CONTRACT_TYPE_HINTS[hits[0]!]}` };
}

/** 要按全合同期口径算审批金额的 */
export const PERIOD_BASED: readonly ContractType[] = ['lease', 'cooperation'];

export interface ContractAmountInput {
  type: ContractType;
  /** 一次性 / 总价（不含税，分） */
  totalExTaxCents: number | null;
  /** 框架 / 按量 / 租赁 / 经营合作：每期（月）不含税金额 × 期数 */
  perPeriodExTaxCents: number | null;
  periods: number | null;
}

/** 审批口径的金额（不含税；分期的按全合同期） */
export function approvalAmount(a: ContractAmountInput): number {
  if (a.type === 'no_amount') return 0;
  const periodTotal = a.perPeriodExTaxCents !== null && a.periods ? a.perPeriodExTaxCents * a.periods : null;
  if (PERIOD_BASED.includes(a.type) && periodTotal === null) throw new Error('租赁、经营合作要按全合同期口径填每期金额和期数');
  return Math.max(a.totalExTaxCents ?? 0, periodTotal ?? 0);
}

/** 终审档位 */
export function contractFinals(type: ContractType, amountCents: number, flags: readonly string[]): GfRole[] {
  const atLeastCfo = flags.some((f) => f === 'major_risk' || f === 'prepay' || f === 'over_budget');
  if (type === 'engineering') return amountCents >= 30 * WAN ? ['entity_head', 'chairman'] : ['entity_head'];
  if (amountCents >= 30 * WAN) return ['chairman'];
  if (amountCents >= 5 * WAN) return ['entity_head'];
  if (amountCents >= 1 * WAN || atLeastCfo) return ['cfo'];
  return ['finance_chief'];
}

export function contractTemplate(type: ContractType, amountCents: number, flags: readonly string[]): GfNode[] {
  const finals = contractFinals(type, amountCents, flags);
  return [
    { kind: 'dept_head', stage: 'review' },
    { kind: 'performer', stage: 'review' },
    { kind: 'all', roles: ['finance_reviewer', 'legal'], label: '财务、法务并行分审（分别出结论）', stage: 'review' },
    // 金额 / 风险 / 工程终审阶段（工程 ≥ 30 万是 CEO → 董事长两级，都按终审回避；内控加在这一段前面）
    ...finals.map((role): GfNode => ({ kind: 'role', role, stage: 'final' })),
  ];
}

/** 变更：哪些算核心（原审批作废、重新路由）；只减金额、其他不变的保留原审批、留变更记录 */
export const CONTRACT_CHANGE_FIELDS = ['amount', 'party', 'scope', 'payment_terms', 'period', 'type'] as const;
export type ContractChangeField = (typeof CONTRACT_CHANGE_FIELDS)[number];
export const CONTRACT_CHANGE_LABELS: Record<ContractChangeField, string> = {
  amount: '金额',
  party: '相对方',
  scope: '标的 / 范围',
  payment_terms: '付款条件',
  period: '期限',
  type: '合同类型',
};
export function changeKeepsApproval(fields: readonly ContractChangeField[], oldCents: number, newCents: number): boolean {
  return fields.length === 1 && fields[0] === 'amount' && newCents < oldCents;
}

export interface ContractView {
  docId: number;
  contractNo: string;
  type: ContractType;
  confirmedType: ContractType | null;
  supplierId: number | null;
  supplierName: string | null;
  counterparty: string;
  approvalCents: number;
  taxInclusiveCents: number | null;
  version: number;
  inLibrary: boolean;
  signedAt: string | null;
  sealedAt: string | null;
  archiveDueOn: string | null;
  supersededBy: number | null;
}
