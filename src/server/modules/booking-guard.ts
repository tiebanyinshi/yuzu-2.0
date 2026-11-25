// 前台派钟、挂技师项目、加钟与技师预约不重叠（v0.7.28，测试会话预检 ded1958 的 P2）。
//
// 预约新建、改时间时在「技师预约」这把咨询锁里核对技师没结束的钟单；这里反过来：建钟单、加钟前取同一把锁，
// 核对这位技师在这一钟计划的时段里有没有还占着时段的预约（待确认、已确认，指定了这位技师的）。两边串行，先提交的那边算数，
// 后到的看得到、拒绝。预约的客人到了要先在「预约」里点到店（预约就不再占时段）；这位客人自己约的这位技师不拦。
// 锁：技师队列锁（调用方已取）之后取这把咨询锁；预约新建、改时间只取这把锁、不取技师队列锁，不会互相等成环。

import { ACTIVE_BOOKING_STATUSES, DEFAULT_BOOKING_RULES, type BookingRules } from '@shared/bookings';
import type { Db, Tx } from '../db';
import { conflict } from '../lib/errors';
import { lockOpKey } from '../lib/fences';
import { settingRow } from '../lib/store-settings';

/**
 * 预约开始前锁技师多少毫秒（8.1.38，预约规则「技师预约开始前锁定技师」，默认 30 分钟）：预约占的时段从「开始 − 提前量」算起，
 * 这段等客人的时间里技师不会被当作空闲派给别人（店主 2026-11-25「扩钟预约状态漏洞」）。不 import bookings.ts（它 import 这里）
 */
export async function technicianHoldMs(db: Db): Promise<number> {
  const row = await settingRow<Partial<BookingRules>>(db, 'booking_rules');
  return (row?.value?.technicianHoldMinutes ?? DEFAULT_BOOKING_RULES.technicianHoldMinutes) * 60_000;
}

/** 技师预约全部串行的那把咨询锁（预约新建、改时间与建钟单、加钟共用） */
export const lockTechnicianBookings = (tx: Tx) => lockOpKey(tx, 'booking:technicians');

const hm = (at: Date, timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

/**
 * 这位技师在 [from, to) 里有还占着时段的预约就拒绝（TECHNICIAN_BOOKED）。memberId：这一钟的客人是会员时，
 * 这位会员自己约的预约不算冲突（同一位客人）
 */
export async function assertTechnicianNotBooked(tx: Tx, a: { technicianId: number; techLabel: string; from: number; to: number; memberId: number | null; timeZone: string }): Promise<void> {
  if (a.to <= a.from) return;
  await lockTechnicianBookings(tx);
  const hold = await technicianHoldMs(tx);
  const [b] = await tx<{ bookingNo: string; startsAt: Date; endsAt: Date; who: string }[]>`
    SELECT b.booking_no, b.starts_at, b.ends_at, coalesce(m.name, nullif(b.guest_name, ''), '客人') AS who
    FROM bookings b LEFT JOIN members m ON m.id = b.member_id
    WHERE b.technician_id = ${a.technicianId} AND b.status IN ${tx(ACTIVE_BOOKING_STATUSES)}
      AND b.starts_at < ${new Date(a.to + hold)} AND b.ends_at > ${new Date(a.from)}
      AND (b.member_id IS NULL OR b.member_id IS DISTINCT FROM ${a.memberId})
    ORDER BY b.starts_at LIMIT 1`;
  if (!b) return;
  throw conflict(
    'TECHNICIAN_BOOKED',
    `${a.techLabel} ${hm(new Date(b.startsAt), a.timeZone)}–${hm(new Date(b.endsAt), a.timeZone)} 有预约（${b.bookingNo}，${b.who}），这一钟会和预约冲突：` +
      '是预约的客人到了，请先在「预约」里点到店；否则请换一位技师或等预约之后' +
      (hold > 0 ? `（预约开始前 ${hold / 60_000} 分钟起技师就锁给预约的客人）` : ''),
    { bookingNo: b.bookingNo },
  );
}

/**
 * 这几位技师里，在 [from, to) 有还占着时段的预约的（8.1.37：轮钟「该派给谁」先把他们排除——真派给他会被上面拒绝，
 * 不排除的话排在他后面的人都得写原因跳过他，还给他记一条跳过）。只读，不取锁（调用方派钟时会取）
 */
export async function bookedTechnicianIds(tx: Tx, a: { technicianIds: number[]; from: number; to: number; memberId: number | null }): Promise<Set<number>> {
  if (a.technicianIds.length === 0 || a.to <= a.from) return new Set();
  const hold = await technicianHoldMs(tx);
  const rows = await tx<{ technicianId: number }[]>`
    SELECT DISTINCT b.technician_id FROM bookings b
    WHERE b.technician_id IN ${tx(a.technicianIds)} AND b.status IN ${tx(ACTIVE_BOOKING_STATUSES)}
      AND b.starts_at < ${new Date(a.to + hold)} AND b.ends_at > ${new Date(a.from)}
      AND (b.member_id IS NULL OR b.member_id IS DISTINCT FROM ${a.memberId})`;
  return new Set(rows.map((r) => Number(r.technicianId)));
}

/**
 * 每位技师今天接下来的预约（8.1.38：前台选技师、钟房派钟的格子上写「几点有预约」，锁定期内写「已锁给预约」）。
 * 只看还占着时段、还没结束的；只读、不取锁
 */
export async function upcomingTechnicianBookings(db: Db, at: Date, withinMs = 24 * 3600_000): Promise<Map<number, { startsAt: string; locked: boolean }>> {
  const hold = await technicianHoldMs(db);
  const rows = await db<{ technicianId: number; startsAt: Date }[]>`
    SELECT DISTINCT ON (b.technician_id) b.technician_id, b.starts_at FROM bookings b
    WHERE b.technician_id IS NOT NULL AND b.status IN ${db(ACTIVE_BOOKING_STATUSES)}
      AND b.ends_at > ${at} AND b.starts_at < ${new Date(at.getTime() + withinMs)}
    ORDER BY b.technician_id, b.starts_at`;
  return new Map(rows.map((r) => [Number(r.technicianId), { startsAt: new Date(r.startsAt).toISOString(), locked: new Date(r.startsAt).getTime() - hold <= at.getTime() }]));
}
