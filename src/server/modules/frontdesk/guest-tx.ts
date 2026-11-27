// 8.2.3 前台（docs/V8223_FRONTDESK.md）：发牌、挂账的事务里顺带做的几样（visits.ts 的 checkin、bills.ts 的 postChargesTx 调）。
// 单放一个文件：guest.ts 要读来访详情（引用 visits.ts），visits.ts 又要这里的字段定义，放在一起会互相引用。

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BOOKED_TECH_TAG, MAX_BOOKED_TECH, type GuestRules } from '@shared/frontdesk-v8223';
import type { Tx } from '../../db';
import { unprocessable } from '../../lib/errors';

/** 发牌请求里每位客人多带的两项：类别、预约的技师（不带时与升级前的请求完全相同，摘要不变） */
export const GuestCheckinFields = {
  category: z.string().trim().max(8, '类别最多 8 个字').optional(),
  bookedTechnician: z.string().trim().max(MAX_BOOKED_TECH, `预约技师最多 ${MAX_BOOKED_TECH} 个字`).optional(),
};

/** 发牌时选的类别要在清单里；没选的记空（= 默认类别） */
export function checkinCategory(raw: string | undefined, rules: GuestRules): string {
  if (!raw) return '';
  if (!rules.categories.includes(raw)) throw unprocessable('GUEST_CATEGORY', `没有「${raw}」这个客人类别，请刷新后重新选`);
  return raw === rules.categories[0] ? '' : raw;
}

/** 发牌时写的预约技师：记成一条带「预约技师」标签的单人备注（与发牌同一个事务；编号由发牌的编号与第几位客人算出来） */
export async function recordBookedTechnician(tx: Tx, a: { visitId: number; note: string; opKey: string; staffId: number; at: Date }) {
  await tx`
    INSERT INTO visit_remarks (visit_id, scope, group_id, tag, note, op_key, created_by, created_at)
    VALUES (${a.visitId}, 'single', NULL, ${BOOKED_TECH_TAG}, ${`${BOOKED_TECH_TAG}：${a.note}`.slice(0, 200)}, ${a.opKey}, ${a.staffId}, ${a.at})`;
}

/** 补单记下出单员（挂账的事务里，来访已锁）：出单员要是在职的员工 */
export async function recordSupplement(tx: Tx, a: { opKey: string; visitId: number; issuerId: number; at: Date; staffId: number }) {
  const [issuer] = await tx<{ id: number }[]>`SELECT id FROM staff WHERE id = ${a.issuerId} AND active AND NOT system`;
  if (!issuer) throw unprocessable('SUPPLEMENT_ISSUER', '出单员不在职或不存在，请重新选');
  await tx`
    INSERT INTO bill_supplements (op_key, visit_id, issuer_id, actual_at, created_by)
    VALUES (${a.opKey}, ${a.visitId}, ${a.issuerId}, ${a.at}, ${a.staffId})`;
}

/** 由一个操作编号与一个序号算出另一个固定的操作编号（发牌时第几位客人的「预约技师」备注用：重提发牌不会多记一条） */
export function derivedKey(base: string, salt: string): string {
  const h = createHash('sha256').update(`${base}:${salt}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
