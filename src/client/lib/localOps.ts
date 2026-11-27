// 「结果待确认」的本机记录（员工培训后台 Codex 审查 a3f5310、汤崎学堂共用；AGENTS.md 开发约定）：
// 发请求以前把原请求存进本机并读回核对，存不了就不发；成功或服务端明确拒绝才删（重提被拒绝时要能断定结果才删，见 SETTLED_ON_RETRY）。
// 没确认的编号只能原样重提，换了内容的不发（见 send）。
// 没收到结果（超时、断网、5xx）的留着，页面上列出来原样重提。用它的接口都要能原样重提：
//   · 新建带操作编号，原样重提返回原来那个；
//   · 修改带页面看到的版本号，原样重提时服务端发现现在的内容就是这次要改成的，按改好了算。

import { useSyncExternalStore } from 'react';
import { api, isRejected } from './api';

export interface LocalOp {
  key: string;
  method: 'POST' | 'PUT';
  url: string;
  body: unknown;
  /** 列表里显示：如「新建文件夹「安保」」 */
  summary: string;
  createdAt: string;
}

/**
 * 原样重提被拒绝时，哪些回答能断定结果（Codex 审查 f5de374）：
 *   · 409 / 404 / 400 / 422：重提的就是原请求，新建带操作编号（已登记会原样返回原来那个）、修改发现现在就是要改成的会按改好了算，
 *     所以被这些拒绝说明原来那次没生效、或者之后又被别人改了，再等也不会变；
 *   · 401（登录过期）、403（没权限）、429（太频繁）等不能断定原来那次有没有生效：记录留着，登录或换人以后再重提。
 */
const SETTLED_ON_RETRY = new Set([400, 404, 409, 422]);

/** 同一个操作编号只能原样重提（Codex 审查 34b9815）：方法、地址、内容都要和存着的那份一样 */
const sameRequest = (a: Pick<LocalOp, 'method' | 'url' | 'body'>, b: Pick<LocalOp, 'method' | 'url' | 'body'>) =>
  a.method === b.method && a.url === b.url && JSON.stringify(a.body) === JSON.stringify(b.body);

/** 一个本机存储键一套记录（各模块分开放，列表里只列自己的） */
export function createLocalOps(store: string) {
  const listeners = new Set<() => void>();
  let cachedRaw: string | null | undefined;
  let cachedList: LocalOp[] = [];

  function readAll(): LocalOp[] {
    let raw: string | null;
    try {
      raw = localStorage.getItem(store);
    } catch {
      raw = null;
    }
    if (raw === cachedRaw) return cachedList;
    cachedRaw = raw;
    try {
      const parsed = raw ? (JSON.parse(raw) as LocalOp[]) : [];
      cachedList = Array.isArray(parsed) ? parsed : [];
    } catch {
      cachedList = [];
    }
    return cachedList;
  }

  function persist(list: LocalOp[]): boolean {
    const raw = list.length ? JSON.stringify(list) : null;
    try {
      if (raw === null) localStorage.removeItem(store);
      else localStorage.setItem(store, raw);
      return localStorage.getItem(store) === raw;
    } catch {
      return false;
    } finally {
      listeners.forEach((l) => l());
    }
  }

  const remove = (key: string) => {
    const list = readAll();
    if (list.some((x) => x.key === key)) persist(list.filter((x) => x.key !== key));
  };

  const subscribe = (l: () => void) => {
    listeners.add(l);
    const onStorage = (e: StorageEvent) => e.key === store && l();
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(l);
      window.removeEventListener('storage', onStorage);
    };
  };

  return {
    /** 本机没确认的记录 */
    useOps: (): LocalOp[] => useSyncExternalStore(subscribe, readAll, () => cachedList),
    /**
     * 发一次（新的或原样重提）：成功、第一次就被服务端明确拒绝、重提被能断定结果的回答拒绝，才删本机记录；没收到结果的留着。
     * 这个编号还没确认、内容却变了（对话框里改了再点保存）：不发——服务端会按「同一编号内容不同」拒绝，本机记录跟着被删，
     * 原来那次到底生效没有就再也核对不了。原来那份照旧留着，页面上方原样重提。
     */
    async send<T>(op: Omit<LocalOp, 'createdAt'> & { createdAt?: string }): Promise<T> {
      const list = readAll();
      const prior = list.find((x) => x.key === op.key);
      const retry = !!prior;
      if (prior && !sameRequest(prior, op)) throw new Error(`「${prior.summary}」上次没收到结果，同一笔只能按原内容重新提交：请先在页面上方「没收到结果」的提醒里原样重提，确认以后再改。`);
      if (!retry && !persist([...list, { ...op, createdAt: op.createdAt ?? new Date().toISOString() }]))
        throw new Error('本机浏览器保存不了这次操作的记录（存储空间已满或被禁用），为防止结果不明，这次没有提交。请清理浏览器数据或换一台电脑。');
      try {
        const r = op.method === 'POST' ? await api.post<T>(op.url, op.body) : await api.put<T>(op.url, op.body);
        remove(op.key);
        return r;
      } catch (e) {
        if (isRejected(e) && (!retry || SETTLED_ON_RETRY.has(e.status))) remove(op.key);
        throw e;
      }
    },
  };
}
