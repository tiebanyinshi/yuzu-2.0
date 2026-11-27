// 后台「WCP 设置 → 员工小程序」（docs/STAFF_MP.md 第 6、8.1 节）：主端口上的管理接口。
//   GET  /api/admin/staffmp                        开关、端口与微信配没配、谁绑了微信
//   PUT  /api/admin/staffmp/settings               开关（SP12）
//   POST /api/admin/staffmp/bindings/:id/revoke    解开某人的微信绑定（这个人在小程序上的会话一起退出）
// 能管员工账号的（staff.manage）、人事管组织架构的（hr.org）都能看、能改。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isPositionKey, positionOf } from '@shared/positions';
import type { StaffMpAdminView, StaffMpBindingRow } from '@shared/staffmp';
import { guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { unbindWechat } from './auth';
import { loadStaffMpEnabled, saveStaffMpEnabled } from './settings';
import { wechatReady } from './wechat';

const SettingsInput = z.object({ enabled: z.boolean() });

export function registerStaffMpAdminRoutes(app: FastifyInstance, { sql, config }: Deps) {
  const auth = guardAny('staff.manage', 'hr.org');

  app.get('/api/admin/staffmp', { preHandler: auth }, async (): Promise<StaffMpAdminView> => {
    const rows = await sql<
      { id: number; staffId: number; displayName: string; username: string; position: string | null; boundAt: Date | string; lastLoginAt: Date | string | null; liveSessions: number }[]
    >`
      SELECT b.id, b.staff_id, s.display_name, s.username, s.position, b.bound_at, b.last_login_at,
             (SELECT count(*)::int FROM staffmp_sessions m JOIN sessions x ON x.token_hash = m.token_hash
              WHERE m.staff_id = b.staff_id AND x.expires_at > now()) AS live_sessions
      FROM staffmp_bindings b JOIN staff s ON s.id = b.staff_id
      WHERE b.revoked_at IS NULL
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
    const { enabled } = parse(SettingsInput, req.body);
    await sql.begin(async (tx) => {
      await saveStaffMpEnabled(tx, enabled, req.actor.id);
      await writeAudit(tx, { staffId: req.actor.id, action: 'staffmp_settings_changed', detail: { enabled }, ip: req.ip });
    });
    return { enabled };
  });

  app.post('/api/admin/staffmp/bindings/:id/revoke', { preHandler: auth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const [b] = await sql<{ staffId: number }[]>`SELECT staff_id FROM staffmp_bindings WHERE id = ${id}`;
    if (!b) throw notFound('没有这个绑定');
    // 已经解开过的（两个人同时点）不再记一次
    const revoked = await unbindWechat(sql, Number(b.staffId), { reason: 'admin', adminId: req.actor.id, ip: req.ip, bindingId: id });
    return { ok: true, revoked };
  });
}
