// 登录与「我是谁」（src/utils/session.ts）：微信一键进、只看看绑着谁、账号密码登录（绑与改绑）、退出以后不再悄悄登录、模拟微信只在非正式版。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeWx } from './fake-wx';

const ME = { staff: { id: 1, displayName: '阿丽' }, entries: [], build: { instance: 'demo' } };
const INFO = (over: Record<string, unknown> = {}) => ({
  status: 200,
  data: { storeName: '汤崎', version: '8.2.6', commit: '', instance: 'demo', open: true, wechat: true, mockWechat: false, time: '', ...over },
});

async function load(envVersion: 'develop' | 'release' = 'develop') {
  vi.resetModules();
  const fake = installFakeWx({ envVersion });
  const api = await import('../src/utils/api');
  api.setRetryDelayForTest(() => 0);
  const session = await import('../src/utils/session');
  return { fake, api, session };
}

describe('登录', () => {
  let ctx: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => {
    ctx = await load();
  });

  it('微信一键进：绑过的存令牌与「我是谁」；没绑过返回 false', async () => {
    const { fake, session } = ctx;
    fake.reply(INFO(), { status: 200, data: { status: 'ok', token: 'tok', me: ME } });
    await expect(session.wechatLogin()).resolves.toBe(true);
    expect(fake.sent[1]!.data).toEqual({ code: 'wxcode123456', mode: 'login' });
    expect(fake.storage.get('wcp_token')).toBe('tok');
    expect(session.currentMe()).toEqual(ME);
    fake.reply({ status: 200, data: { status: 'unbound' } });
    await expect(session.wechatLogin()).resolves.toBe(false);
  });

  it('门店系统没配微信登录：不问微信，直接去账号密码', async () => {
    const { fake, session } = ctx;
    fake.reply(INFO({ wechat: false }));
    await expect(session.wechatLogin()).resolves.toBe(false);
    expect(fake.sent).toHaveLength(1);
  });

  it('只看看：这个微信绑着谁', async () => {
    const { fake, session } = ctx;
    fake.reply(INFO(), { status: 200, data: { status: 'bound', displayName: '阿丽' } });
    await expect(session.peekWechat()).resolves.toEqual({ bound: true, displayName: '阿丽' });
    expect(fake.sent[1]!.data).toEqual({ code: 'wxcode123456', mode: 'peek' });
  });

  it('账号密码登录：要绑的带微信 code 与 replace；不绑的不带 code', async () => {
    const { fake, session } = ctx;
    fake.reply(INFO(), { status: 200, data: { token: 't1', me: ME, bound: true, bindError: null } });
    await session.passwordLogin('alice', 'pw', { bind: true, replace: true });
    expect(fake.sent[1]!.data).toEqual({ username: 'alice', password: 'pw', bind: true, replace: true, code: 'wxcode123456' });
    fake.reply({ status: 200, data: { token: 't2', me: ME, bound: false, bindError: null } });
    await session.passwordLogin('alice', 'pw', { bind: false, replace: false });
    expect(fake.sent[2]!.data).toEqual({ username: 'alice', password: 'pw', bind: false, replace: false });
  });

  it('退出：手机上清掉令牌与「我是谁」，记下主动退出过；令牌过期时不再悄悄用微信登录', async () => {
    const { fake, session, api } = ctx;
    fake.reply(INFO(), { status: 200, data: { status: 'ok', token: 'tok', me: ME } });
    await session.wechatLogin();
    fake.reply({ status: 200, data: { ok: true, unbound: true } });
    await session.logout(true);
    expect(fake.sent[2]!.data).toEqual({ unbind: true });
    expect(fake.storage.has('wcp_token')).toBe(false);
    expect(session.currentMe()).toBeNull();
    expect(session.signedOut()).toBe(true);
    // 退出以后：要登录的接口不再悄悄登录，直接 401（不发 wechat 请求）
    await expect(api.call('GET', '/me')).rejects.toMatchObject({ status: 401 });
    expect(fake.pending()).toBe(0);
  });

  it('退出时连不上门店系统：手机上照样退出', async () => {
    const { fake, session } = ctx;
    fake.reply(INFO(), { status: 200, data: { status: 'ok', token: 'tok', me: ME } });
    await session.wechatLogin();
    fake.reply({ status: 0, fail: true });
    await session.logout(false);
    expect(fake.storage.has('wcp_token')).toBe(false);
  });

  it('退出并解开时连不上：问「这个微信还绑着没有」，还绑着就报错、手机上不退出', async () => {
    const { fake, session } = ctx;
    fake.reply(INFO(), { status: 200, data: { status: 'ok', token: 'tok', me: ME } });
    await session.wechatLogin();
    fake.reply({ status: 0, fail: true }, { status: 200, data: { status: 'bound', displayName: '阿丽' } });
    await expect(session.logout(true)).rejects.toMatchObject({ code: 'UNBIND_UNCONFIRMED' });
    expect(fake.storage.get('wcp_token')).toBe('tok');
    expect(session.currentMe()).toEqual(ME);
    // 问也问不到：同样不退出
    fake.reply({ status: 0, fail: true }, { status: 0, fail: true });
    await expect(session.logout(true)).rejects.toMatchObject({ code: 'UNBIND_UNCONFIRMED' });
    expect(fake.storage.get('wcp_token')).toBe('tok');
  });

  it('退出并解开时门店系统没说解开了（旧版本）：去问，还绑着就报错、不退出', async () => {
    const { fake, session } = ctx;
    fake.reply(INFO(), { status: 200, data: { status: 'ok', token: 'tok', me: ME } });
    await session.wechatLogin();
    fake.reply({ status: 200, data: { ok: true } }, { status: 200, data: { status: 'bound', displayName: '阿丽' } });
    await expect(session.logout(true)).rejects.toMatchObject({ code: 'UNBIND_UNCONFIRMED' });
    expect(fake.storage.get('wcp_token')).toBe('tok');
  });

  it('退出并解开没收到回复、但其实解开了：确认没绑以后手机上退出', async () => {
    const { fake, session } = ctx;
    fake.reply(INFO(), { status: 200, data: { status: 'ok', token: 'tok', me: ME } });
    await session.wechatLogin();
    fake.reply({ status: 502, data: {} }, { status: 200, data: { status: 'unbound' } });
    await session.logout(true);
    expect(fake.storage.has('wcp_token')).toBe(false);
    expect(session.signedOut()).toBe(true);
  });

  it('手机存不下令牌时这次打开照样算登录着（与发请求用同一个令牌）', async () => {
    const { fake, session, api } = ctx;
    const wx = (globalThis as unknown as { wx: { setStorageSync: (k: string, v: unknown) => void } }).wx;
    const original = wx.setStorageSync;
    wx.setStorageSync = (k, v) => {
      if (k === 'wcp_token') throw new Error('满了');
      original(k, v);
    };
    api.saveToken('mem-tok');
    expect(fake.storage.has('wcp_token')).toBe(false);
    expect(session.hasSession()).toBe(true);
  });
});

describe('令牌过期时悄悄重新登录', () => {
  it('还是同一个人：换上新令牌，重发原来的请求', async () => {
    const { fake, session, api } = await load();
    fake.reply(INFO(), { status: 200, data: { status: 'ok', token: 'tok1', me: ME } });
    await session.wechatLogin();
    fake.reply({ status: 401, data: { error: { code: 'UNAUTHORIZED', message: '请先登录' } } }, { status: 200, data: { status: 'ok', token: 'tok2', me: ME } }, { status: 200, data: { ok: 1 } });
    await expect(api.call('GET', '/me')).resolves.toEqual({ ok: 1 });
    expect(fake.sent.at(-1)!.header.authorization).toBe('Bearer tok2');
  });

  it('这个微信绑的是别人（在同事手机上只登录了一次）：不换人，退掉那个会话，交给页面去登录', async () => {
    const { fake, session, api } = await load();
    // 不绑微信的账号密码登录只发登录这一个请求
    fake.reply({ status: 200, data: { token: 'tokA', me: { ...ME, staff: { id: 2, displayName: '借手机的' } }, bound: false, bindError: null } });
    await session.passwordLogin('a', 'pw', { bind: false, replace: false });
    expect(fake.pending()).toBe(0);
    fake.reply(
      { status: 401, data: { error: { code: 'UNAUTHORIZED', message: '请先登录' } } },
      INFO(),
      { status: 200, data: { status: 'ok', token: 'tokOwner', me: ME } },
      { status: 200, data: { ok: true } },
    );
    await expect(api.call('POST', '/oa/attendance/punch', { clientKey: 'k' })).rejects.toMatchObject({ status: 401 });
    // 那个会话当场退掉，没有用手机主人的身份重发打卡
    expect(fake.sent.at(-1)!.url).toContain('/auth/logout');
    // 退掉那个会话用它自己的令牌，没有放进手机上存令牌的地方
    expect(fake.sent.at(-1)!.header.authorization).toBe('Bearer tokOwner');
    expect(fake.sent.filter((x) => x.url.endsWith('/oa/attendance/punch'))).toHaveLength(1);
    expect(fake.storage.has('wcp_token')).toBe(false);
  });

  it('晚回来的 401 不清掉别的请求刚换上的新令牌：用新令牌重发', async () => {
    const { fake, api } = await load();
    api.saveToken('old');
    // 第一个请求带着旧令牌出去，回来之前别的请求已经换上了新令牌
    const wx = (
      globalThis as unknown as { wx: { request: (o: { header: Record<string, string>; success: (r: unknown) => void; fail: () => void; url: string; method: string; data: unknown }) => void } }
    ).wx;
    const original = wx.request;
    let first = true;
    wx.request = (o) => {
      if (first) {
        first = false;
        api.saveToken('new');
      }
      original(o);
    };
    fake.reply({ status: 401, data: { error: { code: 'UNAUTHORIZED', message: '请先登录' } } }, { status: 200, data: { ok: 1 } });
    await expect(api.call('GET', '/me')).resolves.toEqual({ ok: 1 });
    expect(fake.sent[0]!.header.authorization).toBe('Bearer old');
    expect(fake.sent[1]!.header.authorization).toBe('Bearer new');
    expect(fake.storage.get('wcp_token')).toBe('new');
  });
});

describe('门店系统说先改密码、先选岗位', () => {
  it('改「我是谁」的标记，去改密码页（已经在那一页就不动）', async () => {
    const { fake, session, api } = await load();
    const launched: string[] = [];
    const g = globalThis as unknown as { wx: Record<string, unknown>; getCurrentPages: () => { route: string }[] };
    g.wx.reLaunch = (o: { url: string }) => void launched.push(o.url);
    g.getCurrentPages = () => [{ route: 'pages/learn/index' }];
    fake.reply(INFO(), { status: 200, data: { status: 'ok', token: 'tok', me: { ...ME, mustChangePassword: false, needsPosition: false } } });
    await session.wechatLogin();
    fake.reply({ status: 403, data: { error: { code: 'PASSWORD_CHANGE_REQUIRED', message: '首次登录请先修改密码' } } });
    await expect(api.call('GET', '/training/folders')).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    expect(session.currentMe()!.mustChangePassword).toBe(true);
    expect(launched).toEqual(['/pages/password/index?first=1']);
    g.getCurrentPages = () => [{ route: 'pages/password/index' }];
    fake.reply({ status: 403, data: { error: { code: 'PASSWORD_CHANGE_REQUIRED', message: '首次登录请先修改密码' } } });
    await expect(api.call('GET', '/training/folders')).rejects.toBeTruthy();
    expect(launched).toHaveLength(1);
  });
});

describe('换了人', () => {
  it('晚回来的「我是谁」（上一位的）不盖到新登录的人身上', async () => {
    const { fake, session } = await load();
    fake.reply(INFO(), { status: 200, data: { status: 'ok', token: 'tok', me: ME } });
    await session.wechatLogin();
    const other = { ...ME, staff: { id: 9, displayName: '新来的' } };
    // /me 发出去了，回复先压着
    const wx = (globalThis as unknown as { wx: { request: (o: unknown) => void } }).wx;
    const original = wx.request;
    let held: (() => void) | null = null;
    wx.request = (o) => {
      held = () => original(o);
    };
    const pending = session.refreshMe();
    await new Promise((r) => setTimeout(r, 0));
    wx.request = original;
    expect(held).not.toBeNull();
    // 这期间换了人登录
    fake.reply({ status: 200, data: { token: 't9', me: other, bound: false, bindError: null } });
    await session.passwordLogin('n', 'pw', { bind: false, replace: false });
    // 上一位的 /me 这时才回来
    fake.reply({ status: 200, data: ME });
    held!();
    await pending;
    expect(session.currentMe()!.staff.id).toBe(9);
  });

  it('退出、换了人：知识库的文件夹缓存与最近搜过的清掉', async () => {
    const { fake, session } = await load();
    fake.reply(INFO(), { status: 200, data: { status: 'ok', token: 'tok', me: ME } });
    await session.wechatLogin();
    fake.storage.set('wcp_learn_folders', [{ id: 1 }]);
    fake.storage.set('wcp_learn_recent', ['工牌']);
    fake.reply({ status: 200, data: { ok: true } });
    await session.logout(false);
    expect(fake.storage.has('wcp_learn_folders')).toBe(false);
    expect(fake.storage.has('wcp_learn_recent')).toBe(false);
  });
});

describe('模拟微信', () => {
  it('开发版连模拟微信的门店系统：code 写 mock-<这台手机的名字>，一台手机一个', async () => {
    const { fake, session } = await load('develop');
    fake.reply(INFO({ mockWechat: true }));
    const code = await session.wechatCode();
    expect(code).toMatch(/^mock-dev[a-z0-9]{8}$/);
    await expect(session.wechatCode()).resolves.toBe(code);
  });

  it('正式版一律用真的微信', async () => {
    const { fake, session } = await load('release');
    fake.reply(INFO({ mockWechat: true }));
    await expect(session.wechatCode()).resolves.toBe('wxcode123456');
  });
});
