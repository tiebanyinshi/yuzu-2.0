// 8.2.0 P07（回测 3-1，docs/YUZU_REQ_V820.md 第 8 节，RT15 起）：房态中心「在用」的房间直接点水吧、果吧。
//   · 下单 = 挂到这间房现在那位客人的手牌账单上（frontdesk/bills.ts 的 postChargesTx，与点单页同一个挂账：只能点进厨房的菜、价格以服务端为准、
//     核对确认时的合计、口味备注与整单备注印在出品单上、扣沽清、出出品单），出品单的「送到哪」写「房 V08」；出品屏、自动打印照旧；
//   · 操作编号按出品口单独成类 room_order_water / room_order_fruit（Codex 安全审查 e1c3203、404eb2f：不与挂账 bill_post 共用，水吧果吧也分开，
//     只有一个出品口下单权限的人确认作废时碰不到别的挂账、另一个出品口的点单）；断网后的「结果待确认」在 /api/room-center/order-ops/:outlet/:key 查回、作废；同一编号原样重提返回第一次的那一单，不会重复挂账；
//   · 只能点这一个出品口、这个出品口配置里允许的分类（room_order_outlets），逐行按出品口核对下单权限（与点单页同一个 assertOrderOutlets）；
//   · 每一单另记 room_orders / room_order_lines（只追加）：哪间房、挂在哪位客人上、出品单号、经办人与时间；撤单就是作废那几行账单明细
//     （/api/frontdesk/lines/:id/void，「退菜：水吧 / 果吧的菜」逐行核对、留审计），这里不另做一套。
// 锁（docs/LOCKING.md「房态点单」）：操作编号 → 房间一行（客房或空间，共享键锁）→ 来访 → 账单 → 沽清 → 出品单（postChargesTx 原来的顺序）→ 最后写 room_orders；
// 房间与客人只读：来访锁住以后再核对一次这间房还是这位客人（PostOptions.toRoom），换了客人整单拒绝。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_DISH_NOTE, diningSlotOf } from '@shared/dining';
import { MAX_ORDER_NOTE } from '@shared/dining-v8115';
import {
  MAX_ROOM_ORDER_CATEGORIES,
  MAX_ROOM_ORDER_LINES,
  MAX_ROOM_ORDER_QUANTITY,
  ROOM_ORDER_HISTORY_LIMIT,
  ROOM_ORDER_OUTLET_LABELS,
  ROOM_ORDER_PERMISSIONS,
  ROOM_ORDER_OUTLETS,
  isRoomOrderOutlet,
  parseRoomKey,
  roomOrderCategoryOf,
  type RoomOrderConfig,
  type RoomOrderConfigAdmin,
  type RoomOrderHistory,
  type RoomOrderOutlet,
  type RoomOrderResult,
  type RoomOrderSummary,
  type RoomOrderView,
} from '@shared/room-orders';
import type { FrontdeskOpLookup } from '@shared/frontdesk';
import { ROOM_BUSINESS_TYPE } from '@shared/spaces';
import type { Db, Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Actor, type Deps, type OpContext } from '../lib/context';
import { can } from '@shared/permissions';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { currentStoreId } from '../lib/store-context';
import { parse } from '../lib/validate';
import { assertOrderOutlets } from './dining-order-v8115';
import { DishLineFields } from './dish-lines';
import { kitchenDishes } from './dining';
import { PostInput, postChargesTx } from './frontdesk/bills';
import { businessDate, hashRequest, runIdempotent } from './frontdesk/common';
import { currentGuestOfSpace } from './room-state';

type RoomRef = { spaceId: number } | { roomId: number };

const OrderBody = z.object({
  clientKey: z.uuid('操作编号格式不正确'),
  outlet: z.enum(ROOM_ORDER_OUTLETS, '请选水吧或果吧'),
  lines: z
    .array(
      z.object({
        itemId: z.number().int().positive(),
        quantity: z.number('份数不对').int('份数要是整数').min(1, '份数至少 1').max(MAX_ROOM_ORDER_QUANTITY, `一样最多点 ${MAX_ROOM_ORDER_QUANTITY} 份`),
        note: z.string().trim().max(MAX_DISH_NOTE, `备注最多 ${MAX_DISH_NOTE} 字`).optional(),
        /** 选的做法（冰量、甜度……；必选组要选上），与点单页同一个校验与计价（Codex 审查 90a09c7） */
        methods: DishLineFields.methods,
      }),
    )
    .min(1, '请至少点一样')
    .max(MAX_ROOM_ORDER_LINES, `一次最多点 ${MAX_ROOM_ORDER_LINES} 样`),
  orderNote: z.string().trim().max(MAX_ORDER_NOTE, `整单备注最多 ${MAX_ORDER_NOTE} 字`).optional(),
  /** 店员确认时看到的合计：与服务端按现在的价格算的不一致时拒绝（价格刚改过） */
  expectedTotal: z.number().int().min(0),
});

const ConfigBody = z.object({
  outlets: z.object(
    Object.fromEntries(
      ROOM_ORDER_OUTLETS.map((o) => [
        o,
        z.object({
          categories: z.array(z.string().trim().min(1).max(32)).max(MAX_ROOM_ORDER_CATEGORIES).nullable(),
        }),
      ]),
    ) as Record<RoomOrderOutlet, z.ZodObject<{ categories: z.ZodNullable<z.ZodArray<z.ZodString>> }>>,
  ),
});

// ───────────────────────── 房间与客人 ─────────────────────────

/** 路由上的房间（s12 / r3）：本店的空间或客房；客房业态的空间按客房的房间点（卡片也是按房间出的） */
async function resolveRoom(db: Db, key: string): Promise<{ ref: RoomRef; code: string }> {
  const ref = parseRoomKey(key);
  if (!ref) throw notFound('房间不存在，请刷新后重试');
  if ('spaceId' in ref) {
    const [sp] = await db<{ code: string; businessType: string }[]>`
      SELECT code, business_type FROM spaces WHERE id = ${ref.spaceId} AND store_id = ${currentStoreId()}`;
    if (!sp || sp.businessType === ROOM_BUSINESS_TYPE) throw notFound('房间不存在，请刷新后重试');
    return { ref, code: sp.code };
  }
  const [room] = await db<{ roomNo: string }[]>`SELECT room_no FROM rooms WHERE id = ${ref.roomId} AND store_id = ${currentStoreId()}`;
  if (!room) throw notFound('房间不存在，请刷新后重试');
  return { ref, code: room.roomNo };
}

/** 这间房现在的客人（点单挂在他的手牌上）：空间按 currentGuestOfSpace（先登记的、最早的钟、开着的使用单）；客房取在住的那一张入住单；没人为 null */
async function guestOf(db: Db, ref: RoomRef): Promise<{ visitId: number; tagCode: string } | null> {
  if ('spaceId' in ref) {
    const [st] = await db<{ maintenance: boolean }[]>`SELECT maintenance FROM space_room_states WHERE space_id = ${ref.spaceId}`;
    if (st?.maintenance) return null;
    const g = await currentGuestOfSpace(db, ref.spaceId);
    return g ? { visitId: g.visitId, tagCode: g.tagNo } : null;
  }
  const [stay] = await db<{ visitId: number; tagCode: string }[]>`
    SELECT s.visit_id, h.code AS tag_code FROM room_stays s JOIN visits v ON v.id = s.visit_id JOIN hand_tags h ON h.id = v.tag_id
    WHERE s.room_id = ${ref.roomId} AND s.status = 'open' AND v.status = 'open' ORDER BY s.id LIMIT 1`;
  return stay ? { visitId: Number(stay.visitId), tagCode: stay.tagCode } : null;
}

/** 这间房里现在的几位客人（卡片上的单数与金额只算他们的）：空间是登记、钟、使用单上的全部在店来访；客房是在住的入住单 */
async function currentVisitIds(db: Db, ref: RoomRef): Promise<number[]> {
  const rows =
    'spaceId' in ref
      ? await db<{ visitId: number }[]>`
          SELECT g.visit_id FROM (
            SELECT visit_id FROM room_registrations WHERE space_id = ${ref.spaceId} AND status = 'open'
            UNION SELECT visit_id FROM technician_sessions WHERE space_id = ${ref.spaceId} AND status IN ('waiting', 'serving')
            UNION SELECT visit_id FROM space_usages WHERE space_id = ${ref.spaceId} AND status = 'open'
          ) g JOIN visits v ON v.id = g.visit_id WHERE v.status = 'open'`
      : await db<{ visitId: number }[]>`
          SELECT s.visit_id FROM room_stays s JOIN visits v ON v.id = s.visit_id WHERE s.room_id = ${ref.roomId} AND s.status = 'open' AND v.status = 'open'`;
  return [...new Set(rows.map((r) => Number(r.visitId)))];
}

// ───────────────────────── 配置 ─────────────────────────

export async function roomOrderConfig(db: Db): Promise<RoomOrderConfig> {
  const rows = await db<{ outlet: string; categories: string[] | null; updatedAt: string; updatedBy: string | null }[]>`
    SELECT o.outlet, o.categories, o.updated_at, s.display_name AS updated_by
    FROM room_order_outlets o LEFT JOIN staff s ON s.id = o.updated_by WHERE o.store_id = ${currentStoreId()} ORDER BY o.updated_at DESC`;
  const outlets = Object.fromEntries(ROOM_ORDER_OUTLETS.map((o) => [o, { categories: rows.find((r) => r.outlet === o)?.categories ?? null }])) as RoomOrderConfig['outlets'];
  return { outlets, updatedAt: rows[0]?.updatedAt ?? null, updatedBy: rows[0]?.updatedBy ?? null };
}

async function roomOrderConfigAdmin(db: Db, deps: Deps): Promise<RoomOrderConfigAdmin> {
  const today = await businessDate(db as Tx, deps, new Date());
  const dishes = await kitchenDishes(db, today);
  const available = Object.fromEntries(
    ROOM_ORDER_OUTLETS.map((o) => [o, [...new Set(dishes.filter((d) => d.outlet === o).map(roomOrderCategoryOf))].sort((a, b) => a.localeCompare(b, 'zh-CN'))]),
  ) as RoomOrderConfigAdmin['available'];
  return { ...(await roomOrderConfig(db)), available };
}

async function saveRoomOrderConfig(deps: Deps, raw: unknown, ctx: OpContext): Promise<RoomOrderConfigAdmin> {
  const body = parse(ConfigBody, raw);
  await deps.sql.begin(async (tx) => {
    // 按出品口的固定顺序（水吧、果吧）写，两个人同时保存时按同一顺序排队
    for (const outlet of ROOM_ORDER_OUTLETS) {
      const list = body.outlets[outlet].categories;
      const categories = list === null ? null : [...new Set(list)];
      await tx`
        INSERT INTO room_order_outlets (outlet, categories, updated_by, updated_at) VALUES (${outlet}, ${categories}, ${ctx.actor.id}, now())
        ON CONFLICT (store_id, outlet) DO UPDATE SET categories = EXCLUDED.categories, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'settings_updated',
      targetType: 'room_order_outlets',
      targetId: 'room_order_outlets',
      detail: { key: 'room_order_outlets', outlets: body.outlets },
      ip: ctx.ip,
    });
  });
  return roomOrderConfigAdmin(deps.sql, deps);
}

// ───────────────────────── 下单 ─────────────────────────

/** 逐行核对：都在这一个出品口、都在配置允许的分类里、都进厨房（不在这里的整单拒绝，写明哪几样） */
async function assertRoomOrderItems(db: Db, outlet: RoomOrderOutlet, itemIds: number[]) {
  const ids = [...new Set(itemIds)];
  const rows = await db<{ id: number; name: string; category: string; diningOutlet: string | null; diningGroup: string; stationName: string | null }[]>`
    SELECT i.id, i.name, i.category, i.dining_outlet, i.dining_group, s.name AS station_name
    FROM service_items i LEFT JOIN kitchen_stations s ON s.id = i.station_id WHERE i.id IN ${db(ids)}`;
  if (rows.length !== ids.length) throw unprocessable('ITEM_NOT_FOUND', '有菜已经停用或删除，请刷新后重新点');
  const { outlets } = await roomOrderConfig(db);
  const allowed = outlets[outlet].categories;
  const wrong: string[] = [];
  const blocked: string[] = [];
  for (const r of rows) {
    if (r.stationName === null) {
      wrong.push(r.name);
      continue;
    }
    const slot = diningSlotOf({ outlet: r.diningOutlet, group: r.diningGroup, category: r.category, stationName: r.stationName });
    if (slot.outlet !== outlet) wrong.push(r.name);
    else if (allowed !== null && !allowed.includes(roomOrderCategoryOf({ group: slot.group, category: r.category }))) blocked.push(r.name);
  }
  if (wrong.length) {
    throw unprocessable('ROOM_ORDER_OUTLET', `${wrong.map((n) => `「${n}」`).join('')}不是${ROOM_ORDER_OUTLET_LABELS[outlet]}的，请在对应的页签里点`);
  }
  if (blocked.length) {
    throw new AppError(403, 'ROOM_ORDER_CATEGORY', `${blocked.map((n) => `「${n}」`).join('')}不在房态点单能点的分类里（店长在「后台 → 房态点单」设置），请删掉或到点单页点`, { items: blocked });
  }
}

/** 这个出品口的房态点单记成哪一类操作编号 */
const opTypeOf = (outlet: RoomOrderOutlet) => (outlet === 'water' ? 'room_order_water' : 'room_order_fruit') as 'room_order_water' | 'room_order_fruit';

export async function placeRoomOrder(deps: Deps, roomKey: string, raw: unknown, ctx: OpContext): Promise<RoomOrderResult> {
  const { ref, code } = await resolveRoom(deps.sql, roomKey);
  const body = parse(OrderBody, raw);
  const { clientKey: key, ...payload } = body;
  // 摘要只算提交上来的（哪间房、出品口、点了什么、备注、合计），不算查出来的客人：生效了但回复丢了以后客人换了，原样重提照样认得出是同一笔
  const requestHash = hashRequest({ roomOrder: roomKey, ...payload });
  const input = parse(PostInput, {
    clientKey: key,
    lines: body.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, ...(l.note ? { note: l.note } : {}), ...(l.methods ? { methods: l.methods } : {}) })),
    customLines: [],
    expectedTotal: body.expectedTotal,
    ...(body.orderNote ? { orderNote: body.orderNote } : {}),
  });
  const r = await runIdempotent(deps, { key, opType: opTypeOf(body.outlet), requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    // 先锁房间一行（共享键锁，room_orders 的外键要的就是它），再进挂账去锁来访：与客房退房（入住单 → 客房 → 来访）、
    // 钟房换房间（空间一行 → …）同一个先后，不会出现我拿着来访等房间、对方拿着房间等来访（Codex 审查 90a09c7）
    if ('roomId' in ref) await tx`SELECT id FROM rooms WHERE id = ${ref.roomId} FOR KEY SHARE`;
    else await tx`SELECT id FROM spaces WHERE id = ${ref.spaceId} FOR KEY SHARE`;
    const guest = await guestOf(tx, ref);
    if (!guest) throw conflict('ROOM_NOT_IN_USE', `${code} 现在不是在用（没有客人、已退房或在维修），不能点单，请刷新`);
    await assertRoomOrderItems(
      tx,
      body.outlet,
      body.lines.map((l) => l.itemId),
    );
    await assertOrderOutlets(
      tx,
      ctx.actor,
      body.lines.map((l) => l.itemId),
    );
    const posted = await postChargesTx(
      tx,
      deps,
      guest.visitId,
      input,
      { key, requestHash, backfill: null, opType: opTypeOf(body.outlet) },
      { ...ctx, at },
      {
        dining: { onlyKitchen: true },
        // 来访锁住以后再核对一次：这间房还是这位客人
        toRoom: async (t) => {
          const again = await guestOf(t, ref);
          if (!again || again.visitId !== guest.visitId) throw conflict('ROOM_GUEST_CHANGED', `${code} 刚刚换了客人或退了房，请刷新后重新点`);
          return `房 ${code}`;
        },
      },
    );
    const [order] = await tx<{ id: number }[]>`
      INSERT INTO room_orders (op_key, space_id, room_id, room_code, visit_id, outlet, order_no, note, total_cents, staff_id, created_at)
      VALUES (${key}, ${'spaceId' in ref ? ref.spaceId : null}, ${'roomId' in ref ? ref.roomId : null}, ${code}, ${guest.visitId}, ${body.outlet},
              ${posted.orderNo}, ${body.orderNote ?? ''}, ${posted.total}, ${ctx.actor.id}, ${at})
      RETURNING id`;
    await tx`INSERT INTO room_order_lines (room_order_id, bill_line_id) SELECT ${order!.id}, unnest(${posted.lines.map((l) => l.lineId)}::bigint[])`;
    return guest.visitId;
  });
  const [order] = await loadOrders(deps.sql, { opKey: key });
  // 同一编号已经用在别的挂账上（不是从房态点的）：findKey 按摘要已拦下；这里兜底
  if (!order) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的业务，请刷新页面后重新发起');
  return { order, replayed: r.replayed };
}

// ───────────────────────── 查看 ─────────────────────────

type OrderFilter = { opKey: string } | { ref: RoomRef; limit: number };

async function loadOrders(db: Db, f: OrderFilter): Promise<RoomOrderView[]> {
  const where =
    'opKey' in f
      ? db`o.op_key = ${f.opKey}`
      : 'spaceId' in f.ref
        ? db`o.space_id = ${f.ref.spaceId} AND o.store_id = ${currentStoreId()}`
        : db`o.room_id = ${f.ref.roomId} AND o.store_id = ${currentStoreId()}`;
  const limit = 'opKey' in f ? 1 : f.limit;
  const orders = await db<
    {
      id: number;
      roomCode: string;
      outlet: string;
      orderNo: string | null;
      tagCode: string;
      visitOpen: boolean;
      note: string;
      totalCents: number;
      staffUsername: string;
      staffName: string;
      createdAt: string;
    }[]
  >`
    SELECT o.id, o.room_code, o.outlet, o.order_no, h.code AS tag_code, v.status = 'open' AS visit_open, o.note, o.total_cents,
           s.username AS staff_username, s.display_name AS staff_name, o.created_at
    FROM room_orders o JOIN visits v ON v.id = o.visit_id JOIN hand_tags h ON h.id = v.tag_id JOIN staff s ON s.id = o.staff_id
    WHERE ${where} ORDER BY o.id DESC LIMIT ${limit}`;
  if (orders.length === 0) return [];
  const lines = await db<
    {
      orderId: number;
      lineId: number;
      name: string;
      quantity: number;
      unitPrice: number;
      amount: number;
      note: string | null;
      status: string;
      voidReason: string | null;
      voidedByName: string | null;
      voidedAt: string | null;
    }[]
  >`
    SELECT ol.room_order_id AS order_id, l.id AS line_id, l.name, l.quantity, l.unit_price, l.amount, k.note, l.status, l.void_reason,
           vs.display_name AS voided_by_name, l.voided_at
    FROM room_order_lines ol JOIN bill_lines l ON l.id = ol.bill_line_id
    LEFT JOIN kitchen_items k ON k.bill_line_id = l.id
    LEFT JOIN staff vs ON vs.id = l.voided_by
    WHERE ol.room_order_id IN ${db(orders.map((o) => o.id))} ORDER BY l.id`;
  return orders.map((o) => {
    const mine = lines.filter((l) => Number(l.orderId) === Number(o.id));
    return {
      id: Number(o.id),
      roomCode: o.roomCode,
      outlet: isRoomOrderOutlet(o.outlet) ? o.outlet : 'water',
      orderNo: o.orderNo,
      tagCode: o.tagCode,
      visitOpen: o.visitOpen,
      note: o.note,
      postedTotal: o.totalCents,
      total: mine.filter((l) => l.status !== 'voided').reduce((n, l) => n + l.amount, 0),
      staffUsername: o.staffUsername,
      staffName: o.staffName,
      createdAt: o.createdAt,
      lines: mine.map((l) => ({
        lineId: Number(l.lineId),
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
        note: l.note ?? '',
        status: l.status === 'voided' ? 'voided' : 'posted',
        voidReason: l.voidReason,
        voidedByName: l.voidedByName,
        voidedAt: l.voidedAt,
      })),
    };
  });
}

/** 一间房的点单记录：最近的在前；current 是现在房里的客人点的（卡片上那两个数） */
export async function roomOrderHistory(db: Db, roomKey: string): Promise<RoomOrderHistory> {
  const { ref, code } = await resolveRoom(db, roomKey);
  const orders = await loadOrders(db, { ref, limit: ROOM_ORDER_HISTORY_LIMIT + 1 });
  const visits = await currentVisitIds(db, ref);
  const sums = await roomOrderSums(db, visits);
  const current: RoomOrderSummary = { count: 0, amount: 0 };
  for (const s of sums.values()) {
    current.count += s.count;
    current.amount += s.amount;
  }
  return { roomKey, roomCode: code, current, orders: orders.slice(0, ROOM_ORDER_HISTORY_LIMIT), limit: ROOM_ORDER_HISTORY_LIMIT, truncated: orders.length > ROOM_ORDER_HISTORY_LIMIT };
}

/**
 * 几位在店客人从房态点的单：按来访合计（还有没退的行的单数、没退的金额）。房态中心看板给每间房的卡片按房里现在的客人加起来。
 * 只算还在店的来访；退光了的单不算一单
 */
export async function roomOrderSums(db: Db, visitIds: number[]): Promise<Map<number, RoomOrderSummary>> {
  const ids = [...new Set(visitIds)];
  if (ids.length === 0) return new Map();
  const rows = await db<{ visitId: number; count: number; amount: number }[]>`
    SELECT o.visit_id, count(DISTINCT o.id) FILTER (WHERE l.status <> 'voided')::int AS count,
           coalesce(sum(l.amount) FILTER (WHERE l.status <> 'voided'), 0)::int AS amount
    FROM room_orders o JOIN room_order_lines ol ON ol.room_order_id = o.id JOIN bill_lines l ON l.id = ol.bill_line_id
    WHERE o.visit_id IN ${db(ids)} AND o.store_id = ${currentStoreId()}
    GROUP BY o.visit_id`;
  return new Map(rows.map((r) => [Number(r.visitId), { count: r.count, amount: r.amount }]));
}

// ───────────────────────── 路由 ─────────────────────────

export function registerRoomOrderRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 点：有水吧或果吧的下单权限（逐行再按出品口核对）；看记录：能点的、能看房态的
  const order = guardAny('dining.orderWater', 'dining.orderFruit');
  const read = guardAny('dining.orderWater', 'dining.orderFruit', 'room.operate', 'technician.dispatch', 'frontdesk.checkout');
  const roomKey = (req: { params: unknown }) => parse(z.object({ id: z.string().max(24) }), req.params).id;

  app.get('/api/room-center/order-config', { preHandler: order }, async () => roomOrderConfig(sql));

  // 「结果待确认」的查回与确认作废：按出品口——只认这个出品口的房态点单编号，要这个出品口的下单权限（Codex 安全审查 404eb2f）；
  // 别的业务、另一个出品口的编号只答「没查到」、不作废；查回只说生效没生效、记在哪次来访上
  const OpParams = z.object({ outlet: z.enum(ROOM_ORDER_OUTLETS, '出品口不对'), key: z.uuid('操作编号格式不正确') });
  const opParams = (req: { params: unknown; actor: Actor }) => {
    const p = parse(OpParams, req.params);
    if (!can(req.actor, ROOM_ORDER_PERMISSIONS[p.outlet])) throw forbidden(`你的岗位不能在${ROOM_ORDER_OUTLET_LABELS[p.outlet]}下单，也不能处理它的待确认点单`);
    return p;
  };
  const opResult = (r: FrontdeskOpLookup): FrontdeskOpLookup => (r.found && r.type !== 'room_order' ? { found: false, abandoned: false } : r);
  app.get('/api/room-center/order-ops/:outlet/:key', { preHandler: order }, async (req) => {
    const { outlet, key } = opParams(req);
    const { lookupFrontdeskOp } = await import('./frontdesk/visits');
    return opResult(await lookupOutletOp(lookupFrontdeskOp, key, outlet));
  });
  app.post('/api/room-center/order-ops/:outlet/:key/abandon', { preHandler: order }, async (req) => {
    const { outlet, key } = opParams(req);
    const { lookupFrontdeskOp, abandonFrontdeskOp } = await import('./frontdesk/visits');
    // 编号已经有结果（不管是哪一类）：不作废；只有这个出品口的房态点单才答「生效了」，别的一律「没查到」
    const peek = await lookupOutletOp(lookupFrontdeskOp, key, outlet);
    if (peek.found) return opResult(peek);
    const done = (await abandonFrontdeskOp(deps, key, opTypeOf(outlet), ctxOf(req))) as FrontdeskOpLookup;
    // 作废时发现编号刚刚（或早已）有了结果：同样按实际的业务类型核对出品口，不是这个出品口的不说生效没生效（Codex 审查 0995112）
    if (done.found) return lookupOutletOp(lookupFrontdeskOp, key, outlet);
    return done;
  });
  /** 查回：编号属于另一个出品口的房态点单也答「没查到」 */
  async function lookupOutletOp(lookup: typeof import('./frontdesk/visits').lookupFrontdeskOp, key: string, outlet: RoomOrderOutlet): Promise<FrontdeskOpLookup> {
    const [row] = await sql<{ opType: string }[]>`SELECT op_type FROM idempotency_keys WHERE key = ${key}`;
    if (row && row.opType !== opTypeOf(outlet))
      return row.opType.startsWith('room_order_') ? { found: false, abandoned: false } : opResult((await lookup(sql, key, deps.config.timezone, opTypeOf(outlet))) as FrontdeskOpLookup);
    return (await lookup(sql, key, deps.config.timezone, opTypeOf(outlet))) as FrontdeskOpLookup;
  }
  app.get('/api/room-center/rooms/:id/orders', { preHandler: read }, async (req) => roomOrderHistory(sql, roomKey(req)));
  app.post('/api/room-center/rooms/:id/orders', { preHandler: order }, async (req) => placeRoomOrder(deps, roomKey(req), req.body, ctxOf(req)));

  app.get('/api/admin/room-order-config', { preHandler: guardAny('settings.manage', 'catalog.manage') }, async () => roomOrderConfigAdmin(sql, deps));
  app.put('/api/admin/room-order-config', { preHandler: guard('settings.manage') }, async (req) => saveRoomOrderConfig(deps, req.body, ctxOf(req)));
}
