// OA-02 账号与批量开通（docs/OA.md 第 5 节）：模板、预览核对、开通（临时密码、岗位、档案、门店）、原样重提、作废、权限。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffImportPreview, StaffImportResult } from '../src/shared/oa';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let hrLead: string;
beforeAll(async () => {
  ctx = await setup();
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username: 'imp_hr_lead', displayName: '人事负责人', position: 'hr.lead', password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = 'imp_hr_lead'`;
  hrLead = await login(ctx.app, 'imp_hr_lead');
});
afterAll(async () => ctx.close());

const HEAD = '姓名,手机号,工号,部门,岗位,入职日期,登录名';
const csv = (...rows: string[]) => [HEAD, ...rows].join('\n');
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

describe('OA-02 账号与批量开通', () => {
  it('权限与模板：人力行政部负责人能下载模板；前台员工不能', async () => {
    const t = await ctx.app.inject({ method: 'GET', url: '/api/oa/employees/import/template', headers: { cookie: hrLead } });
    expect(t.statusCode).toBe(200);
    expect(t.headers['content-type']).toContain('spreadsheetml');
    expect(t.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/oa/employees/import/preview', { fileName: 'a.csv', csv: csv('甲,13811110000,,前厅部,,,') })).status).toBe(403);
  });

  it('预览：逐行写出问题；人力行政部负责人不能开部门负责人', async () => {
    const r = await api(ctx.app, hrLead, 'POST', '/api/oa/employees/import/preview', {
      fileName: '员工.csv',
      csv: csv(
        '张三,13811110001,E101,人力行政部,员工,2026-01-05,',
        '李四,13811110001,E102,不存在部,,,',
        '王五,1381111,E101,总经办,,,',
        '赵六,13811110004,,男宾部,负责人,2026/13/40,',
        ',13811110005,,女宾部,,,owner',
      ),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = r.body as StaffImportPreview;
    expect(p.rows).toHaveLength(5);
    expect(p.rows[0]).toMatchObject({ row: 2, name: '张三', department: 'hr', position: 'hr.staff', username: 'e101', issues: [] });
    expect(p.rows[1]!.issues.join()).toContain('不存在部');
    expect(p.rows[1]!.issues.join()).toContain('手机号与第 2 行重复');
    expect(p.rows[2]!.issues.join()).toContain('手机号要 11 位');
    expect(p.rows[2]!.issues.join()).toContain('总经办');
    expect(p.rows[2]!.issues.join()).toContain('工号与第 2 行重复');
    expect(p.rows[3]!.issues.join()).toContain('总裁开');
    expect(p.rows[3]!.issues.join()).toContain('入职日期');
    expect(p.rows[4]!.issues.join()).toContain('姓名没填');
    expect(p.rows[4]!.issues.join()).toContain('「owner」已经有人用了');
    expect(p.issueCount).toBe(4);
    // 权限比自己多的岗位（财务部员工）：人力行政部负责人开不了，要总裁开
    const fin = await api(ctx.app, hrLead, 'POST', '/api/oa/employees/import/preview', { fileName: 'f.csv', csv: csv('出纳甲,13811110091,,财务部,员工,,', '出纳乙,13811110092,,财务部,员工,,') });
    const finRows = (fin.body as StaffImportPreview).rows;
    expect(finRows.every((x) => x.issues.some((i) => i.includes('您自己没有的权限')))).toBe(true);
    const finApply = await api(ctx.app, hrLead, 'POST', '/api/oa/employees/import', { clientKey: randomUUID(), fileName: 'f.csv', csv: csv('出纳甲,13811110091,,财务部,员工,,') });
    expect(code(finApply)).toBe('IMPORT_INVALID');
    // 有问题的不能开
    const a = await api(ctx.app, hrLead, 'POST', '/api/oa/employees/import', { clientKey: randomUUID(), fileName: '员工.csv', csv: csv('李四,13811110001,E102,不存在部,,,') });
    expect(a.status).toBe(422);
    expect(code(a)).toBe('IMPORT_INVALID');
  });

  it('开通：建账号（临时密码、首次登录要改）、岗位、档案、门店；原样重提不开两遍、不再给密码', async () => {
    const body = { clientKey: randomUUID(), fileName: '十一月新人.csv', csv: csv('孙七,13811110011,E201,人力行政部,,2026-11-01,', '周八,13811110012,,人力行政部,员工,,zhouba') };
    const r = await api(ctx.app, hrLead, 'POST', '/api/oa/employees/import', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const res = r.body as StaffImportResult;
    expect(res.replayed).toBe(false);
    expect(res.accounts.map((a) => [a.username, a.name, a.position])).toEqual([
      ['e201', '孙七', 'hr.staff'],
      ['zhouba', '周八', 'hr.staff'],
    ]);
    const pw = res.accounts[0]!.temporaryPassword!;
    expect(pw).toMatch(/^yuzu-\d{4}-[a-z]{2}$/);
    // 临时密码能登录，登录后要改密码
    const lr = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'e201', password: pw } });
    expect(lr.statusCode, lr.body).toBe(200);
    const [row] = await ctx.sql<{ mustChangePassword: boolean; role: string; empNo: string; phone: string; hireDate: string; stores: number }[]>`
      SELECT s.must_change_password, s.role, p.emp_no, p.phone, p.hire_date::text AS hire_date,
             (SELECT count(*)::int FROM staff_stores x WHERE x.staff_id = s.id) AS stores
      FROM staff s JOIN staff_profiles p ON p.staff_id = s.id WHERE s.username = 'e201'`;
    expect(row).toMatchObject({ mustChangePassword: true, empNo: 'E201', phone: '13811110011', hireDate: '2026-11-01', stores: 1 });

    // 原样重提：同一批，不再开，也不再给密码
    const again = await api(ctx.app, hrLead, 'POST', '/api/oa/employees/import', body);
    expect(again.status).toBe(200);
    const re = again.body as StaffImportResult;
    expect(re.replayed).toBe(true);
    expect(re.import.id).toBe(res.import.id);
    expect(re.accounts.every((a) => a.temporaryPassword === null)).toBe(true);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM staff WHERE username IN ('e201', 'zhouba')`;
    expect(n!.n).toBe(2);
    // 同一编号换了内容：拒绝
    const other = await api(ctx.app, hrLead, 'POST', '/api/oa/employees/import', { ...body, csv: csv('吴九,13811110013,,人力行政部,,,') });
    expect(code(other)).toBe('IDEMPOTENCY_CONFLICT');
    // 查回
    const look = await api(ctx.app, hrLead, 'GET', `/api/erp/ops/${body.clientKey}?type=oa_staff_import`);
    expect(look.body).toMatchObject({ found: true, refId: res.import.id });
    const audit = await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'oa_staff_imported' AND target_id = ${String(res.import.id)}`;
    expect(audit).toHaveLength(1);
    // 再导一次同样的人：手机号、工号、登录名都被占了
    const dup = await api(ctx.app, hrLead, 'POST', '/api/oa/employees/import/preview', { fileName: 'x.csv', csv: csv('孙七,13811110011,E201,人力行政部,,,') });
    expect((dup.body as StaffImportPreview).rows[0]!.issues).toHaveLength(3);
  });

  it('确认作废以后，原请求晚到也不开；总裁能开部门负责人与各部门员工', async () => {
    const key = randomUUID();
    const ab = await api(ctx.app, hrLead, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'oa_staff_import', summary: '批量开通' });
    expect(ab.status, JSON.stringify(ab.body)).toBe(200);
    const late = await api(ctx.app, hrLead, 'POST', '/api/oa/employees/import', { clientKey: key, fileName: 'late.csv', csv: csv('郑十,13811110021,,人力行政部,,,') });
    expect(code(late)).toBe('OP_ABANDONED');
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM staff_profiles WHERE phone = '13811110021'`;
    expect(n!.n).toBe(0);

    const boss = await api(ctx.app, ctx.owner, 'POST', '/api/oa/employees/import', {
      clientKey: randomUUID(),
      fileName: 'lead.csv',
      csv: csv('钱主管,13811110031,L01,工程部,负责人,,', '出纳丙,13811110032,,财务部,员工,,'),
    });
    expect(boss.status, JSON.stringify(boss.body)).toBe(201);
    expect((boss.body as StaffImportResult).accounts.map((a) => [a.username, a.position])).toEqual([
      ['l01', 'eng.lead'],
      ['u13811110032', 'finance.staff'],
    ]);
  });
});
