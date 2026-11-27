// 8.2.13 发卡台总览（docs/V82213_DESK_UI.md；店主 2026-11-27 收银员工作台 demo 的「区域卡片」与「本班已登记」）：
// 没选手牌时右边一栏不再只是空白提示，改成：
//   · 区域状态板：男宾 / 女宾各区的空闲 / 正常 / 繁忙 / 已满、在店占比条、空牌几张，每个分区推荐一个区（点一下在板上筛到这个区）；
//   · 最近发牌：最近发出去的几张（牌号、客人、几点、哪个区），还在自己能撤销的时间里的标「还可撤销 n 分钟」，点一下打开客人卡。
import { useMemo } from 'react';
import { Keyboard, Sparkles } from 'lucide-react';
import { AREA_STATE_LABELS, areaLabel, areaStatuses, type AreaState } from '@shared/desk-areas';
import { tagArea, ZONE_LABELS, type BoardTag } from '@shared/frontdesk';
import { cn, formatTime } from '../../lib/utils';
import { Kbd } from '../../components/ui';
import { ZoneChip } from './parts';

const STATE_TONE: Record<AreaState, { card: string; chip: string; bar: string }> = {
  idle: { card: 'border-pine/30 bg-pine-soft/40', chip: 'bg-pine text-paper', bar: 'bg-pine' },
  normal: { card: 'border-line bg-card', chip: 'bg-paper-2 text-ink-2', bar: 'bg-ink-3' },
  busy: { card: 'border-clay/30 bg-clay-soft/40', chip: 'bg-clay text-paper', bar: 'bg-clay' },
  full: { card: 'border-line bg-paper-2 opacity-60', chip: 'bg-ink-3 text-paper', bar: 'bg-ink-3' },
};

export function DeskOverview({ tags, now, selfMinutes, onOpen, onArea }: { tags: BoardTag[]; now: number; selfMinutes: number; onOpen: (t: BoardTag) => void; onArea: (code: string) => void }) {
  const areas = useMemo(() => areaStatuses(tags, now), [tags, now]);
  const recent = useMemo(
    () =>
      tags
        .filter((t) => t.visit)
        .sort((a, b) => (a.visit!.checkedInAt < b.visit!.checkedInAt ? 1 : -1))
        .slice(0, 8),
    [tags],
  );
  const zones = [...new Set(areas.map((a) => a.zone))];
  return (
    <div className="scroll-thin h-full overflow-y-auto px-5 py-4" data-testid="desk-overview">
      <h2 className="text-[15px] font-bold text-ink">区域状态</h2>
      <p className="mt-0.5 text-[12.5px] text-ink-3">最近 15 分钟没发过的是空闲、发了 3 张以上是繁忙；每个分区推荐一个区</p>
      {zones.map((z) => (
        <section key={z} className="mt-3" aria-label={`${ZONE_LABELS[z].title}区域`}>
          <ZoneChip zone={z} size="md" />
          <div className="mt-2 grid grid-cols-2 gap-2">
            {areas
              .filter((a) => a.zone === z)
              .map((a) => {
                const tone = STATE_TONE[a.state];
                const pct = a.total ? Math.round((a.inStore / a.total) * 100) : 0;
                return (
                  <button
                    key={a.area || '_'}
                    type="button"
                    onClick={() => onArea(a.area)}
                    className={cn('rounded-[12px] border p-2.5 text-left transition hover:border-pine', tone.card, a.recommended && 'ring-2 ring-yuzu')}
                    data-testid={`area-${z}-${a.area || 'plain'}`}
                    data-state={a.state}
                  >
                    <span className="flex items-center justify-between gap-1">
                      <b className="text-[15px] text-ink">{areaLabel(a.area)}</b>
                      <span className={cn('rounded-full px-2 py-px text-[12px] font-bold', tone.chip)}>{AREA_STATE_LABELS[a.state]}</span>
                    </span>
                    <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-paper-2">
                      <span className={cn('block h-full rounded-full', tone.bar)} style={{ width: `${pct}%` }} />
                    </span>
                    <span className="num mt-1 flex items-center justify-between text-[12px] text-ink-3">
                      <span>
                        在店 {a.inStore}/{a.total}
                      </span>
                      <span className="font-bold text-ink-2">空 {a.free}</span>
                    </span>
                    {a.recommended && (
                      <span className="mt-1 flex items-center gap-1 text-[12px] font-bold text-yuzu-deep">
                        <Sparkles className="size-3.5" /> 推荐往这里发
                      </span>
                    )}
                  </button>
                );
              })}
          </div>
        </section>
      ))}
      <h2 className="mt-5 text-[15px] font-bold text-ink">最近发牌</h2>
      {recent.length === 0 ? (
        <p className="mt-1 text-[13px] text-ink-3">还没有在店的客人</p>
      ) : (
        <ul className="mt-2 divide-y divide-line rounded-[12px] border border-line bg-card" data-testid="recent-issues">
          {recent.map((t) => {
            const left = Math.ceil(selfMinutes - (now - Date.parse(t.visit!.checkedInAt)) / 60_000);
            return (
              <li key={t.id}>
                <button type="button" onClick={() => onOpen(t)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-paper-2">
                  <b className="num w-14 text-[15px]">{t.code}</b>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
                    {t.visit!.memberName ?? t.visit!.guestLabel}
                    {t.visit!.guestCategory && t.visit!.guestCategory !== '普通' ? ` · ${t.visit!.guestCategory}` : ''}
                  </span>
                  <span className="num text-[12px] text-ink-3">
                    {formatTime(t.visit!.checkedInAt)} · {areaLabel(tagArea(t.code))}
                  </span>
                  {left > 0 && <span className="rounded-full bg-yuzu-soft px-2 text-[12px] font-bold text-yuzu-deep">可撤 {left} 分</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-4 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
        <Keyboard className="size-4" /> 直接敲牌号回车 · <Kbd>F2</Kbd> 接待发牌 · <Kbd>F9</Kbd> 去收银台买单 · <Kbd>?</Kbd> 全部快捷键 · <Kbd>⌥0</Kbd> 全部功能
      </p>
    </div>
  );
}
