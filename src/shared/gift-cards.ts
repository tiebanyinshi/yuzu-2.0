// 8.1.40 礼品卡先出卡、后绑手机号（docs/V8140.md 第 5 节）：一批礼品卡 = 一批匿名卡会员（会员号就是卡号）。前后端共用。

/** 一批最多几张 */
export const MAX_GIFT_CARD_BATCH = 200;

export interface GiftCardBatch {
  id: number;
  batchNo: string;
  label: string;
  quantity: number;
  note: string;
  createdAt: string;
  createdByName: string;
  /** 已经绑了手机号（转了实名）的张数 */
  bound: number;
  /** 这一批的卡上现在的本金余额合计（预存了多少） */
  principal: number;
}
