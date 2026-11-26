// OA-07 人脸录入与审核（docs/OA.md 第 10 节；需求文档四（四）第 3 条）。
//   · 员工「办公 → 人脸录入」：3 张正脸照（OA-03 附件，挂到这份录入上），提交后待审核；同一人同时只有一份待审核。
//     提交带操作编号（oa_face_enroll）：结果不确定的查回、原样重提或确认作废；只能查回、作废自己的。
//   · 后台「考勤设置 → 人脸审核」（hr.attendance）：通过（旧的那份记 replaced）、退回（写原因）、停用已通过的；结果发站内通知、记审计。
//     只列这家门店的员工（人脸跟人走，审核谁都一样，但后台按门店看人）。
//   · 打卡时用 approvedPhotos() 取已通过的照片交给比对服务（punches.ts）。
// 加锁（docs/LOCKING.md「人脸录入与审核」）：提交 = 操作编号 → 员工的人脸咨询锁 → 照片附件行；审核 = 操作编号 → 录入行 FOR UPDATE → 同一人已通过的那一行。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FACE_NOTE_MAX,
  FACE_PHOTO_COUNT,
  type FaceEnrollment,
  type FaceEnrollmentPage,
  type FaceEnrollmentStatus,
  type FaceEnrollSaved,
  type FaceReviewSaved,
  type FaceServiceStatus,
  type FaceStatus,
  type MyFace,
} from '@shared/oa';
import { can } from '@shared/permissions';
import type { Db, Fragment } from '../../db';
import { guard } from '../../auth/guard';
import { faceServiceStatus } from '../../integrations/face';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { currentStoreId } from '../../lib/store-context';
import { parse } from '../../lib/validate';
import { erpOpAbandoned } from '../erp-ops';
import { attachmentsOf, bindAttachments, registerAttachmentRef } from './attachments';
import { storeEmployee } from './attendance-setup';
import { notify } from './notifications';

const manage = guard('hr.attendance');
const EnrollInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  photoIds: z.array(z.number().int().positive()).length(FACE_PHOTO_COUNT, `要 ${FACE_PHOTO_COUNT} 张照片`),
});
const reviewKey = {
  /** 操作编号（oa_face_review）：结果不确定的在页面上方查回、原样重提或确认作废 */
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  storeId: z.number().int().positive(),
};
const ReviewInput = z.discriminatedUnion('decision', [
  z.object({ ...reviewKey, decision: z.literal('approve'), note: z.string().trim().max(FACE_NOTE_MAX).optional() }),
  z.object({ ...reviewKey, decision: z.literal('reject'), note: z.string().trim().min(1, '退回要写原因').max(FACE_NOTE_MAX) }),
  z.object({ ...reviewKey, decision: z.literal('revoke'), note: z.string().trim().min(1, '停用要写原因').max(FACE_NOTE_MAX) }),
]);
/** 列表：每页 FACE_PAGE 份，按提交时间倒序；before 是上一页最后一份的 id；q 按姓名、登录名找 */
const FACE_PAGE = 50;
const ListQuery = z.object({
  status: z.enum(['pending', 'approved']).default('pending'),
  q: z.string().trim().max(30).optional(),
  before: z.coerce.number().int().positive().optional(),
});
const idParam = z.object({ id: z.coerce.number().int().positive() });

type Row = {
  id: number;
  staffId: number;
  staffName: string;
  status: FaceEnrollmentStatus;
  submittedAt: Date;
  reviewedAt: Date | null;
  reviewerName: string | null;
  reviewNote: string | null;
};

async function load(db: Db, where: Fragment, limit = 200): Promise<FaceEnrollment[]> {
  const rows = await db<Row[]>`
    SELECT e.id, e.staff_id, s.display_name AS staff_name, e.status, e.submitted_at, e.reviewed_at, r.display_name AS reviewer_name, e.review_note
    FROM oa_face_enrollments e JOIN staff s ON s.id = e.staff_id LEFT JOIN staff r ON r.id = e.reviewed_by
    WHERE ${where} ORDER BY e.id DESC LIMIT ${limit}`;
  return Promise.all(
    rows.map(async (r) => ({
      id: Number(r.id),
      staffId: Number(r.staffId),
      staffName: r.staffName,
      status: r.status,
      submittedAt: new Date(r.submittedAt).toISOString(),
      reviewedAt: r.reviewedAt ? new Date(r.reviewedAt).toISOString() : null,
      reviewerName: r.reviewerName,
      reviewNote: r.reviewNote,
      photos: await attachmentsOf(db, { type: 'oa_face', id: Number(r.id) }),
    })),
  );
}

/** 本人的人脸状态：有已通过的就是 approved；否则看最近提交的那份 */
export async function myFace(db: Db, staffId: number): Promise<MyFace> {
  const [approved] = await load(db, db`e.staff_id = ${staffId} AND e.status = 'approved'`);
  const [latest] = await load(db, db`e.staff_id = ${staffId}`);
  const status: FaceStatus = approved ? 'approved' : latest?.status === 'pending' ? 'pending' : latest?.status === 'rejected' ? 'rejected' : 'none';
  return { status, approved: approved ?? null, latest: latest ?? null };
}

/** 已通过的那份录入的照片（打卡比对用）；没有就是 null */
export async function approvedPhotos(db: Db, staffId: number): Promise<{ fileName: string; mime: string; data: Buffer }[] | null> {
  const rows = await db<{ fileName: string; mime: string; data: Buffer }[]>`
    SELECT a.file_name, a.mime, a.data FROM oa_face_enrollments e JOIN oa_attachments a ON a.ref_type = 'oa_face' AND a.ref_id = e.id
    WHERE e.staff_id = ${staffId} AND e.status = 'approved' ORDER BY a.id`;
  return rows.length ? rows : null;
}

/** 录入照片挂上以后谁能看：本人（上传的人）、管考勤的（这家门店的员工） */
registerAttachmentRef('oa_face', async (db, actor, refId) => {
  if (!can(actor, 'hr.attendance')) return false;
  const [ok] = await db`SELECT 1 FROM oa_face_enrollments e JOIN staff s ON s.id = e.staff_id WHERE e.id = ${refId} AND ${storeEmployee(db)}`;
  return !!ok;
});

export function registerOaFaceRoutes(app: FastifyInstance, { sql, config }: Deps) {
  app.get('/api/oa/face/status', { preHandler: manage }, async (): Promise<FaceServiceStatus> => faceServiceStatus(config.integrations));

  app.get('/api/oa/face/me', { preHandler: guard() }, async (req): Promise<MyFace> => myFace(sql, req.actor.id));

  app.post('/api/oa/face/enroll', { preHandler: guard() }, async (req): Promise<FaceEnrollSaved> => {
    const input = parse(EnrollInput, req.body);
    const me = req.actor.id;
    if (new Set(input.photoIds).size !== input.photoIds.length) throw unprocessable('FACE_PHOTOS', '三张照片不能是同一张');
    const hash = hashRequest({ photoIds: input.photoIds, staffId: me });
    const out = await sql.begin(async (tx): Promise<{ id: number; replayed: boolean }> => {
      await lockOpKey(tx, input.clientKey);
      const [seen] = await tx<{ opType: string; requestHash: string; refId: number; staffId: number }[]>`
        SELECT op_type, request_hash, ref_id, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
      if (seen) {
        if (Number(seen.staffId) !== me) throw forbidden('这份人脸录入是别人提交的');
        if (seen.opType !== 'oa_face_enroll' || seen.requestHash !== hash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重新提交');
        return { id: Number(seen.refId), replayed: true };
      }
      await assertNotFenced(tx, input.clientKey, 'oa_face_enroll', erpOpAbandoned);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`oa_face:${me}`}, 0))`;
      const [pending] = await tx`SELECT 1 FROM oa_face_enrollments WHERE staff_id = ${me} AND status = 'pending'`;
      if (pending) throw conflict('FACE_PENDING', '已经有一份在等人事审核，审核完再提交');
      const photos = await tx<{ mime: string }[]>`SELECT mime FROM oa_attachments WHERE id IN ${tx(input.photoIds)}`;
      if (photos.length !== input.photoIds.length || photos.some((p) => !p.mime.startsWith('image/'))) throw unprocessable('ATTACHMENT_INVALID', '人脸录入要 3 张照片（图片）');
      const [row] = await tx<{ id: number }[]>`INSERT INTO oa_face_enrollments (staff_id) VALUES (${me}) RETURNING id`;
      const id = Number(row!.id);
      await bindAttachments(tx, input.photoIds, req.actor, { type: 'oa_face', id });
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'oa_face_enroll', ${hash}, ${id}, ${me})`;
      return { id, replayed: false };
    });
    const [enrollment] = await load(sql, sql`e.id = ${out.id}`);
    return { enrollment: enrollment!, replayed: out.replayed };
  });

  // 后台「人脸审核」：待审核 / 已通过（这家门店的员工）
  app.get('/api/oa/face/enrollments', { preHandler: manage }, async (req): Promise<FaceEnrollmentPage> => {
    const q = parse(ListQuery, req.query ?? {});
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const items = await load(
      sql,
      sql`e.status = ${q.status} AND ${storeEmployee(sql)}
          ${like ? sql`AND (s.display_name ILIKE ${like} OR s.username ILIKE ${like})` : sql``}
          ${q.before ? sql`AND e.id < ${q.before}` : sql``}`,
      FACE_PAGE + 1,
    );
    const more = items.length > FACE_PAGE;
    const page = items.slice(0, FACE_PAGE);
    return { items: page, nextBefore: more ? page[page.length - 1]!.id : null };
  });

  app.post('/api/oa/face/enrollments/:id/review', { preHandler: manage }, async (req): Promise<FaceReviewSaved> => {
    const { id } = parse(idParam, req.params);
    const input = parse(ReviewInput, req.body);
    if (input.storeId !== currentStoreId()) throw conflict('STORE_SWITCHED', '这次审核是在别的门店的页面上做的：请换回那家门店再查回或重新提交');
    const hash = hashRequest({ id, decision: input.decision, note: input.note ?? null });
    const replayed = await sql.begin(async (tx): Promise<boolean> => {
      await lockOpKey(tx, input.clientKey);
      const [seen] = await tx<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
      if (seen) {
        if (seen.opType !== 'oa_face_review' || seen.requestHash !== hash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重新审核');
        return true;
      }
      await assertNotFenced(tx, input.clientKey, 'oa_face_review', erpOpAbandoned);
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'oa_face_review', ${hash}, ${id}, ${req.actor.id})`;
      const [e] = await tx<{ staffId: number; status: FaceEnrollmentStatus }[]>`
        SELECT e.staff_id, e.status FROM oa_face_enrollments e JOIN staff s ON s.id = e.staff_id WHERE e.id = ${id} AND ${storeEmployee(tx)} FOR UPDATE OF e`;
      if (!e) throw notFound('人脸录入不存在');
      const want: FaceEnrollmentStatus = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'revoked';
      if (e.status === want) return false; // 已经是这个结果（别人刚做了同样的决定）
      const from: FaceEnrollmentStatus = input.decision === 'revoke' ? 'approved' : 'pending';
      if (e.status !== from) throw conflict('FACE_REVIEWED', '这份人脸录入已经被处理过了，请刷新');
      const staffId = Number(e.staffId);
      if (input.decision === 'approve') {
        // 同一人只留一份已通过的：旧的记 replaced
        await tx`UPDATE oa_face_enrollments SET status = 'replaced', reviewed_by = ${req.actor.id}, reviewed_at = now() WHERE staff_id = ${staffId} AND status = 'approved'`;
      }
      if (input.decision === 'revoke') {
        await tx`UPDATE oa_face_enrollments SET status = 'revoked', reviewed_by = ${req.actor.id}, reviewed_at = now(), review_note = ${input.note} WHERE id = ${id}`;
      } else {
        await tx`UPDATE oa_face_enrollments SET status = ${want}, reviewed_by = ${req.actor.id}, reviewed_at = now(), review_note = ${input.note ?? null} WHERE id = ${id}`;
      }
      const title = input.decision === 'approve' ? '人脸录入已通过' : input.decision === 'reject' ? '人脸录入被退回' : '人脸录入已停用';
      await notify(tx, [staffId], {
        kind: 'system',
        title,
        body: input.decision === 'approve' ? '打卡要人脸的考勤组现在可以打卡了' : `原因：${input.note}；请重新录入`,
        link: '/oa/face',
        ref: { type: 'oa_face', id: staffId },
      });
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_face_reviewed',
        targetType: 'staff',
        targetId: staffId,
        detail: { enrollmentId: id, decision: input.decision, note: input.note ?? null, summary: `${title}${input.note ? `（${input.note}）` : ''}` },
        ip: req.ip,
      });
      return false;
    });
    const [row] = await load(sql, sql`e.id = ${id}`);
    return { enrollment: row!, replayed };
  });
}
