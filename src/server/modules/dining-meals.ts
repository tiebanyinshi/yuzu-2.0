// 8.2.7 餐厅入口、含餐抵扣、裸票时段价、餐台点菜折零（docs/V8227_DINING_MEALS.md；店主 2026-11-27《新店系统需求现场走场确认》）。
//
//   · 入口刷手牌登记进餐：按此刻的餐段在这张手牌上记一行餐费（「午餐自助」，记在餐饮）；含餐还有余额的这一行同一笔里自动折成 0（「含餐」），
//     裸票照价收；同一位客人同一营业日同一餐段只登记一次（那一行作废了的可以重新登记）；
//   · 餐台点菜折零：登记了此刻这一餐的客人在点单页点的餐厅出品口的菜，同一笔里自动折成 0（「自助」）；水吧、果吧、桌台（餐包）照价收；
//   · 自动折扣记在单项打折那张表（档 auto），结账时照单项打折一起记「单项折扣」。
// 加锁顺序：入口登记走挂账（postChargesTx：来访 → 账单 → …），先锁来访再核对这一餐有没有登记过；折零在挂账的同一个事务里、写完明细以后记。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { minuteOfDay } from '@shared/business-date';
import { diningSlotOf } from '@shared/dining';
import { MEAL_PERIOD_LABELS, mealAllowance, mealPeriodAt, mealPeriodRange, type MealEntryPreview, type MealEntryRow, type MealPeriod } from '@shared/dining-meals';
import type { Db, Tx } from '../db';
import { guard } from '../auth/guard';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { currentStoreId } from '../lib/store-context';
import { loadDiningOutlets } from './dining-v8139';
import { loadDiningRules } from './dining';
import { findGuestByTag } from './dining-order-v8115';
import { businessDate, hashRequest, insertAutoDiscount, loadBills, lockVisits, runIdempotent, visitTicket } from './frontdesk/index';

const EntryInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  tagCode: z.string('请刷手牌或输入牌号').trim().min(1, '请刷手牌或输入牌号').max(16, '牌号太长'),
});

/** 此刻的餐段（不在供餐时间为 null） */
async function periodNow(db: Db, deps: Deps, at: Date): Promise<MealPeriod | null> {
  const rules = await loadDiningRules(db);
  return mealPeriodAt(rules.mealPeriods, minuteOfDay(at, deps.config.timezone));
}

/** 这次来访这个营业日这一餐有没有登记（那一行没作废的），以及这次来访用了几餐含餐 */
async function entryState(db: Db, visitId: number, date: string, period: string | null) {
  const [r] = await db<{ entered: boolean; used: number }[]>`
    SELECT EXISTS (SELECT 1 FROM meal_entries e JOIN bill_lines l ON l.id = e.line_id
                   WHERE e.visit_id = ${visitId} AND e.business_date = ${date} AND e.period = ${period ?? ''} AND l.status = 'active') AS entered,
           (SELECT count(*)::int FROM meal_entries e JOIN bill_lines l ON l.id = e.line_id
            WHERE e.visit_id = ${visitId} AND e.kind = 'included' AND l.status = 'active') AS used`;
  return { entered: !!r?.entered, used: Number(r?.used ?? 0) };
}

/** 这次来访的票种含几餐、此刻门票几档 → 能用几餐 */
async function allowanceOf(db: Db, visitId: number, at: Date, date: string): Promise<{ allowance: number; ticketName: string | null }> {
  const ticket = await visitTicket(db, visitId, at, date);
  if (!ticket) return { allowance: 0, ticketName: null };
  const [t] = await db<{ meals12h: number; meals24h: number }[]>`SELECT meals_12h, meals_24h FROM ticket_types WHERE id = ${ticket.typeId}`;
  return { allowance: mealAllowance(t ? { meals12h: Number(t.meals12h), meals24h: Number(t.meals24h) } : null, ticket.segments), ticketName: ticket.name };
}

async function visitByTag(db: Db, tagCode: string): Promise<{ visitId: number; tagCode: string; guest: string }> {
  const visitId = await findGuestByTag(db, tagCode);
  if (!visitId) throw notFound(`手牌 ${tagCode} 现在没有在店的客人`);
  const [v] = await db<{ code: string; guest: string }[]>`
    SELECT h.code, coalesce(m.name, nullif(v.guest_label, ''), '散客') AS guest
    FROM visits v JOIN hand_tags h ON h.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id WHERE v.id = ${visitId}`;
  return { visitId, tagCode: v!.code, guest: v!.guest };
}

/** 入口刷手牌：这位客人、此刻的餐段、这一餐收多少 */
export async function previewMealEntry(deps: Deps, tagCode: string, now = new Date()): Promise<MealEntryPreview> {
  const db = deps.sql;
  const g = await visitByTag(db, tagCode);
  const date = await businessDate(db, deps, now);
  const p = await periodNow(db, deps, now);
  const { allowance, ticketName } = await allowanceOf(db, g.visitId, now, date);
  const { entered, used } = await entryState(db, g.visitId, date, p?.key ?? null);
  return {
    ...g,
    ticketName,
    period: p ? { key: p.key, label: MEAL_PERIOD_LABELS[p.key], range: mealPeriodRange(p), price: p.price } : null,
    allowance,
    used,
    entered,
    kind: p ? (used < allowance ? 'included' : 'paid') : null,
  };
}

/** 登记进餐：返回这一次的预览（登记以后的样子） */
export async function createMealEntry(deps: Deps, raw: unknown, ctx: OpContext): Promise<MealEntryPreview> {
  const input = parse(EntryInput, raw);
  const g = await visitByTag(deps.sql, input.tagCode);
  const requestHash = hashRequest({ op: 'meal_entry', visitId: g.visitId });
  const { postChargesTx } = await loadBills();
  await runIdempotent(deps, { key: input.clientKey, opType: 'meal_entry', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const date = await businessDate(tx, deps, at);
    const p = await periodNow(tx, deps, at);
    if (!p) throw unprocessable('MEAL_CLOSED', '现在不是供餐时间（餐段与时间在后台「餐饮规则」里设），不能登记进餐');
    // 先锁来访，再核对这一餐登记过没有、还有几餐含餐（同一位客人的两次登记排队）
    const visit = (await lockVisits(tx, [g.visitId])).get(g.visitId)!;
    const { entered, used } = await entryState(tx, visit.id, date, p.key);
    if (entered) throw conflict('MEAL_ENTERED', `手牌 ${g.tagCode} 今天的${MEAL_PERIOD_LABELS[p.key]}已经登记过了`);
    const { allowance } = await allowanceOf(tx, visit.id, at, date);
    const kind = used < allowance ? 'included' : 'paid';
    const name = `${MEAL_PERIOD_LABELS[p.key]}自助`;
    const posted = await postChargesTx(
      tx,
      deps,
      visit.id,
      { clientKey: input.clientKey, lines: [], customLines: [{ name, amount: p.price }], expectedTotal: p.price } as never,
      { key: input.clientKey, requestHash, backfill: null, opType: 'meal_entry' },
      ctx,
      { customSource: 'dining' },
    );
    const line = posted.lines[0]!;
    await tx`
      INSERT INTO meal_entries (visit_id, business_date, period, kind, price, line_id, client_key, staff_id, created_at)
      VALUES (${visit.id}, ${date}, ${p.key}, ${kind}, ${p.price}, ${line.lineId}, ${input.clientKey}, ${ctx.actor.id}, ${at})`;
    if (kind === 'included') {
      await insertAutoDiscount(tx, { lineId: line.lineId, billId: visit.billId, amount: p.price, rule: 'included_meal', reason: '含餐', staffId: ctx.actor.id, opKey: input.clientKey, date, at });
    }
    return visit.id;
  });
  return previewMealEntry(deps, g.tagCode, ctx.at ?? new Date());
}

/**
 * 餐台点菜折零（点单页下单，挂账的事务里、写完明细以后）：这位客人登记了此刻这一餐的，餐厅出品口的菜自动折成 0（「自助」）。
 * 水吧、果吧的照价收（8.2.8 另有首杯免费）；没登记的照价收
 */
export async function applyBuffetZero(
  tx: Tx,
  deps: Deps,
  a: { visitId: number; billId: number; at: Date; date: string; opKey: string; staffId: number; lines: { lineId: number; itemId: number; amount: number }[] },
) {
  if (a.lines.length === 0) return;
  const p = await periodNow(tx, deps, a.at);
  if (!p) return;
  const { entered } = await entryState(tx, a.visitId, a.date, p.key);
  if (!entered) return;
  const slots = await loadDiningOutlets(tx);
  const items = await tx<{ id: number; category: string; diningOutlet: string | null; diningGroup: string; stationName: string | null }[]>`
    SELECT i.id, i.category, i.dining_outlet, i.dining_group, s.name AS station_name
    FROM service_items i LEFT JOIN kitchen_stations s ON s.id = i.station_id WHERE i.id IN ${tx([...new Set(a.lines.map((l) => l.itemId))])}`;
  const outletOf = new Map(items.map((i) => [Number(i.id), diningSlotOf({ outlet: i.diningOutlet, group: i.diningGroup, category: i.category, stationName: i.stationName }, slots).outlet]));
  for (const l of a.lines) {
    if (outletOf.get(l.itemId) !== 'restaurant') continue;
    await insertAutoDiscount(tx, { lineId: l.lineId, billId: a.billId, amount: l.amount, rule: 'buffet', reason: '自助', staffId: a.staffId, opKey: a.opKey, date: a.date, at: a.at });
  }
}

/**
 * 水吧首杯免费（8.2.8，走场「饮料首杯免费，同类第二杯开始结账」）：挂账的事务里、写完明细以后调用（所有挂到手牌上的入口都走）。
 * 这位客人水吧的每个小分类（手作饮料、糖水、调酒……）第一杯自动折掉一杯的钱（一行只点一杯的折成 0、标「赠」）；
 * 同一个小分类已经有过首杯（那一行没作废）的照价收。门店在「餐饮规则」里能关
 */
export async function applyFirstCup(
  tx: Tx,
  a: { visitId: number; billId: number; date: string; at: Date; opKey: string; staffId: number; lines: { lineId: number; itemId: number; unitPrice: number; amount: number }[] },
) {
  if (a.lines.length === 0) return;
  if (!(await loadDiningRules(tx)).firstCupFree) return;
  const slots = await loadDiningOutlets(tx);
  const items = await tx<{ id: number; category: string; diningOutlet: string | null; diningGroup: string; stationName: string | null }[]>`
    SELECT i.id, i.category, i.dining_outlet, i.dining_group, s.name AS station_name
    FROM service_items i LEFT JOIN kitchen_stations s ON s.id = i.station_id WHERE i.id IN ${tx([...new Set(a.lines.map((l) => l.itemId))])}`;
  const slotOf = new Map(items.map((i) => [Number(i.id), diningSlotOf({ outlet: i.diningOutlet, group: i.diningGroup, category: i.category, stationName: i.stationName }, slots)]));
  // 这次来访已经用过首杯的小分类（那一行还有效的）
  const used = await tx<{ itemId: number }[]>`
    SELECT l.item_id FROM bill_line_discounts d JOIN bill_lines l ON l.id = d.line_id
    WHERE d.bill_id = ${a.billId} AND d.rule = 'first_cup' AND d.status = 'active' AND l.status = 'active' AND l.item_id IS NOT NULL`;
  const usedItems = used.map((u) => Number(u.itemId)).filter((id) => !slotOf.has(id));
  const more = usedItems.length
    ? await tx<{ id: number; category: string; diningOutlet: string | null; diningGroup: string; stationName: string | null }[]>`
        SELECT i.id, i.category, i.dining_outlet, i.dining_group, s.name AS station_name
        FROM service_items i LEFT JOIN kitchen_stations s ON s.id = i.station_id WHERE i.id IN ${tx(usedItems)}`
    : [];
  for (const i of more) slotOf.set(Number(i.id), diningSlotOf({ outlet: i.diningOutlet, group: i.diningGroup, category: i.category, stationName: i.stationName }, slots));
  const taken = new Set(used.map((u) => slotOf.get(Number(u.itemId))?.group ?? ''));
  for (const l of a.lines) {
    const slot = slotOf.get(l.itemId);
    if (!slot || slot.outlet !== 'water' || taken.has(slot.group)) continue;
    taken.add(slot.group);
    // 一杯的钱折掉（点了几杯的只折一杯）：折到 amount − unitPrice
    await insertAutoDiscount(tx, {
      lineId: l.lineId,
      billId: a.billId,
      amount: l.amount,
      finalAmount: l.amount - l.unitPrice,
      rule: 'first_cup',
      reason: '首杯赠',
      staffId: a.staffId,
      opKey: a.opKey,
      date: a.date,
      at: a.at,
    });
  }
}

/** 当天登记过的（最新的在前） */
export async function listMealEntries(deps: Deps, date: string): Promise<MealEntryRow[]> {
  const rows = await deps.sql<(Omit<MealEntryRow, 'at'> & { at: Date })[]>`
    SELECT e.id, e.visit_id, h.code AS tag_code, coalesce(m.name, nullif(v.guest_label, ''), '散客') AS guest, e.period, e.kind, e.price,
           s.display_name AS staff_name, e.created_at AS at, l.status <> 'active' AS voided
    FROM meal_entries e JOIN visits v ON v.id = e.visit_id JOIN hand_tags h ON h.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id
    JOIN staff s ON s.id = e.staff_id JOIN bill_lines l ON l.id = e.line_id
    WHERE e.store_id = ${currentStoreId()} AND e.business_date = ${date} ORDER BY e.id DESC LIMIT 500`;
  return rows.map((r) => ({ ...r, id: Number(r.id), visitId: Number(r.visitId), price: Number(r.price), at: new Date(r.at).toISOString() }));
}

export function registerMealEntryRoutes(app: FastifyInstance, deps: Deps) {
  const restaurant = { preHandler: guard('dining.orderRestaurant') };
  app.get('/api/dining/meal-entries/preview', restaurant, async (req) => {
    const { tag } = parse(z.object({ tag: z.string('请刷手牌或输入牌号').trim().min(1, '请刷手牌或输入牌号').max(16) }), req.query ?? {});
    return previewMealEntry(deps, tag);
  });
  app.get('/api/dining/meal-entries', restaurant, async () => {
    const date = await businessDate(deps.sql, deps, new Date());
    const rules = await loadDiningRules(deps.sql);
    return { date, periods: rules.mealPeriods, entries: await listMealEntries(deps, date) };
  });
  app.post('/api/dining/meal-entries', restaurant, async (req) => createMealEntry(deps, req.body, ctxOf(req)));
}
