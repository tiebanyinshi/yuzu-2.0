// OA-10 办公审批引擎（docs/OA.md 第 13 节）：审批人在提交时按模板定下来（本部门主管、上级部门主管、指定人；取到自己的往上取、
// 相邻同一人并级、发起人是最上级的直接通过）；条件加签；通过、驳回（必填原因、整单退回、重新提交生成新的一版）、转交（转交链）、
// 撤销（没人通过过）、催办（一小时一次）、评论；抄送与已读；谁能看；操作编号（重提不重复、只能查回自己的）；附件按单据核对能不能看。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalDetail, ApprovalPage, ApprovalSaved, ApprovalSummary, ApprovalTemplate } from '../src/shared/oa-approval';
import type { NotificationPage } from '../src/shared/oa';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
type Emp = { id: number; cookie: string };
const emp: Record<string, Emp> = {};
let general: ApprovalTemplate;
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const hire = async (username: string, position: string): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username) };
};
const setLevels = (levels: object[], cc: object[] = [], conditions: object = {}) =>
  ctx.sql`UPDATE oa_approval_templates SET levels = ${ctx.sql.json(levels as never)}, cc = ${ctx.sql.json(cc as never)}, conditions = ${ctx.sql.json(conditions as never)} WHERE code = 'general'`;
const submit = async (who: Emp, form: object = { title: '用章申请', content: '盖合同章' }, extra: object = {}) => {
  const r = await api<ApprovalSaved>(ctx.app, who.cookie, 'POST', '/api/oa/approvals', { clientKey: randomUUID(), templateId: general.id, form, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.approval;
};
const act = (who: Emp, id: number, body: object) => api<ApprovalSaved>(ctx.app, who.cookie, 'POST', `/api/oa/approvals/${id}/act`, { clientKey: randomUUID(), ...body });
const detail = async (who: Emp, id: number) => (await api<ApprovalDetail>(ctx.app, who.cookie, 'GET', `/api/oa/approvals/${id}`)).body;
const chainOf = (a: ApprovalDetail) => a.steps.map((s) => [s.approverId, s.status]);

beforeAll(async () => {
  ctx = await setup();
  emp.staff = await hire('ap_staff', 'front.staff');
  emp.lead = await hire('ap_lead', 'front.lead');
  emp.gmo = await hire('ap_gmo', 'gmo');
  emp.hr = await hire('ap_hr', 'hr.lead');
  emp.eng = await hire('ap_eng', 'eng.staff');
  emp.other = await hire('ap_other', 'kitchen.staff');
  emp.owner = { id: ctx.ownerId, cookie: ctx.owner };
  general = ((await api(ctx.app, emp.staff!.cookie, 'GET', '/api/oa/approval/templates')).body as ApprovalTemplate[]).find((t) => t.code === 'general')!;
});
afterAll(async () => {
  await ctx.close();
});

describe('OA-10 审批引擎', () => {
  it('模板：带「通用」，登录就能看；表单按字段核对', async () => {
    expect(general).toMatchObject({ name: '通用', levels: [{ kind: 'dept_head' }] });
    expect(general.fields.map((f) => f.key)).toEqual(['title', 'content', 'attachments']);
    const bad = await api(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/approvals', { clientKey: randomUUID(), templateId: general.id, form: { title: '没有内容' } });
    expect(code(bad)).toBe('FORM_INVALID');
  });

  it('审批人在提交时定下来：本部门主管 → 上级部门主管 → 指定人；抄送；取到自己的往上取、同一人并级；发起人是最上级的直接通过', async () => {
    await setLevels([{ kind: 'dept_head' }, { kind: 'parent_head' }, { kind: 'staff', staffId: emp.hr!.id }], [{ kind: 'staff', staffId: emp.eng!.id }]);
    const a = await submit(emp.staff!);
    expect(chainOf(a)).toEqual([
      [emp.lead!.id, 'pending'],
      [emp.gmo!.id, 'waiting'],
      [emp.hr!.id, 'waiting'],
    ]);
    expect(a.cc.map((c) => c.staffId)).toEqual([emp.eng!.id]);
    // 部门负责人自己发起：本部门主管取到自己 → 往上取总经办；上级部门主管也是总经办 → 并成一级
    const b = await submit(emp.lead!);
    expect(chainOf(b)).toEqual([
      [emp.gmo!.id, 'pending'],
      [emp.hr!.id, 'waiting'],
    ]);
    // 店主（总裁）自己发起：两级都取不到人，只剩指定的人事
    await setLevels([{ kind: 'dept_head' }, { kind: 'parent_head' }]);
    const c = await submit(emp.owner!);
    expect(c).toMatchObject({ status: 'approved', steps: [] });
    // 模板里指定的审批人停用了：拒绝提交
    await setLevels([{ kind: 'staff', staffId: emp.other!.id }]);
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${emp.other!.id}`;
    expect(code(await api(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/approvals', { clientKey: randomUUID(), templateId: general.id, form: { title: 'x', content: 'y' } }))).toBe('APPROVER_INVALID');
    await ctx.sql`UPDATE staff SET active = true WHERE id = ${emp.other!.id}`;
  });

  it('逐级通过：只有轮到的人能处理、带页面上看到的那一步；最后一级通过整单通过、通知发起人；抄送人看得到、能评论、记已读', async () => {
    await setLevels([{ kind: 'dept_head' }, { kind: 'parent_head' }], [{ kind: 'staff', staffId: emp.eng!.id }]);
    const a = await submit(emp.staff!);
    const todo = (await api<ApprovalPage>(ctx.app, emp.lead!.cookie, 'GET', '/api/oa/approvals?box=todo')).body;
    expect(todo.items.map((x) => x.id)).toContain(a.id);
    expect((await api<ApprovalSummary>(ctx.app, emp.lead!.cookie, 'GET', '/api/oa/approvals/summary')).body.todo).toBeGreaterThanOrEqual(1);
    expect((await act(emp.gmo!, a.id, { action: 'approve', stepId: a.pendingStepId })).status).toBe(403);
    expect(code(await act(emp.lead!, a.id, { action: 'approve', stepId: a.pendingStepId! + 999 }))).toBe('STEP_CHANGED');
    const r1 = await act(emp.lead!, a.id, { action: 'approve', stepId: a.pendingStepId, comment: '同意' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(chainOf(r1.body.approval)).toEqual([
      [emp.lead!.id, 'approved'],
      [emp.gmo!.id, 'pending'],
    ]);
    const r2 = await act(emp.gmo!, a.id, { action: 'approve', stepId: r1.body.approval.pendingStepId });
    expect(r2.body.approval).toMatchObject({ status: 'approved' });
    expect(r2.body.approval.events.map((e) => e.kind)).toEqual(['submit', 'approve', 'approve']);
    const unread = ((await api(ctx.app, emp.staff!.cookie, 'GET', '/api/oa/notifications?status=unread')).body as NotificationPage).items;
    expect(unread.find((n) => n.kind === 'approval_result')).toMatchObject({ title: '用章申请已通过', link: `/oa/approvals/${a.id}` });
    // 抄送：看得到、能评论、记已读
    expect((await api<ApprovalSummary>(ctx.app, emp.eng!.cookie, 'GET', '/api/oa/approvals/summary')).body.ccUnread).toBeGreaterThanOrEqual(1);
    expect((await act(emp.eng!, a.id, { action: 'comment', comment: '收到' })).status).toBe(200);
    await api(ctx.app, emp.eng!.cookie, 'POST', `/api/oa/approvals/${a.id}/read`);
    const cc = (await api<ApprovalPage>(ctx.app, emp.eng!.cookie, 'GET', '/api/oa/approvals?box=cc')).body.items.find((x) => x.id === a.id)!;
    expect(cc.ccReadAt).not.toBeNull();
    // 不相干的人看不到
    expect((await api(ctx.app, emp.other!.cookie, 'GET', `/api/oa/approvals/${a.id}`)).status).toBe(404);
    expect((await act(emp.other!, a.id, { action: 'comment', comment: '路过' })).status).toBe(404);
    expect(code(await act(emp.gmo!, a.id, { action: 'approve', stepId: r1.body.approval.pendingStepId }))).toBe('APPROVAL_CLOSED');
  });

  it('驳回：必填原因、整单退回；改了重新提交生成新的一版，原单留着；只能重新提交一次', async () => {
    await setLevels([{ kind: 'dept_head' }, { kind: 'parent_head' }]);
    const a = await submit(emp.staff!);
    expect((await act(emp.lead!, a.id, { action: 'reject', stepId: a.pendingStepId, comment: '' })).status).toBe(400);
    const r = await act(emp.lead!, a.id, { action: 'reject', stepId: a.pendingStepId, comment: '写清楚用哪个章' });
    expect(r.body.approval).toMatchObject({ status: 'rejected' });
    expect(chainOf(r.body.approval)).toEqual([
      [emp.lead!.id, 'rejected'],
      [emp.gmo!.id, 'cancelled'],
    ]);
    expect((await detail(emp.staff!, a.id)).can.resubmit).toBe(true);
    const b = await submit(emp.staff!, { title: '用章申请', content: '盖合同专用章' }, { previousId: a.id });
    expect(b).toMatchObject({ revision: 2, previousId: a.id, status: 'pending' });
    expect((await detail(emp.staff!, a.id)).nextId).toBe(b.id);
    const again = await api(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/approvals', { clientKey: randomUUID(), templateId: general.id, form: { title: 'x', content: 'y' }, previousId: a.id });
    expect(code(again)).toBe('RESUBMITTED');
    // 别人的单不能拿来重新提交；还在审批中的不能重新提交
    expect(code(await api(ctx.app, emp.lead!.cookie, 'POST', '/api/oa/approvals', { clientKey: randomUUID(), templateId: general.id, form: { title: 'x', content: 'y' }, previousId: a.id }))).toBe(
      'NOT_FOUND',
    );
    expect(code(await api(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/approvals', { clientKey: randomUUID(), templateId: general.id, form: { title: 'x', content: 'y' }, previousId: b.id }))).toBe(
      'RESUBMIT_INVALID',
    );
  });

  it('转交：交给另一位在职员工，记转交链；不能转给自己或发起人', async () => {
    await setLevels([{ kind: 'dept_head' }]);
    const a = await submit(emp.staff!);
    expect(code(await act(emp.lead!, a.id, { action: 'transfer', stepId: a.pendingStepId, toStaffId: emp.staff!.id }))).toBe('TRANSFER_INVALID');
    const r = await act(emp.lead!, a.id, { action: 'transfer', stepId: a.pendingStepId, toStaffId: emp.hr!.id, comment: '人事来批' });
    expect(r.body.approval.steps.map((s) => [s.approverId, s.status, s.transferredToName])).toEqual([
      [emp.lead!.id, 'transferred', 'ap_hr'],
      [emp.hr!.id, 'pending', null],
    ]);
    expect((await act(emp.lead!, a.id, { action: 'approve', stepId: r.body.approval.pendingStepId })).status).toBe(403);
    const done = await act(emp.hr!, a.id, { action: 'approve', stepId: r.body.approval.pendingStepId });
    expect(done.body.approval.status).toBe('approved');
    // 转交出去的人照样看得到、在「我处理过的」里
    expect((await api<ApprovalPage>(ctx.app, emp.lead!.cookie, 'GET', '/api/oa/approvals?box=done')).body.items.map((x) => x.id)).toContain(a.id);
  });

  it('撤销：只有发起人、没人通过过；催办一小时一次', async () => {
    await setLevels([{ kind: 'dept_head' }, { kind: 'parent_head' }]);
    const a = await submit(emp.staff!);
    expect((await act(emp.lead!, a.id, { action: 'withdraw' })).status).toBe(403);
    expect((await act(emp.staff!, a.id, { action: 'urge' })).status).toBe(200);
    expect(code(await act(emp.staff!, a.id, { action: 'urge' }))).toBe('URGE_TOO_SOON');
    const urged = ((await api(ctx.app, emp.lead!.cookie, 'GET', '/api/oa/notifications?status=unread')).body as NotificationPage).items;
    expect(urged.some((n) => n.kind === 'approval_urge')).toBe(true);
    const w = await act(emp.staff!, a.id, { action: 'withdraw', comment: '不用了' });
    expect(w.body.approval).toMatchObject({ status: 'withdrawn' });
    const b = await submit(emp.staff!);
    await act(emp.lead!, b.id, { action: 'approve', stepId: b.pendingStepId });
    expect(code(await act(emp.staff!, b.id, { action: 'withdraw' }))).toBe('WITHDRAW_TOO_LATE');
  });

  it('操作编号：提交与处理重提不重复；换了内容拒绝；只能查回自己的；确认作废以后晚到的不生效', async () => {
    await setLevels([{ kind: 'dept_head' }]);
    const key = randomUUID();
    const body = { clientKey: key, templateId: general.id, form: { title: '重提', content: '一次' } };
    const r1 = await api<ApprovalSaved>(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/approvals', body);
    const r2 = await api<ApprovalSaved>(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/approvals', body);
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ replayed: true, approval: { id: r1.body.approval.id } });
    expect(code(await api(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/approvals', { ...body, form: { title: '重提', content: '两次' } }))).toBe('IDEMPOTENCY_CONFLICT');
    expect((await api(ctx.app, emp.staff!.cookie, 'GET', `/api/erp/ops/${key}?type=oa_approval_submit`)).body).toMatchObject({ found: true, refId: r1.body.approval.id });
    expect((await api(ctx.app, emp.lead!.cookie, 'GET', `/api/erp/ops/${key}?type=oa_approval_submit`)).status).toBe(403);
    const actKey = randomUUID();
    const a1 = await api<ApprovalSaved>(ctx.app, emp.lead!.cookie, 'POST', `/api/oa/approvals/${r1.body.approval.id}/act`, {
      clientKey: actKey,
      action: 'approve',
      stepId: r1.body.approval.pendingStepId,
    });
    expect(a1.body.approval.status).toBe('approved');
    const a2 = await api<ApprovalSaved>(ctx.app, emp.lead!.cookie, 'POST', `/api/oa/approvals/${r1.body.approval.id}/act`, {
      clientKey: actKey,
      action: 'approve',
      stepId: r1.body.approval.pendingStepId,
    });
    expect(a2.body).toMatchObject({ replayed: true });
    const late = randomUUID();
    expect((await api(ctx.app, emp.staff!.cookie, 'POST', `/api/erp/ops/${late}/abandon`, { type: 'oa_approval_submit', summary: '提交审批' })).status).toBe(200);
    expect((await api(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/approvals', { ...body, clientKey: late })).status).toBe(409);
  });

  it('条件加签：报销模板开了「超过 5000 元加签总经办」，金额超过才加一级', async () => {
    const fields = [{ key: 'amount', label: '金额', type: 'money', required: true, min: 1 }];
    // 用迁移带的「报销」模板，只留金额一项（条件开关按模板编码 expense 判断）
    const [t] = await ctx.sql<{ id: number }[]>`
      UPDATE oa_approval_templates SET fields = ${ctx.sql.json(fields as never)}, levels = '[{"kind":"dept_head"}]', conditions = '{"expense_over_5000":true}'
      WHERE code = 'expense' RETURNING id`;
    const post = (amount: number) => api<ApprovalSaved>(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/approvals', { clientKey: randomUUID(), templateId: Number(t!.id), form: { amount } });
    expect((await post(100_000)).body.approval.steps.map((s) => s.approverId)).toEqual([emp.lead!.id]);
    const big = (await post(600_000)).body.approval;
    expect(big.steps.map((s) => [s.approverId, s.label])).toEqual([
      [emp.lead!.id, '本部门主管'],
      [emp.gmo!.id, '超过 5000 元加签'],
    ]);
    expect(big.title).toBe('报销 · ¥6,000.00');
  });

  it('附件：只能挂自己传的；挂上以后审批人看得到、不相干的人看不到', async () => {
    await setLevels([{ kind: 'dept_head' }]);
    const up = await api<{ id: number }>(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/attachments', {
      clientKey: randomUUID(),
      fileName: '合同.jpg',
      mime: 'image/jpeg',
      data: JPEG.toString('base64'),
    });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const theirs = await api<{ id: number }>(ctx.app, emp.eng!.cookie, 'POST', '/api/oa/attachments', {
      clientKey: randomUUID(),
      fileName: '别人.jpg',
      mime: 'image/jpeg',
      data: JPEG.toString('base64'),
    });
    const stolen = await api(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/approvals', {
      clientKey: randomUUID(),
      templateId: general.id,
      form: { title: 'x', content: 'y', attachments: [theirs.body.id] },
    });
    expect(code(stolen)).toBe('ATTACHMENT_INVALID');
    const a = await submit(emp.staff!, { title: '带附件', content: '见附件', attachments: [up.body.id] });
    expect(a.attachments.map((x) => x.id)).toEqual([up.body.id]);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/oa/attachments/${up.body.id}`, headers: { cookie: emp.lead!.cookie } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/oa/attachments/${up.body.id}`, headers: { cookie: emp.other!.cookie } })).statusCode).not.toBe(200);
  });
  it('重新提交沿用上一版的附件：原单留着附件，新一版的审批人看得到；不能拿别人单上的附件（Codex 审查 62e6f5e）', async () => {
    await setLevels([{ kind: 'dept_head' }]);
    const upload = async (who: Emp, fileName: string) =>
      (await api<{ id: number }>(ctx.app, who.cookie, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName, mime: 'image/jpeg', data: JPEG.toString('base64') })).body.id;
    const first = await upload(emp.staff!, '原件.jpg');
    const a = await submit(emp.staff!, { title: '用章', content: '见附件', attachments: [first] });
    await act(emp.lead!, a.id, { action: 'reject', stepId: a.pendingStepId, comment: '再补一张' });
    const second = await upload(emp.staff!, '补充.jpg');
    const b = await submit(emp.staff!, { title: '用章', content: '补上了', attachments: [first, second] }, { previousId: a.id });
    expect(b.attachments.map((x) => x.id)).toEqual([first, second]);
    expect((await detail(emp.staff!, a.id)).attachments.map((x) => x.id)).toEqual([first]);
    // 第三版只留第二张
    await act(emp.lead!, b.id, { action: 'reject', stepId: b.pendingStepId, comment: '第一张不要了' });
    const c = await submit(emp.staff!, { title: '用章', content: '只要补充那张', attachments: [second] }, { previousId: b.id });
    expect(c.attachments.map((x) => x.id)).toEqual([second]);
    // 新一版换了审批人（转交给人事），人事看得到沿用的附件
    const t = await act(emp.lead!, c.id, { action: 'transfer', stepId: c.pendingStepId, toStaffId: emp.hr!.id });
    expect(t.status).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/oa/attachments/${second}`, headers: { cookie: emp.hr!.cookie } })).statusCode).toBe(200);
    // 别人单上的附件不能拿来
    const theirs = await submit(emp.eng!, { title: '别人', content: 'x', attachments: [await upload(emp.eng!, '别人的.jpg')] });
    await act(emp.gmo!, theirs.id, { action: 'approve', stepId: theirs.pendingStepId });
    const stolen = await api(ctx.app, emp.staff!.cookie, 'POST', '/api/oa/approvals', {
      clientKey: randomUUID(),
      templateId: general.id,
      form: { title: 'x', content: 'y', attachments: [theirs.attachments[0]!.id] },
    });
    expect(code(stolen)).toBe('ATTACHMENT_INVALID');
  });

  it('总裁：岗位是总裁的优先，没选岗位的老店主账号只在没有总裁时兜底；总裁自己发起直接通过（Codex 审查 62e6f5e）', async () => {
    await setLevels([{ kind: 'dept_head' }]);
    const boss = await hire('ap_boss', 'president');
    const a = await submit(boss);
    expect(a).toMatchObject({ status: 'approved', steps: [] });
    // 总经办发起：本部门主管是自己 → 往上到公司 → 总裁（岗位是总裁的那位，不是老店主账号）
    const b = await submit(emp.gmo!);
    expect(b.steps.map((x) => x.approverId)).toEqual([boss.id]);
  });
});
