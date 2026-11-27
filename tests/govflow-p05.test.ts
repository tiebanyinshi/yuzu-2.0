// 业财法 P05 付款与紧急特批（docs/APPROVAL_V4.md 第 9 节，合成数据、测试库）：
// 正常付款简化（场景 11）、无合同付款拦截与高额链（场景 13、24）、紧急特批（场景 14–16）、发票先票后款与后补（场景 21）、
// 重复支付校验（剩余应付、同一发票号、银行流水号）、收款账户变更后重新确认、出纳独立核验。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCreditCheck } from '../src/shared/govflow-supply';
import { act, okShot, setupPeople, yuan, type People } from './govflow-helpers';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let p: People;
const c = (u: string) => p.cookies[u]!;
const doc = async (id: number, cookie = c('gf_clerk')) => (await api(ctx.app, cookie, 'GET', `/api/gf/docs/${id}`)).body;
const labels = (d: { nodes: { label: string }[] }) => d.nodes.map((x) => x.label);
let code = 1;
const ACCOUNT = '6222111122223333';

async function activeSupplier(name: string, account = ACCOUNT) {
  const s = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/suppliers', {
    clientKey: randomUUID(),
    name,
    creditCode: withCreditCheck(`91440300MA5Q${String(code++).padStart(5, '0')}`),
    categories: ['general'],
    bankName: '合成银行',
    bankAccount: account,
    accountName: name,
    qualifications: [
      { kind: 'business_license', no: 'A', expiresOn: null },
      { kind: 'bank_account_proof', no: 'B', expiresOn: null },
    ],
  });
  const a = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/suppliers/${s.body.id}/admit`, { clientKey: randomUUID() });
  await act(ctx, c('gf_sc'), a.body.docId, 1);
  await act(ctx, c('gf_ic'), a.body.docId, 2);
  await act(ctx, c('gf_chair'), a.body.docId, 3);
  return s.body.id as number;
}
/** 审批通过的服务合同（库内供应商，含税金额） */
async function approvedContract(supplierId: number, exTax: number, taxIncl: number) {
  const r = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/contracts', {
    clientKey: randomUUID(),
    type: 'service',
    title: '合成维保',
    counterparty: '合成维保公司',
    supplierId,
    departmentId: p.deptId,
    performerId: p.ids.gf_perf,
    substance: { laborResult: true },
    totalExTaxCents: exTax,
    taxInclusiveCents: taxIncl,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const id = r.body.docId;
  await act(ctx, c('gf_head'), id, 1);
  await act(ctx, c('gf_perf'), id, 2);
  await act(ctx, c('gf_fin'), id, 3);
  await act(ctx, c('gf_legal'), id, 3);
  const d = await act(ctx, c('gf_chief'), id, 4);
  expect(d.body.status).toBe('to_execute');
  return id as number;
}
const pay = (body: Record<string, unknown>, cookie = c('gf_clerk')) =>
  api(ctx.app, cookie, 'POST', '/api/gf/payments', {
    clientKey: randomUUID(),
    title: '合成付款',
    departmentId: p.deptId,
    category: 'service',
    invoice: 'received',
    acceptanceBasis: '验收单 YS-001',
    ...body,
  });
async function approveNormal(id: number) {
  await act(ctx, c('gf_head'), id, 1);
  await act(ctx, c('gf_fin'), id, 2);
  return act(ctx, c('gf_cash'), id, 3);
}

beforeAll(async () => {
  ctx = await setup();
  p = await setupPeople(ctx);
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

describe('正常付款（场景 11）', () => {
  it('有效合同 + 验收依据 + 剩余应付内 + 已取票：部门负责人 → 财务 → 出纳；出纳要重新输入账号核验、流水号唯一', async () => {
    const sid = await activeSupplier('合成维保公司');
    const cid = await approvedContract(sid, yuan(5_000), yuan(5_300));
    const r = await pay({ contractDocId: cid, amountCents: yuan(3_000), invoiceNo: 'FP-11' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(labels(await doc(r.body.docId))).toEqual(['部门负责人', '财务审核人', '出纳']);
    // 超过剩余应付（5,300 − 3,000 = 2,300，在途也算）拒绝：重复支付
    expect((await pay({ contractDocId: cid, amountCents: yuan(2_300) + 1, invoiceNo: 'FP-12' })).body.error.code).toBe('GF_OVERPAY');
    // 同一收款方同一发票号只付一次
    expect((await pay({ contractDocId: cid, amountCents: yuan(100), invoiceNo: 'FP-11' })).body.error.code).toBe('GF_DUPLICATE_PAYMENT');
    // 没有验收依据（非预付）拦截
    expect((await pay({ contractDocId: cid, amountCents: yuan(100), acceptanceBasis: '' })).body.error.code).toBe('GF_PAYMENT_BLOCKED');
    await approveNormal(r.body.docId);
    expect(
      (await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/payments/${r.body.docId}/pay`, { clientKey: randomUUID(), amountCents: yuan(3_000), bankRef: 'YH-1', accountConfirm: ACCOUNT })).status,
    ).toBe(403);
    const wrong = await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/payments/${r.body.docId}/pay`, {
      clientKey: randomUUID(),
      amountCents: yuan(3_000),
      bankRef: 'YH-1',
      accountConfirm: '6222000000000000',
    });
    expect(wrong.body.error.code).toBe('GF_ACCOUNT_MISMATCH');
    const part = await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/payments/${r.body.docId}/pay`, { clientKey: randomUUID(), amountCents: yuan(1_000), bankRef: 'YH-1', accountConfirm: ACCOUNT });
    expect(part.body.paidCents).toBe(yuan(1_000));
    expect((await doc(r.body.docId)).status).toBe('executing');
    expect(
      (await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/payments/${r.body.docId}/pay`, { clientKey: randomUUID(), amountCents: yuan(2_000), bankRef: 'YH-1', accountConfirm: ACCOUNT })).body.error
        .code,
    ).toBe('GF_DUPLICATE_PAYMENT');
    expect(
      (await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/payments/${r.body.docId}/pay`, { clientKey: randomUUID(), amountCents: yuan(2_000) + 1, bankRef: 'YH-2', accountConfirm: ACCOUNT })).body.error
        .code,
    ).toBe('GF_OVERPAY');
    await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/payments/${r.body.docId}/pay`, { clientKey: randomUUID(), amountCents: yuan(2_000), bankRef: 'YH-2', accountConfirm: ACCOUNT });
    expect((await doc(r.body.docId)).status).toBe('completed');
  });
});

describe('无合同付款（场景 13、24）', () => {
  it('采购 / 服务 / 工程到 1 万必须签合同：9,999.99 可以，10,000.00 拦截', async () => {
    const ok = await pay({ category: 'purchase', payeeName: '合成杂货', payeeAccount: '6222555566667777', amountCents: yuan(10_000) - 1 });
    expect(ok.status).toBe(200);
    expect(labels(await doc(ok.body.docId))).toEqual(['部门负责人', '财务审核人', '出纳']);
    const no = await pay({ category: 'purchase', payeeName: '合成杂货', payeeAccount: '6222555566667777', amountCents: yuan(10_000) });
    expect(no.body.error.code).toBe('GF_CONTRACT_REQUIRED');
  });
  it('高额（≥ 5 万）或异常的无合同付款：CFO → CEO → 董事长；49,999.99 不升级', async () => {
    const low = await pay({ category: 'tax', payeeName: '合成税务', payeeAccount: '6222999900001111', amountCents: yuan(50_000) - 1 });
    expect(labels(await doc(low.body.docId))).toEqual(['部门负责人', '财务审核人', '出纳']);
    const high = await pay({ category: 'tax', payeeName: '合成税务', payeeAccount: '6222999900001111', amountCents: yuan(50_000) });
    expect(labels(await doc(high.body.docId))).toEqual(['部门负责人', '财务审核人', 'CFO', 'CEO', '董事长', '出纳']);
    const ab = await pay({ category: 'other', payeeName: '合成杂项', payeeAccount: '6222999900002222', amountCents: yuan(100), abnormal: true });
    expect(labels(await doc(ab.body.docId))).toEqual(['部门负责人', '财务审核人', 'CFO', 'CEO', '董事长', '出纳']);
  });
});

describe('发票（场景 21）', () => {
  it('非预付不能「暂不需要」；登记后补 5 个工作日、补票后完成；预付款可以先付', async () => {
    const no = await pay({ category: 'utility', payeeName: '合成水务', payeeAccount: '6222000011110000', amountCents: yuan(500), invoice: 'not_required' });
    expect(no.body.error.code).toBe('GF_PAYMENT_BLOCKED');
    const later = await pay({ category: 'utility', payeeName: '合成水务', payeeAccount: '6222000011110000', amountCents: yuan(500), invoice: 'later' });
    const d = await doc(later.body.docId);
    expect(d.payload.invoice).toBe('later');
    await approveNormal(later.body.docId);
    await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/payments/${later.body.docId}/pay`, { clientKey: randomUUID(), amountCents: yuan(500), bankRef: 'YH-21', accountConfirm: '6222000011110000' });
    expect((await doc(later.body.docId)).status).toBe('backfill_pending');
    await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/payments/${later.body.docId}/invoice`, { invoiceNo: 'FP-21' });
    expect((await doc(later.body.docId)).status).toBe('completed');
    const pre = await pay({ category: 'other', payeeName: '合成预付', payeeAccount: '6222000011112345', amountCents: yuan(500), invoice: 'not_required', prepay: true, acceptanceBasis: '' });
    expect(pre.status).toBe(200);
  });
});

describe('紧急特批（场景 14–16）', () => {
  const special = (body: Record<string, unknown>) =>
    api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/specials', {
      clientKey: randomUUID(),
      title: '设备抢修',
      amountCents: yuan(20_000),
      reason: '设备停机，供应商未入库',
      confirmerIds: [p.ids.gf_cfo, p.ids.gf_ceo],
      confirmedAt: new Date(Date.now() - 60_000).toISOString(),
      payeeAccount: '6222777788889999',
      okScreenshot: okShot(randomUUID()),
      ...body,
    });
  it('未入库供应商：CFO＋经营主体负责人微信确认后，出纳独立核验；分次累计不超特批金额；换账户要重新特批', async () => {
    const s = await special({});
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const base = { category: 'service', payeeName: '合成抢修队', payeeAccount: '6222777788889999', specialId: s.body.id, acceptanceBasis: '' };
    const p1 = await pay({ ...base, amountCents: yuan(12_000) });
    expect(p1.status, JSON.stringify(p1.body)).toBe(200);
    const d = await doc(p1.body.docId);
    expect(labels(d)).toEqual(['出纳']);
    expect(d.status).toBe('special_backfill');
    // 累计超特批：12,000 + 8,000.01
    expect((await pay({ ...base, amountCents: yuan(8_000) + 1 })).body.error.code).toBe('GF_SPECIAL_EXCEEDED');
    const p2 = await pay({ ...base, amountCents: yuan(8_000) });
    expect(p2.status).toBe(200);
    // 换账户
    expect((await pay({ ...base, payeeAccount: '6222000000009999', amountCents: yuan(1) })).body.error.code).toBe('GF_SPECIAL_ACCOUNT');
    // 出纳核验付款、分次补登
    await act(ctx, c('gf_cash'), p1.body.docId, 1);
    const paid = await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/payments/${p1.body.docId}/pay`, {
      clientKey: randomUUID(),
      amountCents: yuan(10_000),
      bankRef: 'YH-14',
      accountConfirm: '6222777788889999',
    });
    expect(paid.body).toMatchObject({ paidCents: yuan(10_000), specialRemainingCents: yuan(10_000) });
  });
  it('确认人不是 CFO＋经营主体负责人的不算；供应商已入库且合同有效的不用紧急特批', async () => {
    const bad = await special({ confirmerIds: [p.ids.gf_cfo, p.ids.gf_chief] });
    expect((await pay({ category: 'service', payeeName: '合成抢修队', payeeAccount: '6222777788889999', specialId: bad.body.id, amountCents: yuan(100) })).body.error.code).toBe(
      'GF_SPECIAL_CONFIRMERS',
    );
    const sid = await activeSupplier('合成正常供应商', '6222333344445555');
    const cid = await approvedContract(sid, yuan(1_000), yuan(1_060));
    const sp = await special({ payeeAccount: '6222333344445555' });
    expect((await pay({ contractDocId: cid, specialId: sp.body.id, amountCents: yuan(100) })).body.error.code).toBe('GF_NOT_EMERGENCY');
  });
});

describe('收款账户变更', () => {
  it('账户变更在审时不能发起；通过后已批付款要财务重新确认才能付', async () => {
    const sid = await activeSupplier('合成换账户公司', '6222444455556666');
    const cid = await approvedContract(sid, yuan(2_000), yuan(2_000));
    const r = await pay({ contractDocId: cid, amountCents: yuan(1_000), invoiceNo: 'FP-77' });
    await approveNormal(r.body.docId);
    const ch = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/suppliers/${sid}/change`, { clientKey: randomUUID(), reason: '换户', changes: { bankAccount: '6222444455550000' } });
    expect((await pay({ contractDocId: cid, amountCents: yuan(100), invoiceNo: 'FP-78' })).body.error.code).toBe('GF_ACCOUNT_PENDING');
    const blocked = await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/payments/${r.body.docId}/pay`, {
      clientKey: randomUUID(),
      amountCents: yuan(1_000),
      bankRef: 'YH-77',
      accountConfirm: '6222444455556666',
    });
    expect(blocked.body.error.code).toBe('GF_ACCOUNT_CHANGED');
    await act(ctx, c('gf_sc'), ch.body.docId, 1);
    const done = await act(ctx, c('gf_chair'), ch.body.docId, 2);
    expect(done.body.cc.map((x: { role: string }) => x.role)).toContain('finance_reviewer');
    const v = (await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/payments/${r.body.docId}`)).body;
    expect(v.needsReconfirm).toBe(true);
    expect(
      (await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/payments/${r.body.docId}/pay`, { clientKey: randomUUID(), amountCents: yuan(1_000), bankRef: 'YH-77', accountConfirm: '6222444455550000' }))
        .body.error.code,
    ).toBe('GF_ACCOUNT_CHANGED');
    expect((await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/payments/${r.body.docId}/reconfirm`, {})).status).toBe(403);
    const rc = await api(ctx.app, c('gf_fin'), 'POST', `/api/gf/payments/${r.body.docId}/reconfirm`, {});
    expect(rc.body.needsReconfirm).toBe(false);
    const ok = await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/payments/${r.body.docId}/pay`, {
      clientKey: randomUUID(),
      amountCents: yuan(1_000),
      bankRef: 'YH-78',
      accountConfirm: '6222444455550000',
    });
    expect(ok.body.paidCents).toBe(yuan(1_000));
  });
});
