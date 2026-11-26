// 福田店整改批次 4（2026-11-26《福田店餐饮与房态中心整改需求文档》，docs/FUTIAN_1126.md）：
//   · FT-14 同一工位多项目：房间里已经登记的客人再加一个项目（另一位技师同时做），各自一张钟单、各自计费与业绩；
//   · FT-15 休息大厅分区：后台增删改分区，把床位（休息大厅一类的空间）归到分区里；
//   · FT-17 ②③ 零售与杂项：房间里的客人挂零售商品（香烟、扑克……）、杂项费（清洁费……），项目在后台价目里维护，分类在「房态中心规则」里设；
//     手动金额的杂项要「手动输入金额」权限；
//   · FT-18 虫洞位：下单三步（手牌、性别、虫洞号；费用按后台设的项目挂到手牌上），清洁时段里没人的虫洞是待清、外面是空闲；客人离开或结账离店就空出来。
// 加锁顺序（docs/LOCKING.md 第 1 节「房态中心」）：加项目、零售杂项 = 房态行 → 来访 → 账单 → 技师队列（postChargesTx）；
// 虫洞入住 = 房态行 → 来访 → 账单（postChargesTx）→ 虫洞使用单；虫洞离开 = 房态行 → 虫洞使用单。

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { PRICE_TIERS } from '@shared/catalog';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import { can } from '@shared/permissions';
import { isLobbyBusinessType, type HallZonesAdmin, type RoomCard } from '@shared/room-center';
import { inCleanWindow, isWormholeType, type RoomCenterRules } from '@shared/room-center-rules';
import { CALL_TYPES } from '@shared/technicians';
import type { Db } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { currentStoreId } from '../lib/store-context';
import { idParam, parse, positiveCents } from '../lib/validate';
import { PostInput, postChargesTx } from './frontdesk/bills';
import { businessDate, hashRequest, runIdempotent, saveKey } from './frontdesk/common';
import { assertRoomVersion, bumpRoomVersion, logRoomEvent } from './room-center-core';
import { loadRoomCenterRules } from './room-center-fees';
import { HOTEL_ELSEWHERE, openRooms, roomOf, runRoomOp } from './room-center-ops';

const clientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');

// ───────────────────────── FT-14 同一工位加项目 ─────────────────────────

export const AddItemInput = z.object({
  clientKey,
  visitId: z.number('请选择是哪位客人').int().positive(),
  itemId: z.number('请选择项目').int().positive('请选择项目'),
  tier: z.enum(PRICE_TIERS, '档次不正确').optional(),
  quantity: z.number().int().min(1).max(9).default(1),
  technicianId: z.number('请选择技师').int().positive('请选择技师'),
  callType: z.enum(CALL_TYPES, '上钟方式应为点钟或轮钟'),
  skipReason: z.string().trim().max(100).optional(),
  start: z.enum(['now', 'later']).default('now'),
  expectedTotal: positiveCents('本次合计'),
});

/**
 * 同一工位加项目（FT-14）：这间房里已经登记的这位客人再做一个项目——另一位技师、另一张钟单，与原来的钟同时进行，各自计费、各自算业绩。
 * 挂账、派钟与登记同一条路（postChargesTx），钟单记在这间房里；不另开登记单（这位客人的登记单还是那一张，退房时一起看）
 */
export async function addRoomItem(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(AddItemInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ op: 'room_add_item', spaceId, ...payload });
  await runIdempotent(deps, { key, opType: 'bill_post', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const today = await businessDate(tx, deps, at);
    const x = roomOf(await openRooms(tx, today, [spaceId]), spaceId);
    if (x.kind === 'hotel') throw unprocessable('ROOM_NOT_SERVICE', HOTEL_ELSEWHERE);
    const guest = x.room.guests.find((g) => Number(g.visit.id) === input.visitId && g.registration !== null);
    if (!guest) throw conflict('GUEST_NOT_IN_ROOM', `这位客人没有登记在 ${x.label}（可能刚退房或换了房），请刷新`);
    const posted = await postChargesTx(
      tx,
      deps,
      input.visitId,
      parse(PostInput, {
        clientKey: key,
        lines: [{ itemId: input.itemId, quantity: input.quantity, tier: input.tier, technicianId: input.technicianId, callType: input.callType }],
        expectedTotal: input.expectedTotal,
      }),
      { key, requestHash, backfill: null },
      ctx,
      { session: { dispatch: { startNow: input.start === 'now', skipReason: input.skipReason, spaceId } } },
    );
    const line = posted.lines[0]!;
    const [s] = await tx<{ sessionNo: string; techNo: string; techName: string }[]>`
      SELECT s.session_no, t.tech_no, t.name AS tech_name FROM bill_lines l JOIN technician_sessions s ON s.id = l.session_id JOIN technicians t ON t.id = s.technician_id
      WHERE l.id = ${line.lineId}`;
    if (!s) throw unprocessable('TECHNICIAN_REQUIRED', `「${line.name}」不是需要技师的项目：零售商品、杂项请用「零售 / 杂项」`);
    await bumpRoomVersion(tx, [spaceId], ctx.actor.id, at);
    const detail = { room: x.label, tag: guest.visit.tagCode, item: line.name, technician: `${s.techNo} 号 ${s.techName}`, amount: posted.total, sessionNo: s.sessionNo };
    await logRoomEvent(tx, { spaceId, kind: 'add_item', registrationId: Number(guest.registration!.id), detail, staffId: ctx.actor.id, at });
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'room_center_add_item', targetType: 'space', targetId: spaceId, detail, ip: ctx.ip, businessDate: today });
    return input.visitId;
  });
}

// ───────────────────────── FT-17 零售与杂项 ─────────────────────────

export const GoodsInput = z
  .object({
    clientKey,
    visitId: z.number('请选择是哪位客人').int().positive(),
    lines: z
      .array(z.object({ itemId: z.number().int().positive(), quantity: z.number('数量不对').int().min(1, '数量至少 1').max(99, '一样最多 99') }))
      .max(20)
      .default([]),
    /** 手动金额的杂项费（如清洁费按实际收）：要「手动输入金额」权限 */
    customLines: z
      .array(z.object({ name: z.string().trim().min(1, '请写杂项名称').max(32), amount: positiveCents('金额') }))
      .max(5)
      .default([]),
    expectedTotal: positiveCents('本次合计'),
  })
  .refine((v) => v.lines.length + v.customLines.length > 0, '请至少选一样');

/**
 * 零售与杂项（FT-17 ②③）：挂到这间房里一位客人的手牌账单上（与前台挂账同一条路）。只能挂后台设的几个分类里、不要技师的项目；
 * 手动金额要「手动输入金额」权限
 */
export async function postRoomGoods(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(GoodsInput, raw);
  if (input.customLines.length && !can(ctx.actor, 'consume.customAmount')) throw forbidden('当前岗位不能手动输入金额，请从项目里选');
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ op: 'room_goods', spaceId, ...payload });
  const rules = await loadRoomCenterRules(deps.sql);
  await runIdempotent(deps, { key, opType: 'bill_post', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const today = await businessDate(tx, deps, at);
    const x = roomOf(await openRooms(tx, today, [spaceId]), spaceId);
    if (x.kind === 'hotel') throw unprocessable('ROOM_NOT_SERVICE', HOTEL_ELSEWHERE);
    const guest = x.room.guests.find((g) => Number(g.visit.id) === input.visitId);
    if (!guest) throw conflict('GUEST_NOT_IN_ROOM', `这位客人不在 ${x.label}（可能刚退房或换了房），请刷新`);
    if (input.lines.length) {
      const items = await tx<{ id: number; name: string; category: string; active: boolean; technicianRequired: boolean }[]>`
        SELECT id, name, category, active, technician_required FROM service_items WHERE id IN ${tx(input.lines.map((l) => l.itemId))}`;
      const bad = input.lines.filter((l) => {
        const i = items.find((it) => Number(it.id) === l.itemId);
        return !i || !i.active || i.technicianRequired || !rules.goodsCategories.includes(i.category);
      });
      if (bad.length) throw unprocessable('GOODS_NOT_ALLOWED', `有项目不是零售商品或杂项（后台「房态中心规则」里设的分类：${rules.goodsCategories.join('、') || '还没设'}），请刷新后重选`);
    }
    const posted = await postChargesTx(
      tx,
      deps,
      input.visitId,
      parse(PostInput, { clientKey: key, lines: input.lines, customLines: input.customLines, expectedTotal: input.expectedTotal }),
      { key, requestHash, backfill: null },
      ctx,
    );
    await bumpRoomVersion(tx, [spaceId], ctx.actor.id, at);
    const detail = { room: x.label, tag: guest.visit.tagCode, items: posted.lines.map((l) => l.name), amount: posted.total };
    await logRoomEvent(tx, { spaceId, kind: 'goods', registrationId: guest.registration ? Number(guest.registration.id) : null, detail, staffId: ctx.actor.id, at });
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'room_center_goods', targetType: 'space', targetId: spaceId, detail, ip: ctx.ip, businessDate: today });
    return input.visitId;
  });
}

// ───────────────────────── FT-15 休息大厅分区 ─────────────────────────

export async function loadHallZones(db: Db): Promise<{ id: number; name: string }[]> {
  return (await db<{ id: number; name: string }[]>`SELECT id, name FROM hall_zones WHERE store_id = ${currentStoreId()} AND active ORDER BY sort_order, id`).map((z) => ({
    id: Number(z.id),
    name: z.name,
  }));
}

async function hallZonesAdmin(db: Db): Promise<HallZonesAdmin> {
  const zones = await db<{ id: number; name: string; sortOrder: number; active: boolean; beds: number }[]>`
    SELECT z.id, z.name, z.sort_order, z.active, (SELECT count(*)::int FROM spaces s WHERE s.hall_zone_id = z.id AND s.active) AS beds
    FROM hall_zones z WHERE z.store_id = ${currentStoreId()} ORDER BY z.active DESC, z.sort_order, z.id`;
  const spaces = await db<{ id: number; code: string; displayName: string; businessType: string; active: boolean; hallZoneId: number | null }[]>`
    SELECT id, code, display_name, business_type, active, hall_zone_id FROM spaces WHERE store_id = ${currentStoreId()} ORDER BY code`;
  return {
    zones: zones.map((z) => ({ ...z, id: Number(z.id) })),
    beds: spaces
      .filter((s) => isLobbyBusinessType(s.businessType))
      .map((s) => ({ spaceId: Number(s.id), code: s.code, name: s.displayName, businessType: s.businessType, active: s.active, zoneId: s.hallZoneId === null ? null : Number(s.hallZoneId) })),
  };
}

const ZoneInput = z.object({
  name: z.string('请填写分区名称').trim().min(1, '请填写分区名称').max(12, '分区名称最多 12 个字'),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  active: z.boolean().default(true),
});
const BedsInput = z.object({
  beds: z
    .array(z.object({ spaceId: z.number().int().positive(), zoneId: z.number().int().positive().nullable() }))
    .min(1)
    .max(500),
});

async function saveZone(deps: Deps, id: number | null, raw: unknown, ctx: OpContext): Promise<HallZonesAdmin> {
  const input = parse(ZoneInput, raw);
  await deps.sql.begin(async (tx) => {
    const [dup] = await tx<{ id: number }[]>`
      SELECT id FROM hall_zones WHERE store_id = ${currentStoreId()} AND active AND lower(btrim(name)) = lower(${input.name}) ${id === null ? tx`` : tx`AND id <> ${id}`}`;
    if (dup && input.active) throw conflict('ZONE_NAME_TAKEN', `已经有叫「${input.name}」的分区了`);
    if (id === null) {
      await tx`INSERT INTO hall_zones (name, sort_order, active) VALUES (${input.name}, ${input.sortOrder}, ${input.active})`;
    } else {
      const rows = await tx`
        UPDATE hall_zones SET name = ${input.name}, sort_order = ${input.sortOrder}, active = ${input.active}, updated_at = now()
        WHERE id = ${id} AND store_id = ${currentStoreId()} RETURNING id`;
      if (!rows.length) throw notFound('分区不存在，请刷新');
      // 停用的分区：床位挪出来（不在任何分区里）
      if (!input.active) await tx`UPDATE spaces SET hall_zone_id = NULL WHERE hall_zone_id = ${id}`;
    }
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'hall_zone_saved', targetType: 'hall_zone', targetId: id ?? input.name, detail: input, ip: ctx.ip });
  });
  return hallZonesAdmin(deps.sql);
}

async function saveBeds(deps: Deps, raw: unknown, ctx: OpContext): Promise<HallZonesAdmin> {
  const input = parse(BedsInput, raw);
  await deps.sql.begin(async (tx) => {
    const zoneIds = [...new Set(input.beds.flatMap((b) => (b.zoneId === null ? [] : [b.zoneId])))];
    if (zoneIds.length) {
      const zones = await tx<{ id: number }[]>`SELECT id FROM hall_zones WHERE id IN ${tx(zoneIds)} AND store_id = ${currentStoreId()} AND active`;
      if (zones.length !== zoneIds.length) throw conflict('ZONE_GONE', '有分区刚被停用，请刷新');
    }
    const ids = [...new Set(input.beds.map((b) => b.spaceId))].sort((a, b) => a - b);
    const spaces = await tx<{ id: number; businessType: string }[]>`
      SELECT id, business_type FROM spaces WHERE id IN ${tx(ids)} AND store_id = ${currentStoreId()} ORDER BY id FOR NO KEY UPDATE`;
    if (spaces.length !== ids.length || spaces.some((s) => !isLobbyBusinessType(s.businessType))) throw unprocessable('NOT_HALL_BED', '只有休息大厅一类的床位能分区');
    for (const b of input.beds) await tx`UPDATE spaces SET hall_zone_id = ${b.zoneId} WHERE id = ${b.spaceId}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'hall_zone_saved', targetType: 'hall_zone', targetId: 'beds', detail: input, ip: ctx.ip });
  });
  return hallZonesAdmin(deps.sql);
}

// ───────────────────────── FT-18 虫洞位 ─────────────────────────

export interface WormholeStayRow {
  id: number;
  spaceId: number;
  tagCode: string;
  gender: 'male' | 'female';
  feeCents: number;
  openedAt: string;
}

/** 开着的虫洞使用单（客人还在店的） */
export async function openWormholeStays(db: Db, spaceIds?: number[]): Promise<Map<number, WormholeStayRow>> {
  const rows = await db<WormholeStayRow[]>`
    SELECT w.id, w.space_id, h.code AS tag_code, w.gender, w.fee_cents, w.opened_at
    FROM wormhole_stays w JOIN visits v ON v.id = w.visit_id JOIN hand_tags h ON h.id = v.tag_id
    WHERE w.status = 'open' AND v.status = 'open' AND w.store_id = ${currentStoreId()} ${spaceIds ? db`AND w.space_id IN ${db(spaceIds)}` : db``}`;
  return new Map(rows.map((r) => [Number(r.spaceId), { ...r, id: Number(r.id), spaceId: Number(r.spaceId), feeCents: Number(r.feeCents) }]));
}

/**
 * 虫洞位的状态（FT-18）：维修 > 有人（在用）> 清洁时段里或手动标了待清（待清）> 空闲。与技师房间不同，用过不自动转待清，按清洁时段排打扫
 */
export function wormholeStatus(base: RoomCard['status'], stay: WormholeStayRow | undefined, manualDirty: boolean, rules: RoomCenterRules, at: Date, timeZone: string): RoomCard['status'] {
  if (base === 'maintenance') return 'maintenance';
  if (stay) return 'in_use';
  if (manualDirty || inCleanWindow(rules.wormhole.cleanWindows, at, timeZone)) return 'dirty';
  return base === 'booked' ? 'booked' : 'free';
}

export const WormholeInput = z.object({
  clientKey,
  tagCode: z
    .string('请填写手牌号')
    .transform((v) => normalizeTagCode(v))
    .pipe(z.string().min(1, '请填写手牌号').regex(TAG_CODE_PATTERN, '牌号格式不正确（例如 A023、1088）')),
  gender: z.enum(['male', 'female'], '请选性别'),
  /** 店员确认时看到的费用（分）：与后台现在设的不一样时拒绝 */
  expectedFee: z.number().int().min(0),
});

/** 虫洞下单（手牌、性别、虫洞号、费用）：费用按后台设的项目挂到手牌上；清洁时段里、有人、维修的不能下 */
export async function openWormhole(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(WormholeInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ op: 'wormhole_in', spaceId, ...payload });
  const rules = await loadRoomCenterRules(deps.sql);
  await runIdempotent(deps, { key, opType: 'bill_post', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const today = await businessDate(tx, deps, at);
    const x = roomOf(await openRooms(tx, today, [spaceId]), spaceId);
    if (!isWormholeType(rules, x.room.space.businessType)) throw unprocessable('NOT_WORMHOLE', `${x.label} 不是虫洞位`);
    if (!x.room.space.active || !x.room.space.sellable) throw conflict('SPACE_INACTIVE', `${x.label} 在空间台账里停用或不可售，请换一个`);
    if (x.room.state?.maintenance) throw conflict('ROOM_MAINTENANCE', `${x.label} 在维修，请换一个`);
    if ((await openWormholeStays(tx, [spaceId])).has(spaceId)) throw conflict('ROOM_IN_USE', `${x.label} 有人在用，请换一个`);
    if (x.st.dirty || inCleanWindow(rules.wormhole.cleanWindows, at, deps.config.timezone)) throw conflict('ROOM_DIRTY', `${x.label} 待清（清洁时段或标了待清），打扫好以后再用`);
    const [guest] = await tx<{ id: number; checkedInAt: string }[]>`
      SELECT v.id, v.checked_in_at FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${input.tagCode} AND v.status = 'open' AND t.store_id = ${currentStoreId()}`;
    if (!guest) throw conflict('TAG_NOT_IN_STORE', `手牌 ${input.tagCode} 没有在店客人，请核对牌号`);
    const visitId = Number(guest.id);
    const [already] = await tx<{ code: string }[]>`
      SELECT s.code FROM wormhole_stays w JOIN spaces s ON s.id = w.space_id WHERE w.visit_id = ${visitId} AND w.status = 'open'`;
    if (already) throw conflict('GUEST_REGISTERED', `手牌 ${input.tagCode} 的客人还在虫洞 ${already.code}：先点那个虫洞的「离开」`);
    let lineId: number | null = null;
    let fee = 0;
    let feeName = '';
    if (rules.wormhole.feeItemId) {
      const posted = await postChargesTx(
        tx,
        deps,
        visitId,
        parse(PostInput, { clientKey: key, lines: [{ itemId: rules.wormhole.feeItemId, quantity: 1 }], expectedTotal: Math.max(1, input.expectedFee) }),
        { key, requestHash, backfill: null },
        ctx,
      );
      lineId = posted.lines[0]!.lineId;
      fee = posted.total;
      feeName = posted.lines[0]!.name;
    } else {
      if (input.expectedFee !== 0) throw conflict('PRICE_CHANGED', '虫洞的费用刚改过（现在不收费），请刷新后重新确认');
      await saveKey(tx, key, 'bill_post', requestHash, visitId, ctx.actor.id);
    }
    await tx`
      INSERT INTO wormhole_stays (space_id, visit_id, gender, bill_line_id, fee_cents, open_key, opened_at, opened_by)
      VALUES (${spaceId}, ${visitId}, ${input.gender}, ${lineId}, ${fee}, ${key}, ${at}, ${ctx.actor.id})`;
    await bumpRoomVersion(tx, [spaceId], ctx.actor.id, at);
    const detail = { room: x.label, tag: input.tagCode, gender: input.gender, fee, ...(feeName ? { item: feeName } : {}) };
    await logRoomEvent(tx, { spaceId, kind: 'wormhole_in', detail, staffId: ctx.actor.id, at });
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'room_center_wormhole', targetType: 'space', targetId: spaceId, detail, ip: ctx.ip, businessDate: today });
    return visitId;
  });
}

export const WormholeLeaveInput = z.object({ clientKey, expectedVersion: z.number().int().min(0) });

/** 虫洞离开：结束这张使用单（费用照收），虫洞马上空出来（清洁时段里是待清） */
export async function leaveWormhole(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const { clientKey: key, ...input } = parse(WormholeLeaveInput, raw);
  await runRoomOp(deps, ctx, { key, opType: 'space_dispatch', requestHash: hashRequest({ op: 'wormhole_out', spaceId, ...input }) }, async (tx, at, today) => {
    const x = roomOf(await openRooms(tx, today, [spaceId]), spaceId);
    assertRoomVersion(x.version, input.expectedVersion, x.label);
    const [stay] = await tx<{ id: number; tagCode: string }[]>`
      SELECT w.id, h.code AS tag_code FROM wormhole_stays w JOIN visits v ON v.id = w.visit_id JOIN hand_tags h ON h.id = v.tag_id
      WHERE w.space_id = ${spaceId} AND w.status = 'open' FOR UPDATE OF w`;
    if (!stay) throw conflict('NOT_IN_USE', `${x.label} 现在没人，请刷新`);
    await tx`UPDATE wormhole_stays SET status = 'closed', closed_at = greatest(opened_at, ${at}), closed_by = ${ctx.actor.id} WHERE id = ${stay.id}`;
    await bumpRoomVersion(tx, [spaceId], ctx.actor.id, at);
    const detail = { room: x.label, tag: stay.tagCode };
    const eventId = await logRoomEvent(tx, { spaceId, kind: 'wormhole_out', detail, staffId: ctx.actor.id, at });
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'room_center_wormhole', targetType: 'space', targetId: spaceId, detail: { ...detail, leave: true }, ip: ctx.ip, businessDate: today });
    return eventId;
  });
}

// ───────────────────────── 路由 ─────────────────────────

/** 房间动作的路由（回复最新看板）在 room-center.ts；这里是后台的分区 */
export function registerHallZoneRoutes(app: FastifyInstance, deps: Deps) {
  const admin = guardAny('settings.manage', 'catalog.manage');
  const write = guard('settings.manage');
  app.get('/api/admin/hall-zones', { preHandler: admin }, async () => hallZonesAdmin(deps.sql));
  app.post('/api/admin/hall-zones', { preHandler: write }, async (req) => saveZone(deps, null, req.body, ctxOf(req)));
  app.put('/api/admin/hall-zones/beds', { preHandler: write }, async (req) => saveBeds(deps, req.body, ctxOf(req)));
  app.put('/api/admin/hall-zones/:id', { preHandler: write }, async (req) => saveZone(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
}
