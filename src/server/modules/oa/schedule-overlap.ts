// OA-05 排班的打卡时段重叠核对（docs/OA.md 第 8 节）：保存排班、修改班次时间都要核对，放在一处。
// 同一人两条排班的打卡时段（上班卡最早 ～ 下班卡最晚）重叠就分不清一次打卡算哪一条（OA-06），标了连班的那一对除外。

import { scheduleSpan } from '@shared/oa';
import { shiftDate } from '@shared/labels';
import { shiftTimeText } from '@shared/technician-admin';
import type { Tx } from '../../db';

/**
 * 查重叠要往前后看几天：一条排班的打卡时段最早从当天 00:00 前 12 小时（提前上限 720 分钟）起，
 * 最晚到第二天结束后 12 小时（班长最多 24 小时，延后上限 720 分钟），两天以上的也可能重叠
 */
export const OVERLAP_LOOKAROUND_DAYS = Math.ceil((720 + 1440 + 1440 + 720) / 1440);

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
    WHERE o.staff_id IN ${tx(staffIds)} AND o.work_date BETWEEN ${shiftDate(from, -OVERLAP_LOOKAROUND_DAYS)} AND ${shiftDate(to, OVERLAP_LOOKAROUND_DAYS)}
    ORDER BY o.staff_id, o.work_date, sh.start_minute`;
  const spans = rows.map((r) => ({ ...r, ...scheduleSpan(r.workDate, r), inRange: r.workDate >= from && r.workDate <= to }));
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      const a = spans[i]!;
      const b = spans[j]!;
      if (Number(a.staffId) !== Number(b.staffId) || a.consecutive || b.consecutive || !(a.inRange || b.inRange)) continue;
      if (a.from < b.to && b.from < a.to) {
        return `${a.staffName}：${a.workDate}「${a.name}」与 ${b.workDate}「${b.name}」的打卡时间段重叠（${shiftTimeText(a)} / ${shiftTimeText(b)}），分不清打卡算哪一班；确实是连班的请勾「连班」`;
      }
    }
  }
  return null;
}
