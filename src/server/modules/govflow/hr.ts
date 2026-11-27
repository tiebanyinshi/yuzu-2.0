// 业财法 P07：人力资源付款批次与费用分摊引擎（docs/APPROVAL_V4.md 第 11 节）。
//   POST /api/gf/hr-batches                      HR 生成批次（凭证按类型必备、批次号唯一、异常批次关联原批次）
//   GET  /api/gf/hr-batches/:docId               批次要点（人员明细最小权限）
//   POST /api/gf/hr-batches/:docId/cashier-check 出纳复核总人数、总金额、收款账户（不一致退回 HR 与财务）
//   POST /api/gf/hr-batches/:docId/pay           出纳按批次付款（复核通过以后；流水号唯一）
//   GET/POST /api/gf/alloc-rules[/:id/version]   分摊规则与版本
//   GET/POST /api/gf/alloc-runs[/:id/reverse]    分摊执行与冲正（只追加，不能删）

import { createHash } from 'node:crypto';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import type { GfRole } from '@shared/govflow';
import {
  HR_BATCH_KINDS,
  HR_DETAIL_ROLES,
  HR_EVIDENCE_KINDS,
  HR_REDIRECTS,
  allocate,
  cashierMismatch,
  hrTemplate,
  isAbnormalBatch,
  missingEvidence,
  type AllocRuleView,
  type AllocRunView,
  type AllocSplit,
  type HrBatchKind,
  type HrBatchView,
  HR_EVIDENCE_LABELS,
} from '@shared/govflow-hr';
import { maskAccount } from '@shared/mask';
import { can } from '@shared/permissions';
import type { Db, Fragment } from '../../db';
import { isUniqueViolation } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { hashRequest } from '../../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../../lib/tx';
import { idParam, parse } from '../../lib/validate';
import { NOT_EMPLOYEE_ROLES } from '../oa/org';
import { notify } from '../oa/notifications';
import { insertDoc, latestFlow, loadDoc, loadMembers, registerHooks, rolesOf, submitFlow } from './engine';
import { templateFor } from './types';

let TZ = 'Asia/Shanghai';
const uuid = z.uuid('缺少有效的操作编号，请刷新页面后重试');

/** 收款账户摘要：人员 + 账号 + 金额，排好序取 SHA-256（出纳复核三者一致用） */
const digestOf = (lines: readonly { staffId: number; account: string; amountCents: number }[]) =>
  createHash('sha256')
    .update(
      [...lines]
        .sort((a, b) => a.staffId - b.staffId)
        .map((l) => `${l.staffId}:${l.account}:${l.amountCents}`)
        .join('|'),
    )
    .digest('hex');

registerHooks('hr_batch', {
  template: (doc) => hrTemplate(doc.payload.kind as HrBatchKind),
  // 薪资不做大范围知会
  ccRoles: [],
});

const BatchInput = z.object({
  clientKey: uuid,
  purpose: z.enum(['payroll', 'in_kind', 'reimbursement']).default('payroll'),
  kind: z.enum(HR_BATCH_KINDS),
  period: z.string().regex(/^\d{4}-\d{2}$/, '期间写成 2026-11'),
  departmentId: z.number().int().positive('请选主责部门'),
  originalBatchNo: z.string().trim().max(40).default(''),
  reason: z.string().trim().max(500).default(''),
  evidence: z.array(z.object({ kind: z.enum(HR_EVIDENCE_KINDS), ref: z.string().trim().min(1).max(120) })).max(20),
  lines: z
    .array(
      z.object({
        staffId: z.number().int().positive(),
        amountCents: z
          .number()
          .int()
          .refine((v) => v !== 0, '金额不能是 0')
          .refine((v) => Math.abs(v) <= 10_000_000_000, '金额太大'),
        account: z
          .string()
          .trim()
          .regex(/^\d{6,30}$/, '收款账号是 6–30 位数字'),
        costDeptId: z.number().int().positive(),
      }),
    )
    .min(1, '批次没有人员明细')
    .max(2000),
});

async function hasRole(db: Db, actor: Actor, roles: readonly GfRole[]) {
  return can(actor, 'gf.roles') || (await rolesOf(db, actor.id)).some((r) => roles.includes(r));
}

async function batchView(db: Db, actor: Actor, docId: number): Promise<HrBatchView> {
  const [b] = await db<{ id: number; batchNo: string; kind: HrBatchKind; period: string; headcount: number; totalCents: number; evidence: HrBatchView['evidence']; originalBatchNo: string | null }[]>`
    SELECT b.id, b.batch_no, b.kind, b.period, b.headcount, b.total_cents, b.evidence, o.batch_no AS original_batch_no
    FROM gf_hr_batches b LEFT JOIN gf_hr_batches o ON o.id = b.original_batch_id WHERE b.doc_id = ${docId}`;
  if (!b) throw notFound('没有这个 HR 批次');
  const detail = await hasRole(db, actor, HR_DETAIL_ROLES);
  const lines = detail
    ? (
        await db<{ staffName: string; amountCents: number; account: string; costDeptName: string }[]>`
          SELECT s.display_name AS staff_name, l.amount_cents, l.account, d.name AS cost_dept_name
          FROM gf_hr_batch_lines l JOIN staff s ON s.id = l.staff_id JOIN departments d ON d.id = l.cost_dept_id WHERE l.batch_id = ${b.id} ORDER BY l.id`
      ).map((l) => ({ staffName: l.staffName, amountCents: Number(l.amountCents), accountMasked: maskAccount(l.account), costDeptName: l.costDeptName }))
    : null;
  const [paid] = await db<{ bankRef: string; paidAt: Date }[]>`SELECT bank_ref, paid_at FROM gf_hr_payouts WHERE batch_id = ${b.id}`;
  const [check] = await db<{ ok: boolean; mismatches: string[] }[]>`SELECT ok, mismatches FROM gf_hr_checks WHERE batch_id = ${b.id} ORDER BY id DESC LIMIT 1`;
  return {
    docId,
    batchNo: b.batchNo,
    kind: b.kind,
    period: b.period,
    headcount: b.headcount,
    totalCents: Number(b.totalCents),
    originalBatchNo: b.originalBatchNo,
    evidence: b.evidence,
    lines,
    paid: paid ? { bankRef: detail ? paid.bankRef : maskAccount(paid.bankRef), paidAt: new Date(paid.paidAt).toISOString() } : null,
    mismatches: check && !check.ok ? check.mismatches : [],
  };
}

const SplitsInput = z
  .array(z.object({ departmentId: z.number().int().positive(), bp: z.number().int().min(1).max(10_000) }))
  .min(1)
  .max(30);

async function ruleViews(db: Db): Promise<AllocRuleView[]> {
  const rows = await db<{ id: number; name: string; version: number; splits: AllocSplit[] }[]>`
    SELECT r.id, r.name, r.version, v.splits FROM gf_alloc_rules r JOIN gf_alloc_rule_versions v ON v.rule_id = r.id AND v.version = r.version ORDER BY r.id`;
  const depts = new Map((await db<{ id: number; name: string }[]>`SELECT id, name FROM departments`).map((d) => [Number(d.id), d.name]));
  return rows.map((r) => ({ id: Number(r.id), name: r.name, version: r.version, splits: r.splits.map((s) => ({ ...s, departmentName: depts.get(s.departmentId) ?? '' })) }));
}

async function runViews(db: Db, where: Fragment): Promise<AllocRunView[]> {
  const rows = await db<
    {
      id: number;
      ruleId: number;
      ruleVersion: number;
      sourceDocId: number | null;
      kind: 'run' | 'reverse';
      amountCents: number;
      reversesRunId: number | null;
      lines: { departmentId: number; cents: number }[];
      createdAt: Date;
    }[]
  >`
    SELECT id, rule_id, rule_version, source_doc_id, kind, amount_cents, reverses_run_id, lines, created_at FROM gf_alloc_runs WHERE ${where} ORDER BY id`;
  const depts = new Map((await db<{ id: number; name: string }[]>`SELECT id, name FROM departments`).map((d) => [Number(d.id), d.name]));
  return rows.map((r) => ({
    id: Number(r.id),
    ruleId: Number(r.ruleId),
    ruleVersion: r.ruleVersion,
    sourceDocId: r.sourceDocId === null ? null : Number(r.sourceDocId),
    kind: r.kind,
    amountCents: Number(r.amountCents),
    reversesRunId: r.reversesRunId === null ? null : Number(r.reversesRunId),
    lines: r.lines.map((l) => ({ ...l, departmentName: depts.get(l.departmentId) ?? '' })),
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}

export function registerHrRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  TZ = deps.config.timezone;
  const signedIn = guard();
  const staffOnly: preHandlerAsyncHookHandler = async function (req, reply) {
    await signedIn.call(this, req, reply);
    if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(req.actor.role)) throw forbidden('这个账号不能用业财法审批');
  };
  const FINANCE: readonly GfRole[] = ['finance_reviewer', 'finance_chief', 'cfo'];

  app.post('/api/gf/hr-batches', { preHandler: staffOnly }, async (req) => {
    const input = parse(BatchInput, req.body);
    if (input.purpose === 'in_kind') throw unprocessable('GF_TO_PURCHASE', HR_REDIRECTS.in_kind);
    if (input.purpose === 'reimbursement') throw unprocessable('GF_TO_EXPENSE', HR_REDIRECTS.reimbursement);
    if (!(await rolesOf(sql, req.actor.id)).includes('hr')) throw forbidden('HR 付款批次由人力资源生成');
    const missing = missingEvidence(
      input.kind,
      input.evidence.map((e) => e.kind),
    );
    if (missing.length) throw unprocessable('GF_EVIDENCE_MISSING', `缺凭证：${missing.map((k) => HR_EVIDENCE_LABELS[k]).join('、')}（不能只上传总额表）`, { missing });
    if (new Set(input.lines.map((l) => l.staffId)).size !== input.lines.length) throw unprocessable('GF_HR_LINES', '同一个人在批次里只能有一行');
    const requestHash = hashRequest({ ...input, clientKey: undefined });
    try {
      const docId = await sql.begin(async (tx) => {
        await setTxTimeouts(tx);
        const [dup] = await tx<{ id: number; createdBy: number; requestHash: string }[]>`SELECT id, created_by, request_hash FROM gf_docs WHERE client_key = ${input.clientKey}`;
        if (dup) {
          if (Number(dup.createdBy) !== req.actor.id || dup.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一个批次');
          return Number(dup.id);
        }
        let originalId: number | null = null;
        if (isAbnormalBatch(input.kind)) {
          if (!input.originalBatchNo || input.reason.length < 4) throw unprocessable('GF_HR_ORIGINAL', '异常批次要关联原批次编号并写明异常说明');
          const [o] = await tx<{ id: number }[]>`SELECT id FROM gf_hr_batches WHERE batch_no = ${input.originalBatchNo}`;
          if (!o) throw unprocessable('GF_HR_ORIGINAL', '原批次编号不存在');
          originalId = Number(o.id);
        }
        const staff = await tx<{ id: number }[]>`SELECT id FROM staff WHERE id IN ${tx(input.lines.map((l) => l.staffId))}`;
        if (staff.length !== input.lines.length) throw unprocessable('GF_HR_LINES', '有人员不存在');
        const total = input.lines.reduce((a, l) => a + l.amountCents, 0);
        if (total <= 0) throw unprocessable('GF_HR_LINES', '批次合计要大于 0');
        const today = todayIn(TZ);
        const id = await insertDoc(
          tx,
          {
            docType: 'hr_batch',
            title: `HR 付款：${input.period} ${input.kind === 'salary' ? '工资' : input.kind === 'commission' ? '提成' : input.kind === 'cash_benefit' ? '现金福利' : '异常批次'}（${input.lines.length} 人）`,
            note: input.reason,
            departmentId: input.departmentId,
            amountCents: total,
            flags: isAbnormalBatch(input.kind) ? ['abnormal'] : [],
            payload: { kind: input.kind, period: input.period },
            clientKey: input.clientKey,
            requestHash,
          },
          req.actor,
          today,
        );
        const batchNo = await nextDocNo(tx, 'gf_hr_batch', 'HRP', today);
        const [b] = await tx<{ id: number }[]>`
          INSERT INTO gf_hr_batches (doc_id, batch_no, kind, period, department_id, original_batch_id, headcount, total_cents, accounts_digest, evidence)
          VALUES (${id}, ${batchNo}, ${input.kind}, ${input.period}, ${input.departmentId}, ${originalId}, ${input.lines.length}, ${total}, ${digestOf(input.lines)}, ${tx.json(input.evidence as never)})
          RETURNING id`;
        for (const l of input.lines) {
          await tx`INSERT INTO gf_hr_batch_lines (batch_id, staff_id, amount_cents, account, cost_dept_id) VALUES (${b!.id}, ${l.staffId}, ${l.amountCents}, ${l.account}, ${l.costDeptId})`;
        }
        await tx`UPDATE gf_docs SET payload = payload || ${tx.json({ batchNo } as never)} WHERE id = ${id}`;
        const doc = await loadDoc(tx, id, true);
        await submitFlow(tx, doc, await templateFor(tx, doc), req.actor);
        return id;
      });
      await writeAudit(sql, {
        staffId: req.actor.id,
        action: 'gf_hr',
        targetType: 'gf_doc',
        targetId: docId,
        detail: { op: 'batch', kind: input.kind, period: input.period, headcount: input.lines.length },
        ip: req.ip,
      });
      return { docId };
    } catch (error) {
      if (isUniqueViolation(error, 'gf_hr_batches_regular_uq')) throw conflict('GF_BATCH_DUP', '这个部门这个期间已经有同类批次了：补发、调整走异常批次');
      throw error;
    }
  });

  app.get('/api/gf/hr-batches/:id', { preHandler: staffOnly }, async (req) => batchView(sql, req.actor, parse(idParam, req.params).id));

  app.post('/api/gf/hr-batches/:id/cashier-check', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(
      z.object({
        headcount: z.number().int().min(0),
        totalCents: z.number().int(),
        accounts: z.array(z.object({ staffId: z.number().int().positive(), account: z.string().trim(), amountCents: z.number().int() })).max(2000),
      }),
      req.body,
    );
    if (!(await rolesOf(sql, req.actor.id)).includes('cashier')) throw forbidden('付款前复核由出纳做');
    const result = await sql.begin(async (tx) => {
      const doc = await loadDoc(tx, id, true);
      if ((await latestFlow(tx, id))?.status !== 'approved') throw conflict('GF_NOT_APPROVED', '财总＋CFO 共同审批通过以后才能付款');
      const [b] = await tx<{ id: number; headcount: number; totalCents: number; accountsDigest: string }[]>`
        SELECT id, headcount, total_cents, accounts_digest FROM gf_hr_batches WHERE doc_id = ${id} FOR UPDATE`;
      const mismatches = cashierMismatch(
        { headcount: b!.headcount, totalCents: Number(b!.totalCents), accountsDigest: b!.accountsDigest },
        { headcount: input.headcount, totalCents: input.totalCents, accountsDigest: digestOf(input.accounts) },
      );
      await tx`INSERT INTO gf_hr_checks (batch_id, ok, mismatches, checked_by) VALUES (${b!.id}, ${mismatches.length === 0}, ${mismatches}, ${req.actor.id})`;
      if (mismatches.length) {
        const members = await loadMembers(tx, doc.entityId);
        await notify(tx, [doc.createdBy, ...(members.finance_reviewer ?? [])], {
          kind: 'approval_result',
          title: `HR 批次出纳复核不一致：${String(doc.payload.batchNo)}`,
          body: `${mismatches.join('；')}，请 HR 与财务核对`,
          link: `/oa/gov/${id}`,
          ref: { type: 'gf_doc', id },
        });
      }
      return mismatches;
    });
    if (result.length) throw conflict('GF_BATCH_MISMATCH', `${result.join('；')}：已退回 HR 与财务核对，不能付款`, { mismatches: result });
    return batchView(sql, req.actor, id);
  });

  app.post('/api/gf/hr-batches/:id/pay', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { bankRef } = parse(z.object({ bankRef: z.string().trim().min(4).max(60) }), req.body);
    if (!(await rolesOf(sql, req.actor.id)).includes('cashier')) throw forbidden('付款由出纳操作');
    await sql.begin(async (tx) => {
      await loadDoc(tx, id, true);
      if ((await latestFlow(tx, id))?.status !== 'approved') throw conflict('GF_NOT_APPROVED', '审批通过以后才能付款');
      const [b] = await tx<{ id: number }[]>`SELECT id FROM gf_hr_batches WHERE doc_id = ${id}`;
      const [check] = await tx<{ ok: boolean }[]>`SELECT ok FROM gf_hr_checks WHERE batch_id = ${b!.id} ORDER BY id DESC LIMIT 1`;
      if (!check?.ok) throw conflict('GF_BATCH_UNCHECKED', '出纳复核总人数、总金额、收款账户一致以后才能付款');
      try {
        await tx`INSERT INTO gf_hr_payouts (batch_id, bank_ref, paid_by) VALUES (${b!.id}, ${bankRef}, ${req.actor.id})`;
      } catch (error) {
        if (isUniqueViolation(error, 'gf_hr_payouts_batch_id_key')) throw conflict('GF_DUPLICATE_PAYMENT', '这个批次已经付过了');
        if (isUniqueViolation(error, 'gf_hr_payouts_bank_ref_key')) throw conflict('GF_DUPLICATE_PAYMENT', '这个银行流水号已经登记过');
        throw error;
      }
      await tx`UPDATE gf_docs SET exec_started_at = now(), exec_started_by = ${req.actor.id}, completed_at = now(), completed_by = ${req.actor.id}, version = version + 1 WHERE id = ${id}`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'gf_hr', targetType: 'gf_doc', targetId: id, detail: { op: 'pay' }, ip: req.ip });
    });
    return batchView(sql, req.actor, id);
  });

  // ───────────── 分摊 ─────────────

  const finance = async (actor: Actor) => {
    if (!(await hasRole(sql, actor, FINANCE))) throw forbidden('费用分摊由财务操作（结果保密，只给财务看）');
  };
  app.get('/api/gf/alloc-rules', { preHandler: staffOnly }, async (req) => {
    await finance(req.actor);
    return ruleViews(sql);
  });
  app.post('/api/gf/alloc-rules', { preHandler: staffOnly }, async (req) => {
    await finance(req.actor);
    const input = parse(z.object({ name: z.string().trim().min(1).max(60), splits: SplitsInput }), req.body);
    allocCheck(input.splits);
    await sql.begin(async (tx) => {
      const [r] = await tx<{ id: number }[]>`INSERT INTO gf_alloc_rules (name, created_by) VALUES (${input.name}, ${req.actor.id}) RETURNING id`;
      await tx`INSERT INTO gf_alloc_rule_versions (rule_id, version, splits, created_by) VALUES (${r!.id}, 1, ${tx.json(input.splits as never)}, ${req.actor.id})`;
    });
    return ruleViews(sql);
  });
  app.post('/api/gf/alloc-rules/:id/version', { preHandler: staffOnly }, async (req) => {
    await finance(req.actor);
    const { id } = parse(idParam, req.params);
    const { splits } = parse(z.object({ splits: SplitsInput }), req.body);
    allocCheck(splits);
    await sql.begin(async (tx) => {
      const [r] = await tx<{ version: number }[]>`UPDATE gf_alloc_rules SET version = version + 1 WHERE id = ${id} RETURNING version`;
      if (!r) throw notFound('没有这条分摊规则');
      await tx`INSERT INTO gf_alloc_rule_versions (rule_id, version, splits, created_by) VALUES (${id}, ${r.version}, ${tx.json(splits as never)}, ${req.actor.id})`;
    });
    return ruleViews(sql);
  });
  app.get('/api/gf/alloc-runs', { preHandler: staffOnly }, async (req) => {
    await finance(req.actor);
    const { sourceDocId } = parse(z.object({ sourceDocId: z.coerce.number().int().positive().optional() }), req.query ?? {});
    return runViews(sql, sourceDocId ? sql`source_doc_id = ${sourceDocId}` : sql`true`);
  });
  app.post('/api/gf/alloc-runs', { preHandler: staffOnly }, async (req) => {
    await finance(req.actor);
    const input = parse(
      z.object({ clientKey: uuid, ruleId: z.number().int().positive(), sourceDocId: z.number().int().positive().nullable().default(null), amountCents: z.number().int().positive() }),
      req.body,
    );
    const runId = await sql.begin(async (tx) => {
      const [done] = await tx<{ id: number }[]>`SELECT id FROM gf_alloc_runs WHERE client_key = ${input.clientKey}`;
      if (done) return Number(done.id);
      const [r] = await tx<{ version: number; splits: AllocSplit[] }[]>`
        SELECT r.version, v.splits FROM gf_alloc_rules r JOIN gf_alloc_rule_versions v ON v.rule_id = r.id AND v.version = r.version WHERE r.id = ${input.ruleId}`;
      if (!r) throw notFound('没有这条分摊规则');
      const lines = allocate(input.amountCents, r.splits);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO gf_alloc_runs (rule_id, rule_version, source_doc_id, kind, amount_cents, lines, client_key, created_by)
        VALUES (${input.ruleId}, ${r.version}, ${input.sourceDocId}, 'run', ${input.amountCents}, ${tx.json(lines as never)}, ${input.clientKey}, ${req.actor.id}) RETURNING id`;
      return Number(row!.id);
    });
    return (await runViews(sql, sql`id = ${runId}`))[0]!;
  });
  // 冲正：追加一条负数的分摊（同一次分摊只能冲一次），原分摊不删
  app.post('/api/gf/alloc-runs/:id/reverse', { preHandler: staffOnly }, async (req) => {
    await finance(req.actor);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ clientKey: uuid, reason: z.string().trim().min(2).max(200) }), req.body);
    const runId = await sql.begin(async (tx) => {
      const [done] = await tx<{ id: number }[]>`SELECT id FROM gf_alloc_runs WHERE client_key = ${input.clientKey}`;
      if (done) return Number(done.id);
      const [o] = await tx<{ ruleId: number; ruleVersion: number; sourceDocId: number | null; kind: string; amountCents: number; lines: { departmentId: number; cents: number }[] }[]>`
        SELECT rule_id, rule_version, source_doc_id, kind, amount_cents, lines FROM gf_alloc_runs WHERE id = ${id} FOR UPDATE`;
      if (!o) throw notFound('没有这次分摊');
      if (o.kind !== 'run') throw conflict('GF_ALLOC', '冲正记录不能再冲正');
      try {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO gf_alloc_runs (rule_id, rule_version, source_doc_id, kind, amount_cents, lines, reverses_run_id, reason, client_key, created_by)
          VALUES (${o.ruleId}, ${o.ruleVersion}, ${o.sourceDocId}, 'reverse', ${-Number(o.amountCents)}, ${tx.json(o.lines.map((l) => ({ ...l, cents: -l.cents })) as never)}, ${id}, ${input.reason}, ${input.clientKey}, ${req.actor.id})
          RETURNING id`;
        return Number(row!.id);
      } catch (error) {
        if (isUniqueViolation(error, 'gf_alloc_runs_reverses_run_id_key')) throw conflict('GF_ALLOC', '这次分摊已经冲正过了');
        throw error;
      }
    });
    return (await runViews(sql, sql`id = ${runId}`))[0]!;
  });
}

function allocCheck(splits: readonly AllocSplit[]) {
  if (splits.reduce((a, s) => a + s.bp, 0) !== 10_000) throw unprocessable('GF_ALLOC', '分摊比例合计要等于 100%');
  if (new Set(splits.map((s) => s.departmentId)).size !== splits.length) throw unprocessable('GF_ALLOC', '同一个部门只能出现一次');
}
