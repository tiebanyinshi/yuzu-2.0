// 登录与「我是谁」（docs/STAFF_MP.md 第 6 节、第 2.8 节）：
//   · 打开小程序：先用手机上存的「我是谁」把页面画出来（没信号也能看上次的样子），同时在后台刷新；
//   · 令牌过期：悄悄用微信重新登录（这个微信绑过账号的），员工感觉不到；
//   · 员工主动退出过：不再悄悄登录（不然一退出又自己进去了），登录页上点「微信一键登录」才进；
//   · 模拟微信（门店系统报告 mockWechat，只在开发版、体验版）：code 写 mock-<这台手机的名字>。

import type { StaffMpInfo, StaffMpLoginReply, StaffMpMe, StaffMpWechatReply } from '../../../src/shared/staffmp';
import { envVersion } from '../config/env';
import { apiError, call, callAs, clearToken, hasToken, isOffline, messageOf, publicCall, saveToken, setGate, setRelogin, tokenNow } from './api';

const ME_KEY = 'wcp_me';
const SIGNED_OUT_KEY = 'wcp_signed_out';
const MOCK_USER_KEY = 'wcp_mock_user';

let me: StaffMpMe | null = null;
const listeners: ((m: StaffMpMe | null) => void)[] = [];

function read<T>(key: string): T | null {
  try {
    const v = wx.getStorageSync(key) as T | '';
    return v === '' ? null : v;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown): void {
  try {
    wx.setStorageSync(key, value);
  } catch {
    // 存不了：只是下次打开要重新取
  }
}
function remove(key: string): void {
  try {
    wx.removeStorageSync(key);
  } catch {
    // 删不了：下次覆盖
  }
}

/** 现在的「我是谁」：内存里的，没有就用手机上存的（上次打开时的） */
export function currentMe(): StaffMpMe | null {
  if (!me) me = read<StaffMpMe>(ME_KEY);
  return me;
}

/** 按人的缓存（知识库的文件夹、最近搜过的）：退出、换了人就清掉，下一位看不到上一位的 */
const USER_CACHES = ['wcp_learn_folders', 'wcp_learn_recent', 'wcp_academy_home'];

function setMe(next: StaffMpMe | null): void {
  const prev = me ?? read<StaffMpMe>(ME_KEY);
  if ((prev ? prev.staff.id : null) !== (next ? next.staff.id : null)) for (const k of USER_CACHES) remove(k);
  me = next;
  if (next) write(ME_KEY, next);
  else remove(ME_KEY);
  for (const fn of listeners.slice()) {
    try {
      fn(next);
    } catch {
      // 一个页面出错不挡别的
    }
  }
}

/** 「我是谁」变了时通知（登录、退出、改密码、刷新） */
export function watchMe(fn: (m: StaffMpMe | null) => void): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** 有没有令牌（登录过、还没退出）：与发请求用的是同一个（手机存不下时这次打开记在内存里的也算） */
export function hasSession(): boolean {
  return hasToken();
}

/** 员工主动退出过（登录页不自动用微信进） */
export function signedOut(): boolean {
  return read<boolean>(SIGNED_OUT_KEY) === true;
}

// ── 门店系统的基本信息 ──

let infoCache: StaffMpInfo | null = null;
export async function info(fresh = false): Promise<StaffMpInfo> {
  if (infoCache && !fresh) return infoCache;
  infoCache = await publicCall<StaffMpInfo>('GET', '/info');
  return infoCache;
}

// ── 微信 ──

function randomName(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += 'abcdefghijkmnpqrstuvwxyz23456789'.charAt(Math.floor(Math.random() * 32));
  return s;
}

/** 模拟的微信用户：一台手机一个（开发版、体验版连「模拟微信」的门店系统时） */
export function mockUser(): string {
  let name = read<string>(MOCK_USER_KEY) || '';
  if (!name) {
    name = 'dev' + randomName();
    write(MOCK_USER_KEY, name);
  }
  return name;
}

function wxLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (r) => (r.code ? resolve(r.code) : reject(apiError('WX_LOGIN_FAILED', '微信登录没成功，请稍后再试', 0))),
      fail: () => reject(apiError('WX_LOGIN_FAILED', '微信登录没成功，请稍后再试', 0)),
    });
  });
}

/** 这次登录用的微信凭证：模拟微信只在开发版、体验版 */
export async function wechatCode(): Promise<string> {
  const i = await info();
  if (i.mockWechat && envVersion() !== 'release') return 'mock-' + mockUser();
  return wxLoginCode();
}

// ── 登录 ──

function signedIn(token: string, next: StaffMpMe): void {
  saveToken(token, next.staff.id);
  remove(SIGNED_OUT_KEY);
  setMe(next);
}

/** 微信一键进：绑过的进去了返回 true；没绑过返回 false（去账号密码登录） */
export async function wechatLogin(): Promise<boolean> {
  const i = await info();
  if (!i.wechat) return false;
  const r = await publicCall<StaffMpWechatReply>('POST', '/auth/wechat', { code: await wechatCode(), mode: 'login' });
  if (r.status !== 'ok') return false;
  signedIn(r.token, r.me);
  return true;
}

/** 只看看这个微信绑着谁（退出以后的登录页：决定「以后用这个微信直接进」默认勾不勾） */
export async function peekWechat(): Promise<{ bound: false } | { bound: true; displayName: string }> {
  const i = await info();
  if (!i.wechat) return { bound: false };
  const r = await publicCall<StaffMpWechatReply>('POST', '/auth/wechat', { code: await wechatCode(), mode: 'peek' });
  return r.status === 'bound' ? { bound: true, displayName: r.displayName } : { bound: false };
}

/** 账号密码登录；bind = 以后用这个微信直接进；replace = 这个微信绑着别人、员工确认了改绑 */
export async function passwordLogin(username: string, password: string, opts: { bind: boolean; replace: boolean }): Promise<StaffMpLoginReply> {
  let code: string | undefined;
  if (opts.bind) {
    try {
      code = await wechatCode();
    } catch {
      // 拿不到微信凭证：照样登录，只是这次不绑
      code = undefined;
    }
  }
  const r = await publicCall<StaffMpLoginReply>('POST', '/auth/login', { username, password, bind: opts.bind && !!code, replace: opts.replace, ...(code ? { code } : {}) });
  signedIn(r.token, r.me);
  return r;
}

/** 刷新「我是谁」（打开小程序、回到前台时） */
export async function refreshMe(): Promise<StaffMpMe> {
  const before = currentMe();
  const next = await call<StaffMpMe>('GET', '/me');
  const now = currentMe();
  // 这期间退出了、换了人登录：晚回来的不盖上去
  if (!hasToken() || (before && !now) || (now && now.staff.id !== next.staff.id)) return next;
  setMe(next);
  return next;
}

/** 改完密码：门店系统回新的「我是谁」 */
export function updateMe(next: StaffMpMe): void {
  setMe(next);
}

/**
 * 退出；unbind = 同时解开这个微信。
 *   · 只退出：不论门店系统回没回，手机上都退出（令牌留在门店系统里，12 小时后自己过期）；
 *   · 退出并解开：解开要确认——没收到回复时问门店系统「这个微信还绑着没有」，还绑着或问不到就报错、手机上不退出
 *     （不然别人拿这台手机还能一键进），员工连上以后再点一次
 */
/** 第几次「主动退出」：退出时加一，之前开始的悄悄重新登录回来对不上就作废（不把人又登录回去） */
let authGen = 0;

export async function logout(unbind: boolean): Promise<void> {
  let failure: unknown = null;
  try {
    // 只退出：用手机上现在的令牌直接退（不悄悄重新登录——退出时不该再登录一次；没有令牌就不用退门店那边）；
    // 退出并解开：要一个能用的会话（过期了悄悄重新登录以后再解开）
    const token = tokenNow();
    const r = unbind
      ? await call<{ ok: boolean; unbound?: boolean }>('POST', '/auth/logout', { unbind })
      : token
        ? await callAs<{ ok: boolean; unbound?: boolean }>(token, 'POST', '/auth/logout', { unbind })
        : { ok: true };
    // 门店系统明说解开了才算；没说（旧版本门店系统）就去问
    if (unbind && r.unbound !== true) failure = apiError('UNBIND_UNKNOWN', '门店系统没说解开了没有', 0);
  } catch (e) {
    failure = e;
  }
  if (unbind && failure) {
    let stillBound = true;
    try {
      stillBound = (await peekWechat()).bound;
    } catch {
      stillBound = true;
    }
    if (stillBound) throw apiError('UNBIND_UNCONFIRMED', `没解开这个微信：${isOffline(failure) ? '现在连不上门店系统' : messageOf(failure)}。连上以后再点一次`, 0);
  }
  authGen += 1;
  clearToken({ signedOut: true });
  write(SIGNED_OUT_KEY, true);
  setMe(null);
}

/**
 * 令牌过期时悄悄重新登录：主动退出过的不登录；**只认同一个人**——在同事的手机上「只登录这一次」的，过期以后
 * 这个微信一键进的是手机主人，不能悄悄换成别人（换了人，没收到回复的写操作会以别人的身份重发）：换了人就当没登录上，
 * 那一个会话当场退掉，页面去登录页
 */
export async function silentRelogin(): Promise<boolean> {
  if (signedOut()) return false;
  const gen = authGen;
  const expected = currentMe()?.staff.id ?? null;
  const i = await info();
  if (!i.wechat) return false;
  const r = await publicCall<StaffMpWechatReply>('POST', '/auth/wechat', { code: await wechatCode(), mode: 'login' });
  if (r.status !== 'ok') return false;
  // 这期间员工主动退出了：这个会话不要了（退掉），不把人又登录回去
  if (gen !== authGen || signedOut()) {
    try {
      await callAs(r.token, 'POST', '/auth/logout', { unbind: false });
    } catch {
      // 退不掉：那个会话 12 小时后自己过期
    }
    return false;
  }
  if (expected !== null && r.me.staff.id !== expected) {
    // 用那个令牌直接退掉（不存、不放进共用的位置：这期间别的请求不会以别人的身份发出去）
    try {
      await callAs(r.token, 'POST', '/auth/logout', { unbind: false });
    } catch {
      // 退不掉：那个会话 12 小时后自己过期
    }
    clearToken();
    return false;
  }
  signedIn(r.token, r.me);
  return true;
}

/** 门店系统说「先改密码 / 先选岗位」（管理员重置了密码、岗位改了）：改「我是谁」的标记，去那一页（已经在那一页就不动） */
setGate((code) => {
  const cur = currentMe();
  if (cur) setMe({ ...cur, mustChangePassword: code === 'PASSWORD_CHANGE_REQUIRED' ? true : cur.mustChangePassword, needsPosition: code === 'POSITION_REQUIRED' ? true : cur.needsPosition });
  const url = code === 'PASSWORD_CHANGE_REQUIRED' ? '/pages/password/index?first=1' : '/pages/position/index';
  let top = '';
  try {
    const pages = getCurrentPages();
    top = pages.length ? pages[pages.length - 1]!.route : '';
  } catch {
    top = '';
  }
  if (!top || url.indexOf(`/${top}`) < 0) wx.reLaunch({ url });
});

setRelogin(async () => {
  try {
    return await silentRelogin();
  } catch {
    return false;
  }
});
