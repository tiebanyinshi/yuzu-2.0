// 退回补资料的「本次必补」与版本快照（8.2.6，docs/MALL_V826.md；表在迁移 580）。
// 退回在 requests.ts 的 actOnRequest（商城来的需求单要逐项标必补）；补资料重提、终止申购在 mall-pilot.ts。
// 这里只读写这几张表，不引用 requests.ts / mall-pilot.ts（免得互相引用）。

import { z } from 'zod';
import {
  isMallFixHeaderField,
  MALL_FIX_FIELD_LABELS,
  MALL_FIX_FIELDS,
  type MallFixField,
  type MallFixItem,
  type MallTermination,
  type MallVersion,
  type MallVersionBrief,
  type MallVersionMode,
  type MallVersionSnapshot,
} from '@shared/mall-fix';
import type { MallCustomSpec } from '@shared/requests';
import type { Db } from '../db';
import { notFound, unprocessable } from '../lib/errors';

export const FixItemsInput = z
  .array(
    z.object({
      lineId: z.number().int().positive().nullable().default(null),
      field: z.enum(MALL_FIX_FIELDS, '必补项不认识，请刷新页面'),
      requirement: z.string().trim().min(1, '每一项必补都要写清楚补什么').max(200, '每一项的要求最多 200 个字'),
    }),
  )
  .max(40, '一次最多标 40 项必补');

/** 一行在某一项上的值（退回时原值、补资料时比对、补的内容都按它） */
export interface FixLine {
  id: number;
  name: string;
  qtyMilli: number;
  unit: string;
  /** 部门写的说明（定制的不带【定制】那一段） */
  plainDetails: string;
  brandModel: string;
  link: string;
  reasonText: string;
  customSpec: MallCustomSpec | null;
  imageIds: number[];
}
export interface FixHeader {
  needBy: string | null;
  deliveryAddress: string;
  budgetProject: string;
  contactName: string;
  note: string;
}

const qtyText = (milli: number) => String(milli / 1000);

export function lineFieldValue(l: FixLine, field: MallFixField): string {
  const spec = l.customSpec;
  switch (field) {
    case 'name':
      return l.name;
    case 'qty':
      return qtyText(l.qtyMilli);
    case 'unit':
      return l.unit;
    case 'details':
      return l.plainDetails;
    case 'brandModel':
      return l.brandModel;
    case 'link':
      return l.link;
    case 'reasonText':
      return l.reasonText;
    case 'images':
      return l.imageIds.length ? `${l.imageIds.length} 张图片（#${l.imageIds.join('、#')}）` : '';
    case 'spec.size':
      return spec?.size ?? '';
    case 'spec.material':
      return spec?.material ?? '';
    case 'spec.tolerance':
      return spec?.tolerance ?? '';
    case 'spec.color':
      return spec?.color ?? '';
    case 'spec.craft':
      return spec?.craft ?? '';
    case 'spec.drawing': {
      const parts = [spec?.drawingUrl ? `链接 ${spec.drawingUrl}` : '', l.imageIds.length ? `${l.imageIds.length} 个图纸 / 图片文件` : ''].filter(Boolean);
      return parts.join('；');
    }
    case 'spec.designVersion':
      return spec?.designVersion ?? '';
    default:
      return '';
  }
}

export function headerFieldValue(h: FixHeader, field: MallFixField): string {
  switch (field) {
    case 'needBy':
      return h.needBy ?? '';
    case 'deliveryAddress':
      return h.deliveryAddress;
    case 'budgetProject':
      return h.budgetProject;
    case 'contactName':
      return h.contactName;
    case 'note':
      return h.note;
    default:
      return '';
  }
}

/** 这张单现在的行（退回时取原值用） */
async function currentLines(db: Db, requestId: number): Promise<FixLine[]> {
  const rows = await db<
    {
      id: number;
      name: string;
      qtyMilli: number;
      unit: string;
      details: string;
      brandModel: string;
      link: string;
      reasonText: string;
      customKind: string | null;
      customSpec: MallCustomSpec | null;
      imageIds: number[] | null;
    }[]
  >`
    SELECT l.id, l.name, l.qty_milli, l.unit, l.details, l.brand_model, l.link, l.reason_text, l.custom_kind, l.custom_spec,
           (SELECT array_agg(i.image_id ORDER BY i.sort_no) FROM purchase_request_line_images i WHERE i.request_line_id = l.id) AS image_ids
    FROM purchase_request_lines l WHERE l.request_id = ${requestId} ORDER BY l.line_no`;
  return rows.map((l) => ({
    id: Number(l.id),
    name: l.name,
    qtyMilli: Number(l.qtyMilli),
    unit: l.unit,
    plainDetails: stripCustomHead(l.details, l.customKind),
    brandModel: l.brandModel ?? '',
    link: l.link ?? '',
    reasonText: l.reasonText ?? '',
    customSpec: l.customSpec,
    imageIds: (l.imageIds ?? []).map(Number),
  }));
}

/** 与 mall-pilot.ts 的 plainDetails 同一个规则：定制的说明前面那段【定制】是拼出来的 */
export function stripCustomHead(details: string, kind: string | null): string {
  if (kind !== 'custom' || !details.startsWith('【定制】')) return details;
  const i = details.indexOf('\n');
  return i < 0 ? '' : details.slice(i + 1);
}

/**
 * 退回时记下这一轮的必补项（round = 之前的轮数 + 1）。行上的项要是这张单的行；同一行同一项只记一次。
 * 返回写进审批记录的一句话（「必补：第 1 行 尺寸 / 规格；收货地点」）
 */
export async function recordFixItems(tx: Db, requestId: number, items: z.infer<typeof FixItemsInput>, actorId: number): Promise<string> {
  if (!items.length) return '';
  const lines = await currentLines(tx, requestId);
  const byId = new Map(lines.map((l, i) => [l.id, { l, no: i + 1 }]));
  const [h] = await tx<FixHeader[]>`
    SELECT to_char(need_by, 'YYYY-MM-DD') AS need_by, delivery_address, budget_project, contact_name, note FROM purchase_requests WHERE id = ${requestId}`;
  const [next] = await tx<{ round: number }[]>`SELECT coalesce(max(round), 0) + 1 AS round FROM request_fix_items WHERE request_id = ${requestId}`;
  const round = Number(next!.round);
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const it of items) {
    const header = isMallFixHeaderField(it.field);
    if (header !== (it.lineId === null)) throw unprocessable('FIX_ITEM_INVALID', `「${MALL_FIX_FIELD_LABELS[it.field]}」${header ? '是整张单的项，不用选行' : '要选是哪一行'}`);
    const key = `${it.lineId ?? 0}:${it.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let original = '';
    let lineLabel = '';
    if (it.lineId !== null) {
      const hit = byId.get(it.lineId);
      if (!hit) throw unprocessable('FIX_ITEM_INVALID', '有一项必补选的行不在这张需求单里，刷新后再退回');
      original = lineFieldValue(hit.l, it.field);
      lineLabel = `第 ${hit.no} 行 ${hit.l.name}`.slice(0, 120);
      labels.push(`第 ${hit.no} 行 ${MALL_FIX_FIELD_LABELS[it.field]}`);
    } else {
      original = h ? headerFieldValue(h, it.field) : '';
      labels.push(MALL_FIX_FIELD_LABELS[it.field]);
    }
    await tx`
      INSERT INTO request_fix_items (request_id, round, request_line_id, line_label, field_key, original_value, requirement, returned_by)
      VALUES (${requestId}, ${round}, ${it.lineId}, ${lineLabel}, ${it.field}, ${original.slice(0, 1000)}, ${it.requirement}, ${actorId})`;
  }
  return `必补：${labels.join('；')}`.slice(0, 180);
}

/** 这一轮还没补的必补项（最近一次退回标的） */
export async function openFixItems(db: Db, requestId: number): Promise<{ id: number; lineId: number | null; field: MallFixField; requirement: string }[]> {
  const rows = await db<{ id: number; lineId: number | null; field: MallFixField; requirement: string }[]>`
    SELECT id, request_line_id AS line_id, field_key AS field, requirement FROM request_fix_items
    WHERE request_id = ${requestId} AND resolved_at IS NULL
      AND round = (SELECT max(round) FROM request_fix_items WHERE request_id = ${requestId})
    ORDER BY id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), lineId: r.lineId === null ? null : Number(r.lineId) }));
}

export async function resolveFixItem(tx: Db, id: number, supplied: string) {
  await tx`UPDATE request_fix_items SET supplied_value = ${supplied.slice(0, 2000)}, resolved_at = now() WHERE id = ${id}`;
}

/** 重新填写（rewrite）提交：这一轮没逐项补的也算处理过了（补的内容记成「重新填写」） */
export async function resolveAllOpen(tx: Db, requestId: number, describe: (lineId: number | null, field: MallFixField) => string) {
  for (const it of await openFixItems(tx, requestId)) await resolveFixItem(tx, it.id, describe(it.lineId, it.field));
}

export async function fixItemsOf(db: Db, requestId: number): Promise<MallFixItem[]> {
  const rows = await db<(Omit<MallFixItem, 'fieldLabel'> & { lineId: number | null })[]>`
    SELECT f.id, f.round, f.request_line_id AS line_id, f.line_label, f.field_key AS field, f.original_value, f.requirement, f.supplied_value,
           s.display_name AS returned_by_name, f.returned_at, f.resolved_at
    FROM request_fix_items f JOIN staff s ON s.id = f.returned_by
    WHERE f.request_id = ${requestId} ORDER BY f.round, f.id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), lineId: r.lineId === null ? null : Number(r.lineId), fieldLabel: MALL_FIX_FIELD_LABELS[r.field] ?? r.field }));
}

// ───────────────────────── 版本快照 ─────────────────────────

export async function snapshotOf(db: Db, requestId: number): Promise<MallVersionSnapshot> {
  const [h] = await db<(FixHeader & { priority: string })[]>`
    SELECT to_char(need_by, 'YYYY-MM-DD') AS need_by, delivery_address, budget_project, contact_name, note, priority FROM purchase_requests WHERE id = ${requestId}`;
  const rows = await db<
    {
      id: number;
      lineNo: number;
      name: string;
      qtyMilli: number;
      unit: string;
      details: string;
      brandModel: string;
      link: string;
      reasonText: string;
      customKind: string | null;
      customSpec: Record<string, unknown> | null;
      imageIds: number[] | null;
    }[]
  >`
    SELECT l.id, l.line_no, l.name, l.qty_milli, l.unit, l.details, l.brand_model, l.link, l.reason_text, l.custom_kind, l.custom_spec,
           (SELECT array_agg(i.image_id ORDER BY i.sort_no) FROM purchase_request_line_images i WHERE i.request_line_id = l.id) AS image_ids
    FROM purchase_request_lines l WHERE l.request_id = ${requestId} ORDER BY l.line_no`;
  return {
    header: {
      needBy: h?.needBy ?? null,
      deliveryAddress: h?.deliveryAddress ?? '',
      budgetProject: h?.budgetProject ?? '',
      contactName: h?.contactName ?? '',
      priority: h?.priority ?? '',
      note: h?.note ?? '',
    },
    lines: rows.map((l) => ({
      id: Number(l.id),
      lineNo: Number(l.lineNo),
      name: l.name,
      qtyMilli: Number(l.qtyMilli),
      unit: l.unit,
      details: l.details,
      brandModel: l.brandModel ?? '',
      link: l.link ?? '',
      reasonText: l.reasonText ?? '',
      customKind: l.customKind,
      customSpec: l.customSpec,
      imageIds: (l.imageIds ?? []).map(Number),
    })),
  };
}

/** 存一版：按这张单现在的内容（写完明细以后调） */
export async function saveVersion(tx: Db, requestId: number, mode: MallVersionMode, actorId: number) {
  const snap = await snapshotOf(tx, requestId);
  await tx`
    INSERT INTO purchase_request_versions (request_id, version_no, snapshot, mode, created_by)
    SELECT ${requestId}, coalesce(max(version_no), 0) + 1, ${tx.json(snap as never)}, ${mode}, ${actorId}
    FROM purchase_request_versions WHERE request_id = ${requestId}`;
}

/** 升级前就提交的单第一次补资料：先把补之前的内容补记成 V1（按提单人、提交时间） */
export async function ensureBaseline(tx: Db, requestId: number) {
  const [has] = await tx`SELECT 1 FROM purchase_request_versions WHERE request_id = ${requestId} LIMIT 1`;
  if (has) return;
  const snap = await snapshotOf(tx, requestId);
  await tx`
    INSERT INTO purchase_request_versions (request_id, version_no, snapshot, mode, created_by, created_at)
    SELECT id, 1, ${tx.json(snap as never)}, 'baseline', requester_id, coalesce(submitted_at, created_at) FROM purchase_requests WHERE id = ${requestId}`;
}

export async function versionsOf(db: Db, requestId: number): Promise<MallVersionBrief[]> {
  const rows = await db<MallVersionBrief[]>`
    SELECT v.version_no, v.mode, v.created_at, s.display_name AS created_by_name
    FROM purchase_request_versions v JOIN staff s ON s.id = v.created_by WHERE v.request_id = ${requestId} ORDER BY v.version_no`;
  return rows.map((v) => ({ ...v, versionNo: Number(v.versionNo) }));
}

export async function versionOf(db: Db, requestId: number, versionNo: number): Promise<MallVersion> {
  const [v] = await db<(MallVersionBrief & { snapshot: MallVersionSnapshot })[]>`
    SELECT v.version_no, v.mode, v.created_at, s.display_name AS created_by_name, v.snapshot
    FROM purchase_request_versions v JOIN staff s ON s.id = v.created_by WHERE v.request_id = ${requestId} AND v.version_no = ${versionNo}`;
  if (!v) throw notFound('没有这一版');
  return { ...v, versionNo: Number(v.versionNo) };
}

// ───────────────────────── 终止申购（读） ─────────────────────────

export async function terminationOf(db: Db, requestId: number): Promise<MallTermination | null> {
  const [t] = await db<MallTermination[]>`
    SELECT t.status, t.reason, rq.display_name AS requested_by_name, t.requested_at, dc.display_name AS decided_by_name, t.decided_at, t.decide_note
    FROM request_terminations t JOIN staff rq ON rq.id = t.requested_by LEFT JOIN staff dc ON dc.id = t.decided_by
    WHERE t.request_id = ${requestId}`;
  return t ?? null;
}
