// 8.1.34 价目核对（docs/PRICE_V8134.md）：收银项目与全品类价目表对不上、看着奇怪的地方。
// 默认只读；--apply 只停用两类（价目表以前建的门票项目、没对接但与已对接的在售项目同名的），
// 「开单即占用」规则在用的不动；其余只列出来。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PriceCatalogOverview, PriceImportPreview } from '../src/shared/price-catalog';
import { priceAudit } from '../src/server/modules/price-catalog/audit';
import { api, setup, type TestContext } from './helpers';
import { priceWorkbook } from './price-workbook';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
}, 90_000);
afterAll(async () => ctx.close());

async function activate(xlsxBase64: string) {
  const p = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import/preview', { fileName: '价目表.xlsx', xlsxBase64 })).body as PriceImportPreview & { digest: string };
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName: '价目表.xlsx', xlsxBase64, previewDigest: p.digest, opKey: randomUUID() })).status).toBe(201);
  const ov = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview;
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { draftId: ov.draft!.id, opKey: randomUUID(), countReason: '用例：合成的表格' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const active = async (id: number) => (await ctx.sql<{ active: boolean }[]>`SELECT active FROM service_items WHERE id = ${id}`)[0]!.active;

describe('价目核对 price-audit', () => {
  it('列出门票项目、同名重复、没对接的；--apply 只停用前两类，开单即占用在用的不动、只有本身价格的照常卖；再跑一次什么都不停', async () => {
    await activate(priceWorkbook());
    // 以前（8.1.33 之前）价目表建的门票项目：模拟一条
    const [ticket] = await ctx.sql<{ id: number }[]>`
      INSERT INTO service_items (name, category, price, active, catalog_key, catalog_managed) VALUES ('12H 不含餐', '入场', 49900, true, 'store||门票|12h不含餐', true) RETURNING id`;
    await ctx.sql`INSERT INTO service_item_prices (item_id, tier, price) VALUES (${ticket!.id}, 'standard', 49900)`;
    // 后台手工又建了一个同名的「台球」（价目表里的已对接）
    const twin = (await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '台 球', category: '娱乐', price: 3000 })).body.items.find(
      (i: { name: string; catalogCategory: unknown }) => i.name === '台 球' && !i.catalogCategory,
    ).id as number;
    // 又一个同名的「台球」，被「开单即占用」规则当房费用着：不动
    const [feeRow] = await ctx.sql<{ id: number }[]>`INSERT INTO service_items (name, category, price, active) VALUES ('台球', '房费', 3000, true) RETURNING id`;
    const fee = Number(feeRow!.id);
    // 没有分档价、只有项目本身的价格（开单按它当标准档，pricing.ts；数据库要求它大于 0）：照常能卖，不算多余（Codex 审查）
    const [plain] = await ctx.sql<{ id: number }[]>`INSERT INTO service_items (name, category, price, active) VALUES ('只有本身价格', '其他', 2000, true) RETURNING id`;
    await ctx.sql`
      INSERT INTO settings (key, value) VALUES ('usage_rules', ${ctx.sql.json({ businessTypes: ['派对房'], pricing: { 派对房: { feeItemId: fee, minMinutes: 60, stepMinutes: 30, openFeeItemId: null } } } as never)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    // 价目表管不到的手工项目：只列出来
    const extra = (await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '毛巾租用', category: '零售', price: 500 })).body.items.find((i: { name: string }) => i.name === '毛巾租用')
      .id as number;

    const dry = await priceAudit(ctx.sql, { apply: false, staffId: null });
    expect(dry.activeSet).not.toBeNull();
    expect(dry.ticketItems.map((i) => i.id)).toEqual([Number(ticket!.id)]);
    expect(dry.duplicates.map((d) => d.id).sort()).toEqual([twin, fee].sort());
    expect(dry.unlinked.map((i) => i.id)).toContain(Number(plain!.id));
    expect(dry.unlinked.map((i) => i.id)).toContain(extra);
    expect(dry.protectedIds).toContain(fee);
    expect(dry.deactivated).toBe(0);
    expect(await active(Number(ticket!.id))).toBe(true);

    const done = await priceAudit(ctx.sql, { apply: true, staffId: null });
    expect(done.deactivated).toBe(2);
    expect(await active(Number(ticket!.id))).toBe(false);
    expect(await active(twin)).toBe(false);
    expect(await active(fee)).toBe(true);
    expect(await active(extra)).toBe(true);
    expect(await active(Number(plain!.id))).toBe(true);
    const [audit] = await ctx.sql<{ detail: { action: string; items: unknown[] } }[]>`SELECT detail FROM audit_logs WHERE action = 'price_catalog' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail).toMatchObject({ action: 'audit_cleanup' });
    expect(audit!.detail.items).toHaveLength(2);
    expect((await priceAudit(ctx.sql, { apply: true, staffId: null })).deactivated).toBe(0);
  });
});
