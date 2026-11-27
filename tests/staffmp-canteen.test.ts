// 员工小程序的吃饭与巡场（员工小程序线 E，docs/STAFF_MP.md 第 5.4 节，SP10）：员工账号与柚子饭堂账号对上
// （旧饭堂账号密码证明、开通新饭卡、后台按手机号预先对好、解开），对上以后照饭堂与巡场原来的规则：
// 饭卡码的钥匙、菜单、负责人扫码登记（一人一餐一次）、巡场打卡；开关关着、没对上、不是负责人的拦下。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../src/shared/business-date';
import { hashPassword } from '../src/server/auth/password';
import { employeeCodeKey, makeCanteenCode } from '../src/server/modules/canteen/code';
import { createStaff } from '../src/server/modules/staff';
import { buildStaffMpApp } from '../src/server/modules/staffmp';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

const SECRET = 'staffmp-canteen-secret-0123456789abcdef-0123456789';
const TZ = 'Asia/Shanghai';
const today = businessDateOf(new Date(), TZ, 0);
const lunch = Date.parse(`${today}T12:00:00+08:00`);

let ctx: TestContext;
let staffApp: FastifyInstance;

async function s<T = any>(method: 'GET' | 'POST' | 'PUT', url: string, token?: string | null, payload?: unknown) {
  const res = await staffApp.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  return { status: res.statusCode, body: body as T };
}
const admin = <T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => api<T>(ctx.app, ctx.owner, method, url, payload);

/** 一位员工（系统账号）登录员工小程序，返回令牌与系统账号编号 */
async function staffLogin(username: string, displayName: string, phone?: string) {
  const id = await createStaff(ctx.sql, { username, displayName, role: 'clerk', password: PASSWORD, mustChangePassword: false });
  if (phone) await ctx.sql`INSERT INTO staff_profiles (staff_id, phone) VALUES (${id}, ${phone})`;
  const r = await s('POST', '/api/staffmp/auth/login', null, { username, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { id, token: r.body.token as string };
}

/** 饭堂名单里加一位（后台），设好密码（像在柚子饭堂网页上开通过一样） */
async function canteenEmployee(empNo: string, name: string, opts: { role?: 'staff' | 'cook' | 'manager'; departmentId?: number | null; phone?: string; password?: string } = {}) {
  const made = await admin('POST', '/api/erp/canteen/employees', { empNo, name, role: opts.role ?? 'staff', departmentId: opts.departmentId ?? null });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const id = made.body.employee.id as number;
  if (opts.password) await ctx.sql`UPDATE canteen_employees SET password_hash = ${await hashPassword(opts.password)}, activation_code = NULL, activation_expires_at = NULL WHERE id = ${id}`;
  if (opts.phone) await ctx.sql`UPDATE canteen_employees SET phone = ${opts.phone}, username = ${`u${empNo.toLowerCase()}`}, source = 'admin' WHERE id = ${id}`;
  return id;
}

let canteenDept: number;
let security: number;

beforeAll(async () => {
  ctx = await setup();
  const config = { ...ctx.config, canteen: { ...ctx.config.canteen, codeSecret: SECRET } };
  staffApp = await buildStaffMpApp(ctx.sql, config, { code2session: async (c) => `openid-${c}`, openCacheMs: 0, clock: () => lunch });
  canteenDept = Number((await ctx.sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('员工食堂') RETURNING id`)[0]!.id);
  security = Number((await ctx.sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('安保部') RETURNING id`)[0]!.id);
});

afterAll(async () => {
  await staffApp?.close();
  await ctx?.close();
});

describe('员工食堂关着', () => {
  it('不显示吃饭；吃饭的接口回「饭堂还没开张」', async () => {
    const a = await staffLogin('closed1', '关着时的同事');
    expect((await s('GET', '/api/staffmp/canteen/status', a.token)).body).toEqual({ open: false, linked: false, employee: null, currentMeal: null });
    expect((await s('GET', '/api/staffmp/me', a.token)).body.entries).not.toContain('canteen');
    const me = await s('GET', '/api/staffmp/canteen/me', a.token);
    expect([me.status, me.body.error.code]).toEqual([503, 'CANTEEN_CLOSED']);
  });
});

describe('对上饭卡', () => {
  beforeAll(async () => {
    expect((await admin('PUT', '/api/erp/modules', { modules: { canteen: true, patrol: true } })).status).toBe(200);
    const s0 = (await admin('GET', '/api/erp/canteen/overview')).body.settings;
    expect((await admin('PUT', '/api/erp/canteen/settings', { ...s0, departmentId: canteenDept })).status).toBe(200);
  });

  it('没对上时：入口里有吃饭，吃饭的接口回「还没对上饭卡」', async () => {
    const a = await staffLogin('nolink1', '还没对上');
    expect((await s('GET', '/api/staffmp/canteen/status', a.token)).body).toEqual({ open: true, linked: false, employee: null, currentMeal: null });
    expect((await s('GET', '/api/staffmp/me', a.token)).body.entries).toContain('canteen');
    const me = await s('GET', '/api/staffmp/canteen/me', a.token);
    expect([me.status, me.body.error.code]).toEqual([409, 'CANTEEN_NOT_LINKED']);
  });

  it('以前登记过：输一次饭堂的账号密码就对上；密码不对是 422（不当成登录过期）；一张饭卡只对给一个人', async () => {
    const empId = await canteenEmployee('E201', '阿丽', { password: 'Fan-tang-2026' });
    const a = await staffLogin('alice2', '阿丽');
    const wrong = await s('POST', '/api/staffmp/canteen/link', a.token, { account: 'E201', password: 'nope-nope' });
    expect([wrong.status, wrong.body.error.code]).toEqual([422, 'CANTEEN_LOGIN_FAILED']);
    // 令牌照样能用
    expect((await s('GET', '/api/staffmp/me', a.token)).status).toBe(200);
    const ok = await s('POST', '/api/staffmp/canteen/link', a.token, { account: 'E201', password: 'Fan-tang-2026' });
    expect(ok.body).toEqual({ open: true, linked: true, employee: { name: '阿丽', empNo: 'E201', role: 'staff' }, currentMeal: { meal: 'lunch', date: today, checkedIn: false } });
    // 证明的时候不留饭堂的会话
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM canteen_sessions WHERE employee_id = ${empId}`)[0]!.n).toBe(0);
    const me = await s('GET', '/api/staffmp/canteen/me', a.token);
    expect(me.status).toBe(200);
    expect(me.body.codeKey).toBe(employeeCodeKey(SECRET, empId, me.body.codeEpoch).toString('base64url'));
    expect(me.body.employee).toMatchObject({ id: empId, name: '阿丽', role: 'staff' });
    const b = await staffLogin('bob2', '冒名的');
    const taken = await s('POST', '/api/staffmp/canteen/link', b.token, { account: 'E201', password: 'Fan-tang-2026' });
    expect([taken.status, taken.body.error.code]).toEqual([409, 'CANTEEN_TAKEN']);
  });

  it('没登记过：开通一个普通员工的饭卡（工号用人事档案的，没有就 S + 编号）；再开通拒绝', async () => {
    const c = await staffLogin('carol2', '小卡');
    await ctx.sql`UPDATE staff_profiles SET emp_no = 'hr-0099' WHERE staff_id = ${c.id}`;
    await ctx.sql`INSERT INTO staff_profiles (staff_id, emp_no) VALUES (${c.id}, 'hr-0099') ON CONFLICT (staff_id) DO UPDATE SET emp_no = 'hr-0099'`;
    const made = await s('POST', '/api/staffmp/canteen/create', c.token, {});
    expect(made.body).toMatchObject({ open: true, linked: true, employee: { name: '小卡', empNo: 'HR-0099', role: 'staff' } });
    expect((await s('POST', '/api/staffmp/canteen/create', c.token, {})).body.error.code).toBe('CANTEEN_ALREADY_LINKED');
    const d = await staffLogin('dave2', '大卫');
    expect((await s('POST', '/api/staffmp/canteen/create', d.token, {})).body.employee.empNo).toBe(`S${d.id}`);
  });

  it('后台：按手机号给出候选、一键对上、解开', async () => {
    const empId = await canteenEmployee('E301', '小林', { phone: '13900000301' });
    const l = await staffLogin('lin3', '小林', '13900000301');
    const rows = (await admin('GET', '/api/admin/staffmp/canteen-links')).body as any[];
    const row = rows.find((r) => r.staffId === l.id);
    expect(row).toMatchObject({ linked: null, suggestion: { employeeId: empId, name: '小林', empNo: 'E301' } });
    expect((await admin('POST', '/api/admin/staffmp/canteen-links', { pairs: [{ staffId: l.id, employeeId: empId }] })).body).toEqual({ linked: 1, skipped: 0 });
    expect((await s('GET', '/api/staffmp/canteen/status', l.token)).body.linked).toBe(true);
    // 已经对上的再对一次跳过
    expect((await admin('POST', '/api/admin/staffmp/canteen-links', { pairs: [{ staffId: l.id, employeeId: empId }] })).body).toEqual({ linked: 0, skipped: 1 });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/staffmp/canteen-links')).status).toBe(403);
    const epoch = async () => (await ctx.sql<{ e: number }[]>`SELECT code_epoch AS e FROM canteen_employees WHERE id = ${empId}`)[0]!.e;
    const before = await epoch();
    expect((await admin('POST', `/api/admin/staffmp/canteen-links/${l.id}/unlink`)).body).toEqual({ ok: true, unlinked: true });
    expect((await s('GET', '/api/staffmp/canteen/status', l.token)).body.linked).toBe(false);
    // 解开以后这张饭卡的码钥匙作废：对错的手机上存着的离线也亮不出能用的码
    expect(await epoch()).toBe(before + 1);
  });

  it('后台：只有人事权限的只看、只动自己门店范围里的员工，不列总裁', async () => {
    const hrId = await createStaff(ctx.sql, { username: 'hr5', displayName: '人事小钱', role: 'clerk', password: PASSWORD, mustChangePassword: false });
    await ctx.sql`UPDATE staff SET position = 'hr.lead', needs_position = false, position_chosen_at = NULL WHERE id = ${hrId}`;
    const hr = await login(ctx.app, 'hr5');
    const [entity] = await ctx.sql<{ id: number }[]>`SELECT entity_id AS id FROM stores WHERE id = 1`;
    const [store2] = await ctx.sql<{ id: number }[]>`INSERT INTO stores (code, name, entity_id) VALUES ('LH', '罗湖店', ${entity!.id}) RETURNING id`;
    const far = await staffLogin('far5', '罗湖的同事', '13900000505');
    await ctx.sql`INSERT INTO staff_stores (staff_id, store_id) VALUES (${far.id}, ${store2!.id})`;
    const farEmp = await canteenEmployee('E505', '罗湖的同事', { phone: '13900000505' });
    const [owner] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE role = 'owner' ORDER BY id LIMIT 1`;

    const hrRows = (await api(ctx.app, hr, 'GET', '/api/admin/staffmp/canteen-links')).body as any[];
    expect(hrRows.some((r) => r.staffId === far.id)).toBe(false);
    expect(hrRows.some((r) => r.staffId === owner!.id)).toBe(false);
    const allRows = (await admin('GET', '/api/admin/staffmp/canteen-links')).body as any[];
    expect(allRows.find((r) => r.staffId === far.id)).toMatchObject({ suggestion: { employeeId: farEmp } });

    const linkFar = await api(ctx.app, hr, 'POST', '/api/admin/staffmp/canteen-links', { pairs: [{ staffId: far.id, employeeId: farEmp }] });
    expect(linkFar.status).toBe(404);
    expect((await s('GET', '/api/staffmp/canteen/status', far.token)).body.linked).toBe(false);
    // 总裁对上以后，人事也解不开
    expect((await admin('POST', '/api/admin/staffmp/canteen-links', { pairs: [{ staffId: far.id, employeeId: farEmp }] })).body).toEqual({ linked: 1, skipped: 0 });
    expect((await api(ctx.app, hr, 'POST', `/api/admin/staffmp/canteen-links/${far.id}/unlink`)).status).toBe(404);
    expect((await s('GET', '/api/staffmp/canteen/status', far.token)).body.linked).toBe(true);
  });
});

describe('对上以后：菜单、负责人扫码、巡场', () => {
  let boss: { id: number; token: string };
  let eater: { id: number; token: string; empId: number };

  beforeAll(async () => {
    const bossEmp = await canteenEmployee('M001', '食堂负责人', { role: 'manager', departmentId: canteenDept, password: 'Fan-tang-2026' });
    boss = await staffLogin('boss4', '食堂负责人');
    await s('POST', '/api/staffmp/canteen/link', boss.token, { account: 'M001', password: 'Fan-tang-2026' });
    expect(bossEmp).toBeGreaterThan(0);
    const empId = await canteenEmployee('E401', '吃饭的人', { password: 'Fan-tang-2026' });
    const e = await staffLogin('eater4', '吃饭的人');
    await s('POST', '/api/staffmp/canteen/link', e.token, { account: 'E401', password: 'Fan-tang-2026' });
    eater = { ...e, empId };
  });

  it('负责人有「扫码登记」；普通员工没有，也扫不了', async () => {
    expect((await s('GET', '/api/staffmp/me', boss.token)).body.entries).toEqual(expect.arrayContaining(['canteen', 'canteenScan']));
    expect((await s('GET', '/api/staffmp/me', eater.token)).body.entries).not.toContain('canteenScan');
    const no = await s('POST', '/api/staffmp/canteen/checkins', eater.token, { clientKey: randomUUID(), employeeId: eater.empId });
    expect(no.status).toBe(403);
  });

  it('负责人扫员工的饭卡码：记一笔；再扫是「已经打过卡啦」；今天的人数跟着变', async () => {
    const me = (await s('GET', '/api/staffmp/canteen/me', eater.token)).body;
    const code = makeCanteenCode(SECRET, eater.empId, me.codeEpoch, lunch);
    const first = await s('POST', '/api/staffmp/canteen/checkins', boss.token, { clientKey: randomUUID(), code, scannedAt: new Date(lunch).toISOString() });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.status).toBe('ok');
    const again = await s('POST', '/api/staffmp/canteen/checkins', boss.token, { clientKey: randomUUID(), code, scannedAt: new Date(lunch).toISOString() });
    expect(again.body.status).toBe('already');
    // 首页此刻卡：这一餐打过卡了
    expect((await s('GET', '/api/staffmp/canteen/status', eater.token)).body.currentMeal).toEqual({ meal: 'lunch', date: today, checkedIn: true });
    expect((await s('GET', '/api/staffmp/canteen/today', boss.token)).status).toBe(200);
    expect((await s('GET', '/api/staffmp/canteen/people?q=吃饭', boss.token)).body.length).toBeGreaterThan(0);
  });

  it('菜单与点赞照饭堂的', async () => {
    expect((await s('GET', `/api/staffmp/canteen/menus?from=${today}&to=${today}`, eater.token)).status).toBe(200);
  });

  it('巡场部门的人：入口里有巡场，看得到今天、扫得了场所码', async () => {
    const guardEmp = await canteenEmployee('A501', '保安老张', { departmentId: security, password: 'Fan-tang-2026' });
    const g = await staffLogin('guard5', '保安老张');
    await s('POST', '/api/staffmp/canteen/link', g.token, { account: 'A501', password: 'Fan-tang-2026' });
    const set = (await admin('GET', '/api/erp/patrol/settings')).body;
    expect((await admin('PUT', '/api/erp/patrol/settings', { departmentIds: [security], viewerIds: [], rev: set.rev })).status).toBe(200);
    const point = (await admin('POST', '/api/erp/patrol/points', { clientKey: randomUUID(), name: '北门停车场', area: '' })).body.point;
    expect((await s('GET', '/api/staffmp/me', g.token)).body.entries).toContain('patrol');
    expect((await s('GET', '/api/staffmp/me', eater.token)).body.entries).not.toContain('patrol');
    const day = await s('GET', '/api/staffmp/canteen/patrol/day', g.token);
    expect(day.status, JSON.stringify(day.body)).toBe(200);
    const scanned = await s('POST', '/api/staffmp/canteen/patrol/checkins', g.token, { clientKey: randomUUID(), code: point.token, employeeId: guardEmp, scannedAt: new Date(lunch).toISOString() });
    expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
    // 不是巡场部门的扫不了（巡场原来的规则）
    const no = await s('POST', '/api/staffmp/canteen/patrol/checkins', eater.token, { clientKey: randomUUID(), code: point.token, employeeId: eater.empId });
    expect(no.status).toBeGreaterThanOrEqual(400);
  });
});
