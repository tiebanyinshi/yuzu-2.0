// 三个端口（门店主程序、小程序端口、员工端口）共用的 HTTP 底座（8.1.48 后端评估，docs/BACKEND_REVIEW_V8148.md 第 3、5、6 节）：
//   · 请求编号：认上游（网关、反向代理）带来的 x-request-id（格式对的才认），没有就生成；响应头原样带回，日志每行带 reqId，
//     审计记录也记上（lib/audit.ts 从请求上下文取），一笔操作从网关、门店日志到审计能串起来；
//   · 日志脱敏：Cookie、Authorization、服务密钥头一律不进日志；
//   · 统一的错误出口：业务错误原样、数据库约束 / 只追加保护 / 等锁超时各回一个固定的码，其余 500 带请求编号方便查日志；
//     三个端口各自只给「忙」与「出错」时对谁说什么话，映射规则只有这一份（以前三处各抄一份）；
//   · 服务密钥头的比对（小程序网关、采购商城）：先各自取摘要再比，长度不同也不提前返回。

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import { AppError } from './errors';

export const REQUEST_ID_HEADER = 'x-request-id';
/** 上游带来的编号只认这种：字母数字与 ._-，8–64 位（防止往日志里塞换行、超长串） */
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** 不进日志的请求头 / 响应头 */
export const REDACT_PATHS = ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-mall-key"]', 'req.headers["x-mp-gateway-key"]', 'res.headers["set-cookie"]'];

export function requestIdOf(raw: unknown): string {
  return typeof raw === 'string' && REQUEST_ID_RE.test(raw) ? raw : randomUUID();
}

/** 建 Fastify 实例的公共选项：日志级别与脱敏、请求编号 */
export function baseServerOptions(logLevel: string): Pick<FastifyServerOptions, 'logger' | 'genReqId' | 'requestIdHeader' | 'requestIdLogLabel'> {
  return {
    logger: { level: logLevel, redact: { paths: REDACT_PATHS, censor: '[已隐藏]' } },
    // 不让 Fastify 直接照搬请求头（不校验格式）；自己认、认不了就生成
    requestIdHeader: false,
    genReqId: (req) => requestIdOf(req.headers[REQUEST_ID_HEADER]),
    requestIdLogLabel: 'reqId',
  };
}

/** 响应头带回请求编号（出错时页面、网关据此报给店里查日志） */
export function installRequestId(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header(REQUEST_ID_HEADER, req.id);
    return payload;
  });
}

const BUSY_CODES = new Set(['55P03', '57014', '40P01', '40001']);

export interface ErrorTexts {
  /** 等锁、超时、死锁、串行化冲突（事务已回滚，确定没生效）时对谁说什么 */
  busy: (req: FastifyRequest) => string;
  /** 没接住的错误（500）时说什么；后面自动带上请求编号 */
  internal: string;
  /** 业务错误带不带 details（小程序端口面向顾客，不带） */
  details: boolean;
  /** 认不认数据库约束（23514 / 23503 → 422）与只追加保护（P0001 → 409）：小程序、员工端口照旧不认（按 500 处理） */
  dbGuards: boolean;
  /** 日志里 500 的说明 */
  logLabel: string;
}

/** 统一的错误出口（响应体一律 { error: { code, message, details? } }） */
export function installErrorHandler(app: FastifyInstance, t: ErrorTexts): void {
  app.setErrorHandler((error, req: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      reply.status(error.status).send({ error: { code: error.code, message: error.message, ...(t.details ? { details: error.details } : {}) } });
      return;
    }
    const e = error as { statusCode?: number; code?: string };
    if (t.dbGuards && (e.code === '23514' || e.code === '23503')) {
      req.log.warn({ err: error }, '数据库约束拦截');
      reply.status(422).send({ error: { code: 'CONSTRAINT', message: '数据校验未通过，操作未生效，请核对后重试' } });
      return;
    }
    if (e.code && BUSY_CODES.has(e.code)) {
      req.log.warn({ err: error }, e.code === '40P01' ? '死锁，事务已回滚' : e.code === '40001' ? '串行化冲突，事务已回滚' : '记账等待超时');
      reply.status(409).send({ error: { code: 'BUSY', message: t.busy(req) } });
      return;
    }
    if (t.dbGuards && e.code === 'P0001') {
      req.log.warn({ err: error }, '只追加保护拦截');
      reply.status(409).send({ error: { code: 'IMMUTABLE', message: '已入账记录不可修改' } });
      return;
    }
    if (e.statusCode && e.statusCode < 500) {
      reply.status(e.statusCode).send({ error: { code: t.dbGuards ? (e.code ?? 'BAD_REQUEST') : 'BAD_REQUEST', message: '请求格式不正确' } });
      return;
    }
    req.log.error({ err: error }, t.logLabel);
    reply.status(500).send({ error: { code: 'INTERNAL', message: `${t.internal}（请求编号 ${req.id}）`, requestId: req.id } });
  });
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** 服务密钥头比对：先各自取摘要再比（长度不同也不提前返回）；previous 是换密钥期间还认的旧密钥（每把都比，不提前返回） */
export function sharedKeyMatcher(key: string, previous: readonly string[] = []): (got: unknown) => boolean {
  const expected = [key, ...previous].map(digest);
  return (got) => {
    if (typeof got !== 'string') return false;
    const d = digest(got);
    let ok = false;
    for (const e of expected) ok = timingSafeEqual(d, e) || ok;
    return ok;
  };
}
