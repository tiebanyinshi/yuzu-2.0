// 员工培训第一期（店主 2026-11-25，docs/TRAINING.md、PENDING_DECISIONS PC37）：
//   · 文件夹：「培训资料」（公共）+ 每个部门一个；有「员工培训管理」的可新建部门文件夹、改名、排序、停用；
//   · 谁能看：所有员工看「培训资料」、自己岗位所在部门的文件夹、自己新建（不对应部门）的部门文件夹；有管理权限的看全部；
//   · 上传：分块（每块 base64 约 4 MB），开始时登记摘要与大小，传完「完成」时核对摘要与文件头，登记成新文件或某份文件的新版本；
//     开始与完成都带操作编号：没收到结果时原样重提，返回原来那一份；
//   · 内容按 SHA-256 只存一份（4 MB 一块存数据库），读的时候支持 Range（视频拖动、PDF 按需读）；
//   · 版本只追加，换新版本不清「看过」；谁看过每人每份文件一行。

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can } from '@shared/permissions';
import {
  TRAINING_CHUNK_BYTES,
  TRAINING_FORMATS,
  TRAINING_MAX_BYTES,
  TRAINING_MAX_CHUNKS,
  trainingViewKind,
  type TrainingFile,
  type TrainingFileDetail,
  type TrainingFileVersion,
  type TrainingFolder,
  type TrainingFolderList,
  type TrainingSheetBook,
} from '@shared/training';
import type { Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Actor, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { hashRequest } from '../lib/idempotency';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { readXlsx, XlsxReadError } from '../lib/xlsx-read';

const MANAGE = 'training.manage' as const;
/** 时间列读出来是字符串（库的类型解析），统一成 ISO */
const iso = (d: Date | string) => new Date(d).toISOString();

// ───────────────────────── 谁能看 ─────────────────────────

/** 我岗位所在的部门 */
async function myDepartment(db: Db, actor: Actor): Promise<string | null> {
  const [row] = await db<{ department: string }[]>`
    SELECT pc.department FROM staff s JOIN position_catalog pc ON pc.key = s.position WHERE s.id = ${actor.id}`;
  return row?.department ?? null;
}

interface FolderRow {
  id: number;
  name: string;
  kind: 'public' | 'department';
  departmentKey: string | null;
  sort: number;
  active: boolean;
  version: number;
}

/** 这个文件夹我看不看得到（停用的只有管理权限看得到） */
function visible(folder: FolderRow, actor: Actor, dept: string | null): boolean {
  if (can(actor, MANAGE)) return true;
  if (!folder.active) return false;
  return folder.kind === 'public' || folder.departmentKey === null || folder.departmentKey === dept;
}

async function loadFolder(db: Db, id: number): Promise<FolderRow> {
  const [f] = await db<FolderRow[]>`SELECT id, name, kind, department_key, sort, active, version FROM training_folders WHERE id = ${id}`;
  if (!f) throw notFound('文件夹不存在');
  return f;
}

async function assertFolderVisible(db: Db, actor: Actor, id: number) {
  const folder = await loadFolder(db, id);
  if (!visible(folder, actor, await myDepartment(db, actor))) throw forbidden('这个文件夹不是你部门的，看不到');
  return folder;
}

// ───────────────────────── 读 ─────────────────────────

async function listFolders(db: Db, actor: Actor): Promise<TrainingFolderList> {
  const dept = await myDepartment(db, actor);
  const rows = await db<(FolderRow & { fileCount: number })[]>`
    SELECT f.id, f.name, f.kind, f.department_key, f.sort, f.active, f.version,
           (SELECT count(*)::int FROM training_files t WHERE t.folder_id = f.id AND t.active) AS file_count
    FROM training_folders f ORDER BY f.kind = 'public' DESC, f.sort, f.id`;
  const folders: TrainingFolder[] = rows.filter((f) => visible(f, actor, dept)).map((f) => ({ ...f, fileCount: Number(f.fileCount) }));
  return { folders, myDepartment: dept, canManage: can(actor, MANAGE) };
}

const VERSION_SELECT = (db: Db) => db`
  v.id, v.version_no, v.file_name, v.mime, v.size_bytes, v.note, v.created_at, s.display_name AS uploaded_by_name`;

type VersionRow = { id: number; versionNo: number; fileName: string; mime: string; sizeBytes: string | number; note: string; createdAt: Date | string; uploadedByName: string };
const toVersion = (v: VersionRow): TrainingFileVersion => ({
  id: Number(v.id),
  versionNo: v.versionNo,
  fileName: v.fileName,
  mime: v.mime,
  sizeBytes: Number(v.sizeBytes),
  note: v.note,
  uploadedByName: v.uploadedByName,
  createdAt: iso(v.createdAt),
});

async function listFiles(db: Db, actor: Actor, folderId: number, onlyId?: number): Promise<TrainingFile[]> {
  const manage = can(actor, MANAGE);
  const rows = await db<
    (VersionRow & {
      fileId: number;
      folderId: number;
      title: string;
      description: string;
      active: boolean;
      sort: number;
      fileVersion: number;
      updatedAt: Date | string;
      myLast: Date | string | null;
      viewers: number;
    })[]
  >`
    SELECT t.id AS file_id, t.folder_id, t.title, t.description, t.active, t.sort, t.version AS file_version, t.updated_at,
           ${VERSION_SELECT(db)},
           (SELECT last_viewed_at FROM training_views w WHERE w.file_id = t.id AND w.staff_id = ${actor.id}) AS my_last,
           (SELECT count(*)::int FROM training_views w WHERE w.file_id = t.id) AS viewers
    FROM training_files t
    JOIN training_file_versions v ON v.id = t.current_version_id
    JOIN staff s ON s.id = v.uploaded_by
    WHERE t.folder_id = ${folderId} ${onlyId ? db`AND t.id = ${onlyId}` : db``} ${manage ? db`` : db`AND t.active`}
    ORDER BY t.sort, t.id`;
  return rows.map((r) => ({
    id: Number(r.fileId),
    folderId: Number(r.folderId),
    title: r.title,
    description: r.description,
    active: r.active,
    sort: r.sort,
    version: r.fileVersion,
    current: toVersion(r),
    viewKind: trainingViewKind(r.mime),
    myLastViewedAt: r.myLast ? iso(r.myLast) : null,
    ...(manage ? { viewerCount: Number(r.viewers) } : {}),
    updatedAt: iso(r.updatedAt),
  }));
}

async function loadFile(db: Db, id: number) {
  const [f] = await db<{ id: number; folderId: number; active: boolean; currentVersionId: number }[]>`
    SELECT id, folder_id, active, current_version_id FROM training_files WHERE id = ${id}`;
  if (!f) throw notFound('培训文件不存在');
  return f;
}

/** 看得到这份文件（文件夹看得到；下架的只有管理权限看得到） */
async function assertFileVisible(db: Db, actor: Actor, id: number) {
  const f = await loadFile(db, id);
  await assertFolderVisible(db, actor, f.folderId);
  if (!f.active && !can(actor, MANAGE)) throw notFound('这份培训文件已下架');
  return f;
}

async function fileDetail(db: Db, actor: Actor, id: number): Promise<TrainingFileDetail> {
  const f = await loadFile(db, id);
  const [file] = await listFiles(db, actor, f.folderId, id);
  const versions = await db<VersionRow[]>`
    SELECT ${VERSION_SELECT(db)} FROM training_file_versions v JOIN staff s ON s.id = v.uploaded_by WHERE v.file_id = ${id} ORDER BY v.version_no DESC`;
  const viewers = await db<{ staffId: number; name: string; department: string | null; firstViewedAt: Date | string; lastViewedAt: Date | string; viewCount: number; versionNo: number | null }[]>`
    SELECT w.staff_id, s.display_name AS name, d.name AS department, w.first_viewed_at, w.last_viewed_at, w.view_count, v.version_no
    FROM training_views w
    JOIN staff s ON s.id = w.staff_id
    LEFT JOIN position_catalog pc ON pc.key = s.position
    LEFT JOIN org_departments d ON d.key = pc.department
    LEFT JOIN training_file_versions v ON v.id = w.last_version_id
    WHERE w.file_id = ${id}
    ORDER BY w.last_viewed_at DESC`;
  return {
    file: file!,
    versions: versions.map(toVersion),
    viewers: viewers.map((v) => ({
      staffId: Number(v.staffId),
      name: v.name,
      department: v.department,
      firstViewedAt: iso(v.firstViewedAt),
      lastViewedAt: iso(v.lastViewedAt),
      viewCount: v.viewCount,
      versionNo: v.versionNo,
    })),
  };
}

// ───────────────────────── 文件夹 ─────────────────────────

const FolderName = z.string().trim().min(1, '请填写文件夹名称').max(40, '文件夹名称最多 40 个字');

const CreateFolderInput = z.object({
  name: FolderName,
  /** 对应的部门（org_departments 里的）；不选 = 自己新建的部门，所有员工都看得到 */
  departmentKey: z.string().trim().min(1).max(40).nullable().default(null),
  sort: z.number().int().min(0).max(9999).default(100),
});

const UpdateFolderInput = z.object({
  name: FolderName,
  sort: z.number().int().min(0).max(9999),
  active: z.boolean(),
  /** 页面看到的版本号：别人先改过就拒绝 */
  version: z.number().int().positive(),
});

const nameTaken = (e: unknown, name: string) => ((e as { code?: string; constraint_name?: string }).code === '23505' ? conflict('TRAINING_FOLDER_TAKEN', `已经有叫「${name}」的文件夹，换个名字`) : e);

async function createFolder(deps: Deps, raw: unknown, ctx: OpContext) {
  const input = parse(CreateFolderInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    if (input.departmentKey) {
      const [d] = await tx`SELECT 1 FROM org_departments WHERE key = ${input.departmentKey}`;
      if (!d) throw unprocessable('TRAINING_DEPARTMENT', '没有这个部门');
      const [has] = await tx<{ name: string }[]>`SELECT name FROM training_folders WHERE department_key = ${input.departmentKey}`;
      if (has) throw conflict('TRAINING_FOLDER_TAKEN', `这个部门已经有文件夹「${has.name}」`);
    }
    let id: number;
    try {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO training_folders (name, kind, department_key, sort, created_by)
        VALUES (${input.name}, 'department', ${input.departmentKey}, ${input.sort}, ${ctx.actor.id}) RETURNING id`;
      id = Number(row!.id);
    } catch (e) {
      throw nameTaken(e, input.name);
    }
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'training_folder_saved', targetType: 'training_folder', targetId: id, detail: { summary: `新建了培训文件夹「${input.name}」` }, ip: ctx.ip });
    return loadFolder(tx, id);
  });
}

async function updateFolder(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(UpdateFolderInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [f] = await tx<FolderRow[]>`SELECT id, name, kind, department_key, sort, active, version FROM training_folders WHERE id = ${id} FOR UPDATE`;
    if (!f) throw notFound('文件夹不存在');
    if (f.version !== input.version) throw conflict('TRAINING_FOLDER_CHANGED', '这个文件夹刚被别人改过，请刷新后再改');
    if (f.kind === 'public' && !input.active) throw unprocessable('TRAINING_FOLDER_PUBLIC', '「培训资料」是全员共用的文件夹，不能停用');
    try {
      await tx`UPDATE training_folders SET name = ${input.name}, sort = ${input.sort}, active = ${input.active}, version = version + 1, updated_at = now() WHERE id = ${id}`;
    } catch (e) {
      throw nameTaken(e, input.name);
    }
    const changes = [f.name !== input.name && `改名为「${input.name}」`, f.active !== input.active && (input.active ? '启用' : '停用'), f.sort !== input.sort && `排序 ${input.sort}`].filter(Boolean);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'training_folder_saved',
      targetType: 'training_folder',
      targetId: id,
      detail: { summary: `培训文件夹「${f.name}」${changes.join('、') || '没有改动'}` },
      ip: ctx.ip,
    });
    return loadFolder(tx, id);
  });
}

// ───────────────────────── 上传 ─────────────────────────

const FileName = z
  .string()
  .trim()
  .min(1, '缺少文件名')
  .max(200, '文件名最多 200 个字')
  .refine((n) => !/[\\/\u0000-\u001f]/.test(n), '文件名不能带路径或控制字符');

const StartUploadInput = z
  .object({
    clientKey: z.uuid('操作编号格式不正确'),
    fileName: FileName,
    mime: z.string().refine((m) => m in TRAINING_FORMATS, '只能上传 PDF、图片、视频、音频、Excel、PPT、Word'),
    sizeBytes: z
      .number()
      .int()
      .min(1, '文件是空的')
      .max(TRAINING_MAX_BYTES, `一份文件最大 ${TRAINING_MAX_BYTES / 1024 / 1024} MB，视频请先压成 720p 的 MP4`),
    /**
     * 文件内容指纹（页面对整份文件算的，内网 HTTP 下算不了 SHA-256）：算进操作编号的原请求里，
     * 接着传时选了同名、同大小但内容不同的文件会被拒绝，不会拿新文件的块拼在旧文件的块后面（Codex 审查 57dd2f6）
     */
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{16}$/, '文件指纹格式不正确')
      .optional(),
  })
  .refine((v) => TRAINING_FORMATS[v.mime]!.ext.includes(v.fileName.toLowerCase().split('.').pop() ?? ''), '文件扩展名与类型对不上');

const chunkCountOf = (size: number) => Math.ceil(size / TRAINING_CHUNK_BYTES);

/** 开始上传：同一个编号重提返回原来那一次（含已传了哪几块） */
async function startUpload(deps: Deps, raw: unknown, ctx: OpContext) {
  const input = parse(StartUploadInput, raw);
  const chunkCount = chunkCountOf(input.sizeBytes);
  if (chunkCount > TRAINING_MAX_CHUNKS) throw badRequest('文件太大');
  const requestHash = hashRequest({ op: 'training_upload', ...input, clientKey: undefined });
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 24 小时前开始、一直没传完的作废（连带传了一半的块）
    await tx`DELETE FROM training_uploads WHERE status = 'open' AND created_at < now() - interval '24 hours'`;
    const [seen] = await tx<{ id: number; requestHash: string; createdBy: number }[]>`
      SELECT id, request_hash, created_by FROM training_uploads WHERE client_key = ${input.clientKey}`;
    let id: number;
    if (seen) {
      if (seen.requestHash !== requestHash || Number(seen.createdBy) !== ctx.actor.id) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次上传，请刷新页面后重新选文件');
      id = Number(seen.id);
    } else {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO training_uploads (client_key, size_bytes, chunk_count, file_name, mime, request_hash, created_by)
        VALUES (${input.clientKey}, ${input.sizeBytes}, ${chunkCount}, ${input.fileName}, ${input.mime}, ${requestHash}, ${ctx.actor.id})
        RETURNING id`;
      id = Number(row!.id);
    }
    return uploadState(tx, id);
  });
}

async function uploadState(db: Db, id: number) {
  const [u] = await db<{ id: number; chunkCount: number; status: string; resultFileId: number | null; resultVersionId: number | null }[]>`
    SELECT id, chunk_count, status, result_file_id, result_version_id FROM training_uploads WHERE id = ${id}`;
  if (!u) throw notFound('上传记录不存在（超过 24 小时没传完的已作废），请重新选文件');
  const received = (await db<{ seq: number }[]>`SELECT seq FROM training_upload_chunks WHERE upload_id = ${id} ORDER BY seq`).map((r) => r.seq);
  return {
    uploadId: Number(u.id),
    chunkCount: u.chunkCount,
    chunkBytes: TRAINING_CHUNK_BYTES,
    /** 已经传到服务器的块（断了以后接着传，跳过这些） */
    received,
    /** cancelled：管理员确认不传了，这个编号不能再传 */
    status: u.status as 'open' | 'done' | 'cancelled',
    fileId: u.resultFileId === null ? null : Number(u.resultFileId),
    versionId: u.resultVersionId === null ? null : Number(u.resultVersionId),
  };
}

/**
 * 不传了（服务端作废登记）：用原编号、原参数。锁住这次上传的行（与「完成」互斥）：
 * 已经登记好的原样返回 done（不能作废）；还没完成的标 cancelled、丢掉传了一半的块；服务端还没见过这个编号的，登记一行 cancelled 占住编号，
 * 之后原请求再到也开始不了、完成不了。返回作废以后的状态，页面见到 cancelled 或 done 才删本机记录（Codex 审查 57dd2f6）。
 */
async function cancelUpload(deps: Deps, raw: unknown, ctx: OpContext) {
  const input = parse(StartUploadInput, raw);
  const chunkCount = chunkCountOf(input.sizeBytes);
  if (chunkCount > TRAINING_MAX_CHUNKS) throw badRequest('文件太大');
  const requestHash = hashRequest({ op: 'training_upload', ...input, clientKey: undefined });
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 编号唯一：先占住（已有的不动），再锁那一行
    await tx`
      INSERT INTO training_uploads (client_key, size_bytes, chunk_count, file_name, mime, request_hash, created_by, status, finished_at)
      VALUES (${input.clientKey}, ${input.sizeBytes}, ${chunkCount}, ${input.fileName}, ${input.mime}, ${requestHash}, ${ctx.actor.id}, 'cancelled', now())
      ON CONFLICT (client_key) DO NOTHING`;
    const [u] = await tx<{ id: number; requestHash: string; createdBy: number; status: string }[]>`
      SELECT id, request_hash, created_by, status FROM training_uploads WHERE client_key = ${input.clientKey} FOR UPDATE`;
    if (!u) throw notFound('上传记录不存在');
    if (u.requestHash !== requestHash || Number(u.createdBy) !== ctx.actor.id) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次上传');
    if (u.status === 'open') {
      await tx`UPDATE training_uploads SET status = 'cancelled', finished_at = now() WHERE id = ${u.id}`;
      await tx`DELETE FROM training_upload_chunks WHERE upload_id = ${u.id}`;
    }
    return uploadState(tx, Number(u.id));
  });
}

async function ownUpload(db: Db, id: number, actor: Actor) {
  const [u] = await db<{ id: number; createdBy: number; status: string; chunkCount: number; sizeBytes: string | number; fileName: string; mime: string }[]>`
    SELECT id, created_by, status, chunk_count, size_bytes, file_name, mime FROM training_uploads WHERE id = ${id}`;
  if (!u) throw notFound('上传记录不存在（超过 24 小时没传完的已作废），请重新选文件');
  if (Number(u.createdBy) !== actor.id) throw forbidden('只能接着传自己开始的上传');
  return { ...u, sizeBytes: Number(u.sizeBytes) };
}

const ChunkParams = z.object({
  id: z.coerce.number().int().positive(),
  seq: z.coerce
    .number()
    .int()
    .min(0)
    .max(TRAINING_MAX_CHUNKS - 1),
});
const ChunkInput = z.object({
  data: z
    .string()
    .min(1)
    .max(Math.ceil((TRAINING_CHUNK_BYTES * 4) / 3) + 8),
});

/** 传一块：同一块重传不覆盖（已经有了就算成功） */
async function putChunk(deps: Deps, params: unknown, raw: unknown, actor: Actor) {
  const { id, seq } = parse(ChunkParams, params);
  const { data } = parse(ChunkInput, raw);
  const u = await ownUpload(deps.sql, id, actor);
  if (u.status === 'done') return { ok: true };
  if (u.status === 'cancelled') throw conflict('TRAINING_UPLOAD_CANCELLED', '这次上传已经确认不传了，请重新选文件');
  if (seq >= u.chunkCount) throw badRequest('块号超出范围');
  const bytes = Buffer.from(data, 'base64');
  const expected = seq === u.chunkCount - 1 ? u.sizeBytes - TRAINING_CHUNK_BYTES * (u.chunkCount - 1) : TRAINING_CHUNK_BYTES;
  if (bytes.length !== expected) throw badRequest(`第 ${seq + 1} 块大小不对（应为 ${expected} 字节，收到 ${bytes.length}）`);
  await deps.sql`INSERT INTO training_upload_chunks (upload_id, seq, data) VALUES (${id}, ${seq}, ${bytes}) ON CONFLICT DO NOTHING`;
  return { ok: true };
}

/** 文件头核对：与声明的类型对得上（Office 新格式是 zip，旧格式是复合文档；视频按 ftyp / EBML 认） */
function sniffOk(mime: string, head: Buffer): boolean {
  const ascii = (a: number, b: number) => head.subarray(a, b).toString('latin1');
  const zip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const cfb = head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  switch (mime) {
    case 'application/pdf':
      return ascii(0, 5) === '%PDF-';
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/png':
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'image/gif':
      return ascii(0, 4) === 'GIF8';
    case 'video/mp4':
    case 'video/quicktime':
    case 'audio/mp4':
      return ascii(4, 8) === 'ftyp' || ascii(4, 8) === 'moov' || ascii(4, 8) === 'wide' || ascii(4, 8) === 'mdat';
    case 'video/webm':
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    case 'audio/mpeg':
      return ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0);
    case 'application/vnd.ms-excel':
    case 'application/vnd.ms-powerpoint':
    case 'application/msword':
      return cfb;
    default:
      return zip;
  }
}

const ViewedInput = z.object({ versionId: z.number().int().positive().optional() });

const CompleteInput = z
  .object({
    /** 新文件放哪个文件夹（与 fileId 二选一） */
    folderId: z.number().int().positive().nullable().default(null),
    /** 给哪份文件换新版本 */
    fileId: z.number().int().positive().nullable().default(null),
    title: z.string().trim().max(80, '标题最多 80 个字').default(''),
    description: z.string().trim().max(500, '说明最多 500 个字').default(''),
    note: z.string().trim().max(200, '版本说明最多 200 个字').default(''),
  })
  .refine((v) => (v.folderId === null) !== (v.fileId === null), '选文件夹（新文件）或选文件（换新版本），二选一');

/**
 * 完成：核对块齐不齐与文件头、按块算摘要（在事务外读块算，块写进去以后不会再变），再在事务里登记内容（同样的内容只存一份）、文件与版本。
 * 原样重提：已完成的返回原来那份。
 */
async function completeUpload(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(CompleteInput, raw);
  const u = await ownUpload(deps.sql, id, ctx.actor);
  if (u.status === 'done') return finished(deps.sql, id);
  if (u.status === 'cancelled') throw conflict('TRAINING_UPLOAD_CANCELLED', '这次上传已经确认不传了，请重新选文件');
  const seqs = (await deps.sql<{ seq: number }[]>`SELECT seq FROM training_upload_chunks WHERE upload_id = ${id} ORDER BY seq`).map((r) => r.seq);
  const missing = Array.from({ length: u.chunkCount }, (_, i) => i).filter((i) => !seqs.includes(i));
  if (missing.length) throw unprocessable('TRAINING_UPLOAD_INCOMPLETE', `还有 ${missing.length} 块没传完`, { missing });
  const hash = createHash('sha256');
  let head: Buffer | null = null;
  for (let seq = 0; seq < u.chunkCount; seq++) {
    const [c] = await deps.sql<{ data: Buffer }[]>`SELECT data FROM training_upload_chunks WHERE upload_id = ${id} AND seq = ${seq}`;
    if (seq === 0) head = c!.data.subarray(0, 16);
    hash.update(c!.data);
  }
  const sha256 = hash.digest('hex');
  if (!sniffOk(u.mime, head!)) throw unprocessable('TRAINING_UPLOAD_FORMAT', `文件内容不是 ${TRAINING_FORMATS[u.mime]!.label}，请确认选对了文件`);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [lock] = await tx<{ status: string }[]>`SELECT status FROM training_uploads WHERE id = ${id} FOR UPDATE`;
    if (!lock) throw notFound('上传记录不存在，请重新选文件');
    if (lock.status === 'done') return finished(tx, id);
    // 「不传了」与「完成」都先锁这一行：先作废的，完成就拒绝（Codex 审查 57dd2f6）
    if (lock.status === 'cancelled') throw conflict('TRAINING_UPLOAD_CANCELLED', '这次上传已经确认不传了，请重新选文件');
    // 内容只存一份：别人刚好也传了同一个文件就沿用
    const [stored] = await tx<{ sha256: string }[]>`
      INSERT INTO training_blobs (sha256, size_bytes, chunk_count) VALUES (${sha256}, ${u.sizeBytes}, ${u.chunkCount})
      ON CONFLICT (sha256) DO NOTHING RETURNING sha256`;
    if (stored) {
      await tx`INSERT INTO training_blob_chunks (sha256, seq, data) SELECT ${sha256}, seq, data FROM training_upload_chunks WHERE upload_id = ${id} ORDER BY seq`;
    }
    await tx`DELETE FROM training_upload_chunks WHERE upload_id = ${id}`;
    let fileId: number;
    let versionNo: number;
    let summary: string;
    if (input.fileId !== null) {
      const [f] = await tx<{ id: number; title: string }[]>`SELECT id, title FROM training_files WHERE id = ${input.fileId} FOR UPDATE`;
      if (!f) throw notFound('要换新版本的培训文件不存在');
      fileId = Number(f.id);
      const [n] = await tx<{ n: number }[]>`SELECT COALESCE(max(version_no), 0)::int + 1 AS n FROM training_file_versions WHERE file_id = ${fileId}`;
      versionNo = n!.n;
      summary = `「${f.title}」换成第 ${versionNo} 版（${u.fileName}）`;
    } else {
      await loadFolder(tx, input.folderId!);
      const title = input.title || u.fileName.replace(/\.[^.]+$/, '');
      const [f] = await tx<{ id: number }[]>`
        INSERT INTO training_files (folder_id, title, description, created_by)
        VALUES (${input.folderId}, ${title.slice(0, 80)}, ${input.description}, ${ctx.actor.id}) RETURNING id`;
      fileId = Number(f!.id);
      versionNo = 1;
      summary = `上传了培训文件「${title}」`;
    }
    const [v] = await tx<{ id: number }[]>`
      INSERT INTO training_file_versions (file_id, version_no, file_name, mime, sha256, size_bytes, note, uploaded_by)
      VALUES (${fileId}, ${versionNo}, ${u.fileName}, ${u.mime}, ${sha256}, ${u.sizeBytes}, ${input.note}, ${ctx.actor.id}) RETURNING id`;
    await tx`UPDATE training_files SET current_version_id = ${v!.id}, version = version + 1, updated_at = now() WHERE id = ${fileId}`;
    await tx`UPDATE training_uploads SET status = 'done', result_file_id = ${fileId}, result_version_id = ${v!.id}, finished_at = now() WHERE id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'training_file_saved', targetType: 'training_file', targetId: fileId, detail: { summary, versionNo, sha256: sha256 }, ip: ctx.ip });
    return finished(tx, id);
  });
}

async function finished(db: Db, id: number) {
  const [u] = await db<{ fileId: number; versionId: number }[]>`SELECT result_file_id AS file_id, result_version_id AS version_id FROM training_uploads WHERE id = ${id}`;
  return { fileId: Number(u!.fileId), versionId: Number(u!.versionId) };
}

// ───────────────────────── 改文件 ─────────────────────────

const UpdateFileInput = z.object({
  title: z.string().trim().min(1, '请填写标题').max(80, '标题最多 80 个字'),
  description: z.string().trim().max(500, '说明最多 500 个字'),
  folderId: z.number().int().positive(),
  active: z.boolean(),
  sort: z.number().int().min(0).max(9999),
  version: z.number().int().positive(),
});

async function updateFile(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(UpdateFileInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [f] = await tx<{ title: string; folderId: number; active: boolean; version: number }[]>`
      SELECT title, folder_id, active, version FROM training_files WHERE id = ${id} FOR UPDATE`;
    if (!f) throw notFound('培训文件不存在');
    if (f.version !== input.version) throw conflict('TRAINING_FILE_CHANGED', '这份文件刚被别人改过，请刷新后再改');
    const folder = await loadFolder(tx, input.folderId);
    await tx`
      UPDATE training_files SET title = ${input.title}, description = ${input.description}, folder_id = ${input.folderId},
             active = ${input.active}, sort = ${input.sort}, version = version + 1, updated_at = now()
      WHERE id = ${id}`;
    const changes = [
      f.title !== input.title && `改名为「${input.title}」`,
      Number(f.folderId) !== input.folderId && `移到「${folder.name}」`,
      f.active !== input.active && (input.active ? '重新上架' : '下架'),
    ].filter(Boolean);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'training_file_saved',
      targetType: 'training_file',
      targetId: id,
      detail: { summary: `培训文件「${f.title}」${changes.join('、') || '改了说明或排序'}` },
      ip: ctx.ip,
    });
  });
  return fileDetail(deps.sql, ctx.actor, id);
}

// ───────────────────────── 读内容 ─────────────────────────

const ContentQuery = z.object({ v: z.coerce.number().int().positive().optional(), download: z.enum(['1']).optional() });
/** 页面里直接显示的类型；其余一律当附件下载 */
const INLINE = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/mp4']);

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

/** 按块读出 [start, end]（每块只取需要的那一段） */
function streamBlob(db: Db, sha256: string, start: number, end: number): Readable {
  const first = Math.floor(start / TRAINING_CHUNK_BYTES);
  const last = Math.floor(end / TRAINING_CHUNK_BYTES);
  async function* chunks() {
    for (let seq = first; seq <= last; seq++) {
      const base = seq * TRAINING_CHUNK_BYTES;
      const from = Math.max(start, base) - base;
      const to = Math.min(end, base + TRAINING_CHUNK_BYTES - 1) - base;
      const [c] = await db<{ part: Buffer }[]>`
        SELECT substring(data FROM ${from + 1} FOR ${to - from + 1}) AS part FROM training_blob_chunks WHERE sha256 = ${sha256} AND seq = ${seq}`;
      if (!c) throw new Error(`培训文件内容缺块 ${sha256}#${seq}`);
      yield c.part;
    }
  }
  return Readable.from(chunks());
}

/** Excel 在页面里看：服务端读成表格（每张表最多 500 行、40 列；文件超过 20 MB 不在页面里显示，下载看） */
const SHEET_MAX_BYTES = 20 * 1024 * 1024;
const SHEET_MAX_ROWS = 500;
const SHEET_MAX_COLS = 40;
/**
 * 防撑爆（Codex 安全审查 57dd2f6）：解压后整份最多 8 MB（工作表、共享字符串都算）、最多读 20 张表、
 * 每格最多 2000 个字、整份预览最多 200 万个字（超了后面的格子留空、标「表格太大」）
 */
const SHEET_MAX_UNZIPPED = 8 * 1024 * 1024;
const SHEET_MAX_SHEETS = 20;
const SHEET_MAX_CELL_CHARS = 2000;
const SHEET_MAX_TOTAL_CHARS = 2_000_000;

async function readBlob(db: Db, sha256: string): Promise<Buffer> {
  const parts = await db<{ data: Buffer }[]>`SELECT data FROM training_blob_chunks WHERE sha256 = ${sha256} ORDER BY seq`;
  return Buffer.concat(parts.map((p) => p.data));
}

async function sheetOf(db: Db, actor: Actor, id: number): Promise<TrainingSheetBook> {
  const f = await assertFileVisible(db, actor, id);
  const [v] = await db<{ mime: string; sha256: string; sizeBytes: string | number }[]>`
    SELECT mime, sha256, size_bytes FROM training_file_versions WHERE id = ${f.currentVersionId}`;
  if (!v || trainingViewKind(v.mime) !== 'sheet') throw unprocessable('TRAINING_NOT_SHEET', '这份文件不是 Excel（.xlsx）');
  if (Number(v.sizeBytes) > SHEET_MAX_BYTES) throw unprocessable('TRAINING_SHEET_TOO_BIG', '这份 Excel 太大，请下载后查看');
  let book;
  try {
    // maxNodes 限住整份 XML 的结构规模（空行、无关属性也算），免得几 KB 的文件解析出几十万个节点（Codex 审查 e1d8be3，同工资表的读法）
    book = readXlsx(await readBlob(db, v.sha256), {
      maxRow: 5000,
      maxCols: 200,
      maxCells: 200_000,
      maxNodes: 300_000,
      maxTotal: SHEET_MAX_UNZIPPED,
      maxSheets: SHEET_MAX_SHEETS,
    });
  } catch (e) {
    if (e instanceof XlsxReadError) throw unprocessable('TRAINING_SHEET_INVALID', `这份 Excel 在页面里打不开（${e.message}），请下载后查看`);
    throw e;
  }
  let budget = SHEET_MAX_TOTAL_CHARS;
  let clipped = false;
  const cellText = (value: string) => {
    let t = value.length > SHEET_MAX_CELL_CHARS ? ((clipped = true), `${value.slice(0, SHEET_MAX_CELL_CHARS)}…`) : value;
    if (t.length > budget) {
      clipped = true;
      t = '';
    }
    budget -= t.length;
    return t;
  };
  return {
    sheets: book.sheets.map((sh) => {
      const rowNos = [...sh.rows.keys()].sort((a, b) => a - b);
      const maxRow = Math.min(rowNos.at(-1) ?? 0, SHEET_MAX_ROWS);
      let maxCol = 0;
      for (const cells of sh.rows.values()) for (const c of cells.keys()) maxCol = Math.max(maxCol, c + 1);
      const cols = Math.min(maxCol, SHEET_MAX_COLS);
      const rows: string[][] = [];
      for (let r = 1; r <= maxRow; r++) {
        const cells = sh.rows.get(r);
        rows.push(Array.from({ length: cols }, (_, c) => cellText(cells?.get(c)?.value ?? '')));
      }
      return {
        name: sh.name,
        rows,
        // 合并单元格裁到显示的范围里（右下角可以写到 XFD1048576，不裁的话页面要铺几十亿格，Codex 审查 e1d8be3）
        merges: sh.merges
          .filter((m) => m.r1 >= 1 && m.c1 >= 0 && m.r1 <= maxRow && m.c1 < cols)
          .map((m) => ({ r1: m.r1, c1: m.c1, r2: Math.min(m.r2, maxRow), c2: Math.min(m.c2, cols - 1) }))
          .filter((m) => m.r2 > m.r1 || m.c2 > m.c1),
        truncated: clipped || (rowNos.at(-1) ?? 0) > SHEET_MAX_ROWS || maxCol > SHEET_MAX_COLS,
      };
    }),
  };
}

// ───────────────────────── 路由 ─────────────────────────

export function registerTrainingRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 登录了就行（改完初始密码、选好岗位以后）；看得到哪些文件夹在接口里按岗位所在部门核对
  const loggedIn = guard();
  const manage = guard(MANAGE);

  app.get('/api/training/folders', { preHandler: loggedIn }, async (req) => listFolders(sql, req.actor));

  app.get('/api/training/folders/:id/files', { preHandler: loggedIn }, async (req) => {
    const { id } = parse(idParam, req.params);
    await assertFolderVisible(sql, req.actor, id);
    return listFiles(sql, req.actor, id);
  });

  app.get('/api/training/files/:id/content', { preHandler: loggedIn }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const q = parse(ContentQuery, req.query ?? {});
    const f = await assertFileVisible(sql, req.actor, id);
    // 带了版本就只读那一版（同一次查看里分段读的都是同一份文件；看的时候换了新版本，不拿新版本的片段拼进来，Codex 审查 e1d8be3）。
    // 旧版本只有管理权限看得到：员工带的不是当前版本就拒绝，页面重新打开
    if (q.v && q.v !== f.currentVersionId && !can(req.actor, MANAGE)) throw conflict('TRAINING_VERSION_CHANGED', '这份文件刚换了新版本，请重新打开');
    const versionId = q.v ?? f.currentVersionId;
    const [v] = await sql<{ fileName: string; mime: string; sha256: string; sizeBytes: string | number }[]>`
      SELECT file_name, mime, sha256, size_bytes FROM training_file_versions WHERE id = ${versionId} AND file_id = ${id}`;
    if (!v) throw notFound('没有这个版本');
    const size = Number(v.sizeBytes);
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') return reply.code(416).header('content-range', `bytes */${size}`).send();
    const inline = !q.download && INLINE.has(v.mime);
    reply
      .header('content-type', v.mime)
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(v.fileName)}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('accept-ranges', 'bytes');
    const { start, end } = range ?? { start: 0, end: size - 1 };
    if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
    reply.header('content-length', String(end - start + 1));
    return reply.send(streamBlob(sql, v.sha256, start, end));
  });

  app.get('/api/training/files/:id/sheet', { preHandler: loggedIn }, async (req) => sheetOf(sql, req.actor, parse(idParam, req.params).id));

  app.post('/api/training/files/:id/viewed', { preHandler: loggedIn }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { versionId } = parse(ViewedInput, req.body ?? {});
    const f = await assertFileVisible(sql, req.actor, id);
    // 记的是员工页面上打开的那一版：页面还停在旧版本（管理员刚换了新的）就不记，免得把没看过的新版本记成看过（Codex 审查 57dd2f6）
    if (versionId !== undefined && versionId !== f.currentVersionId) throw conflict('TRAINING_VERSION_CHANGED', '这份文件刚换了新版本，请重新打开');
    await sql`
      INSERT INTO training_views (file_id, staff_id, last_version_id) VALUES (${id}, ${req.actor.id}, ${f.currentVersionId})
      ON CONFLICT (file_id, staff_id) DO UPDATE SET last_viewed_at = now(), view_count = training_views.view_count + 1, last_version_id = EXCLUDED.last_version_id`;
    return { ok: true };
  });

  // 管理
  app.post('/api/admin/training/folders', { preHandler: manage }, async (req, reply) => reply.code(201).send(await createFolder(deps, req.body, ctxOf(req))));
  app.put('/api/admin/training/folders/:id', { preHandler: manage }, async (req) => updateFolder(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/admin/training/uploads', { preHandler: manage }, async (req) => startUpload(deps, req.body, ctxOf(req)));
  app.put('/api/admin/training/uploads/:id/chunks/:seq', { preHandler: manage, bodyLimit: Math.ceil((TRAINING_CHUNK_BYTES * 4) / 3) + 4096 }, async (req) =>
    putChunk(deps, req.params, req.body, req.actor),
  );
  app.post('/api/admin/training/uploads/cancel', { preHandler: manage }, async (req) => cancelUpload(deps, req.body, ctxOf(req)));
  app.get('/api/admin/training/uploads/:id', { preHandler: manage }, async (req) => {
    const { id } = parse(idParam, req.params);
    await ownUpload(sql, id, req.actor);
    return uploadState(sql, id);
  });
  app.post('/api/admin/training/uploads/:id/complete', { preHandler: manage }, async (req) => completeUpload(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.put('/api/admin/training/files/:id', { preHandler: manage }, async (req) => updateFile(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.get('/api/admin/training/files/:id', { preHandler: manage }, async (req) => fileDetail(sql, req.actor, parse(idParam, req.params).id));
}
