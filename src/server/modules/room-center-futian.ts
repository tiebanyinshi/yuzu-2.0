// 福田店整改批次 2（2026-11-26《福田店餐饮与房态中心整改需求文档》，docs/FUTIAN_1126.md）：
//   · 后台可配置的三个时限与房间计费规则（settings 的 room_center_rules，@shared/room-center-rules）；
//   · FT-06 换技师：技师上钟后限时内（默认 15 分钟）在房间详情里换一位——就是钟房的「转钟」（原明细作废、新技师挂同价明细、新钟单），
//     业绩与时间以系统记录为准；超时由后台的时限拦住；
//   · FT-09 撤房：开房后限时内（默认 15 分钟）撤掉——这次登记的钟单明细全部作废（不收费）、技师按取消派钟 / 退钟回到原位、
//     登记单记「撤房」，房间回到空闲（撤房作废的钟不算用过房间）；
//   · FT-10 / FT-17 ④ 房费：技师下钟后过了免费时长才开始按时间计费（按业态设的计费项目、起步、单位、封顶），退房时记到先登记的那位客人的手牌上；
//   · FT-19 补单：事后补录漏开的单——与前台补录纸质单同一条路（按实际时间挂账、钟单直接记为已下钟、不动排位），
//     记一张「补单」登记单关联原房间与时间（一建就结束，不占房、不让房间转待清），业绩照常计入技师。
//
// 加锁顺序（docs/LOCKING.md 第 1 节）：撤房 房态行 → 来访（id 升序）→ 账单 → 明细 → 技师队列 → 钟单 → 登记单；
// 补单 房态行 → 来访 → 账单 → 技师队列（postChargesTx）→ 之后只插入；退房收房费 房态行 → 来访 → 账单 → 登记单（结账时先来访后登记单，同一个方向）。

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { PRICE_TIERS } from '@shared/catalog';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import { can } from '@shared/permissions';
import { isRoomStatusOnly, MAX_ROOM_NOTE, MAX_SELLER_NO, type RoomGuestView } from '@shared/room-center';
import { HHMM } from '@shared/business-date';
import { MAX_CLEAN_WINDOWS, MAX_ROOM_FEE_MIN_MINUTES, MAX_RULE_MINUTES, normalizeRoomCenterRules, ROOM_CENTER_RULES_KEY, ROOM_FEE_STEP_OPTIONS, type RoomCenterRules } from '@shared/room-center-rules';
import { CALL_TYPES } from '@shared/technicians';
import type { Db } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { saveRuleSetting } from '../lib/rule-settings';
import { currentStoreId } from '../lib/store-context';
import { parse, positiveCents } from '../lib/validate';
import { lockQueue, syncSessionAfterVoid, transferSession } from './clockroom';
import { PostInput, postChargesTx } from './frontdesk/bills';
import { checkBackfillAt, recordBackfill } from './frontdesk/backfill';
import { assertOpen, businessDate, hashRequest, lockVisits, runIdempotent } from './frontdesk/common';
import { assertRoomVersion, bumpRoomVersion, loadRoomFacts, logRoomEvent, roomLabel } from './room-center-core';
import { loadRoomCenterRules } from './room-center-fees';
import { findSeller, HOTEL_ELSEWHERE, openRooms, roomOf, runRoomOp } from './room-center-ops';
import { loadPricedItems } from './pricing';
import { bindAttachments, registerAttachmentRef } from './oa/attachments';

const clientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const expectedVersion = z.number('缺少房态版本号，请刷新页面后重试').int().min(0);

// ───────────────────────── 规则 ─────────────────────────

const minutesField = (what: string) => z.number(`请填写${what}`).int(`${what}要是整数分钟`).min(0, `${what}不能小于 0`).max(MAX_RULE_MINUTES, `${what}最多 ${MAX_RULE_MINUTES} 分钟`);

export const RoomCenterRulesInput = z.object({
  swapTechMinutes: minutesField('换技师时限'),
  revokeMinutes: minutesField('撤房免费时限'),
  freeAfterClockOffMinutes: minutesField('下钟后免房费时长'),
  roomFees: z
    .array(
      z.object({
        businessType: z.string().trim().min(1, '请选择业态').max(20),
        enabled: z.boolean(),
        feeItemId: z.number().int().positive().nullable(),
        minMinutes: z.number().int().min(0).max(MAX_ROOM_FEE_MIN_MINUTES, `起步最多 ${MAX_ROOM_FEE_MIN_MINUTES} 分钟`),
        stepMinutes: z.number().refine((v) => (ROOM_FEE_STEP_OPTIONS as readonly number[]).includes(v), '计费单位只能是 15、30 或 60 分钟'),
        capCents: z.number().int().min(0, '封顶不能小于 0').max(10_000_000),
      }),
    )
    .max(30)
    .refine((list) => new Set(list.map((f) => f.businessType)).size === list.length, '同一种业态只设一条计费规则')
    .refine((list) => list.every((f) => !f.enabled || f.feeItemId !== null), '开着的计费规则要选计费项目'),
  wormhole: z.object({
    businessTypes: z.array(z.string().trim().min(1).max(20)).max(10),
    cleanWindows: z.array(z.object({ start: z.string().regex(HHMM, '时间写成 08:00'), end: z.string().regex(HHMM, '时间写成 08:30') })).max(MAX_CLEAN_WINDOWS, `清洁时段最多 ${MAX_CLEAN_WINDOWS} 段`),
    feeItemId: z.number().int().positive().nullable(),
  }),
});

async function saveRoomCenterRules(deps: Deps, raw: unknown, ctx: OpContext): Promise<RoomCenterRules> {
  const input = parse(RoomCenterRulesInput, raw);
  return saveRuleSetting(
    deps.sql,
    ROOM_CENTER_RULES_KEY,
    loadRoomCenterRules,
    async (_before, tx) => {
      // 计费项目要是在售、有价格的
      const ids = [...input.roomFees.flatMap((f) => (f.feeItemId ? [f.feeItemId] : [])), ...(input.wormhole.feeItemId ? [input.wormhole.feeItemId] : [])];
      const items = ids.length ? await loadPricedItems(tx, ids) : new Map();
      for (const id of ids) {
        const item = items.get(id);
        if (!item || !item.active) throw unprocessable('FEE_ITEM_INACTIVE', '有计费项目已停用或不存在，请重新选择');
      }
      return normalizeRoomCenterRules(input);
    },
    ctx,
  );
}

// ───────────────────────── FT-09 撤房 ─────────────────────────

export const RevokeInput = z.object({
  clientKey,
  expectedVersion,
  reason: z.string('请填写撤房原因（至少 2 个字）').trim().min(2, '请填写撤房原因（至少 2 个字）').max(100, '原因最多 100 字'),
});

/**
 * 撤房（误开的房）：开房（登记）后限时内撤掉，不收费。这间房里每位登记了的客人：这次登记的钟单明细全部作废（原因「撤房：…」，账单减回去）、
 * 钟单按取消派钟 / 退钟收尾（技师按规则回到原位），钟单记「不算用过房间」；登记单记「撤房」。房间回到空闲（不转待清）。
 * 已经有钟做完了的不能撤（请退房）；超过时限的不能撤；钟房直接派进来、没有登记单的不在这里撤（到钟房取消派钟）。
 */
export async function revokeRoom(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const { clientKey: key, ...input } = parse(RevokeInput, raw);
  const rules = await loadRoomCenterRules(deps.sql);
  await runRoomOp(deps, ctx, { key, opType: 'space_dispatch', requestHash: hashRequest({ op: 'room_revoke', spaceId, ...input }) }, async (tx, at, today) => {
    const x = roomOf(await openRooms(tx, today, [spaceId]), spaceId);
    assertRoomVersion(x.version, input.expectedVersion, x.label);
    if (x.kind === 'hotel') throw unprocessable('ROOM_NOT_SERVICE', HOTEL_ELSEWHERE);
    const guests = x.room.guests.filter((g) => g.registration !== null);
    if (guests.length === 0) {
      throw conflict('NO_REGISTRATION', x.st.inUse ? `${x.label} 的钟是钟房直接派进来的，没有登记单：请到钟房取消派钟` : `${x.label} 现在没有登记的客人，请刷新`);
    }
    if (rules.revokeMinutes <= 0) throw unprocessable('REVOKE_OFF', '后台没有开撤房（撤房时限是 0 分钟）：请退房');
    for (const g of guests) {
      const since = new Date(g.registration!.openedAt).getTime();
      if (at.getTime() - since > rules.revokeMinutes * 60_000) {
        throw unprocessable('REVOKE_TOO_LATE', `手牌 ${g.visit.tagCode} 开房已经超过 ${rules.revokeMinutes} 分钟，不能撤房（不收费）；请按正常流程下钟、退房`);
      }
      const done = g.sessions.find((s) => s.status === 'done');
      if (done) throw conflict('REVOKE_DONE', `${done.techNo} 号 ${done.techName}的钟（${done.sessionNo}）已经下钟，不能撤房；请退房`);
    }
    const sessionIds = guests.flatMap((g) => g.sessions.map((s) => Number(s.id))).sort((a, b) => a - b);
    // 来访 → 账单 → 明细 → 技师队列 → 钟单（与钟房退钟同一个顺序）
    const visits = await lockVisits(
      tx,
      guests.map((g) => Number(g.visit.id)),
    );
    for (const v of visits.values()) assertOpen(v);
    const billIds = [...visits.values()].map((v) => Number(v.billId)).sort((a, b) => a - b);
    await tx`SELECT id FROM bills WHERE id IN ${tx(billIds)} ORDER BY id FOR UPDATE`;
    const lines = sessionIds.length
      ? await tx<{ id: number; billId: number; name: string; amount: number }[]>`
          SELECT id, bill_id, name, amount FROM bill_lines WHERE session_id IN ${tx(sessionIds)} AND status = 'active' ORDER BY id FOR UPDATE`
      : [];
    const text = `撤房：${input.reason}`;
    for (const l of lines) await tx`UPDATE bill_lines SET status = 'voided', void_reason = ${text}, voided_by = ${ctx.actor.id}, voided_at = ${at} WHERE id = ${l.id}`;
    for (const billId of billIds) {
      const mine = lines.filter((l) => Number(l.billId) === billId);
      if (mine.length) await tx`UPDATE bills SET amount_cents = amount_cents - ${mine.reduce((n, l) => n + l.amount, 0)}, line_count = line_count - ${mine.length} WHERE id = ${billId}`;
    }
    await lockQueue(tx);
    for (const id of sessionIds) {
      await syncSessionAfterVoid(tx, deps, id, text, ctx.actor, at);
      await tx`UPDATE technician_sessions SET room_neutral = true WHERE id = ${id}`;
    }
    // 这次登记以后在这间房里换掉的钟（换技师 = 转钟，原钟单按退钟结束）也不算用过房间，否则撤房以后房间会转待清
    const since = guests.map((g) => new Date(g.registration!.openedAt).getTime()).reduce((a, b) => Math.min(a, b));
    await tx`
      UPDATE technician_sessions SET room_neutral = true
      WHERE space_id = ${spaceId} AND visit_id IN ${tx(guests.map((g) => Number(g.visit.id)))} AND created_at >= ${new Date(since)} AND NOT room_neutral`;
    const regIds = guests.map((g) => Number(g.registration!.id)).sort((a, b) => a - b);
    await tx`SELECT id FROM room_registrations WHERE id IN ${tx(regIds)} ORDER BY id FOR UPDATE`;
    await tx`
      UPDATE room_registrations SET status = 'closed', closed_at = greatest(opened_at, ${at}), closed_by = ${ctx.actor.id}, close_kind = 'revoked', unpaid_cents = 0
      WHERE id IN ${tx(regIds)} AND status = 'open'`;
    const partners = await tx<{ spaceId: number }[]>`
      UPDATE space_room_states SET merged_into = NULL WHERE (space_id = ${spaceId} AND merged_into IS NOT NULL) OR merged_into = ${spaceId} RETURNING space_id`;
    await bumpRoomVersion(tx, [spaceId, ...partners.map((p) => Number(p.spaceId))], ctx.actor.id, at);
    const amount = lines.reduce((n, l) => n + l.amount, 0);
    const events: number[] = [];
    for (const g of guests) {
      const detail = { room: x.label, tag: g.visit.tagCode, reason: input.reason, sessions: g.sessions.map((s) => s.sessionNo), voided: g.sessions.reduce((n, s) => n + s.amount, 0) };
      events.push(await logRoomEvent(tx, { spaceId, kind: 'revoke', registrationId: Number(g.registration!.id), detail, staffId: ctx.actor.id, at }));
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_center_revoke',
      targetType: 'space',
      targetId: spaceId,
      detail: { room: x.label, tags: guests.map((g) => g.visit.tagCode), reason: input.reason, voided: amount, lines: lines.map((l) => l.name) },
      ip: ctx.ip,
      businessDate: today,
    });
    return events[0]!;
  });
}

// ───────────────────────── FT-06 换技师 ─────────────────────────

export const SwapTechInput = z.object({
  clientKey,
  sessionId: z.number('请选择换哪一张钟').int().positive(),
  technicianId: z.number('请选择换成哪位技师').int().positive('请选择换成哪位技师'),
  callType: z.enum(CALL_TYPES, '上钟方式应为点钟或轮钟'),
  reason: z.string('请填写换技师的原因（至少 2 个字）').trim().min(2, '请填写换技师的原因（至少 2 个字）').max(80, '原因最多 80 字'),
  skipReason: z.string().trim().max(100).optional(),
});

/**
 * 换技师：这间房里一张待上钟、或上钟不到时限的钟单换给另一位技师。就是钟房的「转钟」（同一个函数、同一个操作编号类型）——
 * 原明细作废、新技师挂同项目同价格的明细、建新钟单（原来在钟上的马上上钟，计时从换的这一刻起），业绩与时间以系统记录为准。
 * 时限按后台设的（默认 15 分钟，0 为不让换）；超过的拒绝（SWAP_TOO_LATE）。
 */
export async function swapTechnician(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(SwapTechInput, raw);
  const rules = await loadRoomCenterRules(deps.sql);
  const now = ctx.at ?? new Date();
  const today = await businessDate(deps.sql, deps, now);
  const room = (await loadRoomFacts(deps.sql, today, [spaceId])).get(spaceId);
  if (!room) throw notFound('房间不存在，请刷新后重试');
  const s = room.guests.flatMap((g) => g.sessions).find((it) => Number(it.id) === input.sessionId);
  if (!s) throw conflict('SESSION_NOT_IN_ROOM', `这张钟单不在 ${roomLabel(room.space)}（可能刚换了房或已经退房），请刷新`);
  // 原样重提（结果待确认）时钟单已经转出去了：交给转钟按编号查回第一次的结果，不在这里拦
  const [replay] = await deps.sql<{ id: number }[]>`SELECT 1 AS id FROM idempotency_keys WHERE key = ${input.clientKey}`;
  if (!replay) {
    if (rules.swapTechMinutes <= 0) throw unprocessable('SWAP_OFF', '后台没有开换技师（时限是 0 分钟）：请到钟房处理');
    if (s.status === 'done') throw conflict('SESSION_CLOSED', `钟单 ${s.sessionNo} 已经下钟，不能换技师`);
    if (s.status === 'serving' && s.startedAt && now.getTime() - new Date(s.startedAt).getTime() > rules.swapTechMinutes * 60_000) {
      throw unprocessable('SWAP_TOO_LATE', `${s.techNo} 号 ${s.techName}上钟已经超过 ${rules.swapTechMinutes} 分钟，不能再换技师`);
    }
  }
  await transferSession(
    deps,
    input.sessionId,
    { clientKey: input.clientKey, technicianId: input.technicianId, callType: input.callType, reason: `换技师：${input.reason}`, ...(input.skipReason ? { skipReason: input.skipReason } : {}) },
    ctx,
  );
}

// ───────────────────────── FT-19 补单 ─────────────────────────

export const BackfillRoomInput = z
  .object({
    clientKey,
    tagCode: z
      .string('请填写手牌号')
      .transform((v) => normalizeTagCode(v))
      .pipe(z.string().min(1, '请填写手牌号').regex(TAG_CODE_PATTERN, '牌号格式不正确（例如 A023、1088）')),
    itemId: z.number('请选择项目').int().positive('请选择项目'),
    tier: z.enum(PRICE_TIERS, '档次不正确').optional(),
    quantity: z.number().int().min(1).max(9).default(1),
    technicianId: z.number('请选择技师').int().positive('请选择技师'),
    callType: z.enum(CALL_TYPES, '上钟方式应为点钟或轮钟'),
    sellerNo: z.string('请填写出单员的工号').trim().min(1, '请填写出单员的工号').max(MAX_SELLER_NO),
    /** 手工单号（选填）：纸质手工单上的编号；不填记成「补单」 */
    slipNo: z
      .string()
      .trim()
      .max(32)
      .regex(/^[0-9A-Za-z-]*$/, '手工单号只能是字母、数字或短横线')
      .default(''),
    /** 实际开始时间（必填）：补单关联原房间与时间 */
    startedAt: z.iso.datetime({ offset: true, message: '请填写实际开始时间' }),
    note: z.string().trim().max(MAX_ROOM_NOTE).default(''),
    expectedTotal: positiveCents('本次合计'),
  })
  .strict();

/**
 * 补单：事后补录漏开的单或手工单。与前台「补录纸质单」同一条路（要「按实际时间补录纸质单」权限，48 小时以内，按实际时间挂账、
 * 营业日按实际时间归属，钟单直接记为已下钟、不动技师排位），另记一张「补单」登记单关联原房间与时间（一建就结束：不占房、不让房间转待清）。
 * 客人要还在店（手牌账单没结；已经离店的请到收银台反结账后补）。业绩照常按钟单与明细计入技师。
 */
export async function backfillRoom(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(BackfillRoomInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ op: 'room_backfill', spaceId, ...payload });
  const actual = checkBackfillAt(new Date(input.startedAt), ctx.actor);
  const backfill = { slipNo: input.slipNo || '补单', at: actual };
  await runIdempotent(deps, { key, opType: 'bill_post', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const today = await businessDate(tx, deps, at);
    const x = roomOf(await openRooms(tx, today, [spaceId]), spaceId);
    if (x.kind === 'hotel') throw unprocessable('ROOM_NOT_SERVICE', HOTEL_ELSEWHERE);
    if (x.kind === 'party') throw unprocessable('ROOM_NOT_SERVICE', `${x.label} 是开单即占用的房间，补的单请到发卡台按纸质单补录`);
    const seller = await findSeller(tx, input.sellerNo);
    const [guest] = await tx<{ id: number }[]>`
      SELECT v.id FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${input.tagCode} AND v.status = 'open' AND t.store_id = ${currentStoreId()}`;
    if (!guest) throw conflict('TAG_NOT_IN_STORE', `手牌 ${input.tagCode} 没有在店客人：补单只给还在店的客人补；已经离店的请到收银台反结账后补`);
    const visitId = Number(guest.id);
    const posted = await postChargesTx(
      tx,
      deps,
      visitId,
      parse(PostInput, {
        clientKey: key,
        lines: [{ itemId: input.itemId, quantity: input.quantity, tier: input.tier, technicianId: input.technicianId, callType: input.callType }],
        expectedTotal: input.expectedTotal,
      }),
      { key, requestHash, backfill },
      ctx,
    );
    const line = posted.lines[0]!;
    const [s] = await tx<{ id: number; sessionNo: string; startedAt: string; endedAt: string }[]>`
      SELECT s.id, s.session_no, s.started_at, s.ended_at FROM bill_lines l JOIN technician_sessions s ON s.id = l.session_id WHERE l.id = ${line.lineId}`;
    if (!s) throw unprocessable('TECHNICIAN_REQUIRED', `「${line.name}」不是需要技师的项目，补单请到发卡台按纸质单补录`);
    // 钟单记在这间房里，但不算用过房间（不让房间转待清）
    await tx`UPDATE technician_sessions SET space_id = ${spaceId}, room_neutral = true WHERE id = ${s.id}`;
    const [reg] = await tx<{ id: number }[]>`
      INSERT INTO room_registrations (space_id, visit_id, session_id, seller_no, seller_name, note, opened_at, opened_by, open_key, kind,
                                      status, closed_at, closed_by, close_kind, unpaid_cents)
      VALUES (${spaceId}, ${visitId}, ${s.id}, ${seller.no}, ${seller.name}, ${input.note}, ${s.startedAt}, ${ctx.actor.id}, ${key}, 'backfill',
              'closed', ${s.endedAt}, ${ctx.actor.id}, 'backfill', 0)
      RETURNING id`;
    await recordBackfill(tx, backfill, { kind: 'charges', opKey: key, visitId, businessDate: await businessDate(tx, deps, actual), actor: ctx.actor });
    await bumpRoomVersion(tx, [spaceId], ctx.actor.id, at);
    const detail = {
      room: x.label,
      tag: input.tagCode,
      item: line.name,
      amount: posted.total,
      sessionNo: s.sessionNo,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: new Date(s.endedAt).toISOString(),
      seller: `${seller.no} ${seller.name}`,
      slipNo: backfill.slipNo,
      ...(input.note ? { note: input.note } : {}),
    };
    await logRoomEvent(tx, { spaceId, kind: 'backfill', registrationId: Number(reg!.id), detail, staffId: ctx.actor.id, at });
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'room_center_backfill', targetType: 'space', targetId: spaceId, detail, ip: ctx.ip, businessDate: today });
    return visitId;
  });
}

// ───────────────────────── FT-03 过夜的留宿确认单照片 ─────────────────────────

const OVERNIGHT_PHOTO_REF = 'room_overnight';
const MAX_OVERNIGHT_PHOTOS = 6;
/** 开房以后多久以内能补传（小时） */
const OVERNIGHT_PHOTO_HOURS = 72;

export const OvernightPhotoInput = z.object({
  registrationId: z.number('请指定是哪位客人的登记').int().positive(),
  attachmentId: z.number('请先上传照片').int().positive(),
});

// 挂上以后谁能看：能看房态中心客人的（不是只看房态的康美部账户）
registerAttachmentRef(
  OVERNIGHT_PHOTO_REF,
  async (_db, actor) => !isRoomStatusOnly(actor) && (['technician.dispatch', 'frontdesk.read', 'room.operate', 'room.housekeep'] as const).some((p) => can(actor, p)),
);

/** 这几张登记单上的留宿确认单照片 */
export async function overnightPhotos(db: Db, registrationIds: number[]): Promise<Map<number, RoomGuestView['overnightPhotos']>> {
  const out = new Map<number, RoomGuestView['overnightPhotos']>();
  if (!registrationIds.length) return out;
  const rows = await db<{ id: number; refId: number; hasThumb: boolean }[]>`
    SELECT id, ref_id, thumb IS NOT NULL AS has_thumb FROM oa_attachments WHERE ref_type = ${OVERNIGHT_PHOTO_REF} AND ref_id IN ${db(registrationIds)} ORDER BY id`;
  for (const r of rows) {
    const id = Number(r.id);
    const list = out.get(Number(r.refId)) ?? [];
    list.push({ id, url: `/api/oa/attachments/${id}`, thumbUrl: r.hasThumb ? `/api/oa/attachments/${id}/thumb` : null });
    out.set(Number(r.refId), list);
  }
  return out;
}

/**
 * 给过夜客人的登记挂一张留宿确认单照片（选填，不挡开房；开房以后 72 小时内可以补传，退了房也能补）。
 * 照片先经通用附件传上来（只能挂自己传的、还没挂过的图片）；同一张再挂一次（结果没收到重提）照样成功。锁：登记单 → 附件
 */
export async function attachOvernightPhoto(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(OvernightPhotoInput, raw);
  await deps.sql.begin(async (tx) => {
    const [reg] = await tx<{ id: number; spaceId: number; overnight: boolean; openedAt: string; tagCode: string }[]>`
      SELECT r.id, r.space_id, r.overnight, r.opened_at, h.code AS tag_code
      FROM room_registrations r JOIN visits v ON v.id = r.visit_id JOIN hand_tags h ON h.id = v.tag_id
      WHERE r.id = ${input.registrationId} AND r.store_id = ${currentStoreId()} FOR UPDATE OF r`;
    if (!reg || Number(reg.spaceId) !== spaceId) throw notFound('这间房里没有这张登记，请刷新');
    if (!reg.overnight) throw unprocessable('NOT_OVERNIGHT', `手牌 ${reg.tagCode} 登记时没选过夜，不用传留宿确认单`);
    if (Date.now() - new Date(reg.openedAt).getTime() > OVERNIGHT_PHOTO_HOURS * 3_600_000) throw unprocessable('PHOTO_TOO_LATE', `开房已经超过 ${OVERNIGHT_PHOTO_HOURS} 小时，不能再补传`);
    const [att] = await tx<{ mime: string; refType: string | null; refId: number | null; uploadedBy: number }[]>`
      SELECT mime, ref_type, ref_id, uploaded_by FROM oa_attachments WHERE id = ${input.attachmentId}`;
    if (att && att.refType === OVERNIGHT_PHOTO_REF && Number(att.refId) === reg.id && Number(att.uploadedBy) === ctx.actor.id) return;
    if (!att || !att.mime.startsWith('image/')) throw unprocessable('ATTACHMENT_INVALID', '留宿确认单要传照片');
    const [n] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM oa_attachments WHERE ref_type = ${OVERNIGHT_PHOTO_REF} AND ref_id = ${reg.id}`;
    if (n!.n >= MAX_OVERNIGHT_PHOTOS) throw unprocessable('PHOTO_LIMIT', `一位客人最多传 ${MAX_OVERNIGHT_PHOTOS} 张`);
    await bindAttachments(tx, [input.attachmentId], ctx.actor, { type: OVERNIGHT_PHOTO_REF, id: Number(reg.id) });
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_center_overnight_photo',
      targetType: 'space',
      targetId: spaceId,
      detail: { registrationId: Number(reg.id), tag: reg.tagCode, attachmentId: input.attachmentId },
      ip: ctx.ip,
    });
  });
}

// ───────────────────────── 路由 ─────────────────────────

/** 后台的房态中心规则（三个时限、房间计费、虫洞清洁时段）；房间动作的路由在 room-center.ts（回复看板） */
export function registerRoomCenterRulesRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/admin/room-center-rules', { preHandler: guardAny('settings.manage', 'catalog.manage') }, async () => loadRoomCenterRules(deps.sql));
  app.put('/api/admin/room-center-rules', { preHandler: guard('settings.manage') }, async (req) => saveRoomCenterRules(deps, req.body, ctxOf(req)));
}
