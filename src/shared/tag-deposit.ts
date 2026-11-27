// 手牌押金（8.2.1，docs/V8221_CASHIER.md 第 5 节）：客人外出留牌、去别的区域时收押金，一键退，结账时一起退掉抵扣。前后端共用。

/** 收押金的方式：现金、微信、支付宝、银行卡，或从会员储值扣 */
export const TAG_DEPOSIT_METHODS = ['cash', 'wechat', 'alipay', 'bank_card', 'wallet'] as const;
export type TagDepositMethod = (typeof TAG_DEPOSIT_METHODS)[number];
export const TAG_DEPOSIT_METHOD_LABELS: Record<TagDepositMethod, string> = { cash: '现金', wechat: '微信', alipay: '支付宝', bank_card: '银行卡', wallet: '会员储值' };

/** 一笔押金最多多少（分） */
export const MAX_TAG_DEPOSIT = 1_000_000;
/** 收押金的常见原因（也能手填） */
export const TAG_DEPOSIT_REASONS = ['外出留牌', '去其他区域', '借用物品'] as const;

export type TagDepositRefundKind = 'manual' | 'checkout' | 'cancel';
export const TAG_DEPOSIT_REFUND_LABELS: Record<TagDepositRefundKind, string> = { manual: '退押金', checkout: '结账时退', cancel: '撤销来访时退' };

export interface TagDeposit {
  id: number;
  depositNo: string;
  visitId: number;
  method: TagDepositMethod;
  amount: number;
  memberId: number | null;
  memberName: string | null;
  /** 储值扣的：本金、赠金各扣了多少（退的时候原样退回原卡） */
  split: { principal: number; bonus: number } | null;
  reason: string;
  ref: string;
  staffName: string;
  createdAt: string;
  status: 'held' | 'refunded';
  refundKind: TagDepositRefundKind | null;
  refundedByName: string | null;
  refundedAt: string | null;
}
