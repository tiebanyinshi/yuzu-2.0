// OA-05 排班的打卡时段重叠核对（docs/OA.md 第 8 节）：保存排班、修改班次时间都要核对，放在一处。
// 同一人两条排班的打卡时段（上班卡最早 ～ 下班卡最晚）重叠就分不清一次打卡算哪一条（OA-06），标了连班的那一对除外。

import { scheduleSpan } from '@shared/oa';
import { shiftDate } from '@shared/labels';
import { shiftTimeText } from '@shared/technician-admin';
import type { Db, Tx } from '../../db';
import { DEFAULT_STORE_ID } from '../../lib/store-context';

/**
 * 查重叠要往前后看几天：一条排班的打卡时段最早从当天 00:00 前 12 小时（提前上限 720 分钟）起，
 * 最晚到第二天结束后 12 小时（班长最多 24 小时，延后上限 720 分钟），两天以上的也可能重叠
 */
export const OVERLAP_LOOKAROUND_DAYS = Math.ceil((720 + 1440 + 1440 + 720) / 1440);

/**
 * 还算数的排班（表别名 o）：员工还属于排班所在的门店。调走的员工在原门店今后的排班不再算数（不参与重叠核对、不在「我的排班」里），
 * 历史排班照旧留着；没登记门店归属的员工按默认门店算（与 storeEmployee 一致）
 */
export const liveSchedule = (db: Db) => db`
  (EXISTS (SELECT 1 FROM staff_stores x WHERE x.staff_id = o.staff_id AND x.store_id = o.store_id)
   OR (NOT EXISTS (SELECT 1 FROM staff_stores x WHERE x.staff_id = o.staff_id) AND o.store_id = ${DEFAULT_STORE_ID}::bigint))`;

/**
 * 这几位员工在 from ～ to 之间的排班，与前后几天的排班打卡时段重叠：返回说明（标了连班的那一对不算）。
 * 只报至少有一条落在 from ～ to 里的那一对（范围外的老排班之间不算到这一次头上）
 */
export async function overlapProblem(tx: Tx, staffIds: number[], from: string, to: string): Promise<string | null> {
  if (!staffIds.length) return null;
  const rows = await tx<
    { staffId: number; workDate: string; consecutive: boolean; name: string; staffName: string; startMinute: number; endMinute: number; inAdvanceMinutes: number; outDelayMinutes: number }[]
  >`
    SELECT o.staff_id, o.work_date::text AS work_date, o.consecutive, sh.name, s.display_name AS staff_name,
           sh.start_minute, sh.end_minute, sh.in_advance_minutes, sh.out_delay_minutes
    FROM oa_schedules o JOIN oa_shifts sh ON sh.id = o.shift_id JOIN staff s ON s.id = o.staff_id
    WHERE o.staff_id IN ${tx(staffIds)} AND ${liveSchedule(tx)} AND o.work_date BETWEEN ${shiftDate(from, -OVERLAP_LOOKAROUND_DAYS)} AND ${shiftDate(to, OVERLAP_LOOKAROUND_DAYS)}
    ORDER BY o.staff_id, o.work_date, sh.start_minute`;
  // 按员工分开、按打卡时段开始排序，往后比到开始时间已经不早于这一条的结束为止（不两两全比：几千人 × 几十天的排班也不卡住）
  const byStaff = new Map<number, ((typeof rows)[number] & { from: number; to: number; inRange: boolean })[]>();
  for (const r of rows) {
    const list = byStaff.get(Number(r.staffId)) ?? [];
    list.push({ ...r, ...scheduleSpan(r.workDate, r), inRange: r.workDate >= from && r.workDate <= to });
    byStaff.set(Number(r.staffId), list);
  }
  for (const spans of byStaff.values()) {
    spans.sort((x, y) => x.from - y.from);
    for (let i = 0; i < spans.length; i += 1) {
      const a = spans[i]!;
      for (let j = i + 1; j < spans.length && spans[j]!.from < a.to; j += 1) {
        const b = spans[j]!;
        if (a.consecutive || b.consecutive || !(a.inRange || b.inRange)) continue;
        return `${a.staffName}：${a.workDate}「${a.name}」与 ${b.workDate}「${b.name}」的打卡时间段重叠（${shiftTimeText(a)} / ${shiftTimeText(b)}），分不清打卡算哪一班；确实是连班的请勾「连班」`;
      }
    }
  }
  return null;
}

/**
 * 员工的考勤锁（按员工 id 升序取）：打卡与保存排班都先取它再读写这位员工的排班与打卡（docs/LOCKING.md「打卡」）。
 * 保存排班会把改了的格子删了重写，只锁排班行的话，同时到的打卡可能读不到被重写的那一班（Codex 审查 10545e1）
 */
export async function lockStaffAttendance(tx: Tx, staffIds: readonly number[]): Promise<void> {
  for (const id of [...new Set(staffIds)].sort((a, b) => a - b)) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`oa_attendance_staff:${id}`}, 0))`;
}
