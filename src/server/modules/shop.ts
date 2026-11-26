// 采购商城（8.1.32，店主 2026-11-24：商城模块并进柚子、由我们开发，docs/MALL_V8132.md）。
//
// · 目录：在用的受管物料 × 已上架的供应商 SKU；按门店（业态）判断能不能采购（供应商准入、SKU 上架、没有改价在审、价格没过期、适用这家门店）。
// · 提交：选品清单与商城外自主申请都生成采购需求单（来源「商城」），走 270 的建单写法（操作编号幂等、主管确认、核库）。
//   选品在建单的事务里按 SKU 编号升序锁住（FOR SHARE）再核对：价格版本对不上（加清单以后改过价）拒绝 PRICE_CHANGED，
//   不能采购了拒绝 SKU_UNAVAILABLE，数量低于起订量拒绝 BELOW_MOQ。商城单号用「YZ-操作编号」（柚子里提的）。
// · SKU：采购（purchase.manage）建草稿、提交；有「采购规则」权限的人审核上架（不能批自己提交的，店主除外）；
//   核心信息（价格、税率、起订量、运费、有效期、适用门店）改动另提一张待审的改动，提了以后这条 SKU 暂停采购，批了才生效、价格版本加一。
// 加锁顺序：建单 = 操作编号的咨询锁 → SKU（id 升序，FOR SHARE）→ 写需求单；SKU 的写操作只锁 SKU 一行（FOR UPDATE），
// 改动的审核先锁 SKU 再锁改动一行（docs/LOCKING.md「采购商城」）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { shiftDate } from '@shared/labels';
import { formatYuan } from '@shared/money';
import { can } from '@shared/permissions';
import { REQUEST_PRIORITIES } from '@shared/requests';
import {
  compareRecommendReason,
  filterAndSortCompareOffers,
  grossCents,
  lineGoodsCents,
  lineGrossCents,
  SHOP_BLOCK_LABELS,
  SHOP_MAX_MATERIAL_IMAGES,
  SHOP_MAX_QTY_MILLI,
  type ShopBlock,
  type ShopCatalog,
  type ShopCompareBlock,
  type ShopCompareOffer,
  type ShopCompareResult,
  type ShopItem,
  type ShopMaterialRow,
  type ShopOffer,
  type ShopOverview,
  type ShopRoutePreview,
  type ShopRoutePreviewHint,
  type ShopRoutePreviewNode,
  type ShopSku,
  type ShopSkuCore,
  type ShopSkuStatus,
  type ShopSupplierDetail,
  type ShopSupplierRow,
} from '@shared/shop';
import type { Db } from '../db';
import { guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { csvReply } from '../lib/csv';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { clockIn, todayIn } from '../lib/dates';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { loadExpenseRules } from './expenses';
import { supplierLicenses } from './inventory/admission';
import { docDateSchema } from './inventory/common';
import { loadPurchaseRules } from './inventory/purchase-rules';
import { createMallRequest, exportMallCsv, mallRequest, pagedMall } from './mall';
import { addQuote, claimMallRequest, CustomSpecInput, customDetails, resubmitMallRequest, selectQuote, withdrawQuote } from './mall-pilot';
import { pettyBalances, pettyOccupied } from './petty-uses';
import { allowedStores } from './stores';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { erpOpAbandoned } from './erp-ops';
import { myContext, saveImage } from './requests';

const id = z.number().int().positive();

// ───────────────────────── 读 ─────────────────────────

interface SkuRow {
  id: number;
  materialId: number;
  supplierId: number;
  supplierName: string;
  admission: string;
  skuCode: string;
  priceCents: number;
  taxRateBp: number;
  moqMilli: number;
  leadDays: number;
  freightCents: number;
  validUntil: string;
  storeIds: number[];
  priceVersion: number;
  status: ShopSkuStatus;
  corePending: boolean;
  supplierActive: boolean;
  /** 报价时的采购单位 */
  unit: string;
  /** 物料现在的采购单位、换算与报价时的一样 */
  unitOk: boolean;
}

const SKU_COLS = (db: Db) => db`
  k.id, k.material_id, k.supplier_id, sp.name AS supplier_name, sp.admission, sp.active AS supplier_active, k.sku_code, k.price_cents, k.tax_rate_bp,
  k.moq_milli, k.lead_days, k.freight_cents, to_char(k.valid_until, 'YYYY-MM-DD') AS valid_until, k.store_ids, k.price_version, k.status, k.core_pending, k.unit,
  (SELECT m.purchase_unit = k.unit AND m.purchase_factor_milli = k.unit_factor_milli FROM materials m WHERE m.id = k.material_id) AS unit_ok`;

/** 这条 SKU 在这家门店为什么不能采购（能买为空），按原型的顺序取第一个 */
export function blockOf(k: Pick<SkuRow, 'corePending' | 'status' | 'admission' | 'supplierActive' | 'validUntil' | 'storeIds' | 'unitOk'>, storeId: number, today: string): ShopBlock | null {
  if (k.corePending) return 'core_pending';
  if (k.status !== 'approved') return k.status;
  if (k.admission !== 'approved' || !k.supplierActive) return 'supplier';
  if (!k.unitOk) return 'unit';
  if (k.validUntil < today) return 'expired';
  if (k.storeIds.length && !k.storeIds.map(Number).includes(storeId)) return 'store';
  return null;
}

async function catalog(deps: Deps, actor: Actor, storeIdRaw: unknown): Promise<ShopCatalog> {
  const db = deps.sql;
  const today = todayIn(deps.config.timezone);
  // 只列自己能去的门店（店主全部；Codex 安全审查），提交时 mall.ts 再核对一遍
  const allowed = (await allowedStores(db, actor)).map((x) => Number(x.id));
  const stores = (
    await db<{ id: number; name: string; entityId: number | null }[]>`SELECT id, name, entity_id FROM stores WHERE active AND id IN ${db(allowed.length ? allowed : [0])} ORDER BY sort_order, id`
  ).map((s) => ({
    id: Number(s.id),
    name: s.name,
    entityId: s.entityId === null ? null : Number(s.entityId),
  }));
  const wanted = Number(storeIdRaw);
  const pick = [wanted, actor.storeId].find((x) => x != null && stores.some((s) => s.id === x));
  const storeId = pick ?? stores[0]?.id ?? 1;
  const entities = (await db<{ id: number; name: string }[]>`SELECT id, name FROM legal_entities WHERE active ORDER BY id`).map((e) => ({ id: Number(e.id), name: e.name }));
  const materials = await db<{ id: number; code: string; name: string; category: string; specification: string; unit: string; note: string }[]>`
    SELECT id, code, name, category, specification, purchase_unit AS unit, note FROM materials WHERE active AND tracked ORDER BY category, code`;
  // 草稿、待审的不给部门看（只有上架过的；停用、改价在审的照样列出来、标原因）
  const skus = await db<SkuRow[]>`
    SELECT ${SKU_COLS(db)} FROM mall_skus k JOIN suppliers sp ON sp.id = k.supplier_id
    WHERE k.status IN ('approved', 'disabled') ORDER BY k.material_id, k.id`;
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  const byMaterial = new Map<number, ShopOffer[]>();
  for (const k of skus) {
    const offer: ShopOffer = {
      skuId: Number(k.id),
      skuCode: k.skuCode,
      priceVersion: k.priceVersion,
      supplier: { id: Number(k.supplierId), name: k.supplierName, admission: k.admission },
      priceCents: Number(k.priceCents),
      taxRateBp: k.taxRateBp,
      grossCents: grossCents(Number(k.priceCents), k.taxRateBp),
      moqMilli: Number(k.moqMilli),
      leadDays: k.leadDays,
      freightCents: Number(k.freightCents),
      validUntil: k.validUntil,
      stores: k.storeIds.map((s) => ({ id: Number(s), name: storeName.get(Number(s)) ?? `门店 ${s}` })),
      status: k.status,
      corePending: k.corePending,
      block: blockOf(k, storeId, today),
    };
    const list = byMaterial.get(Number(k.materialId)) ?? [];
    list.push(offer);
    byMaterial.set(Number(k.materialId), list);
  }
  const imagesOf = await materialImages(db);
  const items: ShopItem[] = materials
    .map((m) => {
      const offers = byMaterial.get(Number(m.id)) ?? [];
      const ok = offers.filter((o) => o.block === null);
      return {
        material: { ...m, id: Number(m.id), imageIds: imagesOf.get(Number(m.id)) ?? [] },
        offers,
        fromGrossCents: ok.length ? Math.min(...ok.map((o) => o.grossCents)) : null,
        purchasable: ok.length,
      };
    })
    // 目录里只列有报价的物料；没有报价的走自主申请
    .filter((i) => i.offers.length > 0);
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.material.category || '未分类', (counts.get(i.material.category || '未分类') ?? 0) + 1);
  const me = await myContext(db, actor);
  const { purposes } = await loadExpenseRules(db);
  const free = actor.role === 'owner' || me.canReview;
  return {
    storeId,
    stores,
    entities,
    categories: [...counts].map(([name, count]) => ({ name, count })),
    items,
    purposes,
    // 店主、采购审核可以替别的部门提（与 ERP 填单页一样，resolveDepartment），给在用的部门让他们选
    departments: free ? (await db<{ id: number; name: string }[]>`SELECT id, name FROM departments WHERE active ORDER BY sort_order, id`).map((d) => ({ id: Number(d.id), name: d.name })) : [],
    me: {
      departmentId: me.departmentId,
      departmentName: me.departmentName,
      canPickDepartment: free,
      canPool: me.canReview || me.canStock,
      canManageSku: can(actor, 'purchase.manage'),
      canApproveSku: can(actor, 'purchase.rules') || actor.role === 'owner',
      canEditMaster: can(actor, 'inventory.master'),
    },
    today,
  };
}

const OffersQuery = z.object({
  materialId: z.coerce.number().int().positive('物料编号不正确'),
  qtyMilli: z.coerce.number().int().positive().max(SHOP_MAX_QTY_MILLI, '数量不能超过 1,000,000').optional(),
  storeId: z.coerce.number().int().positive().optional(),
});

/** 比价页专用只读接口（FR-01 第 6 条）：服务端计算 purchasable 与 blockReason（含 below_moq），返回含税总成本与推荐解释 */
async function compareOffers(deps: Deps, actor: Actor, raw: unknown): Promise<ShopCompareResult> {
  const q = parse(OffersQuery, raw ?? {});
  const db = deps.sql;
  const today = todayIn(deps.config.timezone);
  const allowed = (await allowedStores(db, actor)).map((x) => Number(x.id));
  const stores = (await db<{ id: number; name: string }[]>`SELECT id, name FROM stores WHERE active AND id IN ${db(allowed.length ? allowed : [0])} ORDER BY sort_order, id`).map((s) => ({
    id: Number(s.id),
    name: s.name,
  }));
  if (q.storeId !== undefined && !stores.some((s) => s.id === q.storeId)) throw forbidden('你不能查看这家门店的报价');
  const pick = [q.storeId, actor.storeId].find((x) => x != null && stores.some((s) => s.id === x));
  const storeId = pick ?? stores[0]?.id ?? 1;
  const storeName = stores.find((s) => s.id === storeId)?.name ?? `门店 ${storeId}`;

  const [material] = await db<{ id: number; code: string; name: string; category: string; specification: string; unit: string; note: string }[]>`
    SELECT id, code, name, category, specification, purchase_unit AS unit, note FROM materials WHERE id = ${q.materialId} AND active AND tracked`;
  if (!material) {
    return { material: null, storeId, storeName, today, updatedAt: new Date().toISOString(), qtyMilli: q.qtyMilli ?? 1000, offers: [], recommendedSkuId: null, recommendReason: null };
  }

  const skus = await db<(SkuRow & { updatedAt: string })[]>`
    SELECT ${SKU_COLS(db)}, k.updated_at FROM mall_skus k JOIN suppliers sp ON sp.id = k.supplier_id
    WHERE k.material_id = ${q.materialId} AND k.status IN ('approved', 'disabled') ORDER BY k.id`;
  const allStoreNames = new Map((await db<{ id: number; name: string }[]>`SELECT id, name FROM stores`).map((s) => [Number(s.id), s.name]));

  // 未传 qtyMilli 时按可采购报价最小起订量（无则全部报价最小起订量），兜底 1 单位
  let qtyMilli = q.qtyMilli ?? 1000;
  if (q.qtyMilli === undefined && skus.length > 0) {
    const ok = skus.filter((k) => blockOf(k, storeId, today) === null);
    const pool = ok.length > 0 ? ok : skus;
    qtyMilli = Math.min(SHOP_MAX_QTY_MILLI, Math.min(...pool.map((k) => Number(k.moqMilli))));
  }

  let latestMs = 0;
  const offers: ShopCompareOffer[] = skus.map((k) => {
    const ts = Date.parse(k.updatedAt);
    if (!Number.isNaN(ts) && ts > latestMs) latestMs = ts;
    const baseBlock = blockOf(k, storeId, today);
    const moqMilli = Number(k.moqMilli);
    const blockReason: ShopCompareBlock | null = baseBlock ?? (qtyMilli < moqMilli ? 'below_moq' : null);
    const priceCents = Number(k.priceCents);
    const freightCents = Number(k.freightCents);
    const storeIds = k.storeIds.map(Number);
    return {
      skuId: Number(k.id),
      skuCode: k.skuCode,
      priceVersion: k.priceVersion,
      supplierId: Number(k.supplierId),
      supplierName: k.supplierName,
      admission: k.admission,
      admitted: k.admission === 'approved' && k.supplierActive,
      priceCents,
      taxRateBp: k.taxRateBp,
      grossCents: grossCents(priceCents, k.taxRateBp),
      freightCents,
      moqMilli,
      leadDays: k.leadDays,
      estimatedArrival: shiftDate(today, k.leadDays),
      validUntil: k.validUntil,
      storeIds,
      stores: storeIds.map((s) => ({ id: s, name: allStoreNames.get(s) ?? `门店 ${s}` })),
      purchasable: blockReason === null,
      blockReason,
      goodsCents: lineGoodsCents(priceCents, k.taxRateBp, qtyMilli),
      totalCents: lineGrossCents(priceCents, k.taxRateBp, qtyMilli, freightCents),
    };
  });

  const sorted = filterAndSortCompareOffers(offers, 'total', { freeShippingOnly: false, purchasableOnly: false, admittedOnly: false });
  const ok = sorted.filter((o) => o.purchasable);
  return {
    material: { ...material, id: Number(material.id), imageIds: (await materialImages(db, [Number(material.id)])).get(Number(material.id)) ?? [] },
    storeId,
    storeName,
    today,
    updatedAt: latestMs > 0 ? new Date(latestMs).toISOString() : new Date().toISOString(),
    qtyMilli,
    offers: sorted,
    recommendedSkuId: ok[0]?.skuId ?? null,
    recommendReason: compareRecommendReason(ok),
  };
}

// ───────────────────────── 提交 ─────────────────────────

const Header = z.object({
  clientKey: z.uuid('缺少操作编号，请刷新页面后重试'),
  storeId: id,
  entityId: id,
  departmentId: id.nullable().default(null),
  contactName: z.string().trim().min(1, '请填写经办人').max(40),
  budgetProject: z.string().trim().min(1, '请填写预算项目 / 费用归属').max(80),
  needBy: docDateSchema,
  deliveryAddress: z.string().trim().min(1, '请填写收货地点').max(120),
  paymentIntent: z.enum(['company_direct', 'dept_petty']),
  priority: z.enum(REQUEST_PRIORITIES),
  note: z.string().trim().max(500).default(''),
  /** 用途（费用规则里的用途清单）：不选的按「其他」，没有「其他」的用清单第一项（mall.ts withPurposes） */
  purpose: z.string().trim().max(20).default(''),
});

const CatalogSubmit = Header.extend({
  kind: z.literal('catalog'),
  lines: z
    .array(z.object({ skuId: id, priceVersion: z.number().int().positive(), qtyMilli: z.number().int().positive().max(1_000_000_000) }))
    .min(1, '采购清单是空的')
    .max(50, '一次最多 50 行'),
});

const CustomSubmit = Header.extend({
  kind: z.literal('custom'),
  line: z.object({
    name: z.string().trim().min(1, '请填写物品名称').max(100),
    expectedCategory: z.string().trim().max(32).default(''),
    qtyMilli: z.number().int().positive().max(1_000_000_000),
    unit: z.string().trim().min(1).max(8),
    details: z.string().trim().max(1000).default(''),
    /** 8.1.51：非定制（现成品）/ 定制；定制写尺寸、材质工艺、使用场景、打样、预算 */
    customKind: z.enum(['standard', 'custom']).default('standard'),
    customSpec: CustomSpecInput.nullable().default(null),
    brandModel: z.string().trim().max(150).default(''),
    link: z.string().trim().max(1000).default(''),
    reasonText: z.string().trim().min(1, '请填写采购理由 / 使用场景').max(1000),
    imageIds: z.array(id).max(9).default([]),
  }),
});

const SubmitInput = z.discriminatedUnion('kind', [CatalogSubmit, CustomSubmit]);

async function submit(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(SubmitInput, raw);
  // 原样重提（Codex 审查）：按页面提交的内容算摘要，先认这个操作编号建过的单——在按现在的 SKU 重新核对、拼明细之前，
  // 不然之前那次已经生效、之后 SKU 停用、过期、改价或物料改了名，原样重提会被拒绝或报内容不同
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const [done] = await deps.sql<{ opType: string; requestHash: string; refId: number; staffId: number }[]>`
    SELECT op_type, request_hash, ref_id, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
  if (done) {
    if (done.opType !== 'purchase_request' || done.requestHash !== requestHash || Number(done.staffId) !== actor.id) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一笔内容不同的申请');
    return { request: await mallRequest(deps, actor, Number(done.refId)), replayed: true };
  }
  const header = {
    clientKey: input.clientKey,
    externalNo: `YZ-${input.clientKey}`,
    departmentId: input.departmentId,
    contactName: input.contactName,
    storeId: input.storeId,
    entityId: input.entityId,
    budgetProject: input.budgetProject,
    needBy: input.needBy,
    deliveryAddress: input.deliveryAddress,
    paymentIntent: input.paymentIntent,
    priority: input.priority,
    note: input.note,
  };
  if (input.kind === 'custom') {
    const l = input.line;
    if (l.link && !/^https?:\/\/\S+$/i.test(l.link)) throw unprocessable('LINK_INVALID', '参考链接要以 http:// 或 https:// 开头');
    const spec = l.customKind === 'custom' ? (l.customSpec ?? { size: '', craft: '', scene: '', sample: false, budgetCents: null }) : null;
    if (l.customKind === 'standard' && !l.details) throw unprocessable('DETAILS_REQUIRED', '请填写规格型号');
    if (spec && !spec.size && !spec.craft && !l.details) throw unprocessable('DETAILS_REQUIRED', '定制请至少写清尺寸规格、材质工艺或设计要求中的一项');
    return createMallRequest(
      deps,
      {
        ...header,
        lines: [
          {
            materialId: null,
            name: l.name,
            purpose: input.purpose,
            qtyMilli: l.qtyMilli,
            unit: l.unit,
            details: customDetails(l.details, spec),
            brandModel: l.brandModel,
            customKind: l.customKind,
            customSpec: spec,
            expectedCategory: l.expectedCategory,
            link: l.link,
            reasonText: l.reasonText,
            imageIds: l.imageIds,
          },
        ],
      },
      actor,
      ip,
      undefined,
      requestHash,
    );
  }
  // 选品：先按现在的 SKU 算好明细（参考价写含税单价），建单的事务里再锁住核对一遍
  const ids = [...new Set(input.lines.map((l) => l.skuId))].sort((a, b) => a - b);
  if (ids.length !== input.lines.length) throw unprocessable('DUPLICATE_SKU', '同一个 SKU 在清单里只能有一行（数量合在一起）');
  const read = async (db: Db, lock: boolean) =>
    new Map(
      (
        await db<(SkuRow & { materialName: string; unit: string })[]>`
          SELECT ${SKU_COLS(db)}, m.name AS material_name
          FROM mall_skus k JOIN suppliers sp ON sp.id = k.supplier_id JOIN materials m ON m.id = k.material_id
          WHERE k.id IN ${db(ids)} ORDER BY k.id ${lock ? db`FOR SHARE OF k` : db``}`
      ).map((k) => [Number(k.id), k]),
    );
  const check = (skus: Awaited<ReturnType<typeof read>>) => {
    const today = todayIn(deps.config.timezone);
    for (const l of input.lines) {
      const k = skus.get(l.skuId);
      if (!k) throw notFound('清单里有 SKU 不存在了，请返回清单移除');
      const block = blockOf(k, input.storeId, today);
      if (block) throw unprocessable('SKU_UNAVAILABLE', `「${k.materialName}」（${k.supplierName}）现在不能采购：${SHOP_BLOCK_LABELS[block]}，请返回清单移除或换一家`, { skuId: l.skuId });
      if (k.priceVersion !== l.priceVersion) throw conflict('PRICE_CHANGED', `「${k.materialName}」（${k.supplierName}）加清单以后改过价，请回清单确认新价再提交`, { skuId: l.skuId });
      if (l.qtyMilli < Number(k.moqMilli)) throw unprocessable('BELOW_MOQ', `「${k.materialName}」（${k.supplierName}）低于起订量，请改数量`, { skuId: l.skuId });
    }
  };
  const now = await read(deps.sql, false);
  check(now);
  return createMallRequest(
    deps,
    {
      ...header,
      lines: input.lines.map((l) => {
        const k = now.get(l.skuId)!;
        return {
          materialId: Number(k.materialId),
          supplierId: Number(k.supplierId),
          mallSkuCode: k.skuCode,
          priceVersion: `V${k.priceVersion}`,
          name: k.materialName.slice(0, 100),
          purpose: input.purpose,
          qtyMilli: l.qtyMilli,
          unit: k.unit.slice(0, 8),
          refPriceCents: grossCents(Number(k.priceCents), k.taxRateBp),
          taxRateBp: k.taxRateBp,
          freightCents: Number(k.freightCents),
        };
      }),
    },
    actor,
    ip,
    async (tx) => check(await read(tx, true)),
    requestHash,
  );
}

// ───────────────────────── SKU 维护与审核 ─────────────────────────

const CoreInput = z.object({
  priceCents: z.number().int().positive('未税单价要大于 0').max(100_000_000),
  taxRateBp: z.number().int().min(0).max(10_000),
  moqMilli: z.number().int().positive('起订量要大于 0').max(1_000_000_000),
  freightCents: z.number().int().min(0).max(100_000_000),
  validUntil: docDateSchema,
  storeIds: z.array(id).max(50).default([]),
});
/** 含税单价写进需求单的参考单价（上限 100 万元，mall.ts MallLineInput）：报价时就按这个上限核对，免得上架了却提交不了（Codex 审查） */
const MAX_GROSS_CENTS = 100_000_000;
function assertGross(v: { priceCents: number; taxRateBp: number }) {
  if (grossCents(v.priceCents, v.taxRateBp) > MAX_GROSS_CENTS) throw unprocessable('SKU_PRICE_TOO_HIGH', '含税单价不能超过 100 万元');
}
const SkuInput = CoreInput.extend({
  materialId: id,
  supplierId: id,
  skuCode: z.string().trim().min(1, '请填写 SKU 编码').max(40),
  leadDays: z.number().int().min(0).max(365),
  note: z.string().trim().max(200).default(''),
});
const SkuEdit = SkuInput.extend({ version: z.number().int().positive() });
const ReasonInput = z.object({ reason: z.string().trim().min(2, '请写原因（至少 2 个字）').max(200) });
const NoteInput = z.object({ note: z.string().trim().max(200).default('') });

async function checkSkuRefs(db: Db, v: { materialId: number; supplierId: number; storeIds: number[] }) {
  const [m] = await db<{ active: boolean; tracked: boolean }[]>`SELECT active, tracked FROM materials WHERE id = ${v.materialId}`;
  if (!m?.active || !m.tracked) throw unprocessable('MATERIAL_INACTIVE', '物料不存在、已停用或不是受管物料');
  const [s] = await db<{ active: boolean }[]>`SELECT active FROM suppliers WHERE id = ${v.supplierId}`;
  if (!s?.active) throw unprocessable('SUPPLIER_INACTIVE', '供应商不存在或已停用');
  if (v.storeIds.length) {
    const n = await db<{ id: number }[]>`SELECT id FROM stores WHERE id IN ${db(v.storeIds)} AND active`;
    if (n.length !== new Set(v.storeIds).size) throw unprocessable('STORE_INVALID', '适用门店里有不存在或已停用的');
  }
}

async function listSkus(db: Db, ids?: number[]): Promise<ShopSku[]> {
  const rows = await db<
    (SkuRow & {
      materialCode: string;
      materialName: string;
      unit: string;
      note: string;
      submittedByName: string | null;
      approvedByName: string | null;
      approvedAt: string | null;
      version: number;
    })[]
  >`
    SELECT ${SKU_COLS(db)}, m.code AS material_code, m.name AS material_name, m.purchase_unit AS unit, k.note, k.version,
           sb.display_name AS submitted_by_name, ab.display_name AS approved_by_name, k.approved_at
    FROM mall_skus k JOIN suppliers sp ON sp.id = k.supplier_id JOIN materials m ON m.id = k.material_id
    LEFT JOIN staff sb ON sb.id = k.submitted_by LEFT JOIN staff ab ON ab.id = k.approved_by
    WHERE TRUE ${ids ? db`AND k.id IN ${db(ids)}` : db``}
    ORDER BY m.code, k.id LIMIT 2000`;
  const changes = await db<{ id: number; skuId: number; after: ShopSkuCore; reason: string; requestedByName: string; requestedAt: string }[]>`
    SELECT c.id, c.sku_id, c.after, c.reason, s.display_name AS requested_by_name, c.requested_at
    FROM mall_sku_changes c JOIN staff s ON s.id = c.requested_by WHERE c.status = 'pending'`;
  const changeOf = new Map(changes.map((c) => [Number(c.skuId), c]));
  const storeNames = new Map((await db<{ id: number; name: string }[]>`SELECT id, name FROM stores`).map((s) => [Number(s.id), s.name]));
  return rows.map((k) => {
    const c = changeOf.get(Number(k.id));
    return {
      id: Number(k.id),
      skuCode: k.skuCode,
      material: { id: Number(k.materialId), code: k.materialCode, name: k.materialName, unit: k.unit },
      supplier: { id: Number(k.supplierId), name: k.supplierName, admission: k.admission },
      priceCents: Number(k.priceCents),
      taxRateBp: k.taxRateBp,
      grossCents: grossCents(Number(k.priceCents), k.taxRateBp),
      moqMilli: Number(k.moqMilli),
      leadDays: k.leadDays,
      freightCents: Number(k.freightCents),
      validUntil: k.validUntil,
      stores: k.storeIds.map((s) => ({ id: Number(s), name: storeNames.get(Number(s)) ?? `门店 ${s}` })),
      priceVersion: k.priceVersion,
      status: k.status,
      corePending: k.corePending,
      note: k.note,
      submittedByName: k.submittedByName,
      approvedByName: k.approvedByName,
      approvedAt: k.approvedAt,
      version: k.version,
      pendingChange: c ? { id: Number(c.id), after: c.after, reason: c.reason, requestedByName: c.requestedByName, requestedAt: c.requestedAt } : null,
    };
  });
}

const one = async (db: Db, skuId: number) => {
  const [s] = await listSkus(db, [skuId]);
  if (!s) throw notFound('SKU 不存在');
  return s;
};

/** 能审核：有「采购规则」权限或店主；不能批自己提交的（店主除外） */
function assertApprover(actor: Actor, submittedBy: number | null) {
  if (!can(actor, 'purchase.rules') && actor.role !== 'owner') throw forbidden('审核商城 SKU 要有「采购规则」权限');
  if (submittedBy !== null && Number(submittedBy) === actor.id && actor.role !== 'owner') throw forbidden('不能审核自己提交的，请找另一位有权限的同事');
}

type SkuLock = { status: ShopSkuStatus; submittedBy: number | null; corePending: boolean; version: number } & ShopSkuCore;
const lockSku = async (tx: Db, skuId: number): Promise<SkuLock> => {
  const [k] = await tx<SkuLock[]>`
    SELECT status, submitted_by, core_pending, version, price_cents, tax_rate_bp, moq_milli, freight_cents, to_char(valid_until, 'YYYY-MM-DD') AS valid_until, store_ids
    FROM mall_skus WHERE id = ${skuId} FOR UPDATE`;
  if (!k) throw notFound('SKU 不存在');
  return { ...k, priceCents: Number(k.priceCents), moqMilli: Number(k.moqMilli), freightCents: Number(k.freightCents), storeIds: k.storeIds.map(Number) };
};

/** 页面带上看到的版本号（Codex 审查）：结果不确定后重提，第一次已经生效的会因为版本变了被拒（SKU_CHANGED），不会重复生效 */
const VersionBody = z.object({ version: z.number().int().positive().optional() }).passthrough();

async function skuOp(deps: Deps, actor: Actor, skuId: number, ip: string | undefined, fn: (tx: Db, k: SkuLock) => Promise<string>, body?: unknown) {
  const expected = parse(VersionBody, body ?? {}).version;
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const k = await lockSku(tx, skuId);
    if (expected !== undefined && k.version !== expected) throw conflict('SKU_CHANGED', '这条 SKU 刚变过（可能是上一次操作已经生效），请看刷新后的状态再决定');
    const action = await fn(tx, k);
    await writeAudit(tx, { staffId: actor.id, action: 'mall_sku', targetType: 'mall_sku', targetId: skuId, detail: { action }, ip });
  });
  return one(deps.sql, skuId);
}

// ───────────────────────── 供应商档案与集团物料主档（FR-03 / FR-04） ─────────────────────────

const SupplierPatchInput = z
  .object({
    clientKey: z.uuid('操作编号不正确'),
    contact: z.string().trim().max(40, '联系人最多 40 个字').optional(),
    phone: z.string().trim().max(32, '电话最多 32 个字').optional(),
    note: z.string().trim().max(200, '备注最多 200 个字').optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.contact !== undefined || v.phone !== undefined || v.note !== undefined || v.active !== undefined, '请至少修改一项内容');

const MaterialPatchInput = z
  .object({
    clientKey: z.uuid('操作编号不正确'),
    category: z.string().trim().max(16, '分类最多 16 个字').optional(),
    note: z.string().trim().max(200, '备注最多 200 个字').optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.category !== undefined || v.note !== undefined || v.active !== undefined, '请至少修改一项内容');

const BatchCategoryInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  materialIds: z.array(id).min(1, '请至少选择一个物料').max(200, '一次最多批量修改 200 个物料'),
  category: z.string().trim().max(16, '分类最多 16 个字'),
});

async function listShopSuppliers(db: Db, actor: Actor): Promise<ShopSupplierRow[]> {
  const canContact = can(actor, 'purchase.manage') || can(actor, 'inventory.master');
  const rows = await db<
    {
      id: number;
      code: string;
      name: string;
      active: boolean;
      admission: string;
      admissionNote: string;
      contact: string;
      phone: string;
      note: string;
      categories: string[];
      activeSkuCount: number;
      totalSkuCount: number;
      lastPriceChangeAt: string | null;
      avgLeadDays: number | null;
    }[]
  >`
    SELECT sp.id, sp.code, sp.name, sp.active, sp.admission, sp.admission_note, sp.contact, sp.phone, sp.note,
           coalesce((SELECT array_agg(DISTINCT nullif(m.category, '') ORDER BY nullif(m.category, ''))
                     FROM mall_skus k JOIN materials m ON m.id = k.material_id
                     WHERE k.supplier_id = sp.id AND nullif(m.category, '') IS NOT NULL), '{}') AS categories,
           (SELECT count(*)::int FROM mall_skus k WHERE k.supplier_id = sp.id AND k.status = 'approved') AS active_sku_count,
           (SELECT count(*)::int FROM mall_skus k WHERE k.supplier_id = sp.id) AS total_sku_count,
           greatest(
             (SELECT max(c.decided_at) FROM mall_sku_changes c JOIN mall_skus k ON k.id = c.sku_id WHERE k.supplier_id = sp.id AND c.status = 'approved'),
             (SELECT max(k.approved_at) FROM mall_skus k WHERE k.supplier_id = sp.id)
           ) AS last_price_change_at,
           (SELECT round(avg(k.lead_days))::int FROM mall_skus k WHERE k.supplier_id = sp.id AND k.status = 'approved') AS avg_lead_days
    FROM suppliers sp
    ORDER BY sp.active DESC, (sp.admission = 'approved') DESC, sp.code`;
  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    active: r.active,
    admission: r.admission,
    admissionNote: r.admissionNote,
    categories: r.categories ?? [],
    activeSkuCount: Number(r.activeSkuCount),
    totalSkuCount: Number(r.totalSkuCount),
    lastPriceChangeAt: r.lastPriceChangeAt,
    avgLeadDays: r.avgLeadDays === null ? null : Number(r.avgLeadDays),
    contact: canContact ? r.contact : null,
    phone: canContact ? r.phone : null,
    note: r.note,
  }));
}

async function shopSupplierDetail(db: Db, actor: Actor, supplierId: number): Promise<ShopSupplierDetail> {
  const all = await listShopSuppliers(db, actor);
  const base = all.find((s) => s.id === supplierId);
  if (!base) throw notFound('供应商不存在');
  const [adm] = await db<{ admissionByName: string | null; admissionAt: string | null }[]>`
    SELECT st.display_name AS admission_by_name, sp.admission_at
    FROM suppliers sp LEFT JOIN staff st ON st.id = sp.admission_by WHERE sp.id = ${supplierId}`;
  const rawLicenses = await supplierLicenses(db, supplierId);
  const skus = await db<
    {
      id: number;
      skuCode: string;
      materialId: number;
      materialCode: string;
      materialName: string;
      unit: string;
      priceCents: number;
      taxRateBp: number;
      moqMilli: number;
      leadDays: number;
      freightCents: number;
      validUntil: string;
      status: ShopSkuStatus;
      corePending: boolean;
    }[]
  >`
    SELECT k.id, k.sku_code, k.material_id, m.code AS material_code, m.name AS material_name, m.purchase_unit AS unit,
           k.price_cents, k.tax_rate_bp, k.moq_milli, k.lead_days, k.freight_cents,
           to_char(k.valid_until, 'YYYY-MM-DD') AS valid_until, k.status, k.core_pending
    FROM mall_skus k JOIN materials m ON m.id = k.material_id
    WHERE k.supplier_id = ${supplierId} ORDER BY k.status = 'approved' DESC, m.code, k.id`;
  const [hist] = await db<{ orderCount: number; totalAmountCents: string }[]>`
    SELECT count(*)::int AS order_count, coalesce(sum(total_cents), 0)::text AS total_amount_cents
    FROM purchase_orders WHERE supplier_id = ${supplierId} AND status IN ('approved', 'closed')`;
  return {
    ...base,
    admissionByName: adm?.admissionByName ?? null,
    admissionAt: adm?.admissionAt ?? null,
    licenses: rawLicenses.map((l) => ({
      id: l.id,
      kind: l.kind,
      name: l.name,
      licenseNo: l.licenseNo,
      validUntil: l.validUntil,
      mediaUrl: l.media?.url ?? null,
      addedByName: l.addedByName,
      addedAt: l.addedAt,
    })),
    skus: skus.map((k) => ({
      id: Number(k.id),
      skuCode: k.skuCode,
      materialId: Number(k.materialId),
      materialCode: k.materialCode,
      materialName: k.materialName,
      unit: k.unit,
      priceCents: Number(k.priceCents),
      taxRateBp: k.taxRateBp,
      grossCents: grossCents(Number(k.priceCents), k.taxRateBp),
      moqMilli: Number(k.moqMilli),
      leadDays: k.leadDays,
      freightCents: Number(k.freightCents),
      validUntil: k.validUntil,
      status: k.status,
      corePending: k.corePending,
    })),
    history: {
      orderCount: Number(hist?.orderCount ?? 0),
      totalAmountCents: Number(hist?.totalAmountCents ?? 0),
    },
  };
}

async function listShopMaterials(db: Db, today: string): Promise<ShopMaterialRow[]> {
  const rows = await db<
    {
      id: number;
      code: string;
      name: string;
      category: string;
      specification: string;
      unit: string;
      inventoryUnit: string;
      note: string;
      active: boolean;
      skuCount: number;
      activeSkuCount: number;
      supplierCount: number;
    }[]
  >`
    SELECT m.id, m.code, m.name, m.category, m.specification, m.purchase_unit AS unit, m.inventory_unit, m.note, m.active,
           (SELECT count(*)::int FROM mall_skus k WHERE k.material_id = m.id) AS sku_count,
           (SELECT count(*)::int FROM mall_skus k WHERE k.material_id = m.id AND k.status = 'approved') AS active_sku_count,
           (SELECT count(DISTINCT k.supplier_id)::int FROM mall_skus k WHERE k.material_id = m.id AND k.status = 'approved') AS supplier_count
    FROM materials m WHERE m.tracked
    ORDER BY m.active DESC, m.category, m.code`;
  const activePrices = await db<{ materialId: number; priceCents: number; taxRateBp: number }[]>`
    SELECT k.material_id, k.price_cents, k.tax_rate_bp
    FROM mall_skus k JOIN suppliers sp ON sp.id = k.supplier_id JOIN materials m ON m.id = k.material_id
    WHERE k.status = 'approved' AND NOT k.core_pending AND sp.active AND sp.admission = 'approved'
      AND k.valid_until >= ${today}::date AND k.unit = m.purchase_unit AND k.unit_factor_milli = m.purchase_factor_milli`;
  const lowestByMat = new Map<number, number>();
  for (const p of activePrices) {
    const mid = Number(p.materialId);
    const g = grossCents(Number(p.priceCents), p.taxRateBp);
    const cur = lowestByMat.get(mid);
    if (cur === undefined || g < cur) lowestByMat.set(mid, g);
  }
  const imagesOf = await materialImages(db);
  return rows.map((m) => ({
    id: Number(m.id),
    code: m.code,
    name: m.name,
    category: m.category,
    specification: m.specification,
    unit: m.unit,
    inventoryUnit: m.inventoryUnit,
    note: m.note,
    active: m.active,
    skuCount: Number(m.skuCount),
    activeSkuCount: Number(m.activeSkuCount),
    supplierCount: Number(m.supplierCount),
    lowestGrossCents: lowestByMat.get(Number(m.id)) ?? null,
    imageIds: imagesOf.get(Number(m.id)) ?? [],
  }));
}

// ───────────────────────── 商品图（8.1.50，迁移 510） ─────────────────────────

/** 每样物料的商品图（按第几张排好；第 1 张是封面） */
async function materialImages(db: Db, materialIds?: number[]): Promise<Map<number, number[]>> {
  const rows = await db<{ materialId: number; imageId: number }[]>`
    SELECT material_id, image_id FROM material_images
    ${materialIds ? db`WHERE material_id IN ${db(materialIds.length ? materialIds : [0])}` : db``}
    ORDER BY material_id, sort_no`;
  const map = new Map<number, number[]>();
  for (const r of rows) {
    const list = map.get(Number(r.materialId)) ?? [];
    list.push(Number(r.imageId));
    map.set(Number(r.materialId), list);
  }
  return map;
}

const MaterialImagesInput = z.object({
  /** 操作编号（Codex 审查）：与主数据的其他修改同一套「结果待确认」——本机先记下再发，原样重提认编号、不认图片 */
  clientKey: z.uuid('缺少操作编号，请刷新页面后重试'),
  imageIds: z.array(z.number().int().positive()).max(SHOP_MAX_MATERIAL_IMAGES, `每样物料最多 ${SHOP_MAX_MATERIAL_IMAGES} 张商品图`),
  /** 页面看到的现在的那一组：别人先改过的拒绝（晚到的旧请求不盖掉之后的修改）；整组写，原样重提结果一样 */
  expectedImageIds: z.array(z.number().int().positive()).max(SHOP_MAX_MATERIAL_IMAGES),
});

/** 整组换商品图：在物料行锁里核对「看到的」再删了重写；图片要是需求单那边能用的（erp_images 的 general） */
async function setMaterialImages(db: Deps['sql'], materialId: number, raw: unknown, staffId: number, ip?: string): Promise<number[]> {
  const input = parse(MaterialImagesInput, raw);
  if (new Set(input.imageIds).size !== input.imageIds.length) throw badRequest('同一张图不能放两次');
  const requestHash = hashRequest({ op: 'material_images', materialId, imageIds: input.imageIds, expected: input.expectedImageIds });
  return db.begin(async (tx) => {
    await setTxTimeouts(tx);
    await assertNotFenced(tx, input.clientKey, 'shop_master', erpOpAbandoned);
    const [done] = await tx<{ opType: string; requestHash: string; staffId: number }[]>`
      SELECT op_type, request_hash, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    const [m] = await tx<{ id: number }[]>`SELECT id FROM materials WHERE id = ${materialId} AND tracked FOR UPDATE`;
    if (!m) throw notFound('物料不存在');
    const now = (await materialImages(tx, [materialId])).get(materialId) ?? [];
    // 同一个编号原样重提：不再写，返回现在的（之后别人又改过的照别人的，不拿旧请求盖掉）
    if (done) {
      if (done.opType !== 'shop_master' || done.requestHash !== requestHash || Number(done.staffId) !== staffId) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一笔内容不同的主数据维护');
      return now;
    }
    if (now.join(',') !== input.expectedImageIds.join(',')) throw conflict('IMAGES_CHANGED', '这样物料的商品图刚被别人改过，刷新后再改');
    if (input.imageIds.length) {
      const ok = await tx<{ id: number }[]>`SELECT id FROM erp_images WHERE id IN ${tx(input.imageIds)} AND scope = 'general'`;
      if (ok.length !== input.imageIds.length) throw unprocessable('IMAGE_INVALID', '有的图片不存在，重新上传再试');
    }
    await tx`DELETE FROM material_images WHERE material_id = ${materialId}`;
    for (const [i, imageId] of input.imageIds.entries()) await tx`INSERT INTO material_images (material_id, sort_no, image_id) VALUES (${materialId}, ${i + 1}, ${imageId})`;
    await writeAudit(tx, { staffId, action: 'material_images', targetType: 'material', targetId: materialId, detail: { from: now, to: input.imageIds }, ip });
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'shop_master', ${requestHash}, ${materialId}, ${staffId})`;
    return input.imageIds;
  });
}

// ───────────────────────── 审批路由预览与后台总览（FR-02 / FR-05 / FR-10） ─────────────────────────

const RoutePreviewQuery = z.object({
  storeId: z.coerce.number().int().positive('门店编号不正确'),
  departmentId: z.coerce.number().int().positive().optional(),
  paymentIntent: z.enum(['company_direct', 'dept_petty']).default('company_direct'),
  priority: z.enum(REQUEST_PRIORITIES).default('normal'),
  kind: z.enum(['catalog', 'custom']).default('catalog'),
  /** 清单行：skuId:qtyMilli 以逗号分隔，如 "11:10000,15:5000" */
  lines: z.string().max(1600).optional(),
});

function parsePreviewLines(raw: string | undefined): { skuId: number; qtyMilli: number }[] {
  if (!raw || !raw.trim()) return [];
  const out: { skuId: number; qtyMilli: number }[] = [];
  for (const part of raw.split(',').slice(0, 50)) {
    const m = /^([1-9]\d*):([1-9]\d*)$/.exec(part.trim());
    if (!m) continue;
    const skuId = Number(m[1]);
    const qtyMilli = Math.min(SHOP_MAX_QTY_MILLI, Number(m[2]));
    if (Number.isSafeInteger(skuId) && Number.isSafeInteger(qtyMilli)) out.push({ skuId, qtyMilli });
  }
  return out;
}

const DAILY_SPLIT_THRESHOLD_CENTS = 3_000_000; // 3 万元日累计分流参考门槛

async function routePreview(deps: Deps, actor: Actor, raw: unknown): Promise<ShopRoutePreview> {
  const q = parse(RoutePreviewQuery, raw ?? {});
  const db = deps.sql;
  const tz = deps.config.timezone;
  const today = todayIn(tz);

  const allowed = (await allowedStores(db, actor)).map((s) => Number(s.id));
  if (!allowed.includes(q.storeId)) throw forbidden('你不能查看这家门店的审批路由');

  const [rules, me] = await Promise.all([loadPurchaseRules(db), myContext(db, actor)]);
  const canPickDept = actor.role === 'owner' || me.canReview;
  const deptId = canPickDept ? (q.departmentId ?? me.departmentId) : me.departmentId;

  const hints: ShopRoutePreviewHint[] = [];

  // 1) 部门主管确认节点（与 createMallRequest 调 deptConfirmFor(..., true) 完全同口径）
  let deptNode: ShopRoutePreviewNode;
  if (!deptId) {
    deptNode = { key: 'dept_confirm', label: '部门主管确认', role: '待补所属部门', status: 'blocked' };
    hints.push({ code: 'missing_department', tone: 'warning', text: '员工档案尚未填写所属部门，请店主在员工档案补齐后再提交。' });
  } else {
    const [d] = await db<{ name: string; headId: number | null; headName: string | null; headActive: boolean | null }[]>`
      SELECT d.name, d.head_id, h.display_name AS head_name, h.active AS head_active
      FROM departments d LEFT JOIN staff h ON h.id = d.head_id WHERE d.id = ${deptId}`;
    if (!d) {
      deptNode = { key: 'dept_confirm', label: '部门主管确认', role: '部门不存在', status: 'blocked' };
    } else if (!d.headId || !d.headActive) {
      deptNode = { key: 'dept_confirm', label: '部门主管确认', role: `${d.name}未设主管（跳过）`, status: 'skipped' };
    } else if (actor.id === Number(d.headId) || actor.role === 'owner') {
      deptNode = { key: 'dept_confirm', label: '部门主管确认', role: `${d.headName}（提交即确认）`, status: 'auto' };
    } else {
      deptNode = { key: 'dept_confirm', label: '部门主管确认', role: d.headName ?? '部门主管', status: 'active' };
    }
  }

  // 2) 核库节点与金额/同日同供应商提示（与 enterStockCheck 完全同口径）
  let stockNode: ShopRoutePreviewNode;
  let estimateCents: number | null = null;
  const hasUnpriced = q.kind === 'custom';

  if (q.kind === 'custom') {
    stockNode = { key: 'stock_check', label: '核库', role: '自主申请无编码，直进审核', status: 'skipped' };
    hints.push({
      code: 'unpriced_custom',
      tone: 'info',
      text: '待寻源，金额待定：自主申请提交后由采购归类寻源报价，同日累计、3 万元分流与备用金额度在报价后由 ERP 核验。',
    });
  } else {
    const lineSpecs = parsePreviewLines(q.lines);
    const skuIds = [...new Set(lineSpecs.map((l) => l.skuId))];
    const skuRows = skuIds.length
      ? await db<
          {
            id: number;
            supplierId: number;
            supplierName: string;
            priceCents: number;
            taxRateBp: number;
            freightCents: number;
            materialActive: boolean;
            tracked: boolean;
            stockMilli: number;
          }[]
        >`
          SELECT k.id, k.supplier_id, sp.name AS supplier_name, k.price_cents, k.tax_rate_bp, k.freight_cents,
                 m.active AS material_active, m.tracked, m.stock_milli
          FROM mall_skus k JOIN suppliers sp ON sp.id = k.supplier_id JOIN materials m ON m.id = k.material_id
          WHERE k.id IN ${db(skuIds)}`
      : [];
    const bySku = new Map(skuRows.map((r) => [Number(r.id), r]));

    let sumCents = 0;
    let hasCentralStock = false;
    const bySupplier = new Map<number, { name: string; cents: number }>();

    for (const l of lineSpecs) {
      const k = bySku.get(l.skuId);
      if (!k) continue;
      const lineCents = lineGrossCents(Number(k.priceCents), k.taxRateBp, l.qtyMilli, Number(k.freightCents));
      sumCents += lineCents;
      if (k.materialActive && k.tracked && Number(k.stockMilli) > 0) hasCentralStock = true;
      const sid = Number(k.supplierId);
      const prev = bySupplier.get(sid);
      bySupplier.set(sid, { name: k.supplierName, cents: (prev?.cents ?? 0) + lineCents });
    }
    estimateCents = sumCents;

    if (q.priority === 'urgent') {
      stockNode = { key: 'stock_check', label: '核库', role: '紧急件跳过核库', status: 'skipped' };
    } else if (!rules.stockCheckEnabled) {
      stockNode = { key: 'stock_check', label: '核库', role: '规则未开启核库', status: 'skipped' };
    } else if (hasCentralStock) {
      stockNode = { key: 'stock_check', label: '核库', role: `库管（${rules.stockCheckHours} 小时时限）`, status: 'active' };
    } else {
      stockNode = { key: 'stock_check', label: '核库', role: '总仓无结存，直进审核', status: 'skipped' };
    }

    // 同日同供应商累计与采购日累计 3 万元提示（只读参考，非承诺）
    const supIds = [...bySupplier.keys()];
    const todayRows = supIds.length
      ? await db<{ supplierId: number; reqCount: number; cents: string }[]>`
          SELECT l.supplier_id, count(DISTINCT r.id)::int AS req_count,
                 coalesce(sum(round((l.qty_milli::numeric * coalesce(l.ref_price_cents, 0)) / 1000)), 0)::bigint::text AS cents
          FROM purchase_request_lines l JOIN purchase_requests r ON r.id = l.request_id
          WHERE r.store_id = ${q.storeId} AND r.status NOT IN ('draft', 'cancelled', 'rejected')
            AND (r.created_at AT TIME ZONE ${tz})::date = ${today}::date
            AND l.supplier_id IN ${db(supIds)}
          GROUP BY l.supplier_id`
      : [];
    const todayBySup = new Map(todayRows.map((r) => [Number(r.supplierId), { count: Number(r.reqCount), cents: Number(r.cents) }]));
    const [todayStoreRow] = await db<{ cents: string }[]>`
      SELECT coalesce(sum(round((l.qty_milli::numeric * coalesce(l.ref_price_cents, 0)) / 1000)), 0)::bigint::text AS cents
      FROM purchase_request_lines l JOIN purchase_requests r ON r.id = l.request_id
      WHERE r.store_id = ${q.storeId} AND r.status NOT IN ('draft', 'cancelled', 'rejected')
        AND (r.created_at AT TIME ZONE ${tz})::date = ${today}::date`;
    const todayStoreCents = Number(todayStoreRow?.cents ?? 0);

    for (const [sid, cur] of bySupplier) {
      const prev = todayBySup.get(sid);
      if (prev && prev.count > 0) {
        hints.push({
          code: 'same_day_merge',
          tone: 'info',
          text: `可能触发同日同供应商累计合并：「${cur.name}」今日已有 ${prev.count} 张需求单，含本单预计累计 ${formatYuan(prev.cents + cur.cents)}（以 ERP 核验为准）。`,
        });
      }
    }

    const dailyTotal = todayStoreCents + sumCents;
    if (dailyTotal >= DAILY_SPLIT_THRESHOLD_CENTS) {
      hints.push({
        code: 'daily_30k',
        tone: 'warning',
        text: `可能触发采购日累计 3 万元分流：本店今日含本单预计累计 ${formatYuan(dailyTotal)}，最终由 ERP 审核分流认定。`,
      });
    }
    if (rules.quoteThresholdCents > 0 && sumCents >= rules.quoteThresholdCents) {
      hints.push({
        code: 'quote_threshold',
        tone: 'info',
        text: `本单预计金额已达询价门槛（${formatYuan(rules.quoteThresholdCents)}），采购环节按规则需至少 ${rules.minQuotes} 家比价核验。`,
      });
    }
  }

  // 3) 每日截单提醒
  if (rules.cutoffEnabled && clockIn(tz) >= rules.cutoffTime) {
    hints.push({
      code: 'cutoff',
      tone: 'info',
      text: `当前已过每日截单时间（${rules.cutoffTime}），预计最早次日由采购审核通过。`,
    });
  }

  // 4) 部门备用金支付提示（读取 8.1.42 统一部门备用金可用余额）
  if (q.paymentIntent === 'dept_petty') {
    if (deptId) {
      const [bal, occ] = await Promise.all([pettyBalances(db, deptId), pettyOccupied(db, deptId)]);
      const avail = (bal.get(deptId) ?? 0) - (occ.get(deptId) ?? 0);
      hints.push({
        code: 'petty_cash',
        tone: estimateCents !== null && avail < estimateCents ? 'warning' : 'info',
        text: `拟用部门备用金支付：当前可用余额 ${formatYuan(avail)}，实际占用与报销核销由 ERP 核验。`,
      });
    } else {
      hints.push({ code: 'petty_cash', tone: 'info', text: '拟用部门备用金支付：备用金额度与可用余额由 ERP 按所属部门核验。' });
    }
  }

  // 5) FR-02 必含文案：紧急程度仅用于排序，不构成紧急特批
  hints.push({
    code: 'urgency_rule',
    tone: q.priority === 'urgent' ? 'warning' : 'neutral',
    text: '紧急程度仅用于排序，不构成紧急特批；正式紧急采购审批需按制度另行认定。',
  });

  const nodes: ShopRoutePreviewNode[] = [
    deptNode,
    stockNode,
    { key: 'purchase_review', label: '采购审核', role: '采购审核', status: 'active' },
    { key: 'po_order', label: '下单', role: rules.requestPoDirect ? '采购下单（免二次审）' : '采购下单', status: 'active' },
    { key: 'receive', label: '到货', role: '门店 / 仓库验收', status: 'active' },
  ];

  return { nodes, hints, estimateCents, hasUnpriced };
}

async function shopOverview(db: Db): Promise<ShopOverview> {
  const [row] = await db<
    {
      materials: number;
      activeMaterials: number;
      suppliers: number;
      admittedSuppliers: number;
      activeSkus: number;
      totalSkus: number;
      pendingSkus: number;
      pendingSkuChanges: number;
      pendingSuppliers: number;
      materialsWeek: number;
      suppliersWeek: number;
      skusWeek: number;
      requestsWeek: number;
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM materials WHERE tracked) AS materials,
      (SELECT count(*)::int FROM materials WHERE tracked AND active) AS active_materials,
      (SELECT count(*)::int FROM suppliers) AS suppliers,
      (SELECT count(*)::int FROM suppliers WHERE active AND admission = 'approved') AS admitted_suppliers,
      (SELECT count(*)::int FROM mall_skus WHERE status = 'approved') AS active_skus,
      (SELECT count(*)::int FROM mall_skus) AS total_skus,
      (SELECT count(*)::int FROM mall_skus WHERE status = 'pending') AS pending_skus,
      (SELECT count(*)::int FROM mall_sku_changes WHERE status = 'pending') AS pending_sku_changes,
      (SELECT count(*)::int FROM suppliers WHERE active AND admission = 'pending') AS pending_suppliers,
      (SELECT count(*)::int FROM materials WHERE tracked AND created_at >= now() - interval '7 days') AS materials_week,
      (SELECT count(*)::int FROM suppliers WHERE created_at >= now() - interval '7 days') AS suppliers_week,
      (SELECT count(*)::int FROM mall_skus WHERE created_at >= now() - interval '7 days') AS skus_week,
      (SELECT count(*)::int FROM purchase_requests WHERE source = 'mall' AND created_at >= now() - interval '7 days') AS requests_week`;
  const r = row!;
  const pendingSkus = Number(r.pendingSkus);
  const pendingSkuChanges = Number(r.pendingSkuChanges);
  const pendingSuppliers = Number(r.pendingSuppliers);
  return {
    counts: {
      materials: Number(r.materials),
      activeMaterials: Number(r.activeMaterials),
      suppliers: Number(r.suppliers),
      admittedSuppliers: Number(r.admittedSuppliers),
      activeSkus: Number(r.activeSkus),
      totalSkus: Number(r.totalSkus),
      pendingSkus,
      pendingSkuChanges,
      pendingSuppliers,
      totalTodos: pendingSkus + pendingSkuChanges + pendingSuppliers,
    },
    recent: {
      materialsWeek: Number(r.materialsWeek),
      suppliersWeek: Number(r.suppliersWeek),
      skusWeek: Number(r.skusWeek),
      requestsWeek: Number(r.requestsWeek),
    },
    todos: {
      pendingSkus,
      pendingSkuChanges,
      pendingSuppliers,
    },
  };
}

export function registerShopRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const P = '/api/erp/shop';
  const shopper = guardAny('request.create', 'request.review', 'request.stock', 'purchase.manage');
  const skuRead = guardAny('purchase.manage', 'purchase.rules');
  const masterWrite = guardAny('inventory.master');
  // 目录是页面的起点：只审 SKU 的（「采购规则」）也要能进来，才找得到「SKU 维护」（Codex 审查）
  const catalogRead = guardAny('request.create', 'request.review', 'request.stock', 'purchase.manage', 'purchase.rules');

  app.get(`${P}/catalog`, { preHandler: catalogRead }, async (req) => catalog(deps, req.actor, (req.query as { storeId?: string } | undefined)?.storeId));
  app.get(`${P}/offers`, { preHandler: catalogRead }, async (req) => compareOffers(deps, req.actor, req.query));
  app.get(`${P}/route-preview`, { preHandler: shopper }, async (req) => routePreview(deps, req.actor, req.query));
  app.get(`${P}/overview`, { preHandler: skuRead }, async () => shopOverview(sql));
  app.get(`${P}/suppliers`, { preHandler: skuRead }, async (req) => listShopSuppliers(sql, req.actor));
  app.get(`${P}/suppliers/:id`, { preHandler: skuRead }, async (req) => shopSupplierDetail(sql, req.actor, parse(idParam, req.params).id));
  const patchSupplier = async (req: { params: unknown; body: unknown; actor: Actor; ip: string }) => {
    const supplierId = parse(idParam, req.params).id;
    const { clientKey, ...v } = parse(SupplierPatchInput, req.body);
    const requestHash = hashRequest({ op: 'supplier_patch', supplierId, patch: v });
    await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, clientKey, 'shop_master', erpOpAbandoned);
      const [done] = await tx<{ opType: string; requestHash: string; staffId: number }[]>`
        SELECT op_type, request_hash, staff_id FROM idempotency_keys WHERE key = ${clientKey}`;
      if (done) {
        if (done.opType !== 'shop_master' || done.requestHash !== requestHash || Number(done.staffId) !== req.actor.id) {
          throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一笔内容不同的主数据维护');
        }
        return;
      }
      const [cur] = await tx<{ id: number; contact: string; phone: string; note: string; active: boolean }[]>`
        SELECT id, contact, phone, note, active FROM suppliers WHERE id = ${supplierId} FOR UPDATE`;
      if (!cur) throw notFound('供应商不存在');
      await tx`
        UPDATE suppliers SET contact = ${v.contact ?? cur.contact}, phone = ${v.phone ?? cur.phone}, note = ${v.note ?? cur.note},
               active = ${v.active ?? cur.active}, updated_at = now()
        WHERE id = ${supplierId}`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'inventory_master_saved', targetType: 'supplier', targetId: supplierId, detail: { source: 'shop', ...v }, ip: req.ip });
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${clientKey}, 'shop_master', ${requestHash}, ${supplierId}, ${req.actor.id})`;
    });
    return shopSupplierDetail(sql, req.actor, supplierId);
  };
  app.patch(`${P}/suppliers/:id`, { preHandler: masterWrite }, patchSupplier);
  app.put(`${P}/suppliers/:id`, { preHandler: masterWrite }, patchSupplier);
  app.get(`${P}/materials`, { preHandler: skuRead }, async () => listShopMaterials(sql, todayIn(deps.config.timezone)));
  const patchMaterial = async (req: { params: unknown; body: unknown; actor: Actor; ip: string }) => {
    const materialId = parse(idParam, req.params).id;
    const { clientKey, ...v } = parse(MaterialPatchInput, req.body);
    const requestHash = hashRequest({ op: 'material_patch', materialId, patch: v });
    await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, clientKey, 'shop_master', erpOpAbandoned);
      const [done] = await tx<{ opType: string; requestHash: string; staffId: number }[]>`
        SELECT op_type, request_hash, staff_id FROM idempotency_keys WHERE key = ${clientKey}`;
      if (done) {
        if (done.opType !== 'shop_master' || done.requestHash !== requestHash || Number(done.staffId) !== req.actor.id) {
          throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一笔内容不同的主数据维护');
        }
        return;
      }
      const [cur] = await tx<{ id: number; category: string; note: string; active: boolean }[]>`
        SELECT id, category, note, active FROM materials WHERE id = ${materialId} AND tracked FOR UPDATE`;
      if (!cur) throw notFound('受管物料不存在');
      await tx`
        UPDATE materials SET category = ${v.category ?? cur.category}, note = ${v.note ?? cur.note}, active = ${v.active ?? cur.active}, updated_at = now()
        WHERE id = ${materialId}`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'inventory_master_saved', targetType: 'material', targetId: materialId, detail: { source: 'shop', ...v }, ip: req.ip });
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${clientKey}, 'shop_master', ${requestHash}, ${materialId}, ${req.actor.id})`;
    });
    const list = await listShopMaterials(sql, todayIn(deps.config.timezone));
    return list.find((m) => m.id === materialId)!;
  };
  // 商品图（8.1.50）：物料主档里整组换（要「物料档案」权限）；采购商城的人都能看，只给挂在物料上的图，别的图片按编号取不到
  app.put(`${P}/materials/:id/images`, { preHandler: masterWrite }, async (req) => ({
    imageIds: await setMaterialImages(sql, parse(idParam, req.params).id, req.body, req.actor.id, req.ip),
  }));
  app.get(`${P}/images/:id`, { preHandler: catalogRead }, async (req, reply) => {
    const id = parse(idParam, req.params).id;
    const [img] = await sql<{ mime: string; data: Buffer }[]>`
      SELECT i.mime, i.data FROM erp_images i WHERE i.id = ${id} AND i.scope = 'general' AND EXISTS (SELECT 1 FROM material_images mi WHERE mi.image_id = i.id)`;
    if (!img) throw notFound('图片不存在');
    reply.header('content-type', img.mime).header('cache-control', 'private, max-age=31536000, immutable').header('x-content-type-options', 'nosniff');
    return reply.send(img.data);
  });
  app.patch(`${P}/materials/:id`, { preHandler: masterWrite }, patchMaterial);
  app.put(`${P}/materials/:id`, { preHandler: masterWrite }, patchMaterial);
  app.post(`${P}/materials/batch-category`, { preHandler: masterWrite }, async (req) => {
    const { clientKey, materialIds, category } = parse(BatchCategoryInput, req.body);
    const ids = [...new Set(materialIds)].sort((a, b) => a - b);
    const requestHash = hashRequest({ op: 'material_batch_category', ids, category });
    return sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, clientKey, 'shop_master', erpOpAbandoned);
      const [done] = await tx<{ opType: string; requestHash: string; refId: number; staffId: number }[]>`
        SELECT op_type, request_hash, ref_id, staff_id FROM idempotency_keys WHERE key = ${clientKey}`;
      if (done) {
        if (done.opType !== 'shop_master' || done.requestHash !== requestHash || Number(done.staffId) !== req.actor.id) {
          throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一笔内容不同的主数据维护');
        }
        const [cnt] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM materials WHERE id IN ${tx(ids)} AND tracked`;
        return { id: Number(done.refId), updated: Number(cnt?.n ?? 0) };
      }
      const locked = await tx<{ id: number }[]>`SELECT id FROM materials WHERE id IN ${tx(ids)} AND tracked ORDER BY id FOR UPDATE`;
      if (locked.length === 0) throw notFound('未找到可修改的受管物料');
      const foundIds = locked.map((r) => Number(r.id));
      await tx`UPDATE materials SET category = ${category}, updated_at = now() WHERE id IN ${tx(foundIds)}`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'inventory_master_saved',
        targetType: 'material',
        detail: { source: 'shop_batch_category', materialIds: foundIds, category },
        ip: req.ip,
      });
      const refId = foundIds[0]!;
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${clientKey}, 'shop_master', ${requestHash}, ${refId}, ${req.actor.id})`;
      return { id: refId, updated: foundIds.length };
    });
  });
  app.post(`${P}/requests`, { preHandler: guardAny('request.create') }, async (req, reply) => {
    const r = await submit(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    return r;
  });
  // 我的采购需求（只看本部门、自己提的、自己当主管的）与需求池（审核、核库的人看全部商城来的单）
  app.get(`${P}/requests`, { preHandler: shopper }, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const pool = q.scope === 'pool';
    if (pool && !can(req.actor, 'request.review') && !can(req.actor, 'request.stock')) throw forbidden('需求池只给采购、库管看');
    const { scope: _scope, ...rest } = q;
    return pagedMall(deps, req.actor, rest, { mineOnly: !pool });
  });
  app.get(`${P}/requests/export`, { preHandler: shopper }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const pool = q.scope === 'pool';
    if (pool && !can(req.actor, 'request.review') && !can(req.actor, 'request.stock')) throw forbidden('需求池只给采购、库管看');
    const { scope: _scope, ...rest } = q;
    const { fileName, csv } = await exportMallCsv(deps, req.actor, rest, { mineOnly: !pool, ip: req.ip });
    return csvReply(reply, fileName, csv);
  });
  app.get(`${P}/requests/:id`, { preHandler: shopper }, async (req) => mallRequest(deps, req.actor, parse(idParam, req.params).id));
  // 8.1.51 试点：退回后在原单补资料重提（提单人）；需求池接单（采购）；成交方案（采购记、部门确认或采购代记已在微信确认）
  app.put(`${P}/requests/:id/resubmit`, { preHandler: guardAny('request.create') }, async (req) => {
    const rid = parse(idParam, req.params).id;
    await resubmitMallRequest(deps, rid, req.body, req.actor, req.ip);
    return mallRequest(deps, req.actor, rid);
  });
  app.post(`${P}/requests/:id/claim`, { preHandler: guardAny('purchase.manage', 'request.review') }, async (req) => {
    const rid = parse(idParam, req.params).id;
    await claimMallRequest(deps, rid, req.body, req.actor, req.ip);
    return mallRequest(deps, req.actor, rid);
  });
  app.post(`${P}/requests/:id/quotes`, { preHandler: guardAny('purchase.manage', 'request.review') }, async (req, reply) => {
    const rid = parse(idParam, req.params).id;
    await addQuote(deps, rid, req.body, req.actor, req.ip);
    reply.code(201);
    return mallRequest(deps, req.actor, rid);
  });
  // 报价截图（Codex 审查）：单独一类图片，只有采购（经办、审核）能传能看；看的时候要挂在某条方案上，或是自己刚传还没保存的
  const sourcer = guardAny('purchase.manage', 'request.review');
  app.post(`${P}/quote-images`, { preHandler: sourcer, bodyLimit: 1_600_000 }, async (req, reply) => {
    const img = await saveImage(sql, req.body, req.actor, 'quote');
    reply.code(201);
    return { id: img.id, url: `${P}/quote-images/${img.id}` };
  });
  app.get(`${P}/quote-images/:id`, { preHandler: sourcer }, async (req, reply) => {
    const imgId = parse(idParam, req.params).id;
    const [img] = await sql<{ mime: string; data: Buffer }[]>`
      SELECT i.mime, i.data FROM erp_images i
      WHERE i.id = ${imgId} AND i.scope = 'quote'
        AND (i.created_by = ${req.actor.id} OR EXISTS (SELECT 1 FROM mall_request_quotes q WHERE i.id = ANY (q.image_ids)))`;
    if (!img) throw notFound('图片不存在');
    reply.header('content-type', img.mime).header('cache-control', 'private, max-age=31536000, immutable').header('x-content-type-options', 'nosniff');
    return reply.send(img.data);
  });
  app.post(`${P}/quotes/:id/withdraw`, { preHandler: guardAny('purchase.manage', 'request.review') }, async (req) =>
    mallRequest(deps, req.actor, await withdrawQuote(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip)),
  );
  app.post(`${P}/quotes/:id/select`, { preHandler: shopper }, async (req) => mallRequest(deps, req.actor, await selectQuote(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip)));

  app.get(`${P}/skus`, { preHandler: skuRead }, async () => listSkus(sql));
  // 维护 SKU 选物料、供应商用（Codex 审查）：只有「采购管理」没有「库存查看」的人也要能选；只给在用的、选得着的几项
  app.get(`${P}/master`, { preHandler: skuRead }, async () => ({
    materials: (
      await sql<{ id: number; code: string; name: string; unit: string }[]>`
      SELECT id, code, name, purchase_unit AS unit FROM materials WHERE active AND tracked ORDER BY code`
    ).map((m) => ({ ...m, id: Number(m.id) })),
    suppliers: (
      await sql<{ id: number; code: string; name: string; admission: string }[]>`
      SELECT id, code, name, admission FROM suppliers WHERE active ORDER BY code`
    ).map((x) => ({ ...x, id: Number(x.id) })),
  }));
  app.post(`${P}/skus`, { preHandler: guardAny('purchase.manage') }, async (req, reply) => {
    const v = parse(SkuInput, req.body);
    assertGross(v);
    const skuId = await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await checkSkuRefs(tx, v);
      const [dup] = await tx<{ id: number }[]>`SELECT id FROM mall_skus WHERE sku_code = ${v.skuCode}`;
      if (dup) throw conflict('SKU_CODE_EXISTS', `SKU 编码 ${v.skuCode} 已经有了`);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO mall_skus (material_id, supplier_id, sku_code, price_cents, tax_rate_bp, moq_milli, lead_days, freight_cents, valid_until, store_ids, note, created_by,
                               unit, unit_factor_milli)
        SELECT ${v.materialId}, ${v.supplierId}, ${v.skuCode}, ${v.priceCents}, ${v.taxRateBp}, ${v.moqMilli}, ${v.leadDays}, ${v.freightCents}, ${v.validUntil},
               ${v.storeIds}, ${v.note}, ${req.actor.id}, m.purchase_unit, m.purchase_factor_milli
        FROM materials m WHERE m.id = ${v.materialId}
        RETURNING id`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'mall_sku', targetType: 'mall_sku', targetId: row!.id, detail: { action: 'create', ...v }, ip: req.ip });
      return Number(row!.id);
    });
    reply.code(201);
    return one(sql, skuId);
  });
  // 草稿可以随便改（带版本号，别人先改过的拒绝）；提交以后的核心信息走改动审核
  app.put(`${P}/skus/:id`, { preHandler: guardAny('purchase.manage') }, async (req) => {
    const skuId = parse(idParam, req.params).id;
    const v = parse(SkuEdit, req.body);
    assertGross(v);
    return skuOp(deps, req.actor, skuId, req.ip, async (tx, k) => {
      if (k.version !== v.version) throw conflict('SKU_CHANGED', '这条 SKU 刚被别人改过，请刷新后再改');
      if (k.status === 'draft') {
        await checkSkuRefs(tx, v);
        await tx`
          UPDATE mall_skus SET material_id = ${v.materialId}, supplier_id = ${v.supplierId}, sku_code = ${v.skuCode}, price_cents = ${v.priceCents},
                 tax_rate_bp = ${v.taxRateBp}, moq_milli = ${v.moqMilli}, lead_days = ${v.leadDays}, freight_cents = ${v.freightCents},
                 valid_until = ${v.validUntil}, store_ids = ${v.storeIds}, note = ${v.note}, version = version + 1, updated_at = now(),
                 unit = m.purchase_unit, unit_factor_milli = m.purchase_factor_milli
          FROM materials m WHERE mall_skus.id = ${skuId} AND m.id = ${v.materialId}`;
        return 'edit';
      }
      // 提交以后：只改不影响价格的（交期、备注）；核心信息要另提改动
      const core: (keyof ShopSkuCore)[] = ['priceCents', 'taxRateBp', 'moqMilli', 'freightCents', 'validUntil'];
      if (core.some((f) => v[f] !== k[f]) || [...v.storeIds].sort().join() !== [...k.storeIds].sort().join())
        throw unprocessable('SKU_CORE_CHANGE', '已提交的 SKU 改价格、税率、起订量、运费、有效期、适用门店要提「改动」审核');
      await tx`UPDATE mall_skus SET lead_days = ${v.leadDays}, note = ${v.note}, version = version + 1, updated_at = now() WHERE id = ${skuId}`;
      return 'edit_minor';
    });
  });
  app.post(`${P}/skus/:id/submit`, { preHandler: guardAny('purchase.manage') }, async (req) =>
    skuOp(
      deps,
      req.actor,
      parse(idParam, req.params).id,
      req.ip,
      async (tx, k) => {
        if (k.status !== 'draft') throw unprocessable('SKU_STATUS', '只有草稿能提交');
        await tx`UPDATE mall_skus SET status = 'pending', submitted_by = ${req.actor.id}, submitted_at = now(), version = version + 1, updated_at = now() WHERE id = ${parse(idParam, req.params).id}`;
        return 'submit';
      },
      req.body,
    ),
  );
  // 上架时照物料现在的采购单位、换算重新抄一遍：审核人看到的就是按这个单位报的价
  app.post(`${P}/skus/:id/approve`, { preHandler: guardAny('purchase.rules', 'settings.manage') }, async (req) =>
    skuOp(
      deps,
      req.actor,
      parse(idParam, req.params).id,
      req.ip,
      async (tx, k) => {
        if (k.status !== 'pending') throw unprocessable('SKU_STATUS', '只有待审核的能上架');
        assertApprover(req.actor, k.submittedBy);
        await tx`UPDATE mall_skus SET status = 'approved', approved_by = ${req.actor.id}, approved_at = now(), version = version + 1, updated_at = now(),
                 unit = m.purchase_unit, unit_factor_milli = m.purchase_factor_milli
          FROM materials m WHERE mall_skus.id = ${parse(idParam, req.params).id} AND m.id = mall_skus.material_id`;
        return 'approve';
      },
      req.body,
    ),
  );
  app.post(`${P}/skus/:id/return`, { preHandler: guardAny('purchase.rules', 'settings.manage') }, async (req) => {
    const { note } = parse(NoteInput, req.body ?? {});
    return skuOp(
      deps,
      req.actor,
      parse(idParam, req.params).id,
      req.ip,
      async (tx, k) => {
        if (k.status !== 'pending') throw unprocessable('SKU_STATUS', '只有待审核的能退回');
        assertApprover(req.actor, k.submittedBy);
        await tx`UPDATE mall_skus SET status = 'draft', submitted_by = NULL, submitted_at = NULL, note = ${note || '审核退回'}, version = version + 1, updated_at = now() WHERE id = ${parse(idParam, req.params).id}`;
        return 'return';
      },
      req.body,
    );
  });
  app.post(`${P}/skus/:id/disable`, { preHandler: guardAny('purchase.manage') }, async (req) =>
    skuOp(
      deps,
      req.actor,
      parse(idParam, req.params).id,
      req.ip,
      async (tx, k) => {
        if (k.status === 'disabled') return 'disable';
        if (k.status !== 'approved') throw unprocessable('SKU_STATUS', '草稿、待审核的不用停用');
        // 有待审的改动时不能停用（Codex 审查）：不然停用 → 重新上架 → 退回草稿改了物料，旧改动批下来会套到另一份报价上
        if (k.corePending) throw conflict('SKU_CHANGE_PENDING', '这条 SKU 有一张改动在审核，先批准、驳回或撤回再停用');
        await tx`UPDATE mall_skus SET status = 'disabled', version = version + 1, updated_at = now() WHERE id = ${parse(idParam, req.params).id}`;
        return 'disable';
      },
      req.body,
    ),
  );
  // 停用的重新上架要再审一次；价格版本加 1（Codex 审查）：再审时可能被退回成草稿改价、换物料，停用前加进清单的提交时都要重新确认新价
  app.post(`${P}/skus/:id/enable`, { preHandler: guardAny('purchase.manage') }, async (req) =>
    skuOp(
      deps,
      req.actor,
      parse(idParam, req.params).id,
      req.ip,
      async (tx, k) => {
        if (k.status !== 'disabled') throw unprocessable('SKU_STATUS', '只有停用的能重新上架');
        await tx`UPDATE mall_skus SET status = 'pending', submitted_by = ${req.actor.id}, submitted_at = now(), approved_by = NULL, approved_at = NULL, price_version = price_version + 1, version = version + 1, updated_at = now() WHERE id = ${parse(idParam, req.params).id}`;
        return 'enable';
      },
      req.body,
    ),
  );

  // 核心改动：提了以后这条 SKU 暂停采购，批了才换成新的、价格版本加一
  app.post(`${P}/skus/:id/changes`, { preHandler: guardAny('purchase.manage') }, async (req) => {
    const skuId = parse(idParam, req.params).id;
    const after = parse(CoreInput, req.body);
    assertGross(after);
    const { reason } = parse(ReasonInput, req.body);
    return skuOp(
      deps,
      req.actor,
      skuId,
      req.ip,
      async (tx, k) => {
        if (k.status !== 'approved') throw unprocessable('SKU_STATUS', '只有已上架的提改动；草稿直接改');
        if (k.corePending) throw conflict('SKU_CHANGE_PENDING', '这条 SKU 已经有一张改动在审核');
        if (after.storeIds.length) {
          const n = await tx<{ id: number }[]>`SELECT id FROM stores WHERE id IN ${tx(after.storeIds)} AND active`;
          if (n.length !== new Set(after.storeIds).size) throw unprocessable('STORE_INVALID', '适用门店里有不存在或已停用的');
        }
        const before: ShopSkuCore = { priceCents: k.priceCents, taxRateBp: k.taxRateBp, moqMilli: k.moqMilli, freightCents: k.freightCents, validUntil: k.validUntil, storeIds: k.storeIds };
        await tx`INSERT INTO mall_sku_changes (sku_id, before, after, reason, requested_by) VALUES (${skuId}, ${tx.json({ ...before })}, ${tx.json({ ...after })}, ${reason}, ${req.actor.id})`;
        await tx`UPDATE mall_skus SET core_pending = true, version = version + 1, updated_at = now() WHERE id = ${skuId}`;
        return 'change_request';
      },
      req.body,
    );
  });
  for (const decision of ['approve', 'reject', 'withdraw'] as const) {
    app.post(`${P}/changes/:id/${decision}`, { preHandler: guardAny('purchase.manage', 'purchase.rules', 'settings.manage') }, async (req) => {
      const changeId = parse(idParam, req.params).id;
      const { note } = parse(NoteInput, req.body ?? {});
      const [c] = await sql<{ skuId: number }[]>`SELECT sku_id FROM mall_sku_changes WHERE id = ${changeId}`;
      if (!c) throw notFound('改动不存在');
      return skuOp(deps, req.actor, Number(c.skuId), req.ip, async (tx, k) => {
        const [ch] = await tx<{ status: string; requestedBy: number; after: ShopSkuCore }[]>`
          SELECT status, requested_by, after FROM mall_sku_changes WHERE id = ${changeId} FOR UPDATE`;
        if (!ch || ch.status !== 'pending') throw unprocessable('CHANGE_DECIDED', '这张改动已经定下来了');
        // 改动只对提的时候那份上架中的报价有效：SKU 已经不在上架（或不在改动审核中）就不能批（Codex 审查）
        if (decision === 'approve' && (k.status !== 'approved' || !k.corePending)) throw conflict('CHANGE_STALE', '这条 SKU 已经不是提改动时的状态，这张改动不能批，请驳回或撤回');
        if (decision === 'withdraw') {
          if (Number(ch.requestedBy) !== req.actor.id && req.actor.role !== 'owner') throw forbidden('只能撤回自己提的改动');
        } else assertApprover(req.actor, Number(ch.requestedBy));
        const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'withdrawn';
        await tx`UPDATE mall_sku_changes SET status = ${status}, decided_by = ${req.actor.id}, decided_at = now(), decision_note = ${note} WHERE id = ${changeId}`;
        if (decision === 'approve') {
          const a = ch.after;
          await tx`
            UPDATE mall_skus SET price_cents = ${a.priceCents}, tax_rate_bp = ${a.taxRateBp}, moq_milli = ${a.moqMilli}, freight_cents = ${a.freightCents},
                   valid_until = ${a.validUntil}, store_ids = ${a.storeIds}, price_version = price_version + 1, core_pending = false,
                   version = version + 1, updated_at = now()
            WHERE id = ${Number(c.skuId)}`;
        } else {
          await tx`UPDATE mall_skus SET core_pending = false, version = version + 1, updated_at = now() WHERE id = ${Number(c.skuId)}`;
        }
        return `change_${decision}`;
      });
    });
  }
}
