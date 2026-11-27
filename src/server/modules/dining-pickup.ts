// 8.2.9 水吧取餐叫号（docs/V8229_WATER_BAR.md；走场「奶茶、咖啡等点单后显示制作中 / 可取，排队叫号……客人扫小票二维码可看排号进度」）。
//   · 有水吧饮品的点单（挂到手牌上的入口都算）发一个当天的取餐号（门店、营业日从 1 起）与一个查进度的随机编号（小票二维码里）；
//   · 进度看这一单的出品单：待做 / 制作中 = 制作中，已出餐 = 请取餐，已上菜 = 已取；
//   · 叫号屏（餐饮「取餐叫号」）列今天制作中、请取餐的号；客人扫码看自己的号、前面还有几单（不用登录，只能看这一单）。
//   · App、短信、公众号推送要另接账号，这一版没做（扫码看进度代替）。
// 加锁：发号在挂账的事务里、建完出品单以后，先取「当天取餐号」的咨询锁（同一店同一营业日串行）再取最大号 + 1。

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { diningSlotOf } from '@shared/dining';
import type { PickupBoard, PickupProgress, PickupState } from '@shared/dining-meals';
import type { Db, Tx } from '../db';
import { guardAny } from '../auth/guard';
import type { Deps } from '../lib/context';
import { notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { currentStoreId } from '../lib/store-context';
import { loadDiningOutlets } from './dining-v8139';
import { businessDate } from './frontdesk/index';

/** 这一单有水吧饮品的发一个取餐号；没有的不发。挂账的事务里、建完出品单以后调用 */
export async function issuePickup(tx: Tx, a: { orderNo: string | null; visitId: number; date: string; at: Date; itemIds: number[] }) {
  if (!a.orderNo || a.itemIds.length === 0) return;
  const slots = await loadDiningOutlets(tx);
  const items = await tx<{ category: string; diningOutlet: string | null; diningGroup: string; stationName: string | null }[]>`
    SELECT i.category, i.dining_outlet, i.dining_group, s.name AS station_name
    FROM service_items i LEFT JOIN kitchen_stations s ON s.id = i.station_id WHERE i.id IN ${tx([...new Set(a.itemIds)])}`;
  if (!items.some((i) => diningSlotOf({ outlet: i.diningOutlet, group: i.diningGroup, category: i.category, stationName: i.stationName }, slots).outlet === 'water')) return;
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`pickup:${currentStoreId()}:${a.date}`}))`;
  const [n] = await tx<{ next: number }[]>`
    SELECT coalesce(max(pickup_no), 0)::int + 1 AS next FROM pickup_tickets WHERE store_id = ${currentStoreId()} AND business_date = ${a.date}`;
  await tx`
    INSERT INTO pickup_tickets (order_no, visit_id, business_date, pickup_no, token, created_at)
    VALUES (${a.orderNo}, ${a.visitId}, ${a.date}, ${Math.min(9999, n!.next)}, ${randomUUID()}, ${a.at})`;
}

/** 一单的状态：全退了 = 已退；还有待做、制作中的 = 制作中；有已出餐的 = 请取餐；都上了 = 已取 */
const stateOf = (statuses: string[]): PickupState =>
  statuses.every((s) => s === 'cancelled') ? 'cancelled' : statuses.some((s) => s === 'queued' || s === 'cooking') ? 'making' : statuses.some((s) => s === 'done') ? 'ready' : 'served';

interface TicketRow {
  pickupNo: number;
  orderNo: string;
  token: string;
  businessDate: string;
  statuses: string[];
}

async function ticketsOf(db: Db, where: { token?: string; date?: string }): Promise<TicketRow[]> {
  return db<TicketRow[]>`
    SELECT p.pickup_no, p.order_no, p.token, p.business_date::text AS business_date,
           coalesce(array_agg(k.status ORDER BY k.id) FILTER (WHERE k.id IS NOT NULL), '{}') AS statuses
    FROM pickup_tickets p LEFT JOIN kitchen_items k ON k.order_no = p.order_no
    WHERE ${where.token ? db`p.token = ${where.token}` : db`p.store_id = ${currentStoreId()} AND p.business_date = ${where.date!}`}
    GROUP BY p.id ORDER BY p.pickup_no`;
}

/** 客人扫码看的：自己的号、这一单的饮品与状态、前面还有几单在做 */
export async function pickupProgress(db: Db, token: string): Promise<PickupProgress> {
  const [t] = await ticketsOf(db, { token });
  if (!t) throw notFound('这个取餐码不存在，请向服务员确认');
  const items = await db<{ name: string; quantity: number; status: string }[]>`
    SELECT l.name, k.quantity, k.status FROM kitchen_items k JOIN bill_lines l ON l.id = k.bill_line_id WHERE k.order_no = ${t.orderNo} ORDER BY k.id`;
  const state = stateOf(t.statuses);
  const [ahead] =
    state === 'making'
      ? await db<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pickup_tickets p
          WHERE p.store_id = (SELECT store_id FROM pickup_tickets WHERE token = ${token}) AND p.business_date = ${t.businessDate}::date AND p.pickup_no < ${t.pickupNo}
            AND EXISTS (SELECT 1 FROM kitchen_items k WHERE k.order_no = p.order_no AND k.status IN ('queued', 'cooking'))`
      : [{ n: 0 }];
  return { pickupNo: t.pickupNo, state, ahead: Number(ahead?.n ?? 0), items: items.map((i) => ({ name: i.name, quantity: Number(i.quantity), status: i.status })) };
}

/** 叫号屏：今天制作中、请取餐的号（已取、已退的不列） */
export async function pickupBoard(deps: Deps): Promise<PickupBoard> {
  const date = await businessDate(deps.sql, deps, new Date());
  const rows = await ticketsOf(deps.sql, { date });
  const making: number[] = [];
  const ready: number[] = [];
  for (const r of rows) {
    const s = stateOf(r.statuses);
    if (s === 'making') making.push(r.pickupNo);
    else if (s === 'ready') ready.push(r.pickupNo);
  }
  return { date, making, ready };
}

export function registerPickupRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/dining/pickups', { preHandler: guardAny('dining.kitchen', 'dining.order') }, async () => pickupBoard(deps));
  // 客人扫小票二维码（不登录）：只认随机编号，只给这一单的号与进度
  app.get('/api/public/pickup/:token', async (req) => {
    const { token } = parse(z.object({ token: z.uuid('取餐码不正确') }), req.params);
    return pickupProgress(deps.sql, token);
  });
}
