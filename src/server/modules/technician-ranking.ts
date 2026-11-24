// 技师榜单（docs/TECH_RANKING.md，店主 2026-11-24《技师榜单模块需求说明》）第一批：数据接口与照片。
//   · 榜单：与钟房、上钟轮播同一份数据（clockroomBoard），只读、不加锁、不写；状态在这里按钟房算好（TR2），页面不推算；
//     不给客人姓名、手牌与房间（TR6）。人气值 = 近 30 天的点钟钟数（TR3）。
//   · 照片：名册上挂一张（technicians.photo_id），按门店、按内容去重，只追加；换、去掉照片记审计「保存技师」。

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sortBoardTechnicians, techFilterOf, type BoardSession, type BoardTechnician } from '@shared/clockroom';
import { MAX_IMAGE_BYTES } from '@shared/requests';
import {
  RANKING_DEFAULT_REFRESH_SECONDS,
  RANKING_PAGE_SIZE,
  RANKING_POPULARITY_DAYS,
  technicianPhotoUrl,
  type RankingNote,
  type RankingService,
  type RankingStatus,
  type RankingTech,
  type TechnicianRankingView,
} from '@shared/technician-ranking';
import type { Db, Sql } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { badRequest, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { currentStoreId } from '../lib/store-context';
import { clockroomBoard } from './clockroom';
import { sniffImage } from './emenu/core';

/** 钟房的状态 → 榜单的三种状态与小字（TR2） */
export function rankingStatusOf(t: BoardTechnician): { status: RankingStatus; note: RankingNote } {
  switch (techFilterOf(t)) {
    case 'serving':
      return { status: 'serving', note: null };
    case 'waiting':
      return { status: 'serving', note: 'waiting' };
    case 'idle':
      return { status: 'idle', note: null };
    case 'rest':
      return { status: 'idle', note: 'rest' };
    case 'leave':
      return { status: 'off', note: 'leave' };
    case 'suspended':
      return { status: 'off', note: 'suspended' };
    default:
      return { status: 'off', note: null };
  }
}

function serviceOf(t: BoardTechnician, sessions: BoardSession[], now: number): RankingService | null {
  if (!t.busy) return null;
  const s = sessions.find((x) => x.id === t.busy!.sessionId);
  if (!s) return null;
  const started = s.status === 'serving' && s.startedAt ? new Date(s.startedAt).getTime() : null;
  const end = started === null ? null : started + s.minutes * 60_000;
  return {
    sessionId: s.id,
    itemName: s.itemName,
    phase: started === null ? 'waiting' : 'serving',
    startedAt: started === null ? null : s.startedAt,
    minutes: s.minutes,
    plannedEnd: end === null ? null : new Date(end).toISOString(),
    elapsedSeconds: started === null ? null : Math.max(0, Math.floor((now - started) / 1000)),
    remainingSeconds: end === null ? null : Math.max(0, Math.ceil((end - now) / 1000)),
  };
}

/** 人气值：近 N 个营业日（含今天）点钟、已下钟的钟数 */
async function popularityOf(db: Db, businessDate: string): Promise<Map<number, number>> {
  const rows = await db<{ technicianId: number; clocks: number }[]>`
    SELECT s.technician_id, sum(s.clocks)::int AS clocks
    FROM technician_sessions s JOIN technicians t ON t.id = s.technician_id
    WHERE s.call_type = 'designated' AND s.status = 'done' AND t.store_id = ${currentStoreId()}
      AND s.business_date > ${businessDate}::date - ${RANKING_POPULARITY_DAYS}::int AND s.business_date <= ${businessDate}::date
    GROUP BY 1`;
  return new Map(rows.map((r) => [Number(r.technicianId), r.clocks]));
}

export async function technicianRanking(db: Db, deps: Deps): Promise<TechnicianRankingView> {
  const board = await clockroomBoard(db, deps);
  const now = new Date(board.serverTime).getTime();
  const photos = await db<{ id: number; photoId: number }[]>`
    SELECT id, photo_id FROM technicians WHERE store_id = ${currentStoreId()} AND photo_id IS NOT NULL`;
  const photoOf = new Map(photos.map((p) => [Number(p.id), Number(p.photoId)]));
  const popularity = await popularityOf(db, board.businessDate);
  // 在职的都列（TR4）；离职的只在手上还有没结束的钟时列（clockroomBoard 已经这样筛过）
  const techs: RankingTech[] = sortBoardTechnicians(board.technicians, 'queue').map((t, i) => {
    const { status, note } = rankingStatusOf(t);
    return {
      id: t.id,
      techNo: t.techNo,
      name: t.nickname || t.name,
      realName: t.name,
      kind: t.kind,
      photoUrl: technicianPhotoUrl(photoOf.get(t.id) ?? null),
      status,
      note,
      popularity: popularity.get(t.id) ?? 0,
      overallRank: i + 1,
      service: status === 'serving' ? serviceOf(t, board.sessions, now) : null,
    };
  });
  // 工种标签：字典的顺序在前，名册里用着、字典里已经删掉的接在后面
  const dict = board.kinds;
  const extra = [...new Set(techs.map((t) => t.kind).filter((k) => k && !dict.includes(k)))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return {
    serverTime: board.serverTime,
    businessDate: board.businessDate,
    refreshSeconds: RANKING_DEFAULT_REFRESH_SECONDS,
    pageSize: RANKING_PAGE_SIZE,
    popularityDays: RANKING_POPULARITY_DAYS,
    kinds: [...dict, ...extra],
    techs,
    counts: {
      idle: techs.filter((t) => t.status === 'idle').length,
      serving: techs.filter((t) => t.status === 'serving').length,
      off: techs.filter((t) => t.status === 'off').length,
    },
  };
}

// ───────────────────────── 照片 ─────────────────────────

const PhotoInput = z.union([
  z.object({ remove: z.literal(true) }).strict(),
  z
    .object({
      mime: z.enum(['image/jpeg', 'image/png', 'image/webp'], '只能上传 JPEG、PNG、WebP 图片'),
      data: z.string('照片内容为空').min(16, '照片内容为空').max(1_500_000, '照片太大'),
    })
    .strict(),
]);

/** 换（或去掉）一位技师的照片；返回新的照片地址 */
export async function saveTechnicianPhoto(db: Sql, id: number, raw: unknown, actor: { id: number }, ip: string): Promise<{ photoUrl: string | null }> {
  const input = parse(PhotoInput, raw);
  let image: { sha: string; mime: string; buf: Buffer } | null = null;
  if (!('remove' in input)) {
    const buf = Buffer.from(input.data, 'base64');
    if (buf.length === 0) throw badRequest('照片内容为空');
    if (buf.length > MAX_IMAGE_BYTES) throw unprocessable('IMAGE_TOO_LARGE', '照片压缩后仍超过 1 MB，请换一张或裁小一点');
    const mime = sniffImage(buf);
    if (!mime || mime !== input.mime) throw unprocessable('IMAGE_INVALID', '文件不是有效的 JPEG、PNG 或 WebP 图片');
    image = { sha: createHash('sha256').update(buf).digest('hex'), mime, buf };
  }
  return db.begin(async (tx) => {
    // 名册的写法：先锁技师那一行（docs/LOCKING.md「技师」）
    const [before] = await tx<{ techNo: string; name: string; photoId: number | null }[]>`
      SELECT tech_no, name, photo_id FROM technicians WHERE id = ${id} AND store_id = ${currentStoreId()} FOR UPDATE`;
    if (!before) throw notFound('技师不存在');
    let photoId: number | null = null;
    if (image) {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO technician_photos (store_id, sha256, mime, data, size_bytes, created_by)
        VALUES (${currentStoreId()}, ${image.sha}, ${image.mime}, ${image.buf}, ${image.buf.length}, ${actor.id})
        ON CONFLICT (store_id, sha256) DO NOTHING RETURNING id`;
      photoId = Number(row?.id ?? (await tx<{ id: number }[]>`SELECT id FROM technician_photos WHERE store_id = ${currentStoreId()} AND sha256 = ${image.sha}`)[0]!.id);
    }
    const prev = before.photoId === null ? null : Number(before.photoId);
    if (prev !== photoId) {
      await tx`UPDATE technicians SET photo_id = ${photoId}, updated_at = now() WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'technician_saved',
        targetType: 'technician',
        targetId: id,
        detail: {
          name: before.name,
          before: { photoId: prev },
          after: { photoId },
          summary: `${photoId === null ? '去掉' : prev === null ? '上传' : '更换'}技师照片 ${before.techNo} ${before.name}`,
        },
        ip,
      });
    }
    return { photoUrl: technicianPhotoUrl(photoId) };
  });
}

export function registerTechnicianRankingRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 只读：维护名册、钟房、上钟轮播任一项权限都能看（TR1）
  const read = guardAny('technician.manage', 'technician.dispatch', 'technician.board');
  app.get('/api/technician-ranking', { preHandler: read }, async () => technicianRanking(sql, deps));
  // 照片的内容不会变（按内容去重、只追加）：浏览器长期缓存；只给本店的
  app.get('/api/technician-photos/:id', { preHandler: read }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const [img] = await sql<{ mime: string; data: Buffer }[]>`SELECT mime, data FROM technician_photos WHERE id = ${id} AND store_id = ${currentStoreId()}`;
    if (!img) throw notFound('照片不存在');
    reply.header('content-type', img.mime).header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(img.data);
  });
  app.put('/api/admin/technicians/:id/photo', { preHandler: guard('technician.manage'), bodyLimit: 1_600_000 }, async (req) =>
    saveTechnicianPhoto(sql, parse(idParam, req.params).id, req.body, req.actor, req.ip),
  );
}
