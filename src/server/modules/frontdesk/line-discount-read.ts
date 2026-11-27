// 单项打折的只读部分（8.2.1，docs/V8221_CASHIER.md 第 1 节）：账单详情、结账核对、结账、券与会员折扣挑明细都从这里读，不加锁。
// 单独一个文件：账单详情（visits.ts）要用，打折的写入（line-discounts.ts）又要用账单详情，放在一起会互相引用。

import type { LineDiscountInfo } from '@shared/line-discount';
import type { Db } from '../../db';

/**
 * 这几张账单上有效的单项折扣（有效的明细上、没撤下的）：每张账单折掉多少、每一行的折扣。只读；结账、预览在来访、账单的锁里调用。
 * 与部门营业额快照（迁移 530 的 yuzu_snapshot_checkout_items）同一口径
 */
export async function lineDiscountsOf(db: Db, billIds: number[]): Promise<{ byBill: Map<number, number>; lineIds: Set<number>; total: number }> {
  if (billIds.length === 0) return { byBill: new Map(), lineIds: new Set(), total: 0 };
  const rows = await db<{ billId: number; lineId: number; amount: number }[]>`
    SELECT d.bill_id, d.line_id, (d.list_amount - d.final_amount)::bigint AS amount
    FROM bill_line_discounts d JOIN bill_lines l ON l.id = d.line_id
    WHERE d.bill_id IN ${db(billIds)} AND d.status = 'active' AND l.status = 'active'`;
  const byBill = new Map<number, number>();
  for (const r of rows) byBill.set(Number(r.billId), (byBill.get(Number(r.billId)) ?? 0) + Number(r.amount));
  return { byBill, lineIds: new Set(rows.map((r) => Number(r.lineId))), total: rows.reduce((s, r) => s + Number(r.amount), 0) };
}

/** 账单详情里每一行的折扣（有效的那一条），按明细编号 */
export async function lineDiscountInfoOf(db: Db, billId: number): Promise<Map<number, LineDiscountInfo>> {
  const rows = await db<(LineDiscountInfo & { lineId: number })[]>`
    SELECT d.id, d.line_id, d.list_amount, d.final_amount, d.rate, d.reason, s.display_name AS by_name, sp.emp_no AS by_emp_no,
           a.display_name AS approved_by_name, d.created_at AS at
    FROM bill_line_discounts d JOIN staff s ON s.id = d.staff_id LEFT JOIN staff_profiles sp ON sp.staff_id = d.staff_id
    LEFT JOIN staff a ON a.id = d.approved_by
    WHERE d.bill_id = ${billId} AND d.status = 'active'`;
  return new Map(rows.map(({ lineId, ...d }) => [Number(lineId), { ...d, listAmount: Number(d.listAmount), finalAmount: Number(d.finalAmount), rate: d.rate === null ? null : Number(d.rate) }]));
}
