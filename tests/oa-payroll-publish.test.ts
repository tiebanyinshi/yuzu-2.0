// OA-18 发放、签收与薪资安全审计（docs/OA.md 第 21 节，OA22）：
// 发放前核对（空表、没填、名单外、同人同月同标题不重复）、发放后不能改、通知只发一次；员工只看本人已发放的、签收记时间不变；
// 一键提醒只提醒没签的、10 分钟一次；薪资审计按门店范围、不带金额；工资条异议走人力行政部负责人；挂门店的 HR 建的表不含总裁；
// 调出门店范围的行不能再改。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalTemplate } from '../src/shared/oa-approval';
import type { MyPayslipDetail, MyPayslipItem, PayrollAuditPage, PayrollBatchDetail, PayrollBatchSummary, PayslipTemplate } from '../src/shared/oa-payroll';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
type Emp = { id: number; cookie: string; name: string };
const emp: Record<string, Emp> = {};
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
let std: PayslipTemplate;

const hire = async (username: string, position: string): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: `员工${username}`, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = (r.body as { id: number }).id;
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE id = ${id}`;
  return { id, cookie: await login(ctx.app, username), name: `员工${username}` };
};
const hr = () => emp.hr!.cookie;
const newBatch = async (title: string, who = hr(), month = '2026-11') => {
  const r = await api<PayrollBatchSummary>(ctx.app, who, 'POST', '/api/oa/payroll/batches', { month, title, templateId: std.id });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const detail = async (id: number, who = hr()) => (await api<PayrollBatchDetail>(ctx.app, who, 'GET', `/api/oa/payroll/batches/${id}`)).body;
/** 表里只留这几个人，各填一个实发 */
const keepOnly = async (batchId: number, people: Emp[]) => {
  for (const s of (await detail(batchId)).slips) if (!people.some((p) => p.id === s.staffId)) await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batchId}/slips/${s.staffId}/remove`);
  for (const [i, p] of people.entries()) expect((await api(ctx.app, hr(), 'PUT', `/api/oa/payroll/batches/${batchId}/slips/${p.id}`, { values: { f1: 500000, f10: 400000 + i } })).status).toBe(200);
};
const notifications = (staffId: number) => ctx.sql<{ title: string; link: string; refId: number; readAt: Date | null }[]>`
  SELECT title, link, ref_id, read_at FROM oa_notifications WHERE staff_id = ${staffId} AND kind = 'payslip' ORDER BY id`;

beforeAll(async () => {
  ctx = await setup();
  emp.hr = await hire('pp_hr', 'hr.lead');
  emp.a = await hire('pp_a', 'front.staff');
  emp.b = await hire('pp_b', 'eng.staff');
  emp.c = await hire('pp_c', 'eng.staff');
  std = ((await api<PayslipTemplate[]>(ctx.app, hr(), 'GET', '/api/oa/payroll/templates')).body as PayslipTemplate[]).find((t) => t.name === '标准工资条')!;
});
afterAll(async () => {
  await ctx.close();
});

describe('OA-18 发放', () => {
  let batch: PayrollBatchSummary;

  it('挂门店的 HR 建的表不含总裁', async () => {
    batch = await newBatch('11 月工资');
    const ids = (await detail(batch.id)).slips.map((s) => s.staffId);
    const [owner] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE role = 'owner' AND NOT system ORDER BY id LIMIT 1`;
    expect(ids).not.toContain(Number(owner!.id));
    expect(ids).toContain(emp.a!.id);
  });

  it('发放前核对：一项都没填的、表是空的都拦下', async () => {
    expect(code(await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/publish`))).toBe('PAYROLL_BLANK');
    const empty = await newBatch('空表');
    for (const s of (await detail(empty.id)).slips) await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${empty.id}/slips/${s.staffId}/remove`);
    expect(code(await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${empty.id}/publish`))).toBe('PAYROLL_EMPTY');
  });

  it('发放：状态变已发放、每人一条通知（点开到本人的工资条）；再点一次算成功、不重复通知；发放后不能改、不能作废、不能导入', async () => {
    await keepOnly(batch.id, [emp.a!, emp.b!]);
    const r = await api<PayrollBatchSummary>(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/publish`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('published');
    expect(r.body.publishedAt).not.toBeNull();
    const na = await notifications(emp.a!.id);
    expect(na).toHaveLength(1);
    expect(na[0]!.title).toBe('您有新的工资条，请查收');
    expect(na[0]!.link).toMatch(/^\/oa\/payslips\/\d+$/);
    expect((await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/publish`)).status).toBe(200);
    expect(await notifications(emp.a!.id)).toHaveLength(1);
    expect((await notifications(emp.c!.id)).length).toBe(0);
    expect(code(await api(ctx.app, hr(), 'PUT', `/api/oa/payroll/batches/${batch.id}/slips/${emp.a!.id}`, { values: {} }))).toBe('PAYROLL_PUBLISHED');
    expect(code(await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/void`))).toBe('PAYROLL_PUBLISHED');
    expect(code(await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/slips/${emp.a!.id}/remove`))).toBe('PAYROLL_PUBLISHED');
    // 操作记录不带金额
    const logs = await ctx.sql`SELECT detail FROM audit_logs WHERE action = 'oa_payroll_published'`;
    expect(JSON.stringify(logs)).not.toMatch(/500000|400000/);
  });

  it('同一个人同月同标题只能有一张已发放的（门店范围不同的两张同名表，后发的拦下并写清是谁）', async () => {
    const other = await newBatch('11 月工资', ctx.owner);
    expect(other.id).not.toBe(batch.id);
    for (const s of (await detail(other.id, ctx.owner)).slips) if (s.staffId !== emp.a!.id) await api(ctx.app, ctx.owner, 'POST', `/api/oa/payroll/batches/${other.id}/slips/${s.staffId}/remove`);
    await api(ctx.app, ctx.owner, 'PUT', `/api/oa/payroll/batches/${other.id}/slips/${emp.a!.id}`, { values: { f10: 1 } });
    const r = await api(ctx.app, ctx.owner, 'POST', `/api/oa/payroll/batches/${other.id}/publish`);
    expect(code(r)).toBe('PAYROLL_DUPLICATE');
    expect(JSON.stringify(r.body)).toContain(emp.a!.name);
  });

  it('建表后调出门店范围的人：那一行不能再改（只能移出），发放时拦下', async () => {
    const t = await newBatch('调店');
    await keepOnly(t.id, [emp.c!]);
    const [storeB] = await ctx.sql<{ id: number }[]>`INSERT INTO stores (code, name, entity_id) VALUES ('PPB', '乙店', 1) RETURNING id`;
    await ctx.sql`UPDATE staff_stores SET store_id = ${storeB!.id} WHERE staff_id = ${emp.c!.id}`;
    expect(code(await api(ctx.app, hr(), 'PUT', `/api/oa/payroll/batches/${t.id}/slips/${emp.c!.id}`, { values: { f10: 2 } }))).toBe('NOT_ON_ROSTER');
    expect(code(await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${t.id}/publish`))).toBe('PAYROLL_OFF_ROSTER');
    expect((await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${t.id}/slips/${emp.c!.id}/remove`)).status).toBe(200);
    await ctx.sql`UPDATE staff_stores SET store_id = 1 WHERE staff_id = ${emp.c!.id}`;
  });
});

describe('OA-18 员工端与签收', () => {
  let slipA: number;
  let slipB: number;

  it('员工只看得到本人、已发放的工资条；别人的、草稿里的编号都当没有', async () => {
    const mine = (await api<MyPayslipItem[]>(ctx.app, emp.a!.cookie, 'GET', '/api/oa/my/payslips')).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]!).toMatchObject({ month: '2026-11', title: '11 月工资', net: 400000, signedAt: null });
    slipA = mine[0]!.id;
    slipB = (await api<MyPayslipItem[]>(ctx.app, emp.b!.cookie, 'GET', '/api/oa/my/payslips')).body[0]!.id;
    expect((await api(ctx.app, emp.a!.cookie, 'GET', `/api/oa/my/payslips/${slipB}`)).status).toBe(404);
    expect((await api(ctx.app, emp.a!.cookie, 'POST', `/api/oa/my/payslips/${slipB}/sign`)).status).toBe(404);
    // 草稿里的那一行（调店表、空表）员工看不到
    const [draftSlip] = await ctx.sql<{ id: number }[]>`
      SELECT p.id FROM oa_payslips p JOIN oa_payroll_batches b ON b.id = p.batch_id WHERE b.status = 'draft' AND p.staff_id = ${emp.a!.id} LIMIT 1`;
    if (draftSlip) expect((await api(ctx.app, emp.a!.cookie, 'GET', `/api/oa/my/payslips/${draftSlip.id}`)).status).toBe(404);
    expect((await api(ctx.app, emp.c!.cookie, 'GET', '/api/oa/my/payslips')).body).toEqual([]);
    // 专用账号不能用
    await createStaff(ctx.sql, { username: 'pp_tablet', displayName: '平板', role: 'tablet', password: PASSWORD, mustChangePassword: false });
    expect((await api(ctx.app, await login(ctx.app, 'pp_tablet'), 'GET', '/api/oa/my/payslips')).status).toBe(403);
  });

  it('打开看明细：记第一次查看时间与员工查看的审计；确认签收记时间，签过再点不变', async () => {
    const d = await api<MyPayslipDetail>(ctx.app, emp.a!.cookie, 'GET', `/api/oa/my/payslips/${slipA}`);
    expect(d.status).toBe(200);
    expect(d.body.values).toEqual({ f1: 500000, f10: 400000 });
    expect(d.body.fields).toEqual(std.fields);
    const s1 = await api<MyPayslipDetail>(ctx.app, emp.a!.cookie, 'POST', `/api/oa/my/payslips/${slipA}/sign`);
    expect(s1.body.signedAt).not.toBeNull();
    const s2 = await api<MyPayslipDetail>(ctx.app, emp.a!.cookie, 'POST', `/api/oa/my/payslips/${slipA}/sign`);
    expect(s2.body.signedAt).toBe(s1.body.signedAt);
    const row = (await detail((await ctx.sql<{ batchId: number }[]>`SELECT batch_id FROM oa_payslips WHERE id = ${slipA}`)[0]!.batchId)).slips;
    expect(row.find((x) => x.staffId === emp.a!.id)!.signedAt).toBe(s1.body.signedAt);
    expect(row.find((x) => x.staffId === emp.a!.id)!.viewedAt).not.toBeNull();
    expect(row.find((x) => x.staffId === emp.b!.id)!.signedAt).toBeNull();
    expect((await ctx.sql`SELECT 1 FROM oa_payroll_audit WHERE action = 'employee_sign' AND target_id = ${emp.a!.id}`).length).toBe(1);
  });

  it('一键提醒只提醒没签的；10 分钟内再点拦下；草稿不用提醒', async () => {
    const [row] = await ctx.sql<{ batchId: number }[]>`SELECT batch_id FROM oa_payslips WHERE id = ${slipA}`;
    const batchId = Number(row!.batchId);
    // 先把之前的通知都读掉，好数新的
    await ctx.sql`UPDATE oa_notifications SET read_at = now() WHERE kind = 'payslip'`;
    const r = await api<{ reminded: number }>(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batchId}/remind`);
    expect(r.body.reminded).toBe(1);
    expect((await notifications(emp.b!.id)).filter((n) => !n.readAt).map((n) => n.title)).toEqual(['您的工资条还没签收']);
    expect((await notifications(emp.a!.id)).filter((n) => !n.readAt)).toHaveLength(0);
    expect(code(await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batchId}/remind`))).toBe('REMIND_TOO_SOON');
    const draft = await newBatch('草稿提醒');
    expect(code(await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${draft.id}/remind`))).toBe('PAYROLL_NOT_PUBLISHED');
  });
});

describe('OA-18 薪资审计与异议', () => {
  it('审计页：按时间倒序列发放、提醒、员工查看与签收，不带金额；能按动作筛；别的门店的 HR 看不到这张表的记录；员工打不开', async () => {
    const page = (await api<PayrollAuditPage>(ctx.app, hr(), 'GET', '/api/oa/payroll/audit')).body;
    const actions = page.items.map((i) => i.action);
    for (const a of ['publish', 'remind', 'employee_view', 'employee_sign', 'view_batch']) expect(actions, a).toContain(a);
    expect(page.items[0]!.id).toBeGreaterThan(page.items[page.items.length - 1]!.id);
    expect(JSON.stringify(page)).not.toMatch(/500000|400000/);
    const sign = page.items.find((i) => i.action === 'employee_sign')!;
    expect([sign.actorName, sign.targetName, sign.batchLabel]).toEqual([emp.a!.name, emp.a!.name, '2026 年 11 月 · 11 月工资']);
    const only = (await api<PayrollAuditPage>(ctx.app, hr(), 'GET', '/api/oa/payroll/audit?action=publish')).body;
    expect(new Set(only.items.map((i) => i.action))).toEqual(new Set(['publish']));
    // 乙店的 HR
    const [storeB] = await ctx.sql<{ id: number }[]>`SELECT id FROM stores WHERE code = 'PPB'`;
    const hrB = await hire('pp_hrb', 'hr.lead');
    await ctx.sql`UPDATE staff_stores SET store_id = ${storeB!.id} WHERE staff_id = ${hrB.id}`;
    expect((await api<PayrollAuditPage>(ctx.app, hrB.cookie, 'GET', '/api/oa/payroll/audit')).body.items).toEqual([]);
    expect((await api(ctx.app, emp.a!.cookie, 'GET', '/api/oa/payroll/audit')).status).toBe(403);
  });

  it('工资条异议：办公审批的新模板，审批人是人力行政部负责人', async () => {
    const templates = (await api<ApprovalTemplate[]>(ctx.app, emp.a!.cookie, 'GET', '/api/oa/approval/templates')).body;
    const t = templates.find((x) => x.code === 'payslip_objection')!;
    expect(t.name).toBe('工资条异议');
    const r = await api<{ approval: { id: number } }>(ctx.app, emp.a!.cookie, 'POST', '/api/oa/approvals', {
      clientKey: randomUUID(),
      templateId: t.id,
      form: { payslip: '2026 年 11 月 · 11 月工资', content: '加班费少算了一天' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [step] = await ctx.sql<{ approverId: number }[]>`SELECT approver_id FROM oa_approval_steps WHERE approval_id = ${r.body.approval.id} ORDER BY seq LIMIT 1`;
    expect(Number(step!.approverId)).toBe(emp.hr!.id);
  });
});
