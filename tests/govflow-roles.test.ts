// 8.2.9 业财法角色映射可改、变更记录、提交时快照审批人（《业财法审批与 WCP 需求变更》A1，WB1、WB2，docs/V829_GF_ROLES.md）。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, newDoc, setupPeople, yuan, type People } from './govflow-helpers';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let p: People;
const c = (u: string) => p.cookies[u]!;
const roles = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/gf/roles')).body as { id: number; role: string; staffId: number; staffNo: string; departmentName: string | null }[];
const finRow = async () => (await roles()).find((m) => m.role === 'finance_reviewer')!;
/** 30 万合同类：部门负责人 → 履约执行人 → 财法分审 → CEO → 董事长；走到第 3 级（财务审核在这一级） */
const toFinance = async () => {
  const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(300_000), performerId: p.ids.gf_perf, payload: { contractLike: true } });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  expect((await act(ctx, c('gf_head'), d.body.id, 1)).status).toBe(200);
  return d.body.id as number;
};

beforeAll(async () => {
  ctx = await setup();
  p = await setupPeople(ctx);
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

describe('角色映射可改', () => {
  it('列表带工号与部门；修改要写原因、角色不能改、没改动拒绝、只有店主能改', async () => {
    const fin = await finRow();
    expect(fin.staffNo).toBe('gf_fin');
    expect(fin.departmentName).toBe('合成业务部');
    const edit = (cookie: string, body: Record<string, unknown>) => api(ctx.app, cookie, 'POST', `/api/gf/roles/${fin.id}/edit`, body);
    expect((await edit(c('gf_clerk'), { staffId: p.ids.gf_clerk2, reason: '岗位调整' })).status).toBe(403);
    expect((await edit(ctx.owner, { staffId: p.ids.gf_clerk2 })).status).toBe(400);
    expect((await edit(ctx.owner, { staffId: p.ids.gf_fin, reason: '没改' })).body.error.code).toBe('GF_ROLE_SAME');
    // 角色字段不收：传了也不改角色
    expect((await edit(ctx.owner, { staffId: p.ids.gf_fin, role: 'cfo', reason: '没改' })).body.error.code).toBe('GF_ROLE_SAME');
  });

  it('改映射不影响在途单（按提交时的快照），之后提交的按新的；变更记录写清楚谁换成谁、原因', async () => {
    const before = await toFinance();
    const fin = await finRow();
    const r = await api(ctx.app, ctx.owner, 'POST', `/api/gf/roles/${fin.id}/edit`, { staffId: p.ids.gf_clerk2, reason: '岗位调整，由经办二接手' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const now = await finRow();
    expect(now.staffId).toBe(p.ids.gf_clerk2);
    expect(now.id).not.toBe(fin.id);

    // 在途单：履约执行人过了，到第 3 级财法分审，仍由原来的财务审核审
    expect((await act(ctx, c('gf_perf'), before, 2)).status).toBe(200);
    expect((await act(ctx, c('gf_clerk2'), before, 3)).status).toBe(403);
    expect((await act(ctx, c('gf_fin'), before, 3)).status).toBe(200);

    // 之后提交的：新的人审，原来的人不行
    const after = await toFinance();
    expect((await act(ctx, c('gf_perf'), after, 2)).status).toBe(200);
    expect((await act(ctx, c('gf_fin'), after, 3)).status).toBe(403);
    expect((await act(ctx, c('gf_clerk2'), after, 3)).status).toBe(200);

    const log = (await api(ctx.app, ctx.owner, 'GET', '/api/gf/roles/changes')).body;
    expect(log[0]).toMatchObject({ op: 'edit', role: 'finance_reviewer', staffName: '合成经办二', replacedStaffName: '合成财务审核', reason: '岗位调整，由经办二接手' });
    expect((await api(ctx.app, c('gf_clerk'), 'GET', '/api/gf/roles/changes')).status).toBe(403);
  });

  it('快照里的人停用了：这一席改按现在的映射，不卡死；撤销写原因进变更记录', async () => {
    const doc = await toFinance(); // 快照：财务审核 = 经办二
    expect((await act(ctx, c('gf_perf'), doc, 2)).status).toBe(200);
    const fin = await finRow();
    const rv = await api(ctx.app, ctx.owner, 'POST', `/api/gf/roles/${fin.id}/revoke`, { reason: '离职' });
    expect(rv.status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/gf/roles', { role: 'finance_reviewer', staffId: p.ids.gf_fin })).status).toBe(200);
    // 快照里的经办二还在用：仍由他审，现在映射的财务审核审不了
    expect((await act(ctx, c('gf_fin'), doc, 3)).status).toBe(403);
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${p.ids.gf_clerk2!}`;
    expect((await act(ctx, c('gf_fin'), doc, 3)).status).toBe(200);
    const log = (await api(ctx.app, ctx.owner, 'GET', '/api/gf/roles/changes')).body;
    expect(log.find((x: { op: string }) => x.op === 'revoke')).toMatchObject({ role: 'finance_reviewer', staffName: '合成经办二', reason: '离职' });
  });
});
