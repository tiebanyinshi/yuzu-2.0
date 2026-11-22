// OA-03 通用附件（docs/OA.md 第 6 节）：请假证明、报销发票、外勤照片、聊天文件等共用。
//   · 上传：base64 JSON（与门店系统其他上传一样），单个不超过 10MB；按文件头核对格式（与声明的对不上就拒绝）；
//     图片在浏览器里生成缩略图一起传（服务端不做图像处理），缩略图也核对是 JPEG、不超过 200KB；
//   · 上传带操作编号：没收到结果时原样重提，返回原来那一个，不再存一份；
//   · 限额：每人没挂上的最多 30 个、100MB，24 小时内最多传 300MB；没挂上的 24 小时后清掉（每分钟任务）；
//   · 下载：一律当附件下载（Content-Disposition: attachment），只有图片能内嵌显示；都带 nosniff，不让浏览器猜类型；
//     不让浏览器缓存（no-store）：同一台电脑换人登录，不能从缓存里看到上一位的附件；
//   · 谁能看：没挂到单据上的只有上传的人；各模块用 bindAttachments() 把附件挂到自己的单据上（只能挂自己传的、还没挂过的），
//     挂上以后按 registerAttachmentRef() 登记的核对办法看（OA-11 起各模块接上）。

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_THUMB_MAX_BYTES, type OaAttachment } from '@shared/oa';
import type { Db, Tx } from '../../db';
import { guard } from '../../auth/guard';
import type { Actor, Deps } from '../../lib/context';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';

/** 能传的格式：声明的类型 → 文件头怎么认（文本类不认文件头，只核对是 UTF-8、没有 NUL） */
const FORMATS: Record<string, { ext: string[]; image?: boolean; sniff: (b: Buffer) => boolean }> = {
  'image/jpeg': { ext: ['jpg', 'jpeg'], image: true, sniff: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: ['png'], image: true, sniff: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: ['webp'], image: true, sniff: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  'application/pdf': { ext: ['pdf'], sniff: (b) => b.subarray(0, 5).toString('ascii') === '%PDF-' },
  // Office 新格式与 zip 都是 zip 包（PK\x03\x04）；旧格式是复合文档（D0 CF 11 E0）
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: ['docx'], sniff: isZip },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: ['xlsx'], sniff: isZip },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { ext: ['pptx'], sniff: isZip },
  'application/zip': { ext: ['zip'], sniff: isZip },
  'application/msword': { ext: ['doc'], sniff: isCfb },
  'application/vnd.ms-excel': { ext: ['xls'], sniff: isCfb },
  'application/vnd.ms-powerpoint': { ext: ['ppt'], sniff: isCfb },
  'text/plain': { ext: ['txt'], sniff: isText },
  'text/csv': { ext: ['csv'], sniff: isText },
};
function isZip(b: Buffer) {
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
function isCfb(b: Buffer) {
  return b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}
function isText(b: Buffer) {
  if (b.includes(0)) return false;
  return Buffer.from(b.toString('utf8'), 'utf8').equals(b);
}

const UploadInput = z.object({
  /** 操作编号：没收到结果时原样重提，返回原来那一个 */
  clientKey: z.string().uuid(),
  fileName: z
    .string()
    .trim()
    .min(1, '缺少文件名')
    .max(200, '文件名最多 200 个字')
    .refine((n) => !/[\\/\u0000-\u001f]/.test(n), '文件名不能带路径或控制字符'),
  mime: z.string().refine((m) => m in FORMATS, '只能上传图片（JPEG、PNG、WebP）、PDF、Word、Excel、PPT、文本或 zip'),
  data: z
    .string()
    .min(4)
    .max(Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 8),
  /** 图片的缩略图（浏览器生成的 JPEG），可不传 */
  thumb: z
    .string()
    .max(Math.ceil((ATTACHMENT_THUMB_MAX_BYTES * 4) / 3) + 8)
    .optional(),
});

/**
 * 限额（Codex 安全审查 84f5525：不限的话任何员工都能把数据库传满，整个门店系统写不进去）：
 * 每人还没挂到单据上的最多 30 个、共 100MB；每人 24 小时内最多传 300MB；没挂上的 24 小时后清掉（每分钟任务）
 */
const PENDING_MAX_FILES = 30;
const PENDING_MAX_BYTES = 100 * 1024 * 1024;
const DAY_MAX_BYTES = 300 * 1024 * 1024;
const UNBOUND_TTL = '24 hours';

/** 清掉 24 小时还没挂到单据上的附件（每分钟任务调；正在挂的行被锁着，等它挂上就不再符合条件） */
export async function purgeStaleAttachments(db: Db): Promise<number> {
  const rows = await db`DELETE FROM oa_attachments WHERE ref_type IS NULL AND created_at < now() - ${UNBOUND_TTL}::interval RETURNING id`;
  return rows.length;
}

/** 挂到某类单据上以后谁能看：各模块登记（OA-11 起） */
export type AttachmentRefCheck = (db: Db, actor: Actor, refId: number) => Promise<boolean>;
const refChecks = new Map<string, AttachmentRefCheck>();
export function registerAttachmentRef(refType: string, check: AttachmentRefCheck): void {
  refChecks.set(refType, check);
}

/**
 * 把附件挂到单据上（在调用方的事务里，锁附件行）：只能挂自己上传的、还没挂过的；挂上就不再改。
 * 没有附件可挂时什么都不做
 */
export async function bindAttachments(tx: Tx, ids: readonly number[], actor: Actor, ref: { type: string; id: number }): Promise<void> {
  const want = [...new Set(ids)];
  if (!want.length) return;
  const rows = await tx<{ id: number; uploadedBy: number; refType: string | null }[]>`
    SELECT id, uploaded_by, ref_type FROM oa_attachments WHERE id IN ${tx(want)} ORDER BY id FOR UPDATE`;
  if (rows.length !== want.length || rows.some((r) => Number(r.uploadedBy) !== actor.id || r.refType !== null)) {
    throw unprocessable('ATTACHMENT_INVALID', '有附件没有上传成功或已经用在别的单据上，请重新上传');
  }
  await tx`UPDATE oa_attachments SET ref_type = ${ref.type}, ref_id = ${ref.id}, bound_at = now() WHERE id IN ${tx(want)}`;
}

const toView = (r: { id: number; fileName: string; mime: string; sizeBytes: number; hasThumb: boolean }): OaAttachment => {
  const id = Number(r.id);
  return {
    id,
    fileName: r.fileName,
    mime: r.mime,
    sizeBytes: Number(r.sizeBytes),
    isImage: !!FORMATS[r.mime]?.image,
    hasThumb: r.hasThumb,
    url: `/api/oa/attachments/${id}`,
    thumbUrl: r.hasThumb ? `/api/oa/attachments/${id}/thumb` : null,
  };
};

/** 一张单据上挂的附件（给各模块的详情接口用；调用方已经核对过能看这张单据） */
export async function attachmentsOf(db: Db, ref: { type: string; id: number }): Promise<OaAttachment[]> {
  const rows = await db<{ id: number; fileName: string; mime: string; sizeBytes: number; hasThumb: boolean }[]>`
    SELECT id, file_name, mime, size_bytes, thumb IS NOT NULL AS has_thumb FROM oa_attachments
    WHERE ref_type = ${ref.type} AND ref_id = ${ref.id} ORDER BY id`;
  return rows.map(toView);
}

/** 能不能看这个附件：上传的人；挂上以后按单据登记的办法核对（没登记的类型只有上传的人） */
async function readable(db: Db, actor: Actor, id: number) {
  const [row] = await db<{ uploadedBy: number; refType: string | null; refId: number | null }[]>`
    SELECT uploaded_by, ref_type, ref_id FROM oa_attachments WHERE id = ${id}`;
  if (!row) return false;
  if (Number(row.uploadedBy) === actor.id) return true;
  const check = row.refType ? refChecks.get(row.refType) : undefined;
  return check ? check(db, actor, Number(row.refId)) : false;
}

/**
 * 上传占位（Codex 安全审查 23bc0ff P2）：正文（最大 15MB 的 JSON）在解析之前就核对登录与占位，
 * 同一个人同时只能传一个、全店同时最多 4 个，超出的不读正文直接拒绝（ATTACHMENT_BUSY），免得一堆大请求同时进来把应用的内存撑满。
 * 请求结束（成功、出错或中途断开）就放掉占位
 */
const UPLOAD_SLOTS = 4;
const UPLOAD_BODY_LIMIT = 15_000_000;
const uploading = new Map<string, number>();
const releaseSlot = (req: FastifyRequest) => {
  uploading.delete(req.id);
};

export function registerOaAttachmentRoutes(app: FastifyInstance, { sql }: Deps) {
  const auth = guard();
  const takeSlot = async (req: FastifyRequest, reply: FastifyReply) => {
    await auth.call(app, req, reply);
    const declared = Number(req.headers['content-length']);
    if (!Number.isFinite(declared) || declared <= 0) throw new AppError(411, 'LENGTH_REQUIRED', '上传要带文件大小');
    if (declared > UPLOAD_BODY_LIMIT) throw new AppError(413, 'ATTACHMENT_TOO_LARGE', '单个附件不能超过 10MB');
    const mine = [...uploading.values()].includes(req.actor.id);
    if (mine || uploading.size >= UPLOAD_SLOTS) throw new AppError(429, 'ATTACHMENT_BUSY', '正在上传的附件太多，等上一个传完再试');
    uploading.set(req.id, req.actor.id);
  };
  // 登录就能传：传上来的只有自己看得到，挂到单据上要经各模块的接口
  app.post(
    '/api/oa/attachments',
    { onRequest: takeSlot, onResponse: async (req) => releaseSlot(req), onRequestAbort: async (req) => releaseSlot(req), bodyLimit: UPLOAD_BODY_LIMIT },
    async (req, reply): Promise<OaAttachment> => {
      const input = parse(UploadInput, req.body);
      const buf = Buffer.from(input.data, 'base64');
      if (buf.length === 0) throw unprocessable('ATTACHMENT_EMPTY', '文件是空的');
      if (buf.length > ATTACHMENT_MAX_BYTES) throw unprocessable('ATTACHMENT_TOO_LARGE', '单个附件不能超过 10MB');
      const format = FORMATS[input.mime]!;
      const ext = input.fileName.includes('.') ? input.fileName.split('.').pop()!.toLowerCase() : '';
      if (!format.ext.includes(ext) || !format.sniff(buf)) throw unprocessable('ATTACHMENT_INVALID', '文件内容与类型对不上（扩展名或格式不对），请换一个文件');
      let thumb: Buffer | null = null;
      if (input.thumb !== undefined) {
        if (!format.image) throw unprocessable('ATTACHMENT_INVALID', '只有图片才带缩略图');
        thumb = Buffer.from(input.thumb, 'base64');
        if (thumb.length === 0 || thumb.length > ATTACHMENT_THUMB_MAX_BYTES || !FORMATS['image/jpeg']!.sniff(thumb)) throw unprocessable('ATTACHMENT_INVALID', '缩略图不是有效的 JPEG');
      }
      const sha = createHash('sha256').update(buf).digest('hex');
      type Row = { id: number; fileName: string; mime: string; sizeBytes: number; hasThumb: boolean; uploadedBy: number; sha256: string };
      const COLS = sql`id, file_name, mime, size_bytes, thumb IS NOT NULL AS has_thumb, uploaded_by, sha256`;
      const actor = req.actor.id;
      const result = await sql.begin(async (tx) => {
        // 同一个人的上传串行：限额按库里现在的样子核对，几个请求同时到也不会一起越过
        await tx`SELECT pg_advisory_xact_lock(hashtextextended('oa_attachment_upload', ${actor}))`;
        // 同一编号重提：同一个人、同一个文件就返回原来那一个；别的一律拒绝（不占限额）
        const [prev] = await tx<Row[]>`SELECT ${COLS} FROM oa_attachments WHERE client_key = ${input.clientKey}`;
        if (prev) {
          if (Number(prev.uploadedBy) !== actor || prev.sha256 !== sha || prev.fileName !== input.fileName || prev.mime !== input.mime) {
            throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一个附件，请重新选择文件上传');
          }
          return { row: prev, created: false };
        }
        // 限额：先清掉自己过期没用上的，再核对还没用上的个数、大小与 24 小时内传了多少
        await tx`DELETE FROM oa_attachments WHERE uploaded_by = ${actor} AND ref_type IS NULL AND created_at < now() - ${UNBOUND_TTL}::interval`;
        const [used] = await tx<{ pendingFiles: number; pendingBytes: string; dayBytes: string }[]>`
        SELECT count(*) FILTER (WHERE ref_type IS NULL)::int AS pending_files,
               coalesce(sum(size_bytes) FILTER (WHERE ref_type IS NULL), 0)::text AS pending_bytes,
               coalesce(sum(size_bytes), 0)::text AS day_bytes
        FROM oa_attachments WHERE uploaded_by = ${actor} AND created_at >= now() - interval '24 hours'`;
        if (used!.pendingFiles + 1 > PENDING_MAX_FILES || Number(used!.pendingBytes) + buf.length > PENDING_MAX_BYTES) {
          throw unprocessable('ATTACHMENT_QUOTA', `还没用上的附件太多（最多 ${PENDING_MAX_FILES} 个、共 100MB）：先提交手头的单据，没用上的 24 小时后自动清掉`);
        }
        if (Number(used!.dayBytes) + buf.length > DAY_MAX_BYTES) throw unprocessable('ATTACHMENT_QUOTA', '24 小时内上传的附件已到 300MB，明天再传');
        const [row] = await tx<Row[]>`
        INSERT INTO oa_attachments (client_key, uploaded_by, file_name, mime, size_bytes, sha256, data, thumb)
        VALUES (${input.clientKey}, ${actor}, ${input.fileName}, ${input.mime}, ${buf.length}, ${sha}, ${buf}, ${thumb})
        RETURNING ${COLS}`;
        return { row: row!, created: true };
      });
      if (result.created) reply.code(201);
      return toView(result.row);
    },
  );

  const serve = (part: 'data' | 'thumb') => async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = parse(idParam, req.params);
    // 看不到的与不存在的一样回 404（编号是连续的，不能靠猜）
    if (!(await readable(sql, req.actor, id))) throw notFound('附件不存在');
    const [row] = await sql<{ fileName: string; mime: string; body: Buffer | null }[]>`
      SELECT file_name, mime, ${part === 'thumb' ? sql`thumb` : sql`data`} AS body FROM oa_attachments WHERE id = ${id}`;
    if (!row?.body) throw notFound('附件不存在');
    const image = part === 'thumb' || !!FORMATS[row.mime]?.image;
    reply
      .header('content-type', part === 'thumb' ? 'image/jpeg' : row.mime)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('content-disposition', `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.fileName)}`);
    return reply.send(row.body);
  };
  app.get('/api/oa/attachments/:id', { preHandler: guard() }, serve('data'));
  app.get('/api/oa/attachments/:id/thumb', { preHandler: guard() }, serve('thumb'));
}
