// 业财法 P06：报销、出差、商务招待、用印证照（docs/APPROVAL_V4.md 第 10 节）。
//   POST /api/gf/expenses                  报销（同一张发票、已用备用金的不得重复报销；出差报销关联原申请、5 个工作日内）
//   POST /api/gf/travel                    出差申请：部门月度差旅预算冻结；超预算转下月或财总＋CFO 特批
//   GET  /api/gf/travel-budgets            部门差旅额度（批复 / 已用 / 冻结 / 剩余），内控月度审核用
//   POST /api/gf/travel-budgets            设部门月度差旅批复额度（财总）
//   POST /api/gf/entertain                 商务招待；/:id/adjust 金额、人数减少不重审
//   POST /api/gf/seals                     用印证照（已批合同未改动不重审、非合同文件、空白文件、电子证照水印副本、纸质证照借还）
//   GET/POST /api/gf/licenses              证照台账（章证管理员）

import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { addWorkdays, type GfRole } from '@shared/govflow';
import {
  LICENSE_LOAN_MAX_DAYS,
  SEAL_ARCHIVE_WORKDAYS,
  SEAL_FINAL_WORKDAYS,
  SEAL_KINDS,
  TRAVEL_CLAIM_WORKDAYS,
  entertainKeepsApproval,
  entertainTemplate,
  expenseCc,
  expenseTemplate,
  routeTravel,
  sealTemplate,
  type LicenseView,
  type SealKind,
  type TravelBudgetView,
} from '@shared/govflow-expense';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../../db';
import { isUniqueViolation } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { conflict, forbidden, unprocessable } from '../../lib/errors';
import { hashRequest } from '../../lib/idempotency';
import { setTxTimeouts } from '../../lib/tx';
import { idParam, parse } from '../../lib/validate';
import { NOT_EMPLOYEE_ROLES } from '../oa/org';
import { insertDoc, latestFlow, loadDoc, registerHooks, rolesOf, submitFlow, type NewDoc } from './engine';
import { templateFor } from './types';

let TZ = 'Asia/Shanghai';
const uuid = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const monthOf = (day: string) => `${day.slice(0, 7)}-01`;
const nextMonth = (month: string) => {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
async function holidays(db: Db) {
  const rows = await db<{ day: string; kind: 'holiday' | 'workday' }[]>`SELECT day::text AS day, kind FROM oa_holidays WHERE day >= current_date - 60`;
  return new Map(rows.map((r) => [r.day, r.kind]));
}
/** 在途 + 通过的同类事项（没撤回、最近一轮没驳回） */
const ACTIVE = (db: Db, type: string) => db`d.doc_type = ${type} AND d.withdrawn_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM gf_flows f WHERE f.doc_id = d.id AND f.status = 'rejected' AND f.round = (SELECT max(round) FROM gf_flows g WHERE g.doc_id = d.id))`;

/** 新建事项并提交（操作编号幂等：同一编号重提返回原来那个） */
async function createAndSubmit(deps: Deps, actor: Actor, clientKey: string, payload: unknown, build: (tx: Tx, requestHash: string) => Promise<NewDoc>, after?: (tx: Tx, id: number) => Promise<void>) {
  const requestHash = hashRequest(payload);
  const existing = async (db: Db) => {
    const [r] = await db<{ id: number; createdBy: number; requestHash: string }[]>`SELECT id, created_by, request_hash FROM gf_docs WHERE client_key = ${clientKey}`;
    if (!r) return null;
    if (Number(r.createdBy) !== actor.id || r.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一个事项，请刷新页面后重新填写');
    return Number(r.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const found = await existing(tx);
      if (found) return found;
      const id = await insertDoc(tx, await build(tx, requestHash), actor, todayIn(TZ));
      await after?.(tx, id);
      const doc = await loadDoc(tx, id, true);
      await submitFlow(tx, doc, await templateFor(tx, doc), actor);
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

// ───────────────────────── 出差与差旅预算 ─────────────────────────

async function travelBudget(db: Db, deptId: number, month: string) {
  const [b] = await db<{ budgetCents: number }[]>`SELECT budget_cents FROM gf_travel_budgets WHERE department_id = ${deptId} AND month = ${month}::date`;
  const [l] = await db<{ used: number; frozen: number; deferred: number }[]>`
    SELECT coalesce(sum(CASE WHEN kind = 'use' THEN amount_cents END), 0)::bigint AS used,
           coalesce(sum(CASE WHEN kind = 'freeze' THEN amount_cents WHEN kind = 'unfreeze' THEN -amount_cents END), 0)::bigint AS frozen,
           coalesce(sum(CASE WHEN kind = 'freeze' AND op_key LIKE 'defer:%' THEN amount_cents END), 0)::bigint AS deferred
    FROM gf_travel_ledger WHERE department_id = ${deptId} AND month = ${month}::date`;
  const budgetCents = Number(b?.budgetCents ?? 0);
  const usedCents = Number(l!.used);
  const frozenCents = Number(l!.frozen);
  return { budgetCents, usedCents, frozenCents, remainingCents: budgetCents - usedCents - frozenCents, deferredInCents: Number(l!.deferred) };
}
const lockTravel = (tx: Tx, deptId: number) => tx`SELECT pg_advisory_xact_lock(hashtextextended(${`gf_travel:${deptId}`}, 0))`;
async function travelLedger(tx: Tx, e: { deptId: number; month: string; kind: 'freeze' | 'unfreeze' | 'use'; amount: number; docId: number; opKey: string; actorId: number }) {
  if (e.amount <= 0) return;
  await tx`
    INSERT INTO gf_travel_ledger (department_id, month, kind, amount_cents, doc_id, op_key, created_by)
    VALUES (${e.deptId}, ${e.month}, ${e.kind}, ${e.amount}, ${e.docId}, ${e.opKey}, ${e.actorId}) ON CONFLICT (op_key) DO NOTHING`;
}
async function travelFrozen(db: Db, docId: number) {
  const [r] = await db<{ frozen: number; month: string | null; dept: number | null }[]>`
    SELECT coalesce(sum(CASE WHEN kind = 'freeze' THEN amount_cents WHEN kind = 'unfreeze' THEN -amount_cents END), 0)::bigint AS frozen, min(month)::text AS month, min(department_id) AS dept
    FROM gf_travel_ledger WHERE doc_id = ${docId}`;
  return { frozen: Number(r!.frozen), month: r!.month, dept: r!.dept === null ? null : Number(r!.dept) };
}

const TravelInput = z.object({
  clientKey: uuid,
  departmentId: z.number().int().positive(),
  title: z.string().trim().min(2).max(100),
  destination: z.string().trim().min(1).max(60),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  amountCents: z.number().int().positive().max(10_000_000_000),
  priorApplied: z.boolean().default(true),
  overStandard: z.boolean().default(false),
  majorAbnormal: z.boolean().default(false),
  overBudgetMode: z.enum(['defer', 'special']).nullable().default(null),
});

registerHooks('travel', {
  template: (doc) =>
    routeTravel({
      amountCents: doc.amountCents ?? 0,
      remainingCents: doc.payload.overBudget ? -1 : Number.MAX_SAFE_INTEGER,
      priorApplied: doc.payload.priorApplied === true,
      overStandard: doc.payload.overStandard === true,
      majorAbnormal: doc.flags.includes('abnormal'),
      overBudgetMode: (doc.payload.overBudgetMode as 'defer' | 'special' | null) ?? null,
    }).nodes,
  ended: async (tx, doc, outcome, actor) => {
    if (outcome === 'returned') return;
    const f = await travelFrozen(tx, doc.id);
    if (f.frozen > 0) await travelLedger(tx, { deptId: f.dept!, month: f.month!, kind: 'unfreeze', amount: f.frozen, docId: doc.id, opKey: `travel-unfreeze:${doc.id}:${outcome}`, actorId: actor.id });
  },
});

// ───────────────────────── 报销 ─────────────────────────

const ExpenseInput = z.object({
  clientKey: uuid,
  departmentId: z.number().int().positive(),
  title: z.string().trim().min(2).max(100),
  amountCents: z.number().int().positive().max(10_000_000_000),
  invoiceNo: z.string().trim().max(40).default(''),
  travelDocId: z.number().int().positive().nullable().default(null),
  pettyDocId: z.number().int().positive().nullable().default(null),
  note: z.string().trim().max(500).default(''),
});

registerHooks('expense', {
  template: (doc) => {
    const nodes = expenseTemplate({ hasInvoice: !!doc.payload.invoiceNo });
    // 出差结束 5 个工作日以后才报的：财总复核（没票时已经有了）
    if (doc.payload.lateClaim && doc.payload.invoiceNo) nodes.splice(2, 0, { kind: 'role', role: 'finance_chief', stage: 'review' });
    return nodes;
  },
  ccRoles: (doc) => expenseCc(doc.amountCents ?? 0),
  approved: async (tx, doc, actor) => {
    // 出差报销：原申请的冻结转实际占用（台账记在原申请那个月）
    if (!doc.payload.travelDocId) return;
    const travelId = Number(doc.payload.travelDocId);
    const f = await travelFrozen(tx, travelId);
    if (f.dept === null) return;
    await lockTravel(tx, f.dept);
    await travelLedger(tx, { deptId: f.dept, month: f.month!, kind: 'unfreeze', amount: f.frozen, docId: travelId, opKey: `travel-claim-unfreeze:${travelId}`, actorId: actor.id });
    await travelLedger(tx, { deptId: f.dept, month: f.month!, kind: 'use', amount: doc.amountCents ?? 0, docId: travelId, opKey: `travel-claim-use:${travelId}`, actorId: actor.id });
    await tx`UPDATE gf_docs SET completed_at = coalesce(completed_at, now()), completed_by = coalesce(completed_by, ${actor.id}) WHERE id = ${travelId}`;
  },
});

// ───────────────────────── 招待 ─────────────────────────

const EntertainInput = z.object({
  clientKey: uuid,
  departmentId: z.number().int().positive(),
  title: z.string().trim().min(2).max(100),
  guests: z.string().trim().min(1).max(200),
  people: z.number().int().min(1).max(500),
  amountCents: z.number().int().positive().max(10_000_000_000),
  priorApplied: z.boolean().default(true),
});
registerHooks('entertain', {
  template: (doc) => entertainTemplate({ amountCents: doc.amountCents ?? 0, priorApplied: doc.payload.priorApplied === true }),
});

// ───────────────────────── 用印证照 ─────────────────────────

const SealInput = z.object({
  clientKey: uuid,
  kind: z.enum(SEAL_KINDS),
  departmentId: z.number().int().positive(),
  title: z.string().trim().min(2).max(100),
  contractDocId: z.number().int().positive().nullable().default(null),
  licenseId: z.number().int().positive().nullable().default(null),
  highRisk: z.boolean().default(false),
  copies: z.number().int().min(1).max(100).default(1),
  loanDays: z.number().int().min(1).max(LICENSE_LOAN_MAX_DAYS).default(3),
  purpose: z.string().trim().min(2).max(300),
});

registerHooks('seal_use', {
  template: (doc) => sealTemplate({ kind: doc.payload.kind as SealKind, contractUnchanged: doc.payload.contractUnchanged === true, highRisk: doc.payload.highRisk === true }),
  ccRoles: [],
  executor: 'seal_keeper',
  approved: async (tx, doc) => {
    // 电子证照：只发水印副本，自动归档
    if (doc.payload.kind === 'license_e') {
      await tx`
        UPDATE gf_docs SET payload = payload || ${tx.json({ watermarkIssuedAt: new Date().toISOString() } as never)},
          exec_started_at = now(), completed_at = now(), archived_at = now() WHERE id = ${doc.id}`;
    }
  },
  beforeExecute: async (tx, doc, step, actor) => {
    const kind = doc.payload.kind as SealKind;
    const hol = await holidays(tx);
    const today = todayIn(TZ);
    if (kind === 'license_paper') {
      const licenseId = Number(doc.payload.licenseId);
      if (step === 'start') {
        const due = addDays(today, Number(doc.payload.loanDays ?? 3));
        try {
          await tx`INSERT INTO gf_license_loans (license_id, doc_id, borrower_id, lent_by, due_on) VALUES (${licenseId}, ${doc.id}, ${doc.createdBy}, ${actor.id}, ${due})`;
        } catch (error) {
          if (isUniqueViolation(error, 'gf_license_loans_open_uq')) throw conflict('GF_LICENSE_OUT', '这份证照已经借出去了，还回来才能再借');
          throw error;
        }
        await tx`UPDATE gf_docs SET due_on = ${due} WHERE id = ${doc.id}`;
      } else if (step === 'complete') {
        await tx`UPDATE gf_license_loans SET returned_at = now(), returned_to = ${actor.id} WHERE doc_id = ${doc.id} AND returned_at IS NULL`;
      }
      return;
    }
    if (step === 'complete') {
      // 用印完成：空白文件 5 个工作日补最终版；其他 1 个工作日扫描归档
      const due = addWorkdays(today, kind === 'blank' ? SEAL_FINAL_WORKDAYS : SEAL_ARCHIVE_WORKDAYS, hol);
      await tx`UPDATE gf_docs SET due_on = ${due}, backfill_open = true, payload = payload || ${tx.json({ sealedAt: new Date().toISOString() } as never)} WHERE id = ${doc.id}`;
    } else if (step === 'archive') {
      await tx`UPDATE gf_docs SET backfill_open = false WHERE id = ${doc.id}`;
    }
  },
});

async function licenses(db: Db, timeZone: string): Promise<LicenseView[]> {
  const today = todayIn(timeZone);
  const rows = await db<{ id: number; name: string; kind: 'electronic' | 'paper'; entityName: string | null; loanId: number | null; borrowerName: string | null; dueOn: string | null }[]>`
    SELECT l.id, l.name, l.kind, e.name AS entity_name, o.id AS loan_id, s.display_name AS borrower_name, o.due_on::text AS due_on
    FROM gf_licenses l LEFT JOIN legal_entities e ON e.id = l.entity_id
    LEFT JOIN gf_license_loans o ON o.license_id = l.id AND o.returned_at IS NULL LEFT JOIN staff s ON s.id = o.borrower_id
    WHERE l.active ORDER BY l.id`;
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    kind: r.kind,
    entityName: r.entityName,
    onLoan: r.loanId ? { loanId: Number(r.loanId), borrowerName: r.borrowerName ?? '', dueOn: r.dueOn!, overdue: r.dueOn! < today } : null,
  }));
}

export function registerExpenseRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  TZ = deps.config.timezone;
  const signedIn = guard();
  const staffOnly: preHandlerAsyncHookHandler = async function (req, reply) {
    await signedIn.call(this, req, reply);
    if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(req.actor.role)) throw forbidden('这个账号不能用业财法审批');
  };
  const hasRole = async (actor: Actor, roles: readonly GfRole[]) => can(actor, 'gf.roles') || (await rolesOf(sql, actor.id)).some((r) => roles.includes(r));

  app.post('/api/gf/expenses', { preHandler: staffOnly }, async (req) => {
    const input = parse(ExpenseInput, req.body);
    const docId = await createAndSubmit(deps, req.actor, input.clientKey, { ...input, clientKey: undefined }, async (tx, requestHash) => {
      if (input.pettyDocId !== null) throw conflict('GF_DUPLICATE_CLAIM', '已用备用金的事项在零星采购里验收冲抵，不能再报销');
      if (input.invoiceNo) {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`gf_invoice:${input.invoiceNo}`}, 0))`;
        const [dup] = await tx<{ bizNo: string }[]>`
          SELECT d.biz_no FROM gf_docs d
          WHERE (${ACTIVE(tx, 'expense')} AND d.payload->>'invoiceNo' = ${input.invoiceNo})
             OR (d.doc_type = 'petty_purchase' AND d.payload->'acceptance'->>'invoiceNo' = ${input.invoiceNo})
          LIMIT 1`;
        if (dup) throw conflict('GF_DUPLICATE_CLAIM', `这张发票已经用在 ${dup.bizNo} 上（已报销或已用备用金冲抵），不能重复报销`);
      }
      let lateClaim = false;
      if (input.travelDocId !== null) {
        const t = await loadDoc(tx, input.travelDocId, true);
        if (t.docType !== 'travel' || t.createdBy !== req.actor.id) throw unprocessable('GF_TRAVEL', '只能报自己的出差申请');
        if ((await latestFlow(tx, t.id))?.status !== 'approved') throw conflict('GF_NOT_APPROVED', '出差申请审批通过以后才能报销');
        const [dup] = await tx<{ bizNo: string }[]>`SELECT d.biz_no FROM gf_docs d WHERE ${ACTIVE(tx, 'expense')} AND (d.payload->>'travelDocId')::bigint = ${t.id} LIMIT 1`;
        if (dup) throw conflict('GF_DUPLICATE_CLAIM', `这次出差已经在 ${dup.bizNo} 报销过`);
        const due = addWorkdays(String(t.payload.endDate), TRAVEL_CLAIM_WORKDAYS, await holidays(tx));
        lateClaim = todayIn(TZ) > due;
      }
      return {
        docType: 'expense',
        title: `报销：${input.title}`,
        note: input.note,
        departmentId: input.departmentId,
        amountCents: input.amountCents,
        subjectStaffId: req.actor.id,
        relatedDocId: input.travelDocId,
        payload: { invoiceNo: input.invoiceNo, travelDocId: input.travelDocId, lateClaim },
        flags: lateClaim ? ['abnormal'] : [],
        clientKey: input.clientKey,
        requestHash,
      };
    });
    await writeAudit(sql, { staffId: req.actor.id, action: 'gf_expense', targetType: 'gf_doc', targetId: docId, detail: { op: 'expense', amountCents: input.amountCents }, ip: req.ip });
    return { docId };
  });

  app.post('/api/gf/travel', { preHandler: staffOnly }, async (req) => {
    const input = parse(TravelInput, req.body);
    if (input.endDate < input.startDate) throw unprocessable('GF_DATE', '结束日期不能早于开始日期');
    const docId = await createAndSubmit(
      deps,
      req.actor,
      input.clientKey,
      { ...input, clientKey: undefined },
      async (tx, requestHash) => {
        await lockTravel(tx, input.departmentId);
        const month = monthOf(input.startDate);
        const b = await travelBudget(tx, input.departmentId, month);
        const r = routeTravel({ ...input, remainingCents: b.remainingCents });
        if (r.blockers.length) throw unprocessable('GF_TRAVEL_BUDGET', r.blockers.join('；'), { budget: b });
        const freezeMonth = r.overBudget && input.overBudgetMode === 'defer' ? nextMonth(month) : month;
        return {
          docType: 'travel',
          title: `出差：${input.title}（${input.destination}）`,
          departmentId: input.departmentId,
          amountCents: input.amountCents,
          subjectStaffId: req.actor.id,
          flags: input.majorAbnormal ? ['abnormal'] : r.overBudget ? ['over_budget'] : [],
          payload: { ...input, clientKey: undefined, overBudget: r.overBudget, freezeMonth, budgetAtApply: b },
          clientKey: input.clientKey,
          requestHash,
        };
      },
      async (tx, id) => {
        const doc = await loadDoc(tx, id);
        const fm = String(doc.payload.freezeMonth);
        await travelLedger(tx, {
          deptId: input.departmentId,
          month: fm,
          kind: 'freeze',
          amount: input.amountCents,
          docId: id,
          opKey: `${fm === monthOf(input.startDate) ? 'freeze' : 'defer'}:${id}`,
          actorId: req.actor.id,
        });
      },
    );
    return { docId };
  });

  app.get('/api/gf/travel-budgets', { preHandler: staffOnly }, async (req): Promise<TravelBudgetView[]> => {
    const { month } = parse(
      z.object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional(),
      }),
      req.query ?? {},
    );
    const m = month ? `${month}-01` : monthOf(todayIn(TZ));
    const oversight = await hasRole(req.actor, ['internal_control', 'finance_chief', 'cfo', 'finance_reviewer', 'chairman']);
    const [me] = await sql<{ departmentId: number | null }[]>`SELECT department_id FROM staff WHERE id = ${req.actor.id}`;
    const depts = await sql<{ id: number; name: string }[]>`
      SELECT id, name FROM departments WHERE active AND (${oversight} OR id = ${me?.departmentId ?? 0} OR head_id = ${req.actor.id}) ORDER BY sort_order, id`;
    return Promise.all(depts.map(async (d) => ({ departmentId: Number(d.id), departmentName: d.name, month: m.slice(0, 7), ...(await travelBudget(sql, Number(d.id), m)) })));
  });
  app.post('/api/gf/travel-budgets', { preHandler: staffOnly }, async (req) => {
    const input = parse(z.object({ departmentId: z.number().int().positive(), month: z.string().regex(/^\d{4}-\d{2}$/), budgetCents: z.number().int().min(0).max(10_000_000_000) }), req.body);
    if (!(await hasRole(req.actor, ['finance_chief']))) throw forbidden('部门差旅批复额度由财总设');
    await sql`
      INSERT INTO gf_travel_budgets (department_id, month, budget_cents, updated_by) VALUES (${input.departmentId}, ${`${input.month}-01`}, ${input.budgetCents}, ${req.actor.id})
      ON CONFLICT (department_id, month) DO UPDATE SET budget_cents = EXCLUDED.budget_cents, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await writeAudit(sql, { staffId: req.actor.id, action: 'gf_expense', targetType: 'department', targetId: input.departmentId, detail: { op: 'travel_budget', ...input }, ip: req.ip });
    return travelBudget(sql, input.departmentId, `${input.month}-01`);
  });

  app.post('/api/gf/entertain', { preHandler: staffOnly }, async (req) => {
    const input = parse(EntertainInput, req.body);
    const docId = await createAndSubmit(deps, req.actor, input.clientKey, { ...input, clientKey: undefined }, async (_tx, requestHash) => ({
      docType: 'entertain',
      title: `商务招待：${input.title}`,
      departmentId: input.departmentId,
      amountCents: input.amountCents,
      payload: { guests: input.guests, people: input.people, priorApplied: input.priorApplied },
      clientKey: input.clientKey,
      requestHash,
    }));
    return { docId };
  });
  app.post('/api/gf/entertain/:id/adjust', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ amountCents: z.number().int().positive(), people: z.number().int().min(1).max(500) }), req.body);
    await sql.begin(async (tx) => {
      const doc = await loadDoc(tx, id, true);
      if (doc.docType !== 'entertain' || doc.createdBy !== req.actor.id) throw forbidden('只能调整自己发起的招待');
      if ((await latestFlow(tx, id))?.status !== 'approved') throw conflict('GF_NOT_APPROVED', '审批通过以后才能调整；在审的退回修改');
      if (!entertainKeepsApproval(doc.amountCents ?? 0, input.amountCents, Number(doc.payload.people), input.people)) {
        throw conflict('GF_RESUBMIT', '金额或人数增加了：要重新发起招待申请审批');
      }
      await tx`UPDATE gf_docs SET amount_cents = ${input.amountCents}, payload = payload || ${tx.json({ people: input.people, adjusted: true } as never)}, version = version + 1 WHERE id = ${id}`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'gf_expense', targetType: 'gf_doc', targetId: id, detail: { op: 'entertain_adjust', ...input }, ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/api/gf/seals', { preHandler: staffOnly }, async (req) => {
    const input = parse(SealInput, req.body);
    const docId = await createAndSubmit(deps, req.actor, input.clientKey, { ...input, clientKey: undefined }, async (tx, requestHash) => {
      let contractUnchanged = false;
      if (input.kind === 'contract') {
        if (input.contractDocId === null) throw unprocessable('GF_CONTRACT', '请选要用印的合同');
        const c = await loadDoc(tx, input.contractDocId);
        if (c.docType !== 'contract' || (await latestFlow(tx, c.id))?.status !== 'approved' || c.payload.supersededBy) throw conflict('GF_CONTRACT', '合同不是审批通过的有效合同');
        const [v] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM gf_contract_versions WHERE doc_id = ${c.id} AND kind <> 'initial'`;
        contractUnchanged = v!.n === 0;
      }
      if (input.kind === 'license_e' || input.kind === 'license_paper') {
        if (input.licenseId === null) throw unprocessable('GF_LICENSE', '请选证照');
        const [l] = await tx<{ kind: string }[]>`SELECT kind FROM gf_licenses WHERE id = ${input.licenseId} AND active`;
        if (!l || (l.kind === 'electronic') !== (input.kind === 'license_e')) throw unprocessable('GF_LICENSE', '证照不存在或类型不对');
      }
      return {
        docType: 'seal_use',
        title: `用印证照：${input.title}`,
        departmentId: input.departmentId,
        relatedDocId: input.contractDocId,
        flags: input.highRisk ? ['major_risk'] : [],
        payload: { ...input, clientKey: undefined, contractUnchanged },
        clientKey: input.clientKey,
        requestHash,
      };
    });
    return { docId };
  });

  app.get('/api/gf/licenses', { preHandler: staffOnly }, async () => licenses(sql, TZ));
  app.post('/api/gf/licenses', { preHandler: staffOnly }, async (req) => {
    const input = parse(z.object({ name: z.string().trim().min(1).max(60), kind: z.enum(['electronic', 'paper']), entityId: z.number().int().positive().nullable().default(null) }), req.body);
    if (!(await hasRole(req.actor, ['seal_keeper']))) throw forbidden('证照台账由章证管理员维护');
    const [r] = await sql<{ id: number }[]>`INSERT INTO gf_licenses (name, kind, entity_id, created_by) VALUES (${input.name}, ${input.kind}, ${input.entityId}, ${req.actor.id}) RETURNING id`;
    return { id: Number(r!.id) };
  });
}
