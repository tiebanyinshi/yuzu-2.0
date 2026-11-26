// 备用金的申用（8.1.42 起，docs/V8142_PETTY.md；来自 8.1.9 的零采备用金，docs/ERP_V819.md 第 2 节）。
// 金额为整数「分」。申用记在某个部门的备用金上：登记即占用这个部门的可用额度，挂的报销单（钱从「备用金」来）确认后不再占用；
// 可用 = 余额 − 已占用（余额就是部门备用金台账的余额：打款 − 已确认支出 − 退回 + 补付）。

/** 一笔申用现在的状态（从报销单推出来，不另存） */
export const PETTY_USE_STATES = ['open', 'submitted', 'reviewing', 'reimbursed', 'voided'] as const;
export type PettyUseState = (typeof PETTY_USE_STATES)[number];
export const PETTY_USE_STATE_LABELS: Record<PettyUseState, string> = {
  open: '待报销',
  submitted: '已提交报销',
  reviewing: '报销审核中',
  reimbursed: '已报销',
  voided: '已作废',
};

export const PETTY_BACKFILLS = ['pending', 'done'] as const;
export type PettyBackfill = (typeof PETTY_BACKFILLS)[number];
/** 补单：事后补的采购单 */
export const PETTY_BACKFILL_LABELS: Record<PettyBackfill, string> = { pending: '未补单', done: '已补单' };

/** 报销单上列出的申用（简要） */
export interface PettyUseBrief {
  id: number;
  docNo: string;
  useDate: string;
  applicantName: string;
  content: string;
  amountCents: number;
  backfill: PettyBackfill | null;
  poNo: string | null;
}

/** 挂在申用上的报销单（最近一张有效的；撤回、冲销的在详情里） */
export interface PettyUseClaimRef {
  id: number;
  docNo: string;
  status: import('./expenses').ClaimStatus;
  amountCents: number;
  confirmedAt: string | null;
}

export interface PettyUseRow {
  id: number;
  docNo: string;
  useDate: string;
  department: { id: number; name: string };
  applicant: { id: number; name: string };
  purpose: string;
  content: string;
  amountCents: number;
  note: string;
  state: PettyUseState;
  /** 补单：提交报销时必填，之后可以改；没填为空 */
  backfill: PettyBackfill | null;
  purchaseOrder: { id: number; docNo: string; supplierName: string } | null;
  submitNote: string;
  submittedAt: string | null;
  submittedByName: string | null;
  /** 现在挂着的有效报销单（待确认、退回、已确认） */
  claim: PettyUseClaimRef | null;
  voidReason: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  createdByName: string;
  createdAt: string;
  version: number;
  isSynthetic: boolean;
}

export interface PettyUseDetail extends PettyUseRow {
  /** 挂过的报销单（含撤回、冲销的），按登记顺序 */
  claims: PettyUseClaimRef[];
}

/** 一个部门备用金的几个数（申用面板顶上） */
export interface PettyUseSummary {
  /** 定额（部门备用金设置里填，可空） */
  limitCents: number | null;
  /** 余额 = 打款 − 已确认支出 − 退回 + 补付（与部门备用金台账同一个数） */
  balanceCents: number;
  /** 已占用 = 待报销 + 已提交 + 审核中的申用 */
  occupiedCents: number;
  /** 可用 = 余额 − 已占用；可能是负的（先报销、补足再申用） */
  availableCents: number;
  /** 建议补足 = 定额 − 余额（设了定额、余额不到定额时） */
  topUpCents: number | null;
  /** 待报销笔数（还占着额度的） */
  pendingCount: number;
  byState: Record<'open' | 'submitted' | 'reviewing', { count: number; cents: number }>;
  /** 本月报销完成（不再占用）的笔数与申用金额 */
  reimbursedThisMonth: { count: number; cents: number };
}

export interface PettyUseBoard {
  department: { id: number; name: string } | null;
  /** 可以选的部门：设了部门备用金、或有打款、或有申用的（停用的不列） */
  departments: { id: number; name: string }[];
  summary: PettyUseSummary | null;
  uses: PettyUseRow[];
  /** 列表没显示全（合计仍按全部算） */
  truncated: boolean;
}

/** 提交报销时可以选的采购单 */
export interface PettyPoOption {
  id: number;
  docNo: string;
  supplierName: string;
  orderDate: string;
  totalCents: number;
  status: string;
  /** 补单（按收货单补的采购单） */
  backfill: boolean;
}

/** 财务登记报销时可以勾的申用（已提交报销、还没挂有效报销单的） */
export interface PettyUseForClaim extends PettyUseBrief {
  departmentId: number;
  applicantId: number;
  purpose: string;
  purchaseOrderId: number | null;
  submitNote: string;
}
