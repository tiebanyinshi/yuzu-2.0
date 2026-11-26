// 房态页上的「今天的预约」（8.1.44，《前台系统开发》「房态显示当天预约单」，docs/V8144_FRONTDESK.md 第 4 条）：
// 当天的技师、派对房、客房预约按时间列出来（取消的不列），看房的时候知道一会儿谁要来、约了哪间。
// 只读：数据跟着房态看板一起取（不另起定时取数）；确认、到店、取消照旧在预约看板做。

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CalendarClock } from 'lucide-react';
import { BOOKING_KIND_LABELS, BOOKING_STATUS_LABELS, type BookingStatus } from '@shared/bookings';
import type { RoomCenterBooking } from '@shared/room-center';
import { useCan } from '../../lib/session';
import { formatTime } from '../../lib/utils';
import { Badge, Button } from '../../components/ui';

/** 收起时列几张：还没到店的排前面 */
const FOLDED = 4;

const STATUS_TONE: Record<BookingStatus, 'yuzu' | 'pine' | 'neutral' | 'clay' | 'lake'> = {
  pending: 'yuzu',
  confirmed: 'lake',
  arrived: 'pine',
  cancelled: 'neutral',
  no_show: 'clay',
};

export function TodayBookings({ bookings }: { bookings: RoomCenterBooking[] }) {
  const can = useCan();
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  const waiting = bookings.filter((b) => b.status === 'pending' || b.status === 'confirmed');
  const ordered = [...waiting, ...bookings.filter((b) => !waiting.includes(b))];
  const shown = all ? ordered : ordered.slice(0, FOLDED);
  return (
    <section className="rounded-xl border border-line bg-card p-3" aria-label="今天的预约" data-testid="rc-today-bookings">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarClock className="size-4 text-lake" />
        <h2 className="text-[14px] font-bold text-ink">今天的预约</h2>
        <span className="text-[12.5px] text-ink-3" data-testid="rc-today-bookings-count">
          {bookings.length === 0 ? '没有' : `共 ${bookings.length} 张 · 待到店 ${waiting.length} 张`}
        </span>
        <span className="flex-1" />
        {can('booking.manage') && (
          <Button size="sm" variant="ghost" onClick={() => navigate('/crm/bookings')} data-testid="rc-today-bookings-board">
            去预约看板
          </Button>
        )}
      </div>
      {shown.length > 0 && (
        <ul className="mt-2 divide-y divide-line/70">
          {shown.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-[13px]" data-testid={`rc-booking-${b.bookingNo}`}>
              <span className="num w-[92px] shrink-0 font-semibold text-ink">
                {formatTime(b.startsAt)}–{formatTime(b.endsAt)}
              </span>
              <Badge tone="neutral">{BOOKING_KIND_LABELS[b.kind]}</Badge>
              <span className="min-w-0 font-semibold break-all text-ink-2">{b.target}</span>
              <span className="text-ink-3">
                {b.guest} · {b.guests} 人
              </span>
              <span className="flex-1" />
              {b.arrivalTagCode && <span className="num text-[12px] text-ink-3">手牌 {b.arrivalTagCode}</span>}
              {b.serviceNo && <span className="num text-[12px] text-ink-3">{b.serviceNo}</span>}
              {b.holdUntil && b.status !== 'arrived' && <span className="text-[12px] text-ink-3">保留到 {formatTime(b.holdUntil)}</span>}
              <Badge tone={STATUS_TONE[b.status]}>{BOOKING_STATUS_LABELS[b.status]}</Badge>
            </li>
          ))}
        </ul>
      )}
      {ordered.length > FOLDED && (
        <button type="button" onClick={() => setAll((x) => !x)} className="mt-1 text-[13px] font-semibold text-pine hover:underline" data-testid="rc-today-bookings-more">
          {all ? '收起' : `全部 ${ordered.length} 张`}
        </button>
      )}
    </section>
  );
}
