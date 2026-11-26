// 业财法 P02：供应商与商品 SKU 两级库（docs/APPROVAL_V4.md 第 6 节）。
//   /api/gf/materials                         集团物料：列表、新建（供应链负责人或店主）
//   /api/gf/suppliers                         供应商库：列表、建档（待准入，按统一社会信用代码查重）、详情
//   /api/gf/suppliers/:id/admit               提交入库：供应链负责人 → 董事长（新供应商自动加内控），知会 CFO、财总
//   /api/gf/suppliers/:id/change              变更：核心（主体、税号、收款账户、核心资质）→ 董事长；一般资料供应链负责人
//   /api/gf/suppliers/:id/status              停用 / 退出 / 恢复（供应链负责人或店主）
//   /api/gf/suppliers/import                  历史数据迁移：一律进「待准入」，不能一键激活
//   /api/gf/sku-batches                       同一供应商一批 SKU 一张单提报、逐个建码；/:docId/review 差异摘要
//   /api/gf/skus/:id/price                    协议价变更（新价格版本，历史单据保留原版本）
//   /api/gf/selector/suppliers[/:id/skus]     选择器：只给已入库的供应商、只给有效 SKU；状态不明一律不算已入库

import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import type { GfNode } from '@shared/govflow';
import {
  BUSINESS_FORMATS,
  QUALIFICATION_KINDS,
  SUPPLIER_FIELD_LABELS,
  SUPPLY_CATEGORIES,
  creditCodeProblem,
  isCoreChange,
  qualificationProblems,
  skuAbnormal,
  type GfMaterial,
  type GfSkuView,
  type GfSupplierView,
  type Qualification,
  type SkuAbnormal,
  type SkuBatchReview,
  type SupplierField,
  type SupplierImportResult,
  type SupplierStatus,
  type SupplyCategory,
} from '@shared/govflow-supply';
import { can } from '@shared/permissions';
import type { Db, Fragment, Tx } from '../../db';
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
import { insertDoc, loadDoc, registerHooks, rolesOf, submitFlow, type DocRow } from './engine';
import { templateFor } from './types';

const iso = (d: Date | string) => new Date(d).toISOString();
const uuid = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const REVIEW: GfNode[] = [
  { kind: 'role', role: 'supply_chain_head', stage: 'review' },
  { kind: 'role', role: 'chairman', stage: 'final' },
];

/** 管供应链主数据的：店主（gf.roles）或供应链负责人 */
async function isSupplyManager(db: Db, actor: Actor) {
  return can(actor, 'gf.roles') || (await rolesOf(db, actor.id)).includes('supply_chain_head');
}
/** 看得到完整收款账号的：店主、供应链负责人、CFO、财总、出纳、董事长（其他人只看尾号，敏感资料按最小权限） */
async function seesBank(db: Db, actor: Actor) {
  if (can(actor, 'gf.roles')) return true;
  const roles = await rolesOf(db, actor.id);
  return roles.some((r) => r === 'supply_chain_head' || r === 'cfo' || r === 'finance_chief' || r === 'cashier' || r === 'chairman');
}
const mask = (acct: string) => (acct.length <= 4 ? acct.replace(/./g, '*') : `****${acct.slice(-4)}`);

// ───────────────────────── 读 ─────────────────────────

interface SupplierRow {
  id: number;
  supplierNo: string;
  name: string;
  creditCode: string;
  categories: SupplyCategory[];
  contact: string;
  phone: string;
  address: string;
  bankName: string;
  bankAccount: string;
  accountName: string;
  qualifications: Qualification[];
  note: string;
  status: SupplierStatus;
  legacy: boolean;
  version: number;
  admissionDocId: number | null;
  pendingChangeDocId: number | null;
  createdBy: number;
  createdByName: string;
  createdAt: Date;
  skuCount: number;
}

async function supplierRows(db: Db, where: Fragment): Promise<SupplierRow[]> {
  const rows = await db<SupplierRow[]>`
    SELECT s.*, c.display_name AS created_by_name, (SELECT count(*)::int FROM gf_skus k WHERE k.supplier_id = s.id AND k.status = 'active') AS sku_count
    FROM gf_suppliers s JOIN staff c ON c.id = s.created_by WHERE ${where} ORDER BY s.id DESC LIMIT 500`;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    createdBy: Number(r.createdBy),
    admissionDocId: r.admissionDocId === null ? null : Number(r.admissionDocId),
    pendingChangeDocId: r.pendingChangeDocId === null ? null : Number(r.pendingChangeDocId),
  }));
}

async function toViews(db: Db, actor: Actor, rows: SupplierRow[], timeZone: string): Promise<GfSupplierView[]> {
  const bank = await seesBank(db, actor);
  const today = todayIn(timeZone);
  return rows.map((r) => {
    const full = bank || r.createdBy === actor.id;
    return {
      id: r.id,
      supplierNo: r.supplierNo,
      name: r.name,
      creditCode: r.creditCode,
      categories: r.categories,
      contact: r.contact,
      phone: r.phone,
      address: r.address,
      bankName: r.bankName,
      bankAccount: full ? r.bankAccount : mask(r.bankAccount),
      accountName: r.accountName,
      bankMasked: !full,
      qualifications: r.qualifications,
      note: r.note,
      status: r.status,
      legacy: r.legacy,
      version: r.version,
      pendingChangeDocId: r.pendingChangeDocId,
      admissionDocId: r.admissionDocId,
      missing: qualificationProblems(r.categories, r.qualifications, today),
      createdByName: r.createdByName,
      createdAt: iso(r.createdAt),
      skuCount: r.skuCount,
    };
  });
}

async function loadSupplier(db: Db, id: number, lock = false): Promise<SupplierRow> {
  if (lock) await db`SELECT 1 FROM gf_suppliers WHERE id = ${id} FOR UPDATE`;
  const [r] = await supplierRows(db, db`s.id = ${id}`);
  if (!r) throw notFound('没有这个供应商');
  return r;
}

async function skuViews(db: Db, where: Fragment): Promise<GfSkuView[]> {
  const rows = await db<(GfSkuView & { entityIds: (number | string)[] })[]>`
    SELECT k.id, k.sku_code, k.supplier_id, s.name AS supplier_name, k.material_id, m.name AS material_name, k.name, k.spec, k.unit,
           k.price_cents, k.price_version, k.tax_rate_bp, k.entity_ids, k.formats, k.status, k.pending_change_doc_id, k.doc_id
    FROM gf_skus k JOIN gf_suppliers s ON s.id = k.supplier_id JOIN gf_materials m ON m.id = k.material_id
    WHERE ${where} ORDER BY k.id`;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    supplierId: Number(r.supplierId),
    materialId: Number(r.materialId),
    priceCents: Number(r.priceCents),
    entityIds: r.entityIds.map(Number),
    pendingChangeDocId: r.pendingChangeDocId === null ? null : Number(r.pendingChangeDocId),
    docId: r.docId === null ? null : Number(r.docId),
  }));
}

/** 快照：入库、变更通过后记一版（历史单据按 payload 里的版本号对照） */
async function snapshot(tx: Tx, supplierId: number, docId: number) {
  const [s] = await tx<{ version: number }[]>`SELECT version FROM gf_suppliers WHERE id = ${supplierId}`;
  await tx`
    INSERT INTO gf_supplier_versions (supplier_id, version, snapshot, doc_id)
    SELECT id, version, jsonb_build_object('name', name, 'creditCode', credit_code, 'categories', categories, 'bankName', bank_name, 'bankAccount', bank_account,
                                           'accountName', account_name, 'qualifications', qualifications, 'contact', contact, 'phone', phone, 'address', address, 'note', note),
           ${docId}
    FROM gf_suppliers WHERE id = ${supplierId}
    ON CONFLICT (supplier_id, version) DO NOTHING`;
  return s!.version;
}

/**
 * 能不能当「库内」用（P04 的库内供应商 + 有效 SKU 免重复准入要先过这一关）：供应商必须明确是「已入库」且没有在审的核心变更，
 * SKU 必须有效、没有在审的协议价变更。查不到、状态不明一律按不能用（接口不静默放行）。
 */
export async function inLibrary(db: Db, supplierId: number, skuIds: readonly number[] = []): Promise<{ ok: boolean; reason: string | null }> {
  const [s] = await db<{ status: string; pendingChangeDocId: number | null }[]>`SELECT status, pending_change_doc_id FROM gf_suppliers WHERE id = ${supplierId}`;
  if (!s) return { ok: false, reason: '查不到这个供应商' };
  if (s.status !== 'active') return { ok: false, reason: '供应商不是「已入库」' };
  if (s.pendingChangeDocId !== null) return { ok: false, reason: '供应商有在审的变更，审核期间不能按库内简化' };
  if (skuIds.length) {
    const rows = await db<{ id: number; status: string; supplierId: number; pendingChangeDocId: number | null }[]>`
      SELECT id, status, supplier_id, pending_change_doc_id FROM gf_skus WHERE id IN ${db([...skuIds])}`;
    if (rows.length !== new Set(skuIds).size) return { ok: false, reason: '有 SKU 查不到' };
    for (const r of rows) {
      if (Number(r.supplierId) !== supplierId) return { ok: false, reason: 'SKU 不属于这个供应商' };
      if (r.status !== 'active') return { ok: false, reason: '有 SKU 不是有效状态' };
      if (r.pendingChangeDocId !== null) return { ok: false, reason: '有 SKU 的协议价在审，审核期间不能按库内简化' };
    }
  }
  return { ok: true, reason: null };
}

// ───────────────────────── 建档、入库 ─────────────────────────

const QualInput = z.object({
  kind: z.enum(QUALIFICATION_KINDS),
  no: z.string().trim().min(1, '请填证照编号').max(60),
  expiresOn: z.iso.date().nullable().default(null),
});
const SupplierFields = z.object({
  name: z.string().trim().min(2, '请填主体名称').max(80),
  creditCode: z.string().trim().toUpperCase(),
  categories: z.array(z.enum(SUPPLY_CATEGORIES)).min(1, '请选供应品类').max(6),
  contact: z.string().trim().max(30).default(''),
  phone: z.string().trim().max(30).default(''),
  address: z.string().trim().max(120).default(''),
  bankName: z.string().trim().max(60).default(''),
  bankAccount: z
    .string()
    .trim()
    .regex(/^\d{0,30}$/, '收款账号只能是数字')
    .default(''),
  accountName: z.string().trim().max(80).default(''),
  qualifications: z.array(QualInput).max(20).default([]),
  note: z.string().trim().max(500).default(''),
});
const SupplierInput = SupplierFields.extend({ clientKey: uuid });

function checkCredit(code: string) {
  const p = creditCodeProblem(code);
  if (p) throw unprocessable('GF_CREDIT_CODE', p);
}

async function dupOf(db: Db, creditCode: string, exceptId = 0) {
  const [d] = await db<{ id: number; name: string; status: string }[]>`SELECT id, name, status FROM gf_suppliers WHERE credit_code = ${creditCode} AND id <> ${exceptId}`;
  return d ? { id: Number(d.id), name: d.name, status: d.status } : null;
}

async function createSupplier(deps: Deps, raw: unknown, actor: Actor, ip?: string, legacy = false): Promise<number> {
  const input = parse(SupplierInput, raw);
  checkCredit(input.creditCode);
  const existing = async (db: Db) => {
    const [r] = await db<{ id: number; createdBy: number }[]>`SELECT id, created_by FROM gf_suppliers WHERE client_key = ${input.clientKey}`;
    if (!r) return null;
    if (Number(r.createdBy) !== actor.id) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用过，请刷新页面后重新填写');
    return Number(r.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const found = await existing(tx);
      if (found) return found;
      const dup = await dupOf(tx, input.creditCode);
      if (dup) throw conflict('GF_SUPPLIER_DUP', `统一社会信用代码已在库里：${dup.name}（${dup.id}），不能重复建档`, { supplierId: dup.id });
      const no = await nextDocNo(tx, 'gf_supplier', 'GYS', todayIn(deps.config.timezone));
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO gf_suppliers (supplier_no, name, credit_code, categories, contact, phone, address, bank_name, bank_account, account_name, qualifications, note, legacy, client_key, created_by)
        VALUES (${no}, ${input.name}, ${input.creditCode}, ${input.categories}, ${input.contact}, ${input.phone}, ${input.address}, ${input.bankName}, ${input.bankAccount},
                ${input.accountName}, ${tx.json(input.qualifications as never)}, ${input.note}, ${legacy}, ${input.clientKey}, ${actor.id})
        RETURNING id`;
      const id = Number(row!.id);
      await writeAudit(tx, { staffId: actor.id, action: 'gf_supply', targetType: 'gf_supplier', targetId: id, detail: { op: legacy ? 'import' : 'create', no, name: input.name }, ip });
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'gf_suppliers_client_key_key')) {
      const found = await existing(deps.sql);
      if (found) return found;
    }
    if (isUniqueViolation(error, 'gf_suppliers_credit_code_uq')) throw conflict('GF_SUPPLIER_DUP', '统一社会信用代码已在库里，不能重复建档');
    throw error;
  }
}

/** 事项的操作编号：同一编号重提返回原来那个事项（发起人要是同一人） */
async function docByKey(db: Db, clientKey: string, actor: Actor, requestHash: string): Promise<number | null> {
  const [r] = await db<{ id: number; createdBy: number; requestHash: string }[]>`SELECT id, created_by, request_hash FROM gf_docs WHERE client_key = ${clientKey}`;
  if (!r) return null;
  if (Number(r.createdBy) !== actor.id || r.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一个事项，请刷新页面后重新填写');
  return Number(r.id);
}

async function withDocKey(deps: Deps, clientKey: string, actor: Actor, payload: unknown, fn: (tx: Tx, requestHash: string) => Promise<number>): Promise<number> {
  const requestHash = hashRequest(payload);
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const found = await docByKey(tx, clientKey, actor, requestHash);
      if (found) return found;
      return fn(tx, requestHash);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'gf_docs_client_key_key')) {
      const found = await docByKey(deps.sql, clientKey, actor, requestHash);
      if (found) return found;
    }
    throw error;
  }
}

async function admit(deps: Deps, supplierId: number, clientKey: string, actor: Actor, ip?: string) {
  return withDocKey(deps, clientKey, actor, { op: 'admit', supplierId }, async (tx, requestHash) => {
    const s = await loadSupplier(tx, supplierId, true);
    if (s.status !== 'pending') throw conflict('GF_SUPPLIER_STATUS', `供应商现在是「${s.status === 'reviewing' ? '审核中' : '已入库或停用'}」，不能再提交入库`);
    const id = await insertDoc(
      tx,
      {
        docType: 'supplier_admission',
        title: `供应商入库：${s.name}`,
        payload: { supplierId, version: s.version },
        flags: ['new_supplier'],
        clientKey,
        requestHash,
      },
      actor,
      todayIn(deps.config.timezone),
    );
    const doc = await loadDoc(tx, id, true);
    await submitFlow(tx, doc, templateFor(doc), actor);
    await writeAudit(tx, { staffId: actor.id, action: 'gf_supply', targetType: 'gf_supplier', targetId: supplierId, detail: { op: 'admit', docId: id }, ip });
    return id;
  });
}

// ───────────────────────── 变更 ─────────────────────────

const ChangeInput = z.object({
  clientKey: uuid,
  reason: z.string().trim().min(2, '请写变更原因').max(300),
  changes: SupplierFields.partial().refine((c) => Object.keys(c).length > 0, '没有改任何内容'),
});

async function requestChange(deps: Deps, supplierId: number, raw: unknown, actor: Actor, ip?: string) {
  const parsed = parse(ChangeInput, raw);
  // 部分字段带默认值：只认请求里真的给了的字段
  const given = new Set(Object.keys((raw as { changes?: object })?.changes ?? {}));
  const input = { ...parsed, changes: Object.fromEntries(Object.entries(parsed.changes).filter(([k]) => given.has(k))) as typeof parsed.changes };
  return withDocKey(deps, input.clientKey, actor, { op: 'change', supplierId, ...input, clientKey: undefined }, async (tx, requestHash) => {
    const s = await loadSupplier(tx, supplierId, true);
    if (s.status !== 'active' && s.status !== 'disabled') throw conflict('GF_SUPPLIER_STATUS', '已入库（或停用）的供应商才能走变更；还没入库的直接改档案再提交入库');
    if (s.pendingChangeDocId !== null) throw conflict('GF_CHANGE_PENDING', '这个供应商已有在审的变更，审完再发起新的');
    const fields = (Object.keys(input.changes) as SupplierField[]).filter((f) => JSON.stringify(input.changes[f as keyof typeof input.changes]) !== JSON.stringify(s[f as keyof SupplierRow]));
    if (!fields.length) throw unprocessable('GF_NO_CHANGE', '改的内容与现在一样');
    if (input.changes.creditCode !== undefined) {
      checkCredit(input.changes.creditCode);
      const dup = await dupOf(tx, input.changes.creditCode, supplierId);
      if (dup) throw conflict('GF_SUPPLIER_DUP', `统一社会信用代码已被 ${dup.name} 占用`);
    }
    const core = isCoreChange(fields, s.qualifications, input.changes.qualifications ?? s.qualifications);
    const id = await insertDoc(
      tx,
      {
        docType: 'supplier_change',
        title: `供应商${core ? '核心' : '一般'}变更：${s.name}（${fields.map((f) => SUPPLIER_FIELD_LABELS[f]).join('、')}）`,
        note: input.reason,
        payload: { supplierId, baseVersion: s.version, core, fields, changes: input.changes },
        clientKey: input.clientKey,
        requestHash,
      },
      actor,
      todayIn(deps.config.timezone),
    );
    const doc = await loadDoc(tx, id, true);
    await submitFlow(tx, doc, templateFor(doc), actor);
    await writeAudit(tx, { staffId: actor.id, action: 'gf_supply', targetType: 'gf_supplier', targetId: supplierId, detail: { op: 'change', docId: id, core, fields }, ip });
    return id;
  });
}

// ───────────────────────── SKU ─────────────────────────

const SkuLine = z.object({
  materialId: z.number().int().positive(),
  name: z.string().trim().min(1).max(80),
  spec: z.string().trim().max(60).default(''),
  unit: z.string().trim().min(1).max(10),
  priceCents: z.number().int().positive('协议价要大于 0').max(10_000_000_000),
  taxRateBp: z.number().int().min(0).max(3000).default(0),
  entityIds: z.array(z.number().int().positive()).max(20).default([]),
  formats: z.array(z.enum(BUSINESS_FORMATS)).max(4).default([]),
});
const BatchInput = z.object({ clientKey: uuid, supplierId: z.number().int().positive(), lines: z.array(SkuLine).min(1, '至少一个 SKU').max(200, '一批最多 200 个 SKU') });

/** 同一集团物料现有有效 SKU 的最低协议价（不算这几个） */
async function refPrice(db: Db, materialId: number, excludeIds: readonly number[] = []): Promise<number | null> {
  const [r] = await db<{ p: number | null }[]>`
    SELECT min(price_cents) AS p FROM gf_skus WHERE material_id = ${materialId} AND status = 'active' AND ${excludeIds.length ? db`id NOT IN ${db([...excludeIds])}` : db`true`}`;
  return r?.p === null || r?.p === undefined ? null : Number(r.p);
}

async function submitBatch(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(BatchInput, raw);
  return withDocKey(deps, input.clientKey, actor, { op: 'sku_batch', ...input, clientKey: undefined }, async (tx, requestHash) => {
    const s = await loadSupplier(tx, input.supplierId, true);
    if (s.status !== 'active') throw conflict('GF_SUPPLIER_STATUS', 'SKU 只能挂在「已入库」的供应商下');
    const mats = await tx<{ id: number; core: boolean; active: boolean }[]>`SELECT id, core, active FROM gf_materials WHERE id IN ${tx([...new Set(input.lines.map((l) => l.materialId))])}`;
    const matOf = new Map(mats.map((m) => [Number(m.id), m]));
    const flags = new Set<string>();
    let total = 0;
    for (const l of input.lines) {
      const m = matOf.get(l.materialId);
      if (!m?.active) throw unprocessable('GF_MATERIAL', `「${l.name}」映射的集团物料不存在或已停用`);
      const ab = skuAbnormal({ priceCents: l.priceCents, refCents: await refPrice(tx, l.materialId), prevCents: null, core: m.core });
      if (ab.includes('price_high')) flags.add('price_abnormal');
      if (ab.includes('core_category')) flags.add('core_category');
      total += l.priceCents;
    }
    const id = await insertDoc(
      tx,
      {
        docType: 'sku_batch',
        title: `SKU 提报：${s.name} ${input.lines.length} 个`,
        amountCents: total,
        payload: { supplierId: s.id, supplierVersion: s.version, decisions: {} },
        flags: [...flags],
        clientKey: input.clientKey,
        requestHash,
      },
      actor,
      todayIn(deps.config.timezone),
    );
    // 逐个建码：SKU-供应商编号尾号-序号
    const [{ n }] = (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM gf_skus WHERE supplier_id = ${s.id}`) as unknown as [{ n: number }];
    let seq = n;
    for (const l of input.lines) {
      seq += 1;
      const code = `SKU-${s.supplierNo.replace(/^GYS/, '')}-${String(seq).padStart(3, '0')}`;
      await tx`
        INSERT INTO gf_skus (sku_code, supplier_id, material_id, name, spec, unit, price_cents, tax_rate_bp, entity_ids, formats, doc_id, created_by)
        VALUES (${code}, ${s.id}, ${l.materialId}, ${l.name}, ${l.spec}, ${l.unit}, ${l.priceCents}, ${l.taxRateBp}, ${l.entityIds}, ${l.formats}, ${id}, ${actor.id})`;
    }
    const doc = await loadDoc(tx, id, true);
    await submitFlow(tx, doc, templateFor(doc), actor);
    await writeAudit(tx, { staffId: actor.id, action: 'gf_supply', targetType: 'gf_doc', targetId: id, detail: { op: 'sku_batch', supplierId: s.id, count: input.lines.length }, ip });
    return id;
  });
}

async function batchReview(db: Db, doc: DocRow): Promise<SkuBatchReview> {
  const skus = await skuViews(db, db`k.doc_id = ${doc.id}`);
  const ids = skus.map((k) => k.id);
  const mats = new Map(
    (await db<{ id: number; core: boolean }[]>`SELECT id, core FROM gf_materials WHERE id IN ${db(skus.length ? [...new Set(skus.map((k) => k.materialId))] : [0])}`).map((m) => [
      Number(m.id),
      m.core,
    ]),
  );
  const normal: SkuBatchReview['normal'] = [];
  const abnormal: SkuBatchReview['abnormal'] = [];
  for (const k of skus) {
    const ref = await refPrice(db, k.materialId, ids);
    const reasons: SkuAbnormal[] = skuAbnormal({ priceCents: k.priceCents, refCents: ref, prevCents: null, core: mats.get(k.materialId) ?? false });
    if (reasons.length) abnormal.push({ skuId: k.id, skuCode: k.skuCode, name: k.name, priceCents: k.priceCents, refCents: ref, prevCents: null, reasons });
    else normal.push({ skuId: k.id, skuCode: k.skuCode, name: k.name, priceCents: k.priceCents, refCents: ref });
  }
  const [s] = await db<{ name: string }[]>`SELECT name FROM gf_suppliers WHERE id = ${Number(doc.payload.supplierId)}`;
  return {
    docId: doc.id,
    supplierName: s?.name ?? '',
    count: skus.length,
    totalCents: skus.reduce((a, k) => a + k.priceCents, 0),
    normal,
    abnormal,
    decisions: (doc.payload.decisions ?? {}) as Record<number, 'approve' | 'reject'>,
  };
}

const PriceInput = z.object({
  clientKey: uuid,
  priceCents: z.number().int().positive().max(10_000_000_000),
  taxRateBp: z.number().int().min(0).max(3000).optional(),
  reason: z.string().trim().min(2).max(300),
});

async function priceChange(deps: Deps, skuId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(PriceInput, raw);
  return withDocKey(deps, input.clientKey, actor, { op: 'sku_price', skuId, ...input, clientKey: undefined }, async (tx, requestHash) => {
    const [k] = await skuViews(tx, tx`k.id = ${skuId}`);
    if (!k) throw notFound('没有这个 SKU');
    await tx`SELECT 1 FROM gf_skus WHERE id = ${skuId} FOR UPDATE`;
    if (k.status !== 'active') throw conflict('GF_SKU_STATUS', '有效的 SKU 才能改协议价');
    if (k.pendingChangeDocId !== null) throw conflict('GF_CHANGE_PENDING', '这个 SKU 已有在审的协议价变更');
    if (input.priceCents === k.priceCents && (input.taxRateBp ?? k.taxRateBp) === k.taxRateBp) throw unprocessable('GF_NO_CHANGE', '协议价没有变');
    const [m] = await tx<{ core: boolean }[]>`SELECT core FROM gf_materials WHERE id = ${k.materialId}`;
    const ab = skuAbnormal({ priceCents: input.priceCents, refCents: await refPrice(tx, k.materialId, [k.id]), prevCents: k.priceCents, core: m!.core });
    const id = await insertDoc(
      tx,
      {
        docType: 'sku_price_change',
        title: `协议价变更：${k.supplierName} ${k.skuCode} ${k.name}`,
        note: input.reason,
        amountCents: input.priceCents,
        payload: { skuId, fromVersion: k.priceVersion, fromCents: k.priceCents, toCents: input.priceCents, taxRateBp: input.taxRateBp ?? k.taxRateBp, abnormal: ab },
        flags: ab.some((a) => a !== 'core_category') ? ['price_abnormal'] : [],
        clientKey: input.clientKey,
        requestHash,
      },
      actor,
      todayIn(deps.config.timezone),
    );
    const doc = await loadDoc(tx, id, true);
    await submitFlow(tx, doc, templateFor(doc), actor);
    await writeAudit(tx, { staffId: actor.id, action: 'gf_supply', targetType: 'gf_sku', targetId: skuId, detail: { op: 'price', docId: id, from: k.priceCents, to: input.priceCents }, ip });
    return id;
  });
}

// ───────────────────────── 审批钩子 ─────────────────────────

const supplierIdOf = (doc: DocRow) => Number(doc.payload.supplierId);

registerHooks('supplier_admission', {
  template: () => REVIEW,
  ccRoles: ['cfo', 'finance_chief'],
  beforeSubmit: async (tx, doc) => {
    const s = await loadSupplier(tx, supplierIdOf(doc), true);
    if (s.status !== 'pending' && !(s.status === 'reviewing' && s.admissionDocId === doc.id)) throw conflict('GF_SUPPLIER_STATUS', '供应商不在「待准入」，不能提交入库');
    const missing = qualificationProblems(s.categories, s.qualifications, new Date().toISOString().slice(0, 10));
    if (missing.length) throw unprocessable('GF_QUALIFICATION', `资料不全：${missing.join('；')}`, { missing });
    if (!s.bankAccount || !s.accountName) throw unprocessable('GF_QUALIFICATION', '请先填收款账户（开户行、账号、账户名）');
    await tx`UPDATE gf_suppliers SET status = 'reviewing', admission_doc_id = ${doc.id}, updated_at = now() WHERE id = ${s.id}`;
  },
  approved: async (tx, doc) => {
    await tx`UPDATE gf_suppliers SET status = 'active', updated_at = now() WHERE id = ${supplierIdOf(doc)}`;
    await snapshot(tx, supplierIdOf(doc), doc.id);
  },
  ended: async (tx, doc) => {
    await tx`UPDATE gf_suppliers SET status = 'pending', updated_at = now() WHERE id = ${supplierIdOf(doc)} AND status = 'reviewing' AND admission_doc_id = ${doc.id}`;
  },
});

registerHooks('supplier_change', {
  template: (doc) => (doc.payload.core ? REVIEW : [{ kind: 'role', role: 'supply_chain_head', stage: 'final' }]),
  ccRoles: (doc) => (doc.payload.core ? ['cfo', 'finance_chief'] : []),
  beforeSubmit: async (tx, doc) => {
    const s = await loadSupplier(tx, supplierIdOf(doc), true);
    if (s.version !== Number(doc.payload.baseVersion)) throw conflict('GF_STALE', '供应商资料已经变过，请重新发起变更');
    if (s.pendingChangeDocId !== null && s.pendingChangeDocId !== doc.id) throw conflict('GF_CHANGE_PENDING', '这个供应商已有在审的变更');
    await tx`UPDATE gf_suppliers SET pending_change_doc_id = ${doc.id}, updated_at = now() WHERE id = ${s.id}`;
  },
  approved: async (tx, doc) => {
    const c = doc.payload.changes as Partial<z.infer<typeof SupplierFields>>;
    const id = supplierIdOf(doc);
    if (c.creditCode !== undefined && (await dupOf(tx, c.creditCode, id))) throw conflict('GF_SUPPLIER_DUP', '统一社会信用代码已被别的供应商占用');
    await tx`
      UPDATE gf_suppliers SET
        name = coalesce(${c.name ?? null}, name), credit_code = coalesce(${c.creditCode ?? null}, credit_code),
        categories = coalesce(${c.categories ?? null}::text[], categories), contact = coalesce(${c.contact ?? null}, contact), phone = coalesce(${c.phone ?? null}, phone),
        address = coalesce(${c.address ?? null}, address), bank_name = coalesce(${c.bankName ?? null}, bank_name), bank_account = coalesce(${c.bankAccount ?? null}, bank_account),
        account_name = coalesce(${c.accountName ?? null}, account_name), note = coalesce(${c.note ?? null}, note),
        qualifications = coalesce(${c.qualifications ? tx.json(c.qualifications as never) : null}::jsonb, qualifications),
        version = version + 1, pending_change_doc_id = NULL, updated_at = now()
      WHERE id = ${id}`;
    await snapshot(tx, id, doc.id);
  },
  ended: async (tx, doc) => {
    await tx`UPDATE gf_suppliers SET pending_change_doc_id = NULL, updated_at = now() WHERE id = ${supplierIdOf(doc)} AND pending_change_doc_id = ${doc.id}`;
  },
});

const DecisionsInput = z.object({ decisions: z.array(z.object({ skuId: z.number().int().positive(), decision: z.enum(['approve', 'reject']) })).max(200) });

registerHooks('sku_batch', {
  template: () => REVIEW,
  ccRoles: ['cfo', 'finance_chief'],
  beforeSubmit: async (tx, doc) => {
    const s = await loadSupplier(tx, supplierIdOf(doc));
    if (s.status !== 'active') throw conflict('GF_SUPPLIER_STATUS', 'SKU 只能挂在「已入库」的供应商下');
  },
  // 董事长（终审）批：异常的 SKU 要逐个给结论，不能一键全过
  beforeApprove: async (tx, doc, _flow, ctx) => {
    if (!ctx.final) return;
    const review = await batchReview(tx, doc);
    if (!review.abnormal.length) return;
    const parsed = DecisionsInput.safeParse(ctx.extra ?? {});
    const given = new Map((parsed.success ? parsed.data.decisions : []).map((d) => [d.skuId, d.decision]));
    const missing = review.abnormal.filter((a) => !given.has(a.skuId));
    if (missing.length) {
      throw unprocessable('GF_SKU_DECISIONS', `有 ${missing.length} 个异常 SKU 要逐个给结论（同意或不同意），不能一键全过：${missing.map((m) => m.skuCode).join('、')}`, {
        skuIds: missing.map((m) => m.skuId),
      });
    }
    const decisions = Object.fromEntries(review.abnormal.map((a) => [a.skuId, given.get(a.skuId)!]));
    await tx`UPDATE gf_docs SET payload = payload || ${tx.json({ decisions } as never)} WHERE id = ${doc.id}`;
    doc.payload = { ...doc.payload, decisions };
  },
  approved: async (tx, doc) => {
    const decisions = (doc.payload.decisions ?? {}) as Record<string, string>;
    const skus = await tx<{ id: number; priceCents: number; taxRateBp: number }[]>`SELECT id, price_cents, tax_rate_bp FROM gf_skus WHERE doc_id = ${doc.id} AND status = 'reviewing' FOR UPDATE`;
    for (const k of skus) {
      if (decisions[String(k.id)] === 'reject') {
        await tx`UPDATE gf_skus SET status = 'rejected', updated_at = now() WHERE id = ${k.id}`;
        continue;
      }
      await tx`UPDATE gf_skus SET status = 'active', price_version = 1, updated_at = now() WHERE id = ${k.id}`;
      await tx`INSERT INTO gf_sku_prices (sku_id, version, price_cents, tax_rate_bp, doc_id) VALUES (${k.id}, 1, ${k.priceCents}, ${k.taxRateBp}, ${doc.id})`;
    }
  },
  ended: async (tx, doc, outcome) => {
    if (outcome !== 'returned') await tx`UPDATE gf_skus SET status = 'rejected', updated_at = now() WHERE doc_id = ${doc.id} AND status = 'reviewing'`;
  },
});

registerHooks('sku_price_change', {
  template: () => REVIEW,
  ccRoles: ['cfo', 'finance_chief'],
  beforeSubmit: async (tx, doc) => {
    const skuId = Number(doc.payload.skuId);
    const [k] = await tx<{ status: string; priceVersion: number; pendingChangeDocId: number | null }[]>`
      SELECT status, price_version, pending_change_doc_id FROM gf_skus WHERE id = ${skuId} FOR UPDATE`;
    if (k?.status !== 'active') throw conflict('GF_SKU_STATUS', '有效的 SKU 才能改协议价');
    if (k.priceVersion !== Number(doc.payload.fromVersion)) throw conflict('GF_STALE', '协议价已经变过，请重新发起');
    if (k.pendingChangeDocId !== null && Number(k.pendingChangeDocId) !== doc.id) throw conflict('GF_CHANGE_PENDING', '这个 SKU 已有在审的协议价变更');
    await tx`UPDATE gf_skus SET pending_change_doc_id = ${doc.id}, updated_at = now() WHERE id = ${skuId}`;
  },
  approved: async (tx, doc) => {
    const skuId = Number(doc.payload.skuId);
    const version = Number(doc.payload.fromVersion) + 1;
    await tx`INSERT INTO gf_sku_prices (sku_id, version, price_cents, tax_rate_bp, doc_id) VALUES (${skuId}, ${version}, ${Number(doc.payload.toCents)}, ${Number(doc.payload.taxRateBp)}, ${doc.id})`;
    await tx`UPDATE gf_skus SET price_cents = ${Number(doc.payload.toCents)}, tax_rate_bp = ${Number(doc.payload.taxRateBp)}, price_version = ${version}, pending_change_doc_id = NULL, updated_at = now() WHERE id = ${skuId}`;
  },
  ended: async (tx, doc) => {
    await tx`UPDATE gf_skus SET pending_change_doc_id = NULL, updated_at = now() WHERE id = ${Number(doc.payload.skuId)} AND pending_change_doc_id = ${doc.id}`;
  },
});

// ───────────────────────── 路由 ─────────────────────────

const MaterialInput = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,30}$/, '物料编码是 2–30 位大写字母、数字或横线'),
  name: z.string().trim().min(1).max(60),
  category: z.enum(SUPPLY_CATEGORIES),
  unit: z.string().trim().min(1).max(10),
  core: z.boolean().default(false),
});
const ImportInput = z.object({
  rows: z
    .array(SupplierFields.extend({ clientKey: uuid }))
    .min(1)
    .max(500),
});
const StatusInput = z.object({ status: z.enum(['active', 'disabled', 'exited']), reason: z.string().trim().min(2).max(200) });

export function registerSupplyRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const tz = deps.config.timezone;
  const signedIn = guard();
  const staffOnly: preHandlerAsyncHookHandler = async function (req, reply) {
    await signedIn.call(this, req, reply);
    if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(req.actor.role)) throw forbidden('这个账号不能用业财法审批');
  };
  const manager = async (actor: Actor) => {
    if (!(await isSupplyManager(sql, actor))) throw forbidden('只有供应链负责人或店主能做这一步');
  };
  const supplier = async (actor: Actor, id: number) => (await toViews(sql, actor, [await loadSupplier(sql, id)], tz))[0]!;

  app.get('/api/gf/materials', { preHandler: staffOnly }, async (): Promise<GfMaterial[]> => {
    const rows = await sql<GfMaterial[]>`SELECT id, code, name, category, unit, core, active FROM gf_materials ORDER BY code`;
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  });
  app.post('/api/gf/materials', { preHandler: staffOnly }, async (req) => {
    await manager(req.actor);
    const input = parse(MaterialInput, req.body);
    try {
      const [r] = await sql<{ id: number }[]>`
        INSERT INTO gf_materials (code, name, category, unit, core, created_by) VALUES (${input.code}, ${input.name}, ${input.category}, ${input.unit}, ${input.core}, ${req.actor.id}) RETURNING id`;
      await writeAudit(sql, { staffId: req.actor.id, action: 'gf_supply', targetType: 'gf_material', targetId: Number(r!.id), detail: { op: 'material', ...input }, ip: req.ip });
      return { id: Number(r!.id) };
    } catch (error) {
      if (isUniqueViolation(error, 'gf_materials_code_key')) throw conflict('GF_MATERIAL_DUP', '物料编码已存在');
      throw error;
    }
  });

  app.get('/api/gf/suppliers', { preHandler: staffOnly }, async (req) => {
    const { status, q } = parse(z.object({ status: z.enum(['pending', 'reviewing', 'active', 'disabled', 'exited']).optional(), q: z.string().trim().max(40).optional() }), req.query ?? {});
    const where = sql`${status ? sql`s.status = ${status}` : sql`true`} AND ${q ? sql`(s.name ILIKE ${`%${q}%`} OR s.credit_code = ${q.toUpperCase()} OR s.supplier_no = ${q})` : sql`true`}`;
    return toViews(sql, req.actor, await supplierRows(sql, where), tz);
  });
  app.post('/api/gf/suppliers', { preHandler: staffOnly }, async (req) => supplier(req.actor, await createSupplier(deps, req.body, req.actor, req.ip)));
  app.get('/api/gf/suppliers/:id', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const versions = await sql<{ version: number; docId: number | null; createdAt: Date }[]>`
      SELECT version, doc_id, created_at FROM gf_supplier_versions WHERE supplier_id = ${id} ORDER BY version`;
    return {
      supplier: await supplier(req.actor, id),
      skus: await skuViews(sql, sql`k.supplier_id = ${id}`),
      versions: versions.map((v) => ({ version: v.version, docId: v.docId === null ? null : Number(v.docId), createdAt: iso(v.createdAt) })),
    };
  });
  // 待准入的（还没提交、被退回的）建档人或供应链负责人可以改资料
  app.post('/api/gf/suppliers/:id/edit', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(SupplierFields, req.body);
    checkCredit(input.creditCode);
    await sql.begin(async (tx) => {
      const s = await loadSupplier(tx, id, true);
      if (s.status !== 'pending') throw conflict('GF_SUPPLIER_STATUS', '只有「待准入」的能直接改；已入库的走变更');
      if (s.createdBy !== req.actor.id && !(await isSupplyManager(tx, req.actor))) throw forbidden('只有建档人或供应链负责人能改');
      if (await dupOf(tx, input.creditCode, id)) throw conflict('GF_SUPPLIER_DUP', '统一社会信用代码已在库里');
      await tx`
        UPDATE gf_suppliers SET name = ${input.name}, credit_code = ${input.creditCode}, categories = ${input.categories}, contact = ${input.contact}, phone = ${input.phone},
          address = ${input.address}, bank_name = ${input.bankName}, bank_account = ${input.bankAccount}, account_name = ${input.accountName},
          qualifications = ${tx.json(input.qualifications as never)}, note = ${input.note}, updated_at = now()
        WHERE id = ${id}`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'gf_supply', targetType: 'gf_supplier', targetId: id, detail: { op: 'edit' }, ip: req.ip });
    });
    return supplier(req.actor, id);
  });
  app.post('/api/gf/suppliers/:id/admit', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { clientKey } = parse(z.object({ clientKey: uuid }), req.body);
    return { docId: await admit(deps, id, clientKey, req.actor, req.ip) };
  });
  app.post('/api/gf/suppliers/:id/change', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { docId: await requestChange(deps, id, req.body, req.actor, req.ip) };
  });
  app.post('/api/gf/suppliers/:id/status', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(StatusInput, req.body);
    await manager(req.actor);
    await sql.begin(async (tx) => {
      const s = await loadSupplier(tx, id, true);
      const ok =
        (input.status === 'disabled' && s.status === 'active') ||
        (input.status === 'active' && s.status === 'disabled' && s.admissionDocId !== null) ||
        (input.status === 'exited' && (s.status === 'active' || s.status === 'disabled' || s.status === 'pending'));
      if (!ok) throw conflict('GF_SUPPLIER_STATUS', '现在的状态不能这样改');
      await tx`UPDATE gf_suppliers SET status = ${input.status}, updated_at = now() WHERE id = ${id}`;
      if (input.status === 'exited') await tx`UPDATE gf_skus SET status = 'disabled', updated_at = now() WHERE supplier_id = ${id} AND status = 'active'`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'gf_supply',
        targetType: 'gf_supplier',
        targetId: id,
        detail: { op: 'status', from: s.status, to: input.status, reason: input.reason },
        ip: req.ip,
      });
    });
    return supplier(req.actor, id);
  });
  // 历史数据迁移：一律「待准入」（legacy），要走入库审批才能用；查重的跳过并说明
  app.post('/api/gf/suppliers/import', { preHandler: staffOnly, bodyLimit: 4 * 1024 * 1024 }, async (req): Promise<SupplierImportResult> => {
    await manager(req.actor);
    const { rows } = parse(ImportInput, req.body);
    const out: SupplierImportResult = { created: 0, skipped: [] };
    for (const [i, row] of rows.entries()) {
      const problem = creditCodeProblem(row.creditCode);
      if (problem) {
        out.skipped.push({ row: i + 1, name: row.name, reason: problem });
        continue;
      }
      const dup = await dupOf(sql, row.creditCode);
      if (dup) {
        out.skipped.push({ row: i + 1, name: row.name, reason: `统一社会信用代码已在库里（${dup.name}）` });
        continue;
      }
      await createSupplier(deps, row, req.actor, req.ip, true);
      out.created += 1;
    }
    return out;
  });

  app.post('/api/gf/sku-batches', { preHandler: staffOnly }, async (req) => ({ docId: await submitBatch(deps, req.body, req.actor, req.ip) }));
  app.get('/api/gf/sku-batches/:id/review', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const doc = await loadDoc(sql, id);
    if (doc.docType !== 'sku_batch') throw notFound('不是 SKU 提报');
    return batchReview(sql, doc);
  });
  app.post('/api/gf/skus/:id/price', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { docId: await priceChange(deps, id, req.body, req.actor, req.ip) };
  });
  app.get('/api/gf/skus/:id/prices', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const rows = await sql<{ version: number; priceCents: number; taxRateBp: number; docId: number; createdAt: Date }[]>`
      SELECT version, price_cents, tax_rate_bp, doc_id, created_at FROM gf_sku_prices WHERE sku_id = ${id} ORDER BY version`;
    return rows.map((r) => ({ version: r.version, priceCents: Number(r.priceCents), taxRateBp: r.taxRateBp, docId: Number(r.docId), createdAt: iso(r.createdAt) }));
  });

  // 选择器：只给已入库的；状态不明（查不到、在审核中、停用）一律不给
  app.get('/api/gf/selector/suppliers', { preHandler: staffOnly }, async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().max(40).optional() }), req.query ?? {});
    const rows = await supplierRows(sql, sql`s.status = 'active' AND ${q ? sql`(s.name ILIKE ${`%${q}%`} OR s.credit_code = ${q.toUpperCase()})` : sql`true`}`);
    return rows.map((r) => ({ id: r.id, supplierNo: r.supplierNo, name: r.name, categories: r.categories, skuCount: r.skuCount, changePending: r.pendingChangeDocId !== null }));
  });
  app.get('/api/gf/selector/suppliers/:id/skus', { preHandler: staffOnly }, async (req) => {
    const { id } = parse(idParam, req.params);
    const lib = await inLibrary(sql, id);
    const [s] = await sql<{ status: string }[]>`SELECT status FROM gf_suppliers WHERE id = ${id}`;
    if (s?.status !== 'active') throw conflict('GF_SUPPLIER_NOT_ACTIVE', '这个供应商不是「已入库」，不能选');
    return { changePending: !lib.ok, skus: await skuViews(sql, sql`k.supplier_id = ${id} AND k.status = 'active'`) };
  });
}
