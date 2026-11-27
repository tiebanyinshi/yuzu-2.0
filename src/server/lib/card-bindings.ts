// 8.2.21（Codex 审查 PR #73）：芯片号绑定的串行锁。一张卡要么是客人的手牌、要么是技师的工牌，不能两边都绑；
// 手牌绑卡（setTagCard）、手牌导入（importHandTags）、技师绑工牌（bindTechnicianCard）都先拿这把门店级的事务锁，再查另一边、再写，
// 两个会话同时把同一张卡绑到两边时后来的那个一定看得到前一个（docs/LOCKING.md「芯片号绑定」）。
import type { Tx } from '../db';
import { currentStoreId } from './store-context';

export async function lockCardBindings(tx: Tx): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`yuzu.card_bindings:${currentStoreId()}`}, 0))`;
}
