// 业财法 P05：付款与紧急特批（docs/APPROVAL_V4.md 第 9 节）。两端共用的路由与核对规则。
//   · 正常付款简化：关联有效合同 / 付款节点、有验收对账依据、金额在剩余应付内、已取票或登记后补、收款账户没有在审变更、没有异常
//     → 只走 主责部门负责人 → 财务 → 出纳；
//   · 无合同付款：必须签合同的（采购 / 服务 / 工程 ≥ 1 万）不得走无合同付款绕开；高额（≥ 5 万）或异常的按 CFO → CEO → 董事长；
//   · 紧急特批：未入库供应商或合同没完成的紧急付款，由 CFO＋经营主体负责人微信确认（付款前两人都同意），出纳独立核验收款方与账户；
//     少付 / 分次可补登，累计不得超特批金额，超额或换账户重新特批；
//   · 发票：预付款不强制先票，其他先票后款；后补 5 个工作日；
//   · 重复支付：同一合同已付 + 在途不超过合同含税金额；同一收款方同一发票号只付一次；出纳付款带银行流水号（唯一）。

import { WAN, type GfNode } from './govflow';

export const PAYMENT_CATEGORIES = ['purchase', 'service', 'engineering', 'rent', 'utility', 'tax', 'other'] as const;
export type PaymentCategory = (typeof PAYMENT_CATEGORIES)[number];
export const PAYMENT_CATEGORY_LABELS: Record<PaymentCategory, string> = {
  purchase: '采购',
  service: '服务',
  engineering: '工程',
  rent: '租金',
  utility: '水电燃气',
  tax: '税费',
  other: '其他',
};
/** 这几类达到 1 万必须签合同，不能走无合同付款 */
export const CONTRACT_REQUIRED_CATEGORIES: readonly PaymentCategory[] = ['purchase', 'service', 'engineering'];
export const CONTRACT_REQUIRED_CENTS = 1 * WAN;
/** 无合同付款的高额线 */
export const NO_CONTRACT_HIGH_CENTS = 5 * WAN;
/** 发票后补期限（工作日） */
export const INVOICE_LATER_WORKDAYS = 5;

export const INVOICE_STATES = ['received', 'later', 'not_required'] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];
export const INVOICE_STATE_LABELS: Record<InvoiceState, string> = { received: '已取票', later: '登记后补', not_required: '预付款暂不需要' };

export interface PaymentFacts {
  hasContract: boolean;
  /** 合同有效（审批通过、没作废） */
  contractValid: boolean;
  category: PaymentCategory;
  amountCents: number;
  /** 合同剩余应付（含税）；无合同为空 */
  remainingCents: number | null;
  hasAcceptanceBasis: boolean;
  prepay: boolean;
  invoice: InvoiceState;
  accountChangePending: boolean;
  abnormal: boolean;
  emergency: boolean;
}

export interface PaymentRoute {
  /** 走不了的原因（拦截） */
  blockers: string[];
  path: 'normal' | 'no_contract' | 'no_contract_high' | 'emergency';
  nodes: GfNode[];
}

const NORMAL: GfNode[] = [
  { kind: 'dept_head', stage: 'review' },
  { kind: 'role', role: 'finance_reviewer', stage: 'review' },
  { kind: 'role', role: 'cashier', stage: 'final' },
];

export function routePayment(f: PaymentFacts): PaymentRoute {
  const blockers: string[] = [];
  if (f.accountChangePending) blockers.push('收款账户有在审的变更，审完再付');
  if (f.invoice === 'not_required' && !f.prepay) blockers.push('只有预付款可以不先取票；其他先票后款（没票的选「登记后补」）');
  if (f.emergency) {
    return { blockers, path: 'emergency', nodes: [{ kind: 'role', role: 'cashier', stage: 'final' }] };
  }
  if (f.hasContract) {
    if (!f.contractValid) blockers.push('关联的合同不是有效的（没审批通过或已变更作废）');
    if (f.remainingCents !== null && f.amountCents > f.remainingCents) blockers.push('付款金额超过合同剩余应付（含在途），不能重复支付');
    if (!f.hasAcceptanceBasis && !f.prepay) blockers.push('请填验收 / 对账依据');
    return { blockers, path: 'normal', nodes: f.abnormal ? [...NORMAL.slice(0, 2), { kind: 'role', role: 'cfo', stage: 'review' }, NORMAL[2]!] : NORMAL };
  }
  if (CONTRACT_REQUIRED_CATEGORIES.includes(f.category) && f.amountCents >= CONTRACT_REQUIRED_CENTS) {
    blockers.push('这类事项达到 1 万必须签合同，不能走无合同付款');
  }
  if (f.amountCents >= NO_CONTRACT_HIGH_CENTS || f.abnormal) {
    return {
      blockers,
      path: 'no_contract_high',
      nodes: [
        { kind: 'dept_head', stage: 'review' },
        { kind: 'role', role: 'finance_reviewer', stage: 'review' },
        { kind: 'role', role: 'cfo', stage: 'final' },
        { kind: 'role', role: 'entity_head', stage: 'final' },
        { kind: 'role', role: 'chairman', stage: 'final' },
        { kind: 'role', role: 'cashier', stage: 'final' },
      ],
    };
  }
  return { blockers, path: 'no_contract', nodes: NORMAL };
}

export interface PayoutView {
  id: number;
  amountCents: number;
  payeeAccount: string;
  bankRef: string;
  paidByName: string;
  paidAt: string;
}

export interface PaymentView {
  docId: number;
  path: PaymentRoute['path'];
  contractDocId: number | null;
  contractNo: string | null;
  supplierId: number | null;
  payeeName: string;
  payeeAccountMasked: string;
  amountCents: number;
  paidCents: number;
  invoice: InvoiceState;
  invoiceNo: string;
  needsReconfirm: boolean;
  specialId: number | null;
  specialNo: string | null;
  specialRemainingCents: number | null;
  payouts: PayoutView[];
}
