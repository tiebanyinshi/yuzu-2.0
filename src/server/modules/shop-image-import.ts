// 商品图批量导入（8.1.55，采购商城核对 K27-5：主线唯一真正缺的一项）：
//   POST /api/erp/shop/materials/images/import   { fileName, xlsxBase64, mode: 'append' | 'replace', apply }
// 一份 Excel（WPS「嵌入单元格」的图片）：一列物料编码（或物料名称），一列或几列图片；读第一个工作表。
// apply=false 只预览（逐行认物料、数图片、列问题）；apply=true 在物料行锁里写，有问题的行一行都不写。
// 追加：接在已有的后面、同一张图不重复；替换：这一行的图换成表里的。两种都能原样重发（结果一样），不另记操作编号。
// 每样物料最多 SHOP_MAX_MATERIAL_IMAGES 张、每张不超过 1 MB；图片存进 erp_images（general，按内容去重），与物料主档里一张张传的同一处。

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_IMAGE_BYTES } from '@shared/requests';
import { SHOP_MAX_MATERIAL_IMAGES, type ShopImageImportResult, type ShopImageImportRow } from '@shared/shop';
import type { Db } from '../db';
import { guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { unprocessable } from '../lib/errors';
import { setTxTimeouts } from '../lib/tx';
import { parse } from '../lib/validate';
import { dispImgId, readXlsx, XlsxReadError, type XlsxSheet } from '../lib/xlsx-read';
import { sniffImage } from './requests';

const Input = z.object({
  fileName: z.string().trim().min(1).max(200),
  xlsxBase64: z.string().min(16, '文件是空的').max(14_000_000, 'Excel 文件太大（最多 10 MB），请分几份导入'),
  mode: z.enum(['append', 'replace']).default('append'),
  apply: z.boolean().default(false),
});

const CODE_HEADERS = ['物料编码', '编码', '物料编号'];
const NAME_HEADERS = ['物料名称', '名称', '品名', '物料'];
const isImageHeader = (h: string) => /图/.test(h) && !/图片说明|备注/.test(h);

interface Parsed {
  row: number;
  code: string;
  name: string;
  images: { sha: string; mime: string; data: Buffer }[];
  issues: string[];
}

function readRows(sheet: XlsxSheet, cellImages: Map<string, { data: Buffer; ext: string }>): Parsed[] {
  const rowNos = [...sheet.rows.keys()].sort((a, b) => a - b);
  const text = (r: number, c: number) => (sheet.rows.get(r)?.get(c)?.value ?? '').trim();
  let headerRow = -1;
  let codeCol = -1;
  let nameCol = -1;
  let imageCols: number[] = [];
  for (const r of rowNos.slice(0, 10)) {
    const cells = [...(sheet.rows.get(r)?.keys() ?? [])].map((c) => ({ c, h: text(r, c) }));
    const code = cells.find((x) => CODE_HEADERS.includes(x.h));
    const name = cells.find((x) => NAME_HEADERS.includes(x.h));
    const imgs = cells.filter((x) => isImageHeader(x.h)).map((x) => x.c);
    if ((code || name) && imgs.length) {
      headerRow = r;
      codeCol = code?.c ?? -1;
      nameCol = name?.c ?? -1;
      imageCols = imgs.sort((a, b) => a - b);
      break;
    }
  }
  if (headerRow < 0) throw unprocessable('IMPORT_HEADER', '前 10 行里没找到表头：要有一列「物料编码」（或「物料名称」）和至少一列名字里带「图」的图片列');
  const out: Parsed[] = [];
  for (const r of rowNos.filter((n) => n > headerRow)) {
    const code = codeCol >= 0 ? text(r, codeCol) : '';
    const name = nameCol >= 0 ? text(r, nameCol) : '';
    const issues: string[] = [];
    const images: Parsed['images'] = [];
    for (const c of imageCols) {
      const key = dispImgId(sheet.rows.get(r)?.get(c)?.formula ?? null);
      if (!key) continue;
      const img = cellImages.get(key);
      if (!img) {
        issues.push('有一格图片在文件里找不到（请用 WPS「嵌入单元格」插入图片后另存）');
        continue;
      }
      const mime = sniffImage(img.data);
      if (!mime) issues.push('有一张图不是 JPEG、PNG 或 WebP');
      else if (img.data.length > MAX_IMAGE_BYTES) issues.push('有一张图超过 1 MB，请压缩后再放进表里');
      else images.push({ sha: createHash('sha256').update(img.data).digest('hex'), mime, data: img.data });
    }
    if (!code && !name && images.length === 0 && issues.length === 0) continue;
    if (images.length === 0 && issues.length === 0) issues.push('这一行没有图片');
    out.push({ row: r, code, name, images, issues });
  }
  if (out.length === 0) throw unprocessable('IMPORT_EMPTY', '表头下面没有数据行');
  return out;
}

interface MaterialRef {
  id: number;
  code: string;
  name: string;
}

async function plan(db: Db, rows: Parsed[], mode: 'append' | 'replace', lock: boolean) {
  const mats = await db<MaterialRef[]>`
    SELECT id, code, name FROM materials WHERE tracked ORDER BY id ${lock ? db`FOR UPDATE` : db``}`;
  const byCode = new Map(mats.map((m) => [m.code.toLowerCase(), m]));
  const byName = new Map<string, MaterialRef[]>();
  for (const m of mats) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
  const existing = new Map<number, { imageId: number; sha: string }[]>();
  for (const r of await db<{ materialId: number; imageId: number; sha: string }[]>`
    SELECT mi.material_id, mi.image_id, i.sha256 AS sha FROM material_images mi JOIN erp_images i ON i.id = mi.image_id ORDER BY mi.material_id, mi.sort_no`) {
    existing.set(Number(r.materialId), [...(existing.get(Number(r.materialId)) ?? []), { imageId: Number(r.imageId), sha: r.sha }]);
  }
  const seen = new Map<number, number>();
  const out: (ShopImageImportRow & { parsed: Parsed })[] = [];
  for (const p of rows) {
    const issues = [...p.issues];
    let m: MaterialRef | undefined;
    if (p.code) {
      m = byCode.get(p.code.toLowerCase());
      if (!m) issues.push(`物料编码「${p.code}」不在物料主档里`);
    } else if (p.name) {
      const hits = byName.get(p.name) ?? [];
      if (hits.length === 1) m = hits[0];
      else issues.push(hits.length ? `叫「${p.name}」的物料有 ${hits.length} 个，请写物料编码` : `物料「${p.name}」不在物料主档里`);
    } else issues.push('没写物料编码或名称');
    if (m) {
      const dup = seen.get(Number(m.id));
      if (dup) issues.push(`与第 ${dup} 行是同一样物料，请合在一行`);
      else seen.set(Number(m.id), p.row);
    }
    const before = m ? (existing.get(Number(m.id)) ?? []) : [];
    const fileShas = [...new Set(p.images.map((i) => i.sha))];
    const after = mode === 'replace' ? fileShas : [...new Set([...before.map((b) => b.sha), ...fileShas])];
    if (after.length > SHOP_MAX_MATERIAL_IMAGES) issues.push(`导入后有 ${after.length} 张图，每样物料最多 ${SHOP_MAX_MATERIAL_IMAGES} 张`);
    out.push({
      row: p.row,
      materialId: m ? Number(m.id) : null,
      materialCode: m?.code ?? p.code,
      materialName: m?.name ?? p.name,
      fileImages: p.images.length,
      before: before.length,
      after: after.length,
      changed: m ? after.join() !== before.map((b) => b.sha).join() : false,
      issues,
      parsed: p,
    });
  }
  return { rows: out, existing };
}

async function importImages(deps: Deps, raw: unknown, staffId: number, ip?: string): Promise<ShopImageImportResult> {
  const input = parse(Input, raw);
  let book;
  try {
    book = readXlsx(Buffer.from(input.xlsxBase64, 'base64'));
  } catch (error) {
    if (error instanceof XlsxReadError) throw unprocessable('IMPORT_FILE_INVALID', error.message);
    throw error;
  }
  const sheet = book.sheets[0];
  if (!sheet) throw unprocessable('IMPORT_EMPTY', 'Excel 文件里没有工作表');
  const parsed = readRows(sheet, book.cellImages);
  const summarize = (rows: ShopImageImportRow[], applied: boolean): ShopImageImportResult => ({
    mode: input.mode,
    applied,
    rows: rows.map(({ row, materialId, materialCode, materialName, fileImages, before, after, changed, issues }) => ({
      row,
      materialId,
      materialCode,
      materialName,
      fileImages,
      before,
      after,
      changed,
      issues,
    })),
    issueCount: rows.filter((r) => r.issues.length).length,
    changedCount: rows.filter((r) => !r.issues.length && r.changed).length,
  });
  if (!input.apply) return summarize((await plan(deps.sql, parsed, input.mode, false)).rows, false);

  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const { rows, existing } = await plan(tx, parsed, input.mode, true);
    const bad = rows.filter((r) => r.issues.length);
    if (bad.length) {
      throw unprocessable(
        'IMPORT_ISSUES',
        `有 ${bad.length} 行有问题，一行都没写：${bad
          .slice(0, 5)
          .map((r) => `第 ${r.row} 行 ${r.issues[0]}`)
          .join('；')}`,
        {
          rows: bad.map((r) => ({ row: r.row, issues: r.issues })),
        },
      );
    }
    const changed = rows.filter((r) => r.changed);
    for (const r of changed) {
      const ids: number[] = [];
      const keep = input.mode === 'append' ? (existing.get(r.materialId!) ?? []) : [];
      for (const k of keep) ids.push(k.imageId);
      for (const img of r.parsed.images) {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO erp_images (sha256, mime, data, size_bytes, created_by, scope) VALUES (${img.sha}, ${img.mime}, ${img.data}, ${img.data.length}, ${staffId}, 'general')
          ON CONFLICT (scope, sha256) DO NOTHING RETURNING id`;
        const imageId = Number(row?.id ?? (await tx<{ id: number }[]>`SELECT id FROM erp_images WHERE scope = 'general' AND sha256 = ${img.sha}`)[0]!.id);
        if (!ids.includes(imageId)) ids.push(imageId);
      }
      await tx`DELETE FROM material_images WHERE material_id = ${r.materialId}`;
      for (const [i, imageId] of ids.entries()) await tx`INSERT INTO material_images (material_id, sort_no, image_id) VALUES (${r.materialId}, ${i + 1}, ${imageId})`;
    }
    await writeAudit(tx, {
      staffId,
      action: 'material_images_imported',
      targetType: 'material',
      detail: {
        fileName: input.fileName,
        mode: input.mode,
        materials: changed.length,
        summary: `商品图批量导入（${input.fileName}，${input.mode === 'append' ? '追加' : '替换'}）：改了 ${changed.length} 样物料`,
      },
      ip,
    });
    return summarize(rows, true);
  });
}

export function registerShopImageImportRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/api/erp/shop/materials/images/import', { preHandler: guardAny('inventory.master'), bodyLimit: 15_000_000 }, async (req) => importImages(deps, req.body, req.actor.id, req.ip));
}
