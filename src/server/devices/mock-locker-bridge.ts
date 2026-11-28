// 模拟柜锁（docs/LOCKERS_V8149.md 第 3、6、7 节）：开发、测试与厂家对接时用，不连数据库、不要真机。
//   · MockLockerHardware：记在内存里的柜锁板、发卡器与手机柜：开过的柜门是开着的；发卡器上放着一张 M1 手牌，能读、写、清；
//     手机柜 P001–P012 是自选柜，客人刷手牌占一个（take），一张手牌只能占一个（模拟锁的网络拦一牌一柜，GK2）。
//     LOCKER_DRIVER=mock 用它；模拟柜锁桥也用它。
//   · startMockLockerBridge：按柜锁桥的八个 JSON 接口回话的 http 服务（/open、/doors、/card/read、/card/write、/card/clear、
//     /select/list、/select/open、/select/release），用公共 HTTP 底座（lib/http-kit.ts），带 Authorization: Bearer 核对；
//     门店系统配 LOCKER_DRIVER=http 指过来，就能在没有真锁、没有厂家协议的时候把这头试通。
// 衣物柜是固定柜：写卡把卡写成手牌号 X、开衣物柜 X；手机柜是自选柜，不靠写卡（店主 2026-11-27）。

import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { z } from 'zod';
import type { LockerCardLock, LockerCardRead, LockerCardResult, LockerDoor, LockerOpenResult, LockerSelectResult, LockerSelectSlot } from '@shared/lockers';
import { baseServerOptions, installErrorHandler, installRequestId, sharedKeyMatcher } from '../lib/http-kit';
import { parse } from '../lib/validate';

export interface MockCard {
  uid: string;
  code: string | null;
  locks: LockerCardLock[];
}

/** 模拟的手机柜（自选柜）号 */
export const MOCK_SELECT_NOS = Array.from({ length: 12 }, (_, i) => `P${String(i + 1).padStart(3, '0')}`);

interface MockSlot {
  uid: string | null;
  since: string | null;
  doorOpen: boolean;
}

export class MockLockerHardware {
  private readonly opened = new Set<string>();
  card: MockCard | null;
  readonly slots = new Map<string, MockSlot>(MOCK_SELECT_NOS.map((no) => [no, { uid: null, since: null, doorOpen: false }]));

  constructor(card: MockCard | null = { uid: '04A1B2C3', code: null, locks: [] }) {
    this.card = card;
  }

  open(code: string): LockerOpenResult {
    this.opened.add(code);
    return { code, opened: true, uncertain: false, message: '已开（模拟）' };
  }

  doors(codes: readonly string[]): LockerDoor[] {
    return codes.map((code) => ({ code, doorOpen: this.opened.has(code), known: true }));
  }

  /** 发卡器上放一张卡（空白），或拿走（null） */
  place(uid: string | null): void {
    this.card = uid ? { uid: uid.toUpperCase(), code: null, locks: [] } : null;
  }

  /** 读卡：卡里写的衣物柜 + 它此刻占着的手机柜（联网锁报的） */
  read(): LockerCardRead {
    if (!this.card) return { ok: false, uid: null, code: null, locks: [], message: '发卡器上没有卡（模拟）' };
    const phones = [...this.slots].filter(([, s]) => s.uid === this.card!.uid).map(([no]): LockerCardLock => ({ kind: 'phone', no }));
    return { ok: true, uid: this.card.uid, code: this.card.code, locks: [...this.card.locks, ...phones], message: this.card.code ? `能开 ${this.card.code}` : '空白卡' };
  }

  write(code: string, uid: string | null): LockerCardResult {
    const wrong = this.check(uid);
    if (wrong) return wrong;
    this.card!.code = code;
    this.card!.locks = [{ kind: 'clothes', no: code }];
    return { ok: true, uncertain: false, uid: this.card!.uid, message: `已写：衣物柜 ${code}（模拟）` };
  }

  clear(uid: string | null): LockerCardResult {
    const wrong = this.check(uid);
    if (wrong) return wrong;
    this.card!.code = null;
    this.card!.locks = [];
    return { ok: true, uncertain: false, uid: this.card!.uid, message: '已清成空白卡（模拟）' };
  }

  selectList(): LockerSelectSlot[] {
    return [...this.slots].map(([no, s]) => ({ no, uid: s.uid, doorOpen: s.doorOpen, since: s.since }));
  }

  /**
   * 客人在手机柜上刷手牌占一个：一张手牌只能占一个（模拟锁的网络拦一牌一柜）；force 跳过这条（用例里造「锁没拦住」）。
   * 返回没占上的原因，占上了返回 null
   */
  take(no: string, uid: string, opts: { force?: boolean } = {}): string | null {
    const slot = this.slots.get(no);
    const id = uid.toUpperCase();
    if (!slot) return `没有手机柜 ${no}`;
    if (slot.uid && slot.uid !== id) return `手机柜 ${no} 已经有人用了`;
    const other = [...this.slots].find(([n, s]) => n !== no && s.uid === id);
    if (other && !opts.force) return `这张手牌已经占了手机柜 ${other[0]}，别的柜开不了`;
    this.slots.set(no, { uid: id, since: new Date().toISOString(), doorOpen: false });
    return null;
  }

  selectOpen(no: string): LockerSelectResult {
    const slot = this.slots.get(no);
    if (!slot) return { no, ok: false, uncertain: false, message: `没有手机柜 ${no}（模拟）` };
    slot.doorOpen = true;
    return { no, ok: true, uncertain: false, message: '已开（模拟）' };
  }

  /** 释放：这张手牌不再能开这个柜，柜子空出来；uid 给了而占着的是另一张的，不动 */
  selectRelease(no: string, uid: string | null): LockerSelectResult {
    const slot = this.slots.get(no);
    if (!slot) return { no, ok: false, uncertain: false, message: `没有手机柜 ${no}（模拟）` };
    if (uid && slot.uid && slot.uid !== uid.toUpperCase()) return { no, ok: false, uncertain: false, message: `手机柜 ${no} 现在是另一张手牌（${slot.uid}）占着，没有释放（模拟）` };
    this.slots.set(no, { uid: null, since: null, doorOpen: slot.doorOpen });
    return { no, ok: true, uncertain: false, message: '已释放（模拟）' };
  }

  /** 发卡器上没卡、或不是要写的那张：不写 */
  private check(uid: string | null): LockerCardResult | null {
    if (!this.card) return { ok: false, uncertain: false, uid: null, message: '发卡器上没有卡（模拟）' };
    if (uid && uid.toUpperCase() !== this.card.uid) return { ok: false, uncertain: false, uid: this.card.uid, message: `发卡器上是另一张卡（${this.card.uid}），没有写（模拟）` };
    return null;
  }
}

export interface MockLockerBridge {
  url: string;
  hardware: MockLockerHardware;
  close(): Promise<void>;
}

const OpenBody = z.object({ code: z.string().trim().max(32).default('') });
const DoorsBody = z.object({ codes: z.array(z.string().max(32)).max(1000).default([]) });
const WriteBody = z.object({ code: z.string().trim().max(32).default(''), uid: z.string().trim().max(64).nullable().optional() });
const ClearBody = z.object({ uid: z.string().trim().max(64).nullable().optional() });
const SelectOpenBody = z.object({ no: z.string().trim().max(32).default('') });
const SelectReleaseBody = z.object({ no: z.string().trim().max(32).default(''), uid: z.string().trim().max(64).nullable().optional() });

/**
 * 起一个模拟柜锁桥（只在本机地址上听）；token 是门店系统 LOCKER_BRIDGE_TOKEN 要配的那把。
 * 用公共 HTTP 底座（lib/http-kit.ts，8.1.48）：请求编号、日志脱敏、统一的错误出口、服务密钥比对（Codex 审查 f8b2853）。
 */
export async function startMockLockerBridge(opts: { host?: string; port?: number; token: string; hardware?: MockLockerHardware; logLevel?: string }): Promise<MockLockerBridge> {
  const hardware = opts.hardware ?? new MockLockerHardware();
  const host = opts.host ?? '127.0.0.1';
  const app = Fastify({ ...baseServerOptions(opts.logLevel ?? 'warn'), bodyLimit: 64 * 1024 });
  installRequestId(app);
  installErrorHandler(app, { busy: () => '模拟柜锁桥忙，请再试一次', internal: '模拟柜锁桥出错了', details: false, dbGuards: false, logLabel: '模拟柜锁桥未处理的错误' });
  const keyOk = sharedKeyMatcher(opts.token);
  app.addHook('onRequest', async (req, reply) => {
    const auth = req.headers.authorization;
    if (!keyOk(typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null)) return reply.code(401).send({ ok: false, message: '密钥不对' });
  });
  app.post('/open', async (req) => {
    const r = hardware.open(parse(OpenBody, req.body ?? {}).code);
    return { ok: r.opened, message: r.message };
  });
  app.post('/doors', async (req) => ({ doors: hardware.doors(parse(DoorsBody, req.body ?? {}).codes) }));
  app.post('/card/read', async () => hardware.read());
  app.post('/card/write', async (req) => {
    const { code, uid } = parse(WriteBody, req.body ?? {});
    if (!code) return { ok: false, message: '没有手牌号' };
    return hardware.write(code, uid || null);
  });
  app.post('/card/clear', async (req) => hardware.clear(parse(ClearBody, req.body ?? {}).uid || null));
  app.post('/select/list', async () => ({ lockers: hardware.selectList() }));
  app.post('/select/open', async (req) => {
    const r = hardware.selectOpen(parse(SelectOpenBody, req.body ?? {}).no);
    return { ok: r.ok, message: r.message };
  });
  app.post('/select/release', async (req) => {
    const { no, uid } = parse(SelectReleaseBody, req.body ?? {});
    const r = hardware.selectRelease(no, uid || null);
    return { ok: r.ok, message: r.message };
  });
  await app.listen({ host, port: opts.port ?? 0 });
  const { port } = app.server.address() as AddressInfo;
  return { url: `http://${host}:${port}`, hardware, close: () => app.close() };
}
