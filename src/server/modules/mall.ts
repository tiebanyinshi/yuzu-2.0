// 采购商城 V1.1 对接（8.1.31，店主 2026-11-24，docs/MALL_V8131.md）：商城后端经 /api/erp/mall/* 把部门的采购需求提进来，
// 生成同一种采购需求单（XQ），再按需求单号查进度、退回原因。之后的主管确认、核库、采购审核、转采购单、收货都在 ERP 里照旧办。
//
// · 认人：商城后端在 x-mall-key 里带服务密钥（MALL_API_KEY，常量时间比对），在 x-mall-staff-id 里带员工编号；
//   每次请求按员工编号现拼账号（权限、停用、改密、选岗与浏览器会话同一套），员工在 ERP 停用或撤了权限马上生效。
//   商城的请求不读浏览器 Cookie、不做浏览器的来源检查（服务端之间调用，没有 Origin），所以拿着员工的 Cookie 也进不来。
// · 建单：与 ERP 填单同一个事务写法（操作编号的咨询锁 → 原样重提给第一次的结果 → 确认作废的拦住 → 写单），
//   多一道商城单号去重（同一个商城单号只建一张单，换了操作编号也不行）。加锁顺序见 docs/LOCKING.md「部门需求单」。
// · 只读主数据：部门、门店、主体、用途、截单规则；物料；供应商只给名字、联系人与准入状态（银行账户、电话、证照一概不给）。
// · 不开放：商城里改退回的单、撤回（店主 2026-11-24 定：首版商城只看原因，改单回 ERP 改）；多供应商 SKU 与协议价（先不开放）。

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can } from '@shared/permissions';
import {
  MALL_BATCH_LIMIT,
  MALL_DISPLAY_LABELS,
  MALL_KEY_HEADER,
  MALL_LIST_LIMIT,
  MALL_PREFIX,
  MALL_STAFF_HEADER,
  MALL_STORE_HEADER,
  type MallCreateResult,
  type MallDisplayStatus,
  type MallIdentity,
  type MallRequest,
  type MallRequestBrief,
} from '@shared/mall';
import { MAX_LINE_IMAGES, REQUEST_PRIORITIES, REQUEST_STATUS_LABELS, type PurchaseRequest, type RequestStatus, type PurchaseRequestSummary } from '@shared/requests';
import { isUniqueViolation, type Db, type Sql } from '../db';
import { guard, guardAny } from '../auth/guard';
import { checkLock, clearFailures, recordFailure } from '../auth/lockout';
import { verifyPassword } from '../auth/password';
import { resolveStaffActor } from '../auth/session';
import type { AppConfig } from '../config';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { AppError, conflict, forbidden, notFound, unauthorized, unprocessable } from '../lib/errors';
import { assertNotFenced, fenceKey, lockOpKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { decodedPath } from '../lib/paths';
import { todayIn } from '../lib/dates';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { allowedStores } from './stores';
import { erpOpAbandoned, lookupErpOp } from './erp-ops';
import { enabledErpModules, erpModuleDisabled } from './erp';
import { loadExpenseRules } from './expenses';
import { docDateSchema, logApproval } from './inventory/common';
import { loadPurchaseRules } from './inventory/purchase-rules';
import { enterStockCheck } from './request-stock';
import { approvableOnFor, deptConfirmFor, getRequest, myContext, readImageFor, resolveDepartment, saveImage, summaries, toSummary, validateLines, visible, writeLines } from './requests';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** 地址是不是商城的接口（按解码后的路径认） */
export const isMallPath = (path: string) => path === MALL_PREFIX || path.startsWith(`${MALL_PREFIX}/`);

const positiveInt = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
};

/**
 * 商城请求的认人（主程序的 onRequest 里、在浏览器来源检查与读会话之前调）：服务密钥对了，再按员工编号拼账号。
 * 登录校验接口只要密钥（那时还不知道是谁）。门店（x-mall-store-id）给了就要是这位员工能进的。
 */
export async function authenticateMall(req: FastifyRequest, sql: Sql, config: AppConfig): Promise<void> {
  if (!config.mallApiKey) throw new AppError(503, 'MALL_NOT_CONFIGURED', '门店系统还没有配置采购商城的服务密钥（MALL_API_KEY），商城接口没有开');
  const got = req.headers[MALL_KEY_HEADER];
  // 先各自取摘要再比：长度不同也不提前返回
  if (typeof got !== 'string' || !timingSafeEqual(digest(got), digest(config.mallApiKey))) throw new AppError(401, 'MALL_KEY_REJECTED', '请求来源不正确');
  if (decodedPath(req.url) === `${MALL_PREFIX}/auth/verify`) return;
  const staffId = positiveInt(req.headers[MALL_STAFF_HEADER]);
  if (staffId === null) throw new AppError(401, 'MALL_STAFF_REQUIRED', `请在 ${MALL_STAFF_HEADER} 里带上员工编号`);
  const rawStore = req.headers[MALL_STORE_HEADER];
  const storeId = rawStore === undefined ? null : positiveInt(rawStore);
  if (rawStore !== undefined && storeId === null) throw unprocessable('MALL_STORE_INVALID', `${MALL_STORE_HEADER} 不是有效的门店编号`);
  const found = await resolveStaffActor(sql, staffId, storeId);
  if (!found) throw new AppError(401, 'MALL_STAFF_INVALID', '账号不存在或已停用');
  if (storeId !== null && !found.storeIds.includes(storeId)) throw forbidden('这位员工不能进这家门店');
  req.actor = found.actor;
  // 按已登录处理：权限检查、ERP 模块开关（「采购需求单」关着时一律 ERP_MODULE_DISABLED）与浏览器会话同一套
  req.hasSession = true;
}

// ───────────────────────── 身份 ─────────────────────────

async function identityOf(db: Db, actor: Actor): Promise<MallIdentity> {
  const me = await myContext(db, actor);
  const [st] = await db<{ active: boolean; position: string | null }[]>`SELECT active, position FROM staff WHERE id = ${actor.id}`;
  const stores = await allowedStores(db, actor);
  const entities = stores.length
    ? await db<{ id: number; entityId: number | null; entityName: string | null }[]>`
        SELECT s.id, s.entity_id, e.name AS entity_name FROM stores s LEFT JOIN legal_entities e ON e.id = s.entity_id WHERE s.id IN ${db(stores.map((s) => s.id))}`
    : [];
  const ent = new Map(entities.map((e) => [Number(e.id), e]));
  return {
    staff: { id: actor.id, username: actor.username, displayName: actor.displayName, active: st?.active ?? false, role: actor.role, position: st?.position ?? null },
    department: me.departmentId !== null ? { id: me.departmentId, name: me.departmentName ?? '' } : null,
    headOf: me.headOf,
    stores: stores.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      entityId: ent.get(s.id)?.entityId != null ? Number(ent.get(s.id)!.entityId) : null,
      entityName: ent.get(s.id)?.entityName ?? null,
    })),
    mustChangePassword: actor.mustChangePassword,
    needsPosition: actor.needsPosition === true,
    capabilities: {
      canCreateRequest: can(actor, 'request.create'),
      canReviewRequest: can(actor, 'request.review'),
      canStockCheck: can(actor, 'request.stock'),
      canReadInventory: can(actor, 'inventory.read'),
      canManagePurchase: can(actor, 'purchase.manage'),
    },
  };
}

const VerifyInput = z.object({
  username: z.string().trim().min(1, '请填写账号').max(40),
  password: z.string().min(1, '请填写密码').max(200),
  /** 员工在商城登录时的来源 IP（登录限次按它算；不给按商城后端的地址算） */
  clientIp: z.string().trim().max(64).optional(),
});

// ───────────────────────── 建单 ─────────────────────────

const id = z.number().int().positive();
const text = (max: number, label: string) => z.string().trim().max(max, `${label}最多 ${max} 个字`).default('');

const MallLineInput = z.object({
  materialId: id.nullable().default(null),
  supplierId: id.nullable().default(null),
  mallSkuCode: text(40, 'SKU 编码'),
  priceVersion: text(20, '价格版本'),
  name: z.string().trim().min(1, '请填写品名').max(100, '品名最多 100 个字'),
  /** 用途：要在 ERP 的固定用途里；空着按「其他」（没有「其他」时要填） */
  purpose: z.string().trim().max(20).default(''),
  qtyMilli: z.number().int().positive('数量必须大于 0').max(1_000_000_000),
  unit: z.string().trim().min(1, '请填写单位').max(8, '单位最多 8 个字'),
  refPriceCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
  taxRateBp: z.number().int().min(0).max(10_000).nullable().default(null),
  freightCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
  link: text(1000, '链接'),
  details: text(1000, '规格与技术要求'),
  brandModel: text(150, '品牌型号'),
  expectedCategory: text(32, '预期分类'),
  reasonText: text(1000, '采购理由'),
  note: text(500, '行备注'),
  imageIds: z.array(id).max(MAX_LINE_IMAGES, `每一行最多 ${MAX_LINE_IMAGES} 张图片`).default([]),
});

const MallCreateInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号（clientKey，UUID）'),
  externalNo: z.string().trim().min(1, '缺少商城申请单号').max(64, '商城申请单号最多 64 个字'),
  departmentId: id.nullable().default(null),
  contactName: text(40, '经办人'),
  storeId: id.nullable().default(null),
  entityId: id.nullable().default(null),
  budgetProject: text(80, '预算项目'),
  needBy: docDateSchema.nullable().default(null),
  deliveryAddress: text(120, '收货地点'),
  paymentIntent: z.enum(['company_direct', 'dept_petty']).nullable().default(null),
  priority: z.enum(REQUEST_PRIORITIES).default('normal'),
  note: text(500, '备注'),
  lines: z.array(MallLineInput).min(1, '至少一行').max(50, '一张需求单最多 50 行'),
});

async function checkRefs(db: Db, input: z.infer<typeof MallCreateInput>, today: string) {
  if (input.needBy !== null && input.needBy < today) throw unprocessable('NEED_BY_PAST', '期望到货日期不能早于今天');
  if (input.storeId !== null) {
    const [s] = await db<{ active: boolean }[]>`SELECT active FROM stores WHERE id = ${input.storeId}`;
    if (!s?.active) throw unprocessable('STORE_INVALID', '适用门店不存在或已停用');
  }
  if (input.entityId !== null) {
    const [e] = await db<{ active: boolean }[]>`SELECT active FROM legal_entities WHERE id = ${input.entityId}`;
    if (!e?.active) throw unprocessable('ENTITY_INVALID', '费用承担主体不存在或已停用');
  }
}

/** 用途空着的按「其他」（ERP 的固定用途里有「其他」时） */
async function withPurposes(db: Db, lines: z.infer<typeof MallLineInput>[]) {
  const { purposes } = await loadExpenseRules(db);
  return lines.map((l) => ({ ...l, purpose: l.purpose || (purposes.includes('其他') ? '其他' : '') }));
}

export async function createMallRequest(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<MallCreateResult> {
  const input = parse(MallCreateInput, raw);
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const findExisting = async (db: Db) => {
    const [row] = await db<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (!row) return null;
    if (row.opType !== 'purchase_request' || row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一笔内容不同的申请');
    return Number(row.refId);
  };
  let requestId: number;
  let replayed = false;
  try {
    const r = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, input.clientKey);
      const existing = await findExisting(tx);
      if (existing) return { id: existing, replayed: true };
      await assertNotFenced(tx, input.clientKey, 'purchase_request', erpOpAbandoned);
      const [dup] = await tx<{ docNo: string }[]>`SELECT doc_no FROM purchase_requests WHERE external_no = ${input.externalNo}`;
      if (dup) throw conflict('EXTERNAL_NO_EXISTS', `商城申请单号 ${input.externalNo} 已经建过需求单 ${dup.docNo}`, { docNo: dup.docNo });
      const today = todayIn(deps.config.timezone);
      await checkRefs(tx, input, today);
      const deptId = await resolveDepartment(tx, actor, input.departmentId);
      const lines = await withPurposes(tx, input.lines);
      await validateLines(tx, lines, { mall: true });
      const docNo = await nextDocNo(tx, 'purchase_request', 'XQ', today);
      const approvableOn = await approvableOnFor(tx, deps.config.timezone);
      // 全部需求单都要部门主管确认（店主 2026-11-24）：商城来的不看金额门槛
      const confirm = await deptConfirmFor(tx, deptId, actor, lines, true);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO purchase_requests (doc_no, department_id, requester_id, need_by, note, status, client_key, priority, approvable_on,
                                       dept_confirm, dept_head_id, dept_confirmed_by, dept_confirmed_at,
                                       source, external_no, contact_name, store_id, entity_id, budget_project, delivery_address, payment_intent)
        VALUES (${docNo}, ${deptId}, ${actor.id}, ${input.needBy}, ${input.note}, 'submitted', ${input.clientKey}, ${input.priority}, ${approvableOn},
                ${confirm.state}, ${confirm.headId}, ${confirm.state === 'confirmed' ? actor.id : null}, ${confirm.state === 'confirmed' ? tx`now()` : null},
                'mall', ${input.externalNo}, ${input.contactName}, ${input.storeId}, ${input.entityId}, ${input.budgetProject}, ${input.deliveryAddress}, ${input.paymentIntent})
        RETURNING id`;
      await writeLines(tx, row!.id, lines);
      await enterStockCheck(tx, row!.id);
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'purchase_request', ${requestHash}, ${row!.id}, ${actor.id})`;
      await logApproval(tx, 'purchase_request', row!.id, 'create', actor.id);
      await logApproval(tx, 'purchase_request', row!.id, 'submit', actor.id);
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'purchase_request',
        targetType: 'purchase_request',
        targetId: row!.id,
        detail: { docNo, lines: input.lines.length, source: 'mall', externalNo: input.externalNo },
        ip,
      });
      return { id: row!.id, replayed: false };
    });
    requestId = r.id;
    replayed = r.replayed;
  } catch (error) {
    if (isUniqueViolation(error, 'idempotency_keys_pkey') || isUniqueViolation(error, 'purchase_requests_client_key_key')) {
      const existing = await findExisting(deps.sql);
      if (!existing) throw error;
      requestId = existing;
      replayed = true;
    } else if (isUniqueViolation(error, 'purchase_requests_external_no_uq')) {
      throw conflict('EXTERNAL_NO_EXISTS', `商城申请单号 ${input.externalNo} 已经建过需求单`);
    } else throw error;
  }
  return { request: await mallRequest(deps, actor, requestId), replayed };
}

// ───────────────────────── 读取 ─────────────────────────

/** 进度最后一次变的时刻：需求单本身、审批流水、采购单、收货退货单、询价单里最晚的 */
async function progressTimes(db: Db, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await db<{ id: number; at: string }[]>`
    SELECT r.id, GREATEST(
      r.updated_at,
      (SELECT max(a.created_at) FROM approval_logs a WHERE a.doc_kind = 'purchase_request' AND a.doc_id = r.id),
      (SELECT max(po.updated_at) FROM purchase_request_lines l JOIN purchase_order_line_requests x ON x.request_line_id = l.id
         JOIN purchase_order_lines pl ON pl.id = x.po_line_id JOIN purchase_orders po ON po.id = pl.po_id WHERE l.request_id = r.id),
      (SELECT max(d.updated_at) FROM purchase_request_lines l JOIN purchase_order_line_requests x ON x.request_line_id = l.id
         JOIN inv_doc_lines il ON il.po_line_id = x.po_line_id JOIN inv_docs d ON d.id = il.doc_id WHERE l.request_id = r.id),
      (SELECT max(rd.updated_at) FROM purchase_request_lines l JOIN purchase_order_line_requests x ON x.request_line_id = l.id
         JOIN inv_doc_lines src ON src.po_line_id = x.po_line_id JOIN inv_doc_lines rl ON rl.source_line_id = src.id
         JOIN inv_docs rd ON rd.id = rl.doc_id WHERE l.request_id = r.id),
      (SELECT max(e.updated_at) FROM purchase_request_lines l JOIN sourcing_line_requests sr ON sr.request_line_id = l.id
         JOIN sourcing_lines sl ON sl.id = sr.sourcing_line_id JOIN sourcing_events e ON e.id = sl.event_id WHERE l.request_id = r.id),
      (SELECT max(GREATEST(s.decided_at, s.answered_at)) FROM request_line_stock s WHERE s.request_id = r.id)
    ) AS at
    FROM purchase_requests r WHERE r.id IN ${db(ids)}`;
  return new Map(rows.map((r) => [Number(r.id), r.at]));
}

/** 详情（各行进度齐全）合出给商城看的状态 */
function displayOf(r: PurchaseRequest): MallDisplayStatus {
  if (r.status === 'submitted') {
    if (r.deptConfirm.state === 'pending') return 'dept_pending';
    if (r.stockCheck === 'pending') return 'stock_check';
    if (r.stockCheck === 'confirming') return 'stock_confirming';
    return 'reviewing';
  }
  if (r.status !== 'approved') return r.status;
  const states = r.lines.map((l) => l.progress.state);
  if (states.every((s) => s === 'received' || s === 'issued' || s === 'closed')) return states.some((s) => s === 'closed') ? 'closed' : 'received';
  if (states.some((s) => s === 'partial' || s === 'received')) return 'partial';
  if (states.some((s) => s === 'ordered' || s === 'closed')) return 'ordered';
  if (states.some((s) => s === 'sourcing')) return 'sourcing';
  return 'approved';
}

/** 列表上（只有行数统计）合出来的状态：询价中在列表上看不出来，按待下单写；要准的看详情 */
function briefDisplayOf(r: PurchaseRequestSummary): MallDisplayStatus {
  if (r.status === 'submitted') {
    if (r.deptConfirm.state === 'pending') return 'dept_pending';
    if (r.stockCheck === 'pending') return 'stock_check';
    if (r.stockCheck === 'confirming') return 'stock_confirming';
    return 'reviewing';
  }
  if (r.status !== 'approved') return r.status;
  if (r.lineCount > 0 && r.receivedLines >= r.lineCount) return 'received';
  if (r.receivedLines > 0) return 'partial';
  if (r.orderedLines > 0) return 'ordered';
  return 'approved';
}

async function mallRequest(deps: Deps, actor: Actor, requestId: number): Promise<MallRequest> {
  const r = await getRequest(deps.sql, actor, requestId, deps.config.timezone);
  const [extra] = await deps.sql<
    {
      contactName: string;
      budgetProject: string;
      deliveryAddress: string;
      paymentIntent: MallRequest['paymentIntent'];
      storeId: number | null;
      storeName: string | null;
      entityId: number | null;
      entityName: string | null;
    }[]
  >`
    SELECT r.contact_name, r.budget_project, r.delivery_address, r.payment_intent, r.store_id, st.name AS store_name, r.entity_id, le.name AS entity_name
    FROM purchase_requests r LEFT JOIN stores st ON st.id = r.store_id LEFT JOIN legal_entities le ON le.id = r.entity_id WHERE r.id = ${requestId}`;
  const at = (await progressTimes(deps.sql, [requestId])).get(requestId) ?? r.updatedAt;
  const display = displayOf(r);
  return {
    id: r.id,
    docNo: r.docNo,
    externalNo: r.externalNo,
    source: r.source,
    status: r.status,
    displayStatus: display,
    displayLabel: MALL_DISPLAY_LABELS[display],
    reason: r.reason,
    department: r.department,
    requester: r.requester,
    contactName: extra!.contactName,
    priority: r.priority,
    needBy: r.needBy,
    createdAt: r.createdAt,
    submittedAt: r.submittedAt,
    updatedAt: r.updatedAt,
    progressUpdatedAt: at,
    deptConfirm: { state: r.deptConfirm.state, headName: r.deptConfirm.head?.name ?? null },
    stockCheck: r.stockCheck,
    store: extra!.storeId !== null ? { id: Number(extra!.storeId), name: extra!.storeName ?? '' } : null,
    entity: extra!.entityId !== null ? { id: Number(extra!.entityId), name: extra!.entityName ?? '' } : null,
    budgetProject: extra!.budgetProject,
    deliveryAddress: extra!.deliveryAddress,
    paymentIntent: extra!.paymentIntent,
    note: r.note,
    approvals: r.approvals.map((a) => ({ action: a.action, actorName: a.actorName, reason: a.reason, createdAt: a.createdAt })),
    lines: r.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      materialId: l.materialId,
      name: l.name,
      purpose: l.purpose,
      qtyMilli: Number(l.qtyMilli),
      unit: l.unit,
      refPriceCents: l.refPriceCents === null ? null : Number(l.refPriceCents),
      link: l.link,
      details: l.details,
      note: l.note,
      supplier: l.supplier,
      skuCode: l.mall?.skuCode ?? '',
      priceVersion: l.mall?.priceVersion ?? '',
      brandModel: l.mall?.brandModel ?? '',
      expectedCategory: l.mall?.expectedCategory ?? '',
      reasonText: l.mall?.reasonText ?? '',
      imageIds: l.images.map((i) => Number(i.id)),
      progress: {
        state: l.progress.state,
        poNo: l.progress.po?.docNo ?? null,
        supplierName: l.progress.po?.supplierName ?? null,
        sourcingNo: l.progress.sourcing?.docNo ?? null,
        orderedMilli: Number(l.progress.orderedMilli),
        receivedMilli: Number(l.progress.receivedMilli),
        returnedMilli: Number(l.progress.returnedMilli),
        inventoryUnit: l.progress.inventoryUnit,
      },
    })),
  };
}

function briefOf(r: PurchaseRequestSummary & { reason: string | null }, at: string): MallRequestBrief {
  const display = briefDisplayOf(r);
  return {
    id: r.id,
    docNo: r.docNo,
    externalNo: r.externalNo,
    source: r.source,
    status: r.status,
    displayStatus: display,
    displayLabel: MALL_DISPLAY_LABELS[display],
    reason: r.reason,
    department: r.department,
    priority: r.priority,
    needBy: r.needBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    progressUpdatedAt: at,
    lineCount: r.lineCount,
    orderedLines: r.orderedLines,
    receivedLines: r.receivedLines,
    summary: r.summary,
  };
}

/** 一批需求单（已按可见范围筛过）给成简表：带上原因与进度时刻 */
type SummaryRow = Awaited<ReturnType<typeof summaries>>[number];
async function briefs(db: Db, rows: readonly SummaryRow[]): Promise<MallRequestBrief[]> {
  const ids = rows.map((r) => Number(r.id));
  const times = await progressTimes(db, ids);
  const reasons = ids.length
    ? new Map((await db<{ id: number; reason: string | null }[]>`SELECT id, reason FROM purchase_requests WHERE id IN ${db(ids)}`).map((x) => [Number(x.id), x.reason]))
    : new Map<number, string | null>();
  return rows.map((row) => {
    const s = toSummary(row);
    return briefOf({ ...s, reason: reasons.get(s.id) ?? null }, times.get(s.id) ?? s.updatedAt);
  });
}

const ListQuery = z.object({
  status: z.enum(Object.keys(REQUEST_STATUS_LABELS) as [RequestStatus, ...RequestStatus[]]).optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  source: z.literal('mall').optional(),
  /** 进度在这个时刻以后变过的（ISO 时间） */
  updatedSince: z.iso.datetime({ offset: true }).optional(),
  from: docDateSchema.optional(),
  to: docDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MALL_LIST_LIMIT).default(50),
});

async function listMall(deps: Deps, actor: Actor, raw: unknown): Promise<{ requests: MallRequestBrief[] }> {
  const q = parse(ListQuery, raw ?? {});
  const db = deps.sql;
  const me = await myContext(db, actor);
  // 进度增量：先按进度时刻挑出这段时间里变过的单（不限于最近 500 张），再取简表
  let ids: number[] | undefined;
  if (q.updatedSince) {
    const changed = await db<{ id: number }[]>`
      SELECT r.id FROM purchase_requests r
      WHERE r.updated_at >= ${q.updatedSince}
         OR EXISTS (SELECT 1 FROM approval_logs a WHERE a.doc_kind = 'purchase_request' AND a.doc_id = r.id AND a.created_at >= ${q.updatedSince})
         OR EXISTS (SELECT 1 FROM purchase_request_lines l JOIN purchase_order_line_requests x ON x.request_line_id = l.id
                    JOIN purchase_order_lines pl ON pl.id = x.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
                    WHERE l.request_id = r.id AND po.updated_at >= ${q.updatedSince})
         OR EXISTS (SELECT 1 FROM purchase_request_lines l JOIN purchase_order_line_requests x ON x.request_line_id = l.id
                    JOIN inv_doc_lines il ON il.po_line_id = x.po_line_id JOIN inv_docs d ON d.id = il.doc_id
                    WHERE l.request_id = r.id AND d.updated_at >= ${q.updatedSince})
         OR EXISTS (SELECT 1 FROM purchase_request_lines l JOIN purchase_order_line_requests x ON x.request_line_id = l.id
                    JOIN inv_doc_lines src ON src.po_line_id = x.po_line_id JOIN inv_doc_lines rl ON rl.source_line_id = src.id
                    JOIN inv_docs rd ON rd.id = rl.doc_id WHERE l.request_id = r.id AND rd.updated_at >= ${q.updatedSince})
         OR EXISTS (SELECT 1 FROM purchase_request_lines l JOIN sourcing_line_requests sr ON sr.request_line_id = l.id
                    JOIN sourcing_lines sl ON sl.id = sr.sourcing_line_id JOIN sourcing_events e ON e.id = sl.event_id
                    WHERE l.request_id = r.id AND e.updated_at >= ${q.updatedSince})
         OR EXISTS (SELECT 1 FROM request_line_stock s WHERE s.request_id = r.id AND GREATEST(s.decided_at, s.answered_at) >= ${q.updatedSince})
      ORDER BY r.id DESC LIMIT 2000`;
    ids = changed.map((r) => Number(r.id));
    if (!ids.length) return { requests: [] };
  }
  const rows = await summaries(db, {
    ids,
    status: q.status,
    departmentId: q.departmentId,
    source: q.source,
    from: q.from,
    to: q.to,
    timezone: deps.config.timezone,
    requesterOrDept: me.canReview || me.canStock ? undefined : { staffId: actor.id, departmentId: me.departmentId },
  });
  const list = await briefs(db, rows);
  list.sort((a, b) => (a.progressUpdatedAt < b.progressUpdatedAt ? 1 : a.progressUpdatedAt > b.progressUpdatedAt ? -1 : b.id - a.id));
  return { requests: list.slice(0, q.limit) };
}

const BatchInput = z
  .object({
    ids: z.array(id).max(MALL_BATCH_LIMIT, `一次最多查 ${MALL_BATCH_LIMIT} 张`).default([]),
    externalNos: z.array(z.string().trim().min(1).max(64)).max(MALL_BATCH_LIMIT, `一次最多查 ${MALL_BATCH_LIMIT} 张`).default([]),
  })
  .refine((v) => v.ids.length + v.externalNos.length > 0, '请给需求单编号或商城申请单号')
  .refine((v) => v.ids.length + v.externalNos.length <= MALL_BATCH_LIMIT, `一次最多查 ${MALL_BATCH_LIMIT} 张`);

/** 批量查状态：看不到的、没有的不返回（在 missing 里列出来，不区分是哪一种） */
async function batchStatus(deps: Deps, actor: Actor, raw: unknown) {
  const input = parse(BatchInput, raw);
  const db = deps.sql;
  const me = await myContext(db, actor);
  const byId = input.ids.length ? await summaries(db, { ids: input.ids, timezone: deps.config.timezone }) : [];
  const byNo = input.externalNos.length ? await summaries(db, { externalNos: input.externalNos, timezone: deps.config.timezone }) : [];
  const seen = new Map<number, SummaryRow>();
  for (const r of [...byId, ...byNo]) if (visible(me, actor, { departmentId: r.departmentId, requesterId: r.requesterId, deptHeadId: r.deptHeadId })) seen.set(Number(r.id), r);
  const list = await briefs(db, [...seen.values()]);
  const foundIds = new Set(list.map((r) => r.id));
  const foundNos = new Set(list.map((r) => r.externalNo));
  return {
    requests: list,
    missing: { ids: input.ids.filter((x) => !foundIds.has(x)), externalNos: input.externalNos.filter((x) => !foundNos.has(x)) },
  };
}

const KeyParam = z.object({ key: z.uuid('操作编号格式不正确') });
const ExternalParam = z.object({ externalNo: z.string().trim().min(1).max(64) });
const AbandonInput = z.object({ summary: z.string().trim().max(200).default('') });

/**
 * 按操作编号查回（超时、断网后）：建好了给单；确认作废过的写 abandoned；都没有的写 found: false（不等于没生效，只能原样重提或作废）。
 * 只能查回自己提的（操作编号记着是谁提的）
 */
async function byKey(deps: Deps, actor: Actor, key: string) {
  const [row] = await deps.sql<{ staffId: number; opType: string }[]>`SELECT staff_id, op_type FROM idempotency_keys WHERE key = ${key}`;
  if (row && (row.opType !== 'purchase_request' || Number(row.staffId) !== actor.id)) throw notFound('没有这个操作编号');
  const result = await lookupErpOp(deps.sql, key, 'purchase_request');
  return { ...result, request: result.found && result.refId ? await mallRequest(deps, actor, result.refId) : null };
}

/** 确认作废一个操作编号：晚到的原请求不会再建单（OP_ABANDONED）；已经建好的不能作废（返回那张单） */
async function abandon(deps: Deps, actor: Actor, key: string, raw: unknown, ip?: string) {
  const input = parse(AbandonInput, raw ?? {});
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const result = await fenceKey(tx, key, 'purchase_request', actor.id);
    if ('existingOpType' in result) {
      if (result.existingOpType !== 'purchase_request') throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号属于其他业务，不能在这里作废');
      return;
    }
    // 作废登记属于谁：别人登记过的不能替他作废
    const [owner] = await tx<{ staffId: number }[]>`SELECT staff_id FROM op_fences WHERE key = ${key} AND op_type = 'purchase_request'`;
    if (owner && Number(owner.staffId) !== actor.id) throw forbidden('只能作废自己的操作编号');
    if (result.inserted) {
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'erp_op_abandoned',
        targetType: 'operation',
        targetId: key,
        detail: { idempotencyKey: key, type: 'purchase_request', summary: input.summary, source: 'mall' },
        ip,
      });
    }
  });
  return byKey(deps, actor, key);
}

// ───────────────────────── 主数据（只读） ─────────────────────────

async function masterMeta(deps: Deps) {
  const db = deps.sql;
  const departments = await db<{ id: number; name: string; headId: number | null; headName: string | null }[]>`
    SELECT d.id, d.name, d.head_id, h.display_name AS head_name FROM departments d LEFT JOIN staff h ON h.id = d.head_id AND h.active
    WHERE d.active ORDER BY d.sort_order, d.id`;
  const stores = await db<{ id: number; code: string; name: string; entityId: number | null; entityName: string | null }[]>`
    SELECT s.id, s.code, s.name, s.entity_id, e.name AS entity_name FROM stores s LEFT JOIN legal_entities e ON e.id = s.entity_id
    WHERE s.active ORDER BY s.sort_order, s.id`;
  const entities = await db<{ id: number; name: string }[]>`SELECT id, name FROM legal_entities WHERE active ORDER BY id`;
  const { purposes } = await loadExpenseRules(db);
  const rules = await loadPurchaseRules(db);
  return {
    departments: departments.map((d) => ({ id: Number(d.id), name: d.name, head: d.headId != null && d.headName ? { id: Number(d.headId), name: d.headName } : null })),
    stores: stores.map((s) => ({ id: Number(s.id), code: s.code, name: s.name, entityId: s.entityId != null ? Number(s.entityId) : null, entityName: s.entityName })),
    entities: entities.map((e) => ({ id: Number(e.id), name: e.name })),
    purposes,
    priorities: [...REQUEST_PRIORITIES],
    rules: { cutoffEnabled: rules.cutoffEnabled, cutoffTime: rules.cutoffTime, deptConfirm: 'all' as const },
  };
}

async function masterMaterials(deps: Deps) {
  const rows = await deps.sql<
    {
      id: number;
      code: string;
      name: string;
      category: string;
      specification: string;
      inventoryUnit: string;
      decimals: number;
      purchaseUnit: string;
      purchaseFactorMilli: number;
      refPriceCents: number | null;
      defaultSupplierId: number | null;
      updatedAt: string;
    }[]
  >`
    SELECT id, code, name, category, specification, inventory_unit, decimals, purchase_unit, purchase_factor_milli, ref_price_cents, default_supplier_id, updated_at
    FROM materials WHERE active AND tracked ORDER BY code`;
  return { materials: rows.map((m) => ({ ...m, id: Number(m.id), defaultSupplierId: m.defaultSupplierId != null ? Number(m.defaultSupplierId) : null })) };
}

/** 供应商：只给编号、名字、联系人与准入状态——银行账户、电话、证照一概不给（红线） */
async function masterSuppliers(deps: Deps) {
  const rows = await deps.sql<{ id: number; code: string; name: string; contact: string; admission: string; updatedAt: string }[]>`
    SELECT id, code, name, contact, admission, updated_at FROM suppliers WHERE active ORDER BY code`;
  return { suppliers: rows.map((s) => ({ id: Number(s.id), code: s.code, name: s.name, contact: s.contact, admission: s.admission, updatedAt: s.updatedAt })) };
}

// ───────────────────────── 路由 ─────────────────────────

export function registerMallRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const P = MALL_PREFIX;
  // 读：提需求的、审核的、核库的都能看（各自的可见范围照 ERP 的需求单）；写（提单、作废、传图）要能提需求
  const read = guardAny('request.create', 'request.review', 'request.stock');

  app.post(`${P}/auth/verify`, async (req) => {
    // 登录校验还没认出人，ERP 模块开关的统一拦截管不到：这里自己看「采购需求单」开没开
    if (!(await enabledErpModules(sql)).has('requests')) throw erpModuleDisabled('requests');
    const { username, password, clientIp } = parse(VerifyInput, req.body);
    const ip = clientIp || req.ip;
    checkLock(username, ip);
    const [staff] = await sql<{ id: number; passwordHash: string; active: boolean }[]>`SELECT id, password_hash, active FROM staff WHERE username = ${username}`;
    const ok = staff ? await verifyPassword(password, staff.passwordHash) : false;
    if (!staff || !ok || !staff.active) {
      recordFailure(username, ip);
      await writeAudit(sql, {
        staffId: staff?.id ?? null,
        action: 'login_failed',
        detail: { username, reason: !staff ? 'unknown_user' : !ok ? 'bad_password' : 'inactive', channel: 'mall' },
        ip,
      });
      if (staff && ok && !staff.active) throw unauthorized('该账号已停用，请联系店主');
      throw unauthorized('账号或密码不正确');
    }
    clearFailures(username, ip);
    const found = await resolveStaffActor(sql, Number(staff.id), null);
    if (!found) throw unauthorized('该账号已停用，请联系店主');
    await writeAudit(sql, { staffId: found.actor.id, action: 'login', detail: { channel: 'mall' }, ip });
    if (found.actor.mustChangePassword) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '首次登录请先到 ERP 网页修改密码，再回商城登录');
    if (found.actor.needsPosition) throw new AppError(403, 'POSITION_REQUIRED', '请先到 ERP 网页选好岗位，再回商城登录');
    return identityOf(sql, found.actor);
  });

  // 刷新账号（商城定时或提交前问一次）：停用的在认人时就拒了；要改密码、选岗位的照样返回，标着
  app.get(`${P}/staff/me`, async (req) => {
    if (!req.hasSession) throw unauthorized();
    return identityOf(sql, req.actor);
  });

  app.get(`${P}/master/meta`, { preHandler: read }, async () => masterMeta(deps));
  app.get(`${P}/master/materials`, { preHandler: read }, async () => masterMaterials(deps));
  app.get(`${P}/master/suppliers`, { preHandler: read }, async () => masterSuppliers(deps));

  app.post(`${P}/requests`, { preHandler: guard('request.create') }, async (req, reply) => {
    const result = await createMallRequest(deps, req.body, req.actor, req.ip);
    if (!result.replayed) reply.code(201);
    return result;
  });
  app.get(`${P}/requests`, { preHandler: read }, async (req) => listMall(deps, req.actor, req.query));
  app.post(`${P}/requests/batch-status`, { preHandler: read }, async (req) => batchStatus(deps, req.actor, req.body));
  app.get(`${P}/requests/by-key/:key`, { preHandler: guard('request.create') }, async (req) => byKey(deps, req.actor, parse(KeyParam, req.params).key));
  app.get(`${P}/requests/by-external/:externalNo`, { preHandler: read }, async (req) => {
    const { externalNo } = parse(ExternalParam, req.params);
    const [row] = await sql<{ id: number }[]>`SELECT id FROM purchase_requests WHERE external_no = ${externalNo}`;
    if (!row) throw notFound('没有这张商城申请对应的需求单');
    return mallRequest(deps, req.actor, Number(row.id));
  });
  app.get(`${P}/requests/:id`, { preHandler: read }, async (req) => mallRequest(deps, req.actor, parse(idParam, req.params).id));
  app.post(`${P}/ops/:key/abandon`, { preHandler: guard('request.create') }, async (req) => abandon(deps, req.actor, parse(KeyParam, req.params).key, req.body, req.ip));

  app.post(`${P}/images`, { preHandler: guard('request.create'), bodyLimit: 1_600_000 }, async (req, reply) => {
    const img = await saveImage(sql, req.body, req.actor);
    reply.code(201);
    return { id: img.id };
  });
  app.get(`${P}/images/:id`, { preHandler: read }, async (req, reply) => {
    const img = await readImageFor(sql, req.actor, parse(idParam, req.params).id);
    reply.header('content-type', img.mime).header('cache-control', 'private, max-age=86400');
    return reply.send(img.data);
  });
}
