// 连员工小程序端口（docs/STAFF_MP.md 第 5、6 节）：所有接口都在 /api/staffmp/ 下，带 Authorization: Bearer <令牌>。
//   · 令牌是门店系统发的员工会话（12 小时滑动过期）；过期（401）时先悄悄用微信重新登录一次再重发（session.ts 交进来的 relogin），
//     重新登录不了（没绑微信、主动退出过）就交给页面去登录页；
//   · 门店明确没处理的忙（409 BUSY、503 OVERLOADED、429 RATE_LIMITED）带原编号短暂自动重发两次，调用方不要再叠一层；
//   · 连不上（NETWORK）照实说，不当成「没有生效」：写操作的页面按「结果待确认」处理（第 2.8 节）。
// 门店系统回的错误文字面向员工，原样显示。

import { apiBase } from '../config/env';

export const PREFIX = '/api/staffmp';

export interface ApiError {
  readonly api: true;
  /** 门店系统的错误码；NETWORK = 连不上门店系统 */
  code: string;
  message: string;
  status: number;
}

export function apiError(code: string, message: string, status: number): ApiError {
  return { api: true, code, message, status };
}

export function isApiError(e: unknown): e is ApiError {
  return typeof e === 'object' && e !== null && (e as { api?: unknown }).api === true;
}

/** 连不上门店系统（手机没网、门店系统没开） */
export function isOffline(e: unknown): boolean {
  return isApiError(e) && e.code === 'NETWORK';
}

/** 服务端明确拒绝了（4xx，不是忙）：说明这次没有生效 */
export function isRejected(e: unknown): boolean {
  return isApiError(e) && e.status >= 400 && e.status < 500 && !['BUSY', 'RATE_LIMITED'].includes(e.code);
}

/** 给页面显示的一句话 */
export function messageOf(e: unknown): string {
  if (isApiError(e)) return e.message;
  return '出了点问题，请稍后再试';
}

interface Raw {
  status: number;
  data: unknown;
  retryAfterMs?: number;
}

type Method = 'GET' | 'POST' | 'PUT';

function send(method: Method, path: string, body: Record<string, unknown> | undefined, token: string | null): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const header: Record<string, string> = { 'content-type': 'application/json' };
    if (token) header.authorization = 'Bearer ' + token;
    wx.request({
      url: apiBase() + PREFIX + path,
      method,
      // 写操作一律带 JSON（空的也写 {}）
      data: method === 'GET' ? undefined : body || {},
      header,
      timeout: 15000,
      success: (res) => {
        const h = (res.header || {}) as Record<string, string>;
        const ra = Number(h['retry-after'] || h['Retry-After'] || '');
        resolve({ status: res.statusCode, data: res.data, retryAfterMs: isFinite(ra) && ra > 0 ? ra * 1000 : undefined });
      },
      fail: () => reject(apiError('NETWORK', '现在连不上门店系统，请到信号好的地方再试', 0)),
    });
  });
}

export function errorOf(status: number, data: unknown): ApiError {
  const body = data && typeof data === 'object' ? (data as { error?: { code?: unknown; message?: unknown } }) : {};
  const e = body.error;
  const code = e && typeof e.code === 'string' ? e.code : status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
  const message = e && typeof e.message === 'string' && e.message ? e.message : '门店系统出了点问题，请稍后再试';
  return apiError(code, message, status);
}

const ok = (r: Raw) => r.status >= 200 && r.status < 300;

const MAX_BUSY_RESENDS = 2;
let customDelay: ((attempt: number, retryAfterMs?: number) => number) | null = null;
/** 测试用：换掉重发前等多久 */
export function setRetryDelayForTest(fn: ((attempt: number, retryAfterMs?: number) => number) | null): void {
  customDelay = fn;
}
function busyDelay(attempt: number, retryAfterMs?: number): number {
  if (customDelay) return customDelay(attempt, retryAfterMs);
  if (retryAfterMs !== undefined) return Math.round(Math.min(retryAfterMs, 1500) * (0.75 + Math.random() * 0.25));
  return Math.round(300 * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5));
}
const BUSY = ['BUSY', 'OVERLOADED', 'RATE_LIMITED'];

async function sendWithBusyRetry(method: Method, path: string, body: Record<string, unknown> | undefined, token: string | null): Promise<Raw> {
  for (let attempt = 0; ; attempt++) {
    const r = await send(method, path, body, token);
    if (ok(r) || !BUSY.includes(errorOf(r.status, r.data).code) || attempt >= MAX_BUSY_RESENDS) return r;
    await new Promise((res) => setTimeout(res, busyDelay(attempt, r.retryAfterMs)));
  }
}

// ── 令牌 ──

const TOKEN_KEY = 'wcp_token';

export function storedToken(): string | null {
  try {
    const t = wx.getStorageSync(TOKEN_KEY) as string;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  try {
    wx.setStorageSync(TOKEN_KEY, token);
  } catch {
    // 存不了：这次照用（内存里的），下次打开重新登录
  }
  memoryToken = token;
}

export function clearToken(): void {
  memoryToken = null;
  try {
    wx.removeStorageSync(TOKEN_KEY);
  } catch {
    // 删不了：下次登录覆盖
  }
}

let memoryToken: string | null = null;
const currentToken = () => memoryToken || storedToken();
/** 有没有能用的令牌（存着的，或手机存不下时记在内存里的） */
export const hasToken = () => !!currentToken();

/** 令牌过期时怎么悄悄重新登录（session.ts 交进来；登录成功返回 true） */
let relogin: (() => Promise<boolean>) | null = null;
let relogging: Promise<boolean> | null = null;
export function setRelogin(fn: (() => Promise<boolean>) | null): void {
  relogin = fn;
}
function reloginOnce(): Promise<boolean> {
  if (!relogin) return Promise.resolve(false);
  if (!relogging) {
    relogging = relogin().then(
      (v) => {
        relogging = null;
        return v;
      },
      () => {
        relogging = null;
        return false;
      },
    );
  }
  return relogging;
}

/** 门店系统说「先改密码 / 先选岗位」时怎么办（session.ts 交进来：改「我是谁」的标记、去那一页） */
let gate: ((code: string) => void) | null = null;
export function setGate(fn: ((code: string) => void) | null): void {
  gate = fn;
}
const GATE_CODES = ['PASSWORD_CHANGE_REQUIRED', 'POSITION_REQUIRED'];

/** 要登录的接口：令牌过期时悄悄用微信重新登录、重发一次；还是不行抛 401 UNAUTHORIZED（页面去登录页） */
export async function call<T>(method: Method, path: string, body?: Record<string, unknown>): Promise<T> {
  if (!currentToken() && !(await reloginOnce())) throw apiError('UNAUTHORIZED', '请先登录', 401);
  const used = currentToken();
  let r = await sendWithBusyRetry(method, path, body, used);
  if (r.status === 401) {
    if (currentToken() === used) {
      // 这个令牌确实不认了：清掉、悄悄重新登录一次
      clearToken();
      if (await reloginOnce()) r = await sendWithBusyRetry(method, path, body, currentToken());
    } else if (currentToken()) {
      // 这期间别的请求已经换上了新令牌：用新的重发，不清掉它
      r = await sendWithBusyRetry(method, path, body, currentToken());
    }
  }
  if (ok(r)) return r.data as T;
  const error = errorOf(r.status, r.data);
  if (r.status === 403 && GATE_CODES.indexOf(error.code) >= 0 && gate) gate(error.code);
  throw error;
}

/** 用指定的令牌发一次（不悄悄重新登录、不动存着的令牌）：退掉一个不该留的会话用 */
export async function callAs<T>(token: string, method: Method, path: string, body?: Record<string, unknown>): Promise<T> {
  const r = await sendWithBusyRetry(method, path, body, token);
  if (ok(r)) return r.data as T;
  throw errorOf(r.status, r.data);
}

/** 不用登录的接口（info、登录本身） */
export async function publicCall<T>(method: Method, path: string, body?: Record<string, unknown>): Promise<T> {
  const r = await sendWithBusyRetry(method, path, body, null);
  if (ok(r)) return r.data as T;
  throw errorOf(r.status, r.data);
}

/** 带令牌下载文件到手机（培训资料、附件）：微信的 downloadFile 能带请求头 */
export function download(path: string, onProgress?: (percent: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const token = currentToken();
    const task = wx.downloadFile({
      url: apiBase() + PREFIX + path,
      header: token ? { authorization: 'Bearer ' + token } : {},
      // 大文件（最大 200MB）慢慢下：给 10 分钟
      timeout: 600000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.tempFilePath);
        else if (res.statusCode === 401) reject(apiError('UNAUTHORIZED', '登录过期了，请重新打开', 401));
        else if (res.statusCode === 409) reject(apiError('VERSION_CHANGED', '这份资料刚换了新版本，已经重新打开，请再点一次', 409));
        else reject(apiError('DOWNLOAD_FAILED', '文件没有下载下来，请稍后再试', res.statusCode));
      },
      fail: () => reject(apiError('NETWORK', '现在连不上门店系统，请到信号好的地方再试', 0)),
    });
    if (onProgress) task.onProgressUpdate((p) => onProgress(p.progress));
  });
}

/** 门店系统上的完整地址（短时地址给 video、image 用） */
export function absoluteUrl(path: string): string {
  return apiBase() + path;
}
