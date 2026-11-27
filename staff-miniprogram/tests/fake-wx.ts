// 单元测试里假的 wx：本机存储、请求（按顺序回事先排好的回复）、登录、版本信息。

export interface FakeReply {
  status: number;
  data?: unknown;
  header?: Record<string, string>;
  /** 连不上 */
  fail?: boolean;
}

export interface Sent {
  url: string;
  method: string;
  data: unknown;
  header: Record<string, string>;
}

export function installFakeWx(opts: { envVersion?: 'develop' | 'trial' | 'release' } = {}) {
  const storage = new Map<string, unknown>();
  const replies: FakeReply[] = [];
  const sent: Sent[] = [];
  let loginCode = 'wxcode123456';
  const wx = {
    getStorageSync: (k: string) => (storage.has(k) ? storage.get(k) : ''),
    setStorageSync: (k: string, v: unknown) => void storage.set(k, v),
    removeStorageSync: (k: string) => void storage.delete(k),
    getStorageInfoSync: () => ({ keys: [...storage.keys()], currentSize: 0, limitSize: 10240 }),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: opts.envVersion ?? 'develop', version: '' } }),
    login: (o: { success: (r: { code: string }) => void }) => o.success({ code: loginCode }),
    request: (o: { url: string; method: string; data: unknown; header: Record<string, string>; success: (r: unknown) => void; fail: () => void }) => {
      sent.push({ url: o.url, method: o.method, data: o.data, header: o.header });
      const r = replies.shift();
      if (!r) throw new Error(`没有排好回复：${o.method} ${o.url}`);
      if (r.fail) o.fail();
      else o.success({ statusCode: r.status, data: r.data, header: r.header ?? {} });
    },
  };
  (globalThis as unknown as { wx: unknown }).wx = wx;
  return {
    storage,
    sent,
    reply: (...r: FakeReply[]) => void replies.push(...r),
    pending: () => replies.length,
    setLoginCode: (c: string) => {
      loginCode = c;
    },
  };
}
