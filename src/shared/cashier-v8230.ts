// 8.2.30 收银合并（docs/V8230_CASHIER.md）：港元现金的折算、大额找零、收银申请。前后端共用；金额为分（港元为港仙）。

/** 汇率的上下限（每 1 港元折多少人民币，百万分之一）：0.5–1.5 之外多半是填错了 */
export const HKD_RATE_MIN_PPM = 500_000;
export const HKD_RATE_MAX_PPM = 1_500_000;

/** 实给的港元（港仙）折成人民币（分）：向下取整，不让店里多算客人的钱 */
export function hkdWorth(tenderedHkd: number, ratePpm: number): number {
  return Math.floor((tenderedHkd * ratePpm) / 1_000_000);
}

/** 应收的人民币（分）折成港元（港仙）：向上取到港仙，客人给够这个数就不差钱 */
export function hkdDue(cny: number, ratePpm: number): number {
  return Math.ceil((cny * 1_000_000) / ratePpm);
}

/** 汇率显示：920000 → "0.92" */
export function rateText(ratePpm: number): string {
  return (ratePpm / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** "0.92" → 920000；填错返回 null */
export function parseRate(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const ppm = Math.round(Number(t) * 1_000_000);
  return ppm >= HKD_RATE_MIN_PPM && ppm <= HKD_RATE_MAX_PPM ? ppm : null;
}

/** 港仙显示成 "HK$163.05" */
export function formatHkd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}HK$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/** 大额找零要多确认一次（CM-4）：找零超过门槛，或超过这笔应收的 2 倍 */
export function bigChange(change: number, due: number, thresholdCents: number): boolean {
  return change > 0 && (change > thresholdCents || change > due * 2);
}

// ───────────── 收银申请（CM-5、CM-6） ─────────────

export const CASHIER_REQUEST_KINDS = ['refund', 'void'] as const;
export type CashierRequestKind = (typeof CASHIER_REQUEST_KINDS)[number];
export const CASHIER_REQUEST_KIND_LABELS: Record<CashierRequestKind, string> = { refund: '退款', void: '反结账' };

export const CASHIER_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const;
export type CashierRequestStatus = (typeof CASHIER_REQUEST_STATUSES)[number];
export const CASHIER_REQUEST_STATUS_LABELS: Record<CashierRequestStatus, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  expired: '已失效',
  cancelled: '已撤回',
};

/** 申请多久没人批就失效（CM-6） */
export const CASHIER_REQUEST_TTL_HOURS = 24;

export interface CashierRequestView {
  id: number;
  requestNo: string;
  kind: CashierRequestKind;
  checkoutId: number;
  checkoutNo: string;
  amount: number;
  reason: string;
  /** 退款单的申请：退哪几项、怎么退（与开退款单的内容一样）；反结账为空 */
  items: { category: string; name: string; quantity: number; amount: number }[];
  payments: { method: string; amount: number; ref: string }[];
  requestedBy: number;
  requestedByName: string;
  requestedAt: string;
  expiresAt: string;
  /** 超过 expiresAt 还没处理的也显示成「已失效」（第一次有人去处理时记下） */
  status: CashierRequestStatus;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string;
  refundNo: string | null;
}

/** 这张申请现在算什么状态：待审批但已过了时限的算已失效 */
export function effectiveStatus(r: { status: CashierRequestStatus; expiresAt: string }, now: Date): CashierRequestStatus {
  return r.status === 'pending' && new Date(r.expiresAt).getTime() <= now.getTime() ? 'expired' : r.status;
}

// ───────────── 交接清单（CM-9） ─────────────

/** 交班页「交给下一班」：只读，不拦交班 */
export interface ShiftHandover {
  /** 本人提交、还没处理的收银申请 */
  myPendingRequests: { requestNo: string; kind: CashierRequestKind; checkoutNo: string; amount: number }[];
  /** 等本人（有权限的）处理的收银申请数 */
  toApprove: number;
  /** 本人没读的站内通知数 */
  unreadNotices: number;
  /** 此刻在店没结的手牌数 */
  openVisits: number;
}
