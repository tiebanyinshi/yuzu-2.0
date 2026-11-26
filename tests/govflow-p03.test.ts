// 业财法 P03 零星采购与备用金额度（docs/APPROVAL_V4.md 第 7 节，合成数据、测试库）：
// 3,000 元 / 50 件分级（整值前后一分钱）、普通员工先过部门负责人、同日同供应商合并防拆单、不走快速通道的类型、
// 部门日 1 万 / 月 5 万额度台账（事务内锁定重算、冻结 → 验收转实际占用 → 差额释放）、80% / 90% 预警、
// 超额财总＋CFO 合并特批（一次、只给本事项、驳回即解冻）、采购部门日累计超 1 万、负责人自购与验收、逾期限制与财总复核、
// 月度额度核定（共同审批、次月生效）、冲正只追加。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { act, setupPeople, yuan, type People } from './govflow-helpers';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let p: People;
const c = (u: string) => p.cookies[u]!;
let n = 0;
/** 每个用例用自己的部门，额度互不影响 */
async function dept(name: string, headUser = 'gf_head') {
  const [d] = await ctx.sql<{ id: number }[]>`INSERT INTO departments (name, sort_order, head_id) VALUES (${name}, 99, ${p.ids[headUser]!}) RETURNING id`;
  return Number(d!.id);
}
const petty = (cookie: string, departmentId: number, body: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', '/api/gf/petty', {
    clientKey: randomUUID(),
    departmentId,
    supplierName: `合成五金店${n++}`,
    items: '合成物资',
    qty: 1,
    amountCents: yuan(100),
    ...body,
  });
const doc = async (id: number, cookie = c('gf_clerk')) => (await api(ctx.app, cookie, 'GET', `/api/gf/docs/${id}`)).body;
const labels = (d: { nodes: { label: string }[] }) => d.nodes.map((x) => x.label);
const quota = async (deptId: number) => (await api(ctx.app, c('gf_ic'), 'GET', `/api/gf/petty/quota/${deptId}`)).body;
/** 走完 部门负责人 → 财务审核 */
async function approve(id: number) {
  await act(ctx, c('gf_head'), id, 1);
  return act(ctx, c('gf_fin'), id, 2);
}

beforeAll(async () => {
  ctx = await setup();
  p = await setupPeople(ctx);
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

describe('分级（场景 1、2、33）', () => {
  it('3,000.00 元、50 件基础审核；普通员工先过部门负责人再财务审核人', async () => {
    const d = await dept('零星分级A');
    const r = await petty(c('gf_clerk'), d, { amountCents: yuan(3000), qty: 50 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const x = await doc(r.body.docId);
    expect(labels(x)).toEqual(['部门负责人', '财务审核人']);
    expect(x.payload.tier).toBe('basic');
  });
  it('3,000.01 元或 51 件超出基础审核：只加审核内容（比价说明）不加层级', async () => {
    const d = await dept('零星分级B');
    const no = await petty(c('gf_clerk'), d, { amountCents: yuan(3000) + 1 });
    expect(no.body.error.code).toBe('GF_QUOTE_REQUIRED');
    const qty = await petty(c('gf_clerk'), d, { qty: 51 });
    expect(qty.body.error.code).toBe('GF_QUOTE_REQUIRED');
    const ok = await petty(c('gf_clerk'), d, { amountCents: yuan(3000) + 1, quoteNote: '三家比价，最低一家' });
    const x = await doc(ok.body.docId);
    expect(labels(x)).toEqual(['部门负责人', '财务审核人']);
    expect(x.payload.tier).toBe('enhanced');
  });
  it('合同、工程、服务外包、预付款、固定资产不走零星快速通道', async () => {
    const d = await dept('零星分级C');
    for (const kind of ['contract', 'engineering', 'service_outsource', 'prepay', 'fixed_asset']) {
      const r = await petty(c('gf_clerk'), d, { kind });
      expect(r.body.error.code, kind).toBe('GF_TO_FORMAL');
    }
  });
});

describe('防拆单（场景 3）', () => {
  it('同日同供应商合并算：2,000 + 1,500 合起来超了，第二笔按超出处理并提示疑似拆单', async () => {
    const d = await dept('防拆单');
    const first = await petty(c('gf_clerk'), d, { supplierName: '合成 拆单五金', amountCents: yuan(2000) });
    expect((await doc(first.body.docId)).payload.splitSuspect).toBe(false);
    const second = await petty(c('gf_clerk2'), d, { supplierName: '合成拆单五金', amountCents: yuan(1500) });
    expect(second.body.error.code).toBe('GF_QUOTE_REQUIRED');
    expect(second.body.error.details.preview).toMatchObject({ splitSuspect: true, combinedCents: yuan(3500) });
    const ok = await petty(c('gf_clerk2'), d, { supplierName: '合成拆单五金', amountCents: yuan(1500), quoteNote: '补买，已比价' });
    const x = await doc(ok.body.docId, c('gf_clerk2'));
    expect(x.flags).toContain('abnormal');
    expect(x.payload.splitSuspect).toBe(true);
  });
});

describe('部门备用金额度（场景 4、5、19、25、26、27、40）', () => {
  it('日 1 万：用到 10,000.00 不用特批，再多一分加财总＋CFO 合并特批；预警 80% / 90%', async () => {
    const d = await dept('额度日');
    const a = await petty(c('gf_clerk'), d, { amountCents: yuan(2900) });
    const b = await petty(c('gf_clerk'), d, { amountCents: yuan(2900) });
    expect((await quota(d)).warn).toBe(null);
    const cc = await petty(c('gf_clerk'), d, { amountCents: yuan(2500) });
    expect((await quota(d)).warn).toBe(80);
    const dd = await petty(c('gf_clerk'), d, { amountCents: yuan(1700) - 1 });
    expect((await quota(d)).warn).toBe(90);
    expect(labels(await doc(dd.body.docId))).toEqual(['部门负责人', '财务审核人']);
    const exact = await petty(c('gf_clerk'), d, { amountCents: 1 });
    expect(labels(await doc(exact.body.docId))).toEqual(['部门负责人', '财务审核人']);
    expect((await quota(d)).dayRemaining).toBe(0);
    const over = await petty(c('gf_clerk'), d, { amountCents: 1 });
    const x = await doc(over.body.docId);
    expect(labels(x)).toEqual(['部门负责人', '财务审核人', '财总＋CFO 合并特批']);
    expect(x.payload.overDaily).toBe(true);
    void [a, b, cc];
  });

  it('日、月都超也只特批一次；特批只给本事项（下一笔还要特批）；特批驳回即解冻', async () => {
    const d = await dept('额度合并');
    const [g] = await ctx.sql<{ id: number }[]>`SELECT id FROM gf_docs ORDER BY id LIMIT 1`;
    const month = new Date().toISOString().slice(0, 7);
    await ctx.sql`INSERT INTO gf_dept_quotas (department_id, effective_month, daily_cents, monthly_cents, doc_id) VALUES (${d}, ${`${month}-01`}, ${yuan(1000)}, ${yuan(1000)}, ${g!.id})`;
    const big = await petty(c('gf_clerk'), d, { amountCents: yuan(1200), quoteNote: '比价' });
    const x = await doc(big.body.docId);
    expect(x.payload).toMatchObject({ overDaily: true, overMonthly: true, needSpecial: true });
    expect(labels(x).filter((l: string) => l.includes('特批'))).toHaveLength(1);
    const [sp] = await ctx.sql`SELECT special_no, over_cents FROM gf_quota_specials WHERE doc_id = ${big.body.docId}`;
    expect(String(sp!.specialNo)).toMatch(/^TE/);
    expect(Number(sp!.overCents)).toBe(yuan(200));
    const next = await petty(c('gf_clerk'), d, { amountCents: yuan(1) });
    expect((await doc(next.body.docId)).payload.needSpecial).toBe(true);
    // 特批：财总同意、CFO 驳回 → 不通过，冻结的释放
    await approve(big.body.docId);
    await act(ctx, c('gf_chief'), big.body.docId, 3);
    const rej = await act(ctx, c('gf_cfo'), big.body.docId, 3, 'reject', '超额理由不充分');
    expect(rej.body.status).toBe('rejected');
    const l = (await api(ctx.app, c('gf_clerk'), 'GET', `/api/gf/petty/${big.body.docId}/ledger`)).body;
    expect(l).toMatchObject({ frozen: 0, used: 0 });
  });

  it('冻结 → 验收转实际占用、差额释放；采购的人不能自己验收；同一操作编号重提不重复冻结', async () => {
    const d = await dept('额度验收');
    const key = randomUUID();
    const body = { clientKey: key, departmentId: d, supplierName: '合成验收店', items: '拖把', qty: 2, amountCents: yuan(500) };
    const r1 = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/petty', body);
    const r2 = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/petty', body);
    expect(r2.body.docId).toBe(r1.body.docId);
    expect((await quota(d)).dayFrozen).toBe(yuan(500));
    const id = r1.body.docId;
    await ctx.sql`UPDATE staff SET department_id = ${d} WHERE id = ${p.ids.gf_clerk2!}`;
    expect((await api(ctx.app, c('gf_clerk2'), 'POST', `/api/gf/petty/${id}/accept`, { clientKey: randomUUID(), actualCents: yuan(480), stockIn: true })).body.error.code).toBe('GF_NOT_APPROVED');
    await approve(id);
    expect((await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/petty/${id}/accept`, { clientKey: randomUUID(), actualCents: yuan(480), stockIn: true })).status).toBe(403);
    expect((await api(ctx.app, c('gf_clerk2'), 'POST', `/api/gf/petty/${id}/accept`, { clientKey: randomUUID(), actualCents: yuan(500) + 1, stockIn: true })).body.error.code).toBe('GF_OVER_APPROVED');
    const ok = await api(ctx.app, c('gf_clerk2'), 'POST', `/api/gf/petty/${id}/accept`, { clientKey: randomUUID(), actualCents: yuan(480), stockIn: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await ctx.sql`UPDATE staff SET department_id = ${p.deptId} WHERE id = ${p.ids.gf_clerk2!}`;
    const q = await quota(d);
    expect(q).toMatchObject({ dayFrozen: 0, dayUsed: yuan(480), dayRemaining: yuan(10_000) - yuan(480) });
    // 没票：后补待完成；补了发票变已完成
    expect((await doc(id)).status).toBe('backfill_pending');
    await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/petty/${id}/invoice`, { invoiceNo: 'FP-0001' });
    expect((await doc(id)).status).toBe('completed');
    // 冲正：只有财总，追加不删
    expect((await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/petty/${id}/reverse`, { clientKey: randomUUID(), amountCents: yuan(80), reason: '退货' })).status).toBe(403);
    const rv = await api(ctx.app, c('gf_chief'), 'POST', `/api/gf/petty/${id}/reverse`, { clientKey: randomUUID(), amountCents: yuan(80), reason: '退货' });
    expect(rv.body.used).toBe(yuan(400));
    const [cnt] = await ctx.sql`SELECT count(*)::int AS n FROM gf_quota_ledger WHERE doc_id = ${id}`;
    expect(cnt!.n).toBe(4);
  });
});

describe('采购部门日累计（场景 38）', () => {
  it('采购部门当日累计超 1 万：非紧急转正式采购，紧急加财总＋CFO 特批', async () => {
    const pd = await dept('合成采购部门', 'gf_sc');
    await api(ctx.app, ctx.owner, 'POST', '/api/gf/settings/purchase-dept', { departmentId: pd });
    await createStaff(ctx.sql, { username: 'gf_buyer', displayName: '合成采购员', role: 'clerk', departmentId: pd, password: PASSWORD, mustChangePassword: false });
    const buyer = await login(ctx.app, 'gf_buyer');
    const costDept = await dept('采购代买的部门');
    for (let i = 0; i < 4; i++) expect((await petty(buyer, costDept, { amountCents: yuan(2500) })).status).toBe(200);
    // 10,000.00 正好不超；再多一分
    const formal = await petty(buyer, costDept, { amountCents: 1 });
    expect(formal.body.error.code).toBe('GF_TO_FORMAL');
    const urgent = await petty(buyer, costDept, { amountCents: 1, urgent: true });
    expect(urgent.status).toBe(200);
    expect(labels(await doc(urgent.body.docId, buyer)).at(-1)).toBe('财总＋CFO 合并特批');
  });
});

describe('负责人自购（场景 41）', () => {
  it('部门负责人自购：负责人一级自动视同确认、采购部门只收记录；验收要部门里另一名员工', async () => {
    const d = await dept('自购部门');
    const r = await petty(c('gf_head'), d, { amountCents: yuan(300) });
    const x = await doc(r.body.docId, c('gf_head'));
    expect(x.payload.selfPurchase).toBe(true);
    expect(x.actions[0]).toMatchObject({ action: 'skip', seat: '部门负责人' });
    expect(x.cc.map((cc: { role: string }) => cc.role)).toEqual(['supply_chain_head']);
    await act(ctx, c('gf_fin'), r.body.docId, 2);
    expect((await api(ctx.app, c('gf_head'), 'POST', `/api/gf/petty/${r.body.docId}/accept`, { clientKey: randomUUID(), actualCents: yuan(300), stockIn: true })).status).toBe(403);
    // 不是这个部门的员工也不行
    const [other] = await ctx.sql`SELECT id FROM departments WHERE name = '合成采购部'`;
    void other;
    const ok = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/petty/${r.body.docId}/accept`, { clientKey: randomUUID(), actualCents: yuan(300), invoiceNo: 'FP-9', stockIn: true });
    expect(ok.status).toBe(403);
    await ctx.sql`UPDATE staff SET department_id = ${d} WHERE id = ${p.ids.gf_clerk2!}`;
    const ok2 = await api(ctx.app, c('gf_clerk2'), 'POST', `/api/gf/petty/${r.body.docId}/accept`, { clientKey: randomUUID(), actualCents: yuan(300), invoiceNo: 'FP-9', stockIn: true });
    expect(ok2.status, JSON.stringify(ok2.body)).toBe(200);
    expect((await doc(r.body.docId, c('gf_head'))).status).toBe('completed');
    await ctx.sql`UPDATE staff SET department_id = ${p.deptId} WHERE id = ${p.ids.gf_clerk2!}`;
  });
});

describe('逾期限制', () => {
  it('验收期限过了没验收：经办人不能新增，财总复核后恢复', async () => {
    const d = await dept('逾期部门');
    const r = await petty(c('gf_clerk'), d, { amountCents: yuan(50) });
    await approve(r.body.docId);
    await ctx.sql`UPDATE gf_docs SET due_on = current_date - 3 WHERE id = ${r.body.docId}`;
    const blocked = await petty(c('gf_clerk'), d, { amountCents: yuan(50) });
    expect(blocked.body.error.code).toBe('GF_OVERDUE_BLOCK');
    expect((await doc(r.body.docId)).overdue).toBe(true);
    expect((await api(ctx.app, c('gf_cfo'), 'POST', '/api/gf/petty/overdue-reviews', { staffId: p.ids.gf_clerk, note: '已核实' })).status).toBe(403);
    await api(ctx.app, c('gf_chief'), 'POST', '/api/gf/petty/overdue-reviews', { staffId: p.ids.gf_clerk, note: '已核实，限期验收' });
    expect((await petty(c('gf_clerk'), d, { amountCents: yuan(50) })).status).toBe(200);
  });
});

describe('月度额度核定（场景 42）', () => {
  it('内控提建议，财总＋CFO 共同审批，次月生效；本月不变；不能改本月', async () => {
    const d = await dept('核定部门');
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
    const thisMonth = now.toISOString().slice(0, 7);
    const body = { departmentId: d, dailyCents: yuan(20_000), monthlyCents: yuan(80_000), reason: '旺季' };
    expect((await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/quota-adjust', { clientKey: randomUUID(), month: next, ...body })).status).toBe(403);
    expect((await api(ctx.app, c('gf_ic'), 'POST', '/api/gf/quota-adjust', { clientKey: randomUUID(), month: thisMonth, ...body })).body.error.code).toBe('GF_MONTH');
    const r = await api(ctx.app, c('gf_ic'), 'POST', '/api/gf/quota-adjust', { clientKey: randomUUID(), month: next, ...body });
    expect(labels(await doc(r.body.docId, c('gf_ic')))).toEqual(['财总＋CFO 共同审批']);
    await act(ctx, c('gf_chief'), r.body.docId, 1);
    expect((await quota(d)).nextMonth).toBe(null);
    await act(ctx, c('gf_cfo'), r.body.docId, 1);
    const q = await quota(d);
    expect(q).toMatchObject({ dailyLimit: yuan(10_000), monthlyLimit: yuan(50_000), nextMonth: { dailyLimit: yuan(20_000), monthlyLimit: yuan(80_000) } });
  });

  it('内控公示：各部门已用、冻结、剩余；普通员工看不到', async () => {
    expect((await api(ctx.app, c('gf_clerk'), 'GET', '/api/gf/petty/board')).status).toBe(403);
    const b = await api(ctx.app, c('gf_ic'), 'GET', '/api/gf/petty/board');
    expect(b.body.length).toBeGreaterThan(3);
    expect(b.body[0]).toHaveProperty('dayRemaining');
  });
});
