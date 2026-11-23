// OA-12 办公审批管理端（docs/OA.md 第 15 节；需求文档五（四））：后台「办公审批」三个页签的接口。
//   · 模板设置（oa.templates）：审批人 1–3 级、条件开关（只给适用于这个模板的）、抄送、说明、启用；带版本，记审计。
//     表单字段不在后台改（OA14）。改了只影响之后提交的单（在途的单审批人提交时已定）。
//   · 全部审批单（oa.all）：按模板、状态、发起人部门、提交日期、关键字筛；导出 Excel（记审计）。看详情、催办走 approvals.ts 的接口
//     （有 oa.all 的能看任何一张、能催办）。
//   · 看板（oa.all）：某个月各模板的发起、通过、驳回、撤销、在途数与平均审批时长；当前这一级等了超过 24 小时的（OA14）。
// 加锁：改模板锁那一行（FOR UPDATE 核对版本）；提交时读模板是 FOR SHARE，两边串行（docs/LOCKING.md「办公审批」）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { departmentOfPosition } from '@shared/oa';
import {
  APPROVAL_CONDITIONS,
  APPROVAL_OVERDUE_HOURS,
  APPROVAL_STATUS_LABELS,
  CONDITION_TEMPLATE,
  type AdminApprovalItem,
  type AdminApprovalPage,
  type ApprovalBoard,
  type ApprovalCondition,
  type ApprovalStatus,
  type ApprovalTemplate,
} from '@shared/oa-approval';
import { ORG_DEPARTMENTS, type OrgDepartment, type PositionKey } from '@shared/positions';
import type { Db, Fragment } from '../../db';
import { guard, guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { attachment } from '../../lib/csv';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { dateSchema, idParam, parse } from '../../lib/validate';
import { buildXlsx } from '../../lib/xlsx';
import { listApprovals, TEMPLATE_COLS, toTemplate } from './approval-engine';
import { monthRange, monthSchema } from './attendance-monthly';
import { NOT_EMPLOYEE_ROLES } from './org';
import { localMinute } from './punches';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PAGE = 50;
/** 一次最多导出几张 */
const EXPORT_LIMIT = 5000;
const deptName = (key: string | null) => ORG_DEPARTMENTS.find((d) => d.key === key)?.name ?? '';

const staffSpec = z.object({ kind: z.literal('staff'), staffId: z.number().int().positive() });
const TemplatePatch = z.object({
  description: z.string().trim().max(200, '说明最多 200 个字').default(''),
  levels: z
    .array(z.union([staffSpec, z.object({ kind: z.literal('dept_head') }), z.object({ kind: z.literal('parent_head') }), z.object({ kind: z.literal('hr_head') })]))
    .min(1, '至少一级审批人')
    .max(3, '最多三级审批人'),
  conditions: z.record(z.string(), z.boolean()).default({}),
  cc: z.array(z.union([staffSpec, z.object({ kind: z.literal('dept_head') })])).max(10, '抄送最多 10 个'),
  active: z.boolean(),
  version: z.number().int().positive(),
});

/** 指定的人要是在职员工 */
async function assertOnDuty(db: Db, ids: number[]) {
  if (!ids.length) return;
  const rows = await db<{ id: number }[]>`
    SELECT s.id FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
    WHERE s.id IN ${db(ids)} AND s.active AND NOT s.system AND s.role <> ALL(${NOT_EMPLOYEE_ROLES}) AND COALESCE(p.status, 'active') = 'active'`;
  if (rows.length !== new Set(ids).size) throw unprocessable('APPROVER_INVALID', '指定的审批人或抄送人要是在职员工');
}

const AllQuery = z.object({
  template: z
    .string()
    .regex(/^[a-z_]{1,30}$/)
    .optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional(),
  dept: z.enum(ORG_DEPARTMENTS.map((d) => d.key) as [OrgDepartment, ...OrgDepartment[]]).optional(),
  from: dateSchema('开始日期').optional(),
  to: dateSchema('结束日期').optional(),
  q: z.string().trim().max(40).optional(),
  before: z.coerce.number().int().positive().optional(),
});

/** 发起人某个部门（s 是 staff 表） */
function inDepartment(db: Db, dept: OrgDepartment): Fragment {
  if (dept === 'company') return db`s.position = 'president'`;
  if (dept === 'gmo') return db`s.position = 'gmo'`;
  return db`(s.position = ${`${dept}.lead`} OR s.position = ${`${dept}.staff`})`;
}

async function listAll(db: Db, actorId: number, tz: string, q: z.infer<typeof AllQuery>, limit: number): Promise<AdminApprovalItem[]> {
  const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const where = db`true
    ${q.template ? db`AND a.template_code = ${q.template}` : db``}
    ${q.status ? db`AND a.status = ${q.status}` : db``}
    ${q.dept ? db`AND ${inDepartment(db, q.dept)}` : db``}
    ${q.from ? db`AND (a.submitted_at AT TIME ZONE ${tz})::date >= ${q.from}` : db``}
    ${q.to ? db`AND (a.submitted_at AT TIME ZONE ${tz})::date <= ${q.to}` : db``}
    ${like ? db`AND (a.title ILIKE ${like} OR s.display_name ILIKE ${like})` : db``}
    ${q.before ? db`AND a.id < ${q.before}` : db``}`;
  const items = await listApprovals(db, actorId, where, limit);
  if (!items.length) return [];
  const pos = await db<{ id: number; position: PositionKey | null }[]>`SELECT id, position FROM staff WHERE id IN ${db([...new Set(items.map((i) => i.applicantId))])}`;
  const byId = new Map(pos.map((p) => [Number(p.id), p.position]));
  return items.map((i) => ({ ...i, department: deptName(departmentOfPosition(byId.get(i.applicantId) ?? null)) }));
}

export function registerOaApprovalAdminRoutes(app: FastifyInstance, { sql, config }: Deps) {
  const tz = config.timezone;
  const templatesPerm = guard('oa.templates');
  const allPerm = guard('oa.all');

  // 后台：全部模板（含停用的）
  app.get(
    '/api/oa/approval/templates/all',
    { preHandler: guardAny('oa.templates', 'oa.all') },
    async (): Promise<ApprovalTemplate[]> => (await sql<ApprovalTemplate[]>`SELECT ${TEMPLATE_COLS(sql)} FROM oa_approval_templates ORDER BY sort, id`).map(toTemplate),
  );

  // 改模板：审批人、条件开关、抄送、说明、启用（带版本）
  app.put('/api/oa/approval/templates/:id', { preHandler: templatesPerm }, async (req): Promise<ApprovalTemplate> => {
    const { id } = parse(idParam, req.params);
    const input = parse(TemplatePatch, req.body);
    return sql.begin(async (tx) => {
      const [cur] = await tx<ApprovalTemplate[]>`SELECT ${TEMPLATE_COLS(tx)} FROM oa_approval_templates WHERE id = ${id} FOR UPDATE`;
      if (!cur) throw notFound('模板不存在');
      if (cur.version !== input.version) throw conflict('VERSION_CONFLICT', '这个模板刚被别人改过，请刷新后再改');
      // 条件开关只认引擎里有、适用于这个模板的
      const conditions: Partial<Record<ApprovalCondition, boolean>> = {};
      for (const [k, on] of Object.entries(input.conditions)) {
        if (!(k in APPROVAL_CONDITIONS) || CONDITION_TEMPLATE[k as ApprovalCondition] !== cur.code) throw unprocessable('CONDITION_INVALID', '这个模板没有这个条件开关');
        conditions[k as ApprovalCondition] = on;
      }
      await assertOnDuty(
        tx,
        [...input.levels, ...input.cc].flatMap((x) => (x.kind === 'staff' ? [x.staffId] : [])),
      );
      const [row] = await tx<ApprovalTemplate[]>`
        UPDATE oa_approval_templates SET description = ${input.description}, levels = ${tx.json(input.levels as never)}, conditions = ${tx.json(conditions as never)},
          cc = ${tx.json(input.cc as never)}, active = ${input.active}, version = version + 1, updated_at = now()
        WHERE id = ${id} RETURNING ${TEMPLATE_COLS(tx)}`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_approval_template_saved',
        targetType: 'oa_approval_template',
        targetId: id,
        detail: { before: { levels: cur.levels, conditions: cur.conditions, cc: cur.cc, active: cur.active }, after: { ...input, conditions }, summary: `修改审批模板「${cur.name}」` },
        ip: req.ip,
      });
      return toTemplate(row!);
    });
  });

  // 全部审批单
  app.get('/api/oa/approvals/all', { preHandler: allPerm }, async (req): Promise<AdminApprovalPage> => {
    const q = parse(AllQuery, req.query ?? {});
    const items = await listAll(sql, req.actor.id, tz, q, PAGE + 1);
    return { items: items.slice(0, PAGE), next: items.length > PAGE ? items[PAGE - 1]!.id : null };
  });

  app.get('/api/oa/approvals/all.xlsx', { preHandler: allPerm }, async (req, reply) => {
    const q = parse(AllQuery, { ...(req.query as object), before: undefined });
    // 多取一张看有没有超过上限：超过就拒绝、请缩小范围，不悄悄截掉较早的（Codex 审查 8f4ba02）
    const items = await listAll(sql, req.actor.id, tz, q, EXPORT_LIMIT + 1);
    if (items.length > EXPORT_LIMIT) throw unprocessable('EXPORT_TOO_LARGE', `符合条件的超过 ${EXPORT_LIMIT} 张，一次最多导出 ${EXPORT_LIMIT} 张，请按日期、模板或部门缩小范围分几次导出`);
    const buffer = buildXlsx({
      name: '办公审批',
      columns: [
        { header: '编号', width: 8 },
        { header: '模板', width: 8 },
        { header: '标题', width: 32 },
        { header: '发起人', width: 10 },
        { header: '部门', width: 12 },
        { header: '状态', width: 8 },
        { header: '当前审批人', width: 10 },
        { header: '第几版', width: 6 },
        { header: '提交时间', width: 18 },
        { header: '结束时间', width: 18 },
      ],
      rows: items.map((i) => [
        i.id,
        i.templateName,
        i.title,
        i.applicantName,
        i.department,
        APPROVAL_STATUS_LABELS[i.status as ApprovalStatus],
        i.currentApproverName ?? '',
        i.revision,
        new Date(i.submittedAt).toLocaleString('zh-CN', { timeZone: tz, hour12: false }),
        i.finishedAt ? new Date(i.finishedAt).toLocaleString('zh-CN', { timeZone: tz, hour12: false }) : '',
      ]),
    });
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'oa_approvals', detail: { ...q, count: items.length }, ip: req.ip });
    attachment(reply, `办公审批_${localMinute(new Date(), tz).date}.xlsx`, XLSX_TYPE);
    return reply.send(buffer);
  });

  // 看板
  app.get('/api/oa/approvals/board', { preHandler: allPerm }, async (req): Promise<ApprovalBoard> => {
    const month = parse(z.object({ month: monthSchema }), req.query ?? {}).month ?? localMinute(new Date(), tz).date.slice(0, 7);
    const [from, to] = monthRange(month);
    const templates = await sql<ApprovalBoard['templates']>`
      SELECT t.code, t.name,
             count(a.id) FILTER (WHERE (a.submitted_at AT TIME ZONE ${tz})::date BETWEEN ${from} AND ${to})::int AS submitted,
             count(a.id) FILTER (WHERE a.status = 'approved' AND (a.finished_at AT TIME ZONE ${tz})::date BETWEEN ${from} AND ${to})::int AS approved,
             count(a.id) FILTER (WHERE a.status = 'rejected' AND (a.finished_at AT TIME ZONE ${tz})::date BETWEEN ${from} AND ${to})::int AS rejected,
             count(a.id) FILTER (WHERE a.status = 'withdrawn' AND (a.finished_at AT TIME ZONE ${tz})::date BETWEEN ${from} AND ${to})::int AS withdrawn,
             count(a.id) FILTER (WHERE a.status = 'pending')::int AS pending,
             round((avg(extract(epoch FROM a.finished_at - a.submitted_at)) FILTER (
               WHERE a.status IN ('approved', 'rejected') AND (a.finished_at AT TIME ZONE ${tz})::date BETWEEN ${from} AND ${to}) / 3600)::numeric, 1)::float AS avg_hours
      FROM oa_approval_templates t LEFT JOIN oa_approvals a ON a.template_id = t.id
      GROUP BY t.id, t.code, t.name, t.sort ORDER BY t.sort, t.id`;
    // 当前这一级从什么时候开始等：最近一次推进审批的事件（提交、通过、转交）
    const overdue = await sql<{ id: number; title: string; applicantName: string; approverName: string; waitedHours: number }[]>`
      SELECT a.id, a.title, s.display_name AS applicant_name, p.display_name AS approver_name,
             floor(extract(epoch FROM now() - (SELECT max(e.created_at) FROM oa_approval_events e WHERE e.approval_id = a.id AND e.kind IN ('submit', 'approve', 'transfer'))) / 3600)::int AS waited_hours
      FROM oa_approvals a
      JOIN staff s ON s.id = a.applicant_id
      JOIN oa_approval_steps st ON st.approval_id = a.id AND st.status = 'pending'
      JOIN staff p ON p.id = st.approver_id
      WHERE a.status = 'pending'
        AND (SELECT max(e.created_at) FROM oa_approval_events e WHERE e.approval_id = a.id AND e.kind IN ('submit', 'approve', 'transfer')) < now() - make_interval(hours => ${APPROVAL_OVERDUE_HOURS})
      ORDER BY waited_hours DESC, a.id
      LIMIT 200`;
    return { month, templates, overdue: overdue.map((o) => ({ ...o, id: Number(o.id) })) };
  });
}
