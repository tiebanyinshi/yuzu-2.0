// 业财法 P06：报销、出差（部门月度差旅预算）、商务招待、用印证照（docs/APPROVAL_V4.md 第 10 节）。两端共用的路由规则。
//   · 普通报销：部门负责人 → 财务 → 出纳，不因金额升级；超过 2 万 CFO 知会、超过 5 万 CFO＋董事长知会；无票先财总复核再付；
//     已用备用金的事项（同一张发票）不得重复报销；
//   · 出差：显示部门当月差旅批复额度、已用、冻结、剩余；预算内 部门负责人 → 财务（预算与标准审核）；超预算本月原则上不报，可登记转下月，
//     特殊的财总＋CFO 特批；无事前申请 / 一般超标财总复核，超预算 / 重大异常 CFO，50 万及以上异常 CFO → CEO → 董事长；
//     结束后 5 个工作日内报销并关联原申请；
//   · 商务招待：部门负责人 → 财务；超过 2 万加财总、超过 5 万加 CFO；无事前申请至少财总；金额、人数减少不重审；
//   · 用印证照：已批合同没改动不重审（章证管理员直接用印）；非合同文件部门负责人 + 财法按内容审，高风险 / 超授权到经营主体负责人；
//     空白文件财总＋经营主体负责人特批、5 个工作日补最终版；用印后 1 个工作日扫描归档；电子证照只发水印副本；纸质证照登记借还、超期提醒。

import { WAN, type GfNode, type GfRole } from './govflow';

export const EXPENSE_CC_CFO_CENTS = 2 * WAN;
export const EXPENSE_CC_CHAIRMAN_CENTS = 5 * WAN;
export const ENTERTAIN_CHIEF_CENTS = 2 * WAN;
export const ENTERTAIN_CFO_CENTS = 5 * WAN;
export const TRAVEL_ABNORMAL_TOP_CENTS = 50 * WAN;
export const TRAVEL_CLAIM_WORKDAYS = 5;
export const SEAL_FINAL_WORKDAYS = 5;
export const SEAL_ARCHIVE_WORKDAYS = 1;
export const LICENSE_LOAN_MAX_DAYS = 30;

const head: GfNode = { kind: 'dept_head', stage: 'review' };
const fin: GfNode = { kind: 'role', role: 'finance_reviewer', stage: 'review' };
const role = (r: GfRole, stage: 'review' | 'final' | 'special' = 'final'): GfNode => ({ kind: 'role', role: r, stage });

/** 普通报销：链不因金额升级；无票加财总复核（付款前） */
export function expenseTemplate(input: { hasInvoice: boolean }): GfNode[] {
  return [head, fin, ...(input.hasInvoice ? [] : [role('finance_chief', 'review')]), role('cashier')];
}
/** 报销的知会：超过 2 万 CFO，超过 5 万 CFO＋董事长（都是「超过」，整值不算） */
export function expenseCc(amountCents: number): GfRole[] {
  if (amountCents > EXPENSE_CC_CHAIRMAN_CENTS) return ['cfo', 'chairman'];
  if (amountCents > EXPENSE_CC_CFO_CENTS) return ['cfo'];
  return [];
}

export interface TravelFacts {
  amountCents: number;
  /** 部门本月差旅剩余（批复 − 已用 − 冻结） */
  remainingCents: number;
  priorApplied: boolean;
  overStandard: boolean;
  majorAbnormal: boolean;
  /** 超预算时：登记转下月 / 特殊事项特批 */
  overBudgetMode: 'defer' | 'special' | null;
}
export interface TravelRoute {
  overBudget: boolean;
  blockers: string[];
  nodes: GfNode[];
}
export function routeTravel(f: TravelFacts): TravelRoute {
  const overBudget = f.amountCents > f.remainingCents;
  const blockers: string[] = [];
  if (overBudget && !f.overBudgetMode) blockers.push('超出部门本月差旅预算：本月原则上不报，选「登记转下月」，特殊事项选「财总＋CFO 特批」');
  const nodes: GfNode[] = [head, { ...fin, stage: 'review' }];
  if (!f.priorApplied || f.overStandard) nodes.push(role('finance_chief', 'review'));
  if (f.majorAbnormal && f.amountCents >= TRAVEL_ABNORMAL_TOP_CENTS) nodes.push(role('cfo'), role('entity_head'), role('chairman'));
  else if (f.majorAbnormal || (overBudget && f.overBudgetMode === 'special')) nodes.push(role('cfo'));
  if (overBudget && f.overBudgetMode === 'special') nodes.push({ kind: 'all', roles: ['finance_chief', 'cfo'], label: '财总＋CFO 特批（超部门差旅预算）', stage: 'special' });
  return { overBudget, blockers, nodes: dedupe(nodes) };
}

export function entertainTemplate(input: { amountCents: number; priorApplied: boolean }): GfNode[] {
  const nodes: GfNode[] = [head, fin];
  if (input.amountCents > ENTERTAIN_CHIEF_CENTS || !input.priorApplied) nodes.push(role('finance_chief', input.amountCents > ENTERTAIN_CFO_CENTS ? 'review' : 'final'));
  if (input.amountCents > ENTERTAIN_CFO_CENTS) nodes.push(role('cfo'));
  return nodes;
}
/** 金额、人数都不增加（减少或不变）的变更不重审 */
export const entertainKeepsApproval = (oldCents: number, newCents: number, oldPeople: number, newPeople: number) => newCents <= oldCents && newPeople <= oldPeople;

export const SEAL_KINDS = ['contract', 'document', 'blank', 'license_e', 'license_paper'] as const;
export type SealKind = (typeof SEAL_KINDS)[number];
export const SEAL_KIND_LABELS: Record<SealKind, string> = {
  contract: '已批合同用印',
  document: '非合同文件用印',
  blank: '空白文件用印',
  license_e: '电子证照（水印副本）',
  license_paper: '纸质证照借用',
};
export function sealTemplate(input: { kind: SealKind; contractUnchanged: boolean; highRisk: boolean }): GfNode[] {
  switch (input.kind) {
    case 'contract':
      // 已批合同没改动：不重审，章证管理员核对后用印；改过的按非合同文件审
      return input.contractUnchanged ? [role('seal_keeper')] : sealTemplate({ ...input, kind: 'document' });
    case 'document':
      return [
        head,
        { kind: 'all', roles: ['finance_reviewer', 'legal'], label: '财务、法务按内容审', stage: 'review' },
        ...(input.highRisk ? [role('entity_head')] : []),
        role('seal_keeper', 'review'),
      ];
    case 'blank':
      return [head, { kind: 'all', roles: ['finance_chief', 'entity_head'], label: '财总＋经营主体负责人特批（空白文件）', stage: 'special' }, role('seal_keeper', 'review')];
    case 'license_e':
    case 'license_paper':
      return [head, role('seal_keeper', 'review')];
  }
}

function dedupe(nodes: GfNode[]): GfNode[] {
  const seen = new Set<string>();
  return nodes.filter((n) => {
    const k = JSON.stringify({ ...n, stage: undefined });
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface TravelBudgetView {
  departmentId: number;
  departmentName: string;
  month: string;
  budgetCents: number;
  usedCents: number;
  frozenCents: number;
  remainingCents: number;
  deferredInCents: number;
}

export interface LicenseView {
  id: number;
  name: string;
  kind: 'electronic' | 'paper';
  entityName: string | null;
  onLoan: { loanId: number; borrowerName: string; dueOn: string; overdue: boolean } | null;
}
