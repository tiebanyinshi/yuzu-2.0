// 价目表录入（店主 2026-11-22《汤崎宝安全品类价目表录入系统需求说明》，docs/PRICE_CATALOG.md，PC1 起）。
// 第一批：数据模型与导入——六张表导入成「草稿」价目表数据集（替换原来的草稿），逐行校验带工作表、行号、字段与原因，
// 条数对照（门店 9、娱乐 8、房间 9、零点 131、按摩 67）。单条新增、改价、停用、改价留痕、切换生效与回滚在 edit.ts（第三批），
// 读数据集在 read.ts，开单取新价在第四批。
// 权限沿用「管理充值套餐与消费项目」（catalog.manage，需求说明：不改权限模型）。
// 加锁：导入草稿只碰这家门店的草稿那一行——先按门店锁住数据集（FOR UPDATE 门店的草稿行，没有就靠「一家门店一份草稿」的唯一索引兜底），
//   再删旧草稿的条目、写新条目。草稿不参与开单，不涉及别的模块的锁。

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PRICE_SHEET_NAMES, PRICE_SHEETS, priceCounts, type PriceCatalogEntry, type PriceCatalogSet, type PriceImportPreview } from '@shared/price-catalog';
import { guard, guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../../lib/context';
import { attachment } from '../../lib/csv';
import { conflict, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { erpOpAbandoned } from '../erp-ops';
import { currentStoreId } from '../../lib/store-context';
import { parse } from '../../lib/validate';
import { buildWorkbook, type WbSheet } from '../../lib/xlsx';
import { readXlsx, XlsxReadError } from '../../lib/xlsx-read';
import { exportPriceCatalog, priceCategoryChecks } from './checks';
import { registerPriceCatalogEditRoutes } from './edit';
import { lockStoreCatalog, registerPriceLinkRoutes } from './links';
import { parsePriceCatalog, PriceFileError } from './parse';
import { priceSheet, priceSheets } from './sheet-io';
import { activePriceCatalog, entriesOf, priceCatalogOverview, priceCatalogSet, rowOf } from './read';

const FileFields = z.object({
  fileName: z.string().trim().min(1, '缺少文件名').max(120, '文件名太长'),
  xlsxBase64: z.string().min(1, '请选择 Excel 文件').max(6_000_000, '文件太大'),
  /** 只导这一张表（各模块单独的模板：门店 / 娱乐 / 房间 / 零点菜品 / 按摩及助浴）；不写是整份六张表 */
  sheet: z.enum(PRICE_SHEETS, '工作表不对').optional(),
});
const ImportInput = FileFields.extend({
  /** 用户看过的那次预览的摘要：与这次读出来的不一样（换了文件）就不导 */
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/, '请先预览，核对后再导入'),
  title: z.string().trim().max(60, '名称最多 60 个字').optional(),
  /** 操作编号：结果不确定（断网、超时）原样重提时返回第一次的结果，不再替换草稿 */
  opKey: z.uuid('缺少操作编号'),
});

// ───────────────────────── 读文件 ─────────────────────────

function previewOf(f: z.infer<typeof FileFields>): PriceImportPreview & { digest: string } {
  const buf = Buffer.from(f.xlsxBase64, 'base64');
  if (!/\.xlsx$/i.test(f.fileName)) throw unprocessable('IMPORT_FILE_INVALID', '只能导入 Excel（.xlsx）；老版本的 .xls 请另存为 .xlsx');
  let book;
  let parsed;
  try {
    book = readXlsx(buf);
    parsed = parsePriceCatalog(book, { only: f.sheet, fileName: f.fileName });
  } catch (error) {
    if (error instanceof XlsxReadError || error instanceof PriceFileError) throw unprocessable('IMPORT_FILE_INVALID', error.message);
    throw error;
  }
  // 只导一张表：条数对照只列这一张（别的表照旧，不算差了几项）
  const all = priceCounts(parsed.entries);
  const counts = f.sheet ? all.counts.filter((c) => c.sheet === f.sheet) : all.counts;
  const total = f.sheet ? { expected: counts[0]!.expected, actual: counts[0]!.actual } : all.total;
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
    ...(f.sheet ? { sheet: f.sheet } : {}),
  };
  const digest = createHash('sha256')
    .update(JSON.stringify({ sheet: f.sheet ?? null, entries: parsed.entries, notes: parsed.notes }))
    .digest('hex');
  return { ...preview, digest };
}

// ───────────────────────── 导入成草稿 ─────────────────────────

export async function importPriceCatalog(deps: Deps, raw: unknown, ctx: OpContext): Promise<PriceCatalogSet> {
  const f = parse(ImportInput, raw);
  const p = previewOf(f);
  if (p.digest !== f.previewDigest) throw unprocessable('IMPORT_STALE', '这份文件与预览时的不一样，请重新预览、核对后再导入');
  if (p.errorCount > 0) throw unprocessable('IMPORT_INVALID', `有 ${p.errorCount} 处问题，整份没有导入；请按预览里写的工作表、行号改好再导`);
  const id = await deps.sql.begin(async (tx) => {
    // 同一个操作编号排队；已经做过的返回第一次的那份草稿（草稿后来被替换或放弃的拒绝，不再替换别人新导的）
    await lockOpKey(tx, f.opKey);
    const [done] = await tx<{ setId: number | null; fileSha256: string; storeId: number }[]>`
      SELECT set_id, file_sha256, store_id FROM price_catalog_import_ops WHERE op_key = ${f.opKey}`;
    if (done) {
      if (Number(done.storeId) !== currentStoreId() || done.fileSha256 !== p.sha256) throw conflict('IMPORT_OP_REUSED', '这个操作编号已经用过了，请刷新页面后重新导入');
      if (done.setId === null) throw conflict('IMPORT_DONE', '这次导入之前已经成功了，但那份草稿后来被替换或放弃；刷新页面看现在的草稿');
      return Number(done.setId);
    }
    // 页面上「确认作废」过的编号：原请求晚到也不导
    await assertNotFenced(tx, f.opKey, 'price_import', erpOpAbandoned);
    // 一家门店一份草稿：门店级咨询锁（与切换、回滚、放弃同一把）→ 原来的草稿行，删掉它与它的条目，再写新的
    await lockStoreCatalog(tx);
    const [old] = await tx<{ id: number; title: string; notes: Record<string, string> | null }[]>`
      SELECT id, title, notes FROM price_catalog_sets WHERE store_id = ${currentStoreId()} AND status = 'draft' FOR UPDATE`;
    // 只导一张表：别的表照现在的草稿（没有草稿就照生效中的那份）原样带过来，只换这一张
    let kept: PriceCatalogEntry[] = [];
    let keptNotes: Record<string, string> = {};
    let baseTitle = '';
    if (f.sheet) {
      const base =
        old ??
        (
          await tx<{ id: number; title: string; notes: Record<string, string> | null }[]>`
        SELECT id, title, notes FROM price_catalog_sets WHERE store_id = ${currentStoreId()} AND status = 'active'`
        )[0];
      if (base) {
        kept = (await entriesOf(tx, Number(base.id))).filter((e) => e.sheet !== f.sheet);
        keptNotes = base.notes ?? {};
        baseTitle = base.title;
      }
    }
    if (old) await tx`DELETE FROM price_catalog_sets WHERE id = ${old.id}`;
    const title = (f.title || (f.sheet ? `${baseTitle.replace(/（导入[^）]*）$/, '') || '价目表'}（导入${PRICE_SHEET_NAMES[f.sheet]}）` : `价目表 ${f.fileName.replace(/\.xlsx$/i, '')}`)).slice(0, 60);
    const [set] = await tx<{ id: number }[]>`
      INSERT INTO price_catalog_sets (status, title, file_name, file_sha256, notes, created_by)
      VALUES ('draft', ${title}, ${f.fileName}, ${p.sha256}, ${tx.json({ ...keptNotes, ...p.notes })}, ${ctx.actor.id}) RETURNING id`;
    const setId = Number(set!.id);
    await tx`INSERT INTO price_catalog_import_ops (op_key, set_id, file_sha256, staff_id) VALUES (${f.opKey}, ${setId}, ${p.sha256}, ${ctx.actor.id})`;
    const rows = [...kept, ...p.entries];
    for (let i = 0; i < rows.length; i += 100) {
      await tx`INSERT INTO price_catalog_entries ${tx(rows.slice(i, i + 100).map((e) => rowOf(setId, e)) as never[])}`;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'price_catalog',
      targetType: 'price_catalog_set',
      targetId: String(setId),
      detail: {
        action: 'import',
        label: f.sheet ? `导入${PRICE_SHEET_NAMES[f.sheet]}到草稿「${title}」（${p.total.actual} 项，别的表照原样）` : `导入草稿「${title}」（${p.total.actual} 项）`,
        fileName: f.fileName,
        sha256: p.sha256,
        total: p.total.actual,
        ...(f.sheet ? { sheet: f.sheet } : {}),
        replacedDraft: old ? Number(old.id) : null,
      },
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
  const SheetQuery = z.object({ sheet: z.enum(PRICE_SHEETS, '工作表不对').optional() });
  const storeName = async () => (await deps.sql<{ name: string }[]>`SELECT name FROM stores WHERE id = ${currentStoreId()}`)[0]?.name ?? '';
  app.get('/api/admin/price-catalog/template', { preHandler: manage }, async (req, reply) => {
    // 各模块单独的模板（?sheet=room……）：照门店从总表拆出来的那张表的格式，数据留空
    const { sheet } = parse(SheetQuery, req.query ?? {});
    if (sheet) {
      attachment(reply, `${PRICE_SHEET_NAMES[sheet]}.xlsx`, XLSX);
      return reply.send(buildWorkbook([{ ...priceSheet(sheet, [], await storeName()), active: true }]));
    }
    attachment(reply, '价目表导入模板.xlsx', XLSX);
    return reply.send(priceCatalogTemplate());
  });
  // 按导入模板的格式导出（?sheet= 只导这一张）：页面改过的也在里面，导出的文件原样再导入不丢、不重复
  app.get('/api/admin/price-catalog/sets/:id/export-sheets', { preHandler: manage }, async (req, reply) => {
    const id = parse(z.object({ id: z.coerce.number().int().positive() }), req.params).id;
    const { sheet } = parse(SheetQuery, req.query ?? {});
    const set = await priceCatalogSet(deps.sql, id);
    const name = await storeName();
    attachment(reply, sheet ? `${PRICE_SHEET_NAMES[sheet]}.xlsx` : `${set.title}（导入格式）.xlsx`, XLSX);
    return reply.send(buildWorkbook(sheet ? [{ ...priceSheet(sheet, set.entries, name), active: true }] : priceSheets(set.entries, name, set.notes)));
  });
  app.post('/api/admin/price-catalog/import/preview', { preHandler: manage, bodyLimit }, async (req) => previewOf(parse(FileFields, req.body)));
  app.post('/api/admin/price-catalog/import', { preHandler: manage, bodyLimit }, async (req, reply) => {
    const set = await importPriceCatalog(deps, req.body, ctxOf(req));
    reply.code(201);
    return set;
  });
  // 重做第四批：分类核对、导出一份价目表
  app.get('/api/admin/price-catalog/category-checks', { preHandler: manage }, async () => priceCategoryChecks(deps.sql));
  app.get('/api/admin/price-catalog/sets/:id/export', { preHandler: manage }, async (req, reply) => {
    const id = parse(z.object({ id: z.coerce.number().int().positive() }), req.params).id;
    const set = await priceCatalogSet(deps.sql, id);
    attachment(reply, `${set.title}.xlsx`, XLSX);
    return reply.send(await exportPriceCatalog(deps.sql, id));
  });
  // 第四批：生效中的价目表（在用的条目），收银台「价目试算」与开单页取价用；前台能看账单的、管价目的都能读
  app.get('/api/price-catalog/active', { preHandler: guardAny('frontdesk.read', 'catalog.manage') }, async () => activePriceCatalog(deps.sql));
  registerPriceCatalogEditRoutes(app, deps);
  registerPriceLinkRoutes(app, deps);
}
