// 「我的排班」月历（OA-05 排班优化 + 员工办公 v1.1 第 2 批）：WCP 的「我的排班」页与手机「我的」页共用。
// 每天的底色按上班 / 休息 / 请假 / 缺勤；跨天班写「至次日 06:00」，第二天 00:00 上班的在前一天写「今晚 24:00 上班」。
// 传入 onSelectDate 时支持点选某一天（手机端格子窄，点开在下方看完整班次与时间）。

import { shiftDate } from '@shared/labels';
import { MY_DAY_STATUS_LABELS, MY_DAY_STATUSES, type MyDayStatus, type MySchedule, type MyScheduleItem } from '@shared/oa';
import { clockText } from '@shared/technician-admin';
import { cn } from '../../lib/utils';

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

/** 每天的底色（排班优化第 4 条）：系统现有的主题色，图例与格子同一张表 */
const DAY_TONE: Record<MyDayStatus, { cell: string; swatch: string; text: string }> = {
  work: { cell: 'bg-lake-soft border-lake/30', swatch: 'bg-lake-soft border-lake/40', text: 'text-lake' },
  rest: { cell: 'bg-paper-2 border-line', swatch: 'bg-paper-2 border-line-strong', text: 'text-ink-3' },
  leave: { cell: 'bg-yuzu-soft border-yuzu/40', swatch: 'bg-yuzu-soft border-yuzu/50', text: 'text-yuzu-deep' },
  absent: { cell: 'bg-clay-soft border-clay/30', swatch: 'bg-clay-soft border-clay/40', text: 'text-clay' },
};
export const LEAVE_PART_LABELS: Record<'full' | 'am' | 'pm', string> = { full: '请假', am: '上午请假', pm: '下午请假' };

export function DayLegend() {
  return (
    <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]" data-testid="my-schedule-legend">
      {MY_DAY_STATUSES.map((s) => (
        <span key={s} className="flex items-center gap-1.5 text-ink-2">
          <span className={cn('size-4 rounded border', DAY_TONE[s].swatch)} aria-hidden />
          {MY_DAY_STATUS_LABELS[s]}
        </span>
      ))}
    </div>
  );
}

export const itemText = (i: Pick<MyScheduleItem, 'startMinute' | 'endMinute'>) => `${clockText(i.startMinute)}–${i.endMinute <= i.startMinute ? '次日 ' : ''}${clockText(i.endMinute)}`;

export function MonthGrid({ data, selectedDate, onSelectDate }: { data: MySchedule; selectedDate?: string | null; onSelectDate?: (date: string) => void }) {
  const first = data.days[0]!.date;
  const [y, m, d] = first.split('-').map(Number) as [number, number, number];
  const lead = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  // 下个月 1 号的也算上：00:00 上班的在这个月最后一天写「今晚 24:00 上班」
  const byDate = new Map([...data.days, data.following].map((x) => [x.date, x.items]));
  return (
    <div className="grid grid-cols-7 gap-1 text-[12px]">
      {WEEK.map((w) => (
        <div key={w} className="py-1 text-center font-semibold text-ink-3">
          {w}
        </div>
      ))}
      {Array.from({ length: lead }, (_, i) => (
        <div key={`pad-${i}`} />
      ))}
      {data.days.map((day) => {
        // 第二天 00:00 上班的班次：今晚就要去，前一天写上
        const tonight = (byDate.get(shiftDate(day.date, 1)) ?? []).filter((i) => i.startMinute === 0);
        const selected = !!selectedDate && selectedDate === day.date;
        const body = (
          <>
            <p className="num font-semibold text-ink-2">{Number(day.date.slice(8))}</p>
            {day.status === 'leave' && <p className={cn('font-bold', DAY_TONE.leave.text)}>{LEAVE_PART_LABELS[day.leavePart ?? 'full']}</p>}
            {day.status === 'absent' && <p className={cn('font-bold', DAY_TONE.absent.text)}>缺勤</p>}
            {day.items.length === 0 && tonight.length === 0 && day.status === 'rest' && (
              <p className="text-ink-3">
                休<span className="max-sm:hidden">息</span>
              </p>
            )}
            {day.items.map((i) => (
              <p key={i.shiftId} className="mt-0.5 leading-tight">
                <span className="block truncate font-bold text-ink">{i.name}</span>
                <span className={cn('num block text-[12px] text-ink-3', onSelectDate && 'max-sm:hidden')}>{itemText(i)}</span>
              </p>
            ))}
            {tonight.map((i) => (
              <p key={`t-${i.shiftId}`} className="mt-0.5 text-[12px] leading-tight font-semibold text-ember">
                {onSelectDate ? (
                  <>
                    <span className="sm:hidden">今晚夜</span>
                    <span className="max-sm:hidden">今晚 24:00 上班（{i.name}）</span>
                  </>
                ) : (
                  <span>今晚 24:00 上班（{i.name}）</span>
                )}
              </p>
            ))}
          </>
        );
        const cls = cn(
          'min-h-14 min-w-0 rounded-md border px-1 py-1 text-left transition-colors sm:min-h-20 sm:px-1.5',
          DAY_TONE[day.status].cell,
          selected ? 'ring-2 ring-yuzu' : day.date === data.today && 'ring-2 ring-pine',
          day.date < data.today && !selected && 'opacity-70',
        );
        if (onSelectDate) {
          return (
            <button
              key={day.date}
              type="button"
              onClick={() => onSelectDate(day.date)}
              data-testid={`my-day-${day.date}`}
              data-status={day.status}
              data-selected={selected ? 'true' : undefined}
              className={cn(cls, 'tap relative w-full cursor-pointer align-top')}
            >
              {body}
            </button>
          );
        }
        return (
          <div key={day.date} data-testid={`my-day-${day.date}`} data-status={day.status} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
