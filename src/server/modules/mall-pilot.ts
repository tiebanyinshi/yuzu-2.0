// 采购商城试点（8.1.51，店主 2026-11-26，docs/MALL_V8151.md）：
//   · 退回以后在原单上补资料、重新提交（单号不变；退回原因与每一次补资料都留在记录里）
//   · 需求池「接单」：哪位供应链 BP 在跟这张单
//   · 成交方案：BP 在微信上跟供应商谈好，回到系统记下供应商、含税单价、运费、交期与报价截图；部门在系统里确认，或 BP 记「已在微信确认」。
//     部门看得到方案说明、供应商、交期，看不到价格与截图（店主 2026-11-24：成交价不给商城）。转采购单时带上选定方案的供应商与单价
// 路由在 shop.ts（/api/erp/shop/…），返回的整张单由 mall.ts 的 mallRequest 拼。

import { z } from 'zod';
import { can } from '@shared/permissions';
import { REQUEST_PRIORITIES, type MallCustomSpec } from '@shared/requests';
import type { MallQuote } from '@shared/mall';
import type { Db, Tx } from '../db';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { setTxTimeouts } from '../lib/tx';
import { parse } from '../lib/validate';
import { docDateSchema, logApproval } from './inventory/common';
import { erpOpAbandoned } from './erp-ops';
import { clearStockDecisions, enterStockCheck, hasIssuedLines } from './request-stock';
import { approvableOnFor, deptConfirmFor, isHeadOf, lockRequest, myContext, validateLines, type LineWrite } from './requests';

const id = z.number().int().positive();

/** 看得到价格与报价截图的：采购经办、采购审核、店主 */
export const canSeeDealPrices = (actor: Actor) => actor.role === 'owner' || can(actor, 'purchase.manage') || can(actor, 'request.review');
/** 能接单、记方案的：采购经办、采购审核 */
const canSource = (actor: Actor) => actor.role === 'owner' || can(actor, 'purchase.manage') || can(actor, 'request.review');

// ───────────────────────── 定制的要求写成一段话（ERP 的「规格与技术要求」里看） ─────────────────────────

export const CustomSpecInput = z.object({
  size: z.string().trim().max(120, '尺寸规格最多 120 个字').default(''),
  craft: z.string().trim().max(200, '材质工艺最多 200 个字').default(''),
  scene: z.string().trim().max(200, '使用场景最多 200 个字').default(''),
  sample: z.boolean().default(false),
  budgetCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
});

/** 定制：「【定制】尺寸…；材质工艺…；使用场景…；需要先打样；预算 ¥…」+ 部门写的说明（合起来不超过 1000 个字） */
export function customDetails(details: string, spec: MallCustomSpec | null): string {
  if (!spec) return details;
  const parts = [
    spec.size && `尺寸规格：${spec.size}`,
    spec.craft && `材质工艺：${spec.craft}`,
    spec.scene && `使用场景：${spec.scene}`,
    spec.sample ? '需要先打样确认' : '不用打样',
    spec.budgetCents !== null && `预算约 ¥${(spec.budgetCents / 100).toFixed(2)}`,
  ].filter(Boolean);
  const head = `【定制】${parts.join('；')}`;
  const all = details ? `${head}\n${details}` : head;
  // 合起来超过 1000 字不截断（Codex 审查：截掉的验收要求就丢了），让部门删短一点
  if (all.length > 1000) throw unprocessable('DETAILS_TOO_LONG', `定制要求与设计说明合起来最多 1000 个字（现在 ${all.length} 个），请把设计说明写短一点`);
  return all;
}

/** 拆回部门写的说明（改单时回显用） */
export function plainDetails(details: string, kind: string | null): string {
  if (kind !== 'custom' || !details.startsWith('【定制】')) return details;
  const i = details.indexOf('\n');
  return i < 0 ? '' : details.slice(i + 1);
}

// ───────────────────────── 退回后在原单补资料 ─────────────────────────

const ResubmitLine = z.object({
  id,
  qtyMilli: z.number().int().positive('数量必须大于 0').max(1_000_000_000),
  /** 以下只对自主申请的行有用（选品的行只能改数量、删行） */
  name: z.string().trim().min(1, '请填写物品名称').max(100).optional(),
  unit: z.string().trim().min(1).max(8).optional(),
  details: z.string().trim().max(1000).optional(),
  brandModel: z.string().trim().max(150).optional(),
  link: z.string().trim().max(1000).optional(),
  reasonText: z.string().trim().max(1000).optional(),
  expectedCategory: z.string().trim().max(32).optional(),
  customKind: z.enum(['standard', 'custom']).optional(),
  customSpec: CustomSpecInput.nullable().optional(),
  imageIds: z.array(id).max(9).optional(),
});

const ResubmitInput = z.object({
  /** 操作编号（Codex 审查）：页面本机先记下再发；回复丢了在页面顶部查回 / 原样重提 / 确认作废（mall_resubmit） */
  clientKey: z.uuid('缺少操作编号，请刷新页面后重试'),
  /** 页面看到的这张单的修改时间：之后又被退回、改过的拒绝（晚到的旧请求不盖掉之后的修改） */
  expectedUpdatedAt: z.string().min(10),
  contactName: z.string().trim().min(1, '请填写经办人').max(40),
  budgetProject: z.string().trim().min(1, '请填写预算项目 / 费用归属').max(80),
  needBy: docDateSchema,
  deliveryAddress: z.string().trim().min(1, '请填写收货地点').max(120),
  priority: z.enum(REQUEST_PRIORITIES),
  note: z.string().trim().max(500).default(''),
  /** 补资料说明：补了什么（记进审批记录，审核的人一眼看得到） */
  remark: z.string().trim().min(1, '请写一句补了什么').max(200),
  lines: z.array(ResubmitLine).min(1, '至少留一行').max(50),
});

interface StoredLine {
  id: number;
  materialId: number | null;
  name: string;
  purpose: string;
  qtyMilli: number;
  unit: string;
  link: string;
  details: string;
  refPriceCents: number | null;
  note: string;
  supplierId: number | null;
  mallSkuCode: string;
  priceVersion: string;
  brandModel: string;
  expectedCategory: string;
  reasonText: string;
  freightCents: number | null;
  taxRateBp: number | null;
  customKind: 'standard' | 'custom' | null;
  customSpec: MallCustomSpec | null;
  imageIds: number[];
}

/**
 * 退回的商城单：提单人（或店主）在原单上补资料、重新提交。单号、来源、门店、主体、部门不变；明细按页面给的整组重写（删掉的行不要了），
 * 选品的行只能改数量；自主申请的行能改全部内容。重新提交按这一次算主管确认与核库，与第一次提交一样。
 */
export async function resubmitMallRequest(deps: Deps, requestId: number, raw: unknown, actor: Actor, ip?: string): Promise<void> {
  const input = parse(ResubmitInput, raw);
  const requestHash = hashRequest({ op: 'mall_resubmit', requestId, ...input, clientKey: undefined });
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const r = await lockRequest(tx, requestId);
    await assertNotFenced(tx, input.clientKey, 'mall_resubmit', erpOpAbandoned);
    const [done] = await tx<{ opType: string; requestHash: string; staffId: number }[]>`
      SELECT op_type, request_hash, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (done) {
      // 同一个编号原样重提：第一次已经提交，不再写
      if (done.opType !== 'mall_resubmit' || done.requestHash !== requestHash || Number(done.staffId) !== actor.id) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一笔内容不同的补资料');
      return;
    }
    if (r.source !== 'mall') throw conflict('NOT_MALL', '这张需求单不是采购商城提的，请在 ERP 的采购需求单里改');
    if (r.requesterId !== actor.id && actor.role !== 'owner') throw forbidden('只能补自己提的需求单');
    if (r.status !== 'returned') throw conflict('INVALID_STATE', '只有被退回的需求单能在原单上补资料');
    const [seen] = await tx<{ same: boolean }[]>`
      SELECT date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ${input.expectedUpdatedAt}::timestamptz) AS same FROM purchase_requests WHERE id = ${requestId}`;
    if (!seen?.same) throw conflict('REQUEST_CHANGED', '这张需求单刚有变动，刷新后再补');
    if (await hasIssuedLines(tx, requestId)) throw conflict('STOCK_ISSUED_LOCKED', '这张需求单已经有行从库存领用，不能再改');
    const stored = await storedLines(tx, requestId);
    const byId = new Map(stored.map((l) => [l.id, l]));
    if (new Set(input.lines.map((l) => l.id)).size !== input.lines.length) throw badRequest('同一行出现了两次');
    const lines: LineWrite[] = input.lines.map((x) => {
      const old = byId.get(x.id);
      if (!old) throw unprocessable('LINE_NOT_FOUND', '有一行不属于这张需求单，刷新后再补');
      if (old.mallSkuCode) return { ...old, qtyMilli: x.qtyMilli };
      const kind = x.customKind ?? old.customKind ?? 'standard';
      const spec = kind === 'custom' ? (x.customSpec === undefined ? old.customSpec : x.customSpec) : null;
      const link = x.link ?? old.link;
      if (link && !/^https?:\/\/\S+$/i.test(link)) throw unprocessable('LINK_INVALID', '参考链接要以 http:// 或 https:// 开头');
      const details = x.details ?? plainDetails(old.details, old.customKind);
      if (!details.trim() && kind === 'standard') throw unprocessable('DETAILS_REQUIRED', '请填写规格型号');
      return {
        ...old,
        qtyMilli: x.qtyMilli,
        name: x.name ?? old.name,
        unit: x.unit ?? old.unit,
        link,
        details: customDetails(details, spec),
        brandModel: x.brandModel ?? old.brandModel,
        reasonText: x.reasonText ?? old.reasonText,
        expectedCategory: x.expectedCategory ?? old.expectedCategory,
        customKind: kind,
        customSpec: spec,
        imageIds: x.imageIds ?? old.imageIds,
      };
    });
    await validateLines(tx, lines, { mall: true });
    await assertMoq(tx, lines);
    await clearStockDecisions(tx, requestId);
    await rewriteLinesInPlace(
      tx,
      requestId,
      stored,
      input.lines.map((x) => x.id),
      lines,
    );
    const approvableOn = await approvableOnFor(tx, deps.config.timezone);
    const confirm = await deptConfirmFor(tx, r.departmentId, actor, lines, true);
    await tx`
      UPDATE purchase_requests SET need_by = ${input.needBy}, note = ${input.note}, priority = ${input.priority}, contact_name = ${input.contactName},
             budget_project = ${input.budgetProject}, delivery_address = ${input.deliveryAddress},
             status = 'submitted', reason = NULL, submitted_at = now(), approvable_on = ${approvableOn}, updated_at = now(),
             dept_confirm = ${confirm.state}, dept_head_id = ${confirm.headId},
             dept_confirmed_by = ${confirm.state === 'confirmed' ? actor.id : null}, dept_confirmed_at = ${confirm.state === 'confirmed' ? tx`now()` : null}
      WHERE id = ${requestId}`;
    // 审批记录：先记补了什么（修改），再记重新提交
    await logApproval(tx, 'purchase_request', requestId, 'revise', actor.id, `补资料：${input.remark}`);
    await logApproval(tx, 'purchase_request', requestId, 'submit', actor.id);
    await enterStockCheck(tx, requestId);
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'purchase_request',
      targetType: 'purchase_request',
      targetId: requestId,
      detail: { action: 'mall_resubmit', remark: input.remark, lines: lines.length },
      ip,
    });
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'mall_resubmit', ${requestHash}, ${requestId}, ${actor.id})`;
  });
}

/** 选品的行改了数量（Codex 审查）：按这个 SKU 现在的起订量再核一遍，与第一次从清单提交一样（BELOW_MOQ） */
async function assertMoq(db: Db, lines: LineWrite[]) {
  const codes = [...new Set(lines.map((l) => l.mallSkuCode).filter((c): c is string => !!c))];
  if (!codes.length) return;
  const moq = new Map((await db<{ skuCode: string; moqMilli: number }[]>`SELECT sku_code, moq_milli FROM mall_skus WHERE sku_code IN ${db(codes)}`).map((k) => [k.skuCode, Number(k.moqMilli)]));
  for (const l of lines) {
    const min = l.mallSkuCode ? moq.get(l.mallSkuCode) : undefined;
    if (min !== undefined && l.qtyMilli < min) throw unprocessable('BELOW_MOQ', `「${l.name}」低于起订量，请改数量`);
  }
}

/**
 * 原单补资料写回明细（Codex 审查）：留下的行按原来的编号原地改（成交方案挂在行上，删了重写会撞外键），删掉的行连同它的方案一起删；
 * 行号按页面的顺序重排。内容变了，原来选定的方案退回「待确认」，请部门重新确认
 */
async function rewriteLinesInPlace(tx: Db, requestId: number, stored: StoredLine[], keepIds: number[], lines: LineWrite[]) {
  const gone = stored.map((l) => l.id).filter((x) => !keepIds.includes(x));
  if (gone.length) {
    await tx`DELETE FROM mall_request_quotes WHERE line_id IN ${tx(gone)}`;
    await tx`DELETE FROM purchase_request_line_images WHERE request_line_id IN ${tx(gone)}`;
    await tx`DELETE FROM purchase_request_lines WHERE id IN ${tx(gone)}`;
  }
  // 先挪开行号，免得重排时撞「一张单里行号不重复」
  await tx`UPDATE purchase_request_lines SET line_no = line_no + 1000 WHERE request_id = ${requestId}`;
  for (const [i, l] of lines.entries()) {
    const lineId = keepIds[i]!;
    await tx`
      UPDATE purchase_request_lines SET line_no = ${i + 1}, name = ${l.name}, qty_milli = ${l.qtyMilli}, unit = ${l.unit}, link = ${l.link}, details = ${l.details},
             brand_model = ${l.brandModel ?? ''}, expected_category = ${l.expectedCategory ?? ''}, reason_text = ${l.reasonText ?? ''},
             custom_kind = ${l.customKind ?? null}, custom_spec = ${l.customSpec ? tx.json(l.customSpec as never) : null}
      WHERE id = ${lineId} AND request_id = ${requestId}`;
    await tx`DELETE FROM purchase_request_line_images WHERE request_line_id = ${lineId}`;
    for (const [k, imageId] of l.imageIds.entries()) await tx`INSERT INTO purchase_request_line_images (request_line_id, sort_no, image_id) VALUES (${lineId}, ${k + 1}, ${imageId})`;
  }
  await tx`UPDATE mall_request_quotes SET status = 'proposed', selected_mode = NULL, selected_by = NULL, selected_at = NULL WHERE request_id = ${requestId} AND status = 'selected'`;
}

async function storedLines(db: Db, requestId: number): Promise<StoredLine[]> {
  const rows = await db<(Omit<StoredLine, 'imageIds'> & { imageIds: number[] | null })[]>`
    SELECT l.id, l.material_id, l.name, l.purpose, l.qty_milli, l.unit, l.link, l.details, l.ref_price_cents, l.note, l.supplier_id,
           l.mall_sku_code, l.price_version, l.brand_model, l.expected_category, l.reason_text, l.freight_cents, l.tax_rate_bp,
           l.custom_kind, l.custom_spec,
           (SELECT array_agg(i.image_id ORDER BY i.sort_no) FROM purchase_request_line_images i WHERE i.request_line_id = l.id) AS image_ids
    FROM purchase_request_lines l WHERE l.request_id = ${requestId} ORDER BY l.line_no`;
  return rows.map((l) => ({
    ...l,
    id: Number(l.id),
    materialId: l.materialId === null ? null : Number(l.materialId),
    qtyMilli: Number(l.qtyMilli),
    refPriceCents: l.refPriceCents === null ? null : Number(l.refPriceCents),
    supplierId: l.supplierId === null ? null : Number(l.supplierId),
    freightCents: l.freightCents === null ? null : Number(l.freightCents),
    taxRateBp: l.taxRateBp === null ? null : Number(l.taxRateBp),
    imageIds: (l.imageIds ?? []).map(Number),
  }));
}

// ───────────────────────── 需求池接单 ─────────────────────────

/** 接单 / 放回：没人接的谁都能接（要能记方案的）；接了的只有接单的人能放回，审核的人可以改派给自己（take: true） */
export async function claimMallRequest(deps: Deps, requestId: number, raw: unknown, actor: Actor, ip?: string): Promise<void> {
  const { clientKey, release, take } = parse(QuoteActKey.extend({ release: z.boolean().default(false), take: z.boolean().default(false) }), raw ?? {});
  if (!canSource(actor)) throw forbidden('只有采购（供应链 BP）能接单');
  // 接单、放回也走「结果待确认」（Codex 审查，与选定 / 撤下方案同一类 mall_quote_act）：确认作废的晚到不会删掉之后别人接的单
  const requestHash = hashRequest({ op: 'mall_claim', requestId, release, take });
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const r = await lockRequest(tx, requestId);
    if (await quoteActDone(tx, clientKey, requestHash, actor)) return;
    if (r.source !== 'mall') throw conflict('NOT_MALL', '这张需求单不是采购商城提的');
    if (!['submitted', 'approved'].includes(r.status)) throw conflict('INVALID_STATE', '只有审核中、已通过的需求单能接单');
    // 接单记在 mall_request_sourcing（Codex 审查：需求单通过后整行不能改）；需求单一行已经锁着，同一张单的接单、放回串行
    const [cur] = await tx<{ ownerId: number | null }[]>`SELECT owner_id FROM mall_request_sourcing WHERE request_id = ${requestId}`;
    const owner = cur?.ownerId === null || cur?.ownerId === undefined ? null : Number(cur.ownerId);
    if (release) {
      if (owner === null) return quoteActRecord(tx, clientKey, requestHash, requestId, actor);
      if (owner !== actor.id && actor.role !== 'owner' && !can(actor, 'request.review')) throw forbidden('只有接单的人能放回需求池');
      await tx`DELETE FROM mall_request_sourcing WHERE request_id = ${requestId}`;
    } else {
      if (owner === actor.id) return quoteActRecord(tx, clientKey, requestHash, requestId, actor);
      if (owner !== null && !(take && (actor.role === 'owner' || can(actor, 'request.review')))) throw conflict('ALREADY_CLAIMED', '这张单已经有人接了');
      await tx`
        INSERT INTO mall_request_sourcing (request_id, owner_id) VALUES (${requestId}, ${actor.id})
        ON CONFLICT (request_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, claimed_at = now()`;
    }
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'purchase_request',
      targetType: 'purchase_request',
      targetId: requestId,
      detail: { action: release ? 'mall_release' : 'mall_claim', from: owner },
      ip,
    });
    await quoteActRecord(tx, clientKey, requestHash, requestId, actor);
  });
}

// ───────────────────────── 成交方案 ─────────────────────────

const QuoteInput = z.object({
  clientKey: z.uuid('缺少操作编号，请刷新页面后重试'),
  lineId: id,
  supplierId: id.nullable().default(null),
  supplierName: z.string().trim().max(80).default(''),
  unitPriceCents: z.number().int().min(0).max(100_000_000),
  taxRateBp: z.number().int().min(0).max(10_000),
  freightCents: z.number().int().min(0).max(100_000_000).default(0),
  leadDays: z.number().int().min(0).max(365),
  validUntil: docDateSchema.nullable().default(null),
  planNote: z.string().trim().max(500).default(''),
  internalNote: z.string().trim().max(500).default(''),
  imageIds: z.array(id).max(9).default([]),
  recommended: z.boolean().default(false),
});

/**
 * 记一条方案：接单的人（或审核的人、店主）；需求单要在审核中或已通过。
 * 「结果待确认」用自己的操作类型 mall_quote（按采购权限查回、作废，Codex 审查）：页面本机先记下再发；同一个编号原样重提返回第一次那条，内容不同的拒绝；确认作废的编号晚到也不记
 */
export async function addQuote(deps: Deps, requestId: number, raw: unknown, actor: Actor, ip?: string): Promise<void> {
  const input = parse(QuoteInput, raw);
  if (!canSource(actor)) throw forbidden('只有采购（供应链 BP）能记成交方案');
  const requestHash = hashRequest({ op: 'mall_quote', requestId, ...input, clientKey: undefined });
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const r = await lockRequest(tx, requestId);
    await assertNotFenced(tx, input.clientKey, 'mall_quote', erpOpAbandoned);
    const [done] = await tx<{ opType: string; requestHash: string; staffId: number }[]>`
      SELECT op_type, request_hash, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (done) {
      if (done.opType !== 'mall_quote' || done.requestHash !== requestHash || Number(done.staffId) !== actor.id) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一笔内容不同的方案');
      return;
    }
    if (r.source !== 'mall') throw conflict('NOT_MALL', '这张需求单不是采购商城提的');
    if (!['submitted', 'approved'].includes(r.status)) throw conflict('INVALID_STATE', '只有审核中、已通过的需求单能记方案');
    await assertSourcer(tx, requestId, actor);
    const [line] = await tx<{ id: number }[]>`SELECT id FROM purchase_request_lines WHERE id = ${input.lineId} AND request_id = ${requestId}`;
    if (!line) throw unprocessable('LINE_NOT_FOUND', '这一行不属于这张需求单');
    let supplierName = input.supplierName;
    if (input.supplierId !== null) {
      const [s] = await tx<{ name: string; active: boolean }[]>`SELECT name, active FROM suppliers WHERE id = ${input.supplierId}`;
      if (!s?.active) throw unprocessable('SUPPLIER_INVALID', '供应商不存在或已停用');
      supplierName = s.name;
    }
    if (!supplierName) throw unprocessable('SUPPLIER_REQUIRED', '请选择供应商，或写上供应商名称（还没建档的）');
    if (input.imageIds.length) {
      const ok = await tx<{ id: number }[]>`SELECT id FROM erp_images WHERE id IN ${tx(input.imageIds)} AND scope = 'quote'`;
      if (ok.length !== new Set(input.imageIds).size) throw unprocessable('IMAGE_INVALID', '有的截图不存在，重新上传再试');
    }
    if (input.recommended) await tx`UPDATE mall_request_quotes SET recommended = false WHERE line_id = ${input.lineId} AND status = 'proposed'`;
    const [q] = await tx<{ id: number }[]>`
      INSERT INTO mall_request_quotes (request_id, line_id, client_key, supplier_id, supplier_name, unit_price_cents, tax_rate_bp, freight_cents,
                                       lead_days, valid_until, plan_note, internal_note, image_ids, recommended, created_by)
      VALUES (${requestId}, ${input.lineId}, ${input.clientKey}, ${input.supplierId}, ${supplierName}, ${input.unitPriceCents}, ${input.taxRateBp},
              ${input.freightCents}, ${input.leadDays}, ${input.validUntil}, ${input.planNote}, ${input.internalNote}, ${input.imageIds},
              ${input.recommended}, ${actor.id})
      RETURNING id`;
    // 记了方案还没人接的：顺手算接单
    await tx`INSERT INTO mall_request_sourcing (request_id, owner_id) VALUES (${requestId}, ${actor.id}) ON CONFLICT (request_id) DO NOTHING`;
    await writeAudit(tx, { staffId: actor.id, action: 'purchase_request', targetType: 'purchase_request', targetId: requestId, detail: { action: 'mall_quote', quoteId: q!.id, supplierName }, ip });
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'mall_quote', ${requestHash}, ${requestId}, ${actor.id})`;
  });
}

async function assertSourcer(db: Db, requestId: number, actor: Actor) {
  const [o] = await db<{ ownerId: number | null }[]>`SELECT owner_id FROM mall_request_sourcing WHERE request_id = ${requestId}`;
  const owner = o?.ownerId === null || o?.ownerId === undefined ? null : Number(o.ownerId);
  if (owner !== null && owner !== actor.id && actor.role !== 'owner' && !can(actor, 'request.review')) throw forbidden('这张单是别的同事接的，请让接单的人记方案');
}

/** 能不能替部门确认方案：提单人、这个部门的人、主管（提交时记着的或现在的）、店主 */
async function confirmsPlan(db: Db, actor: Actor, r: { requesterId: number; departmentId: number; deptHeadId: number | null }) {
  if (r.requesterId === actor.id) return true;
  const me = await myContext(db, actor);
  return isHeadOf(me, actor, r) || me.departmentId === r.departmentId;
}

/** 详情页的「能确认方案」：与 selectQuote 同一个判断 */
export async function canConfirmPlan(db: Db, actor: Actor, requestId: number): Promise<boolean> {
  const [r] = await db<{ requesterId: number; departmentId: number; deptHeadId: number | null }[]>`
    SELECT requester_id, department_id, dept_head_id FROM purchase_requests WHERE id = ${requestId}`;
  return !!r && (await confirmsPlan(db, actor, { requesterId: Number(r.requesterId), departmentId: Number(r.departmentId), deptHeadId: r.deptHeadId === null ? null : Number(r.deptHeadId) }));
}

/** 撤下一条方案（选定以后、转了采购单的不能撤） */
export async function withdrawQuote(deps: Deps, quoteId: number, raw: unknown, actor: Actor, ip?: string): Promise<number> {
  const { clientKey } = parse(QuoteActKey, raw ?? {});
  if (!canSource(actor)) throw forbidden('只有采购（供应链 BP）能撤方案');
  const requestHash = hashRequest({ op: 'mall_quote_withdraw', quoteId });
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const q = await lockQuoteAfterRequest(tx, quoteId);
    if (await quoteActDone(tx, clientKey, requestHash, actor)) return q.requestId;
    await assertSourcer(tx, q.requestId, actor);
    if (q.status === 'withdrawn') {
      await quoteActRecord(tx, clientKey, requestHash, q.requestId, actor);
      return q.requestId;
    }
    if (q.status === 'selected' && (await lineOrdered(tx, q.lineId))) throw conflict('QUOTE_ORDERED', '这条方案已经转了采购单，不能撤');
    await tx`UPDATE mall_request_quotes SET status = 'withdrawn', recommended = false, selected_mode = NULL, selected_by = NULL, selected_at = NULL WHERE id = ${quoteId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'purchase_request', targetType: 'purchase_request', targetId: q.requestId, detail: { action: 'mall_quote_withdraw', quoteId }, ip });
    await quoteActRecord(tx, clientKey, requestHash, q.requestId, actor);
    return q.requestId;
  });
}

/**
 * 选定、撤下方案的「结果待确认」（Codex 审查）：操作编号 mall_quote_act，只能查回、作废自己的。
 * 先锁需求单与方案、再认编号：同编号原样重提不再写；确认作废的编号晚到也不改（不会在部门改选了 B 以后又把晚到的 A 换回去）
 */
const QuoteActKey = z.object({ clientKey: z.uuid('缺少操作编号，请刷新页面后重试') });
async function quoteActDone(tx: Tx, key: string, requestHash: string, actor: Actor): Promise<boolean> {
  await assertNotFenced(tx, key, 'mall_quote_act', erpOpAbandoned);
  const [done] = await tx<{ opType: string; requestHash: string; staffId: number }[]>`SELECT op_type, request_hash, staff_id FROM idempotency_keys WHERE key = ${key}`;
  if (!done) return false;
  if (done.opType !== 'mall_quote_act' || done.requestHash !== requestHash || Number(done.staffId) !== actor.id) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一笔内容不同的方案操作');
  return true;
}
async function quoteActRecord(tx: Tx, key: string, requestHash: string, requestId: number, actor: Actor) {
  await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${key}, 'mall_quote_act', ${requestHash}, ${requestId}, ${actor.id})`;
}

const SelectInput = QuoteActKey.extend({
  /** dept：部门在系统里确认；wechat：BP 记「部门已在微信上确认」（要写一句，比如谁、几点确认的） */
  mode: z.enum(['dept', 'wechat']),
  note: z.string().trim().max(200).default(''),
});

/** 选定方案：部门（提单人、这个部门的主管）确认，或 BP 代记已在微信确认；同一行原来选定的换掉（还没转采购单时） */
export async function selectQuote(deps: Deps, quoteId: number, raw: unknown, actor: Actor, ip?: string): Promise<number> {
  const input = parse(SelectInput, raw);
  const requestHash = hashRequest({ op: 'mall_quote_select', quoteId, mode: input.mode, note: input.note });
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const q = await lockQuoteAfterRequest(tx, quoteId);
    const r = await lockRequest(tx, q.requestId);
    if (await quoteActDone(tx, input.clientKey, requestHash, actor)) return q.requestId;
    if (q.status === 'withdrawn') throw conflict('QUOTE_WITHDRAWN', '这条方案已经撤下了');
    if (q.status === 'selected') {
      await quoteActRecord(tx, input.clientKey, requestHash, q.requestId, actor);
      return q.requestId;
    }
    if (!['submitted', 'approved'].includes(r.status)) throw conflict('INVALID_STATE', '这张需求单已经结束，不能再选方案');
    if (input.mode === 'dept') {
      if (!(await confirmsPlan(tx, actor, r))) throw forbidden('只有提单的部门能确认方案');
    } else {
      if (!canSource(actor)) throw forbidden('只有采购（供应链 BP）能记「已在微信确认」');
      await assertSourcer(tx, q.requestId, actor);
      if (!input.note) throw unprocessable('NOTE_REQUIRED', '请写一句部门是谁、什么时候在微信上确认的');
    }
    if (await lineOrdered(tx, q.lineId)) throw conflict('QUOTE_ORDERED', '这一行已经转了采购单，方案不能再换');
    await tx`UPDATE mall_request_quotes SET status = 'proposed', selected_mode = NULL, selected_by = NULL, selected_at = NULL WHERE line_id = ${q.lineId} AND status = 'selected'`;
    await tx`
      UPDATE mall_request_quotes SET status = 'selected', selected_mode = ${input.mode}, selected_by = ${actor.id}, selected_at = now(), selected_note = ${input.note}
      WHERE id = ${quoteId}`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'purchase_request',
      targetType: 'purchase_request',
      targetId: q.requestId,
      detail: { action: 'mall_quote_select', quoteId, mode: input.mode },
      ip,
    });
    await quoteActRecord(tx, input.clientKey, requestHash, q.requestId, actor);
    return q.requestId;
  });
}

/** 锁的顺序固定（Codex 审查，AGENTS.md）：先锁需求单、再锁方案——与记方案（先锁需求单、再改同一行的方案）一样，不会互相等 */
async function lockQuoteAfterRequest(tx: Db, quoteId: number) {
  const [peek] = await tx<{ requestId: number }[]>`SELECT request_id FROM mall_request_quotes WHERE id = ${quoteId}`;
  if (!peek) throw notFound('方案不存在');
  await lockRequest(tx, Number(peek.requestId));
  const [q] = await tx<{ requestId: number; lineId: number; status: MallQuote['status'] }[]>`
    SELECT request_id, line_id, status FROM mall_request_quotes WHERE id = ${quoteId} FOR UPDATE`;
  if (!q) throw notFound('方案不存在');
  return { requestId: Number(q.requestId), lineId: Number(q.lineId), status: q.status };
}

/** 这一行转了采购单没有（没撤销的采购单） */
async function lineOrdered(db: Db, lineId: number): Promise<boolean> {
  const [x] = await db<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id
                   JOIN purchase_orders po ON po.id = pl.po_id WHERE x.request_line_id = ${lineId} AND po.status <> 'cancelled') AS ok`;
  return !!x?.ok;
}

/** 一张单的方案（详情页用）：看不到价格的账号把价格、截图、内部备注拿掉 */
export async function requestQuotes(db: Db, requestId: number, actor: Actor): Promise<MallQuote[]> {
  const rows = await db<
    {
      id: number;
      lineId: number;
      supplierId: number | null;
      supplierName: string;
      unitPriceCents: number;
      taxRateBp: number;
      freightCents: number;
      leadDays: number;
      validUntil: string | null;
      planNote: string;
      internalNote: string;
      imageIds: number[];
      recommended: boolean;
      status: MallQuote['status'];
      selectedMode: MallQuote['selectedMode'];
      selectedAt: string | null;
      selectedByName: string | null;
      selectedNote: string;
      createdAt: string;
      createdByName: string;
    }[]
  >`
    SELECT q.id, q.line_id, q.supplier_id, q.supplier_name, q.unit_price_cents, q.tax_rate_bp, q.freight_cents, q.lead_days,
           to_char(q.valid_until, 'YYYY-MM-DD') AS valid_until, q.plan_note, q.internal_note, q.image_ids, q.recommended, q.status,
           q.selected_mode, q.selected_at, sb.display_name AS selected_by_name, q.selected_note, q.created_at, cb.display_name AS created_by_name
    FROM mall_request_quotes q JOIN staff cb ON cb.id = q.created_by LEFT JOIN staff sb ON sb.id = q.selected_by
    WHERE q.request_id = ${requestId} AND q.status <> 'withdrawn'
    ORDER BY q.line_id, q.id`;
  const full = canSeeDealPrices(actor);
  return rows.map((q) => ({
    id: Number(q.id),
    lineId: Number(q.lineId),
    supplierId: q.supplierId === null ? null : Number(q.supplierId),
    supplierName: q.supplierName,
    leadDays: Number(q.leadDays),
    validUntil: q.validUntil,
    planNote: q.planNote,
    recommended: q.recommended,
    status: q.status,
    selectedMode: q.selectedMode,
    selectedAt: q.selectedAt,
    selectedByName: q.selectedByName,
    selectedNote: q.selectedNote,
    createdAt: q.createdAt,
    createdByName: q.createdByName,
    unitPriceCents: full ? Number(q.unitPriceCents) : null,
    taxRateBp: full ? Number(q.taxRateBp) : null,
    freightCents: full ? Number(q.freightCents) : null,
    internalNote: full ? q.internalNote : null,
    imageIds: full ? (q.imageIds ?? []).map(Number) : [],
  }));
}

/** 这张单的接单人 */
export async function sourcingOwner(db: Db, requestId: number): Promise<{ id: number; name: string; claimedAt: string } | null> {
  const [o] = await db<{ id: number | null; name: string | null; claimedAt: string | null }[]>`
    SELECT ms.owner_id AS id, s.display_name AS name, ms.claimed_at
    FROM mall_request_sourcing ms JOIN staff s ON s.id = ms.owner_id WHERE ms.request_id = ${requestId}`;
  return o?.id ? { id: Number(o.id), name: o.name ?? '', claimedAt: o.claimedAt ?? '' } : null;
}
