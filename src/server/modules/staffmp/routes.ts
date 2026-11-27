// 员工小程序自己的接口（docs/STAFF_MP.md 第 8.1 节）：只挂在员工小程序端口上。
//   GET  /api/staffmp/info           不用登录：门店名、版本 + SHA、实例标识、开没开、微信一键登录能不能用
//   POST /api/staffmp/auth/wechat    微信 code 换会话：绑过的直接进，没绑过的回 unbound
//   POST /api/staffmp/auth/login     账号密码登录；带着微信 code 且 bind 为真时顺带绑上（绑不上照样登录）
//   POST /api/staffmp/auth/password  改密码（第一次登录要改的也走这里）；别处的登录全部退出，这台留着
//   POST /api/staffmp/auth/logout    退出；unbind 为真时同时解开这个微信
//   GET  /api/staffmp/me             我是谁
//   POST /api/staffmp/media          短时地址（培训视频、附件缩略图给 <video>、<image> 用，media.ts）

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Role } from '@shared/permissions';
import type { StaffMpInfo, StaffMpLoginReply, StaffMpMe, StaffMpMediaLink, StaffMpWechatReply } from '@shared/staffmp';
import { checkLock, clearFailures, recordFailure } from '../../auth/lockout';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../../auth/password';
import { destroySession, destroyStaffSessions, hashSessionToken } from '../../auth/session';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { AppError, badRequest, unauthorized } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { loadSettings } from '../settings';
import { bindWechat, buildMe, eligibilityOf, issueSession, resolveStaffMpSession, unbindWechat } from './auth';
import { issueTicket } from './media';
import { loadStaffMpEnabled } from './settings';
import { wechatReady, type Code2Session } from './wechat';

declare module 'fastify' {
  interface FastifyRequest {
    /** 员工小程序端口：这次请求带的令牌（退出、改密码时用） */
    staffmpToken?: string;
  }
}

const WechatInput = z.object({ code: z.string().trim().min(1, '缺少微信登录凭证').max(128), mode: z.enum(['login', 'peek']).default('login') });
const LoginInput = z.object({
  username: z.string().trim().toLowerCase().min(1, '请输入账号').max(32),
  password: z.string().min(1, '请输入密码').max(128),
  code: z.string().trim().max(128).optional(),
  bind: z.boolean().default(true),
  // 这个微信绑着别人时，员工确认了「改绑给我」（第 6 节）
  replace: z.boolean().default(false),
});
const PasswordInput = z.object({ currentPassword: z.string().min(1, '请输入当前密码'), newPassword: z.string() });
const LogoutInput = z.object({ unbind: z.boolean().default(false) });
const MediaInput = z.object({ kind: z.enum(['training', 'attachment', 'thumb']), id: z.number().int().positive(), v: z.number().int().positive().optional() });

export function registerStaffMpRoutes(app: FastifyInstance, deps: Deps, code2session: Code2Session) {
  const { sql, config } = deps;
  const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
  const signedIn = (req: FastifyRequest): Actor => {
    if (!req.hasSession) throw unauthorized('请先登录');
    return req.actor;
  };
  /** 登录、换会话以后的「我是谁」：按刚发的令牌现解析一次（权限、门店与以后每个请求一样） */
  const meOf = async (token: string): Promise<StaffMpMe> => {
    const actor = await resolveStaffMpSession(sql, token, config.sessionTtlHours);
    if (!actor) throw unauthorized('登录没有成功，请重试');
    return buildMe(deps, actor);
  };
  const refuse = async (staffId: number, req: FastifyRequest) => {
    const e = await eligibilityOf(sql, staffId);
    if (!e.ok) {
      await writeAudit(sql, { staffId, action: 'login_failed', detail: { via: 'staffmp', reason: e.code }, ip: req.ip });
      throw new AppError(403, e.code, e.message);
    }
  };

  app.get('/api/staffmp/info', async (): Promise<StaffMpInfo> => {
    const settings = await loadSettings(sql);
    return {
      storeName: settings.storeName,
      version: config.version,
      commit: config.commit,
      instance: config.instance,
      open: await loadStaffMpEnabled(sql),
      wechat: wechatReady(config.staffmp),
      mockWechat: config.staffmp.mockWechat,
      time: new Date().toISOString(),
    };
  });

  app.post('/api/staffmp/auth/wechat', async (req): Promise<StaffMpWechatReply> => {
    const { code, mode } = parse(WechatInput, req.body);
    // 问微信在事务外（不在事务里等外部调用）
    const openid = await code2session(code);
    const [b] = await sql<{ id: number; staffId: number; name: string }[]>`
      SELECT b.id, b.staff_id, s.display_name AS name FROM staffmp_bindings b JOIN staff s ON s.id = b.staff_id
      WHERE b.openid = ${openid} AND b.revoked_at IS NULL`;
    if (!b) return { status: 'unbound' };
    // 只看看：退出以后的登录页用，不登录（拿着这台手机的人看得到这个微信绑着谁）
    if (mode === 'peek') return { status: 'bound', displayName: b.name };
    const staffId = Number(b.staffId);
    await refuse(staffId, req);
    const token = await issueSession(sql, staffId, Number(b.id), config.sessionTtlHours, meta(req));
    await sql`UPDATE staffmp_bindings SET last_login_at = now() WHERE id = ${b.id}`;
    await sql`UPDATE staff SET last_login_at = now() WHERE id = ${staffId}`;
    await writeAudit(sql, { staffId, action: 'login', detail: { via: 'staffmp', method: 'wechat' }, ip: req.ip });
    return { status: 'ok', token, me: await meOf(token) };
  });

  app.post('/api/staffmp/auth/login', async (req): Promise<StaffMpLoginReply> => {
    const input = parse(LoginInput, req.body);
    // 与网页共用失败计数（同一个账号在网页和小程序上输错算在一起）
    checkLock(input.username, req.ip);
    const [staff] = await sql<{ id: number; passwordHash: string; active: boolean; role: Role }[]>`
      SELECT id, password_hash, active, role FROM staff WHERE username = ${input.username}`;
    const ok = staff ? await verifyPassword(input.password, staff.passwordHash) : false;
    if (!staff || !ok || !staff.active) {
      recordFailure(input.username, req.ip);
      const reason = !staff ? 'unknown_user' : !ok ? 'bad_password' : 'inactive';
      await writeAudit(sql, { staffId: staff?.id ?? null, action: 'login_failed', detail: { username: input.username, reason, via: 'staffmp' }, ip: req.ip });
      if (staff && ok && !staff.active) throw unauthorized('这个账号已停用，请联系管理员');
      throw unauthorized('账号或密码不正确');
    }
    const staffId = Number(staff.id);
    await refuse(staffId, req);
    clearFailures(input.username, req.ip);
    // 顺带绑微信：问微信在事务外；绑不上不挡登录（第 6 节）
    let bindingId: number | null = null;
    let bindError: string | null = null;
    if (input.bind && input.code) {
      try {
        const bound = await bindWechat(sql, staffId, await code2session(input.code), { ip: req.ip, replace: input.replace });
        if ('bindingId' in bound) bindingId = bound.bindingId;
        else bindError = `这个微信现在绑着「${bound.taken}」，没有改绑：这次只登录这一次`;
      } catch (error) {
        bindError = error instanceof AppError ? error.message : '这次没绑上微信，下次登录时再试';
        req.log.warn({ err: error }, '员工小程序登录时绑微信没成功');
      }
    }
    const token = await issueSession(sql, staffId, bindingId, config.sessionTtlHours, meta(req));
    if (bindingId) await sql`UPDATE staffmp_bindings SET last_login_at = now() WHERE id = ${bindingId}`;
    await sql`UPDATE staff SET last_login_at = now() WHERE id = ${staffId}`;
    await writeAudit(sql, { staffId, action: 'login', detail: { via: 'staffmp', method: 'password' }, ip: req.ip });
    return { token, me: await meOf(token), bound: bindingId !== null, bindError };
  });

  app.post('/api/staffmp/auth/password', async (req): Promise<StaffMpMe> => {
    const actor = signedIn(req);
    const { currentPassword, newPassword } = parse(PasswordInput, req.body);
    const weak = checkPasswordStrength(newPassword);
    if (weak) throw badRequest(weak, { field: 'newPassword' });
    if (newPassword === currentPassword) throw badRequest('新密码不能和现在的一样', { field: 'newPassword' });
    const [row] = await sql<{ passwordHash: string }[]>`SELECT password_hash FROM staff WHERE id = ${actor.id}`;
    if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) throw badRequest('现在的密码不对', { field: 'currentPassword' });
    const hash = await hashPassword(newPassword);
    await sql.begin(async (tx) => {
      await tx`UPDATE staff SET password_hash = ${hash}, must_change_password = false, updated_at = now() WHERE id = ${actor.id}`;
      // 网页、别的手机上的登录全部退出，这台留着
      await destroyStaffSessions(tx, actor.id, req.staffmpToken);
      await writeAudit(tx, { staffId: actor.id, action: 'password_changed', detail: { via: 'staffmp' }, ip: req.ip });
    });
    return buildMe(deps, { ...actor, mustChangePassword: false });
  });

  app.post('/api/staffmp/auth/logout', async (req) => {
    const { unbind } = parse(LogoutInput, req.body ?? {});
    if (req.hasSession && unbind) await unbindWechat(sql, req.actor.id, { reason: 'self', ip: req.ip });
    if (req.staffmpToken) await destroySession(sql, req.staffmpToken);
    if (req.hasSession) await writeAudit(sql, { staffId: req.actor.id, action: 'logout', detail: { via: 'staffmp', unbind }, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/staffmp/me', async (req): Promise<StaffMpMe> => buildMe(deps, signedIn(req)));

  // 短时地址：只发给员工小程序的令牌（不发给短时地址自己）；能不能看由原来的接口在打开时当场核对
  app.post('/api/staffmp/media', async (req): Promise<StaffMpMediaLink> => {
    signedIn(req);
    if (!req.staffmpToken) throw unauthorized('请先登录');
    const { kind, id, v } = parse(MediaInput, req.body);
    const { ticket, expiresAt } = issueTicket({ h: hashSessionToken(req.staffmpToken), k: kind, i: id, v: kind === 'training' ? (v ?? null) : null });
    return { url: `/api/staffmp/media/${ticket}`, expiresAt };
  });
}
