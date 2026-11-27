// ERP 审批中心导出（8.2.16，《业财法审批与 WCP 需求变更》A3）：店主按提交日期、单据类型、状态导出 Excel，
// 每行一张审批单：单号、类型、金额、部门、提交人、提交时间、状态、走到第几级、审批记录（谁、什么时候、同意 / 退回、意见、代谁审）、结束时间。
// 一次最多 5,000 张，超过拒绝（请缩小范围）；导出写操作日志。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { APPROVAL_DOC_TYPES, APPROVAL_DOC_TYPE_LABELS, APPROVAL_STATUS_LABELS, type ApprovalStatus } from '@shared/approvals';
import { ISO_DATE } from '@shared/business-date';
import { guard } from '../../auth/guard';
import { attachment } from '../../lib/csv';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { unprocessable } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { buildXlsx } from '../../lib/xlsx';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const EXPORT_LIMIT = 5000;

const ExportQuery = z.object({
  from: z.string().regex(ISO_DATE, '开始日期格式不对'),
  to: z.string().regex(ISO_DATE, '结束日期格式不对'),
  docType: z.enum(APPROVAL_DOC_TYPES).optional(),
  status: z.enum(['pending', 'approved', 'returned', 'cancelled']).optional(),
});

const fmt = (at: Date | string, tz: string) => new Date(at).toLocaleString('zh-CN', { timeZone: tz, hour12: false });

export function registerApprovalExport(app: FastifyInstance, { sql, config }: Deps) {
  const tz = config.timezone;
  app.get('/api/approvals/export.xlsx', { preHandler: guard('approval.rules') }, async (req, reply) => {
    const q = parse(ExportQuery, req.query ?? {});
    if (q.from > q.to) throw unprocessable('EXPORT_RANGE', '开始日期不能晚于结束日期');
    const rows = await sql<
      {
        id: number;
        docNo: string;
        docType: (typeof APPROVAL_DOC_TYPES)[number];
        amountCents: number | null;
        departmentName: string | null;
        submittedByName: string;
        submittedAt: Date;
        status: ApprovalStatus;
        currentLevel: number;
        levels: number;
        finishedAt: Date | null;
        history: string | null;
      }[]
    >`
      SELECT r.id, r.doc_no, r.doc_type, r.amount_cents, d.name AS department_name, s.display_name AS submitted_by_name, r.submitted_at,
             r.status, r.current_level, jsonb_array_length(r.steps) AS levels, r.finished_at,
             (SELECT string_agg(concat('第', a.level, '级 ', st.display_name, CASE WHEN a.on_behalf_of IS NOT NULL THEN concat('（代 ', ob.display_name, '）') END,
                                       CASE a.action WHEN 'approve' THEN ' 同意 ' ELSE ' 退回 ' END, to_char(a.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI'),
                                       CASE WHEN a.comment <> '' THEN concat('：', a.comment) END), E'\n' ORDER BY a.id)
                FROM approval_actions a JOIN staff st ON st.id = a.actor_id LEFT JOIN staff ob ON ob.id = a.on_behalf_of
               WHERE a.request_id = r.id) AS history
      FROM approval_requests r JOIN staff s ON s.id = r.submitted_by LEFT JOIN departments d ON d.id = r.department_id
      WHERE (r.submitted_at AT TIME ZONE ${tz})::date BETWEEN ${q.from} AND ${q.to}
        ${q.docType ? sql`AND r.doc_type = ${q.docType}` : sql``}
        ${q.status ? sql`AND r.status = ${q.status}` : sql``}
      ORDER BY r.id LIMIT ${EXPORT_LIMIT + 1}`;
    if (rows.length > EXPORT_LIMIT) throw unprocessable('EXPORT_TOO_LARGE', `符合条件的超过 ${EXPORT_LIMIT} 张，请按日期、类型或状态缩小范围分几次导出`);
    const buffer = buildXlsx({
      name: '审批中心',
      columns: [
        { header: '单号', width: 18 },
        { header: '类型', width: 12 },
        { header: '金额（元）', width: 12 },
        { header: '部门', width: 12 },
        { header: '提交人', width: 10 },
        { header: '提交时间', width: 18 },
        { header: '状态', width: 8 },
        { header: '级别', width: 8 },
        { header: '审批记录', width: 60 },
        { header: '结束时间', width: 18 },
      ],
      rows: rows.map((r) => [
        r.docNo,
        APPROVAL_DOC_TYPE_LABELS[r.docType] ?? r.docType,
        r.amountCents === null ? '' : Number(r.amountCents) / 100,
        r.departmentName ?? '',
        r.submittedByName,
        fmt(r.submittedAt, tz),
        APPROVAL_STATUS_LABELS[r.status] ?? r.status,
        `${r.currentLevel} / ${r.levels}`,
        r.history ?? '',
        r.finishedAt ? fmt(r.finishedAt, tz) : '',
      ]),
    });
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'approval_requests', detail: { ...q, count: rows.length }, ip: req.ip });
    attachment(reply, `审批中心_${todayIn(tz)}.xlsx`, XLSX_TYPE);
    return reply.send(buffer);
  });
}
