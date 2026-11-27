// 8.2.30 收银申请（docs/V8230_CASHIER.md 第 2 节）：有待审批的申请时，同一张结账单不能直接开退款单、反结账（CM-6）。
// 单独一个文件：退款单、反结账都要用，收银申请又要调它们，放在一起会循环引用。

import type { Tx } from '../../db';
import { conflict } from '../../lib/errors';
import { CASHIER_REQUEST_KIND_LABELS, type CashierRequestKind } from '@shared/cashier-v8230';

/**
 * 结账单已锁（FOR UPDATE）以后调：这张结账单还有没处理、没过时限的申请（不是这次要执行的那张）就拒绝。
 * 过了时限的不拦（每分钟的扫描会记成失效）
 */
export async function assertNoPendingRequest(tx: Tx, c: { id: number; checkoutNo: string }, exceptId: number | undefined, at: Date) {
  const [r] = await tx<{ id: number; requestNo: string; kind: CashierRequestKind; requestedByName: string }[]>`
    SELECT r.id, r.request_no, r.kind, s.display_name AS requested_by_name
    FROM cashier_requests r JOIN staff s ON s.id = r.requested_by
    WHERE r.checkout_id = ${c.id} AND r.status = 'pending' AND r.expires_at > ${at}`;
  if (r && Number(r.id) !== exceptId) {
    throw conflict('REQUEST_PENDING', `结账单 ${c.checkoutNo} 有一张待审批的${CASHIER_REQUEST_KIND_LABELS[r.kind]}申请（${r.requestNo}，${r.requestedByName}提交），请先在「收银申请」里批准或驳回`, {
      requestNo: r.requestNo,
    });
  }
}
