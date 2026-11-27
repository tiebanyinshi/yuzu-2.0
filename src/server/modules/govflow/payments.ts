// 业财法 P05：付款与紧急特批（docs/APPROVAL_V4.md 第 9 节）。
//   POST /api/gf/payments                 发起付款申请（含税）：按合同 / 无合同 / 紧急特批分路，拦截重复支付与绕开合同
//   GET  /api/gf/payments/:id             付款要点、已付、特批剩余
//   POST /api/gf/payments/:id/pay         出纳付款：独立核验收款账户（要重新输入、与当前账户一致），分次累计不超申请金额与特批金额
//   POST /api/gf/payments/:id/reconfirm   收款账户变更后，已批付款申请由财务重新确认
//   POST /api/gf/payments/:id/invoice     后补发票（同一收款方同一发票号只付一次）

import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { addWorkdays, type GfRole } from '@shared/govflow';
import { INVOICE_LATER_WORKDAYS, INVOICE_STATES, PAYMENT_CATEGORIES, routePayment, type InvoiceState, type PaymentRoute, type PaymentView } from '@shared/govflow-payment';
import { formatAmount } from '@shared/money';
import { maskAccount } from '@shared/mask';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../../db';
import { isUniqueViolation } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { hashRequest } from '../../lib/idempotency';
import { setTxTimeouts } from '../../lib/tx';
import { idParam, parse } from '../../lib/validate';
import { NOT_EMPLOYEE_ROLES } from '../oa/org';
import { insertDoc, latestFlow, loadDoc, loadMembers, registerHooks, rolesOf, submitFlow, type DocRow } from './engine';
import { inLibrary } from './supply';
import { templateFor } from './types';

let TZ = 'Asia/Shanghai';
const uuid = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const yuan = (c: number) => `¥${formatAmount(c)}`;

/** 在途 + 已付的付款申请（没撤回、最近一轮没驳回） */
const ACTIVE = (db: Db) => db`d.doc_type = 'payment' AND d.withdrawn_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM gf_flows f WHERE f.doc_id = d.id AND f.status IN ('rejected') AND f.round = (SELECT max(round) FROM gf_flows g WHERE g.doc_id = d.id))`;

async function holidays(db: Db) {
  const rows = await db<{ day: string; kind: 'holiday' | 'workday' }[]>`SELECT day::text AS day, kind FROM oa_holidays WHERE day >= current_date - 7`;
  return new Map(rows.map((r) => [r.day, r.kind]));
}

const PaymentInput = z.object({
  clientKey: uuid,
  title: z.string().trim().min(2).max(100),
  departmentId: z.number().int().positive(),
  category: z.enum(PAYMENT_CATEGORIES),
  contractDocId: z.number().int().positive().nullable().default(null),
  paymentNode: z.string().trim().max(60).default(''),
  supplierId: z.number().int().positive().nullable().default(null),
  payeeName: z.string().trim().max(80).default(''),
  payeeAccount: z
    .string()
    .trim()
    .regex(/^\d{6,30}$/, '收款账号是 6–30 位数字')
    .nullable()
    .default(null),
  amountCents: z.number().int().positive('付款金额要大于 0').max(100_000_000_000),
  acceptanceBasis: z.string().trim().max(300).default(''),
  prepay: z.boolean().default(false),
  invoice: z.enum(INVOICE_STATES),
  invoiceNo: z.string().trim().max(40).default(''),
  abnormal: z.boolean().default(false),
  specialId: z.number().int().positive().nullable().default(null),
  note: z.string().trim().max(500).default(''),
});
type PaymentInputT = z.infer<typeof PaymentInput>;

/** 紧急特批核对：确认人要有一位 CFO、一位经营主体负责人；收款账户一致；累计（含这一笔）不超特批金额 */
async function checkSpecial(db: Db, specialId: number, payeeAccount: string, amount: number, entityId: number | null, excludeDocId = 0) {
  const [s] = await db<{ id: number; specialNo: string; amountCents: number; confirmerIds: number[]; confirmedAt: Date; payeeAccount: string | null }[]>`
    SELECT id, special_no, amount_cents, confirmer_ids, confirmed_at, payee_account FROM gf_specials WHERE id = ${specialId} FOR UPDATE`;
  if (!s) throw unprocessable('GF_SPECIAL', '没有这笔特批');
  const members = await loadMembers(db, entityId);
  const ids = s.confirmerIds.map(Number);
  const cfo = ids.some((id) => (members.cfo ?? []).includes(id));
  const ceo = ids.some((id) => (members.entity_head ?? []).includes(id));
  if (!cfo || !ceo) throw unprocessable('GF_SPECIAL_CONFIRMERS', '紧急付款的特批要 CFO 与经营主体负责人两人微信确认');
  if (new Date(s.confirmedAt).getTime() > Date.now()) throw unprocessable('GF_SPECIAL', '特批确认时间晚于现在：付款前要先完成两人同意');
  if (!s.payeeAccount || s.payeeAccount !== payeeAccount) throw conflict('GF_SPECIAL_ACCOUNT', '收款账户与特批时确认的不一致：换账户要重新特批');
  const [used] = await db<{ s: number }[]>`
    SELECT coalesce(sum(d.amount_cents), 0)::bigint AS s FROM gf_docs d WHERE ${ACTIVE(db)} AND (d.payload->>'specialId')::bigint = ${specialId} AND d.id <> ${excludeDocId}`;
  if (Number(used!.s) + amount > Number(s.amountCents)) {
    throw conflict('GF_SPECIAL_EXCEEDED', `累计 ${yuan(Number(used!.s) + amount)} 超过特批金额 ${yuan(Number(s.amountCents))}：超额要重新特批`);
  }
  return { specialNo: s.specialNo, amountCents: Number(s.amountCents) };
}

async function createPayment(deps: Deps, input: PaymentInputT, actor: Actor): Promise<number> {
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const existing = async (db: Db) => {
    const [r] = await db<{ id: number; createdBy: number; requestHash: string }[]>`SELECT id, created_by, request_hash FROM gf_docs WHERE client_key = ${input.clientKey}`;
    if (!r) return null;
    if (Number(r.createdBy) !== actor.id || r.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔付款，请刷新页面后重新填写');
    return Number(r.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const found = await existing(tx);
      if (found) return found;
      // 合同与收款方
      let contract: DocRow | null = null;
      let contractValid = false;
      let supplierId = input.supplierId;
      let payeeName = input.payeeName;
      if (input.contractDocId !== null) {
        contract = await loadDoc(tx, input.contractDocId, true);
        if (contract.docType !== 'contract') throw unprocessable('GF_CONTRACT', '关联的不是合同');
        const f = await latestFlow(tx, contract.id);
        contractValid = f?.status === 'approved' && !contract.withdrawnAt && !contract.payload.supersededBy;
        supplierId = contract.payload.supplierId ? Number(contract.payload.supplierId) : supplierId;
        payeeName = String(contract.payload.counterparty ?? payeeName);
      }
      let payeeAccount = input.payeeAccount;
      let accountChangePending = false;
      let supplierActive = false;
      if (supplierId !== null) {
        const [s] = await tx<{ name: string; bankAccount: string; pendingChangeDocId: number | null; status: string }[]>`
          SELECT name, bank_account, pending_change_doc_id, status FROM gf_suppliers WHERE id = ${supplierId} FOR SHARE`;
        if (!s) throw unprocessable('GF_SUPPLIER', '供应商不存在');
        payeeName = s.name;
        payeeAccount = s.bankAccount || payeeAccount;
        accountChangePending = s.pendingChangeDocId !== null;
        supplierActive = (await inLibrary(tx, supplierId)).ok;
      }
      if (!payeeAccount) throw unprocessable('GF_PAYEE', '请填收款账号');
      if (!payeeName) throw unprocessable('GF_PAYEE', '请填收款方');
      // 同一合同串行算剩余应付；同一收款方同一发票号只付一次
      if (contract) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`gf_contract_pay:${contract.id}`}, 0))`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`gf_payee:${payeeAccount}`}, 0))`;
      if (input.invoiceNo) {
        const [dup] = await tx<{ bizNo: string }[]>`
          SELECT d.biz_no FROM gf_docs d WHERE ${ACTIVE(tx)} AND d.payload->>'payeeAccount' = ${payeeAccount} AND d.payload->>'invoiceNo' = ${input.invoiceNo} LIMIT 1`;
        if (dup) throw conflict('GF_DUPLICATE_PAYMENT', `同一收款方、同一发票号已经有付款申请（${dup.bizNo}），不能重复支付`);
      }
      let remaining: number | null = null;
      if (contract) {
        const total = Number(contract.payload.taxInclusiveCents ?? contract.amountCents ?? 0);
        const [used] = await tx<{ s: number }[]>`
          SELECT coalesce(sum(d.amount_cents), 0)::bigint AS s FROM gf_docs d WHERE ${ACTIVE(tx)} AND (d.payload->>'contractDocId')::bigint = ${contract.id}`;
        remaining = total - Number(used!.s);
      }
      const emergency = input.specialId !== null;
      let special: { specialNo: string; amountCents: number } | null = null;
      if (emergency) {
        if (supplierActive && contractValid) throw unprocessable('GF_NOT_EMERGENCY', '供应商已入库、合同已完成审批：走正常付款，不用紧急特批');
        special = await checkSpecial(tx, input.specialId!, payeeAccount, input.amountCents, contract?.entityId ?? null);
      }
      const route: PaymentRoute = routePayment({
        hasContract: contract !== null,
        contractValid,
        category: input.category,
        amountCents: input.amountCents,
        remainingCents: remaining,
        hasAcceptanceBasis: input.acceptanceBasis.length >= 2,
        prepay: input.prepay,
        invoice: input.invoice,
        accountChangePending,
        abnormal: input.abnormal,
        emergency,
      });
      if (route.blockers.length) {
        const code = route.blockers.some((b) => b.includes('必须签合同'))
          ? 'GF_CONTRACT_REQUIRED'
          : route.blockers.some((b) => b.includes('重复支付'))
            ? 'GF_OVERPAY'
            : route.blockers.some((b) => b.includes('账户'))
              ? 'GF_ACCOUNT_PENDING'
              : 'GF_PAYMENT_BLOCKED';
        throw unprocessable(code, route.blockers.join('；'), { blockers: route.blockers });
      }
      const flags: string[] = [];
      if (input.abnormal) flags.push('abnormal');
      if (input.prepay) flags.push('prepay');
      if (emergency) flags.push('urgent');
      const today = todayIn(TZ);
      const invoiceLater = input.invoice !== 'received';
      const id = await insertDoc(
        tx,
        {
          docType: 'payment',
          title: `付款：${input.title}`,
          note: input.note,
          departmentId: input.departmentId,
          entityId: contract?.entityId ?? null,
          amountCents: input.amountCents,
          relatedDocId: contract?.id ?? null,
          flags,
          payload: {
            path: route.path,
            category: input.category,
            contractDocId: contract?.id ?? null,
            contractNo: contract?.payload.contractNo ?? null,
            paymentNode: input.paymentNode,
            supplierId,
            payeeName,
            payeeAccount,
            acceptanceBasis: input.acceptanceBasis,
            prepay: input.prepay,
            invoice: input.invoice,
            invoiceNo: input.invoiceNo,
            specialId: input.specialId,
            specialNo: special?.specialNo ?? null,
            needsReconfirm: false,
          },
          clientKey: input.clientKey,
          requestHash,
          dueOn: input.invoice === 'later' ? addWorkdays(today, INVOICE_LATER_WORKDAYS, await holidays(tx)) : null,
        },
        actor,
        today,
      );
      if (invoiceLater) await tx`UPDATE gf_docs SET backfill_open = true WHERE id = ${id}`;
      const doc = await loadDoc(tx, id, true);
      await submitFlow(tx, doc, templateFor(doc), actor);
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

/** 审批链按发起时定下的路径重排（退回再提交时） */
function nodesFor(doc: DocRow) {
  const p = doc.payload;
  return routePayment({
    hasContract: p.contractDocId !== null,
    contractValid: true,
    category: p.category as PaymentInputT['category'],
    amountCents: doc.amountCents ?? 0,
    remainingCents: null,
    hasAcceptanceBasis: true,
    prepay: p.prepay === true,
    invoice: p.invoice as InvoiceState,
    accountChangePending: false,
    abnormal: doc.flags.includes('abnormal'),
    emergency: p.specialId !== null && p.specialId !== undefined,
  }).nodes;
}

registerHooks('payment', {
  template: nodesFor,
  ccRoles: (doc) => (doc.payload.path === 'normal' || doc.payload.path === 'no_contract' ? [] : ['chairman', 'business_gm', 'finance_chief', 'cfo']),
  beforeSubmit: async (tx, doc) => {
    if (doc.payload.supplierId) {
      const [s] = await tx<{ pendingChangeDocId: number | null }[]>`SELECT pending_change_doc_id FROM gf_suppliers WHERE id = ${Number(doc.payload.supplierId)}`;
      if (s?.pendingChangeDocId) throw conflict('GF_ACCOUNT_PENDING', '收款账户有在审的变更，审完再付');
    }
  },
});

async function paymentView(db: Db, doc: DocRow): Promise<PaymentView> {
  const p = doc.payload;
  const payouts = await db<{ id: number; amountCents: number; payeeAccount: string; bankRef: string; paidByName: string; paidAt: Date }[]>`
    SELECT o.id, o.amount_cents, o.payee_account, o.bank_ref, s.display_name AS paid_by_name, o.paid_at FROM gf_payouts o JOIN staff s ON s.id = o.paid_by WHERE o.doc_id = ${doc.id} ORDER BY o.id`;
  let specialRemaining: number | null = null;
  if (p.specialId) {
    const [r] = await db<{ amount: number; used: number }[]>`
      SELECT s.amount_cents AS amount, coalesce((SELECT sum(o.amount_cents) FROM gf_payouts o JOIN gf_docs d ON d.id = o.doc_id WHERE (d.payload->>'specialId')::bigint = s.id), 0)::bigint AS used
      FROM gf_specials s WHERE s.id = ${Number(p.specialId)}`;
    specialRemaining = r ? Number(r.amount) - Number(r.used) : null;
  }
  return {
    docId: doc.id,
    path: p.path as PaymentView['path'],
    contractDocId: p.contractDocId ? Number(p.contractDocId) : null,
    contractNo: (p.contractNo as string | null) ?? null,
    supplierId: p.supplierId ? Number(p.supplierId) : null,
    payeeName: String(p.payeeName),
    payeeAccountMasked: maskAccount(String(p.payeeAccount)),
    amountCents: doc.amountCents ?? 0,
    paidCents: payouts.reduce((a, o) => a + Number(o.amountCents), 0),
    invoice: p.invoice as InvoiceState,
    invoiceNo: String(p.invoiceNo ?? ''),
    needsReconfirm: p.needsReconfirm === true,
    specialId: p.specialId ? Number(p.specialId) : null,
    specialNo: (p.specialNo as string | null) ?? null,
    specialRemainingCents: specialRemaining,
    payouts: payouts.map((o) => ({ ...o, id: Number(o.id), amountCents: Number(o.amountCents), payeeAccount: maskAccount(o.payeeAccount), paidAt: new Date(o.paidAt).toISOString() })),
  };
}

/** 收款账户变更通过后：这个供应商还没付完的付款申请都要财务重新确认（供应商变更通过时调） */
export async function flagReconfirm(tx: Tx, supplierId: number) {
  await tx`
    UPDATE gf_docs SET payload = payload || '{"needsReconfirm": true}'::jsonb, version = version + 1
    WHERE doc_type = 'payment' AND (payload->>'supplierId')::bigint = ${supplierId} AND completed_at IS NULL AND withdrawn_at IS NULL`;
}

const PayInput = z.object({
  clientKey: uuid,
  amountCents: z.number().int().positive(),
  bankRef: z.string().trim().min(4, '请填银行流水号').max(60),
  accountConfirm: z
    .string()
    .trim()
    .regex(/^\d{6,30}$/, '请重新输入收款账号核对'),
});

export function registerPaymentRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  TZ = deps.config.timezone;
  const signedIn = guard();
  const staffOnly: preHandlerAsyncHookHandler = async function (req, reply) {
    await signedIn.call(this, req, reply);
    if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(req.actor.role)) throw forbidden('这个账号不能用业财法审批');
  };
  const hasRole = async (actor: Actor, roles: readonly GfRole[]) => (await rolesOf(sql, actor.id)).some((r) => roles.includes(r));

  app.post('/api/gf/payments', { preHandler: staffOnly }, async (req) => {
    const input = parse(PaymentInput, req.body);
    const id = await createPayment(deps, input, req.actor);
    await writeAudit(sql, { staffId: req.actor.id, action: 'gf_payment', targetType: 'gf_doc', targetId: id, detail: { op: 'create', amountCents: input.amountCents }, ip: req.ip });
    return { docId: id };
  });
  app.get('/api/gf/payments/:id', { preHandler: staffOnly }, async (req) => {
    const doc = await loadDoc(sql, parse(idParam, req.params).id);
    if (doc.docType !== 'payment') throw notFound('不是付款申请');
    return paymentView(sql, doc);
  });
  app.post('/api/gf/payments/:id/pay', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(PayInput, req.body);
    if (!(await hasRole(req.actor, ['cashier']))) throw forbidden('付款由出纳操作');
    await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [done] = await tx<{ docId: number }[]>`SELECT doc_id FROM gf_payouts WHERE client_key = ${input.clientKey}`;
      if (done) return;
      const doc = await loadDoc(tx, id, true);
      if (doc.docType !== 'payment') throw notFound('不是付款申请');
      const flow = await latestFlow(tx, id);
      if (flow?.status !== 'approved') throw conflict('GF_NOT_APPROVED', '审批通过以后才能付款');
      if (doc.withdrawnAt) throw conflict('GF_WITHDRAWN', '已撤回');
      const p = doc.payload;
      if (p.needsReconfirm) throw conflict('GF_ACCOUNT_CHANGED', '收款账户变更过：要财务重新确认后才能付');
      // 出纳独立核验：重新输入的账号要与申请时一致，也要与供应商现在的账户一致
      if (input.accountConfirm !== p.payeeAccount) throw conflict('GF_ACCOUNT_MISMATCH', '输入的收款账号与申请的不一致，请核对');
      if (p.supplierId) {
        const [s] = await tx<{ bankAccount: string; pendingChangeDocId: number | null }[]>`SELECT bank_account, pending_change_doc_id FROM gf_suppliers WHERE id = ${Number(p.supplierId)}`;
        if (s?.pendingChangeDocId || s?.bankAccount !== p.payeeAccount) throw conflict('GF_ACCOUNT_CHANGED', '供应商收款账户有变更（或在审），已批的付款要重新确认');
      }
      const [paid] = await tx<{ s: number }[]>`SELECT coalesce(sum(amount_cents), 0)::bigint AS s FROM gf_payouts WHERE doc_id = ${id}`;
      const total = Number(paid!.s) + input.amountCents;
      if (total > (doc.amountCents ?? 0)) throw conflict('GF_OVERPAY', `累计付款 ${yuan(total)} 超过申请金额 ${yuan(doc.amountCents ?? 0)}`);
      if (p.specialId) {
        const [r] = await tx<{ amount: number; used: number }[]>`
          SELECT s.amount_cents AS amount, coalesce((SELECT sum(o.amount_cents) FROM gf_payouts o JOIN gf_docs d ON d.id = o.doc_id WHERE (d.payload->>'specialId')::bigint = s.id), 0)::bigint AS used
          FROM gf_specials s WHERE s.id = ${Number(p.specialId)} FOR UPDATE OF s`;
        if (Number(r!.used) + input.amountCents > Number(r!.amount)) throw conflict('GF_SPECIAL_EXCEEDED', '累计付款超过特批金额：超额要重新特批');
      }
      try {
        await tx`
          INSERT INTO gf_payouts (doc_id, amount_cents, payee_account, bank_ref, client_key, paid_by)
          VALUES (${id}, ${input.amountCents}, ${String(p.payeeAccount)}, ${input.bankRef}, ${input.clientKey}, ${req.actor.id})`;
      } catch (error) {
        if (isUniqueViolation(error, 'gf_payouts_bank_ref_key')) throw conflict('GF_DUPLICATE_PAYMENT', '这个银行流水号已经登记过，不能重复支付');
        throw error;
      }
      const full = total === (doc.amountCents ?? 0);
      await tx`
        UPDATE gf_docs SET exec_started_at = coalesce(exec_started_at, now()), exec_started_by = coalesce(exec_started_by, ${req.actor.id}),
          completed_at = ${full ? tx`now()` : null}, completed_by = ${full ? req.actor.id : null}, version = version + 1, updated_at = now()
        WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'gf_payment',
        targetType: 'gf_doc',
        targetId: id,
        detail: { op: 'pay', amountCents: input.amountCents, bankRef: input.bankRef },
        ip: req.ip,
      });
    });
    return paymentView(sql, await loadDoc(sql, id));
  });
  app.post('/api/gf/payments/:id/reconfirm', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    if (!(await hasRole(req.actor, ['finance_reviewer', 'finance_chief'])) && !can(req.actor, 'gf.roles')) throw forbidden('账户变更后的重新确认由财务做');
    await sql.begin(async (tx) => {
      const doc = await loadDoc(tx, id, true);
      if (!doc.payload.needsReconfirm) throw conflict('GF_STEP', '不需要重新确认');
      const [s] = await tx<{ bankAccount: string; pendingChangeDocId: number | null }[]>`SELECT bank_account, pending_change_doc_id FROM gf_suppliers WHERE id = ${Number(doc.payload.supplierId)}`;
      if (!s || s.pendingChangeDocId) throw conflict('GF_ACCOUNT_PENDING', '收款账户变更还在审');
      await tx`UPDATE gf_docs SET payload = payload || ${tx.json({ needsReconfirm: false, payeeAccount: s.bankAccount, reconfirmedBy: req.actor.id } as never)}, version = version + 1 WHERE id = ${id}`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'gf_payment', targetType: 'gf_doc', targetId: id, detail: { op: 'reconfirm' }, ip: req.ip });
    });
    return paymentView(sql, await loadDoc(sql, id));
  });
  app.post('/api/gf/payments/:id/invoice', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { invoiceNo } = parse(z.object({ invoiceNo: z.string().trim().min(4).max(40) }), req.body);
    await sql.begin(async (tx) => {
      const doc = await loadDoc(tx, id, true);
      if (doc.docType !== 'payment') throw notFound('不是付款申请');
      if (doc.createdBy !== req.actor.id && !(await hasRole(req.actor, ['finance_reviewer']))) throw forbidden('只有经办人或财务能补发票');
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`gf_payee:${String(doc.payload.payeeAccount)}`}, 0))`;
      const [dup] = await tx<{ bizNo: string }[]>`
        SELECT d.biz_no FROM gf_docs d WHERE ${ACTIVE(tx)} AND d.id <> ${id} AND d.payload->>'payeeAccount' = ${String(doc.payload.payeeAccount)} AND d.payload->>'invoiceNo' = ${invoiceNo} LIMIT 1`;
      if (dup) throw conflict('GF_DUPLICATE_PAYMENT', `这张发票已经用在 ${dup.bizNo} 上`);
      await tx`UPDATE gf_docs SET payload = payload || ${tx.json({ invoice: 'received', invoiceNo } as never)}, backfill_open = false, version = version + 1 WHERE id = ${id}`;
    });
    return paymentView(sql, await loadDoc(sql, id));
  });
}
