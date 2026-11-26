// 业财法 P07：人力资源付款批次与费用分摊引擎（docs/APPROVAL_V4.md 第 11 节）。两端共用的规则。
//   · HR 生成工资 / 提成 / 现金福利批次 → 工资、提成要主责部门确认业绩与计算依据 → HR 复核人员、期间、规则、金额 →
//     财务复核预算、税务、账户、成本分摊 → 财总＋CFO 共同审批（不看金额，常规与异常一样）→ 出纳按批次付款；
//   · 异常批次（补发、调整、离职结算、预算外奖励）同一流程，关联原批次编号与异常说明，仍是财总＋CFO，不转董事长；历史只追加；
//   · 实物福利、福利商品、活动服务转采购合同＋供应商入库；员工个人报销 / 垫付走普通报销，不进 HR 批次；
//   · 出纳付款前复核批次总人数、总金额、收款账户三者一致，不一致退回 HR 与财务核对；
//   · 无纸化凭证按类型必备，不能只有总额表；批次号唯一；薪资明细最小权限，不做大范围知会；
//   · 费用分摊引擎：规则有版本、执行结果只追加，冲正追加负数记录，不能删原分摊。

import type { GfNode, GfRole } from './govflow';

export const HR_BATCH_KINDS = ['salary', 'commission', 'cash_benefit', 'supplement', 'adjustment', 'separation', 'extra_bonus'] as const;
export type HrBatchKind = (typeof HR_BATCH_KINDS)[number];
export const HR_BATCH_KIND_LABELS: Record<HrBatchKind, string> = {
  salary: '工资',
  commission: '提成',
  cash_benefit: '现金福利',
  supplement: '补发（异常）',
  adjustment: '调整（异常）',
  separation: '离职结算（异常）',
  extra_bonus: '预算外奖励（异常）',
};
export const HR_ABNORMAL_KINDS: readonly HrBatchKind[] = ['supplement', 'adjustment', 'separation', 'extra_bonus'];
export const isAbnormalBatch = (k: HrBatchKind) => HR_ABNORMAL_KINDS.includes(k);

/** 不进 HR 批次的：实物福利 / 福利商品 / 活动服务转采购合同＋供应商入库；个人报销 / 垫付走普通报销 */
export const HR_REDIRECTS = { in_kind: '实物福利、福利商品、活动服务要转采购合同＋供应商入库流程，不能走 HR 付款', reimbursement: '员工个人报销、垫付走普通报销，不进 HR 批次' } as const;

export const HR_EVIDENCE_KINDS = [
  'payroll_sheet',
  'attendance',
  'social_tax_account',
  'performance_confirm',
  'commission_rules',
  'calc_detail',
  'benefit_policy',
  'name_list',
  'benefit_standard',
  'original_batch',
  'abnormal_reason',
  'diff_detail',
  'total_sheet',
] as const;
export type HrEvidenceKind = (typeof HR_EVIDENCE_KINDS)[number];
export const HR_EVIDENCE_LABELS: Record<HrEvidenceKind, string> = {
  payroll_sheet: '工资表',
  attendance: '考勤 / 计薪依据',
  social_tax_account: '社保、个税与账户资料',
  performance_confirm: '业绩确认',
  commission_rules: '提成规则',
  calc_detail: '计算明细',
  benefit_policy: '福利政策',
  name_list: '名单',
  benefit_standard: '发放标准',
  original_batch: '原批次',
  abnormal_reason: '异常原因',
  diff_detail: '差异明细',
  total_sheet: '总额表',
};
/** 各类批次必备的凭证（只有总额表不够） */
export function requiredEvidence(kind: HrBatchKind): HrEvidenceKind[] {
  if (kind === 'salary') return ['payroll_sheet', 'attendance', 'social_tax_account'];
  if (kind === 'commission') return ['performance_confirm', 'commission_rules', 'calc_detail'];
  if (kind === 'cash_benefit') return ['benefit_policy', 'name_list', 'benefit_standard'];
  return ['original_batch', 'abnormal_reason', 'diff_detail'];
}
export const missingEvidence = (kind: HrBatchKind, given: readonly string[]) => requiredEvidence(kind).filter((k) => !given.includes(k));

/** 工资、提成要主责部门确认业绩与计算依据 */
export const needsDeptConfirm = (k: HrBatchKind) => k === 'salary' || k === 'commission';

/** 审批链：不看金额，常规与异常一样（异常只是要原批次与说明） */
export function hrTemplate(kind: HrBatchKind): GfNode[] {
  return [
    ...(needsDeptConfirm(kind) ? [{ kind: 'dept_head', stage: 'review' } as GfNode] : []),
    { kind: 'role', role: 'hr', stage: 'review' },
    { kind: 'role', role: 'finance_reviewer', stage: 'review' },
    { kind: 'all', roles: ['finance_chief', 'cfo'], label: '财总＋CFO 共同审批', stage: 'special' },
    { kind: 'role', role: 'cashier', stage: 'final' },
  ];
}

/** 看得到人员明细、回单的（最小权限） */
export const HR_DETAIL_ROLES: readonly GfRole[] = ['hr', 'finance_reviewer', 'finance_chief', 'cfo', 'cashier'];

/** 出纳复核：人数、总额、账户三者都要一致 */
export interface CashierCheck {
  headcount: number;
  totalCents: number;
  accountsDigest: string;
}
export function cashierMismatch(batch: CashierCheck, input: CashierCheck): string[] {
  const out: string[] = [];
  if (batch.headcount !== input.headcount) out.push(`总人数不一致（批次 ${batch.headcount}，复核 ${input.headcount}）`);
  if (batch.totalCents !== input.totalCents) out.push('总金额不一致');
  if (batch.accountsDigest !== input.accountsDigest) out.push('收款账户不一致');
  return out;
}

// ───────────────────────── 费用分摊 ─────────────────────────

export interface AllocSplit {
  departmentId: number;
  /** 万分比，合计 10000 */
  bp: number;
}
/** 按比例分摊，尾差给最后一个（合计永远等于原金额） */
export function allocate(amountCents: number, splits: readonly AllocSplit[]): { departmentId: number; cents: number }[] {
  const total = splits.reduce((a, s) => a + s.bp, 0);
  if (total !== 10_000) throw new Error('分摊比例合计要等于 100%');
  let left = amountCents;
  return splits.map((s, i) => {
    const cents = i === splits.length - 1 ? left : Math.floor((amountCents * s.bp) / 10_000);
    left -= cents;
    return { departmentId: s.departmentId, cents };
  });
}

export interface HrBatchView {
  docId: number;
  batchNo: string;
  kind: HrBatchKind;
  period: string;
  headcount: number;
  totalCents: number;
  originalBatchNo: string | null;
  evidence: { kind: HrEvidenceKind; ref: string }[];
  /** 没权限的不给明细 */
  lines: { staffName: string; amountCents: number; accountMasked: string; costDeptName: string }[] | null;
  paid: { bankRef: string; paidAt: string } | null;
  mismatches: string[];
}

export interface AllocRuleView {
  id: number;
  name: string;
  version: number;
  splits: (AllocSplit & { departmentName: string })[];
}
export interface AllocRunView {
  id: number;
  ruleId: number;
  ruleVersion: number;
  sourceDocId: number | null;
  kind: 'run' | 'reverse';
  amountCents: number;
  reversesRunId: number | null;
  lines: { departmentId: number; departmentName: string; cents: number }[];
  createdAt: string;
}
