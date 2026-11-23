// OA-17 工资条模板与制表（docs/OA.md 第 20 节，OA21）：
// 权限只给总裁与核实过的人力行政部负责人；模板字段可配（编号不变、去重、版本）；工资表按「这个月在职过」建名单、同月同标题去重；
// 在线编辑、补人、移出；Excel 预览逐行核对、有错整份不导、导入整张替换；原件加密存库、只能用当前密钥解；看、下载都记薪资审计，操作记录不带金额；
// 作废、发放后不能再改。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PayrollBatchDetail, PayrollBatchSummary, PayrollImportPreview, PayrollImportResult, PayslipTemplate } from '../src/shared/oa-payroll';
import { loadPayrollFileKey } from '../src/server/config';
import { buildWorkbook } from '../src/server/lib/xlsx';
import { readXlsx } from '../src/server/lib/xlsx-read';
import { payrollKeyOf } from '../src/server/modules/oa/payroll';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
type Emp = { id: number; cookie: string; name: string };
const emp: Record<string, Emp> = {};
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const MONTH = '2026-11';

const hire = async (username: string, position: string, profile?: { empNo?: string; hire?: string; left?: string }): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: `员工${username}`, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = (r.body as { id: number }).id;
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE id = ${id}`;
  if (profile) {
    await ctx.sql`
      INSERT INTO staff_profiles (staff_id, emp_no, hire_date, leave_date, status)
      VALUES (${id}, ${profile.empNo ?? null}, ${profile.hire ?? null}, ${profile.left ?? null}, ${profile.left ? 'left' : 'active'})
      ON CONFLICT (staff_id) DO UPDATE SET emp_no = EXCLUDED.emp_no, hire_date = EXCLUDED.hire_date, leave_date = EXCLUDED.leave_date, status = EXCLUDED.status`;
  }
  const cookie = profile?.left ? '' : await login(ctx.app, username);
  if (profile?.left) await ctx.sql`UPDATE staff SET active = false WHERE id = ${id}`;
  return { id, cookie, name: `员工${username}` };
};

const hr = () => emp.hr!.cookie;
const xlsx = (rows: (string | number | null)[][]) => buildWorkbook([{ name: '工资表', widths: [], rows: rows.map((cells) => ({ cells })) }]).toString('base64');
let std: PayslipTemplate;
const header = () => ['工号', '姓名', '部门', ...std.fields.map((f) => f.label)];

beforeAll(async () => {
  ctx = await setup();
  emp.hr = await hire('py_hr', 'hr.lead');
  emp.staff = await hire('py_staff', 'front.staff');
  emp.gmo = await hire('py_gmo', 'gmo');
  emp.a = await hire('py_a', 'front.staff', { empNo: 'E001' });
  emp.b = await hire('py_b', 'eng.staff', { empNo: 'E002' });
  emp.c = await hire('py_c', 'eng.staff');
  // 这个月中途离职的在名单里；上个月就离职的、下个月才入职的不在
  emp.leftIn = await hire('py_leftin', 'front.staff', { empNo: 'E003', hire: '2026-01-01', left: '2026-11-10' });
  emp.leftBefore = await hire('py_leftbefore', 'front.staff', { empNo: 'E004', hire: '2026-01-01', left: '2026-10-20' });
  emp.future = await hire('py_future', 'front.staff', { empNo: 'E005', hire: '2026-12-01' });
  await createStaff(ctx.sql, { username: 'py_tablet', displayName: '点餐平板', role: 'tablet', password: PASSWORD, mustChangePassword: false });
  const tr = await api<PayslipTemplate[]>(ctx.app, hr(), 'GET', '/api/oa/payroll/templates');
  expect(tr.status, JSON.stringify(tr.body)).toBe(200);
  std = tr.body.find((t) => t.name === '标准工资条')!;
});
afterAll(async () => {
  await ctx.close();
});

describe('OA-17 工资条：权限与模板', () => {
  it('总裁、人力行政部负责人能进；部门员工、总经办不能；自己选成人力负责人、后台没核实的不能', async () => {
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/oa/payroll/batches')).status).toBe(200);
    expect((await api(ctx.app, hr(), 'GET', '/api/oa/payroll/batches')).status).toBe(200);
    for (const who of [emp.staff!, emp.gmo!]) expect((await api(ctx.app, who.cookie, 'GET', '/api/oa/payroll/templates')).status).toBe(403);
    await ctx.sql`UPDATE staff SET position_chosen_at = now() WHERE id = ${emp.hr!.id}`;
    expect((await api(ctx.app, hr(), 'GET', '/api/oa/payroll/batches')).status).toBe(403);
    await ctx.sql`UPDATE staff SET position_chosen_at = NULL WHERE id = ${emp.hr!.id}`;
    expect((await api(ctx.app, hr(), 'GET', '/api/oa/payroll/batches')).status).toBe(200);
  });

  it('迁移带「标准工资条」：十个金额字段，实发合计标「实发」', () => {
    expect(std.fields.map((f) => f.label)).toEqual(['基本工资', '岗位津贴', '绩效工资', '加班费', '社保扣款', '公积金扣款', '个税', '其他扣款', '应发合计', '实发合计']);
    expect(std.fields.every((f) => f.kind === 'money')).toBe(true);
    expect(std.fields.filter((f) => f.net).map((f) => f.label)).toEqual(['实发合计']);
  });

  it('新建模板：字段自动编号、名称不能重复、「实发」只能一项且是金额；原样重提不另建', async () => {
    const body = {
      name: '计时工资条',
      fields: [
        { label: '工时', kind: 'number' },
        { label: '时薪', kind: 'money' },
        { label: '实发', kind: 'money', net: true },
        { label: '备注', kind: 'text' },
      ],
    };
    const r = await api<PayslipTemplate>(ctx.app, hr(), 'POST', '/api/oa/payroll/templates', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.fields.map((f) => f.key)).toEqual(['f1', 'f2', 'f3', 'f4']);
    const again = await api<PayslipTemplate>(ctx.app, hr(), 'POST', '/api/oa/payroll/templates', body);
    expect([again.status, again.body.id]).toEqual([200, r.body.id]);
    // 同名但字段不同：在用的模板名不能重复
    expect(code(await api(ctx.app, hr(), 'POST', '/api/oa/payroll/templates', { ...body, fields: body.fields.slice(0, 2) }))).toBe('TEMPLATE_NAME_EXISTS');
    for (const bad of [
      {
        name: 'x',
        fields: [
          { label: '工资', kind: 'money' },
          { label: '工资', kind: 'money' },
        ],
      },
      { name: 'x', fields: [{ label: '备注', kind: 'text', net: true }] },
      {
        name: 'x',
        fields: [
          { label: '甲', kind: 'money', net: true },
          { label: '乙', kind: 'money', net: true },
        ],
      },
      { name: 'x', fields: [{ label: '姓名', kind: 'text' }] },
    ])
      expect((await api(ctx.app, hr(), 'POST', '/api/oa/payroll/templates', bad)).status).toBe(400);
  });

  it('改模板：已有字段的编号不变、新字段接着编；带版本，别人先改过的不能覆盖，原样重提算成功', async () => {
    const t = ((await api<PayslipTemplate[]>(ctx.app, hr(), 'GET', '/api/oa/payroll/templates')).body as PayslipTemplate[]).find((x) => x.name === '计时工资条')!;
    const fields = [{ ...t.fields[2]! }, { label: '餐补', kind: 'money' as const }, ...t.fields.slice(0, 2)];
    const r = await api<PayslipTemplate>(ctx.app, hr(), 'PUT', `/api/oa/payroll/templates/${t.id}`, { name: t.name, fields, active: true, version: t.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.fields.map((f) => `${f.key}:${f.label}`)).toEqual(['f3:实发', 'f5:餐补', 'f1:工时', 'f2:时薪']);
    expect(r.body.version).toBe(t.version + 1);
    const replay = await api(ctx.app, hr(), 'PUT', `/api/oa/payroll/templates/${t.id}`, { name: t.name, fields: r.body.fields, active: true, version: t.version });
    expect(replay.status).toBe(200);
    const stale = await api(ctx.app, hr(), 'PUT', `/api/oa/payroll/templates/${t.id}`, { name: '改名', fields: r.body.fields, active: true, version: t.version });
    expect(code(stale)).toBe('VERSION_CONFLICT');
    const off = await api<PayslipTemplate>(ctx.app, hr(), 'PUT', `/api/oa/payroll/templates/${t.id}`, { name: t.name, fields: r.body.fields, active: false, version: r.body.version });
    expect(off.body.active).toBe(false);
    expect(code(await api(ctx.app, hr(), 'POST', '/api/oa/payroll/batches', { month: MONTH, title: '计时', templateId: t.id }))).toBe('TEMPLATE_INACTIVE');
  });
});

describe('OA-17 工资条：工资表与制表', () => {
  let batch: PayrollBatchSummary;
  const detail = async () => (await api<PayrollBatchDetail>(ctx.app, hr(), 'GET', `/api/oa/payroll/batches/${batch.id}`)).body;

  it('新建工资表：按这个月在职过的人每人一行（中途离职的在，之前离职的、之后入职的、专用账号不在）；同月同标题直接打开那张', async () => {
    const r = await api<PayrollBatchSummary>(ctx.app, hr(), 'POST', '/api/oa/payroll/batches', { month: MONTH, title: '11 月工资', templateId: std.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    batch = r.body;
    const d = await detail();
    const ids = d.slips.map((s) => s.staffId);
    for (const k of ['hr', 'staff', 'a', 'b', 'c', 'leftIn']) expect(ids, k).toContain(emp[k]!.id);
    for (const k of ['leftBefore', 'future']) expect(ids, k).not.toContain(emp[k]!.id);
    expect(d.slips.map((s) => s.name)).not.toContain('点餐平板');
    expect(d.missing).toEqual([]);
    expect(d.fields).toEqual(std.fields);
    expect(d.canUpload).toBe(true);
    const again = await api<PayrollBatchSummary>(ctx.app, hr(), 'POST', '/api/oa/payroll/batches', { month: MONTH, title: '11 月工资', templateId: std.id });
    expect([again.status, again.body.id]).toEqual([200, batch.id]);
    const other = ((await api<PayslipTemplate[]>(ctx.app, hr(), 'GET', '/api/oa/payroll/templates')).body as PayslipTemplate[]).find((t) => t.name === '计时工资条')!;
    await ctx.sql`UPDATE oa_payslip_templates SET active = true WHERE id = ${other.id}`;
    expect(code(await api(ctx.app, hr(), 'POST', '/api/oa/payroll/batches', { month: MONTH, title: '11 月工资', templateId: other.id }))).toBe('PAYROLL_TITLE_EXISTS');
  });

  it('在线编辑：金额按分存、写错的拦下；移出、从名单里补回来；不在名单里的补不进来；操作记录不带金额', async () => {
    const put = (staffId: number, values: object) => api(ctx.app, hr(), 'PUT', `/api/oa/payroll/batches/${batch.id}/slips/${staffId}`, { values });
    expect((await put(emp.a!.id, { f1: 500000, f10: 456789, zz: 1 })).status).toBe(200);
    expect((await put(emp.a!.id, { f1: 500000, f10: 456789 })).status).toBe(200);
    expect(code(await put(emp.a!.id, { f1: 12.5 }))).toBe('PAYSLIP_INVALID');
    expect(code(await put(emp.a!.id, { f1: 'abc' }))).toBe('PAYSLIP_INVALID');
    let d = await detail();
    expect(d.slips.find((s) => s.staffId === emp.a!.id)!.values).toEqual({ f1: 500000, f10: 456789 });
    expect(d.filledCount).toBe(1);

    expect((await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/slips/${emp.c!.id}/remove`)).status).toBe(200);
    expect((await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/slips/${emp.c!.id}/remove`)).status).toBe(200);
    d = await detail();
    expect(d.missing.map((p) => p.staffId)).toEqual([emp.c!.id]);
    expect((await put(emp.c!.id, { f1: '3000.5' })).status).toBe(200);
    d = await detail();
    expect(d.slips.find((s) => s.staffId === emp.c!.id)!.values).toEqual({ f1: 300050 });
    expect(code(await put(emp.leftBefore!.id, {}))).toBe('NOT_ON_ROSTER');

    const logs = await ctx.sql<{ detail: object }[]>`SELECT detail FROM audit_logs WHERE action LIKE 'oa_payroll%'`;
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toMatch(/500000|456789|300050/);
  });

  it('下载表格：工号、姓名、部门 + 模板各列，已经填的金额带上（元）；记薪资审计', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/oa/payroll/batches/${batch.id}/sheet.xlsx`, headers: { cookie: hr() } });
    expect(res.statusCode).toBe(200);
    const sheet = readXlsx(res.rawPayload).sheets[0]!;
    const text = (r: number) => {
      const line = sheet.rows.get(r);
      return line ? Array.from({ length: Math.max(...line.keys()) + 1 }, (_, c) => line.get(c)?.value ?? '') : [];
    };
    expect(text(1)).toEqual([`2026 年 11 月 · 11 月工资`]);
    expect(text(2)).toEqual(header());
    const rowA = [...sheet.rows.keys()].map(text).find((cells) => cells[1] === emp.a!.name)!;
    expect(rowA[0]).toBe('E001');
    expect(rowA[3]).toBe('5000');
    expect(rowA[12]).toBe('4567.89');
    expect((await ctx.sql`SELECT 1 FROM oa_payroll_audit WHERE action = 'export_sheet' AND batch_id = ${batch.id} AND staff_id = ${emp.hr!.id}`).length).toBe(1);
    expect((await ctx.sql`SELECT 1 FROM oa_payroll_audit WHERE action = 'view_batch' AND batch_id = ${batch.id}`).length).toBeGreaterThan(0);
  });

  it('导入预览：按工号对人（没工号按姓名），逐行写问题；名单里有、表里没有的另列', async () => {
    const amounts = (n: number) => std.fields.map((_, i) => (i === 9 ? n : 100 + i));
    const rows = [
      ['标题'],
      header(),
      ['E001', emp.a!.name, '前厅部', ...amounts(8000)],
      ['', emp.c!.name, '', ...amounts(7000)],
      ['E002', '别人', '', ...amounts(1)],
      ['E999', '谁', '', ...amounts(1)],
      ['', emp.a!.name, '', ...amounts(1)],
      ['E004', emp.leftBefore!.name, '', ...amounts(1)],
      ['E003', emp.leftIn!.name, '', '12.345', ...amounts(1).slice(1)],
    ];
    const r = await api<PayrollImportPreview>(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/import/preview`, { fileName: '11月.xlsx', xlsxBase64: xlsx(rows) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const issues = r.body.rows.map((x) => x.issues.join('；'));
    expect(issues[0]).toBe('');
    expect(issues[1]).toBe('');
    expect(issues[2]).toContain('工号「E002」是「员工py_b」');
    expect(issues[3]).toContain('对不上员工');
    expect(issues[4]).toContain('与第 3 行是同一个人');
    expect(issues[5]).toContain('不在这个月的在职名单里');
    expect(issues[6]).toContain('最多两位小数');
    expect([r.body.okCount, r.body.errorCount]).toEqual([2, 5]);
    expect(r.body.missing.map((p) => p.staffId)).toContain(emp.hr!.id);
    // 有错的整份不导
    const bad = await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/import`, { fileName: '11月.xlsx', xlsxBase64: xlsx(rows) });
    expect(code(bad)).toBe('IMPORT_HAS_ERRORS');
    expect((await ctx.sql`SELECT 1 FROM oa_payroll_files`).length).toBe(0);
    // 表头不对
    const noCol = await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/import/preview`, {
      fileName: 'x.xlsx',
      xlsxBase64: xlsx([
        ['工号', '姓名'],
        ['E001', emp.a!.name],
      ]),
    });
    expect(code(noCol)).toBe('IMPORT_FILE_INVALID');
  });

  let original: string;
  it('导入：整张替换草稿；原件加密存库（库里看不到明文），下载解出来与上传的一样，记审计；同一份文件再传不重复存原件', async () => {
    const amounts = (n: number) => std.fields.map((_, i) => (i === 9 ? n : i === 0 ? '6000.00' : null));
    original = xlsx([['11 月工资'], header(), ['E001', emp.a!.name, '', ...amounts(8000.5)], ['E002', emp.b!.name, '', ...amounts(9000)]]);
    const r = await api<PayrollImportResult>(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/import`, { fileName: '11月工资.xlsx', xlsxBase64: original });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.slipCount).toBe(2);
    const d = await detail();
    expect(d.slips.map((s) => [s.staffId, s.values])).toEqual(
      expect.arrayContaining([
        [emp.a!.id, { f1: 600000, f10: 800050 }],
        [emp.b!.id, { f1: 600000, f10: 900000 }],
      ]),
    );
    expect(d.slips).toHaveLength(2);
    expect(d.missing.map((p) => p.staffId)).toEqual(expect.arrayContaining([emp.c!.id, emp.hr!.id]));
    expect(d.files).toHaveLength(1);
    expect(d.files[0]!.readable).toBe(true);

    const [f] = await ctx.sql<{ ciphertext: Buffer }[]>`SELECT ciphertext FROM oa_payroll_files WHERE id = ${r.body.fileId}`;
    const plain = Buffer.from(original, 'base64');
    expect(f!.ciphertext.equals(plain)).toBe(false);
    expect(f!.ciphertext.subarray(0, 2).toString()).not.toBe('PK');
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/oa/payroll/batches/${batch.id}/files/${r.body.fileId}`, headers: { cookie: hr() } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(plain)).toBe(true);
    expect((await ctx.sql`SELECT 1 FROM oa_payroll_audit WHERE action = 'download_file' AND file_id = ${r.body.fileId}`).length).toBe(1);
    // 员工下载不了
    expect((await ctx.app.inject({ method: 'GET', url: `/api/oa/payroll/batches/${batch.id}/files/${r.body.fileId}`, headers: { cookie: emp.a!.cookie } })).statusCode).toBe(403);

    const again = await api<PayrollImportResult>(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/import`, { fileName: '11月工资.xlsx', xlsxBase64: original });
    expect(again.body.fileId).toBe(r.body.fileId);
    expect((await ctx.sql`SELECT 1 FROM oa_payroll_files WHERE batch_id = ${batch.id}`).length).toBe(1);
  });

  it('换了密钥：旧原件标「解不开」，下载明说；正式环境没配密钥不能上传；密钥太短起不来', async () => {
    await ctx.sql`UPDATE oa_payroll_files SET key_id = '0000000000000000' WHERE batch_id = ${batch.id}`;
    const d = await detail();
    expect(d.files[0]!.readable).toBe(false);
    const dl = await api(ctx.app, hr(), 'GET', `/api/oa/payroll/batches/${batch.id}/files/${d.files[0]!.id}`);
    expect(code(dl)).toBe('PAYROLL_KEY_CHANGED');
    expect(payrollKeyOf({ env: 'production', payrollFileKey: null })).toBeNull();
    expect(payrollKeyOf({ env: 'trial', payrollFileKey: null })).toBeNull();
    expect(payrollKeyOf({ env: 'production', payrollFileKey: 'k'.repeat(64) })!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(payrollKeyOf({ env: 'production', payrollFileKey: 'k'.repeat(64) })!.id).not.toBe(payrollKeyOf({ env: 'test', payrollFileKey: null })!.id);
    expect(() => loadPayrollFileKey({ PAYROLL_FILE_KEY: 'short' })).toThrow(/至少 32/);
    expect(loadPayrollFileKey({})).toBeNull();
  });

  it('发放以后（OA-18）不能再改；作废草稿以后不能再改、列表里不显示，同标题可以重建', async () => {
    await ctx.sql`UPDATE oa_payroll_batches SET status = 'published' WHERE id = ${batch.id}`;
    expect(code(await api(ctx.app, hr(), 'PUT', `/api/oa/payroll/batches/${batch.id}/slips/${emp.a!.id}`, { values: {} }))).toBe('PAYROLL_PUBLISHED');
    expect(code(await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/void`))).toBe('PAYROLL_PUBLISHED');
    await ctx.sql`UPDATE oa_payroll_batches SET status = 'draft' WHERE id = ${batch.id}`;

    expect((await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/void`)).status).toBe(200);
    expect((await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/void`)).status).toBe(200);
    expect(code(await api(ctx.app, hr(), 'PUT', `/api/oa/payroll/batches/${batch.id}/slips/${emp.a!.id}`, { values: {} }))).toBe('PAYROLL_VOID');
    expect(code(await api(ctx.app, hr(), 'POST', `/api/oa/payroll/batches/${batch.id}/import`, { fileName: 'a.xlsx', xlsxBase64: original }))).toBe('PAYROLL_VOID');
    const list = (await api<PayrollBatchSummary[]>(ctx.app, hr(), 'GET', '/api/oa/payroll/batches')).body;
    expect(list.map((b) => b.id)).not.toContain(batch.id);
    const fresh = await api<PayrollBatchSummary>(ctx.app, hr(), 'POST', '/api/oa/payroll/batches', { month: MONTH, title: '11 月工资', templateId: std.id });
    expect(fresh.status).toBe(201);
    expect(fresh.body.id).not.toBe(batch.id);
  });

  it('员工调不到任何工资表接口', async () => {
    for (const [m, url] of [
      ['GET', '/api/oa/payroll/batches'],
      ['GET', `/api/oa/payroll/batches/${batch.id}`],
      ['GET', `/api/oa/payroll/batches/${batch.id}/sheet.xlsx`],
      ['POST', '/api/oa/payroll/batches'],
      ['PUT', `/api/oa/payroll/batches/${batch.id}/slips/${emp.a!.id}`],
    ] as const)
      expect((await api(ctx.app, emp.a!.cookie, m, url, m === 'GET' ? undefined : {})).status, url).toBe(403);
  });
});
