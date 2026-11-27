// OA-10 办公审批的接口（docs/OA.md 第 13 节；需求文档五（一）、（三））。引擎的取人、挂接点、详情在 approval-engine.ts。
//   · 提交（带操作编号 oa_approval_submit）：按模板字段核对表单 → 模板的 prepare → 定审批链与抄送 → 建单、节点、时间线 → 通知第一位审批人与抄送人
//     → 挂附件；驳回以后重新提交带上一张的编号，生成新的一张（revision + 1），上一张留着。
//   · 处理（带操作编号 oa_approval_act，审批人的还带页面上看到的节点）：通过、驳回（必填原因）、转交（记转交链）、撤销（发起人，没有人通过过）、
//     评论（相关的人）、催办（发起人，一小时一次）。
//   · 列表：待我审批、我处理过的、我发起的、抄送我的；「待我审批」数与「抄送我未读」数。
// 加锁（docs/LOCKING.md「办公审批」）：操作编号 → 单据行（FOR UPDATE）→ 节点行 → 附件行 → 模板登记的联动（最后）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  APPROVAL_COMMENT_MAX,
  APPROVAL_STATUS_LABELS,
  APPROVAL_URGE_GAP_MINUTES,
  checkApprovalForm,
  formAttachmentIds,
  type ApprovalBox,
  type ApprovalDetail,
  type ApprovalForm,
  type ApprovalPage,
  type ApprovalPerson,
  type ApprovalSaved,
  type ApprovalStatus,
  type ApprovalSummary,
  type ApprovalTemplate,
} from '@shared/oa-approval';
import { departmentOfPosition } from '@shared/oa';
import { can } from '@shared/permissions';
import { ORG_DEPARTMENTS, type PositionKey } from '@shared/positions';
import type { Db, Fragment, Tx } from '../../db';
import { guard } from '../../auth/guard';
import type { Actor, Deps } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { idParam, parse } from '../../lib/validate';
import { erpOpAbandoned } from '../erp-ops';
import type { LinkEnv } from './attendance-link';
import { canViewApproval, canViewApprovalAttachment, hooksOf, listApprovals, loadApproval, resolveChain, revisionsUpTo, TEMPLATE_COLS, toTemplate } from './approval-engine';
import { bindAttachments, registerAttachmentRef } from './attachments';
import { notify } from './notifications';
import { NOT_EMPLOYEE_ROLES } from './org';
import { localMinute } from './punches';

const PAGE = 30;
const link = (id: number) => `/oa/approvals/${id}`;

const SubmitInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  templateId: z.number().int().positive(),
  form: z.record(z.string(), z.unknown()),
  previousId: z.number().int().positive().nullable().default(null),
});
const comment = z.string().trim().max(APPROVAL_COMMENT_MAX, `意见最多 ${APPROVAL_COMMENT_MAX} 个字`).default('');
const ActInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), clientKey: z.uuid(), stepId: z.number().int().positive(), comment }),
  z.object({ action: z.literal('reject'), clientKey: z.uuid(), stepId: z.number().int().positive(), comment: comment.refine((c) => c.length > 0, '驳回要写原因') }),
  z.object({ action: z.literal('transfer'), clientKey: z.uuid(), stepId: z.number().int().positive(), toStaffId: z.number().int().positive(), comment }),
  z.object({ action: z.literal('withdraw'), clientKey: z.uuid(), comment }),
  z.object({ action: z.literal('comment'), clientKey: z.uuid(), comment: comment.refine((c) => c.length > 0, '请写评论') }),
  z.object({ action: z.literal('urge'), clientKey: z.uuid() }),
]);
const ListQuery = z.object({
  box: z.enum(['todo', 'done', 'mine', 'cc']).default('todo'),
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional(),
  before: z.coerce.number().int().positive().optional(),
  /** 只要某个模板的（报销关联出差单时选候选用） */
  template: z
    .string()
    .regex(/^[a-z_]{1,30}$/)
    .optional(),
});

/** 轮到这一步：标成待处理、通知审批人 */
async function activate(tx: Tx, approval: { id: number; title: string; applicantName: string }, stepId: number, approverId: number) {
  await tx`UPDATE oa_approval_steps SET status = 'pending' WHERE id = ${stepId}`;
  await notify(tx, [approverId], {
    kind: 'approval_todo',
    title: `待审批：${approval.applicantName}的${approval.title}`,
    link: link(approval.id),
    ref: { type: 'oa_approval', id: approval.id },
  });
}

/** 整单结束：记状态、通知发起人、调模板登记的联动 */
async function finish(tx: Tx, env: LinkEnv, a: { id: number; title: string; applicantId: number; templateCode: string; form: ApprovalForm }, status: 'approved' | 'rejected' | 'withdrawn', why = '') {
  await tx`UPDATE oa_approval_steps SET status = 'cancelled' WHERE approval_id = ${a.id} AND status IN ('waiting', 'pending')`;
  await tx`UPDATE oa_approvals SET status = ${status}, finished_at = now() WHERE id = ${a.id}`;
  if (status !== 'withdrawn') {
    await notify(tx, [a.applicantId], {
      kind: 'approval_result',
      title: `${a.title}${status === 'approved' ? '已通过' : '被驳回'}`,
      body: why ? `原因：${why}` : '',
      link: link(a.id),
      ref: { type: 'oa_approval', id: a.id },
    });
  }
  // 通过以后：模板登记的联动（OA-13 考勤与假期余额），排在最后
  if (status === 'approved') await hooksOf(a.templateCode).onApproved?.(tx, { id: a.id, applicantId: a.applicantId, title: a.title, form: a.form }, env);
}

/** 在职员工（转交的对象） */
async function onDuty(db: Db, id: number): Promise<{ name: string } | null> {
  const [s] = await db<{ name: string }[]>`
    SELECT s.display_name AS name FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
    WHERE s.id = ${id} AND s.active AND NOT s.system AND s.role <> ALL(${NOT_EMPLOYEE_ROLES}) AND COALESCE(p.status, 'active') = 'active'`;
  return s ?? null;
}

async function submit(tx: Tx, actor: Actor, input: z.infer<typeof SubmitInput>, hash: string, env: LinkEnv): Promise<number> {
  const today = localMinute(env.at, env.timeZone).date;
  const [t] = await tx<ApprovalTemplate[]>`SELECT ${TEMPLATE_COLS(tx)} FROM oa_approval_templates WHERE id = ${input.templateId} FOR SHARE`;
  if (!t || !t.active) throw notFound('审批模板不存在或已停用，请刷新');
  const template = toTemplate(t);
  const checked = checkApprovalForm(template.fields, input.form);
  if ('error' in checked) throw unprocessable('FORM_INVALID', checked.error);
  let form = checked.form;
  let title = typeof form.title === 'string' && form.title ? form.title : template.name;
  // 假种、关联单这两类字段：假种要在用的；关联单只能是自己已通过的那个模板的单
  for (const f of template.fields) {
    const v = form[f.key];
    if (typeof v !== 'number') continue;
    if (f.type === 'leave_type') {
      const [ok] = await tx`SELECT 1 FROM oa_leave_types WHERE id = ${v} AND active`;
      if (!ok) throw unprocessable('FORM_INVALID', `${f.label}不存在或已停用，请刷新`);
    }
    if (f.type === 'ref') {
      const [ok] = await tx`SELECT 1 FROM oa_approvals WHERE id = ${v} AND applicant_id = ${actor.id} AND template_code = ${f.refTemplate ?? ''} AND status = 'approved'`;
      if (!ok) throw unprocessable('FORM_INVALID', `${f.label}只能选自己已通过的单`);
    }
  }
  const prepared = await hooksOf(template.code).prepare?.(tx, { applicant: actor, form, fields: template.fields, today, env });
  if (prepared?.form) form = prepared.form;
  if (prepared?.title) title = prepared.title;
  let revision = 1;
  if (input.previousId !== null) {
    const [prev] = await tx<{ applicantId: number; status: string; templateId: number; revision: number }[]>`
      SELECT applicant_id, status, template_id, revision FROM oa_approvals WHERE id = ${input.previousId} FOR UPDATE`;
    if (!prev || Number(prev.applicantId) !== actor.id) throw notFound('要重新提交的单不存在');
    if (prev.status !== 'rejected' || Number(prev.templateId) !== template.id) throw unprocessable('RESUBMIT_INVALID', '只有被驳回的单能改了重新提交');
    const [next] = await tx`SELECT 1 FROM oa_approvals WHERE previous_id = ${input.previousId}`;
    if (next) throw conflict('RESUBMITTED', '这张单已经重新提交过了，请刷新');
    revision = prev.revision + 1;
  }
  const chain = await resolveChain(tx, template, actor, form);
  // 报销不自动通过（8.2.6，《业财法审批与 WCP 需求变更》B1 / 7.3）：发起人就是最上级、一级都不剩的，交给另一位店主审；
  // 没有别的店主就不让提交（不再按 OA12 直接通过）。别的单照旧
  if (!chain.steps.length && template.code === 'expense') {
    const [o] = await tx<{ id: number }[]>`SELECT id FROM staff WHERE active AND NOT system AND role = 'owner' AND id <> ${actor.id} ORDER BY id LIMIT 1`;
    if (!o) throw unprocessable('NO_APPROVER', '这张报销没有能审批的人（发起人就是最上级）。报销不能自动通过，请店主在「WCP 设置 → 审批模板」里给报销指定审批人');
    chain.steps.push({ approverId: Number(o.id), label: '店主审批（报销不自动通过）' });
  }
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO oa_approvals (template_id, template_code, template_name, fields, applicant_id, title, form, status, revision, previous_id, finished_at)
    VALUES (${template.id}, ${template.code}, ${template.name}, ${tx.json(template.fields as never)}, ${actor.id}, ${title.slice(0, 100)}, ${tx.json(form as never)},
            ${chain.steps.length ? 'pending' : 'approved'}, ${revision}, ${input.previousId}, ${chain.steps.length ? null : new Date().toISOString()})
    RETURNING id`;
  const id = Number(row!.id);
  await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'oa_approval_submit', ${hash}, ${id}, ${actor.id})`;
  await tx`INSERT INTO oa_approval_events (approval_id, actor_id, kind) VALUES (${id}, ${actor.id}, 'submit')`;
  const stepIds: number[] = [];
  for (const [i, s] of chain.steps.entries()) {
    const [st] = await tx<{ id: number }[]>`
      INSERT INTO oa_approval_steps (approval_id, seq, label, approver_id, status) VALUES (${id}, ${i + 1}, ${s.label}, ${s.approverId}, 'waiting') RETURNING id`;
    stepIds.push(Number(st!.id));
  }
  const view = { id, title, applicantName: actor.displayName };
  if (chain.steps.length) await activate(tx, view, stepIds[0]!, chain.steps[0]!.approverId);
  for (const staffId of chain.cc) await tx`INSERT INTO oa_approval_cc (approval_id, staff_id) VALUES (${id}, ${staffId})`;
  if (chain.cc.length) {
    await notify(tx, chain.cc, { kind: 'system', title: `抄送：${actor.displayName}的${title}`, link: link(id), ref: { type: 'oa_approval', id } });
  }
  // 附件：新传的挂到这一张；重新提交沿用上一版（及更早各版）的，留在原来那一版上（自己传的才行），详情按表单里的编号取
  const wanted = formAttachmentIds(template.fields, form);
  const carried =
    input.previousId !== null && wanted.length
      ? (
          await tx<{ id: number }[]>`
            SELECT id FROM oa_attachments WHERE id IN ${tx(wanted)} AND uploaded_by = ${actor.id}
              AND ref_type = 'oa_approval' AND ref_id IN ${tx(await revisionsUpTo(tx, input.previousId))}`
        ).map((r) => Number(r.id))
      : [];
  await bindAttachments(
    tx,
    wanted.filter((x) => !carried.includes(x)),
    actor,
    { type: 'oa_approval', id },
  );
  // 发起人就是最上级、一级都不剩的：直接通过（OA12）
  if (!chain.steps.length) await finish(tx, env, { id, title, applicantId: actor.id, templateCode: template.code, form }, 'approved');
  return id;
}

type Locked = { id: number; title: string; applicantId: number; applicantName: string; status: string; templateCode: string; form: ApprovalForm; lastUrgedAt: Date | null };

async function act(tx: Tx, actor: Actor, id: number, input: z.infer<typeof ActInput>, env: LinkEnv): Promise<void> {
  const [a] = await tx<Locked[]>`
    SELECT a.id, a.title, a.applicant_id, s.display_name AS applicant_name, a.status, a.template_code, a.form, a.last_urged_at
    FROM oa_approvals a JOIN staff s ON s.id = a.applicant_id WHERE a.id = ${id} FOR UPDATE OF a`;
  if (!a || !(await canViewApproval(tx, actor, id))) throw notFound('审批单不存在');
  const approval = { ...a, id: Number(a.id), applicantId: Number(a.applicantId) };
  const event = (kind: string, extra: { stepId?: number; toStaffId?: number; comment?: string } = {}) =>
    tx`INSERT INTO oa_approval_events (approval_id, actor_id, kind, step_id, to_staff_id, comment)
       VALUES (${id}, ${actor.id}, ${kind}, ${extra.stepId ?? null}, ${extra.toStaffId ?? null}, ${extra.comment ?? ''})`;
  if (input.action === 'comment') {
    await event('comment', { comment: input.comment });
    return;
  }
  if (approval.status !== 'pending') throw conflict('APPROVAL_CLOSED', `这张单${APPROVAL_STATUS_LABELS[approval.status as ApprovalStatus]}，请刷新`);
  const [pending] = await tx<{ id: number; seq: number; label: string; approverId: number }[]>`
    SELECT id, seq, label, approver_id FROM oa_approval_steps WHERE approval_id = ${id} AND status = 'pending' FOR UPDATE`;
  const step = pending ? { ...pending, id: Number(pending.id), approverId: Number(pending.approverId) } : null;
  await tx`UPDATE oa_approvals SET version = version + 1 WHERE id = ${id}`;

  if (input.action === 'withdraw' || input.action === 'urge') {
    if (approval.applicantId !== actor.id && !(input.action === 'urge' && can(actor, 'oa.all'))) {
      throw forbidden(input.action === 'withdraw' ? '只有发起人能撤销' : '只有发起人或管全部审批单的人能催办');
    }
    if (input.action === 'withdraw') {
      const [done] = await tx`SELECT 1 FROM oa_approval_steps WHERE approval_id = ${id} AND status = 'approved' LIMIT 1`;
      if (done) throw unprocessable('WITHDRAW_TOO_LATE', '已经有人审批通过了，不能撤销');
      await event('withdraw', { comment: input.comment });
      await finish(tx, env, approval, 'withdrawn');
      return;
    }
    const gap = approval.lastUrgedAt ? Date.now() - new Date(approval.lastUrgedAt).getTime() : Infinity;
    if (gap < APPROVAL_URGE_GAP_MINUTES * 60_000) throw unprocessable('URGE_TOO_SOON', `催办过了，${APPROVAL_URGE_GAP_MINUTES} 分钟内不再催`);
    await tx`UPDATE oa_approvals SET last_urged_at = now() WHERE id = ${id}`;
    await event('urge');
    await notify(tx, [step!.approverId], { kind: 'approval_urge', title: `催办：${approval.applicantName}的${approval.title}`, link: link(id), ref: { type: 'oa_approval', id } });
    return;
  }

  // 通过、驳回、转交：只有这一步的审批人，带页面上看到的那一步
  if (!step || step.approverId !== actor.id) throw forbidden('现在不是你审批');
  if (input.stepId !== step.id) throw conflict('STEP_CHANGED', '这张单刚被处理过，请刷新');
  if (input.action === 'approve') {
    await tx`UPDATE oa_approval_steps SET status = 'approved', comment = ${input.comment}, acted_at = now() WHERE id = ${step.id}`;
    await event('approve', { stepId: step.id, comment: input.comment });
    const [next] = await tx<{ id: number; approverId: number }[]>`
      SELECT id, approver_id FROM oa_approval_steps WHERE approval_id = ${id} AND status = 'waiting' AND seq > ${step.seq} ORDER BY seq, id LIMIT 1`;
    if (next) await activate(tx, approval, Number(next.id), Number(next.approverId));
    else await finish(tx, env, approval, 'approved');
    return;
  }
  if (input.action === 'reject') {
    await tx`UPDATE oa_approval_steps SET status = 'rejected', comment = ${input.comment}, acted_at = now() WHERE id = ${step.id}`;
    await event('reject', { stepId: step.id, comment: input.comment });
    await finish(tx, env, approval, 'rejected', input.comment);
    return;
  }
  // 转交：给另一位在职员工（不能是自己、发起人），同一级再加一步
  if (input.toStaffId === actor.id || input.toStaffId === approval.applicantId) throw unprocessable('TRANSFER_INVALID', '不能转交给自己或发起人');
  if (!(await onDuty(tx, input.toStaffId))) throw unprocessable('TRANSFER_INVALID', '要转交给一位在职员工');
  const [st] = await tx<{ id: number }[]>`
    INSERT INTO oa_approval_steps (approval_id, seq, label, approver_id, status) VALUES (${id}, ${step.seq}, ${step.label}, ${input.toStaffId}, 'waiting') RETURNING id`;
  const newId = Number(st!.id);
  await tx`UPDATE oa_approval_steps SET status = 'transferred', transferred_to = ${newId}, comment = ${input.comment}, acted_at = now() WHERE id = ${step.id}`;
  await event('transfer', { stepId: step.id, toStaffId: input.toStaffId, comment: input.comment });
  await activate(tx, approval, newId, input.toStaffId);
}

export function registerOaApprovalRoutes(app: FastifyInstance, { sql, config }: Deps) {
  const auth = guard();
  registerAttachmentRef('oa_approval', canViewApprovalAttachment);

  app.get(
    '/api/oa/approval/templates',
    { preHandler: auth },
    async (): Promise<ApprovalTemplate[]> => (await sql<ApprovalTemplate[]>`SELECT ${TEMPLATE_COLS(sql)} FROM oa_approval_templates WHERE active ORDER BY sort, id`).map(toTemplate),
  );

  // 提交（含驳回以后重新提交）
  app.post('/api/oa/approvals', { preHandler: auth }, async (req, reply): Promise<ApprovalSaved> => {
    const input = parse(SubmitInput, req.body);
    const hash = hashRequest({ templateId: input.templateId, form: input.form, previousId: input.previousId });
    const { id, replayed } = await sql.begin(async (tx) => {
      await lockOpKey(tx, input.clientKey);
      const [seen] = await tx<{ opType: string; requestHash: string; refId: number; staffId: number }[]>`
        SELECT op_type, request_hash, ref_id, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
      if (seen) {
        if (seen.opType !== 'oa_approval_submit' || seen.requestHash !== hash || Number(seen.staffId) !== req.actor.id) {
          throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重新提交');
        }
        return { id: Number(seen.refId), replayed: true };
      }
      await assertNotFenced(tx, input.clientKey, 'oa_approval_submit', erpOpAbandoned);
      return { id: await submit(tx, req.actor, input, hash, { timeZone: config.timezone, at: new Date() }), replayed: false };
    });
    reply.code(replayed ? 200 : 201);
    return { approval: await loadApproval(sql, req.actor, id), replayed };
  });

  // 处理：通过、驳回、转交、撤销、评论、催办
  app.post('/api/oa/approvals/:id/act', { preHandler: auth }, async (req): Promise<ApprovalSaved> => {
    const { id } = parse(idParam, req.params);
    const input = parse(ActInput, req.body);
    const { clientKey, ...rest } = input;
    const hash = hashRequest({ id, ...rest });
    const replayed = await sql.begin(async (tx): Promise<boolean> => {
      await lockOpKey(tx, clientKey);
      const [seen] = await tx<{ opType: string; requestHash: string; staffId: number }[]>`SELECT op_type, request_hash, staff_id FROM idempotency_keys WHERE key = ${clientKey}`;
      if (seen) {
        if (seen.opType !== 'oa_approval_act' || seen.requestHash !== hash || Number(seen.staffId) !== req.actor.id) {
          throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重新处理');
        }
        return true;
      }
      await assertNotFenced(tx, clientKey, 'oa_approval_act', erpOpAbandoned);
      await act(tx, req.actor, id, input, { timeZone: config.timezone, at: new Date() });
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${clientKey}, 'oa_approval_act', ${hash}, ${id}, ${req.actor.id})`;
      return false;
    });
    return { approval: await loadApproval(sql, req.actor, id), replayed };
  });

  // 转交时选的人：在职员工（登录就能看名字与部门）
  app.get('/api/oa/approval/people', { preHandler: auth }, async (): Promise<ApprovalPerson[]> => {
    const rows = await sql<{ id: number; name: string; position: PositionKey | null }[]>`
      SELECT s.id, s.display_name AS name, s.position FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
      WHERE s.active AND NOT s.system AND s.role <> ALL(${NOT_EMPLOYEE_ROLES}) AND COALESCE(p.status, 'active') = 'active'
      ORDER BY s.display_name, s.id`;
    return rows.map((r) => {
      const dept = departmentOfPosition(r.position);
      return { id: Number(r.id), name: r.name, department: ORG_DEPARTMENTS.find((d) => d.key === dept)?.name ?? '' };
    });
  });

  // 抄送我的：看过记已读（重复点不要紧）
  app.post('/api/oa/approvals/:id/read', { preHandler: auth }, async (req): Promise<{ ok: true }> => {
    const { id } = parse(idParam, req.params);
    await sql`UPDATE oa_approval_cc SET read_at = now() WHERE approval_id = ${id} AND staff_id = ${req.actor.id} AND read_at IS NULL`;
    return { ok: true };
  });

  app.get('/api/oa/approvals/summary', { preHandler: auth }, async (req): Promise<ApprovalSummary> => {
    const [r] = await sql<ApprovalSummary[]>`
      SELECT (SELECT count(*)::int FROM oa_approval_steps WHERE approver_id = ${req.actor.id} AND status = 'pending') AS todo,
             (SELECT count(*)::int FROM oa_approval_cc WHERE staff_id = ${req.actor.id} AND read_at IS NULL) AS cc_unread`;
    return r!;
  });

  app.get('/api/oa/approvals', { preHandler: auth }, async (req): Promise<ApprovalPage> => {
    const q = parse(ListQuery, req.query ?? {});
    const me = req.actor.id;
    const box: Record<ApprovalBox, Fragment> = {
      todo: sql`EXISTS (SELECT 1 FROM oa_approval_steps st WHERE st.approval_id = a.id AND st.approver_id = ${me} AND st.status = 'pending')`,
      done: sql`EXISTS (SELECT 1 FROM oa_approval_steps st WHERE st.approval_id = a.id AND st.approver_id = ${me} AND st.status IN ('approved', 'rejected', 'transferred'))`,
      mine: sql`a.applicant_id = ${me}`,
      cc: sql`EXISTS (SELECT 1 FROM oa_approval_cc c WHERE c.approval_id = a.id AND c.staff_id = ${me})`,
    };
    const items = await listApprovals(
      sql,
      me,
      sql`${box[q.box]} ${q.status ? sql`AND a.status = ${q.status}` : sql``} ${q.template ? sql`AND a.template_code = ${q.template}` : sql``} ${q.before ? sql`AND a.id < ${q.before}` : sql``}`,
      PAGE + 1,
    );
    return { items: items.slice(0, PAGE), next: items.length > PAGE ? items[PAGE - 1]!.id : null };
  });

  app.get('/api/oa/approvals/:id', { preHandler: auth }, async (req): Promise<ApprovalDetail> => {
    const { id } = parse(idParam, req.params);
    const ok = await canViewApproval(sql, req.actor, id);
    if (!ok) throw notFound('审批单不存在');
    return loadApproval(sql, req.actor, id);
  });
}
