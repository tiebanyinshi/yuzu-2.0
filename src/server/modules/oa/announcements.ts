// 员工办公 v1.1 第 5 批（docs/OA_MOBILE.md 第五节）：公司 / 部门公告。
//   · 员工端（仅在职员工，非专用/系统/离职账号，同培训与即时通讯）：
//     - GET  /api/oa/announcements         本店已发布且对本人可见（全员或本部门）的公告，置顶优先、按发布时间倒序，含未读数与附件；
//     - GET  /api/oa/announcements/:id     单条详情与附件（撤回、跨门店、不在范围一律 404）；
//     - POST /api/oa/announcements/:id/read 幂等标已读，并把对应的站内公告通知一并标已读。
//   · 管理端（oa.announce，默认总裁与人力行政部负责人）：
//     - GET  /api/admin/oa/announcements            本店全部公告（含已撤回）、已读数 / 目标人数与附件；
//     - GET  /api/admin/oa/announcements/:id/readers 已读名单（谁读了、何时读）与目标范围总人数；
//     - POST /api/admin/oa/announcements            发布公告（带操作编号幂等 + 确认作废围栏），绑定附件、给目标范围在职员工发站内通知并记审计；
//     - PUT  /api/admin/oa/announcements/:id        修改标题 / 正文 / 置顶（带 version 乐观锁，仅已发布公告可改）并记审计；
//     - POST /api/admin/oa/announcements/:id/recall 撤回公告（带操作编号幂等 + 确认作废围栏 + 原因），隐藏通知并记审计。
// 加锁（docs/LOCKING.md「公司公告」）：
//   发布：lockOpKey → 附件行（id 升序 FOR UPDATE）→ 插入公告 → 站内通知 → 幂等键 → 审计；
//   编辑：公告行（FOR UPDATE，核对 version）→ 审计；
//   撤回：lockOpKey → 公告行（FOR UPDATE）→ 更新状态与清未读通知 → 幂等键 → 审计。

import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import {
  ANNOUNCEMENT_ATTACHMENTS_MAX,
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  type AnnouncementScope,
  type AnnouncementStatus,
  type OaAnnouncement,
  type OaAnnouncementList,
  type OaAnnouncementReaders,
  type OaAnnouncementSaved,
} from '@shared/oa';
import { can } from '@shared/permissions';
import { ORG_DEPARTMENTS, type OrgDepartment } from '@shared/positions';
import { DEFAULT_STORE_ID } from '@shared/stores';
import type { Db, Fragment } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { currentStoreId } from '../../lib/store-context';
import { setTxTimeouts } from '../../lib/tx';
import { idParam, parse } from '../../lib/validate';
import { erpOpAbandoned } from '../erp-ops';
import { attachmentsOf, bindAttachments, registerAttachmentRef } from './attachments';
import { onDuty } from './im';
import { notify, registerNotificationVisibility } from './notifications';
import { NOT_EMPLOYEE_ROLES } from './org';

const REF = 'oa_announcement';
const VALID_DEPTS = new Set<string>(ORG_DEPARTMENTS.map((d) => d.key));
const iso = (d: Date | string) => new Date(d).toISOString();

/** 员工是否属于指定门店（与 attendance-setup.ts 一致：有 staff_stores 按其判定，没填归默认门店） */
const inStore = (db: Db, storeId: number): Fragment =>
  db`(EXISTS (SELECT 1 FROM staff_stores x WHERE x.staff_id = s.id AND x.store_id = ${storeId})
      OR (NOT EXISTS (SELECT 1 FROM staff_stores x WHERE x.staff_id = s.id) AND ${storeId} = ${DEFAULT_STORE_ID}))`;

/** 员工岗位所在部门 */
async function myDepartment(db: Db, staffId: number): Promise<OrgDepartment | null> {
  const [row] = await db<{ department: string }[]>`
    SELECT pc.department FROM staff s JOIN position_catalog pc ON pc.key = s.position WHERE s.id = ${staffId}`;
  return (row?.department as OrgDepartment | undefined) ?? null;
}

/** 员工是否在职且归属该门店 */
async function isEmployeeInStore(db: Db, staffId: number, storeId: number): Promise<boolean> {
  const [row] = await db<{ id: number }[]>`
    SELECT s.id FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
    WHERE s.id = ${staffId} AND ${onDuty(db)} AND ${inStore(db, storeId)}`;
  return !!row;
}

/** 只有在职员工能看公司公告（专用账号、系统账号、离职员工或非本店员工一律拒绝） */
const signedIn = guard();
function employeeOnly(db: Db): preHandlerAsyncHookHandler {
  return async function (req, reply) {
    await signedIn.call(this, req, reply);
    if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(req.actor.role) || !(await isEmployeeInStore(db, req.actor.id, currentStoreId()))) {
      throw forbidden('这个账号不能查看公司公告');
    }
  };
}

interface AnnouncementRow {
  id: number;
  storeId: number;
  title: string;
  body: string;
  scope: AnnouncementScope;
  targetDepts: string[];
  pinned: boolean;
  status: AnnouncementStatus;
  publishedById: number;
  publishedByName: string;
  publishedAt: Date | string;
  recalledByName: string | null;
  recalledAt: Date | string | null;
  recallReason: string;
  version: number;
  readAt: Date | string | null;
}

const DeptKey = z
  .string()
  .trim()
  .refine((k): k is OrgDepartment => VALID_DEPTS.has(k), '部门不存在');

const PublishInput = z
  .object({
    clientKey: z.uuid('操作编号格式不正确'),
    title: z.string().trim().min(1, '请填写公告标题').max(ANNOUNCEMENT_TITLE_MAX, `标题最多 ${ANNOUNCEMENT_TITLE_MAX} 个字`),
    body: z.string().trim().min(1, '请填写公告正文').max(ANNOUNCEMENT_BODY_MAX, `正文最多 ${ANNOUNCEMENT_BODY_MAX} 个字`),
    scope: z.enum(['all', 'dept']),
    targetDepts: z.array(DeptKey).max(ORG_DEPARTMENTS.length).default([]),
    pinned: z.boolean().default(false),
    attachmentIds: z.array(z.number().int().positive()).max(ANNOUNCEMENT_ATTACHMENTS_MAX).default([]),
  })
  .refine((v) => v.scope === 'all' || v.targetDepts.length > 0, { message: '指定部门公告至少选一个部门', path: ['targetDepts'] });

const UpdateInput = z.object({
  title: z.string().trim().min(1, '请填写公告标题').max(ANNOUNCEMENT_TITLE_MAX, `标题最多 ${ANNOUNCEMENT_TITLE_MAX} 个字`),
  body: z.string().trim().min(1, '请填写公告正文').max(ANNOUNCEMENT_BODY_MAX, `正文最多 ${ANNOUNCEMENT_BODY_MAX} 个字`),
  pinned: z.boolean(),
  version: z.number().int().positive(),
});

const RecallInput = z.object({
  clientKey: z.uuid('操作编号格式不正确'),
  reason: z.string().trim().min(1, '请填写撤回原因').max(200, '撤回原因最多 200 个字'),
});

function canSeeAnnouncement(a: { storeId: number; status: string; scope: string; targetDepts: readonly string[] }, storeId: number, dept: string | null): boolean {
  if (Number(a.storeId) !== storeId || a.status !== 'published') return false;
  return a.scope === 'all' || (dept !== null && a.targetDepts.includes(dept));
}

async function targetStaffIds(db: Db, storeId: number, scope: AnnouncementScope, targetDepts: readonly string[]): Promise<number[]> {
  const rows = await db<{ id: number }[]>`
    SELECT s.id
    FROM staff s
    LEFT JOIN staff_profiles p ON p.staff_id = s.id
    LEFT JOIN position_catalog pc ON pc.key = s.position
    WHERE ${onDuty(db)}
      AND ${inStore(db, storeId)}
      ${scope === 'dept' ? db`AND pc.department = ANY(${[...targetDepts]}::text[])` : db``}
    ORDER BY s.id`;
  return rows.map((r) => Number(r.id));
}

async function loadAnnouncementRows(db: Db, storeId: number, viewerStaffId: number, opts: { onlyId?: number; publishedOnly?: boolean } = {}): Promise<AnnouncementRow[]> {
  return db<AnnouncementRow[]>`
    SELECT a.id, a.store_id, a.title, a.body, a.scope, a.target_depts, a.pinned, a.status,
           a.published_by AS published_by_id, pub.display_name AS published_by_name, a.published_at,
           rec.display_name AS recalled_by_name, a.recalled_at, a.recall_reason, a.version,
           r.read_at
    FROM oa_announcements a
    JOIN staff pub ON pub.id = a.published_by
    LEFT JOIN staff rec ON rec.id = a.recalled_by
    LEFT JOIN oa_announcement_reads r ON r.announcement_id = a.id AND r.staff_id = ${viewerStaffId}
    WHERE a.store_id = ${storeId}
      ${opts.onlyId ? db`AND a.id = ${opts.onlyId}` : db``}
      ${opts.publishedOnly ? db`AND a.status = 'published'` : db``}
    ORDER BY (a.status = 'published') DESC, a.pinned DESC, a.published_at DESC, a.id DESC`;
}

async function attachMeta(db: Db, rows: AnnouncementRow[], includeStats: boolean): Promise<OaAnnouncement[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const atts = await db<{ refId: number; id: number; fileName: string; mime: string; sizeBytes: number; hasThumb: boolean }[]>`
    SELECT ref_id, id, file_name, mime, size_bytes, thumb IS NOT NULL AS has_thumb
    FROM oa_attachments
    WHERE ref_type = ${REF} AND ref_id IN ${db(ids)}
    ORDER BY id`;
  const byRef = new Map<number, OaAnnouncement['attachments']>();
  for (const a of atts) {
    const rid = Number(a.refId);
    const aid = Number(a.id);
    const list = byRef.get(rid) ?? [];
    list.push({
      id: aid,
      fileName: a.fileName,
      mime: a.mime,
      sizeBytes: Number(a.sizeBytes),
      isImage: a.mime.startsWith('image/'),
      hasThumb: a.hasThumb,
      url: `/api/oa/attachments/${aid}`,
      thumbUrl: a.hasThumb ? `/api/oa/attachments/${aid}/thumb` : null,
    });
    byRef.set(rid, list);
  }

  const readCounts = new Map<number, number>();
  const deptCounts = new Map<string, number>();
  let allTargetCount = 0;
  if (includeStats) {
    const rc = await db<{ announcementId: number; n: number }[]>`
      SELECT announcement_id, count(*)::int AS n FROM oa_announcement_reads WHERE announcement_id IN ${db(ids)} GROUP BY announcement_id`;
    for (const r of rc) readCounts.set(Number(r.announcementId), Number(r.n));
    const storeId = Number(rows[0]!.storeId);
    const tc = await db<{ department: string | null; n: number }[]>`
      SELECT pc.department, count(*)::int AS n
      FROM staff s
      LEFT JOIN staff_profiles p ON p.staff_id = s.id
      LEFT JOIN position_catalog pc ON pc.key = s.position
      WHERE ${onDuty(db)} AND ${inStore(db, storeId)}
      GROUP BY pc.department`;
    for (const row of tc) {
      allTargetCount += Number(row.n);
      if (row.department) deptCounts.set(row.department, Number(row.n));
    }
  }

  return rows.map((r) => {
    const id = Number(r.id);
    const targetDepts = (r.targetDepts ?? []) as OrgDepartment[];
    const item: OaAnnouncement = {
      id,
      title: r.title,
      body: r.body,
      scope: r.scope,
      targetDepts,
      pinned: r.pinned,
      status: r.status,
      publishedById: Number(r.publishedById),
      publishedByName: r.publishedByName,
      publishedAt: iso(r.publishedAt),
      recalledByName: r.recalledByName,
      recalledAt: r.recalledAt ? iso(r.recalledAt) : null,
      recallReason: r.recallReason,
      version: r.version,
      attachments: byRef.get(id) ?? [],
      readAt: r.readAt ? iso(r.readAt) : null,
    };
    if (includeStats) {
      item.readCount = readCounts.get(id) ?? 0;
      item.targetCount = r.scope === 'all' ? allTargetCount : targetDepts.reduce((sum, d) => sum + (deptCounts.get(d) ?? 0), 0);
    }
    return item;
  });
}

async function loadOne(db: Db, storeId: number, id: number, viewerStaffId: number, includeStats: boolean): Promise<OaAnnouncement | null> {
  const rows = await loadAnnouncementRows(db, storeId, viewerStaffId, { onlyId: id });
  if (!rows.length) return null;
  const [item] = await attachMeta(db, rows, includeStats);
  return item ?? null;
}

export function registerOaAnnouncementRoutes(app: FastifyInstance, { sql }: Deps) {
  const emp = employeeOnly(sql);
  const manage = guard('oa.announce');

  // 附件访问控制（strict: true）：管理员看本店全部公告附件；员工只看本店已发布且自己有权限看的公告附件
  registerAttachmentRef(
    REF,
    async (db: Db, actor: Actor, refId: number) => {
      const [a] = await db<{ storeId: number; status: string; scope: string; targetDepts: string[] }[]>`
        SELECT store_id, status, scope, target_depts FROM oa_announcements WHERE id = ${refId}`;
      if (!a) return false;
      const storeId = actor.storeId ?? currentStoreId();
      if (can(actor, 'oa.announce') && Number(a.storeId) === storeId) return true;
      if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(actor.role) || !(await isEmployeeInStore(db, actor.id, storeId))) return false;
      const dept = await myDepartment(db, actor.id);
      return canSeeAnnouncement(a, storeId, dept);
    },
    { strict: true },
  );

  // 站内通知可见性：已撤回、已离职、调离目标部门或跨店的公告通知不再展示，也不计入未读数
  registerNotificationVisibility(
    'announcement',
    (db, staffId) => db`
      EXISTS (
        SELECT 1
        FROM oa_announcements a
        JOIN staff s ON s.id = ${staffId}
        LEFT JOIN staff_profiles p ON p.staff_id = s.id
        LEFT JOIN position_catalog pc ON pc.key = s.position
        WHERE oa_notifications.ref_type = ${REF}
          AND oa_notifications.ref_id = a.id
          AND a.status = 'published'
          AND ${onDuty(db)}
          AND ${inStore(db, currentStoreId())}
          AND a.store_id = ${currentStoreId()}
          AND (a.scope = 'all' OR (pc.department IS NOT NULL AND pc.department = ANY(a.target_depts)))
      )`,
  );

  // ───────────── 员工端 ─────────────

  app.get('/api/oa/announcements', { preHandler: emp }, async (req): Promise<OaAnnouncementList> => {
    const storeId = currentStoreId();
    const dept = await myDepartment(sql, req.actor.id);
    const rows = (await loadAnnouncementRows(sql, storeId, req.actor.id, { publishedOnly: true })).filter((r) => canSeeAnnouncement(r, storeId, dept));
    const items = await attachMeta(sql, rows, false);
    const unreadCount = items.filter((x) => !x.readAt).length;
    return { items, unreadCount };
  });

  app.get('/api/oa/announcements/:id', { preHandler: emp }, async (req): Promise<OaAnnouncement> => {
    const { id } = parse(idParam, req.params);
    const storeId = currentStoreId();
    const dept = await myDepartment(sql, req.actor.id);
    const rows = (await loadAnnouncementRows(sql, storeId, req.actor.id, { onlyId: id, publishedOnly: true })).filter((r) => canSeeAnnouncement(r, storeId, dept));
    if (!rows.length) throw notFound('公告不存在或已撤回');
    const [item] = await attachMeta(sql, rows, false);
    return item!;
  });

  app.post('/api/oa/announcements/:id/read', { preHandler: emp }, async (req): Promise<{ readAt: string }> => {
    const { id } = parse(idParam, req.params);
    const storeId = currentStoreId();
    const readAt = await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [a] = await tx<{ storeId: number; status: string; scope: string; targetDepts: string[] }[]>`
        SELECT store_id, status, scope, target_depts FROM oa_announcements WHERE id = ${id} FOR SHARE`;
      const dept = await myDepartment(tx, req.actor.id);
      if (!a || !canSeeAnnouncement(a, storeId, dept)) throw notFound('公告不存在或已撤回');
      await tx`
        INSERT INTO oa_announcement_reads (announcement_id, staff_id)
        VALUES (${id}, ${req.actor.id})
        ON CONFLICT (announcement_id, staff_id) DO NOTHING`;
      const [r] = await tx<{ readAt: Date | string }[]>`
        SELECT read_at FROM oa_announcement_reads WHERE announcement_id = ${id} AND staff_id = ${req.actor.id}`;
      await tx`
        UPDATE oa_notifications
        SET read_at = now()
        WHERE staff_id = ${req.actor.id} AND kind = 'announcement' AND ref_type = ${REF} AND ref_id = ${id} AND read_at IS NULL`;
      return iso(r!.readAt);
    });
    return { readAt };
  });

  // ───────────── 管理端（oa.announce） ─────────────

  app.get('/api/admin/oa/announcements', { preHandler: manage }, async (req): Promise<OaAnnouncement[]> => {
    const rows = await loadAnnouncementRows(sql, currentStoreId(), req.actor.id);
    return attachMeta(sql, rows, true);
  });

  app.get('/api/admin/oa/announcements/:id/readers', { preHandler: manage }, async (req): Promise<OaAnnouncementReaders> => {
    const { id } = parse(idParam, req.params);
    const storeId = currentStoreId();
    const [a] = await sql<{ scope: AnnouncementScope; targetDepts: string[] }[]>`
      SELECT scope, target_depts FROM oa_announcements WHERE id = ${id} AND store_id = ${storeId}`;
    if (!a) throw notFound('公告不存在');
    const readers = await sql<{ staffId: number; name: string; department: string | null; readAt: Date | string }[]>`
      SELECT r.staff_id, s.display_name AS name, d.name AS department, r.read_at
      FROM oa_announcement_reads r
      JOIN staff s ON s.id = r.staff_id
      LEFT JOIN position_catalog pc ON pc.key = s.position
      LEFT JOIN org_departments d ON d.key = pc.department
      WHERE r.announcement_id = ${id}
      ORDER BY r.read_at DESC, r.staff_id`;
    const targets = await targetStaffIds(sql, storeId, a.scope, a.targetDepts ?? []);
    return {
      readers: readers.map((x) => ({ staffId: Number(x.staffId), name: x.name, department: x.department, readAt: iso(x.readAt) })),
      targetCount: targets.length,
    };
  });

  app.post('/api/admin/oa/announcements', { preHandler: manage }, async (req, reply): Promise<OaAnnouncementSaved> => {
    const input = parse(PublishInput, req.body);
    const storeId = currentStoreId();
    const targetDepts = input.scope === 'all' ? [] : [...new Set(input.targetDepts)].sort();
    const attachmentIds = [...new Set(input.attachmentIds)].sort((a, b) => a - b);
    const hash = hashRequest({
      op: 'publish',
      storeId,
      title: input.title,
      body: input.body,
      scope: input.scope,
      targetDepts,
      pinned: input.pinned,
      attachmentIds,
      staffId: req.actor.id,
    });

    const out = await sql.begin(async (tx): Promise<{ id: number; replayed: boolean }> => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, input.clientKey);
      const [seen] = await tx<{ opType: string; requestHash: string; refId: number; staffId: number }[]>`
        SELECT op_type, request_hash, ref_id, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
      if (seen) {
        if (seen.opType !== 'oa_announcement' || seen.requestHash !== hash || Number(seen.staffId) !== req.actor.id) {
          throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次公告操作，请刷新页面后重试');
        }
        return { id: Number(seen.refId), replayed: true };
      }
      await assertNotFenced(tx, input.clientKey, 'oa_announcement', erpOpAbandoned);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO oa_announcements (store_id, title, body, scope, target_depts, pinned, published_by)
        VALUES (${storeId}, ${input.title}, ${input.body}, ${input.scope}, ${targetDepts}::text[], ${input.pinned}, ${req.actor.id})
        RETURNING id`;
      const id = Number(row!.id);
      await bindAttachments(tx, attachmentIds, req.actor, { type: REF, id });
      const recipients = await targetStaffIds(tx, storeId, input.scope, targetDepts);
      await notify(tx, recipients, {
        kind: 'announcement',
        title: `公告：${input.title}`.slice(0, 100),
        body: input.body.slice(0, 120),
        link: `/oa/announcements/${id}`,
        ref: { type: REF, id },
      });
      await tx`
        INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id)
        VALUES (${input.clientKey}, 'oa_announcement', ${hash}, ${id}, ${req.actor.id})`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_announcement_published',
        targetType: REF,
        targetId: id,
        detail: { title: input.title, scope: input.scope, targetDepts, pinned: input.pinned, recipientCount: recipients.length },
        ip: req.ip,
      });
      return { id, replayed: false };
    });

    const announcement = (await loadOne(sql, storeId, out.id, req.actor.id, true))!;
    // 确认附件按最新返回
    announcement.attachments = await attachmentsOf(sql, { type: REF, id: out.id });
    reply.code(out.replayed ? 200 : 201);
    return { announcement, replayed: out.replayed };
  });

  app.put('/api/admin/oa/announcements/:id', { preHandler: manage }, async (req): Promise<OaAnnouncement> => {
    const { id } = parse(idParam, req.params);
    const input = parse(UpdateInput, req.body);
    const storeId = currentStoreId();
    await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [cur] = await tx<{ status: AnnouncementStatus; version: number; title: string; pinned: boolean }[]>`
        SELECT status, version, title, pinned FROM oa_announcements WHERE id = ${id} AND store_id = ${storeId} FOR UPDATE`;
      if (!cur) throw notFound('公告不存在');
      if (cur.status !== 'published') throw unprocessable('ANNOUNCEMENT_RECALLED', '已撤回的公告不能再编辑');
      if (cur.version !== input.version) throw conflict('VERSION_CONFLICT', '这条公告刚被别人修改过，请刷新后再试');
      await tx`
        UPDATE oa_announcements
        SET title = ${input.title}, body = ${input.body}, pinned = ${input.pinned}, version = version + 1, updated_at = now()
        WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_announcement_updated',
        targetType: REF,
        targetId: id,
        detail: { beforeTitle: cur.title, afterTitle: input.title, beforePinned: cur.pinned, afterPinned: input.pinned },
        ip: req.ip,
      });
    });
    return (await loadOne(sql, storeId, id, req.actor.id, true))!;
  });

  app.post('/api/admin/oa/announcements/:id/recall', { preHandler: manage }, async (req): Promise<OaAnnouncementSaved> => {
    const { id } = parse(idParam, req.params);
    const input = parse(RecallInput, req.body);
    const storeId = currentStoreId();
    const hash = hashRequest({ op: 'recall', storeId, id, reason: input.reason, staffId: req.actor.id });

    const out = await sql.begin(async (tx): Promise<{ replayed: boolean }> => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, input.clientKey);
      const [seen] = await tx<{ opType: string; requestHash: string; refId: number; staffId: number }[]>`
        SELECT op_type, request_hash, ref_id, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
      if (seen) {
        if (seen.opType !== 'oa_announcement' || seen.requestHash !== hash || Number(seen.staffId) !== req.actor.id || Number(seen.refId) !== id) {
          throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次公告操作，请刷新页面后重试');
        }
        return { replayed: true };
      }
      await assertNotFenced(tx, input.clientKey, 'oa_announcement', erpOpAbandoned);
      const [cur] = await tx<{ status: AnnouncementStatus; title: string }[]>`
        SELECT status, title FROM oa_announcements WHERE id = ${id} AND store_id = ${storeId} FOR UPDATE`;
      if (!cur) throw notFound('公告不存在');
      if (cur.status === 'recalled') throw conflict('ANNOUNCEMENT_RECALLED', '这条公告已经撤回');
      await tx`
        UPDATE oa_announcements
        SET status = 'recalled', pinned = false, recalled_by = ${req.actor.id}, recalled_at = now(),
            recall_reason = ${input.reason}, version = version + 1, updated_at = now()
        WHERE id = ${id}`;
      await tx`
        UPDATE oa_notifications SET read_at = now()
        WHERE kind = 'announcement' AND ref_type = ${REF} AND ref_id = ${id} AND read_at IS NULL`;
      await tx`
        INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id)
        VALUES (${input.clientKey}, 'oa_announcement', ${hash}, ${id}, ${req.actor.id})`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_announcement_recalled',
        targetType: REF,
        targetId: id,
        detail: { title: cur.title, reason: input.reason },
        ip: req.ip,
      });
      return { replayed: false };
    });

    const announcement = (await loadOne(sql, storeId, id, req.actor.id, true))!;
    return { announcement, replayed: out.replayed };
  });
}
