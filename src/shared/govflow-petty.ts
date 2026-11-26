// 业财法 P03：零星采购与备用金额度（docs/APPROVAL_V4.md 第 7 节）。两端共用的阈值、纯规则与形状。
//   · 零星采购分级：单笔 ≤ 3,000 元且 ≤ 50 件基础审核；超出只加审核内容（比价说明）不加层级；普通员工发起一律先过部门负责人；
//     合同、工程、服务外包、预付款、固定资产不走零星快速通道；
//   · 防拆单：同日同供应商合并计算（合起来超了就按超出处理并提示疑似拆单）；
//   · 采购部门当日累计超 1 万：非紧急转正式采购 / 合同，紧急由财总＋CFO 特批；
//   · 部门备用金台账：按费用承担部门 + 自然日 / 月，日 1 万、月 5 万，80% / 90% 预警；超额由财总＋CFO 合并特批（一个事项触发几个限额只特批一次），
//     特批形成一次性专项额度只给本事项；额度在数据库事务内锁定重算，冻结 → 验收转实际占用 → 取消 / 差额释放，台账只追加；
//   · 负责人自购：部门负责人直接用备用金自购，不需采购部门审批（采购部门只收记录），不免验收（部门里另一名员工验收、办部门小仓入库），发票冲抵；
//   · 逾期：验收期限过了没验收的，限制经办人（保管人）新增借款，恢复要财总复核；
//   · 月度额度核定：内控提建议，财总＋CFO 共同审批，次月生效，不自动升降。

import { WAN, YUAN, type GfNode } from './govflow';

export const PETTY_BASIC_CENTS = 3000 * YUAN;
export const PETTY_BASIC_QTY = 50;
export const DEPT_DAILY_CENTS = 1 * WAN;
export const DEPT_MONTHLY_CENTS = 5 * WAN;
export const PURCHASE_DEPT_DAILY_CENTS = 1 * WAN;
/** 审批通过后几天内要验收（过了算逾期） */
export const PETTY_ACCEPT_DAYS = 7;

/** 不走零星快速通道的采购类型 */
export const PETTY_KINDS = ['goods', 'contract', 'engineering', 'service_outsource', 'prepay', 'fixed_asset'] as const;
export type PettyKind = (typeof PETTY_KINDS)[number];
export const PETTY_KIND_LABELS: Record<PettyKind, string> = {
  goods: '一般物资',
  contract: '要签合同的',
  engineering: '工程',
  service_outsource: '服务外包',
  prepay: '预付款',
  fixed_asset: '固定资产',
};
export const pettyAllowed = (kind: PettyKind) => kind === 'goods';

export type PettyTier = 'basic' | 'enhanced';
/** 分级（合并同日同供应商以后的金额、件数）：≤ 3,000 元且 ≤ 50 件基础审核，否则加审核内容 */
export function pettyTier(amountCents: number, qty: number): PettyTier {
  return amountCents <= PETTY_BASIC_CENTS && qty <= PETTY_BASIC_QTY ? 'basic' : 'enhanced';
}

export interface QuotaFacts {
  dailyLimit: number;
  monthlyLimit: number;
  /** 本部门今天 / 本月已占用（实际占用 + 冻结） */
  dayTaken: number;
  monthTaken: number;
  amount: number;
}
export interface QuotaCheck {
  overDaily: boolean;
  overMonthly: boolean;
  /** 要不要财总＋CFO 合并特批（几个限额都超也只特批一次） */
  needSpecial: boolean;
  /** 超出部分（按超得多的那个算），特批形成的一次性专项额度 */
  overCents: number;
  /** 这一笔以后达到的预警线（80 / 90），没到为空 */
  warn: 80 | 90 | null;
}
export function quotaCheck(f: QuotaFacts): QuotaCheck {
  const day = f.dayTaken + f.amount;
  const month = f.monthTaken + f.amount;
  const overDaily = day > f.dailyLimit;
  const overMonthly = month > f.monthlyLimit;
  const overCents = Math.max(0, day - f.dailyLimit, month - f.monthlyLimit);
  const pct = Math.max(f.dailyLimit ? (day * 100) / f.dailyLimit : 0, f.monthlyLimit ? (month * 100) / f.monthlyLimit : 0);
  const warn = pct >= 90 ? 90 : pct >= 80 ? 80 : null;
  return { overDaily, overMonthly, needSpecial: overDaily || overMonthly, overCents, warn };
}

/** 采购部门当日累计：超 1 万的非紧急转正式采购 / 合同，紧急要财总＋CFO 特批 */
export function purchaseDeptCheck(cumBefore: number, amount: number, urgent: boolean): 'ok' | 'formal' | 'special' {
  if (cumBefore + amount <= PURCHASE_DEPT_DAILY_CENTS) return 'ok';
  return urgent ? 'special' : 'formal';
}

/**
 * 零星采购的审批链：普通员工发起先过部门负责人（负责人自购这一级自动视同确认），再财务审核人基础审核（超出的加比价说明，不加层级）；
 * 超部门额度或采购部门紧急超 1 万的，加一级财总＋CFO 共同审批（合并成一次）。
 */
export function pettyTemplate(input: { needSpecial: boolean }): GfNode[] {
  const nodes: GfNode[] = [
    { kind: 'dept_head', stage: 'review' },
    { kind: 'role', role: 'finance_reviewer', stage: 'final' },
  ];
  if (input.needSpecial) nodes.push({ kind: 'all', roles: ['finance_chief', 'cfo'], label: '财总＋CFO 合并特批', stage: 'special' });
  return nodes;
}

// ───────────────────────── 接口的形状 ─────────────────────────

export interface PettyQuotaView {
  departmentId: number;
  departmentName: string;
  day: string;
  month: string;
  dailyLimit: number;
  monthlyLimit: number;
  dayUsed: number;
  dayFrozen: number;
  monthUsed: number;
  monthFrozen: number;
  dayRemaining: number;
  monthRemaining: number;
  warn: 80 | 90 | null;
  overdue: number;
  splitSuspects: number;
  /** 下月已核定的额度（还没生效） */
  nextMonth: { dailyLimit: number; monthlyLimit: number } | null;
}

export interface PettyPreview {
  tier: PettyTier;
  combinedCents: number;
  combinedQty: number;
  splitSuspect: boolean;
  quota: QuotaCheck & { dailyLimit: number; monthlyLimit: number; dayTaken: number; monthTaken: number };
  purchaseDept: 'ok' | 'formal' | 'special' | null;
  blockedReason: string | null;
}
