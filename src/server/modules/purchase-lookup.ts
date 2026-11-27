// 采购模块按单号查（8.2.6，《采购模块需求补充：单号搜索 / 排序 / 无供应商自购》R1）：
// 输入采购单号、需求单号、商城申请单号或收货单号，直接定位到这张采购单（或需求单）与它的流程进度。
//   · 去掉首尾空格、忽略大小写、不管分隔符（CG20261127-0001 与 cg202611270001 一样）
//   · 完整单号精确命中优先；没有精确的，按后缀、再按包含列出候选（最多 20 条，服务端查）
//   · 需求单号、收货单号反查到采购单；只读，不改任何单据
// 页面在 src/client/features/purchasing/DocLookup.tsx。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DocLookupHit, DocLookupResult } from '@shared/purchase-lookup';
import { guardAny } from '../auth/guard';
import { readSnapshot, type Db } from '../db';
import type { Deps } from '../lib/context';
import { parse } from '../lib/validate';

const MAX_HITS = 20;

/** 单号归一：只留字母数字、大写 */
const normalizeDocNo = (s: string) =>
  s
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const NORM = (db: Db, col: string) => db.unsafe(`regexp_replace(upper(${col}), '[^A-Z0-9]', '', 'g')`);

export async function lookupDocNo(db: Db, raw: string): Promise<DocLookupResult> {
  const norm = normalizeDocNo(raw);
  if (norm.length < 3) return { query: raw.trim(), hits: [], exact: false };
  const like = `%${norm}%`;
  const pos = await db<Omit<DocLookupHit, 'kind' | 'poId' | 'requestId'>[]>`
    SELECT po.id, po.doc_no, po.status, coalesce(s.name, '自购 · ' || po.self_channel) AS party, coalesce((SELECT string_agg(m.name, '、' ORDER BY pl.line_no) FROM purchase_order_lines pl
             JOIN materials m ON m.id = pl.material_id WHERE pl.po_id = po.id AND pl.line_no <= 3), '') AS summary,
           po.created_at AS at, ${NORM(db, 'po.doc_no')} = ${norm} AS exact
    FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE ${NORM(db, 'po.doc_no')} LIKE ${like}
    ORDER BY (${NORM(db, 'po.doc_no')} = ${norm}) DESC, (${NORM(db, 'po.doc_no')} LIKE ${`%${norm}`}) DESC, po.id DESC LIMIT ${MAX_HITS}`;
  const requests = await db<(Omit<DocLookupHit, 'kind' | 'requestId'> & { poId: number | null })[]>`
    SELECT r.id, r.doc_no, r.status, d.name AS party, coalesce((SELECT string_agg(l.name, '、' ORDER BY l.line_no) FROM purchase_request_lines l
             WHERE l.request_id = r.id AND l.line_no <= 3), '') AS summary,
           r.created_at AS at,
           (${NORM(db, 'r.doc_no')} = ${norm} OR ${NORM(db, "coalesce(r.external_no, '')")} = ${norm}) AS exact,
           (SELECT min(po.id) FROM purchase_request_lines l JOIN purchase_order_line_requests x ON x.request_line_id = l.id
              JOIN purchase_order_lines pl ON pl.id = x.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
             WHERE l.request_id = r.id AND po.status <> 'cancelled') AS po_id
    FROM purchase_requests r JOIN departments d ON d.id = r.department_id
    WHERE ${NORM(db, 'r.doc_no')} LIKE ${like} OR ${NORM(db, "coalesce(r.external_no, '')")} LIKE ${like}
    ORDER BY exact DESC, (${NORM(db, 'r.doc_no')} LIKE ${`%${norm}`}) DESC, r.id DESC LIMIT ${MAX_HITS}`;
  const receipts = await db<(Omit<DocLookupHit, 'kind' | 'requestId'> & { poId: number | null })[]>`
    SELECT d.id, d.doc_no, d.status, coalesce(s.name, '') AS party, '' AS summary, d.created_at AS at,
           ${NORM(db, 'd.doc_no')} = ${norm} AS exact, d.purchase_order_id AS po_id
    FROM inv_docs d LEFT JOIN suppliers s ON s.id = d.supplier_id
    WHERE d.doc_type = 'receipt' AND ${NORM(db, 'd.doc_no')} LIKE ${like}
    ORDER BY exact DESC, d.id DESC LIMIT ${MAX_HITS}`;
  const hits: DocLookupHit[] = [
    ...pos.map((p) => ({ ...p, kind: 'po' as const, id: Number(p.id), poId: Number(p.id), requestId: null })),
    ...requests.map((r) => ({ ...r, kind: 'request' as const, id: Number(r.id), poId: r.poId === null ? null : Number(r.poId), requestId: Number(r.id) })),
    ...receipts.map((r) => ({ ...r, kind: 'receipt' as const, id: Number(r.id), poId: r.poId === null ? null : Number(r.poId), requestId: null })),
  ];
  // 精确的在前，其次后缀命中，再按时间新的在前
  const suffix = (h: DocLookupHit) => normalizeDocNo(h.docNo).endsWith(norm);
  hits.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(suffix(b)) - Number(suffix(a)) || Date.parse(String(b.at)) - Date.parse(String(a.at)));
  const exact = hits.filter((h) => h.exact);
  return { query: raw.trim(), hits: (exact.length ? exact : hits).slice(0, MAX_HITS), exact: exact.length > 0 };
}

const LookupQuery = z.object({ no: z.string().trim().min(1, '请输入单号').max(64, '单号最多 64 个字') });

export function registerPurchaseLookupRoutes(app: FastifyInstance, { sql }: Deps) {
  // 采购模块的人（看得到采购单的）才能查：结果按现在的数据权限，看不到采购单的不会进到这里
  app.get('/api/purchase-lookup', { preHandler: guardAny('inventory.read') }, async (req) => {
    const { no } = parse(LookupQuery, req.query);
    return readSnapshot(sql, (tx) => lookupDocNo(tx, no));
  });
}
