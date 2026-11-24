// 房态中心五种状态的样子：颜色 + 文字 + 图标，卡片、数量、总览的小方块共用这一张表。
// 回测整改 P01（回测 3-2）：空闲 绿、在用 蓝、待清 黄、维修 红 四色固定，走样式表里只给房态用的 --color-room-*（值见 @shared/room-colors）；
// 卡片底色、左侧色条、状态点三处同源；已预订用中性灰，不占这四色。

import { CalendarClock, CircleCheck, Sparkles, Timer, Wrench } from 'lucide-react';
import { ROOM_COUNT_KEY, ROOM_STATUS_LABELS, ROOM_STATUSES, type RoomCounts, type RoomStatus } from '@shared/room-center';
import { cn } from '../../lib/utils';

export const STATUS_META: Record<RoomStatus, { icon: typeof Timer; card: string; bar: string; text: string; dot: string }> = {
  free: { icon: CircleCheck, card: 'border-room-free/40 bg-room-free-soft', bar: 'border-l-room-free', text: 'text-room-free-ink', dot: 'bg-room-free' },
  in_use: { icon: Timer, card: 'border-room-in-use/40 bg-room-in-use-soft', bar: 'border-l-room-in-use', text: 'text-room-in-use-ink', dot: 'bg-room-in-use' },
  dirty: { icon: Sparkles, card: 'border-room-dirty/50 bg-room-dirty-soft', bar: 'border-l-room-dirty', text: 'text-room-dirty-ink', dot: 'bg-room-dirty' },
  maintenance: {
    icon: Wrench,
    card: 'border-room-maintenance/40 bg-room-maintenance-soft',
    bar: 'border-l-room-maintenance',
    text: 'text-room-maintenance-ink',
    dot: 'bg-room-maintenance',
  },
  booked: { icon: CalendarClock, card: 'border-line-strong bg-paper-2', bar: 'border-l-ink-4', text: 'text-ink-2', dot: 'bg-ink-3' },
};

/** 状态章：图标 + 文字（16 像素），底色用卡片色、边线与字用状态色——放在哪种底色的卡片上都看得清 */
export function StatusChip({ status, className, compact = false }: { status: RoomStatus; className?: string; /** 卡片右上角用的小号（颜色一样，只是小一点，给房号留地方） */ compact?: boolean }) {
  const m = STATUS_META[status];
  const Icon = m.icon;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border border-current/30 bg-card leading-none font-bold whitespace-nowrap',
        compact ? 'h-6 px-2 text-[13px]' : 'h-7 px-2.5 text-[16px]',
        m.text,
        className,
      )}
      data-testid="rc-status"
    >
      <span className={cn('size-2 shrink-0 rounded-full', m.dot)} aria-hidden data-testid="rc-status-dot" />
      {!compact && <Icon className="size-4" aria-hidden />}
      {ROOM_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * 一排数量：全部、空闲、在用、待清、维修、已预订。给了 onFilter 就是能点的（点一下只看这一种，再点一下看全部）。
 * 每个都是图标 + 文字 + 数字，按钮高 44 像素。
 */
export function CountChips({ counts, filter, onFilter, testId }: { counts: RoomCounts; filter?: RoomStatus | null; onFilter?: (s: RoomStatus | null) => void; testId?: string }) {
  const base = 'flex h-11 min-w-[72px] flex-1 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-semibold whitespace-nowrap sm:flex-none sm:px-3.5';
  const total = (
    <>
      全部 <b className="num text-[18px] text-ink">{counts.total}</b>
    </>
  );
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="各状态的房间数" data-testid={testId}>
      {onFilter ? (
        <button
          type="button"
          onClick={() => onFilter(null)}
          aria-pressed={!filter}
          className={cn(base, 'text-ink-2', !filter ? 'border-ink-3 bg-card' : 'border-line bg-paper hover:border-line-strong')}
          data-testid="rc-count-total"
        >
          {total}
        </button>
      ) : (
        <span className={cn(base, 'border-line bg-paper text-ink-2')} data-testid="rc-count-total">
          {total}
        </span>
      )}
      {ROOM_STATUSES.map((s) => {
        const m = STATUS_META[s];
        const Icon = m.icon;
        const on = filter === s;
        const inner = (
          <>
            <Icon className="size-4" aria-hidden />
            {ROOM_STATUS_LABELS[s]} <b className="num text-[18px]">{counts[ROOM_COUNT_KEY[s]]}</b>
          </>
        );
        return onFilter ? (
          <button
            key={s}
            type="button"
            onClick={() => onFilter(on ? null : s)}
            aria-pressed={on}
            className={cn(base, m.text, on ? cn(m.card, 'ring-2 ring-current/40') : 'border-line bg-card hover:border-line-strong')}
            data-testid={`rc-count-${s}`}
          >
            {inner}
          </button>
        ) : (
          <span key={s} className={cn(base, m.text, 'border-line bg-card')} data-testid={`rc-count-${s}`}>
            {inner}
          </span>
        );
      })}
    </div>
  );
}

/**
 * 顶部统计卡行（店主 2026-11-24《房态中心排版优化需求说明》第二节 1）：空闲、在用、待清、维修、已预订五张，大数字 + 小字说明。
 * 口径与下面的数量、分组头一样（这一页签的房间）；点一张只看这一种，再点看全部（与数量那一排同一个筛选）。
 */
const STAT_NOTES: Record<RoomStatus, string> = {
  free: '可排房',
  in_use: '有客人',
  dirty: '等打扫',
  maintenance: '暂不能用',
  booked: '今天有预订',
};

export function StatCards({ counts, filter, onFilter }: { counts: RoomCounts; filter: RoomStatus | null; onFilter: (s: RoomStatus | null) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 min-[560px]:grid-cols-3 lg:grid-cols-5" role="group" aria-label="房态统计" data-testid="rc-stats">
      {ROOM_STATUSES.map((s) => {
        const m = STATUS_META[s];
        const Icon = m.icon;
        const on = filter === s;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onFilter(on ? null : s)}
            aria-pressed={on}
            className={cn('flex min-h-[84px] flex-col justify-between rounded-xl border border-l-[6px] px-4 py-3 text-left', m.card, m.bar, on && 'ring-2 ring-current/40', m.text)}
            data-testid={`rc-stat-${s}`}
          >
            <span className="flex items-center gap-1.5 text-[14px] font-bold">
              <Icon className="size-4" aria-hidden />
              {ROOM_STATUS_LABELS[s]}
            </span>
            <span className="flex items-baseline justify-between gap-2">
              <b className="num text-[30px] leading-9 text-ink">{counts[ROOM_COUNT_KEY[s]]}</b>
              <span className="text-[12.5px] text-ink-3">{STAT_NOTES[s]}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 区域分组头：区域名 + 共 N 间 + 这个区域空闲 / 在用 / 待清 / 维修各几间（第二节 3） */
export function GroupHead({ name, counts, testId }: { name: string; counts: RoomCounts; testId?: string }) {
  return (
    <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-2" data-testid={testId}>
      <h3 className="text-[16px] font-bold text-ink">{name}</h3>
      <span className="text-[13px] text-ink-3">
        共 <b className="num text-ink-2">{counts.total}</b> 间
      </span>
      <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[13px]">
        {(['free', 'in_use', 'dirty', 'maintenance'] as const).map((s) => {
          const n = counts[ROOM_COUNT_KEY[s]];
          return (
            <span key={s} className={cn('flex items-center gap-1 font-semibold', n > 0 ? STATUS_META[s].text : 'text-ink-4')}>
              <span className={cn('size-2 rounded-full', n > 0 ? STATUS_META[s].dot : 'bg-ink-4')} aria-hidden />
              {ROOM_STATUS_LABELS[s]} <b className="num">{n}</b>
            </span>
          );
        })}
      </span>
    </div>
  );
}
