// 模拟柜锁（docs/LOCKERS_V8149.md 第 3、6 节）：开发、测试与厂家对接时用，不连数据库、不要真机。
//   · MockLockerHardware：记在内存里的柜锁板与发卡器：开过的柜门是开着的；发卡器上放着一张 M1 手牌，能读、写、清。
//     LOCKER_DRIVER=mock 用它；模拟柜锁桥也用它。
//   · startMockLockerBridge：按柜锁桥的五个 JSON 接口回话的 http 服务（/open、/doors、/card/read、/card/write、/card/clear），
//     用公共 HTTP 底座（lib/http-kit.ts），带 Authorization: Bearer 核对；门店系统配 LOCKER_DRIVER=http 指过来，就能在没有真锁、没有厂家库的时候把这头试通。
// 模拟的对照表：手牌号 X 开衣物柜 X、手机柜 X（真的对照表在厂家的桥里，GK2）。

import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { z } from 'zod';
import type { LockerCardLock, LockerCardRead, LockerCardResult, LockerDoor, LockerOpenResult } from '@shared/lockers';
import { baseServerOptions, installErrorHandler, installRequestId, sharedKeyMatcher } from '../lib/http-kit';
import { parse } from '../lib/validate';

export interface MockCard {
  uid: string;
  code: string | null;
  locks: LockerCardLock[];
}

export class MockLockerHardware {
  private readonly opened = new Set<string>();
  card: MockCard | null;

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

  read(): LockerCardRead {
    if (!this.card) return { ok: false, uid: null, code: null, locks: [], message: '发卡器上没有卡（模拟）' };
    return { ok: true, uid: this.card.uid, code: this.card.code, locks: [...this.card.locks], message: this.card.code ? `能开 ${this.card.code}` : '空白卡' };
  }

  write(code: string, uid: string | null): LockerCardResult {
    const wrong = this.check(uid);
    if (wrong) return wrong;
    this.card!.code = code;
    this.card!.locks = [
      { kind: 'clothes', no: code },
      { kind: 'phone', no: code },
    ];
    return { ok: true, uncertain: false, uid: this.card!.uid, message: `已写：衣物柜 ${code}、手机柜 ${code}（模拟）` };
  }

  clear(uid: string | null): LockerCardResult {
    const wrong = this.check(uid);
    if (wrong) return wrong;
    this.card!.code = null;
    this.card!.locks = [];
    return { ok: true, uncertain: false, uid: this.card!.uid, message: '已清成空白卡（模拟）' };
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
  await app.listen({ host, port: opts.port ?? 0 });
  const { port } = app.server.address() as AddressInfo;
  return { url: `http://${host}:${port}`, hardware, close: () => app.close() };
}
