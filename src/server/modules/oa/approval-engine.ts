// OA-10 办公审批引擎（docs/OA.md 第 13 节；需求文档五（一））：审批人怎么取、条件加签、各模板的挂接点、谁能看、单据详情。
// 接口在 approvals.ts。审批人在提交那一刻定下来（OA12）：
//   · 本部门主管 / 上级部门主管 / 总经办按 OA-01 的「部门实际主管」取；取到发起人自己的往上一级部门取，一路取不到的给总裁；
//   · 取到的是发起人自己（发起人就是最上级）的那一级不要；相邻两级同一个人的并成一级；一级都不剩的直接通过。
//   · 条件开关硬编码在这里（CONDITIONS），模板里开或关。

import { departmentOfPosition } from '@shared/oa';
import { can } from '@shared/permissions';
import {
  formAttachmentIds,
  LEVEL_KIND_LABELS,
  type ApprovalCcSpec,
  type ApprovalCondition,
  type ApprovalDetail,
  type ApprovalEvent,
  type ApprovalField,
  type ApprovalForm,
  type ApprovalLevelSpec,
  type ApprovalListItem,
  type ApprovalStep,
  type ApprovalTemplate,
} from '@shared/oa-approval';
import type { OrgDepartment, PositionKey } from '@shared/positions';
import type { Db, Fragment } from '../../db';
import type { Actor } from '../../lib/context';
import { unprocessable } from '../../lib/errors';
import { TEMPLATE_HOOKS, type ApprovalHooks } from './approval-templates';
import { attachmentsOf } from './attachments';
import { loadOrg } from './org';

type Level = ApprovalLevelSpec | { kind: 'gmo' };

/** 条件开关：按模板编码与表单判断要不要加一级（OA-11 的请假、报销表单用） */
const CONDITIONS: Record<ApprovalCondition, { applies: (code: string, form: ApprovalForm) => boolean; level: Level; label: string }> = {
  // 请假时长（半天为单位，OA-11 的请假表单算好放在 durationHalves）超过 3 天
  leave_over_3_days: { applies: (code, form) => code === 'leave' && Number(form.durationHalves ?? 0) > 6, level: { kind: 'parent_head' }, label: '超过 3 天加签' },
  // 报销金额（分）超过 5000 元
  expense_over_5000: { applies: (code, form) => code === 'expense' && Number(form.amount ?? 0) > 500_000, level: { kind: 'gmo' }, label: '超过 5000 元加签' },
};

export const hooksOf = (code: string): ApprovalHooks => TEMPLATE_HOOKS[code] ?? {};

export const TEMPLATE_COLS = (db: Db) => db`id, code, name, description, fields, levels, conditions, cc, active, sort, version`;
export const toTemplate = (r: ApprovalTemplate): ApprovalTemplate => ({ ...r, id: Number(r.id) });

/** 发起人的部门往上一级一级的主管（含本部门），跳过取不到的与发起人自己；最后是总裁 */
async function resolver(db: Db, applicant: { id: number; position?: PositionKey | null }) {
  const org = await loadOrg(db);
  const byKey = new Map(org.departments.map((d) => [d.key, d]));
  // 总裁：岗位是总裁的在职员工；老账号没选岗位的店主也算（最早建的一位）
  const [top] = await db<{ id: number }[]>`
    SELECT s.id FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
    WHERE s.active AND NOT s.system AND COALESCE(p.status, 'active') = 'active' AND (s.position = 'president' OR (s.position IS NULL AND s.role = 'owner'))
    ORDER BY COALESCE(s.position = 'president', false) DESC, s.id LIMIT 1`;
  const president = top ? { id: Number(top.id) } : null;
  const own = departmentOfPosition(applicant.position ?? null) ?? 'company';
  /** 从 start 部门往上找第一位不是发起人的主管；一路都没有就是总裁（总裁就是发起人自己时为空） */
  const upFrom = (start: OrgDepartment | null): number | null => {
    const seen = new Set<string>();
    for (let k = start; k && !seen.has(k); k = byKey.get(k)?.parentKey ?? null) {
      seen.add(k);
      const head = byKey.get(k)?.head;
      if (head && head.id !== applicant.id) return head.id;
    }
    return president && president.id !== applicant.id ? president.id : null;
  };
  const activeIds = new Set(org.employees.filter((e) => e.active && e.status === 'active').map((e) => e.staffId));
  return {
    level(spec: Level): number | null {
      switch (spec.kind) {
        case 'staff':
          if (!activeIds.has(spec.staffId)) throw unprocessable('APPROVER_INVALID', '模板里指定的审批人已离职或停用，请联系人事改模板');
          return spec.staffId === applicant.id ? null : spec.staffId;
        case 'dept_head':
          return upFrom(own);
        case 'parent_head':
          return upFrom(byKey.get(own)?.parentKey ?? null);
        case 'gmo':
          return upFrom('gmo');
        // OA-18：人力行政部的主管（没有就往上找，都没有给总裁）；申请人自己就是的，往上一级
        case 'hr_head':
          return upFrom('hr');
      }
    },
    cc(spec: ApprovalCcSpec): number | null {
      if (spec.kind === 'staff') return activeIds.has(spec.staffId) && spec.staffId !== applicant.id ? spec.staffId : null;
      return upFrom(own);
    },
  };
}

/** 按模板与表单定下审批链与抄送人（提交时调用） */
export async function resolveChain(
  db: Db,
  template: Pick<ApprovalTemplate, 'code' | 'levels' | 'conditions' | 'cc'>,
  applicant: { id: number; position?: PositionKey | null },
  form: ApprovalForm,
): Promise<{ steps: { approverId: number; label: string }[]; cc: number[] }> {
  const r = await resolver(db, applicant);
  const levels: { spec: Level; label: string }[] = template.levels.map((spec) => ({ spec, label: LEVEL_KIND_LABELS[spec.kind] }));
  for (const [code, on] of Object.entries(template.conditions) as [ApprovalCondition, boolean][]) {
    const c = CONDITIONS[code];
    if (on && c?.applies(template.code, form)) levels.push({ spec: c.level, label: c.label });
  }
  const steps: { approverId: number; label: string }[] = [];
  for (const l of levels) {
    const id = r.level(l.spec);
    if (id === null) continue;
    // 相邻两级是同一个人的并成一级
    if (steps.at(-1)?.approverId === id) continue;
    steps.push({ approverId: id, label: l.label });
  }
  const cc = [...new Set(template.cc.map((c) => r.cc(c)).filter((x): x is number => x !== null && !steps.some((s) => s.approverId === x)))];
  return { steps, cc };
}

/** 能不能看这张单：发起人、链上的审批人（含转交前后）、抄送人 */
export function canViewSql(db: Db, actorId: number): Fragment {
  return db`(a.applicant_id = ${actorId}
    OR EXISTS (SELECT 1 FROM oa_approval_steps st WHERE st.approval_id = a.id AND st.approver_id = ${actorId})
    OR EXISTS (SELECT 1 FROM oa_approval_cc c WHERE c.approval_id = a.id AND c.staff_id = ${actorId}))`;
}
export async function canViewApproval(db: Db, actor: Actor, id: number): Promise<boolean> {
  // 有「全部审批单」权限的能看任何一张（OA-12）
  const [row] = can(actor, 'oa.all') ? await db`SELECT 1 FROM oa_approvals WHERE id = ${id}` : await db`SELECT 1 FROM oa_approvals a WHERE a.id = ${id} AND ${canViewSql(db, actor.id)}`;
  return !!row;
}

/** 这一张与之前的各版（重新提交一路往前），自己在第一个 */
export async function revisionsUpTo(db: Db, id: number): Promise<number[]> {
  const rows = await db<{ id: number }[]>`
    WITH RECURSIVE up AS (SELECT id, previous_id, 0 AS depth FROM oa_approvals WHERE id = ${id}
      UNION ALL SELECT a.id, a.previous_id, up.depth + 1 FROM oa_approvals a JOIN up ON a.id = up.previous_id)
    SELECT id FROM up ORDER BY depth`;
  return rows.map((r) => Number(r.id));
}

/**
 * 附件挂在哪一版上，能看那一版或之后重新提交的任一版的人都能看（重新提交沿用的附件还挂在最早那一版上，
 * 新一版的审批人也要看得到，Codex 审查 62e6f5e）
 */
export async function canViewApprovalAttachment(db: Db, actor: Actor, id: number): Promise<boolean> {
  if (can(actor, 'oa.all')) return true;
  const [row] = await db`
    WITH RECURSIVE down AS (SELECT id FROM oa_approvals WHERE id = ${id}
      UNION ALL SELECT a.id FROM oa_approvals a JOIN down ON a.previous_id = down.id)
    SELECT 1 FROM oa_approvals a WHERE a.id IN (SELECT id FROM down) AND ${canViewSql(db, actor.id)} LIMIT 1`;
  return !!row;
}

type ListRow = Omit<ApprovalListItem, 'submittedAt' | 'finishedAt' | 'ccReadAt'> & { submittedAt: Date; finishedAt: Date | null; ccReadAt?: Date | null };
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** 列表（where 里 a = oa_approvals） */
export async function listApprovals(db: Db, actorId: number, where: Fragment, limit: number): Promise<ApprovalListItem[]> {
  const rows = await db<ListRow[]>`
    SELECT a.id, a.title, a.template_code, a.template_name, a.applicant_id, s.display_name AS applicant_name, a.status, a.revision,
           a.submitted_at, a.finished_at,
           (SELECT p.display_name FROM oa_approval_steps st JOIN staff p ON p.id = st.approver_id WHERE st.approval_id = a.id AND st.status = 'pending') AS current_approver_name,
           (SELECT c.read_at FROM oa_approval_cc c WHERE c.approval_id = a.id AND c.staff_id = ${actorId}) AS cc_read_at
    FROM oa_approvals a JOIN staff s ON s.id = a.applicant_id
    WHERE ${where}
    ORDER BY a.id DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, id: Number(r.id), applicantId: Number(r.applicantId), submittedAt: iso(r.submittedAt)!, finishedAt: iso(r.finishedAt), ccReadAt: iso(r.ccReadAt) }));
}

/** 单据详情（调用方已经核对过能看） */
export async function loadApproval(db: Db, actor: Actor, id: number): Promise<ApprovalDetail> {
  const [item] = await listApprovals(db, actor.id, db`a.id = ${id}`, 1);
  const [extra] = await db<{ fields: ApprovalField[]; form: ApprovalForm; previousId: number | null; nextId: number | null; lastUrgedAt: Date | null }[]>`
    SELECT a.fields, a.form, a.previous_id, a.last_urged_at, (SELECT n.id FROM oa_approvals n WHERE n.previous_id = a.id) AS next_id
    FROM oa_approvals a WHERE a.id = ${id}`;
  const stepRows = await db<(Omit<ApprovalStep, 'actedAt'> & { actedAt: Date | null })[]>`
    SELECT st.id, st.seq, st.label, st.approver_id, p.display_name AS approver_name, st.status, st.comment, st.acted_at,
           (SELECT q.display_name FROM oa_approval_steps t JOIN staff q ON q.id = t.approver_id WHERE t.id = st.transferred_to) AS transferred_to_name
    FROM oa_approval_steps st JOIN staff p ON p.id = st.approver_id
    WHERE st.approval_id = ${id} ORDER BY st.seq, st.id`;
  const steps = stepRows.map((s) => ({ ...s, id: Number(s.id), approverId: Number(s.approverId), actedAt: iso(s.actedAt) }));
  const eventRows = await db<(Omit<ApprovalEvent, 'createdAt'> & { createdAt: Date })[]>`
    SELECT e.id, e.kind, e.actor_id, s.display_name AS actor_name, t.display_name AS to_name, e.comment, e.created_at
    FROM oa_approval_events e JOIN staff s ON s.id = e.actor_id LEFT JOIN staff t ON t.id = e.to_staff_id
    WHERE e.approval_id = ${id} ORDER BY e.id`;
  const cc = await db<{ staffId: number; name: string; readAt: Date | null }[]>`
    SELECT c.staff_id, s.display_name AS name, c.read_at FROM oa_approval_cc c JOIN staff s ON s.id = c.staff_id WHERE c.approval_id = ${id} ORDER BY c.staff_id`;
  const pending = steps.find((s) => s.status === 'pending') ?? null;
  const mine = item!.applicantId === actor.id;
  const pendingStatus = item!.status === 'pending';
  const urgeReady = !extra!.lastUrgedAt || Date.now() - new Date(extra!.lastUrgedAt).getTime() >= 60 * 60_000;
  return {
    ...item!,
    fields: extra!.fields,
    form: extra!.form,
    previousId: extra!.previousId === null ? null : Number(extra!.previousId),
    nextId: extra!.nextId === null ? null : Number(extra!.nextId),
    steps,
    events: eventRows.map((e) => ({ ...e, id: Number(e.id), actorId: Number(e.actorId), createdAt: iso(e.createdAt)! })),
    cc: cc.map((c) => ({ staffId: Number(c.staffId), name: c.name, readAt: iso(c.readAt) })),
    attachments: await attachmentsOf(db, { type: 'oa_approval', id: await revisionsUpTo(db, id) }, formAttachmentIds(extra!.fields, extra!.form)),
    pendingStepId: pending?.id ?? null,
    can: {
      approve: !!pending && pending.approverId === actor.id,
      reject: !!pending && pending.approverId === actor.id,
      transfer: !!pending && pending.approverId === actor.id,
      withdraw: mine && pendingStatus && !steps.some((s) => s.status === 'approved'),
      // 发起人催办；有「全部审批单」权限的也能催（OA-12），同一个一小时一次的限制
      urge: (mine || can(actor, 'oa.all')) && pendingStatus && urgeReady,
      comment: true,
      resubmit: mine && item!.status === 'rejected' && extra!.nextId === null,
    },
  };
}
