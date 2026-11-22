// 价目表录入：读数据集与条目（导入、编辑、切换都用；docs/PRICE_CATALOG.md）。只读、不加锁。

import { PRICE_SHEETS, priceCounts, type PriceCatalogEntry, type PriceCatalogOverview, type PriceCatalogSet, type PriceCatalogSetSummary } from '@shared/price-catalog';
import type { Db, Tx } from '../../db';
import { notFound } from '../../lib/errors';
import { currentStoreId } from '../../lib/store-context';

interface SetRow {
  id: number;
  status: 'draft' | 'active' | 'retired';
  title: string;
  fileName: string | null;
  notes: Record<string, string>;
  createdAt: string;
  createdByName: string;
  activatedAt: string | null;
  activatedByName: string | null;
  retiredAt: string | null;
}

export const ENTRY_COLUMNS = `id, sheet, kind, section, category, code, name, price_mode, price_cents, price2_cents, rate_bp, unit, duration_minutes,
  extra_price_cents, extra_minutes, cap_cents, units_count, room_numbers, window_start, window_end, includes_meal, venues, gender,
  audience, content, highlight, note, variants, orderable, active, source_row, sort_order, version`;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
export function entryOf(r: Record<string, unknown>): PriceCatalogEntry {
  return {
    id: Number(r.id),
    version: Number(r.version),
    sheet: r.sheet as PriceCatalogEntry['sheet'],
    kind: r.kind as PriceCatalogEntry['kind'],
    section: String(r.section),
    category: String(r.category),
    code: String(r.code),
    name: String(r.name),
    priceMode: r.priceMode as PriceCatalogEntry['priceMode'],
    priceCents: num(r.priceCents),
    price2Cents: num(r.price2Cents),
    rateBp: num(r.rateBp),
    unit: String(r.unit),
    durationMinutes: num(r.durationMinutes),
    extraPriceCents: num(r.extraPriceCents),
    extraMinutes: num(r.extraMinutes),
    capCents: num(r.capCents),
    unitsCount: num(r.unitsCount),
    roomNumbers: (r.roomNumbers as string[]) ?? [],
    windowStart: num(r.windowStart),
    windowEnd: num(r.windowEnd),
    includesMeal: r.includesMeal === null ? null : Boolean(r.includesMeal),
    venues: (r.venues as PriceCatalogEntry['venues']) ?? [],
    gender: (r.gender as PriceCatalogEntry['gender']) ?? null,
    audience: String(r.audience),
    content: String(r.content),
    highlight: String(r.highlight),
    note: String(r.note),
    variants: (r.variants as PriceCatalogEntry['variants']) ?? [],
    orderable: Boolean(r.orderable),
    active: Boolean(r.active),
    sourceRow: num(r.sourceRow),
    sortOrder: Number(r.sortOrder),
  };
}

async function setRows(db: Db | Tx, where: { id?: number; status?: 'draft' | 'active' | 'retired' }): Promise<SetRow[]> {
  return db<SetRow[]>`
    SELECT s.id, s.status, s.title, s.file_name, s.notes, s.created_at, c.display_name AS created_by_name, s.activated_at, a.display_name AS activated_by_name, s.retired_at
    FROM price_catalog_sets s JOIN staff c ON c.id = s.created_by LEFT JOIN staff a ON a.id = s.activated_by
    WHERE s.store_id = ${currentStoreId()}
      ${where.id !== undefined ? db`AND s.id = ${where.id}` : db``}
      ${where.status ? db`AND s.status = ${where.status}` : db``}
    ORDER BY s.retired_at DESC NULLS LAST, s.id DESC`;
}

export async function entriesOf(db: Db | Tx, setId: number): Promise<PriceCatalogEntry[]> {
  const rows = await db<Record<string, unknown>[]>`
    SELECT ${db.unsafe(ENTRY_COLUMNS)} FROM price_catalog_entries WHERE set_id = ${setId}
    ORDER BY array_position(${[...PRICE_SHEETS]}::text[], sheet), sort_order, id`;
  return rows.map(entryOf);
}

async function summaryOf(db: Db | Tx, s: SetRow): Promise<PriceCatalogSetSummary> {
  const rows = await db<{ sheet: PriceCatalogEntry['sheet']; kind: PriceCatalogEntry['kind']; section: string; active: boolean }[]>`
    SELECT sheet, kind, section, active FROM price_catalog_entries WHERE set_id = ${s.id}`;
  const { counts, total } = priceCounts(rows);
  return {
    id: Number(s.id),
    status: s.status,
    title: s.title,
    fileName: s.fileName,
    createdAt: s.createdAt,
    createdByName: s.createdByName,
    activatedAt: s.activatedAt,
    activatedByName: s.activatedByName,
    retiredAt: s.retiredAt,
    counts,
    total,
    notes: s.notes ?? {},
  };
}

export async function priceCatalogOverview(db: Db | Tx): Promise<PriceCatalogOverview> {
  const [active] = await setRows(db, { status: 'active' });
  const [draft] = await setRows(db, { status: 'draft' });
  // 上一版：最近一次换下来的（停用时间最晚的）
  const [previous] = await setRows(db, { status: 'retired' });
  return {
    active: active ? await summaryOf(db, active) : null,
    draft: draft ? await summaryOf(db, draft) : null,
    previous: previous ? await summaryOf(db, previous) : null,
  };
}

export async function priceCatalogSet(db: Db | Tx, id: number): Promise<PriceCatalogSet> {
  const [s] = await setRows(db, { id });
  if (!s) throw notFound('没有这份价目表');
  return { ...(await summaryOf(db, s)), entries: await entriesOf(db, Number(s.id)) };
}

/** 条目 → 表里的一行（导入、新增用；postgres.js 插入要写列名） */
export const rowOf = (setId: number, e: PriceCatalogEntry) => ({
  set_id: setId,
  sheet: e.sheet,
  kind: e.kind,
  section: e.section,
  category: e.category,
  code: e.code,
  name: e.name,
  price_mode: e.priceMode,
  price_cents: e.priceCents,
  price2_cents: e.price2Cents,
  rate_bp: e.rateBp,
  unit: e.unit,
  duration_minutes: e.durationMinutes,
  extra_price_cents: e.extraPriceCents,
  extra_minutes: e.extraMinutes,
  cap_cents: e.capCents,
  units_count: e.unitsCount,
  room_numbers: e.roomNumbers,
  window_start: e.windowStart,
  window_end: e.windowEnd,
  includes_meal: e.includesMeal,
  venues: e.venues,
  gender: e.gender,
  audience: e.audience,
  content: e.content,
  highlight: e.highlight,
  note: e.note,
  variants: e.variants,
  orderable: e.orderable,
  active: e.active,
  source_row: e.sourceRow,
  sort_order: e.sortOrder,
});
