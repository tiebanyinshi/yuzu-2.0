// 柜况与智能柜锁（8.1.49，docs/LOCKERS_V8149.md）：柜子状态的判断与分组、三种控制器（没配 / 模拟 / 柜锁桥）、
// 远程开柜的权限、原因、审计，没配控制器时拒绝。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoardTag } from '../src/shared/frontdesk';
import { groupLockers, lockerState } from '../src/shared/lockers';
import { loadLockerConfig } from '../src/server/config';
import { createLockerController } from '../src/server/devices/locker-controller';
import { api, setup, type TestContext } from './helpers';

const tag = (over: Partial<BoardTag>): BoardTag =>
  ({
    id: 1,
    code: 'A8060',
    zone: 'male',
    kind: 'normal',
    vipLevel: null,
    locked: false,
    lockReason: null,
    active: true,
    isSynthetic: false,
    serviceStatus: 'normal',
    serviceNote: null,
    visit: null,
    ...over,
  }) as BoardTag;

describe('柜子状态与分组（不要数据库）', () => {
  it('在用优先，其次锁定、停用、维修、暂停，其余空闲', () => {
    const visit = { id: 1 } as BoardTag['visit'];
    expect(lockerState(tag({ visit, locked: true, serviceStatus: 'repair' }))).toBe('in_use');
    expect(lockerState(tag({ locked: true, serviceStatus: 'repair' }))).toBe('locked');
    expect(lockerState(tag({ active: false }))).toBe('inactive');
    expect(lockerState(tag({ serviceStatus: 'repair' }))).toBe('repair');
    expect(lockerState(tag({ serviceStatus: 'paused' }))).toBe('paused');
    expect(lockerState(tag({}))).toBe('free');
  });

  it('普通柜按区、VIP 柜按等级分组计数，总数对得上', () => {
    const { groups, total } = groupLockers([
      tag({ id: 1, code: 'A8060' }),
      tag({ id: 2, code: 'A8061', visit: { id: 9 } as BoardTag['visit'] }),
      tag({ id: 3, code: 'B8186', locked: true }),
      tag({ id: 4, code: '9033', kind: 'vip', vipLevel: 2 }),
      tag({ id: 5, code: 'A6001', zone: 'female' }),
    ]);
    expect(groups.map((g) => [g.key, g.tags.length])).toEqual([
      ['male:normal:A', 2],
      ['male:normal:B', 1],
      ['male:vip:2', 1],
      ['female:normal:A', 1],
    ]);
    expect(groups[0]!.counts).toMatchObject({ free: 1, in_use: 1 });
    expect(groups[2]!.title).toContain('VIP 第 2 级');
    expect(total).toEqual({ in_use: 1, locked: 1, repair: 0, paused: 0, inactive: 0, free: 3 });
  });
});

describe('柜锁控制器（不要数据库）', () => {
  it('配置：默认没配；http 要地址与至少 32 位密钥；写错的拒绝启动', () => {
    expect(loadLockerConfig({})).toEqual({ driver: 'none', bridgeUrl: null, bridgeToken: null });
    expect(loadLockerConfig({ LOCKER_DRIVER: 'mock' }).driver).toBe('mock');
    expect(() => loadLockerConfig({ LOCKER_DRIVER: 'rs485' })).toThrow(/LOCKER_DRIVER/);
    expect(() => loadLockerConfig({ LOCKER_DRIVER: 'http' })).toThrow(/LOCKER_BRIDGE_URL/);
    expect(() => loadLockerConfig({ LOCKER_DRIVER: 'http', LOCKER_BRIDGE_URL: 'http://127.0.0.1:9300', LOCKER_BRIDGE_TOKEN: 'short' })).toThrow(/32/);
    expect(loadLockerConfig({ LOCKER_DRIVER: 'http', LOCKER_BRIDGE_URL: 'http://127.0.0.1:9300/', LOCKER_BRIDGE_TOKEN: 't'.repeat(32) })).toEqual({
      driver: 'http',
      bridgeUrl: 'http://127.0.0.1:9300',
      bridgeToken: 't'.repeat(32),
    });
  });

  it('模拟：开过的柜门是开着的', async () => {
    const c = createLockerController({ driver: 'mock', bridgeUrl: null, bridgeToken: null });
    expect(await c.open('A8060')).toMatchObject({ opened: true });
    expect(await c.doors(['A8060', 'A8061'])).toEqual([
      { code: 'A8060', doorOpen: true, known: true },
      { code: 'A8061', doorOpen: false, known: true },
    ]);
  });

  it('柜锁桥：带密钥调 /open、/doors；桥不认的柜号标出来；连不上时开柜返回没开、原因', async () => {
    const calls: { url: string; auth: string | null; body: unknown }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
      if (url.endsWith('/open')) return new Response(JSON.stringify({ ok: true, message: '3 号板第 7 路' }));
      return new Response(JSON.stringify({ doors: [{ code: 'A8060', doorOpen: false, known: true }] }));
    }) as typeof fetch;
    const cfg = { driver: 'http' as const, bridgeUrl: 'http://bridge', bridgeToken: 'k'.repeat(32) };
    const c = createLockerController(cfg, fakeFetch);
    expect(await c.open('A8060')).toEqual({ code: 'A8060', opened: true, message: '3 号板第 7 路' });
    expect(await c.doors(['A8060', 'Z9999'])).toEqual([
      { code: 'A8060', doorOpen: false, known: true },
      { code: 'Z9999', doorOpen: null, known: false },
    ]);
    expect(calls[0]).toEqual({ url: 'http://bridge/open', auth: `Bearer ${'k'.repeat(32)}`, body: { code: 'A8060' } });
    const down = createLockerController(cfg, (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    const r = await down.open('A8060');
    expect(r.opened).toBe(false);
    expect(r.message).toContain('连不上柜锁桥');
  });
});

describe('远程开柜接口', () => {
  let ctx: TestContext;
  const prev = process.env.LOCKER_DRIVER;
  beforeAll(async () => {
    process.env.LOCKER_DRIVER = 'mock';
    ctx = await setup();
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.LOCKER_DRIVER;
    else process.env.LOCKER_DRIVER = prev;
    await ctx?.close();
  });

  it('看控制器；要「维护手牌池」权限、写原因；开过的记审计；查柜门', async () => {
    const [t] = await ctx.sql<{ id: number }[]>`INSERT INTO hand_tags (code, zone) VALUES ('L8001', 'male') RETURNING id`;
    const info = await api(ctx.app, ctx.clerk, 'GET', '/api/lockers/controller');
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ driver: 'mock', canOpen: true });

    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/lockers/${t!.id}/open`, { reason: '客人忘带手牌' })).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/lockers/${t!.id}/open`, { reason: '' })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/lockers/999999/open', { reason: '客人忘带手牌' })).status).toBe(404);

    const res = await api(ctx.app, ctx.owner, 'POST', `/api/lockers/${t!.id}/open`, { reason: '客人忘带手牌' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code: 'L8001', opened: true });
    const [audit] = await ctx.sql<{ targetId: string; detail: Record<string, unknown> }[]>`
      SELECT target_id, detail FROM audit_logs WHERE action = 'locker_opened' ORDER BY id DESC LIMIT 1`;
    expect(audit).toMatchObject({ targetId: String(t!.id), detail: { code: 'L8001', reason: '客人忘带手牌', driver: 'mock', opened: true } });

    const doors = await api(ctx.app, ctx.clerk, 'POST', '/api/lockers/doors', { codes: ['L8001'] });
    expect(doors.body).toEqual([{ code: 'L8001', doorOpen: true, known: true }]);
  });
});

describe('没接控制器', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(async () => ctx?.close());

  it('控制器是 none；远程开柜回 503 LOCKER_NOT_CONFIGURED，不记审计；查柜门为空', async () => {
    const [t] = await ctx.sql<{ id: number }[]>`INSERT INTO hand_tags (code, zone) VALUES ('L8002', 'male') RETURNING id`;
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/lockers/controller')).body).toMatchObject({ driver: 'none', canOpen: false });
    const res = await api(ctx.app, ctx.owner, 'POST', `/api/lockers/${t!.id}/open`, { reason: '客人忘带手牌' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('LOCKER_NOT_CONFIGURED');
    expect(await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'locker_opened'`).toHaveLength(0);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/lockers/doors', { codes: ['L8002'] })).body).toEqual([]);
  });
});
