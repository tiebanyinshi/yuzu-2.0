// 后台「WCP 设置 → 员工小程序」（docs/STAFF_MP.md 第 6、8.1 节）：主端口上的管理接口。
//   GET  /api/admin/staffmp                        开关、端口与微信配没配、谁绑了微信
//   PUT  /api/admin/staffmp/settings               开关（SP12）
//   POST /api/admin/staffmp/bindings/:id/revoke    解开某人的微信绑定（这个人在小程序上的会话一起退出）
// 谁能管（Codex 审查 467189d，与组织架构同一个门，src/server/modules/oa/org.ts）：总裁（staff.manage），或有 hr.org、岗位由后台核实过的人
// （老账号自己选成人力负责人、还没核实的不算）；只有 hr.org 的只看、只解开挂的门店都在自己能进的门店里的员工，不能动总裁。
// 整个员工小程序的开关只有总裁（staff.manage）能改。

import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { isPositionKey, positionOf } from '@shared/positions';
import type { StaffMpAdminView, StaffMpBindingRow } from '@shared/staffmp';
import { guardAny } from '../../auth/guard';
import { can } from '@shared/permissions';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { forbidden, notFound } from '../../lib/errors';
import { managesOrg, orgScope, storeCond } from '../oa';
import { idParam, parse } from '../../lib/validate';
import { unbindWechat } from './auth';
import { loadStaffMpEnabled, saveStaffMpEnabled } from './settings';
import { wechatReady } from './wechat';

const SettingsInput = z.object({ enabled: z.boolean() });

export function registerStaffMpAdminRoutes(app: FastifyInstance, { sql, config }: Deps) {
  const guardHr = guardAny('staff.manage', 'hr.org');
  const auth: preHandlerAsyncHookHandler = async function (req, reply) {
    await guardHr.call(this, req, reply);
    if (!(await managesOrg(sql, req.actor))) throw forbidden('你的岗位还没由后台核实，不能管员工小程序');
  };

  app.get('/api/admin/staffmp', { preHandler: auth }, async (req): Promise<StaffMpAdminView> => {
    const scope = await orgScope(sql, req.actor);
    const rows = await sql<
      { id: number; staffId: number; displayName: string; username: string; position: string | null; boundAt: Date | string; lastLoginAt: Date | string | null; liveSessions: number }[]
    >`
      SELECT b.id, b.staff_id, s.display_name, s.username, s.position, b.bound_at, b.last_login_at,
             (SELECT count(*)::int FROM staffmp_sessions m JOIN sessions x ON x.token_hash = m.token_hash
              WHERE m.staff_id = b.staff_id AND x.expires_at > now()) AS live_sessions
      FROM staffmp_bindings b JOIN staff s ON s.id = b.staff_id
      WHERE b.revoked_at IS NULL AND ${storeCond(sql, scope)} AND (${scope.all} OR s.role <> 'owner')
      ORDER BY b.bound_at DESC, b.id DESC`;
    const bindings: StaffMpBindingRow[] = rows.map((r) => ({
      id: Number(r.id),
      staffId: Number(r.staffId),
      displayName: r.displayName,
      username: r.username,
      positionTitle: isPositionKey(r.position) ? positionOf(r.position).title : null,
      // 时间按库里返回的（Date 或字符串）统一成 ISO
      boundAt: new Date(r.boundAt).toISOString(),
      lastLoginAt: r.lastLoginAt ? new Date(r.lastLoginAt).toISOString() : null,
      liveSessions: r.liveSessions,
    }));
    return {
      enabled: await loadStaffMpEnabled(sql),
      portOpen: config.staffmp.port !== null,
      wechatConfigured: wechatReady(config.staffmp),
      mockWechat: config.staffmp.mockWechat,
      appId: config.staffmp.appId,
      bindings,
    };
  });

  app.put('/api/admin/staffmp/settings', { preHandler: auth }, async (req) => {
    if (!can(req.actor, 'staff.manage')) throw forbidden('整个员工小程序的开关只有总裁能改');
    const { enabled } = parse(SettingsInput, req.body);
    await sql.begin(async (tx) => {
      await saveStaffMpEnabled(tx, enabled, req.actor.id);
      await writeAudit(tx, { staffId: req.actor.id, action: 'staffmp_settings_changed', detail: { enabled }, ip: req.ip });
    });
    return { enabled };
  });

  app.post('/api/admin/staffmp/bindings/:id/revoke', { preHandler: auth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const scope = await orgScope(sql, req.actor);
    // 范围外的员工、总裁（只有 hr.org 时）当作没有这个绑定：知道编号也不能越过门店范围
    const [b] = await sql<{ staffId: number }[]>`
      SELECT b.staff_id FROM staffmp_bindings b JOIN staff s ON s.id = b.staff_id
      WHERE b.id = ${id} AND ${storeCond(sql, scope)} AND (${scope.all} OR s.role <> 'owner')`;
    if (!b) throw notFound('没有这个绑定');
    // 已经解开过的（两个人同时点）不再记一次
    const staffId = Number(b.staffId);
    const revoked = await unbindWechat(sql, staffId, {
      reason: 'admin',
      adminId: req.actor.id,
      ip: req.ip,
      bindingId: id,
      // 先锁员工行（与调店同一个顺序），再另起一句核对范围：读到的是调店提交以后的门店（与 oa/org.ts 的 inStoreScope 同一个做法）
      check: async (tx) => {
        await tx`SELECT 1 FROM staff WHERE id = ${staffId} FOR SHARE`;
        const [ok] = await tx`SELECT 1 FROM staff s WHERE s.id = ${staffId} AND ${storeCond(tx, scope)} AND (${scope.all} OR s.role <> 'owner')`;
        if (!ok) throw notFound('没有这个绑定');
      },
    });
    return { ok: true, revoked };
  });
}
