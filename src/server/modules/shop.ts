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
import { can } from '@shared/permissions';
import { REQUEST_PRIORITIES } from '@shared/requests';
import { grossCents, SHOP_BLOCK_LABELS, type ShopBlock, type ShopCatalog, type ShopItem, type ShopOffer, type ShopSku, type ShopSkuCore, type ShopSkuStatus } from '@shared/shop';
import type { Db } from '../db';
import { guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { todayIn } from '../lib/dates';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { loadExpenseRules } from './expenses';
import { docDateSchema } from './inventory/common';
import { createMallRequest, mallRequest, pagedMall } from './mall';
import { allowedStores } from './stores';
import { hashRequest } from '../lib/idempotency';
import { myContext } from './requests';

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
  const items: ShopItem[] = materials
    .map((m) => {
      const offers = byMaterial.get(Number(m.id)) ?? [];
      const ok = offers.filter((o) => o.block === null);
      return {
        material: { ...m, id: Number(m.id) },
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
    },
    today,
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
    details: z.string().trim().min(1, '请填写规格与技术要求').max(1000),
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
            details: l.details,
            brandModel: l.brandModel,
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

export function registerShopRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const P = '/api/erp/shop';
  const shopper = guardAny('request.create', 'request.review', 'request.stock', 'purchase.manage');
  const skuRead = guardAny('purchase.manage', 'purchase.rules');
  // 目录是页面的起点：只审 SKU 的（「采购规则」）也要能进来，才找得到「SKU 维护」（Codex 审查）
  const catalogRead = guardAny('request.create', 'request.review', 'request.stock', 'purchase.manage', 'purchase.rules');

  app.get(`${P}/catalog`, { preHandler: catalogRead }, async (req) => catalog(deps, req.actor, (req.query as { storeId?: string } | undefined)?.storeId));
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
  app.get(`${P}/requests/:id`, { preHandler: shopper }, async (req) => mallRequest(deps, req.actor, parse(idParam, req.params).id));

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
