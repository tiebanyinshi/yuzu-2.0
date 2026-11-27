// 业财法 P06 报销、出差、招待、用印证照（docs/APPROVAL_V4.md 第 10 节，合成数据、测试库）：
// 普通报销与知会（场景 17）、无票财总复核与不得重复报销（场景 18）、出差与部门月度差旅预算（场景 19、20、46）、
// 商务招待（场景 23）、用印证照（场景 39）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, setupPeople, yuan, type People } from './govflow-helpers';
import { todayIn } from '../src/server/lib/dates';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let p: People;
const c = (u: string) => p.cookies[u]!;
const doc = async (id: number, cookie = c('gf_clerk')) => (await api(ctx.app, cookie, 'GET', `/api/gf/docs/${id}`)).body;
const labels = (d: { nodes: { label: string }[] }) => d.nodes.map((x) => x.label);
// 门店时区的今天与本月（UTC 日期在门店零点前后差一天，月底那晚差一个月）；用到时 ctx 已建好
const today = () => todayIn(ctx.config.timezone);
const month = () => today().slice(0, 7);
const expense = (body: Record<string, unknown>, cookie = c('gf_clerk')) =>
  api(ctx.app, cookie, 'POST', '/api/gf/expenses', { clientKey: randomUUID(), departmentId: p.deptId, title: '合成报销', amountCents: yuan(100), ...body });
const travel = (body: Record<string, unknown>, cookie = c('gf_clerk')) =>
  api(ctx.app, cookie, 'POST', '/api/gf/travel', {
    clientKey: randomUUID(),
    departmentId: p.deptId,
    title: '合成出差',
    destination: '广州',
    startDate: today(),
    endDate: today(),
    amountCents: yuan(1_000),
    ...body,
  });
const budget = async () => (await api(ctx.app, c('gf_ic'), 'GET', `/api/gf/travel-budgets?month=${month()}`)).body.find((b: { departmentId: number }) => b.departmentId === p.deptId);

beforeAll(async () => {
  ctx = await setup();
  p = await setupPeople(ctx);
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

describe('报销（场景 17、18）', () => {
  it('部门负责人 → 财务 → 出纳，不因金额升级；超过 2 万知会 CFO、超过 5 万 CFO＋董事长', async () => {
    const big = await expense({ amountCents: yuan(50_000) + 1, invoiceNo: 'FP-E1' });
    const id = big.body.docId;
    expect(labels(await doc(id))).toEqual(['部门负责人', '财务审核人', '出纳']);
    await act(ctx, c('gf_head'), id, 1);
    await act(ctx, c('gf_fin'), id, 2);
    const done = await act(ctx, c('gf_cash'), id, 3);
    const roles = new Set(done.body.cc.map((x: { role: string }) => x.role));
    expect(roles).toEqual(new Set(['cfo', 'chairman']));
    const small = await expense({ amountCents: yuan(20_000), invoiceNo: 'FP-E2' });
    await act(ctx, c('gf_head'), small.body.docId, 1);
    await act(ctx, c('gf_fin'), small.body.docId, 2);
    expect((await act(ctx, c('gf_cash'), small.body.docId, 3)).body.cc).toEqual([]);
  });
  it('无票的财总复核后才付；同一张发票不能重复报销；已用备用金的不能报销', async () => {
    const no = await expense({ invoiceNo: '' });
    expect(labels(await doc(no.body.docId))).toEqual(['部门负责人', '财务审核人', '财总', '出纳']);
    await expense({ invoiceNo: 'FP-DUP' });
    expect((await expense({ invoiceNo: 'FP-DUP' })).body.error.code).toBe('GF_DUPLICATE_CLAIM');
    expect((await expense({ invoiceNo: 'FP-X', pettyDocId: 1 })).body.error.code).toBe('GF_DUPLICATE_CLAIM');
  });
});

describe('出差与部门月度差旅预算（场景 19、20、46）', () => {
  it('财总设批复额度；预算内冻结；正好用完不超、多一分要选转下月或特批；转下月记到下月；报销关联原申请转实际占用', async () => {
    expect((await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/travel-budgets', { departmentId: p.deptId, month: month(), budgetCents: yuan(3_000) })).status).toBe(403);
    await api(ctx.app, c('gf_chief'), 'POST', '/api/gf/travel-budgets', { departmentId: p.deptId, month: month(), budgetCents: yuan(3_000) });
    const t1 = await travel({ amountCents: yuan(2_000) });
    expect(labels(await doc(t1.body.docId))).toEqual(['部门负责人', '财务审核人']);
    expect(await budget()).toMatchObject({ budgetCents: yuan(3_000), frozenCents: yuan(2_000), remainingCents: yuan(1_000) });
    const t2 = await travel({ amountCents: yuan(1_000) });
    expect(t2.status).toBe(200);
    const over = await travel({ amountCents: 1 });
    expect(over.body.error.code).toBe('GF_TRAVEL_BUDGET');
    const defer = await travel({ amountCents: yuan(500), overBudgetMode: 'defer' });
    expect((await doc(defer.body.docId)).flags).toContain('over_budget');
    expect((await budget()).frozenCents).toBe(yuan(3_000));
    const special = await travel({ amountCents: yuan(500), overBudgetMode: 'special' });
    expect(labels(await doc(special.body.docId)).at(-1)).toBe('财总＋CFO 特批（超部门差旅预算）');
    // 场景 46：报销关联原申请，冻结转实际占用
    await act(ctx, c('gf_head'), t1.body.docId, 1);
    await act(ctx, c('gf_fin'), t1.body.docId, 2);
    const claim = await expense({ amountCents: yuan(1_800), invoiceNo: 'FP-T1', travelDocId: t1.body.docId });
    expect((await doc(claim.body.docId)).payload.lateClaim).toBe(false);
    await act(ctx, c('gf_head'), claim.body.docId, 1);
    await act(ctx, c('gf_fin'), claim.body.docId, 2);
    await act(ctx, c('gf_cash'), claim.body.docId, 3);
    expect(await budget()).toMatchObject({ usedCents: yuan(1_800), frozenCents: yuan(1_000) + yuan(500) });
    expect((await expense({ amountCents: yuan(1), invoiceNo: 'FP-T2', travelDocId: t1.body.docId })).body.error.code).toBe('GF_DUPLICATE_CLAIM');
  });
  it('无事前申请财总复核；结束 5 个工作日以后才报的财总复核；驳回解冻', async () => {
    await api(ctx.app, c('gf_chief'), 'POST', '/api/gf/travel-budgets', { departmentId: p.dept2Id, month: month(), budgetCents: yuan(100_000) });
    const post = await travel({ departmentId: p.dept2Id, priorApplied: false, amountCents: yuan(300) });
    expect(labels(await doc(post.body.docId))).toEqual(['部门负责人', '财务审核人', '财总']);
    await api(ctx.app, c('gf_chief'), 'POST', '/api/gf/travel-budgets', { departmentId: p.dept2Id, month: '2026-10', budgetCents: yuan(1_000) });
    const old = await travel({ departmentId: p.dept2Id, amountCents: yuan(400), startDate: '2026-10-01', endDate: '2026-10-02' });
    await act(ctx, c('gf_sc'), old.body.docId, 1);
    await act(ctx, c('gf_fin'), old.body.docId, 2);
    const late = await expense({ departmentId: p.dept2Id, amountCents: yuan(400), invoiceNo: 'FP-LATE', travelDocId: old.body.docId });
    const d = await doc(late.body.docId);
    expect(d.payload.lateClaim).toBe(true);
    expect(labels(d)).toContain('财总');
    const rej = await act(ctx, c('gf_sc'), post.body.docId, 1, 'reject', '不必出差');
    expect(rej.body.status).toBe('rejected');
    const [l] = await ctx.sql`SELECT count(*)::int AS n FROM gf_travel_ledger WHERE doc_id = ${post.body.docId} AND kind = 'unfreeze'`;
    expect(l!.n).toBe(1);
  });
  it('内控看各部门差旅额度；普通员工只看本部门', async () => {
    const all = (await api(ctx.app, c('gf_ic'), 'GET', '/api/gf/travel-budgets')).body;
    expect(all.length).toBeGreaterThan(1);
    const mine = (await api(ctx.app, c('gf_clerk'), 'GET', '/api/gf/travel-budgets')).body;
    expect(mine.map((b: { departmentId: number }) => b.departmentId)).toEqual([p.deptId]);
  });
});

describe('商务招待（场景 23）', () => {
  it('超过 2 万加财总、超过 5 万加 CFO；无事前申请至少财总；减少不重审、增加要重新发起', async () => {
    const e = (body: Record<string, unknown>) =>
      api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/entertain', {
        clientKey: randomUUID(),
        departmentId: p.deptId,
        title: '合成招待',
        guests: '合成客户',
        people: 6,
        amountCents: yuan(3_000),
        ...body,
      });
    expect(labels(await doc((await e({ amountCents: yuan(20_000) + 1 })).body.docId))).toEqual(['部门负责人', '财务审核人', '财总']);
    expect(labels(await doc((await e({ amountCents: yuan(50_000) + 1 })).body.docId))).toEqual(['部门负责人', '财务审核人', '财总', 'CFO']);
    expect(labels(await doc((await e({ priorApplied: false })).body.docId))).toEqual(['部门负责人', '财务审核人', '财总']);
    const r = await e({});
    await act(ctx, c('gf_head'), r.body.docId, 1);
    await act(ctx, c('gf_fin'), r.body.docId, 2);
    expect((await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/entertain/${r.body.docId}/adjust`, { amountCents: yuan(2_500), people: 5 })).status).toBe(200);
    const d = await doc(r.body.docId);
    expect(d).toMatchObject({ amountCents: yuan(2_500), round: 1, status: 'to_execute' });
    expect((await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/entertain/${r.body.docId}/adjust`, { amountCents: yuan(2_600), people: 5 })).body.error.code).toBe('GF_RESUBMIT');
  });
});

describe('用印证照（场景 39）', () => {
  it('非合同文件：负责人 + 财法按内容审，高风险到 CEO；用印后 1 个工作日归档；空白文件 5 个工作日补最终版', async () => {
    const s = (body: Record<string, unknown>) =>
      api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/seals', { clientKey: randomUUID(), kind: 'document', departmentId: p.deptId, title: '合成证明', purpose: '办理证明', ...body });
    const hr = await s({ highRisk: true });
    expect(labels(await doc(hr.body.docId))).toEqual(['部门负责人', '财务、法务按内容审', 'CEO', '章证管理员']);
    const d = await s({});
    const id = d.body.docId;
    await act(ctx, c('gf_head'), id, 1);
    await act(ctx, c('gf_fin'), id, 2);
    await act(ctx, c('gf_legal'), id, 2);
    let x = (await act(ctx, c('gf_seal'), id, 3)).body;
    expect((await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/docs/${id}/execute`, { version: x.version, step: 'start' })).status).toBe(403);
    x = (await api(ctx.app, c('gf_seal'), 'POST', `/api/gf/docs/${id}/execute`, { version: x.version, step: 'start' })).body;
    x = (await api(ctx.app, c('gf_seal'), 'POST', `/api/gf/docs/${id}/execute`, { version: x.version, step: 'complete' })).body;
    expect(x.status).toBe('backfill_pending');
    x = (await api(ctx.app, c('gf_seal'), 'POST', `/api/gf/docs/${id}/execute`, { version: x.version, step: 'archive' })).body;
    expect(x.status).toBe('archived');
    const blank = await s({ kind: 'blank' });
    expect(labels(await doc(blank.body.docId))[1]).toBe('财总＋经营主体负责人特批（空白文件）');
  });
  it('电子证照只发水印副本、通过即归档；纸质证照借还，同一份同时只借一次', async () => {
    const e = await api(ctx.app, c('gf_seal'), 'POST', '/api/gf/licenses', { name: '营业执照（电子）', kind: 'electronic' });
    const paper = await api(ctx.app, c('gf_seal'), 'POST', '/api/gf/licenses', { name: '营业执照（正本）', kind: 'paper' });
    expect((await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/licenses', { name: 'x', kind: 'paper' })).status).toBe(403);
    const r = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/seals', {
      clientKey: randomUUID(),
      kind: 'license_e',
      licenseId: e.body.id,
      departmentId: p.deptId,
      title: '投标用',
      purpose: '投标',
    });
    await act(ctx, c('gf_head'), r.body.docId, 1);
    const done = await act(ctx, c('gf_seal'), r.body.docId, 2);
    expect(done.body.status).toBe('archived');
    expect(done.body.payload.watermarkIssuedAt).toBeTruthy();
    const wrongKind = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/seals', {
      clientKey: randomUUID(),
      kind: 'license_paper',
      licenseId: e.body.id,
      departmentId: p.deptId,
      title: '借用执照',
      purpose: '借用',
    });
    expect(wrongKind.body.error.code).toBe('GF_LICENSE');
    const borrow = async () => {
      const b = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/seals', {
        clientKey: randomUUID(),
        kind: 'license_paper',
        licenseId: paper.body.id,
        departmentId: p.deptId,
        title: '借执照',
        purpose: '银行开户',
        loanDays: 2,
      });
      await act(ctx, c('gf_head'), b.body.docId, 1);
      return (await act(ctx, c('gf_seal'), b.body.docId, 2)).body;
    };
    const b1 = await borrow();
    const lent = (await api(ctx.app, c('gf_seal'), 'POST', `/api/gf/docs/${b1.id}/execute`, { version: b1.version, step: 'start' })).body;
    expect(lent.status).toBe('executing');
    const lic = (await api(ctx.app, c('gf_clerk'), 'GET', '/api/gf/licenses')).body.find((l: { id: number }) => l.id === paper.body.id);
    expect(lic.onLoan).toMatchObject({ borrowerName: '合成经办', overdue: false });
    const b2 = await borrow();
    expect((await api(ctx.app, c('gf_seal'), 'POST', `/api/gf/docs/${b2.id}/execute`, { version: b2.version, step: 'start' })).body.error.code).toBe('GF_LICENSE_OUT');
    // 超期提醒：借出期限过了算逾期
    await ctx.sql`UPDATE gf_license_loans SET due_on = current_date - 1 WHERE doc_id = ${b1.id}`;
    await ctx.sql`UPDATE gf_docs SET due_on = current_date - 1 WHERE id = ${b1.id}`;
    expect((await doc(b1.id)).overdue).toBe(true);
    await api(ctx.app, c('gf_seal'), 'POST', `/api/gf/docs/${b1.id}/execute`, { version: (await doc(b1.id)).version, step: 'complete' });
    expect((await api(ctx.app, c('gf_clerk'), 'GET', '/api/gf/licenses')).body.find((l: { id: number }) => l.id === paper.body.id).onLoan).toBe(null);
  });
});
