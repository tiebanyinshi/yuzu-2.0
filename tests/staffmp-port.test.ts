// 员工小程序端口（员工小程序线，docs/STAFF_MP.md 第 5、6 节）：端口的边界与白名单、账号密码与微信登录、
// 换绑要员工明确确认（SP05）、退出与解绑、改密码、停用与专用账号、开关（SP12）、后台的绑定名单与解开。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffMpPath } from '../src/shared/staffmp';
import { buildStaffMpApp } from '../src/server/modules/staffmp';
import { issueSession } from '../src/server/modules/staffmp/auth';
import { STAFFMP_ALLOWLIST, rewriteStaffMpUrl } from '../src/server/modules/staffmp/allowlist';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let staffApp: FastifyInstance;

/** 模拟微信：code「wx-<名字>」换出 openid「openid-<名字>」 */
const code2session = async (code: string) => {
  const m = /^wx-([a-z0-9]+)$/.exec(code);
  if (!m) throw new Error('bad code');
  return `openid-${m[1]}`;
};

async function s<T = any>(method: 'GET' | 'POST' | 'PUT', url: string, token?: string | null, payload?: unknown) {
  const res = await staffApp.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  return { status: res.statusCode, body: body as T };
}

const admin = <T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => api<T>(ctx.app, ctx.owner, method, url, payload);

async function hire(username: string, displayName: string, opts: { role?: string; mustChangePassword?: boolean } = {}) {
  const id = await createStaff(ctx.sql, { username, displayName, role: (opts.role ?? 'clerk') as never, password: PASSWORD, mustChangePassword: opts.mustChangePassword ?? false });
  return id;
}

const pwLogin = (username: string, extra: Record<string, unknown> = {}) => s('POST', '/api/staffmp/auth/login', null, { username, password: PASSWORD, ...extra });

beforeAll(async () => {
  ctx = await setup();
  staffApp = await buildStaffMpApp(ctx.sql, ctx.config, { code2session, openCacheMs: 0 });
});

afterAll(async () => {
  await staffApp?.close();
  await ctx?.close();
});

describe('端口的边界与白名单', () => {
  it('info 不用登录：版本、实例标识、开没开', async () => {
    const r = await s('GET', '/api/staffmp/info');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ open: true, version: ctx.config.version, instance: ctx.config.instance });
  });

  it('白名单里的每一条都对得上真实的路由，没有管理接口', () => {
    for (const entry of STAFFMP_ALLOWLIST) {
      const [method, url] = entry.split(' ') as ['GET' | 'POST', string];
      expect(staffApp.hasRoute({ method, url }), entry).toBe(true);
      expect(url, entry).not.toMatch(/^\/api\/(admin|erp)\//);
      expect(url, entry).not.toMatch(/payroll\/|employees|grants|setup|templates\/|\/all\b|board/);
    }
  });

  it('直接用里面的地址、白名单外的管理接口、网页的登录一律 404', async () => {
    const { body } = await pwLogin('clerk');
    const token = body.token as string;
    for (const url of [
      '/api/oa/attendance/today',
      '/api/training/folders',
      '/api/auth/login',
      '/api/staffmp/oa/attendance/punches',
      '/api/staffmp/oa/payroll/batches',
      '/api/staffmp/oa/attendance/schedule',
      '/api/staffmp/nope',
    ]) {
      const r = await s('GET', url, token);
      expect([url, r.status, r.body.error?.code]).toEqual([url, 404, 'NOT_FOUND']);
    }
    const r = await s('POST', '/api/staffmp/account/login', null, { username: 'clerk', password: PASSWORD });
    expect(r.status).toBe(404);
  });

  it('改写地址：前缀换成里面的地址，编码过的同样认；附件等回来的地址换回外面的', async () => {
    expect(rewriteStaffMpUrl('/api/staffmp/oa/approvals/12?x=1')).toBe('/api/oa/approvals/12?x=1');
    expect(rewriteStaffMpUrl('/api/staffmp/%6fa/attendance/today')).toBe('/api/oa/attendance/today');
    expect(rewriteStaffMpUrl('/api/staffmp/account/position')).toBe('/api/auth/position');
    expect(rewriteStaffMpUrl('/api/oa/attendance/today')).toBe('/api/staffmp/_not_found');
    expect(rewriteStaffMpUrl('/%61pi/oa/attendance/today')).toBe('/api/staffmp/_not_found');
    expect(staffMpPath('/api/oa/attachments/3/thumb')).toBe('/api/staffmp/oa/attachments/3/thumb');
    const { body } = await pwLogin('clerk');
    const r = await s('GET', '/api/staffmp/%6fa/attendance/today', body.token);
    expect(r.status).toBe(200);
  });
});

describe('账号密码登录', () => {
  it('密码不对 401；对了发令牌，令牌能用自己的接口和挂上来的接口', async () => {
    expect((await s('POST', '/api/staffmp/auth/login', null, { username: 'clerk', password: 'wrong-pass' })).status).toBe(401);
    const r = await pwLogin('clerk');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bound: false, bindError: null });
    expect(r.body.me.staff.displayName).toBe('测试店员');
    expect(r.body.me.entries).toContain('knowledge');
    const me = await s('GET', '/api/staffmp/me', r.body.token);
    expect(me.status).toBe(200);
    expect((await s('GET', '/api/staffmp/oa/attendance/today', r.body.token)).status).toBe(200);
    expect((await s('GET', '/api/staffmp/training/folders', r.body.token)).status).toBe(200);
  });

  it('不带令牌、网页的会话令牌在员工小程序端口上都不认', async () => {
    expect((await s('GET', '/api/staffmp/me')).status).toBe(401);
    const webToken = ctx.clerk.replace(/^yuzu_sid=/, '').split(';')[0]!;
    expect((await s('GET', '/api/staffmp/me', webToken)).status).toBe(401);
    expect((await s('GET', '/api/staffmp/oa/attendance/today', webToken)).status).toBe(401);
  });

  it('专用账号（设计师）登录不了', async () => {
    await hire('designer1', '设计师小王', { role: 'designer' });
    const r = await pwLogin('designer1');
    expect([r.status, r.body.error.code]).toEqual([403, 'NOT_EMPLOYEE']);
  });

  it('人事档案办了离职的登录不了，已登录的马上进不来', async () => {
    const id = await hire('leaver1', '要走的同事');
    const r = await pwLogin('leaver1');
    expect(r.status).toBe(200);
    await ctx.sql`INSERT INTO staff_profiles (staff_id, status, leave_date) VALUES (${id}, 'left', CURRENT_DATE)`;
    expect((await s('GET', '/api/staffmp/me', r.body.token)).status).toBe(401);
    expect((await pwLogin('leaver1')).body.error.code).toBe('NOT_EMPLOYEE');
  });

  it('停用以后令牌马上失效', async () => {
    const id = await hire('stop1', '停用的同事');
    const r = await pwLogin('stop1');
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${id}`;
    expect((await s('GET', '/api/staffmp/me', r.body.token)).status).toBe(401);
  });

  it('第一次要改密码的：别的接口拦下，改完能用；别处的登录退出，这台留着', async () => {
    await hire('newbie1', '新同事', { mustChangePassword: true });
    const web = await login(ctx.app, 'newbie1');
    const r = await pwLogin('newbie1');
    expect(r.body.me.mustChangePassword).toBe(true);
    const blocked = await s('GET', '/api/staffmp/oa/attendance/today', r.body.token);
    expect([blocked.status, blocked.body.error.code]).toEqual([403, 'PASSWORD_CHANGE_REQUIRED']);
    const weak = await s('POST', '/api/staffmp/auth/password', r.body.token, { currentPassword: PASSWORD, newPassword: '1' });
    expect(weak.status).toBe(400);
    const done = await s('POST', '/api/staffmp/auth/password', r.body.token, { currentPassword: PASSWORD, newPassword: 'Tangqi-2026-new' });
    expect(done.status).toBe(200);
    expect(done.body.mustChangePassword).toBe(false);
    expect((await s('GET', '/api/staffmp/oa/attendance/today', r.body.token)).status).toBe(200);
    expect((await api(ctx.app, web, 'GET', '/api/auth/me')).status).toBe(401);
  });

  it('老账号要选新岗位：在小程序里就能看能选的岗位', async () => {
    const id = await hire('oldtimer1', '老同事');
    await ctx.sql`UPDATE staff SET needs_position = true WHERE id = ${id}`;
    const r = await pwLogin('oldtimer1');
    expect(r.body.me.needsPosition).toBe(true);
    const opts = await s('GET', '/api/staffmp/account/position-options', r.body.token);
    expect(opts.status).toBe(200);
    expect(opts.body.needsPosition).toBe(true);
  });
});

describe('微信一键进与绑定（SP05）', () => {
  it('没绑过的微信回 unbound；登录时顺带绑上，之后一键进', async () => {
    await hire('alice', '阿丽');
    expect((await s('POST', '/api/staffmp/auth/wechat', null, { code: 'wx-phonea' })).body).toEqual({ status: 'unbound' });
    const r = await pwLogin('alice', { code: 'wx-phonea' });
    expect(r.body).toMatchObject({ bound: true, bindError: null });
    expect(r.body.me.wechatBound).toBe(true);
    const w = await s('POST', '/api/staffmp/auth/wechat', null, { code: 'wx-phonea' });
    expect(w.body.status).toBe('ok');
    expect(w.body.me.staff.displayName).toBe('阿丽');
    expect((await s('GET', '/api/staffmp/me', w.body.token)).status).toBe(200);
    expect((await s('POST', '/api/staffmp/auth/wechat', null, { code: 'wx-phonea', mode: 'peek' })).body).toEqual({ status: 'bound', displayName: '阿丽' });
  });

  it('在同事的手机上登录：没确认改绑就不顶掉同事的绑定，只登录这一次', async () => {
    const bobId = await hire('bob', '阿波');
    const r = await pwLogin('bob', { code: 'wx-phonea' });
    expect(r.status).toBe(200);
    expect(r.body.bound).toBe(false);
    expect(r.body.bindError).toContain('阿丽');
    // 阿丽的手机照样是阿丽
    expect((await s('POST', '/api/staffmp/auth/wechat', null, { code: 'wx-phonea' })).body.me.staff.displayName).toBe('阿丽');
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM staffmp_bindings WHERE staff_id = ${bobId}`;
    expect(n!.n).toBe(0);
  });

  it('确认改绑：顶掉原来的，原来那位在小程序上的会话退出、收到通知', async () => {
    const alice = await s('POST', '/api/staffmp/auth/wechat', null, { code: 'wx-phonea' });
    const aliceToken = alice.body.token as string;
    const aliceId = alice.body.me.staff.id as number;
    const r = await pwLogin('bob', { code: 'wx-phonea', replace: true });
    expect(r.body.bound).toBe(true);
    expect((await s('POST', '/api/staffmp/auth/wechat', null, { code: 'wx-phonea' })).body.me.staff.displayName).toBe('阿波');
    expect((await s('GET', '/api/staffmp/me', aliceToken)).status).toBe(401);
    const [b] = await ctx.sql<{ revokeReason: string }[]>`SELECT revoke_reason FROM staffmp_bindings WHERE staff_id = ${aliceId} ORDER BY id DESC LIMIT 1`;
    expect(b!.revokeReason).toBe('rebind');
    const [note] = await ctx.sql<{ title: string }[]>`SELECT title FROM oa_notifications WHERE staff_id = ${aliceId} AND kind = 'system' ORDER BY id DESC LIMIT 1`;
    expect(note!.title).toContain('微信绑定已解开');
  });

  it('自己换了手机：新手机绑上，旧手机的绑定自动解开', async () => {
    await hire('carol', '小卡');
    await pwLogin('carol', { code: 'wx-oldphone' });
    const r = await pwLogin('carol', { code: 'wx-newphone' });
    expect(r.body.bound).toBe(true);
    expect((await s('POST', '/api/staffmp/auth/wechat', null, { code: 'wx-oldphone' })).body).toEqual({ status: 'unbound' });
    expect((await s('POST', '/api/staffmp/auth/wechat', null, { code: 'wx-newphone' })).body.status).toBe('ok');
  });

  it('退出：不解绑的下次还能一键进；解绑的令牌失效、微信回到没绑', async () => {
    const w = await s('POST', '/api/staffmp/auth/wechat', null, { code: 'wx-newphone' });
    expect((await s('POST', '/api/staffmp/auth/logout', w.body.token, {})).status).toBe(200);
    expect((await s('GET', '/api/staffmp/me', w.body.token)).status).toBe(401);
    const again = await s('POST', '/api/staffmp/auth/wechat', null, { code: 'wx-newphone' });
    expect(again.body.status).toBe('ok');
    // 令牌已经失效（过期、被退掉）时要解绑：回 401，不回「好了」却没解开
    const dead = await s('POST', '/api/staffmp/auth/logout', w.body.token, { unbind: true });
    expect([dead.status, dead.body.error?.code]).toEqual([401, 'UNAUTHORIZED']);
    expect((await s('POST', '/api/staffmp/auth/wechat', null, { code: 'wx-newphone', mode: 'peek' })).body.status).toBe('bound');
    const done = await s('POST', '/api/staffmp/auth/logout', again.body.token, { unbind: true });
    expect(done.body).toEqual({ ok: true, unbound: true });
    expect((await s('POST', '/api/staffmp/auth/wechat', null, { code: 'wx-newphone' })).body).toEqual({ status: 'unbound' });
  });
});

describe('短时地址（给 <video>、<image> 用）', () => {
  /** 一张 1×1 的 PNG */
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('自己传的附件按短时地址打开；票据改了、换了编号、退出以后都打不开', async () => {
    await hire('erin', '小艾');
    const r = await pwLogin('erin');
    const token = r.body.token as string;
    const up = await s('POST', '/api/staffmp/oa/attachments', token, { clientKey: randomUUID(), fileName: 'a.png', mime: 'image/png', data: PNG });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(staffMpPath(up.body.url)).toBe(`/api/staffmp/oa/attachments/${up.body.id}`);
    // 带令牌照样能取
    expect((await s('GET', staffMpPath(up.body.url), token)).status).toBe(200);

    const link = await s('POST', '/api/staffmp/media', token, { kind: 'attachment', id: up.body.id });
    expect(link.status).toBe(200);
    expect(link.body.url).toMatch(/^\/api\/staffmp\/media\/[\w-]+\.[\w-]+$/);
    const got = await staffApp.inject({ method: 'GET', url: link.body.url });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toContain('image/png');

    // 签名对不上
    const forged = link.body.url.slice(0, -2) + (link.body.url.endsWith('AA') ? 'BB' : 'AA');
    expect((await staffApp.inject({ method: 'GET', url: forged })).statusCode).toBe(401);
    // 不带票据直接打改写以后的地址：没登录
    expect((await staffApp.inject({ method: 'GET', url: `/api/staffmp/oa/attachments/${up.body.id}` })).statusCode).toBe(401);
    // 票据只认它那一个文件：拿来开别的编号不行
    const ticket = link.body.url.split('/').pop();
    expect((await staffApp.inject({ method: 'GET', url: `/api/staffmp/oa/attachments/${up.body.id + 1}?__ticket=${ticket}` })).statusCode).toBe(401);
    // 别人的令牌要不到我的附件的票据也打不开（附件只有上传的人看得到，由原来的接口核对）
    const other = await pwLogin('clerk');
    const otherLink = await s('POST', '/api/staffmp/media', other.body.token, { kind: 'attachment', id: up.body.id });
    expect((await staffApp.inject({ method: 'GET', url: otherLink.body.url })).statusCode).toBeGreaterThanOrEqual(400);
    // 退出以后票据跟着作废
    await s('POST', '/api/staffmp/auth/logout', token, {});
    expect((await staffApp.inject({ method: 'GET', url: link.body.url })).statusCode).toBe(401);
  });

  it('没登录要不到票据', async () => {
    expect((await s('POST', '/api/staffmp/media', null, { kind: 'training', id: 1 })).status).toBe(401);
  });
});

describe('开关与后台（SP12）', () => {
  it('后台看得到谁绑了；解开以后那个人在小程序上的会话退出', async () => {
    await hire('dave', '大卫');
    const r = await pwLogin('dave', { code: 'wx-phoned' });
    const view = await admin('GET', '/api/admin/staffmp');
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body).toMatchObject({ enabled: true, portOpen: expect.any(Boolean), wechatConfigured: expect.any(Boolean) });
    const row = view.body.bindings.find((b: any) => b.displayName === '大卫');
    expect(row.liveSessions).toBe(1);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/staffmp')).status).toBe(403);
    const revoked = await admin('POST', `/api/admin/staffmp/bindings/${row.id}/revoke`);
    expect(revoked.body).toEqual({ ok: true, revoked: true });
    expect((await admin('POST', `/api/admin/staffmp/bindings/${row.id}/revoke`)).body).toEqual({ ok: true, revoked: false });
    expect((await s('GET', '/api/staffmp/me', r.body.token)).status).toBe(401);
  });

  it('人事：岗位要后台核实过（自己选成人力负责人的不算）；开关只有总裁能改', async () => {
    const hrId = await hire('hr1', '人事小周');
    await ctx.sql`UPDATE staff SET position = 'hr.lead', needs_position = false, position_chosen_at = now() WHERE id = ${hrId}`;
    const selfChosen = await login(ctx.app, 'hr1');
    const denied = await api(ctx.app, selfChosen, 'GET', '/api/admin/staffmp');
    expect([denied.status, denied.body.error.message]).toEqual([403, '你的岗位还没由后台核实，不能管员工小程序']);
    await ctx.sql`UPDATE staff SET position_chosen_at = NULL WHERE id = ${hrId}`;
    const hr = await login(ctx.app, 'hr1');
    expect((await api(ctx.app, hr, 'GET', '/api/admin/staffmp')).status).toBe(200);
    expect((await api(ctx.app, hr, 'PUT', '/api/admin/staffmp/settings', { enabled: false })).status).toBe(403);
  });

  it('只有人事权限的：看不到、解不开总裁与别家门店员工的绑定', async () => {
    const hr = await login(ctx.app, 'hr1');
    // 总裁绑了微信
    await pwLogin('owner', { code: 'wx-ownerphone' });
    // 只挂在别家门店的员工绑了微信
    const [entity] = await ctx.sql<{ id: number }[]>`SELECT entity_id AS id FROM stores WHERE id = 1`;
    const [store2] = await ctx.sql<{ id: number }[]>`INSERT INTO stores (code, name, entity_id) VALUES ('FT', '福田店', ${entity!.id}) RETURNING id`;
    const farId = await hire('far1', '福田的同事');
    await ctx.sql`INSERT INTO staff_stores (staff_id, store_id) VALUES (${farId}, ${store2!.id})`;
    await pwLogin('far1', { code: 'wx-farphone' });
    const all = (await admin('GET', '/api/admin/staffmp')).body.bindings as any[];
    const names = (await api(ctx.app, hr, 'GET', '/api/admin/staffmp')).body.bindings.map((b: any) => b.displayName);
    expect(names).not.toContain('测试店主');
    expect(names).not.toContain('福田的同事');
    for (const name of ['测试店主', '福田的同事']) {
      const row = all.find((b) => b.displayName === name);
      expect((await api(ctx.app, hr, 'POST', `/api/admin/staffmp/bindings/${row.id}/revoke`)).status, name).toBe(404);
    }
    // 总裁看得到全部
    expect(all.map((b) => b.displayName)).toEqual(expect.arrayContaining(['测试店主', '福田的同事']));
  });

  it('绑定解开以后，挂着它的会话马上不认；解开以后再发挂在它上面的会话发不出来', async () => {
    await hire('race1', '赛跑的同事');
    const r = await pwLogin('race1', { code: 'wx-racephone' });
    expect(r.body.bound).toBe(true);
    const [b] = await ctx.sql<{ id: number; staffId: number }[]>`SELECT id, staff_id FROM staffmp_bindings WHERE openid = 'openid-racephone' AND revoked_at IS NULL`;
    // 只把绑定标成解开、不删会话（模拟解开与发会话撞在一起）：令牌照样不认
    await ctx.sql`UPDATE staffmp_bindings SET revoked_at = now(), revoke_reason = 'self' WHERE id = ${b!.id}`;
    expect((await s('GET', '/api/staffmp/me', r.body.token)).status).toBe(401);
    expect(await issueSession(ctx.sql, Number(b!.staffId), Number(b!.id), 12, {})).toBeNull();
  });

  it('关上以后除了 info 都回「暂停使用」，打开就恢复', async () => {
    const r = await pwLogin('clerk');
    expect((await admin('PUT', '/api/admin/staffmp/settings', { enabled: false })).status).toBe(200);
    const closed = await s('GET', '/api/staffmp/me', r.body.token);
    expect([closed.status, closed.body.error.code]).toEqual([503, 'STAFFMP_CLOSED']);
    expect((await s('POST', '/api/staffmp/auth/login', null, { username: 'clerk', password: PASSWORD })).status).toBe(503);
    expect((await s('GET', '/api/staffmp/info')).body.open).toBe(false);
    await admin('PUT', '/api/admin/staffmp/settings', { enabled: true });
    expect((await s('GET', '/api/staffmp/me', r.body.token)).status).toBe(200);
  });
});
