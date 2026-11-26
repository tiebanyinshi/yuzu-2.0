// 业财法 P07 HR 付款与费用分摊（docs/APPROVAL_V4.md 第 11 节，合成数据、测试库）：场景 45（HR 批次全流程、异常批次、
// 出纳复核不一致阻断付款、薪资最小权限、转单）与场景 48（分摊规则版本、执行、冲正只追加、不能删）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { act, mapRole, setupPeople, yuan, type People } from './govflow-helpers';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let p: People;
let hr2: string;
const c = (u: string) => p.cookies[u]!;
const doc = async (id: number, cookie = c('gf_hr')) => (await api(ctx.app, cookie, 'GET', `/api/gf/docs/${id}`)).body;
const labels = (d: { nodes: { label: string }[] }) => d.nodes.map((x) => x.label);
const SALARY_EVIDENCE = [
  { kind: 'payroll_sheet', ref: 'GZB-202611' },
  { kind: 'attendance', ref: 'KQ-202611' },
  { kind: 'social_tax_account', ref: 'SB-202611' },
];
let lines: { staffId: number; amountCents: number; account: string; costDeptId: number }[];
const batch = (body: Record<string, unknown>, cookie = c('gf_hr')) =>
  api(ctx.app, cookie, 'POST', '/api/gf/hr-batches', { clientKey: randomUUID(), kind: 'salary', period: '2026-11', departmentId: p.deptId, evidence: SALARY_EVIDENCE, lines, ...body });
async function approveAll(id: number, deptConfirm = true) {
  let level = 1;
  if (deptConfirm) await act(ctx, c('gf_head'), id, level++);
  await act(ctx, hr2, id, level++);
  await act(ctx, c('gf_fin'), id, level++);
  await act(ctx, c('gf_chief'), id, level);
  await act(ctx, c('gf_cfo'), id, level++);
  return act(ctx, c('gf_cash'), id, level);
}

beforeAll(async () => {
  ctx = await setup();
  p = await setupPeople(ctx);
  // HR 复核要另一位 HR（生成批次的人回避）
  const id2 = await createStaff(ctx.sql, { username: 'gf_hr2', displayName: '合成人力复核', role: 'clerk', departmentId: p.deptId, password: PASSWORD, mustChangePassword: false });
  await mapRole(ctx, 'hr', id2);
  hr2 = await login(ctx.app, 'gf_hr2');
  lines = [
    { staffId: p.ids.gf_clerk!, amountCents: yuan(6_000), account: '6222000000000101', costDeptId: p.deptId },
    { staffId: p.ids.gf_clerk2!, amountCents: yuan(7_000), account: '6222000000000102', costDeptId: p.dept2Id },
  ];
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

describe('HR 付款批次（场景 45）', () => {
  it('只有 HR 能生成；实物福利转采购、个人报销走普通报销；只有总额表拒绝', async () => {
    expect((await batch({}, c('gf_clerk'))).status).toBe(403);
    expect((await batch({ purpose: 'in_kind' })).body.error.code).toBe('GF_TO_PURCHASE');
    expect((await batch({ purpose: 'reimbursement' })).body.error.code).toBe('GF_TO_EXPENSE');
    expect((await batch({ evidence: [{ kind: 'total_sheet', ref: 'ZE' }] })).body.error.code).toBe('GF_EVIDENCE_MISSING');
  });

  it('工资：主责部门确认 → HR → 财务 → 财总＋CFO（不看金额）→ 出纳；人数、总额、账户不一致阻断付款；批次号唯一、同期不能重复', async () => {
    const r = await batch({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = r.body.docId;
    expect(labels(await doc(id))).toEqual(['部门负责人', '人力资源', '财务审核人', '财总＋CFO 共同审批', '出纳']);
    expect((await batch({})).body.error.code).toBe('GF_BATCH_DUP');
    const done = await approveAll(id);
    expect(done.body.status).toBe('to_execute');
    expect(done.body.cc).toEqual([]);
    // 付款前没复核：拒绝
    expect((await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/hr-batches/${id}/pay`, { bankRef: 'HRYH-1' })).body.error.code).toBe('GF_BATCH_UNCHECKED');
    const bad = await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/hr-batches/${id}/cashier-check`, {
      headcount: 2,
      totalCents: yuan(13_000),
      accounts: [{ ...lines[0]!, account: '6222999999999999' }, lines[1]],
    });
    expect(bad.body.error.code).toBe('GF_BATCH_MISMATCH');
    const [n] = await ctx.sql`SELECT count(*)::int AS n FROM oa_notifications WHERE staff_id = ${p.ids.gf_hr!} AND title LIKE 'HR 批次出纳复核不一致%'`;
    expect(n!.n).toBe(1);
    expect((await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/hr-batches/${id}/pay`, { bankRef: 'HRYH-1' })).body.error.code).toBe('GF_BATCH_UNCHECKED');
    const ok = await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/hr-batches/${id}/cashier-check`, { headcount: 2, totalCents: yuan(13_000), accounts: lines });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const paid = await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/hr-batches/${id}/pay`, { bankRef: 'HRYH-1' });
    expect(paid.body.paid.bankRef).toBe('HRYH-1');
    expect((await api(ctx.app, c('gf_cash'), 'POST', `/api/gf/hr-batches/${id}/pay`, { bankRef: 'HRYH-2' })).body.error.code).toBe('GF_DUPLICATE_PAYMENT');
    expect((await doc(id)).status).toBe('completed');
  });

  it('薪资明细最小权限：HR、财务看得到；部门负责人（审批人）只看总额', async () => {
    const r = await batch({
      kind: 'commission',
      evidence: [
        { kind: 'performance_confirm', ref: 'a' },
        { kind: 'commission_rules', ref: 'b' },
        { kind: 'calc_detail', ref: 'c' },
      ],
    });
    const v1 = (await api(ctx.app, c('gf_fin'), 'GET', `/api/gf/hr-batches/${r.body.docId}`)).body;
    expect(v1.lines.length).toBe(2);
    expect(v1.lines[0].accountMasked).toBe('****0101');
    const v2 = (await api(ctx.app, c('gf_head'), 'GET', `/api/gf/hr-batches/${r.body.docId}`)).body;
    expect(v2.lines).toBe(null);
    expect(v2.totalCents).toBe(yuan(13_000));
  });

  it('异常批次（补发）：同一流程、关联原批次编号与说明，仍是财总＋CFO；历史只追加', async () => {
    const [orig] = await ctx.sql<{ batchNo: string }[]>`SELECT batch_no FROM gf_hr_batches WHERE kind = 'salary' LIMIT 1`;
    const evidence = [
      { kind: 'original_batch', ref: orig!.batchNo },
      { kind: 'abnormal_reason', ref: '漏发加班费' },
      { kind: 'diff_detail', ref: 'CY-1' },
    ];
    expect((await batch({ kind: 'supplement', evidence, lines: [lines[0]] })).body.error.code).toBe('GF_HR_ORIGINAL');
    const r = await batch({ kind: 'supplement', evidence, originalBatchNo: orig!.batchNo, reason: '十一月漏发加班费', lines: [{ ...lines[0]!, amountCents: yuan(300) }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = await doc(r.body.docId);
    expect(labels(d)).toEqual(['人力资源', '财务审核人', '财总＋CFO 共同审批', '出纳']);
    expect((await api(ctx.app, c('gf_hr'), 'GET', `/api/gf/hr-batches/${r.body.docId}`)).body.originalBatchNo).toBe(orig!.batchNo);
    await expect(ctx.sql`DELETE FROM gf_hr_batch_lines`).rejects.toThrow();
  });

  it('财总＋CFO 任一人不同意即不通过', async () => {
    const r = await batch({
      kind: 'cash_benefit',
      period: '2026-10',
      evidence: [
        { kind: 'benefit_policy', ref: 'a' },
        { kind: 'name_list', ref: 'b' },
        { kind: 'benefit_standard', ref: 'c' },
      ],
    });
    await act(ctx, hr2, r.body.docId, 1);
    await act(ctx, c('gf_fin'), r.body.docId, 2);
    await act(ctx, c('gf_chief'), r.body.docId, 3);
    expect((await act(ctx, c('gf_cfo'), r.body.docId, 3, 'reject', '标准超出政策')).body.status).toBe('rejected');
  });
});

describe('费用分摊引擎（场景 48）', () => {
  it('规则有版本；执行结果按当时版本；冲正追加负数、只能冲一次；原分摊不能删；结果只给财务', async () => {
    expect((await api(ctx.app, c('gf_clerk'), 'GET', '/api/gf/alloc-rules')).status).toBe(403);
    expect((await api(ctx.app, c('gf_fin'), 'POST', '/api/gf/alloc-rules', { name: '后勤分摊', splits: [{ departmentId: p.deptId, bp: 6000 }] })).body.error.code).toBe('GF_ALLOC');
    const rules = (
      await api(ctx.app, c('gf_fin'), 'POST', '/api/gf/alloc-rules', {
        name: '后勤分摊',
        splits: [
          { departmentId: p.deptId, bp: 6000 },
          { departmentId: p.dept2Id, bp: 4000 },
        ],
      })
    ).body;
    const rule = rules[0];
    const run1 = (await api(ctx.app, c('gf_fin'), 'POST', '/api/gf/alloc-runs', { clientKey: randomUUID(), ruleId: rule.id, amountCents: yuan(1_000) })).body;
    expect(run1.lines.map((l: { cents: number }) => l.cents)).toEqual([yuan(600), yuan(400)]);
    const v2 = (
      await api(ctx.app, c('gf_fin'), 'POST', `/api/gf/alloc-rules/${rule.id}/version`, {
        splits: [
          { departmentId: p.deptId, bp: 5000 },
          { departmentId: p.dept2Id, bp: 5000 },
        ],
      })
    ).body;
    expect(v2[0].version).toBe(2);
    const run2 = (await api(ctx.app, c('gf_fin'), 'POST', '/api/gf/alloc-runs', { clientKey: randomUUID(), ruleId: rule.id, amountCents: yuan(1_000) })).body;
    expect(run2).toMatchObject({ ruleVersion: 2 });
    const rev = (await api(ctx.app, c('gf_chief'), 'POST', `/api/gf/alloc-runs/${run1.id}/reverse`, { clientKey: randomUUID(), reason: '口径调整' })).body;
    expect(rev).toMatchObject({ kind: 'reverse', amountCents: -yuan(1_000), reversesRunId: run1.id, ruleVersion: 1 });
    expect((await api(ctx.app, c('gf_chief'), 'POST', `/api/gf/alloc-runs/${run1.id}/reverse`, { clientKey: randomUUID(), reason: '再冲' })).body.error.code).toBe('GF_ALLOC');
    await expect(ctx.sql`DELETE FROM gf_alloc_runs WHERE id = ${run1.id}`).rejects.toThrow();
    const all = (await api(ctx.app, c('gf_cfo'), 'GET', '/api/gf/alloc-runs')).body;
    const net = all
      .flatMap((r: { lines: { departmentId: number; cents: number }[] }) => r.lines)
      .reduce((a: number, l: { departmentId: number; cents: number }) => a + (l.departmentId === p.deptId ? l.cents : 0), 0);
    expect(net).toBe(yuan(500));
  });
});
