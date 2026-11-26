// OA-06 打卡（docs/OA.md 第 9 节；需求文档四（四）、第十三节第 1、2 条）。
//   · 员工「办公 → 打卡」：按打卡时间匹配本人前一天、当天、后一天的排班（只看这家门店、员工还属于这家门店的排班），
//     落在上班窗口 → 上班卡，落在下班窗口 → 下班卡（matchPunch，严禁「当天第一次打卡 = 上班卡」）；每次都留明细，有效卡查询时算。
//   · 位置：考勤组要 GPS 的按与组里打卡点的距离判断，范围外拒绝（LOCATION_OUT），可改成外勤（事由 + 照片）；不要 GPS 的带了定位就记下。
//   · 防作弊：记设备、IP、定位精度；同一坐标一分钟内有别人也打了卡的标告警（不拦截）。
//   · 打卡带操作编号（oa_punch）：结果不确定的原样重提返回原来那一次；确认作废过的拒绝。
//   · 后台「考勤设置 → 打卡记录」：按业务日期看明细；部门负责人只看本部门。
// 加锁（docs/LOCKING.md「打卡」）：操作编号 → 员工的打卡咨询锁 → 匹配到的排班行 FOR SHARE（与保存排班的 FOR UPDATE 串行）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  distanceMeters,
  epochMinuteOf,
  matchPunch,
  nextPunchHint,
  OUTWORK_REASON_MAX,
  PUNCH_SHARED_SECONDS,
  punchWindows,
  type OaPunch,
  type FaceResult,
  type OaShiftTimes,
  type PunchDay,
  type PunchGroupInfo,
  type PunchKind,
  type PunchRecord,
  type PunchResult,
  type PunchSlot,
  type PunchSlotView,
  type PunchToday,
} from '@shared/oa';
import { shiftDate } from '@shared/labels';
import { can } from '@shared/permissions';
import type { Db, Fragment } from '../../db';
import { guard, guardAny } from '../../auth/guard';
import type { Actor, Deps } from '../../lib/context';
import { clockIn, dateIn } from '../../lib/dates';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { currentStoreId } from '../../lib/store-context';
import { dateSchema, parse } from '../../lib/validate';
import { faceVerifier, verifyFace, type FaceVerifyService } from '../../integrations/face';
import { erpOpAbandoned } from '../erp-ops';
import { bindAttachments, registerAttachmentRef } from './attachments';
import { approvedPhotos, myFace } from './faces';
import { liveSchedule, lockStaffAttendance } from './schedule-overlap';
import { deptFilter } from './schedules';

const PunchInput = z
  .object({
    clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
    storeId: z.number().int().positive(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    accuracy: z.number().min(0).max(1_000_000).optional(),
    device: z.string().max(200).default(''),
    outwork: z
      .object({
        reason: z.string().trim().min(1, '请写外勤事由').max(OUTWORK_REASON_MAX, `外勤事由最多 ${OUTWORK_REASON_MAX} 个字`),
        photoId: z.number().int().positive('请拍一张外勤照片'),
      })
      .optional(),
    /** 考勤组要人脸时的自拍（OA-07，先传成附件） */
    faceImageId: z.number().int().positive().optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: '经纬度要一起带' });
type PunchBody = z.infer<typeof PunchInput>;

/**
 * 位置核对（打卡事务前、事务里各做一次，结果一样）：在任何一个打卡点的范围里就算在范围内（各点半径不同，最近的那个不一定覆盖到），
 * 记下的是范围内最近的那个，都不在就记最近的；要 GPS 的组范围外拒绝（可改外勤）
 */
function checkLocation(group: PunchGroupInfo, input: PunchBody) {
  const here = input.lat !== undefined && input.lng !== undefined ? { lat: input.lat, lng: input.lng } : null;
  const measured = here ? group.locations.map((l) => ({ ...l, distance: distanceMeters(here, l) })).sort((a, b) => a.distance - b.distance) : [];
  const inRange = measured.some((l) => l.distance <= l.radiusM);
  const nearest = measured.find((l) => l.distance <= l.radiusM) ?? measured[0] ?? null;
  if (group.gpsRequired && !here) throw unprocessable('LOCATION_REQUIRED', '这个考勤组打卡要定位：请允许浏览器取位置后再打卡');
  if (input.outwork && !here) throw unprocessable('LOCATION_REQUIRED', '外勤打卡要带上当前位置');
  const locationOk = !group.gpsRequired || inRange;
  if (group.gpsRequired && !locationOk && !input.outwork) {
    throw unprocessable(
      'LOCATION_OUT',
      nearest ? `不在打卡范围内：离最近的「${nearest.name}」${nearest.distance} 米（范围 ${nearest.radiusM} 米）；在外面办事的可以改成外勤打卡` : '考勤组还没设打卡点，只能外勤打卡；请找人事设打卡点',
    );
  }
  if (input.outwork && locationOk) throw unprocessable('OUTWORK_NOT_NEEDED', '你在打卡范围内，直接打卡就行，不用外勤');
  return { here, nearest, locationOk };
}
const DayQuery = z.object({
  date: dateSchema('日期').optional(),
  groupId: z.coerce.number().int().positive().optional(),
});

/** 门店所在地「1970-01-01 起第几分钟」 */
export function localMinute(at: Date, timeZone: string): { date: string; minute: number } {
  const date = dateIn(at, timeZone);
  const [h, m] = clockIn(timeZone, at).split(':').map(Number) as [number, number];
  return { date, minute: epochMinuteOf(date, h * 60 + m) };
}

/** 员工在这家门店的考勤组（启用的）与组里启用的打卡点 */
async function groupOf(db: Db, staffId: number): Promise<PunchGroupInfo | null> {
  const [g] = await db<{ id: number; name: string; gpsRequired: boolean; faceRequired: boolean }[]>`
    SELECT g.id, g.name, g.gps_required, g.face_required FROM oa_group_members m JOIN oa_attendance_groups g ON g.id = m.group_id
    WHERE m.staff_id = ${staffId} AND g.store_id = ${currentStoreId()} AND g.active`;
  if (!g) return null;
  const locations = await db<{ id: number; name: string; lat: string; lng: string; radiusM: number }[]>`
    SELECT l.id, l.name, l.lat, l.lng, l.radius_m FROM oa_group_locations gl JOIN oa_locations l ON l.id = gl.location_id
    WHERE gl.group_id = ${g.id} AND l.active ORDER BY l.id`;
  return {
    id: Number(g.id),
    name: g.name,
    gpsRequired: g.gpsRequired,
    faceRequired: g.faceRequired,
    locations: locations.map((l) => ({ id: Number(l.id), name: l.name, lat: Number(l.lat), lng: Number(l.lng), radiusM: l.radiusM })),
  };
}

type SlotRow = OaShiftTimes & { workDate: string; shiftId: number; name: string };

/** 员工在这家门店 from–to 的排班（还算数的）；lock = 对排班行加共享锁（打卡时，与保存排班串行） */
async function slotsOf(db: Db, staffId: number, from: string, to: string, lock: boolean): Promise<(PunchSlot & { name: string; startMinute: number; endMinute: number })[]> {
  const rows = await db<SlotRow[]>`
    SELECT o.work_date::text AS work_date, o.shift_id, sh.name, sh.start_minute, sh.end_minute, sh.rest_start_minute, sh.rest_end_minute,
           sh.in_advance_minutes, sh.late_grace_minutes, sh.in_after_minutes, sh.out_before_minutes, sh.out_delay_minutes
    FROM oa_schedules o JOIN oa_shifts sh ON sh.id = o.shift_id
    WHERE o.staff_id = ${staffId} AND o.store_id = ${currentStoreId()} AND o.status = 'published' AND ${liveSchedule(db)} AND o.work_date BETWEEN ${from} AND ${to}
    ORDER BY o.work_date, sh.start_minute, o.shift_id
    ${lock ? db`FOR SHARE OF o` : db``}`;
  const filled = await db<{ businessDate: string; shiftId: number; kind: PunchKind }[]>`
    SELECT DISTINCT business_date::text AS business_date, shift_id, kind FROM oa_punches
    WHERE staff_id = ${staffId} AND store_id = ${currentStoreId()} AND business_date BETWEEN ${from} AND ${to} AND kind IN ('in', 'out')`;
  const has = new Set(filled.map((f) => `${f.businessDate}|${Number(f.shiftId)}|${f.kind}`));
  return rows.map((r) => ({
    date: r.workDate,
    shiftId: Number(r.shiftId),
    name: r.name,
    startMinute: r.startMinute,
    endMinute: r.endMinute,
    windows: punchWindows(r.workDate, r),
    hasIn: has.has(`${r.workDate}|${Number(r.shiftId)}|in`),
    hasOut: has.has(`${r.workDate}|${Number(r.shiftId)}|out`),
  }));
}

type PunchRow = {
  id: number;
  staffId: number;
  staffName: string;
  punchedAt: Date;
  localDate: string;
  localTime: string;
  kind: PunchKind;
  businessDate: string;
  shiftId: number | null;
  shiftName: string | null;
  lateMinutes: number;
  earlyMinutes: number;
  locationName: string | null;
  distanceM: number | null;
  accuracyM: number | null;
  locationOk: boolean;
  outwork: boolean;
  outworkReason: string | null;
  sharedLocation: boolean;
  deviceInfo: string;
  ip: string;
  effective: boolean;
  photoId: number | null;
  photoName: string | null;
  photoMime: string | null;
  photoSize: number | null;
  photoThumb: boolean | null;
  faceResult: FaceResult | null;
  faceId: number | null;
  faceName: string | null;
  faceMime: string | null;
  faceSize: number | null;
  faceThumb: boolean | null;
  makeup: boolean;
};

/** 打卡明细（带有效卡标记：上班卡第一次、下班卡最后一次）；where 是对 p 的过滤 */
async function loadPunches(db: Db, timeZone: string, where: Fragment): Promise<PunchRow[]> {
  return db<PunchRow[]>`
    SELECT p.id, p.staff_id, s.display_name AS staff_name, p.punched_at,
           to_char(p.punched_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS local_date,
           to_char(p.punched_at AT TIME ZONE ${timeZone}, 'HH24:MI') AS local_time,
           p.kind, p.business_date::text AS business_date, p.shift_id, sh.name AS shift_name, p.late_minutes, p.early_minutes,
           l.name AS location_name, p.distance_m, p.accuracy_m, p.location_ok, p.outwork, p.outwork_reason, p.shared_location,
           p.device_info, p.ip, p.makeup_approval_id IS NOT NULL AS makeup,
           CASE p.kind
             WHEN 'in' THEN NOT EXISTS (SELECT 1 FROM oa_punches q WHERE q.staff_id = p.staff_id AND q.store_id = p.store_id AND q.business_date = p.business_date
                                          AND q.shift_id = p.shift_id AND q.kind = 'in' AND (q.punched_at, q.id) < (p.punched_at, p.id))
             WHEN 'out' THEN NOT EXISTS (SELECT 1 FROM oa_punches q WHERE q.staff_id = p.staff_id AND q.store_id = p.store_id AND q.business_date = p.business_date
                                           AND q.shift_id = p.shift_id AND q.kind = 'out' AND (q.punched_at, q.id) > (p.punched_at, p.id))
             ELSE false END AS effective,
           a.id AS photo_id, a.file_name AS photo_name, a.mime AS photo_mime, a.size_bytes AS photo_size, a.thumb IS NOT NULL AS photo_thumb,
           p.face_result, f.id AS face_id, f.file_name AS face_name, f.mime AS face_mime, f.size_bytes AS face_size, f.thumb IS NOT NULL AS face_thumb
    FROM oa_punches p
    JOIN staff s ON s.id = p.staff_id
    LEFT JOIN oa_shifts sh ON sh.id = p.shift_id
    LEFT JOIN oa_locations l ON l.id = p.location_id
    LEFT JOIN LATERAL (SELECT id, file_name, mime, size_bytes, thumb FROM oa_attachments WHERE ref_type = 'oa_punch' AND ref_id = p.id ORDER BY id LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT id, file_name, mime, size_bytes, thumb FROM oa_attachments WHERE ref_type = 'oa_punch_face' AND ref_id = p.id ORDER BY id LIMIT 1) f ON true
    WHERE ${where}
    ORDER BY p.punched_at, p.id`;
}

const attachmentView = (id: number | null, name: string | null, mime: string | null, size: number | null, thumb: boolean | null) =>
  id === null
    ? null
    : {
        id: Number(id),
        fileName: name ?? '',
        mime: mime ?? '',
        sizeBytes: Number(size ?? 0),
        isImage: (mime ?? '').startsWith('image/'),
        hasThumb: !!thumb,
        url: `/api/oa/attachments/${Number(id)}`,
        thumbUrl: thumb ? `/api/oa/attachments/${Number(id)}/thumb` : null,
      };

const toPunch = (r: PunchRow): OaPunch => ({
  id: Number(r.id),
  punchedAt: new Date(r.punchedAt).toISOString(),
  localDate: r.localDate,
  localTime: r.localTime,
  kind: r.kind,
  businessDate: r.businessDate,
  shiftId: r.shiftId === null ? null : Number(r.shiftId),
  shiftName: r.shiftName,
  lateMinutes: r.lateMinutes,
  earlyMinutes: r.earlyMinutes,
  locationName: r.locationName,
  distanceM: r.distanceM,
  accuracyM: r.accuracyM,
  locationOk: r.locationOk,
  outwork: r.outwork,
  outworkReason: r.outworkReason,
  photo: attachmentView(r.photoId, r.photoName, r.photoMime, r.photoSize, r.photoThumb),
  sharedLocation: r.sharedLocation,
  faceResult: r.faceResult,
  facePhoto: attachmentView(r.faceId, r.faceName, r.faceMime, r.faceSize, r.faceThumb),
  makeup: r.makeup,
});

/** 一条打卡与它所在那一格的有效卡 */
async function resultOf(db: Db, timeZone: string, id: number, replayed: boolean): Promise<PunchResult> {
  const [row] = await loadPunches(db, timeZone, db`p.id = ${id}`);
  if (!row) throw notFound('打卡记录不存在');
  let effective: OaPunch | null = null;
  if (row.kind === 'in' || row.kind === 'out') {
    const same = await loadPunches(
      db,
      timeZone,
      db`p.staff_id = ${row.staffId} AND p.store_id = ${currentStoreId()} AND p.business_date = ${row.businessDate} AND p.shift_id = ${row.shiftId} AND p.kind = ${row.kind}`,
    );
    const eff = same.find((x) => x.effective);
    effective = eff ? toPunch(eff) : null;
  }
  return { punch: toPunch(row), effective, replayed };
}

/** 外勤照片挂到打卡上以后谁能看：本人（上传的人）、管考勤的；部门负责人看本部门的 */
async function punchReadable(db: Db, actor: Actor, refId: number): Promise<boolean> {
  const [p] = await db<{ staffId: number; storeId: number }[]>`SELECT staff_id, store_id FROM oa_punches WHERE id = ${refId}`;
  if (!p || Number(p.storeId) !== currentStoreId()) return false;
  if (Number(p.staffId) === actor.id || can(actor, 'hr.attendance')) return true;
  if (!can(actor, 'hr.attendanceDept')) return false;
  const [ok] = await db`SELECT 1 FROM staff s WHERE s.id = ${p.staffId} AND ${deptFilter(db, actor)}`;
  return !!ok;
}
registerAttachmentRef('oa_punch', punchReadable);

/**
 * 人脸比对（考勤组要人脸时，事务外）：要有已通过的录入、要带一张本人刚传的自拍；不通过拒绝（FACE_MISMATCH），
 * 比对服务没配置或不可用记 pending（待人工核对，照常打卡）
 */
async function checkFace(db: Db, me: number, imageId: number | undefined, service: FaceVerifyService): Promise<FaceResult> {
  if (!imageId) throw unprocessable('FACE_REQUIRED', '这个考勤组打卡要先自拍一张');
  const enrolled = await approvedPhotos(db, me);
  if (!enrolled) throw unprocessable('FACE_NOT_ENROLLED', '你的人脸录入还没通过审核（或已停用），打不了要人脸的卡：请先到「办公 → 人脸录入」');
  const [probe] = await db<{ fileName: string; mime: string; data: Buffer; uploadedBy: number; refType: string | null }[]>`
    SELECT file_name, mime, data, uploaded_by, ref_type FROM oa_attachments WHERE id = ${imageId}`;
  if (!probe || Number(probe.uploadedBy) !== me || probe.refType !== null || !probe.mime.startsWith('image/')) {
    throw unprocessable('ATTACHMENT_INVALID', '自拍没有传上，或已经用过了：请重拍一张');
  }
  const verdict = await verifyFace(service, { enrolled, probe: { fileName: probe.fileName, mime: probe.mime, data: probe.data } });
  if (verdict.result === 'fail') throw unprocessable('FACE_MISMATCH', '人脸比对没通过：请正对镜头、光线充足时重拍一张');
  return verdict.result === 'pass' ? 'pass' : 'pending';
}

/** 打卡自拍挂上以后谁能看：与打卡明细一样（本人、管考勤的、部门负责人看本部门） */
registerAttachmentRef('oa_punch_face', (db, actor, refId) => punchReadable(db, actor, refId));

export function registerOaPunchRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const tz = deps.config.timezone;

  // 员工打卡页：现在、考勤组与打卡点、前后几天的排班与有效卡、今天的明细
  app.get('/api/oa/attendance/today', { preHandler: guard() }, async (req): Promise<PunchToday> => {
    const me = req.actor.id;
    const { date: today, minute: now } = localMinute(new Date(), tz);
    const group = await groupOf(sql, me);
    const from = shiftDate(today, -1);
    const to = shiftDate(today, 1);
    const slots = await slotsOf(sql, me, from, to, false);
    const rows = await loadPunches(
      sql,
      tz,
      sql`p.staff_id = ${me} AND p.store_id = ${currentStoreId()} AND (p.business_date BETWEEN ${from} AND ${to} OR (p.punched_at AT TIME ZONE ${tz})::date = ${today})`,
    );
    const eff = (s: PunchSlot, kind: 'in' | 'out') => {
      const r = rows.find((x) => x.effective && x.kind === kind && x.businessDate === s.date && Number(x.shiftId) === s.shiftId);
      return r ? toPunch(r) : null;
    };
    // 打卡时段已经结束超过一天的不再列出（前一天的白班到了今天就不用看了）
    const views: PunchSlotView[] = slots
      .filter((s) => s.windows.outTo >= now - 1440)
      .map((s) => ({ date: s.date, shiftId: s.shiftId, name: s.name, startMinute: s.startMinute, endMinute: s.endMinute, windows: s.windows, in: eff(s, 'in'), out: eff(s, 'out') }));
    const face = (await myFace(sql, me)).status;
    return { now, today, group, face, slots: views, punches: rows.filter((r) => r.localDate === today).map(toPunch), nextPunch: nextPunchHint(now, today, views, group) };
  });

  app.post('/api/oa/attendance/punch', { preHandler: guard() }, async (req): Promise<PunchResult> => {
    // 打卡时间按请求到达服务端的时间：后面的人脸比对（可能要等外部服务）不算进员工的打卡时间
    const at = new Date();
    const input = parse(PunchInput, req.body);
    const store = currentStoreId();
    if (input.storeId !== store) throw conflict('STORE_SWITCHED', '这次打卡是在别的门店的页面上发的：请换回那家门店再查回或重新提交');
    const me = req.actor.id;
    // 请求散列带上是谁打的：同一编号换了人（同一台电脑换人登录后从「结果待确认」重提）不能当成原样重提
    const hash = hashRequest({ ...input, clientKey: undefined, staffId: me });
    // 事务外（不在事务里等外部服务）：先核对位置、再比对人脸（文档第十三节第 1 条：先 GPS 围栏、再人脸开关）。原样重提跳过，事务里返回原来那一次
    let face: FaceResult | null = null;
    const [prior] = await sql`SELECT 1 FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (!prior) {
      const group = await groupOf(sql, me);
      if (!group) throw unprocessable('PUNCH_NO_GROUP', '你还没进这家门店的考勤组，打不了卡：请找人事把你加进考勤组');
      checkLocation(group, input);
      if (group.faceRequired) face = await checkFace(sql, me, input.faceImageId, faceVerifier(deps.config.integrations));
    }
    const out = await sql.begin(async (tx): Promise<{ id: number; replayed: boolean }> => {
      await lockOpKey(tx, input.clientKey);
      const [seen] = await tx<{ opType: string; requestHash: string; refId: number; staffId: number }[]>`
        SELECT op_type, request_hash, ref_id, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
      if (seen) {
        if (Number(seen.staffId) !== me) throw forbidden('这条打卡是别人打的：只能查回、重提自己的打卡');
        if (seen.opType !== 'oa_punch' || seen.requestHash !== hash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重新打卡');
        return { id: Number(seen.refId), replayed: true };
      }
      await assertNotFenced(tx, input.clientKey, 'oa_punch', erpOpAbandoned);
      // 员工的考勤锁：同一人的打卡串行（有效卡「第一次 / 最后一次」不乱），与保存这位员工的排班也串行
      await lockStaffAttendance(tx, [me]);

      const group = await groupOf(tx, me);
      if (!group) throw unprocessable('PUNCH_NO_GROUP', '你还没进这家门店的考勤组，打不了卡：请找人事把你加进考勤组');
      const { here, nearest, locationOk } = checkLocation(group, input);
      // 人脸：事务外已经比对过；这期间考勤组改成要人脸的，请员工重打一次（这次会先比对）
      if (group.faceRequired && face === null) throw unprocessable('FACE_REQUIRED', '这个考勤组打卡要先自拍一张，请重新打卡');
      if (face !== null) {
        const [ok] = await tx`SELECT 1 FROM oa_face_enrollments WHERE staff_id = ${me} AND status = 'approved'`;
        if (!ok) throw unprocessable('FACE_NOT_ENROLLED', '你的人脸录入还没通过审核（或已停用），打不了要人脸的卡：请先到「办公 → 人脸录入」');
      }

      // 按时间匹配排班（前后相邻日，跨天班）
      const { date: localDate, minute: t } = localMinute(at, tz);
      const slots = await slotsOf(tx, me, shiftDate(localDate, -2), shiftDate(localDate, 1), true);
      const m = matchPunch(t, slots);
      const businessDate = m.kind === 'rest' ? localDate : m.slot.date;
      const shiftId = m.kind === 'in' || m.kind === 'out' ? m.slot.shiftId : null;

      // 同一坐标一分钟内有别人也打了卡：只告警
      let shared = false;
      if (here) {
        const [other] = await tx`
          SELECT 1 FROM oa_punches WHERE store_id = ${store} AND staff_id <> ${me} AND lat IS NOT NULL
            AND abs(lat - ${here.lat}) < 0.00001 AND abs(lng - ${here.lng}) < 0.00001
            AND punched_at > ${at.toISOString()}::timestamptz - make_interval(secs => ${PUNCH_SHARED_SECONDS}) LIMIT 1`;
        shared = !!other;
      }
      const device = [input.device, String(req.headers['user-agent'] ?? '')].filter(Boolean).join(' | ').slice(0, 400);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO oa_punches (staff_id, punched_at, kind, business_date, shift_id, late_minutes, early_minutes, group_id,
                                lat, lng, accuracy_m, location_id, distance_m, location_ok, outwork, outwork_reason, shared_location, device_info, ip, face_result)
        VALUES (${me}, ${at.toISOString()}, ${m.kind}, ${businessDate}, ${shiftId},
                ${m.kind === 'in' || m.kind === 'out' ? m.lateMinutes : 0}, ${m.kind === 'in' || m.kind === 'out' ? m.earlyMinutes : 0}, ${group.id},
                ${here?.lat ?? null}, ${here?.lng ?? null}, ${input.accuracy === undefined ? null : Math.round(input.accuracy)},
                ${nearest?.id ?? null}, ${nearest?.distance ?? null}, ${locationOk}, ${!!input.outwork}, ${input.outwork?.reason ?? null}, ${shared},
                ${device}, ${req.ip}, ${face})
        RETURNING id`;
      const id = Number(row!.id);
      if (face !== null && input.faceImageId) await bindAttachments(tx, [input.faceImageId], req.actor, { type: 'oa_punch_face', id });
      if (input.outwork) {
        const [photo] = await tx<{ mime: string }[]>`SELECT mime FROM oa_attachments WHERE id = ${input.outwork.photoId}`;
        if (!photo?.mime.startsWith('image/')) throw unprocessable('ATTACHMENT_INVALID', '外勤要拍一张照片（图片）');
        await bindAttachments(tx, [input.outwork.photoId], req.actor, { type: 'oa_punch', id });
      }
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'oa_punch', ${hash}, ${id}, ${me})`;
      return { id, replayed: false };
    });
    return resultOf(sql, tz, out.id, out.replayed);
  });

  // 后台「考勤设置 → 打卡记录」：某个业务日期的明细（部门负责人只看本部门）
  app.get('/api/oa/attendance/punches', { preHandler: guardAny('hr.attendance', 'hr.attendanceDept') }, async (req): Promise<PunchDay> => {
    const q = parse(DayQuery, req.query ?? {});
    const date = q.date ?? localMinute(new Date(), tz).date;
    const store = currentStoreId();
    const groups = await sql<{ id: number; name: string }[]>`SELECT id, name FROM oa_attendance_groups WHERE store_id = ${store} AND active ORDER BY id`;
    const rows = await loadPunches(sql, tz, sql`p.store_id = ${store} AND p.business_date = ${date} AND ${deptFilter(sql, req.actor)} ${q.groupId ? sql`AND p.group_id = ${q.groupId}` : sql``}`);
    const records: PunchRecord[] = rows.map((r) => ({ ...toPunch(r), staffId: Number(r.staffId), staffName: r.staffName, deviceInfo: r.deviceInfo, ip: r.ip, effective: r.effective }));
    return { date, groups: groups.map((g) => ({ id: Number(g.id), name: g.name })), groupId: q.groupId ?? null, records };
  });
}
