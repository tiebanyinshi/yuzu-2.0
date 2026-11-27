// 收银台「锁牌外出」（8.2.7，docs/V8227_AWAY_LOCK.md）：在店客人外出时锁住他的手牌，最多 4 小时；锁之前先收预售（一张手牌押金，结账时抵扣）。前后端共用。

/** 锁牌最长几小时（店主 2026-11-27：不超过四个小时） */
export const AWAY_LOCK_MAX_HOURS = 4;
/** 页面上能选的时长（分钟）：半小时一档，最多 4 小时 */
export const AWAY_LOCK_MINUTE_OPTIONS = [30, 60, 90, 120, 150, 180, 210, 240] as const;
/** 锁牌前收的预售记成手牌押金，原因写这个（结账时照押金抵扣）。预售至少预填门店设的默认押金金额（后台「前台规则」可改） */
export const AWAY_LOCK_REASON = '锁牌外出预收';

/** 怎么解的锁：客人回来、到时间自动、结账时 */
export type AwayLockReleaseKind = 'return' | 'expired' | 'checkout';

/** 这次来访此刻锁着的牌（没锁为 null） */
export interface AwayLock {
  id: number;
  lockedAt: string;
  lockUntil: string;
  reason: string;
  lockedByName: string;
  /** 锁之前收的预售（手牌押金） */
  deposit: { id: number; depositNo: string; method: import('./tag-deposit').TagDepositMethod; amount: number };
}

/**
 * 预售默认收多少：此刻应收（明细 − 单项打折 + 门票）减去已经押着的押金，至少是门店设的默认押金金额。
 * 只是预填，收银员可以改（要大于 0）
 */
export function awayLockPrefill(o: { billCents: number; discountCents: number; ticketCents: number; heldDepositCents: number; minimumCents: number }): number {
  const due = Math.max(0, o.billCents - o.discountCents + o.ticketCents - o.heldDepositCents);
  return Math.max(o.minimumCents, due);
}
