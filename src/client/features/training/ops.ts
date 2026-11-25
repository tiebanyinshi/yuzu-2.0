// 员工培训后台的「改资料」写操作（新建 / 修改文件夹、修改文件信息）的结果待确认（Codex 审查 a3f5310，AGENTS.md 开发约定）：
// 发请求以前把原请求存进本机并读回核对，存不了就不发；成功或服务端明确拒绝才删。
// 没收到结果（超时、断网、5xx）的留着，「WCP 设置 → 员工培训」顶上列出来，可以原样重提：
//   · 新建文件夹带操作编号，原样重提返回原来那个；
//   · 修改带页面看到的版本号，原样重提时服务端发现现在的内容就是这次要改成的，按改好了算。

import { useSyncExternalStore } from 'react';
import { api, isRejected } from '../../lib/api';

export interface TrainingOp {
  key: string;
  method: 'POST' | 'PUT';
  url: string;
  body: unknown;
  /** 列表里显示：如「新建文件夹「安保」」 */
  summary: string;
  createdAt: string;
}

const STORE = 'yuzu.trainingOps.v1';
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedList: TrainingOp[] = [];

function readAll(): TrainingOp[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORE);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as TrainingOp[]) : [];
    cachedList = Array.isArray(parsed) ? parsed : [];
  } catch {
    cachedList = [];
  }
  return cachedList;
}

function persist(list: TrainingOp[]): boolean {
  const raw = list.length ? JSON.stringify(list) : null;
  try {
    if (raw === null) localStorage.removeItem(STORE);
    else localStorage.setItem(STORE, raw);
    return localStorage.getItem(STORE) === raw;
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
  const onStorage = (e: StorageEvent) => e.key === STORE && l();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
};

export function useTrainingOps(): TrainingOp[] {
  return useSyncExternalStore(subscribe, readAll, () => cachedList);
}

/** 发一次（新的或原样重提）：成功、服务端明确拒绝才删本机记录；没收到结果的留着 */
export async function sendTrainingOp<T>(op: Omit<TrainingOp, 'createdAt'> & { createdAt?: string }): Promise<T> {
  const list = readAll();
  if (!list.some((x) => x.key === op.key) && !persist([...list, { ...op, createdAt: op.createdAt ?? new Date().toISOString() }]))
    throw new Error('本机浏览器保存不了这次修改的记录（存储空间已满或被禁用），为防止结果不明，这次没有提交。请清理浏览器数据或换一台电脑。');
  try {
    const r = op.method === 'POST' ? await api.post<T>(op.url, op.body) : await api.put<T>(op.url, op.body);
    remove(op.key);
    return r;
  } catch (e) {
    if (isRejected(e)) remove(op.key);
    throw e;
  }
}
