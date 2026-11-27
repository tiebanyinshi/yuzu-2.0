// 手牌押金的只读部分（8.2.1，docs/V8221_CASHIER.md 第 5 节）：账单详情、结账核对从这里读，不加锁。
// 单独一个文件：账单详情（visits.ts）要用，押金的写入（tag-deposits.ts）又要用账单详情，放在一起会互相引用。

import type { TagDeposit } from '@shared/tag-deposit';
import type { Db } from '../../db';

/** 这几次来访的押金（含已退的；按时间先后），储值扣的带本金、赠金构成。只读 */
export async function depositsOf(db: Db, visitIds: number[], onlyHeld = false): Promise<TagDeposit[]> {
  if (visitIds.length === 0) return [];
  const rows = await db<(Omit<TagDeposit, 'split'> & { principal: number | null; bonus: number | null })[]>`
    SELECT d.id, d.deposit_no, d.visit_id, d.method, d.amount, d.member_id, m.name AS member_name, c.principal_amount AS principal, c.bonus_amount AS bonus,
           d.reason, d.ref, s.display_name AS staff_name, d.created_at, d.status, d.refund_kind, r.display_name AS refunded_by_name, d.refunded_at
    FROM tag_deposits d JOIN staff s ON s.id = d.staff_id LEFT JOIN staff r ON r.id = d.refunded_by
    LEFT JOIN members m ON m.id = d.member_id LEFT JOIN consumptions c ON c.id = d.consumption_id
    WHERE d.visit_id IN ${db(visitIds)} ${onlyHeld ? db`AND d.status = 'held'` : db``} ORDER BY d.id`;
  return rows.map(({ principal, bonus, ...d }) => ({
    ...d,
    amount: Number(d.amount),
    split: principal === null ? null : { principal: Number(principal), bonus: Number(bonus) },
  }));
}
