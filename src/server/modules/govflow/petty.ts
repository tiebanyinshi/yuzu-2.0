// 业财法 P03：零星采购与备用金额度（docs/APPROVAL_V4.md 第 7 节）。
//   POST /api/gf/petty/preview            页面预检（不占额度）
//   POST /api/gf/petty                    发起零星采购：在事务里锁部门额度重算、冻结、按需加财总＋CFO 合并特批
//   POST /api/gf/petty/:id/accept         验收（部门里另一名员工）：冻结转实际占用、差额释放、发票冲抵（没票的后补）
//   POST /api/gf/petty/:id/invoice        后补发票
//   POST /api/gf/petty/:id/reverse        冲正（财总；追加负数，不删历史）
//   POST /api/gf/petty/overdue-reviews    保管人逾期后财总复核恢复
//   GET  /api/gf/petty/board              内控公示：各部门已用、冻结、剩余、逾期、疑似拆单
//   GET  /api/gf/petty/quota/:deptId      某个部门的额度（部门负责人看本部门）
//   POST /api/gf/quota-adjust             月度额度核定（内控提、财总＋CFO 共同审批、次月生效）
//   POST /api/gf/settings/purchase-dept   设置哪个部门是采购部门（店主）

import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { COSIGN_FINANCE_CFO, type GfRole } from '@shared/govflow';
import {
  DEPT_DAILY_CENTS,
  DEPT_MONTHLY_CENTS,
  PETTY_ACCEPT_DAYS,
  PETTY_KINDS,
  PETTY_KIND_LABELS,
  pettyAllowed,
  pettyTemplate,
  pettyTier,
  purchaseDeptCheck,
  quotaCheck,
  type PettyPreview,
  type PettyQuotaView,
} from '@shared/govflow-petty';
import { formatAmount } from '@shared/money';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../../db';
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
import { addCc, deptHeadOf, insertDoc, latestFlow, loadDoc, registerHooks, rolesOf, submitFlow, type DocRow } from './engine';
import { templateFor } from './types';

/** 应用配置的时区（注册路由时设；钩子里算日期用） */
let TZ = 'Asia/Shanghai';
const uuid = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const yuan = (cents: number) => `¥${formatAmount(cents)}`;

/** 部门额度：最近一次核定（生效月 ≤ 本月）的；没有就按默认日 1 万、月 5 万 */
async function limitsOf(db: Db, deptId: number, day: string) {
  const [q] = await db<{ dailyCents: number; monthlyCents: number }[]>`
    SELECT daily_cents, monthly_cents FROM gf_dept_quotas WHERE department_id = ${deptId} AND effective_month <= ${monthStart(day)}::date
    ORDER BY effective_month DESC LIMIT 1`;
  return { dailyLimit: q ? Number(q.dailyCents) : DEPT_DAILY_CENTS, monthlyLimit: q ? Number(q.monthlyCents) : DEPT_MONTHLY_CENTS };
}

/** 台账汇总：已实际占用（use − reverse）与冻结中（freeze − unfreeze），按天、按月 */
async function takenOf(db: Db, deptId: number, day: string) {
  const [r] = await db<{ dayUsed: number; dayFrozen: number; monthUsed: number; monthFrozen: number }[]>`
    SELECT
      coalesce(sum(CASE WHEN biz_date = ${day}::date AND kind = 'use' THEN amount_cents WHEN biz_date = ${day}::date AND kind = 'reverse' THEN -amount_cents END), 0)::bigint AS day_used,
      coalesce(sum(CASE WHEN biz_date = ${day}::date AND kind = 'freeze' THEN amount_cents WHEN biz_date = ${day}::date AND kind = 'unfreeze' THEN -amount_cents END), 0)::bigint AS day_frozen,
      coalesce(sum(CASE WHEN kind = 'use' THEN amount_cents WHEN kind = 'reverse' THEN -amount_cents END), 0)::bigint AS month_used,
      coalesce(sum(CASE WHEN kind = 'freeze' THEN amount_cents WHEN kind = 'unfreeze' THEN -amount_cents END), 0)::bigint AS month_frozen
    FROM gf_quota_ledger WHERE department_id = ${deptId} AND biz_date >= ${monthStart(day)}::date AND biz_date < (${monthStart(day)}::date + interval '1 month')`;
  return { dayUsed: Number(r!.dayUsed), dayFrozen: Number(r!.dayFrozen), monthUsed: Number(r!.monthUsed), monthFrozen: Number(r!.monthFrozen) };
}

/** 这个事项在台账上还冻结着多少、实际占用多少 */
async function docLedger(db: Db, docId: number) {
  const [r] = await db<{ frozen: number; used: number; day: string | null; dept: number | null }[]>`
    SELECT coalesce(sum(CASE WHEN kind = 'freeze' THEN amount_cents WHEN kind = 'unfreeze' THEN -amount_cents END), 0)::bigint AS frozen,
           coalesce(sum(CASE WHEN kind = 'use' THEN amount_cents WHEN kind = 'reverse' THEN -amount_cents END), 0)::bigint AS used,
           min(biz_date)::text AS day, min(department_id) AS dept
    FROM gf_quota_ledger WHERE doc_id = ${docId}`;
  return { frozen: Number(r!.frozen), used: Number(r!.used), day: r!.day, dept: r!.dept === null ? null : Number(r!.dept) };
}

async function ledger(tx: Tx, e: { deptId: number; day: string; kind: 'freeze' | 'unfreeze' | 'use' | 'reverse'; amount: number; docId: number; opKey: string; note?: string; actorId: number }) {
  if (e.amount <= 0) return;
  await tx`
    INSERT INTO gf_quota_ledger (department_id, biz_date, kind, amount_cents, doc_id, note, op_key, created_by)
    VALUES (${e.deptId}, ${e.day}, ${e.kind}, ${e.amount}, ${e.docId}, ${e.note ?? ''}, ${e.opKey}, ${e.actorId})
    ON CONFLICT (op_key) DO NOTHING`;
}

/** 额度在事务里串行：锁部门（几个部门按编号顺序锁，不死锁） */
async function lockDepts(tx: Tx, ids: number[]) {
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`gf_quota:${id}`}, 0))`;
}

async function purchaseDeptId(db: Db): Promise<number | null> {
  const [r] = await db<{ value: number }[]>`SELECT value FROM gf_settings WHERE key = 'purchase_dept_id'`;
  return r ? Number(r.value) : null;
}

/** 保管人（经办人）有没有逾期没处理、也没经财总复核恢复的零星采购 */
async function overdueBlock(db: Db, staffId: number, today: string): Promise<string | null> {
  const [r] = await db<{ n: number; first: string | null }[]>`
    SELECT count(*)::int AS n, min(d.biz_no) AS first FROM gf_docs d
    WHERE d.doc_type = 'petty_purchase' AND d.created_by = ${staffId} AND d.withdrawn_at IS NULL AND d.completed_at IS NULL
      AND d.due_on < ${today}::date
      AND d.due_on >= coalesce((SELECT max(created_at)::date FROM gf_overdue_reviews WHERE staff_id = ${staffId}), '-infinity'::date)
      AND EXISTS (SELECT 1 FROM gf_flows f WHERE f.doc_id = d.id AND f.status = 'approved')`;
  return r && r.n > 0 ? `你有 ${r.n} 笔零星采购逾期没验收（${r.first} 等），先处理并请财总复核后才能新增` : null;
}

const normSupplier = (s: string) => s.replace(/\s+/g, '').toLowerCase();

const PettyFields = z.object({
  departmentId: z.number().int().positive('请选费用承担部门'),
  supplierName: z.string().trim().min(2, '请写供应商').max(80),
  items: z.string().trim().min(1, '请写买什么').max(300),
  qty: z.number().int().min(1, '件数至少 1').max(100_000),
  amountCents: z.number().int().positive('金额要大于 0').max(100_000_000),
  kind: z.enum(PETTY_KINDS).default('goods'),
  urgent: z.boolean().default(false),
  quoteNote: z.string().trim().max(500).default(''),
});
const PettyInput = PettyFields.extend({ clientKey: uuid });

interface Assessment {
  preview: PettyPreview;
  deptIdOfBuyer: number | null;
  purchaseDept: number | null;
  needSpecial: boolean;
}

/** 预检与正式提交共用的判定（正式提交时在锁里再算一遍，页面预检不算占用） */
async function assess(db: Db, actor: Actor, input: z.infer<typeof PettyFields>, today: string): Promise<Assessment> {
  const [buyer] = await db<{ departmentId: number | null }[]>`SELECT department_id FROM staff WHERE id = ${actor.id}`;
  const buyerDept = buyer?.departmentId === null || buyer?.departmentId === undefined ? null : Number(buyer.departmentId);
  const same = await db<{ amount: number; qty: number }[]>`
    SELECT d.amount_cents AS amount, (d.payload->>'qty')::int AS qty FROM gf_docs d
    WHERE d.doc_type = 'petty_purchase' AND d.payload->>'supplierKey' = ${normSupplier(input.supplierName)} AND d.payload->>'day' = ${today}
      AND d.withdrawn_at IS NULL AND NOT EXISTS (SELECT 1 FROM gf_flows f WHERE f.doc_id = d.id AND f.status = 'rejected' AND f.round = (SELECT max(round) FROM gf_flows g WHERE g.doc_id = d.id))`;
  const combinedCents = same.reduce((a, r) => a + Number(r.amount), 0) + input.amountCents;
  const combinedQty = same.reduce((a, r) => a + Number(r.qty), 0) + input.qty;
  const tier = pettyTier(combinedCents, combinedQty);
  const splitSuspect = same.length > 0 && pettyTier(input.amountCents, input.qty) === 'basic' && tier === 'enhanced';
  const limits = await limitsOf(db, input.departmentId, today);
  const t = await takenOf(db, input.departmentId, today);
  const dayTaken = t.dayUsed + t.dayFrozen;
  const monthTaken = t.monthUsed + t.monthFrozen;
  const q = quotaCheck({ ...limits, dayTaken, monthTaken, amount: input.amountCents });
  const pdId = await purchaseDeptId(db);
  let pd: 'ok' | 'formal' | 'special' | null = null;
  if (pdId !== null && buyerDept === pdId) {
    const [cum] = await db<{ s: number }[]>`
      SELECT coalesce(sum(d.amount_cents), 0)::bigint AS s FROM gf_docs d JOIN staff s ON s.id = d.created_by
      WHERE d.doc_type = 'petty_purchase' AND s.department_id = ${pdId} AND d.payload->>'day' = ${today} AND d.withdrawn_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM gf_flows f WHERE f.doc_id = d.id AND f.status = 'rejected')`;
    pd = purchaseDeptCheck(Number(cum!.s), input.amountCents, input.urgent);
  }
  let blockedReason: string | null = null;
  if (!pettyAllowed(input.kind)) blockedReason = `「${PETTY_KIND_LABELS[input.kind]}」不走零星采购快速通道，请走正式采购 / 合同`;
  else if (pd === 'formal') blockedReason = '采购部门今天零星采购累计超过 1 万：非紧急的转正式采购 / 合同（不能用备用金特批绕开）';
  else if (tier === 'enhanced' && input.quoteNote.length < 4) blockedReason = '超出基础审核（3,000 元或 50 件，同日同供应商合并算）：请写比价说明';
  else blockedReason = await overdueBlock(db, actor.id, today);
  return {
    preview: { tier, combinedCents, combinedQty, splitSuspect, quota: { ...q, ...limits, dayTaken, monthTaken }, purchaseDept: pd, blockedReason },
    deptIdOfBuyer: buyerDept,
    purchaseDept: pdId,
    needSpecial: q.needSpecial || pd === 'special',
  };
}

async function createPetty(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<number> {
  const input = parse(PettyInput, raw);
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const existing = async (db: Db) => {
    const [r] = await db<{ id: number; createdBy: number; requestHash: string }[]>`SELECT id, created_by, request_hash FROM gf_docs WHERE client_key = ${input.clientKey}`;
    if (!r) return null;
    if (Number(r.createdBy) !== actor.id || r.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔，请刷新页面后重新填写');
    return Number(r.id);
  };
  const today = todayIn(deps.config.timezone);
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const found = await existing(tx);
      if (found) return found;
      const [dept] = await tx`SELECT 1 FROM departments WHERE id = ${input.departmentId} AND active`;
      if (!dept) throw unprocessable('GF_DEPT', '费用承担部门不存在或已停用');
      const pd = await purchaseDeptId(tx);
      // 锁住费用承担部门与采购部门，在锁里重算（页面预检不算最终占用）
      await lockDepts(tx, [input.departmentId, ...(pd !== null ? [pd] : [])]);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`gf_petty_supplier:${today}:${normSupplier(input.supplierName)}`}, 0))`;
      const a = await assess(tx, actor, input, today);
      if (a.preview.blockedReason) {
        const code = !pettyAllowed(input.kind) || a.preview.purchaseDept === 'formal' ? 'GF_TO_FORMAL' : a.preview.blockedReason.includes('逾期') ? 'GF_OVERDUE_BLOCK' : 'GF_QUOTE_REQUIRED';
        throw unprocessable(code, a.preview.blockedReason, { preview: a.preview });
      }
      const headId = await deptHeadOf(tx, input.departmentId);
      const selfPurchase = headId === actor.id;
      const flags: string[] = [];
      if (a.preview.splitSuspect) flags.push('abnormal');
      if (input.urgent) flags.push('urgent');
      const id = await insertDoc(
        tx,
        {
          docType: 'petty_purchase',
          title: `${selfPurchase ? '负责人自购' : '零星采购'}：${input.items.slice(0, 40)}`,
          departmentId: input.departmentId,
          amountCents: input.amountCents,
          flags,
          payload: {
            supplierName: input.supplierName,
            supplierKey: normSupplier(input.supplierName),
            day: today,
            qty: input.qty,
            items: input.items,
            kind: input.kind,
            quoteNote: input.quoteNote,
            tier: a.preview.tier,
            combinedCents: a.preview.combinedCents,
            combinedQty: a.preview.combinedQty,
            splitSuspect: a.preview.splitSuspect,
            selfPurchase,
            needSpecial: a.needSpecial,
            overDaily: a.preview.quota.overDaily,
            overMonthly: a.preview.quota.overMonthly,
            purchaseDept: a.preview.purchaseDept,
          },
          clientKey: input.clientKey,
          requestHash,
        },
        actor,
        today,
      );
      await ledger(tx, { deptId: input.departmentId, day: today, kind: 'freeze', amount: input.amountCents, docId: id, opKey: `freeze:${id}`, note: '申请冻结', actorId: actor.id });
      if (a.needSpecial) {
        const specialNo = await nextDocNo(tx, 'gf_quota_special', 'TE', today);
        await tx`
          INSERT INTO gf_quota_specials (special_no, doc_id, over_daily, over_monthly, purchase_dept, over_cents)
          VALUES (${specialNo}, ${id}, ${a.preview.quota.overDaily}, ${a.preview.quota.overMonthly}, ${a.preview.purchaseDept === 'special'}, ${a.preview.quota.overCents})`;
      }
      const doc = await loadDoc(tx, id, true);
      await submitFlow(tx, doc, templateFor(doc), actor);
      // 负责人自购：采购部门只收系统记录（知会供应链负责人，进日报）
      if (selfPurchase) await addCc(tx, doc, { reason: '负责人自购记录（不需采购部门审批）', special: false, actorId: actor.id, roles: ['supply_chain_head'] });
      if (a.preview.quota.warn && headId) {
        await notify(tx, [headId], {
          kind: 'system',
          title: `备用金额度预警 ${a.preview.quota.warn}%`,
          body: `部门今天 / 本月已占用（含这一笔）达到额度的 ${a.preview.quota.warn}% 以上`,
          link: `/oa/gov/${id}`,
          ref: { type: 'gf_quota_warn', id: input.departmentId },
        });
      }
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'gf_petty',
        targetType: 'gf_doc',
        targetId: id,
        detail: { op: 'create', amountCents: input.amountCents, tier: a.preview.tier, special: a.needSpecial },
        ip,
      });
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

/** 释放冻结（驳回、撤回）：把还冻结着的全部解冻 */
async function releaseFrozen(tx: Tx, doc: DocRow, actorId: number, why: string) {
  const l = await docLedger(tx, doc.id);
  if (l.frozen > 0 && l.dept !== null && l.day) {
    await ledger(tx, { deptId: l.dept, day: l.day, kind: 'unfreeze', amount: l.frozen, docId: doc.id, opKey: `unfreeze:${doc.id}:${why}`, note: why, actorId });
  }
}

registerHooks('petty_purchase', {
  template: (doc) => pettyTemplate({ needSpecial: doc.payload.needSpecial === true }),
  ccRoles: (doc) => (doc.payload.needSpecial ? ['chairman', 'business_gm', 'finance_chief', 'cfo'] : []),
  approved: async (tx, doc) => {
    await tx`UPDATE gf_docs SET due_on = ${addDays(todayIn(TZ), PETTY_ACCEPT_DAYS)} WHERE id = ${doc.id}`;
  },
  ended: async (tx, doc, outcome, actor) => {
    // 退回的还要改了再交，额度继续冻结；驳回、撤回的解冻
    if (outcome !== 'returned') await releaseFrozen(tx, doc, actor.id, outcome);
  },
});

const AcceptInput = z.object({
  clientKey: uuid,
  actualCents: z.number().int().positive('实际金额要大于 0'),
  invoiceNo: z.string().trim().max(40).default(''),
  stockIn: z.literal(true, '验收要同时办部门小仓入库'),
  note: z.string().trim().max(200).default(''),
});

async function accept(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(AcceptInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const doc = await loadDoc(tx, id, true);
    if (doc.docType !== 'petty_purchase') throw notFound('不是零星采购');
    if (doc.payload.acceptance) {
      if ((doc.payload.acceptance as { clientKey: string }).clientKey === input.clientKey) return;
      throw conflict('GF_ACCEPTED', '已经验收过了');
    }
    const flow = await latestFlow(tx, id);
    if (flow?.status !== 'approved') throw conflict('GF_NOT_APPROVED', '审批通过以后才能验收');
    if (actor.id === doc.createdBy) throw forbidden('采购的人不能自己验收：请实际使用人或部门里另一名员工验收');
    const [me] = await tx<{ departmentId: number | null }[]>`SELECT department_id FROM staff WHERE id = ${actor.id} AND active`;
    if (Number(me?.departmentId) !== doc.departmentId) throw forbidden('验收要由费用承担部门里的员工（实际使用人或另一名员工）来做');
    await lockDepts(tx, [doc.departmentId!]);
    const l = await docLedger(tx, id);
    if (input.actualCents > l.frozen) throw unprocessable('GF_OVER_APPROVED', `实际金额 ${yuan(input.actualCents)} 超过审批冻结的 ${yuan(l.frozen)}：超出部分要重新申请`);
    // 冻结转实际占用、差额释放（台账按原申请那天记）
    await ledger(tx, { deptId: l.dept!, day: l.day!, kind: 'unfreeze', amount: l.frozen, docId: id, opKey: `accept-unfreeze:${id}`, note: '验收转出', actorId: actor.id });
    await ledger(tx, { deptId: l.dept!, day: l.day!, kind: 'use', amount: input.actualCents, docId: id, opKey: `accept-use:${id}`, note: '验收实际占用', actorId: actor.id });
    const acceptance = { clientKey: input.clientKey, acceptorId: actor.id, actualCents: input.actualCents, invoiceNo: input.invoiceNo, stockIn: true, note: input.note, at: new Date().toISOString() };
    await tx`
      UPDATE gf_docs SET payload = payload || ${tx.json({ acceptance } as never)}, completed_at = now(), completed_by = ${actor.id},
        exec_started_at = coalesce(exec_started_at, now()), exec_started_by = coalesce(exec_started_by, ${actor.id}),
        backfill_open = ${!input.invoiceNo}, version = version + 1, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'gf_petty',
      targetType: 'gf_doc',
      targetId: id,
      detail: { op: 'accept', actualCents: input.actualCents, released: l.frozen - input.actualCents },
      ip,
    });
  });
}

const AdjustInput = z.object({
  clientKey: uuid,
  departmentId: z.number().int().positive(),
  month: z.string().regex(/^\d{4}-\d{2}$/, '月份写成 2026-12'),
  dailyCents: z.number().int().positive().max(100_000_000),
  monthlyCents: z.number().int().positive().max(1_000_000_000),
  reason: z.string().trim().min(2).max(300),
});

registerHooks('quota_adjust', {
  template: () => [COSIGN_FINANCE_CFO],
  ccRoles: ['chairman', 'business_gm'],
  beforeSubmit: async (_tx, doc) => {
    const month = String(doc.payload.month);
    if (`${month}-01` <= monthStart(todayIn(TZ))) throw unprocessable('GF_MONTH', '额度核定从次月起生效，不能改本月或以前');
  },
  approved: async (tx, doc) => {
    await tx`
      INSERT INTO gf_dept_quotas (department_id, effective_month, daily_cents, monthly_cents, doc_id)
      VALUES (${doc.departmentId}, ${`${String(doc.payload.month)}-01`}, ${Number(doc.payload.dailyCents)}, ${Number(doc.payload.monthlyCents)}, ${doc.id})
      ON CONFLICT (department_id, effective_month) DO UPDATE SET daily_cents = EXCLUDED.daily_cents, monthly_cents = EXCLUDED.monthly_cents, doc_id = EXCLUDED.doc_id`;
  },
});

async function quotaView(db: Db, deptId: number, name: string, day: string): Promise<PettyQuotaView> {
  const limits = await limitsOf(db, deptId, day);
  const t = await takenOf(db, deptId, day);
  const next = new Date(`${monthStart(day)}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const [n] = await db<{ dailyCents: number; monthlyCents: number }[]>`
    SELECT daily_cents, monthly_cents FROM gf_dept_quotas WHERE department_id = ${deptId} AND effective_month = ${next.toISOString().slice(0, 10)}::date`;
  const [o] = await db<{ overdue: number; split: number }[]>`
    SELECT count(*) FILTER (WHERE d.due_on < ${day}::date AND d.completed_at IS NULL AND d.withdrawn_at IS NULL)::int AS overdue,
           count(*) FILTER (WHERE (d.payload->>'splitSuspect')::boolean)::int AS split
    FROM gf_docs d WHERE d.doc_type = 'petty_purchase' AND d.department_id = ${deptId} AND d.payload->>'day' >= ${monthStart(day)}`;
  const q = quotaCheck({ ...limits, dayTaken: t.dayUsed + t.dayFrozen, monthTaken: t.monthUsed + t.monthFrozen, amount: 0 });
  return {
    departmentId: deptId,
    departmentName: name,
    day,
    month: day.slice(0, 7),
    ...limits,
    ...t,
    dayRemaining: limits.dailyLimit - t.dayUsed - t.dayFrozen,
    monthRemaining: limits.monthlyLimit - t.monthUsed - t.monthFrozen,
    warn: q.warn,
    overdue: o!.overdue,
    splitSuspects: o!.split,
    nextMonth: n ? { dailyLimit: Number(n.dailyCents), monthlyLimit: Number(n.monthlyCents) } : null,
  };
}

const OVERSIGHT: readonly GfRole[] = ['internal_control', 'finance_chief', 'cfo', 'chairman', 'finance_reviewer'];

export function registerPettyRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const tz = deps.config.timezone;
  TZ = tz;
  const signedIn = guard();
  const staffOnly: preHandlerAsyncHookHandler = async function (req, reply) {
    await signedIn.call(this, req, reply);
    if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(req.actor.role)) throw forbidden('这个账号不能用业财法审批');
  };
  const hasRole = async (actor: Actor, roles: readonly GfRole[]) => can(actor, 'gf.roles') || (await rolesOf(sql, actor.id)).some((r) => roles.includes(r));

  app.post('/api/gf/petty/preview', { preHandler: staffOnly }, async (req) => (await assess(sql, req.actor, parse(PettyFields, req.body), todayIn(tz))).preview);
  app.post('/api/gf/petty', { preHandler: staffOnly }, async (req) => ({ docId: await createPetty(deps, req.body, req.actor, req.ip) }));
  app.post('/api/gf/petty/:id/accept', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    await accept(deps, id, req.body, req.actor, req.ip);
    return { ok: true };
  });
  app.post('/api/gf/petty/:id/invoice', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { invoiceNo } = parse(z.object({ invoiceNo: z.string().trim().min(4, '请填发票号').max(40) }), req.body);
    await sql.begin(async (tx) => {
      const doc = await loadDoc(tx, id, true);
      if (doc.docType !== 'petty_purchase' || !doc.payload.acceptance) throw conflict('GF_STEP', '验收以后才能补发票');
      if (doc.createdBy !== req.actor.id && !(await hasRole(req.actor, ['finance_reviewer', 'finance_chief']))) throw forbidden('只有经办人或财务能补发票');
      await tx`UPDATE gf_docs SET payload = jsonb_set(payload, '{acceptance,invoiceNo}', to_jsonb(${invoiceNo}::text)), backfill_open = false, version = version + 1 WHERE id = ${id}`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'gf_petty', targetType: 'gf_doc', targetId: id, detail: { op: 'invoice', invoiceNo }, ip: req.ip });
    });
    return { ok: true };
  });
  app.post('/api/gf/petty/:id/reverse', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ clientKey: uuid, amountCents: z.number().int().positive(), reason: z.string().trim().min(2).max(200) }), req.body);
    if (!(await hasRole(req.actor, ['finance_chief']))) throw forbidden('冲正要财总来做');
    await sql.begin(async (tx) => {
      const doc = await loadDoc(tx, id, true);
      await lockDepts(tx, [doc.departmentId!]);
      const l = await docLedger(tx, id);
      if (input.amountCents > l.used) throw unprocessable('GF_REVERSE', `冲正金额超过实际占用 ${yuan(l.used)}`);
      await ledger(tx, { deptId: l.dept!, day: l.day!, kind: 'reverse', amount: input.amountCents, docId: id, opKey: `reverse:${input.clientKey}`, note: input.reason, actorId: req.actor.id });
      await writeAudit(tx, { staffId: req.actor.id, action: 'gf_petty', targetType: 'gf_doc', targetId: id, detail: { op: 'reverse', amountCents: input.amountCents }, ip: req.ip });
    });
    return docLedger(sql, id);
  });
  app.get('/api/gf/petty/:id/ledger', { preHandler: staffOnly }, async (req) => docLedger(sql, parse(idParam, req.params).id));
  app.post('/api/gf/petty/overdue-reviews', { preHandler: staffOnly }, async (req) => {
    const input = parse(z.object({ staffId: z.number().int().positive(), note: z.string().trim().min(2).max(200) }), req.body);
    if (!(await hasRole(req.actor, ['finance_chief']))) throw forbidden('逾期恢复要财总复核');
    await sql`INSERT INTO gf_overdue_reviews (staff_id, reviewed_by, note) VALUES (${input.staffId}, ${req.actor.id}, ${input.note})`;
    await writeAudit(sql, { staffId: req.actor.id, action: 'gf_petty', targetType: 'staff', targetId: input.staffId, detail: { op: 'overdue_review', note: input.note }, ip: req.ip });
    return { ok: true };
  });
  app.get('/api/gf/petty/board', { preHandler: staffOnly }, async (req) => {
    if (!(await hasRole(req.actor, OVERSIGHT))) throw forbidden('额度公示给内控、财务、CFO、董事长看');
    const day = todayIn(tz);
    const depts = await sql<{ id: number; name: string }[]>`SELECT id, name FROM departments WHERE active ORDER BY sort_order, id`;
    return Promise.all(depts.map((d) => quotaView(sql, Number(d.id), d.name, day)));
  });
  app.get('/api/gf/petty/quota/:id', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const [d] = await sql<{ name: string; headId: number | null }[]>`SELECT name, head_id FROM departments WHERE id = ${id}`;
    if (!d) throw notFound('没有这个部门');
    const [me] = await sql<{ departmentId: number | null }[]>`SELECT department_id FROM staff WHERE id = ${req.actor.id}`;
    if (Number(d.headId) !== req.actor.id && Number(me?.departmentId) !== id && !(await hasRole(req.actor, OVERSIGHT))) throw forbidden('只能看本部门的额度');
    return quotaView(sql, id, d.name, todayIn(tz));
  });
  app.post('/api/gf/quota-adjust', { preHandler: staffOnly }, async (req) => {
    const input = parse(AdjustInput, req.body);
    if (!(await hasRole(req.actor, ['internal_control']))) throw forbidden('月度额度建议由内控提出');
    if (input.monthlyCents < input.dailyCents) throw unprocessable('GF_QUOTA', '月额度不能小于日额度');
    const requestHash = hashRequest({ ...input, clientKey: undefined });
    const docId = await sql.begin(async (tx) => {
      const [r] = await tx<{ id: number }[]>`SELECT id FROM gf_docs WHERE client_key = ${input.clientKey}`;
      if (r) return Number(r.id);
      const [d] = await tx<{ name: string }[]>`SELECT name FROM departments WHERE id = ${input.departmentId} AND active`;
      if (!d) throw unprocessable('GF_DEPT', '部门不存在或已停用');
      const id = await insertDoc(
        tx,
        {
          docType: 'quota_adjust',
          title: `月度额度核定：${d.name} ${input.month}（日 ${yuan(input.dailyCents)} / 月 ${yuan(input.monthlyCents)}）`,
          note: input.reason,
          departmentId: input.departmentId,
          amountCents: input.monthlyCents,
          payload: { month: input.month, dailyCents: input.dailyCents, monthlyCents: input.monthlyCents },
          clientKey: input.clientKey,
          requestHash,
        },
        req.actor,
        todayIn(tz),
      );
      const doc = await loadDoc(tx, id, true);
      await submitFlow(tx, doc, templateFor(doc), req.actor);
      return id;
    });
    return { docId };
  });
  app.post('/api/gf/settings/purchase-dept', { preHandler: guard('gf.roles') }, async (req) => {
    const { departmentId } = parse(z.object({ departmentId: z.number().int().positive() }), req.body);
    await sql`
      INSERT INTO gf_settings (key, value, updated_by) VALUES ('purchase_dept_id', ${sql.json(departmentId)}, ${req.actor.id})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    return { departmentId };
  });
  app.get('/api/gf/settings', { preHandler: staffOnly }, async () => ({ purchaseDeptId: await purchaseDeptId(sql) }));
}
