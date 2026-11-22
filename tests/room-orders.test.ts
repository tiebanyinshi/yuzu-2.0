// 回测整改 P07（回测 3-1，docs/YUZU_REQ_V820.md 第 8 节）：房态中心「在用」的房间直接点水吧、果吧——
// 下单挂到房里客人的手牌账单、出出品单（送到「房 H601」、口味备注与整单备注进出品单）、卡片上的单数与金额、原样重提不重复挂账、
// 只能点这个出品口、配置限定分类、逐行按出品口核对权限、空房不能点、合计对不上整单拒绝、撤单（作废明细）留痕、点单记录。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoomCenterBoard } from '../src/shared/room-center';
import type { DiningMenu } from '../src/shared/dining';
import { roomOrderCategoryOf, type RoomOrderConfigAdmin, type RoomOrderHistory, type RoomOrderResult } from '../src/shared/room-orders';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let km: string; // 康美部：只有水吧、果吧的下单与退菜
let butler: string; // 管家：不能点
let tagNo = 0;
const item: Record<string, number> = {};
const price: Record<string, number> = { 宫保鸡丁: 4800, 柠檬茶: 1800, 椰子水: 2200, 果盘: 3800, 西瓜汁: 2600 };
const room: Record<string, number> = {};
const station: Record<string, number> = {};

const enter = async () => {
  tagNo += 1;
  const tagCode = `R${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { visitId: r.body.visits[0].id as number, tagCode };
};
const checkIn = async (roomNo: string) => {
  const g = await enter();
  const s = await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkin', { clientKey: randomUUID(), roomId: room[roomNo], expectedRate: 30000, tagCode: g.tagCode, guests: 1 });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return g;
};
type Line = { name: string; quantity?: number; note?: string };
const place = (roomNo: string, outlet: 'water' | 'fruit', lines: Line[], extra: Record<string, unknown> = {}, cookie = km, clientKey = randomUUID()) =>
  api<RoomOrderResult & { error: { code: string; message: string } }>(ctx.app, cookie, 'POST', `/api/room-center/rooms/r${room[roomNo]}/orders`, {
    clientKey,
    outlet,
    lines: lines.map((l) => ({ itemId: item[l.name]!, quantity: l.quantity ?? 1, ...(l.note ? { note: l.note } : {}) })),
    expectedTotal: lines.reduce((s, l) => s + price[l.name]! * (l.quantity ?? 1), 0),
    ...extra,
  });
const card = async (roomNo: string, cookie = km) => ((await api(ctx.app, cookie, 'GET', '/api/room-center')).body as RoomCenterBoard).rooms.find((r) => r.code === roomNo)!;
const history = async (roomNo: string) => (await api(ctx.app, km, 'GET', `/api/room-center/rooms/r${room[roomNo]}/orders`)).body as RoomOrderHistory;
const billLines = async (visitId: number) => {
  const [r] = await ctx.sql<{ n: number; amount: number }[]>`
    SELECT count(*)::int AS n, coalesce(sum(l.amount) FILTER (WHERE l.status <> 'voided'), 0)::int AS amount FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${visitId}`;
  return r!;
};

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'rkm', displayName: '康美小周', role: 'backoffice', duties: ['kangmei'], password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'rbutler', displayName: '管家甲', role: 'backoffice', duties: ['concierge'], password: PASSWORD, mustChangePassword: false });
  km = await login(ctx.app, 'rkm');
  butler = await login(ctx.app, 'rbutler');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'R', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  for (const name of ['热菜', '水吧', '果吧']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name });
    station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
  }
  for (const [name, category, st] of [
    ['宫保鸡丁', '热菜', '热菜'],
    ['柠檬茶', '饮品', '水吧'],
    ['椰子水', '饮品', '水吧'],
    ['果盘', '水果', '果吧'],
    ['西瓜汁', '鲜榨', '果吧'],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price: price[name] });
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: item[name], stationId: station[st] }] })).status).toBe(200);
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(200);
  const rt = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '大床房', kind: 'daily', price: 30000 });
  const typeId = rt.body.types.find((x: { name: string }) => x.name === '大床房').id;
  for (const roomNo of ['H601', 'H602', 'H603', 'H604']) {
    const rm = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo, floor: '6', roomTypeId: typeId });
    room[roomNo] = rm.body.rooms.find((x: { roomNo: string }) => x.roomNo === roomNo).id;
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/rooms/${room[roomNo]}/housekeeping`, { status: 'clean' })).status).toBe(200);
  }
});
afterAll(async () => ctx.close());

describe('房态点单（P07）', () => {
  it('康美部在在用的房间点水吧：挂到客人账上、出品单送到房间、备注进出品单；卡片写单数与金额；原样重提不重复', async () => {
    const g = await checkIn('H601');
    expect((await card('H601')).orders).toBeNull();
    const base = await billLines(g.visitId);
    const key = randomUUID();
    const r = await place('H601', 'water', [{ name: '柠檬茶', quantity: 2, note: '少冰' }, { name: '椰子水' }], { orderNote: '客人在泡池' }, km, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.replayed).toBe(false);
    const o = r.body.order;
    expect(o).toMatchObject({
      roomCode: 'H601',
      outlet: 'water',
      tagCode: g.tagCode,
      note: '客人在泡池',
      postedTotal: 5800,
      total: 5800,
      staffUsername: 'rkm',
      staffName: '康美小周',
      visitOpen: true,
    });
    expect(o.orderNo).toBeTruthy();
    expect(o.lines.map((l) => [l.name, l.quantity, l.note, l.status])).toEqual([
      ['柠檬茶', 2, '少冰', 'posted'],
      ['椰子水', 1, '', 'posted'],
    ]);
    const kitchen = await ctx.sql<{ deliverTo: string; orderNote: string | null; note: string }[]>`
      SELECT deliver_to, order_note, note FROM kitchen_items WHERE order_no = ${o.orderNo} ORDER BY id`;
    expect(kitchen.map((k) => k.deliverTo)).toEqual(['房 H601', '房 H601']);
    expect(kitchen.map((k) => k.orderNote)).toEqual(['客人在泡池', '客人在泡池']);
    expect(kitchen[0]!.note).toBe('少冰');
    expect(await billLines(g.visitId)).toEqual({ n: base.n + 2, amount: base.amount + 5800 });
    expect((await card('H601')).orders).toEqual({ count: 1, amount: 5800 });
    // 同一编号原样重提：返回第一次那一单，不再挂账
    const again = await place('H601', 'water', [{ name: '柠檬茶', quantity: 2, note: '少冰' }, { name: '椰子水' }], { orderNote: '客人在泡池' }, km, key);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, order: { id: o.id } });
    expect((await billLines(g.visitId)).n).toBe(base.n + 2);
    // 同一编号换了内容：拒绝
    expect((await place('H601', 'water', [{ name: '椰子水' }], {}, km, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 断网后的查回走点单页那一套
    expect((await api(ctx.app, km, 'GET', `/api/room-center/order-ops/water/${key}`)).body).toEqual({ found: true, type: 'room_order', visitId: g.visitId });
    const [op] = await ctx.sql<{ opType: string }[]>`SELECT op_type FROM idempotency_keys WHERE key = ${key}`;
    expect(op!.opType).toBe('room_order_water');
    // 换个出品口问同一个编号：答「没查到」
    expect((await api(ctx.app, km, 'GET', `/api/room-center/order-ops/fruit/${key}`)).body).toEqual({ found: false, abandoned: false });
    // 再点一单果吧
    expect((await place('H601', 'fruit', [{ name: '果盘' }])).status).toBe(200);
    expect((await card('H601')).orders).toEqual({ count: 2, amount: 9600 });
  });

  it('空房、别的出品口的菜、餐厅的菜、合计对不上都整单拒绝；不能点的岗位进不来', async () => {
    const empty = await place('H602', 'water', [{ name: '柠檬茶' }]);
    expect(empty.status).toBe(409);
    expect(empty.body.error.code).toBe('ROOM_NOT_IN_USE');
    await checkIn('H602');
    const wrongTab = await place('H602', 'water', [{ name: '柠檬茶' }, { name: '果盘' }]);
    expect(wrongTab.status).toBe(422);
    expect(wrongTab.body.error).toMatchObject({ code: 'ROOM_ORDER_OUTLET' });
    expect(wrongTab.body.error.message).toContain('「果盘」');
    expect((await place('H602', 'water', [{ name: '宫保鸡丁' }], {}, ctx.clerk)).body.error.code).toBe('ROOM_ORDER_OUTLET');
    const changed = await place('H602', 'fruit', [{ name: '果盘' }], { expectedTotal: 100 });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('PRICE_CHANGED');
    expect((await place('H602', 'fruit', [{ name: '果盘' }], {}, butler)).status).toBe(403);
    expect((await api(ctx.app, butler, 'GET', `/api/room-center/rooms/r${room['H602']}/orders`)).status).toBe(403);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM room_orders WHERE room_id = ${room['H602']!}`;
    expect(n!.n).toBe(0);
    expect((await api(ctx.app, km, 'POST', '/api/room-center/rooms/x1/orders', {})).status).toBe(404);
  });

  it('门店按出品口限定能点的分类：后台列出现有分类；限定以后别的分类拒绝；改回全部', async () => {
    const admin = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/room-order-config')).body as RoomOrderConfigAdmin;
    expect(admin.available.fruit).toEqual(['水果', '鲜榨']);
    expect(admin.available.water).toEqual(['手作饮料']);
    expect(admin.outlets).toEqual({ water: { categories: null }, fruit: { categories: null } });
    expect((await api(ctx.app, km, 'PUT', '/api/admin/room-order-config', { outlets: { water: { categories: null }, fruit: { categories: ['水果'] } } })).status).toBe(403);
    const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/room-order-config', { outlets: { water: { categories: null }, fruit: { categories: ['水果'] } } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await api(ctx.app, km, 'GET', '/api/room-center/order-config')).body.outlets.fruit.categories).toEqual(['水果']);
    // 房态点单的菜单只给能点的分类：果吧只剩「水果」，水吧照旧全部
    const menu = (await api(ctx.app, km, 'GET', '/api/room-center/order-menu')).body as DiningMenu;
    expect([...new Set(menu.dishes.filter((d) => d.outlet === 'fruit').map(roomOrderCategoryOf))]).toEqual(['水果']);
    expect(menu.dishes.some((d) => d.outlet === 'water')).toBe(true);
    expect(menu.dishes.some((d) => d.outlet !== 'water' && d.outlet !== 'fruit')).toBe(false);
    await checkIn('H603');
    const blocked = await place('H603', 'fruit', [{ name: '西瓜汁' }]);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ROOM_ORDER_CATEGORY');
    expect((await place('H603', 'fruit', [{ name: '果盘' }])).status).toBe(200);
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'settings_updated' AND target_type = 'room_order_outlets'`;
    expect(audit!.n).toBe(1);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/room-order-config', { outlets: { water: { categories: null }, fruit: { categories: null } } })).status).toBe(200);
    expect((await place('H603', 'fruit', [{ name: '西瓜汁' }])).status).toBe(200);
  });

  it('撤单：康美部按行作废（要原因、留审计），记录里写谁退的；卡片上的单数与金额跟着变，退光的那一单不算', async () => {
    const before = await history('H601');
    expect(before.current).toEqual({ count: 2, amount: 9600 });
    expect(before.orders.map((o) => o.outlet)).toEqual(['fruit', 'water']);
    const fruit = before.orders[0]!;
    const line = fruit.lines[0]!;
    expect((await api(ctx.app, km, 'POST', `/api/frontdesk/lines/${line.lineId}/void`, { reason: '客人不要了' })).status).toBe(200);
    const after = await history('H601');
    expect(after.current).toEqual({ count: 1, amount: 5800 });
    const voided = after.orders.find((o) => o.id === fruit.id)!;
    expect(voided.total).toBe(0);
    expect(voided.postedTotal).toBe(3800);
    expect(voided.lines[0]).toMatchObject({ status: 'voided', voidReason: '客人不要了', voidedByName: '康美小周' });
    expect((await card('H601')).orders).toEqual({ count: 1, amount: 5800 });
    // 再退一次：已退过
    expect((await api(ctx.app, km, 'POST', `/api/frontdesk/lines/${line.lineId}/void`, { reason: '客人不要了' })).status).toBe(409);
    // 记录只追加：改不了
    const id = fruit.id;
    await expect(Promise.resolve().then(async () => ctx.sql`UPDATE room_orders SET note = 'x' WHERE id = ${id}`)).rejects.toThrow();
  });

  it('必选做法照点单页的规矩：不选拒绝，选了能下、写进出品单（Codex 审查 90a09c7）', async () => {
    const made = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes', {
      clientKey: randomUUID(),
      name: '冰柠水',
      category: '饮品',
      slot: 'water:手作饮料',
      stationId: station['水吧'],
      prices: { standard: 1600 },
      methods: [
        { name: '少冰', group: '冰量', price: 0 },
        { name: '去冰', group: '冰量', price: 0 },
      ],
      methodGroups: [{ name: '冰量', required: true }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    item['冰柠水'] = made.body.dish.id;
    price['冰柠水'] = 1600;
    const g = await checkIn('H604');
    const bare = await place('H604', 'water', [{ name: '冰柠水' }]);
    expect(bare.status, JSON.stringify(bare.body)).toBeGreaterThanOrEqual(400);
    const ok = await api<RoomOrderResult>(ctx.app, km, 'POST', `/api/room-center/rooms/r${room['H604']}/orders`, {
      clientKey: randomUUID(),
      outlet: 'water',
      lines: [{ itemId: item['冰柠水'], quantity: 1, methods: ['去冰'] }],
      expectedTotal: 1600,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.order.lines[0]!.note).toContain('去冰');
    expect(ok.body.order.tagCode).toBe(g.tagCode);
  });

  it('只有「在水吧下单」的账号：能下单，断网后也能查回、确认作废（Codex 审查 90a09c7）', async () => {
    const made = await api(ctx.app, ctx.owner, 'POST', '/api/staff', {
      username: 'rwater',
      displayName: '只点水吧',
      position: 'finance.staff',
      permissionAdjust: { add: ['dining.orderWater'], remove: [] },
      password: PASSWORD,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = 'rwater'`;
    const water = await login(ctx.app, 'rwater');
    const me = (await api(ctx.app, water, 'GET', '/api/auth/me')).body as { permissions: string[] };
    expect(me.permissions).toContain('dining.orderWater');
    expect(me.permissions).not.toContain('dining.order');
    expect(me.permissions).not.toContain('frontdesk.read');
    // 菜单：点单页的读不了，房态点单自己的能读，只给水吧的菜（Codex 审查 4eef781）
    expect((await api(ctx.app, water, 'GET', '/api/dining/menu')).status).toBe(403);
    const menu = await api(ctx.app, water, 'GET', '/api/room-center/order-menu');
    expect(menu.status, JSON.stringify(menu.body)).toBe(200);
    const outlets = new Set((menu.body as DiningMenu).dishes.map((d) => d.outlet));
    expect([...outlets]).toEqual(['water']);
    const key = randomUUID();
    expect((await place('H604', 'water', [{ name: '柠檬茶' }], {}, water, key)).status).toBe(200);
    expect((await api(ctx.app, water, 'GET', `/api/room-center/order-ops/water/${key}`)).body).toMatchObject({ found: true, type: 'room_order' });
    // 点单页、前台的查回与作废照旧要「餐饮点单」或前台权限
    expect((await api(ctx.app, water, 'GET', `/api/dining/ops/${key}`)).status).toBe(403);
    expect((await api(ctx.app, water, 'POST', `/api/dining/ops/${randomUUID()}/abandon`, {})).status).toBe(403);
    // 确认作废只登记房态点单这一类：同一个编号的前台挂账照样生效（Codex 安全审查 e1c3203）
    const other = randomUUID();
    const abandoned = await api(ctx.app, water, 'POST', `/api/room-center/order-ops/water/${other}/abandon`, {});
    expect(abandoned.status, JSON.stringify(abandoned.body)).toBe(200);
    expect(abandoned.body).toEqual({ found: false, abandoned: true });
    const [fence] = await ctx.sql<{ opType: string }[]>`SELECT op_type FROM op_fences WHERE key = ${other}`;
    expect(fence!.opType).toBe('room_order_water');
    const g = await enter();
    const post = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${g.visitId}/charges`, {
      clientKey: other,
      lines: [{ itemId: item['柠檬茶'], quantity: 1 }],
      expectedTotal: price['柠檬茶'],
    });
    expect(post.status, JSON.stringify(post.body)).toBe(200);
    // 别的挂账的编号：这里只答「没查到」，也不作废
    expect((await api(ctx.app, water, 'GET', `/api/room-center/order-ops/water/${other}`)).body).toEqual({ found: false, abandoned: false });
    expect((await api(ctx.app, water, 'POST', `/api/room-center/order-ops/water/${other}/abandon`, {})).body).toEqual({ found: false, abandoned: false });
    // 果吧的待确认点单：只有水吧权限的人碰不到——果吧的入口 403；从水吧的入口作废只登记水吧这一类，果吧那一单照样生效（Codex 安全审查 404eb2f）
    const fruitKey = randomUUID();
    expect((await api(ctx.app, water, 'GET', `/api/room-center/order-ops/fruit/${fruitKey}`)).status).toBe(403);
    expect((await api(ctx.app, water, 'POST', `/api/room-center/order-ops/fruit/${fruitKey}/abandon`, {})).status).toBe(403);
    expect((await api(ctx.app, water, 'POST', `/api/room-center/order-ops/water/${fruitKey}/abandon`, {})).body).toEqual({ found: false, abandoned: true });
    expect((await place('H604', 'fruit', [{ name: '果盘' }], {}, km, fruitKey)).status).toBe(200);
    // 果吧那一单已经生效：从水吧的入口查回、作废都只答「没查到」，不说生效没生效、记在谁上（Codex 审查 0995112）
    expect((await api(ctx.app, water, 'GET', `/api/room-center/order-ops/water/${fruitKey}`)).body).toEqual({ found: false, abandoned: false });
    expect((await api(ctx.app, water, 'POST', `/api/room-center/order-ops/water/${fruitKey}/abandon`, {})).body).toEqual({ found: false, abandoned: false });
    expect((await api(ctx.app, km, 'GET', `/api/room-center/order-ops/fruit/${fruitKey}`)).body).toMatchObject({ found: true, type: 'room_order' });
  });

  it('只为点单来看房态的：看板只给精简的卡片，不给客人、手牌、技师、金额、客房房价（Codex 安全审查 e1c3203）', async () => {
    const full = await card('H601', ctx.clerk);
    expect(full.hotel?.stay?.tagCode).toBeTruthy();
    // 只有「在水吧下单」的账号（上一条建的）：只为点单来看房态
    const slim = await card('H601', await login(ctx.app, 'rwater'));
    expect(slim).toMatchObject({ code: 'H601', status: 'in_use', guests: [], hotel: null, usage: null, guestText: null, techText: null, amount: null, booking: null });
    expect(slim.orders).toEqual(full.orders);
    expect(JSON.stringify(slim)).not.toContain(full.hotel!.stay!.tagCode);
  });
});
