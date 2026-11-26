// 业财法审批流的引擎（P01，docs/APPROVAL_V4.md 第 3 节）：排链、谁能审、同意 / 退回 / 驳回、自动跳过、知会、状态。
// 各批的业务单据（供应商入库、零星采购、合同、付款、报销、HR 批次……）都挂在 gf_docs 上，提交时把模板交给 submitFlow。
// 锁顺序：事项一行（gf_docs FOR UPDATE）→ 在审那一轮（gf_flows FOR UPDATE）。

import {
  GF_CC_ROLES,
  GF_ROLE_SHORT,
  ccTargets,
  ccUrgent,
  deriveStatus,
  nodeLabel,
  planFlow,
  seatsFor,
  seatsOf,
  type DerivedStatus,
  type GfFlowStatus,
  type GfNode,
  type GfRole,
  type SeatContext,
} from '@shared/govflow';
import type { Db, Sql, Tx } from '../../db';
import type { Actor } from '../../lib/context';
import { dateIn, todayIn } from '../../lib/dates';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { nextDocNo } from '../../lib/tx';
import { notify } from '../oa/notifications';

export interface DocRow {
  id: number;
  bizNo: string;
  docType: string;
  title: string;
  entityId: number | null;
  departmentId: number | null;
  amountCents: number | null;
  flags: string[];
  performerId: number | null;
  subjectStaffId: number | null;
  createdBy: number;
  version: number;
  withdrawnAt: string | null;
  execStartedAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  dueOn: string | null;
  backfillOpen: boolean;
  payload: Record<string, unknown>;
}

export interface FlowRow {
  id: number;
  docId: number;
  round: number;
  nodes: GfNode[];
  notes: string[];
  currentLevel: number;
  status: GfFlowStatus;
  submittedBy: number;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function docOf(r: Record<string, unknown>): DocRow {
  const d = r as unknown as DocRow;
  return {
    ...d,
    id: Number(d.id),
    entityId: num(d.entityId),
    departmentId: num(d.departmentId),
    amountCents: num(d.amountCents),
    performerId: num(d.performerId),
    subjectStaffId: num(d.subjectStaffId),
    createdBy: Number(d.createdBy),
    dueOn: d.dueOn ? String(d.dueOn).slice(0, 10) : null,
  };
}
const flowOf = (r: FlowRow): FlowRow => ({ ...r, id: Number(r.id), docId: Number(r.docId), submittedBy: Number(r.submittedBy) });

export async function loadDoc(db: Db, id: number, lock = false): Promise<DocRow> {
  const [r] = lock ? await db`SELECT * FROM gf_docs WHERE id = ${id} FOR UPDATE` : await db`SELECT * FROM gf_docs WHERE id = ${id}`;
  if (!r) throw notFound('没有这个事项');
  return docOf(r);
}

export async function latestFlow(db: Db, docId: number, lock = false): Promise<FlowRow | null> {
  const rows = lock
    ? await db<FlowRow[]>`SELECT * FROM gf_flows WHERE doc_id = ${docId} ORDER BY round DESC LIMIT 1 FOR UPDATE`
    : await db<FlowRow[]>`SELECT * FROM gf_flows WHERE doc_id = ${docId} ORDER BY round DESC LIMIT 1`;
  return rows[0] ? flowOf(rows[0]) : null;
}

// ───────────────────────── 各类事项的钩子（P02 起） ─────────────────────────

/**
 * 业务单据挂在事项上，审批走到某一步时各自处理（供应商入库、SKU 建码、价格版本……）。都在同一个事务里调。
 *   · beforeApprove：同意前核对（例如董事长批 SKU 要逐个确认异常的那几个，extra 是页面带来的逐行结论）；
 *   · approved：整轮通过；ended：退回、驳回、撤回（业务单据回到可改 / 作废）；
 *   · ccRoles：通过后知会谁（不给就是董事长、业态总经理、财总、CFO）。
 */
export interface TypeHooks {
  /** 审批链模板（各类事项自己定） */
  template?: (doc: DocRow) => GfNode[];
  beforeApprove?: (tx: Tx, doc: DocRow, flow: FlowRow, ctx: { level: number; final: boolean; actor: Actor; extra: unknown }) => Promise<void>;
  approved?: (tx: Tx, doc: DocRow, actor: Actor) => Promise<void>;
  ended?: (tx: Tx, doc: DocRow, outcome: 'returned' | 'rejected' | 'withdrawn', actor: Actor) => Promise<void>;
  ccRoles?: readonly GfRole[] | ((doc: DocRow) => readonly GfRole[]);
  /** 提交（含退回后再提交）前核对业务单据、把它改成审核中 */
  beforeSubmit?: (tx: Tx, doc: DocRow, actor: Actor) => Promise<void>;
  /** 推进执行前（开始执行 / 完成 / 归档）：合同签署前核对类型确认与供应商入库，用印后定归档期限 */
  beforeExecute?: (tx: Tx, doc: DocRow, step: 'start' | 'complete' | 'archive', actor: Actor) => Promise<void>;
  /** 推进执行的人：默认发起人或履约执行人；用印证照由章证管理员 */
  executor?: 'owner_or_performer' | 'seal_keeper';
}
const HOOKS = new Map<string, TypeHooks>();
export function registerHooks(docType: string, hooks: TypeHooks) {
  HOOKS.set(docType, hooks);
}
export const hooksOf = (docType: string): TypeHooks => HOOKS.get(docType) ?? {};

// ───────────────────────── 角色与部门负责人 ─────────────────────────

/** 各角色现在映射的在用账号；entityId 有值时只要「所有经营主体」与这个经营主体的 */
export async function loadMembers(db: Db, entityId: number | null): Promise<Partial<Record<GfRole, number[]>>> {
  const rows = await db<{ role: GfRole; staffId: number }[]>`
    SELECT m.role, m.staff_id FROM gf_role_members m JOIN staff s ON s.id = m.staff_id
    WHERE m.revoked_at IS NULL AND s.active AND (m.entity_id IS NULL OR m.entity_id = ${entityId})
    ORDER BY m.role, m.staff_id`;
  const out: Partial<Record<GfRole, number[]>> = {};
  for (const r of rows) (out[r.role] ??= []).push(Number(r.staffId));
  return out;
}

export async function rolesOf(db: Db, staffId: number): Promise<GfRole[]> {
  const rows = await db<{ role: GfRole }[]>`SELECT DISTINCT role FROM gf_role_members WHERE staff_id = ${staffId} AND revoked_at IS NULL ORDER BY role`;
  return rows.map((r) => r.role);
}

export async function deptHeadOf(db: Db, departmentId: number | null): Promise<number | null> {
  if (departmentId === null) return null;
  const [d] = await db<{ headId: number | null }[]>`
    SELECT d.head_id FROM departments d LEFT JOIN staff s ON s.id = d.head_id WHERE d.id = ${departmentId} AND (d.head_id IS NULL OR s.active)`;
  return num(d?.headId);
}

export async function seatContext(db: Db, doc: DocRow, flow: FlowRow): Promise<SeatContext> {
  return {
    members: await loadMembers(db, doc.entityId),
    deptHeadId: await deptHeadOf(db, doc.departmentId),
    performerId: doc.performerId,
    submittedBy: flow.submittedBy,
    subjectStaffId: doc.subjectStaffId,
  };
}

// ───────────────────────── 新建事项 ─────────────────────────

export interface NewDoc {
  docType: string;
  title: string;
  note?: string;
  entityId?: number | null;
  departmentId?: number | null;
  amountCents?: number | null;
  payload?: Record<string, unknown>;
  flags?: readonly string[];
  performerId?: number | null;
  subjectStaffId?: number | null;
  relatedDocId?: number | null;
  clientKey: string;
  requestHash: string;
  dueOn?: string | null;
}

/** 写一行事项（业务编号 YCF…，各类事项共用）；调用方已核对过操作编号没用过 */
export async function insertDoc(tx: Tx, input: NewDoc, actor: Actor, today: string): Promise<number> {
  const bizNo = await nextDocNo(tx, 'gf_doc', 'YCF', today);
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO gf_docs (biz_no, doc_type, title, note, entity_id, department_id, amount_cents, payload, flags, performer_id, subject_staff_id,
                         related_doc_id, client_key, request_hash, created_by, due_on)
    VALUES (${bizNo}, ${input.docType}, ${input.title}, ${input.note ?? ''}, ${input.entityId ?? null}, ${input.departmentId ?? null}, ${input.amountCents ?? null},
            ${tx.json((input.payload ?? {}) as never)}, ${[...new Set(input.flags ?? [])]}, ${input.performerId ?? null}, ${input.subjectStaffId ?? null},
            ${input.relatedDocId ?? null}, ${input.clientKey}, ${input.requestHash}, ${actor.id}, ${input.dueOn ?? null})
    RETURNING id`;
  return Number(row!.id);
}

// ───────────────────────── 提交 ─────────────────────────

/** 这一级已经出过结论的席位（同意或自动跳过） */
async function filledSeats(db: Db, flowId: number, level: number): Promise<{ seats: Set<string>; people: Set<number> }> {
  const rows = await db<{ seat: string; actorId: number; action: string }[]>`
    SELECT seat, actor_id, action FROM gf_flow_actions WHERE flow_id = ${flowId} AND level = ${level} AND action IN ('approve', 'skip')`;
  return { seats: new Set(rows.map((r) => r.seat)), people: new Set(rows.filter((r) => r.action === 'approve').map((r) => Number(r.actorId))) };
}

/**
 * 自动跳过（记一条 skip，不算谁同意）：部门负责人一级、履约执行人一级由本人发起的视同已确认（负责人自己发起、自己就是履约执行人）。
 * 返回审批是不是走完了。
 */
async function advance(tx: Tx, _doc: DocRow, flow: FlowRow, ctx: SeatContext, actorId: number, from = flow.currentLevel): Promise<'pending' | 'approved'> {
  // stored：库里现在记的级别（同意以后调用方从下一级开始找，库里还是原来那一级）
  const stored = flow.currentLevel;
  let level = from;
  for (;;) {
    const node = flow.nodes[level - 1];
    if (!node) {
      await tx`UPDATE gf_flows SET status = 'approved', current_level = ${flow.nodes.length}, finished_at = now(), finished_by = ${actorId} WHERE id = ${flow.id}`;
      return 'approved';
    }
    const { seats } = await filledSeats(tx, flow.id, level);
    for (const seat of seatsOf(node)) {
      if (seats.has(seat)) continue;
      const self = (seat === 'dept_head' && ctx.deptHeadId === flow.submittedBy) || (seat === 'performer' && ctx.performerId === flow.submittedBy);
      if (self) {
        await tx`
          INSERT INTO gf_flow_actions (flow_id, level, action, seat, actor_id, comment)
          VALUES (${flow.id}, ${level}, 'skip', ${seat}, ${flow.submittedBy}, ${seat === 'dept_head' ? '部门负责人本人发起，视同已确认' : '履约执行人本人发起，视同已确认'})`;
        seats.add(seat);
      }
    }
    if (seatsOf(node).every((s) => seats.has(s))) {
      level += 1;
      continue;
    }
    if (level !== stored) await tx`UPDATE gf_flows SET current_level = ${level}, level_started_at = now() WHERE id = ${flow.id}`;
    flow.currentLevel = level;
    return 'pending';
  }
}

/** 当前这一级还没出结论的席位，各自现在谁能坐 */
export async function waitingSeats(db: Db, doc: DocRow, flow: FlowRow, ctx?: SeatContext) {
  const c = ctx ?? (await seatContext(db, doc, flow));
  const node = flow.nodes[flow.currentLevel - 1]!;
  const { seats, people } = await filledSeats(db, flow.id, flow.currentLevel);
  const out: { seat: string; staffIds: number[] }[] = [];
  for (const seat of seatsOf(node)) {
    if (seats.has(seat)) continue;
    const pool = seat === 'dept_head' ? (c.deptHeadId ? [c.deptHeadId] : []) : seat === 'performer' ? (c.performerId ? [c.performerId] : []) : (c.members[seat] ?? []);
    out.push({ seat, staffIds: pool.filter((id) => !people.has(id) && seatsFor(node, id, c).includes(seat as never)) });
  }
  return out;
}

export const seatLabel = (seat: string) => (seat === 'dept_head' ? '部门负责人' : seat === 'performer' ? '内部履约执行人' : (GF_ROLE_SHORT[seat as GfRole] ?? seat));

/** 提醒当前这一级能审的人 */
async function notifyTodo(tx: Tx, doc: DocRow, flow: FlowRow, ctx: SeatContext) {
  const waiting = await waitingSeats(tx, doc, flow, ctx);
  const ids = [...new Set(waiting.flatMap((w) => w.staffIds))];
  await notify(tx, ids, {
    kind: 'approval_todo',
    title: `业财法待审：${doc.title}`,
    body: `${doc.bizNo} 第 ${flow.currentLevel} 级（${nodeLabel(flow.nodes[flow.currentLevel - 1]!)}）等你审批`,
    link: `/oa/gov/${doc.id}`,
    ref: { type: 'gf_doc', id: doc.id },
  });
}

/**
 * 提交（或退回后再提交）：按模板排链、开新一轮。调用方已锁住事项一行、核对过是提交人本人。
 * 驳回的不能再提交（驳回 = 不通过，要重新发起）；撤回的不能再提交；在审的不能重复提交。
 */
export async function submitFlow(tx: Tx, doc: DocRow, template: GfNode[], actor: Actor): Promise<FlowRow> {
  if (doc.withdrawnAt) throw conflict('GF_WITHDRAWN', '这个事项已撤回，不能再提交');
  const last = await latestFlow(tx, doc.id, true);
  if (last?.status === 'pending') throw conflict('GF_PENDING', '这个事项正在审批，不用重复提交');
  if (last?.status === 'approved') throw conflict('GF_APPROVED', '这个事项已经审批通过');
  if (last?.status === 'rejected') throw conflict('GF_REJECTED', '这个事项已被驳回（不通过），要重新发起一个事项');
  await hooksOf(doc.docType).beforeSubmit?.(tx, doc, actor);
  const members = await loadMembers(tx, doc.entityId);
  const deptHeadId = await deptHeadOf(tx, doc.departmentId);
  if (template.some((n) => n.kind === 'dept_head') && deptHeadId === null) {
    throw unprocessable('GF_NO_DEPT_HEAD', '费用承担部门还没有设负责人（或负责人已停用），请先在组织架构里设好部门负责人');
  }
  if (template.some((n) => n.kind === 'performer') && doc.performerId === null) {
    throw unprocessable('GF_NO_PERFORMER', '合同类事项要先选内部履约执行人');
  }
  const plan = planFlow(template, { members, deptHeadId, performerId: doc.performerId, submittedBy: actor.id, subjectStaffId: doc.subjectStaffId, flags: doc.flags });
  // 每一级都要有人能审（回避以后），没人的不让提交：避免卡在半路
  const ctx: SeatContext = { members, deptHeadId, performerId: doc.performerId, submittedBy: actor.id, subjectStaffId: doc.subjectStaffId };
  for (const node of plan.nodes) {
    for (const seat of seatsOf(node)) {
      const selfSkip = (seat === 'dept_head' && deptHeadId === actor.id) || (seat === 'performer' && doc.performerId === actor.id);
      if (selfSkip) continue;
      const pool = seat === 'dept_head' ? (deptHeadId ? [deptHeadId] : []) : seat === 'performer' ? (doc.performerId ? [doc.performerId] : []) : (members[seat] ?? []);
      if (!pool.some((id) => seatsFor(node, id, ctx).includes(seat as never))) {
        throw unprocessable('GF_NO_APPROVER', `「${seatLabel(seat)}」现在没有可以审批的人（没有配角色或都要回避），请店主在「业财法 → 角色映射」里配好再提交`, { seat });
      }
    }
    // 会签 / 并行分审要不同的人坐每一席
    if (node.kind === 'all') {
      const pools = node.roles.map((r) => (members[r] ?? []).filter((id) => seatsFor(node, id, ctx).includes(r)));
      const union = new Set(pools.flat());
      if (union.size < node.roles.length) throw unprocessable('GF_COSIGN_SAME', `「${nodeLabel(node)}」要 ${node.roles.length} 个不同的人审批，现在配的人不够`);
    }
  }
  const round = (last?.round ?? 0) + 1;
  const [row] = await tx<FlowRow[]>`
    INSERT INTO gf_flows (doc_id, round, nodes, notes, submitted_by)
    VALUES (${doc.id}, ${round}, ${tx.json(plan.nodes as never)}, ${plan.notes}, ${actor.id})
    RETURNING *`;
  const flow = flowOf(row!);
  const r = await advance(tx, doc, flow, ctx, actor.id);
  if (r === 'approved') await onApproved(tx, doc, flow, actor);
  else await notifyTodo(tx, doc, flow, ctx);
  return flow;
}

// ───────────────────────── 同意、退回、驳回 ─────────────────────────

export type ActKind = 'approve' | 'return' | 'reject';

/**
 * 审当前这一级。approve：坐上自己能坐、还空着的一席（会签里一个人只坐一席），席位都齐了进下一级；
 * return：退回提交人改了再交；reject：驳回（不通过，会签任一人不同意即不通过）。调用方已锁住事项一行。
 */
export async function actFlow(tx: Tx, doc: DocRow, actor: Actor, input: { action: ActKind; level: number; comment: string; clientKey: string; extra?: unknown }) {
  const [done] = await tx<{ flowId: number }[]>`SELECT flow_id FROM gf_flow_actions WHERE client_key = ${input.clientKey}`;
  if (done) return { replayed: true };
  const flow = await latestFlow(tx, doc.id, true);
  if (!flow || flow.status !== 'pending') throw conflict('GF_NOT_PENDING', '这个事项现在不在审批中，请刷新后再看');
  if (input.level !== flow.currentLevel) throw conflict('GF_MOVED', `这个事项已经走到第 ${flow.currentLevel} 级（别人刚审过），请刷新后再看`, { level: flow.currentLevel });
  const ctx = await seatContext(tx, doc, flow);
  const node = flow.nodes[flow.currentLevel - 1]!;
  const mine = seatsFor(node, actor.id, ctx);
  if (mine.length === 0) {
    const recused = actor.id === flow.submittedBy || actor.id === doc.subjectStaffId;
    throw forbidden(recused ? '这是你本人的事项，按回避规则要由其他审批人处理' : `这一级由「${nodeLabel(node)}」审批，你不在这一级的审批人里`);
  }
  const { seats, people } = await filledSeats(tx, flow.id, flow.currentLevel);
  if (input.action === 'approve') {
    if (people.has(actor.id)) throw conflict('GF_ALREADY', '你已经在这一级同意过了；共同审批要另一位同意');
    const seat = mine.find((s) => !seats.has(s));
    if (!seat) throw conflict('GF_ALREADY', '这一级你能审的那一席已经有人同意了');
    await hooksOf(doc.docType).beforeApprove?.(tx, doc, flow, { level: flow.currentLevel, final: flow.currentLevel === flow.nodes.length, actor, extra: input.extra });
    await tx`
      INSERT INTO gf_flow_actions (flow_id, level, action, seat, actor_id, comment, client_key)
      VALUES (${flow.id}, ${flow.currentLevel}, 'approve', ${seat}, ${actor.id}, ${input.comment}, ${input.clientKey})`;
    seats.add(seat);
    if (!seatsOf(node).every((s) => seats.has(s))) return { replayed: false, outcome: 'partial' as const };
    const r = await advance(tx, doc, flow, ctx, actor.id, flow.currentLevel + 1);
    if (r === 'approved') {
      await onApproved(tx, doc, flow, actor);
      return { replayed: false, outcome: 'approved' as const };
    }
    await notifyTodo(tx, doc, flow, ctx);
    return { replayed: false, outcome: 'advanced' as const };
  }
  if (input.comment.trim().length < 2) throw unprocessable('GF_REASON', input.action === 'return' ? '请写退回原因（至少 2 个字）' : '请写驳回原因（至少 2 个字）');
  const seat = mine.find((s) => !seats.has(s)) ?? mine[0]!;
  await tx`
    INSERT INTO gf_flow_actions (flow_id, level, action, seat, actor_id, comment, client_key)
    VALUES (${flow.id}, ${flow.currentLevel}, ${input.action}, ${seat}, ${actor.id}, ${input.comment}, ${input.clientKey})`;
  const status = input.action === 'return' ? 'returned' : 'rejected';
  await tx`UPDATE gf_flows SET status = ${status}, finished_at = now(), finished_by = ${actor.id} WHERE id = ${flow.id}`;
  await hooksOf(doc.docType).ended?.(tx, doc, status, actor);
  await notify(tx, [flow.submittedBy], {
    kind: 'approval_result',
    title: `业财法${input.action === 'return' ? '退回' : '驳回'}：${doc.title}`,
    body: `${doc.bizNo} 在第 ${flow.currentLevel} 级被${input.action === 'return' ? '退回' : '驳回'}：${input.comment}`,
    link: `/oa/gov/${doc.id}`,
    ref: { type: 'gf_doc', id: doc.id },
  });
  return { replayed: false, outcome: status };
}

// ───────────────────────── 知会 ─────────────────────────

/** 审批通过以后知会董事长、业态总经理、财总、CFO（已在审批链里出过结论的、提交人不重复知会） */
async function onApproved(tx: Tx, doc: DocRow, flow: FlowRow, actor: Actor) {
  const hooks = hooksOf(doc.docType);
  await hooks.approved?.(tx, doc, actor);
  await notify(tx, [flow.submittedBy], {
    kind: 'approval_result',
    title: `业财法通过：${doc.title}`,
    body: `${doc.bizNo} 已审批通过，待执行`,
    link: `/oa/gov/${doc.id}`,
    ref: { type: 'gf_doc', id: doc.id },
  });
  const roles = typeof hooks.ccRoles === 'function' ? hooks.ccRoles(doc) : hooks.ccRoles;
  await addCc(tx, doc, { reason: '审批通过', special: false, actorId: actor.id, roles });
}

/** 写知会（同一事项同一人只一次）；即时的马上发站内信，其他的等日报 */
export async function addCc(tx: Tx, doc: DocRow, opts: { reason: string; special: boolean; actorId: number; roles?: readonly GfRole[] }) {
  const members = await loadMembers(tx, doc.entityId);
  const candidates = (opts.roles ?? GF_CC_ROLES).flatMap((role) => (members[role] ?? []).map((staffId) => ({ staffId, role })));
  const acted = await tx<{ actorId: number }[]>`
    SELECT DISTINCT a.actor_id FROM gf_flow_actions a JOIN gf_flows f ON f.id = a.flow_id WHERE f.doc_id = ${doc.id} AND a.action <> 'skip'`;
  const participants = new Set(acted.map((a) => Number(a.actorId)));
  const targets = ccTargets(candidates, participants, doc.createdBy);
  if (!targets.length) return;
  const urgent = ccUrgent(doc.amountCents, doc.flags, opts.special);
  const fresh: number[] = [];
  for (const t of targets) {
    const rows = await tx<{ id: number }[]>`
      INSERT INTO gf_cc (doc_id, staff_id, role, urgent, reason, notified_at)
      VALUES (${doc.id}, ${t.staffId}, ${t.role}, ${urgent}, ${opts.reason}, ${urgent ? tx`now()` : null})
      ON CONFLICT (doc_id, staff_id) DO NOTHING RETURNING id`;
    if (rows.length) fresh.push(t.staffId);
  }
  if (urgent && fresh.length) {
    await notify(tx, fresh, {
      kind: 'system',
      title: `业财法知会：${doc.title}`,
      body: `${doc.bizNo} ${opts.reason}（只是知会，不用审批）`,
      link: `/oa/gov/${doc.id}`,
      ref: { type: 'gf_cc', id: doc.id },
    });
  }
}

/** 日报：每天 18 点以后，把还没发的普通知会按人汇总成一条站内信（重复跑不会重复发） */
export async function sendCcDigest(db: Sql, timeZone: string, now = new Date()): Promise<number> {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(now));
  if (hour < 18) return 0;
  const today = dateIn(now, timeZone);
  return db.begin(async (tx) => {
    type DigestRow = { id: number; staffId: number; title: string; bizNo: string };
    const rows: DigestRow[] = await tx<DigestRow[]>`
      SELECT c.id, c.staff_id, d.title, d.biz_no FROM gf_cc c JOIN gf_docs d ON d.id = c.doc_id
      WHERE c.notified_at IS NULL AND (c.created_at AT TIME ZONE ${timeZone})::date <= ${today}::date
      ORDER BY c.staff_id, c.id FOR UPDATE OF c SKIP LOCKED`;
    const byStaff = new Map<number, DigestRow[]>();
    for (const r of rows) {
      const list = byStaff.get(Number(r.staffId)) ?? [];
      list.push(r);
      byStaff.set(Number(r.staffId), list);
    }
    for (const [staffId, list] of byStaff) {
      await notify(tx, [staffId], {
        kind: 'system',
        title: `业财法知会日报：${list.length} 件`,
        body: list
          .slice(0, 10)
          .map((r) => `${r.bizNo} ${r.title}`)
          .join('；'),
        link: '/oa/gov?box=cc',
        ref: { type: 'gf_digest', id: Number(today.replaceAll('-', '')) },
      });
      await tx`UPDATE gf_cc SET notified_at = now() WHERE id IN ${tx(list.map((r) => Number(r.id)))}`;
    }
    return rows.length;
  });
}

// ───────────────────────── 状态 ─────────────────────────

export async function statusOf(db: Db, doc: DocRow, flowStatus: GfFlowStatus | null, timeZone: string): Promise<DerivedStatus> {
  // 关联的特批：挂在这个事项上的，或付款申请引用的（紧急付款先特批、后发起）
  const specialId = doc.payload.specialId ? Number(doc.payload.specialId) : 0;
  const [s] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM gf_specials WHERE (doc_id = ${doc.id} OR id = ${specialId}) AND backfilled_at IS NULL`;
  return deriveStatus({
    flow: flowStatus,
    withdrawn: !!doc.withdrawnAt,
    execStarted: !!doc.execStartedAt,
    completed: !!doc.completedAt,
    archived: !!doc.archivedAt,
    specialUnfilled: (s?.n ?? 0) > 0,
    backfillOpen: doc.backfillOpen,
    dueOn: doc.dueOn,
    today: todayIn(timeZone),
  });
}
