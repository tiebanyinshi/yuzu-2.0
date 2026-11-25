// 价目表与多门店（测试会话 8.1.32 报告 P1）：收银项目全公司一份，名称、分类、停用只跟本店（编号 1）的价目表走；
// 第二家店切换生效只写本店价，不能把总店在售的项目停用、改名。两家店各自切换生效，互不影响。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PriceCatalogOverview, PriceImportPreview } from '../src/shared/price-catalog';
import { api, login, setup, type TestContext } from './helpers';
import { priceSheet, priceWorkbook } from './price-workbook';

let ctx: TestContext;
let branch = '';

beforeAll(async () => {
  ctx = await setup();
  const entity = await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '分店主体' });
  const storeId = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'FD', name: '分店', entityId: entity.body.id })).body.id as number;
  const created = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username: 'fdmgr', displayName: '分店店总', role: 'store_manager' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const temp = created.body.temporaryPassword as string;
  const first = await login(ctx.app, 'fdmgr', temp);
  expect((await api(ctx.app, first, 'POST', '/api/auth/change-password', { currentPassword: temp, newPassword: 'fdmgr-2026x' })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${created.body.staff?.id ?? created.body.id}/stores`, { storeIds: [storeId] })).status).toBe(200);
  branch = await login(ctx.app, 'fdmgr', 'fdmgr-2026x');
}, 90_000);
afterAll(async () => ctx.close());

async function importAndActivate(cookie: string, xlsxBase64: string) {
  const p = (await api(ctx.app, cookie, 'POST', '/api/admin/price-catalog/import/preview', { fileName: '价目表.xlsx', xlsxBase64 })).body as PriceImportPreview & { digest: string };
  expect(
    p.issues.filter((i) => i.level === 'error'),
    JSON.stringify(p.issues),
  ).toEqual([]);
  const imp = await api(ctx.app, cookie, 'POST', '/api/admin/price-catalog/import', { fileName: '价目表.xlsx', xlsxBase64, previewDigest: p.digest, opKey: randomUUID() });
  expect(imp.status, JSON.stringify(imp.body)).toBe(201);
  const ov = (await api(ctx.app, cookie, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview;
  const act = await api(ctx.app, cookie, 'POST', '/api/admin/price-catalog/activate', { draftId: ov.draft!.id, opKey: randomUUID(), countReason: '用例：合成的表格条数与原表不同' });
  expect(act.status, JSON.stringify(act.body)).toBe(200);
}

const items = () =>
  ctx.sql<{ id: number; name: string; active: boolean; catalogKey: string | null; catalogCategoryName: string | null }[]>`
    SELECT id, name, active, catalog_key, catalog_category_name FROM service_items ORDER BY id`;

describe('价目表：两家店各自切换生效', () => {
  it('分店的价目表里没有「斯诺克」：分店切换生效后，总店在售的「斯诺克」照旧在用，收银项目一行都不变', async () => {
    await importAndActivate(ctx.owner, priceWorkbook());
    const before = await items();
    const snooker = before.find((i) => i.name === '斯诺克');
    expect(snooker?.active).toBe(true);
    // 分店的娱乐表：没有斯诺克，台球改了价
    const ent = priceSheet('娱乐价格', [['分店'], ['类型', '数量', '价格', '备注'], ['台球', 2, '59/2h', '加钟/29.9']]);
    await importAndActivate(branch, priceWorkbook({ 娱乐价格: ent }));
    expect(await items()).toEqual(before);
    // 总店再切换生效一次（重新导入同一份）：也不受分店那份影响
    await importAndActivate(ctx.owner, priceWorkbook());
    expect((await items()).find((i) => i.id === snooker!.id)).toMatchObject({ name: '斯诺克', active: true });
  });
});
