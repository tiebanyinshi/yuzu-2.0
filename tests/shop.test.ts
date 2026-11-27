// 采购商城并进柚子（8.1.32，docs/MALL_V8132.md）：SKU 上架与改价审核、目录里能不能买、选品与自主申请提交、
// 价格版本与起订量的核对、我的需求与需求池的可见范围、商城的单在 ERP 填单页改不了、自检照过。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { pagedMall } from '../src/server/modules/mall';
import { requestChecks } from '../src/server/modules/requests';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { zip } from '../src/server/lib/xlsx';
import { shiftDate } from '../src/shared/labels';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string; // 店主 linlan：有「采购规则」
let buyer: string; // 采购经办 zhouyi：purchase.manage
let reqA: string; // 部门申购（运营部）
let reqB: string; // 部门申购（水吧）
let deptA: number;
let storeId: number;
let entityId: number;
let mat: { id: number };
let supA: number;
let supB: number;
let today: string;
const q = (n: number) => Math.round(n * 1000);

const header = (over: Record<string, unknown> = {}) => ({
  clientKey: randomUUID(),
  storeId,
  entityId,
  contactName: '王小明',
  budgetProject: '布草消耗预算',
  needBy: shiftDate(today, 3),
  deliveryAddress: '本店布草仓',
  paymentIntent: 'company_direct',
  priority: 'high',
  note: '',
  ...over,
});

async function sku(over: Record<string, unknown> = {}) {
  const r = await api(ctx.app, buyer, 'POST', '/api/erp/shop/skus', {
    materialId: mat.id,
    supplierId: supA,
    skuCode: `SKU-${randomUUID().slice(0, 8)}`,
    priceCents: 850,
    taxRateBp: 1300,
    moqMilli: q(100),
    leadDays: 5,
    freightCents: 0,
    validUntil: shiftDate(today, 365),
    storeIds: [],
    ...over,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: number; status: string; version: number; priceVersion: number; skuCode: string };
}
async function listed(skuId: number) {
  expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${skuId}/submit`, {})).status).toBe(200);
  const r = await api(ctx.app, boss, 'POST', `/api/erp/shop/skus/${skuId}/approve`, {});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { id: number; status: string; priceVersion: number };
}
const catalog = async (cookie: string) => (await api(ctx.app, cookie, 'GET', `/api/erp/shop/catalog?storeId=${storeId}`)).body;
const offer = async (cookie: string, skuId: number) =>
  ((await catalog(cookie)).items as { offers: { skuId: number; block: string | null; priceVersion: number; grossCents: number }[] }[]).flatMap((i) => i.offers).find((o) => o.skuId === skuId);

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  const mk = async (name: string) => {
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name });
    return ((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[]).find((d) => d.name === name)!.id;
  };
  deptA = await mk('运营部');
  const deptB = await mk('水吧');
  await createStaff(ctx.sql, { username: 'shop_a', displayName: '运营部申购', role: 'backoffice', duties: ['request'], departmentId: deptA, password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'shop_b', displayName: '水吧申购', role: 'backoffice', duties: ['request'], departmentId: deptB, password: PASSWORD, mustChangePassword: false });
  reqA = await login(ctx.app, 'shop_a');
  reqB = await login(ctx.app, 'shop_b');
  storeId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM stores ORDER BY id LIMIT 1`)[0]!.id);
  entityId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM legal_entities ORDER BY id LIMIT 1`)[0]!.id);
  mat = (await ctx.sql<{ id: number }[]>`SELECT id FROM materials WHERE code = 'M016'`)[0]!;
  supA = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM suppliers WHERE code = 'S004'`)[0]!.id);
  supB = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM suppliers WHERE code <> 'S004' AND active ORDER BY id LIMIT 1`)[0]!.id);
  await ctx.sql`UPDATE suppliers SET admission = 'approved' WHERE id IN (${supA}, ${supB})`;
}, 120_000);
afterAll(async () => ctx.close());

describe('SKU 上架与改价', () => {
  it('草稿 → 提交 → 有「采购规则」的人审核上架；没权限的批不了；草稿、待审的部门看不到', async () => {
    const s = await sku();
    expect(s.status).toBe('draft');
    expect(await offer(reqA, s.id)).toBeUndefined();
    await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${s.id}/submit`, {});
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${s.id}/approve`, {})).status).toBe(403);
    expect(await offer(reqA, s.id)).toBeUndefined();
    const ok = await api(ctx.app, boss, 'POST', `/api/erp/shop/skus/${s.id}/approve`, {});
    expect(ok.body).toMatchObject({ status: 'approved', approvedByName: expect.any(String) });
    expect((await offer(reqA, s.id))!.block).toBeNull();
    // 部门申购看不到 SKU 维护
    expect((await api(ctx.app, reqA, 'GET', '/api/erp/shop/skus')).status).toBe(403);
  });

  it('上架后直接改价被拒；提改动后暂停采购，批了价格版本加一、恢复采购；SKU 不能删', async () => {
    const s = await listed((await sku()).id);
    const cur = (await api(ctx.app, buyer, 'GET', '/api/erp/shop/skus')).body.find((x: { id: number }) => x.id === s.id);
    const edit = await api(ctx.app, buyer, 'PUT', `/api/erp/shop/skus/${s.id}`, {
      materialId: mat.id,
      supplierId: supA,
      skuCode: cur.skuCode,
      priceCents: 900,
      taxRateBp: 1300,
      moqMilli: q(100),
      leadDays: 5,
      freightCents: 0,
      validUntil: cur.validUntil,
      storeIds: [],
      version: cur.version,
    });
    expect(edit.body.error.code).toBe('SKU_CORE_CHANGE');
    const ch = await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${s.id}/changes`, {
      priceCents: 900,
      taxRateBp: 1300,
      moqMilli: q(50),
      freightCents: 0,
      validUntil: cur.validUntil,
      storeIds: [],
      reason: '供应商调价',
    });
    expect(ch.body).toMatchObject({ corePending: true, pendingChange: { reason: '供应商调价' } });
    expect((await offer(reqA, s.id))!.block).toBe('core_pending');
    const done = await api(ctx.app, boss, 'POST', `/api/erp/shop/changes/${ch.body.pendingChange.id}/approve`, {});
    expect(done.body).toMatchObject({ corePending: false, priceVersion: 2, priceCents: 900, moqMilli: q(50) });
    expect((await offer(reqA, s.id))!.block).toBeNull();
    await expect(ctx.sql`DELETE FROM mall_skus WHERE id = ${s.id}`).rejects.toThrow(/不能删除/);
  });

  it('能不能买：供应商没准入、价格过期、不适用这家门店', async () => {
    const other = Number((await ctx.sql<{ id: number }[]>`INSERT INTO stores (code, name, entity_id) VALUES ('S2', '第二家店', ${entityId}) RETURNING id`)[0]!.id);
    const onlyOther = await listed((await sku({ storeIds: [other] })).id);
    expect((await offer(reqA, onlyOther.id))!.block).toBe('store');
    const expired = await listed((await sku({ validUntil: shiftDate(today, -1) })).id);
    expect((await offer(reqA, expired.id))!.block).toBe('expired');
    const pendingSup = Number((await ctx.sql<{ id: number }[]>`INSERT INTO suppliers (code, name, admission) VALUES ('S-NEW', '待准入供应商', 'pending') RETURNING id`)[0]!.id);
    const noAdmit = await listed((await sku({ supplierId: pendingSup })).id);
    expect((await offer(reqA, noAdmit.id))!.block).toBe('supplier');
  });
});

describe('提交', () => {
  it('选品：一张需求单、来源商城、带 SKU 与价格版本、含税参考价、意向供应商；要主管确认的照规则', async () => {
    const s = await listed((await sku({ priceCents: 1000, taxRateBp: 1300, freightCents: 500 })).id);
    const r = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header(), kind: 'catalog', lines: [{ skuId: s.id, priceVersion: 1, qtyMilli: q(120) }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const req = r.body.request;
    expect(req).toMatchObject({ source: 'mall', priority: 'high', contactName: '王小明', budgetProject: '布草消耗预算' });
    expect(req.externalNo).toMatch(/^YZ-/);
    expect(req.lines[0]).toMatchObject({ materialId: mat.id, supplier: { id: supA }, priceVersion: 'V1', refPriceCents: 1130 });
    const checks = await requestChecks(ctx.sql);
    expect(checks[0]!.ok, checks[0]!.detail).toBe(true);
    // ERP 的填单页改不了商城的单
    const edit = await api(ctx.app, reqA, 'PUT', `/api/erp/requests/${req.id}`, { departmentId: null, needBy: null, priority: 'normal', note: '', lines: [] });
    expect(edit.body.error?.code ?? edit.body.error).toBeDefined();
    const edit2 = await api(ctx.app, reqA, 'PUT', `/api/erp/requests/${req.id}`, {
      departmentId: null,
      needBy: null,
      priority: 'normal',
      note: '',
      lines: [{ materialId: mat.id, name: 'x', purpose: '其他', qtyMilli: q(1), unit: '箱', imageIds: [] }],
    });
    expect(edit2.body.error.code).toBe('MALL_EDIT_IN_SHOP');
  });

  it('加清单以后改过价：PRICE_CHANGED；低于起订量：BELOW_MOQ；不能买：SKU_UNAVAILABLE；同一个操作编号原样重提给同一张', async () => {
    const s = await listed((await sku()).id);
    expect((await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header(), kind: 'catalog', lines: [{ skuId: s.id, priceVersion: 9, qtyMilli: q(100) }] })).body.error.code).toBe(
      'PRICE_CHANGED',
    );
    expect((await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header(), kind: 'catalog', lines: [{ skuId: s.id, priceVersion: 1, qtyMilli: q(10) }] })).body.error.code).toBe(
      'BELOW_MOQ',
    );
    await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${s.id}/disable`, {});
    expect((await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header(), kind: 'catalog', lines: [{ skuId: s.id, priceVersion: 1, qtyMilli: q(100) }] })).body.error.code).toBe(
      'SKU_UNAVAILABLE',
    );
    const ok = await listed((await sku()).id);
    const body = { ...header(), kind: 'catalog', lines: [{ skuId: ok.id, priceVersion: 1, qtyMilli: q(100) }] };
    const first = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', body);
    const again = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', body);
    expect(again.body).toMatchObject({ replayed: true, request: { id: first.body.request.id } });
    // 之后 SKU 停用了、物料改了名：原样重提照样认得是同一笔（先认操作编号，再按现在的 SKU 核对）
    await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${ok.id}/disable`, {});
    await ctx.sql`UPDATE materials SET name = name || '（新）' WHERE id = ${mat.id}`;
    const late = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', body);
    expect(late.status, JSON.stringify(late.body)).toBe(200);
    expect(late.body).toMatchObject({ replayed: true, request: { id: first.body.request.id } });
    // 同一个编号换了内容：拒绝
    expect((await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...body, note: '改了' })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 停用后重新上架：价格版本加 1，停用前加进清单的要重新确认
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${ok.id}/enable`, {})).body).toMatchObject({ status: 'pending', priceVersion: 2 });
  });

  it('自主申请：不要求链接与图片；理由、规格必填；链接要 http(s)', async () => {
    const line = { name: '定制工作服', expectedCategory: '', qtyMilli: q(20), unit: '套', details: '藏青色', brandModel: '', link: '', reasonText: '新员工入职', imageIds: [] };
    const r = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header({ priority: 'urgent' }), kind: 'custom', line });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.request.lines[0]).toMatchObject({ materialId: null, reasonText: '新员工入职', link: '' });
    expect((await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header(), kind: 'custom', line: { ...line, reasonText: '' } })).status).toBe(400);
    expect((await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header(), kind: 'custom', line: { ...line, link: 'ftp://x' } })).body.error.code).toBe('LINK_INVALID');
    expect((await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header({ needBy: shiftDate(today, -1) }), kind: 'custom', line })).body.error.code).toBe('NEED_BY_PAST');
    // 用途：可以选；不选的按「其他」，店里把「其他」去掉了就用用途清单第一项（不再一律 PURPOSE_INVALID）
    const chosen = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header({ purpose: '客用消耗' }), kind: 'custom', line });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(201);
    expect(chosen.body.request.lines[0].purpose).toBe('客用消耗');
    const [rules] = await ctx.sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'expense_rules'`;
    await ctx.sql`INSERT INTO settings (key, value) VALUES ('expense_rules', ${ctx.sql.json({ purposes: ['客用消耗', '办公用品'] })})
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    try {
      const fallback = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header(), kind: 'custom', line });
      expect(fallback.status, JSON.stringify(fallback.body)).toBe(201);
      expect(fallback.body.request.lines[0].purpose).toBe('客用消耗');
    } finally {
      if (rules) await ctx.sql`UPDATE settings SET value = ${ctx.sql.json(rules.value as Parameters<typeof ctx.sql.json>[0])} WHERE key = 'expense_rules'`;
      else await ctx.sql`DELETE FROM settings WHERE key = 'expense_rules'`;
    }
  });
});

describe('我的需求与需求池', () => {
  it('部门只看自己的；采购看需求池；需求池部门申购进不去', async () => {
    const mine = (await api(ctx.app, reqA, 'GET', '/api/erp/shop/requests?scope=mine')).body.requests as { id: number; department: { id: number } }[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.department.id === deptA)).toBe(true);
    expect(((await api(ctx.app, reqB, 'GET', '/api/erp/shop/requests?scope=mine')).body.requests as unknown[]).length).toBe(0);
    expect((await api(ctx.app, reqB, 'GET', `/api/erp/shop/requests/${mine[0]!.id}`)).status).toBe(404);
    expect((await api(ctx.app, reqA, 'GET', '/api/erp/shop/requests?scope=pool')).status).toBe(403);
    const pool = (await api(ctx.app, buyer, 'GET', '/api/erp/shop/requests?scope=pool')).body.requests as { id: number }[];
    expect(pool.length).toBeGreaterThanOrEqual(mine.length);
  });
});

describe('SKU 的边界（Codex 审查）', () => {
  it('我的采购需求一页页取（从新到旧，不重不漏）；紧急程度在服务端先筛再分页', async () => {
    const line = { name: '分页测试', expectedCategory: '', qtyMilli: q(1), unit: '个', details: 'x', brandModel: '', link: '', reasonText: 'x', imageIds: [] };
    for (const priority of ['urgent', 'normal', 'normal']) {
      expect((await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header({ priority }), kind: 'custom', line })).status).toBe(201);
    }
    const all = (await api(ctx.app, reqA, 'GET', '/api/erp/shop/requests?scope=mine&limit=100')).body.requests as { id: number }[];
    const seen: number[] = [];
    let before: number | null = null;
    for (let i = 0; i < 100; i += 1) {
      const page = (await api(ctx.app, reqA, 'GET', `/api/erp/shop/requests?scope=mine&limit=1${before ? `&beforeId=${before}` : ''}`)).body as {
        requests: { id: number }[];
        nextBeforeId: number | null;
      };
      seen.push(...page.requests.map((r) => r.id));
      before = page.nextBeforeId;
      if (!before) break;
    }
    expect(seen).toEqual(all.map((r) => r.id));
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
    const urgent = (await api(ctx.app, reqA, 'GET', '/api/erp/shop/requests?scope=mine&priority=urgent&limit=1')).body.requests as { priority: string }[];
    expect(urgent).toHaveLength(1);
    expect(urgent[0]!.priority).toBe('urgent');
  });

  it('只能给自己能去的门店提（Codex 安全审查）：目录只列这些门店，提交别的门店 403', async () => {
    const [entity] = await ctx.sql<{ entityId: number }[]>`SELECT entity_id FROM stores WHERE id = ${storeId}`;
    const [other] = await ctx.sql<{ id: number }[]>`INSERT INTO stores (code, name, entity_id) VALUES ('SHOPB', '商城测试分店', ${entity!.entityId}) RETURNING id`;
    const [me] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'shop_a'`;
    await ctx.sql`INSERT INTO staff_stores (staff_id, store_id) VALUES (${me!.id}, ${storeId}) ON CONFLICT DO NOTHING`;
    const stores = (await catalog(reqA)).stores as { id: number }[];
    expect(stores.map((s) => s.id)).not.toContain(Number(other!.id));
    const line = { name: '跨店', expectedCategory: '', qtyMilli: q(1), unit: '个', details: 'x', brandModel: '', link: '', reasonText: 'x', imageIds: [] };
    const r = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header({ storeId: Number(other!.id) }), kind: 'custom', line });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    // 店主哪家都能提
    expect(((await catalog(boss)).stores as { id: number }[]).map((s) => s.id)).toContain(Number(other!.id));
  });

  it('有待审改动时不能停用（不然旧改动会套到改过的报价上）；选物料、供应商的接口给 SKU 维护的人', async () => {
    const s = await listed((await sku()).id);
    const ch = await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${s.id}/changes`, {
      priceCents: 900,
      taxRateBp: 1300,
      moqMilli: q(100),
      freightCents: 0,
      validUntil: shiftDate(today, 365),
      storeIds: [],
      reason: '涨价',
    });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${s.id}/disable`, {})).body.error.code).toBe('SKU_CHANGE_PENDING');
    const master = await api(ctx.app, buyer, 'GET', '/api/erp/shop/master');
    expect(master.status).toBe(200);
    expect(master.body.materials.some((m: { id: number }) => m.id === mat.id)).toBe(true);
    expect((await api(ctx.app, reqA, 'GET', '/api/erp/shop/master')).status).toBe(403);
  });

  it('带版本号的操作：上一次已经生效、再点一次被拒（SKU_CHANGED），不重复生效', async () => {
    const s = await sku();
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${s.id}/submit`, { version: s.version })).status).toBe(200);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${s.id}/submit`, { version: s.version })).body.error.code).toBe('SKU_CHANGED');
  });

  it('含税单价超过 100 万元：建、改、提改动都拒（不然上架了也提交不了）', async () => {
    const r = await api(ctx.app, buyer, 'POST', '/api/erp/shop/skus', {
      materialId: mat.id,
      supplierId: supA,
      skuCode: `SKU-${randomUUID().slice(0, 8)}`,
      priceCents: 100_000_000,
      taxRateBp: 1300,
      moqMilli: q(1),
      leadDays: 1,
      freightCents: 0,
      validUntil: shiftDate(today, 30),
      storeIds: [],
    });
    expect(r.body.error.code).toBe('SKU_PRICE_TOO_HIGH');
  });

  it('物料的采购单位改了：已上架的报价暂停采购（按旧单位报的价不能当新单位提交）；重新上架审核后按新单位', async () => {
    const s = await listed((await sku()).id);
    expect((await offer(reqA, s.id))!.block).toBeNull();
    const [m] = await ctx.sql<{ purchaseUnit: string }[]>`SELECT purchase_unit FROM materials WHERE id = ${mat.id}`;
    await ctx.sql`UPDATE materials SET purchase_unit = '包' WHERE id = ${mat.id}`;
    try {
      expect((await offer(reqA, s.id))!.block).toBe('unit');
      const r = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header(), kind: 'catalog', lines: [{ skuId: s.id, priceVersion: s.priceVersion, qtyMilli: q(100) }] });
      expect(r.body.error.code).toBe('SKU_UNAVAILABLE');
      // 停用 → 重新上架（价格版本加一）→ 审核：按新单位
      await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${s.id}/disable`, {});
      await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${s.id}/enable`, {});
      expect((await api(ctx.app, boss, 'POST', `/api/erp/shop/skus/${s.id}/approve`, {})).status).toBe(200);
      const again = (await offer(reqA, s.id))!;
      expect(again.block).toBeNull();
      expect(again.priceVersion).toBe(s.priceVersion + 1);
    } finally {
      await ctx.sql`UPDATE materials SET purchase_unit = ${m!.purchaseUnit} WHERE id = ${mat.id}`;
    }
  });

  it('比价接口 GET /api/erp/shop/offers：服务端计算可采购与阻断原因（含 below_moq），受门店范围保护，空物料返回空态', async () => {
    const sFree = await listed((await sku({ supplierId: supA, priceCents: 1000, taxRateBp: 1300, freightCents: 0, moqMilli: q(10), leadDays: 5 })).id);
    const sHighMoq = await listed((await sku({ supplierId: supB, priceCents: 900, taxRateBp: 1300, freightCents: 0, moqMilli: q(50), leadDays: 3 })).id);
    const r = await api(ctx.app, reqA, 'GET', `/api/erp/shop/offers?materialId=${mat.id}&qtyMilli=${q(10)}&storeId=${storeId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const offers = r.body.offers as { skuId: number; purchasable: boolean; blockReason: string | null; totalCents: number }[];
    const freeRow = offers.find((o) => o.skuId === sFree.id)!;
    const moqRow = offers.find((o) => o.skuId === sHighMoq.id)!;
    expect(freeRow).toMatchObject({ purchasable: true, blockReason: null, totalCents: 11_300 });
    expect(moqRow).toMatchObject({ purchasable: false, blockReason: 'below_moq', totalCents: 10_170 });
    // 提高到 50：高起订量行解锁
    const r50 = await api(ctx.app, reqA, 'GET', `/api/erp/shop/offers?materialId=${mat.id}&qtyMilli=${q(50)}&storeId=${storeId}`);
    expect((r50.body.offers as { skuId: number; purchasable: boolean; blockReason: string | null }[]).find((o) => o.skuId === sHighMoq.id)).toMatchObject({
      purchasable: true,
      blockReason: null,
    });
    // 越权门店 403
    const [otherStore] = await ctx.sql<{ id: number }[]>`SELECT id FROM stores WHERE id <> ${storeId} LIMIT 1`;
    if (otherStore) {
      expect((await api(ctx.app, reqA, 'GET', `/api/erp/shop/offers?materialId=${mat.id}&storeId=${otherStore.id}`)).status).toBe(403);
    }
    // 不存在的物料返回空态
    const empty = await api(ctx.app, reqA, 'GET', `/api/erp/shop/offers?materialId=999999&storeId=${storeId}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ material: null, offers: [], recommendedSkuId: null });
  });

  it('供应商档案（FR-03）：准入状态与 SKU 拦截一致、字段级权限隐藏联系人/电话、受控编辑不碰收款账户', async () => {
    // 只有 purchase.rules 没有 purchase.manage / inventory.master 的审核员：能看档案，但联系人与电话为 null（前端显示「联系采购获取」）
    await createStaff(ctx.sql, { username: 'shop_rules_only', displayName: '规则审核员', role: 'backoffice', duties: [], password: PASSWORD, mustChangePassword: false });
    await ctx.sql`UPDATE staff SET permission_adjust = ${ctx.sql.json({ add: ['purchase.rules'], remove: [] })} WHERE username = 'shop_rules_only'`;
    const rulesOnly = await login(ctx.app, 'shop_rules_only');

    // 普通申购人无权访问
    expect((await api(ctx.app, reqA, 'GET', '/api/erp/shop/suppliers')).status).toBe(403);
    expect((await api(ctx.app, reqA, 'GET', `/api/erp/shop/suppliers/${supA}`)).status).toBe(403);

    // 规则审核员看列表与详情：联系人/电话脱敏，不能编辑
    const rListMasked = await api(ctx.app, rulesOnly, 'GET', '/api/erp/shop/suppliers');
    expect(rListMasked.status, JSON.stringify(rListMasked.body)).toBe(200);
    const maskedSup = (rListMasked.body as { id: number; contact: string | null; phone: string | null; admission: string }[]).find((s) => s.id === supA)!;
    expect(maskedSup.contact).toBeNull();
    expect(maskedSup.phone).toBeNull();
    expect(maskedSup.admission).toBe('approved');
    expect((await api(ctx.app, rulesOnly, 'PUT', `/api/erp/shop/suppliers/${supA}`, { clientKey: randomUUID(), note: '越权' })).status).toBe(403);
    // 缺操作编号拒绝 400
    expect((await api(ctx.app, boss, 'PUT', `/api/erp/shop/suppliers/${supA}`, { note: '缺编号' })).status).toBe(400);

    // 有档案权限的店主修改联系人与备注，且不影响收款账户；重提同一操作编号不覆盖后续更新、不重复审计
    const [origSup] = await ctx.sql<{ contact: string; phone: string; note: string; bankAccount: string }[]>`SELECT contact, phone, note, bank_account FROM suppliers WHERE id = ${supA}`;
    try {
      const k1 = randomUUID();
      const patched = await api(ctx.app, boss, 'PUT', `/api/erp/shop/suppliers/${supA}`, { clientKey: k1, contact: '张联络', phone: '13800138000', note: '商城档案备注' });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(patched.body).toMatchObject({ id: supA, contact: '张联络', phone: '13800138000', note: '商城档案备注' });
      const [afterSup] = await ctx.sql<{ bankAccount: string }[]>`SELECT bank_account FROM suppliers WHERE id = ${supA}`;
      expect(afterSup!.bankAccount).toBe(origSup!.bankAccount);

      // 查回结果可用
      const lookup = await api(ctx.app, boss, 'GET', `/api/erp/ops/${k1}?type=shop_master`);
      expect(lookup.status, JSON.stringify(lookup.body)).toBe(200);
      expect(lookup.body).toMatchObject({ found: true, abandoned: false, refId: supA });

      // 另一笔新操作把备注更新成新值，随后旧操作编号 k1 晚到重提：不覆盖新值且不追加第二条审计
      const k2 = randomUUID();
      expect((await api(ctx.app, boss, 'PUT', `/api/erp/shop/suppliers/${supA}`, { clientKey: k2, note: '更新后的备注' })).status).toBe(200);
      const [auditBefore] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE target_type = 'supplier' AND target_id = ${String(supA)}`;
      const replay = await api(ctx.app, boss, 'PUT', `/api/erp/shop/suppliers/${supA}`, { clientKey: k1, contact: '张联络', phone: '13800138000', note: '商城档案备注' });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.note).toBe('更新后的备注');
      const [auditAfter] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE target_type = 'supplier' AND target_id = ${String(supA)}`;
      expect(auditAfter!.n).toBe(auditBefore!.n);

      // 同编号不同内容拒绝 409
      expect((await api(ctx.app, boss, 'PUT', `/api/erp/shop/suppliers/${supA}`, { clientKey: k1, note: '篡改内容' })).status).toBe(409);

      // 先确认作废再晚到的原请求被拦（OP_ABANDONED），数据库值不被修改
      const kAbandon = randomUUID();
      const ab = await api(ctx.app, boss, 'POST', `/api/erp/ops/${kAbandon}/abandon`, { type: 'shop_master', summary: '作废供应商修改' });
      expect(ab.status, JSON.stringify(ab.body)).toBe(200);
      expect(ab.body).toMatchObject({ found: false, abandoned: true });
      const blockedLate = await api(ctx.app, boss, 'PUT', `/api/erp/shop/suppliers/${supA}`, { clientKey: kAbandon, note: '不应生效' });
      expect(blockedLate.status).toBe(409);
      expect(blockedLate.body.error.code).toBe('OP_ABANDONED');
      const [checkSup] = await ctx.sql<{ note: string }[]>`SELECT note FROM suppliers WHERE id = ${supA}`;
      expect(checkSup!.note).toBe('更新后的备注');

      // 准入状态改为 pending 时，档案页与目录 SKU 的阻断原因同源一致
      const s = await listed((await sku({ supplierId: supA })).id);
      await ctx.sql`UPDATE suppliers SET admission = 'pending' WHERE id = ${supA}`;
      const det = await api(ctx.app, buyer, 'GET', `/api/erp/shop/suppliers/${supA}`);
      expect(det.status).toBe(200);
      expect(det.body.admission).toBe('pending');
      expect((await offer(reqA, s.id))!.block).toBe('supplier');
    } finally {
      await ctx.sql`UPDATE suppliers SET admission = 'approved', contact = ${origSup!.contact}, phone = ${origSup!.phone}, note = ${origSup!.note} WHERE id = ${supA}`;
    }
  });

  it('集团物料主档（FR-04）：停用后商城与比价立即不可见、历史需求单仍可查，支持批量改分类且带操作编号防重', async () => {
    const s = await listed((await sku({ supplierId: supA, moqMilli: q(10) })).id);
    const created = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header(), kind: 'catalog', lines: [{ skuId: s.id, priceVersion: s.priceVersion, qtyMilli: q(10) }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const reqId = created.body.request.id as number;

    const [origMat] = await ctx.sql<{ category: string; note: string; active: boolean }[]>`SELECT category, note, active FROM materials WHERE id = ${mat.id}`;
    try {
      // 普通员工不能看/改物料主档
      expect((await api(ctx.app, reqA, 'GET', '/api/erp/shop/materials')).status).toBe(403);
      expect((await api(ctx.app, reqA, 'PUT', `/api/erp/shop/materials/${mat.id}`, { clientKey: randomUUID(), active: false })).status).toBe(403);
      expect((await api(ctx.app, reqA, 'POST', '/api/erp/shop/materials/batch-category', { clientKey: randomUUID(), materialIds: [mat.id], category: '测试类' })).status).toBe(403);

      // 停用物料
      const matKey1 = randomUUID();
      const dis = await api(ctx.app, boss, 'PUT', `/api/erp/shop/materials/${mat.id}`, { clientKey: matKey1, active: false, note: '停用测试' });
      expect(dis.status, JSON.stringify(dis.body)).toBe(200);
      expect(dis.body).toMatchObject({ id: mat.id, active: false, note: '停用测试' });

      // 商城目录与比价接口立即不可见
      const cat = await catalog(reqA);
      expect((cat.items as { material: { id: number } }[]).some((i) => i.material.id === mat.id)).toBe(false);
      const off = await api(ctx.app, reqA, 'GET', `/api/erp/shop/offers?materialId=${mat.id}&storeId=${storeId}`);
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ material: null, offers: [] });

      // 已提交历史需求单仍正常可读
      const histReq = await api(ctx.app, reqA, 'GET', `/api/erp/shop/requests/${reqId}`);
      expect(histReq.status, JSON.stringify(histReq.body)).toBe(200);
      expect(histReq.body.id).toBe(reqId);

      // 恢复启用后，旧操作编号 matKey1 晚到重提不会把物料再停用回去
      expect((await api(ctx.app, boss, 'PUT', `/api/erp/shop/materials/${mat.id}`, { clientKey: randomUUID(), active: true })).status).toBe(200);
      const lateDisable = await api(ctx.app, boss, 'PUT', `/api/erp/shop/materials/${mat.id}`, { clientKey: matKey1, active: false, note: '停用测试' });
      expect(lateDisable.status, JSON.stringify(lateDisable.body)).toBe(200);
      expect(lateDisable.body.active).toBe(true);

      // 批量改分类：带操作编号，同编号重提不覆盖后续新分类
      const batchKey = randomUUID();
      const batch = await api(ctx.app, boss, 'POST', '/api/erp/shop/materials/batch-category', { clientKey: batchKey, materialIds: [mat.id], category: '批量测试类' });
      expect(batch.status, JSON.stringify(batch.body)).toBe(200);
      expect(batch.body).toMatchObject({ id: mat.id, updated: 1 });
      expect((await api(ctx.app, boss, 'PUT', `/api/erp/shop/materials/${mat.id}`, { clientKey: randomUUID(), category: '后续新类' })).status).toBe(200);
      const batchReplay = await api(ctx.app, boss, 'POST', '/api/erp/shop/materials/batch-category', { clientKey: batchKey, materialIds: [mat.id], category: '批量测试类' });
      expect(batchReplay.status, JSON.stringify(batchReplay.body)).toBe(200);
      expect(batchReplay.body).toMatchObject({ id: mat.id, updated: 1 });
      const mats = await api(ctx.app, buyer, 'GET', '/api/erp/shop/materials');
      expect((mats.body as { id: number; category: string }[]).find((m) => m.id === mat.id)!.category).toBe('后续新类');
    } finally {
      await ctx.sql`UPDATE materials SET category = ${origMat!.category}, note = ${origMat!.note}, active = ${origMat!.active} WHERE id = ${mat.id}`;
    }
  });

  it('审批路由预览（FR-02）：预计节点与提交后真实流转一致、含紧急程度免责与待寻源标注、越权门店 403', async () => {
    const headId = await createStaff(ctx.sql, {
      username: 'shop_head_e',
      displayName: '运营部门主管',
      role: 'backoffice',
      duties: ['request'],
      departmentId: deptA,
      password: PASSWORD,
      mustChangePassword: false,
    });
    await ctx.sql`UPDATE departments SET head_id = ${headId} WHERE id = ${deptA}`;
    try {
      const s = await listed((await sku({ supplierId: supA, moqMilli: q(10), priceCents: 1200, taxRateBp: 1300, freightCents: 0 })).id);
      // 1) 正常目录单预览：部门主管确认 active、含紧急程度说明
      const preview = await api(ctx.app, reqA, 'GET', `/api/erp/shop/route-preview?storeId=${storeId}&kind=catalog&priority=normal&paymentIntent=dept_petty&lines=${s.id}:${q(10)}`);
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      const nodes = preview.body.nodes as { key: string; status: string; role: string }[];
      const hints = preview.body.hints as { code: string; text: string }[];
      expect(nodes.find((n) => n.key === 'dept_confirm')).toMatchObject({ status: 'active', role: '运营部门主管' });
      expect(hints.some((h) => h.code === 'urgency_rule' && h.text.includes('紧急程度仅用于排序，不构成紧急特批'))).toBe(true);
      expect(hints.some((h) => h.code === 'petty_cash')).toBe(true);
      expect(preview.body.hasUnpriced).toBe(false);

      // 真实提交同一单：流转首节点与预览完全一致（待主管确认）
      const submitted = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', {
        ...header({ priority: 'normal', paymentIntent: 'dept_petty' }),
        kind: 'catalog',
        lines: [{ skuId: s.id, priceVersion: s.priceVersion, qtyMilli: q(10) }],
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
      expect(submitted.body.request.deptConfirm).toMatchObject({ state: 'pending', headName: '运营部门主管' });
      expect(submitted.body.request.displayStatus).toBe('dept_pending');

      // 提交完一单后再次预览同供应商：给出同日同供应商累计合并提示
      const secondPreview = await api(ctx.app, reqA, 'GET', `/api/erp/shop/route-preview?storeId=${storeId}&kind=catalog&priority=urgent&lines=${s.id}:${q(10)}`);
      expect(secondPreview.status).toBe(200);
      expect((secondPreview.body.nodes as { key: string; status: string }[]).find((n) => n.key === 'stock_check')?.status).toBe('skipped');
      expect((secondPreview.body.hints as { code: string }[]).some((h) => h.code === 'same_day_merge')).toBe(true);

      // 2) 自主申请预览：标注待寻源、金额待定
      const customPreview = await api(ctx.app, reqA, 'GET', `/api/erp/shop/route-preview?storeId=${storeId}&kind=custom&priority=high`);
      expect(customPreview.status).toBe(200);
      expect(customPreview.body.hasUnpriced).toBe(true);
      expect(customPreview.body.estimateCents).toBeNull();
      expect((customPreview.body.hints as { code: string; text: string }[]).some((h) => h.code === 'unpriced_custom' && h.text.includes('待寻源，金额待定'))).toBe(true);

      // 3) 越权门店 403
      const [otherStore] = await ctx.sql<{ id: number }[]>`SELECT id FROM stores WHERE id <> ${storeId} LIMIT 1`;
      if (otherStore) {
        expect((await api(ctx.app, reqA, 'GET', `/api/erp/shop/route-preview?storeId=${otherStore.id}&kind=custom`)).status).toBe(403);
      }
    } finally {
      await ctx.sql`UPDATE departments SET head_id = NULL WHERE id = ${deptA}`;
    }
  });

  it('供应链后台总览（FR-05 & FR-10）：统计计数与各列表实际条数一致，待办汇总准确', async () => {
    // 普通申购人无权查看后台总览
    expect((await api(ctx.app, reqA, 'GET', '/api/erp/shop/overview')).status).toBe(403);

    // 建一条待审核 SKU，验证待办计数包含它
    const pendingSku = await sku();
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/skus/${pendingSku.id}/submit`, {})).status).toBe(200);

    const [ov, mats, sups, skus] = await Promise.all([
      api(ctx.app, buyer, 'GET', '/api/erp/shop/overview'),
      api(ctx.app, buyer, 'GET', '/api/erp/shop/materials'),
      api(ctx.app, buyer, 'GET', '/api/erp/shop/suppliers'),
      api(ctx.app, buyer, 'GET', '/api/erp/shop/skus'),
    ]);
    expect(ov.status, JSON.stringify(ov.body)).toBe(200);
    const counts = ov.body.counts as {
      materials: number;
      suppliers: number;
      activeSkus: number;
      pendingSkus: number;
      pendingSkuChanges: number;
      pendingSuppliers: number;
      totalTodos: number;
    };
    expect(counts.materials).toBe((mats.body as unknown[]).length);
    expect(counts.suppliers).toBe((sups.body as unknown[]).length);
    expect(counts.activeSkus).toBe((skus.body as { status: string }[]).filter((k) => k.status === 'approved').length);
    expect(counts.pendingSkus).toBeGreaterThanOrEqual(1);
    expect(counts.totalTodos).toBe(counts.pendingSkus + counts.pendingSkuChanges + counts.pendingSuppliers);
  });

  it('我的需求增强与导出（FR-08 & FR-11）：状态分组/关键词/日期筛选分页准确、导出 CSV 条数与金额单位一致、详情带服务端节点时间与操作人', async () => {
    const tag = `EXPORT-${randomUUID().slice(0, 6)}`;
    const line = { name: `${tag} 专用定制件`, expectedCategory: '', qtyMilli: q(2), unit: '套', details: '规格要求', brandModel: '', link: '', reasonText: 'FR-08测试', imageIds: [] };
    const created = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header({ budgetProject: tag }), kind: 'custom', line });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const reqId = created.body.request.id as number;
    const docNo = created.body.request.docNo as string;

    // 1) 关键词 + 日期 + 状态分组（进行中）筛选命中且分页准确
    const activeHit = await api(ctx.app, reqA, 'GET', `/api/erp/shop/requests?scope=mine&group=active&q=${encodeURIComponent(tag)}&from=${today}&to=${today}`);
    expect(activeHit.status, JSON.stringify(activeHit.body)).toBe(200);
    expect((activeHit.body.requests as { id: number }[]).map((r) => r.id)).toEqual([reqId]);
    expect(activeHit.body.nextBeforeId).toBeNull();

    // 另一状态分组（已终止）不包含该单
    const endedMiss = await api(ctx.app, reqA, 'GET', `/api/erp/shop/requests?scope=mine&group=ended&q=${encodeURIComponent(tag)}`);
    expect(endedMiss.status).toBe(200);
    expect(endedMiss.body.requests).toHaveLength(0);

    // 开始日期晚于结束日期 400
    expect((await api(ctx.app, reqA, 'GET', `/api/erp/shop/requests?scope=mine&from=${shiftDate(today, 2)}&to=${today}`)).status).toBe(400);

    // 2) FR-11 导出当前筛选结果：条数与列表一致，包含单号与表头；需求池权限隔离
    const expRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/erp/shop/requests/export?scope=mine&group=active&q=${encodeURIComponent(tag)}`,
      headers: { cookie: reqA },
    });
    expect(expRes.statusCode).toBe(200);
    expect(expRes.headers['content-type']).toContain('text/csv');
    const lines = expRes.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('需求单号,门店,部门,预估金额（元）,状态,紧急程度,更新时间,摘要');
    expect(lines[1]).toContain(docNo);
    // 普通申购人无权导出需求池
    expect((await api(ctx.app, reqA, 'GET', '/api/erp/shop/requests/export?scope=pool')).status).toBe(403);

    // 3) 采购审核通过后，详情页 timeline 带真实服务端时间戳与操作人
    const approved = await api(ctx.app, buyer, 'POST', `/api/erp/requests/${reqId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const det = await api(ctx.app, reqA, 'GET', `/api/erp/shop/requests/${reqId}`);
    expect(det.status).toBe(200);
    const timeline = det.body.timeline as { key: string; done: boolean; at: string | null; actorName: string | null }[];
    expect(timeline.find((n) => n.key === 'submit')).toMatchObject({ done: true, actorName: '运营部申购' });
    expect(timeline.find((n) => n.key === 'submit')!.at).toBeTruthy();
    expect(timeline.find((n) => n.key === 'review')).toMatchObject({ done: true });
    expect(timeline.find((n) => n.key === 'review')!.at).toBeTruthy();
    expect(timeline.find((n) => n.key === 'review')!.actorName).toBeTruthy();
  });

  it('到货节点时间线读取已确认入库单，且稀疏状态分组扫满本轮上限时保留续取游标不截断', async () => {
    const tag = `RECV-${randomUUID().slice(0, 6)}`;
    const s = await listed((await sku({ supplierId: supA, moqMilli: q(1) })).id);
    // 先创建一张较老的「进行中」需求单
    const olderActive = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', {
      ...header({ budgetProject: tag }),
      kind: 'catalog',
      lines: [{ skuId: s.id, priceVersion: s.priceVersion, qtyMilli: q(1) }],
    });
    expect(olderActive.status, JSON.stringify(olderActive.body)).toBe(201);
    const olderActiveId = olderActive.body.request.id as number;

    // 再创建一张更新的需求单，走完审核 → 下单 → 确认全量收货（变为 received，归入 done 组而非 active 组）
    const newerDone = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', {
      ...header({ budgetProject: tag }),
      kind: 'catalog',
      lines: [{ skuId: s.id, priceVersion: s.priceVersion, qtyMilli: q(1) }],
    });
    expect(newerDone.status, JSON.stringify(newerDone.body)).toBe(201);
    const doneId = newerDone.body.request.id as number;
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${doneId}/approve`, {})).status).toBe(200);
    const reqDetail = await api(ctx.app, buyer, 'GET', `/api/erp/requests/${doneId}`);
    const reqLineId = reqDetail.body.lines[0].id as number;

    const poRes = await api(ctx.app, boss, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId: supA,
      orderDate: today,
      action: 'save',
      lines: [{ materialId: mat.id, purchaseQtyMilli: q(1), priceCents: 1000, requestLineIds: [reqLineId] }],
    });
    expect(poRes.status, JSON.stringify(poRes.body)).toBe(201);
    const po = poRes.body.po;
    expect((await api(ctx.app, boss, 'POST', `/api/purchase-orders/${po.id}/submit`, {})).status).toBe(200);
    await api(ctx.app, boss, 'POST', `/api/purchase-orders/${po.id}/approve`, {});
    const freshPo = (await api(ctx.app, boss, 'GET', `/api/purchase-orders/${po.id}`)).body;
    const [buyerRow] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`;
    const recQty = Number(freshPo.lines[0].baseQtyMilli);
    const rec = await api(ctx.app, boss, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId: supA,
      purchaseOrderId: po.id,
      coAcceptorId: Number(buyerRow!.id),
      lines: [{ materialId: mat.id, poLineId: freshPo.lines[0].id, deliveredMilli: recQty, acceptedMilli: recQty }],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const recDoc = rec.body.doc;
    if (recDoc.status !== 'confirmed') {
      const confirmed = await api(ctx.app, boss, 'POST', `/api/inventory/docs/${recDoc.id}/approve`, {});
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    }

    // 1) 到货节点必须命中 confirmed 入库单并带上确认时间与操作人
    const det = await api(ctx.app, reqA, 'GET', `/api/erp/shop/requests/${doneId}`);
    expect(det.status, JSON.stringify(det.body)).toBe(200);
    expect(det.body.displayStatus).toBe('received');
    const timeline = det.body.timeline as { key: string; done: boolean; at: string | null; actorName: string | null }[];
    const receiveNode = timeline.find((n) => n.key === 'receive')!;
    expect(receiveNode.done).toBe(true);
    expect(receiveNode.at).toBeTruthy();
    expect(receiveNode.actorName).toBeTruthy();

    // 2) 稀疏分组扫满本轮上限（chunkSize=1, maxRounds=1）：第 1 页只扫到最新的 received 单（通过 SQL approved 粗筛但被 active 组排除），
    //    仍必须返回 nextBeforeId = doneId，而不是 null；续翻下一页即可命中较老的 olderActiveId
    const [bossStaff] = await ctx.sql<{ id: number; username: string; displayName: string; role: 'owner'; departmentId: number | null }[]>`
      SELECT id, username, display_name, role, department_id FROM staff WHERE username = 'linlan'`;
    const bossActor = {
      id: Number(bossStaff!.id),
      username: bossStaff!.username,
      displayName: bossStaff!.displayName,
      role: bossStaff!.role,
      duties: [],
      permissions: ['request.review' as const],
      mustChangePassword: false,
      storeId,
      departmentId: bossStaff!.departmentId,
    };
    const deps = { sql: ctx.sql, config: ctx.config };
    const p1 = await pagedMall(deps, bossActor, { group: 'active', q: tag, limit: 10 }, { mineOnly: false, maxRounds: 1, chunkSize: 1 });
    expect(p1.requests).toHaveLength(0);
    expect(p1.nextBeforeId).toBe(doneId);

    const p2 = await pagedMall(deps, bossActor, { group: 'active', q: tag, beforeId: p1.nextBeforeId, limit: 10 }, { mineOnly: false, maxRounds: 1, chunkSize: 1 });
    expect(p2.requests.map((r) => r.id)).toEqual([olderActiveId]);
  });
});

describe('商品图（8.1.50，迁移 510）', () => {
  const png = (n: number) => {
    // 1×1 PNG，末尾补几个字节让内容各不相同（按内容去重）
    const base = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    return Buffer.concat([base, Buffer.alloc(n, 7)]).toString('base64');
  };
  const upload = async (cookie: string, n: number) => {
    const r = await api(ctx.app, cookie, 'POST', '/api/erp/images', { mime: 'image/png', data: png(n) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const put = (cookie: string, imageIds: number[], expectedImageIds: number[], clientKey = randomUUID()) =>
    api(ctx.app, cookie, 'PUT', `/api/erp/shop/materials/${mat.id}/images`, { imageIds, expectedImageIds, clientKey });

  it('物料主档整组换商品图：目录、比价、主档都带上；部门申购能看；别人先改过拒绝；不是商品图的图片取不到', async () => {
    const s = await sku();
    await listed(s.id);
    const a = await upload(boss, 1);
    const b = await upload(boss, 2);
    // 部门申购不能改主档
    expect((await put(reqA, [a], [])).status).toBe(403);
    const key = randomUUID();
    const set = await put(boss, [a, b], [], key);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.imageIds).toEqual([a, b]);
    // 原样重提（同一个编号）：结果一样；同一个编号换了内容：拒绝
    expect((await put(boss, [a, b], [], key)).body.imageIds).toEqual([a, b]);
    expect((await put(boss, [a], [], key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 看到的已经过时：拒绝
    expect((await put(boss, [b], [])).body.error.code).toBe('IMAGES_CHANGED');
    // 目录、比价、主档
    const item = ((await catalog(reqA)).items as { material: { id: number; imageIds: number[] } }[]).find((i) => i.material.id === mat.id)!;
    expect(item.material.imageIds).toEqual([a, b]);
    const cmp = await api(ctx.app, reqA, 'GET', `/api/erp/shop/offers?materialId=${mat.id}&storeId=${storeId}`);
    expect(cmp.body.material.imageIds).toEqual([a, b]);
    const master = (await api(ctx.app, boss, 'GET', '/api/erp/shop/materials')).body as { id: number; imageIds: number[] }[];
    expect(master.find((m) => m.id === mat.id)!.imageIds).toEqual([a, b]);
    // 部门申购（只能看自己传的需求单图片）照样能看商品图
    const img = await ctx.app.inject({ method: 'GET', url: `/api/erp/shop/images/${a}`, headers: { cookie: reqB } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    // 没挂在物料上的图片：这个地址取不到
    const loose = await upload(reqA, 3);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/erp/shop/images/${loose}`, headers: { cookie: reqB } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/erp/shop/images/${a}` })).statusCode).toBe(401);
    // 换顺序（封面换成 b）、清空
    expect((await put(boss, [b, a], [a, b])).body.imageIds).toEqual([b, a]);
    expect((await put(boss, [a, a], [b, a])).status).toBe(400);
    expect((await put(boss, [], [b, a])).body.imageIds).toEqual([]);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/erp/shop/images/${a}`, headers: { cookie: reqB } })).statusCode).toBe(404);
    // 回复丢了的那一笔晚到（Codex 审查）：之后别人改回了空的，原样重提不会把图又放回去
    const lost = randomUUID();
    expect((await put(boss, [a], [], lost)).body.imageIds).toEqual([a]);
    expect((await put(boss, [], [a])).body.imageIds).toEqual([]);
    expect((await put(boss, [a], [], lost)).body.imageIds).toEqual([]);
  });
});

describe('原单补资料（8.1.51，Codex 审查）', () => {
  it('选品的行改了数量：按 SKU 的起订量再核一遍（BELOW_MOQ），够了才能重提', async () => {
    const s = await listed((await sku()).id);
    const r = await api(ctx.app, reqA, 'POST', '/api/erp/shop/requests', { ...header(), kind: 'catalog', lines: [{ skuId: s.id, priceVersion: 1, qtyMilli: q(120) }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const req = r.body.request as { id: number; lines: { id: number }[] };
    expect(
      (await api(ctx.app, boss, 'POST', `/api/erp/requests/${req.id}/return`, { reason: '数量再核一下', fixItems: [{ lineId: req.lines[0]!.id, field: 'qty', requirement: '数量再核一下' }] })).status,
    ).toBe(200);
    const back = (await api(ctx.app, reqA, 'GET', `/api/erp/shop/requests/${req.id}`)).body as { updatedAt: string };
    const body = (qtyMilli: number) => ({
      clientKey: randomUUID(),
      expectedUpdatedAt: back.updatedAt,
      contactName: '王小明',
      budgetProject: '布草消耗预算',
      needBy: shiftDate(today, 3),
      deliveryAddress: '本店布草仓',
      priority: 'high',
      remark: '改了数量',
      lines: [{ id: req.lines[0]!.id, qtyMilli }],
    });
    expect((await api(ctx.app, reqA, 'PUT', `/api/erp/shop/requests/${req.id}/resubmit`, body(q(10)))).body.error.code).toBe('BELOW_MOQ');
    const ok = await api(ctx.app, reqA, 'PUT', `/api/erp/shop/requests/${req.id}/resubmit`, body(q(100)));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.lines[0]).toMatchObject({ qtyMilli: q(100) });
  });
});

describe('部门日额度（8.1.55，店主 K27-4「用 1 万」）', () => {
  it('拟用部门备用金：预览照业财法部门日额度提示；累计超过 1 万的不能提交，公司直付不受限', async () => {
    const s = await listed((await sku({ priceCents: 5000, taxRateBp: 0, moqMilli: q(1) })).id);
    const lines = [{ skuId: s.id, priceVersion: s.priceVersion, qtyMilli: q(120) }]; // ¥6,000
    const first = await api(ctx.app, reqB, 'POST', '/api/erp/shop/requests', { ...header({ paymentIntent: 'dept_petty' }), kind: 'catalog', lines });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const preview = await api(ctx.app, reqB, 'GET', `/api/erp/shop/route-preview?storeId=${storeId}&kind=catalog&paymentIntent=dept_petty&lines=${s.id}:${q(120)}`);
    const hint = (preview.body.hints as { code: string; tone: string; text: string }[]).find((h) => h.code === 'dept_daily_quota');
    expect(hint).toMatchObject({ tone: 'warning' });
    expect(hint!.text).toContain('10,000');
    expect((preview.body.hints as { code: string }[]).some((h) => h.code === 'daily_30k')).toBe(false);

    const over = await api(ctx.app, reqB, 'POST', '/api/erp/shop/requests', { ...header({ paymentIntent: 'dept_petty' }), kind: 'catalog', lines });
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({ code: 'DEPT_DAILY_QUOTA', details: { limitCents: 1_000_000, takenCents: 600_000, requestCents: 600_000 } });

    const direct = await api(ctx.app, reqB, 'POST', '/api/erp/shop/requests', { ...header({ paymentIntent: 'company_direct' }), kind: 'catalog', lines });
    expect(direct.status, JSON.stringify(direct.body)).toBe(201);
  });
});

describe('商品图批量导入（8.1.55）', () => {
  const pngBuf = (n: number) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), Buffer.alloc(n, 9)]);
  /** WPS「嵌入单元格」图片的最小 Excel：rows 每行 [第一列文字, 图片编号...] */
  const workbook = (rows: string[][], images: Record<string, Buffer>) => {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const cell = (r: number, c: number, v: string) => {
      const ref = `${String.fromCharCode(65 + c)}${r}`;
      return v.startsWith('ID_') ? `<c r="${ref}" t="str"><f>_xlfn.DISPIMG("${v}",1)</f><v>=DISPIMG("${v}",1)</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
    };
    const sheet = `<worksheet><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((v, c) => (v ? cell(i + 1, c, v) : '')).join('')}</row>`).join('')}</sheetData></worksheet>`;
    const names = Object.keys(images);
    const ci = `<etc:cellImages xmlns:etc="x" xmlns:xdr="y" xmlns:a="z" xmlns:r="w">${names
      .map((n, i) => `<etc:cellImage><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="${n}"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${i + 1}"/></xdr:blipFill></xdr:pic></etc:cellImage>`)
      .join('')}</etc:cellImages>`;
    const ciRels = `<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="media/image${i + 1}.png"/>`).join('')}</Relationships>`;
    return zip([
      { name: 'xl/workbook.xml', data: Buffer.from('<workbook xmlns:r="w"><sheets><sheet name="商品图" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
      { name: 'xl/cellimages.xml', data: Buffer.from(ci) },
      { name: 'xl/_rels/cellimages.xml.rels', data: Buffer.from(ciRels) },
      ...names.map((n, i) => ({ name: `xl/media/image${i + 1}.png`, data: images[n]!, store: true })),
    ]).toString('base64');
  };
  const send = (cookie: string, xlsxBase64: string, mode: 'append' | 'replace', apply: boolean) =>
    api(ctx.app, cookie, 'POST', '/api/erp/shop/materials/images/import', { fileName: '商品图.xlsx', xlsxBase64, mode, apply });

  it('预览逐行核对、有问题一行都不写；追加不重复、替换照表；没有「物料档案」权限的进不来', async () => {
    const [m] = await ctx.sql<{ code: string }[]>`SELECT code FROM materials WHERE id = ${mat.id}`;
    await ctx.sql`DELETE FROM material_images WHERE material_id = ${mat.id}`;
    const imgs = { ID_A: pngBuf(11), ID_B: pngBuf(12), ID_C: pngBuf(13) };

    const bad = workbook(
      [
        ['物料编码', '商品图1', '商品图2'],
        [m!.code, 'ID_A', 'ID_B'],
        ['NOPE-1', 'ID_C', ''],
      ],
      imgs,
    );
    expect((await send(reqA, bad, 'append', false)).status).toBe(403);
    const pv = await send(boss, bad, 'append', false);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ applied: false, issueCount: 1, changedCount: 1 });
    expect(pv.body.rows[0]).toMatchObject({ row: 2, materialId: mat.id, fileImages: 2, before: 0, after: 2, changed: true, issues: [] });
    expect(pv.body.rows[1].issues[0]).toContain('NOPE-1');
    const refused = await send(boss, bad, 'append', true);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('IMPORT_ISSUES');
    expect((await ctx.sql`SELECT 1 FROM material_images WHERE material_id = ${mat.id}`).length).toBe(0);

    const good = workbook(
      [
        ['物料编码', '商品图1', '商品图2'],
        [m!.code, 'ID_A', 'ID_B'],
      ],
      imgs,
    );
    const done = await send(boss, good, 'append', true);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ applied: true, changedCount: 1 });
    const ids = async () => (await ctx.sql<{ imageId: number }[]>`SELECT image_id FROM material_images WHERE material_id = ${mat.id} ORDER BY sort_no`).map((r) => Number(r.imageId));
    const afterFirst = await ids();
    expect(afterFirst).toHaveLength(2);
    // 原样再发：追加不重复
    expect((await send(boss, good, 'append', true)).body.changedCount).toBe(0);
    expect(await ids()).toEqual(afterFirst);
    // 追加一张新的接在后面
    expect(
      (
        await send(
          boss,
          workbook(
            [
              ['物料编码', '图片'],
              [m!.code, 'ID_C'],
            ],
            imgs,
          ),
          'append',
          true,
        )
      ).status,
    ).toBe(200);
    expect((await ids()).slice(0, 2)).toEqual(afterFirst);
    expect(await ids()).toHaveLength(3);
    // 替换：只剩表里的
    const rep = await send(
      boss,
      workbook(
        [
          ['物料编码', '图片'],
          [m!.code, 'ID_B'],
        ],
        imgs,
      ),
      'replace',
      true,
    );
    expect(rep.body.rows[0]).toMatchObject({ before: 3, after: 1 });
    expect(await ids()).toEqual([afterFirst[1]]);
    // 商城页面取得到导入的图
    expect((await api(ctx.app, reqA, 'GET', `/api/erp/shop/images/${afterFirst[1]}`)).status).toBe(200);
    // 超过 6 张拦下
    const many = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`ID_M${i}`, pngBuf(20 + i)]));
    const seven = await send(
      boss,
      workbook(
        [
          ['物料编码', ...Object.keys(many).map((_, i) => `图${i + 1}`)],
          [m!.code, ...Object.keys(many)],
        ],
        many,
      ),
      'replace',
      false,
    );
    expect(seven.body.rows[0].issues[0]).toContain('最多 6 张');
    await ctx.sql`DELETE FROM material_images WHERE material_id = ${mat.id}`;
  });

  it('没有表头、不是 Excel 的给出能看懂的错', async () => {
    expect((await send(boss, workbook([['随便', '什么']], {}), 'append', false)).body.error.code).toBe('IMPORT_HEADER');
    expect((await send(boss, Buffer.from('not a zip file at all').toString('base64'), 'append', false)).body.error.code).toBe('IMPORT_FILE_INVALID');
  });
});
