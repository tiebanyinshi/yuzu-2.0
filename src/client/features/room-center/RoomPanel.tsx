// 房态中心的右侧详情栏（店主 2026-11-24《房态中心排版优化需求说明》第二节 5）：点房间卡片在右侧展开，再点同一张收起；手机、平板竖屏是底部抽屉。
// 只是把原来点卡片就做的那一下（登记、开单、入住、看入住单、改房态、看详情）挪到这里的主按钮上，外加「详情、动作与历史」与「点单」：
// 功能、权限、颜色都不变——主按钮做的就是原来点卡片做的（open），详情按钮就是原来卡片右上角的「详情」（openDetail）。

import { ChevronRight, CupSoda, DoorOpen, X } from 'lucide-react';
import { elapsedText, ROOM_STATUS_LABELS, type RoomCard } from '@shared/room-center';
import { cn, formatTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Button } from '../../components/ui';
import { STATUS_META, StatusChip } from './status';

/** 主按钮叫什么：与原来点卡片做的一致（没有专门的动作时就是看详情） */
export function primaryLabel(room: RoomCard, perms: { canPost: boolean; canOperate: boolean; canHousekeep: boolean }): string {
  const vacant = room.status === 'free' || room.status === 'booked';
  if (room.kind === 'hotel') {
    const h = room.hotel;
    if (h?.stay) return perms.canOperate ? '看入住单' : '房间情况';
    if (h?.status === 'vacant' && perms.canOperate) return '办理入住';
    return perms.canHousekeep ? '改房态' : '房间情况';
  }
  if (vacant && room.kind === 'service' && perms.canPost) return '登记';
  if (vacant && room.kind === 'party' && perms.canOperate) return '开单';
  return '详情与动作';
}

/** 清洁状态：待清写几点起、维修写维修中，别的是已清洁 */
function cleaningText(room: RoomCard): string {
  if (room.status === 'dirty') return room.dirtySince ? `待清（${formatTime(room.dirtySince)} 起）` : '待清';
  if (room.status === 'maintenance') return '维修中';
  return '已清洁';
}

export function RoomPanel({
  room,
  area,
  now,
  label,
  onClose,
  onGo,
  onDetail,
  onOrder,
}: {
  room: RoomCard;
  /** 区域（房态中心的房型）名 */
  area: string;
  now: number;
  /** 主按钮的字（primaryLabel） */
  label: string;
  onClose: () => void;
  /** 原来点卡片做的那一下 */
  onGo: () => void;
  /** 原来卡片右上角的「详情、动作与历史」 */
  onDetail: () => void;
  onOrder?: () => void;
}) {
  const m = STATUS_META[room.status];
  const rows: [string, string][] = [
    ['状态', ROOM_STATUS_LABELS[room.status]],
    ['清洁状态', cleaningText(room)],
    ['区域', area],
    ['房间', [room.name, room.floor, room.capacity ? `${room.capacity} 人` : ''].filter(Boolean).join(' · ') || '—'],
  ];
  if (room.status === 'in_use') {
    if (room.guestText) rows.push(['客人', room.guestText]);
    if (room.techText) rows.push(['技师', room.techText]);
    if (room.hotel?.stay?.expectedCheckoutDate) rows.push(['预离', room.hotel.stay.expectedCheckoutDate]);
    if (room.since) rows.push(['已用', elapsedText(room.since, now)]);
  }
  if (room.status === 'maintenance' && room.maintenance) rows.push(['维修原因', room.maintenance.reason]);
  if (room.status === 'booked' && room.booking) rows.push(['预订', `今天 ${formatTime(room.booking.startsAt)} · ${room.booking.guest} · ${room.booking.guests} 人`]);
  return (
    <aside
      aria-label={`${room.code} 房间详情`}
      className={cn(
        // 手机、平板竖屏：底部抽屉；宽屏：右侧一栏，跟着页面往下滚时停在顶上
        'fixed inset-x-0 bottom-0 z-30 max-h-[70vh] overflow-y-auto rounded-t-2xl border border-line bg-card p-4 shadow-lg',
        'lg:sticky lg:top-4 lg:z-auto lg:max-h-[calc(100vh-2rem)] lg:rounded-xl lg:shadow-none',
      )}
      data-testid="rc-panel"
      data-room={room.code}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="num truncate text-[24px] leading-8 font-bold text-ink" data-testid="rc-panel-code">
            {room.code}
          </p>
          <p className="truncate text-[12.5px] text-ink-3">{area}</p>
        </div>
        <StatusChip status={room.status} />
        <button
          type="button"
          onClick={onClose}
          aria-label="收起房间详情"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink"
          data-testid="rc-panel-close"
        >
          <X className="size-5" />
        </button>
      </div>
      <dl className={cn('mt-3 space-y-1.5 rounded-lg border-l-4 bg-paper px-3 py-2.5 text-[13px]', m.bar)}>
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3">
            <dt className="w-16 shrink-0 text-ink-3">{k}</dt>
            <dd className="min-w-0 flex-1 break-words text-ink-2">{v}</dd>
          </div>
        ))}
        {room.amount !== null && (
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-ink-3">金额</dt>
            <dd className="min-w-0 flex-1">
              <Money cents={room.amount} className="font-bold text-ink" />
            </dd>
          </div>
        )}
      </dl>
      <div className="mt-3 flex flex-col gap-2" data-testid="rc-panel-actions">
        <Button variant="primary" icon={<DoorOpen className="size-4" />} className="h-11" onClick={onGo} data-testid="rc-panel-go">
          {label}
        </Button>
        {onOrder && (
          <Button variant="secondary" icon={<CupSoda className="size-4" />} className="h-11" onClick={onOrder} data-testid="rc-panel-order">
            点单（水吧、果吧）
          </Button>
        )}
        {label !== '详情与动作' && (
          <Button variant="secondary" icon={<ChevronRight className="size-4" />} className="h-11" onClick={onDetail} data-testid="rc-panel-detail">
            详情、动作与历史
          </Button>
        )}
      </div>
    </aside>
  );
}
