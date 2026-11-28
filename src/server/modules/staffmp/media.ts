// 短时地址（docs/STAFF_MP.md 第 5.2 节）：小程序的 <video>、<image> 不能带 Authorization 头，培训视频、审批附件的缩略图
// 用员工小程序端口发的短时地址打开：/api/staffmp/media/<票据>，只给这个人（这一个会话）、只对这一个文件。
//   · 有效期：附件、缩略图 10 分钟；培训资料 4 小时——视频、音频是边放边一段一段取的（每一段都核对票据），
//     10 分钟就断会让长视频放到一半断掉；票据绑着会话，会话退了、解绑了、人停用了照样马上打不开；
//   · 票据 = 内容（会话摘要、哪一类、编号、版本、到期）+ HMAC 签名；签名的密钥是进程启动时随机生成的（重启以后旧票据作废，小程序重新要一张）；
//   · 用的时候：先把地址改写到原来的接口（培训文件内容、附件、缩略图），再在读会话那一步核对签名、到期、编号对得上、会话还在、人还在职，
//     用这个会话的身份进原来的处理函数——能不能看照旧由原来的接口当场核对（员工培训的文件夹权限、附件的登记规则）。

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { STAFFMP_PREFIX } from '@shared/staffmp';

const KEY = randomBytes(32);
export const TICKET_TTL_SECONDS = 600;
/** 培训资料（视频、音频边放边取）的票据有效期 */
export const TRAINING_TICKET_TTL_SECONDS = 4 * 3600;
/** 改写以后的地址里放票据的查询参数 */
export const TICKET_QUERY = '__ticket';

/** 票据能打开的几类：培训文件内容、附件、附件缩略图 */
export const MEDIA_TARGETS = {
  training: { route: '/api/training/files/:id/content', path: (id: number, v: number | null) => `/api/training/files/${id}/content${v ? `?v=${v}` : ''}` },
  attachment: { route: '/api/oa/attachments/:id', path: (id: number, _v: number | null) => `/api/oa/attachments/${id}` },
  thumb: { route: '/api/oa/attachments/:id/thumb', path: (id: number, _v: number | null) => `/api/oa/attachments/${id}/thumb` },
} as const;

const Payload = z.object({
  /** 会话令牌的摘要 */
  h: z.string().regex(/^[0-9a-f]{64}$/),
  k: z.enum(['training', 'attachment', 'thumb']),
  i: z.number().int().positive(),
  v: z.number().int().positive().nullable(),
  /** 到期（秒） */
  e: z.number().int().positive(),
});
export type TicketPayload = z.infer<typeof Payload>;

const sign = (body: string) => createHmac('sha256', KEY).update(body).digest('base64url');

export function issueTicket(p: Omit<TicketPayload, 'e'>, nowMs = Date.now()): { ticket: string; expiresAt: string } {
  const e = Math.floor(nowMs / 1000) + (p.k === 'training' ? TRAINING_TICKET_TTL_SECONDS : TICKET_TTL_SECONDS);
  const body = Buffer.from(JSON.stringify({ ...p, e })).toString('base64url');
  return { ticket: `${body}.${sign(body)}`, expiresAt: new Date(e * 1000).toISOString() };
}

/** 只读出内容（不核对签名）：改写地址时用；核对在读会话那一步 */
export function peekTicket(ticket: string): TicketPayload | null {
  const [body] = ticket.split('.');
  if (!body) return null;
  try {
    const parsed = Payload.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 核对签名与到期；对的返回内容 */
export function verifyTicket(ticket: string, nowMs = Date.now()): TicketPayload | null {
  const [body, sig] = ticket.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const p = peekTicket(ticket);
  if (!p || p.e * 1000 < nowMs) return null;
  return p;
}

/** /api/staffmp/media/<票据> 改写成原来的接口地址（带上票据）；认不出的返回 null */
export function mediaRewrite(path: string): string | null {
  const prefix = `${STAFFMP_PREFIX}/media/`;
  if (!path.startsWith(prefix)) return null;
  const ticket = path.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)) return null;
  const p = peekTicket(ticket);
  if (!p) return null;
  const inner = MEDIA_TARGETS[p.k].path(p.i, p.v);
  return `${inner}${inner.includes('?') ? '&' : '?'}${TICKET_QUERY}=${encodeURIComponent(ticket)}`;
}
