// 发卡器「结果待确认」的本机记录（Codex 审查 34a7c87，docs/LOCKERS_V8149.md 第 6.4 节）：
// 写卡、清卡发请求以前先记在本机并读回核对，存不了就不发（AGENTS.md 开发约定）；明确做成、明确没做成才删，
// 没收到回答（桥没回答、浏览器没收到门店系统的回话）的留着，发卡器下面列出来，读卡核对出结论再删（settleLockerCardPending）。
// 写卡、清卡没有操作编号：再写一次、再清一次对卡没坏处，核对靠读卡看卡上现在的样子，不靠重提。

import { useSyncExternalStore } from 'react';
import type { LockerCardPending } from '@shared/lockers';

const KEY = 'yuzu.lockers.cardPending';
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: LockerCardPending[] = [];

function readAll(): LockerCardPending[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as LockerCardPending[]) : [];
    cached = Array.isArray(parsed) ? parsed : [];
  } catch {
    cached = [];
  }
  return cached;
}

function persist(list: LockerCardPending[]): boolean {
  const raw = list.length ? JSON.stringify(list) : null;
  try {
    if (raw === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, raw);
    return localStorage.getItem(KEY) === raw;
  } catch {
    return false;
  } finally {
    listeners.forEach((l) => l());
  }
}

export const lockerCardPending = {
  /**
   * 发请求以前记下；存不了（或读回对不上）返回 false，调用方不发。
   * 不设条数上限、不挤掉旧的：没核对的那一次可能已经改了卡，提醒不能自己消失（Codex 审查 b446d09）
   */
  add(p: LockerCardPending): boolean {
    return persist([...readAll().filter((x) => x.id !== p.id), p]);
  },
  remove(id: string): void {
    const list = readAll();
    if (list.some((x) => x.id === id)) persist(list.filter((x) => x.id !== id));
  },
};

function subscribe(fn: () => void) {
  listeners.add(fn);
  // 同一台电脑开着两个柜况页：另一页记的、删的这里也跟着变
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** 这家店没核对的写卡、清卡（换店登录只列本店的） */
export function useLockerCardPending(storeId: number): LockerCardPending[] {
  const all = useSyncExternalStore(subscribe, readAll, readAll);
  return all.filter((p) => p.storeId === storeId);
}
