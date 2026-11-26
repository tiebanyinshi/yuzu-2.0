// 智能柜锁控制器（8.1.49，docs/LOCKERS_V8149.md 第 3 节）：采购清单里还没有柜锁控制器（D8），先把接口做好。
//   · none：没配（默认）。开柜返回 LOCKER_NOT_CONFIGURED，查柜门返回空；页面不显示开柜按钮。
//   · mock：模拟（开发、测试）。记在内存里：开过的柜门是开着的。
//   · http：本机的「柜锁桥」。各厂家的柜锁板（RS485、厂家云）协议都不一样，由桥翻译成下面两个 JSON 接口，门店系统不认具体厂家：
//       POST {LOCKER_BRIDGE_URL}/open   { code }            → { ok: boolean, message?: string }
//       POST {LOCKER_BRIDGE_URL}/doors  { codes: string[] } → { doors: [{ code, doorOpen: boolean | null, known: boolean }] }
//     带 Authorization: Bearer {LOCKER_BRIDGE_TOKEN}；每次 5 秒超时；开柜不自动重试（开两次没坏处，但要让人知道第一次没成）。

import type { LockerConfig } from '../config';
import type { LockerControllerInfo, LockerDoor, LockerOpenResult } from '@shared/lockers';

export interface LockerController {
  info: LockerControllerInfo;
  open(code: string): Promise<LockerOpenResult>;
  doors(codes: readonly string[]): Promise<LockerDoor[]>;
}

const TIMEOUT_MS = 5000;

export function createLockerController(cfg: LockerConfig, fetchImpl: typeof fetch = fetch): LockerController {
  if (cfg.driver === 'mock') {
    const opened = new Set<string>();
    return {
      info: { driver: 'mock', canOpen: true },
      async open(code) {
        opened.add(code);
        return { code, opened: true, message: '已开（模拟）' };
      },
      async doors(codes) {
        return codes.map((code) => ({ code, doorOpen: opened.has(code), known: true }));
      },
    };
  }
  if (cfg.driver === 'http' && cfg.bridgeUrl && cfg.bridgeToken) {
    const call = async <T>(path: string, body: unknown): Promise<T> => {
      const res = await fetchImpl(`${cfg.bridgeUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.bridgeToken}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`柜锁桥回 ${res.status}`);
      return (await res.json()) as T;
    };
    return {
      info: { driver: 'http', canOpen: true },
      async open(code) {
        try {
          const r = await call<{ ok?: unknown; message?: unknown }>('/open', { code });
          const opened = r.ok === true;
          return { code, opened, message: typeof r.message === 'string' ? r.message.slice(0, 200) : opened ? '已开' : '控制器没有开' };
        } catch (error) {
          return { code, opened: false, message: `连不上柜锁桥：${error instanceof Error ? error.message : String(error)}`.slice(0, 200) };
        }
      },
      async doors(codes) {
        const r = await call<{ doors?: unknown }>('/doors', { codes });
        const list = Array.isArray(r.doors) ? r.doors : [];
        const byCode = new Map<string, LockerDoor>();
        for (const d of list as { code?: unknown; doorOpen?: unknown; known?: unknown }[]) {
          if (typeof d?.code !== 'string') continue;
          byCode.set(d.code, { code: d.code, doorOpen: typeof d.doorOpen === 'boolean' ? d.doorOpen : null, known: d.known !== false });
        }
        return codes.map((code) => byCode.get(code) ?? { code, doorOpen: null, known: false });
      },
    };
  }
  return {
    info: { driver: 'none', canOpen: false },
    async open(code) {
      return { code, opened: false, message: '还没有接柜锁控制器' };
    },
    async doors() {
      return [];
    },
  };
}
