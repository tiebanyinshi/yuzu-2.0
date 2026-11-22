// 8.2.0 P09（回测 4-2，docs/YUZU_REQ_V820.md 第 10 节）：技师上钟轮播（门店电视、大屏投用，只读）。
//   · 顶部「按项目 / 按区域」一键切换；技师类型、项目、区域、状态四个筛选可以组合，生效的条件写成小标签、可以逐个去掉、可以一键重置；
//   · 最左一列固定写排钟顺序（序号、技师号与花名、状态），不跟着轮播；右边一列一个项目（或区域），格子里是这位技师在这一项上的钟：
//     房间、开始时间、已上钟多久、预计几点下钟；列头写这一列几个人在钟；顶上写下一位排钟；
//   · 一屏放不下的列分页自动轮播，间隔 5–15 秒可调（本机记住），能暂停、继续、左右翻，鼠标停在上面暂停；
//   · 和钟房同一份数据，5 秒取一次（useLivePoll：后台、断网不取，回来马上取）；取失败照旧显示上一次的数据，顶上写哪个时刻的、带「重试」；
//     列与行按名字、技师编号做 key，数据更新时卡片不跳、不重复；
//   · 字号跟着屏宽走（1920×1080 到 4K），全屏投屏只留看板、隐藏导航与操作按钮（Esc 退出）；不提供任何改钟的操作。

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Pause, Play, RotateCcw, X } from 'lucide-react';
import { TECH_FILTER_LABELS } from '@shared/clockroom';
import {
  NO_AREA,
  TECH_BOARD_DEFAULT_INTERVAL,
  TECH_BOARD_INTERVALS,
  TECH_BOARD_MODE_LABELS,
  TECH_BOARD_REFRESH_MS,
  TECH_BOARD_STATUSES,
  type TechBoardMode,
  type TechBoardSession,
  type TechBoardStatus,
  type TechBoardView,
} from '@shared/tech-board';
import { api, errorMessage } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { useServerNow } from '../../lib/serverClock';
import { useCan, useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { LoadFailed } from '../../components/LoadFailed';
import { Button, Segmented, Select, Skeleton } from '../../components/ui';

const boardKey = ['tech-board'] as const;
const INTERVAL_STORE = 'yuzu.techBoard.interval';
/** 一列至少多宽（em，跟着字号一起放大） */
const COLUMN_EM = 15;
const LEFT_EM = 12;

/** 状态小章：跟着看板的字号一起放大（公共的 Badge 是固定像素，4K 上太小） */
const STATUS_CHIP: Record<TechBoardStatus, string> = {
  serving: 'bg-room-in-use-soft text-room-in-use-ink',
  waiting: 'bg-ember-soft text-ember-deep',
  idle: 'bg-pine-tint text-pine',
  rest: 'bg-paper-2 text-ink-3',
  suspended: 'bg-clay/15 text-clay',
};
type Filters = { kind: string; item: string; area: string; status: TechBoardStatus | '' };
const NO_FILTERS: Filters = { kind: '', item: '', area: '', status: '' };

function readInterval(): number {
  try {
    const n = Number(localStorage.getItem(INTERVAL_STORE));
    return (TECH_BOARD_INTERVALS as readonly number[]).includes(n) ? n : TECH_BOARD_DEFAULT_INTERVAL;
  } catch {
    return TECH_BOARD_DEFAULT_INTERVAL;
  }
}

const minutesBetween = (from: string, now: number) => Math.max(0, Math.floor((now - new Date(from).getTime()) / 60_000));
const durationText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分`);

export function TechBoardPage() {
  const can = useCan();
  const session = useSession();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const mode: TechBoardMode = params.get('mode') === 'area' ? 'area' : 'item';
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [interval, setIntervalSec] = useState(readInterval);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [page, setPage] = useState(0);
  const [full, setFull] = useState(false);
  const [perPage, setPerPage] = useState(4);
  const boardRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);

  const q = useQuery({ queryKey: boardKey, queryFn: () => api.get<TechBoardView>('/api/tech-board') });
  useLivePoll(
    async (isLive) => {
      if (isLive()) await qc.refetchQueries({ queryKey: boardKey, exact: true });
    },
    [qc],
    { intervalMs: TECH_BOARD_REFRESH_MS },
  );
  const d = q.data;
  const now = useServerNow(d?.serverTime, 15_000);

  // 一屏放几列：按右边的宽度与字号算（字号跟着屏宽走，4K 上照样是这几列，只是更大）
  useEffect(() => {
    const el = columnsRef.current;
    if (!el) return;
    const measure = () => {
      const font = parseFloat(getComputedStyle(el).fontSize) || 16;
      setPerPage(Math.max(1, Math.floor(el.clientWidth / (COLUMN_EM * font))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [d !== undefined, full]);

  // 全屏投屏：浏览器全屏（能用时）+ 页面上只留看板；Esc 或浏览器退出全屏都回来
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  const enterFull = () => {
    setFull(true);
    void boardRef.current?.requestFullscreen?.().catch(() => undefined);
  };
  const exitFull = () => {
    setFull(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };

  const view = useMemo(() => {
    if (!d) return null;
    const sessionMatches = (s: TechBoardSession) => (!filters.item || s.itemName === filters.item) && (!filters.area || (s.area ?? NO_AREA) === filters.area);
    const sessions = d.sessions.filter(sessionMatches);
    const narrowed = !!filters.item || !!filters.area;
    const techs = d.techs.filter((t) => (!filters.kind || t.kind === filters.kind) && (!filters.status || t.status === filters.status) && (!narrowed || sessions.some((s) => s.technicianId === t.id)));
    const keyOf = (s: TechBoardSession) => (mode === 'item' ? s.itemName : (s.area ?? NO_AREA));
    const shownIds = new Set(techs.map((t) => t.id));
    const counts = new Map<string, Set<number>>();
    for (const s of sessions) {
      if (!shownIds.has(s.technicianId)) continue;
      const k = keyOf(s);
      counts.set(k, (counts.get(k) ?? new Set()).add(s.technicianId));
    }
    // 列：在钟人多的在前，一样多的按名字；没有钟的项目、区域不出列
    const columns = [...counts.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], 'zh-CN')).map(([name, ids]) => ({ name, techs: ids.size }));
    const cellOf = (techId: number, col: string) => sessions.filter((s) => s.technicianId === techId && keyOf(s) === col);
    return { techs, columns, cellOf, serving: new Set(sessions.filter((s) => s.status === 'serving' && shownIds.has(s.technicianId)).map((s) => s.technicianId)).size };
  }, [d, filters, mode]);

  const pages = view ? Math.max(1, Math.ceil(view.columns.length / perPage)) : 1;
  const current = Math.min(page, pages - 1);
  // 自动翻页：暂停、鼠标停在上面、只有一页时不翻；每翻一页重新计时
  useEffect(() => {
    if (paused || hover || pages <= 1) return;
    const t = window.setTimeout(() => setPage((p) => (Math.min(p, pages - 1) + 1) % pages), interval * 1000);
    return () => window.clearTimeout(t);
  }, [current, paused, hover, pages, interval]);

  if (!session.technicians) return <Navigate to="/" replace />;
  if (!can('technician.board') && !can('technician.dispatch') && !can('technician.announce')) return <Navigate to="/" replace />;

  const setMode = (m: TechBoardMode) => {
    const next = new URLSearchParams(params);
    if (m === 'area') next.set('mode', 'area');
    else next.delete('mode');
    setParams(next, { replace: true });
    setPage(0);
  };
  const setFilter = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  };
  const chooseInterval = (n: number) => {
    setIntervalSec(n);
    try {
      localStorage.setItem(INTERVAL_STORE, String(n));
    } catch {
      /* 存不了就只在这一页里用 */
    }
  };
  const active: { key: keyof Filters; label: string }[] = [
    ...(filters.kind ? [{ key: 'kind' as const, label: `技师类型：${filters.kind}` }] : []),
    ...(filters.item ? [{ key: 'item' as const, label: `项目：${filters.item}` }] : []),
    ...(filters.area ? [{ key: 'area' as const, label: `区域：${filters.area}` }] : []),
    ...(filters.status ? [{ key: 'status' as const, label: `状态：${TECH_FILTER_LABELS[filters.status]}` }] : []),
  ];
  const shown = view ? view.columns.slice(current * perPage, current * perPage + perPage) : [];
  // 一页固定 perPage 格：最后一页不满的补空格，表头与每一行的格子才对得齐
  const slots = Array.from({ length: perPage }, (_, i) => shown[i] ?? null);
  const stale = q.isError && !!d;

  const controls = (
    <div className="flex flex-wrap items-end gap-2" data-testid="tech-board-controls">
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: 'item', label: TECH_BOARD_MODE_LABELS.item },
          { value: 'area', label: TECH_BOARD_MODE_LABELS.area },
        ]}
        ariaLabel="看的维度"
      />
      <FilterSelect label="技师类型" value={filters.kind} options={d?.kinds ?? []} onChange={(v) => setFilter({ kind: v })} testId="tech-board-kind" />
      <FilterSelect label="项目" value={filters.item} options={d?.items ?? []} onChange={(v) => setFilter({ item: v })} testId="tech-board-item" />
      <FilterSelect label="区域" value={filters.area} options={d?.areas ?? []} onChange={(v) => setFilter({ area: v })} testId="tech-board-area" />
      <FilterSelect
        label="状态"
        value={filters.status}
        options={TECH_BOARD_STATUSES.map((s) => ({ value: s, label: TECH_FILTER_LABELS[s] }))}
        onChange={(v) => setFilter({ status: v as TechBoardStatus | '' })}
        testId="tech-board-status"
      />
      <span className="mx-1 h-8 w-px bg-line" aria-hidden />
      <label className="flex items-center gap-1.5 text-[13px] text-ink-3">
        轮播
        <Select fullWidth={false} value={interval} onChange={(e) => chooseInterval(Number(e.target.value))} aria-label="轮播间隔" data-testid="tech-board-interval" className="h-9">
          {TECH_BOARD_INTERVALS.map((n) => (
            <option key={n} value={n}>
              {n} 秒
            </option>
          ))}
        </Select>
      </label>
      <Button size="sm" variant="secondary" icon={paused ? <Play className="size-4" /> : <Pause className="size-4" />} onClick={() => setPaused((p) => !p)} data-testid="tech-board-pause">
        {paused ? '继续' : '暂停'}
      </Button>
      <Button size="sm" variant="ghost" icon={<Maximize2 className="size-4" />} onClick={enterFull} data-testid="tech-board-full">
        全屏投屏
      </Button>
    </div>
  );

  return (
    <>
      {!full && <PageHeader title="技师上钟轮播" subtitle="谁在上钟、上什么项目、排在哪；按项目或按区域看，列多了自动轮播。只读，和钟房同一份排位" />}
      <div className={cn('flex min-h-0 flex-1 flex-col', !full && 'scroll-thin overflow-y-auto')} data-testid="tech-board-page">
        <div className={cn('flex min-h-0 flex-1 flex-col gap-3', !full && 'px-5 py-4 md:px-7')}>
          {!full && controls}
          {!full && active.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="tech-board-active">
              <span className="text-[12.5px] text-ink-3">生效的条件：</span>
              {active.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => setFilter({ [a.key]: '' })}
                  className="flex items-center gap-1 rounded-full border border-line bg-card px-2.5 py-1 text-[12.5px] font-semibold text-ink-2 hover:border-line-strong"
                  aria-label={`去掉 ${a.label}`}
                  data-testid={`tech-board-chip-${a.key}`}
                >
                  {a.label}
                  <X className="size-3.5" aria-hidden />
                </button>
              ))}
              <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setFilter(NO_FILTERS)} data-testid="tech-board-reset">
                重置
              </Button>
            </div>
          )}
          <div
            ref={boardRef}
            className={cn('flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-xl border border-line bg-paper text-ink', full && 'fixed inset-0 z-[70] min-h-0 rounded-none border-0')}
            style={{ fontSize: 'clamp(15px, 1.05vw, 46px)' }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            data-testid="tech-board"
            data-mode={mode}
            data-page={current}
            data-pages={pages}
            data-paused={paused || hover ? 'true' : undefined}
            data-full={full ? 'true' : undefined}
          >
            <div className="flex flex-wrap items-center gap-x-[1em] gap-y-1 border-b border-line bg-card px-[1em] py-[0.5em]">
              <span className="text-[1.15em] font-bold">技师上钟 · {TECH_BOARD_MODE_LABELS[mode]}</span>
              <span className="num text-ink-3">{formatTime(new Date(now).toISOString())}</span>
              {view && (
                <span className="text-ink-2">
                  在钟 <b className="num">{view.serving}</b> 人
                </span>
              )}
              <span className="text-ink-2" data-testid="tech-board-next">
                下一位排钟：<b>{d?.next ? `${d.next.techNo} 号 ${d.next.name}` : '—'}</b>
              </span>
              <span className="ml-auto flex items-center gap-[0.4em]">
                {stale && (
                  <span className="flex items-center gap-[0.4em] text-[length:max(12px,0.85em)] text-clay" data-testid="tech-board-stale">
                    刷新失败，显示的是 {formatTime(new Date(q.dataUpdatedAt).toISOString())} 的数据
                    <Button size="sm" variant="secondary" onClick={() => void q.refetch()} data-testid="tech-board-retry">
                      重试
                    </Button>
                  </span>
                )}
                {pages > 1 && (
                  <>
                    {!full && (
                      <IconButton label="上一页" onClick={() => setPage((p) => (Math.min(p, pages - 1) - 1 + pages) % pages)} testId="tech-board-prev">
                        <ChevronLeft className="size-[1.1em]" />
                      </IconButton>
                    )}
                    <span className="num text-ink-3" data-testid="tech-board-pageno">
                      {current + 1} / {pages}
                    </span>
                    {!full && (
                      <IconButton label="下一页" onClick={() => setPage((p) => (Math.min(p, pages - 1) + 1) % pages)} testId="tech-board-next-page">
                        <ChevronRight className="size-[1.1em]" />
                      </IconButton>
                    )}
                  </>
                )}
                {(paused || hover) && pages > 1 && <span className="text-[length:max(12px,0.85em)] text-ember-deep">已暂停</span>}
                {full && (
                  <IconButton label="退出全屏" onClick={exitFull} testId="tech-board-exit">
                    <Minimize2 className="size-[1.1em]" />
                  </IconButton>
                )}
              </span>
            </div>
            {q.isPending ? (
              <Skeleton className="m-4 h-64" />
            ) : !d || !view ? (
              <LoadFailed title="技师上钟情况取不回来" onRetry={() => void q.refetch()} retrying={q.isFetching}>
                {q.error ? errorMessage(q.error) : null}
              </LoadFailed>
            ) : view.techs.length === 0 ? (
              <p className="m-auto p-8 text-center text-[1.1em] text-ink-3" data-testid="tech-board-empty">
                {active.length ? '没有对上筛选条件的技师' : '现在没有在岗的技师'}
              </p>
            ) : (
              <div className="scroll-thin flex min-h-0 flex-1 overflow-y-auto">
                {/* 最左一列：排钟顺序，固定不动 */}
                <div className="shrink-0 border-r border-line bg-card" style={{ width: `${LEFT_EM}em` }} data-testid="tech-board-order">
                  <div className="flex h-[3.2em] items-center border-b border-line px-[0.8em] font-bold text-ink-3">排钟顺序</div>
                  {view.techs.map((t, i) => (
                    <div key={t.id} className="flex h-[4.6em] items-center gap-[0.5em] border-b border-line/70 px-[0.8em]" data-testid={`tech-board-row-${t.techNo}`} data-status={t.status}>
                      <span className="num w-[1.6em] shrink-0 text-right text-[1.1em] font-bold text-ink-3">{t.position ?? i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="num block truncate text-[1.2em] font-bold">{t.techNo} 号</span>
                        <span className="block truncate text-ink-2">{t.name}</span>
                      </span>
                      <span className={cn('shrink-0 rounded-full px-[0.6em] py-[0.15em] text-[length:max(12px,0.85em)] font-bold whitespace-nowrap', STATUS_CHIP[t.status])}>
                        {TECH_FILTER_LABELS[t.status]}
                      </span>
                    </div>
                  ))}
                </div>
                {/* 右边：一列一个项目（区域），一屏放不下分页轮播 */}
                <div ref={columnsRef} className="min-w-0 flex-1" data-testid="tech-board-columns">
                  {view.columns.length === 0 ? (
                    <p className="p-8 text-center text-[1.1em] text-ink-3">现在没有人在钟上</p>
                  ) : (
                    <div className="grid" style={{ gridTemplateColumns: `repeat(${perPage}, minmax(0, 1fr))` }}>
                      {slots.map((c, i) =>
                        c ? (
                          <div key={c.name} className="flex h-[3.2em] min-w-0 items-center gap-[0.5em] border-b border-l border-line px-[0.8em] first:border-l-0" data-testid="tech-board-col">
                            <span className="min-w-0 flex-1 truncate text-[1.1em] font-bold">{c.name}</span>
                            <span className="num shrink-0 text-ink-3">{c.techs} 人</span>
                          </div>
                        ) : (
                          <div key={`blank:${i}`} className="h-[3.2em] border-b border-l border-line first:border-l-0" aria-hidden />
                        ),
                      )}
                      {view.techs.map((t) =>
                        slots.map((c, i) => (
                          <div key={`${t.id}:${c?.name ?? `blank:${i}`}`} className="h-[4.6em] min-w-0 border-b border-l border-line/70 p-[0.35em] first:border-l-0">
                            {c && view.cellOf(t.id, c.name).map((s) => <SessionCard key={s.id} s={s} mode={mode} now={now} />)}
                          </div>
                        )),
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function SessionCard({ s, mode, now }: { s: TechBoardSession; mode: TechBoardMode; now: number }) {
  const elapsed = s.startedAt ? minutesBetween(s.startedAt, now) : null;
  const left = s.plannedEnd ? Math.ceil((new Date(s.plannedEnd).getTime() - now) / 60_000) : null;
  return (
    <div
      className={cn(
        'flex h-full min-w-0 flex-col justify-center rounded-lg border px-[0.6em] leading-tight',
        s.status === 'serving' ? 'border-room-in-use/40 bg-room-in-use-soft' : 'border-ember/30 bg-ember-soft',
      )}
      data-testid="tech-board-card"
      data-status={s.status}
    >
      <p className="flex min-w-0 items-baseline gap-[0.5em]">
        <span className="num truncate text-[1.15em] font-bold">{s.room ?? '未选房间'}</span>
        <span className="truncate text-ink-2">{mode === 'item' ? (s.area ?? '') : s.itemName}</span>
      </p>
      {s.status === 'serving' && s.startedAt ? (
        <p className="num truncate text-[length:max(12px,0.9em)] text-ink-2">
          {formatTime(s.startedAt)} 起 · 已上 {durationText(elapsed ?? 0)}
          {s.plannedEnd && (
            <span className={cn('ml-[0.4em]', left !== null && left < 0 ? 'font-bold text-clay' : 'text-ink-3')}>
              {left !== null && left < 0 ? `超 ${-left} 分` : `预计 ${formatTime(s.plannedEnd)} 下钟`}
            </span>
          )}
        </p>
      ) : (
        <p className="text-[length:max(12px,0.9em)] font-semibold text-ember-deep">已派待上 · {s.minutes * s.clocks} 分钟</p>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  options: readonly (string | { value: string; label: string })[];
  onChange: (v: string) => void;
  testId: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[13px] text-ink-3">
      {label}
      <Select fullWidth={false} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 max-w-[11rem]" data-testid={testId}>
        <option value="">全部</option>
        {options.map((o) => {
          const v = typeof o === 'string' ? o : o.value;
          return (
            <option key={v} value={v}>
              {typeof o === 'string' ? o : o.label}
            </option>
          );
        })}
      </Select>
    </label>
  );
}

function IconButton({ label, onClick, testId, children }: { label: string; onClick: () => void; testId: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-[2em] items-center justify-center rounded-lg border border-line bg-card text-ink-2 hover:border-line-strong"
      data-testid={testId}
    >
      {children}
    </button>
  );
}
