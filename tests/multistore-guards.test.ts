// 多门店防护（8.1.52，后端评估 docs/BACKEND_REVIEW_V8148.md 第 7 节）：挂的门店都停用了的账号不再落到本店——
// 登录拒绝 NO_STORE，已有的会话当作没登录；门店重新启用后照常。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx?.close());

describe('挂的门店都停用了', () => {
  it('登录拒绝、已有会话失效；门店重新启用后照常', async () => {
    const [b] = await ctx.sql<{ id: number }[]>`INSERT INTO stores (code, name, entity_id) VALUES ('NS2', '乙店', 1) RETURNING id`;
    const id = await createStaff(ctx.sql, { username: 'bonly', displayName: '乙店店员', role: 'clerk', password: PASSWORD, mustChangePassword: false });
    await ctx.sql`INSERT INTO staff_stores (staff_id, store_id) VALUES (${id}, ${b!.id})`;
    const cookie = await login(ctx.app, 'bonly');
    expect((await api(ctx.app, cookie, 'GET', '/api/auth/me')).status).toBe(200);

    await ctx.sql`UPDATE stores SET active = false WHERE id = ${b!.id}`;
    expect((await api(ctx.app, cookie, 'GET', '/api/auth/me')).status).toBe(401);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bonly', password: PASSWORD } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NO_STORE');
    const [audit] = await ctx.sql<{ detail: { reason: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'login_failed' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.reason).toBe('no_store');

    await ctx.sql`UPDATE stores SET active = true WHERE id = ${b!.id}`;
    expect((await api(ctx.app, cookie, 'GET', '/api/auth/me')).status).toBe(200);
  });

  it('没挂任何门店的照旧按本店算（单店时与以往一样）', async () => {
    await createStaff(ctx.sql, { username: 'nostore', displayName: '没挂门店', role: 'clerk', password: PASSWORD, mustChangePassword: false });
    const cookie = await login(ctx.app, 'nostore');
    expect((await api(ctx.app, cookie, 'GET', '/api/auth/me')).status).toBe(200);
  });
});
