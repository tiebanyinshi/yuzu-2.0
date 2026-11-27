import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COUPON_PLATFORMS } from '@shared/checkout';
import { ISO_DATE } from '@shared/business-date';
import { can } from '@shared/permissions';
import { guard, guardAny } from '../../auth/guard';
import { MAX_OVERTIME_HOURLY_CENTS, VOID_PERMISSIONS } from '@shared/frontdesk-v8117';
import { readSnapshot, type Tx } from '../../db';
import { BUY_CODE_PATTERN, MAX_BUY_CODES, type BuyCode } from '@shared/frontdesk';
import { MAX_TAG_DEPOSIT } from '@shared/tag-deposit';
import { PRICE_TIERS } from '@shared/catalog';
import { checkoutDaySummary } from '../settlement';
import type { Deps } from '../../lib/context';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { checkBackfillAt } from './backfill';
import { moveLines, postCharges, voidLine, type PostInputData } from './bills';
import { discountLine, revokeLineDiscount } from './line-discounts';
import { collectDeposit, refundDeposit } from './tag-deposits';
import { resolveReadableDate } from '../ledger';
import { refundShiftOptions } from '../shifts';
import { checkout, findCoupon, getCheckout, listCheckouts, previewCheckout, voidCheckout, type CheckoutInputData } from './checkout';
import { createRefund, getRefund, listRefunds, refundOptions, voidRefund, type RefundInputData } from './refunds';
import { couponByCode, couponMomentOf, couponLines, withTicketLines } from '../coupon-checkout';
import { previewTableCheckout } from '../tables';
import { listTicketTypes, saveTicketType, setVisitTicket, type TicketTypeInputData } from './tickets';
import { frontdeskChecks } from './checks';
import { businessDate, FRONTDESK_OP_PERMISSIONS, FRONTDESK_OPS, loadFrontdeskRules } from './common';
import { batchCreate, deleteHandTag, generateTags, setTagService, importHandTags, listTags, lockHandTag, setTagCard, tagByCard, unlockHandTag, updateHandTag, type ImportInputData } from './tags';
import { registerIncidentRoutes } from './incidents';
import { registerRiskRoutes } from './risk';
import { registerGuestRoutes } from './guest';
import { registerRemarkRoutes } from './remarks';
import { bindVisitMember, lookupCashierMembers, MemberLookupQuery } from './cashier-member';
import { memberLockerGrades } from './vip';
import {
  abandonFrontdeskOp,
  cancelVisit,
  changeGroup,
  checkin,
  getBoard,
  getVisit,
  lookupFrontdeskOp,
  previewBills,
  swapTag,
  withMemberMarks,
  type CheckinInputData,
  type GroupInputData,
  type SwapInputData,
} from './visits';
import { ctxOf } from '../../lib/context';
import { saveRuleSetting } from '../../lib/rule-settings';

// 会员等级的口径、门槛与名称 v0.7.23 起归「会员规则」（membership.ts）；VIP 柜的当场授权开关 8.0.4 起归「会员权益 → VIP 柜」
// （vip-lockers.ts）。旧页面带来的这几项不再保存（zod 去掉多余的字段）
const floorPct = z.number('下限是 0–100 的整数').int('下限是 0–100 的整数').min(0, '下限不能小于 0').max(100, '下限最多 100（= 不能打折）');
const RulesInput = z.object({
  selfVoidMinutes: z.number().int().min(0, '分钟数不能为负').max(120, '最多 120 分钟'),
  lostTagFeeCents: z.number().int().min(0, '赔偿金额不能为负').max(10_000_00, '赔偿金额最多 10,000 元'),
  overtimeGraceMinutes: z.number().int().min(0, '宽限分钟数不能为负').max(120, '宽限最多 120 分钟'),
  // 8.1.17（BW-1）：超时加收每超 1 小时多少（分），0 = 不算价；只用来把「加收」的金额先填好
  overtimeSurchargeHourlyCents: z
    .number('金额必须是整数（分）')
    .int('金额必须是整数（分）')
    .min(0, '金额不能为负')
    .max(MAX_OVERTIME_HOURLY_CENTS, `每小时最多 ¥${MAX_OVERTIME_HOURLY_CENTS / 100}`),
  // 8.1.44 买角：数字代号 → 价目项目与价格档（清单待业务提供，默认空）；代号不能重复，项目在保存时逐条核对
  buyCodes: z
    .array(
      z.object({
        code: z.string('请填写数字代号').regex(BUY_CODE_PATTERN, '数字代号是 1–4 位数字'),
        itemId: z.number().int().positive('请选择项目'),
        tier: z.enum(PRICE_TIERS, '价格档不正确'),
      }),
    )
    .max(MAX_BUY_CODES, `数字代号最多 ${MAX_BUY_CODES} 条`)
    .refine((list) => new Set(list.map((c) => c.code)).size === list.length, '数字代号有重复'),
  // 8.2.1 单项打折：每一档最低收原价的百分之几（0 = 能免单）；高一档的下限不能比低一档还高
  lineDiscountFloors: z
    .object({ cashier: floorPct, duty: floorPct, lead: floorPct, owner: floorPct })
    .refine((f) => f.cashier >= f.duty && f.duty >= f.lead && f.lead >= f.owner, '高一档的下限不能比低一档还高（前台收银 ≥ 值班经理 ≥ 部门负责人 ≥ 店主）'),
  // 8.2.1 手牌押金：收押金时先填好的金额（分），0 = 不预填
  tagDepositDefaultCents: z
    .number('金额必须是整数（分）')
    .int('金额必须是整数（分）')
    .min(0, '金额不能为负')
    .max(MAX_TAG_DEPOSIT, `押金最多 ¥${MAX_TAG_DEPOSIT / 100}`),
});

/** 买角的代号对到的项目要在售、有这一档价格（保存时核对；之后项目停用了，收银台敲到时照挂账的规矩拒绝） */
async function assertBuyCodeItems(tx: Tx, codes: readonly BuyCode[]) {
  if (codes.length === 0) return;
  const rows = await tx<{ itemId: number; tier: string }[]>`
    SELECT p.item_id, p.tier FROM service_item_prices p JOIN service_items i ON i.id = p.item_id
    WHERE i.active AND p.item_id IN ${tx([...new Set(codes.map((c) => c.itemId))])}`;
  const ok = new Set(rows.map((r) => `${r.itemId}:${r.tier}`));
  const bad = codes.find((c) => !ok.has(`${c.itemId}:${c.tier}`));
  if (bad) throw badRequest(`数字代号 ${bad.code} 对的项目已停用或没有这一档价格，请重新选择`);
}

export function registerFrontdeskRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  // ── 状态板与手牌账单 ──
  // 8.1.15：手牌板带会员的档阶与手上能用的券（发卡台认身份、收银台提醒），同一个只读快照里补
  app.get('/api/frontdesk/board', { preHandler: guard('frontdesk.read') }, async () =>
    readSnapshot(sql, async (tx) => withMemberMarks(tx, await getBoard(tx), await businessDate(tx, deps, new Date()))),
  );

  app.get('/api/frontdesk/visits/:id', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return readSnapshot(sql, (tx) => getVisit(tx, id, deps.config.timezone));
  });

  app.get('/api/frontdesk/preview', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { ids } = parse(
      z.object({
        ids: z
          .string('请选择手牌')
          .transform((s) => s.split(',').map(Number))
          .pipe(z.array(z.number().int().positive('手牌编号不正确')).min(1).max(30, '一次最多合并 30 张手牌')),
      }),
      req.query,
    );
    return readSnapshot(sql, (tx) => previewBills(tx, ids));
  });

  // 结果待确认时：GET 只查回；POST abandon 作废这笔（之后原请求即使到达也不会生效）。type 为页面记录的原业务类型
  const OpKey = z.object({ key: z.uuid('操作编号格式不正确') });
  app.get('/api/frontdesk/ops/:key', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { key } = parse(OpKey, req.params);
    const { type } = parse(z.object({ type: z.enum(FRONTDESK_OPS).optional() }), req.query ?? {});
    return lookupFrontdeskOp(sql, key, deps.config.timezone, type);
  });

  // 作废要有原业务本身的权限（与原接口一致），例如没有结账收款权限的人不能作废别人正在进行的结账
  app.post('/api/frontdesk/ops/:key/abandon', { preHandler: guard() }, async (req) => {
    const { key } = parse(OpKey, req.params);
    const { type } = parse(z.object({ type: z.enum(FRONTDESK_OPS, '缺少原操作的业务类型') }), req.body ?? {});
    if (!FRONTDESK_OP_PERMISSIONS[type].every((p) => can(req.actor, p))) throw forbidden('作废这笔要有原业务的权限，请由有权限的员工处理');
    return abandonFrontdeskOp(deps, key, type, ctxOf(req));
  });

  // ── 接待、换牌、同行、撤销 ──
  app.post('/api/frontdesk/checkins', { preHandler: guard('frontdesk.operate') }, async (req, reply) => {
    const result = await checkin(deps, req.body as CheckinInputData, ctxOf(req));
    reply.status(result.replayed ? 200 : 201);
    return result;
  });

  app.post('/api/frontdesk/visits/:id/swap', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return swapTag(deps, id, req.body as SwapInputData, ctxOf(req));
  });

  // 8.1.44（《前台系统开发》同行人组建与拆分结算）：收银台买单时也能把分批到的客人组成同行、或把不一起结的拆出去，有结账权限就行
  app.post('/api/frontdesk/visits/:id/group', { preHandler: guardAny('frontdesk.operate', 'frontdesk.checkout') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return changeGroup(deps, id, req.body as GroupInputData, ctxOf(req));
  });

  // 8.1.44：买单时查会员（余额、充没充过值）、把会员记到手牌上（现场建档走 POST /api/members）
  app.get('/api/frontdesk/member-lookup', { preHandler: guard('member.read') }, async (req) => lookupCashierMembers(sql, parse(MemberLookupQuery, req.query).q));
  app.post('/api/frontdesk/visits/:id/member', { preHandler: guardAny('frontdesk.operate', 'frontdesk.checkout') }, async (req) =>
    bindVisitMember(deps, parse(idParam, req.params).id, req.body, ctxOf(req)),
  );

  app.post('/api/frontdesk/visits/:id/cancel', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return cancelVisit(deps, id, req.body, ctxOf(req));
  });

  // ── 挂账与更正 ──
  app.post('/api/frontdesk/visits/:id/charges', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    // 8.1.17（BW-3）：发卡台「加项目」里进厨房的菜按出品口的下单权限核对（与点单页同一个函数）
    return postCharges(deps, id, req.body as PostInputData, ctxOf(req), { outlets: true });
  });

  // 8.1.17（BW-4）：康美部能退水吧、果吧的菜——有任一项「退菜：某出品口」的也进得来，逐行按出品口核对（dining-v8117.ts）
  app.post('/api/frontdesk/lines/:id/void', { preHandler: guardAny('frontdesk.operate', ...VOID_PERMISSIONS) }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidLine(deps, id, req.body, ctxOf(req));
  });

  // 单项打折（8.2.1，docs/V8221_CASHIER.md）：收银的人给一行打折、恢复原价；超过自己那一档的下限带当场授权
  app.post('/api/frontdesk/lines/:id/discount', { preHandler: guard('frontdesk.checkout') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return discountLine(deps, id, req.body, ctxOf(req));
  });
  app.post('/api/frontdesk/lines/:id/discount/revoke', { preHandler: guard('frontdesk.checkout') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return revokeLineDiscount(deps, id, req.body, ctxOf(req));
  });
  // 手牌押金（8.2.1）：收、一键退；两个台都能办
  app.post('/api/frontdesk/visits/:id/deposits', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return collectDeposit(deps, id, req.body, ctxOf(req));
  });
  app.post('/api/frontdesk/deposits/:id/refund', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return refundDeposit(deps, id, req.body, ctxOf(req));
  });

  // 转单（v0.7.6）：挂错手牌的明细转到另一位在店客人的手牌上（操作编号；权限与作废明细相同）
  app.post('/api/frontdesk/lines/move', { preHandler: guard('frontdesk.operate') }, async (req) => moveLines(deps, req.body, ctxOf(req)));

  // ── 票种与门票 ──
  app.get('/api/frontdesk/ticket-types', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { all } = parse(z.object({ all: z.string().optional() }), req.query ?? {});
    return listTicketTypes(sql, all === '1');
  });

  app.post('/api/frontdesk/ticket-types', { preHandler: guard('catalog.manage') }, async (req) => saveTicketType(sql, null, req.body as TicketTypeInputData, ctxOf(req)));

  app.put('/api/frontdesk/ticket-types/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return saveTicketType(sql, id, req.body as TicketTypeInputData, ctxOf(req));
  });

  app.post('/api/frontdesk/visits/:id/ticket', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await setVisitTicket(deps, id, req.body, ctxOf(req));
    return getVisit(sql, id, deps.config.timezone);
  });

  // ── 结账 ──
  const VisitIds = z.object({
    ids: z
      .string('请选择手牌')
      .transform((s) => s.split(',').map(Number))
      .pipe(z.array(z.number().int().positive('手牌编号不正确')).min(1).max(30, '一次最多合并 30 张手牌')),
  });
  // at：补录纸质单时按实际离店时间计价（需要补录权限，时间范围与补录相同）
  app.get('/api/frontdesk/checkout-preview', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { ids, at } = parse(VisitIds.extend({ at: z.iso.datetime({ offset: true, message: '实际时间格式不正确' }).optional() }), req.query);
    return previewCheckout(deps, ids, at ? checkBackfillAt(new Date(at), req.actor) : undefined);
  });

  app.post('/api/frontdesk/checkouts', { preHandler: guard('frontdesk.checkout') }, async (req) => checkout(deps, req.body as CheckoutInputData, ctxOf(req)));

  // 结账时输入券码核对（v0.7.20）：手牌结账按所选手牌（含此刻的门票），桌台结账按所选的桌；能不能用、能抵多少
  app.post('/api/frontdesk/checkout-coupon', { preHandler: guard('frontdesk.checkout') }, async (req) => {
    const input = parse(
      z.object({
        visitIds: z.array(z.number().int().positive()).max(30).default([]),
        tableSessionIds: z.array(z.number().int().positive()).max(30).default([]),
        code: z.string('请填写券码').max(40, '券码不正确'),
      }),
      req.body ?? {},
    );
    if (input.visitIds.length > 0 === input.tableSessionIds.length > 0) throw badRequest('请选择要结账的手牌或桌台');
    const at = new Date();
    let billIds: number[];
    let memberIds: number[];
    let lines;
    if (input.visitIds.length) {
      const pre = await previewCheckout(deps, input.visitIds, at);
      billIds = pre.visits.map((v) => v.billId);
      memberIds = pre.members.map((m) => m.id);
      lines = withTicketLines(
        await couponLines(sql, billIds),
        pre.visits.flatMap((v) => (v.ticket ? [{ visitId: v.visitId, typeId: v.ticket.typeId, name: v.ticket.name, amount: v.ticket.amount }] : [])),
      );
    } else {
      const pre = await previewTableCheckout(deps, input.tableSessionIds, at);
      billIds = pre.sessions.map((x) => x.billId);
      memberIds = pre.members.map((m) => m.id);
      lines = await couponLines(sql, billIds);
    }
    const date = await businessDate(sql, deps, at);
    const option = await couponByCode(sql, input.code, memberIds, lines, date, couponMomentOf(date, at, deps.config.timezone));
    return option ? { found: true, option } : { found: false };
  });

  // 结账记录可以切换营业日（过了营业日切换点仍能找到前一晚的单来反结账）；查看之前的营业日需要历史营业日权限
  app.get('/api/frontdesk/checkouts', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { date } = parse(z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional() }), req.query ?? {});
    return listCheckouts(sql, await resolveReadableDate(deps, req, date));
  });

  // 结账记录的合计（8.0.8，A02）：与日结同一个口径，另列没开班时收的结账；同一个快照里读
  app.get('/api/frontdesk/checkouts/summary', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { date } = parse(z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional() }), req.query ?? {});
    const day = await resolveReadableDate(deps, req, date);
    return readSnapshot(sql, (tx) => checkoutDaySummary(tx, day));
  });

  app.get('/api/frontdesk/checkouts/:id', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getCheckout(sql, id);
  });

  // 反结账退现金可以选的钱箱（跨钱箱退款，v0.7.1）：此刻当班的班次与建议的默认
  app.get('/api/frontdesk/checkouts/:id/refund-shifts', { preHandler: guard('frontdesk.checkoutVoid') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return refundShiftOptions(sql, id, req.actor.id);
  });

  app.post('/api/frontdesk/checkouts/:id/void', { preHandler: guard('frontdesk.checkoutVoid') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidCheckout(deps, id, req.body, ctxOf(req));
  });

  // ── 退款单（v0.7.20，离店后部分退款）──
  // 开退款单前的核对：每项、每种方式还能退多少，退现金可以选的钱箱
  app.get('/api/frontdesk/checkouts/:id/refund-options', { preHandler: guard('frontdesk.refund') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const options = await readSnapshot(sql, (tx) => refundOptions(tx, id, req.actor));
    return { ...options, drawers: await refundShiftOptions(sql, id, req.actor.id) };
  });

  app.post('/api/frontdesk/checkouts/:id/refunds', { preHandler: guard('frontdesk.refund') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const refund = await createRefund(deps, id, req.body as RefundInputData, ctxOf(req));
    reply.status(201);
    return refund;
  });

  // 某个营业日开的退款单（结账记录页），查看之前的营业日需要历史营业日权限
  app.get('/api/frontdesk/refunds', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { date } = parse(z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional() }), req.query ?? {});
    return listRefunds(sql, await resolveReadableDate(deps, req, date));
  });

  app.get('/api/frontdesk/refunds/:id', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getRefund(sql, id);
  });

  app.post('/api/frontdesk/refunds/:id/void', { preHandler: guard('frontdesk.refund') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidRefund(deps, id, req.body, ctxOf(req));
  });

  // 按完整券码核对一张团购券有没有登记过
  app.get('/api/frontdesk/coupons', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { platform, code } = parse(z.object({ platform: z.enum(COUPON_PLATFORMS), code: z.string().trim().min(1).max(80) }), req.query ?? {});
    return findCoupon(sql, platform, code);
  });

  // 会员的档阶与能用几级 VIP 柜（发牌时核对 VIP 柜）
  app.get('/api/frontdesk/members/:id/grade', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const grade = (await memberLockerGrades(sql, [id], await businessDate(sql, deps, new Date()))).get(id);
    if (!grade) throw notFound('会员不存在');
    return grade;
  });

  // ── 手牌池 ──
  app.get('/api/frontdesk/tags', { preHandler: guard('frontdesk.read') }, async () => listTags(sql));

  // 芯片号 → 牌号与现在的状态（8.1.15）：发牌时刷卡带出牌号；这张卡没绑手牌时 found 为 false
  app.get('/api/frontdesk/tags/by-card', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { uid } = parse(z.object({ uid: z.string('请刷卡或填写芯片号').max(64, '芯片号不正确') }), req.query ?? {});
    return tagByCard(sql, uid);
  });

  // 给手牌绑芯片号 / 解绑（cardUid 为 null）
  app.put('/api/frontdesk/tags/:id/card', { preHandler: guard('frontdesk.tags') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return setTagCard(deps, id, req.body, ctxOf(req));
  });

  app.post('/api/frontdesk/tags/import', { preHandler: guard('frontdesk.tags') }, async (req) => importHandTags(sql, req.body as ImportInputData, { staffId: req.actor.id, ip: req.ip, via: 'web' }));

  app.post('/api/frontdesk/tags/batch', { preHandler: guard('frontdesk.tags') }, async (req) => batchCreate(deps, req.body, ctxOf(req)));

  // 手牌管理（店主 2026-11-24）：按规则批量生成（预览 / 建）、删除、柜子标暂停使用 / 维修中
  app.post('/api/frontdesk/tags/generate', { preHandler: guard('frontdesk.tags') }, async (req) => generateTags(deps, req.body, ctxOf(req)));
  app.post('/api/frontdesk/tags/:id/delete', { preHandler: guard('frontdesk.tags') }, async (req) => deleteHandTag(deps, parse(idParam, req.params).id, ctxOf(req)));
  app.post('/api/frontdesk/tags/:id/service', { preHandler: guard('frontdesk.tags') }, async (req) => {
    await setTagService(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return { ok: true };
  });

  app.post('/api/frontdesk/tags/:id/lock', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await lockHandTag(deps, id, req.body, ctxOf(req));
    return { ok: true };
  });

  app.post('/api/frontdesk/tags/:id/unlock', { preHandler: guard('frontdesk.tags') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await unlockHandTag(deps, id, ctxOf(req));
    return { ok: true };
  });

  app.put('/api/frontdesk/tags/:id', { preHandler: guard('frontdesk.tags') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await updateHandTag(deps, id, req.body, ctxOf(req));
    return { ok: true };
  });

  // ── 规则与自检 ──
  app.get('/api/frontdesk/rules', { preHandler: guard('frontdesk.read') }, async () => loadFrontdeskRules(sql));

  // 只改提交的字段，其余沿用当前规则；合并后整体校验（v0.7.22：在锁里读当前规则再合并，两人同时改不同字段不会互相覆盖）
  app.put('/api/frontdesk/rules', { preHandler: guard('settings.manage') }, async (req) => {
    const patch = parse(RulesInput.partial(), req.body);
    await saveRuleSetting(
      sql,
      'frontdesk_rules',
      loadFrontdeskRules,
      async (before, tx) => {
        const after = parse(RulesInput, { ...before, ...patch });
        if (patch.buyCodes) await assertBuyCodeItems(tx, after.buyCodes);
        return after;
      },
      ctxOf(req),
    );
    return loadFrontdeskRules(sql);
  });

  app.get('/api/frontdesk/checks', { preHandler: guard('frontdesk.read') }, async () => readSnapshot(sql, frontdeskChecks));

  // ── 8.1.15：发牌前风控（黑名单、未结离店、重复到店、预约）与发牌后的异常处置 ──
  registerRiskRoutes(app, deps);
  registerIncidentRoutes(app, deps);
  // 8.1.44：前台备注（同组 / 单人，记经办人与时间）
  registerRemarkRoutes(app, deps);
  // 8.2.3：客人类别与偏好、全店刷手牌看的那一条、客诉台账、高风险提示、补单的出单员
  registerGuestRoutes(app, deps);
}
