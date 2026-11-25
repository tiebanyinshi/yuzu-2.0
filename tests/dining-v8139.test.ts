// 8.1.39 餐饮新店（docs/V8139.md）：菜品的计价方式（时价 / 杂项、称重）、桌台低消与服务费、挂账、转手牌。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
const item: Record<string, number> = {};
const table: Record<string, number> = {};
let tagNo = 0;

type Line = { id: number; name: string; unitPrice: number; quantity: number; amount: number; status: string; source: string; kitchen: { note: string } | null };
type Detail = { id: number; amount: number; lines: Line[] };

const open = async (tableId: number) => {
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 2 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id as number;
};
const order = (sessionId: number, lines: Record<string, unknown>[], expectedTotal: number, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', `/api/dining/tables/sessions/${sessionId}/orders`, { clientKey: randomUUID(), lines, expectedTotal });
const detail = async (id: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/sessions/${id}`)).body as Detail;
const checkin = async () => {
  tagNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: `K${String(tagNo).padStart(3, '0')}`, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0].id as number;
};
const wristOrder = (visitId: number, lines: Record<string, unknown>[], expectedTotal: number) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines, expectedTotal });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  boss = await login(ctx.app, 'boss');
  const r = await api(ctx.app, boss, 'POST', '/api/admin/dining/stations', { name: '热菜' });
  const station = r.body.stations.find((s: { name: string }) => s.name === '热菜').id as number;
  for (const [name, category, price] of [
    ['清蒸石斑', '海鲜', 16800],
    ['开瓶费', '杂项', 100],
    ['宫保鸡丁', '热菜', 4800],
  ] as const) {
    const c = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    item[name] = c.body.items.find((i: { name: string }) => i.name === name).id;
  }
  const set = await api(ctx.app, boss, 'PUT', '/api/admin/dining/items', { items: Object.values(item).map((id) => ({ id, stationId: station })) });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true, tablesEnabled: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'K', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  for (const name of ['A1', '包1']) {
    const t = await api(ctx.app, boss, 'POST', '/api/admin/dining/tables', { name, area: name === '包1' ? '包间' : '大厅', seats: 6 });
    table[name] = t.body.tables.find((x: { name: string }) => x.name === name).id;
  }
});
afterAll(async () => ctx.close());

describe('菜品的计价方式（R5、R15、R16）', () => {
  it('只有有改价权限的能改计价方式，记审计；菜单带上计价方式', async () => {
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/dishes/${item['清蒸石斑']}/price-mode`, { priceMode: 'weight' })).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/dining/dishes/${item['清蒸石斑']}/price-mode`, { priceMode: 'weight' })).body).toEqual({ id: item['清蒸石斑'], priceMode: 'weight' });
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/dining/dishes/${item['开瓶费']}/price-mode`, { priceMode: 'open' })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/dining/dishes/${item['开瓶费']}/price-mode`, { priceMode: 'bad' })).status).toBe(400);
    const menu = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu')).body as { dishes: { id: number; priceMode?: string }[] };
    expect(menu.dishes.find((d) => d.id === item['清蒸石斑'])!.priceMode).toBe('weight');
    expect(menu.dishes.find((d) => d.id === item['开瓶费'])!.priceMode).toBe('open');
    expect(menu.dishes.find((d) => d.id === item['宫保鸡丁'])!.priceMode).toBeUndefined();
    const [a] = await ctx.sql<{ detail: { from: string; to: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'dish_price_mode' AND target_id = ${item['清蒸石斑']}`;
    expect(a!.detail).toMatchObject({ from: 'fixed', to: 'weight' });
  });

  it('桌台点单：称重按每斤单价 × 斤数记一份，单价可改；杂项填一次金额，退的时候整行退；按价目的不能改价', async () => {
    const s = await open(table['A1']!);
    // 称重：1.35 斤 × ¥168 = ¥226.80；没填斤数拒绝；按价目的菜带了价拒绝
    expect((await order(s, [{ itemId: item['清蒸石斑'], quantity: 1 }], 16800)).body.error.code).toBe('DISH_NEEDS_WEIGHT');
    expect((await order(s, [{ itemId: item['宫保鸡丁'], quantity: 1, customPrice: 100 }], 100)).status).toBe(400);
    expect((await order(s, [{ itemId: item['清蒸石斑'], quantity: 2, weight: 135 }], 45360)).status).toBe(400);
    const fish = await order(s, [{ itemId: item['清蒸石斑'], quantity: 1, weight: 135 }], 22680);
    expect(fish.status, JSON.stringify(fish.body)).toBe(200);
    // 时价改单价：¥198/斤 × 0.8 斤 = ¥158.40
    expect((await order(s, [{ itemId: item['清蒸石斑'], quantity: 1, weight: 80, customPrice: 19800 }], 15840)).status).toBe(200);
    // 开瓶费 ¥400：一行
    expect((await order(s, [{ itemId: item['开瓶费'], quantity: 1 }], 100)).body.error.code).toBe('DISH_NEEDS_PRICE');
    const bottle = await order(s, [{ itemId: item['开瓶费'], quantity: 1, customPrice: 40000 }], 40000);
    expect(bottle.status, JSON.stringify(bottle.body)).toBe(200);
    const d = await detail(s);
    const active = d.lines.filter((l) => l.status === 'active');
    expect(active.map((l) => [l.name, l.unitPrice, l.quantity, l.amount])).toEqual([
      ['清蒸石斑 1.35斤', 22680, 1, 22680],
      ['清蒸石斑 0.8斤', 15840, 1, 15840],
      ['开瓶费', 40000, 1, 40000],
    ]);
    expect(active[0]!.kitchen!.note).toContain('1.35斤×¥168.00/斤');
    expect(d.amount).toBe(22680 + 15840 + 40000);
    const [audit] = await ctx.sql<{ detail: { pricedOnSite: unknown[] } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'table_post' AND target_id = ${s} ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.pricedOnSite).toEqual([{ name: '开瓶费', priceMode: 'open', customPrice: 40000, listPrice: 100 }]);
    // 退开瓶费：整行退（不会拆成 400 条）
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/dining/tables/lines/${active[2]!.id}/void`, { reason: '客人不开了' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect((await detail(s)).lines.filter((l) => l.name === '开瓶费').length).toBe(1);
  });

  it('手牌点单同样按填的价、斤数计', async () => {
    const v = await checkin();
    const r = await wristOrder(v, [{ itemId: item['清蒸石斑'], quantity: 1, weight: 200 }], 33600);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lines = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body.lines as { name: string; amount: number }[];
    expect(lines.map((l) => [l.name, l.amount])).toEqual([['清蒸石斑 2斤', 33600]]);
  });
});
