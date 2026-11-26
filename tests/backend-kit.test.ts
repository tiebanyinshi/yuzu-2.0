// 后端评估（8.1.48，docs/BACKEND_REVIEW_V8148.md）的公共底座：请求编号（认上游的、格式不对就生成、响应头带回、记进审计）、
// 统一的错误出口（三个端口同一份映射）、节流。
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/server/lib/errors';
import { baseServerOptions, installErrorHandler, installRequestId, requestIdOf, sharedKeyMatcher } from '../src/server/lib/http-kit';
import { every } from '../src/server/lib/throttle';
import { PASSWORD, setup, type TestContext } from './helpers';

describe('请求编号与统一的错误出口（不要数据库）', () => {
  const build = async (dbGuards: boolean) => {
    const app = Fastify({ ...baseServerOptions('silent') });
    installRequestId(app);
    installErrorHandler(app, { busy: () => '忙', internal: '出错了', details: dbGuards, dbGuards, logLabel: '测试' });
    const pgError = (code: string) => Object.assign(new Error('x'), { code });
    app.get('/app', async () => {
      throw new AppError(409, 'SAME', '已经有了', { a: 1 });
    });
    app.get('/busy', async () => {
      throw pgError('55P03');
    });
    app.get('/deadlock', async () => {
      throw pgError('40P01');
    });
    app.get('/check', async () => {
      throw pgError('23514');
    });
    app.get('/immutable', async () => {
      throw pgError('P0001');
    });
    app.get('/boom', async () => {
      throw new Error('内部细节不该出去');
    });
    await app.ready();
    return app;
  };

  it('认上游带来的编号；格式不对的（换行、太短、太长）换成新生成的；响应头带回', async () => {
    const app = await build(true);
    const ok = await app.inject({ method: 'GET', url: '/app', headers: { 'x-request-id': 'gw-12345678' } });
    expect(ok.headers['x-request-id']).toBe('gw-12345678');
    for (const bad of ['a\nb12345678', 'short', 'x'.repeat(65)]) {
      const res = await app.inject({ method: 'GET', url: '/app', headers: { 'x-request-id': bad } });
      expect(res.headers['x-request-id']).not.toBe(bad);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(requestIdOf(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  it('门店主程序：业务错误原样带 details；约束 422、只追加 409、等锁与死锁 409 BUSY；500 不带内部细节、带请求编号', async () => {
    const app = await build(true);
    const get = async (url: string) => {
      const res = await app.inject({ method: 'GET', url, headers: { 'x-request-id': 'req-abcdefgh' } });
      return { status: res.statusCode, body: res.json() };
    };
    expect(await get('/app')).toEqual({ status: 409, body: { error: { code: 'SAME', message: '已经有了', details: { a: 1 } } } });
    expect(await get('/busy')).toEqual({ status: 409, body: { error: { code: 'BUSY', message: '忙' } } });
    expect(await get('/deadlock')).toEqual({ status: 409, body: { error: { code: 'BUSY', message: '忙' } } });
    expect((await get('/check')).body.error.code).toBe('CONSTRAINT');
    expect((await get('/immutable')).body.error.code).toBe('IMMUTABLE');
    const boom = await get('/boom');
    expect(boom.status).toBe(500);
    expect(boom.body).toEqual({ error: { code: 'INTERNAL', message: '出错了（请求编号 req-abcdefgh）', requestId: 'req-abcdefgh' } });
    expect(JSON.stringify(boom.body)).not.toContain('内部细节');
    await app.close();
  });

  it('小程序、员工端口：不带 details；数据库约束不细分（按 500）', async () => {
    const app = await build(false);
    const res = await app.inject({ method: 'GET', url: '/app' });
    expect(res.json()).toEqual({ error: { code: 'SAME', message: '已经有了' } });
    expect((await app.inject({ method: 'GET', url: '/check' })).statusCode).toBe(500);
    await app.close();
  });

  it('服务密钥比对：只认完全一样的', () => {
    const match = sharedKeyMatcher('k'.repeat(32));
    expect(match('k'.repeat(32))).toBe(true);
    expect(match('k'.repeat(31))).toBe(false);
    expect(match(undefined)).toBe(false);
    expect(match(['k'.repeat(32)])).toBe(false);
  });

  it('节流：第一次放行，满间隔才再放行', () => {
    const due = every(1000);
    expect(due(5000)).toBe(true);
    expect(due(5500)).toBe(false);
    expect(due(6000)).toBe(true);
    expect(due(6999)).toBe(false);
  });
});

describe('请求编号记进审计（迁移 490）', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(async () => ctx?.close());

  it('登录写的审计记上这次请求的编号；没带编号的也有（生成的）', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-request-id': 'login-req-0001' }, payload: { username: 'owner', password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('login-req-0001');
    const [row] = await ctx.sql<{ requestId: string | null }[]>`SELECT request_id FROM audit_logs WHERE action = 'login' ORDER BY id DESC LIMIT 1`;
    expect(row!.requestId).toBe('login-req-0001');

    const again = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: PASSWORD } });
    const [row2] = await ctx.sql<{ requestId: string | null }[]>`SELECT request_id FROM audit_logs WHERE action = 'login' ORDER BY id DESC LIMIT 1`;
    expect(row2!.requestId).toBe(again.headers['x-request-id']);
  });
});
