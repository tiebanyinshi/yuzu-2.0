// 业财法事项导出（8.2.16，《业财法审批与 WCP 需求变更》A3）：看全部事项的人（店主、内控、董事长）按发起日期、类型、状态导出 Excel，
// 每行一项：编号、类型、事项、主体、部门、金额、发起人、发起时间、状态、当前等谁、审批记录（各级谁、什么时候、同意 / 退回 / 驳回、意见）、微信特批。
// 一次最多 2,000 项，超过拒绝（请缩小范围），不悄悄截掉；导出写操作日志。

import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { GfDocCard } from '@shared/govflow';
import type { Db, Fragment } from '../../db';
import type { Actor } from '../../lib/context';
import { z } from 'zod';
import { GF_DOC_TYPES, GF_DOC_TYPE_LABELS, GF_STATUS_LABELS, GF_STATUSES } from '@shared/govflow';
import { ISO_DATE } from '@shared/business-date';
import { attachment } from '../../lib/csv';
import { buildXlsx } from '../../lib/xlsx';
import { writeAudit } from '../../lib/audit';
import { forbidden, unprocessable } from '../../lib/errors';
import type { Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { parse } from '../../lib/validate';

/** routes.ts 里的几样（传进来，不反向引用 routes.ts，免得循环引用） */
export interface ExportHelpers {
  staffOnly: preHandlerAsyncHookHandler;
  seesAll: (db: Db, actor: Actor) => Promise<boolean>;
  listSelect: (db: Db) => Fragment;
  cardsOf: (db: Db, actor: Actor, rows: Record<string, unknown>[], timeZone: string) => Promise<GfDocCard[]>;
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const EXPORT_LIMIT = 2000;
/** 每批读多少项（按编号往后翻） */
const EXPORT_BATCH = 500;
const ACTION_LABELS: Record<string, string> = { approve: '同意', return: '退回', reject: '驳回', skip: '自动跳过' };

const ExportQuery = z.object({
  from: z.string().regex(ISO_DATE, '开始日期格式不对'),
  to: z.string().regex(ISO_DATE, '结束日期格式不对'),
  docType: z.enum(GF_DOC_TYPES).optional(),
  status: z.enum(GF_STATUSES).optional(),
});

const fmt = (at: Date | string, tz: string) => new Date(at).toLocaleString('zh-CN', { timeZone: tz, hour12: false });

export function registerGovflowExport(app: FastifyInstance, deps: Deps, { staffOnly, seesAll, listSelect, cardsOf }: ExportHelpers) {
  const { sql } = deps;
  const tz = deps.config.timezone;
  app.get('/api/gf/export.xlsx', { preHandler: staffOnly }, async (req, reply) => {
    if (!(await seesAll(sql, req.actor))) throw forbidden('只有店主、内控、董事长能导出业财法事项');
    const q = parse(ExportQuery, req.query ?? {});
    if (q.from > q.to) throw unprocessable('EXPORT_RANGE', '开始日期不能晚于结束日期');
    // 状态要按审批流算（cardsOf），在数据库里筛不了：按编号分批读、算完状态先筛再计数（8.2.16 Codex 审查后补），
    // 不是先截前几千项再筛——范围里事项多、按状态筛下来不多的照样能导出；筛下来超过上限的照旧拒绝
    const cards: GfDocCard[] = [];
    for (let after = 0; ; ) {
      const rows = await sql`
        ${listSelect(sql)}
        WHERE (d.created_at AT TIME ZONE ${tz})::date BETWEEN ${q.from} AND ${q.to}
          ${q.docType ? sql`AND d.doc_type = ${q.docType}` : sql``}
          AND d.id > ${after}
        ORDER BY d.id LIMIT ${EXPORT_BATCH}`;
      if (rows.length === 0) break;
      for (const c of await cardsOf(sql, req.actor, rows, tz)) if (!q.status || c.status === q.status) cards.push(c);
      if (cards.length > EXPORT_LIMIT) throw unprocessable('EXPORT_TOO_LARGE', `符合条件的超过 ${EXPORT_LIMIT} 项，请按日期、类型或状态缩小范围分几次导出`);
      if (rows.length < EXPORT_BATCH) break;
      after = Number(rows[rows.length - 1]!.id);
    }
    const ids = cards.map((c) => c.id);
    const acts = ids.length
      ? await sql<{ docId: number; round: number; level: number; action: string; actorName: string; comment: string; createdAt: Date }[]>`
          SELECT f.doc_id, f.round, a.level, a.action, s.display_name AS actor_name, a.comment, a.created_at
          FROM gf_flow_actions a JOIN gf_flows f ON f.id = a.flow_id JOIN staff s ON s.id = a.actor_id
          WHERE f.doc_id IN ${sql(ids)} ORDER BY f.doc_id, a.id`
      : [];
    const specials = ids.length
      ? await sql<{ docId: number; nos: string }[]>`
          SELECT doc_id, string_agg(special_no, '、' ORDER BY id) AS nos FROM gf_specials WHERE doc_id IN ${sql(ids)} GROUP BY doc_id`
      : [];
    const history = new Map<number, string[]>();
    for (const a of acts) {
      const line = `第${a.round}轮第${a.level}级 ${a.actorName} ${ACTION_LABELS[a.action] ?? a.action} ${fmt(a.createdAt, tz)}${a.comment ? `：${a.comment}` : ''}`;
      const list = history.get(Number(a.docId)) ?? [];
      list.push(line);
      history.set(Number(a.docId), list);
    }
    const specialOf = new Map(specials.map((s) => [Number(s.docId), s.nos]));
    const buffer = buildXlsx({
      name: '业财法事项',
      columns: [
        { header: '业务编号', width: 16 },
        { header: '类型', width: 10 },
        { header: '事项', width: 28 },
        { header: '经营主体', width: 14 },
        { header: '费用承担部门', width: 12 },
        { header: '金额（元）', width: 12 },
        { header: '发起人', width: 10 },
        { header: '发起时间', width: 18 },
        { header: '状态', width: 10 },
        { header: '逾期', width: 6 },
        { header: '当前', width: 16 },
        { header: '审批记录', width: 60 },
        { header: '微信特批', width: 16 },
      ],
      rows: cards.map((c) => [
        c.bizNo,
        GF_DOC_TYPE_LABELS[c.docType],
        c.title,
        c.entityName ?? '',
        c.departmentName ?? '',
        c.amountCents === null ? '' : c.amountCents / 100,
        c.createdByName,
        fmt(c.createdAt, tz),
        GF_STATUS_LABELS[c.status],
        c.overdue ? '是' : '',
        c.currentLabel ?? '',
        (history.get(c.id) ?? []).join('\n'),
        specialOf.get(c.id) ?? '',
      ]),
    });
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'gf_docs', detail: { ...q, count: cards.length }, ip: req.ip });
    attachment(reply, `业财法事项_${todayIn(tz)}.xlsx`, XLSX_TYPE);
    return reply.send(buffer);
  });
}
