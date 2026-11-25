// 长时间往外送内容的接口（文件下载、视频分段）的占位（Codex 安全审查 ec38502，做法同 design.ts 的素材下载）：
// 全店同时最多 slots 个、同一个人最多 perStaff 个；满了先排队（先来后到），等太久或同一个人排了太多才 429；
// 连接一断就放掉占位；送的过程中一段时间没往外写（对方读得太慢或不读）就断开，不让慢连接一直占着。

import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors';

export interface StreamSlotOptions {
  slots: number;
  perStaff: number;
  waitMs: number;
  queuePerStaff: number;
  /** 多久没往外写就断开 */
  idleMs: number;
  /** 429 的错误码与提示 */
  code: string;
  message: string;
}

export function createStreamSlots(opts: StreamSlotOptions) {
  const active = new Map<string, number>();
  const waiting: { reqId: string; staffId: number; ready: () => boolean; resolve: () => void; timer: ReturnType<typeof setTimeout> }[] = [];

  const release = (req: FastifyRequest) => {
    if (!active.delete(req.id)) return;
    const next = waiting.find((w) => w.ready());
    if (next) {
      waiting.splice(waiting.indexOf(next), 1);
      clearTimeout(next.timer);
      active.set(next.reqId, next.staffId);
      next.resolve();
    }
  };

  /** 拿一个占位（拿不到先排队）；拿到以后连接断开、送完都放掉 */
  const take = async (req: FastifyRequest, reply: FastifyReply, staffId: number) => {
    const free = () => active.size < opts.slots && [...active.values()].filter((x) => x === staffId).length < opts.perStaff;
    if (!free()) {
      if (waiting.filter((w) => w.staffId === staffId).length >= opts.queuePerStaff) throw new AppError(429, opts.code, opts.message);
      await new Promise<void>((resolve, reject) => {
        const w = {
          reqId: req.id,
          staffId,
          ready: free,
          resolve,
          timer: setTimeout(() => {
            const i = waiting.indexOf(w);
            if (i >= 0) waiting.splice(i, 1);
            reject(new AppError(429, opts.code, opts.message));
          }, opts.waitMs),
        };
        waiting.push(w);
        reply.raw.once('close', () => {
          const i = waiting.indexOf(w);
          if (i >= 0) {
            waiting.splice(i, 1);
            clearTimeout(w.timer);
            reject(new AppError(499, 'CLIENT_CLOSED', '请求已取消'));
          }
        });
      });
    }
    if (!active.has(req.id)) active.set(req.id, staffId);
    reply.raw.once('close', () => release(req));
    // 一段时间没往外写（对方不读）就断开，放掉占位
    reply.raw.setTimeout(opts.idleMs, () => reply.raw.destroy());
  };

  return { take, release, activeCount: () => active.size };
}
