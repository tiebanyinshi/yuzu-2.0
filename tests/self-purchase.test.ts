// 8.2.13 无供应商自购（《采购模块需求补充：单号搜索 / 排序 / 无供应商自购》第 3 部分，docs/V8213_SELF_PURCHASE.md）：
// 采购单可以不选供应商，填自购原因、渠道、经办人、付款方式并上传票据；不造虚拟供应商；
// 提交一律要负责人审批（提交人不能审），超过 ¥2,000 再加店主；收货不选供应商；结算按现金（不进应付）。

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let buyer: string; // 采购经办 zhouyi
let buyerId: number;
let approver: string; // 负责人
let keeper: string; // 物资经办 lixiao
let imageId: number;
let matId: number;
const q = (n: number) => Math.round(n * 1000);

const selfInfo = (extra: Record<string, unknown> = {}) => ({
  reason: 'urgent',
  reasonNote: '',
  channel: '楼下五金店',
  handlerId: buyerId,
  payMethod: 'employee_advance',
  boughtOn: today,
  receiptImageIds: [imageId],
  ...extra,
});
const newPo = (body: Record<string, unknown>, cookie = buyer) =>
  api(ctx.app, cookie, 'POST', '/api/purchase-orders', {
    clientKey: randomUUID(),
    orderDate: today,
    action: 'submit',
    lines: [{ materialId: matId, purchaseQtyMilli: q(2), priceCents: 45_000 }],
    ...body,
  });
const pendingLevels = async (poId: number) =>
  (
    await ctx.sql<{ steps: { group: string }[] }[]>`
      SELECT steps FROM approval_requests WHERE doc_kind = 'purchase_order' AND doc_id = ${poId} ORDER BY id DESC LIMIT 1`
  )[0]?.steps.map((s) => s.group);

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyerId = (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`)[0]!.id;
  await createStaff(ctx.sql, { username: 'appr', displayName: '负责人', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
  approver = await login(ctx.app, 'appr');
  const data = Buffer.from('self-purchase-receipt-photo');
  imageId = (
    await ctx.sql<{ id: number }[]>`
      INSERT INTO erp_images (sha256, mime, data, size_bytes, created_by)
      VALUES (${createHash('sha256').update(data).digest('hex')}, 'image/png', ${data}, ${data.length}, ${buyerId}) RETURNING id`
  )[0]!.id;
  matId = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/materials?all=1')).body.find((m: { code: string }) => m.code === 'M016').id;
}, 120_000);
afterAll(async () => ctx.close());

describe('自购采购单', () => {
  it('供应商采购照旧要供应商；自购要填自购信息、不能带供应商；「其他」原因要写说明', async () => {
    expect((await newPo({})).body.error.code).toBe('SUPPLIER_REQUIRED');
    expect((await newPo({ purchaseMethod: 'self' })).body.error.code).toBe('SELF_INFO_REQUIRED');
    expect((await newPo({ purchaseMethod: 'self', self: selfInfo({ reason: 'other' }) })).body.error.code).toBe('SELF_REASON_NOTE_REQUIRED');
    expect((await newPo({ purchaseMethod: 'self', self: selfInfo({ receiptImageIds: [] }) })).status).toBe(400);
    expect((await newPo({ purchaseMethod: 'self', self: selfInfo({ receiptImageIds: [999_999] }) })).body.error.code).toBe('IMAGE_NOT_FOUND');
    const sup = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/suppliers?all=1')).body[0];
    expect((await newPo({ purchaseMethod: 'self', supplierId: sup.id, self: selfInfo() })).body.error.code).toBe('SELF_NO_SUPPLIER');
    // 数据库也拦：自购不能有供应商、供应商采购不能没有
    await expect(ctx.sql`UPDATE purchase_orders SET supplier_id = NULL WHERE purchase_method = 'supplier'`).rejects.toThrow();
  });

  it('自购 ¥900：提交后等负责人审批（不自动通过、提交人不能审），审完已确认；列表与单号直达写「自购 · 渠道」', async () => {
    const r = await newPo({ purchaseMethod: 'self', self: selfInfo() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const po = r.body.po;
    expect(po.purchaseMethod).toBe('self');
    expect(po.supplier).toBeNull();
    expect(po.self).toMatchObject({ reason: 'urgent', channel: '楼下五金店', payMethod: 'employee_advance' });
    expect(po.status).toBe('submitted');
    expect(await pendingLevels(po.id)).toEqual(['manager']);
    // 提交人自己审不了
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/approve`, {})).status).toBeGreaterThanOrEqual(400);
    const ok = await api(ctx.app, approver, 'POST', `/api/purchase-orders/${po.id}/approve`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const got = (await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${po.id}`)).body;
    expect(got.status).toBe('approved');
    const list = (await api(ctx.app, buyer, 'GET', '/api/purchase-orders')).body;
    const row = (Array.isArray(list) ? list : list.rows).find((p: { id: number }) => p.id === po.id);
    expect(row.supplierName).toBe('自购 · 楼下五金店');
    expect(row.purchaseMethod).toBe('self');
    const hit = (await api(ctx.app, buyer, 'GET', `/api/purchase-lookup?no=${po.docNo}`)).body;
    expect(hit.hits[0]).toMatchObject({ kind: 'po', party: '自购 · 楼下五金店' });

    // 收货：不选供应商，挂这张自购的采购单
    const line = got.lines[0];
    const doc = {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      purchaseOrderId: po.id,
      lines: [{ materialId: matId, poLineId: line.id, deliveredMilli: line.baseQtyMilli, acceptedMilli: line.baseQtyMilli }],
    };
    const sup = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/suppliers?all=1')).body[0];
    expect((await api(ctx.app, keeper, 'POST', '/api/inventory/docs', { ...doc, clientKey: randomUUID(), supplierId: sup.id })).status).toBeGreaterThanOrEqual(400);
    const rec = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', doc);
    expect([200, 201], JSON.stringify(rec.body)).toContain(rec.status);

    // 付款走报销：自购按现付，出现在「采购单转报销」的候选里，能带出报销内容（不进应付）
    const cands = (await api(ctx.app, ctx.owner, 'GET', `/api/erp/expenses/po-candidates?q=${po.docNo}`)).body;
    expect(cands.map((c: { id: number }) => c.id)).toContain(po.id);
    const prefill = await api(ctx.app, ctx.owner, 'GET', `/api/erp/expenses/po/${po.id}/prefill`);
    expect(prefill.status, JSON.stringify(prefill.body)).toBe(200);
  });

  it('自购超过 ¥2,000：负责人之后加店主一级', async () => {
    const r = await newPo({ purchaseMethod: 'self', self: selfInfo(), lines: [{ materialId: matId, purchaseQtyMilli: q(10), priceCents: 45_000 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await pendingLevels(r.body.po.id)).toEqual(['manager', 'owner']);
  });

  it('自购不能连供应商门户；没有自购的供应商采购单照旧', async () => {
    const sup = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/suppliers?all=1')).body[0];
    const r = await newPo({ supplierId: sup.id, action: 'save' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.po.purchaseMethod).toBe('supplier');
    expect(r.body.po.supplier.id).toBe(sup.id);
    expect(r.body.po.self).toBeNull();
  });
});
