// 8.2.30 收银申请（docs/V8230_CASHIER.md 第 2 节，CM-5、CM-6）：没有「开退款单」「反结账」权限的收银员填好内容提交申请，
// 有权限的人批准时按当时的数据重新核对、走原来的退款单 / 反结账（同一个函数、同一套加锁顺序）执行；驳回要写原因。
// 结果（批准、驳回、失效）发站内通知给申请人；同一张结账单同时只能有一张待审批申请，有待审批申请时不能直接退款、反结账；
// 24 小时没人批的由每分钟的扫描记失效并通知。
//
// 锁顺序：批准时照原来的退款单 / 反结账（班次 → 结账单 → …），申请一行在最后锁（afterCreate / afterRestore 里）。
// 提交只写申请一行（唯一索引兜底「一张结账单一张待审批」），不锁结账单。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CASHIER_REQUEST_KIND_LABELS,
  CASHIER_REQUEST_TTL_HOURS,
  effectiveStatus,
  type CashierRequestKind,
  type CashierRequestStatus,
  type CashierRequestView,
  type ShiftHandover,
} from '@shared/cashier-v8230';
import { formatYuan } from '@shared/money';
import { can, permissionsOf, type Duty, type Permission, type Role } from '@shared/permissions';
import { guard, guardAny } from '../../auth/guard';
import { loadRoleOverrides, staffSubject } from '../../auth/role-permissions';
import { isUniqueViolation, type Db, type Fragment, type Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../../lib/context';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { currentStoreId, forEachStore } from '../../lib/store-context';
import { parse } from '../../lib/validate';
import { notify } from '../oa/index';
import { systemAutoStaffId } from '../system-staff';
import { voidCheckout } from './checkout';
import { businessDate, findKey, hashRequest, nextDocNo, runIdempotent, saveKey, setTxTimeouts } from './common';
import { createRefund, RefundInput } from './refunds';

// 退款申请只带「退什么、按什么方式退多少」：怎么执行由批准人定（Codex 审查 06b2eee、8cf7faa，安全）——
//   · 钱箱（refundShiftId）：批准人选，申请人带的丢掉不存；
//   · 每种方式的执行细节（原路退回 viaTerminal、商户后台的退款单号 ref）：批准人在批准时填，申请人带的丢掉不存
//     （不然收银员可以把扫码收的钱写成「已在商户后台退了」、填两个字的假单号，批准就记一张完成的退款单，钱不经支付方）
const RequestPayment = z.object({ method: RefundInput.shape.payments.element.shape.method, amount: RefundInput.shape.payments.element.shape.amount });
const RefundBody = RefundInput.omit({ clientKey: true, refundShiftId: true }).extend({
  payments: z.array(RequestPayment).min(1, '请填写退款方式').max(5, '退款方式最多 5 种'),
});
/** 批准退款申请时每种方式怎么退（批准人填）：微信、支付宝扫码收的默认原路退回；不原路退的（含银行卡、其他）要登记退款单号或写明怎么退的 */
const ApprovePayment = z.object({
  method: RefundInput.shape.payments.element.shape.method,
  viaTerminal: z.boolean().optional(),
  ref: z.string().trim().max(64, '退款单号最多 64 字').default(''),
});
const shiftId = z
  .number('钱箱班次不正确')
  .int('钱箱班次不正确')
  .positive('钱箱班次不正确')
  .nullish()
  .transform((v) => v ?? undefined);

const SubmitInput = z.discriminatedUnion(
  'kind',
  [
    z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'), kind: z.literal('refund'), checkoutId: z.number().int().positive(), refund: RefundBody }),
    z.object({
      clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
      kind: z.literal('void'),
      checkoutId: z.number().int().positive(),
      reason: z.string('请填写反结账原因').trim().min(2, '请填写反结账原因（至少 2 个字）').max(200, '原因最多 200 字'),
    }),
  ],
  '申请的种类不正确',
);
const ApproveInput = z.object({
  /**
   * 批准的操作编号（批准人的页面生成，提交前存进本机「结果待确认」）：退款申请就是开退款单的编号（checkout_refund），
   * 反结账申请记作 cashier_void_approve；同一编号重提返回同一个结果，内容变了拒绝 IDEMPOTENCY_CONFLICT
   */
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  /** 退现金从哪个钱箱退（批准人选，只能是这家店此刻当班的钱箱）；不带时记到批准人自己的班次 */
  refundShiftId: shiftId,
  /** 退款申请：每种方式怎么退（批准人填，见 ApprovePayment）；现金不用填 */
  payments: z.array(ApprovePayment).max(5).default([]),
});
const RejectInput = z.object({ note: z.string('请写驳回原因').trim().min(2, '请写驳回原因（至少 2 个字）').max(200, '原因最多 200 字') });

/** 批准、驳回要的权限：退款申请要「开退款单」，反结账申请要「反结账」 */
const PERMISSION_OF: Record<CashierRequestKind, Permission> = { refund: 'frontdesk.refund', void: 'frontdesk.checkoutVoid' };

/** 执行时这些错误说明单子已经变了（已反结账、退过了、项目或方式超额），申请记失效并通知申请人；别的错误（没开班、超过时限等）是批准人这边的，申请留着 */
const STALE_CODES = new Set([
  'CHECKOUT_VOIDED',
  'ALREADY_VOIDED',
  'REFUND_EXISTS',
  'REFUND_EXCEEDS',
  'REFUND_ITEM_NOT_FOUND',
  'REFUND_METHOD_NOT_PAID',
  'REFUND_METHOD_EXCEEDS',
  'REFUND_NOTHING_LEFT',
  'TAG_REISSUED',
  'MEMBER_IN_STORE',
  'TABLE_TAKEN',
]);

interface Row {
  id: number;
  requestNo: string;
  kind: CashierRequestKind;
  checkoutId: number;
  checkoutNo: string;
  payload: { items?: CashierRequestView['items']; payments?: CashierRequestView['payments'] };
  amount: number;
  reason: string;
  requestedBy: number;
  requestedByName: string;
  requestedAt: Date;
  expiresAt: Date;
  status: CashierRequestStatus;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string;
  refundNo: string | null;
}

async function rows(db: Db, where: Fragment): Promise<Row[]> {
  return db<Row[]>`
    SELECT r.id, r.request_no, r.kind, r.checkout_id, c.checkout_no, r.payload, r.amount, r.reason, r.requested_by, rb.display_name AS requested_by_name,
           r.requested_at, r.expires_at, r.status, db.display_name AS decided_by_name, r.decided_at, r.decision_note, f.refund_no
    FROM cashier_requests r JOIN checkouts c ON c.id = r.checkout_id JOIN staff rb ON rb.id = r.requested_by
    LEFT JOIN staff db ON db.id = r.decided_by LEFT JOIN refunds f ON f.id = r.refund_id
    WHERE r.store_id = ${currentStoreId()} AND ${where}
    ORDER BY r.requested_at DESC, r.id DESC LIMIT 100`;
}

function view(r: Row, now: Date): CashierRequestView {
  const expiresAt = new Date(r.expiresAt).toISOString();
  return {
    id: Number(r.id),
    requestNo: r.requestNo,
    kind: r.kind,
    checkoutId: Number(r.checkoutId),
    checkoutNo: r.checkoutNo,
    amount: r.amount,
    reason: r.reason,
    items: r.payload.items ?? [],
    payments: r.payload.payments ?? [],
    requestedBy: Number(r.requestedBy),
    requestedByName: r.requestedByName,
    requestedAt: new Date(r.requestedAt).toISOString(),
    expiresAt,
    status: effectiveStatus({ status: r.status, expiresAt }, now),
    decidedByName: r.decidedByName,
    decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null,
    decisionNote: r.decisionNote,
    refundNo: r.refundNo,
  };
}

export async function getRequest(db: Db, id: number, now = new Date()): Promise<CashierRequestView> {
  const [r] = await rows(db, db`r.id = ${id}`);
  if (!r) throw notFound('申请不存在');
  return view(r, now);
}

/** 待我审批的（我有对应权限、不是我提交的、还在时限里）与我提交的（最近 100 张） */
export async function listRequests(db: Db, actor: OpContext['actor'], now = new Date()): Promise<{ todo: CashierRequestView[]; mine: CashierRequestView[] }> {
  const kinds = (Object.keys(PERMISSION_OF) as CashierRequestKind[]).filter((k) => can(actor, PERMISSION_OF[k]));
  const todo = kinds.length ? await rows(db, db`r.status = 'pending' AND r.expires_at > ${now} AND r.kind IN ${db(kinds)} AND r.requested_by <> ${actor.id}`) : [];
  const mine = await rows(db, db`r.requested_by = ${actor.id}`);
  return { todo: todo.map((r) => view(r, now)), mine: mine.map((r) => view(r, now)) };
}

/** 在这家店、在职、有这项权限的人（店主不用挂店；没挂任何店的算全店） */
async function holdersOf(tx: Tx, permission: Permission, except: number): Promise<number[]> {
  const list = await tx<{ id: number; role: Role; duties: Duty[] | null; position: unknown; permissionAdjust: unknown }[]>`
    SELECT s.id, s.role, s.duties, s.position, s.permission_adjust FROM staff s
    WHERE s.active AND NOT s.system AND s.id <> ${except}
      AND (s.role = 'owner' OR EXISTS (SELECT 1 FROM staff_stores ss WHERE ss.staff_id = s.id AND ss.store_id = ${currentStoreId()})
           OR NOT EXISTS (SELECT 1 FROM staff_stores ss WHERE ss.staff_id = s.id))
    ORDER BY s.id`;
  const overrides = await loadRoleOverrides(tx);
  return list.filter((s) => can({ role: s.role, duties: s.duties ?? [], permissions: permissionsOf(staffSubject(s), overrides) }, permission)).map((s) => Number(s.id));
}

const link = (id: number) => `/crm/cashier-requests?r=${id}`;

/** 提交申请：核对结账单还能退 / 反结账（只读，批准时再按当时的数据核对一次）；同一张结账单已有待审批的拒绝 */
export async function submitRequest(deps: Deps, raw: unknown, ctx: OpContext): Promise<CashierRequestView> {
  const input = parse(SubmitInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  let amount: number;
  let reason: string;
  let body: Record<string, unknown>;
  if (input.kind === 'refund') {
    const r = input.refund;
    const items = r.items.reduce((s, i) => s + i.amount, 0);
    const pays = r.payments.reduce((s, p) => s + p.amount, 0);
    if (items !== pays) throw unprocessable('REFUND_NOT_BALANCED', `退的项目合计 ${formatYuan(items)}，退款方式合计 ${formatYuan(pays)}，两者要相等`, { items, payments: pays });
    amount = items;
    reason = r.reason;
    body = { items: r.items, payments: r.payments };
  } else {
    reason = input.reason;
    body = {};
    amount = 0;
  }
  const run = await runIdempotent(deps, { key, opType: 'cashier_request', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const [c] = await tx<{ id: number; checkoutNo: string; status: string; totalAmount: number }[]>`
      SELECT id, checkout_no, status, total_amount FROM checkouts WHERE id = ${input.checkoutId} AND store_id = ${currentStoreId()}`;
    if (!c) throw notFound('结账单不存在');
    if (c.status !== 'completed') throw conflict('CHECKOUT_VOIDED', `结账单 ${c.checkoutNo} 已反结账`);
    if (input.kind === 'void') amount = c.totalAmount;
    // 过了时限还挂着的先记失效（不然唯一索引挡着新申请）；扫描每分钟也会记
    await expireDue(tx, deps, at, input.checkoutId);
    const date = await businessDate(tx, deps, at);
    const requestNo = await nextDocNo(tx, 'cashier_request', 'SQ', date);
    let id: number;
    try {
      const [r] = await tx<{ id: number }[]>`
        INSERT INTO cashier_requests (request_no, kind, checkout_id, payload, amount, reason, client_key, requested_by, requested_at, expires_at)
        VALUES (${requestNo}, ${input.kind}, ${c.id}, ${tx.json(body as never)}, ${amount}, ${reason}, ${key}, ${ctx.actor.id}, ${at},
                ${new Date(at.getTime() + CASHIER_REQUEST_TTL_HOURS * 3_600_000)})
        RETURNING id`;
      id = Number(r!.id);
    } catch (e) {
      if (isUniqueViolation(e, 'cashier_requests_one_pending')) throw conflict('REQUEST_PENDING', `结账单 ${c.checkoutNo} 已经有一张待审批的申请，等它处理完再提交`);
      throw e;
    }
    await saveKey(tx, key, 'cashier_request', requestHash, id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'cashier_request_submit',
      targetType: 'cashier_request',
      targetId: id,
      detail: { docNo: requestNo, kind: input.kind, checkoutNo: c.checkoutNo, amount, reason },
      ip: ctx.ip,
      businessDate: date,
    });
    await notify(tx, await holdersOf(tx, PERMISSION_OF[input.kind], ctx.actor.id), {
      kind: 'approval_todo',
      title: `${CASHIER_REQUEST_KIND_LABELS[input.kind]}申请待审批：${c.checkoutNo}`,
      body: `${ctx.actor.displayName}申请${CASHIER_REQUEST_KIND_LABELS[input.kind]} ${formatYuan(amount)}，原因：${reason}`,
      link: link(id),
      ref: { type: 'cashier_request', id },
    });
    return id;
  });
  return getRequest(deps.sql, run.refId);
}

/** 锁住申请一行核对还能处理：不存在、已处理、过了时限的拒绝（过了时限的顺手记失效） */
async function lockPending(tx: Tx, id: number, at: Date) {
  const [r] = await tx<{ id: number; requestNo: string; kind: CashierRequestKind; checkoutId: number; status: CashierRequestStatus; expiresAt: Date; requestedBy: number }[]>`
    SELECT id, request_no, kind, checkout_id, status, expires_at, requested_by FROM cashier_requests WHERE id = ${id} AND store_id = ${currentStoreId()} FOR UPDATE`;
  if (!r) throw notFound('申请不存在');
  if (r.status !== 'pending') throw conflict('REQUEST_DECIDED', `申请 ${r.requestNo} 已经处理过了，请刷新`);
  if (new Date(r.expiresAt).getTime() <= at.getTime()) throw conflict('REQUEST_EXPIRED', `申请 ${r.requestNo} 已超过 ${CASHIER_REQUEST_TTL_HOURS} 小时，失效了；请申请人重新提交`);
  return r;
}

async function peek(db: Db, id: number) {
  const [r] = await db<{ id: number; requestNo: string; kind: CashierRequestKind; checkoutId: number; status: CashierRequestStatus; requestedBy: number; reason: string; payload: Row['payload'] }[]>`
    SELECT id, request_no, kind, checkout_id, status, requested_by, reason, payload FROM cashier_requests WHERE id = ${id} AND store_id = ${currentStoreId()}`;
  if (!r) throw notFound('申请不存在');
  return r;
}

/** 记一种结果并通知申请人（在调用方的事务里，申请一行已锁） */
async function decide(
  tx: Tx,
  deps: Deps,
  r: { id: number; requestNo: string; kind: CashierRequestKind; requestedBy: number },
  d: { status: Exclude<CashierRequestStatus, 'pending'>; by: number; note: string; refundId?: number; at: Date; ip?: string; checkoutNo: string },
) {
  await tx`
    UPDATE cashier_requests SET status = ${d.status}, decided_by = ${d.by}, decided_at = ${d.at}, decision_note = ${d.note.slice(0, 200)},
                                refund_id = ${d.refundId ?? null}
    WHERE id = ${r.id}`;
  await writeAudit(tx, {
    staffId: d.by,
    action: 'cashier_request_decide',
    targetType: 'cashier_request',
    targetId: r.id,
    detail: { docNo: r.requestNo, kind: r.kind, status: d.status, note: d.note },
    ...(d.ip ? { ip: d.ip } : {}),
    businessDate: await businessDate(tx, deps, d.at),
  });
  if (d.status === 'cancelled') return;
  const what = `${CASHIER_REQUEST_KIND_LABELS[r.kind]}申请 ${r.requestNo}（${d.checkoutNo}）`;
  await notify(tx, [r.requestedBy], {
    kind: 'approval_result',
    title: d.status === 'approved' ? `${what}已批准` : d.status === 'rejected' ? `${what}被驳回` : `${what}已失效`,
    body: d.status === 'approved' ? (r.kind === 'refund' ? '已开退款单；退现金的请当面退给客人' : '已反结账，客人回到在店，可以重新结账') : d.note,
    link: link(r.id),
    ref: { type: 'cashier_request', id: r.id },
  });
  // 待审批的那条通知（发给有权限的人）在处理以后不用再看：同一件事没读的只留一条，这里不动，点开会看到已处理
}

/**
 * 批准：按当时的数据重新核对，走原来的开退款单 / 反结账执行；单子已经变了的申请记失效并通知申请人。
 * 批准是一笔收款（退款、反结账退钱），照「结果待确认」的协议（Codex 审查 06b2eee P1）：页面提交前把操作编号与原请求存进本机，
 *   · 退款申请：编号就是开退款单的编号（checkout_refund），查回、作废走退款单那一类；
 *   · 反结账申请：编号记作 cashier_void_approve（ref_id 是这张申请），在反结账的同一事务最后写下（处理期间被作废则整笔回滚）；
 * 同一编号重提返回同一个结果，内容（钱箱）变了拒绝 IDEMPOTENCY_CONFLICT。
 */
export async function approveRequest(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<CashierRequestView> {
  const input = parse(ApproveInput, raw);
  const r = await peek(deps.sql, id);
  if (!can(ctx.actor, PERMISSION_OF[r.kind])) throw forbidden(`批准${CASHIER_REQUEST_KIND_LABELS[r.kind]}申请要有「${r.kind === 'refund' ? '开退款单' : '反结账'}」的权限`);
  if (Number(r.requestedBy) === ctx.actor.id) throw forbidden('不能批准自己提交的申请');
  const key = input.clientKey;
  const voidHash = hashRequest({ requestId: Number(r.id), refundShiftId: input.refundShiftId ?? null });
  // 反结账申请：同一编号已经批过（回复丢了重提）直接返回；作废过的编号拒绝 OP_ABANDONED
  const replayed = async () => (r.kind === 'void' ? await findKey(deps.sql, key, 'cashier_void_approve', voidHash) : null);
  if ((await replayed()) !== null) return getRequest(deps.sql, id);
  const [c] = await deps.sql<{ checkoutNo: string }[]>`SELECT checkout_no FROM checkouts WHERE id = ${r.checkoutId}`;
  const finish = async (tx: Tx, refundId?: number) => {
    const at = ctx.at ?? new Date();
    const locked = await lockPending(tx, id, at);
    await decide(
      tx,
      deps,
      { ...locked, id: Number(locked.id), requestedBy: Number(locked.requestedBy) },
      { status: 'approved', by: ctx.actor.id, note: '', refundId, at, ip: ctx.ip, checkoutNo: c!.checkoutNo },
    );
    if (r.kind === 'void') await saveKey(tx, key, 'cashier_void_approve', voidHash, id, ctx.actor.id);
  };
  // 钱箱只能选这家店此刻当班的（lockRefundShift 在锁里核对：别家店的、已交班的、升级前开的都拒绝）；不带时记到批准人自己的班次
  const drawer = input.refundShiftId !== undefined ? { refundShiftId: input.refundShiftId } : {};
  try {
    if (r.kind === 'refund') {
      const p = r.payload;
      await createRefund(
        deps,
        Number(r.checkoutId),
        {
          clientKey: key,
          items: p.items as never,
          payments: await approvedPayments(deps.sql, Number(r.checkoutId), p.payments ?? [], input.payments),
          reason: `申请 ${r.requestNo}：${r.reason}`.slice(0, 200),
          ...drawer,
        },
        ctx,
        { requestId: Number(r.id), afterCreate: (tx, refund) => finish(tx, refund.id) },
      );
    } else {
      await voidCheckout(deps, Number(r.checkoutId), { reason: `申请 ${r.requestNo}：${r.reason}`.slice(0, 200), ...drawer }, ctx, {
        requestId: Number(r.id),
        afterRestore: (tx) => finish(tx),
      });
    }
  } catch (e) {
    // 同一编号的两次提交并发：后到的那次撞上编号或看到「已反结账」，先按编号查回，是同一笔就返回第一次的结果
    if (r.kind === 'void' && (isUniqueViolation(e, 'idempotency_keys_pkey') || (e instanceof AppError && e.code === 'ALREADY_VOIDED'))) {
      if ((await replayed().catch(() => null)) !== null) return getRequest(deps.sql, id);
    }
    // 已处理过（别人刚批了）照原样报；单子变了的记失效
    if (e instanceof AppError && STALE_CODES.has(e.code)) await markStale(deps, id, e.message, ctx);
    throw e;
  }
  return getRequest(deps.sql, id);
}

/**
 * 退款申请的每种方式按批准人填的执行：微信、支付宝在这张结账单上有扫码收款的，批准人没说不原路退就原路退回（由系统去支付方退）；
 * 其余（不原路退的微信、支付宝，银行卡、其他）带上批准人登记的退款单号，createRefund 照直接开退款单同样核对（至少 2 个字）。
 * 默认只看「这种方式扫码收过」（不看还剩多少能退），重提同一个编号时算出来的一样，不会因为退过一次变了内容
 */
async function approvedPayments(db: Db, checkoutId: number, requested: { method: string; amount: number }[], chosen: z.infer<typeof ApprovePayment>[]) {
  const scanned = await db<{ provider: string }[]>`
    SELECT DISTINCT provider FROM pay_transactions WHERE consumed_kind = 'checkout' AND consumed_id = ${checkoutId}`;
  const terminal = new Set(scanned.map((t) => t.provider));
  return requested.map((p) => {
    if (p.method === 'cash') return { method: p.method, amount: p.amount };
    const c = chosen.find((x) => x.method === p.method);
    const via = c?.viaTerminal ?? ((p.method === 'wechat' || p.method === 'alipay') && terminal.has(p.method));
    return via ? { method: p.method, amount: p.amount, viaTerminal: true } : { method: p.method, amount: p.amount, ref: c?.ref ?? '' };
  }) as never;
}

async function markStale(deps: Deps, id: number, why: string, ctx: OpContext) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const [r] = await tx<{ id: number; requestNo: string; kind: CashierRequestKind; status: string; requestedBy: number; checkoutNo: string }[]>`
      SELECT r.id, r.request_no, r.kind, r.status, r.requested_by, c.checkout_no FROM cashier_requests r JOIN checkouts c ON c.id = r.checkout_id
      WHERE r.id = ${id} FOR UPDATE OF r`;
    if (!r || r.status !== 'pending') return;
    await decide(
      tx,
      deps,
      { ...r, id: Number(r.id), requestedBy: Number(r.requestedBy) },
      { status: 'expired', by: ctx.actor.id, note: `单子已经变了：${why}`, at, ip: ctx.ip, checkoutNo: r.checkoutNo },
    );
  });
}

export async function rejectRequest(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<CashierRequestView> {
  const { note } = parse(RejectInput, raw);
  const r = await peek(deps.sql, id);
  if (!can(ctx.actor, PERMISSION_OF[r.kind])) throw forbidden(`驳回${CASHIER_REQUEST_KIND_LABELS[r.kind]}申请要有「${r.kind === 'refund' ? '开退款单' : '反结账'}」的权限`);
  if (Number(r.requestedBy) === ctx.actor.id) throw forbidden('自己的申请请用「撤回」');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const locked = await lockPending(tx, id, at);
    const [c] = await tx<{ checkoutNo: string }[]>`SELECT checkout_no FROM checkouts WHERE id = ${locked.checkoutId}`;
    await decide(tx, deps, { ...locked, id: Number(locked.id), requestedBy: Number(locked.requestedBy) }, { status: 'rejected', by: ctx.actor.id, note, at, ip: ctx.ip, checkoutNo: c!.checkoutNo });
  });
  return getRequest(deps.sql, id);
}

/** 申请人撤回自己没处理的申请 */
export async function cancelRequest(deps: Deps, id: number, ctx: OpContext): Promise<CashierRequestView> {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const locked = await lockPending(tx, id, at);
    if (Number(locked.requestedBy) !== ctx.actor.id) throw forbidden('只能撤回自己提交的申请');
    const [c] = await tx<{ checkoutNo: string }[]>`SELECT checkout_no FROM checkouts WHERE id = ${locked.checkoutId}`;
    await decide(
      tx,
      deps,
      { ...locked, id: Number(locked.id), requestedBy: Number(locked.requestedBy) },
      { status: 'cancelled', by: ctx.actor.id, note: '申请人撤回', at, ip: ctx.ip, checkoutNo: c!.checkoutNo },
    );
  });
  return getRequest(deps.sql, id);
}

/** 过了时限还没处理的记失效、通知申请人（checkoutId 只处理这一张结账单的）；返回记了几张 */
async function expireDue(tx: Tx, deps: Deps, now: Date, checkoutId?: number): Promise<number> {
  const due = await tx<{ id: number; requestNo: string; kind: CashierRequestKind; requestedBy: number; checkoutNo: string }[]>`
    SELECT r.id, r.request_no, r.kind, r.requested_by, c.checkout_no FROM cashier_requests r JOIN checkouts c ON c.id = r.checkout_id
    WHERE r.store_id = ${currentStoreId()} AND r.status = 'pending' AND r.expires_at <= ${now}
      ${checkoutId !== undefined ? tx`AND r.checkout_id = ${checkoutId}` : tx``}
    ORDER BY r.id LIMIT 200 FOR UPDATE OF r SKIP LOCKED`;
  if (!due.length) return 0;
  const staffId = await systemAutoStaffId(tx);
  for (const r of due) {
    await decide(
      tx,
      deps,
      { ...r, id: Number(r.id), requestedBy: Number(r.requestedBy) },
      {
        status: 'expired',
        by: staffId,
        note: `${CASHIER_REQUEST_TTL_HOURS} 小时没人处理，自动失效；还要办的请重新提交`,
        at: now,
        checkoutNo: r.checkoutNo,
      },
    );
  }
  return due.length;
}

/** 每分钟：过了时限还没处理的申请记失效并通知申请人 */
export async function sweepCashierRequests(deps: Deps, now = new Date()): Promise<number> {
  let n = 0;
  await forEachStore(deps.sql, async () => {
    n += await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      return expireDue(tx, deps, now);
    });
  });
  return n;
}

/** 交班页「交给下一班」（CM-9）：只读 */
export async function shiftHandover(db: Db, actor: OpContext['actor'], now = new Date()): Promise<ShiftHandover> {
  const mine = await db<{ requestNo: string; kind: CashierRequestKind; checkoutNo: string; amount: number }[]>`
    SELECT r.request_no, r.kind, c.checkout_no, r.amount FROM cashier_requests r JOIN checkouts c ON c.id = r.checkout_id
    WHERE r.store_id = ${currentStoreId()} AND r.requested_by = ${actor.id} AND r.status = 'pending' AND r.expires_at > ${now}
    ORDER BY r.requested_at`;
  const kinds = (Object.keys(PERMISSION_OF) as CashierRequestKind[]).filter((k) => can(actor, PERMISSION_OF[k]));
  const [todo] = kinds.length
    ? await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM cashier_requests
        WHERE store_id = ${currentStoreId()} AND status = 'pending' AND expires_at > ${now} AND kind IN ${db(kinds)} AND requested_by <> ${actor.id}`
    : [{ n: 0 }];
  const [unread] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM oa_notifications WHERE staff_id = ${actor.id} AND read_at IS NULL`;
  const [open] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM visits WHERE store_id = ${currentStoreId()} AND status = 'open'`;
  return { myPendingRequests: mine, toApprove: todo!.n, unreadNotices: unread!.n, openVisits: open!.n };
}

export function registerCashierRequestRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const idParam = z.object({ id: z.coerce.number().int().positive() });
  app.get('/api/cashier-requests', { preHandler: guard('frontdesk.read') }, async (req) => listRequests(sql, req.actor));
  app.get('/api/cashier-requests/handover', { preHandler: guard('frontdesk.read') }, async (req) => shiftHandover(sql, req.actor));
  app.get('/api/cashier-requests/:id', { preHandler: guard('frontdesk.read') }, async (req) => getRequest(sql, parse(idParam, req.params).id));
  app.post('/api/cashier-requests', { preHandler: guard('frontdesk.checkout') }, async (req) => submitRequest(deps, req.body, ctxOf(req)));
  app.post('/api/cashier-requests/:id/approve', { preHandler: guardAny('frontdesk.refund', 'frontdesk.checkoutVoid') }, async (req) =>
    approveRequest(deps, parse(idParam, req.params).id, req.body, ctxOf(req)),
  );
  app.post('/api/cashier-requests/:id/reject', { preHandler: guardAny('frontdesk.refund', 'frontdesk.checkoutVoid') }, async (req) =>
    rejectRequest(deps, parse(idParam, req.params).id, req.body, ctxOf(req)),
  );
  app.post('/api/cashier-requests/:id/cancel', { preHandler: guard('frontdesk.read') }, async (req) => cancelRequest(deps, parse(idParam, req.params).id, ctxOf(req)));
}
