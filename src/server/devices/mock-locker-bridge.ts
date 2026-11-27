// 模拟柜锁（docs/LOCKERS_V8149.md 第 3、6 节）：开发、测试与厂家对接时用，不连数据库、不要真机。
//   · MockLockerHardware：记在内存里的柜锁板与发卡器：开过的柜门是开着的；发卡器上放着一张 M1 手牌，能读、写、清。
//     LOCKER_DRIVER=mock 用它；模拟柜锁桥也用它。
//   · startMockLockerBridge：按柜锁桥的五个 JSON 接口回话的 http 服务（/open、/doors、/card/read、/card/write、/card/clear），
//     带 Authorization: Bearer 核对；门店系统配 LOCKER_DRIVER=http 指过来，就能在没有真锁、没有厂家库的时候把这头试通。
// 模拟的对照表：手牌号 X 开衣物柜 X、手机柜 X（真的对照表在厂家的桥里，GK2）。

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LockerCardLock, LockerCardRead, LockerCardResult, LockerDoor, LockerOpenResult } from '@shared/lockers';

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
    return { code, opened: true, message: '已开（模拟）' };
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
    return { ok: true, uid: this.card!.uid, message: `已写：衣物柜 ${code}、手机柜 ${code}（模拟）` };
  }

  clear(uid: string | null): LockerCardResult {
    const wrong = this.check(uid);
    if (wrong) return wrong;
    this.card!.code = null;
    this.card!.locks = [];
    return { ok: true, uid: this.card!.uid, message: '已清成空白卡（模拟）' };
  }

  /** 发卡器上没卡、或不是要写的那张：不写 */
  private check(uid: string | null): LockerCardResult | null {
    if (!this.card) return { ok: false, uid: null, message: '发卡器上没有卡（模拟）' };
    if (uid && uid.toUpperCase() !== this.card.uid) return { ok: false, uid: this.card.uid, message: `发卡器上是另一张卡（${this.card.uid}），没有写（模拟）` };
    return null;
  }
}

export interface MockLockerBridge {
  url: string;
  hardware: MockLockerHardware;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('请求太大');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  const parsed: unknown = text ? JSON.parse(text) : {};
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** 起一个模拟柜锁桥（只在本机地址上听）；token 是门店系统 LOCKER_BRIDGE_TOKEN 要配的那把 */
export async function startMockLockerBridge(opts: { host?: string; port?: number; token: string; hardware?: MockLockerHardware }): Promise<MockLockerBridge> {
  const hardware = opts.hardware ?? new MockLockerHardware();
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${opts.token}`) return send(401, { ok: false, message: '密钥不对' });
    if (req.method !== 'POST') return send(405, { ok: false, message: '只收 POST' });
    readJson(req)
      .then((body) => {
        switch (req.url) {
          case '/open':
            return send(200, ((r) => ({ ok: r.opened, message: r.message }))(hardware.open(str(body.code) ?? '')));
          case '/doors':
            return send(200, { doors: hardware.doors(Array.isArray(body.codes) ? body.codes.filter((c): c is string => typeof c === 'string') : []) });
          case '/card/read':
            return send(200, hardware.read());
          case '/card/write': {
            const code = str(body.code);
            if (!code) return send(200, { ok: false, message: '没有手牌号' });
            return send(200, hardware.write(code, str(body.uid)));
          }
          case '/card/clear':
            return send(200, hardware.clear(str(body.uid)));
          default:
            return send(404, { ok: false, message: '没有这个接口' });
        }
      })
      .catch((error: unknown) => send(400, { ok: false, message: error instanceof Error ? error.message : String(error) }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${opts.host ?? '127.0.0.1'}:${port}`,
    hardware,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
