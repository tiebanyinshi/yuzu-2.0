// 业财法审批流的接口（P01，docs/APPROVAL_V4.md 第 4 节）：
//   /api/gf/meta                      角色清单、我的角色、经营主体、部门（含负责人）、员工
//   /api/gf/roles                     角色映射（gf.roles，店主配置）：列表、加、撤销
//   /api/gf/docs                      事项：新建（操作编号幂等）、列表（我发起 / 待我审批 / 知会我 / 全部）
//   /api/gf/docs/:id                  详情（审批链、每级结论、知会、特批、状态）
//   /api/gf/docs/:id/submit|act|withdraw|execute
//   /api/gf/specials                  微信特批：登记（两人确认、唯一特批编号）、列表、补登（需求说明 + OK 截图）
//   /api/gf/files/:id                 下载补登的文件（看得到事项 / 特批的人）
//   /api/gf/config…                   流程与阈值（8.2.15，config.ts）

import { createHash } from 'node:crypto';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import {
  GF_FILE_MAX_BYTES,
  GF_FILE_MIMES,
  GF_FILE_PURPOSES,
  GF_FLAGS,
  GF_ROLE_LABELS,
  GF_ROLES,
  GF_SPECIAL_BACKFILL_WORKDAYS,
  addWorkdays,
  nodeLabel,
  seatsFor,
  type GfActionView,
  type GfDocCard,
  type GfDocDetail,
  type GfDocType,
  type GfFilePurpose,
  type GfFlag,
  type GfMeta,
  type GfNodeView,
  type GfRole,
  type GfRoleChange,
  type GfRoleMember,
  type GfSpecialView,
  type GfStage,
} from '@shared/govflow';
import { can } from '@shared/permissions';
import type { Db, Fragment, Tx } from '../../db';
import { isUniqueViolation } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { dateIn, todayIn } from '../../lib/dates';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { hashRequest } from '../../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../../lib/tx';
import { idParam, parse } from '../../lib/validate';
import { NOT_EMPLOYEE_ROLES } from '../oa/org';
import { notify } from '../oa/notifications';
import { registerGovflowExport } from './export';
import { actFlow, addCc, docOf, hooksOf, insertDoc, latestFlow, loadDoc, loadMembers, rolesOf, seatContext, seatLabel, statusOf, submitFlow, waitingSeats, type DocRow, type FlowRow } from './engine';
import { registerGfConfigRoutes } from './config';
import { templateFor } from './types';

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
const uuid = z.uuid('缺少有效的操作编号，请刷新页面后重试');

/** 看全部事项的：角色映射管理（店主）、内控、董事长 */
async function seesAll(db: Db, actor: Actor): Promise<boolean> {
  if (can(actor, 'gf.roles')) return true;
  const roles = await rolesOf(db, actor.id);
  return roles.includes('internal_control') || roles.includes('chairman');
}

/** 能不能看这个事项：发起人、履约执行人、事项本人、审批链里能审或审过的、知会的、看全部的 */
async function canView(db: Db, actor: Actor, doc: DocRow): Promise<boolean> {
  if ([doc.createdBy, doc.performerId, doc.subjectStaffId].includes(actor.id)) return true;
  if (await seesAll(db, actor)) return true;
  const [hit] = await db<{ n: number }[]>`
    SELECT (SELECT count(*) FROM gf_flow_actions a JOIN gf_flows f ON f.id = a.flow_id WHERE f.doc_id = ${doc.id} AND a.actor_id = ${actor.id})
         + (SELECT count(*) FROM gf_cc WHERE doc_id = ${doc.id} AND staff_id = ${actor.id})
         + (SELECT count(*) FROM gf_specials WHERE doc_id = ${doc.id} AND (registered_by = ${actor.id} OR ${actor.id} = ANY (confirmer_ids)))::int AS n`;
  if ((hit?.n ?? 0) > 0) return true;
  const flow = await latestFlow(db, doc.id);
  if (!flow) return false;
  const ctx = await seatContext(db, doc, flow);
  return flow.nodes.some((n) => seatsFor(n, actor.id, ctx).length > 0);
}

// ───────────────────────── 角色映射 ─────────────────────────

async function listMembers(db: Db): Promise<GfRoleMember[]> {
  const rows = await db<(Omit<GfRoleMember, 'createdAt'> & { createdAt: Date })[]>`
    SELECT m.id, m.role, m.staff_id, s.display_name AS staff_name, s.username AS staff_no, d.name AS department_name,
           m.entity_id, e.name AS entity_name, m.note, c.display_name AS created_by_name, m.created_at
    FROM gf_role_members m JOIN staff s ON s.id = m.staff_id JOIN staff c ON c.id = m.created_by LEFT JOIN legal_entities e ON e.id = m.entity_id
         LEFT JOIN departments d ON d.id = s.department_id
    WHERE m.revoked_at IS NULL ORDER BY array_position(${GF_ROLES as unknown as string[]}::text[], m.role), s.display_name`;
  return rows.map((r) => ({ ...r, id: Number(r.id), staffId: Number(r.staffId), entityId: r.entityId === null ? null : Number(r.entityId), createdAt: iso(r.createdAt)! }));
}

/** 变更记录（8.2.14，A1）：加（不是替换别的）、改（替换了旧的一条）、撤（撤销且没有被替换），新的在前 */
async function roleChanges(db: Db): Promise<GfRoleChange[]> {
  const rows = await db<(Omit<GfRoleChange, 'at'> & { at: Date })[]>`
    SELECT * FROM (
      SELECT m.id, m.role, s.display_name AS staff_name, s.username AS staff_no, e.name AS entity_name, m.note,
             CASE WHEN m.replaces_id IS NULL THEN 'add' ELSE 'edit' END AS op,
             os.display_name AS replaced_staff_name, coalesce(o.revoke_reason, '') AS reason, c.display_name AS by_name, m.created_at AS at
      FROM gf_role_members m JOIN staff s ON s.id = m.staff_id JOIN staff c ON c.id = m.created_by LEFT JOIN legal_entities e ON e.id = m.entity_id
           LEFT JOIN gf_role_members o ON o.id = m.replaces_id LEFT JOIN staff os ON os.id = o.staff_id
      UNION ALL
      SELECT m.id, m.role, s.display_name, s.username, e.name, m.note, 'revoke', NULL, m.revoke_reason, r.display_name, m.revoked_at
      FROM gf_role_members m JOIN staff s ON s.id = m.staff_id JOIN staff r ON r.id = m.revoked_by LEFT JOIN legal_entities e ON e.id = m.entity_id
      WHERE m.revoked_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gf_role_members n WHERE n.replaces_id = m.id)
    ) x ORDER BY at DESC, id DESC LIMIT 500`;
  return rows.map((r) => ({ ...r, id: Number(r.id), at: iso(r.at)! }));
}

/** 能配业财法角色的员工：在用、不是专用账号 */
async function assertRoleStaff(tx: Tx, staffId: number) {
  const [s] = await tx<{ role: string }[]>`SELECT role FROM staff WHERE id = ${staffId} AND active`;
  if (!s) throw unprocessable('GF_STAFF', '员工不存在或已停用');
  if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(s.role)) throw unprocessable('GF_STAFF', '专用账号不能配业财法角色');
}

const EditInput = z.object({
  staffId: z.number().int().positive('请选员工'),
  entityId: z.number().int().positive().nullable().default(null),
  note: z.string().trim().max(100, '备注最多 100 个字').default(''),
  reason: z.string().trim().min(2, '请写修改原因（至少 2 个字）').max(200, '原因最多 200 个字'),
});
const RevokeInput = z.object({ reason: z.string().trim().max(200, '原因最多 200 个字').default('') });

const MemberInput = z.object({
  role: z.enum(GF_ROLES, '请选角色'),
  staffId: z.number().int().positive('请选员工'),
  entityId: z.number().int().positive().nullable().default(null),
  note: z.string().trim().max(100, '备注最多 100 个字').default(''),
});

// ───────────────────────── 事项 ─────────────────────────

const DocInput = z.object({
  clientKey: uuid,
  docType: z.literal('general', '这里只能发起通用事项；供应商、SKU 等在各自的页面发起'),
  title: z.string().trim().min(1, '请写事项名称').max(100, '事项名称最多 100 个字'),
  note: z.string().trim().max(1000, '说明最多 1000 个字').default(''),
  entityId: z.number().int().positive().nullable().default(null),
  departmentId: z.number().int().positive('请选费用承担部门'),
  amountCents: z.number().int().min(0, '金额不能是负数').max(100_000_000_000, '金额太大').nullable().default(null),
  flags: z.array(z.enum(GF_FLAGS)).max(GF_FLAGS.length).default([]),
  performerId: z.number().int().positive().nullable().default(null),
  subjectStaffId: z.number().int().positive().nullable().default(null),
  payload: z.object({ contractLike: z.boolean().default(false) }).default({ contractLike: false }),
  submit: z.boolean().default(true),
});

async function createDoc(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<number> {
  const input = parse(DocInput, raw);
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const existing = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string; createdBy: number }[]>`SELECT id, request_hash, created_by FROM gf_docs WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash || Number(row.createdBy) !== actor.id) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一个事项，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const found = await existing(tx);
      if (found) return found;
      const [dept] = await tx`SELECT 1 FROM departments WHERE id = ${input.departmentId} AND active`;
      if (!dept) throw unprocessable('GF_DEPT', '费用承担部门不存在或已停用');
      if (input.entityId !== null) {
        const [e] = await tx`SELECT 1 FROM legal_entities WHERE id = ${input.entityId}`;
        if (!e) throw unprocessable('GF_ENTITY', '经营主体不存在');
      }
      for (const [label, sid] of [
        ['内部履约执行人', input.performerId],
        ['事项本人', input.subjectStaffId],
      ] as const) {
        if (sid === null) continue;
        const [s] = await tx`SELECT 1 FROM staff WHERE id = ${sid} AND active`;
        if (!s) throw unprocessable('GF_STAFF', `${label}不存在或已停用`);
      }
      if (input.performerId !== null) {
        const members = await loadMembers(tx, input.entityId);
        if (!(members.performer ?? []).includes(input.performerId)) throw unprocessable('GF_PERFORMER_ROLE', '选的人不在「内部履约执行人」角色里，请店主先在角色映射里配上');
      }
      if (input.payload.contractLike && input.performerId === null) throw unprocessable('GF_NO_PERFORMER', '合同类事项要选内部履约执行人');
      const flags = [...new Set(input.flags)];
      const id = await insertDoc(tx, { ...input, flags, clientKey: input.clientKey, requestHash }, actor, todayIn(deps.config.timezone));
      const bizNo = (await loadDoc(tx, id)).bizNo;
      await writeAudit(tx, { staffId: actor.id, action: 'gf_doc', targetType: 'gf_doc', targetId: id, detail: { op: 'create', bizNo, amountCents: input.amountCents, flags }, ip });
      if (input.submit) {
        const doc = await loadDoc(tx, id, true);
        await submitFlow(tx, doc, await templateFor(tx, doc), actor);
      }
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'gf_docs_client_key_key')) {
      const found = await existing(deps.sql);
      if (found) return found;
    }
    throw error;
  }
}

interface ListRow {
  id: number;
  bizNo: string;
  docType: GfDocType;
  title: string;
  amountCents: number | null;
  departmentName: string | null;
  entityName: string | null;
  flags: GfFlag[];
  createdByName: string;
  createdAt: Date;
}

async function cardsOf(db: Db, actor: Actor, rows: Record<string, unknown>[], timeZone: string): Promise<GfDocCard[]> {
  const out: GfDocCard[] = [];
  for (const raw of rows) {
    const doc = docOf(raw);
    const r = raw as unknown as ListRow;
    const flow = await latestFlow(db, doc.id);
    const st = await statusOf(db, doc, flow?.status ?? null, timeZone);
    let canAct = false;
    let currentLabel: string | null = null;
    if (flow?.status === 'pending') {
      currentLabel = `第 ${flow.currentLevel} 级 · ${nodeLabel(flow.nodes[flow.currentLevel - 1]!)}`;
      const waiting = await waitingSeats(db, doc, flow);
      canAct = waiting.some((w) => w.staffIds.includes(actor.id));
    }
    out.push({
      id: doc.id,
      bizNo: doc.bizNo,
      docType: r.docType,
      title: doc.title,
      amountCents: doc.amountCents,
      departmentName: r.departmentName,
      entityName: r.entityName,
      flags: doc.flags as GfFlag[],
      status: st.status,
      overdue: st.overdue,
      createdByName: r.createdByName,
      createdAt: iso(r.createdAt)!,
      currentLabel,
      canAct,
    });
  }
  return out;
}

const LIST_SELECT = (db: Db) => db`
  SELECT d.*, dp.name AS department_name, e.name AS entity_name, c.display_name AS created_by_name
  FROM gf_docs d LEFT JOIN departments dp ON dp.id = d.department_id LEFT JOIN legal_entities e ON e.id = d.entity_id JOIN staff c ON c.id = d.created_by`;

async function listDocs(deps: Deps, actor: Actor, box: 'mine' | 'todo' | 'cc' | 'all'): Promise<GfDocCard[]> {
  const db = deps.sql;
  const tz = deps.config.timezone;
  if (box === 'mine') return cardsOf(db, actor, await db`${LIST_SELECT(db)} WHERE d.created_by = ${actor.id} ORDER BY d.id DESC LIMIT 200`, tz);
  if (box === 'cc') {
    return cardsOf(db, actor, await db`${LIST_SELECT(db)} WHERE d.id IN (SELECT doc_id FROM gf_cc WHERE staff_id = ${actor.id}) ORDER BY d.id DESC LIMIT 200`, tz);
  }
  if (box === 'all') {
    if (!(await seesAll(db, actor))) throw forbidden('只有店主、内控、董事长看得到全部事项');
    return cardsOf(db, actor, await db`${LIST_SELECT(db)} ORDER BY d.id DESC LIMIT 300`, tz);
  }
  // 待我审批：在审的每一轮，当前这一级我能坐还空着的席
  const rows = await db`${LIST_SELECT(db)} WHERE d.id IN (SELECT doc_id FROM gf_flows WHERE status = 'pending') ORDER BY d.id`;
  const cards = await cardsOf(db, actor, rows, tz);
  return cards.filter((c) => c.canAct);
}

async function detail(deps: Deps, actor: Actor, id: number): Promise<GfDocDetail> {
  const db = deps.sql;
  const doc = await loadDoc(db, id);
  if (!(await canView(db, actor, doc))) throw forbidden('你看不到这个事项');
  const [card] = await cardsOf(db, actor, await db`${LIST_SELECT(db)} WHERE d.id = ${id}`, deps.config.timezone);
  const flow = await latestFlow(db, id);
  const names = new Map((await db<{ id: number; displayName: string }[]>`SELECT id, display_name FROM staff`).map((s) => [Number(s.id), s.displayName]));
  let nodes: GfNodeView[] = [];
  let actions: GfActionView[] = [];
  let mySeats: string[] = [];
  if (flow) {
    const acts = await db<{ id: number; level: number; action: GfActionView['action']; seat: string; actorId: number; comment: string; createdAt: Date }[]>`
      SELECT id, level, action, seat, actor_id, comment, created_at FROM gf_flow_actions WHERE flow_id = ${flow.id} ORDER BY id`;
    actions = acts.map((a) => ({
      id: Number(a.id),
      level: a.level,
      action: a.action,
      seat: seatLabel(a.seat),
      actorName: names.get(Number(a.actorId)) ?? `#${a.actorId}`,
      comment: a.comment,
      createdAt: iso(a.createdAt)!,
    }));
    const ctx = await seatContext(db, doc, flow);
    const waiting = flow.status === 'pending' ? await waitingSeats(db, doc, flow, ctx) : [];
    nodes = flow.nodes.map((n, i) => {
      const level = i + 1;
      const levelActs = acts.filter((a) => a.level === level);
      const end = levelActs.find((a) => a.action === 'return' || a.action === 'reject');
      let state: GfNodeView['state'];
      if (end) state = end.action === 'return' ? 'returned' : 'rejected';
      else if (flow.status === 'approved' || level < flow.currentLevel) state = levelActs.length && levelActs.every((a) => a.action === 'skip') ? 'skipped' : 'done';
      else if (level === flow.currentLevel && flow.status === 'pending') state = 'current';
      else state = 'waiting';
      const isCurrent = state === 'current';
      return {
        level,
        label: nodeLabel(n),
        stage: (n.stage ?? 'review') as GfStage,
        state,
        waiting: isCurrent ? waiting.map((w) => seatLabel(w.seat)) : [],
        eligibleNames: isCurrent ? [...new Set(waiting.flatMap((w) => w.staffIds))].map((sid) => names.get(sid) ?? `#${sid}`) : [],
      };
    });
    if (flow.status === 'pending') {
      const node = flow.nodes[flow.currentLevel - 1]!;
      mySeats = waiting.filter((w) => w.staffIds.includes(actor.id) && seatsFor(node, actor.id, ctx).includes(w.seat as never)).map((w) => seatLabel(w.seat));
    }
  }
  const cc = await db<{ staffId: number; role: GfRole; urgent: boolean; notifiedAt: Date | null; readAt: Date | null }[]>`
    SELECT staff_id, role, urgent, notified_at, read_at FROM gf_cc WHERE doc_id = ${id} ORDER BY id`;
  const specials = await listSpecials(db, db`s.doc_id = ${id}`, deps.config.timezone);
  const owner = doc.createdBy === actor.id;
  const approved = flow?.status === 'approved';
  return {
    ...card!,
    payload: doc.payload,
    departmentId: doc.departmentId,
    entityId: doc.entityId,
    performerId: doc.performerId,
    performerName: doc.performerId ? (names.get(doc.performerId) ?? null) : null,
    subjectStaffId: doc.subjectStaffId,
    note: String((await db<{ note: string }[]>`SELECT note FROM gf_docs WHERE id = ${id}`)[0]!.note),
    version: doc.version,
    flowId: flow?.id ?? null,
    round: flow?.round ?? 0,
    currentLevel: flow?.status === 'pending' ? flow.currentLevel : null,
    nodes,
    notes: flow?.notes ?? [],
    actions,
    cc: cc.map((c) => ({ staffName: names.get(Number(c.staffId)) ?? '', role: c.role, urgent: c.urgent, notifiedAt: iso(c.notifiedAt), readAt: iso(c.readAt) })),
    specials,
    mySeats,
    canWithdraw: owner && !doc.withdrawnAt && !approved && flow?.status !== 'rejected',
    canSubmit: owner && !doc.withdrawnAt && (flow === null || flow.status === 'returned' || flow.status === 'cancelled'),
    canExecute: approved && !doc.archivedAt && (hooksOf(doc.docType).executor === 'seal_keeper' ? (await rolesOf(db, actor.id)).includes('seal_keeper') : owner || doc.performerId === actor.id),
  };
}

const ActInput = z.object({
  clientKey: uuid,
  action: z.enum(['approve', 'return', 'reject'], '请选同意、退回或驳回'),
  level: z.number().int().positive(),
  comment: z.string().trim().max(500, '意见最多 500 个字').default(''),
  /** 各类事项自己的逐行结论（例如董事长批 SKU 时逐个确认异常的） */
  extra: z.unknown().optional(),
});
const VersionInput = z.object({ version: z.number().int().positive() });
const ExecInput = VersionInput.extend({ step: z.enum(['start', 'complete', 'archive'], '请选开始执行、完成或归档') });

/** 改事项一行（锁住、核对版本、版本 +1） */
async function bump(tx: Tx, id: number, version: number) {
  const doc = await loadDoc(tx, id, true);
  if (doc.version !== version) throw conflict('VERSION_CONFLICT', '这个事项刚被别人改过，请刷新后再操作');
  await tx`UPDATE gf_docs SET version = version + 1, updated_at = now() WHERE id = ${id}`;
  return doc;
}

// ───────────────────────── 微信特批 ─────────────────────────

async function listSpecials(db: Db, where: Fragment, timeZone: string): Promise<GfSpecialView[]> {
  const rows = await db<
    {
      id: number;
      specialNo: string;
      docId: number | null;
      docBizNo: string | null;
      title: string;
      amountCents: number;
      reason: string;
      confirmerIds: number[];
      confirmedAt: Date;
      dueOn: string;
      backfilledAt: Date | null;
      backfilledByName: string | null;
      backfillNote: string;
      registeredByName: string;
    }[]
  >`
    SELECT s.id, s.special_no, s.doc_id, d.biz_no AS doc_biz_no, s.title, s.amount_cents, s.reason, s.confirmer_ids, s.confirmed_at, s.due_on::text AS due_on,
           s.backfilled_at, b.display_name AS backfilled_by_name, s.backfill_note, r.display_name AS registered_by_name
    FROM gf_specials s LEFT JOIN gf_docs d ON d.id = s.doc_id LEFT JOIN staff b ON b.id = s.backfilled_by JOIN staff r ON r.id = s.registered_by
    WHERE ${where} ORDER BY s.id DESC LIMIT 200`;
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const files = await db<{ id: number; ownerId: number; purpose: GfFilePurpose; fileName: string; sizeBytes: number }[]>`
    SELECT id, owner_id, purpose, file_name, size_bytes FROM gf_files WHERE owner_type = 'special' AND owner_id IN ${db(ids)} ORDER BY id`;
  // OK 截图复用（8.2.16，WB7：只提示、不拦）：同一张截图（内容摘要一样）也用在了别的特批上
  const reused = await db<{ ownerId: number; others: string }[]>`
    SELECT f.owner_id, string_agg(DISTINCT o.special_no, '、') AS others
    FROM gf_files f JOIN gf_files g ON g.sha256 = f.sha256 AND g.owner_type = 'special' AND g.purpose = 'ok_screenshot' AND g.owner_id <> f.owner_id
         JOIN gf_specials o ON o.id = g.owner_id
    WHERE f.owner_type = 'special' AND f.purpose = 'ok_screenshot' AND f.owner_id IN ${db(ids)}
    GROUP BY f.owner_id`;
  const reusedOf = new Map(reused.map((r) => [Number(r.ownerId), r.others.split('、')]));
  const staff = new Map(
    (await db<{ id: number; displayName: string }[]>`SELECT id, display_name FROM staff WHERE id IN ${db([...new Set(rows.flatMap((r) => r.confirmerIds.map(Number)))])}`).map((s) => [
      Number(s.id),
      s.displayName,
    ]),
  );
  const today = todayIn(timeZone);
  return rows.map((r) => ({
    id: Number(r.id),
    specialNo: r.specialNo,
    docId: r.docId === null ? null : Number(r.docId),
    docBizNo: r.docBizNo,
    title: r.title,
    amountCents: Number(r.amountCents),
    reason: r.reason,
    confirmerNames: r.confirmerIds.map((id) => staff.get(Number(id)) ?? `#${id}`),
    confirmedAt: iso(r.confirmedAt)!,
    dueOn: r.dueOn,
    backfilledAt: iso(r.backfilledAt),
    backfilledByName: r.backfilledByName,
    backfillNote: r.backfillNote,
    files: files.filter((f) => Number(f.ownerId) === Number(r.id)).map((f) => ({ id: Number(f.id), purpose: f.purpose, fileName: f.fileName, sizeBytes: f.sizeBytes })),
    overdue: !r.backfilledAt && r.dueOn < today,
    registeredByName: r.registeredByName,
    screenshotReusedIn: reusedOf.get(Number(r.id)) ?? [],
  }));
}

/** 登记时的微信 OK 截图（8.2.16，WB6：发起时必传；只收图片） */
const OkShotInput = z.object(
  {
    fileName: z.string().trim().min(1).max(120),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp'], 'OK 截图只收 PNG、JPG、WEBP 图片'),
    base64: z
      .string()
      .min(4)
      .max(Math.ceil((GF_FILE_MAX_BYTES * 4) / 3) + 8, '截图最多 5 MB'),
  },
  '请上传微信里的 OK 截图',
);

const SpecialInput = z.object({
  clientKey: uuid,
  docId: z.number().int().positive().nullable().default(null),
  title: z.string().trim().min(1, '请写特批事项').max(100, '特批事项最多 100 个字'),
  amountCents: z.number().int().positive('特批金额要大于 0').max(100_000_000_000),
  reason: z.string().trim().min(2, '请写紧急原因（至少 2 个字）').max(500, '原因最多 500 个字'),
  confirmerIds: z.array(z.number().int().positive()).length(2, '微信特批要两个人确认'),
  confirmedAt: z.iso.datetime({ offset: true, message: '请填微信确认的时间' }),
  /** 新登记必传；接口上可缺，只为升级前就在「结果待确认」里的原请求（没有这一栏）能按原编号查回（createSpecial 里再拦） */
  okScreenshot: OkShotInput.optional(),
  /** 紧急付款的特批要记确认时的收款账号（换账户要重新特批，P05） */
  payeeAccount: z
    .string()
    .trim()
    .regex(/^\d{6,30}$/, '收款账号是 6–30 位数字')
    .nullable()
    .default(null),
});

async function holidays(db: Db): Promise<Map<string, 'holiday' | 'workday'>> {
  const rows = await db<{ day: string; kind: 'holiday' | 'workday' }[]>`SELECT day::text AS day, kind FROM oa_holidays WHERE day >= current_date - 30`;
  return new Map(rows.map((r) => [r.day, r.kind]));
}

async function createSpecial(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<number> {
  const input = parse(SpecialInput, raw);
  if (input.confirmerIds[0] === input.confirmerIds[1]) throw badRequest('微信特批要两个不同的人确认');
  const okShot = input.okScreenshot;
  const shot = okShot ? Buffer.from(okShot.base64, 'base64') : null;
  if (okShot && shot) {
    if (shot.length === 0 || shot.length > GF_FILE_MAX_BYTES) throw unprocessable('GF_FILE_SIZE', 'OK 截图大小不对（最多 5 MB）');
    if (!MAGIC[okShot.mime]!(shot)) throw unprocessable('GF_FILE_TYPE', 'OK 截图的内容与图片类型对不上');
  }
  const shotSha = shot ? createHash('sha256').update(shot).digest('hex') : null;
  // 操作编号核对用截图的摘要，不把整张图算进去；升级前（8.2.16 以前）的摘要没有截图这一栏，原样重提的也认
  const legacyHash = hashRequest({ ...input, clientKey: undefined, okScreenshot: undefined });
  const requestHash = okShot ? hashRequest({ ...input, clientKey: undefined, okScreenshot: { ...okShot, base64: shotSha } }) : legacyHash;
  const existing = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM gf_specials WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash && row.requestHash !== legacyHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔特批，请刷新页面后重新填写');
    return Number(row.id);
  };
  // 先按操作编号查回已提交的，再要求截图：只有真正新登记的才必传
  const committed = await existing(deps.sql);
  if (committed) return committed;
  const needShot = () => {
    if (!okShot || !shot || !shotSha) throw badRequest('请上传微信里的 OK 截图', { field: 'okScreenshot' });
    return { okShot, shot, shotSha };
  };
  needShot();
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const found = await existing(tx);
      if (found) return found;
      const { okShot: file, shot: content, shotSha: sha } = needShot();
      const confirmed = new Date(input.confirmedAt);
      if (confirmed.getTime() > Date.now() + 5 * 60_000) throw unprocessable('GF_FUTURE', '微信确认时间不能晚于现在');
      const people = await tx<{ id: number }[]>`SELECT id FROM staff WHERE id IN ${tx(input.confirmerIds)} AND active`;
      if (people.length !== 2) throw unprocessable('GF_STAFF', '确认人不存在或已停用');
      if (input.confirmerIds.includes(actor.id)) throw unprocessable('GF_SELF_CONFIRM', '登记人不能是确认人之一（两人确认要由别人给出）');
      if (input.docId !== null) {
        const doc = await loadDoc(tx, input.docId, true);
        if (doc.withdrawnAt) throw conflict('GF_WITHDRAWN', '关联的事项已撤回');
        if (!(await canView(tx, actor, doc))) throw forbidden('你看不到要关联的事项');
      }
      const day = dateIn(confirmed, deps.config.timezone);
      const dueOn = addWorkdays(day, GF_SPECIAL_BACKFILL_WORKDAYS, await holidays(tx));
      const specialNo = await nextDocNo(tx, 'gf_special', 'TP', todayIn(deps.config.timezone));
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO gf_specials (special_no, doc_id, title, amount_cents, reason, confirmer_ids, confirmed_at, due_on, registered_by, client_key, request_hash, payee_account)
        VALUES (${specialNo}, ${input.docId}, ${input.title}, ${input.amountCents}, ${input.reason}, ${input.confirmerIds}, ${confirmed}, ${dueOn}, ${actor.id}, ${input.clientKey}, ${requestHash}, ${input.payeeAccount})
        RETURNING id`;
      const id = Number(row!.id);
      await tx`
        INSERT INTO gf_files (owner_type, owner_id, purpose, file_name, mime, size_bytes, sha256, content, uploaded_by)
        VALUES ('special', ${id}, 'ok_screenshot', ${file.fileName}, ${file.mime}, ${content.length}, ${sha}, ${content}, ${actor.id})`;
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'gf_special',
        targetType: 'gf_special',
        targetId: id,
        detail: { op: 'create', specialNo, amountCents: input.amountCents, docId: input.docId },
        ip,
      });
      // 特批即时知会（董事长、业态总经理、财总、CFO；已参与的不重复）
      if (input.docId !== null) await addCc(tx, await loadDoc(tx, input.docId), { reason: `微信特批 ${specialNo}`, special: true, actorId: actor.id });
      await notify(tx, [actor.id], {
        kind: 'system',
        title: `微信特批待补登：${input.title}`,
        body: `${specialNo} 请在 ${dueOn} 前上传需求说明补登`,
        link: '/oa/gov?box=specials',
        ref: { type: 'gf_special', id },
      });
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'gf_specials_client_key_key')) {
      const found = await existing(deps.sql);
      if (found) return found;
    }
    throw error;
  }
}

const FileInput = z.object({
  purpose: z.enum(GF_FILE_PURPOSES),
  fileName: z.string().trim().min(1).max(120),
  mime: z.enum(GF_FILE_MIMES, '只收 PNG、JPG、WEBP 图片或 PDF'),
  base64: z
    .string()
    .min(4)
    .max(Math.ceil((GF_FILE_MAX_BYTES * 4) / 3) + 8, '单个文件最多 5 MB'),
});
const BackfillInput = z.object({
  note: z.string().trim().max(500, '说明最多 500 个字').default(''),
  files: z.array(FileInput).min(1, '要上传需求说明').max(6, '一次最多 6 个文件'),
});

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};

async function backfillSpecial(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(BackfillInput, raw);
  const purposes = new Set(input.files.map((f) => f.purpose));
  if (!purposes.has('need')) throw unprocessable('GF_BACKFILL_FILES', '补登要有需求说明（至少一份）');
  const decoded = input.files.map((f) => {
    const buf = Buffer.from(f.base64, 'base64');
    if (buf.length === 0 || buf.length > GF_FILE_MAX_BYTES) throw unprocessable('GF_FILE_SIZE', `「${f.fileName}」大小不对（最多 5 MB）`);
    if (!MAGIC[f.mime]!(buf)) throw unprocessable('GF_FILE_TYPE', `「${f.fileName}」的内容与文件类型对不上`);
    return { ...f, buf };
  });
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [s] = await tx<{ registeredBy: number; confirmerIds: number[]; backfilledAt: Date | null }[]>`
      SELECT registered_by, confirmer_ids, backfilled_at FROM gf_specials WHERE id = ${id} FOR UPDATE`;
    if (!s) throw notFound('没有这笔特批');
    if (s.backfilledAt) throw conflict('GF_BACKFILLED', '这笔特批已经补登过了（补登不重复审批）');
    if (Number(s.registeredBy) !== actor.id && !s.confirmerIds.map(Number).includes(actor.id)) throw forbidden('只有登记人或两位确认人能补登');
    // 8.2.16 以前登记的特批没有 OK 截图：补登时照旧要补上
    const [shot] = await tx`SELECT 1 FROM gf_files WHERE owner_type = 'special' AND owner_id = ${id} AND purpose = 'ok_screenshot'`;
    if (!shot && !purposes.has('ok_screenshot')) throw unprocessable('GF_BACKFILL_FILES', '这笔特批登记时没有 OK 截图，补登要一起上传');
    for (const f of decoded) {
      await tx`
        INSERT INTO gf_files (owner_type, owner_id, purpose, file_name, mime, size_bytes, sha256, content, uploaded_by)
        VALUES ('special', ${id}, ${f.purpose}, ${f.fileName}, ${f.mime}, ${f.buf.length}, ${createHash('sha256').update(f.buf).digest('hex')}, ${f.buf}, ${actor.id})`;
    }
    await tx`UPDATE gf_specials SET backfilled_at = now(), backfilled_by = ${actor.id}, backfill_note = ${input.note} WHERE id = ${id}`;
    await writeAudit(tx, { staffId: actor.id, action: 'gf_special', targetType: 'gf_special', targetId: id, detail: { op: 'backfill', files: decoded.length }, ip });
  });
}

// ───────────────────────── 路由 ─────────────────────────

export function registerGovflowRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const signedIn = guard();
  // 在职员工（平板、专用账号、系统账号不能用）
  const staffOnly: preHandlerAsyncHookHandler = async function (req, reply) {
    await signedIn.call(this, req, reply);
    if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(req.actor.role)) throw forbidden('这个账号不能用业财法审批');
  };
  const manage = guard('gf.roles');
  // 流程与阈值（8.2.15）：在这里挂，不另占 app.ts 一行
  registerGfConfigRoutes(app, deps);

  app.get('/api/gf/meta', { preHandler: staffOnly }, async (req): Promise<GfMeta> => {
    const entities = await sql<{ id: number; name: string }[]>`SELECT id, name FROM legal_entities ORDER BY id`;
    const departments = await sql<{ id: number; name: string; headId: number | null; headName: string | null }[]>`
      SELECT d.id, d.name, d.head_id, s.display_name AS head_name FROM departments d LEFT JOIN staff s ON s.id = d.head_id WHERE d.active ORDER BY d.sort_order, d.id`;
    const staff = await sql<{ id: number; name: string }[]>`
      SELECT id, display_name AS name FROM staff WHERE active AND role NOT IN ${sql(NOT_EMPLOYEE_ROLES as unknown as string[])} ORDER BY display_name`;
    return {
      roles: GF_ROLES.map((role) => ({ role, label: GF_ROLE_LABELS[role] })),
      myRoles: await rolesOf(sql, req.actor.id),
      canManageRoles: can(req.actor, 'gf.roles'),
      entities: entities.map((e) => ({ id: Number(e.id), name: e.name })),
      departments: departments.map((d) => ({ id: Number(d.id), name: d.name, headId: d.headId === null ? null : Number(d.headId), headName: d.headName })),
      staff: staff.map((s) => ({ id: Number(s.id), name: s.name })),
    };
  });

  registerGovflowExport(app, deps, { staffOnly, seesAll, listSelect: LIST_SELECT, cardsOf });

  app.get('/api/gf/roles', { preHandler: staffOnly }, async () => listMembers(sql));

  app.post('/api/gf/roles', { preHandler: manage }, async (req) => {
    const input = parse(MemberInput, req.body);
    await sql.begin(async (tx) => {
      await assertRoleStaff(tx, input.staffId);
      try {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO gf_role_members (role, staff_id, entity_id, note, created_by) VALUES (${input.role}, ${input.staffId}, ${input.entityId}, ${input.note}, ${req.actor.id}) RETURNING id`;
        await writeAudit(tx, { staffId: req.actor.id, action: 'gf_role', targetType: 'gf_role_member', targetId: Number(row!.id), detail: { op: 'add', ...input }, ip: req.ip });
      } catch (error) {
        if (isUniqueViolation(error, 'gf_role_members_active_uq')) throw conflict('GF_ROLE_DUP', '这个人已经是这个角色了');
        throw error;
      }
    });
    return listMembers(sql);
  });

  app.post('/api/gf/roles/:id/revoke', { preHandler: manage }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(RevokeInput, req.body ?? {});
    await sql.begin(async (tx) => {
      const rows = await tx`
        UPDATE gf_role_members SET revoked_at = now(), revoked_by = ${req.actor.id}, revoke_reason = ${reason} WHERE id = ${id} AND revoked_at IS NULL RETURNING id`;
      if (!rows.length) throw notFound('没有这条角色映射（或已撤销）');
      await writeAudit(tx, { staffId: req.actor.id, action: 'gf_role', targetType: 'gf_role_member', targetId: id, detail: { op: 'revoke', reason }, ip: req.ip });
    });
    return listMembers(sql);
  });

  // 修改（8.2.14，A1、WB1）：换人、改经营主体范围、改备注；角色不能改。旧的一条撤销、新建一条指回它。
  // 已经提交的单按提交时的快照审批（WB2），不受影响；之后提交的按新的
  app.post('/api/gf/roles/:id/edit', { preHandler: manage }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(EditInput, req.body);
    await sql.begin(async (tx) => {
      const [old] = await tx<{ role: string; staffId: number; entityId: number | null; note: string }[]>`
        SELECT role, staff_id, entity_id, note FROM gf_role_members WHERE id = ${id} AND revoked_at IS NULL FOR UPDATE`;
      if (!old) throw notFound('没有这条角色映射（或已撤销），请刷新后再看');
      if (Number(old.staffId) === input.staffId && (old.entityId === null ? null : Number(old.entityId)) === input.entityId && old.note === input.note) {
        throw unprocessable('GF_ROLE_SAME', '没有改动');
      }
      await assertRoleStaff(tx, input.staffId);
      await tx`UPDATE gf_role_members SET revoked_at = now(), revoked_by = ${req.actor.id}, revoke_reason = ${input.reason} WHERE id = ${id}`;
      try {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO gf_role_members (role, staff_id, entity_id, note, created_by, replaces_id)
          VALUES (${old.role}, ${input.staffId}, ${input.entityId}, ${input.note}, ${req.actor.id}, ${id}) RETURNING id`;
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'gf_role',
          targetType: 'gf_role_member',
          targetId: Number(row!.id),
          detail: { op: 'edit', replaces: id, before: { staffId: Number(old.staffId), entityId: old.entityId, note: old.note }, after: input },
          ip: req.ip,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'gf_role_members_active_uq')) throw conflict('GF_ROLE_DUP', '这个人已经是这个角色了');
        throw error;
      }
    });
    return listMembers(sql);
  });

  app.get('/api/gf/roles/changes', { preHandler: manage }, async () => roleChanges(sql));

  app.get('/api/gf/docs', { preHandler: staffOnly }, async (req) => {
    const { box } = parse(z.object({ box: z.enum(['mine', 'todo', 'cc', 'all']).default('mine') }), req.query ?? {});
    return listDocs(deps, req.actor, box);
  });

  app.post('/api/gf/docs', { preHandler: staffOnly }, async (req) => detail(deps, req.actor, await createDoc(deps, req.body, req.actor, req.ip)));

  app.get('/api/gf/docs/:id', { preHandler: staffOnly }, async (req) => detail(deps, req.actor, parse(idParam, req.params).id));

  app.post('/api/gf/docs/:id/submit', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { version } = parse(VersionInput, req.body);
    await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const doc = await bump(tx, id, version);
      if (doc.createdBy !== req.actor.id) throw forbidden('只有发起人能提交');
      await submitFlow(tx, doc, await templateFor(tx, doc), req.actor);
      await writeAudit(tx, { staffId: req.actor.id, action: 'gf_doc', targetType: 'gf_doc', targetId: id, detail: { op: 'submit' }, ip: req.ip });
    });
    return detail(deps, req.actor, id);
  });

  app.post('/api/gf/docs/:id/act', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(ActInput, req.body);
    await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const doc = await loadDoc(tx, id, true);
      const r = await actFlow(tx, doc, req.actor, input);
      if (!r.replayed) {
        await tx`UPDATE gf_docs SET version = version + 1, updated_at = now() WHERE id = ${id}`;
        await writeAudit(tx, { staffId: req.actor.id, action: 'gf_act', targetType: 'gf_doc', targetId: id, detail: { action: input.action, level: input.level, outcome: r.outcome }, ip: req.ip });
      }
    });
    return detail(deps, req.actor, id);
  });

  app.post('/api/gf/docs/:id/withdraw', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { version } = parse(VersionInput, req.body);
    await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const doc = await bump(tx, id, version);
      if (doc.createdBy !== req.actor.id) throw forbidden('只有发起人能撤回');
      if (doc.withdrawnAt) throw conflict('GF_WITHDRAWN', '已经撤回了');
      const flow: FlowRow | null = await latestFlow(tx, id, true);
      if (flow?.status === 'approved') throw conflict('GF_APPROVED', '已经审批通过的不能撤回');
      if (flow?.status === 'rejected') throw conflict('GF_REJECTED', '已经驳回的不用撤回');
      if (flow?.status === 'pending') await tx`UPDATE gf_flows SET status = 'cancelled', finished_at = now(), finished_by = ${req.actor.id} WHERE id = ${flow.id}`;
      await tx`UPDATE gf_docs SET withdrawn_at = now(), withdrawn_by = ${req.actor.id} WHERE id = ${id}`;
      await hooksOf(doc.docType).ended?.(tx, doc, 'withdrawn', req.actor);
      await writeAudit(tx, { staffId: req.actor.id, action: 'gf_doc', targetType: 'gf_doc', targetId: id, detail: { op: 'withdraw' }, ip: req.ip });
    });
    return detail(deps, req.actor, id);
  });

  app.post('/api/gf/docs/:id/execute', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { version, step } = parse(ExecInput, req.body);
    await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const doc = await bump(tx, id, version);
      if (hooksOf(doc.docType).executor === 'seal_keeper') {
        if (!(await rolesOf(tx, req.actor.id)).includes('seal_keeper')) throw forbidden('用印、证照借还由章证管理员操作');
      } else if (doc.createdBy !== req.actor.id && doc.performerId !== req.actor.id) throw forbidden('只有发起人或履约执行人能推进执行');
      const flow = await latestFlow(tx, id);
      if (flow?.status !== 'approved') throw conflict('GF_NOT_APPROVED', '审批通过以后才能执行');
      await hooksOf(doc.docType).beforeExecute?.(tx, doc, step, req.actor);
      if (step === 'archive') Object.assign(doc, await loadDoc(tx, id));
      if (step === 'start') {
        if (doc.execStartedAt) throw conflict('GF_STEP', '已经开始执行了');
        await tx`UPDATE gf_docs SET exec_started_at = now(), exec_started_by = ${req.actor.id} WHERE id = ${id}`;
      } else if (step === 'complete') {
        if (doc.completedAt) throw conflict('GF_STEP', '已经完成了');
        const [open] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM gf_specials WHERE doc_id = ${id} AND backfilled_at IS NULL`;
        if ((open?.n ?? 0) > 0) throw conflict('GF_SPECIAL_OPEN', '还有微信特批没补登，补登以后才能完成');
        await tx`UPDATE gf_docs SET completed_at = now(), completed_by = ${req.actor.id},
                   exec_started_at = coalesce(exec_started_at, now()), exec_started_by = coalesce(exec_started_by, ${req.actor.id}) WHERE id = ${id}`;
      } else {
        if (!doc.completedAt) throw conflict('GF_STEP', '完成以后才能归档');
        if (doc.backfillOpen) throw conflict('GF_STEP', '还有后补没完成，不能归档');
        await tx`UPDATE gf_docs SET archived_at = now(), archived_by = ${req.actor.id} WHERE id = ${id}`;
      }
      await writeAudit(tx, { staffId: req.actor.id, action: 'gf_doc', targetType: 'gf_doc', targetId: id, detail: { op: step }, ip: req.ip });
    });
    return detail(deps, req.actor, id);
  });

  // 知会：标已读
  app.post('/api/gf/docs/:id/cc-read', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    await sql`UPDATE gf_cc SET read_at = now() WHERE doc_id = ${id} AND staff_id = ${req.actor.id} AND read_at IS NULL`;
    return { ok: true };
  });

  app.get('/api/gf/specials', { preHandler: staffOnly }, async (req) => {
    const all = await seesAll(sql, req.actor);
    return listSpecials(sql, all ? sql`true` : sql`(s.registered_by = ${req.actor.id} OR ${req.actor.id} = ANY (s.confirmer_ids))`, deps.config.timezone);
  });

  app.post('/api/gf/specials', { preHandler: staffOnly, bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const id = await createSpecial(deps, req.body, req.actor, req.ip);
    return (await listSpecials(sql, sql`s.id = ${id}`, deps.config.timezone))[0]!;
  });

  app.post('/api/gf/specials/:id/backfill', { preHandler: staffOnly, bodyLimit: 40 * 1024 * 1024 }, async (req) => {
    const { id } = parse(idParam, req.params);
    await backfillSpecial(deps, id, req.body, req.actor, req.ip);
    return (await listSpecials(sql, sql`s.id = ${id}`, deps.config.timezone))[0]!;
  });

  app.get('/api/gf/files/:id', { preHandler: staffOnly }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const [f] = await sql<{ ownerType: string; ownerId: number; fileName: string; mime: string; content: Buffer }[]>`
      SELECT owner_type, owner_id, file_name, mime, content FROM gf_files WHERE id = ${id}`;
    if (!f) throw notFound('没有这个文件');
    let ok = await seesAll(sql, req.actor);
    if (!ok && f.ownerType === 'special') {
      const [s] = await sql<{ registeredBy: number; confirmerIds: number[]; docId: number | null }[]>`SELECT registered_by, confirmer_ids, doc_id FROM gf_specials WHERE id = ${f.ownerId}`;
      ok =
        !!s &&
        (Number(s.registeredBy) === req.actor.id || s.confirmerIds.map(Number).includes(req.actor.id) || (s.docId !== null && (await canView(sql, req.actor, await loadDoc(sql, Number(s.docId))))));
    } else if (!ok && f.ownerType === 'doc') ok = await canView(sql, req.actor, await loadDoc(sql, Number(f.ownerId)));
    if (!ok) throw forbidden('你看不到这个文件');
    return reply
      .header('content-type', f.mime)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.fileName)}`)
      .header('x-content-type-options', 'nosniff')
      .send(f.content);
  });
}
