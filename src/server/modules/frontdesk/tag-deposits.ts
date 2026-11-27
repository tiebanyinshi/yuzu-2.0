// 手牌押金（8.2.1，docs/V8221_CASHIER.md 第 5 节；会议纪要「收银系统功能评审」二.2）：客人外出留牌、去别的区域时收押金。
//
//   · 收：现金、微信、支付宝、银行卡，或从这位客人自己的会员储值扣（记一张储值消费单「手牌押金 YJ…」）；
//   · 退：一键退（中途回来要退），现金类按原方式退，储值扣的按原单撤销、本金赠金原样退回原卡；
//   · 结账：这几张手牌上押着的押金在结账的事务里一起退掉（结账核对列出押金，页面按现金类押金先填好同样方式的收款，就是「抵扣」）；
//     撤销来访前要先退押金；
//   · 钱怎么记（照客房押金 room_deposits 的做法）：押金是负债，不算营业额；收、退都记经办人当班的班次（现金计入交班应有现金），
//     日结列「押金」一块；
//   · 都带操作编号（tag_deposit / tag_deposit_refund，先查编号、最后写编号前核对「确认作废」）、记审计；结果待确认照前台的做法。
// 加锁顺序（docs/LOCKING.md 第 1 节）：经办人的班次（共享锁）→ 来访（FOR UPDATE）→ 押金一行（退时 FOR UPDATE）→ 会员一行（储值扣、退）；
// 结账在会员（会员折扣里 id 升序已锁）之后、记收款之前按 id 升序锁这几张手牌押着的押金。两边都先锁来访，互相排队。

import { z } from 'zod';
import { formatYuan } from '@shared/money';
import { can } from '@shared/permissions';
import { MAX_TAG_DEPOSIT, TAG_DEPOSIT_METHODS, type TagDeposit, type TagDepositRefundKind } from '@shared/tag-deposit';
import type { Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { currentStoreId } from '../../lib/store-context';
import { nextDocNo } from '../../lib/tx';
import { cents, parse } from '../../lib/validate';
import { lockPaymentShift, openShiftOf } from '../shifts';
import { consumeForDeposit, reverseForCheckout } from '../wallet';
import { assertOpen, businessDate, hashRequest, lockVisits, runIdempotent, saveKey } from './common';
import { getVisit } from './visits';
import { assertDepositNotLocking } from './away-lock';

export const CollectDepositInput = z
  .object({
    clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
    amount: cents('押金')
      .positive('押金必须大于 0')
      .max(MAX_TAG_DEPOSIT, `押金最多 ${formatYuan(MAX_TAG_DEPOSIT)}`),
    method: z.enum(TAG_DEPOSIT_METHODS, '请选择押金的收款方式'),
    reason: z.string('请写为什么收押金').trim().min(2, '请写为什么收押金（至少 2 个字）').max(64, '原因最多 64 字'),
    ref: z.string().trim().max(64, '收款备注最多 64 字').default(''),
    /** 储值扣：员工确认时看到的本金 / 赠金扣款构成 */
    expectedSplit: z.object({ principal: cents('扣本金'), bonus: cents('扣赠金') }).optional(),
  })
  .refine((v) => v.method !== 'wallet' || v.expectedSplit !== undefined, '缺少确认时的扣款构成，请重新核对');

export const RefundDepositInput = z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') });

interface DepositRow {
  id: number;
  depositNo: string;
  visitId: number;
  method: TagDeposit['method'];
  amount: number;
  memberId: number | null;
  consumptionId: number | null;
  status: 'held' | 'refunded';
}

/** 收押金 */
export async function collectDeposit(deps: Deps, visitId: number, raw: unknown, ctx: OpContext) {
  const input = parse(CollectDepositInput, raw);
  if (input.method === 'wallet' && !can(ctx.actor, 'consume.create')) throw forbidden('当前岗位不能用会员储值收押金');
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ visitId, ...payload });
  const seenShift = await openShiftOf(deps.sql, ctx.actor.id);
  await runIdempotent(deps, { key, opType: 'tag_deposit', requestHash }, async (tx) => {
    const shiftId = await lockPaymentShift(tx, ctx.actor.id, seenShift);
    const at = ctx.at ?? new Date();
    const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
    assertOpen(visit);
    const id = await insertDeposit(tx, deps, { visit, input, key, shiftId, at, ctx });
    await saveKey(tx, key, 'tag_deposit', requestHash, id, ctx.actor.id);
    return id;
  });
  return getVisit(deps.sql, visitId, deps.config.timezone);
}

/**
 * 在调用方的事务里收一笔押金（来访已锁、经办人的班次已加共享锁）：编号、储值扣、写押金、审计。返回押金编号。
 * 收押金本身与锁牌外出（8.2.7，锁之前先收预售）都用它；操作编号由调用方写
 */
export async function insertDeposit(
  tx: Tx,
  deps: Deps,
  a: { visit: { id: number; visitNo: string; tagId: number; memberId: number | null }; input: z.output<typeof CollectDepositInput>; key: string; shiftId: number | null; at: Date; ctx: OpContext },
): Promise<number> {
  const { visit, input, key, shiftId, at, ctx } = a;
  const date = await businessDate(tx, deps, at);
  const depositNo = await nextDocNo(tx, 'tag_deposit', 'YJ', date);
  const [tag] = await tx<{ code: string }[]>`SELECT code FROM hand_tags WHERE id = ${visit.tagId}`;
  let wallet: { memberId: number; consumptionId: number; split: { principal: number; bonus: number } } | null = null;
  if (input.method === 'wallet') {
    // 只能扣这张手牌上的会员自己的储值（不扣别人的卡，与结账用储值同一条）
    if (!visit.memberId) throw unprocessable('NO_MEMBER', '这张手牌上没有会员，不能从储值扣押金；请先在收银台记上会员，或改用现金、微信、支付宝、银行卡');
    const r = await consumeForDeposit(tx, deps, { memberId: visit.memberId, amount: input.amount, expectedSplit: input.expectedSplit!, depositNo, tagCode: tag!.code, businessDate: date, ctx, at });
    wallet = { memberId: visit.memberId, consumptionId: r.consumptionId, split: r.split };
  }
  const [row] = await tx<{ id: number }[]>`
      INSERT INTO tag_deposits (deposit_no, visit_id, method, amount, member_id, consumption_id, reason, ref, client_key, shift_id, business_date, staff_id, created_at)
      VALUES (${depositNo}, ${visit.id}, ${input.method}, ${input.amount}, ${wallet?.memberId ?? null}, ${wallet?.consumptionId ?? null}, ${input.reason}, ${input.ref},
              ${key}, ${shiftId}, ${date}, ${ctx.actor.id}, ${at})
      RETURNING id`;
  await writeAudit(tx, {
    staffId: ctx.actor.id,
    action: 'tag_deposit_received',
    targetType: 'visit',
    targetId: visit.id,
    detail: {
      depositNo,
      visitNo: visit.visitNo,
      tagCode: tag!.code,
      method: input.method,
      amount: input.amount,
      reason: input.reason,
      ...(wallet ? { memberId: wallet.memberId, split: wallet.split } : {}),
    },
    ip: ctx.ip,
    businessDate: date,
  });
  return row!.id;
}

/** 一键退押金 */
export async function refundDeposit(deps: Deps, depositId: number, raw: unknown, ctx: OpContext) {
  const { clientKey: key } = parse(RefundDepositInput, raw);
  const [peek] = await deps.sql<{ visitId: number }[]>`SELECT visit_id FROM tag_deposits WHERE id = ${depositId} AND store_id = ${currentStoreId()}`;
  if (!peek) throw notFound('押金记录不存在');
  const requestHash = hashRequest({ depositId });
  const seenShift = await openShiftOf(deps.sql, ctx.actor.id);
  await runIdempotent(deps, { key, opType: 'tag_deposit_refund', requestHash }, async (tx) => {
    const shiftId = await lockPaymentShift(tx, ctx.actor.id, seenShift);
    const at = ctx.at ?? new Date();
    const visit = (await lockVisits(tx, [peek.visitId])).get(peek.visitId)!;
    assertOpen(visit);
    const [d] = await tx<DepositRow[]>`
      SELECT id, deposit_no, visit_id, method, amount, member_id, consumption_id, status FROM tag_deposits WHERE id = ${depositId} FOR UPDATE`;
    if (d!.status !== 'held') throw conflict('DEPOSIT_REFUNDED', `押金 ${d!.depositNo} 已经退过了，不会重复退`);
    // 锁牌外出的预售（8.2.7）：牌还锁着不能单独退
    await assertDepositNotLocking(tx, d!.id, d!.depositNo);
    const date = await businessDate(tx, deps, at);
    await refundOne(tx, deps, d!, { kind: 'manual', shiftId, checkoutId: null, date, at, ctx, visitNo: visit.visitNo });
    await saveKey(tx, key, 'tag_deposit_refund', requestHash, d!.id, ctx.actor.id);
    return d!.id;
  });
  return getVisit(deps.sql, peek.visitId, deps.config.timezone);
}

async function refundOne(
  tx: Tx,
  deps: Deps,
  d: DepositRow,
  o: { kind: TagDepositRefundKind; shiftId: number | null; checkoutId: number | null; date: string; at: Date; ctx: OpContext; visitNo: string },
) {
  let reversalId: number | null = null;
  if (d.method === 'wallet') {
    const r = await reverseForCheckout(tx, deps, {
      consumptionId: d.consumptionId!,
      reason: `退手牌押金 ${d.depositNo}`,
      businessDate: o.date,
      ctx: o.ctx,
      at: o.at,
      mergedText: '这位会员已经并到别的会员名下，储值扣的押金退不回原卡；请联系店主处理',
    });
    reversalId = r.reversalId;
  }
  await tx`
    UPDATE tag_deposits SET status = 'refunded', refund_kind = ${o.kind}, refund_shift_id = ${o.shiftId}, refund_business_date = ${o.date},
                            refunded_by = ${o.ctx.actor.id}, refunded_at = ${o.at}, refund_reversal_id = ${reversalId}, checkout_id = ${o.checkoutId}
    WHERE id = ${d.id}`;
  await writeAudit(tx, {
    staffId: o.ctx.actor.id,
    action: 'tag_deposit_refunded',
    targetType: 'visit',
    targetId: d.visitId,
    detail: { depositNo: d.depositNo, visitNo: o.visitNo, method: d.method, amount: Number(d.amount), kind: o.kind, ...(o.checkoutId ? { checkoutId: o.checkoutId } : {}) },
    ip: o.ctx.ip,
    businessDate: o.date,
  });
}

/**
 * 结账时把这几位客人押着的押金一起退掉（在结账的事务里：来访、账单、会员都已锁住，记收款之前调用；押金按 id 升序锁）。
 * 储值扣的先退回原卡，之后的储值支付按退回以后的余额扣（与结账核对给的余额一致）。返回退了哪几笔
 */
export async function settleDepositsAtCheckout(tx: Tx, deps: Deps, o: { visitIds: number[]; checkoutId: number; shiftId: number | null; date: string; at: Date; ctx: OpContext }) {
  const rows = await tx<(DepositRow & { visitNo: string })[]>`
    SELECT d.id, d.deposit_no, d.visit_id, d.method, d.amount, d.member_id, d.consumption_id, d.status, v.visit_no
    FROM tag_deposits d JOIN visits v ON v.id = d.visit_id
    WHERE d.visit_id IN ${tx(o.visitIds)} AND d.status = 'held' ORDER BY d.id FOR UPDATE OF d`;
  for (const d of rows) await refundOne(tx, deps, d, { kind: 'checkout', shiftId: o.shiftId, checkoutId: o.checkoutId, date: o.date, at: o.at, ctx: o.ctx, visitNo: d.visitNo });
  return rows.map((d) => ({ depositNo: d.depositNo, method: d.method, amount: Number(d.amount) }));
}
