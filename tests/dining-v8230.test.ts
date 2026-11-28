// 8.2.30 收银合并的餐饮补全（docs/V8230_CASHIER.md 第 4 节）：
//   · 等叫（CM-16）：还没开始做的能标，等叫着厨房不能开始做、出餐；「起菜」以后照常；开始做了不能再等叫；整单一起标；
//   · 加急、打包：只是标记，厨房屏与桌台明细带出来；已上菜、已退的不能再标；
//   · 沽清一键恢复（CM-17）：今天的沽清、限量全部取消，记审计；
//   · 待催（CM-18）：桌台看板带最早一道下了单还没出餐的时刻（等叫的不算）；
//   · 分次上菜（CM-19）：出餐以后先上几份，上齐了才算已上菜；撤回先撤上的份数；带上看到的已上份数，同一个请求到两次只上一次；
//   · 等叫的套餐（Codex 审查 06b2eee）：别的档口的子项也不能开始做、出餐，厨房屏的子项带上等叫；子项开始做了不能再等叫。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let dish: number;
let table: number;
let session: number;
let chef: number;

type Pending = { id: number; name: string; status: string; quantity: number; hold?: boolean; urgent?: boolean; takeaway?: boolean; servedQty?: number };
const pending = async () => (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/sessions/${session}`)).body.pending as Pending[];
const kitchen = (id: number, action: string, body: Record<string, unknown> = {}) => api(ctx.app, ctx.owner, 'POST', `/api/kitchen/items/${id}/${action}`, body);
const flags = (ids: number[], patch: Record<string, unknown>, cookie = ctx.clerk) => api(ctx.app, cookie, 'POST', '/api/dining/items/flags', { ids, ...patch });
const order = async (quantity: number) => {
  const r = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${session}/orders`, {
    clientKey: randomUUID(),
    lines: [{ itemId: dish, quantity }],
    expectedTotal: 3800 * quantity,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (await pending()).at(-1)!;
};

beforeAll(async () => {
  ctx = await setup();
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '中厨' });
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '中厨').id;
  chef = stationId;
  const c = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '虾饺', category: '点心', price: 3800 });
  dish = c.body.items.find((i: { name: string }) => i.name === '虾饺').id;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true, tablesEnabled: true, trackServed: true, warnMinutes: 15 })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: dish, stationId, slot: 'restaurant:餐饮' }] })).status).toBe(200);
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: 'A1', area: '大厅', seats: 4 });
  table = t.body.tables.find((x: { name: string }) => x.name === 'A1').id;
  const o = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId: table, guests: 2 });
  expect(o.status, JSON.stringify(o.body)).toBe(200);
  session = o.body.id;
});
afterAll(async () => ctx.close());

describe('等叫、起菜、加急、打包', () => {
  it('等叫着厨房不能开始做、出餐；起菜以后照常；开始做了不能再等叫', async () => {
    const p = await order(1);
    const h = await flags([p.id], { hold: true });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect((await pending()).find((x) => x.id === p.id)).toMatchObject({ hold: true });
    const start = await kitchen(p.id, 'start');
    expect(start.status).toBe(409);
    expect(start.body.error.code).toBe('DISH_HELD');
    expect((await kitchen(p.id, 'done')).status).toBe(409);
    // 等叫的菜不算待催
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/tables')).body;
    expect(board.tables.find((x: { id: number }) => x.id === table).session.oldestWaitingAt).toBeNull();
    expect((await flags([p.id], { hold: false })).status).toBe(200);
    expect((await kitchen(p.id, 'start')).status).toBe(200);
    const again = await flags([p.id], { hold: true });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DISH_STARTED');
  });

  it('整单等叫、加急、打包；空的标记拒绝；没有点单权限的不能标', async () => {
    const a = await order(1);
    const b = await order(2);
    expect((await flags([a.id, b.id], { hold: true, urgent: true, takeaway: true })).status).toBe(200);
    const list = await pending();
    for (const id of [a.id, b.id]) expect(list.find((x) => x.id === id)).toMatchObject({ hold: true, urgent: true, takeaway: true });
    const kds = (await api(ctx.app, ctx.owner, 'GET', '/api/kitchen')).body;
    expect(JSON.stringify(kds)).toContain('"hold":true');
    expect((await flags([a.id], {})).status).toBe(400);
    expect((await flags([a.id, b.id], { hold: false })).status).toBe(200);
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'dining_kitchen_flags'`;
    expect(audit!.n).toBeGreaterThanOrEqual(3);
  });
});

describe('等叫的套餐', () => {
  it('套餐等叫时别的档口的子项也不能开始做、出餐；厨房屏的子项带上等叫；子项开始做了不能再等叫', async () => {
    const ws = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '水吧' });
    const water = ws.body.stations.find((s: { name: string }) => s.name === '水吧').id;
    const drink = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes', {
      clientKey: randomUUID(),
      name: '柠檬茶',
      category: '餐饮',
      slot: 'water:手作饮料',
      stationId: water,
      prices: { standard: 800 },
    });
    expect(drink.status, JSON.stringify(drink.body)).toBe(201);
    const set = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes', {
      clientKey: randomUUID(),
      name: '点心套餐',
      category: '餐饮',
      slot: 'restaurant:餐饮',
      stationId: chef,
      prices: { standard: 4200 },
      combo: [
        { itemId: dish, quantity: 1 },
        { itemId: drink.body.dish.id, quantity: 1 },
      ],
    });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    const o = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${session}/orders`, {
      clientKey: randomUUID(),
      lines: [{ itemId: set.body.dish.id, quantity: 1 }],
      expectedTotal: 4200,
    });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    const combo = (await pending()).at(-1)!;
    const [part] = await ctx.sql<{ id: number }[]>`SELECT id FROM kitchen_item_parts WHERE kitchen_item_id = ${combo.id} AND split`;
    const partAct = (action: string) => api(ctx.app, ctx.owner, 'POST', `/api/kitchen/parts/${part!.id}/${action}`, { from: 'queued' });
    expect((await flags([combo.id], { hold: true })).status).toBe(200);
    const kds = (await api(ctx.app, ctx.owner, 'GET', '/api/kitchen')).body as { parts: { id: number; hold: boolean }[] };
    expect(kds.parts.find((x) => x.id === part!.id)).toMatchObject({ hold: true });
    for (const action of ['start', 'done']) {
      const r = await partAct(action);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('DISH_HELD');
    }
    // 起菜以后子项照常；子项开始做了，套餐不能再等叫（套餐那一张自己还在待做）
    expect((await flags([combo.id], { hold: false })).status).toBe(200);
    expect((await partAct('start')).status).toBe(200);
    const again = await flags([combo.id], { hold: true });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DISH_STARTED');
  });
});

describe('分次上菜', () => {
  it('出餐以后先上几份，上齐才算已上菜；撤回先撤上的份数；已上菜的不能再标', async () => {
    const p = await order(3);
    expect((await kitchen(p.id, 'done')).status).toBe(200);
    expect((await kitchen(p.id, 'serve', { from: 'done', quantity: 4, servedQty: 0 })).status).toBe(422);
    // 分次上菜要带上看到的已上份数（Codex 审查 06b2eee）
    expect((await kitchen(p.id, 'serve', { from: 'done', quantity: 1 })).status).toBe(400);
    expect((await kitchen(p.id, 'serve', { from: 'done', quantity: 1, servedQty: 0 })).status).toBe(200);
    // 回复丢了重提、连点两下：同一个请求第二次已上份数对不上，不会多上一份
    const replay = await kitchen(p.id, 'serve', { from: 'done', quantity: 1, servedQty: 0 });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('DISH_CHANGED');
    expect((await pending()).find((x) => x.id === p.id)).toMatchObject({ status: 'done', servedQty: 1 });
    expect((await kitchen(p.id, 'undo')).status).toBe(200);
    expect((await pending()).find((x) => x.id === p.id)).toMatchObject({ status: 'done', servedQty: 0 });
    expect((await kitchen(p.id, 'serve', { from: 'done', quantity: 2, servedQty: 0 })).status).toBe(200);
    expect((await kitchen(p.id, 'serve', { from: 'done' })).status).toBe(200);
    expect((await pending()).find((x) => x.id === p.id)).toBeUndefined();
    const [k] = await ctx.sql<{ status: string; servedQty: number }[]>`SELECT status, served_qty FROM kitchen_items WHERE id = ${p.id}`;
    expect(k).toEqual({ status: 'served', servedQty: 3 });
    expect((await flags([p.id], { takeaway: true })).status).toBe(409);
  });
});

describe('待催与沽清一键恢复', () => {
  it('桌台看板带最早一道还没出餐的下单时刻', async () => {
    await order(1);
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/tables')).body;
    expect(board.tables.find((x: { id: number }) => x.id === table).session.oldestWaitingAt).not.toBeNull();
  });

  it('全部恢复：今天的沽清、限量都取消', async () => {
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${dish}`, { remaining: 0 })).status).toBe(200);
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/kitchen/limits/restore-all', {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.restored).toBe(1);
    expect(r.body.board.dishes.find((d: { id: number }) => d.id === dish).remaining).toBeNull();
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/kitchen/limits/restore-all', {})).body.restored).toBe(0);
  });
});

describe('杯贴', () => {
  it('一单一杯一张：品名、第几杯、桌号；没有这一单的 404', async () => {
    const p = await order(2);
    const [k] = await ctx.sql<{ orderNo: string }[]>`SELECT order_no FROM kitchen_items WHERE id = ${p.id}`;
    const r = await api(ctx.app, ctx.clerk, 'GET', `/api/dining/cup-labels/${k!.orderNo}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ orderNo: k!.orderNo, where: '桌 A1', total: 2, pickupNo: null });
    expect(r.body.labels.map((l: { name: string; seq: number }) => [l.name, l.seq])).toEqual([
      ['虾饺', 1],
      ['虾饺', 2],
    ]);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/cup-labels/NO-SUCH')).status).toBe(404);
  });

  it('没设点单分类、按「水吧」档口默认归水吧的饮品也能打杯贴；厨房屏标成水吧（Codex 审查 e383bf9）', async () => {
    const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '二号水吧' });
    const bar = st.body.stations.find((s: { name: string }) => s.name === '二号水吧').id;
    const c = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '柠檬茶', category: '餐饮', price: 2600 });
    const tea = c.body.items.find((i: { name: string }) => i.name === '柠檬茶').id as number;
    // 只设档口、不设点单分类（service_items.dining_outlet 为空）
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: tea, stationId: bar }] })).status).toBe(200);
    const [raw] = await ctx.sql<{ diningOutlet: string | null }[]>`SELECT dining_outlet FROM service_items WHERE id = ${tea}`;
    expect(raw!.diningOutlet).toBeNull();
    // 同一单还点了一道虾饺（餐厅）：杯贴只打柠檬茶
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${session}/orders`, {
      clientKey: randomUUID(),
      lines: [
        { itemId: tea, quantity: 1 },
        { itemId: dish, quantity: 1 },
      ],
      expectedTotal: 2600 + 3800,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const kds = (await api(ctx.app, ctx.owner, 'GET', '/api/kitchen')).body as { items: { name: string; orderNo: string; outlet: string | null }[] };
    const ticket = kds.items.filter((k) => k.name === '柠檬茶').at(-1)!;
    expect(ticket.outlet).toBe('water');
    expect(kds.items.find((k) => k.orderNo === ticket.orderNo && k.name === '虾饺')!.outlet).toBe('restaurant');
    const labels = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/cup-labels/${ticket.orderNo}`)).body;
    expect(labels).toMatchObject({ total: 1, labels: [{ name: '柠檬茶', seq: 1 }] });
  });

  it('加料不单独算一杯，写进它那杯饮品的杯贴（桌台点单与前台点单两条路）', async () => {
    const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '饮品' });
    const bar = st.body.stations.find((s: { name: string }) => s.name === '饮品').id;
    const make = async (body: Record<string, unknown>) => {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes', { clientKey: randomUUID(), category: '饮品', slot: 'water:手作饮料', stationId: bar, ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.dish.id as number;
    };
    const pearl = await make({ name: '珍珠', prices: { standard: 200 } });
    const tea = await make({ name: '奶茶', prices: { standard: 1500 }, addons: [pearl] });
    const lines = [
      { itemId: tea, quantity: 2 },
      { itemId: pearl, quantity: 2, addonOf: 0 },
    ];
    const check = async (where: { visitId?: number; sessionId?: number }, place: string) => {
      const [k] = await ctx.sql<{ orderNo: string }[]>`
        SELECT k.order_no FROM kitchen_items k JOIN bill_lines l ON l.id = k.bill_line_id
        WHERE l.name = '奶茶' AND ${where.visitId ? ctx.sql`k.visit_id = ${where.visitId}` : ctx.sql`k.table_session_id = ${where.sessionId!}`} ORDER BY k.id DESC LIMIT 1`;
      const r = await api(ctx.app, ctx.clerk, 'GET', `/api/dining/cup-labels/${k!.orderNo}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ total: 2, where: place });
      expect(r.body.labels).toEqual([
        { name: '奶茶', note: '加珍珠', seq: 1 },
        { name: '奶茶', note: '加珍珠', seq: 2 },
      ]);
    };
    const t = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${session}/orders`, { clientKey: randomUUID(), lines, expectedTotal: 3400 });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    await check({ sessionId: session }, '桌 A1');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'W', from: 1, to: 2, width: 3, zone: 'male' })).status).toBe(200);
    const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'W001', zone: 'male' }] });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const visitId = v.body.visits[0].id as number;
    const o = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines, expectedTotal: 3400 });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    await check({ visitId }, '手牌 W001');
  });
});
