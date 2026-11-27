// 柜况与智能柜锁（8.1.49，docs/LOCKERS_V8149.md）：柜子状态的判断与分组、三种控制器（没配 / 模拟 / 柜锁桥）、
// 远程开柜的权限、原因、审计，没配控制器时拒绝；第 6 节发卡器（泰格柜锁、M1 手牌）：能力开关、读卡写卡清卡、模拟柜锁桥。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoardTag } from '../src/shared/frontdesk';
import { groupLockers, lockerState } from '../src/shared/lockers';
import { loadLockerConfig } from '../src/server/config';
import { createLockerController } from '../src/server/devices/locker-controller';
import { MockLockerHardware, startMockLockerBridge } from '../src/server/devices/mock-locker-bridge';
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
    expect(loadLockerConfig({})).toEqual({ driver: 'none', bridgeUrl: null, bridgeToken: null, capabilities: [] });
    expect(loadLockerConfig({ LOCKER_DRIVER: 'mock' }).driver).toBe('mock');
    expect(() => loadLockerConfig({ LOCKER_DRIVER: 'rs485' })).toThrow(/LOCKER_DRIVER/);
    expect(() => loadLockerConfig({ LOCKER_DRIVER: 'http' })).toThrow(/LOCKER_BRIDGE_URL/);
    expect(() => loadLockerConfig({ LOCKER_DRIVER: 'http', LOCKER_BRIDGE_URL: 'http://127.0.0.1:9300', LOCKER_BRIDGE_TOKEN: 'short' })).toThrow(/32/);
    expect(loadLockerConfig({ LOCKER_DRIVER: 'http', LOCKER_BRIDGE_URL: 'http://127.0.0.1:9300/', LOCKER_BRIDGE_TOKEN: 't'.repeat(32) })).toEqual({
      driver: 'http',
      bridgeUrl: 'http://127.0.0.1:9300',
      bridgeToken: 't'.repeat(32),
      capabilities: ['open', 'doors'],
    });
  });

  it('能力开关（第 6 节）：mock 三样都有；http 默认开柜、查柜门，泰格单机锁只配发卡器；写错、写空拒绝启动', () => {
    const http = { LOCKER_DRIVER: 'http', LOCKER_BRIDGE_URL: 'http://127.0.0.1:9300', LOCKER_BRIDGE_TOKEN: 't'.repeat(32) };
    expect(loadLockerConfig({ LOCKER_DRIVER: 'mock' }).capabilities).toEqual(['open', 'doors', 'card']);
    expect(loadLockerConfig({ ...http, LOCKER_CAPABILITIES: ' Card ' }).capabilities).toEqual(['card']);
    expect(loadLockerConfig({ ...http, LOCKER_CAPABILITIES: 'card,open' }).capabilities).toEqual(['open', 'card']);
    expect(() => loadLockerConfig({ ...http, LOCKER_CAPABILITIES: 'card,nfc' })).toThrow(/nfc/);
    expect(() => loadLockerConfig({ ...http, LOCKER_CAPABILITIES: ' , ' })).toThrow(/至少/);
    const c = createLockerController(loadLockerConfig({ ...http, LOCKER_CAPABILITIES: 'card' }));
    expect(c.info).toEqual({ driver: 'http', canOpen: false, canDoors: false, canCard: true });
  });

  it('模拟：开过的柜门是开着的', async () => {
    const c = createLockerController(loadLockerConfig({ LOCKER_DRIVER: 'mock' }));
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
    const cfg = { driver: 'http' as const, bridgeUrl: 'http://bridge', bridgeToken: 'k'.repeat(32), capabilities: ['open' as const, 'doors' as const] };
    const c = createLockerController(cfg, fakeFetch);
    expect(await c.open('A8060')).toEqual({ code: 'A8060', opened: true, uncertain: false, message: '3 号板第 7 路' });
    expect(await c.doors(['A8060', 'Z9999'])).toEqual([
      { code: 'A8060', doorOpen: false, known: true },
      { code: 'Z9999', doorOpen: null, known: false },
    ]);
    expect(calls[0]).toEqual({ url: 'http://bridge/open', auth: `Bearer ${'k'.repeat(32)}`, body: { code: 'A8060' } });
    const down = createLockerController(cfg, (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    // 没收到回答：不当成没开，结果待确认（Codex 审查 f8b2853）
    const r = await down.open('A8060');
    expect(r).toMatchObject({ opened: false, uncertain: true });
    expect(r.message).toContain('柜门可能已经开了');
  });

  it('结果待确认（Codex 审查 f8b2853）：没收到回答时写卡读回核对、开柜查柜门；对上了按做成算，对不上标待确认；4xx 是明确没做', async () => {
    const cfg = { driver: 'http' as const, bridgeUrl: 'http://bridge', bridgeToken: 'k'.repeat(32), capabilities: ['open' as const, 'doors' as const, 'card' as const] };
    const respond = (handlers: Record<string, () => Response>) =>
      (async (url: string) => {
        const path = new URL(url).pathname;
        const h = handlers[path];
        if (!h) throw new Error('timeout');
        return h();
      }) as typeof fetch;
    const json =
      (v: unknown, status = 200) =>
      () =>
        new Response(JSON.stringify(v), { status });
    // 写卡超时，但读回已经是要写的柜：按写成算，注明读回核对
    const written = createLockerController(cfg, respond({ '/card/read': json({ ok: true, uid: '04A1B2C3', code: 'A8060' }) }));
    const w1 = await written.writeCard('A8060', '04A1B2C3');
    expect(w1).toMatchObject({ ok: true, uncertain: false, uid: '04A1B2C3' });
    expect(w1.message).toContain('读回核对');
    // 写卡回 503、读回还是空白卡：结果待确认（桥可能还在写）
    const pending = createLockerController(cfg, respond({ '/card/write': json({}, 503), '/card/read': json({ ok: true, uid: '04A1B2C3', code: null }) }));
    const w2 = await pending.writeCard('A8060', null);
    expect(w2).toMatchObject({ ok: false, uncertain: true, uid: '04A1B2C3' });
    expect(w2.message).toContain('读回的卡里是 空白');
    // 清卡超时、读回也读不到：结果待确认
    expect(await createLockerController(cfg, respond({})).clearCard(null)).toMatchObject({ ok: false, uncertain: true });
    // 桥回 400：明确没做
    expect(await createLockerController(cfg, respond({ '/card/write': json({}, 400) })).writeCard('A8060', null)).toMatchObject({ ok: false, uncertain: false });
    expect(await createLockerController(cfg, respond({ '/open': json({}, 401) })).open('A8060')).toMatchObject({ opened: false, uncertain: false });
    // 开柜超时、查柜门开着：按开了算
    expect(await createLockerController(cfg, respond({ '/doors': json({ doors: [{ code: 'A8060', doorOpen: true }] }) })).open('A8060')).toMatchObject({
      opened: true,
      uncertain: false,
    });
  });

  it('发卡器（模拟）：读空白卡、写成柜号（衣物柜、手机柜）、清卡；不是要写的那张卡不写；发卡器上没卡时说明', async () => {
    const hw = new MockLockerHardware({ uid: '04A1B2C3', code: null, locks: [] });
    const c = createLockerController(loadLockerConfig({ LOCKER_DRIVER: 'mock' }), fetch, hw);
    expect(await c.readCard()).toMatchObject({ ok: true, uid: '04A1B2C3', code: null, locks: [] });
    expect(await c.writeCard('A8060', 'FFFF0000')).toMatchObject({ ok: false });
    expect(await c.writeCard('A8060', '04a1b2c3')).toMatchObject({ ok: true, uid: '04A1B2C3' });
    expect(await c.readCard()).toMatchObject({
      code: 'A8060',
      locks: [
        { kind: 'clothes', no: 'A8060' },
        { kind: 'phone', no: 'A8060' },
      ],
    });
    expect(await c.clearCard(null)).toMatchObject({ ok: true });
    expect((await c.readCard()).code).toBeNull();
    hw.place(null);
    expect(await c.readCard()).toMatchObject({ ok: false, uid: null });
    expect(await c.writeCard('A8060', null)).toMatchObject({ ok: false });
  });

  it('发卡器（柜锁桥）：带密钥调 /card/*；桥报的芯片号照手牌的写法整理、不认识的锁类归「其他」、乱回的不当真；连不上时写卡返回没写成', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith('/card/read'))
        return new Response(JSON.stringify({ ok: true, uid: '04:a1:b2:c3', code: 'A8060', locks: [{ kind: 'clothes', no: 'A8060' }, { kind: 'shoe', no: 'S12' }, { no: 5 }] }));
      if (url.endsWith('/card/write')) return new Response(JSON.stringify({ ok: true, uid: '04A1B2C3', message: '已写：衣物柜 A8060、手机柜 P060' }));
      return new Response(JSON.stringify({ ok: 'yes', uid: 'x' }));
    }) as typeof fetch;
    const cfg = { driver: 'http' as const, bridgeUrl: 'http://bridge', bridgeToken: 'k'.repeat(32), capabilities: ['card' as const] };
    const c = createLockerController(cfg, fakeFetch);
    expect(await c.readCard()).toEqual({
      ok: true,
      uid: '04A1B2C3',
      code: 'A8060',
      locks: [
        { kind: 'clothes', no: 'A8060' },
        { kind: 'other', no: 'S12' },
      ],
      message: '已读',
    });
    expect(await c.writeCard('A8060', '04A1B2C3')).toEqual({ ok: true, uncertain: false, uid: '04A1B2C3', message: '已写：衣物柜 A8060、手机柜 P060' });
    expect(await c.clearCard(null)).toEqual({ ok: false, uncertain: false, uid: null, message: '发卡器没有写成' });
    expect(calls.map((x) => [x.url, x.body])).toEqual([
      ['http://bridge/card/read', {}],
      ['http://bridge/card/write', { code: 'A8060', uid: '04A1B2C3' }],
      ['http://bridge/card/clear', {}],
    ]);
    const down = createLockerController(cfg, (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    expect(await down.writeCard('A8060', null)).toMatchObject({ ok: false, uncertain: true });
    await expect(down.readCard()).rejects.toThrow();
  });

  it('模拟柜锁桥（cli locker-bridge-mock）：门店系统用真的 http 调过去，五个接口都通；密钥不对回 401', async () => {
    const token = 'b'.repeat(32);
    const bridge = await startMockLockerBridge({ token, hardware: new MockLockerHardware({ uid: '04A1B2C3', code: null, locks: [] }) });
    try {
      const c = createLockerController({ driver: 'http', bridgeUrl: bridge.url, bridgeToken: token, capabilities: ['open', 'doors', 'card'] });
      expect(await c.open('A8060')).toMatchObject({ opened: true });
      expect(await c.doors(['A8060'])).toEqual([{ code: 'A8060', doorOpen: true, known: true }]);
      expect(await c.writeCard('A8060', '04A1B2C3')).toMatchObject({ ok: true, uid: '04A1B2C3' });
      expect(await c.readCard()).toMatchObject({ ok: true, code: 'A8060', locks: [{ kind: 'clothes' }, { kind: 'phone' }] });
      expect(await c.clearCard('04A1B2C3')).toMatchObject({ ok: true });
      const wrong = createLockerController({ driver: 'http', bridgeUrl: bridge.url, bridgeToken: 'x'.repeat(32), capabilities: ['card'] });
      await expect(wrong.readCard()).rejects.toThrow(/401/);
    } finally {
      await bridge.close();
    }
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

  it('发卡器：读卡带出芯片号绑的手牌；写卡、清卡要「维护手牌池」、写原因、记审计；卡里的柜与绑的手牌对不上标出来', async () => {
    const [t] = await ctx.sql<{ id: number }[]>`INSERT INTO hand_tags (code, zone, card_uid) VALUES ('L8003', 'male', '04A1B2C3') RETURNING id`;
    const [other] = await ctx.sql<{ id: number }[]>`INSERT INTO hand_tags (code, zone) VALUES ('L8004', 'male') RETURNING id`;
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/lockers/controller')).body).toMatchObject({ canCard: true, cardReasons: expect.arrayContaining(['补发手牌']) });
    const blank = await api(ctx.app, ctx.clerk, 'POST', '/api/lockers/card/read', {});
    expect(blank.status).toBe(200);
    expect(blank.body).toMatchObject({ ok: true, uid: '04A1B2C3', code: null, tag: { id: t!.id, code: 'L8003' }, mismatch: false });

    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/lockers/${t!.id}/card/write`, { reason: '补发手牌' })).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/lockers/${t!.id}/card/write`, { reason: '' })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/lockers/${t!.id}/card/write`, { reason: '补发手牌', uid: '??' })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/lockers/999999/card/write', { reason: '补发手牌' })).status).toBe(404);

    // 写成另一张牌的柜：芯片号绑的是 L8003，读卡标出对不上
    const w = await api(ctx.app, ctx.owner, 'POST', `/api/lockers/${other!.id}/card/write`, { reason: '手牌失灵重写', uid: '04a1b2c3' });
    expect(w.body).toMatchObject({ ok: true, uid: '04A1B2C3', code: 'L8004', boundTag: { code: 'L8003' } });
    const [audit] = await ctx.sql<{ targetId: string; detail: Record<string, unknown> }[]>`
      SELECT target_id, detail FROM audit_logs WHERE action = 'locker_card_written' ORDER BY id DESC LIMIT 1`;
    expect(audit).toMatchObject({ targetId: String(other!.id), detail: { code: 'L8004', uid: '04A1B2C3', reason: '手牌失灵重写', driver: 'mock', ok: true, uncertain: false } });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/lockers/card/read', {})).body).toMatchObject({ code: 'L8004', tag: { code: 'L8003' }, mismatch: true });

    // 不是要清的那张卡：不清，照样记审计（没清成）
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/lockers/card/clear', { reason: '作废', uid: 'FFFF0000' })).body).toMatchObject({ ok: false });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/lockers/card/clear', { reason: '作废' })).status).toBe(403);
    const cleared = await api(ctx.app, ctx.owner, 'POST', '/api/lockers/card/clear', { reason: '退牌回收', uid: '04A1B2C3' });
    expect(cleared.body).toMatchObject({ ok: true, uid: '04A1B2C3' });
    const logs = await ctx.sql<{ targetId: string | null; detail: Record<string, unknown> }[]>`
      SELECT target_id, detail FROM audit_logs WHERE action = 'locker_card_cleared' ORDER BY id`;
    expect(logs.map((l) => l.detail.ok)).toEqual([false, true]);
    expect(logs[1]).toMatchObject({ targetId: String(t!.id), detail: { uid: '04A1B2C3', code: 'L8003', reason: '退牌回收' } });
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
    // 发卡器也没有：读、写、清都回 503 LOCKER_CARD_NOT_CONFIGURED，不记审计
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/lockers/card/read', {})).body.error.code).toBe('LOCKER_CARD_NOT_CONFIGURED');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/lockers/${t!.id}/card/write`, { reason: '补发手牌' })).status).toBe(503);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/lockers/card/clear', { reason: '作废' })).status).toBe(503);
    expect(await ctx.sql`SELECT 1 FROM audit_logs WHERE action IN ('locker_card_written', 'locker_card_cleared')`).toHaveLength(0);
  });
});
