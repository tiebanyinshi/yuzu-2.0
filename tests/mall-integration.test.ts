// 采购商城 V1.1 对接（8.1.31，docs/MALL_V8131.md）：商城后端经 /api/erp/mall/* 认人、建需求单、查进度。
// 服务密钥、停用与改密、跨站来源、部门隔离、供应商脱敏、ERP 模块开关、原样重提与商城单号去重、确认作废、主管确认与退回原因、三档紧急程度、自检。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { todayIn } from '../src/server/modules/inventory/common';
import { requestChecks } from '../src/server/modules/requests';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

const KEY = 'k'.repeat(40);
let ctx: TestContext;
let mall: FastifyInstance;
let boss: string;
let deptA: number;
let deptB: number;
let reqA: number; // 部门 A 的申购账号（共用）
let reqB: number;
let headA: number; // 部门 A 的主管
let buyer: number; // 采购审核
let supplierId: number;
let mat: { id: number };
const q = (n: number) => Math.round(n * 1000);

type Res = { status: number; body: any };
async function call(method: 'GET' | 'POST', url: string, opts: { staff?: number; key?: string | null; body?: unknown; headers?: Record<string, string>; app?: FastifyInstance } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.key !== null) headers['x-mall-key'] = opts.key ?? KEY;
  if (opts.staff) headers['x-mall-staff-id'] = String(opts.staff);
  const res = await (opts.app ?? mall).inject({ method, url, headers, ...(opts.body === undefined ? {} : { payload: opts.body as object }) });
  return { status: res.statusCode, body: res.headers['content-type']?.toString().includes('json') ? res.json() : res.body };
}

const selfLine = (over: Record<string, unknown> = {}) => ({
  name: '定制工作服（夏季）',
  purpose: '',
  qtyMilli: q(20),
  unit: '套',
  refPriceCents: 8800,
  details: '藏青色，含刺绣 logo',
  brandModel: '自定',
  reasonText: '新员工入职',
  ...over,
});
const body = (over: Record<string, unknown> = {}) => ({
  clientKey: randomUUID(),
  externalNo: `MALL-${randomUUID().slice(0, 8)}`,
  contactName: '王小明',
  budgetProject: '运营部 · 员工服装',
  deliveryAddress: '本店仓库',
  paymentIntent: 'company_direct',
  priority: 'high',
  lines: [selfLine()],
  ...over,
});

beforeAll(async () => {
  ctx = await setup();
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  mall = await buildApp(ctx.sql, { ...ctx.config, mallApiKey: KEY });
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  const mk = async (name: string) => {
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name });
    return ((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[]).find((d) => d.name === name)!.id;
  };
  deptA = await mk('运营部');
  deptB = await mk('水吧');
  headA = await createStaff(ctx.sql, { username: 'head_a', displayName: '运营主管', role: 'backoffice', duties: ['request'], departmentId: deptA, password: PASSWORD, mustChangePassword: false });
  await ctx.sql`UPDATE departments SET head_id = ${headA} WHERE id = ${deptA}`;
  reqA = await createStaff(ctx.sql, { username: 'mall_a', displayName: '运营部申购', role: 'backoffice', duties: ['request'], departmentId: deptA, password: PASSWORD, mustChangePassword: false });
  reqB = await createStaff(ctx.sql, { username: 'mall_b', displayName: '水吧申购', role: 'backoffice', duties: ['request'], departmentId: deptB, password: PASSWORD, mustChangePassword: false });
  buyer = (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`)[0]!.id;
  supplierId = (await ctx.sql<{ id: number }[]>`SELECT id FROM suppliers WHERE code = 'S004'`)[0]!.id;
  mat = (await ctx.sql<{ id: number }[]>`SELECT id FROM materials WHERE code = 'M016'`)[0]!;
}, 120_000);
afterAll(async () => {
  await mall?.close();
  await ctx.close();
});

describe('认人', () => {
  it('没配服务密钥：一律 503；密钥不对或没带：401；只带员工的 Cookie 不带密钥也进不来', async () => {
    expect((await call('GET', '/api/erp/mall/staff/me', { staff: reqA, app: ctx.app })).body.error.code).toBe('MALL_NOT_CONFIGURED');
    expect((await call('GET', '/api/erp/mall/staff/me', { staff: reqA, key: 'x'.repeat(40) })).status).toBe(401);
    expect((await call('GET', '/api/erp/mall/staff/me', { staff: reqA, key: null })).body.error.code).toBe('MALL_KEY_REJECTED');
    const cookie = await login(mall, 'mall_a');
    const res = await mall.inject({ method: 'GET', url: '/api/erp/mall/staff/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
    // 没带员工编号
    expect((await call('GET', '/api/erp/mall/staff/me')).body.error.code).toBe('MALL_STAFF_REQUIRED');
  });

  it('登录校验：账号密码对了给身份（部门、主管、门店、能做什么）；错了 401 并记审计；停用的 401', async () => {
    const ok = await call('POST', '/api/erp/mall/auth/verify', { body: { username: 'mall_a', password: PASSWORD, clientIp: '10.0.0.8' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ staff: { id: reqA, username: 'mall_a' }, department: { id: deptA, name: '运营部' }, capabilities: { canCreateRequest: true, canReviewRequest: false } });
    expect(ok.body.stores.length).toBeGreaterThan(0);
    const head = await call('POST', '/api/erp/mall/auth/verify', { body: { username: 'head_a', password: PASSWORD } });
    expect(head.body.headOf).toEqual([deptA]);
    expect((await call('POST', '/api/erp/mall/auth/verify', { body: { username: 'mall_a', password: 'wrong-pass' } })).status).toBe(401);
    const [audit] = await ctx.sql<{ detail: { channel: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'login_failed' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.channel).toBe('mall');
    const gone = await createStaff(ctx.sql, {
      username: 'mall_gone',
      displayName: '已离职',
      role: 'backoffice',
      duties: ['request'],
      departmentId: deptA,
      password: PASSWORD,
      mustChangePassword: false,
    });
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${gone}`;
    expect((await call('POST', '/api/erp/mall/auth/verify', { body: { username: 'mall_gone', password: PASSWORD } })).status).toBe(401);
    // 停用以后商城的业务接口马上不认
    expect((await call('GET', '/api/erp/mall/staff/me', { staff: gone })).body.error.code).toBe('MALL_STAFF_INVALID');
  });

  it('要先改密码、选岗位的：登录校验 403，业务接口照样拒绝', async () => {
    const fresh = await createStaff(ctx.sql, {
      username: 'mall_new',
      displayName: '新账号',
      role: 'backoffice',
      duties: ['request'],
      departmentId: deptA,
      password: PASSWORD,
      mustChangePassword: true,
    });
    expect((await call('POST', '/api/erp/mall/auth/verify', { body: { username: 'mall_new', password: PASSWORD } })).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await call('POST', '/api/erp/mall/requests', { staff: fresh, body: body() })).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await call('GET', '/api/erp/mall/staff/me', { staff: fresh })).body.mustChangePassword).toBe(true);
  });

  it('跨站来源：带对密钥的服务端调用不受浏览器来源检查影响；普通接口照旧拦', async () => {
    const res = await call('POST', '/api/erp/mall/requests/batch-status', { staff: reqA, body: { ids: [1] }, headers: { origin: 'https://mall.example.com' } });
    expect(res.status).toBe(200);
    const cookie = await login(mall, 'mall_a');
    const plain = await mall.inject({ method: 'POST', url: '/api/erp/requests', headers: { cookie, origin: 'https://mall.example.com' }, payload: {} });
    expect(plain.json().error.code).toBe('BAD_ORIGIN');
  });
});

describe('主数据', () => {
  it('部门（带主管）、门店、主体、用途；物料；供应商不带银行账户、电话、证照', async () => {
    const meta = (await call('GET', '/api/erp/mall/master/meta', { staff: reqA })).body;
    expect(meta.departments.find((d: { id: number }) => d.id === deptA).head).toEqual({ id: headA, name: '运营主管' });
    expect(meta.stores.length).toBeGreaterThan(0);
    expect(meta.priorities).toEqual(['urgent', 'high', 'normal']);
    expect(meta.rules.deptConfirm).toBe('all');
    const mats = (await call('GET', '/api/erp/mall/master/materials', { staff: reqA })).body.materials;
    expect(mats.some((m: { id: number }) => m.id === mat.id)).toBe(true);
    const sups = (await call('GET', '/api/erp/mall/master/suppliers', { staff: reqA })).body.suppliers as Record<string, unknown>[];
    expect(sups.length).toBeGreaterThan(0);
    for (const s of sups) expect(Object.keys(s).sort()).toEqual(['admission', 'code', 'contact', 'id', 'name', 'updatedAt']);
  });
});

describe('提报', () => {
  it('选品（物料 + 意向供应商 + SKU）与自主申请（没有链接、没有图片）一张单；来源商城、较急、要部门主管确认；自检照样过', async () => {
    const b = body({
      lines: [
        { materialId: mat.id, supplierId, mallSkuCode: 'SKU-001', priceVersion: 'v3', name: '一次性护理床单', purpose: '客用消耗', qtyMilli: q(2), unit: '箱', refPriceCents: 32000, taxRateBp: 1300 },
        selfLine(),
      ],
    });
    const res = await call('POST', '/api/erp/mall/requests', { staff: reqA, body: b });
    expect(res.status).toBe(201);
    const r = res.body.request;
    expect(r).toMatchObject({
      source: 'mall',
      externalNo: b.externalNo,
      priority: 'high',
      contactName: '王小明',
      displayStatus: 'dept_pending',
      deptConfirm: { state: 'pending', headName: '运营主管' },
    });
    expect(r.docNo).toMatch(/^XQ/);
    expect(r.lines[0]).toMatchObject({ supplier: { id: supplierId }, skuCode: 'SKU-001', priceVersion: 'v3' });
    expect(r.lines[1]).toMatchObject({ link: '', imageIds: [], purpose: '其他', reasonText: '新员工入职' });
    // ERP 页面上看得到商城的几项
    const erp = (await api(mall, boss, 'GET', `/api/erp/requests/${r.id}`)).body;
    expect(erp.mall).toMatchObject({ externalNo: b.externalNo, contactName: '王小明', paymentIntent: 'company_direct' });
    expect(erp.lines[0].mall).toMatchObject({ skuCode: 'SKU-001', taxRateBp: 1300 });
    const checks = await requestChecks(ctx.sql);
    expect(checks[0]!.ok, checks[0]!.detail).toBe(true);
  });

  it('同一个操作编号原样重提：给同一张单；内容不同：409；换了编号用同一个商城单号：409 EXTERNAL_NO_EXISTS', async () => {
    const b = body();
    const first = await call('POST', '/api/erp/mall/requests', { staff: reqA, body: b });
    const again = await call('POST', '/api/erp/mall/requests', { staff: reqA, body: b });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.request.id).toBe(first.body.request.id);
    expect((await ctx.sql`SELECT 1 FROM purchase_requests WHERE external_no = ${b.externalNo}`).length).toBe(1);
    expect((await call('POST', '/api/erp/mall/requests', { staff: reqA, body: { ...b, note: '改了' } })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await call('POST', '/api/erp/mall/requests', { staff: reqA, body: { ...b, clientKey: randomUUID() } })).body.error.code).toBe('EXTERNAL_NO_EXISTS');
    // 按操作编号、商城单号都查得回
    const byKey = (await call('GET', `/api/erp/mall/requests/by-key/${b.clientKey}`, { staff: reqA })).body;
    expect(byKey).toMatchObject({ found: true, abandoned: false, request: { id: first.body.request.id } });
    expect((await call('GET', `/api/erp/mall/requests/by-external/${b.externalNo}`, { staff: reqA })).body.id).toBe(first.body.request.id);
  });

  it('确认作废：晚到的原请求被拒（OP_ABANDONED）；别人的编号查不回', async () => {
    const b = body();
    const ab = await call('POST', `/api/erp/mall/ops/${b.clientKey}/abandon`, { staff: reqA, body: { summary: '超时' } });
    expect(ab.body).toMatchObject({ found: false, abandoned: true });
    expect((await call('POST', '/api/erp/mall/requests', { staff: reqA, body: b })).body.error.code).toBe('OP_ABANDONED');
    const other = body();
    await call('POST', '/api/erp/mall/requests', { staff: reqA, body: other });
    expect((await call('GET', `/api/erp/mall/requests/by-key/${other.clientKey}`, { staff: reqB })).status).toBe(404);
  });

  it('只能给自己的部门提；期望到货日期不能早于今天；停用的供应商不收', async () => {
    expect((await call('POST', '/api/erp/mall/requests', { staff: reqA, body: body({ departmentId: deptB }) })).status).toBe(403);
    expect((await call('POST', '/api/erp/mall/requests', { staff: reqA, body: body({ needBy: '2020-01-01' }) })).body.error.code).toBe('NEED_BY_PAST');
    const [s] = await ctx.sql<{ id: number }[]>`INSERT INTO suppliers (code, name, active) VALUES ('S-OFF', '停用的供应商', false) RETURNING id`;
    expect((await call('POST', '/api/erp/mall/requests', { staff: reqA, body: body({ lines: [selfLine({ supplierId: s!.id })] }) })).body.error.code).toBe('SUPPLIER_INACTIVE');
  });
});

describe('进度与可见范围', () => {
  it('部门看不到别的部门的单；采购看全部；主管确认 → 采购退回带原因 → 商城看到「已退回」和原因', async () => {
    const created = (await call('POST', '/api/erp/mall/requests', { staff: reqA, body: body({ priority: 'urgent' }) })).body.request;
    expect((await call('GET', `/api/erp/mall/requests/${created.id}`, { staff: reqB })).status).toBe(404);
    const batchB = (await call('POST', '/api/erp/mall/requests/batch-status', { staff: reqB, body: { ids: [created.id] } })).body;
    expect(batchB).toMatchObject({ requests: [], missing: { ids: [created.id] } });
    expect((await call('GET', `/api/erp/mall/requests/${created.id}`, { staff: buyer })).status).toBe(200);

    const head = await login(mall, 'head_a');
    expect((await api(mall, head, 'POST', `/api/erp/requests/${created.id}/dept-confirm`, {})).status).toBe(200);
    const afterConfirm = (await call('GET', `/api/erp/mall/requests/${created.id}`, { staff: reqA })).body;
    expect(afterConfirm.displayStatus).toBe('reviewing');
    expect(afterConfirm.progressUpdatedAt >= created.progressUpdatedAt).toBe(true);

    const buyerCookie = await login(mall, 'zhouyi', 'yuzu2026');
    expect((await api(mall, buyerCookie, 'POST', `/api/erp/requests/${created.id}/return`, { reason: '请补充尺码表' })).status).toBe(200);
    const back = (await call('POST', '/api/erp/mall/requests/batch-status', { staff: reqA, body: { externalNos: [created.externalNo] } })).body.requests[0];
    expect(back).toMatchObject({ status: 'returned', displayStatus: 'returned', displayLabel: '已退回', reason: '请补充尺码表' });
    // 列表按进度时刻增量取
    const since = new Date(Date.now() - 60_000).toISOString();
    const list = (await call('GET', `/api/erp/mall/requests?source=mall&updatedSince=${encodeURIComponent(since)}`, { staff: reqA })).body.requests as { id: number }[];
    expect(list.some((x) => x.id === created.id)).toBe(true);
    const listB = (await call('GET', '/api/erp/mall/requests', { staff: reqB })).body.requests as { id: number }[];
    expect(listB.some((x) => x.id === created.id)).toBe(false);
  });

  it('三档紧急程度：较急照常核库，只有紧急跳过；待审核按紧急 → 较急 → 普通排', async () => {
    const today = todayIn(ctx.config.timezone);
    expect(today).toMatch(/^\d{4}-/);
    const rows = await ctx.sql<{ priority: string }[]>`SELECT DISTINCT priority FROM purchase_requests WHERE source = 'mall' ORDER BY priority`;
    expect(rows.map((r) => r.priority).sort()).toEqual(['high', 'urgent']);
    const pending = (await api(mall, boss, 'GET', '/api/erp/requests?status=submitted')).body.requests as { priority: string }[];
    const rank = { urgent: 0, high: 1, normal: 2 } as Record<string, number>;
    for (let i = 1; i < pending.length; i += 1) expect(rank[pending[i - 1]!.priority]! <= rank[pending[i]!.priority]!).toBe(true);
  });
});

describe('列表与批量的进度（Codex 审查）', () => {
  it('部分到货、采购单关闭在批量查状态里与详情一致；采购单解开关联也算进度变动；增量按游标一页页取完；ERP 不改商城的单', async () => {
    const today = todayIn(ctx.config.timezone);
    const b = body({
      priority: 'urgent',
      lines: [{ materialId: mat.id, supplierId, mallSkuCode: 'SKU-P', priceVersion: 'v1', name: '一次性护理床单', purpose: '客用消耗', qtyMilli: q(10), unit: '箱' }],
    });
    const r = (await call('POST', '/api/erp/mall/requests', { staff: reqA, body: b })).body.request;
    // ERP 的修改页改不了商城的单（会丢 SKU、价格版本），退回的在商城重新提
    const erpEdit = await api(mall, await login(mall, 'mall_a'), 'PUT', `/api/erp/requests/${r.id}`, {
      lines: [{ materialId: mat.id, name: '一次性护理床单', purpose: '客用消耗', qtyMilli: q(1), unit: '箱' }],
    });
    expect(erpEdit.body.error?.code).toBe('MALL_EDIT_IN_SHOP');
    expect((await api(mall, await login(mall, 'head_a'), 'POST', `/api/erp/requests/${r.id}/dept-confirm`, {})).status).toBe(200);
    const approved = await api(mall, boss, 'POST', `/api/erp/requests/${r.id}/approve`, {});
    expect(approved.body.status, JSON.stringify(approved.body)).toBe('approved');
    const lineId = approved.body.lines[0].id as number;
    const status = async () => (await call('POST', '/api/erp/mall/requests/batch-status', { staff: reqA, body: { ids: [r.id] } })).body.requests[0];
    const detail = async () => (await call('GET', `/api/erp/mall/requests/${r.id}`, { staff: reqA })).body;

    const created = await api(mall, boss, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId,
      orderDate: today,
      action: 'save',
      lines: [{ materialId: mat.id, purchaseQtyMilli: q(10), priceCents: 100, requestLineIds: [lineId] }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const po = created.body.po;
    expect((await status()).displayStatus).toBe('ordered');
    // 采购单改版解开关联：需求单回到「已通过」，增量里能取到它，进度时刻不往回走
    const before = (await status()).progressUpdatedAt as string;
    const since = new Date().toISOString();
    const put = (requestLineIds: number[]) =>
      api(mall, boss, 'PUT', `/api/purchase-orders/${po.id}`, {
        supplierId,
        orderDate: today,
        action: 'save',
        lines: [{ id: po.lines[0].id, materialId: mat.id, purchaseQtyMilli: q(10), priceCents: 100, requestLineIds }],
      });
    const unl = await put([]);
    expect(unl.status, JSON.stringify(unl.body)).toBe(200);
    const unlinked = await status();
    expect(unlinked.displayStatus).toBe('approved');
    expect(unlinked.progressUpdatedAt >= before).toBe(true);
    const inc = (await call('GET', `/api/erp/mall/requests?updatedSince=${encodeURIComponent(since)}`, { staff: reqA })).body.requests as { id: number }[];
    expect(inc.map((x) => x.id)).toContain(r.id);
    expect((await put([lineId])).status).toBe(200);
    await api(mall, boss, 'POST', `/api/purchase-orders/${po.id}/submit`, {});
    await api(mall, boss, 'POST', `/api/purchase-orders/${po.id}/approve`, {});
    const fresh = (await api(mall, boss, 'GET', `/api/purchase-orders/${po.id}`)).body;
    expect(fresh.status).toBe('approved');
    // 到 3 箱：部分到货（列表与详情一样）
    const rec = await api(mall, boss, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId,
      purchaseOrderId: po.id,
      coAcceptorId: buyer,
      lines: [{ materialId: mat.id, poLineId: fresh.lines[0].id, deliveredMilli: q(3), acceptedMilli: q(3) }],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    if (rec.body.status !== 'confirmed') await api(mall, boss, 'POST', `/api/inventory/docs/${rec.body.id}/confirm`, {});
    expect((await detail()).displayStatus).toBe('partial');
    expect((await status()).displayStatus).toBe('partial');
    // 关单：没到齐的不再到，列表上是「已关闭」
    expect((await api(mall, boss, 'POST', `/api/purchase-orders/${po.id}/close`, { reason: '供应商缺货' })).status).toBe(200);
    expect((await detail()).displayStatus).toBe('closed');
    expect((await status()).displayStatus).toBe('closed');

    // 增量一页一张，跟着游标取完：不重、不漏，按进度时刻从早到晚
    const all = (await call('GET', `/api/erp/mall/requests?updatedSince=${encodeURIComponent('2000-01-01T00:00:00Z')}&limit=200`, { staff: buyer })).body;
    const seen: number[] = [];
    type Cursor = { updatedSince: string; afterId: number } | null;
    let cursor: Cursor = { updatedSince: '2000-01-01T00:00:00.000Z', afterId: 0 };
    for (let i = 0; cursor && i < 100; i += 1) {
      const qs: string = `updatedSince=${encodeURIComponent(cursor.updatedSince)}${cursor.afterId ? `&afterId=${cursor.afterId}` : ''}&limit=1`;
      const page = (await call('GET', `/api/erp/mall/requests?${qs}`, { staff: buyer })).body as { requests: { id: number; progressUpdatedAt: string }[]; nextCursor: Cursor };
      seen.push(...page.requests.map((x) => x.id));
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort((a, c) => a - c)).toEqual((all.requests as { id: number }[]).map((x) => x.id).sort((a, c) => a - c));
    expect(seen).toContain(r.id);
  });
});

describe('ERP 模块开关', () => {
  it('「采购需求单」关着：商城接口一律 403 ERP_MODULE_DISABLED（登录校验也是）', async () => {
    const [row] = await ctx.sql<{ value: Record<string, boolean> }[]>`SELECT value FROM settings WHERE key = 'erp_modules'`;
    const before = row?.value ?? {};
    await ctx.sql`INSERT INTO settings (key, value) VALUES ('erp_modules', ${ctx.sql.json({ ...before, requests: false })})
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    try {
      expect((await call('GET', '/api/erp/mall/master/meta', { staff: reqA })).body.error.code).toBe('ERP_MODULE_DISABLED');
      expect((await call('POST', '/api/erp/mall/auth/verify', { body: { username: 'mall_a', password: PASSWORD } })).body.error.code).toBe('ERP_MODULE_DISABLED');
    } finally {
      await ctx.sql`INSERT INTO settings (key, value) VALUES ('erp_modules', ${ctx.sql.json(before)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    }
  });
});
