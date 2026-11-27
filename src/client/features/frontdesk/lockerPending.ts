// 柜锁「结果待确认」的本机记录（Codex 审查 34a7c87，docs/LOCKERS_V8149.md 第 6.4、7.3 节）：
// 发卡器写卡、清卡与释放手机柜，发请求以前先记在本机并读回核对，存不了就不发（AGENTS.md 开发约定）；明确做成、明确没做成才删，
// 没收到回答（桥没回答、浏览器没收到门店系统的回话）的留着，页面列出来：发卡器的读卡核对（settleLockerCardPending），
// 手机柜的等列表刷新核对（settleLockerSelectPending），有结论再删。
// 这几样都没有操作编号：再做一次对卡、对柜子没坏处，核对靠看卡上、锁上现在的样子，不靠重提。

import { useSyncExternalStore } from 'react';
import type { LockerPending } from '@shared/lockers';

const KEY = 'yuzu.lockers.cardPending';
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: LockerPending[] = [];

function readAll(): LockerPending[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as LockerPending[]) : [];
    cached = Array.isArray(parsed) ? parsed : [];
  } catch {
    cached = [];
  }
  return cached;
}

function persist(list: LockerPending[]): boolean {
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

export const lockerPending = {
  /**
   * 发请求以前记下；存不了（或读回对不上）返回 false，调用方不发。
   * 不设条数上限、不挤掉旧的：没核对的那一次可能已经改了卡、放了柜，提醒不能自己消失（Codex 审查 b446d09）
   */
  add(p: LockerPending): boolean {
    return persist([...readAll().filter((x) => x.id !== p.id), p]);
  },
  /** 此刻本机记着的（不经渲染：同一轮里刚记下、刚删掉的也看得到） */
  list(): LockerPending[] {
    return readAll();
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
export function useLockerPending(storeId: number): LockerPending[] {
  const all = useSyncExternalStore(subscribe, readAll, readAll);
  return all.filter((p) => p.storeId === storeId);
}
