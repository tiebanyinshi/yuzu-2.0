// OA-05 排班 + 员工办公 v1.1 第 2 批（docs/OA.md 第 8 节；docs/OA_MOBILE.md 第 3–5 节，EO5 / 需求 5.2）。
//   · 保存先存草稿（不发通知、不影响员工打卡/结算/我的排班）；点「发布排班」后才正式生效并推送「排班变更」站内通知。
//   · 所有排班查看、单格保存、批量排班、发布均走服务端统一的排班授权校验（resolveScheduleAccess，src/server/modules/oa/schedule-grants.ts）：
//       人事（hr.attendance）全店可管；部门经理可管本部门及下级并可授权下属（不可转授）；被授权人按授出权限与范围操作。
//   · 保存草稿保留已发布的线上行（待删记 pending_delete、连班改动记 draft_consecutive），发布前员工照旧按原已发布排班打卡与结算。
//   · 同一人前后相邻的排班打卡时段不能重叠（保存查 intended，发布再查 published），标了连班的除外。
//   · 保存、批量排班（oa_schedule_save）与发布排班（oa_schedule_publish）均带操作编号幂等与「确认作废」围栏。
// 加锁顺序（docs/LOCKING.md「排班」）：
//   lockSetup → lockOpKey → resolveScheduleAccess(lock: staff + oa_schedule_grants FOR SHARE) → lockStaffAttendance → oa_schedules FOR UPDATE → oa_attendance_daily。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  departmentOfPosition,
  SCHEDULE_AHEAD_DAYS,
  SCHEDULE_BATCH_MAX_CELLS,
  SCHEDULE_BATCH_MAX_DAYS,
  SCHEDULE_BATCH_MAX_STAFF,
  SCHEDULE_MAX_DAYS,
  SCHEDULE_MAX_SHIFTS_PER_DAY,
  SCHEDULE_SAVE_MAX_CELLS,
  type MyDayStatus,
  type MySchedule,
  type OaShift,
  type ScheduleBatchResult,
  type ScheduleCell,
  type SchedulePublishRecord,
  type SchedulePublishResult,
  type ScheduleSkipReason,
  type ScheduleWeek,
} from '@shared/oa';
import { shiftDate } from '@shared/labels';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { daysBetween, todayIn } from '../../lib/dates';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { currentStoreId } from '../../lib/store-context';
import { dateSchema, parse } from '../../lib/validate';
import { erpOpAbandoned } from '../erp-ops';
import { lockSetup, SHIFT_COLS, storeEmployee } from './attendance-setup';
import { notify } from './notifications';
import { resolveScheduleAccess } from './schedule-grants';
import { liveSchedule, lockStaffAttendance, overlapProblem } from './schedule-overlap';

const WeekQuery = z.object({
  groupId: z.coerce.number().int().positive().optional(),
  from: dateSchema('开始日期').optional(),
  days: z.coerce.number().int().min(1).max(SCHEDULE_MAX_DAYS).default(7),
});
const MonthQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式应为 YYYY-MM')
    .optional(),
});

const CellState = z.object({
  shiftIds: z.array(z.number().int().positive()).max(SCHEDULE_MAX_SHIFTS_PER_DAY, `一天最多 ${SCHEDULE_MAX_SHIFTS_PER_DAY} 个班次`),
  consecutive: z.boolean().default(false),
});
const SaveInput = z.object({
  /** 操作编号（与 OA-04 新建同一个做法）：结果不确定的原样重提返回原来那次；确认作废过的拒绝 */
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  storeId: z.number().int().positive(),
  groupId: z.number().int().positive(),
  cells: z
    .array(
      CellState.extend({
        staffId: z.number().int().positive(),
        date: dateSchema('日期'),
        /** 页面上看到的原排班（草稿/工作态）：别人先改过就拒绝 */
        expected: CellState,
      }),
    )
    .min(1, '没有要保存的格子')
    .max(SCHEDULE_SAVE_MAX_CELLS, `一次最多保存 ${SCHEDULE_SAVE_MAX_CELLS} 格`),
});

const BatchInput = z
  .object({
    /** 保存时要（预览不要）：与单格保存同一个做法 */
    clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试').optional(),
    storeId: z.number().int().positive(),
    groupId: z.number().int().positive(),
    staffIds: z.array(z.number().int().positive()).min(1, '请勾选员工').max(SCHEDULE_BATCH_MAX_STAFF, `一次最多 ${SCHEDULE_BATCH_MAX_STAFF} 位员工`),
    dates: z.array(dateSchema('日期')).min(1, '请勾选日期').max(SCHEDULE_BATCH_MAX_DAYS, `一次最多 ${SCHEDULE_BATCH_MAX_DAYS} 天`),
    shiftId: z.number('请选班次').int().positive('请选班次'),
    /** 已有别的排班的日子换成这个班（不勾就跳过） */
    overwrite: z.boolean().default(false),
    /** 只预览，不保存 */
    preview: z.boolean().default(false),
    /** 保存时要：预览返回的版本（每一格当时的排班与处理方式）；锁里重算不一样就拒绝，不悄悄改掉预览以后别人排的 */
    revision: z
      .string()
      .regex(/^[0-9a-f]{64}$/, '缺少预览版本，请重新预览')
      .optional(),
  })
  .refine((v) => new Set(v.staffIds).size * new Set(v.dates).size <= SCHEDULE_BATCH_MAX_CELLS, `一次最多 ${SCHEDULE_BATCH_MAX_CELLS} 格（员工数 × 天数），请分几次排`)
  .refine((v) => v.preview || !!v.clientKey, '缺少有效的操作编号，请刷新页面后重试')
  .refine((v) => v.preview || !!v.revision, '缺少预览版本，请重新预览');

const PublishInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  storeId: z.number().int().positive(),
  groupId: z.number().int().positive(),
  from: dateSchema('开始日期'),
  to: dateSchema('结束日期'),
  staffIds: z.array(z.number().int().positive()).min(1, '至少选一位员工').max(SCHEDULE_BATCH_MAX_STAFF, `一次最多 ${SCHEDULE_BATCH_MAX_STAFF} 位员工`).optional(),
});

interface CellRow {
  id: number;
  shiftId: number;
  consecutive: boolean;
  status: 'draft' | 'published';
  pendingDelete: boolean;
  draftConsecutive: boolean | null;
}

type BatchCell = { staffId: number; date: string; current: number[]; action: 'write' | 'overwrite' | 'same' | ScheduleSkipReason };

/** 批量排班每一格怎么处理（按草稿/工作态；保存时在锁里再算一次） */
async function planBatch(db: Db, today: string, store: number, staffIds: readonly number[], dates: readonly string[], shiftId: number, overwrite: boolean, lock: boolean): Promise<BatchCell[]> {
  const sorted = [...dates].sort();
  const rows = await db<{ staffId: number; workDate: string; shiftId: number; status: 'draft' | 'published'; pendingDelete: boolean }[]>`
    SELECT staff_id, work_date::text AS work_date, shift_id, status, pending_delete FROM oa_schedules
    WHERE store_id = ${store} AND staff_id IN ${db(staffIds)} AND work_date IN ${db(sorted)} ORDER BY staff_id, work_date, shift_id
    ${lock ? db`FOR UPDATE` : db``}`;
  const leaves = await db<{ staffId: number; workDate: string }[]>`
    SELECT DISTINCT staff_id, work_date::text AS work_date FROM oa_attendance_covers WHERE kind = 'leave' AND staff_id IN ${db(staffIds)} AND work_date IN ${db(sorted)}`;
  const punched = await db<{ staffId: number; businessDate: string; shiftId: number }[]>`
    SELECT DISTINCT staff_id, business_date::text AS business_date, shift_id FROM oa_punches
    WHERE store_id = ${store} AND staff_id IN ${db(staffIds)} AND business_date IN ${db(sorted)} AND shift_id IS NOT NULL`;
  const cur = new Map<string, number[]>();
  const pub = new Map<string, number[]>();
  for (const r of rows) {
    const k = `${r.staffId}|${r.workDate}`;
    if (!r.pendingDelete) cur.set(k, [...(cur.get(k) ?? []), Number(r.shiftId)]);
    if (r.status === 'published') pub.set(k, [...(pub.get(k) ?? []), Number(r.shiftId)]);
  }
  const onLeave = new Set(leaves.map((l) => `${l.staffId}|${l.workDate}`));
  const punchedOf = new Map<string, number[]>();
  for (const p of punched) punchedOf.set(`${p.staffId}|${p.businessDate}`, [...(punchedOf.get(`${p.staffId}|${p.businessDate}`) ?? []), Number(p.shiftId)]);
  const out: BatchCell[] = [];
  for (const staffId of [...staffIds].sort((a, b) => a - b)) {
    for (const date of sorted) {
      const k = `${staffId}|${date}`;
      const current = cur.get(k) ?? [];
      const published = pub.get(k) ?? [];
      const cell = (action: BatchCell['action']) => out.push({ staffId, date, current, action });
      if (date < today) cell('past');
      else if (daysBetween(today, date) > SCHEDULE_AHEAD_DAYS) cell('too_far');
      else if (onLeave.has(k)) cell('leave');
      else if (current.length === 1 && current[0] === shiftId) cell('same');
      else if (!current.length && !(punchedOf.get(k) ?? []).some((id) => id !== shiftId && published.includes(id))) cell('write');
      else if (!current.length) cell('punched');
      else if (!overwrite) cell('exists');
      else if ((punchedOf.get(k) ?? []).some((id) => id !== shiftId && (current.includes(id) || published.includes(id)))) cell('punched');
      else cell('overwrite');
    }
  }
  return out;
}

/** 预览的版本：每一格原来的排班与要怎么处理；保存时锁里重算，对不上说明预览以后有人改过 */
const planRevision = (cells: BatchCell[]) => hashRequest(cells.map((c) => [c.staffId, c.date, [...c.current].sort((a, b) => a - b), c.action]));

const summarize = (cells: BatchCell[], names: Map<number, string>, staff: number, days: number): ScheduleBatchResult => ({
  revision: planRevision(cells),
  staff,
  days,
  total: cells.length,
  write: cells.filter((c) => c.action === 'write' || c.action === 'overwrite').length,
  overwrite: cells.filter((c) => c.action === 'overwrite').length,
  same: cells.filter((c) => c.action === 'same').length,
  skipped: cells
    .filter((c): c is BatchCell & { action: ScheduleSkipReason } => !['write', 'overwrite', 'same'].includes(c.action))
    .map((c) => ({ staffId: c.staffId, name: names.get(c.staffId) ?? '', date: c.date, reason: c.action })),
});

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

// 排班的日子是班次开始那一天的日历日（docs/OA.md 第 8 节），不是营业日：凌晨换营业日以前也不能再改昨天的
const todayOf = (deps: Deps) => todayIn(deps.config.timezone);

/** 能看哪些员工（打卡记录、每日结算、考勤月报用）：hr.attendance 全部；只有 hr.attendanceDept 的只看本部门 */
export function deptFilter(db: Db, actor: Actor) {
  if (can(actor, 'hr.attendance')) return db`true`;
  const dept = departmentOfPosition(actor.position);
  if (!dept || dept === 'company') return db`false`;
  return dept === 'gmo' ? db`s.position = 'gmo'` : db`(s.position = ${`${dept}.lead`} OR s.position = ${`${dept}.staff`})`;
}

/**
 * 把一格的改动写成草稿态，保留所有已发布的线上行不变（EO5：发布前不影响员工打卡、结算与「我的排班」）：
 *   - 原来的 draft 行直接删掉重插；
 *   - 原来的 published 行仍在 want 中：恢复 pending_delete = false，连班若变化记 draft_consecutive（改回原值则清空）；
 *   - 原来的 published 行不在 want 中：标 pending_delete = true（发布时再真正删除）；
 *   - want 中新增的班次：以 status = 'draft' 插入。
 */
async function applyDraftCell(tx: Tx, store: number, actorId: number, staffId: number, date: string, rows: readonly CellRow[], want: { shiftIds: number[]; consecutive: boolean }) {
  await tx`DELETE FROM oa_schedules WHERE staff_id = ${staffId} AND work_date = ${date} AND store_id = ${store} AND status = 'draft'`;
  const publishedIds = new Set<number>();
  for (const r of rows) {
    if (r.status !== 'published') continue;
    const sid = Number(r.shiftId);
    publishedIds.add(sid);
    if (want.shiftIds.includes(sid)) {
      const nextDraftConsec = want.consecutive === r.consecutive ? null : want.consecutive;
      await tx`
        UPDATE oa_schedules
        SET pending_delete = false, draft_consecutive = ${nextDraftConsec}, updated_by = ${actorId}, updated_at = now()
        WHERE id = ${r.id}`;
    } else {
      await tx`
        UPDATE oa_schedules
        SET pending_delete = true, draft_consecutive = NULL, updated_by = ${actorId}, updated_at = now()
        WHERE id = ${r.id}`;
    }
  }
  for (const sid of want.shiftIds) {
    if (publishedIds.has(sid)) continue;
    await tx`
      INSERT INTO oa_schedules (staff_id, work_date, shift_id, consecutive, status, created_by, updated_by)
      VALUES (${staffId}, ${date}, ${sid}, ${want.consecutive}, 'draft', ${actorId}, ${actorId})`;
  }
}

async function loadPublishRecord(db: Db, id: number): Promise<SchedulePublishRecord | null> {
  const [r] = await db<
    {
      id: number;
      groupId: number;
      fromDate: string;
      toDate: string;
      staffCount: number;
      cellCount: number;
      publishedBy: number;
      publishedByName: string;
      createdAt: Date;
    }[]
  >`
    SELECT p.id, p.group_id, p.from_date::text AS from_date, p.to_date::text AS to_date,
           p.staff_count, p.cell_count, p.published_by, s.display_name AS published_by_name, p.created_at
    FROM oa_schedule_publishes p JOIN staff s ON s.id = p.published_by
    WHERE p.id = ${id}`;
  return r
    ? {
        id: Number(r.id),
        groupId: Number(r.groupId),
        fromDate: r.fromDate,
        toDate: r.toDate,
        staffCount: r.staffCount,
        cellCount: r.cellCount,
        publishedBy: Number(r.publishedBy),
        publishedByName: r.publishedByName,
        createdAt: new Date(r.createdAt).toISOString(),
      }
    : null;
}

async function loadWeek(db: Db, deps: Deps, actor: Actor, q: z.infer<typeof WeekQuery>): Promise<ScheduleWeek> {
  const store = currentStoreId();
  const today = todayOf(deps);
  const from = q.from ?? today;
  const to = shiftDate(from, q.days - 1);
  const access = await resolveScheduleAccess(db, actor, today);
  if (!access.summary.canView) throw forbidden('你没有查看排班的权限');

  const visibleIds = [...access.viewStaff];
  const visibleFilter = access.allCompany ? db`true` : visibleIds.length > 0 ? db`s.id = ANY(${visibleIds}::bigint[])` : db`false`;

  const groups = await db<{ id: number; name: string }[]>`
    SELECT g.id, g.name FROM oa_attendance_groups g
    WHERE g.store_id = ${store} AND g.active
      AND EXISTS (SELECT 1 FROM oa_group_members m JOIN staff s ON s.id = m.staff_id WHERE m.group_id = g.id AND ${storeEmployee(db)} AND ${visibleFilter})
    ORDER BY g.id`;
  const list = groups.map((g) => ({ id: Number(g.id), name: g.name }));
  const group = (q.groupId ? list.find((g) => g.id === q.groupId) : list[0]) ?? null;
  if (q.groupId && !group) throw notFound('考勤组不存在，或其中没有你能看的员工');
  const members = group
    ? await db<{ staffId: number; name: string; position: ScheduleWeek['members'][number]['position'] }[]>`
        SELECT s.id AS staff_id, s.display_name AS name, s.position FROM oa_group_members m JOIN staff s ON s.id = m.staff_id
        WHERE m.group_id = ${group.id} AND ${storeEmployee(db)} AND ${visibleFilter} ORDER BY s.id`
    : [];
  const ids = members.map((m) => Number(m.staffId));
  const rows = ids.length
    ? await db<{ staffId: number; workDate: string; shiftId: number; consecutive: boolean; status: 'draft' | 'published'; pendingDelete: boolean; draftConsecutive: boolean | null }[]>`
        SELECT staff_id, work_date::text AS work_date, shift_id, consecutive, status, pending_delete, draft_consecutive FROM oa_schedules
        WHERE store_id = ${store} AND staff_id IN ${db(ids)} AND work_date BETWEEN ${from} AND ${to} ORDER BY staff_id, work_date, shift_id`
    : [];

  const grouped = new Map<string, (typeof rows)[number][]>();
  for (const r of rows) {
    const key = `${r.staffId}|${r.workDate}`;
    grouped.set(key, [...(grouped.get(key) ?? []), r]);
  }
  const cells: ScheduleCell[] = [];
  for (const [key, listRows] of grouped) {
    const [sidStr, date] = key.split('|') as [string, string];
    const intended = listRows.filter((r) => !r.pendingDelete);
    const unpublished = listRows.some((r) => r.status === 'draft' || r.pendingDelete || r.draftConsecutive !== null);
    if (!intended.length && !unpublished) continue;
    cells.push({
      staffId: Number(sidStr),
      date,
      shiftIds: intended.map((r) => Number(r.shiftId)),
      consecutive: intended.some((r) => r.draftConsecutive ?? r.consecutive),
      ...(unpublished ? { unpublished: true } : {}),
    });
  }
  const unpublishedCount = cells.filter((c) => c.unpublished && c.date >= today).length;

  const usedShifts = [...new Set(rows.filter((r) => !r.pendingDelete).map((r) => Number(r.shiftId)))];
  const shifts = await db<OaShift[]>`
    SELECT ${SHIFT_COLS(db)} FROM oa_shifts WHERE store_id = ${store} AND (active ${usedShifts.length ? db`OR id IN ${db(usedShifts)}` : db``}) ORDER BY start_minute, id`;

  const recentRows = group
    ? await db<
        {
          id: number;
          groupId: number;
          fromDate: string;
          toDate: string;
          staffCount: number;
          cellCount: number;
          publishedBy: number;
          publishedByName: string;
          createdAt: Date;
        }[]
      >`
        SELECT p.id, p.group_id, p.from_date::text AS from_date, p.to_date::text AS to_date,
               p.staff_count, p.cell_count, p.published_by, s.display_name AS published_by_name, p.created_at
        FROM oa_schedule_publishes p JOIN staff s ON s.id = p.published_by
        WHERE p.store_id = ${store} AND p.group_id = ${group.id}
        ORDER BY p.created_at DESC, p.id DESC LIMIT 5`
    : [];
  const recentPublishes: SchedulePublishRecord[] = recentRows.map((r) => ({
    id: Number(r.id),
    groupId: Number(r.groupId),
    fromDate: r.fromDate,
    toDate: r.toDate,
    staffCount: r.staffCount,
    cellCount: r.cellCount,
    publishedBy: Number(r.publishedBy),
    publishedByName: r.publishedByName,
    createdAt: new Date(r.createdAt).toISOString(),
  }));

  const mappedMembers = members.map((m) => {
    const staffId = Number(m.staffId);
    return {
      staffId,
      name: m.name,
      position: m.position,
      editable: access.editStaff.has(staffId),
      publishable: access.publishStaff.has(staffId),
    };
  });

  return {
    groups: list,
    group,
    from,
    to,
    today,
    editable: mappedMembers.length > 0 ? mappedMembers.some((m) => m.editable) : access.summary.canEdit,
    publishable: mappedMembers.length > 0 ? mappedMembers.some((m) => m.publishable) : access.summary.canPublish,
    unpublishedCount,
    recentPublishes,
    members: mappedMembers,
    shifts: shifts.map((s) => ({ ...s, id: Number(s.id) })),
    cells,
  };
}

/** 要去掉的那几班里已经有打卡的（OA-06：打卡按员工 + 日期 + 班次对应排班） */
async function punchedShifts(tx: Tx, staffId: number, date: string, shiftIds: readonly number[]): Promise<number[]> {
  if (!shiftIds.length) return [];
  const rows = await tx<{ shiftId: number }[]>`
    SELECT DISTINCT shift_id FROM oa_punches WHERE staff_id = ${staffId} AND store_id = ${currentStoreId()} AND business_date = ${date} AND shift_id IN ${tx(shiftIds)}`;
  return rows.map((r) => Number(r.shiftId));
}

export function registerOaScheduleRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/oa/attendance/schedule', { preHandler: guard() }, async (req) => loadWeek(sql, deps, req.actor, parse(WeekQuery, req.query ?? {})));

  // 单格 / 多格保存排班草稿（不发通知、不影响员工打卡/结算，发布后才生效）
  app.post('/api/oa/attendance/schedule', { preHandler: guard() }, async (req) => {
    const input = parse(SaveInput, req.body);
    const store = currentStoreId();
    const keys = new Set<string>();
    for (const c of input.cells) {
      const k = `${c.staffId}|${c.date}`;
      if (keys.has(k)) throw unprocessable('SCHEDULE_DUPLICATE', '同一人同一天提交了两次，请刷新后再排');
      keys.add(k);
      if (new Set(c.shiftIds).size !== c.shiftIds.length) throw unprocessable('SCHEDULE_DUPLICATE', '同一天选了两次同一个班次');
    }
    if (input.storeId !== store) throw conflict('STORE_SWITCHED', '这次保存是在别的门店做的：请换回那家门店再查回或重新提交');
    const hash = hashRequest({ staffId: req.actor.id, groupId: input.groupId, cells: input.cells });
    const changed = await sql.begin(async (tx): Promise<number> => {
      await lockSetup(tx);
      await lockOpKey(tx, input.clientKey);
      const [seen] = await tx<{ opType: string; requestHash: string; refId: number; staffId: number }[]>`
        SELECT op_type, request_hash, ref_id, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
      if (seen) {
        if (Number(seen.staffId) !== req.actor.id && !can(req.actor, 'hr.attendance')) throw forbidden('该操作编号属于他人，不能重提');
        if (seen.opType !== 'oa_schedule_save' || seen.requestHash !== hash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重新排');
        return 0;
      }
      await assertNotFenced(tx, input.clientKey, 'oa_schedule_save', erpOpAbandoned);
      const today = todayOf(deps);
      const access = await resolveScheduleAccess(tx, req.actor, today, { lock: true });
      const staffIds = [...new Set(input.cells.map((c) => c.staffId))].sort((a, b) => a - b);
      if (!access.summary.canEdit) throw forbidden('你没有编排排班的权限');
      const [group] = await tx<{ id: number; name: string }[]>`SELECT id, name FROM oa_attendance_groups WHERE id = ${input.groupId} AND store_id = ${store} AND active`;
      if (!group) throw notFound('考勤组不存在或已停用，请刷新');
      // 这几位员工的考勤锁：与打卡、发布排班串行
      await lockStaffAttendance(tx, staffIds);
      const members = await tx<{ id: number }[]>`
        SELECT s.id FROM oa_group_members m JOIN staff s ON s.id = m.staff_id WHERE m.group_id = ${group.id} AND s.id IN ${tx(staffIds)} AND ${storeEmployee(tx)}`;
      if (members.length !== staffIds.length) throw unprocessable('SCHEDULE_MEMBER', '有员工已经不在这个考勤组里或已离职，请刷新');
      if (staffIds.some((id) => !access.editStaff.has(id))) throw forbidden('所选员工中包含超出你排班授权范围的人员');
      const shiftIds = [...new Set(input.cells.flatMap((c) => c.shiftIds))];
      if (shiftIds.length) {
        const ok = await tx<{ id: number }[]>`SELECT id FROM oa_shifts WHERE store_id = ${store} AND active AND id IN ${tx(shiftIds)}`;
        if (ok.length !== shiftIds.length) throw unprocessable('SCHEDULE_SHIFT', '有班次不存在或已停用，请刷新');
      }
      const changes: { staffId: number; date: string; before: z.infer<typeof CellState>; after: z.infer<typeof CellState> }[] = [];
      for (const c of [...input.cells].sort((a, b) => a.staffId - b.staffId || a.date.localeCompare(b.date))) {
        const rows = await tx<CellRow[]>`
          SELECT id, shift_id, consecutive, status, pending_delete, draft_consecutive
          FROM oa_schedules WHERE staff_id = ${c.staffId} AND work_date = ${c.date} AND store_id = ${store} ORDER BY shift_id FOR UPDATE`;
        const intended = rows.filter((r) => !r.pendingDelete);
        const current = { shiftIds: intended.map((r) => Number(r.shiftId)), consecutive: intended.some((r) => r.draftConsecutive ?? r.consecutive) };
        const want = { shiftIds: c.shiftIds, consecutive: c.shiftIds.length ? c.consecutive : false };
        if (sameSet(current.shiftIds, want.shiftIds) && current.consecutive === want.consecutive) continue;
        if (!sameSet(current.shiftIds, c.expected.shiftIds) || current.consecutive !== (c.expected.shiftIds.length ? c.expected.consecutive : false)) {
          throw conflict('SCHEDULE_CHANGED', `${c.date} 这一格刚被别人改过，请刷新后再排`);
        }
        if (c.date < today) throw unprocessable('SCHEDULE_PAST', `${c.date} 已经过了，不能再改排班`);
        if (daysBetween(today, c.date) > SCHEDULE_AHEAD_DAYS) throw unprocessable('SCHEDULE_TOO_FAR', `最远排到 ${SCHEDULE_AHEAD_DAYS} 天以后`);
        // 已经打过卡的那一班不能删（OA-06：打卡按员工 + 日期 + 班次对应排班）
        const publishedShiftIds = rows.filter((r) => r.status === 'published').map((r) => Number(r.shiftId));
        const removed = [...new Set([...current.shiftIds, ...publishedShiftIds])].filter((id) => !want.shiftIds.includes(id));
        if ((await punchedShifts(tx, c.staffId, c.date, removed)).length) {
          throw unprocessable('SCHEDULE_PUNCHED', `${c.date} 这一格要去掉的班次已经有打卡，不能删；要调整请先找人事核对考勤`);
        }
        await applyDraftCell(tx, store, req.actor.id, c.staffId, c.date, rows, want);
        changes.push({ staffId: c.staffId, date: c.date, before: current, after: want });
      }
      // 记下操作编号（ref_id 是考勤组）：没有要改的格子也记，查回时算已保存
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'oa_schedule_save', ${hash}, ${group.id}, ${req.actor.id})`;
      if (!changes.length) return 0;
      const dates = changes.map((x) => x.date).sort();
      const problem = await overlapProblem(tx, [...new Set(changes.map((x) => x.staffId))], dates[0]!, dates[dates.length - 1]!, 'intended');
      if (problem) throw unprocessable('SCHEDULE_OVERLAP', problem);
      const viaGrantIds = access.grantIdsFor('edit', [...new Set(changes.map((x) => x.staffId))]);
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_schedule_saved',
        targetType: 'oa_attendance_group',
        targetId: group.id,
        detail: {
          draft: true,
          viaGrantIds,
          changes,
          summary: `考勤组「${group.name}」保存排班草稿：改了 ${changes.length} 格（${dates[0]} 至 ${dates[dates.length - 1]}）`,
        },
        ip: req.ip,
      });
      return changes.length;
    });
    return { changed, saved: { id: input.groupId } };
  });

  // 批量排班：先预览（只读），再带操作编号保存草稿（发布后才生效、才通知）
  app.post('/api/oa/attendance/schedule/batch', { preHandler: guard() }, async (req): Promise<ScheduleBatchResult> => {
    const input = parse(BatchInput, req.body);
    const store = currentStoreId();
    if (input.storeId !== store) throw conflict('STORE_SWITCHED', '这次排班是在别的门店做的：请换回那家门店再查回或重新提交');
    const staffIds = [...new Set(input.staffIds)].sort((a, b) => a - b);
    const dates = [...new Set(input.dates)].sort();
    const check = async (db: Db, accessEditStaff: ReadonlySet<number>, canEdit: boolean) => {
      if (!canEdit) throw forbidden('你没有编排排班的权限');
      const [group] = await db<{ id: number; name: string }[]>`SELECT id, name FROM oa_attendance_groups WHERE id = ${input.groupId} AND store_id = ${store} AND active`;
      if (!group) throw notFound('考勤组不存在或已停用，请刷新');
      const members = await db<{ id: number; name: string }[]>`
        SELECT s.id, s.display_name AS name FROM oa_group_members m JOIN staff s ON s.id = m.staff_id WHERE m.group_id = ${group.id} AND s.id IN ${db(staffIds)} AND ${storeEmployee(db)}`;
      if (members.length !== staffIds.length) throw unprocessable('SCHEDULE_MEMBER', '有员工已经不在这个考勤组里或已离职，请刷新');
      if (staffIds.some((id) => !accessEditStaff.has(id))) throw forbidden('所选员工中包含超出你排班授权范围的人员');
      const [shift] = await db<{ id: number; name: string }[]>`SELECT id, name FROM oa_shifts WHERE id = ${input.shiftId} AND store_id = ${store} AND active`;
      if (!shift) throw unprocessable('SCHEDULE_SHIFT', '班次不存在或已停用，请刷新');
      return { group, shift, names: new Map(members.map((m) => [Number(m.id), m.name])) };
    };
    if (input.preview) {
      const today = todayOf(deps);
      const access = await resolveScheduleAccess(sql, req.actor, today);
      const { names } = await check(sql, access.editStaff, access.summary.canEdit);
      return summarize(await planBatch(sql, today, store, staffIds, dates, input.shiftId, input.overwrite, false), names, staffIds.length, dates.length);
    }
    const hash = hashRequest({ staffId: req.actor.id, op: 'schedule_batch', groupId: input.groupId, staffIds, dates, shiftId: input.shiftId, overwrite: input.overwrite, revision: input.revision });
    const key = input.clientKey!;
    return sql.begin(async (tx): Promise<ScheduleBatchResult> => {
      await lockSetup(tx);
      await lockOpKey(tx, key);
      const [seen] = await tx<{ opType: string; requestHash: string; staffId: number }[]>`SELECT op_type, request_hash, staff_id FROM idempotency_keys WHERE key = ${key}`;
      if (seen) {
        if (Number(seen.staffId) !== req.actor.id && !can(req.actor, 'hr.attendance')) throw forbidden('该操作编号属于他人，不能重提');
        if (seen.opType !== 'oa_schedule_save' || seen.requestHash !== hash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重新排');
        return { revision: input.revision!, staff: staffIds.length, days: dates.length, total: 0, write: 0, overwrite: 0, same: 0, skipped: [], changed: 0, saved: { id: input.groupId } };
      }
      await assertNotFenced(tx, key, 'oa_schedule_save', erpOpAbandoned);
      const today = todayOf(deps);
      const access = await resolveScheduleAccess(tx, req.actor, today, { lock: true });
      const { group, shift, names } = await check(tx, access.editStaff, access.summary.canEdit);
      // 这几位员工的考勤锁：与打卡、单格保存、发布串行
      await lockStaffAttendance(tx, staffIds);
      const plan = await planBatch(tx, today, store, staffIds, dates, input.shiftId, input.overwrite, true);
      if (planRevision(plan) !== input.revision) throw conflict('SCHEDULE_CHANGED', '预览以后这些员工的排班、请假或打卡有变化，已重新预览：请核对后再保存');
      const todo = plan.filter((c) => c.action === 'write' || c.action === 'overwrite');
      for (const c of todo) {
        const rows = await tx<CellRow[]>`
          SELECT id, shift_id, consecutive, status, pending_delete, draft_consecutive
          FROM oa_schedules WHERE staff_id = ${c.staffId} AND work_date = ${c.date} AND store_id = ${store} ORDER BY shift_id FOR UPDATE`;
        await applyDraftCell(tx, store, req.actor.id, c.staffId, c.date, rows, { shiftIds: [input.shiftId], consecutive: false });
      }
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${key}, 'oa_schedule_save', ${hash}, ${group.id}, ${req.actor.id})`;
      const result = { ...summarize(plan, names, staffIds.length, dates.length), changed: todo.length, saved: { id: group.id } };
      if (!todo.length) return result;
      const touched = [...new Set(todo.map((c) => c.staffId))];
      const ds = todo.map((c) => c.date).sort();
      const problem = await overlapProblem(tx, touched, ds[0]!, ds.at(-1)!, 'intended');
      if (problem) throw unprocessable('SCHEDULE_OVERLAP', problem);
      const viaGrantIds = access.grantIdsFor('edit', touched);
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_schedule_saved',
        targetType: 'oa_attendance_group',
        targetId: group.id,
        detail: {
          draft: true,
          viaGrantIds,
          batch: { staffIds, dates, shiftId: input.shiftId, shift: shift.name, overwrite: input.overwrite },
          changed: todo.length,
          skipped: result.skipped.length,
          summary: `考勤组「${group.name}」批量保存排班草稿：${staffIds.length} 人 × ${dates.length} 天排「${shift.name}」，改了 ${todo.length} 格、跳过 ${result.skipped.length} 格`,
        },
        ip: req.ip,
      });
      return result;
    });
  });

  // 发布排班（EO5）：把今天起至 to 的未发布改动（草稿、待删、连班改动）正式生效，并仅向有变动的员工推送站内通知
  app.post('/api/oa/attendance/schedule/publish', { preHandler: guard() }, async (req): Promise<SchedulePublishResult> => {
    const input = parse(PublishInput, req.body);
    const store = currentStoreId();
    if (input.storeId !== store) throw conflict('STORE_SWITCHED', '这次发布是在别的门店做的：请换回那家门店再查回或重新发布');
    if (input.to < input.from) throw unprocessable('SCHEDULE_DATES', '结束日期不能早于开始日期');
    if (daysBetween(input.from, input.to) > SCHEDULE_AHEAD_DAYS + 31) throw unprocessable('SCHEDULE_TOO_FAR', '一次发布的日期跨度不能超过排班范围');
    const reqStaffIds = input.staffIds ? [...new Set(input.staffIds)].sort((a, b) => a - b) : null;
    const hash = hashRequest({ staffId: req.actor.id, groupId: input.groupId, from: input.from, to: input.to, staffIds: reqStaffIds });

    return sql.begin(async (tx): Promise<SchedulePublishResult> => {
      await lockSetup(tx);
      await lockOpKey(tx, input.clientKey);
      const [seen] = await tx<{ opType: string; requestHash: string; refId: number; staffId: number }[]>`
        SELECT op_type, request_hash, ref_id, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
      if (seen) {
        if (Number(seen.staffId) !== req.actor.id && !can(req.actor, 'hr.attendance')) throw forbidden('该操作编号属于他人，不能重提');
        if (seen.opType !== 'oa_schedule_publish' || seen.requestHash !== hash) {
          throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重试');
        }
        const [existingPub] = await tx<{ id: number }[]>`SELECT id FROM oa_schedule_publishes WHERE client_key = ${input.clientKey}`;
        const publish = existingPub ? await loadPublishRecord(tx, Number(existingPub.id)) : null;
        return {
          publish,
          staffCount: publish?.staffCount ?? 0,
          cellCount: publish?.cellCount ?? 0,
          replayed: true,
          saved: { id: publish?.id ?? input.groupId },
        };
      }
      await assertNotFenced(tx, input.clientKey, 'oa_schedule_publish', erpOpAbandoned);
      const today = todayOf(deps);
      if (input.to < today) throw unprocessable('SCHEDULE_PAST', '这段日期已经过了，没有可发布的排班');
      const effectiveFrom = input.from < today ? today : input.from;

      const access = await resolveScheduleAccess(tx, req.actor, today, { lock: true });
      if (!access.summary.canPublish) throw forbidden('你没有发布排班的权限');
      const [group] = await tx<{ id: number; name: string }[]>`SELECT id, name FROM oa_attendance_groups WHERE id = ${input.groupId} AND store_id = ${store} AND active`;
      if (!group) throw notFound('考勤组不存在或已停用，请刷新');

      const memberRows = await tx<{ id: number }[]>`
        SELECT s.id FROM oa_group_members m JOIN staff s ON s.id = m.staff_id WHERE m.group_id = ${group.id} AND ${storeEmployee(tx)} ORDER BY s.id`;
      const groupMemberSet = new Set(memberRows.map((m) => Number(m.id)));
      let targetStaffIds: number[];
      if (reqStaffIds) {
        if (reqStaffIds.some((id) => !groupMemberSet.has(id))) throw unprocessable('SCHEDULE_MEMBER', '有员工已经不在这个考勤组里或已离职，请刷新');
        if (reqStaffIds.some((id) => !access.publishStaff.has(id))) throw forbidden('所选员工中包含超出你发布授权范围的人员');
        targetStaffIds = reqStaffIds;
      } else {
        targetStaffIds = memberRows.map((m) => Number(m.id)).filter((id) => access.publishStaff.has(id));
        if (!targetStaffIds.length) throw forbidden('这个考勤组里没有你有权限发布排班的员工');
      }

      await lockStaffAttendance(tx, targetStaffIds);
      const pendingRows = await tx<{ id: number; staffId: number; workDate: string; shiftId: number; status: 'draft' | 'published'; pendingDelete: boolean; draftConsecutive: boolean | null }[]>`
        SELECT id, staff_id, work_date::text AS work_date, shift_id, status, pending_delete, draft_consecutive
        FROM oa_schedules
        WHERE store_id = ${store} AND staff_id IN ${tx(targetStaffIds)}
          AND work_date BETWEEN ${effectiveFrom} AND ${input.to}
          AND (status = 'draft' OR pending_delete OR draft_consecutive IS NOT NULL)
        ORDER BY staff_id, work_date, shift_id
        FOR UPDATE`;

      if (!pendingRows.length) {
        await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'oa_schedule_publish', ${hash}, ${group.id}, ${req.actor.id})`;
        return { publish: null, staffCount: 0, cellCount: 0, replayed: false, saved: { id: group.id } };
      }

      // 再次核对要删除的已发布班次没有在草稿期间被打过卡
      const deletesByCell = new Map<string, { staffId: number; date: string; shiftIds: number[]; rowIds: number[] }>();
      for (const r of pendingRows) {
        if (!r.pendingDelete) continue;
        const k = `${r.staffId}|${r.workDate}`;
        const cur = deletesByCell.get(k) ?? { staffId: Number(r.staffId), date: r.workDate, shiftIds: [], rowIds: [] };
        cur.shiftIds.push(Number(r.shiftId));
        cur.rowIds.push(Number(r.id));
        deletesByCell.set(k, cur);
      }
      for (const d of deletesByCell.values()) {
        if ((await punchedShifts(tx, d.staffId, d.date, d.shiftIds)).length) {
          throw unprocessable('SCHEDULE_PUNCHED', `${d.date} 要去掉的班次已经有打卡，不能发布删除；请刷新排班后再调整`);
        }
      }

      const byStaff = new Map<number, Set<string>>();
      const cellKeys = new Set<string>();
      for (const r of pendingRows) {
        const sid = Number(r.staffId);
        cellKeys.add(`${sid}|${r.workDate}`);
        const ds = byStaff.get(sid) ?? new Set<string>();
        ds.add(r.workDate);
        byStaff.set(sid, ds);
      }
      const affectedStaffIds = [...byStaff.keys()].sort((a, b) => a - b);
      const cellCount = cellKeys.size;
      const staffCount = affectedStaffIds.length;

      const [pubRow] = await tx<{ id: number }[]>`
        INSERT INTO oa_schedule_publishes (store_id, group_id, from_date, to_date, staff_count, cell_count, published_by, client_key)
        VALUES (${store}, ${group.id}, ${effectiveFrom}::date, ${input.to}::date, ${staffCount}, ${cellCount}, ${req.actor.id}, ${input.clientKey})
        RETURNING id`;
      const pubId = Number(pubRow!.id);

      // 1. 删除 pending_delete 的旧行，同时清理未打卡且已结算的对应日结行
      for (const d of deletesByCell.values()) {
        await tx`DELETE FROM oa_schedules WHERE id IN ${tx(d.rowIds)}`;
        await tx`DELETE FROM oa_attendance_daily WHERE staff_id = ${d.staffId} AND business_date = ${d.date} AND shift_id IN ${tx(d.shiftIds)}`;
      }
      // 2. 草稿行转为已发布
      const draftIds = pendingRows.filter((r) => r.status === 'draft').map((r) => Number(r.id));
      if (draftIds.length) {
        await tx`
          UPDATE oa_schedules
          SET status = 'published', published_at = now(), published_by = ${req.actor.id}, publish_id = ${pubId},
              updated_by = ${req.actor.id}, updated_at = now()
          WHERE id IN ${tx(draftIds)}`;
      }
      // 3. 已发布行的连班草稿变更生效
      const consecIds = pendingRows.filter((r) => r.status === 'published' && !r.pendingDelete && r.draftConsecutive !== null).map((r) => Number(r.id));
      if (consecIds.length) {
        await tx`
          UPDATE oa_schedules
          SET consecutive = draft_consecutive, draft_consecutive = NULL,
              published_at = now(), published_by = ${req.actor.id}, publish_id = ${pubId},
              updated_by = ${req.actor.id}, updated_at = now()
          WHERE id IN ${tx(consecIds)}`;
      }

      // 核对生效后的线上排班无打卡时段重叠（防止局部发布与范围外旧排班冲突）
      const allDates = [...new Set(pendingRows.map((r) => r.workDate))].sort();
      const problem = await overlapProblem(tx, affectedStaffIds, allDates[0]!, allDates[allDates.length - 1]!, 'published');
      if (problem) throw unprocessable('SCHEDULE_OVERLAP', problem);

      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'oa_schedule_publish', ${hash}, ${pubId}, ${req.actor.id})`;

      // 排班发布后，仅向排班有变动的员工推送站内通知（同一人没读的只留一条，更新内容）
      for (const [staffId, dateSet] of byStaff) {
        const ds = [...dateSet].sort();
        await notify(tx, [staffId], {
          kind: 'schedule_change',
          title: '排班已发布',
          body: `${ds.slice(0, 6).join('、')}${ds.length > 6 ? ` 等 ${ds.length} 天` : ''}的排班已发布更新，点开看「我的排班」`,
          link: '/oa/schedule',
          ref: { type: 'oa_schedule', id: staffId },
        });
      }

      const viaGrantIds = access.grantIdsFor('publish', affectedStaffIds);
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_schedule_published',
        targetType: 'oa_attendance_group',
        targetId: group.id,
        detail: {
          publishId: pubId,
          from: effectiveFrom,
          to: input.to,
          staffCount,
          cellCount,
          staffIds: affectedStaffIds,
          viaGrantIds,
          summary: `考勤组「${group.name}」发布排班（${effectiveFrom} 至 ${input.to}）：${staffCount} 人、${cellCount} 格`,
        },
        ip: req.ip,
      });

      const publish = await loadPublishRecord(tx, pubId);
      return { publish, staffCount, cellCount, replayed: false, saved: { id: pubId } };
    });
  });

  // 员工「我的排班」：本人一个月已发布的排班（各门店的都算）；登录就能看
  app.get('/api/oa/me/schedule', { preHandler: guard() }, async (req): Promise<MySchedule> => {
    const q = parse(MonthQuery, req.query ?? {});
    const today = todayOf(deps);
    const month = q.month ?? today.slice(0, 7);
    const first = `${month}-01`;
    const [y, m] = month.split('-').map(Number) as [number, number];
    const end = shiftDate(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1);
    const rows = await sql<{ workDate: string; shiftId: number; name: string; startMinute: number; endMinute: number; inAdvanceMinutes: number; consecutive: boolean }[]>`
      SELECT o.work_date::text AS work_date, o.shift_id, sh.name, sh.start_minute, sh.end_minute, sh.in_advance_minutes, o.consecutive
      FROM oa_schedules o JOIN oa_shifts sh ON sh.id = o.shift_id
      WHERE o.staff_id = ${req.actor.id} AND o.status = 'published' AND ${liveSchedule(sql)} AND o.work_date BETWEEN ${first} AND ${shiftDate(end, 1)}
      ORDER BY o.work_date, sh.start_minute`;
    const itemsOf = (d: string) =>
      rows
        .filter((r) => r.workDate === d)
        .map((r) => ({
          shiftId: Number(r.shiftId),
          name: r.name,
          startMinute: r.startMinute,
          endMinute: r.endMinute,
          inAdvanceMinutes: r.inAdvanceMinutes,
          consecutive: r.consecutive,
        }));
    // 每一天的状态（排班优化第 4 条）：请假（审批通过的覆盖）＞ 缺勤（有一班结算成旷工）＞ 上班 ＞ 休息；只是显示
    const leaves = await sql<{ workDate: string; part: 'full' | 'am' | 'pm' }[]>`
      SELECT work_date::text AS work_date, part FROM oa_attendance_covers
      WHERE staff_id = ${req.actor.id} AND kind = 'leave' AND work_date BETWEEN ${first} AND ${end} ORDER BY work_date, id`;
    const absent = await sql<{ businessDate: string }[]>`
      SELECT DISTINCT business_date::text AS business_date FROM oa_attendance_daily
      WHERE staff_id = ${req.actor.id} AND status = 'absent' AND business_date BETWEEN ${first} AND ${end}`;
    const leaveOf = new Map<string, 'full' | 'am' | 'pm'>();
    for (const l of leaves) leaveOf.set(l.workDate, leaveOf.has(l.workDate) && leaveOf.get(l.workDate) !== l.part ? 'full' : l.part);
    const absentDays = new Set(absent.map((a) => a.businessDate));
    const days: MySchedule['days'] = [];
    for (let d = first; d <= end; d = shiftDate(d, 1)) {
      const items = itemsOf(d);
      const leavePart = leaveOf.get(d);
      const status: MyDayStatus = leavePart ? 'leave' : absentDays.has(d) ? 'absent' : items.length ? 'work' : 'rest';
      days.push({ date: d, items, status, ...(leavePart ? { leavePart } : {}) });
    }
    // 下个月 1 号的也带上：00:00 上班的要在这个月最后一天写「今晚 24:00 上班」
    const next = shiftDate(end, 1);
    return { month, today, days, following: { date: next, items: itemsOf(next) } };
  });
}
