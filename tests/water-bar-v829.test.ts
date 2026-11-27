// 8.2.18 水吧（docs/V82218_WATER_BAR.md）：首杯免费（每个小分类第一杯自动折掉，同类第二杯照价；点两杯的只折一杯；能关）、
// 结账单上标【赠】写原价与实收；取餐号（有水吧饮品的单发号，当天从 1 起）、客人扫码看进度（制作中 / 请取餐 / 已取）、叫号屏。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VisitDetail } from '../src/shared/frontdesk';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let tagNo = 0;
const item: Record<string, number> = {};

const checkin = async () => {
  tagNo += 1;
  const tagCode = `W${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0].id as number;
};
const order = (visitId: number, lines: Record<string, unknown>[], expectedTotal: number) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines, expectedTotal });
const lines = async (id: number) => (await api<VisitDetail>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${id}`)).body.lines.filter((l) => l.status === 'active');

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '水吧' });
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '水吧').id;
  for (const [name, price, slot] of [
    ['柠檬茶', 3800, 'water:手作饮料'],
    ['奶茶', 3200, 'water:手作饮料'],
    ['双皮奶', 2800, 'water:糖水'],
    ['炒饭', 4800, 'restaurant:餐饮'],
  ] as const) {
    const c = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category: '饮品', price });
    item[name] = c.body.items.find((i: { name: string }) => i.name === name).id;
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: item[name], stationId, slot }] })).status).toBe(200);
  }
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'W', from: 1, to: 30, width: 3, zone: 'male' })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('水吧首杯免费', () => {
  it('每个小分类第一杯折掉；同类第二杯照价；点两杯的只折一杯；餐厅的不算', async () => {
    const v = await checkin();
    expect((await order(v, [{ itemId: item['柠檬茶'], quantity: 1 }], 3800)).status).toBe(200);
    expect((await order(v, [{ itemId: item['奶茶'], quantity: 1 }], 3200)).status).toBe(200);
    expect(
      (
        await order(
          v,
          [
            { itemId: item['双皮奶'], quantity: 2 },
            { itemId: item['炒饭'], quantity: 1 },
          ],
          2800 * 2 + 4800,
        )
      ).status,
    ).toBe(200);
    const ls = await lines(v);
    expect(ls.find((l) => l.name === '柠檬茶')!.discount).toMatchObject({ listAmount: 3800, finalAmount: 0, rule: 'first_cup' });
    expect(ls.find((l) => l.name === '奶茶')!.discount).toBeNull();
    expect(ls.find((l) => l.name === '双皮奶')!.discount).toMatchObject({ listAmount: 5600, finalAmount: 2800, rule: 'first_cup' });
    expect(ls.find((l) => l.name === '炒饭')!.discount).toBeNull();
    // 结账单：【赠】写原价与实收
    const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v}`)).body;
    expect(pre.lineDiscountAmount).toBe(3800 + 2800);
    const due = pre.totalAmount - pre.lineDiscountAmount;
    const paid = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v],
      expectedTotal: pre.totalAmount,
      payments: [{ method: 'cash', amount: due }],
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const print = (await api(ctx.app, ctx.clerk, 'GET', `/api/print/checkouts/${paid.body.id}`)).body as {
      bills: { lines: { name: string; lineDiscount: { finalAmount: number; rule: string | null } | null }[] }[];
    };
    expect(print.bills[0]!.lines.find((l) => l.name === '柠檬茶')!.lineDiscount).toEqual({ finalAmount: 0, rule: 'first_cup' });
  });

  it('首杯那一行作废了，下一杯算首杯；门店能关掉', async () => {
    const v = await checkin();
    expect((await order(v, [{ itemId: item['柠檬茶'], quantity: 1 }], 3800)).status).toBe(200);
    const first = (await lines(v)).find((l) => l.name === '柠檬茶')!;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${first.id}/void`, { reason: '做错了' })).status).toBe(200);
    expect((await order(v, [{ itemId: item['奶茶'], quantity: 1 }], 3200)).status).toBe(200);
    expect((await lines(v)).find((l) => l.name === '奶茶')!.discount).toMatchObject({ finalAmount: 0, rule: 'first_cup' });
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { firstCupFree: false })).status).toBe(200);
    try {
      const w = await checkin();
      expect((await order(w, [{ itemId: item['柠檬茶'], quantity: 1 }], 3800)).status).toBe(200);
      expect((await lines(w)).find((l) => l.name === '柠檬茶')!.discount).toBeNull();
    } finally {
      await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { firstCupFree: true });
    }
  });
});

describe('取餐叫号', () => {
  it('有水吧饮品的单发号（当天从 1 起）；客人扫码看进度；叫号屏', async () => {
    const before = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/pickups')).body as { making: number[]; ready: number[] };
    const v = await checkin();
    expect((await order(v, [{ itemId: item['炒饭'], quantity: 1 }], 4800)).status).toBe(200);
    expect((await order(v, [{ itemId: item['奶茶'], quantity: 1 }], 3200)).status).toBe(200);
    const tickets = await ctx.sql<{ pickupNo: number; token: string; orderNo: string }[]>`SELECT pickup_no, token, order_no FROM pickup_tickets WHERE visit_id = ${v}`;
    expect(tickets).toHaveLength(1);
    const t = tickets[0]!;
    // 点菜单上带号与查进度的编号
    const receipt = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/receipt?visit=${v}`)).body as { orders: { orderNo: string; pickup: { no: number; token: string } | null }[] };
    expect(receipt.orders.find((o) => o.orderNo === t.orderNo)!.pickup).toEqual({ no: Number(t.pickupNo), token: t.token });
    expect(receipt.orders.find((o) => o.orderNo !== t.orderNo)!.pickup).toBeNull();
    // 不登录也能看
    const pub = await ctx.app.inject({ method: 'GET', url: `/api/public/pickup/${t.token}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ pickupNo: Number(t.pickupNo), state: 'making', items: [{ name: '奶茶', quantity: 1 }] });
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/pickups')).body as { making: number[]; ready: number[] };
    expect(board.making).toContain(Number(t.pickupNo));
    expect(board.making.length).toBe(before.making.length + 1);
    // 出餐 → 请取餐；上菜 → 已取（屏上不再列）
    const [k] = await ctx.sql<{ id: number }[]>`SELECT id FROM kitchen_items WHERE order_no = ${t.orderNo}`;
    for (const action of ['start', 'done']) {
      const r = await api(ctx.app, ctx.clerk, 'POST', `/api/kitchen/items/${k!.id}/${action}`, {});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    expect((await ctx.app.inject({ method: 'GET', url: `/api/public/pickup/${t.token}` })).json().state).toBe('ready');
    expect(((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/pickups')).body as { ready: number[] }).ready).toContain(Number(t.pickupNo));
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/kitchen/items/${k!.id}/serve`, {})).status).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/public/pickup/${t.token}` })).json().state).toBe('served');
    // 编号不对的
    expect((await ctx.app.inject({ method: 'GET', url: `/api/public/pickup/${randomUUID()}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/public/pickup/abc' })).statusCode).toBe(400);
    // 只追加
    await expect(ctx.sql`UPDATE pickup_tickets SET pickup_no = 99 WHERE visit_id = ${v}`).rejects.toThrow();
  });
});
