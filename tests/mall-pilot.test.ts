// 采购商城试点（8.1.51，docs/MALL_V8151.md）：自主申请分非定制 / 定制；退回后在原单补资料重提；需求池接单；
// 成交方案（部门看不到价格）、部门确认或 BP 记已在微信确认、转采购单带上方案；收货的待补数量。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { shiftDate } from '../src/shared/labels';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let buyer: string;
let brand: string; // 品牌部申购
let other: string; // 别的部门申购
let storeId: number;
let entityId: number;
let supId: number;
let today: string;
const q = (n: number) => Math.round(n * 1000);

const header = (over: Record<string, unknown> = {}) => ({
  clientKey: randomUUID(),
  storeId,
  entityId,
  contactName: '品牌部小王',
  budgetProject: '品牌物料',
  needBy: shiftDate(today, 10),
  deliveryAddress: '总店前台',
  paymentIntent: 'company_direct',
  priority: 'normal',
  note: '',
  ...over,
});
const customLine = (over: Record<string, unknown> = {}) => ({
  name: '店庆易拉宝',
  qtyMilli: q(4),
  unit: '个',
  details: '画面见附件',
  reasonText: '店庆活动',
  customKind: 'custom',
  customSpec: { size: '80×200cm', craft: 'PP 合成纸、铝合金架', scene: '大堂入口', sample: true, budgetCents: 80000 },
  ...over,
});
const submit = (cookie: string, line: Record<string, unknown>, over: Record<string, unknown> = {}) => api(ctx.app, cookie, 'POST', '/api/erp/shop/requests', { ...header(over), kind: 'custom', line });
const detail = async (cookie: string, id: number) => (await api(ctx.app, cookie, 'GET', `/api/erp/shop/requests/${id}`)).body;

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
  const brandDept = await mk('品牌部');
  const linenDept = await mk('客房部');
  await createStaff(ctx.sql, { username: 'pilot_brand', displayName: '品牌部申购', role: 'backoffice', duties: ['request'], departmentId: brandDept, password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'pilot_linen', displayName: '客房部申购', role: 'backoffice', duties: ['request'], departmentId: linenDept, password: PASSWORD, mustChangePassword: false });
  brand = await login(ctx.app, 'pilot_brand');
  other = await login(ctx.app, 'pilot_linen');
  storeId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM stores ORDER BY id LIMIT 1`)[0]!.id);
  entityId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM legal_entities ORDER BY id LIMIT 1`)[0]!.id);
  supId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM suppliers WHERE active ORDER BY id LIMIT 1`)[0]!.id);
}, 120_000);
afterAll(async () => ctx.close());

describe('自主申请分非定制 / 定制', () => {
  it('定制：结构化要求存下来，ERP 的「规格与技术要求」写成一段话；非定制要写规格型号', async () => {
    const r = await submit(brand, customLine());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const line = r.body.request.lines[0];
    expect(line.customKind).toBe('custom');
    expect(line.customSpec).toMatchObject({ size: '80×200cm', sample: true, budgetCents: 80000 });
    expect(line.details).toContain('【定制】尺寸规格：80×200cm');
    expect(line.details).toContain('需要先打样确认');
    expect(line.details).toContain('画面见附件');
    expect((await submit(brand, { name: '订书机', qtyMilli: q(2), unit: '个', details: '', reasonText: '办公', customKind: 'standard' })).body.error.code).toBe('DETAILS_REQUIRED');
    const std = await submit(brand, { name: '订书机', qtyMilli: q(2), unit: '个', details: '得力 0414', reasonText: '办公', customKind: 'standard' });
    expect(std.body.request.lines[0]).toMatchObject({ customKind: 'standard', customSpec: null, details: '得力 0414' });
  });
});

describe('退回后在原单补资料', () => {
  it('只有提单人、只有退回的、看到的要是最新的；补完回到待审核，单号不变，记下补了什么', async () => {
    const r = (await submit(brand, customLine({ name: '工牌挂绳' }))).body.request as { id: number; docNo: string; updatedAt: string; lines: { id: number }[] };
    const body = (over: Record<string, unknown> = {}) => ({
      clientKey: randomUUID(),
      expectedUpdatedAt: r.updatedAt,
      contactName: '品牌部小王',
      budgetProject: '品牌物料',
      needBy: shiftDate(today, 12),
      deliveryAddress: '总店前台',
      priority: 'high',
      note: '',
      remark: '补了尺寸与工艺',
      lines: [
        { id: r.lines[0]!.id, qtyMilli: q(100), customKind: 'custom', customSpec: { size: '90cm', craft: '涤纶热转印', scene: '员工', sample: false, budgetCents: null }, details: 'logo 见附件' },
      ],
      ...over,
    });
    // 还没退回：不能补
    expect((await api(ctx.app, brand, 'PUT', `/api/erp/shop/requests/${r.id}/resubmit`, body())).body.error.code).toBe('INVALID_STATE');
    const ret = await api(ctx.app, boss, 'POST', `/api/erp/requests/${r.id}/return`, { reason: '请补尺寸与工艺' });
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);
    const returned = await detail(brand, r.id);
    expect(returned.status).toBe('returned');
    expect(returned.can.resubmit).toBe(true);
    // 别人不能补；看到的过时了拒绝
    expect((await api(ctx.app, other, 'PUT', `/api/erp/shop/requests/${r.id}/resubmit`, body({ expectedUpdatedAt: returned.updatedAt }))).status).toBe(403);
    expect((await api(ctx.app, brand, 'PUT', `/api/erp/shop/requests/${r.id}/resubmit`, body())).body.error.code).toBe('REQUEST_CHANGED');
    const sent = body({ expectedUpdatedAt: returned.updatedAt });
    const ok = await api(ctx.app, brand, 'PUT', `/api/erp/shop/requests/${r.id}/resubmit`, sent);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ id: r.id, docNo: r.docNo, status: 'submitted', reason: null, priority: 'high' });
    expect(ok.body.lines[0]).toMatchObject({ qtyMilli: q(100), customSpec: { size: '90cm' } });
    expect(ok.body.lines[0].details).toContain('涤纶热转印');
    const actions = (ok.body.approvals as { action: string; reason: string }[]).map((a) => `${a.action}:${a.reason}`);
    expect(actions).toContain('return:请补尺寸与工艺');
    expect(actions).toContain('revise:补资料：补了尺寸与工艺');
    // 回复丢了、同一个编号原样重提（Codex 审查）：认得是同一笔，不再写；查回找得到；换了内容拒绝
    const replay = await api(ctx.app, brand, 'PUT', `/api/erp/shop/requests/${r.id}/resubmit`, sent);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect((replay.body.approvals as { action: string }[]).filter((a) => a.action === 'revise')).toHaveLength(1);
    expect((await api(ctx.app, brand, 'GET', `/api/erp/ops/${sent.clientKey}?type=mall_resubmit`)).body).toMatchObject({ found: true, refId: r.id });
    expect((await api(ctx.app, other, 'GET', `/api/erp/ops/${sent.clientKey}?type=mall_resubmit`)).status).toBe(403);
    expect((await api(ctx.app, brand, 'PUT', `/api/erp/shop/requests/${r.id}/resubmit`, { ...sent, remark: '另一笔' })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 新的编号再提：已经不是退回状态，拒绝，不会重复
    expect((await api(ctx.app, brand, 'PUT', `/api/erp/shop/requests/${r.id}/resubmit`, body({ expectedUpdatedAt: returned.updatedAt }))).body.error.code).toBe('INVALID_STATE');
    // 确认作废了的编号晚到：不提交
    const r2 = (await submit(brand, customLine({ name: '名片' }))).body.request as { id: number; lines: { id: number }[] };
    expect((await api(ctx.app, boss, 'POST', `/api/erp/requests/${r2.id}/return`, { reason: '请补' })).status).toBe(200);
    const back2 = await detail(brand, r2.id);
    const late = {
      ...body({ expectedUpdatedAt: back2.updatedAt }),
      lines: [{ id: r2.lines[0]!.id, qtyMilli: q(2), customKind: 'custom', customSpec: { size: '90×54mm', craft: '铜版纸', scene: '前台', sample: false, budgetCents: null }, details: '' }],
    };
    expect((await api(ctx.app, brand, 'POST', `/api/erp/ops/${late.clientKey}/abandon`, { type: 'mall_resubmit', summary: '作废补资料' })).status).toBe(200);
    expect((await api(ctx.app, brand, 'PUT', `/api/erp/shop/requests/${r2.id}/resubmit`, late)).body.error.code).toBe('OP_ABANDONED');
    expect((await detail(brand, r2.id)).status).toBe('returned');
  });
});

describe('接单、成交方案、转采购单、收货待补', () => {
  it('BP 接单记方案；部门看不到价格，确认方案；BP 代记微信确认要写一句；转采购单带上方案；收货待补不超过拒收', async () => {
    const r = (await submit(brand, customLine({ name: '定制纸杯', qtyMilli: q(1000), unit: '个', customSpec: { size: '9 盎司', craft: '单层淋膜', scene: '前台', sample: true, budgetCents: 50000 } })))
      .body.request as { id: number; lines: { id: number }[] };
    const lineId = r.lines[0]!.id;
    // 部门申购不能接单
    expect((await api(ctx.app, brand, 'POST', `/api/erp/shop/requests/${r.id}/claim`, { clientKey: randomUUID() })).status).toBe(403);
    const claimed = await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/claim`, { clientKey: randomUUID() });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body.sourcingOwner.name).toBeTruthy();
    // 需求池列表带接单人
    const pool = (await api(ctx.app, buyer, 'GET', '/api/erp/shop/requests?scope=pool')).body.requests as { id: number; sourcingOwner: { name: string } | null }[];
    expect(pool.find((x) => x.id === r.id)?.sourcingOwner).not.toBeNull();
    const quote = (over: Record<string, unknown> = {}) => ({
      clientKey: randomUUID(),
      lineId,
      supplierId: supId,
      unitPriceCents: 45,
      taxRateBp: 1300,
      freightCents: 2000,
      leadDays: 7,
      planNote: '9 盎司单层，先寄 10 个样品',
      internalNote: '老板答应再降 2 分',
      recommended: true,
      ...over,
    });
    const key = randomUUID();
    const added = await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/quotes`, quote({ clientKey: key }));
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/quotes`, quote({ clientKey: key }))).body.quotes).toHaveLength(1);
    const second = await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/quotes`, quote({ supplierId: null, supplierName: '还没建档的印刷厂', unitPriceCents: 52, recommended: false }));
    expect(second.body.quotes).toHaveLength(2);
    // 采购看得到价格；部门只看到供应商、交期、方案说明
    expect(second.body.quotes[0]).toMatchObject({ unitPriceCents: 45, internalNote: '老板答应再降 2 分', recommended: true });
    const seen = await detail(brand, r.id);
    expect(seen.can.seePrices).toBe(false);
    expect(seen.quotes[0]).toMatchObject({ supplierName: expect.any(String), leadDays: 7, planNote: '9 盎司单层，先寄 10 个样品', unitPriceCents: null, internalNote: null, imageIds: [] });
    // 别的部门不能确认；BP 代记要写一句
    const [qa, qb] = seen.quotes as { id: number }[];
    expect((await api(ctx.app, other, 'POST', `/api/erp/shop/quotes/${qa!.id}/select`, { clientKey: randomUUID(), mode: 'dept' })).status).toBeGreaterThanOrEqual(403);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/quotes/${qb!.id}/select`, { clientKey: randomUUID(), mode: 'wechat' })).body.error.code).toBe('NOTE_REQUIRED');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/quotes/${qb!.id}/select`, { clientKey: randomUUID(), mode: 'wechat', note: '王经理 11-27 上午微信确认' })).status).toBe(200);
    // 部门改选第一个：原来选定的换掉
    const selBody = { clientKey: randomUUID(), mode: 'dept' };
    const sel = await api(ctx.app, brand, 'POST', `/api/erp/shop/quotes/${qa!.id}/select`, selBody);
    expect(sel.status, JSON.stringify(sel.body)).toBe(200);
    // 选定的结果待确认（Codex 审查）：同一个编号原样重提不再写；查回只有自己能查；确认作废的编号晚到不改（不会把之后的改选换回去）
    expect((await api(ctx.app, brand, 'POST', `/api/erp/shop/quotes/${qa!.id}/select`, selBody)).status).toBe(200);
    expect((await api(ctx.app, brand, 'GET', `/api/erp/ops/${selBody.clientKey}?type=mall_quote_act`)).body).toMatchObject({ found: true, refId: r.id });
    expect((await api(ctx.app, other, 'GET', `/api/erp/ops/${selBody.clientKey}?type=mall_quote_act`)).status).toBe(403);
    const lateKey = randomUUID();
    expect((await api(ctx.app, brand, 'POST', `/api/erp/ops/${lateKey}/abandon`, { type: 'mall_quote_act', summary: '作废确认' })).status).toBe(200);
    expect((await api(ctx.app, brand, 'POST', `/api/erp/shop/quotes/${qb!.id}/select`, { clientKey: lateKey, mode: 'dept' })).body.error.code).toBe('OP_ABANDONED');
    const states = (sel.body.quotes as { id: number; status: string; selectedMode: string | null }[]).map((x) => [x.id, x.status, x.selectedMode]);
    expect(states).toEqual([
      [qa!.id, 'selected', 'dept'],
      [qb!.id, 'proposed', null],
    ]);
    // 主管确认（没设主管的不用）、审核通过 → 待转采购单的行带着方案
    const head = await detail(boss, r.id);
    if (head.deptConfirm.state === 'pending') expect((await api(ctx.app, boss, 'POST', `/api/erp/requests/${r.id}/dept-confirm`, {})).status).toBe(200);
    const ap = await api(ctx.app, boss, 'POST', `/api/erp/requests/${r.id}/approve`, {});
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    const open = (await api(ctx.app, buyer, 'GET', `/api/erp/requests/open-lines?ids=${lineId}`)).body as {
      id: number;
      plan: { supplierId: number; unitPriceCents: number; leadDays: number } | null;
    }[];
    expect(open[0]?.plan).toMatchObject({ supplierId: supId, unitPriceCents: 45, leadDays: 7 });
    // 审核通过以后需求单整行不能改（Codex 审查）：接单记在另一张表，放回、再接、在没人接的单上记方案照样能做
    const released = await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/claim`, { clientKey: randomUUID(), release: true });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.sourcingOwner).toBeNull();
    const extra = await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/quotes`, quote({ unitPriceCents: 50 }));
    expect(extra.status, JSON.stringify(extra.body)).toBe(201);
    expect((await detail(buyer, r.id)).sourcingOwner).not.toBeNull();
    // 放回需求池的回复丢了、确认作废（Codex 审查）：晚到的放回不会删掉之后的接单
    const lateRelease = randomUUID();
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/ops/${lateRelease}/abandon`, { type: 'mall_quote_act', summary: '作废放回' })).status).toBe(200);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/claim`, { clientKey: lateRelease, release: true })).body.error.code).toBe('OP_ABANDONED');
    expect((await detail(buyer, r.id)).sourcingOwner).not.toBeNull();
    // 撤下选定的（还没转采购单）可以；撤下后不再带
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/quotes/${qa!.id}/withdraw`, { clientKey: randomUUID() })).status).toBe(200);
    expect(((await api(ctx.app, buyer, 'GET', `/api/erp/requests/open-lines?ids=${lineId}`)).body as { plan: unknown }[])[0]?.plan).toBeNull();
  });

  it('收货：待补不能多于拒收；记下的待补留在收货单上', async () => {
    const mat = (await ctx.sql<{ id: number; purchaseUnit: string }[]>`SELECT id, purchase_unit FROM materials WHERE active AND tracked ORDER BY id LIMIT 1`)[0]!;
    const dept = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM departments WHERE name = '客房部'`)[0]!.id);
    const base = { docType: 'receipt', docDate: today, urgent: true, departmentId: dept, supplierId: supId };
    const line = (over: Record<string, unknown>) => ({ materialId: Number(mat.id), deliveredMilli: q(10), acceptedMilli: q(8), rejectReason: '破损', priceCents: 100, ...over });
    const bad = await api(ctx.app, buyer, 'POST', '/api/inventory/docs', { ...base, clientKey: randomUUID(), lines: [line({ redeliverMilli: q(3) })] });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('待补不能多于拒收数量');
    const good = await api(ctx.app, buyer, 'POST', '/api/inventory/docs', { ...base, clientKey: randomUUID(), lines: [line({ redeliverMilli: q(2) })] });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    const doc = (await api(ctx.app, buyer, 'GET', `/api/inventory/docs/${good.body.doc.id}`)).body as { lines: { rejectedMilli: number; redeliverMilli: number }[] };
    expect(Number(doc.lines[0]!.rejectedMilli)).toBe(q(2));
    expect(Number(doc.lines[0]!.redeliverMilli)).toBe(q(2));
  });
});

describe('Codex 审查后的边界', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');

  it('定制说明合起来超过 1000 字：拒绝，不截断', async () => {
    const long = customLine({ details: '要'.repeat(800), customSpec: { size: '尺'.repeat(120), craft: '工'.repeat(200), scene: '场'.repeat(200), sample: true, budgetCents: null } });
    expect((await submit(brand, long)).body.error.code).toBe('DETAILS_TOO_LONG');
  });

  it('方案：同一个编号换了内容拒绝；报价截图单独一类，只有采购看得到；记了方案的单被退回也能在原单补资料', async () => {
    const r = (await submit(brand, customLine({ name: '工服' }))).body.request as { id: number; lines: { id: number }[] };
    const lineId = r.lines[0]!.id;
    // 截图：采购传到报价截图接口；部门、只看库存的人都取不到
    const shot = await api(ctx.app, buyer, 'POST', '/api/erp/shop/quote-images', { mime: 'image/png', data: png });
    expect(shot.status, JSON.stringify(shot.body)).toBe(201);
    const imgId = shot.body.id as number;
    // 需求单图片那条不能用来挂方案截图
    const general = (await api(ctx.app, buyer, 'POST', '/api/erp/images', { mime: 'image/png', data: png })).body.id as number;
    const quote = (over: Record<string, unknown> = {}) => ({ clientKey: randomUUID(), lineId, supplierId: supId, unitPriceCents: 6800, taxRateBp: 600, leadDays: 10, ...over });
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/quotes`, quote({ imageIds: [general] }))).body.error.code).toBe('IMAGE_INVALID');
    const key = randomUUID();
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/quotes`, quote({ clientKey: key, imageIds: [imgId] }))).status).toBe(201);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/quotes`, quote({ clientKey: key, imageIds: [imgId], unitPriceCents: 1 }))).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 只有采购审核、没有主数据维护权限的账号（Codex 审查）：方案的查回、确认作废照样能做
    await createStaff(ctx.sql, { username: 'pilot_reviewer', displayName: '采购审核', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
    const reviewer = await login(ctx.app, 'pilot_reviewer');
    expect((await api(ctx.app, reviewer, 'GET', `/api/erp/ops/${key}?type=mall_quote`)).body).toMatchObject({ found: true, refId: r.id });
    const lost = randomUUID();
    expect((await api(ctx.app, reviewer, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'mall_quote', summary: '作废方案' })).body).toMatchObject({ found: false, abandoned: true });
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/quotes`, quote({ clientKey: lost }))).body.error.code).toBe('OP_ABANDONED');
    expect((await api(ctx.app, brand, 'GET', `/api/erp/ops/${key}?type=mall_quote`)).status).toBe(403);
    const stock = await login(ctx.app, 'lixiao', 'yuzu2026'); // 物资经办：能看库存、看需求单图片
    for (const cookie of [stock, brand]) {
      expect((await ctx.app.inject({ method: 'GET', url: `/api/erp/images/${imgId}`, headers: { cookie } })).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'GET', url: `/api/erp/shop/quote-images/${imgId}`, headers: { cookie } })).statusCode).toBe(403);
    }
    expect((await ctx.app.inject({ method: 'GET', url: `/api/erp/shop/quote-images/${imgId}`, headers: { cookie: buyer } })).statusCode).toBe(200);
    // 部门确认了方案；之后采购退回 → 原单补资料（方案挂在行上，原地改行，不撞外键；选定的退回待确认）
    const qt = ((await detail(brand, r.id)).quotes as { id: number }[])[0]!;
    expect((await api(ctx.app, brand, 'POST', `/api/erp/shop/quotes/${qt.id}/select`, { clientKey: randomUUID(), mode: 'dept' })).status).toBe(200);
    expect((await api(ctx.app, boss, 'POST', `/api/erp/requests/${r.id}/return`, { reason: '请写尺码' })).status).toBe(200);
    const back = await detail(brand, r.id);
    const ok = await api(ctx.app, brand, 'PUT', `/api/erp/shop/requests/${r.id}/resubmit`, {
      clientKey: randomUUID(),
      expectedUpdatedAt: back.updatedAt,
      contactName: '品牌部小王',
      budgetProject: '品牌物料',
      needBy: shiftDate(today, 12),
      deliveryAddress: '总店前台',
      priority: 'normal',
      remark: '补了尺码',
      lines: [{ id: lineId, qtyMilli: q(20), customKind: 'custom', customSpec: { size: 'S 5 / M 10 / L 5', craft: '涤棉', scene: '前台', sample: false, budgetCents: null }, details: '' }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.lines[0]).toMatchObject({ id: lineId, qtyMilli: q(20) });
    expect(ok.body.quotes[0]).toMatchObject({ id: qt.id, status: 'proposed' });
    // 再退回、补资料时改了单位（Codex 审查）：按原单位报的方案全部撤下，不拿 ¥/件 的价当 ¥/箱 用
    expect((await api(ctx.app, boss, 'POST', `/api/erp/requests/${r.id}/return`, { reason: '按箱买' })).status).toBe(200);
    const back3 = await detail(brand, r.id);
    const boxed = await api(ctx.app, brand, 'PUT', `/api/erp/shop/requests/${r.id}/resubmit`, {
      clientKey: randomUUID(),
      expectedUpdatedAt: back3.updatedAt,
      contactName: '品牌部小王',
      budgetProject: '品牌物料',
      needBy: shiftDate(today, 12),
      deliveryAddress: '总店前台',
      priority: 'normal',
      remark: '改成按箱',
      lines: [{ id: lineId, qtyMilli: q(1), unit: '箱', customKind: 'custom', customSpec: { size: '一箱 20 件', craft: '涤棉', scene: '前台', sample: false, budgetCents: null }, details: '' }],
    });
    expect(boxed.status, JSON.stringify(boxed.body)).toBe(200);
    expect(boxed.body.quotes).toHaveLength(0);
    const [gone] = await ctx.sql<{ status: string }[]>`SELECT status FROM mall_request_quotes WHERE id = ${qt.id}`;
    expect(gone!.status).toBe('withdrawn');
  });
});
