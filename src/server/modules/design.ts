// Design 素材库（店主 2026-11-24，docs/BOARDS.md 第 4、9 节）：字体、图片、视频存在库里；每个用途（@shared/design 的 DESIGN_SLOTS）
// 选一份当前使用的，一键切换、可切回。做法照开源调研（Payload、Strapi、Penpot）：
//   · 素材与版本分开、版本只追加——「换文件」是加一版，编号不变、旧版还在；用途绑在某一版上，素材出了新版不跟着悄悄变；
//   · 每次切换追加一行（带操作编号，原样重提给第一次的结果；带页面看到的当前版本，别人先换过的拒绝 SLOT_CHANGED）；
//   · 用着的素材不能归档；文件按文件头认格式，SVG 照工作台的规矩把关，送出去带禁止脚本的 CSP。
// 加锁：上传只写新行（同一份素材加版本时锁素材一行）；切换先取这个用途的咨询锁再写（docs/LOCKING.md「Design 素材库」）。

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DESIGN_KIND_LABELS,
  DESIGN_LIMITS,
  DESIGN_SLOT_KEYS,
  DESIGN_SLOTS,
  DESIGN_TOTAL_MAX_BYTES,
  type DesignAsset,
  type DesignAssetDetail,
  type DesignAssetKind,
  type DesignCurrent,
  type DesignSlot,
  type DesignSlotState,
  type DesignVersion,
} from '@shared/design';
import { isUniqueViolation, type Db, type Tx } from '../db';
import { guardAny, sessionOnly } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { currentStoreId } from '../lib/store-context';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { assetHeaders, parseStudioAsset } from './studio/assets';

// ───────────────────────── 认文件 ─────────────────────────

interface Parsed {
  mime: string;
  bytes: Buffer;
  sha256: string;
  width: number | null;
  height: number | null;
  fontFamily: string | null;
}

const isTrueType = (b: Buffer) => b.readUInt32BE(0) === 0x00010000 || b.toString('latin1', 0, 4) === 'true';

/** TTF / OTF 名称表里的字族名（nameID 1，优先 Windows 的 UTF-16BE）；WOFF / WOFF2 是压缩的，读不到为空 */
function fontFamilyOf(b: Buffer): string | null {
  try {
    const numTables = b.readUInt16BE(4);
    for (let i = 0; i < numTables; i += 1) {
      const rec = 12 + i * 16;
      if (b.toString('latin1', rec, rec + 4) !== 'name') continue;
      const base = b.readUInt32BE(rec + 8);
      const count = b.readUInt16BE(base + 2);
      const strings = base + b.readUInt16BE(base + 4);
      let mac: string | null = null;
      for (let j = 0; j < count; j += 1) {
        const r = base + 6 + j * 12;
        const platform = b.readUInt16BE(r);
        const nameId = b.readUInt16BE(r + 6);
        if (nameId !== 1) continue;
        const len = b.readUInt16BE(r + 8);
        const off = strings + b.readUInt16BE(r + 10);
        if (platform === 3)
          return (
            Buffer.from(b.subarray(off, off + len))
              .swap16()
              .toString('utf16le')
              .trim()
              .slice(0, 120) || null
          );
        if (platform === 1 && mac === null)
          mac = b
            .toString('latin1', off, off + len)
            .trim()
            .slice(0, 120);
      }
      return mac || null;
    }
  } catch {
    // 表不完整：当没读到
  }
  return null;
}

/** 试用版字体（名称表里写着 Unlicensed Trial）不收：条款不许放在服务器上、不许分发（与 brand-fonts 目录同一规矩） */
const isTrialFont = (b: Buffer) => b.includes(Buffer.from('Unlicensed Trial', 'latin1')) || b.includes(Buffer.from('Unlicensed Trial', 'utf16le').swap16());

export function parseDesignFile(kind: DesignAssetKind, bytes: Buffer): Parsed {
  if (bytes.length === 0) throw badRequest('文件是空的');
  const limit = DESIGN_LIMITS[kind];
  if (bytes.length > limit.maxBytes) throw unprocessable('DESIGN_TOO_LARGE', `${DESIGN_KIND_LABELS[kind]}最大 ${limit.maxBytes / 1024 / 1024} MB`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (kind === 'image') {
    const img = parseStudioAsset(bytes.toString('base64'));
    return { mime: img.mime, bytes, sha256, width: img.width, height: img.height, fontFamily: null };
  }
  if (kind === 'font') {
    const head = bytes.length >= 12 ? bytes.toString('latin1', 0, 4) : '';
    const mime = head === 'wOF2' ? 'font/woff2' : head === 'wOFF' ? 'font/woff' : head === 'OTTO' ? 'font/otf' : bytes.length >= 12 && isTrueType(bytes) ? 'font/ttf' : null;
    if (!mime) throw unprocessable('DESIGN_TYPE', `字体只收 ${limit.formats}`);
    if (isTrialFont(bytes)) throw unprocessable('DESIGN_FONT_TRIAL', '这是试用版字体（写着 Unlicensed Trial），条款不许放在服务器上：请换成授权包里的文件');
    return { mime, bytes, sha256, width: null, height: null, fontFamily: mime === 'font/ttf' || mime === 'font/otf' ? fontFamilyOf(bytes) : null };
  }
  const mp4 = bytes.length > 12 && bytes.toString('latin1', 4, 8) === 'ftyp';
  const webm = bytes.length > 4 && bytes.readUInt32BE(0) === 0x1a45dfa3;
  if (!mp4 && !webm) throw unprocessable('DESIGN_TYPE', `视频只收 ${limit.formats}`);
  return { mime: mp4 ? 'video/mp4' : 'video/webm', bytes, sha256, width: null, height: null, fontFamily: null };
}

// ───────────────────────── 读 ─────────────────────────

type VersionRow = DesignVersion & { assetId: number };
const versionCols = (db: Db) => db`
  v.id, v.asset_id, v.version_no, v.mime, v.size_bytes, v.width, v.height, v.font_family, v.created_at, s.display_name AS created_by_name`;

const toVersion = (v: VersionRow): DesignVersion => ({
  id: Number(v.id),
  versionNo: v.versionNo,
  mime: v.mime,
  sizeBytes: v.sizeBytes,
  width: v.width,
  height: v.height,
  fontFamily: v.fontFamily,
  createdAt: v.createdAt,
  createdByName: v.createdByName,
});

/**
 * 每个用途现在用哪一版（这家门店的最新一行）。用途按门店分开设（Codex 安全审查：只挂在分店的设计师不能改总店的横幅、大屏、字体），
 * 与对客导览、UI 工作台一样按当前门店；素材库本身（素材与版本）全公司一份
 */
export async function currentSlots(db: Db): Promise<DesignCurrent> {
  const rows = await db<{ slot: string; versionId: number | null }[]>`
    SELECT DISTINCT ON (slot) slot, version_id FROM design_slot_assignments WHERE store_id = ${currentStoreId()} ORDER BY slot, id DESC`;
  const map = Object.fromEntries(DESIGN_SLOT_KEYS.map((k) => [k, null])) as DesignCurrent;
  for (const r of rows) if (r.slot in map) map[r.slot as DesignSlot] = r.versionId === null ? null : Number(r.versionId);
  return map;
}

/** 素材列表一页多少（Codex 审查：不再一次截到 500 条，按编号往前翻页，另可按名字、标签搜） */
export const DESIGN_PAGE_SIZE = 60;

async function assetsOf(db: Db, ids?: number[], f: { kind?: DesignAssetKind; archived?: boolean; search?: string; beforeId?: number; limit?: number } = {}): Promise<DesignAsset[]> {
  const like = f.search ? `%${f.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await db<{ id: number; kind: DesignAssetKind; name: string; tags: string[]; note: string; archivedAt: string | null; createdAt: string; updatedAt: string; versionCount: number }[]>`
    SELECT a.id, a.kind, a.name, a.tags, a.note, a.archived_at, a.created_at, a.updated_at,
           (SELECT count(*)::int FROM design_asset_versions v WHERE v.asset_id = a.id) AS version_count
    FROM design_assets a
    WHERE TRUE ${ids ? db`AND a.id IN ${db(ids)}` : db``}
      ${f.kind ? db`AND a.kind = ${f.kind}` : db``}
      ${f.archived === undefined ? db`` : f.archived ? db`AND a.archived_at IS NOT NULL` : db`AND a.archived_at IS NULL`}
      ${like ? db`AND (a.name ILIKE ${like} OR EXISTS (SELECT 1 FROM unnest(a.tags) t WHERE t ILIKE ${like}))` : db``}
      ${f.beforeId ? db`AND a.id < ${f.beforeId}` : db``}
    ORDER BY a.id DESC ${f.limit ? db`LIMIT ${f.limit}` : db``}`;
  if (!rows.length) return [];
  const assetIds = rows.map((r) => Number(r.id));
  const latest = await db<VersionRow[]>`
    SELECT DISTINCT ON (v.asset_id) ${versionCols(db)} FROM design_asset_versions v JOIN staff s ON s.id = v.created_by
    WHERE v.asset_id IN ${db(assetIds)} ORDER BY v.asset_id, v.version_no DESC`;
  const byAsset = new Map(latest.map((v) => [Number(v.assetId), v]));
  const current = await currentSlots(db);
  const used = Object.entries(current).filter(([, v]) => v !== null) as [DesignSlot, number][];
  const usedVersions = used.length ? await db<{ id: number; assetId: number }[]>`SELECT id, asset_id FROM design_asset_versions WHERE id IN ${db(used.map(([, v]) => v))}` : [];
  const versionAsset = new Map(usedVersions.map((v) => [Number(v.id), Number(v.assetId)]));
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    name: r.name,
    tags: r.tags,
    note: r.note,
    archived: r.archivedAt !== null,
    latest: toVersion(byAsset.get(Number(r.id))!),
    versionCount: r.versionCount,
    usedBy: used.filter(([, v]) => versionAsset.get(v) === Number(r.id)).map(([slot, versionId]) => ({ slot, versionId })),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

async function assetDetail(db: Db, id: number): Promise<DesignAssetDetail> {
  const [a] = await assetsOf(db, [id]);
  if (!a) throw notFound('素材不存在');
  const versions = await db<VersionRow[]>`
    SELECT ${versionCols(db)} FROM design_asset_versions v JOIN staff s ON s.id = v.created_by WHERE v.asset_id = ${id} ORDER BY v.version_no DESC`;
  return { ...a, versions: versions.map(toVersion) };
}

async function slotStates(db: Db): Promise<DesignSlotState[]> {
  const hist = await db<
    {
      id: number;
      slot: string;
      versionId: number | null;
      assetId: number | null;
      assetName: string | null;
      versionNo: number | null;
      mime: string | null;
      reason: string;
      at: string;
      byName: string;
    }[]
  >`
    SELECT x.id, x.slot, x.version_id, v.asset_id, a.name AS asset_name, v.version_no, v.mime, x.reason, x.created_at AS at, s.display_name AS by_name
    FROM (SELECT *, row_number() OVER (PARTITION BY slot ORDER BY id DESC) AS rn FROM design_slot_assignments WHERE store_id = ${currentStoreId()}) x
    JOIN staff s ON s.id = x.staff_id
    LEFT JOIN design_asset_versions v ON v.id = x.version_id LEFT JOIN design_assets a ON a.id = v.asset_id
    WHERE x.rn <= 10 ORDER BY x.slot, x.id DESC`;
  const newest = await db<{ assetId: number; id: number }[]>`SELECT DISTINCT ON (asset_id) asset_id, id FROM design_asset_versions ORDER BY asset_id, version_no DESC`;
  const newestOf = new Map(newest.map((n) => [Number(n.assetId), Number(n.id)]));
  return DESIGN_SLOT_KEYS.map((slot) => {
    const rows = hist.filter((h) => h.slot === slot);
    const top = rows[0];
    const current =
      top && top.versionId !== null ? { versionId: Number(top.versionId), assetId: Number(top.assetId), assetName: top.assetName ?? '', versionNo: top.versionNo ?? 0, mime: top.mime ?? '' } : null;
    const newer = current ? (newestOf.get(current.assetId) ?? null) : null;
    return {
      slot,
      kind: DESIGN_SLOTS[slot].kind,
      label: DESIGN_SLOTS[slot].label,
      where: DESIGN_SLOTS[slot].where,
      current,
      changedAt: top?.at ?? null,
      changedByName: top?.byName ?? null,
      newerVersionId: current && newer !== null && newer !== current.versionId ? newer : null,
      history: rows.map((h) => ({
        id: Number(h.id),
        versionId: h.versionId === null ? null : Number(h.versionId),
        assetName: h.assetName,
        versionNo: h.versionNo,
        reason: h.reason,
        at: h.at,
        byName: h.byName,
      })),
    };
  });
}

/** 某个用途现在用的文件（各处用：平板菜单的品牌字体……）；没设为空 */
export async function slotFile(db: Db, slot: DesignSlot): Promise<{ versionId: number; mime: string; data: Buffer; sha256: string } | null> {
  const [row] = await db<{ versionId: number | null; mime: string | null; data: Buffer | null; sha256: string | null }[]>`
    SELECT x.version_id, v.mime, v.data, v.sha256 FROM design_slot_assignments x LEFT JOIN design_asset_versions v ON v.id = x.version_id
    WHERE x.store_id = ${currentStoreId()} AND x.slot = ${slot} ORDER BY x.id DESC LIMIT 1`;
  if (!row || row.versionId === null || !row.data) return null;
  return { versionId: Number(row.versionId), mime: row.mime!, data: row.data, sha256: row.sha256! };
}

// ───────────────────────── 写 ─────────────────────────

/** 上传占位：请求 id → 员工；全店同时最多 UPLOAD_SLOTS 个 */
const UPLOAD_SLOTS = 2;
const uploading = new Map<string, number>();

const UploadQuery = z.object({
  kind: z.enum(['font', 'image', 'video']),
  /** 新素材的名字；给 assetId 时是给这份素材加一版 */
  name: z.string().trim().max(60).optional(),
  assetId: z.coerce.number().int().positive().optional(),
  note: z.string().trim().max(500).optional(),
});

let quotaBytes = DESIGN_TOTAL_MAX_BYTES;
/** 只给用例：把总量上限调小，核对超限的拒绝（不用真的存 2GB） */
export function setDesignQuotaForTest(bytes: number | null) {
  quotaBytes = bytes ?? DESIGN_TOTAL_MAX_BYTES;
}

/** 存之前核对总量（素材库的总量咨询锁 design_quota：几次上传的核对与写入排队，不会两个一起钻过上限） */
async function assertQuota(tx: Tx, bytes: number) {
  await tx`SELECT pg_advisory_xact_lock(hashtext('design_quota'))`;
  const [row] = await tx<{ used: string }[]>`SELECT coalesce(sum(size_bytes), 0)::text AS used FROM design_asset_versions`;
  const used = Number(row!.used);
  if (used + bytes > quotaBytes) {
    throw new AppError(
      413,
      'DESIGN_QUOTA',
      `素材库已用 ${(used / 1024 / 1024).toFixed(0)}MB，再存这个就超过 ${(quotaBytes / 1024 / 1024 / 1024).toFixed(quotaBytes < 1024 ** 3 ? 3 : 0)}GB 的上限，请找店主处理`,
    );
  }
}

async function upload(deps: Deps, rawQuery: unknown, body: unknown, staffId: number, ip?: string): Promise<DesignAssetDetail> {
  const q = parse(UploadQuery, rawQuery ?? {});
  if (!Buffer.isBuffer(body)) throw badRequest('请直接上传文件内容（Content-Type: application/octet-stream）');
  const file = parseDesignFile(q.kind, body);
  if (q.kind === 'font' && q.assetId === undefined && !q.note) throw unprocessable('DESIGN_FONT_LICENSE', '字体请写授权说明（哪家的、授权范围），商业字体没有授权不要上传');
  const assetId = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 同一个文件的上传排队（Codex 审查）：按内容摘要取事务级咨询锁，查重与新建在同一把锁里——重传、两人同时传同一个文件都只建一份
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`design_sha:${file.sha256}`}))`;
    let id: number;
    if (q.assetId !== undefined) {
      const [a] = await tx<{ kind: DesignAssetKind; archivedAt: string | null }[]>`SELECT kind, archived_at FROM design_assets WHERE id = ${q.assetId} FOR UPDATE`;
      if (!a) throw notFound('素材不存在');
      if (a.kind !== q.kind) throw unprocessable('DESIGN_KIND_MISMATCH', `这份素材是${DESIGN_KIND_LABELS[a.kind]}，不能换成${DESIGN_KIND_LABELS[q.kind]}`);
      if (a.archivedAt) throw unprocessable('DESIGN_ARCHIVED', '素材已归档，先恢复再加新版');
      // 这份素材任何一版已经是这个文件：不另加一版（Codex 审查）。只比最新一版的话，A 传成功但没收到回复、别人接着传了 B，
      // 再重传 A 会多出一版、把 B 压下去；旧文件要再用，在「用途」里直接选那一版
      const [same] = await tx<{ id: number }[]>`SELECT id FROM design_asset_versions WHERE asset_id = ${q.assetId} AND sha256 = ${file.sha256} LIMIT 1`;
      if (same) return q.assetId;
      const [last] = await tx<{ versionNo: number }[]>`SELECT version_no FROM design_asset_versions WHERE asset_id = ${q.assetId} ORDER BY version_no DESC LIMIT 1`;
      id = q.assetId;
      await assertQuota(tx, file.bytes.length);
      await tx`
        INSERT INTO design_asset_versions (asset_id, version_no, sha256, mime, size_bytes, data, width, height, font_family, created_by)
        VALUES (${id}, ${(last?.versionNo ?? 0) + 1}, ${file.sha256}, ${file.mime}, ${file.bytes.length}, ${file.bytes}, ${file.width}, ${file.height}, ${file.fontFamily}, ${staffId})`;
      await tx`UPDATE design_assets SET updated_at = now() WHERE id = ${id}`;
    } else {
      // 同一个文件已经在库里（没归档）：给那一份，不重复建（上传超时后重传也不会多出一份）
      const [dup] = await tx<{ assetId: number }[]>`
        SELECT v.asset_id FROM design_asset_versions v JOIN design_assets a ON a.id = v.asset_id
        WHERE v.sha256 = ${file.sha256} AND a.kind = ${q.kind} AND a.archived_at IS NULL ORDER BY v.id DESC LIMIT 1`;
      if (dup) return Number(dup.assetId);
      await assertQuota(tx, file.bytes.length);
      const name = q.name || file.fontFamily || `${DESIGN_KIND_LABELS[q.kind]} ${new Date().toISOString().slice(0, 10)}`;
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO design_assets (kind, name, note, created_by) VALUES (${q.kind}, ${name.slice(0, 60)}, ${q.note ?? ''}, ${staffId}) RETURNING id`;
      id = Number(row!.id);
      await tx`
        INSERT INTO design_asset_versions (asset_id, version_no, sha256, mime, size_bytes, data, width, height, font_family, created_by)
        VALUES (${id}, 1, ${file.sha256}, ${file.mime}, ${file.bytes.length}, ${file.bytes}, ${file.width}, ${file.height}, ${file.fontFamily}, ${staffId})`;
    }
    await writeAudit(tx, {
      staffId,
      action: 'design_asset_upload',
      targetType: 'design_asset',
      targetId: id,
      detail: { kind: q.kind, mime: file.mime, bytes: file.bytes.length, sha256: file.sha256 },
      ip,
    });
    return id;
  });
  return assetDetail(deps.sql, assetId);
}

const EditInput = z.object({
  /** 页面看到的最后修改时间（Codex 审查）：之后改过就拒绝 ASSET_CHANGED，结果不确定的原请求晚到不会盖掉后来的修改 */
  expectedUpdatedAt: z.iso.datetime({ offset: true, message: '缺少页面看到的修改时间，请刷新后再改' }),
  name: z.string().trim().min(1, '请填写名字').max(60),
  tags: z.array(z.string().trim().min(1).max(20)).max(10).default([]),
  note: z.string().trim().max(500).default(''),
});

/**
 * 归档 / 恢复带「页面看到的这份素材的最后修改时间」（Codex 审查）：素材这一行在那之后改过（归档、恢复、改名、加版）就拒绝 ASSET_CHANGED。
 * 结果不确定（超时、服务器出错）时原请求只可能在原来的样子上生效一次：之后任何改动都让它作废，晚到的原请求不会盖掉后来的选择；
 * 页面查回这份素材，已经是想要的样子就算成了，不是就照现在的样子再选
 */
const ArchiveInput = z.object({ archived: z.boolean(), expectedUpdatedAt: z.iso.datetime({ offset: true, message: '缺少页面看到的修改时间，请刷新后再操作' }) });

async function setArchived(deps: Deps, id: number, raw: unknown, staffId: number, ip?: string) {
  const { archived, expectedUpdatedAt } = parse(ArchiveInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [a] = await tx<{ archivedAt: string | null; same: boolean }[]>`
      SELECT archived_at, date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ${expectedUpdatedAt}::timestamptz) AS same
      FROM design_assets WHERE id = ${id} FOR UPDATE`;
    if (!a) throw notFound('素材不存在');
    if (!a.same) throw conflict('ASSET_CHANGED', '这份素材刚被改过（归档、恢复、改名或加了新版），刷新后再看');
    if (archived) {
      // 素材全公司一份：哪家门店的用途用着都不能归档
      const used = await tx<{ slot: string; storeName: string }[]>`
        SELECT c.slot, st.name AS store_name
        FROM (SELECT DISTINCT ON (store_id, slot) store_id, slot, version_id FROM design_slot_assignments ORDER BY store_id, slot, id DESC) c
        JOIN design_asset_versions v ON v.id = c.version_id JOIN stores st ON st.id = c.store_id
        WHERE v.asset_id = ${id} ORDER BY c.store_id, c.slot`;
      if (used.length) {
        const slots = used.map((u) => `${u.storeName} · ${DESIGN_SLOTS[u.slot as DesignSlot]?.label ?? u.slot}`);
        throw conflict('DESIGN_IN_USE', `这份素材正用在用途上（${slots.join('、')}），先在「用途」里换掉再归档`);
      }
      await tx`UPDATE design_assets SET archived_at = now(), archived_by = ${staffId}, updated_at = now() WHERE id = ${id}`;
    } else {
      await tx`UPDATE design_assets SET archived_at = NULL, archived_by = NULL, updated_at = now() WHERE id = ${id}`;
    }
    await writeAudit(tx, { staffId, action: 'design_asset_archive', targetType: 'design_asset', targetId: id, detail: { archived }, ip });
  });
  return assetDetail(deps.sql, id);
}

const AssignInput = z.object({
  /** 换成哪一版；空 = 不用素材（照原来的样子） */
  versionId: z.number().int().positive().nullable(),
  /** 页面看到的现在用的那一版（空 = 没设）：别人先换过的拒绝 */
  fromVersionId: z.number().int().positive().nullable(),
  opKey: z.uuid('缺少操作编号'),
  reason: z.string().trim().max(200).default(''),
});

async function assign(deps: Deps, slotRaw: string, raw: unknown, staffId: number, ip?: string): Promise<{ slot: DesignSlotState; replayed: boolean }> {
  if (!(DESIGN_SLOT_KEYS as string[]).includes(slotRaw)) throw notFound('没有这个用途');
  const slot = slotRaw as DesignSlot;
  const input = parse(AssignInput, raw);
  let replayed = false;
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 同一个用途的切换排队（与原样重提的查找串行）
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`design_slot:${currentStoreId()}:${slot}`}))`;
      // 这个编号已经确认作废：原请求晚到也不换
      const [fenced] = await tx<{ opKey: string }[]>`SELECT op_key FROM design_assign_fences WHERE op_key = ${input.opKey}`;
      // 编号全公司唯一：别的门店用过的编号不给它的结果（查回、作废同样只看本店）
      if (fenced) throw conflict('OP_ABANDONED', '这一笔已经确认作废，没有换；要换请重新操作');
      const [done] = await tx<{ slot: string; versionId: number | null; storeId: number }[]>`SELECT slot, version_id, store_id FROM design_slot_assignments WHERE op_key = ${input.opKey}`;
      if (done) {
        if (Number(done.storeId) !== currentStoreId() || done.slot !== slot || (done.versionId === null ? null : Number(done.versionId)) !== input.versionId)
          throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一次切换');
        replayed = true;
        return;
      }
      const now = (await currentSlots(tx))[slot];
      if (now !== input.fromVersionId) throw conflict('SLOT_CHANGED', '这个用途刚被别人换过，请刷新后再看');
      if (input.versionId !== null) {
        const [v] = await tx<{ kind: DesignAssetKind; archivedAt: string | null }[]>`
          SELECT a.kind, a.archived_at FROM design_asset_versions v JOIN design_assets a ON a.id = v.asset_id WHERE v.id = ${input.versionId}
          FOR SHARE OF a`;
        // 锁住素材（共享锁，与归档的 FOR UPDATE 互斥，Codex 审查）：不会一边换上、一边被归档
        if (!v) throw notFound('素材版本不存在');
        if (v.kind !== DESIGN_SLOTS[slot].kind) throw unprocessable('DESIGN_KIND_MISMATCH', `「${DESIGN_SLOTS[slot].label}」只能用${DESIGN_KIND_LABELS[DESIGN_SLOTS[slot].kind]}`);
        if (v.archivedAt) throw unprocessable('DESIGN_ARCHIVED', '素材已归档，先恢复再用');
      }
      await tx`
        INSERT INTO design_slot_assignments (store_id, slot, version_id, op_key, reason, staff_id)
        VALUES (${currentStoreId()}, ${slot}, ${input.versionId}, ${input.opKey}, ${input.reason}, ${staffId})`;
      await writeAudit(tx, {
        staffId,
        action: 'design_slot_assign',
        targetType: 'design_slot',
        targetId: slot,
        detail: { storeId: currentStoreId(), from: input.fromVersionId, to: input.versionId, reason: input.reason },
        ip,
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error, 'design_slot_assignments_op_key_key')) throw error;
    replayed = true;
  }
  const state = (await slotStates(deps.sql)).find((s) => s.slot === slot)!;
  return { slot: state, replayed };
}

// ───────────────────────── 路由 ─────────────────────────

const ListQuery = z.object({
  kind: z.enum(['font', 'image', 'video']).optional(),
  archived: z.enum(['0', '1']).optional(),
  /** 按名字或标签搜 */
  q: z.string().trim().max(60).optional(),
  /** 翻页：只要编号比它小的（列表按编号从新到旧） */
  before: z.coerce.number().int().positive().optional(),
});

export function registerDesignRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 素材库与用途：设计师（工作台）、能改规则的店主店总
  const manage = guardAny('studio.edit', 'settings.manage');

  app.get('/api/design/assets', { preHandler: manage }, async (req) => {
    const q = parse(ListQuery, req.query ?? {});
    return assetsOf(sql, undefined, {
      kind: q.kind,
      archived: q.archived === undefined ? false : q.archived === '1',
      search: q.q || undefined,
      beforeId: q.before,
      limit: DESIGN_PAGE_SIZE,
    });
  });
  app.get('/api/design/assets/:id', { preHandler: manage }, async (req) => assetDetail(sql, parse(idParam, req.params).id));
  app.put('/api/design/assets/:id', { preHandler: manage }, async (req) => {
    const id = parse(idParam, req.params).id;
    const input = parse(EditInput, req.body);
    const { expectedUpdatedAt, ...change } = input;
    await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [a] = await tx<{ same: boolean }[]>`
        SELECT date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ${expectedUpdatedAt}::timestamptz) AS same FROM design_assets WHERE id = ${id} FOR UPDATE`;
      if (!a) throw notFound('素材不存在');
      if (!a.same) throw conflict('ASSET_CHANGED', '这份素材刚被改过（归档、恢复、改名或加了新版），刷新后再看');
      await tx`UPDATE design_assets SET name = ${change.name}, tags = ${change.tags}, note = ${change.note}, updated_at = now() WHERE id = ${id}`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'design_asset_edit', targetType: 'design_asset', targetId: id, detail: change, ip: req.ip });
    });
    return assetDetail(sql, id);
  });
  app.post('/api/design/assets/:id/archive', { preHandler: manage }, async (req) => setArchived(deps, parse(idParam, req.params).id, req.body, req.actor.id, req.ip));

  // 上传：直接传文件内容（视频几十 MB，不走 Base64）；种类、名字、给哪份素材加版放在查询参数里
  // 正文读进来之前（onRequest）先核对登录、权限、声明的大小与占位（Codex 安全审查，与办公附件同一个做法）：
  // 没权限的、超过这一种上限的不读正文直接拒绝；全店同时最多 2 个、同一个人同时 1 个，免得一堆 30MB 的请求同时进来把内存撑满
  const takeSlot = async (req: FastifyRequest, reply: FastifyReply) => {
    await manage.call(app, req, reply);
    const kind = (req.query as { kind?: string } | undefined)?.kind;
    const limit = kind === 'font' || kind === 'image' || kind === 'video' ? DESIGN_LIMITS[kind].maxBytes : null;
    if (limit === null) throw badRequest('请写明素材种类（kind=font / image / video）');
    const declared = Number(req.headers['content-length']);
    if (!Number.isFinite(declared) || declared <= 0) throw new AppError(411, 'LENGTH_REQUIRED', '上传要带文件大小');
    if (declared > limit) throw new AppError(413, 'DESIGN_TOO_LARGE', `${DESIGN_KIND_LABELS[kind as DesignAssetKind]}单个不能超过 ${limit / 1024 / 1024}MB`);
    const mine = [...uploading.values()].includes(req.actor.id);
    if (mine || uploading.size >= UPLOAD_SLOTS) throw new AppError(429, 'DESIGN_UPLOAD_BUSY', '正在上传的文件太多，等上一个传完再试');
    uploading.set(req.id, req.actor.id);
  };
  const releaseSlot = async (req: FastifyRequest) => {
    uploading.delete(req.id);
  };
  app.register(async (sub) => {
    sub.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: DESIGN_LIMITS.video.maxBytes + 1024 }, (_req, body, done) => done(null, body));
    sub.post('/api/design/upload', { onRequest: takeSlot, onResponse: releaseSlot, onRequestAbort: releaseSlot, bodyLimit: DESIGN_LIMITS.video.maxBytes + 1024 }, async (req, reply) => {
      const r = await upload(deps, req.query, req.body, req.actor.id, req.ip);
      reply.code(201);
      return r;
    });
  });

  app.get('/api/design/slots', { preHandler: manage }, async () => slotStates(sql));
  app.post('/api/design/slots/:slot/assign', { preHandler: manage }, async (req) => {
    const { slot } = parse(z.object({ slot: z.string().max(60) }), req.params);
    return assign(deps, slot, req.body, req.actor.id, req.ip);
  });

  // 切换结果不确定时：按操作编号查回（只读；查不到不等于没生效）与确认作废（在用途锁里：已经换了的给结果，没换的登记作废）
  const OpKeyParam = z.object({ key: z.uuid('操作编号格式不正确') });
  app.get('/api/design/ops/:key', { preHandler: manage }, async (req) => {
    const { key } = parse(OpKeyParam, req.params);
    const [done] = await sql<{ slot: string }[]>`SELECT slot FROM design_slot_assignments WHERE op_key = ${key} AND store_id = ${currentStoreId()}`;
    const [fenced] = await sql<{ slot: string }[]>`SELECT slot FROM design_assign_fences WHERE op_key = ${key} AND store_id = ${currentStoreId()}`;
    return { found: !!done, abandoned: !!fenced };
  });
  app.post('/api/design/ops/:key/abandon', { preHandler: manage }, async (req) => {
    const { key } = parse(OpKeyParam, req.params);
    const { slot } = parse(z.object({ slot: z.enum(DESIGN_SLOT_KEYS as [DesignSlot, ...DesignSlot[]]) }), req.body);
    return sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`design_slot:${currentStoreId()}:${slot}`}))`;
      const [done] = await tx<{ storeId: number }[]>`SELECT store_id FROM design_slot_assignments WHERE op_key = ${key}`;
      if (done && Number(done.storeId) !== currentStoreId()) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一家门店的切换');
      if (done) return { found: true, abandoned: false };
      await tx`INSERT INTO design_assign_fences (op_key, store_id, slot, staff_id) VALUES (${key}, ${currentStoreId()}, ${slot}, ${req.actor.id}) ON CONFLICT (op_key) DO NOTHING`;
      return { found: false, abandoned: true };
    });
  });

  // 各处读「现在用哪一版」与文件：登录了就能看（门户横幅、大屏视频、平板字体都要）；文件按版本号长期缓存（版本只追加、内容不变）
  app.get('/api/design/current', { preHandler: sessionOnly }, async () => currentSlots(sql));
  app.get('/api/design/files/:id', { preHandler: sessionOnly }, async (req, reply) => {
    const id = parse(idParam, req.params).id;
    const [v] = await sql<{ mime: string; data: Buffer }[]>`SELECT mime, data FROM design_asset_versions WHERE id = ${id}`;
    if (!v) throw notFound('文件不存在');
    for (const [k, val] of Object.entries(assetHeaders(v.mime))) reply.header(k, val);
    return reply.send(v.data);
  });
}
