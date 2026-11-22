// OA-04 考勤组、班次、打卡点（docs/OA.md 第 7 节；需求文档四（一）、四（二））：后台「人事与办公 → 考勤设置」。
//   · 班次：上下班时间（下班不晚于上班 = 跨天班）、休息段、打卡窗口的几个时长（默认值 OA9）；时间与窗口说不通的不让存（shiftProblem）。
//   · 打卡点：经纬度、有效半径；员工打卡时按距离判断（OA-06）。
//   · 考勤组：用哪几个打卡点、GPS / 人脸两个开关、成员（一人一组）。
// 都按门店分，不删只停用；改的时候带版本，别人先改过就拒绝。
// 加锁（docs/LOCKING.md「考勤设置」）：门店的考勤设置咨询锁（三样的保存之间串行）→ 要改的那一行（FOR UPDATE）→ 成员（员工行 FOR SHARE，按编号）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OA_LOCATION_RADIUS_DEFAULT, OA_SHIFT_NAME_MAX, SHIFT_WINDOW_DEFAULTS, shiftProblem, type AttendanceSetup, type OaAttendanceGroup, type OaLocation, type OaShift } from '@shared/oa';
import { shiftTimeText } from '@shared/technician-admin';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { currentStoreId, DEFAULT_STORE_ID } from '../../lib/store-context';
import { idParam, parse } from '../../lib/validate';
import { NOT_EMPLOYEE_ROLES } from './org';

const manage = guard('hr.attendance');

const lockSetup = (tx: Tx) => tx`SELECT pg_advisory_xact_lock(hashtext(${currentStoreId() === DEFAULT_STORE_ID ? 'oa_attendance_setup' : `oa_attendance_setup:${currentStoreId()}`}))`;

const minute = (label: string) => z.number(`请填写${label}`).int().min(0, `${label}不正确`).max(1439, `${label}不正确`);
const span = (label: string, max: number) => z.number(`请填写${label}`).int().min(0, `${label}不能是负数`).max(max, `${label}最多 ${max} 分钟`);
const version = z.number().int().positive().optional();

const ShiftInput = z
  .object({
    name: z.string().trim().min(1, '请填写班次的名字').max(OA_SHIFT_NAME_MAX, `班次的名字最多 ${OA_SHIFT_NAME_MAX} 个字`),
    startMinute: minute('上班时间'),
    endMinute: minute('下班时间'),
    restStartMinute: minute('休息开始').nullable().default(null),
    restEndMinute: minute('休息结束').nullable().default(null),
    inAdvanceMinutes: span('上班卡可提前', 720).default(SHIFT_WINDOW_DEFAULTS.inAdvanceMinutes),
    lateGraceMinutes: span('迟到弹性', 240).default(SHIFT_WINDOW_DEFAULTS.lateGraceMinutes),
    inAfterMinutes: span('上班窗口在上班后再开', 480).default(SHIFT_WINDOW_DEFAULTS.inAfterMinutes),
    outBeforeMinutes: span('下班窗口在下班前开始', 480).default(SHIFT_WINDOW_DEFAULTS.outBeforeMinutes),
    outDelayMinutes: span('下班卡可延后', 720).default(SHIFT_WINDOW_DEFAULTS.outDelayMinutes),
    active: z.boolean().default(true),
    version,
  })
  .superRefine((s, ctx) => {
    const problem = shiftProblem(s);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

const LocationInput = z.object({
  name: z.string().trim().min(1, '请填写打卡点的名字').max(30, '打卡点的名字最多 30 个字'),
  address: z.string().trim().max(100, '地址最多 100 个字').default(''),
  lat: z.number('请填写纬度').min(-90, '纬度在 -90 到 90 之间').max(90, '纬度在 -90 到 90 之间'),
  lng: z.number('请填写经度').min(-180, '经度在 -180 到 180 之间').max(180, '经度在 -180 到 180 之间'),
  radiusM: z.number().int().min(10, '有效半径至少 10 米').max(3000, '有效半径最多 3000 米').default(OA_LOCATION_RADIUS_DEFAULT),
  active: z.boolean().default(true),
  version,
});

const GroupInput = z.object({
  name: z.string().trim().min(1, '请填写考勤组的名字').max(20, '考勤组的名字最多 20 个字'),
  gpsRequired: z.boolean().default(true),
  faceRequired: z.boolean().default(false),
  active: z.boolean().default(true),
  locationIds: z.array(z.number().int().positive()).max(50, '一个考勤组最多 50 个打卡点').default([]),
  memberIds: z.array(z.number().int().positive()).max(2000).default([]),
  version,
});

/** 本店在职员工（专用账号、系统账号不算）；s 是 staff 表 */
const storeEmployee = (db: Db) => db`
  s.active AND NOT s.system AND s.role <> ALL(${NOT_EMPLOYEE_ROLES})
  AND (EXISTS (SELECT 1 FROM staff_stores x WHERE x.staff_id = s.id AND x.store_id = ${currentStoreId()})
       OR (NOT EXISTS (SELECT 1 FROM staff_stores x WHERE x.staff_id = s.id) AND ${currentStoreId()}::bigint = ${DEFAULT_STORE_ID}::bigint))`;

const SHIFT_COLS = (db: Db) => db`id, name, start_minute, end_minute, rest_start_minute, rest_end_minute, in_advance_minutes, late_grace_minutes,
  in_after_minutes, out_before_minutes, out_delay_minutes, active, version`;

async function loadSetup(db: Db): Promise<AttendanceSetup> {
  const store = currentStoreId();
  const shifts = await db<OaShift[]>`SELECT ${SHIFT_COLS(db)} FROM oa_shifts WHERE store_id = ${store} ORDER BY active DESC, start_minute, id`;
  const locations = await db<(Omit<OaLocation, 'lat' | 'lng'> & { lat: string; lng: string })[]>`
    SELECT id, name, address, lat, lng, radius_m, active, version FROM oa_locations WHERE store_id = ${store} ORDER BY active DESC, id`;
  const groups = await db<Omit<OaAttendanceGroup, 'locationIds' | 'memberIds'>[]>`
    SELECT id, name, gps_required, face_required, active, version FROM oa_attendance_groups WHERE store_id = ${store} ORDER BY active DESC, id`;
  const links = await db<{ groupId: number; locationId: number }[]>`
    SELECT gl.group_id, gl.location_id FROM oa_group_locations gl JOIN oa_attendance_groups g ON g.id = gl.group_id WHERE g.store_id = ${store} ORDER BY gl.location_id`;
  const employees = await db<{ staffId: number; name: string; position: AttendanceSetup['employees'][number]['position']; groupId: number | null }[]>`
    SELECT s.id AS staff_id, s.display_name AS name, s.position, m.group_id
    FROM staff s
    LEFT JOIN oa_group_members m ON m.staff_id = s.id AND m.group_id IN (SELECT id FROM oa_attendance_groups WHERE store_id = ${store})
    WHERE ${storeEmployee(db)}
    ORDER BY s.id`;
  return {
    shifts: shifts.map((s) => ({ ...s, id: Number(s.id) })),
    locations: locations.map((l) => ({ ...l, id: Number(l.id), lat: Number(l.lat), lng: Number(l.lng) })),
    groups: groups.map((g) => ({
      ...g,
      id: Number(g.id),
      locationIds: links.filter((x) => Number(x.groupId) === Number(g.id)).map((x) => Number(x.locationId)),
      memberIds: employees.filter((e) => e.groupId !== null && Number(e.groupId) === Number(g.id)).map((e) => Number(e.staffId)),
    })),
    employees: employees.map((e) => ({ staffId: Number(e.staffId), name: e.name, position: e.position, groupId: e.groupId === null ? null : Number(e.groupId) })),
  };
}

/** 改的时候带版本：别人先改过（或停用了）就拒绝，免得覆盖 */
function checkVersion(row: { version: number } | undefined, expected: number | undefined, what: string) {
  if (!row) throw notFound(`${what}不存在，请刷新`);
  if (expected === undefined) throw unprocessable('VERSION_REQUIRED', '缺少版本，请刷新后再改');
  if (row.version !== expected) throw conflict('VERSION_CONFLICT', `这个${what}刚被别人改过，请刷新后再改`);
}

export function registerOaAttendanceSetupRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/oa/attendance/setup', { preHandler: manage }, async () => loadSetup(sql));

  // ── 班次 ──
  const saveShift = async (id: number | null, raw: unknown, actorId: number, ip: string): Promise<AttendanceSetup> => {
    const s = parse(ShiftInput, raw);
    try {
      return await sql.begin(async (tx) => {
        await lockSetup(tx);
        let shiftId = id;
        let before: OaShift | undefined;
        if (shiftId === null) {
          const [row] = await tx<{ id: number }[]>`
            INSERT INTO oa_shifts (name, start_minute, end_minute, rest_start_minute, rest_end_minute, in_advance_minutes, late_grace_minutes,
                                   in_after_minutes, out_before_minutes, out_delay_minutes, active, created_by, updated_by)
            VALUES (${s.name}, ${s.startMinute}, ${s.endMinute}, ${s.restStartMinute}, ${s.restEndMinute}, ${s.inAdvanceMinutes}, ${s.lateGraceMinutes},
                    ${s.inAfterMinutes}, ${s.outBeforeMinutes}, ${s.outDelayMinutes}, ${s.active}, ${actorId}, ${actorId})
            RETURNING id`;
          shiftId = Number(row!.id);
        } else {
          [before] = await tx<OaShift[]>`SELECT ${SHIFT_COLS(tx)} FROM oa_shifts WHERE id = ${shiftId} AND store_id = ${currentStoreId()} FOR UPDATE`;
          checkVersion(before, s.version, '班次');
          await tx`
            UPDATE oa_shifts SET name = ${s.name}, start_minute = ${s.startMinute}, end_minute = ${s.endMinute},
                   rest_start_minute = ${s.restStartMinute}, rest_end_minute = ${s.restEndMinute},
                   in_advance_minutes = ${s.inAdvanceMinutes}, late_grace_minutes = ${s.lateGraceMinutes}, in_after_minutes = ${s.inAfterMinutes},
                   out_before_minutes = ${s.outBeforeMinutes}, out_delay_minutes = ${s.outDelayMinutes}, active = ${s.active},
                   version = version + 1, updated_by = ${actorId}, updated_at = now()
            WHERE id = ${shiftId}`;
        }
        const { version: _v, ...after } = s;
        await writeAudit(tx, {
          staffId: actorId,
          action: 'oa_shift_saved',
          targetType: 'oa_shift',
          targetId: shiftId,
          detail: { before: before ?? null, after, summary: `${id === null ? '新建' : '修改'}考勤班次「${s.name}」${shiftTimeText(s)}${s.active ? '' : '（已停用）'}` },
          ip,
        });
        return loadSetup(tx);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'oa_shifts_name_uq')) throw conflict('NAME_TAKEN', `已经有叫「${s.name}」的班次（停用的也算），请换一个名字`);
      throw error;
    }
  };
  app.post('/api/oa/attendance/shifts', { preHandler: manage }, async (req, reply) => {
    const out = await saveShift(null, req.body, req.actor.id, req.ip);
    reply.code(201);
    return out;
  });
  app.put('/api/oa/attendance/shifts/:id', { preHandler: manage }, async (req) => saveShift(parse(idParam, req.params).id, req.body, req.actor.id, req.ip));

  // ── 打卡点 ──
  const saveLocation = async (id: number | null, raw: unknown, actorId: number, ip: string): Promise<AttendanceSetup> => {
    const l = parse(LocationInput, raw);
    const lat = l.lat.toFixed(6);
    const lng = l.lng.toFixed(6);
    try {
      return await sql.begin(async (tx) => {
        await lockSetup(tx);
        let locationId = id;
        let before: Record<string, unknown> | undefined;
        if (locationId === null) {
          const [row] = await tx<{ id: number }[]>`
            INSERT INTO oa_locations (name, address, lat, lng, radius_m, active, created_by, updated_by)
            VALUES (${l.name}, ${l.address}, ${lat}, ${lng}, ${l.radiusM}, ${l.active}, ${actorId}, ${actorId}) RETURNING id`;
          locationId = Number(row!.id);
        } else {
          const [row] = await tx<{ name: string; address: string; lat: string; lng: string; radiusM: number; active: boolean; version: number }[]>`
            SELECT name, address, lat, lng, radius_m, active, version FROM oa_locations WHERE id = ${locationId} AND store_id = ${currentStoreId()} FOR UPDATE`;
          checkVersion(row, l.version, '打卡点');
          before = row;
          await tx`
            UPDATE oa_locations SET name = ${l.name}, address = ${l.address}, lat = ${lat}, lng = ${lng}, radius_m = ${l.radiusM}, active = ${l.active},
                   version = version + 1, updated_by = ${actorId}, updated_at = now()
            WHERE id = ${locationId}`;
        }
        const { version: _v, ...after } = l;
        await writeAudit(tx, {
          staffId: actorId,
          action: 'oa_location_saved',
          targetType: 'oa_location',
          targetId: locationId,
          detail: { before: before ?? null, after, summary: `${id === null ? '新建' : '修改'}打卡点「${l.name}」半径 ${l.radiusM} 米${l.active ? '' : '（已停用）'}` },
          ip,
        });
        return loadSetup(tx);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'oa_locations_name_uq')) throw conflict('NAME_TAKEN', `已经有叫「${l.name}」的打卡点（停用的也算），请换一个名字`);
      throw error;
    }
  };
  app.post('/api/oa/attendance/locations', { preHandler: manage }, async (req, reply) => {
    const out = await saveLocation(null, req.body, req.actor.id, req.ip);
    reply.code(201);
    return out;
  });
  app.put('/api/oa/attendance/locations/:id', { preHandler: manage }, async (req) => saveLocation(parse(idParam, req.params).id, req.body, req.actor.id, req.ip));

  // ── 考勤组 ──
  const saveGroup = async (id: number | null, raw: unknown, actorId: number, ip: string): Promise<AttendanceSetup> => {
    const g = parse(GroupInput, raw);
    const locationIds = [...new Set(g.locationIds)].sort((a, b) => a - b);
    const memberIds = [...new Set(g.memberIds)].sort((a, b) => a - b);
    try {
      return await sql.begin(async (tx) => {
        await lockSetup(tx);
        const store = currentStoreId();
        // 打卡点要是本店的；要 GPS 的考勤组至少一个启用的打卡点
        if (locationIds.length) {
          const found = await tx<{ id: number; active: boolean }[]>`SELECT id, active FROM oa_locations WHERE store_id = ${store} AND id IN ${tx(locationIds)}`;
          if (found.length !== locationIds.length) throw unprocessable('LOCATION_INVALID', '有打卡点不存在，请刷新');
          if (g.active && g.gpsRequired && !found.some((x) => x.active)) throw unprocessable('LOCATION_REQUIRED', '要 GPS 打卡的考勤组至少选一个启用中的打卡点');
        } else if (g.active && g.gpsRequired) {
          throw unprocessable('LOCATION_REQUIRED', '要 GPS 打卡的考勤组至少选一个启用中的打卡点');
        }
        // 成员要是本店在职员工（员工行 FOR SHARE，按编号：与办理离职、调店互斥）；在别的门店的考勤组里的不能直接挪过来
        if (memberIds.length) {
          const rows = await tx<{ id: number }[]>`SELECT s.id FROM staff s WHERE s.id IN ${tx(memberIds)} ORDER BY s.id FOR SHARE`;
          if (rows.length !== memberIds.length) throw unprocessable('MEMBER_INVALID', '有员工不存在，请刷新');
          const ok = await tx<{ id: number }[]>`SELECT s.id FROM staff s WHERE s.id IN ${tx(memberIds)} AND ${storeEmployee(tx)}`;
          if (ok.length !== memberIds.length) throw unprocessable('MEMBER_INVALID', '有员工已经离职或不在本店，请刷新');
          const elsewhere = await tx<{ name: string }[]>`
            SELECT s.display_name AS name FROM oa_group_members m JOIN oa_attendance_groups og ON og.id = m.group_id JOIN staff s ON s.id = m.staff_id
            WHERE m.staff_id IN ${tx(memberIds)} AND og.store_id <> ${store}`;
          if (elsewhere.length) throw conflict('MEMBER_IN_OTHER_STORE', `${elsewhere.map((x) => x.name).join('、')} 在别的门店的考勤组里，先在那边移出来`);
        }
        let groupId = id;
        let before: Record<string, unknown> | undefined;
        if (groupId === null) {
          const [row] = await tx<{ id: number }[]>`
            INSERT INTO oa_attendance_groups (name, gps_required, face_required, active, created_by, updated_by)
            VALUES (${g.name}, ${g.gpsRequired}, ${g.faceRequired}, ${g.active}, ${actorId}, ${actorId}) RETURNING id`;
          groupId = Number(row!.id);
        } else {
          const [row] = await tx<{ name: string; gpsRequired: boolean; faceRequired: boolean; active: boolean; version: number }[]>`
            SELECT name, gps_required, face_required, active, version FROM oa_attendance_groups WHERE id = ${groupId} AND store_id = ${store} FOR UPDATE`;
          checkVersion(row, g.version, '考勤组');
          const prevLocations = await tx<{ locationId: number }[]>`SELECT location_id FROM oa_group_locations WHERE group_id = ${groupId} ORDER BY location_id`;
          const prevMembers = await tx<{ staffId: number }[]>`SELECT staff_id FROM oa_group_members WHERE group_id = ${groupId} ORDER BY staff_id`;
          before = { ...row, locationIds: prevLocations.map((x) => Number(x.locationId)), memberIds: prevMembers.map((x) => Number(x.staffId)) };
          await tx`
            UPDATE oa_attendance_groups SET name = ${g.name}, gps_required = ${g.gpsRequired}, face_required = ${g.faceRequired}, active = ${g.active},
                   version = version + 1, updated_by = ${actorId}, updated_at = now()
            WHERE id = ${groupId}`;
        }
        await tx`DELETE FROM oa_group_locations WHERE group_id = ${groupId}`;
        if (locationIds.length)
          await tx`INSERT INTO oa_group_locations ${tx(
            locationIds.map((locationId) => ({ group_id: groupId, location_id: locationId })),
            'group_id',
            'location_id',
          )}`;
        // 停用的考勤组不留成员（成员回到「没进考勤组」）；其余：不在名单里的移出，名单里的挪进来（原来在本店别的组的照样挪）
        const keep = g.active ? memberIds : [];
        await tx`DELETE FROM oa_group_members WHERE group_id = ${groupId} ${keep.length ? tx`AND staff_id NOT IN ${tx(keep)}` : tx``}`;
        if (keep.length) {
          await tx`
            INSERT INTO oa_group_members ${tx(
              keep.map((staffId) => ({ staff_id: staffId, group_id: groupId })),
              'staff_id',
              'group_id',
            )}
            ON CONFLICT (staff_id) DO UPDATE SET group_id = EXCLUDED.group_id, joined_at = now() WHERE oa_group_members.group_id <> EXCLUDED.group_id`;
        }
        const { version: _v, ...after } = g;
        await writeAudit(tx, {
          staffId: actorId,
          action: 'oa_group_saved',
          targetType: 'oa_attendance_group',
          targetId: groupId,
          detail: {
            before: before ?? null,
            after: { ...after, locationIds, memberIds: keep },
            summary: `${id === null ? '新建' : '修改'}考勤组「${g.name}」${keep.length} 人、${locationIds.length} 个打卡点${g.active ? '' : '（已停用）'}`,
          },
          ip,
        });
        return loadSetup(tx);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'oa_attendance_groups_name_uq')) throw conflict('NAME_TAKEN', `已经有叫「${g.name}」的考勤组（停用的也算），请换一个名字`);
      throw error;
    }
  };
  app.post('/api/oa/attendance/groups', { preHandler: manage }, async (req, reply) => {
    const out = await saveGroup(null, req.body, req.actor.id, req.ip);
    reply.code(201);
    return out;
  });
  app.put('/api/oa/attendance/groups/:id', { preHandler: manage }, async (req) => saveGroup(parse(idParam, req.params).id, req.body, req.actor.id, req.ip));
}
