// 8.1.39（餐饮 B，docs/V8139_DINING_B.md）：
//   · 分时段自动沽清（R3）：菜品设了售卖时段，不在时段里手牌点单、桌台点单都下不了单（DISH_NOT_ON_SALE），点单页的菜单标着停售；
//   · 出品档口按时段切换：这一刻落在档口时段里的菜，出品单到那一段的档口；以后改了时段，已经下的单不动；
//   · 菜单小分类可以在后台改（R4）：按设的名单核对点单分类；还有菜在用的小分类不能删、不能改名（DINING_GROUP_IN_USE）；
//   · 点菜单每一行带单价（R12，接口原来就有 unitPrice）；前台结账核对的「只看餐饮」（R10）：几张手牌各自与合起来的餐饮小计。
// 时段按「现在」往前、往后挪出来，不依赖跑用例的时刻。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { minuteOfDay } from '../src/shared/business-date';
import { slotKey, type DiningMenu, type DiningReceipt, type KitchenItem } from '../src/shared/dining';
import type { DiningSubtotals } from '../src/shared/dining-v8139';
import type { DishRow, DishesBoard } from '../src/shared/dishes';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let tagNo = 0;
const station: Record<string, number> = {};

/** 现在往后挪 delta 分钟（一天里的第几分钟，绕回零点） */
const at = (delta: number) => (((minuteOfDay(new Date(), ctx.config.timezone) + delta) % 1440) + 1440) % 1440;
/** 包住现在的一段、不包住现在的一段 */
const nowWindow = () => ({ start: at(-60), end: at(60) });
const laterWindow = () => ({ start: at(120), end: at(240) });

const board = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/dining/dishes')).body as DishesBoard;
const dishOf = async (name: string) => (await board()).dishes.find((d) => d.name === name)!;
const fieldsOf = (d: DishRow) => ({ name: d.name, category: d.category, slot: slotKey(d), stationId: d.stationId, imageId: d.imageId, methods: d.methods, addons: [], combo: [] });
const create = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes', { clientKey: randomUUID(), category: '餐饮', ...body });
const update = (d: DishRow, patch: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', `/api/dining/dishes/${d.id}`, { clientKey: randomUUID(), rev: d.rev, ...fieldsOf(d), ...patch });
const menu = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu')).body as DiningMenu;
const enter = async () => {
  tagNo += 1;
  const code = `N${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.visits[0].id as number, code };
};
const order = (visitId: number, lines: { itemId: number; quantity: number }[], expectedTotal: number) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines, expectedTotal });
const rules = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', body);

beforeAll(async () => {
  ctx = await setup();
  expect((await rules({ enabled: true, tablesEnabled: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'N', from: 1, to: 30, width: 3, zone: 'male' })).status).toBe(200);
  for (const name of ['热菜', '夜宵档']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name });
    expect(r.status).toBe(200);
    station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
  }
  for (const [name, price] of [
    ['早茶虾饺', 3800],
    ['砂锅粥', 4200],
    ['白灼菜心', 2600],
  ] as const) {
    const r = await create({ name, slot: 'restaurant:餐饮', stationId: station['热菜'], prices: { standard: price } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
});
afterAll(async () => ctx.close());

describe('分时段自动沽清（R3）', () => {
  it('不在售卖时段：菜单标停售，手牌点单整笔拒绝、写明几点卖；在时段里照常点', async () => {
    const d = await dishOf('早茶虾饺');
    const w = laterWindow();
    const saved = await update(d, { saleWindows: [w] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((saved.body.dish as DishRow).saleWindows).toEqual([w]);
    const m = (await menu()).dishes.find((x) => x.id === d.id)!;
    expect(m).toMatchObject({ saleWindows: [w], offSale: true });
    // 没设时段的菜不带
    expect((await menu()).dishes.find((x) => x.name === '白灼菜心')).not.toHaveProperty('offSale');

    const v = await enter();
    const r = await order(v.id, [{ itemId: d.id, quantity: 1 }], 3800);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DISH_NOT_ON_SALE');
    expect(r.body.error.message).toContain('早茶虾饺');
    expect(r.body.error.message).toContain('到点自动停售');
    // 整笔拒绝：账上什么都没挂
    expect((await ctx.sql`SELECT count(*)::int AS n FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${v.id}`)[0]!.n).toBe(0);

    // 改成包住现在的一段（再加一段），能点了
    const again = await update(await dishOf('早茶虾饺'), { saleWindows: [laterWindow(), nowWindow()] });
    expect(again.status).toBe(200);
    expect((await menu()).dishes.find((x) => x.id === d.id)).toMatchObject({ offSale: false });
    expect((await order(v.id, [{ itemId: d.id, quantity: 1 }], 3800)).status).toBe(200);
    // 审计写了改了什么
    const [audit] = await ctx.sql<{ summary: string }[]>`SELECT detail->>'summary' AS summary FROM audit_logs WHERE action = 'dish_saved' AND detail->>'summary' LIKE '%售卖时段%' ORDER BY id LIMIT 1`;
    expect(audit?.summary).toContain('售卖时段 全天 →');
    // 清掉（空数组）就是全天卖
    expect((await update(await dishOf('早茶虾饺'), { saleWindows: [] })).body.dish.saleWindows).toEqual([]);
  });

  it('桌台点单同样拒绝；时段写错了不让存', async () => {
    const d = await dishOf('砂锅粥');
    expect((await update(d, { saleWindows: [laterWindow()] })).status).toBe(200);
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: 'B1' });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const tableId = t.body.tables.find((x: { name: string }) => x.name === 'B1').id as number;
    const open = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 2 });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${open.body.id}/orders`, { clientKey: randomUUID(), lines: [{ itemId: d.id, quantity: 1 }], expectedTotal: 4200 });
    expect(r.body.error?.code).toBe('DISH_NOT_ON_SALE');

    const bad = await update(await dishOf('砂锅粥'), { saleWindows: [{ start: 600, end: 600 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('DISH_WINDOW_INVALID');
    expect((await update(await dishOf('砂锅粥'), { saleWindows: [] })).status).toBe(200);
  });
});

describe('出品档口按时段切换', () => {
  it('现在落在档口时段里的菜到那一段的档口；改了时段已经下的单不动；档口时段不能重叠', async () => {
    const d = await dishOf('白灼菜心');
    const overlap = await update(d, {
      stationWindows: [
        { ...nowWindow(), stationId: station['夜宵档'] },
        { start: at(0), end: at(30), stationId: station['热菜'] },
      ],
    });
    expect(overlap.body.error?.code).toBe('DISH_WINDOW_INVALID');
    const saved = await update(d, { stationWindows: [{ ...nowWindow(), stationId: station['夜宵档'] }] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.dish.stationWindows).toMatchObject([{ stationId: station['夜宵档'], stationName: '夜宵档' }]);
    // 菜单上写此刻的档口
    expect((await menu()).dishes.find((x) => x.id === d.id)).toMatchObject({ stationId: station['夜宵档'], stationName: '夜宵档' });

    const v = await enter();
    expect((await order(v.id, [{ itemId: d.id, quantity: 1 }], 2600)).status).toBe(200);
    const items = async () => ((await api(ctx.app, ctx.owner, 'GET', '/api/kitchen')).body.items as KitchenItem[]).filter((k) => k.visitId === v.id);
    expect((await items()).map((k) => k.stationName)).toEqual(['夜宵档']);

    // 档口时段挪到以后：新下的到菜品自己的档口，刚才那张照旧
    expect((await update(await dishOf('白灼菜心'), { stationWindows: [{ ...laterWindow(), stationId: station['夜宵档'] }] })).status).toBe(200);
    expect((await order(v.id, [{ itemId: d.id, quantity: 1 }], 2600)).status).toBe(200);
    expect((await items()).map((k) => k.stationName)).toEqual(['夜宵档', '热菜']);
  });
});

describe('菜单小分类（R4）', () => {
  it('默认名单照旧；加了新的小分类就能把菜挪进去，名单里没有的拒绝', async () => {
    const admin = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/dining')).body;
    expect(admin.rules.outletGroups).toEqual({ restaurant: ['餐饮', '酒水'], water: ['手作饮料', '糖水', '调酒'] });
    const d = await dishOf('早茶虾饺');
    expect((await update(d, { slot: 'restaurant:点心' })).body.error.code).toBe('DINING_SLOT_UNKNOWN');

    expect((await rules({ outletGroups: { restaurant: ['点心', '中餐', '烧腊', '餐饮', '酒水'], water: ['手作饮料', '糖水', '调酒'] } })).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/outlets')).body.outlets[0].groups).toEqual(['点心', '中餐', '烧腊', '餐饮', '酒水']);
    expect((await update(await dishOf('早茶虾饺'), { slot: 'restaurant:点心' })).status).toBe(200);
    expect((await menu()).dishes.find((x) => x.name === '早茶虾饺')).toMatchObject({ outlet: 'restaurant', group: '点心' });
    // 后台「出品档口与菜品」的批量设分类也按名单
    const bad = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: d.id, slot: 'restaurant:粤菜' }] });
    expect(bad.body.error.code).toBe('DINING_SLOT_UNKNOWN');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: (await dishOf('砂锅粥')).id, slot: 'restaurant:中餐' }] })).status).toBe(200);
  });

  it('还有菜在用的小分类不能删、不能改名；名字超过 8 个字、重复的不让存', async () => {
    const used = await rules({ outletGroups: { restaurant: ['中餐', '烧腊', '餐饮', '酒水'], water: ['手作饮料', '糖水', '调酒'] } });
    expect(used.status).toBe(409);
    expect(used.body.error.code).toBe('DINING_GROUP_IN_USE');
    expect(used.body.error.message).toContain('「餐厅 · 点心」还有 1 道菜');
    // 改名（把「餐饮」改成「粤菜」）：白灼菜心还按「餐饮」，不让改
    const renamed = await rules({ outletGroups: { restaurant: ['点心', '中餐', '烧腊', '粤菜', '酒水'], water: ['手作饮料', '糖水', '调酒'] } });
    expect(renamed.body.error.code).toBe('DINING_GROUP_IN_USE');
    expect(renamed.body.error.message).toContain('「餐厅 · 餐饮」还有 1 道菜');
    // 没有菜的「烧腊」可以删
    expect((await rules({ outletGroups: { restaurant: ['点心', '中餐', '餐饮', '酒水'], water: ['手作饮料', '糖水', '调酒'] } })).status).toBe(200);
    expect((await rules({ outletGroups: { restaurant: ['点心', '点心'], water: ['糖水'] } })).body.error.message).toContain('重复');
    expect((await rules({ outletGroups: { restaurant: ['一二三四五六七八九'], water: ['糖水'] } })).body.error.message).toContain('8 个字');
    expect((await rules({ outletGroups: { restaurant: [], water: ['糖水'] } })).body.error.message).toContain('至少要有一个');
  });
});

describe('点菜单标单价（R12）、同组账单只看餐饮（R10）', () => {
  it('点菜单每一行带单价；结账核对按手牌给餐饮小计与合计，不算别的明细', async () => {
    const a = await enter();
    const b = await enter();
    const c = await enter();
    const shrimp = await dishOf('早茶虾饺');
    const greens = await dishOf('白灼菜心');
    expect((await order(a.id, [{ itemId: shrimp.id, quantity: 2 }], 7600)).status).toBe(200);
    expect((await order(b.id, [{ itemId: greens.id, quantity: 1 }], 2600)).status).toBe(200);
    // a 再挂一笔非餐饮的（手动金额），不算进餐饮
    const custom = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${a.id}/charges`, {
      clientKey: randomUUID(),
      lines: [],
      customLines: [{ name: '毛巾赔偿', amount: 1000 }],
      expectedTotal: 1000,
    });
    expect(custom.status, JSON.stringify(custom.body)).toBe(200);

    const receipt = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/receipt?visit=${a.id}`)).body as DiningReceipt;
    expect(receipt.orders[0]!.lines[0]).toMatchObject({ name: '早茶虾饺', unitPrice: 3800, quantity: 2, amount: 7600 });

    const r = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/dining-subtotals?visitIds=${a.id},${b.id},${c.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = r.body as DiningSubtotals;
    expect(s.total).toBe(10200);
    expect(s.visits.find((v) => v.visitId === a.id)).toMatchObject({ amount: 7600, quantity: 2, lines: [{ name: '早茶虾饺', unitPrice: 3800, quantity: 2, amount: 7600 }] });
    expect(s.visits.find((v) => v.visitId === b.id)).toMatchObject({ amount: 2600 });
    expect(s.visits.find((v) => v.visitId === c.id)).toMatchObject({ amount: 0, lines: [] });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/dining-subtotals?visitIds=abc')).status).toBe(400);
  });
});
