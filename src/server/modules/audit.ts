import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AUDIT_EXPORT_MAX, AUDIT_PAGE_MAX, SENSITIVE_AUDIT_ACTIONS } from '@shared/audit';
import type { AuditRecord } from '@shared/types';
import { guard } from '../auth/guard';
import type { Deps } from '../lib/context';
import { csvReply, toCsv } from '../lib/csv';
import { dateSchema, parse } from '../lib/validate';
import { storeIn } from '../lib/store-context';
import { writeAudit } from '../lib/audit';
import { withReportScope } from './stores';

const AuditQuery = z.object({
  /** 按自然日（门店时区）筛选 */
  date: dateSchema().optional(),
  /**
   * 8.1.36：按动作筛——sensitive 为「敏感操作」一组（@shared/audit），也可以逗号分隔写几个动作名；不带为全部
   */
  actions: z
    .string()
    .trim()
    .max(2000)
    .regex(/^[a-z_,]*$/, '动作名只能是小写字母、下划线，用逗号分隔')
    .optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(200),
});

const actionsOf = (raw: string | undefined): readonly string[] | null => {
  if (!raw) return null;
  if (raw === 'sensitive') return SENSITIVE_AUDIT_ACTIONS;
  const list = raw.split(',').filter(Boolean);
  return list.length ? list : null;
};

export function registerAuditRoutes(app: FastifyInstance, { sql, config }: Deps) {
  const query = (date: string | undefined, actions: readonly string[] | null, limit: number) => sql<AuditRecord[]>`
      SELECT a.id, a.action, s.display_name AS staff_name, a.target_type, a.target_id, a.detail, a.ip, a.created_at
      FROM audit_logs a LEFT JOIN staff s ON s.id = a.staff_id
      -- 审计按店看（8.0.22）：当前门店的；店主「合并看」（?scope=all）看能进的几家店
      WHERE ${storeIn(sql, 'a.store_id')}
      ${date ? sql`AND (a.created_at AT TIME ZONE ${config.timezone})::date = ${date}` : sql``}
      ${actions ? sql`AND a.action IN ${sql(actions as string[])}` : sql``}
      ORDER BY a.id DESC LIMIT ${limit}`;

  app.get('/api/audit', { preHandler: guard('audit.read') }, async (req): Promise<AuditRecord[]> => {
    const { date, actions, limit } = parse(AuditQuery, req.query);
    return withReportScope(sql, req, () => query(date, actionsOf(actions), limit));
  });

  // 8.1.36：导出 CSV（同样的筛选，最多一万条）；导出本身也记一条审计
  app.get('/api/audit.csv', { preHandler: guard('audit.read') }, async (req, reply) => {
    const { date, actions } = parse(AuditQuery, req.query);
    const rows = await withReportScope(sql, req, () => query(date, actionsOf(actions), AUDIT_EXPORT_MAX));
    await writeAudit(sql, {
      staffId: req.actor.id,
      action: 'export',
      targetType: 'audit',
      detail: { kind: 'audit', date: date ?? null, actions: actions ?? null, rows: rows.length },
      ip: req.ip,
    });
    const csv = toCsv([
      ['时间', '动作', '经办人', '对象', '对象编号', '内容', 'IP'],
      ...rows.map((r) => [new Date(r.createdAt).toISOString(), r.action, r.staffName ?? '系统', r.targetType ?? '', r.targetId ?? '', JSON.stringify(r.detail), r.ip ?? '']),
    ]);
    return csvReply(reply, `操作审计-${date ?? '全部'}${actions === 'sensitive' ? '-敏感操作' : ''}.csv`, csv);
  });
}
