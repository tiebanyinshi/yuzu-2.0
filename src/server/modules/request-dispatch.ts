// 物料发配记录（8.2.6，《汤崎 ERP｜采购商城模块 需求变更文档 v0.2》第 5、6 章，docs/MALL_V826.md）：
//   · 部门申请的一行物料可以分几次给：核库时先给库存有的（request-stock.ts 开领料单，记一条 stock），剩下的采购到货以后
//     在库存「物料发配记录」里点「补发物料」（记一条 arrival），直到待发配量为 0；每一次都开部门领料单（与部门领料同一条路，不另造出库类型）。
//   · 已发配量 = 这一行发配记录的合计（领料单作废的不算）；待发配量 = 申请量 − 已发配量；部分发配仍算「未完成」。
//   · 库存可发量：总仓结存按「先申请先给」分到各行（同一物料几个部门在等时，先提交的先分）；只有合格入库的才进总仓，拒收、待补、待判的不算。
//   · 从升级到 8.2.6 那天起提交的需求单进这张表；之前的照原来的方式手工开领料单（不然几年的旧单全在「未完成」里）。
// 加锁：操作编号 → 需求行一行（FOR UPDATE）→ 领料单照库存单据原来的锁（单号 → 物料 → 部门小仓）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fitsDecimals, formatQty, toBaseQty } from '@shared/quantity';
import { DISPATCH_RANGES, DISPATCH_TABS, type DispatchBoard, type DispatchDetail, type DispatchIssue, type DispatchRow, type DispatchStatus, type DispatchTab } from '@shared/dispatch';
import { readSnapshot, type Db, type Fragment, type Tx } from '../db';
import { guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { dateIn, todayIn } from '../lib/dates';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced, lockOpKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';
import { createRequestIssue } from './inventory';
import { notify } from './oa';

/** 一次最多给页面多少行（按提交时间倒序；超过的提示用搜索收窄） */
const MAX_ROWS = 1000;

interface RawLine {
  lineId: number;
  lineNo: number;
  requestId: number;
  docNo: string;
  source: string;
  status: string;
  departmentId: number;
  departmentName: string;
  requesterId: number;
  requesterName: string;
  submittedAt: string;
  name: string;
  details: string;
  unit: string;
  appliedMilli: number;
  materialId: number | null;
  materialName: string | null;
  inventoryUnit: string | null;
  purchaseUnit: string | null;
  factorMilli: number | null;
  decimals: number | null;
  stockMilli: number | null;
  materialActive: boolean | null;
  issuedMilli: number;
  issueCount: number;
  inTransitMilli: number;
  expectedDate: string | null;
  terminated: boolean;
}

const LINE_SQL = (db: Db, where: Fragment) => db<RawLine[]>`
  WITH m AS (
    SELECT l.id AS line_id,
           coalesce(l.material_id, (SELECT min(pl.material_id) FROM purchase_order_line_requests x
                                    JOIN purchase_order_lines pl ON pl.id = x.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
                                    WHERE x.request_line_id = l.id AND po.status <> 'cancelled')) AS material_id
    FROM purchase_request_lines l JOIN purchase_requests r ON r.id = l.request_id
    WHERE ${where}
  )
  SELECT l.id AS line_id, l.line_no, r.id AS request_id, r.doc_no, r.source, r.status, r.department_id, d.name AS department_name,
         r.requester_id, rs.display_name AS requester_name, coalesce(r.submitted_at, r.created_at) AS submitted_at,
         l.name, l.details, l.unit, l.qty_milli AS applied_milli,
         m.material_id, mt.name AS material_name, mt.inventory_unit, mt.purchase_unit, mt.purchase_factor_milli AS factor_milli, mt.decimals,
         mt.stock_milli, (mt.active AND mt.tracked) AS material_active,
         coalesce((SELECT sum(i.qty_milli) FROM request_line_issues i JOIN inv_docs v ON v.id = i.inv_doc_id
                   WHERE i.request_line_id = l.id AND v.status = 'confirmed'), 0)::bigint AS issued_milli,
         (SELECT count(*) FROM request_line_issues i JOIN inv_docs v ON v.id = i.inv_doc_id WHERE i.request_line_id = l.id AND v.status = 'confirmed')::int AS issue_count,
         coalesce((SELECT sum(greatest(pl.base_qty_milli - coalesce((SELECT sum(dl.qty_milli) FROM inv_doc_lines dl JOIN inv_docs dd ON dd.id = dl.doc_id
                                                                     WHERE dl.po_line_id = pl.id AND dd.status = 'confirmed'), 0), 0))
                   FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
                   WHERE x.request_line_id = l.id AND po.status = 'approved'), 0)::bigint AS in_transit_milli,
         (SELECT min(po.expected_date)::text FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id
            JOIN purchase_orders po ON po.id = pl.po_id WHERE x.request_line_id = l.id AND po.status = 'approved') AS expected_date,
         EXISTS (SELECT 1 FROM request_terminations t WHERE t.request_id = r.id AND t.status = 'approved') AS terminated
  FROM m JOIN purchase_request_lines l ON l.id = m.line_id JOIN purchase_requests r ON r.id = l.request_id
  JOIN departments d ON d.id = r.department_id JOIN staff rs ON rs.id = r.requester_id
  LEFT JOIN materials mt ON mt.id = m.material_id
  ORDER BY coalesce(r.submitted_at, r.created_at) DESC, r.id DESC, l.line_no`;

/** 从哪天起记：迁移 580 执行的时间（升级那一刻） */
async function sinceOf(db: Db): Promise<string | null> {
  const [s] = await db<{ at: string | null }[]>`SELECT applied_at AS at FROM schema_migrations WHERE version = '580_mall_dispatch.sql'`;
  return s?.at ? new Date(s.at).toISOString() : null;
}

/** 进发配记录的行：升级以后提交的需求单里，审核通过（或已转领用、已结束）的；有过发配的不论新旧都进 */
function scopeWhere(db: Db, since: string | null) {
  return db`(
    (r.status IN ('approved', 'issued', 'rejected', 'cancelled') AND (${since}::timestamptz IS NULL OR r.created_at >= ${since}::timestamptz))
    OR EXISTS (SELECT 1 FROM request_line_issues i WHERE i.request_line_id = l.id)
  )`;
}

const unitModeOf = (l: Pick<RawLine, 'unit' | 'inventoryUnit' | 'purchaseUnit'>): DispatchRow['unitMode'] =>
  l.inventoryUnit && l.unit === l.inventoryUnit ? 'inventory' : l.purchaseUnit && l.unit === l.purchaseUnit ? 'purchase' : null;

/** 待发配量换成库存单位（换不了的按 null：先给多少由库管填） */
function pendingBase(l: RawLine, pending: number): number | null {
  const mode = unitModeOf(l);
  if (mode === 'inventory') return pending;
  if (mode === 'purchase' && l.factorMilli) return toBaseQty(pending, Number(l.factorMilli)) ?? Math.ceil((pending * Number(l.factorMilli)) / 1000);
  return null;
}

async function lastIssues(db: Db, lineIds: number[]): Promise<Map<number, DispatchIssue>> {
  if (!lineIds.length) return new Map();
  const rows = await db<(DispatchIssue & { lineId: number })[]>`
    SELECT DISTINCT ON (i.request_line_id) i.request_line_id AS line_id, i.id, v.id AS doc_id, v.doc_no, i.qty_milli, i.kind, i.note, i.created_at AS at,
           s.display_name AS by_name, v.status <> 'confirmed' AS voided
    FROM request_line_issues i JOIN inv_docs v ON v.id = i.inv_doc_id JOIN staff s ON s.id = i.created_by
    WHERE i.request_line_id IN ${db(lineIds)} AND v.status = 'confirmed'
    ORDER BY i.request_line_id, i.created_at DESC, i.id DESC`;
  return new Map(rows.map((r) => [Number(r.lineId), issueOf(r)]));
}

const issueOf = (r: DispatchIssue): DispatchIssue => ({
  id: Number(r.id),
  docId: Number(r.docId),
  docNo: r.docNo,
  qtyMilli: Number(r.qtyMilli),
  kind: r.kind,
  note: r.note,
  at: new Date(r.at).toISOString(),
  byName: r.byName,
  voided: r.voided,
});

/** 拼一行：状态、按先申请先给分到这一行的库存可发量 */
function buildRows(raw: RawLine[], last: Map<number, DispatchIssue>): DispatchRow[] {
  // 总仓结存按物料、先申请先给：提交时间从早到晚分
  const left = new Map<number, number>();
  for (const l of raw) if (l.materialId !== null && l.stockMilli !== null) left.set(Number(l.materialId), Math.max(0, Number(l.stockMilli)));
  const available = new Map<number, number>();
  const ended = (l: RawLine) => l.terminated || l.status === 'rejected' || l.status === 'cancelled';
  for (const l of [...raw].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.lineId - b.lineId)) {
    const pending = Number(l.appliedMilli) - Number(l.issuedMilli);
    if (ended(l) || pending <= 0 || l.materialId === null || !l.materialActive) continue;
    const have = left.get(Number(l.materialId)) ?? 0;
    if (have <= 0) continue;
    const need = pendingBase(l, pending);
    const give = need === null ? have : Math.min(have, need);
    available.set(Number(l.lineId), give);
    if (need !== null) left.set(Number(l.materialId), have - give);
  }
  return raw.map((l) => {
    const applied = Number(l.appliedMilli);
    const issued = Number(l.issuedMilli);
    const pending = Math.max(0, applied - issued);
    const avail = available.get(Number(l.lineId)) ?? 0;
    const inTransit = Number(l.inTransitMilli);
    const status: DispatchStatus = ended(l) ? 'ended' : pending === 0 ? 'done' : avail > 0 ? 'ready' : issued > 0 ? 'partial' : inTransit > 0 ? 'awaiting' : 'pending';
    const lastIssue = last.get(Number(l.lineId)) ?? null;
    return {
      lineId: Number(l.lineId),
      requestId: Number(l.requestId),
      docNo: l.docNo,
      source: l.source,
      departmentId: Number(l.departmentId),
      departmentName: l.departmentName,
      requesterName: l.requesterName,
      submittedAt: new Date(l.submittedAt).toISOString(),
      name: l.name,
      details: l.details,
      unit: l.unit,
      materialId: l.materialId === null ? null : Number(l.materialId),
      materialName: l.materialName,
      inventoryUnit: l.inventoryUnit,
      unitMode: unitModeOf(l),
      appliedMilli: applied,
      issuedMilli: issued,
      pendingMilli: pending,
      availableMilli: avail,
      inTransitMilli: inTransit,
      expectedDate: l.expectedDate,
      lastIssue,
      issueCount: Number(l.issueCount),
      status,
      activityAt: lastIssue?.at ?? new Date(l.submittedAt).toISOString(),
    };
  });
}

const tabOf = (r: DispatchRow): DispatchTab[] => {
  const tabs: DispatchTab[] = ['all'];
  if (r.status === 'ended') tabs.push('ended');
  else if (r.status === 'done') tabs.push('done');
  else {
    tabs.push('open');
    if (r.issuedMilli === 0) tabs.push('unissued');
  }
  return tabs;
};

const BoardQuery = z.object({
  tab: z.enum(DISPATCH_TABS).default('open'),
  range: z.enum(DISPATCH_RANGES).default('all'),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  q: z.string().trim().max(40).default(''),
  departmentId: z.coerce.number().int().positive().optional(),
});

export async function dispatchBoard(deps: Deps, raw: unknown): Promise<DispatchBoard> {
  const q = parse(BoardQuery, raw ?? {});
  const tz = deps.config.timezone;
  return readSnapshot(deps.sql, async (db) => {
    const since = await sinceOf(db);
    const lines = await LINE_SQL(db, scopeWhere(db, since));
    const all = buildRows(
      lines,
      await lastIssues(
        db,
        lines.filter((l) => Number(l.issueCount) > 0).map((l) => Number(l.lineId)),
      ),
    );
    const today = todayIn(tz);
    const inRange = (r: DispatchRow) => {
      if (q.range === 'all') return true;
      const day = dateIn(r.activityAt, tz);
      if (q.range === 'today') return day === today;
      if (q.range === 'week') return day > shift(today, -7);
      if (q.range === 'month') return day >= `${today.slice(0, 7)}-01`;
      return (!q.from || day >= q.from) && (!q.to || day <= q.to);
    };
    const kw = q.q.toLowerCase();
    const matches = (r: DispatchRow) =>
      (!q.departmentId || r.departmentId === q.departmentId) && (!kw || [r.docNo, r.departmentName, r.name, r.materialName ?? '', r.requesterName].some((x) => x.toLowerCase().includes(kw)));
    const filtered = all.filter((r) => inRange(r) && matches(r));
    const counts = Object.fromEntries(DISPATCH_TABS.map((t) => [t, 0])) as Record<DispatchTab, number>;
    for (const r of filtered) for (const t of tabOf(r)) counts[t] += 1;
    let rows = filtered.filter((r) => tabOf(r).includes(q.tab));
    // 未发配申请：可发配的置顶，其余先申请先给（文档 6.7）；其余页签按最近动静倒序
    if (q.tab === 'unissued' || q.tab === 'open') {
      rows = rows.sort((a, b) => Number(b.status === 'ready') - Number(a.status === 'ready') || a.submittedAt.localeCompare(b.submittedAt) || a.lineId - b.lineId);
    } else rows = rows.sort((a, b) => b.activityAt.localeCompare(a.activityAt) || b.lineId - a.lineId);
    return { rows: rows.slice(0, MAX_ROWS), counts, since, truncated: rows.length > MAX_ROWS };
  });
}

const shift = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** 库管待办（文档 6.8）：合格入库以后能补发的申请行有几行（库存「物料发配记录」可发配的） */
export async function dispatchReadyCount(db: Db): Promise<number> {
  const lines = await LINE_SQL(db, scopeWhere(db, await sinceOf(db)));
  return buildRows(lines, new Map()).filter((r) => r.status === 'ready').length;
}

export async function dispatchDetail(deps: Deps, lineId: number): Promise<DispatchDetail> {
  return readSnapshot(deps.sql, async (db) => {
    const lines = await LINE_SQL(db, db`l.id = ${lineId}`);
    if (!lines.length) throw notFound('这一行申请不存在');
    const issues = (
      await db<DispatchIssue[]>`
        SELECT i.id, v.id AS doc_id, v.doc_no, i.qty_milli, i.kind, i.note, i.created_at AS at, s.display_name AS by_name, v.status <> 'confirmed' AS voided
        FROM request_line_issues i JOIN inv_docs v ON v.id = i.inv_doc_id JOIN staff s ON s.id = i.created_by
        WHERE i.request_line_id = ${lineId} ORDER BY i.created_at, i.id`
    ).map(issueOf);
    const [row] = buildRows(lines, new Map(issues.filter((i) => !i.voided).map((i) => [lineId, i])));
    return { row: row!, issues };
  });
}

// ───────────────────────── 记一次发配（核库、补发都走这里） ─────────────────────────

/** 在开好领料单的事务里记一条发配记录（核库领用、替代同意、补发物料） */
export async function recordIssue(tx: Tx, e: { lineId: number; requestId: number; departmentId: number; docId: number; qtyMilli: number; kind: 'stock' | 'arrival'; note: string; actorId: number }) {
  await tx`
    INSERT INTO request_line_issues (request_line_id, request_id, department_id, inv_doc_id, qty_milli, kind, note, created_by)
    VALUES (${e.lineId}, ${e.requestId}, ${e.departmentId}, ${e.docId}, ${e.qtyMilli}, ${e.kind}, ${e.note.slice(0, 200)}, ${e.actorId})
    ON CONFLICT (inv_doc_id, request_line_id) DO NOTHING`;
}

const IssueInput = z.object({
  clientKey: z.uuid('缺少操作编号，请刷新页面后重试'),
  /** 这次发多少（申请行的单位） */
  qtyMilli: z.number('请填写这次发配的数量').int().positive('这次发配的数量要大于 0').max(1_000_000_000),
  /** 申请行的单位换不成库存单位时：实际出库多少（库存单位） */
  stockQtyMilli: z.number().int().positive('出库数量要大于 0').max(1_000_000_000).optional(),
  note: z.string().trim().max(100).default(''),
});

/**
 * 补发物料（文档 6.6）：从一行未完成的申请继续发，开一张部门领料单（与部门领料同一条路）并记一条发配记录。
 * 只能发审核通过的单、不超过待发配量与总仓结存；待发配量发到 0 时通知提单人。返回发配记录编号
 */
export async function issueDispatch(deps: Deps, lineId: number, raw: unknown, actor: Actor, ip?: string): Promise<DispatchDetail> {
  const input = parse(IssueInput, raw);
  const requestHash = hashRequest({ op: 'request_dispatch', lineId, ...input, clientKey: undefined });
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, input.clientKey);
    const [done] = await tx<{ opType: string; requestHash: string; staffId: number }[]>`
      SELECT op_type, request_hash, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (done) {
      if (done.opType !== 'request_dispatch' || done.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一笔内容不同的发配');
      return;
    }
    await assertNotFenced(tx, input.clientKey, 'request_dispatch', erpOpAbandoned);
    // 锁这一行申请：同一行两个人同时补发，后来的按前一笔发完以后的待发配量核对
    const [locked] = await tx<{ id: number }[]>`SELECT id FROM purchase_request_lines WHERE id = ${lineId} FOR UPDATE`;
    if (!locked) throw notFound('这一行申请不存在');
    const [l] = await LINE_SQL(tx, tx`l.id = ${lineId}`);
    if (!l) throw notFound('这一行申请不存在');
    if (l.terminated || l.status === 'rejected' || l.status === 'cancelled') throw conflict('REQUEST_ENDED', `需求单 ${l.docNo} 已终止，不再发配`);
    if (l.status !== 'approved' && l.status !== 'issued') throw conflict('REQUEST_NOT_APPROVED', `需求单 ${l.docNo} 还没审核通过，通过以后再发配`);
    if (l.materialId === null || !l.materialActive) throw unprocessable('NO_MATERIAL', `「${l.name}」还没对应到在用的受管物料（转采购单时会定），定了以后才能从总仓发`);
    const pending = Number(l.appliedMilli) - Number(l.issuedMilli);
    if (pending <= 0) throw conflict('DISPATCH_DONE', `「${l.name}」已经发齐了`);
    if (input.qtyMilli > pending) throw unprocessable('DISPATCH_EXCEEDS', `「${l.name}」最多再发 ${formatQty(pending)} ${l.unit}（待发配量）`);
    const mode = unitModeOf(l);
    let base: number;
    if (mode === 'inventory') base = input.qtyMilli;
    else if (mode === 'purchase') {
      const b = toBaseQty(input.qtyMilli, Number(l.factorMilli));
      if (b === null) throw badRequest(`${formatQty(input.qtyMilli)} ${l.unit} 换算成 ${l.inventoryUnit} 除不尽，请换一个数`);
      base = b;
    } else {
      if (!input.stockQtyMilli) throw badRequest(`申请的单位「${l.unit}」换不成库存单位「${l.inventoryUnit}」，请另填实际出库多少 ${l.inventoryUnit}`);
      base = input.stockQtyMilli;
    }
    if (!fitsDecimals(base, Number(l.decimals))) throw badRequest(`「${l.materialName}」最多 ${l.decimals} 位小数（单位：${l.inventoryUnit}）`);
    if (base > Number(l.stockMilli)) throw unprocessable('INSUFFICIENT_STOCK', `「${l.materialName}」总仓只有 ${formatQty(Number(l.stockMilli))} ${l.inventoryUnit}`);
    const doc = await createRequestIssue(
      tx,
      deps,
      {
        departmentId: Number(l.departmentId),
        handler: l.requesterName,
        note: `需求单 ${l.docNo} 第 ${l.lineNo} 行补发${input.note ? `：${input.note}` : ''}`.slice(0, 200),
        lines: [
          {
            materialId: Number(l.materialId),
            qtyMilli: base,
            enteredQtyMilli: mode === 'purchase' ? input.qtyMilli : null,
            enteredUnit: mode === 'purchase' ? l.unit : null,
            note: `${l.docNo} 第 ${l.lineNo} 行`,
          },
        ],
      },
      actor,
    );
    // 关联的采购单收过货的算「到货后发配」，否则是从原有库存发
    const [arrived] = await tx<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM purchase_order_line_requests x JOIN inv_doc_lines dl ON dl.po_line_id = x.po_line_id JOIN inv_docs dd ON dd.id = dl.doc_id
                     WHERE x.request_line_id = ${lineId} AND dd.status = 'confirmed') AS ok`;
    const kind = arrived?.ok ? 'arrival' : 'stock';
    await recordIssue(tx, { lineId, requestId: Number(l.requestId), departmentId: Number(l.departmentId), docId: doc.id, qtyMilli: input.qtyMilli, kind, note: input.note, actorId: actor.id });
    const left = pending - input.qtyMilli;
    if (left === 0) {
      await notify(tx, [Number(l.requesterId)], {
        kind: 'system',
        title: `「${l.name}」已经发齐`,
        body: `需求单 ${l.docNo}：申请 ${formatQty(Number(l.appliedMilli))} ${l.unit}，已全部发到${l.departmentName}（最后一次领料单 ${doc.docNo}）。`,
      });
    }
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'request_dispatch',
      targetType: 'purchase_request',
      targetId: Number(l.requestId),
      detail: { docNo: l.docNo, line: l.lineNo, issueDocNo: doc.docNo, qtyMilli: input.qtyMilli, unit: l.unit, kind, pendingAfter: left },
      ip,
    });
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'request_dispatch', ${requestHash}, ${lineId}, ${actor.id})`;
  });
  return dispatchDetail(deps, lineId);
}

export function registerRequestDispatchRoutes(app: FastifyInstance, deps: Deps) {
  // 看：库管、核库的、看库存的；补发：库管或核库的（与核库开领料单同一组）
  const read = guardAny('inventory.read', 'inventory.operate', 'request.stock');
  const write = guardAny('inventory.operate', 'request.stock');
  app.get('/api/inventory/dispatch', { preHandler: read }, async (req) => dispatchBoard(deps, req.query));
  app.get('/api/inventory/dispatch/lines/:id', { preHandler: read }, async (req) => dispatchDetail(deps, parse(idParam, req.params).id));
  app.post('/api/inventory/dispatch/lines/:id/issue', { preHandler: write }, async (req) => issueDispatch(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
}
