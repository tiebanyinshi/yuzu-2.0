// OA-01 组织架构与员工档案（docs/OA.md 第 4 节，OA1–OA5）：部门上级与主管、员工档案、办理离职与复职。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgOverview } from '../src/shared/oa';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

const hire = async (username: string, position: string) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username) };
};
const org = async (cookie = ctx.owner) => {
  const r = await api(ctx.app, cookie, 'GET', '/api/oa/org');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as OrgOverview;
};
const emp = (o: OrgOverview, id: number) => o.employees.find((e) => e.staffId === id)!;
const deptVersion = async (key: string) => (await org()).departments.find((d) => d.key === key)!.version;
const putDept = async (key: string, body: { parentKey: string | null; headStaffId: number | null }, version?: number) =>
  api(ctx.app, ctx.owner, 'PUT', `/api/oa/org/departments/${key}`, { ...body, version: version ?? (await deptVersion(key)) });

describe('OA-01 组织架构与员工档案', () => {
  it('权限：人力行政部负责人与总裁能看；前台员工、人力行政部员工不能', async () => {
    const hrLead = await hire('oa_hr_lead', 'hr.lead');
    const hrStaff = await hire('oa_hr_staff', 'hr.staff');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/oa/org')).status).toBe(403);
    expect((await api(ctx.app, hrStaff.cookie, 'GET', '/api/oa/org')).status).toBe(403);
    const o = await org(hrLead.cookie);
    expect(o.departments).toHaveLength(15);
    expect(o.departments.find((d) => d.key === 'company')!.parentKey).toBeNull();
    expect(o.departments.find((d) => d.key === 'gmo')!.parentKey).toBe('company');
    expect(o.departments.find((d) => d.key === 'front')!.parentKey).toBe('gmo');
  });

  it('部门主管：没指定按负责人岗位自动取；指定在职员工后用指定的；上级部门不能绕成环', async () => {
    const lead = await hire('oa_front_lead', 'front.lead');
    const staff = await hire('oa_front_staff', 'front.staff');
    let front = (await org()).departments.find((d) => d.key === 'front')!;
    expect(front.head).toEqual({ id: lead.id, name: 'oa_front_lead', designated: false });
    expect(front.memberCount).toBeGreaterThanOrEqual(2);

    let r = await putDept('front', { parentKey: 'gmo', headStaffId: staff.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    front = (r.body as OrgOverview).departments.find((d) => d.key === 'front')!;
    expect(front.head).toEqual({ id: staff.id, name: 'oa_front_staff', designated: true });

    // 总经办挂到前厅部下面 → 前厅部在总经办下面，绕成环
    r = await putDept('gmo', { parentKey: 'front', headStaffId: null });
    expect(r.status).toBe(422);
    expect((r.body as { error: { code: string } }).error.code).toBe('PARENT_CYCLE');
    r = await putDept('company', { parentKey: 'gmo', headStaffId: null });
    expect((r.body as { error: { code: string } }).error.code).toBe('PARENT_INVALID');
    r = await putDept('eng', { parentKey: null, headStaffId: null });
    expect((r.body as { error: { code: string } }).error.code).toBe('PARENT_INVALID');
    // 拿着旧版本再改：被拒，不覆盖别人刚改的
    const stale = (await deptVersion('front')) - 1;
    r = await putDept('front', { parentKey: 'gmo', headStaffId: null }, stale);
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT');
    // 部门挪到前厅部下面：可以
    r = await putDept('ent', { parentKey: 'front', headStaffId: null });
    expect(r.status).toBe(200);
    const audit = await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'org_department_updated'`;
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('员工档案：带版本改；别人先改过不能覆盖；工号全店唯一、手机号在职员工之间不重复', async () => {
    const a = await hire('oa_prof_a', 'male.staff');
    const b = await hire('oa_prof_b', 'male.staff');
    let r = await api(ctx.app, ctx.owner, 'PUT', `/api/oa/employees/${a.id}/profile`, { empNo: 'E001', phone: '13800000001', hireDate: '2026-01-05', version: 0 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(emp(r.body as OrgOverview, a.id)).toMatchObject({ empNo: 'E001', phone: '13800000001', hireDate: '2026-01-05', status: 'active', version: 1, department: 'male' });
    // 还拿着版本 0 再提交：被拒
    r = await api(ctx.app, ctx.owner, 'PUT', `/api/oa/employees/${a.id}/profile`, { empNo: 'E002', phone: null, hireDate: null, version: 0 });
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT');
    r = await api(ctx.app, ctx.owner, 'PUT', `/api/oa/employees/${b.id}/profile`, { empNo: 'E001', phone: null, hireDate: null, version: 0 });
    expect((r.body as { error: { code: string } }).error.code).toBe('EMP_NO_EXISTS');
    r = await api(ctx.app, ctx.owner, 'PUT', `/api/oa/employees/${b.id}/profile`, { empNo: 'E003', phone: '13800000001', hireDate: null, version: 0 });
    expect((r.body as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
    r = await api(ctx.app, ctx.owner, 'PUT', `/api/oa/employees/${b.id}/profile`, { empNo: 'bad no', phone: null, hireDate: null, version: 0 });
    expect(r.status).toBe(400);
  });

  it('办理离职：账号停用、登录失效、指定主管清掉、历史保留；不能给自己办；复职恢复账号', async () => {
    const leaver = await hire('oa_leaver', 'eng.staff');
    await api(ctx.app, ctx.owner, 'PUT', `/api/oa/employees/${leaver.id}/profile`, { empNo: 'E100', phone: '13900000100', hireDate: '2026-03-01', version: 0 });
    await putDept('eng', { parentKey: 'gmo', headStaffId: leaver.id });
    expect((await api(ctx.app, leaver.cookie, 'GET', '/api/auth/me')).status).toBe(200);

    let r = await api(ctx.app, ctx.owner, 'POST', `/api/oa/employees/${leaver.id}/leave`, { leaveDate: '2026-02-01', version: 1 });
    expect((r.body as { error: { code: string } }).error.code).toBe('LEAVE_BEFORE_HIRE');
    r = await api(ctx.app, ctx.owner, 'POST', `/api/oa/employees/${leaver.id}/leave`, { leaveDate: '2026-11-22', version: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const o = r.body as OrgOverview;
    expect(emp(o, leaver.id)).toMatchObject({ status: 'left', leaveDate: '2026-11-22', active: false, empNo: 'E100' });
    expect(o.departments.find((d) => d.key === 'eng')!.headStaffId).toBeNull();
    expect((await api(ctx.app, leaver.cookie, 'GET', '/api/auth/me')).status).toBe(401);
    const [row] = await ctx.sql`SELECT active FROM staff WHERE id = ${leaver.id}`;
    expect(row!.active).toBe(false);
    // 离职的不能再指定成主管；也不能在「员工账号」里直接启用（要走复职）
    r = await putDept('eng', { parentKey: 'gmo', headStaffId: leaver.id });
    expect((r.body as { error: { code: string } }).error.code).toBe('HEAD_INVALID');
    r = await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${leaver.id}`, { displayName: 'oa_leaver', position: 'eng.staff', active: true });
    expect(r.status).toBe(422);
    expect((r.body as { error: { code: string } }).error.code).toBe('EMPLOYEE_LEFT');

    // 离职员工的手机号可以给新同事用
    const newbie = await hire('oa_newbie', 'eng.staff');
    r = await api(ctx.app, ctx.owner, 'PUT', `/api/oa/employees/${newbie.id}/profile`, { empNo: null, phone: '13900000100', hireDate: null, version: 0 });
    expect(r.status).toBe(200);
    // 复职时手机号已被在职员工用了：拒绝，提示改号
    r = await api(ctx.app, ctx.owner, 'POST', `/api/oa/employees/${leaver.id}/rehire`, { version: 2 });
    expect((r.body as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
    await api(ctx.app, ctx.owner, 'PUT', `/api/oa/employees/${newbie.id}/profile`, { empNo: null, phone: null, hireDate: null, version: 1 });
    r = await api(ctx.app, ctx.owner, 'POST', `/api/oa/employees/${leaver.id}/rehire`, { version: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(emp(r.body as OrgOverview, leaver.id)).toMatchObject({ status: 'active', leaveDate: null, active: true });
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/oa/employees/${leaver.id}/rehire`, { version: 3 })).status).toBe(409);

    const [ownerRow] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'owner'`;
    r = await api(ctx.app, ctx.owner, 'POST', `/api/oa/employees/${ownerRow!.id}/leave`, { leaveDate: '2026-11-22', version: 0 });
    expect((r.body as { error: { code: string } }).error.code).toBe('SELF_LEAVE');
    const actions = await ctx.sql<{ action: string }[]>`SELECT action FROM audit_logs WHERE target_id = ${String(leaver.id)} AND action IN ('employee_left', 'employee_rehired') ORDER BY id`;
    expect(actions.map((a) => a.action)).toEqual(['employee_left', 'employee_rehired']);
  });
});
