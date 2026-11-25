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
    const [a] = await ctx.sql<{ detail: { from: string; to: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'dish_price_mode' AND target_id = ${item['清蒸石斑']!}`;
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

const pay = (sessionIds: number[], expectedTotal: number, extra: Record<string, unknown> = {}) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/checkout', {
    clientKey: randomUUID(),
    sessionIds,
    expectedTotal,
    payments: expectedTotal ? [{ method: 'cash', amount: expectedTotal }] : [],
    ...extra,
  });
const preview = async (ids: number[]) => (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/checkout-preview?ids=${ids.join(',')}`)).body;

describe('包房的低消与服务费、赠送（R6、R14）', () => {
  it('后台设低消、服务费；服务费按没赠送的菜算；低消不够的拒绝，勾补足记一行；反结账再结不重复收', async () => {
    const t = (await api(ctx.app, boss, 'GET', '/api/admin/dining/tables')).body.tables.find((x: { name: string }) => x.name === '包1');
    const set = await api(ctx.app, boss, 'PUT', `/api/admin/dining/tables/${table['包1']}`, { ...t, minSpend: 30000, serviceFeeBp: 1500 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.tables.find((x: { name: string }) => x.name === '包1')).toMatchObject({ minSpend: 30000, serviceFeeBp: 1500 });
    // 不带这两项的保存不改它们
    expect(
      (await api(ctx.app, boss, 'PUT', `/api/admin/dining/tables/${table['包1']}`, { name: '包1', area: '包间', seats: 6 })).body.tables.find((x: { name: string }) => x.name === '包1'),
    ).toMatchObject({ minSpend: 30000 });

    const s = await open(table['包1']!);
    expect((await order(s, [{ itemId: item['宫保鸡丁'], quantity: 4 }], 19200)).status).toBe(200);
    // 赠送一份：菜照出，这一行不收钱
    const gift = await order(s, [{ itemId: item['宫保鸡丁'], quantity: 1 }], 4800);
    const giftLine = (await detail(s)).lines.filter((l) => l.status === 'active').at(-1)!;
    expect(gift.status).toBe(200);
    const g = await api(ctx.app, ctx.owner, 'POST', `/api/dining/tables/lines/${giftLine.id}/void`, { reason: '客户经理送的', gift: true });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const [k] = await ctx.sql<{ status: string }[]>`SELECT status FROM kitchen_items WHERE bill_line_id = ${giftLine.id}`;
    expect(k!.status).not.toBe('cancelled');

    // 菜钱 ¥192，服务费 15% = ¥28.80；低消 ¥300 差 ¥108
    const p = await preview([s]);
    expect(p.sessions[0].charge).toMatchObject({ subtotal: 19200, serviceFee: 2880, minSpend: 30000, shortfall: 10800 });
    expect(p).toMatchObject({ totalAmount: 22080, minSpendShortfall: 10800 });
    const refused = await pay([s], 22080);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('MIN_SPEND_SHORT');
    expect(refused.body.error.message).toContain('差 ¥108.00');
    const ok = await pay([s], 22080 + 10800, { minSpendTopUp: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const lines = await ctx.sql<{ name: string; amount: number; chargeKind: string | null; status: string }[]>`
      SELECT l.name, l.amount, l.charge_kind, l.status FROM bill_lines l JOIN table_sessions ts ON ts.bill_id = l.bill_id WHERE ts.id = ${s} AND l.charge_kind IS NOT NULL ORDER BY l.id`;
    expect(lines.map((l) => [l.name, Number(l.amount), l.status])).toEqual([
      ['服务费 15%', 2880, 'active'],
      ['低消补足', 10800, 'active'],
    ]);
    // 台账：赠送的那一行记「赠送」
    const ledger = (await api(ctx.app, ctx.owner, 'GET', `/api/dining/ledger?from=${ok.body.businessDate}&to=${ok.body.businessDate}`)).body;
    expect(ledger.rows.find((r: { name: string; kind: string; amount: number }) => r.kind === 'gift')).toMatchObject({ name: '宫保鸡丁' });

    // 反结账再结：原来自动记的作废重算，不重复收
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${ok.body.id}/void`, { reason: '低消补错了' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const p2 = await preview([s]);
    expect(p2).toMatchObject({ totalAmount: 22080, minSpendShortfall: 10800 });
    expect((await pay([s], 22080 + 10800, { minSpendTopUp: true })).status).toBe(200);
    const after = await ctx.sql<{ status: string }[]>`
      SELECT l.status FROM bill_lines l JOIN table_sessions ts ON ts.bill_id = l.bill_id WHERE ts.id = ${s} AND l.charge_kind IS NOT NULL ORDER BY l.id`;
    expect(after.map((l) => l.status)).toEqual(['voided', 'voided', 'active', 'active']);
  });
});

describe('包房转挂账（R9）', () => {
  it('转挂账：桌台空出来能开新台；挂账的单不能点菜、换台，能结账；记审计', async () => {
    const board = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/tables')).body.tables as { id: number; session: { id: number } | null }[];
    // 包1 上一位结账以后待清台，先清台
    await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/${table['包1']}/clear`, { clientKey: randomUUID() });
    const s = await open(table['包1']!);
    expect((await order(s, [{ itemId: item['宫保鸡丁'], quantity: 1 }], 4800)).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s}/park`, { reason: '' })).status).toBe(400);
    const parked = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s}/park`, { reason: '低消没结清，客户经理跟进' });
    expect(parked.status, JSON.stringify(parked.body)).toBe(200);
    expect(parked.body.parked.map((p: { id: number; amount: number }) => [p.id, p.amount])).toEqual([[s, 4800]]);
    expect((await board()).find((t) => t.id === table['包1'])!.session).toBeNull();
    expect((await order(s, [{ itemId: item['宫保鸡丁'], quantity: 1 }], 4800)).body.error.code).toBe('TABLE_PARKED');
    // 桌台空出来：下一桌照常开
    const next = await open(table['包1']!);
    expect((await board()).find((t) => t.id === table['包1'])!.session!.id).toBe(next);
    // 挂账的单照常结（低消不够的同样要补足）
    const p = await preview([s]);
    const done = await pay([s], p.totalAmount + p.minSpendShortfall, p.minSpendShortfall ? { minSpendTopUp: true } : {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/tables/parked')).body.parked).toEqual([]);
    const [a] = await ctx.sql<{ detail: { reason: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'table_park' AND target_id = ${s}`;
    expect(a!.detail.reason).toBe('低消没结清，客户经理跟进');
    // 反结账挂账的单：桌台被下一桌占着也能恢复（挂账的单不占桌台）
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${done.body.id}/void`, { reason: '金额不对' })).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/tables/parked')).body.parked.map((p: { id: number }) => p.id)).toEqual([s]);
  });
});

describe('消费转手牌（R11）', () => {
  it('餐饮的菜转到另一张手牌：出品单跟着走；之后厨房屏写新手牌；加料不能单独转', async () => {
    const a = await checkin();
    const b = await checkin();
    expect((await wristOrder(a, [{ itemId: item['宫保鸡丁'], quantity: 2 }], 9600)).status).toBe(200);
    const visitA = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${a}`)).body;
    const line = visitA.lines.find((l: { name: string; status: string }) => l.name === '宫保鸡丁' && l.status === 'active');
    const tagB = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${b}`)).body.tag.code;
    const moved = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/lines/move', { clientKey: randomUUID(), lineIds: [line.id], toTagCode: tagB, reason: '挂错手牌了' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const visitB = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${b}`)).body;
    const newLine = visitB.lines.find((l: { name: string }) => l.name === '宫保鸡丁');
    expect(newLine).toMatchObject({ amount: 9600, status: 'active' });
    const [k] = await ctx.sql<{ billLineId: number; visitId: number; status: string }[]>`SELECT bill_line_id, visit_id, status FROM kitchen_items WHERE bill_line_id = ${newLine.id}`;
    expect(k).toMatchObject({ visitId: b });
    expect(k!.status).not.toBe('cancelled');
    // 原手牌的那一行作废、写明转到哪
    const after = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${a}`)).body.lines.find((l: { id: number }) => l.id === line.id);
    expect(after.status).toBe('voided');
    expect(after.voidReason).toContain(`转到手牌 ${tagB}`);
    // 厨房屏：这道菜现在是 B 手牌的
    const kitchen = (await api(ctx.app, ctx.clerk, 'GET', '/api/kitchen')).body.items as { billLineId?: number; tagCode: string | null; name: string }[];
    expect(kitchen.filter((x) => x.name === '宫保鸡丁').map((x) => x.tagCode)).toContain(tagB);
  });
});
