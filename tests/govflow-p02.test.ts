// 业财法 P02 供应商与商品 SKU 两级库（docs/APPROVAL_V4.md 第 6 节，合成数据、测试库）：
// 统一社会信用代码查重与校验、资料统一必填 + 按品类触发、入库 供应链负责人 → 内控 → 董事长（知会 CFO、财总）、
// SKU 批量提报逐个建码、董事长逐个确认异常 SKU（不能一键全过）、核心 / 一般变更、审核期间不算库内简化、
// 选择器只给已入库与有效 SKU、历史数据迁移先进待审、收款账号按最小权限。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCreditCheck } from '../src/shared/govflow-supply';
import { inLibrary } from '../src/server/modules/govflow/supply';
import { act, setupPeople, yuan, type People } from './govflow-helpers';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let p: People;
const c = (u: string) => p.cookies[u]!;
let seq = 0;
const credit = () => withCreditCheck(`91440300MA5${String(100000 + seq++).padStart(6, '0')}`);
const quals = [
  { kind: 'business_license', no: 'YYZZ-001', expiresOn: null },
  { kind: 'bank_account_proof', no: 'KH-001', expiresOn: null },
];
const newSupplier = (body: Record<string, unknown> = {}, cookie = c('gf_clerk')) =>
  api(ctx.app, cookie, 'POST', '/api/gf/suppliers', {
    clientKey: randomUUID(),
    name: `合成供应商${seq}`,
    creditCode: credit(),
    categories: ['general'],
    bankName: '合成银行',
    bankAccount: '6222000011112222',
    accountName: '合成供应商',
    qualifications: quals,
    ...body,
  });
const doc = async (id: number, cookie = c('gf_clerk')) => (await api(ctx.app, cookie, 'GET', `/api/gf/docs/${id}`)).body;
/** 建档并走完入库 */
async function activeSupplier() {
  const s = await newSupplier();
  const a = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/suppliers/${s.body.id}/admit`, { clientKey: randomUUID() });
  await act(ctx, c('gf_sc'), a.body.docId, 1);
  await act(ctx, c('gf_ic'), a.body.docId, 2);
  await act(ctx, c('gf_chair'), a.body.docId, 3);
  return s.body.id as number;
}
let matA: number;
let matCore: number;

beforeAll(async () => {
  ctx = await setup();
  p = await setupPeople(ctx);
  matA = (await api(ctx.app, c('gf_sc'), 'POST', '/api/gf/materials', { code: 'MAT-TOWEL', name: '浴巾', category: 'general', unit: '条' })).body.id;
  matCore = (await api(ctx.app, c('gf_sc'), 'POST', '/api/gf/materials', { code: 'MAT-CHEM', name: '消毒剂', category: 'chemical', unit: '桶', core: true })).body.id;
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

describe('一级供应商库', () => {
  it('统一社会信用代码：校验位不对拒绝；重复的不能建档；经办人建档是「待准入」', async () => {
    const bad = await newSupplier({ creditCode: '91440300MA5000000X' });
    expect(bad.body.error.code).toBe('GF_CREDIT_CODE');
    const code = credit();
    const s = await newSupplier({ creditCode: code });
    expect(s.body.status).toBe('pending');
    const dup = await newSupplier({ creditCode: code, name: '另一个名字' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('GF_SUPPLIER_DUP');
  });

  it('资料：统一必填 + 按品类触发（食品要食品经营许可证），缺的不能提交入库', async () => {
    const s = await newSupplier({ categories: ['food'] });
    expect(s.body.missing).toEqual(['缺「食品经营许可证」']);
    const a = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/suppliers/${s.body.id}/admit`, { clientKey: randomUUID() });
    expect(a.body.error.code).toBe('GF_QUALIFICATION');
  });

  it('场景 28：入库 供应链负责人 → 内控（新供应商）→ 董事长，通过后已入库并知会 CFO、财总', async () => {
    const s = await newSupplier();
    const a = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/suppliers/${s.body.id}/admit`, { clientKey: randomUUID() });
    const d = await doc(a.body.docId);
    expect(d.nodes.map((n: { label: string }) => n.label)).toEqual(['供应链负责人', '内控', '董事长']);
    expect((await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/suppliers/${s.body.id}`)).body.supplier.status).toBe('reviewing');
    // 审核中的不能再提交、不进选择器
    expect((await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/suppliers/${s.body.id}/admit`, { clientKey: randomUUID() })).status).toBe(409);
    expect((await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/selector/suppliers/${s.body.id}/skus`)).status).toBe(409);
    await act(ctx, c('gf_sc'), a.body.docId, 1);
    await act(ctx, c('gf_ic'), a.body.docId, 2);
    const done = await act(ctx, c('gf_chair'), a.body.docId, 3);
    expect(done.body.status).toBe('to_execute');
    expect(done.body.cc.every((r: { role: string }) => r.role === 'cfo' || r.role === 'finance_chief')).toBe(true);
    const after = (await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/suppliers/${s.body.id}`)).body;
    expect(after.supplier.status).toBe('active');
    expect(after.versions.map((v: { version: number }) => v.version)).toEqual([1]);
  });

  it('退回后供应商回到「待准入」，改了资料可以再提交', async () => {
    const s = await newSupplier();
    const a = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/suppliers/${s.body.id}/admit`, { clientKey: randomUUID() });
    const r = await act(ctx, c('gf_sc'), a.body.docId, 1, 'return', '开户证明模糊');
    expect(r.body.status).toBe('returned');
    expect((await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/suppliers/${s.body.id}`)).body.supplier.status).toBe('pending');
    const again = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/docs/${a.body.docId}/submit`, { version: r.body.version });
    expect(again.body.status).toBe('reviewing');
  });

  it('收款账号按最小权限：经办人以外的普通员工只看尾号，CFO 看全', async () => {
    const id = await activeSupplier();
    const other = (await api(ctx.app, c('gf_clerk2'), 'GET', `/api/gf/suppliers/${id}`)).body.supplier;
    expect(other.bankAccount).toBe('****2222');
    expect(other.bankMasked).toBe(true);
    expect((await api(ctx.app, c('gf_cfo'), 'GET', `/api/gf/suppliers/${id}`)).body.supplier.bankAccount).toBe('6222000011112222');
  });

  it('场景 37：历史数据迁移一律进「待准入」，查重的跳过；不能直接用', async () => {
    const code = credit();
    const rows = [
      { clientKey: randomUUID(), name: '历史供应商甲', creditCode: code, categories: ['general'] },
      { clientKey: randomUUID(), name: '历史供应商甲重复', creditCode: code, categories: ['general'] },
      { clientKey: randomUUID(), name: '错码', creditCode: '123', categories: ['general'] },
    ];
    expect((await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/suppliers/import', { rows })).status).toBe(403);
    const r = await api(ctx.app, c('gf_sc'), 'POST', '/api/gf/suppliers/import', { rows });
    expect(r.body.created).toBe(1);
    expect(r.body.skipped.length).toBe(2);
    const list = (await api(ctx.app, c('gf_sc'), 'GET', `/api/gf/suppliers?q=${code}`)).body;
    expect(list[0]).toMatchObject({ status: 'pending', legacy: true });
    const sel = (await api(ctx.app, c('gf_clerk'), 'GET', '/api/gf/selector/suppliers?q=历史')).body;
    expect(sel.length).toBe(0);
  });
});

describe('二级 SKU 库', () => {
  it('SKU 只能挂在已入库的供应商下', async () => {
    const s = await newSupplier();
    const r = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/sku-batches', {
      clientKey: randomUUID(),
      supplierId: s.body.id,
      lines: [{ materialId: matA, name: '浴巾', unit: '条', priceCents: yuan(20) }],
    });
    expect(r.body.error.code).toBe('GF_SUPPLIER_STATUS');
  });

  it('场景 29、31、35：一批 SKU 一张单逐个建码；董事长要逐个确认异常的（价格高、核心品类），不能一键全过', async () => {
    const base = await activeSupplier();
    const b0 = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/sku-batches', {
      clientKey: randomUUID(),
      supplierId: base,
      lines: [{ materialId: matA, name: '浴巾 A', unit: '条', priceCents: yuan(20) }],
    });
    await act(ctx, c('gf_sc'), b0.body.docId, 1);
    await act(ctx, c('gf_chair'), b0.body.docId, 2);
    const sid = await activeSupplier();
    const lines = [
      { materialId: matA, name: '浴巾 B', unit: '条', priceCents: yuan(22) }, // 高 10%：不算异常（整值）
      { materialId: matA, name: '浴巾 C', unit: '条', priceCents: yuan(22) + 1 }, // 高 10% 多一分：异常
      { materialId: matCore, name: '消毒剂', unit: '桶', priceCents: yuan(80) }, // 核心品类
    ];
    const b = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/sku-batches', { clientKey: randomUUID(), supplierId: sid, lines });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    const d = await doc(b.body.docId);
    expect(d.nodes.map((n: { label: string }) => n.label)).toEqual(['供应链负责人', '内控', '董事长']);
    const review = (await api(ctx.app, c('gf_chair'), 'GET', `/api/gf/sku-batches/${b.body.docId}/review`)).body;
    expect(review.count).toBe(3);
    expect(review.normal.map((x: { name: string }) => x.name)).toEqual(['浴巾 B']);
    expect(review.abnormal.map((x: { name: string; reasons: string[] }) => [x.name, x.reasons])).toEqual([
      ['浴巾 C', ['price_high']],
      ['消毒剂', ['core_category']],
    ]);
    const codes = new Set([...review.normal, ...review.abnormal].map((x: { skuCode: string }) => x.skuCode));
    expect(codes.size).toBe(3);
    await act(ctx, c('gf_sc'), b.body.docId, 1);
    await act(ctx, c('gf_ic'), b.body.docId, 2);
    // 一键全过：拒绝
    const blind = await act(ctx, c('gf_chair'), b.body.docId, 3);
    expect(blind.body.error.code).toBe('GF_SKU_DECISIONS');
    const partial = await api(ctx.app, c('gf_chair'), 'POST', `/api/gf/docs/${b.body.docId}/act`, {
      clientKey: randomUUID(),
      action: 'approve',
      level: 3,
      extra: { decisions: [{ skuId: review.abnormal[0].skuId, decision: 'reject' }] },
    });
    expect(partial.body.error.code).toBe('GF_SKU_DECISIONS');
    const ok = await api(ctx.app, c('gf_chair'), 'POST', `/api/gf/docs/${b.body.docId}/act`, {
      clientKey: randomUUID(),
      action: 'approve',
      level: 3,
      extra: {
        decisions: [
          { skuId: review.abnormal[0].skuId, decision: 'reject' },
          { skuId: review.abnormal[1].skuId, decision: 'approve' },
        ],
      },
    });
    expect(ok.body.status).toBe('to_execute');
    const sel = (await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/selector/suppliers/${sid}/skus`)).body;
    expect(sel.skus.map((k: { name: string }) => k.name).sort()).toEqual(['浴巾 B', '消毒剂']);
    expect(sel.skus.every((k: { priceVersion: number }) => k.priceVersion === 1)).toBe(true);
  });
});

describe('变更', () => {
  it('场景 32：收款账户（核心）变更 供应链负责人 → 董事长；审核期间不能再变更、不算库内简化；通过后新版本、历史版本保留', async () => {
    const sid = await activeSupplier();
    expect((await inLibrary(ctx.sql, sid)).ok).toBe(true);
    const ch = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/suppliers/${sid}/change`, { clientKey: randomUUID(), reason: '换开户行', changes: { bankAccount: '6222999988887777' } });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    const d = await doc(ch.body.docId);
    expect(d.nodes.map((n: { label: string }) => n.label)).toEqual(['供应链负责人', '董事长']);
    expect((await inLibrary(ctx.sql, sid)).ok).toBe(false);
    const second = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/suppliers/${sid}/change`, { clientKey: randomUUID(), reason: '再改', changes: { phone: '123' } });
    expect(second.body.error.code).toBe('GF_CHANGE_PENDING');
    const sel = (await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/selector/suppliers/${sid}/skus`)).body;
    expect(sel.changePending).toBe(true);
    await act(ctx, c('gf_sc'), ch.body.docId, 1);
    await act(ctx, c('gf_chair'), ch.body.docId, 2);
    const after = (await api(ctx.app, c('gf_cfo'), 'GET', `/api/gf/suppliers/${sid}`)).body;
    expect(after.supplier).toMatchObject({ bankAccount: '6222999988887777', version: 2, pendingChangeDocId: null });
    expect(after.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    const [v1] = await ctx.sql`SELECT snapshot FROM gf_supplier_versions WHERE supplier_id = ${sid} AND version = 1`;
    expect((v1!.snapshot as { bankAccount: string }).bankAccount).toBe('6222000011112222');
    expect((await inLibrary(ctx.sql, sid)).ok).toBe(true);
  });

  it('一般资料（电话）只要供应链负责人审核留痕，不知会', async () => {
    const sid = await activeSupplier();
    const ch = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/suppliers/${sid}/change`, { clientKey: randomUUID(), reason: '换电话', changes: { phone: '0755-1234' } });
    const done = await act(ctx, c('gf_sc'), ch.body.docId, 1);
    expect(done.body.nodes.map((n: { label: string }) => n.label)).toEqual(['供应链负责人']);
    expect(done.body.status).toBe('to_execute');
    expect(done.body.cc).toEqual([]);
  });

  it('SKU 协议价变更：新版本、旧版本保留；变动超过 10% 加内控', async () => {
    const sid = await activeSupplier();
    const b = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/sku-batches', {
      clientKey: randomUUID(),
      supplierId: sid,
      lines: [{ materialId: matA, name: '浴巾 Z', unit: '条', priceCents: yuan(18) }],
    });
    await act(ctx, c('gf_sc'), b.body.docId, 1);
    await act(ctx, c('gf_chair'), b.body.docId, 2);
    const sku = (await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/selector/suppliers/${sid}/skus`)).body.skus[0];
    const pc = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/skus/${sku.id}/price`, { clientKey: randomUUID(), priceCents: yuan(25), reason: '原料涨价' });
    const d = await doc(pc.body.docId);
    expect(d.nodes.map((n: { label: string }) => n.label)).toEqual(['供应链负责人', '内控', '董事长']);
    expect((await inLibrary(ctx.sql, sid, [sku.id])).ok).toBe(false);
    await act(ctx, c('gf_sc'), pc.body.docId, 1);
    await act(ctx, c('gf_ic'), pc.body.docId, 2);
    await act(ctx, c('gf_chair'), pc.body.docId, 3);
    const prices = (await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/skus/${sku.id}/prices`)).body;
    expect(prices.map((x: { version: number; priceCents: number }) => [x.version, x.priceCents])).toEqual([
      [1, yuan(18)],
      [2, yuan(25)],
    ]);
  });
});
