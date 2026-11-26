// 业财法 P04 七类合同审批（docs/APPROVAL_V4.md 第 8 节，合成数据、测试库）：档位（场景 6–10）、工程（场景 44）、
// 履约执行人 +1（场景 43 复验）、经济实质与混合合同（场景 36）、全合同期口径、库内供应商 + 有效 SKU 价格一致与免重复准入、
// 「其他」财法确认归属才能签署、签署 → 用印 → 1 个工作日归档、变更（场景 30：减金额保留、核心变更作废重走）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCreditCheck } from '../src/shared/govflow-supply';
import { act, mapRole, setupPeople, yuan, type People } from './govflow-helpers';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let p: People;
const c = (u: string) => p.cookies[u]!;
const contract = (body: Record<string, unknown> = {}, cookie = c('gf_clerk')) =>
  api(ctx.app, cookie, 'POST', '/api/gf/contracts', {
    clientKey: randomUUID(),
    type: 'service',
    title: '合成保洁服务',
    counterparty: '合成保洁公司',
    departmentId: p.deptId,
    performerId: p.ids.gf_perf,
    substance: { laborResult: true },
    totalExTaxCents: yuan(5_000),
    ...body,
  });
const doc = async (id: number, cookie = c('gf_clerk')) => (await api(ctx.app, cookie, 'GET', `/api/gf/docs/${id}`)).body;
const labels = (d: { nodes: { label: string }[] }) => d.nodes.map((x) => x.label);
let supplierId: number;
let skuId: number;

/** 走完前三级：部门负责人 → 履约执行人 → 财务、法务 */
async function through3(id: number) {
  await act(ctx, c('gf_head'), id, 1);
  await act(ctx, c('gf_perf'), id, 2);
  await act(ctx, c('gf_fin'), id, 3);
  return act(ctx, c('gf_legal'), id, 3);
}

beforeAll(async () => {
  ctx = await setup();
  p = await setupPeople(ctx);
  // 库内供应商与一个有效 SKU（走完入库与 SKU 审批）
  const mat = (await api(ctx.app, c('gf_sc'), 'POST', '/api/gf/materials', { code: 'MAT-SOAP', name: '洗手液', category: 'general', unit: '瓶' })).body.id;
  const s = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/suppliers', {
    clientKey: randomUUID(),
    name: '合成日化',
    creditCode: withCreditCheck('91440300MA5P00001'),
    categories: ['general'],
    bankName: '合成银行',
    bankAccount: '6222000000000001',
    accountName: '合成日化',
    qualifications: [
      { kind: 'business_license', no: 'A', expiresOn: null },
      { kind: 'bank_account_proof', no: 'B', expiresOn: null },
    ],
  });
  supplierId = s.body.id;
  const a = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/suppliers/${supplierId}/admit`, { clientKey: randomUUID() });
  await act(ctx, c('gf_sc'), a.body.docId, 1);
  await act(ctx, c('gf_ic'), a.body.docId, 2);
  await act(ctx, c('gf_chair'), a.body.docId, 3);
  const b = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/sku-batches', {
    clientKey: randomUUID(),
    supplierId,
    lines: [{ materialId: mat, name: '洗手液 500ml', unit: '瓶', priceCents: yuan(12.5) }],
  });
  await act(ctx, c('gf_sc'), b.body.docId, 1);
  await act(ctx, c('gf_chair'), b.body.docId, 2);
  skuId = (await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/selector/suppliers/${supplierId}/skus`)).body.skus[0].id;
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

describe('档位（场景 6–10）与工程（场景 44）', () => {
  it.each([
    [yuan(10_000) - 1, '财总'],
    [yuan(10_000), 'CFO'],
    [yuan(50_000) - 1, 'CFO'],
    [yuan(50_000), 'CEO'],
    [yuan(300_000) - 1, 'CEO'],
    [yuan(300_000), '董事长'],
  ])('服务合同不含税 %i 分 → 终审 %s；不含税口径、库外相对方加内控', async (cents, last) => {
    const r = await contract({ totalExTaxCents: cents, taxInclusiveCents: Math.round(cents * 1.06) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = await doc(r.body.docId);
    expect(d.amountCents).toBe(cents);
    expect(labels(d).slice(0, 3)).toEqual(['部门负责人', '内部履约执行人', '财务、法务并行分审（分别出结论）']);
    expect(labels(d).at(-1)).toBe(last);
    expect(labels(d)).toContain('内控');
  });
  it('工程：5,000 元也到 CEO；300,000.00 起 CEO → 董事长', async () => {
    const small = await contract({ type: 'engineering', substance: { construction: true }, totalExTaxCents: yuan(5_000) });
    expect(labels(await doc(small.body.docId)).slice(-1)).toEqual(['CEO']);
    const big = await contract({ type: 'engineering', substance: { construction: true }, totalExTaxCents: yuan(300_000) });
    expect(labels(await doc(big.body.docId)).slice(-3)).toEqual(['内控', 'CEO', '董事长']);
  });
  it('预付款至少 CFO', async () => {
    const r = await contract({ totalExTaxCents: yuan(100), flags: ['prepay'] });
    expect(labels(await doc(r.body.docId)).at(-1)).toBe('CFO');
  });
  it('租赁按全合同期口径：每月 2 万 × 36 期 = 72 万 → 董事长', async () => {
    const r = await contract({ type: 'lease', substance: { periodUse: true }, totalExTaxCents: null, perPeriodExTaxCents: yuan(20_000), periods: 36 });
    const d = await doc(r.body.docId);
    expect(d.amountCents).toBe(yuan(720_000));
    expect(labels(d).at(-1)).toBe('董事长');
    expect((await contract({ type: 'lease', substance: { periodUse: true }, totalExTaxCents: yuan(100) })).body.error.code).toBe('GF_PERIOD_AMOUNT');
  });
});

describe('类型判定（场景 36）', () => {
  it('选的类型与经济实质不符拒绝；混合合同不写不能拆的原因拒绝', async () => {
    const wrong = await contract({ type: 'purchase', substance: { laborResult: true } });
    expect(wrong.body.error).toMatchObject({ code: 'GF_TYPE_MISMATCH', details: { suggested: 'service' } });
    const mixed = await contract({ type: 'purchase', substance: { ownership: true, laborResult: true } });
    expect(mixed.body.error.code).toBe('GF_SPLIT');
    const ok = await contract({ type: 'purchase', substance: { ownership: true, laborResult: true }, cannotSplitReason: '一体交付，无法拆分' });
    expect(ok.status).toBe(200);
    // 施工附带设备不可分：归工程
    const eng = await contract({ type: 'engineering', substance: { construction: true, ownership: true, equipmentInseparable: true } });
    expect(eng.status).toBe(200);
  });
  it('「其他」类要财法确认归属才能签署；发起人不能自己确认', async () => {
    const r = await contract({ type: 'other', substance: {}, totalExTaxCents: yuan(500) });
    const id = r.body.docId;
    await through3(id);
    let x = (await act(ctx, c('gf_chief'), id, 4)).body;
    expect(x.status).toBe('to_execute');
    const sign = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/docs/${id}/execute`, { version: x.version, step: 'start' });
    expect(sign.body.error.code).toBe('GF_TYPE_UNCONFIRMED');
    expect((await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/contracts/${id}/confirm-type`, { type: 'service' })).status).toBe(403);
    expect((await api(ctx.app, c('gf_legal'), 'POST', `/api/gf/contracts/${id}/confirm-type`, { type: 'service' })).status).toBe(200);
    x = await doc(id);
    // 相对方不在库里：还是签不了，要先入库
    const sign2 = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/docs/${id}/execute`, { version: x.version, step: 'start' });
    expect(sign2.body.error.code).toBe('GF_SUPPLIER_NOT_ACTIVE');
  });
});

describe('库内供应商 + 有效 SKU', () => {
  it('价格必须等于现行协议价；一致的免重复准入（不加内控），财法审核与金额终审保留', async () => {
    const bad = await contract({ type: 'purchase', substance: { ownership: true }, supplierId, lines: [{ skuId, qty: 100, priceCents: yuan(13) }], totalExTaxCents: yuan(1300) });
    expect(bad.body.error.code).toBe('GF_PRICE_MISMATCH');
    const sumBad = await contract({ type: 'purchase', substance: { ownership: true }, supplierId, lines: [{ skuId, qty: 100, priceCents: yuan(12.5) }], totalExTaxCents: yuan(1300) });
    expect(sumBad.body.error.code).toBe('GF_AMOUNT_MISMATCH');
    const ok = await contract({ type: 'purchase', substance: { ownership: true }, supplierId, lines: [{ skuId, qty: 100, priceCents: yuan(12.5) }], totalExTaxCents: yuan(1250) });
    const d = await doc(ok.body.docId);
    expect(labels(d)).toEqual(['部门负责人', '内部履约执行人', '财务、法务并行分审（分别出结论）', '财总']);
    expect(d.payload.inLibrary).toBe(true);
  });

  it('签署 → 用印 → 1 个工作日内归档（之前是后补待完成），合同知会财总、CFO', async () => {
    const r = await contract({ type: 'purchase', substance: { ownership: true }, supplierId, lines: [{ skuId, qty: 10, priceCents: yuan(12.5) }], totalExTaxCents: yuan(125) });
    const id = r.body.docId;
    await through3(id);
    let x = (await act(ctx, c('gf_chief'), id, 4)).body;
    expect(x.cc.every((cc: { role: string }) => cc.role === 'cfo')).toBe(true);
    x = (await api(ctx.app, c('gf_perf'), 'POST', `/api/gf/docs/${id}/execute`, { version: x.version, step: 'start' })).body;
    expect(x.status).toBe('executing');
    x = (await api(ctx.app, c('gf_perf'), 'POST', `/api/gf/docs/${id}/execute`, { version: x.version, step: 'complete' })).body;
    expect(x.status).toBe('backfill_pending');
    const view = (await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/contracts/${id}`)).body.contract;
    expect(view.archiveDueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(view.sealedAt).toBeTruthy();
    x = (await api(ctx.app, c('gf_perf'), 'POST', `/api/gf/docs/${id}/execute`, { version: x.version, step: 'archive' })).body;
    expect(x.status).toBe('archived');
  });
});

describe('场景 43 复验：履约执行人与部门负责人同一人不重复', () => {
  it('合同上履约执行人选部门负责人：链里不出现履约执行人', async () => {
    await mapRole(ctx, 'performer', p.ids.gf_head!);
    const r = await contract({ performerId: p.ids.gf_head });
    expect(labels(await doc(r.body.docId))).not.toContain('内部履约执行人');
  });
});

describe('变更（场景 30）', () => {
  async function approved(cents: number) {
    const r = await contract({ totalExTaxCents: cents });
    await through3(r.body.docId);
    const last = cents >= yuan(10_000) ? 'gf_cfo' : 'gf_chief';
    // 库外相对方：第 4 级内控
    await act(ctx, c('gf_ic'), r.body.docId, 4);
    await act(ctx, c(last), r.body.docId, 5);
    return r.body.docId as number;
  }
  it('只减金额、其他不变：保留原审批，留变更记录', async () => {
    const id = await approved(yuan(8_000));
    const ch = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/contracts/${id}/change`, { clientKey: randomUUID(), fields: ['amount'], totalExTaxCents: yuan(7_000), reason: '减少频次' });
    expect(ch.body).toEqual({ docId: id, kept: true });
    const d = await doc(id);
    expect(d).toMatchObject({ status: 'to_execute', amountCents: yuan(7_000), round: 1 });
    const v = (await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/contracts/${id}`)).body.versions;
    expect(v.map((x: { kind: string }) => x.kind)).toEqual(['initial', 'decrease']);
  });
  it('加金额：原审批作废，新事项按新金额重新路由（8,000 → 20,000 终审升到 CFO）', async () => {
    const id = await approved(yuan(8_000));
    const ch = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/contracts/${id}/change`, { clientKey: randomUUID(), fields: ['amount'], totalExTaxCents: yuan(20_000), reason: '增加范围' });
    expect(ch.body.kept).toBe(false);
    expect((await doc(id)).status).toBe('withdrawn');
    const next = await doc(ch.body.docId);
    expect(next).toMatchObject({ status: 'reviewing', amountCents: yuan(20_000) });
    expect(labels(next).at(-1)).toBe('CFO');
    // 作废的不能再签署、不能再变更
    expect(
      (await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/contracts/${id}/change`, { clientKey: randomUUID(), fields: ['amount'], totalExTaxCents: yuan(1), reason: '再改' })).body.error.code,
    ).toBe('GF_SUPERSEDED');
  });
  it('改相对方（核心）：即使金额减少也重新路由', async () => {
    const id = await approved(yuan(8_000));
    const ch = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/contracts/${id}/change`, {
      clientKey: randomUUID(),
      fields: ['amount', 'party'],
      totalExTaxCents: yuan(7_000),
      reason: '换主体',
      patch: { counterparty: '合成保洁二公司' },
    });
    expect(ch.body.kept).toBe(false);
  });
});
