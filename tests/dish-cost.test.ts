// 8.1.41 菜品管理里看成本卡与毛利（docs/V8141.md 第 2 节）：GET /api/dining/dishes/costs。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
const item: Record<string, number> = {};
let water = 0;
const q = (n: number) => Math.round(n * 1000);
type Row = { itemId: number; hasRecipe: boolean; unitCostCents: number | null; missingCost: boolean };

beforeAll(async () => {
  ctx = await setup();
  for (const [name, price] of [
    ['柠檬水', 500],
    ['没配成本卡的', 300],
    ['新物料的菜', 800],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category: '饮品', price });
    expect(r.status).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
  // 一箱 24 瓶、参考价 24 元：没进过货时一瓶按 1 元起算
  const w = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', {
    code: 'C-WATER',
    name: '瓶装水',
    inventoryUnit: '瓶',
    decimals: 0,
    purchaseUnit: '箱',
    purchaseFactorMilli: q(24),
    refPriceCents: 2400,
  });
  expect(w.status, JSON.stringify(w.body)).toBe(201);
  water = w.body.id;
  // 没有参考价、没进过货的物料：成本卡配了也算不出成本
  const n = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', { code: 'C-NEW', name: '新物料', inventoryUnit: '个', decimals: 0, purchaseUnit: '个', purchaseFactorMilli: q(1) });
  expect(n.status, JSON.stringify(n.body)).toBe(201);
  expect((await api(ctx.app, ctx.owner, 'PUT', `/api/inventory/recipes/${item['柠檬水']}`, { expectedVersion: 0, lines: [{ materialId: water, qtyMilli: q(1) }] })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', `/api/inventory/recipes/${item['新物料的菜']}`, { expectedVersion: 0, lines: [{ materialId: n.body.id, qtyMilli: q(1) }] })).status).toBe(200);
}, 60_000);
afterAll(async () => ctx.close());

describe('菜品的成本卡', () => {
  it('店主看得到一份成本（按物料现在的成本，没进过货按参考价）、有没有成本卡、缺成本的物料', async () => {
    const r = await api(ctx.app, ctx.owner, 'GET', '/api/dining/dishes/costs');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.canSeeCost).toBe(true);
    const of = (name: string) => (r.body.rows as Row[]).find((x) => x.itemId === item[name])!;
    expect(of('柠檬水')).toMatchObject({ hasRecipe: true, unitCostCents: 100, missingCost: false });
    expect(of('没配成本卡的')).toMatchObject({ hasRecipe: false, unitCostCents: null, missingCost: false });
    expect(of('新物料的菜')).toMatchObject({ hasRecipe: true, unitCostCents: null, missingCost: true });
  });

  it('进货以后成本跟着物料的平均成本变：一瓶 1.5 元', async () => {
    // 直接写平均成本模拟到货入账（到货怎么算平均成本见 tests/stock-usage.test.ts 与库存的用例）
    await ctx.sql`UPDATE materials SET avg_cost_e4 = 1500000, cost_estimated = false WHERE id = ${water}`;
    const r = await api(ctx.app, ctx.owner, 'GET', '/api/dining/dishes/costs');
    expect((r.body.rows as Row[]).find((x) => x.itemId === item['柠檬水'])!.unitCostCents).toBe(150);
  });

  it('看不到菜品的（前台）不能查', async () => {
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/dishes/costs')).status).toBe(403);
  });
});
