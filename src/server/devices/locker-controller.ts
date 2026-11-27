// 智能柜锁控制器（8.1.49，docs/LOCKERS_V8149.md 第 3、6 节）：采购清单里还没有柜锁控制器（D8），先把接口做好。
//   · none：没配（默认）。开柜返回 LOCKER_NOT_CONFIGURED，查柜门返回空；页面不显示开柜、发卡器。
//   · mock：模拟（开发、测试），三样都有。记在内存里：开过的柜门是开着的；发卡器上放着一张 M1 手牌（mock-locker-bridge.ts）。
//   · http：本机的「柜锁桥」。各厂家的柜锁（RS485 柜锁板、厂家云、泰格这类单机锁的发卡器动态库）协议都不一样，由桥翻译成下面的 JSON 接口，
//     门店系统不认具体厂家；能做哪几样按 LOCKER_CAPABILITIES（open / doors / card）：
//       POST {LOCKER_BRIDGE_URL}/open        { code }            → { ok: boolean, message?: string }
//       POST {LOCKER_BRIDGE_URL}/doors       { codes: string[] } → { doors: [{ code, doorOpen: boolean | null, known: boolean }] }
//       POST {LOCKER_BRIDGE_URL}/card/read   {}                  → { ok, uid?, code?, locks?: [{ kind, no }], message? }
//       POST {LOCKER_BRIDGE_URL}/card/write  { code, uid? }      → { ok, uid?, message? }
//       POST {LOCKER_BRIDGE_URL}/card/clear  { uid? }            → { ok, uid?, message? }
//     带 Authorization: Bearer {LOCKER_BRIDGE_TOKEN}；每次 5 秒超时；开柜、写卡、清卡都不自动重试（再做一次没坏处，但要让人知道上一次没成）。

import { CARD_UID_PATTERN, normalizeCardUid } from '@shared/frontdesk-risk';
import {
  LOCKER_LOCK_KINDS,
  type LockerCardLock,
  type LockerCardRead,
  type LockerCardResult,
  type LockerControllerInfo,
  type LockerDoor,
  type LockerLockKind,
  type LockerOpenResult,
} from '@shared/lockers';
import type { LockerConfig } from '../config';
import { MockLockerHardware } from './mock-locker-bridge';

export interface LockerController {
  info: LockerControllerInfo;
  open(code: string): Promise<LockerOpenResult>;
  doors(codes: readonly string[]): Promise<LockerDoor[]>;
  /** 读发卡器上的卡；桥连不上时抛出（页面报「柜锁桥没有回应」） */
  readCard(): Promise<LockerCardRead>;
  /** 把发卡器上的卡写成能开这个手牌号的柜；uid 给了而发卡器上是另一张卡的，不写。连不上时返回没写成、原因 */
  writeCard(code: string, uid: string | null): Promise<LockerCardResult>;
  /** 把发卡器上的卡清成空白；uid 同上 */
  clearCard(uid: string | null): Promise<LockerCardResult>;
}

const TIMEOUT_MS = 5000;
const text = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);

/** 桥报的芯片号照手牌绑芯片号的写法整理；不像芯片号的当没读到 */
function cleanUid(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const uid = normalizeCardUid(v);
  return CARD_UID_PATTERN.test(uid) ? uid : null;
}

function cleanLocks(v: unknown): LockerCardLock[] {
  if (!Array.isArray(v)) return [];
  const out: LockerCardLock[] = [];
  for (const l of v.slice(0, 10) as { kind?: unknown; no?: unknown }[]) {
    const no = text(l?.no, 16);
    if (!no) continue;
    const kind = (LOCKER_LOCK_KINDS as readonly unknown[]).includes(l?.kind) ? (l.kind as LockerLockKind) : 'other';
    out.push({ kind, no });
  }
  return out;
}

const cardRead = (r: { ok?: unknown; uid?: unknown; code?: unknown; locks?: unknown; message?: unknown }): LockerCardRead => {
  const ok = r.ok === true;
  return {
    ok,
    uid: cleanUid(r.uid),
    code: ok ? text(r.code, 16) || null : null,
    locks: ok ? cleanLocks(r.locks) : [],
    message: text(r.message) ?? (ok ? '已读' : '没读到卡'),
  };
};

const cardResult = (r: { ok?: unknown; uid?: unknown; message?: unknown }, done: string): LockerCardResult => {
  const ok = r.ok === true;
  return { ok, uid: cleanUid(r.uid), message: text(r.message) ?? (ok ? done : '发卡器没有写成') };
};

const unreachable = (error: unknown) => `连不上柜锁桥：${error instanceof Error ? error.message : String(error)}`.slice(0, 200);

export function createLockerController(cfg: LockerConfig, fetchImpl: typeof fetch = fetch, hardware?: MockLockerHardware): LockerController {
  const has = (c: string) => (cfg.capabilities as readonly string[]).includes(c);
  const info: LockerControllerInfo = { driver: cfg.driver, canOpen: has('open'), canDoors: has('doors'), canCard: has('card') };
  if (cfg.driver === 'mock') {
    const hw = hardware ?? new MockLockerHardware();
    return {
      info,
      async open(code) {
        return hw.open(code);
      },
      async doors(codes) {
        return hw.doors(codes);
      },
      async readCard() {
        return hw.read();
      },
      async writeCard(code, uid) {
        return hw.write(code, uid);
      },
      async clearCard(uid) {
        return hw.clear(uid);
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
      info,
      async open(code) {
        try {
          const r = await call<{ ok?: unknown; message?: unknown }>('/open', { code });
          const opened = r.ok === true;
          return { code, opened, message: text(r.message) ?? (opened ? '已开' : '控制器没有开') };
        } catch (error) {
          return { code, opened: false, message: unreachable(error) };
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
      async readCard() {
        return cardRead(await call('/card/read', {}));
      },
      async writeCard(code, uid) {
        try {
          return cardResult(await call('/card/write', uid ? { code, uid } : { code }), '已写');
        } catch (error) {
          return { ok: false, uid: null, message: unreachable(error) };
        }
      },
      async clearCard(uid) {
        try {
          return cardResult(await call('/card/clear', uid ? { uid } : {}), '已清');
        } catch (error) {
          return { ok: false, uid: null, message: unreachable(error) };
        }
      },
    };
  }
  const none = '还没有接柜锁控制器';
  return {
    info: { driver: 'none', canOpen: false, canDoors: false, canCard: false },
    async open(code) {
      return { code, opened: false, message: none };
    },
    async doors() {
      return [];
    },
    async readCard() {
      return { ok: false, uid: null, code: null, locks: [], message: none };
    },
    async writeCard() {
      return { ok: false, uid: null, message: none };
    },
    async clearCard() {
      return { ok: false, uid: null, message: none };
    },
  };
}
