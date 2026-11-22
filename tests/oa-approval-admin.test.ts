// OA-12 办公审批管理端（docs/OA.md 第 15 节）：两项新权限默认给人力行政部负责人（全部审批单还给总经办）；
// 模板设置（审批人、条件开关只认适用的、指定人要在职、带版本、停用以后不能发起、改了只影响之后提交的）；
// 全部审批单（筛选、不相干也能看详情、能催办、导出记审计）；看板（数量、平均时长、超时未处理）。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminApprovalPage, ApprovalBoard, ApprovalDetail, ApprovalSaved, ApprovalTemplate } from '../src/shared/oa-approval';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
type Emp = { id: number; cookie: string };
const emp: Record<string, Emp> = {};
const tpl: Record<string, ApprovalTemplate> = {};
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

const hire = async (username: string, position: string): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username) };
};
const submit = async (who: Emp, title: string) => {
  const r = await api<ApprovalSaved>(ctx.app, who.cookie, 'POST', '/api/oa/approvals', { clientKey: randomUUID(), templateId: tpl.general!.id, form: { title, content: '内容' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.approval;
};
const templates = async () => {
  for (const t of (await api(ctx.app, emp.hr!.cookie, 'GET', '/api/oa/approval/templates/all')).body as ApprovalTemplate[]) tpl[t.code] = t;
};
const put = (code: string, patch: object, who = emp.hr!) => {
  const t = tpl[code]!;
  return api<ApprovalTemplate>(ctx.app, who.cookie, 'PUT', `/api/oa/approval/templates/${t.id}`, {
    description: t.description,
    levels: t.levels,
    conditions: t.conditions,
    cc: t.cc,
    active: t.active,
    version: t.version,
    ...patch,
  });
};

beforeAll(async () => {
  ctx = await setup();
  emp.staff = await hire('aa_staff', 'front.staff');
  emp.lead = await hire('aa_lead', 'front.lead');
  emp.hr = await hire('aa_hr', 'hr.lead');
  emp.gmo = await hire('aa_gmo', 'gmo');
  emp.eng = await hire('aa_eng', 'eng.staff');
  await templates();
});
afterAll(async () => {
  await ctx.close();
});

describe('OA-12 办公审批管理端', () => {
  it('权限：人力行政部负责人两项都有、总经办只有全部审批单、员工都没有', async () => {
    expect((await api(ctx.app, emp.hr!.cookie, 'GET', '/api/oa/approvals/all')).status).toBe(200);
    expect((await api(ctx.app, emp.gmo!.cookie, 'GET', '/api/oa/approvals/all')).status).toBe(200);
    expect((await put('general', {}, emp.gmo!)).status).toBe(403);
    for (const url of ['/api/oa/approvals/all', '/api/oa/approvals/board', '/api/oa/approval/templates/all']) {
      expect((await api(ctx.app, emp.staff!.cookie, 'GET', url)).status, url).toBe(403);
    }
  });

  it('模板设置：改审批人只影响之后提交的单；条件开关只认适用的；指定人要在职；带版本；停用以后不能发起', async () => {
    const before = await submit(emp.staff!, '改之前');
    expect(before.steps.map((s) => s.approverId)).toEqual([emp.lead!.id]);
    const r = await put('general', { levels: [{ kind: 'dept_head' }, { kind: 'staff', staffId: emp.hr!.id }], cc: [{ kind: 'staff', staffId: emp.eng!.id }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.version).toBe(tpl.general!.version + 1);
    expect(code(await put('general', { description: '旧版本' }))).toBe('VERSION_CONFLICT');
    await templates();
    const after = await submit(emp.staff!, '改之后');
    expect(after.steps.map((s) => s.approverId)).toEqual([emp.lead!.id, emp.hr!.id]);
    expect(after.cc.map((c) => c.staffId)).toEqual([emp.eng!.id]);
    expect((await api<ApprovalDetail>(ctx.app, emp.staff!.cookie, 'GET', `/api/oa/approvals/${before.id}`)).body.steps.map((s) => s.approverId)).toEqual([emp.lead!.id]);
    expect(code(await put('general', { conditions: { leave_over_3_days: true } }))).toBe('CONDITION_INVALID');
    expect((await put('leave', { conditions: { leave_over_3_days: false } })).status).toBe(200);
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${emp.eng!.id}`;
    expect(code(await put('general', { cc: [{ kind: 'staff', staffId: emp.eng!.id }] }))).toBe('APPROVER_INVALID');
    await ctx.sql`UPDATE staff SET active = true WHERE id = ${emp.eng!.id}`;
    expect((await put('general', { levels: [] })).status).toBe(400);
    expect((await put('general', { levels: [{ kind: 'dept_head' }, { kind: 'dept_head' }, { kind: 'dept_head' }, { kind: 'dept_head' }] })).status).toBe(400);
    expect((await put('trip', { active: false })).status).toBe(200);
    const off = await api(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/approvals', { clientKey: randomUUID(), templateId: tpl.trip!.id, form: {} });
    expect(code(off)).toBe('NOT_FOUND');
    expect(((await api(ctx.app, emp.staff!.cookie, 'GET', '/api/oa/approval/templates')).body as ApprovalTemplate[]).some((t) => t.code === 'trip')).toBe(false);
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'oa_approval_template_saved'`).length).toBe(3);
    // 放回只有一级，免得影响下面
    await templates();
    expect((await put('general', { levels: [{ kind: 'dept_head' }], cc: [] })).status).toBe(200);
    await templates();
  });

  it('全部审批单：筛选；不相干也能看详情、能催办；导出 Excel 记审计', async () => {
    const a = await submit(emp.eng!, '工程部的用章');
    const all = (q = '') => api<AdminApprovalPage>(ctx.app, emp.hr!.cookie, 'GET', `/api/oa/approvals/all${q}`);
    expect((await all('?dept=eng')).body.items.map((x) => x.id)).toEqual([a.id]);
    expect((await all('?dept=eng')).body.items[0]).toMatchObject({ department: '工程部', status: 'pending' });
    expect((await all('?q=工程部的')).body.items.map((x) => x.id)).toEqual([a.id]);
    expect((await all('?q=aa_eng')).body.items.map((x) => x.id)).toEqual([a.id]);
    expect((await all('?template=general&status=pending')).body.items.length).toBeGreaterThanOrEqual(3);
    expect((await all('?template=leave')).body.items).toEqual([]);
    expect((await all('?from=2000-01-01&to=2000-01-31')).body.items).toEqual([]);
    // 人事不在这张单上（工程部没有负责人，取到总经办），也能看、能催办（一小时一次）
    const d = await api<ApprovalDetail>(ctx.app, emp.hr!.cookie, 'GET', `/api/oa/approvals/${a.id}`);
    expect(d.status).toBe(200);
    expect(d.body.can).toMatchObject({ urge: true, approve: false, withdraw: false });
    const urge = () => api(ctx.app, emp.hr!.cookie, 'POST', `/api/oa/approvals/${a.id}/act`, { clientKey: randomUUID(), action: 'urge' });
    expect((await urge()).status).toBe(200);
    expect(code(await urge())).toBe('URGE_TOO_SOON');
    expect((await api(ctx.app, emp.hr!.cookie, 'POST', `/api/oa/approvals/${a.id}/act`, { clientKey: randomUUID(), action: 'withdraw' })).status).toBe(403);
    // 员工照旧看不到别人的
    expect((await api(ctx.app, emp.staff!.cookie, 'GET', `/api/oa/approvals/${a.id}`)).status).toBe(404);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/oa/approvals/all.xlsx?dept=eng', headers: { cookie: emp.hr!.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const [log] = await ctx.sql<{ detail: { count: number } }[]>`SELECT detail FROM audit_logs WHERE action = 'export' AND target_type = 'oa_approvals'`;
    expect(log!.detail.count).toBe(1);
  });

  it('看板：本月各模板的数量与平均时长；当前这一级等了超过 24 小时的列为超时', async () => {
    const a = await submit(emp.staff!, '要超时的');
    const b = await submit(emp.staff!, '很快批的');
    await api(ctx.app, emp.lead!.cookie, 'POST', `/api/oa/approvals/${b.id}/act`, { clientKey: randomUUID(), action: 'approve', stepId: b.pendingStepId });
    await ctx.sql`UPDATE oa_approval_events SET created_at = now() - interval '30 hours' WHERE approval_id = ${a.id}`;
    const board = (await api<ApprovalBoard>(ctx.app, emp.hr!.cookie, 'GET', '/api/oa/approvals/board')).body;
    const general = board.templates.find((t) => t.code === 'general')!;
    expect(general.submitted).toBeGreaterThanOrEqual(5);
    expect(general.approved).toBeGreaterThanOrEqual(1);
    expect(general.avgHours).not.toBeNull();
    expect(board.templates.find((t) => t.code === 'overtime')).toMatchObject({ submitted: 0, avgHours: null });
    expect(board.overdue.find((o) => o.id === a.id)).toMatchObject({ approverName: 'aa_lead', waitedHours: 30 });
    expect(board.overdue.some((o) => o.id === b.id)).toBe(false);
    expect((await api(ctx.app, emp.hr!.cookie, 'GET', '/api/oa/approvals/board?month=2000-01')).body).toMatchObject({ month: '2000-01' });
  });
});
