// 价目表录入（店主 2026-11-22《汤崎宝安全品类价目表录入系统需求说明》，docs/PRICE_CATALOG.md，PC1 起）。
// 第一批：数据模型与导入——六张表导入成「草稿」价目表数据集（替换原来的草稿），逐行校验带工作表、行号、字段与原因，
// 条数对照（门店 9、娱乐 8、房间 9、零点 131、按摩 67）。切换生效、回滚、改价留痕在第三批，开单取新价在第四批。
// 权限沿用「管理充值套餐与消费项目」（catalog.manage，需求说明：不改权限模型）。
// 加锁：导入草稿只碰这家门店的草稿那一行——先按门店锁住数据集（FOR UPDATE 门店的草稿行，没有就靠「一家门店一份草稿」的唯一索引兜底），
//   再删旧草稿的条目、写新条目。草稿不参与开单，不涉及别的模块的锁。

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PRICE_SHEET_NAMES,
  PRICE_SHEETS,
  priceCounts,
  type PriceCatalogEntry,
  type PriceCatalogOverview,
  type PriceCatalogSet,
  type PriceCatalogSetSummary,
  type PriceImportPreview,
} from '@shared/price-catalog';
import type { Db, Tx } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../../lib/context';
import { attachment } from '../../lib/csv';
import { notFound, unprocessable } from '../../lib/errors';
import { currentStoreId } from '../../lib/store-context';
import { parse } from '../../lib/validate';
import { buildWorkbook, type WbSheet } from '../../lib/xlsx';
import { readXlsx, XlsxReadError } from '../../lib/xlsx-read';
import { parsePriceCatalog } from './parse';

const FileFields = z.object({
  fileName: z.string().trim().min(1, '缺少文件名').max(120, '文件名太长'),
  xlsxBase64: z.string().min(1, '请选择 Excel 文件').max(6_000_000, '文件太大'),
});
const ImportInput = FileFields.extend({
  /** 用户看过的那次预览的摘要：与这次读出来的不一样（换了文件）就不导 */
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/, '请先预览，核对后再导入'),
  title: z.string().trim().max(60, '名称最多 60 个字').optional(),
});

// ───────────────────────── 读文件 ─────────────────────────

function previewOf(f: z.infer<typeof FileFields>): PriceImportPreview & { digest: string } {
  const buf = Buffer.from(f.xlsxBase64, 'base64');
  if (!/\.xlsx$/i.test(f.fileName)) throw unprocessable('IMPORT_FILE_INVALID', '只能导入 Excel（.xlsx）；老版本的 .xls 请另存为 .xlsx');
  let book;
  try {
    book = readXlsx(buf);
  } catch (error) {
    if (error instanceof XlsxReadError) throw unprocessable('IMPORT_FILE_INVALID', error.message);
    throw error;
  }
  const parsed = parsePriceCatalog(book);
  const { counts, total } = priceCounts(parsed.entries);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const errorCount = parsed.issues.filter((i) => i.level === 'error').length;
  const preview: PriceImportPreview = {
    fileName: f.fileName,
    sha256,
    entries: parsed.entries,
    issues: parsed.issues,
    errorCount,
    warningCount: parsed.issues.length - errorCount,
    counts,
    total,
    notes: parsed.notes,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify({ entries: parsed.entries, notes: parsed.notes }))
    .digest('hex');
  return { ...preview, digest };
}

// ───────────────────────── 读数据集 ─────────────────────────

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
}

const ENTRY_COLUMNS = `id, sheet, kind, section, category, code, name, price_mode, price_cents, price2_cents, rate_bp, unit, duration_minutes,
  extra_price_cents, extra_minutes, cap_cents, units_count, room_numbers, window_start, window_end, includes_meal, venues, gender,
  audience, content, highlight, note, variants, orderable, active, source_row, sort_order`;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
function entryOf(r: Record<string, unknown>): PriceCatalogEntry {
  return {
    id: Number(r.id),
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

async function setRows(db: Db | Tx, where: { id?: number; status?: 'draft' | 'active' }): Promise<SetRow[]> {
  return db<SetRow[]>`
    SELECT s.id, s.status, s.title, s.file_name, s.notes, s.created_at, c.display_name AS created_by_name, s.activated_at, a.display_name AS activated_by_name
    FROM price_catalog_sets s JOIN staff c ON c.id = s.created_by LEFT JOIN staff a ON a.id = s.activated_by
    WHERE s.store_id = ${currentStoreId()}
      ${where.id !== undefined ? db`AND s.id = ${where.id}` : db``}
      ${where.status ? db`AND s.status = ${where.status}` : db``}
    ORDER BY s.id DESC`;
}

async function entriesOf(db: Db | Tx, setId: number): Promise<PriceCatalogEntry[]> {
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
    counts,
    total,
    notes: s.notes ?? {},
  };
}

export async function priceCatalogOverview(db: Db): Promise<PriceCatalogOverview> {
  const [active] = await setRows(db, { status: 'active' });
  const [draft] = await setRows(db, { status: 'draft' });
  return { active: active ? await summaryOf(db, active) : null, draft: draft ? await summaryOf(db, draft) : null };
}

export async function priceCatalogSet(db: Db, id: number): Promise<PriceCatalogSet> {
  const [s] = await setRows(db, { id });
  if (!s) throw notFound('没有这份价目表');
  return { ...(await summaryOf(db, s)), entries: await entriesOf(db, Number(s.id)) };
}

// ───────────────────────── 导入成草稿 ─────────────────────────

const rowOf = (setId: number, e: PriceCatalogEntry) => ({
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

export async function importPriceCatalog(deps: Deps, raw: unknown, ctx: OpContext): Promise<PriceCatalogSet> {
  const f = parse(ImportInput, raw);
  const p = previewOf(f);
  if (p.digest !== f.previewDigest) throw unprocessable('IMPORT_STALE', '这份文件与预览时的不一样，请重新预览、核对后再导入');
  if (p.errorCount > 0) throw unprocessable('IMPORT_INVALID', `有 ${p.errorCount} 处问题，整份没有导入；请按预览里写的工作表、行号改好再导`);
  const id = await deps.sql.begin(async (tx) => {
    // 一家门店一份草稿：先锁住原来的草稿行（并发的两次导入在这里排队），删掉它与它的条目，再写新的
    const [old] = await tx<{ id: number }[]>`SELECT id FROM price_catalog_sets WHERE store_id = ${currentStoreId()} AND status = 'draft' FOR UPDATE`;
    if (old) await tx`DELETE FROM price_catalog_sets WHERE id = ${old.id}`;
    const title = f.title || `价目表 ${f.fileName.replace(/\.xlsx$/i, '')}`.slice(0, 60);
    const [set] = await tx<{ id: number }[]>`
      INSERT INTO price_catalog_sets (status, title, file_name, file_sha256, notes, created_by)
      VALUES ('draft', ${title}, ${f.fileName}, ${p.sha256}, ${tx.json(p.notes)}, ${ctx.actor.id}) RETURNING id`;
    const setId = Number(set!.id);
    for (let i = 0; i < p.entries.length; i += 100) {
      await tx`INSERT INTO price_catalog_entries ${tx(p.entries.slice(i, i + 100).map((e) => rowOf(setId, e)) as never[])}`;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'price_catalog',
      targetType: 'price_catalog_set',
      targetId: String(setId),
      detail: { action: 'import', label: `导入草稿「${title}」（${p.total.actual} 项）`, fileName: f.fileName, sha256: p.sha256, total: p.total.actual, replacedDraft: old ? Number(old.id) : null },
      ip: ctx.ip,
    });
    return setId;
  });
  return priceCatalogSet(deps.sql, id);
}

// ───────────────────────── 导入模板 ─────────────────────────

/** 与《价目表 1119》同结构的六张表（表头照原表；数据行留空） */
export function priceCatalogTemplate(): Buffer {
  const head = (cells: string[]) => ({ height: 22, cells: cells.map((v) => ({ v, style: 'optional' as const })) });
  const title = (v: string, span: number) => ({ height: 28, cells: [{ v, style: 'title' as const }, ...Array.from({ length: span - 1 }, () => null)] });
  const dishHead = ['序号', '菜品分类', '菜品名称', '售价', '单位'];
  const sheets: WbSheet[] = [
    { name: PRICE_SHEET_NAMES.store, widths: [10, 16, 10, 16, 24], rows: [title('门店价格', 5), head(['类型', '项目', '价格', '备注', '时间'])], merges: ['A1:E1'] },
    { name: PRICE_SHEET_NAMES.entertainment, widths: [14, 8, 12, 16], rows: [title('娱乐价格', 4), head(['类型', '数量', '价格', '备注'])], merges: ['A1:D1'] },
    { name: PRICE_SHEET_NAMES.room, widths: [12, 8, 22, 18, 30, 30], rows: [head(['房型', '总数', '收费参考', '', '备注', ''])] },
    {
      name: PRICE_SHEET_NAMES.dish,
      widths: [6, 12, 30, 8, 6],
      rows: ['2楼餐厅零点菜品', '早餐自助零点菜品', '午餐自助零点菜品', '晚餐自助零点菜品'].flatMap((t) => [title(t, 5), head(dishHead), { cells: [] }]),
      merges: [0, 1, 2, 3].map((i) => `A${i * 3 + 1}:E${i * 3 + 1}`),
    },
    {
      name: PRICE_SHEET_NAMES.massage,
      widths: [10, 6, 22, 10, 8, 8, 8, 30, 30, 30],
      rows: [head(['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价', '核心针对人群', '服务操作内容', '项目亮点'])],
    },
    { name: '储值政策', widths: [40], rows: [title('储值政策', 1)] },
  ];
  sheets[0]!.active = true;
  return buildWorkbook(sheets);
}

export function registerPriceCatalogRoutes(app: FastifyInstance, deps: Deps) {
  const manage = guard('catalog.manage');
  const bodyLimit = 8_500_000;
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  app.get('/api/admin/price-catalog', { preHandler: manage }, async () => priceCatalogOverview(deps.sql));
  app.get('/api/admin/price-catalog/sets/:id', { preHandler: manage }, async (req) => priceCatalogSet(deps.sql, parse(z.object({ id: z.coerce.number().int().positive() }), req.params).id));
  app.get('/api/admin/price-catalog/template', { preHandler: manage }, async (_req, reply) => {
    attachment(reply, '价目表导入模板.xlsx', XLSX);
    return reply.send(priceCatalogTemplate());
  });
  app.post('/api/admin/price-catalog/import/preview', { preHandler: manage, bodyLimit }, async (req) => previewOf(parse(FileFields, req.body)));
  app.post('/api/admin/price-catalog/import', { preHandler: manage, bodyLimit }, async (req, reply) => {
    const set = await importPriceCatalog(deps, req.body, ctxOf(req));
    reply.code(201);
    return set;
  });
}
