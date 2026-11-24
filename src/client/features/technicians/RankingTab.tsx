// 技师管理 · 技师榜单（docs/TECH_RANKING.md，店主 2026-11-24《技师榜单模块需求说明》）：只做展示与查询。
//   · 顶部：工种标签（全部 + 名册的工种，横向滚动）、状态筛选、搜索（技师号、姓名、花名）；
//   · 左侧：综合榜 / 人气榜竖排切换（默认综合榜）；
//   · 中部：深色照片卡片网格（宽屏一行 6 张，每页 12 张；窄屏少几列），没照片显示占位头像，照片加载失败也换成占位；
//   · 底部：首页 / 上一页 / 页码 / 下一页 / 尾页。筛选、搜索、切换榜单后回到第 1 页。
//   · 第三批：按技师规则里的间隔（默认 30 秒）重新取；服务中的卡片按服务器时间每秒倒计时、画进度条（不靠取数），
//     到点没下钟的写「待下钟」，钟房下钟后下一次取数变空闲；人气榜按人气值排，前三名皇冠 / 银牌 / 铜牌。
// 状态由服务端按钟房算好，这里只显示；不显示客人信息（TR6）。

import { useEffect, useState } from 'react';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Crown, Flame, Medal, Search, UserRound } from 'lucide-react';
import {
  countdownText,
  filterRanking,
  pageOf,
  podiumOf,
  RANKING_BOARD_LABELS,
  RANKING_BOARDS,
  RANKING_NOTE_LABELS,
  RANKING_STATUS_LABELS,
  RANKING_STATUSES,
  rankOf,
  serviceProgress,
  type RankingBoard,
  type RankingStatus,
  type RankingTech,
} from '@shared/technician-ranking';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Card, Input, Select, Skeleton } from '../../components/ui';
import { useTechRanking } from './queries';

const STATUS_TONE: Record<RankingStatus, string> = {
  idle: 'bg-moss text-paper',
  serving: 'bg-lake text-paper',
  off: 'bg-ink-3 text-paper',
};

/** 服务器时间：取数时记下与本机的时差，之后每秒走一格（纯界面的计时器，不取数） */
function useServerNow(serverTime: string | undefined, receivedAt: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const offset = serverTime ? new Date(serverTime).getTime() - receivedAt : 0;
  return now + offset;
}

export function RankingTab() {
  const q = useTechRanking();
  const serverNow = useServerNow(q.data?.serverTime, q.dataUpdatedAt);
  const [kind, setKind] = useState<string | null>(null);
  const [status, setStatus] = useState<RankingStatus | 'all'>('all');
  const [text, setText] = useState('');
  const [board, setBoard] = useState<RankingBoard>('overall');
  const [page, setPage] = useState(1);
  // 换了条件回到第 1 页
  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };

  if (q.isPending) return <Skeleton className="h-96" />;
  if (!q.data) return <LoadFailed title="技师榜单没取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} testId="ranking-failed" />;
  const v = q.data;
  // 名次在工种之内算；状态、搜索只挑出来看，不改名次
  const ranked = rankOf(
    v.techs.filter((t) => kind === null || t.kind === kind),
    board,
  );
  const visible = new Set(
    filterRanking(
      ranked.map((r) => r.tech),
      { kind: null, status, text },
    ).map((t) => t.id),
  );
  const list = ranked.filter((r) => visible.has(r.tech.id));
  const shown = pageOf(list, page, v.pageSize);
  const onDuty = v.counts.idle + v.counts.serving;

  return (
    <Card className="p-4 md:p-5" data-testid="tech-ranking">
      {/* 顶部：工种标签、状态、搜索 */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="scroll-thin -mx-1 flex min-w-0 flex-1 basis-80 gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="按工种看" data-testid="ranking-kinds">
          <KindTab on={kind === null} onClick={() => reset(setKind)(null)} count={v.techs.length}>
            全部
          </KindTab>
          {v.kinds.map((k) => (
            <KindTab key={k} on={kind === k} onClick={() => reset(setKind)(k)} count={v.techs.filter((t) => t.kind === k).length}>
              {k}
            </KindTab>
          ))}
        </div>
        <Select value={status} onChange={(e) => reset(setStatus)(e.target.value as RankingStatus | 'all')} fullWidth={false} className="h-10 w-32" aria-label="按状态筛选" data-testid="ranking-status">
          <option value="all">全部状态</option>
          {RANKING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {RANKING_STATUS_LABELS[s]} {v.counts[s]}
            </option>
          ))}
        </Select>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input
            value={text}
            onChange={(e) => reset(setText)(e.target.value)}
            placeholder="搜技师号、姓名"
            aria-label="搜索技师"
            className="h-10 pl-9"
            maxLength={20}
            inputMode="search"
            data-testid="ranking-search"
          />
        </div>
      </div>
      <p className="mt-2 text-[13px] text-ink-3" data-testid="ranking-summary">
        当班 <span className="num font-semibold text-ink-2">{onDuty}</span> 人（空闲 <span className="num">{v.counts.idle}</span> · 服务中 <span className="num">{v.counts.serving}</span>）· 未当班{' '}
        <span className="num">{v.counts.off}</span> 人 · 共 <span className="num">{v.techs.length}</span> 人
      </p>

      <div className="mt-3 flex flex-col gap-3 md:flex-row">
        {/* 左侧：综合榜 / 人气榜 */}
        <div className="flex shrink-0 gap-1.5 md:w-24 md:flex-col" role="tablist" aria-label="榜单" data-testid="ranking-boards">
          {RANKING_BOARDS.map((b) => (
            <button
              key={b}
              type="button"
              role="tab"
              aria-selected={board === b}
              onClick={() => reset(setBoard)(b)}
              className={cn(
                'tap relative h-11 flex-1 rounded-md border text-[14px] font-bold md:flex-none',
                board === b ? 'border-ink bg-ink text-paper' : 'border-line-strong bg-card text-ink-2 hover:border-ink-4',
              )}
              data-testid={`ranking-board-${b}`}
            >
              {RANKING_BOARD_LABELS[b]}
            </button>
          ))}
        </div>

        {/* 中部：卡片网格 */}
        <div className="min-w-0 flex-1">
          {list.length === 0 ? (
            <EmptyState title="没有符合条件的技师" description="换个工种、状态，或清掉搜索词再看" />
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6" data-testid="ranking-grid">
              {shown.items.map(({ tech, rank }) => (
                <li key={tech.id}>
                  <RankingCard t={tech} rank={rank} board={board} serverNow={serverNow} />
                </li>
              ))}
            </ul>
          )}
          {/* 底部：分页 */}
          <nav className="mt-4 flex items-center justify-center gap-1.5" aria-label="翻页" data-testid="ranking-pager">
            <PageButton label="首页" disabled={shown.page <= 1} onClick={() => setPage(1)} testId="ranking-first">
              <ChevronFirst className="size-4" />
            </PageButton>
            <PageButton label="上一页" disabled={shown.page <= 1} onClick={() => setPage(shown.page - 1)} testId="ranking-prev">
              <ChevronLeft className="size-4" />
            </PageButton>
            <span className="num min-w-16 text-center text-[14px] font-semibold text-ink-2" data-testid="ranking-page">
              {shown.page}/{shown.pages}
            </span>
            <PageButton label="下一页" disabled={shown.page >= shown.pages} onClick={() => setPage(shown.page + 1)} testId="ranking-next">
              <ChevronRight className="size-4" />
            </PageButton>
            <PageButton label="尾页" disabled={shown.page >= shown.pages} onClick={() => setPage(shown.pages)} testId="ranking-last">
              <ChevronLast className="size-4" />
            </PageButton>
          </nav>
        </div>
      </div>
    </Card>
  );
}

function KindTab({ on, onClick, count, children }: { on: boolean; onClick: () => void; count: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'tap relative h-9 shrink-0 rounded-full border px-3.5 text-[13.5px] font-semibold whitespace-nowrap',
        on ? 'border-ink bg-ink text-paper' : 'border-line-strong bg-card text-ink-2 hover:border-ink-4',
      )}
    >
      {children} <span className="num opacity-70">{count}</span>
    </button>
  );
}

function PageButton({ label, disabled, onClick, testId, children }: { label: string; disabled: boolean; onClick: () => void; testId: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="tap relative flex h-10 items-center gap-1 rounded-md border border-line-strong bg-card px-2.5 text-[13px] font-semibold text-ink-2 hover:border-ink-4 disabled:opacity-40"
      data-testid={testId}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

const PODIUM = {
  1: { icon: Crown, label: '第一名', tone: 'bg-yuzu text-ink' },
  2: { icon: Medal, label: '第二名', tone: 'bg-paper-3 text-ink' },
  3: { icon: Medal, label: '第三名', tone: 'bg-ember text-paper' },
} as const;

/** 一张技师卡片：照片（没有或加载失败为占位头像）、No.技师号、名字与工种、状态；服务中的写项目、已服务时长、进度条与剩余时间 */
function RankingCard({ t, rank, board, serverNow }: { t: RankingTech; rank: number; board: RankingBoard; serverNow: number }) {
  const popular = board === 'popular';
  const podium = podiumOf(rank, t.popularity, board);
  const PodiumIcon = podium ? PODIUM[podium].icon : null;
  const progress = t.service ? serviceProgress(t.service, serverNow) : null;
  const [broken, setBroken] = useState<string | null>(null);
  const photo = t.photoUrl && broken !== t.photoUrl ? t.photoUrl : null;
  return (
    <article className={cn('overflow-hidden rounded-lg bg-ink text-paper shadow-sm', t.status === 'off' && 'opacity-75')} data-testid={`ranking-card-${t.techNo}`} data-status={t.status}>
      <div className="relative aspect-[3/4] bg-ink-2">
        {photo ? (
          <img src={photo} alt={`${t.techNo} 号 ${t.name}`} loading="lazy" className="size-full object-cover" onError={() => setBroken(photo)} />
        ) : (
          <div className="flex size-full items-center justify-center text-ink-4" data-testid="ranking-placeholder" aria-label="没有照片">
            <UserRound className="size-16" strokeWidth={1.25} />
          </div>
        )}
        <span className={cn('absolute top-2 right-2 rounded-full px-2 py-0.5 text-[12px] font-bold', STATUS_TONE[t.status])} data-testid="ranking-status-tag">
          {RANKING_STATUS_LABELS[t.status]}
        </span>
        {podium && PodiumIcon && (
          <span
            className={cn('absolute top-2 left-2 flex size-8 items-center justify-center rounded-full shadow', PODIUM[podium].tone)}
            title={PODIUM[podium].label}
            aria-label={PODIUM[podium].label}
            data-testid="ranking-podium"
            data-rank={podium}
          >
            <PodiumIcon className="size-4.5" aria-hidden />
          </span>
        )}
        {popular && (
          <span className="absolute bottom-2 left-2 flex items-center gap-0.5 rounded-full bg-ink/70 px-2 py-0.5 text-[12px] font-bold text-yuzu" data-testid="ranking-popularity">
            <Flame className="size-3.5" aria-hidden />
            <span className="num">{t.popularity}</span>
          </span>
        )}
      </div>
      <div className="space-y-0.5 px-2.5 py-2">
        <p className="flex flex-wrap items-baseline justify-between gap-x-1">
          <span className="num text-[15px] font-bold">No.{t.techNo}</span>
          {t.note && <span className="text-[12px] whitespace-nowrap text-paper-3">{RANKING_NOTE_LABELS[t.note]}</span>}
        </p>
        <p className="truncate text-[13px] text-paper-2">
          {t.name}
          {t.kind && <span className="text-paper-3"> · {t.kind}</span>}
        </p>
        {t.service && (
          <div className="space-y-1 pt-0.5" data-testid="ranking-service">
            <p className="truncate text-[12px] text-paper-2">{t.service.itemName}</p>
            {progress ? (
              <>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-ink-2"
                  role="progressbar"
                  aria-label="服务进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress.ratio * 100)}
                  data-testid="ranking-progress"
                >
                  <div className={cn('h-full rounded-full', progress.remaining > 0 ? 'bg-lake' : 'bg-ember')} style={{ width: `${progress.ratio * 100}%` }} />
                </div>
                <p className="flex justify-between gap-1 text-[12px] text-paper-3">
                  <span className="num" data-testid="ranking-elapsed">
                    已服务 {Math.floor(progress.elapsed / 60)} 分
                  </span>
                  {progress.remaining > 0 ? (
                    <span className="num font-semibold text-paper" data-testid="ranking-remaining">
                      剩 {countdownText(progress.remaining)}
                    </span>
                  ) : (
                    <span className="font-semibold text-ember" data-testid="ranking-remaining">
                      待下钟
                    </span>
                  )}
                </p>
              </>
            ) : (
              <p className="text-[12px] text-paper-3">已派钟，还没上钟</p>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
