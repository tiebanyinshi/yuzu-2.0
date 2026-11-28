// 员工小程序（docs/STAFF_MP.md 第 5、6 节）不要数据库的部分：端口与微信配置的读法、微信 code 换 openid（模拟与真的）。

import { describe, expect, it } from 'vitest';
import { loadStaffMpConfig, type StaffMpConfig } from '../src/server/config';
import { code2sessionFor, wechatReady } from '../src/server/modules/staffmp/wechat';
import { issueTicket, mediaRewrite, TICKET_TTL_SECONDS, TRAINING_TICKET_TTL_SECONDS, verifyTicket } from '../src/server/modules/staffmp/media';

const taken = { main: 8080, mp: 8081, canteen: 8090 };
const APPID = 'wx0123456789abcdef';
const SECRET = '0123456789abcdef0123456789abcdef';

describe('员工小程序端口的配置', () => {
  it('没设端口不开；设了要是合法的、不和别的端口相同', () => {
    expect(loadStaffMpConfig({}, 'production', taken).port).toBeNull();
    expect(loadStaffMpConfig({ STAFFMP_PORT: '8095' }, 'production', taken).port).toBe(8095);
    expect(() => loadStaffMpConfig({ STAFFMP_PORT: '8090' }, 'production', taken)).toThrow(/不能与/);
    expect(() => loadStaffMpConfig({ STAFFMP_PORT: 'abc' }, 'production', taken)).toThrow(/端口号/);
  });

  it('AppID 与 AppSecret 要一起配、格式要对', () => {
    expect(loadStaffMpConfig({ STAFFMP_APPID: APPID, STAFFMP_APP_SECRET: SECRET }, 'production', taken)).toMatchObject({ appId: APPID, appSecret: SECRET });
    expect(() => loadStaffMpConfig({ STAFFMP_APPID: APPID }, 'production', taken)).toThrow(/一起配/);
    expect(() => loadStaffMpConfig({ STAFFMP_APPID: 'abc', STAFFMP_APP_SECRET: SECRET }, 'production', taken)).toThrow(/AppID/);
    expect(() => loadStaffMpConfig({ STAFFMP_APPID: APPID, STAFFMP_APP_SECRET: 'short' }, 'production', taken)).toThrow(/AppSecret/);
  });

  it('模拟微信只在开发、测试环境认', () => {
    expect(loadStaffMpConfig({ STAFFMP_MOCK_WECHAT: 'true' }, 'development', taken).mockWechat).toBe(true);
    expect(loadStaffMpConfig({ STAFFMP_MOCK_WECHAT: 'true' }, 'test', taken).mockWechat).toBe(true);
    expect(loadStaffMpConfig({ STAFFMP_MOCK_WECHAT: 'true' }, 'production', taken).mockWechat).toBe(false);
    expect(loadStaffMpConfig({ STAFFMP_MOCK_WECHAT: 'true' }, 'trial', taken).mockWechat).toBe(false);
  });
});

const cfg = (over: Partial<StaffMpConfig> = {}): StaffMpConfig => ({ port: null, host: '0.0.0.0', appId: null, appSecret: null, mockWechat: false, trustProxy: [], ...over });
const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('微信 code 换 openid', () => {
  it('模拟微信：mock-<名字> 换成 mock_<名字>，别的写法拒绝', async () => {
    const c2s = code2sessionFor(cfg({ mockWechat: true }));
    expect(wechatReady(cfg({ mockWechat: true }))).toBe(true);
    await expect(c2s('mock-alice')).resolves.toBe('mock_alice');
    await expect(c2s('alice')).rejects.toMatchObject({ code: 'WECHAT_CODE_INVALID' });
  });

  it('没配 AppID：不能微信一键登录', async () => {
    expect(wechatReady(cfg())).toBe(false);
    await expect(code2sessionFor(cfg())('0a1b2c3d4e5f')).rejects.toMatchObject({ code: 'WECHAT_NOT_CONFIGURED' });
  });

  it('微信回 openid 就用它；code 失效、连不上、别的错误各有说法', async () => {
    const real = cfg({ appId: APPID, appSecret: SECRET });
    let asked = '';
    const ok = (async (url: string) => {
      asked = url;
      return new Response(JSON.stringify({ openid: 'oABC', session_key: 'k' }));
    }) as unknown as typeof fetch;
    await expect(code2sessionFor(real, ok)('0a1b2c3d4e5f')).resolves.toBe('oABC');
    expect(asked).toContain(`appid=${APPID}`);
    expect(asked).toContain('js_code=0a1b2c3d4e5f');
    await expect(code2sessionFor(real, reply({ errcode: 40163, errmsg: 'code been used' }))('0a1b2c3d4e5f')).rejects.toMatchObject({ code: 'WECHAT_CODE_INVALID' });
    await expect(code2sessionFor(real, reply({ errcode: -1 }))('0a1b2c3d4e5f')).rejects.toMatchObject({ code: 'WECHAT_REJECTED' });
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(code2sessionFor(real, down)('0a1b2c3d4e5f')).rejects.toMatchObject({ code: 'WECHAT_UNREACHABLE' });
    await expect(code2sessionFor(real, ok)('bad code!')).rejects.toMatchObject({ code: 'WECHAT_CODE_INVALID' });
  });
});

describe('短时地址的票据', () => {
  const h = 'a'.repeat(64);
  it('附件 10 分钟、培训资料 4 小时内认（视频边放边取，不能放到一半断），过期、改了内容或签名都不认', () => {
    const now = Date.parse('2026-11-27T10:00:00Z');
    const a = issueTicket({ h, k: 'attachment', i: 7, v: null }, now);
    expect(a.expiresAt).toBe(new Date(now + TICKET_TTL_SECONDS * 1000).toISOString());
    expect(verifyTicket(a.ticket, now + (TICKET_TTL_SECONDS + 1) * 1000)).toBeNull();
    const { ticket, expiresAt } = issueTicket({ h, k: 'training', i: 7, v: 3 }, now);
    expect(expiresAt).toBe(new Date(now + TRAINING_TICKET_TTL_SECONDS * 1000).toISOString());
    expect(verifyTicket(ticket, now + 1000)).toMatchObject({ h, k: 'training', i: 7, v: 3 });
    expect(verifyTicket(ticket, now + 3 * 3600 * 1000)).not.toBeNull();
    expect(verifyTicket(ticket, now + (TRAINING_TICKET_TTL_SECONDS + 1) * 1000)).toBeNull();
    const [body, sig] = ticket.split('.');
    const other = Buffer.from(JSON.stringify({ h, k: 'training', i: 8, v: 3, e: Math.floor(now / 1000) + 600 })).toString('base64url');
    expect(verifyTicket(`${other}.${sig}`, now)).toBeNull();
    expect(verifyTicket(`${body}.x${sig!.slice(1)}`, now)).toBeNull();
    expect(verifyTicket('nonsense', now)).toBeNull();
  });

  it('改写成原来的接口地址：培训文件带版本，附件、缩略图不带', () => {
    const t = issueTicket({ h, k: 'training', i: 7, v: 3 }).ticket;
    expect(mediaRewrite(`/api/staffmp/media/${t}`)).toBe(`/api/training/files/7/content?v=3&__ticket=${encodeURIComponent(t)}`);
    const a = issueTicket({ h, k: 'thumb', i: 9, v: null }).ticket;
    expect(mediaRewrite(`/api/staffmp/media/${a}`)).toBe(`/api/oa/attachments/9/thumb?__ticket=${encodeURIComponent(a)}`);
    expect(mediaRewrite('/api/staffmp/media/../../x')).toBeNull();
    expect(mediaRewrite('/api/staffmp/me')).toBeNull();
  });
});
