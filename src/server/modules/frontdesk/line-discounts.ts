// 单项打折（8.2.1，docs/V8221_CASHIER.md 第 1 节；会议纪要「收银系统功能评审」四.2）：收银台账单的每一行旁边点「折」，
// 按折扣（8 折）或直接填折后价给这一行打折。
//
//   · 明细本身不改（金额照旧是原价、只追加的规矩不变），折扣记在 bill_line_discounts；结账时这几张账单上有效的折扣合计记一笔
//     「单项折扣」（不是收款，与会员折扣同一口径），部门营业额快照按行记到那一行的部门与项目；
//   · 每一档的下限在后台「手牌与前台」设（默认前台收银九折、值班经理七折、部门负责人五折、店主能免单）；超过自己那一档的要当场授权，
//     授权人那一档要够打到这个价；
//   · 打过折的行不再用券、次卡、会员折扣（不打折上折）；转单、反结账照旧：转走的行不带折扣（要先恢复原价再转），
//     反结账后账单恢复在店，折扣还在那一行上；
//   · 改折扣 = 撤下原来的、记一条新的（同一个事务）；恢复原价 = 撤下。都带操作编号、记审计。
// 加锁顺序（docs/LOCKING.md 第 1 节）：来访 → 账单 → 这一行明细 → 这一行有效的折扣 → 授权凭据（最后加锁并核销）；
// 结账在来访、账单的锁里只读这几张账单的折扣，不另加锁（打折、撤下都要先锁来访，与结账排队）。

import { z } from 'zod';
import { floorLabel, lineDiscountTierOf, LINE_DISCOUNT_TIER_LABELS, rateLabel, discountedAmount, withinFloor } from '@shared/line-discount';
import { formatYuan } from '@shared/money';
import type { Db, Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { derivedKey } from '../../lib/derived-key';
import type { AutoDiscountRule } from '@shared/dining-meals';
import { consumeLineDiscountGrant } from '../../auth/grants';
import { assertOpen, businessDate, hashRequest, loadFrontdeskRules, lockVisits, runIdempotent, saveKey } from './common';
import { getVisit } from './visits';

export const LineDiscountInput = z
  .object({
    clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
    /** 按折扣：收原价的百分之几（80 = 八折，0 = 免单） */
    rate: z.number('折扣不正确').int('折扣是 0–99 的整数（80 = 八折）').min(0, '折扣不能小于 0').max(99, '折扣最多 99（= 九九折）').optional(),
    /** 按折后价：这一行收多少（分） */
    finalAmount: z.number('折后价不正确').int('折后价要以分为单位的整数').min(0, '折后价不能为负').optional(),
    reason: z.string().trim().max(64, '原因最多 64 字').default(''),
    /** 超过自己那一档的下限时：当场授权的编号 */
    grantId: z.uuid('授权编号不正确').optional(),
  })
  .refine((v) => (v.rate === undefined) !== (v.finalAmount === undefined), '请填折扣或折后价（二选一）');

export const RevokeLineDiscountInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  reason: z.string('请填写恢复原价的原因').trim().min(2, '请填写恢复原价的原因（至少 2 个字）').max(64, '原因最多 64 字'),
});

interface LockedLine {
  id: number;
  billId: number;
  name: string;
  quantity: number;
  amount: number;
  status: string;
  ticketTypeId: number | null;
}

interface LockedDiscount {
  id: number;
  finalAmount: number;
  rate: number | null;
}

/** 来访 → 账单 → 明细 → 这一行有效的折扣（都在一个事务里）；返回锁住的来访、明细与折扣 */
async function lockLine(tx: Tx, visitId: number, lineId: number) {
  const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
  assertOpen(visit);
  const [bill] = await tx<{ status: string }[]>`SELECT status FROM bills WHERE id = ${visit.billId} FOR UPDATE`;
  if (bill!.status !== 'open') throw conflict('BILL_CLOSED', '账单已结束，不能再打折');
  const [line] = await tx<LockedLine[]>`
    SELECT id, bill_id, name, quantity, amount, status, ticket_type_id FROM bill_lines WHERE id = ${lineId} FOR UPDATE`;
  if (!line || line.billId !== visit.billId) throw notFound('这一行明细不在这位客人的账单上，请刷新后重试');
  if (line.status !== 'active') throw conflict('ALREADY_VOIDED', `「${line.name}」已作废，不能打折`);
  const [current] = await tx<LockedDiscount[]>`
    SELECT id, final_amount, rate FROM bill_line_discounts WHERE line_id = ${lineId} AND status = 'active' FOR UPDATE`;
  return { visit, line, current: current ?? null };
}

async function peekVisit(db: Db, lineId: number): Promise<number> {
  const [peek] = await db<{ visitId: number }[]>`SELECT v.id AS visit_id FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE l.id = ${lineId}`;
  if (!peek) throw notFound('账单明细不存在');
  return peek.visitId;
}

/** 给一行打折（或改成另一个折扣） */
export async function discountLine(deps: Deps, lineId: number, raw: unknown, ctx: OpContext) {
  const input = parse(LineDiscountInput, raw);
  const visitId = await peekVisit(deps.sql, lineId);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ lineId, ...payload });
  await runIdempotent(deps, { key, opType: 'line_discount', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const { visit, line, current } = await lockLine(tx, visitId, lineId);
    if (line.ticketTypeId !== null) throw unprocessable('LINE_NOT_DISCOUNTABLE', '门票按在店时长计价，不能单项打折；要降价请改票种');
    const listAmount = Number(line.amount);
    const finalAmount = input.rate !== undefined ? discountedAmount(listAmount, input.rate) : input.finalAmount!;
    if (finalAmount >= listAmount) throw badRequest(`折后价要比原价 ${formatYuan(listAmount)} 低`);
    if (current && Number(current.finalAmount) === finalAmount) throw conflict('SAME_DISCOUNT', `「${line.name}」已经是这个价（${formatYuan(finalAmount)}）了`);
    const rules = await loadFrontdeskRules(tx);
    const tier = lineDiscountTierOf(ctx.actor);
    const floor = rules.lineDiscountFloors[tier];
    let approval: { approverId: number; approverName: string } | null = null;
    if (!withinFloor(listAmount, finalAmount, floor)) {
      if (!input.grantId) {
        throw unprocessable('LINE_DISCOUNT_AUTH_REQUIRED', `你是${LINE_DISCOUNT_TIER_LABELS[tier]}，单项打折${floorLabel(floor)}；打到 ${formatYuan(finalAmount)} 要请值班经理、店总或店主当场授权`, {
          floor,
          listAmount,
          finalAmount,
        });
      }
      approval = await consumeLineDiscountGrant(tx, { grantId: input.grantId, actor: ctx.actor, lineId, listAmount, finalAmount, usedRef: `line_discount:${key}` });
    }
    const date = await businessDate(tx, deps, at);
    if (current) {
      await tx`
        UPDATE bill_line_discounts SET status = 'revoked', revoked_by = ${ctx.actor.id}, revoked_at = ${at}, revoke_reason = '改成别的折扣'
        WHERE id = ${current.id}`;
    }
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO bill_line_discounts (line_id, bill_id, list_amount, final_amount, rate, reason, tier, floor_pct, staff_id, approved_by, grant_id,
                                       client_key, business_date, created_at)
      VALUES (${lineId}, ${line.billId}, ${listAmount}, ${finalAmount}, ${input.rate ?? null}, ${input.reason}, ${tier}, ${floor}, ${ctx.actor.id},
              ${approval?.approverId ?? null}, ${approval ? input.grantId! : null}, ${key}, ${date}, ${at})
      RETURNING id`;
    await saveKey(tx, key, 'line_discount', requestHash, visit.id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_line_discount',
      targetType: 'visit',
      targetId: visit.id,
      detail: {
        visitNo: visit.visitNo,
        lineId,
        discountId: row!.id,
        name: line.name,
        listAmount,
        finalAmount,
        discount: listAmount - finalAmount,
        rate: input.rate ?? null,
        rateText: input.rate !== undefined ? rateLabel(input.rate) : null,
        reason: input.reason,
        tier,
        floor,
        ...(current ? { replaced: { id: current.id, finalAmount: Number(current.finalAmount) } } : {}),
        ...(approval ? { approverId: approval.approverId, approverName: approval.approverName } : {}),
      },
      ip: ctx.ip,
      businessDate: date,
    });
    return visit.id;
  });
  return getVisit(deps.sql, visitId, deps.config.timezone);
}

/** 恢复原价：撤下这一行的折扣 */
export async function revokeLineDiscount(deps: Deps, lineId: number, raw: unknown, ctx: OpContext) {
  const input = parse(RevokeLineDiscountInput, raw);
  const visitId = await peekVisit(deps.sql, lineId);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ lineId, revoke: true, ...payload });
  await runIdempotent(deps, { key, opType: 'line_discount', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const { visit, line, current } = await lockLine(tx, visitId, lineId);
    if (!current) throw conflict('NO_DISCOUNT', `「${line.name}」没有打折，不用恢复`);
    await tx`
      UPDATE bill_line_discounts SET status = 'revoked', revoked_by = ${ctx.actor.id}, revoked_at = ${at}, revoke_reason = ${input.reason}
      WHERE id = ${current.id}`;
    const date = await businessDate(tx, deps, at);
    await saveKey(tx, key, 'line_discount', requestHash, visit.id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_line_discount_revoke',
      targetType: 'visit',
      targetId: visit.id,
      detail: { visitNo: visit.visitNo, lineId, discountId: current.id, name: line.name, finalAmount: Number(current.finalAmount), reason: input.reason },
      ip: ctx.ip,
      businessDate: date,
    });
    return visit.id;
  });
  return getVisit(deps.sql, visitId, deps.config.timezone);
}

/**
 * 系统按规则打的自动折扣（8.2.7：含餐、自助；8.2.8：首杯赠）：在挂账的同一个事务里、写完这一行明细以后调用，这一行折成 0。
 * 档 auto、没有授权人，经办人记下这一笔的人；编号由这一笔的操作编号与明细算出（原样重提时不会走到这里）
 */
export async function insertAutoDiscount(
  tx: Tx,
  a: { lineId: number; billId: number; amount: number; rule: AutoDiscountRule; reason: string; staffId: number; opKey: string; date: string; at: Date },
): Promise<void> {
  if (a.amount <= 0) return;
  await tx`
    INSERT INTO bill_line_discounts (line_id, bill_id, list_amount, final_amount, rate, reason, tier, floor_pct, staff_id, approved_by, grant_id,
                                     client_key, business_date, created_at, rule)
    VALUES (${a.lineId}, ${a.billId}, ${a.amount}, 0, 0, ${a.reason}, 'auto', 0, ${a.staffId}, NULL, NULL,
            ${derivedKey(`auto-discount:${a.opKey}:${a.lineId}`)}, ${a.date}, ${a.at}, ${a.rule})`;
}
