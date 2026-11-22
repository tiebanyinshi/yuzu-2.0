// OA-05 排班（docs/OA.md 第 8 节；需求文档四（三））。
//   · 后台「考勤设置 → 排班」：考勤组 × 日期，一格一个或几个班次（连班），空着 = 休息。只能改今天及以后的日子。
//   · 保存按格子提交，每一格带着页面上看到的原排班：别人先改过的拒绝（SCHEDULE_CHANGED）；已经是要的样子的跳过（原样重提照常成功）。
//   · 同一人前后相邻的排班打卡时段不能重叠（OA-06 分不清一次打卡算哪一条），标了连班的除外。
//   · 部门负责人（hr.attendanceDept）只看本部门员工的排班，不能改。
//   · 员工「我的排班」：本人一个月的排班。排班有变的员工收到站内通知（同一人没读的只留一条）。
// 加锁（docs/LOCKING.md「排班」）：门店的考勤设置咨询锁（与班次、考勤组的保存串行）→ 排班行（按员工、日期改）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  departmentOfPosition,
  SCHEDULE_AHEAD_DAYS,
  SCHEDULE_MAX_DAYS,
  SCHEDULE_MAX_SHIFTS_PER_DAY,
  scheduleSpan,
  type MySchedule,
  type OaShift,
  type ScheduleCell,
  type ScheduleWeek,
} from '@shared/oa';
import { shiftDate } from '@shared/labels';
import { can } from '@shared/permissions';
import { shiftTimeText } from '@shared/technician-admin';
import type { Db, Tx } from '../../db';
import { guard, guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { daysBetween } from '../../lib/dates';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { currentStoreId } from '../../lib/store-context';
import { dateSchema, parse } from '../../lib/validate';
import { businessDate } from '../frontdesk/common';
import { lockSetup, SHIFT_COLS, storeEmployee } from './attendance-setup';
import { notify } from './notifications';

const view = guardAny('hr.attendance', 'hr.attendanceDept');
const manage = guard('hr.attendance');

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
  groupId: z.number().int().positive(),
  cells: z
    .array(
      CellState.extend({
        staffId: z.number().int().positive(),
        date: dateSchema('日期'),
        /** 页面上看到的原排班：别人先改过就拒绝 */
        expected: CellState,
      }),
    )
    .min(1, '没有要保存的格子')
    .max(500, '一次最多保存 500 格，请分几次保存'),
});

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

const todayOf = (db: Db, deps: Deps) => businessDate(db, deps, new Date());

/** 能看哪些员工：hr.attendance 全部；只有 hr.attendanceDept 的只看本部门（同部门的岗位） */
function deptFilter(db: Db, actor: Actor) {
  if (can(actor, 'hr.attendance')) return db`true`;
  const dept = departmentOfPosition(actor.position);
  if (!dept || dept === 'company') return db`false`;
  return dept === 'gmo' ? db`s.position = 'gmo'` : db`(s.position = ${`${dept}.lead`} OR s.position = ${`${dept}.staff`})`;
}

async function loadWeek(db: Db, deps: Deps, actor: Actor, q: z.infer<typeof WeekQuery>): Promise<ScheduleWeek> {
  const store = currentStoreId();
  const today = await todayOf(db, deps);
  const from = q.from ?? today;
  const to = shiftDate(from, q.days - 1);
  const groups = await db<{ id: number; name: string }[]>`
    SELECT g.id, g.name FROM oa_attendance_groups g
    WHERE g.store_id = ${store} AND g.active
      AND EXISTS (SELECT 1 FROM oa_group_members m JOIN staff s ON s.id = m.staff_id WHERE m.group_id = g.id AND ${storeEmployee(db)} AND ${deptFilter(db, actor)})
    ORDER BY g.id`;
  const list = groups.map((g) => ({ id: Number(g.id), name: g.name }));
  const group = (q.groupId ? list.find((g) => g.id === q.groupId) : list[0]) ?? null;
  if (q.groupId && !group) throw notFound('考勤组不存在，或其中没有你能看的员工');
  const members = group
    ? await db<{ staffId: number; name: string; position: ScheduleWeek['members'][number]['position'] }[]>`
        SELECT s.id AS staff_id, s.display_name AS name, s.position FROM oa_group_members m JOIN staff s ON s.id = m.staff_id
        WHERE m.group_id = ${group.id} AND ${storeEmployee(db)} AND ${deptFilter(db, actor)} ORDER BY s.id`
    : [];
  const ids = members.map((m) => Number(m.staffId));
  const rows = ids.length
    ? await db<{ staffId: number; workDate: string; shiftId: number; consecutive: boolean }[]>`
        SELECT staff_id, work_date::text AS work_date, shift_id, consecutive FROM oa_schedules
        WHERE store_id = ${store} AND staff_id IN ${db(ids)} AND work_date BETWEEN ${from} AND ${to} ORDER BY staff_id, work_date, shift_id`
    : [];
  const cells = new Map<string, ScheduleCell>();
  for (const r of rows) {
    const key = `${r.staffId}|${r.workDate}`;
    const c = cells.get(key) ?? { staffId: Number(r.staffId), date: r.workDate, shiftIds: [], consecutive: false };
    c.shiftIds.push(Number(r.shiftId));
    c.consecutive = c.consecutive || r.consecutive;
    cells.set(key, c);
  }
  const usedShifts = [...new Set(rows.map((r) => Number(r.shiftId)))];
  const shifts = await db<OaShift[]>`
    SELECT ${SHIFT_COLS(db)} FROM oa_shifts WHERE store_id = ${store} AND (active ${usedShifts.length ? db`OR id IN ${db(usedShifts)}` : db``}) ORDER BY start_minute, id`;
  return {
    groups: list,
    group,
    from,
    to,
    today,
    editable: can(actor, 'hr.attendance'),
    members: members.map((m) => ({ staffId: Number(m.staffId), name: m.name, position: m.position })),
    shifts: shifts.map((s) => ({ ...s, id: Number(s.id) })),
    cells: [...cells.values()],
  };
}

type Placed = { staffId: number; date: string; shiftId: number; consecutive: boolean };

/** 同一人前后相邻的排班打卡时段重叠：返回说明（标了连班的那一对不算） */
async function overlapProblem(tx: Tx, staffIds: number[], from: string, to: string): Promise<string | null> {
  const rows = await tx<(Placed & { workDate: string; name: string; staffName: string; startMinute: number; endMinute: number; inAdvanceMinutes: number; outDelayMinutes: number })[]>`
    SELECT o.staff_id, o.work_date::text AS work_date, o.shift_id, o.consecutive, sh.name, s.display_name AS staff_name,
           sh.start_minute, sh.end_minute, sh.in_advance_minutes, sh.out_delay_minutes
    FROM oa_schedules o JOIN oa_shifts sh ON sh.id = o.shift_id JOIN staff s ON s.id = o.staff_id
    WHERE o.staff_id IN ${tx(staffIds)} AND o.work_date BETWEEN ${shiftDate(from, -1)} AND ${shiftDate(to, 1)}
    ORDER BY o.staff_id, o.work_date, sh.start_minute`;
  const spans = rows.map((r) => ({ ...r, ...scheduleSpan(r.workDate, r) }));
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      const a = spans[i]!;
      const b = spans[j]!;
      if (Number(a.staffId) !== Number(b.staffId) || a.consecutive || b.consecutive) continue;
      if (a.from < b.to && b.from < a.to) {
        return `${a.staffName}：${a.workDate}「${a.name}」与 ${b.workDate}「${b.name}」的打卡时间段重叠（${shiftTimeText(a)} / ${shiftTimeText(b)}），分不清打卡算哪一班；确实是连班的请勾「连班」`;
      }
    }
  }
  return null;
}

export function registerOaScheduleRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/oa/attendance/schedule', { preHandler: view }, async (req) => loadWeek(sql, deps, req.actor, parse(WeekQuery, req.query ?? {})));

  app.put('/api/oa/attendance/schedule', { preHandler: manage }, async (req) => {
    const input = parse(SaveInput, req.body);
    const store = currentStoreId();
    const keys = new Set<string>();
    for (const c of input.cells) {
      const k = `${c.staffId}|${c.date}`;
      if (keys.has(k)) throw unprocessable('SCHEDULE_DUPLICATE', '同一人同一天提交了两次，请刷新后再排');
      keys.add(k);
      if (new Set(c.shiftIds).size !== c.shiftIds.length) throw unprocessable('SCHEDULE_DUPLICATE', '同一天选了两次同一个班次');
    }
    const changed = await sql.begin(async (tx) => {
      await lockSetup(tx);
      const today = await todayOf(tx, deps);
      const [group] = await tx<{ id: number; name: string }[]>`SELECT id, name FROM oa_attendance_groups WHERE id = ${input.groupId} AND store_id = ${store} AND active`;
      if (!group) throw notFound('考勤组不存在或已停用，请刷新');
      const staffIds = [...new Set(input.cells.map((c) => c.staffId))].sort((a, b) => a - b);
      const members = await tx<{ id: number }[]>`
        SELECT s.id FROM oa_group_members m JOIN staff s ON s.id = m.staff_id WHERE m.group_id = ${group.id} AND s.id IN ${tx(staffIds)} AND ${storeEmployee(tx)}`;
      if (members.length !== staffIds.length) throw unprocessable('SCHEDULE_MEMBER', '有员工已经不在这个考勤组里或已离职，请刷新');
      const shiftIds = [...new Set(input.cells.flatMap((c) => c.shiftIds))];
      if (shiftIds.length) {
        const ok = await tx<{ id: number }[]>`SELECT id FROM oa_shifts WHERE store_id = ${store} AND active AND id IN ${tx(shiftIds)}`;
        if (ok.length !== shiftIds.length) throw unprocessable('SCHEDULE_SHIFT', '有班次不存在或已停用，请刷新');
      }
      const changes: { staffId: number; date: string; before: z.infer<typeof CellState>; after: z.infer<typeof CellState> }[] = [];
      for (const c of [...input.cells].sort((a, b) => a.staffId - b.staffId || a.date.localeCompare(b.date))) {
        const rows = await tx<{ shiftId: number; consecutive: boolean }[]>`
          SELECT shift_id, consecutive FROM oa_schedules WHERE staff_id = ${c.staffId} AND work_date = ${c.date} AND store_id = ${store} FOR UPDATE`;
        const current = { shiftIds: rows.map((r) => Number(r.shiftId)), consecutive: rows.some((r) => r.consecutive) };
        const want = { shiftIds: c.shiftIds, consecutive: c.shiftIds.length ? c.consecutive : false };
        if (sameSet(current.shiftIds, want.shiftIds) && current.consecutive === want.consecutive) continue;
        if (!sameSet(current.shiftIds, c.expected.shiftIds) || current.consecutive !== (c.expected.shiftIds.length ? c.expected.consecutive : false)) {
          throw conflict('SCHEDULE_CHANGED', `${c.date} 这一格刚被别人改过，请刷新后再排`);
        }
        if (c.date < today) throw unprocessable('SCHEDULE_PAST', `${c.date} 已经过了，不能再改排班`);
        if (daysBetween(today, c.date) > SCHEDULE_AHEAD_DAYS) throw unprocessable('SCHEDULE_TOO_FAR', `最远排到 ${SCHEDULE_AHEAD_DAYS} 天以后`);
        await tx`DELETE FROM oa_schedules WHERE staff_id = ${c.staffId} AND work_date = ${c.date} AND store_id = ${store}`;
        for (const shiftId of want.shiftIds) {
          await tx`
            INSERT INTO oa_schedules (staff_id, work_date, shift_id, consecutive, created_by, updated_by)
            VALUES (${c.staffId}, ${c.date}, ${shiftId}, ${want.consecutive}, ${req.actor.id}, ${req.actor.id})`;
        }
        changes.push({ staffId: c.staffId, date: c.date, before: current, after: want });
      }
      if (!changes.length) return [];
      const dates = changes.map((x) => x.date).sort();
      const problem = await overlapProblem(tx, [...new Set(changes.map((x) => x.staffId))], dates[0]!, dates[dates.length - 1]!);
      if (problem) throw unprocessable('SCHEDULE_OVERLAP', problem);
      // 排班有变的员工收到站内通知（同一人没读的只留一条，更新内容）
      const byStaff = new Map<number, string[]>();
      for (const x of changes) byStaff.set(x.staffId, [...(byStaff.get(x.staffId) ?? []), x.date]);
      for (const [staffId, ds] of byStaff) {
        await notify(tx, [staffId], {
          kind: 'schedule_change',
          title: '排班有变动',
          body: `${ds.slice(0, 6).join('、')}${ds.length > 6 ? ` 等 ${ds.length} 天` : ''}的排班改了，点开看「我的排班」`,
          link: '/oa/schedule',
          ref: { type: 'oa_schedule', id: staffId },
        });
      }
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_schedule_saved',
        targetType: 'oa_attendance_group',
        targetId: group.id,
        detail: { changes, summary: `考勤组「${group.name}」排班：改了 ${changes.length} 格（${dates[0]} 至 ${dates[dates.length - 1]}）` },
        ip: req.ip,
      });
      return changes;
    });
    return { changed: changed.length };
  });

  // 员工「我的排班」：本人一个月（各门店的都算）；登录就能看
  app.get('/api/oa/me/schedule', { preHandler: guard() }, async (req): Promise<MySchedule> => {
    const q = parse(MonthQuery, req.query ?? {});
    const today = await todayOf(sql, deps);
    const month = q.month ?? today.slice(0, 7);
    const first = `${month}-01`;
    const [y, m] = month.split('-').map(Number) as [number, number];
    const end = shiftDate(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1);
    const rows = await sql<{ workDate: string; shiftId: number; name: string; startMinute: number; endMinute: number; consecutive: boolean }[]>`
      SELECT o.work_date::text AS work_date, o.shift_id, sh.name, sh.start_minute, sh.end_minute, o.consecutive
      FROM oa_schedules o JOIN oa_shifts sh ON sh.id = o.shift_id
      WHERE o.staff_id = ${req.actor.id} AND o.work_date BETWEEN ${first} AND ${end}
      ORDER BY o.work_date, sh.start_minute`;
    const days: MySchedule['days'] = [];
    for (let d = first; d <= end; d = shiftDate(d, 1)) {
      days.push({
        date: d,
        items: rows.filter((r) => r.workDate === d).map((r) => ({ shiftId: Number(r.shiftId), name: r.name, startMinute: r.startMinute, endMinute: r.endMinute, consecutive: r.consecutive })),
      });
    }
    return { month, today, days };
  });
}
