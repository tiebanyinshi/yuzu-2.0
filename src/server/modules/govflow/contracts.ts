// 业财法 P04：七类合同审批（docs/APPROVAL_V4.md 第 8 节）。
//   POST /api/gf/contracts/classify       按经济实质判定类型、提示拆分（不落库）
//   POST /api/gf/contracts                发起合同：类型与实质一致、不含税全期口径、库内供应商 + 有效 SKU 价格一致、按档位排链
//   GET  /api/gf/contracts/:id            合同要点与版本
//   POST /api/gf/contracts/:id/confirm-type   「其他」类由财法确认归属（未确认不得签署）
//   POST /api/gf/contracts/:id/change     变更：只减金额且其他不变保留原审批留记录；核心变更原审批作废、新事项重新路由
// 签署（开始执行）、用印（完成，1 个工作日内归档）、归档走事项的「执行」接口，这里用钩子把关。

import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { addWorkdays, GF_FLAGS } from '@shared/govflow';
import {
  CONTRACT_CHANGE_FIELDS,
  CONTRACT_TYPES,
  CONTRACT_TYPE_LABELS,
  approvalAmount,
  changeKeepsApproval,
  classifyContract,
  contractTemplate,
  type ContractType,
  type ContractView,
} from '@shared/govflow-contract';
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
import { insertDoc, latestFlow, loadDoc, loadMembers, registerHooks, rolesOf, submitFlow, type DocRow } from './engine';
import { inLibrary } from './supply';
import { templateFor } from './types';

let TZ = 'Asia/Shanghai';
const uuid = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const yuan = (c: number) => `¥${formatAmount(c)}`;

const Substance = z.object({
  ownership: z.boolean().default(false),
  laborResult: z.boolean().default(false),
  construction: z.boolean().default(false),
  periodUse: z.boolean().default(false),
  jointOperation: z.boolean().default(false),
  equipmentInseparable: z.boolean().default(false),
  generalInstallOnly: z.boolean().default(false),
  frameworkOrdersPriced: z.boolean().default(false),
  hasAmount: z.boolean().default(true),
});
const Amounts = z.object({
  totalExTaxCents: z.number().int().min(0).max(100_000_000_000).nullable().default(null),
  perPeriodExTaxCents: z.number().int().min(0).max(10_000_000_000).nullable().default(null),
  periods: z.number().int().min(1).max(600).nullable().default(null),
  taxInclusiveCents: z.number().int().min(0).max(200_000_000_000).nullable().default(null),
});
const ContractInput = Amounts.extend({
  clientKey: uuid,
  type: z.enum(CONTRACT_TYPES),
  title: z.string().trim().min(2).max(100),
  counterparty: z.string().trim().min(2, '请填相对方').max(80),
  supplierId: z.number().int().positive().nullable().default(null),
  departmentId: z.number().int().positive(),
  entityId: z.number().int().positive().nullable().default(null),
  performerId: z.number().int().positive('合同要选内部履约执行人'),
  flags: z.array(z.enum(GF_FLAGS)).max(GF_FLAGS.length).default([]),
  substance: Substance,
  cannotSplitReason: z.string().trim().max(200).default(''),
  lines: z
    .array(z.object({ skuId: z.number().int().positive(), qty: z.number().int().positive().max(1_000_000), priceCents: z.number().int().positive() }))
    .max(200)
    .default([]),
  note: z.string().trim().max(1000).default(''),
});
type ContractInputT = z.infer<typeof ContractInput>;

function amountOf(type: ContractType, a: z.infer<typeof Amounts>): number {
  try {
    return approvalAmount({ type, totalExTaxCents: a.totalExTaxCents, perPeriodExTaxCents: a.perPeriodExTaxCents, periods: a.periods });
  } catch (error) {
    throw unprocessable('GF_PERIOD_AMOUNT', (error as Error).message);
  }
}

/** 校验并算出要落库的内容（新发起与核心变更重新路由共用） */
async function prepare(tx: Tx, input: ContractInputT) {
  const cls = classifyContract(input.substance);
  if (input.type !== 'other' && input.type !== cls.type) {
    throw unprocessable('GF_TYPE_MISMATCH', `按经济实质应归「${CONTRACT_TYPE_LABELS[cls.type]}」（${cls.reason}）；确实不同的选「其他」由财法确认归属`, { suggested: cls.type });
  }
  if (cls.splitAdvice && input.cannotSplitReason.length < 4) throw unprocessable('GF_SPLIT', `${cls.splitAdvice}；不能拆的写明原因`, { advice: cls.splitAdvice });
  const approvalCents = amountOf(input.type, input);
  if (input.type !== 'no_amount' && approvalCents === 0) throw unprocessable('GF_AMOUNT', '请填不含税金额（无金额的选「无金额」）');
  const members = await loadMembers(tx, input.entityId);
  if (!(members.performer ?? []).includes(input.performerId)) throw unprocessable('GF_PERFORMER_ROLE', '选的人不在「内部履约执行人」角色里');
  const flags = new Set<string>(input.flags);
  let lib = false;
  let supplierName: string | null = null;
  if (input.supplierId !== null) {
    const [s] = await tx<{ name: string }[]>`SELECT name FROM gf_suppliers WHERE id = ${input.supplierId}`;
    if (!s) throw unprocessable('GF_SUPPLIER', '供应商不存在');
    supplierName = s.name;
    lib = (
      await inLibrary(
        tx,
        input.supplierId,
        input.lines.map((l) => l.skuId),
      )
    ).ok;
  }
  // 价格一致性：库内 SKU 的单价必须等于现行协议价
  if (input.lines.length) {
    if (input.supplierId === null) throw unprocessable('GF_SUPPLIER', '带 SKU 明细的合同要选供应商');
    const skus = await tx<{ id: number; supplierId: number; priceCents: number; status: string; skuCode: string }[]>`
      SELECT id, supplier_id, price_cents, status, sku_code FROM gf_skus WHERE id IN ${tx(input.lines.map((l) => l.skuId))}`;
    const byId = new Map(skus.map((k) => [Number(k.id), k]));
    let sum = 0;
    for (const l of input.lines) {
      const k = byId.get(l.skuId);
      if (!k || Number(k.supplierId) !== input.supplierId) throw unprocessable('GF_SKU', 'SKU 不属于这个供应商');
      if (k.status === 'active' && Number(k.priceCents) !== l.priceCents) {
        throw unprocessable('GF_PRICE_MISMATCH', `${k.skuCode} 单价 ${yuan(l.priceCents)} 与现行协议价 ${yuan(Number(k.priceCents))} 不一致：先走协议价变更`, { skuId: l.skuId });
      }
      sum += l.priceCents * l.qty;
    }
    if (input.totalExTaxCents !== null && sum !== input.totalExTaxCents) throw unprocessable('GF_AMOUNT_MISMATCH', `明细合计 ${yuan(sum)} 与合同不含税总价 ${yuan(input.totalExTaxCents)} 对不上`);
  }
  // 库外（或没在库里的相对方）供应商：不能免准入，加内控；签署前必须完成供应商入库
  const needsAdmission = ['purchase', 'service', 'engineering'].includes(input.type) && !lib;
  if (needsAdmission) flags.add('new_supplier');
  return { cls, approvalCents, flags: [...flags], lib, supplierName, needsAdmission };
}

async function createContract(deps: Deps, input: ContractInputT, actor: Actor, opts: { relatedDocId?: number; version?: number; tx?: Tx; requestHash?: string } = {}) {
  const requestHash = opts.requestHash ?? hashRequest({ ...input, clientKey: undefined });
  const run = async (tx: Tx) => {
    const [dup] = await tx<{ id: number; createdBy: number; requestHash: string }[]>`SELECT id, created_by, request_hash FROM gf_docs WHERE client_key = ${input.clientKey}`;
    if (dup) {
      if (Number(dup.createdBy) !== actor.id || dup.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一份合同，请刷新页面后重新填写');
      return Number(dup.id);
    }
    const p = await prepare(tx, input);
    const today = todayIn(TZ);
    const contractNo = await nextDocNo(tx, 'gf_contract', 'HT', today);
    const id = await insertDoc(
      tx,
      {
        docType: 'contract',
        title: `${CONTRACT_TYPE_LABELS[input.type]}合同：${input.title}`,
        note: input.note,
        entityId: input.entityId,
        departmentId: input.departmentId,
        amountCents: p.approvalCents,
        performerId: input.performerId,
        relatedDocId: opts.relatedDocId ?? null,
        flags: p.flags,
        payload: {
          contractNo,
          type: input.type,
          confirmedType: input.type === 'other' ? null : input.type,
          counterparty: input.counterparty,
          supplierId: input.supplierId,
          supplierName: p.supplierName,
          totalExTaxCents: input.totalExTaxCents,
          perPeriodExTaxCents: input.perPeriodExTaxCents,
          periods: input.periods,
          taxInclusiveCents: input.taxInclusiveCents,
          substance: input.substance,
          classification: p.cls,
          cannotSplitReason: input.cannotSplitReason,
          lines: input.lines,
          inLibrary: p.lib,
          needsAdmission: p.needsAdmission,
          version: opts.version ?? 1,
        },
        clientKey: input.clientKey,
        requestHash,
      },
      actor,
      today,
    );
    await tx`
      INSERT INTO gf_contract_versions (doc_id, version, kind, approval_cents, created_by)
      VALUES (${id}, ${opts.version ?? 1}, ${opts.relatedDocId ? 'reroute' : 'initial'}, ${p.approvalCents}, ${actor.id})`;
    const doc = await loadDoc(tx, id, true);
    await submitFlow(tx, doc, await templateFor(tx, doc), actor);
    return id;
  };
  if (opts.tx) return run(opts.tx);
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      return run(tx);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'gf_docs_client_key_key')) {
      const [r] = await deps.sql<{ id: number }[]>`SELECT id FROM gf_docs WHERE client_key = ${input.clientKey} AND created_by = ${actor.id}`;
      if (r) return Number(r.id);
    }
    throw error;
  }
}

registerHooks('contract', {
  template: (doc) => contractTemplate(doc.payload.type as ContractType, doc.amountCents ?? 0, doc.flags),
  ccRoles: ['finance_chief', 'cfo'],
  beforeSubmit: async (_tx, doc) => {
    if (doc.payload.supersededBy) throw conflict('GF_SUPERSEDED', '这份合同已经变更作废，按新的那份走');
  },
  beforeExecute: async (tx, doc, step) => {
    if (doc.payload.supersededBy) throw conflict('GF_SUPERSEDED', '这份合同已经变更作废，按新的那份走');
    if (step === 'start') {
      if (!doc.payload.confirmedType) throw conflict('GF_TYPE_UNCONFIRMED', '「其他」类合同要财法确认归属以后才能签署');
      // 采购 / 服务 / 工程（「其他」按财法确认的归属）要库内供应商：没入库的先完成入库再签
      const effective = String(doc.payload.confirmedType);
      if (['purchase', 'service', 'engineering'].includes(effective)) {
        const lib = doc.payload.supplierId ? await inLibrary(tx, Number(doc.payload.supplierId)) : { ok: false, reason: '相对方不在供应商库里' };
        if (!lib.ok) throw conflict('GF_SUPPLIER_NOT_ACTIVE', `供应商还没完成入库（${lib.reason}）：先建档并完成入库再签署`);
      }
      await tx`UPDATE gf_docs SET payload = payload || ${tx.json({ signedAt: new Date().toISOString() } as never)} WHERE id = ${doc.id}`;
    } else if (step === 'complete') {
      // 用印：1 个工作日内扫描归档（没归档前是「后补待完成」，过期算逾期）
      const holidays = new Map((await tx<{ day: string; kind: 'holiday' | 'workday' }[]>`SELECT day::text AS day, kind FROM oa_holidays WHERE day >= current_date - 7`).map((h) => [h.day, h.kind]));
      const due = addWorkdays(todayIn(TZ), 1, holidays);
      await tx`UPDATE gf_docs SET due_on = ${due}, backfill_open = true, payload = payload || ${tx.json({ sealedAt: new Date().toISOString() } as never)} WHERE id = ${doc.id}`;
    } else {
      await tx`UPDATE gf_docs SET backfill_open = false WHERE id = ${doc.id}`;
    }
  },
});

async function view(db: Db, doc: DocRow): Promise<ContractView> {
  const p = doc.payload;
  const [v] = await db<{ v: number }[]>`SELECT max(version) AS v FROM gf_contract_versions WHERE doc_id = ${doc.id}`;
  return {
    docId: doc.id,
    contractNo: String(p.contractNo),
    type: p.type as ContractType,
    confirmedType: (p.confirmedType as ContractType | null) ?? null,
    supplierId: p.supplierId === null || p.supplierId === undefined ? null : Number(p.supplierId),
    supplierName: (p.supplierName as string | null) ?? null,
    counterparty: String(p.counterparty),
    approvalCents: doc.amountCents ?? 0,
    taxInclusiveCents: p.taxInclusiveCents === null || p.taxInclusiveCents === undefined ? null : Number(p.taxInclusiveCents),
    version: Number(v?.v ?? 1),
    inLibrary: p.inLibrary === true,
    signedAt: (p.signedAt as string | undefined) ?? null,
    sealedAt: (p.sealedAt as string | undefined) ?? null,
    archiveDueOn: doc.backfillOpen ? doc.dueOn : null,
    supersededBy: p.supersededBy ? Number(p.supersededBy) : null,
  };
}

const ChangeInput = Amounts.extend({
  clientKey: uuid,
  fields: z.array(z.enum(CONTRACT_CHANGE_FIELDS)).min(1, '请选改了什么'),
  reason: z.string().trim().min(2).max(300),
  /** 核心变更时的新内容（相对方、标的、类型……），不给的照原合同 */
  patch: z
    .object({
      counterparty: z.string().trim().min(2).max(80).optional(),
      title: z.string().trim().min(2).max(100).optional(),
      type: z.enum(CONTRACT_TYPES).optional(),
      note: z.string().max(1000).optional(),
    })
    .default({}),
});

export function registerContractRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  TZ = deps.config.timezone;
  const signedIn = guard();
  const staffOnly: preHandlerAsyncHookHandler = async function (req, reply) {
    await signedIn.call(this, req, reply);
    if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(req.actor.role)) throw forbidden('这个账号不能用业财法审批');
  };

  app.post('/api/gf/contracts/classify', { preHandler: staffOnly }, async (req) => classifyContract(parse(Substance, req.body)));
  app.post('/api/gf/contracts', { preHandler: staffOnly }, async (req) => {
    const input = parse(ContractInput, req.body);
    const id = await createContract(deps, input, req.actor);
    await writeAudit(sql, { staffId: req.actor.id, action: 'gf_contract', targetType: 'gf_doc', targetId: id, detail: { op: 'create', type: input.type }, ip: req.ip });
    return { docId: id };
  });
  app.get('/api/gf/contracts/:id', { preHandler: staffOnly }, async (req) => {
    const doc = await loadDoc(sql, parse(idParam, req.params).id);
    if (doc.docType !== 'contract') throw notFound('不是合同');
    const versions = await sql<{ version: number; kind: string; approvalCents: number; fields: string[]; reason: string; newDocId: number | null; createdAt: Date }[]>`
      SELECT version, kind, approval_cents, fields, reason, new_doc_id, created_at FROM gf_contract_versions WHERE doc_id = ${doc.id} ORDER BY version`;
    return {
      contract: await view(sql, doc),
      versions: versions.map((v) => ({ ...v, approvalCents: Number(v.approvalCents), newDocId: v.newDocId === null ? null : Number(v.newDocId), createdAt: new Date(v.createdAt).toISOString() })),
    };
  });
  app.post('/api/gf/contracts/:id/confirm-type', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { type } = parse(z.object({ type: z.enum(CONTRACT_TYPES.filter((t) => t !== 'other') as [ContractType, ...ContractType[]]) }), req.body);
    const roles = await rolesOf(sql, req.actor.id);
    if (!roles.includes('legal') && !roles.includes('finance_reviewer')) throw forbidden('「其他」类的归属由财务或法务确认');
    await sql.begin(async (tx) => {
      const doc = await loadDoc(tx, id, true);
      if (doc.docType !== 'contract' || doc.payload.type !== 'other') throw conflict('GF_STEP', '只有「其他」类合同要确认归属');
      if (doc.payload.confirmedType) throw conflict('GF_STEP', '已经确认过归属了');
      if (doc.createdBy === req.actor.id) throw forbidden('发起人不能自己确认归属');
      await tx`UPDATE gf_docs SET payload = payload || ${tx.json({ confirmedType: type, confirmedBy: req.actor.id } as never)}, version = version + 1 WHERE id = ${id}`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'gf_contract', targetType: 'gf_doc', targetId: id, detail: { op: 'confirm_type', type }, ip: req.ip });
    });
    return { ok: true };
  });
  app.post('/api/gf/contracts/:id/change', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(ChangeInput, req.body);
    const result = await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const doc = await loadDoc(tx, id, true);
      if (doc.docType !== 'contract') throw notFound('不是合同');
      if (doc.createdBy !== req.actor.id && doc.performerId !== req.actor.id && !can(req.actor, 'gf.roles')) throw forbidden('只有发起人或履约执行人能发起变更');
      if (doc.payload.supersededBy) throw conflict('GF_SUPERSEDED', '这份合同已经变更作废');
      if (doc.archivedAt) throw conflict('GF_STEP', '已归档的合同不能再变更');
      const flow = await latestFlow(tx, id);
      if (flow?.status !== 'approved') throw conflict('GF_NOT_APPROVED', '审批通过的合同才走变更；在审的直接退回修改');
      const p = doc.payload;
      const type = (input.patch.type ?? p.type) as ContractType;
      const merged = {
        totalExTaxCents: input.totalExTaxCents ?? (p.totalExTaxCents as number | null),
        perPeriodExTaxCents: input.perPeriodExTaxCents ?? (p.perPeriodExTaxCents as number | null),
        periods: input.periods ?? (p.periods as number | null),
        taxInclusiveCents: input.taxInclusiveCents ?? (p.taxInclusiveCents as number | null),
      };
      const newCents = amountOf(type, merged);
      const [{ v }] = (await tx<{ v: number }[]>`SELECT max(version) AS v FROM gf_contract_versions WHERE doc_id = ${id}`) as unknown as [{ v: number }];
      if (changeKeepsApproval(input.fields, doc.amountCents ?? 0, newCents)) {
        // 只减金额、其他不变：保留原审批，留变更记录
        await tx`
          INSERT INTO gf_contract_versions (doc_id, version, kind, approval_cents, fields, reason, created_by)
          VALUES (${id}, ${v + 1}, 'decrease', ${newCents}, ${input.fields}, ${input.reason}, ${req.actor.id})`;
        await tx`UPDATE gf_docs SET amount_cents = ${newCents}, payload = payload || ${tx.json(merged as never)}, version = version + 1, updated_at = now() WHERE id = ${id}`;
        return { docId: id, kept: true };
      }
      // 核心变更：原审批作废，按新内容重新路由（新事项，关联原合同）
      const next: ContractInputT = {
        clientKey: input.clientKey,
        type,
        title: input.patch.title ?? String(doc.title).replace(/^.+?合同：/, ''),
        counterparty: input.patch.counterparty ?? String(p.counterparty),
        supplierId: (p.supplierId as number | null) ?? null,
        departmentId: doc.departmentId!,
        entityId: doc.entityId,
        performerId: doc.performerId!,
        flags: doc.flags.filter((f) => f !== 'new_supplier') as ContractInputT['flags'],
        substance: p.substance as ContractInputT['substance'],
        cannotSplitReason: String(p.cannotSplitReason ?? ''),
        lines: (p.lines as ContractInputT['lines']) ?? [],
        note: input.patch.note ?? `变更自 ${String(p.contractNo)}：${input.reason}`,
        ...merged,
      };
      const newId = await createContract(deps, next, req.actor, { relatedDocId: id, version: v + 1, tx, requestHash: hashRequest({ change: id, ...input, clientKey: undefined }) });
      await tx`
        INSERT INTO gf_contract_versions (doc_id, version, kind, approval_cents, fields, reason, new_doc_id, created_by)
        VALUES (${id}, ${v + 1}, 'reroute', ${newCents}, ${input.fields}, ${input.reason}, ${newId}, ${req.actor.id})`;
      await tx`UPDATE gf_docs SET payload = payload || ${tx.json({ supersededBy: newId } as never)}, withdrawn_at = now(), withdrawn_by = ${req.actor.id}, version = version + 1 WHERE id = ${id}`;
      return { docId: newId, kept: false };
    });
    await writeAudit(sql, { staffId: req.actor.id, action: 'gf_contract', targetType: 'gf_doc', targetId: id, detail: { op: 'change', ...result, fields: input.fields }, ip: req.ip });
    return result;
  });
}
