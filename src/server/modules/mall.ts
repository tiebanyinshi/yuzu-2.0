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
import { formatAmount } from '@shared/money';
import { can } from '@shared/permissions';
import {
  MALL_BATCH_LIMIT,
  MALL_DISPLAY_LABELS,
  MALL_GROUP_STATUSES,
  MALL_KEY_HEADER,
  MALL_LIST_LIMIT,
  MALL_PREFIX,
  MALL_REQUEST_GROUPS,
  MALL_STAFF_HEADER,
  MALL_STORE_HEADER,
  type MallCreateResult,
  type MallDisplayStatus,
  type MallIdentity,
  type MallRequest,
  type MallRequestBrief,
  type MallRequestGroup,
  type MallTimelineNode,
} from '@shared/mall';
import {
  MAX_LINE_IMAGES,
  PRIORITY_LABELS,
  REQUEST_PRIORITIES,
  REQUEST_STATUS_LABELS,
  type PurchaseRequest,
  type PurchaseRequestSummary,
  type RequestLineProgress,
  type RequestStatus,
} from '@shared/requests';
import { isUniqueViolation, type Db, type Sql } from '../db';
import { guard, guardAny } from '../auth/guard';
import { checkLock, clearFailures, recordFailure } from '../auth/lockout';
import { verifyPassword } from '../auth/password';
import { resolveStaffActor } from '../auth/session';
import type { AppConfig } from '../config';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { toCsv } from '../lib/csv';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized, unprocessable } from '../lib/errors';
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
import {
  approvableOnFor,
  deptConfirmFor,
  getRequest,
  lineStates,
  myContext,
  PROGRESS_AT_SQL,
  readImageFor,
  REQUESTER_OR_DEPT,
  resolveDepartment,
  saveImage,
  summaries,
  toSummary,
  validateLines,
  visible,
  writeLines,
} from './requests';

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

async function checkRefs(db: Db, input: z.infer<typeof MallCreateInput>, today: string, actor: Actor) {
  if (input.needBy !== null && input.needBy < today) throw unprocessable('NEED_BY_PAST', '期望到货日期不能早于今天');
  if (input.storeId !== null) {
    const [s] = await db<{ active: boolean }[]>`SELECT active FROM stores WHERE id = ${input.storeId}`;
    if (!s?.active) throw unprocessable('STORE_INVALID', '适用门店不存在或已停用');
    // 只能给自己能去的门店提（Codex 安全审查）：店主全部，其他人按员工档案里的门店（allowedStores）
    if (!(await allowedStores(db, actor)).some((x) => Number(x.id) === input.storeId)) throw forbidden('只能给自己所在的门店提采购需求');
  }
  if (input.entityId !== null) {
    const [e] = await db<{ active: boolean }[]>`SELECT active FROM legal_entities WHERE id = ${input.entityId}`;
    if (!e?.active) throw unprocessable('ENTITY_INVALID', '费用承担主体不存在或已停用');
  }
}

/** 用途空着的按「其他」（ERP 的固定用途里有「其他」时） */
/** 没填用途的：按「其他」；店里把「其他」从用途清单里去掉了就用清单第一项（Codex 审查：不然商城的单一律 PURPOSE_INVALID） */
async function withPurposes(db: Db, lines: z.infer<typeof MallLineInput>[]) {
  const { purposes } = await loadExpenseRules(db);
  return lines.map((l) => ({ ...l, purpose: l.purpose || (purposes.includes('其他') ? '其他' : (purposes[0] ?? '')) }));
}

export async function createMallRequest(
  deps: Deps,
  raw: unknown,
  actor: Actor,
  ip?: string,
  /** 柚子里的商城页面（8.1.32）：在建单的事务里、写单之前锁住并核对 SKU（价格版本、能不能买） */
  beforeWrite?: (tx: Db) => Promise<void>,
  /** 柚子里的商城页面：按页面原样提交的内容算的摘要（明细是按当时的 SKU 拼出来的，SKU 之后改了也不影响原样重提认得出来） */
  requestHashOverride?: string,
): Promise<MallCreateResult> {
  const input = parse(MallCreateInput, raw);
  const requestHash = requestHashOverride ?? hashRequest({ ...input, clientKey: undefined });
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
      await checkRefs(tx, input, today, actor);
      if (beforeWrite) await beforeWrite(tx);
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

/** 进度最后一次变的时刻：需求单本身、审批流水、采购单、收货退货单、询价单、核库、解开采购单关联里最晚的 */
async function progressTimes(db: Db, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await db<{ id: number; at: string }[]>`SELECT r.id, ${PROGRESS_AT_SQL(db)} AS at FROM purchase_requests r WHERE r.id IN ${db(ids)}`;
  return new Map(rows.map((r) => [Number(r.id), r.at]));
}

/** 审核前的几步（详情与列表一样） */
function reviewDisplayOf(r: Pick<PurchaseRequestSummary, 'status' | 'deptConfirm' | 'stockCheck'>): MallDisplayStatus | null {
  if (r.status === 'submitted') {
    if (r.deptConfirm.state === 'pending') return 'dept_pending';
    if (r.stockCheck === 'pending') return 'stock_check';
    if (r.stockCheck === 'confirming') return 'stock_confirming';
    return 'reviewing';
  }
  return r.status !== 'approved' ? r.status : null;
}

/** 通过以后按各行进度合出来：都到齐（或领用、关单）= 已到货 / 已关闭；有到货的 = 部分到货；有下单的 = 已下单；询价中；都没动 = 已通过 */
function progressDisplayOf(states: readonly RequestLineProgress['state'][]): MallDisplayStatus {
  if (states.length && states.every((s) => s === 'received' || s === 'issued' || s === 'closed')) return states.some((s) => s === 'closed') ? 'closed' : 'received';
  if (states.some((s) => s === 'partial' || s === 'received')) return 'partial';
  if (states.some((s) => s === 'ordered' || s === 'closed')) return 'ordered';
  if (states.some((s) => s === 'sourcing')) return 'sourcing';
  return 'approved';
}

/** 详情（各行进度齐全）合出给商城看的状态 */
function displayOf(r: PurchaseRequest): MallDisplayStatus {
  return reviewDisplayOf(r) ?? progressDisplayOf(r.lines.map((l) => l.progress.state));
}

/** 列表、批量查状态：各行进度另查一次（lineStates，与详情同一个算法），部分到货、采购单关闭在列表上也对 */
function briefDisplayOf(r: PurchaseRequestSummary, states: readonly RequestLineProgress['state'][]): MallDisplayStatus {
  return reviewDisplayOf(r) ?? progressDisplayOf(states);
}

export async function mallRequest(deps: Deps, actor: Actor, requestId: number): Promise<MallRequest> {
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
      deptConfirmedAt: string | null;
      deptConfirmedByName: string | null;
    }[]
  >`
    SELECT r.contact_name, r.budget_project, r.delivery_address, r.payment_intent, r.store_id, st.name AS store_name, r.entity_id, le.name AS entity_name,
           r.dept_confirmed_at, dcb.display_name AS dept_confirmed_by_name
    FROM purchase_requests r
    LEFT JOIN stores st ON st.id = r.store_id
    LEFT JOIN legal_entities le ON le.id = r.entity_id
    LEFT JOIN staff dcb ON dcb.id = r.dept_confirmed_by
    WHERE r.id = ${requestId}`;
  const [[poStep], [recvStep]] = await Promise.all([
    deps.sql<{ at: string; actorName: string | null }[]>`
      SELECT po.created_at AS at, st.display_name AS actor_name
      FROM purchase_request_lines l
      JOIN purchase_order_line_requests x ON x.request_line_id = l.id
      JOIN purchase_order_lines pl ON pl.id = x.po_line_id
      JOIN purchase_orders po ON po.id = pl.po_id
      LEFT JOIN staff st ON st.id = po.created_by
      WHERE l.request_id = ${requestId} AND po.status <> 'cancelled'
      ORDER BY po.created_at ASC LIMIT 1`,
    deps.sql<{ at: string; actorName: string | null }[]>`
      SELECT x.at, x.actor_name FROM (
        SELECT d.created_at AS at, st.display_name AS actor_name
        FROM purchase_request_lines l
        JOIN purchase_order_line_requests polr ON polr.request_line_id = l.id
        JOIN inv_doc_lines il ON il.po_line_id = polr.po_line_id
        JOIN inv_docs d ON d.id = il.doc_id
        LEFT JOIN staff st ON st.id = d.created_by
        WHERE l.request_id = ${requestId} AND d.status = 'approved'
        UNION ALL
        SELECT d.created_at AS at, st.display_name AS actor_name
        FROM request_line_stock s
        JOIN inv_docs d ON d.id = s.inv_doc_id
        LEFT JOIN staff st ON st.id = d.created_by
        WHERE s.request_id = ${requestId} AND d.status = 'approved'
      ) x ORDER BY x.at DESC LIMIT 1`,
  ]);
  const at = (await progressTimes(deps.sql, [requestId])).get(requestId) ?? r.updatedAt;
  const display = displayOf(r);
  const ended = ['returned', 'rejected', 'cancelled'].includes(display);
  const revApprovals = [...r.approvals].reverse();
  const submitLog = revApprovals.find((a) => a.action === 'submit');
  const deptLog = revApprovals.find((a) => a.action === 'approve' && a.reason === '部门主管确认');
  const reviewLog = revApprovals.find((a) => a.action === 'approve' && a.reason !== '部门主管确认') ?? revApprovals.find((a) => a.action === 'stock');
  const timeline: MallTimelineNode[] = [
    {
      key: 'submit',
      label: '提交',
      done: true,
      at: submitLog?.createdAt ?? r.submittedAt ?? r.createdAt,
      actorName: submitLog?.actorName ?? r.requester.name,
    },
    {
      key: 'dept_confirm',
      label: '主管确认',
      done: !ended && display !== 'dept_pending',
      at: deptLog?.createdAt ?? extra?.deptConfirmedAt ?? null,
      actorName: deptLog?.actorName ?? extra?.deptConfirmedByName ?? null,
    },
    {
      key: 'review',
      label: '核库与采购审核',
      done: !ended && ['approved', 'sourcing', 'ordered', 'partial', 'received', 'closed', 'issued'].includes(display),
      at: reviewLog?.createdAt ?? null,
      actorName: reviewLog?.actorName ?? null,
    },
    {
      key: 'order',
      label: '下单',
      done: !ended && ['ordered', 'partial', 'received', 'closed'].includes(display),
      at: poStep?.at ?? null,
      actorName: poStep?.actorName ?? null,
    },
    {
      key: 'receive',
      label: '到货',
      done: !ended && ['received', 'issued'].includes(display),
      at: recvStep?.at ?? null,
      actorName: recvStep?.actorName ?? null,
    },
  ];
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
    timeline,
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

function briefOf(r: PurchaseRequestSummary & { reason: string | null }, at: string, states: readonly RequestLineProgress['state'][]): MallRequestBrief {
  const display = briefDisplayOf(r, states);
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
  const states = await lineStates(db, ids);
  const reasons = ids.length
    ? new Map((await db<{ id: number; reason: string | null }[]>`SELECT id, reason FROM purchase_requests WHERE id IN ${db(ids)}`).map((x) => [Number(x.id), x.reason]))
    : new Map<number, string | null>();
  return rows.map((row) => {
    const s = toSummary(row);
    return briefOf({ ...s, reason: reasons.get(s.id) ?? null }, times.get(s.id) ?? s.updatedAt, states.get(s.id) ?? []);
  });
}

const ListQuery = z.object({
  status: z.enum(Object.keys(REQUEST_STATUS_LABELS) as [RequestStatus, ...RequestStatus[]]).optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  source: z.literal('mall').optional(),
  /** 进度在这个时刻以后（含）变过的（ISO 时间）：按进度时刻从早到晚给，一页给不完的带 nextCursor 接着取 */
  updatedSince: z.iso.datetime({ offset: true }).optional(),
  /** 接着上一页取（nextCursor.afterId）：进度时刻与 updatedSince 相同的，只给编号比它大的 */
  afterId: z.coerce.number().int().positive().optional(),
  from: docDateSchema.optional(),
  to: docDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MALL_LIST_LIMIT).default(50),
});

export interface MallListCursor {
  updatedSince: string;
  afterId: number;
}

/** mineOnly（柚子里的「我的采购需求」）：审核、核库的人也只看本部门、自己提的、自己当主管的 */
export async function listMall(deps: Deps, actor: Actor, raw: unknown, opts: { mineOnly?: boolean } = {}): Promise<{ requests: MallRequestBrief[]; nextCursor: MallListCursor | null }> {
  const q = parse(ListQuery, raw ?? {});
  const db = deps.sql;
  const tz = deps.config.timezone;
  const me = await myContext(db, actor);
  const scope = (me.canReview || me.canStock) && !opts.mineOnly ? undefined : { staffId: actor.id, departmentId: me.departmentId };
  const filters = { status: q.status, departmentId: q.departmentId, source: q.source, from: q.from, to: q.to, timezone: tz, requesterOrDept: scope, plainStatus: true };
  if (!q.updatedSince) {
    // 不带增量：最近的单，按进度时刻从晚到早
    const list = await briefs(db, await summaries(db, filters));
    list.sort((a, b) => (a.progressUpdatedAt < b.progressUpdatedAt ? 1 : a.progressUpdatedAt > b.progressUpdatedAt ? -1 : b.id - a.id));
    return { requests: list.slice(0, q.limit), nextCursor: null };
  }
  // 进度增量（Codex 审查）：筛选与可见范围先在数据库里做，按（进度时刻, 编号）从早到晚排、取一页，给续取的游标——
  // 变动再多也能一页页取完，不会因为先截了「最近 500 张」漏掉老单的进度。时刻截到毫秒（与接口给出去的一样），游标才对得上
  const since = new Date(q.updatedSince);
  const page = await db<{ id: number; at: Date }[]>`
    SELECT x.id, x.at FROM (
      SELECT r.id, date_trunc('milliseconds', ${PROGRESS_AT_SQL(db)}) AS at FROM purchase_requests r
      WHERE TRUE
        ${q.source ? db`AND r.source = ${q.source}` : db``}
        ${q.status ? db`AND r.status = ${q.status}` : db``}
        ${q.departmentId ? db`AND r.department_id = ${q.departmentId}` : db``}
        ${q.from ? db`AND (r.created_at AT TIME ZONE ${tz})::date >= ${q.from}` : db``}
        ${q.to ? db`AND (r.created_at AT TIME ZONE ${tz})::date <= ${q.to}` : db``}
        ${scope ? db`AND ${REQUESTER_OR_DEPT(db, scope)}` : db``}
    ) x
    WHERE x.at > ${since} OR (x.at = ${since} AND x.id > ${q.afterId ?? 0})
    ORDER BY x.at, x.id LIMIT ${q.limit}`;
  if (!page.length) return { requests: [], nextCursor: null };
  // 这一页已经按商城的筛选挑好了，只按编号取：不再套 ERP 待审核队列的口径（待审核不含核库中），免得核库中的单被丢掉、游标却跳过了它（Codex 审查）
  const rows = await summaries(db, { ids: page.map((r) => Number(r.id)), timezone: tz });
  const byId = new Map((await briefs(db, rows)).map((b) => [b.id, b]));
  const requests = page.map((r) => byId.get(Number(r.id))).filter((b): b is MallRequestBrief => !!b);
  const last = page[page.length - 1]!;
  return { requests, nextCursor: page.length === q.limit ? { updatedSince: new Date(last.at).toISOString(), afterId: Number(last.id) } : null };
}

const emptyToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const PagedQuery = z.object({
  priority: z.preprocess(emptyToUndef, z.enum(REQUEST_PRIORITIES).optional()),
  group: z.preprocess(emptyToUndef, z.enum(MALL_REQUEST_GROUPS).optional()),
  q: z.preprocess(emptyToUndef, z.string().trim().max(80).optional()),
  from: z.preprocess(emptyToUndef, docDateSchema.optional()),
  to: z.preprocess(emptyToUndef, docDateSchema.optional()),
  /** 接着上一页取：编号比它小的 */
  beforeId: z.preprocess(emptyToUndef, z.coerce.number().int().positive().optional()),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function escapeLike(s: string): string {
  return s.replace(/[\\_%]/g, '\\$&');
}

function groupSqlPreFilter(db: Db, group: MallRequestGroup | undefined) {
  if (!group) return db``;
  if (group === 'ended') return db`AND r.status IN ('returned', 'rejected', 'cancelled')`;
  if (group === 'todo') return db`AND (r.status = 'returned' OR (r.status = 'submitted' AND (r.dept_confirm = 'pending' OR r.stock_check = 'confirming')))`;
  if (group === 'done') return db`AND r.status IN ('issued', 'approved')`;
  return db`AND r.status IN ('submitted', 'approved')`;
}

async function queryPagedMall(
  deps: Deps,
  actor: Actor,
  q: Omit<z.infer<typeof PagedQuery>, 'limit'> & { limit: number },
  opts: { mineOnly: boolean },
): Promise<{ requests: MallRequestBrief[]; nextBeforeId: number | null }> {
  if (q.from && q.to && q.from > q.to) throw badRequest('开始日期不能晚于结束日期');
  const db = deps.sql;
  const tz = deps.config.timezone;
  const me = await myContext(db, actor);
  const scope = (me.canReview || me.canStock) && !opts.mineOnly ? undefined : { staffId: actor.id, departmentId: me.departmentId };
  const pattern = q.q ? `%${escapeLike(q.q)}%` : null;
  const allowedDisplay = q.group ? new Set(MALL_GROUP_STATUSES[q.group]) : null;
  const chunkSize = Math.min(200, Math.max(q.limit + 1, 50));

  const matched: MallRequestBrief[] = [];
  let cursor = q.beforeId;
  // 按块向后翻找，确保按 13 态分组后分页不跳行、不重行、且只有真正还有下一页时才返回 nextBeforeId
  for (let round = 0; round < 40 && matched.length <= q.limit; round += 1) {
    const page = await db<{ id: number }[]>`
      SELECT r.id FROM purchase_requests r
      WHERE r.source = 'mall'
        ${q.priority ? db`AND r.priority = ${q.priority}` : db``}
        ${groupSqlPreFilter(db, q.group)}
        ${q.from ? db`AND (r.created_at AT TIME ZONE ${tz})::date >= ${q.from}` : db``}
        ${q.to ? db`AND (r.created_at AT TIME ZONE ${tz})::date <= ${q.to}` : db``}
        ${
          pattern
            ? db`AND (r.doc_no ILIKE ${pattern} ESCAPE '\\' OR r.budget_project ILIKE ${pattern} ESCAPE '\\'
                 OR EXISTS (SELECT 1 FROM purchase_request_lines l WHERE l.request_id = r.id AND l.name ILIKE ${pattern} ESCAPE '\\'))`
            : db``
        }
        ${cursor ? db`AND r.id < ${cursor}` : db``}
        ${scope ? db`AND ${REQUESTER_OR_DEPT(db, scope)}` : db``}
      ORDER BY r.id DESC LIMIT ${chunkSize}`;
    if (!page.length) break;
    const ids = page.map((r) => Number(r.id));
    const byId = new Map((await briefs(db, await summaries(db, { ids, timezone: tz }))).map((b) => [b.id, b]));
    for (const idVal of ids) {
      const brief = byId.get(idVal);
      if (!brief) continue;
      if (allowedDisplay && !allowedDisplay.has(brief.displayStatus)) continue;
      matched.push(brief);
      if (matched.length > q.limit) break;
    }
    if (page.length < chunkSize) break;
    cursor = ids[ids.length - 1]!;
  }

  const hasMore = matched.length > q.limit;
  const requests = hasMore ? matched.slice(0, q.limit) : matched;
  return { requests, nextBeforeId: hasMore && requests.length ? requests[requests.length - 1]!.id : null };
}

/**
 * 柚子里的商城页面「我的采购需求」「需求池」（Codex 审查 + FR-08）：来源是商城的单，按编号从新到旧一页页取，
 * 紧急程度、状态分组、关键词、日期范围都在服务端筛选再分页，老的单翻页也找得到。
 */
export async function pagedMall(deps: Deps, actor: Actor, raw: unknown, opts: { mineOnly: boolean }): Promise<{ requests: MallRequestBrief[]; nextBeforeId: number | null }> {
  const q = parse(PagedQuery, raw ?? {});
  return queryPagedMall(deps, actor, q, opts);
}

const MALL_EXPORT_LIMIT = 5000;

/** 商城侧「我的采购需求 / 需求池」当前筛选结果导出（FR-11）：与页面可见范围、筛选条件完全一致，金额按元保留两位小数 */
export async function exportMallCsv(deps: Deps, actor: Actor, raw: unknown, opts: { mineOnly: boolean; ip?: string }): Promise<{ fileName: string; csv: string; count: number }> {
  const parsed = parse(PagedQuery.omit({ beforeId: true, limit: true }), raw ?? {});
  const { requests } = await queryPagedMall(deps, actor, { ...parsed, beforeId: undefined, limit: MALL_EXPORT_LIMIT }, { mineOnly: opts.mineOnly });
  const ids = requests.map((r) => r.id);
  const metaRows = ids.length
    ? await deps.sql<{ id: number; storeName: string | null; estimateCents: string | null; hasPrice: boolean }[]>`
        SELECT r.id, st.name AS store_name,
               sum(round((l.qty_milli::numeric * l.ref_price_cents) / 1000))::bigint::text AS estimate_cents,
               bool_or(l.ref_price_cents IS NOT NULL) AS has_price
        FROM purchase_requests r
        LEFT JOIN stores st ON st.id = r.store_id
        LEFT JOIN purchase_request_lines l ON l.request_id = r.id
        WHERE r.id IN ${deps.sql(ids)}
        GROUP BY r.id, st.name`
    : [];
  const metaById = new Map(metaRows.map((m) => [Number(m.id), m]));
  const tz = deps.config.timezone;
  const fmtAt = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('sv-SE', { timeZone: tz }).slice(0, 16);
  };
  const header = ['需求单号', '门店', '部门', '预估金额（元）', '状态', '紧急程度', '更新时间', '摘要'];
  const rows: (string | number)[][] = [
    header,
    ...requests.map((r) => {
      const m = metaById.get(r.id);
      const yuan = m?.hasPrice && m.estimateCents !== null ? formatAmount(Number(m.estimateCents)).replace(/,/g, '') : '';
      return [r.docNo, m?.storeName ?? '', r.department.name, yuan, r.displayLabel, PRIORITY_LABELS[r.priority], fmtAt(r.progressUpdatedAt), r.summary];
    }),
  ];
  await writeAudit(deps.sql, {
    staffId: actor.id,
    action: 'export',
    targetType: 'purchase_requests',
    detail: { source: 'shop', scope: opts.mineOnly ? 'mine' : 'pool', ...parsed, count: requests.length },
    ip: opts.ip,
  });
  const stamp = todayIn(tz);
  return { fileName: `采购商城需求_${opts.mineOnly ? '我的' : '需求池'}_${stamp}.csv`, csv: toCsv(rows), count: requests.length };
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
