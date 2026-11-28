// 员工小程序端口（员工小程序线，docs/STAFF_MP.md 第 5.2 节）：单开的 Fastify 实例，只挂员工小程序的接口。
//   · 外面的地址都在 /api/staffmp/ 下（放 Caddy 的服务器只把 sys.yuzusystem.xyz/api/staffmp/* 转到这里）；
//   · 自己的接口：登录、微信绑定、我是谁（routes.ts），吃饭与巡场（canteen.ts），重提被拒时的确认作废（ops.ts）；
//   · WCP、员工培训、汤崎学堂的员工端接口原样挂上（/api/staffmp/oa/… 进的就是 /api/oa/… 那个处理函数），只放行白名单（allowlist.ts）；
//   · 认证只认 Authorization: Bearer <令牌>，令牌是员工小程序发的员工会话（不认浏览器 Cookie，所以没有跨站请求伪造）；
//   · 没有管理后台的页面与接口；没设 STAFFMP_PORT 不开。

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseAcademyMarkup } from '@shared/academy-markup';
import { STAFFMP_BEARER, type StaffMpAcademyLesson } from '@shared/staffmp';
import type { AppConfig } from '../../config';
import type { Sql } from '../../db';
import type { Deps } from '../../lib/context';
import { AppError } from '../../lib/errors';
import { baseServerOptions, installErrorHandler, installRequestId } from '../../lib/http-kit';
import { decodedPath } from '../../lib/paths';
import { createProtection, TokenBuckets } from '../../lib/protect';
import { DEFAULT_STORE_ID, runInStore } from '../../lib/store-context';
import { hashSessionToken } from '../../auth/session';
import {
  registerOaAnnouncementRoutes,
  registerOaApprovalRoutes,
  registerOaAttachmentRoutes,
  registerOaAttendanceDailyRoutes,
  registerOaDirectoryRoutes,
  registerOaLeaveRoutes,
  registerOaNotificationRoutes,
  registerOaPayrollRoutes,
  registerOaPunchRoutes,
  registerOaScheduleRoutes,
} from '../oa';
import { registerTrainingRoutes } from '../training';
import { registerAcademyRoutes } from '../academy';
import { registerAuthRoutes } from '../../auth/routes';
import { passthroughAllowed, rewriteStaffMpUrl } from './allowlist';
import { resolveStaffMpSession, resolveStaffMpSessionByHash } from './auth';
import { registerStaffMpCanteenRoutes } from './canteen';
import { registerStaffMpOpsRoutes } from './ops';
import { MEDIA_TARGETS, mediaRewrite, TICKET_QUERY, verifyTicket } from './media';
import { registerStaffMpRoutes } from './routes';
import { loadStaffMpEnabled } from './settings';
import { code2sessionFor, type Code2Session } from './wechat';

export interface StaffMpAppOptions {
  /** 测试用：换掉问微信的那一步 */
  code2session?: Code2Session;
  /** 开关的缓存时间（毫秒，默认 3 秒；测试给 0） */
  openCacheMs?: number;
  /** 测试用：固定「此刻」（吃饭的餐次、巡场的轮次按它算） */
  clock?: () => number;
}

/** 不用登录、也不看开关的接口 */
const PUBLIC_ROUTES = new Set(['/api/staffmp/info']);

function bearerOf(header: unknown): string | null {
  if (typeof header !== 'string' || !header.startsWith(STAFFMP_BEARER)) return null;
  const token = header.slice(STAFFMP_BEARER.length).trim();
  return /^[A-Za-z0-9_-]{20,100}$/.test(token) ? token : null;
}

export async function buildStaffMpApp(sql: Sql, config: AppConfig, opts: StaffMpAppOptions = {}): Promise<FastifyInstance> {
  const deps: Deps = { sql, config };
  const app = Fastify({
    ...baseServerOptions(config.logLevel),
    bodyLimit: 64 * 1024,
    trustProxy: config.staffmp.trustProxy.length ? config.staffmp.trustProxy : false,
    // 短时地址先改写成原来的接口（media.ts），其余按前缀改写（allowlist.ts）
    rewriteUrl: (raw) => mediaRewrite(decodedPath(raw.url ?? '/')) ?? rewriteStaffMpUrl(raw.url ?? '/'),
  });
  app.decorateRequest('actor', null as never);
  app.decorateRequest('hasSession', false);

  // 过载保护与网页同一套（8.1.3）；频率限制按令牌（登录了的）或来源 IP（没登录的）算，数与网页一样
  const protection = createProtection({ ...config.protection, sessionPerMin: 0, ipPerMin: 0, allowCidrs: [] });
  const perSession = config.protection.sessionPerMin > 0 ? new TokenBuckets(config.protection.sessionPerMin, config.protection.sessionPerMin / 60) : null;
  const perIp = config.protection.ipPerMin > 0 ? new TokenBuckets(config.protection.ipPerMin, config.protection.ipPerMin / 60) : null;
  const sweeper = setInterval(() => {
    perSession?.sweep();
    perIp?.sweep();
  }, 60_000);
  sweeper.unref();
  app.addHook('onRequest', protection.gate);
  app.addHook('onResponse', protection.done);
  app.addHook('onRequestAbort', protection.done);
  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    protection.close();
  });

  // 开关缓存 3 秒（店主在后台关了，最多 3 秒后小程序就停）
  const cacheMs = opts.openCacheMs ?? 3000;
  let openCache: { at: number; open: boolean } | null = null;
  const isOpen = async () => {
    if (!openCache || Date.now() - openCache.at >= cacheMs) openCache = { at: Date.now(), open: await loadStaffMpEnabled(sql) };
    return openCache.open;
  };

  const TicketQuery = z.object({ [TICKET_QUERY]: z.string().max(1024) });
  const IdParams = z.object({ id: z.string() });
  const ticketActor = async (req: FastifyRequest) => {
    const q = TicketQuery.safeParse(req.query);
    if (!q.success) return null;
    const p = verifyTicket(q.data[TICKET_QUERY]);
    if (!p || req.routeOptions.url !== MEDIA_TARGETS[p.k].route) return null;
    const params = IdParams.safeParse(req.params);
    if (!params.success || params.data.id !== String(p.i)) return null;
    const actor = await resolveStaffMpSessionByHash(sql, p.h);
    return actor ? { actor, sessionHash: p.h } : null;
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!decodedPath(req.url).startsWith('/api/')) throw new AppError(404, 'NOT_FOUND', '接口不存在');
    const route = req.routeOptions.url;
    // 白名单：挂上来的模块里，只有白名单里的「方法 + 路由」进得来（管理接口当作没有）
    if (!route || !passthroughAllowed(req.method, route)) throw new AppError(404, 'NOT_FOUND', '接口不存在');
    if (PUBLIC_ROUTES.has(route)) return undefined;
    if (!(await isOpen())) throw new AppError(503, 'STAFFMP_CLOSED', '员工小程序暂停使用：请找管理员在「WCP 设置 → 员工小程序」里打开');
    const token = bearerOf(req.headers.authorization);
    let ticketSession: string | null = null;
    if (token) {
      const actor = await resolveStaffMpSession(sql, token, config.sessionTtlHours);
      if (actor) {
        req.actor = actor;
        req.hasSession = true;
        req.staffmpToken = token;
      }
    } else {
      // 短时地址（media.ts）：票据签名、到期、对得上这一个文件、会话还在，才用这个会话的身份进原来的接口
      const t = await ticketActor(req);
      if (t) {
        req.actor = t.actor;
        req.hasSession = true;
        ticketSession = t.sessionHash;
      }
    }
    // 频率限制按会话算（短时地址按它绑着的会话）：门店里大家连同一个 Wi-Fi、出口 IP 一样，按 IP 算几个人一起看视频就会互相挡
    const sessionKey = req.hasSession && token ? hashSessionToken(token) : ticketSession;
    const hit = sessionKey ? perSession?.take(`s:${sessionKey.slice(0, 22)}`) : perIp?.take(`ip:${req.ip}`);
    if (hit && !hit.ok) {
      reply.header('retry-after', String(hit.retryAfterSec));
      throw new AppError(429, 'RATE_LIMITED', '请求太频繁，这次没有处理，请稍等几秒');
    }
    return undefined;
  });

  // 当前门店（8.0.22）：处理请求时在这位员工的当前门店上下文里，与网页一样
  app.addHook('preHandler', (req, _reply, done) => {
    runInStore(req.actor?.storeId ?? DEFAULT_STORE_ID, done, req.id);
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (String(reply.getHeader('content-type') ?? '').startsWith('application/json')) reply.header('cache-control', 'no-store');
    return payload;
  });

  installRequestId(app);
  // 错误文字面向员工（lib/http-kit.ts 统一的错误出口；各模块原来的错误文字原样给出）
  installErrorHandler(app, {
    busy: () => '这一项正在被别人操作，这次没有生效，请稍后再试',
    internal: '门店系统出了点问题，这次操作可能没有完成，请稍后核对',
    details: true,
    dbGuards: true,
    logLabel: '员工小程序端口未处理的错误',
  });
  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  });

  registerStaffMpRoutes(app, deps, opts.code2session ?? code2sessionFor(config.staffmp));
  // 吃饭与巡场（员工账号对上的饭堂身份，canteen.ts）
  registerStaffMpCanteenRoutes(app, deps, opts.clock);
  // 打卡、发起申请、处理审批重提被拒时的「确认作废」（ops.ts）
  registerStaffMpOpsRoutes(app, deps);
  // WCP 与员工培训的员工端接口（只放行 allowlist.ts 里的）
  registerOaPunchRoutes(app, deps);
  registerOaScheduleRoutes(app, deps);
  registerOaAttendanceDailyRoutes(app, deps);
  registerOaLeaveRoutes(app, deps);
  registerOaAttachmentRoutes(app, deps);
  registerOaApprovalRoutes(app, deps);
  registerOaNotificationRoutes(app, deps);
  registerOaAnnouncementRoutes(app, deps);
  registerOaPayrollRoutes(app, deps);
  registerOaDirectoryRoutes(app, deps);
  registerTrainingRoutes(app, deps);
  // 汤崎学堂的员工端（只放行 allowlist.ts 里的；管理端一律 404）。课时的回包附上解析好的块：
  // 解析用学堂自己的 parseAcademyMarkup（网页的课件页也是它），小程序不另写一份
  registerAcademyRoutes(app, deps);
  app.addHook('preSerialization', async (req, _reply, payload: unknown) => {
    if (req.method !== 'GET' || req.routeOptions.url !== '/api/academy/lessons/:id' || !payload || typeof payload !== 'object' || !('lesson' in payload)) return payload;
    const view = payload as StaffMpAcademyLesson;
    return { ...view, blocks: view.lesson.kind === 'article' ? parseAcademyMarkup(view.lesson.body).blocks : [] };
  });
  // 账号：只放行老账号选新岗位的两个接口（登录、换门店等用 Cookie 的都不在白名单里）
  registerAuthRoutes(app, deps);
  return app;
}
