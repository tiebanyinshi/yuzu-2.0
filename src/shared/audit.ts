// 操作审计的筛选（8.1.36，对照领浴问题表「操作日志」「订单敏感操作明细表」）：
// 「敏感操作」一组动作——动钱、动余额、撤销、授权、改身份的，店主、财务按天查、导出对账。

/** 敏感操作：手工扣款（会员消费，含手动金额）、撤销会员消费、退储值、反结账、结账退款、作废明细、当场授权、改会员手机号、解绑微信、合并会员、作废券、次卡退卡、平台核销作废、钟房换房间 */
export const SENSITIVE_AUDIT_ACTIONS = [
  'consumption_created',
  'consumption_reversed',
  'member_refund',
  'frontdesk_checkout_void',
  'checkout_refund',
  'checkout_refund_void',
  'frontdesk_void',
  'table_void',
  'auth_granted',
  'auth_failed',
  'member_phone_changed',
  'mp_unbind',
  'member_merged',
  'member_status_changed',
  'coupon_voided',
  'count_card_refund',
  'platform_redemption_void',
  'room_center_state',
  'clock_session_room',
  'usage_cancel',
  'room_cancel',
] as const;

/** 一次最多看、导出多少条 */
export const AUDIT_PAGE_MAX = 2000;
export const AUDIT_EXPORT_MAX = 10_000;
