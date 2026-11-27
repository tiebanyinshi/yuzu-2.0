// 汤崎学堂 · 员工端（docs/ACADEMY.md 第 8 节；WCP 手机端底部「学堂」Tab、宽屏左侧「学堂」）：
//   /oa/academy                 首页：继续学、四个入口、我的必修、学习地图、知识中心、榜单（顶栏搜索 ?q= 同时搜课程与培训资料）
//   /oa/academy/paths           学习地图列表；/oa/academy/paths/<编号> 蜿蜒路线
//   /oa/academy/courses         知识中心（?category= 按分类）；/oa/academy/courses/<编号> 课程；/oa/academy/lessons/<编号> 课时
//   /oa/academy/daily           每日一练；/oa/academy/me 我的（等级、证书、掌握度）；/oa/academy/rank 榜单；/oa/academy/coach 待我签核

import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Award, BookOpen, Brain, ChevronRight, ClipboardCheck, Flag, Map as MapIcon, Settings, Trophy } from 'lucide-react';
import { ACADEMY_CATEGORIES, ACADEMY_CATEGORY_LABELS, type AcademyAssigned, type AcademyCategory, type AcademyRankBoard, type AcademyRankPeriod, type AcademyRankScope } from '@shared/academy';
import type { TrainingSearchItem } from '@shared/training';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Card, Segmented, Skeleton } from '../../components/ui';
import { CoursePage, LessonPage } from './CoursePages';
import { COVER_CLASS, minutesText, useAcademyCourses, useAcademyHome, useAcademyPath, useAcademyRank } from './data';
import { CoachPage, DailyPage, MePage } from './MePages';
import { AcademyFrame, AcademyOpsPanel, CourseRow, PathCard, ProgressBar } from './parts';

export function AcademyPages() {
  const { pathname } = useLocation();
  const [, , , section, id] = pathname.replace(/\/$/, '').split('/');
  const n = id ? Number(id) : null;
  if (section === 'paths' && n) return <PathPage id={n} />;
  if (section === 'paths') return <PathsPage />;
  if (section === 'courses' && n) return <CoursePage id={n} />;
  if (section === 'courses') return <CoursesPage />;
  if (section === 'lessons' && n) return <LessonPage id={n} />;
  if (section === 'daily') return <DailyPage />;
  if (section === 'me') return <MePage />;
  if (section === 'rank') return <RankPage />;
  if (section === 'coach') return <CoachPage />;
  return <HomePage />;
}

function dueBadge(a: AcademyAssigned) {
  if (a.completed) return <Badge tone="pine">已完成</Badge>;
  if (a.overdue) return <Badge tone="clay">已逾期 · {a.dueOn}</Badge>;
  if (a.dueOn) return <Badge tone="ember">截止 {a.dueOn}</Badge>;
  return <Badge>{a.required ? '必修' : '推荐'}</Badge>;
}

function AssignedCard({ a }: { a: AcademyAssigned }) {
  const to = a.kind === 'path' ? `/oa/academy/paths/${a.id}` : `/oa/academy/courses/${a.id}`;
  return (
    <Link to={to} className="mo-lift block rounded-lg border border-line bg-card p-3.5" data-testid={`academy-assigned-${a.kind}-${a.id}`}>
      <div className="flex items-start gap-3">
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-md', COVER_CLASS[a.cover].solid)}>
          {a.kind === 'path' ? <MapIcon className="size-5" aria-hidden /> : <BookOpen className="size-5" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold text-ink">{a.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-ink-3">{a.kind === 'path' ? '学习地图' : '课程'}</span>
            {dueBadge(a)}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <ProgressBar done={a.done} total={a.total} tone={a.overdue ? 'yuzu' : 'pine'} className="flex-1" />
            <span className="shrink-0 text-[12px] font-semibold text-ink-3 tabular-nums">
              {a.done}/{a.total}
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function SearchResults({ q }: { q: string }) {
  const courses = useAcademyCourses(q, '');
  const docs = useQuery({ queryKey: ['training', 'search', q], queryFn: () => api.get<TrainingSearchItem[]>(`/api/training/search?q=${encodeURIComponent(q)}`) });
  return (
    <div className="space-y-3" data-testid="academy-search-results">
      <p className="px-1 text-[13px] text-ink-3">「{q}」的结果</p>
      <p className="text-[13px] font-bold text-ink-2">课程</p>
      {courses.isError && !courses.data ? (
        <LoadFailed title="课程没有取回来" onRetry={() => void courses.refetch()} />
      ) : courses.data?.length ? (
        courses.data.map((c) => <CourseRow key={c.id} c={c} />)
      ) : (
        <p className="text-[13px] text-ink-4">{courses.isPending ? '正在找…' : '没有找到课程'}</p>
      )}
      <p className="text-[13px] font-bold text-ink-2">培训资料</p>
      {docs.isError && !docs.data ? (
        <LoadFailed title="培训资料没有取回来" onRetry={() => void docs.refetch()} />
      ) : docs.data?.length ? (
        <div className="space-y-2" data-testid="academy-search-docs">
          {docs.data.map((d) => (
            <Link key={d.file.id} to={`/oa/training/${d.folderId}/${d.file.id}`} className="block rounded-lg border border-line bg-card p-3 text-[14px] font-semibold text-ink">
              {d.file.title}
              <span className="ml-2 text-[12px] font-normal text-ink-3">{d.folderName}</span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-ink-4">{docs.isPending ? '正在找…' : '没有找到培训资料'}</p>
      )}
    </div>
  );
}

function HomePage() {
  const home = useAcademyHome();
  // 带教（academy.coach，部门负责人）首页就看得到待签的实操
  const canCoach = useCan()('academy.coach');
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  if (q) {
    return (
      <AcademyFrame title="学堂" testId="academy-home">
        <SearchResults q={q} />
      </AcademyFrame>
    );
  }
  if (home.isPending)
    return (
      <AcademyFrame title="学堂" testId="academy-home">
        <Skeleton className="h-36" />
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </AcademyFrame>
    );
  if (home.isError || !home.data)
    return (
      <AcademyFrame title="学堂" testId="academy-home">
        <LoadFailed title="学堂没有取回来" onRetry={() => void home.refetch()} retrying={home.isFetching}>
          {errorMessage(home.error)}
        </LoadFailed>
      </AcademyFrame>
    );
  const { me, required, recommended, resume, paths, categories, canManage } = home.data;
  const nextGap = me.nextLevel ? me.nextLevel.min - me.credits : 0;
  return (
    <AcademyFrame title="学堂" testId="academy-home">
      <AcademyOpsPanel />
      <Card className="overflow-hidden" data-testid="academy-me-card">
        <div className="bg-pine px-4 py-4 text-paper">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-yuzu px-2.5 py-0.5 text-[12px] font-bold text-on-bright">LV{me.level.level}</span>
            <span className="text-[16px] font-bold">{me.level.title}</span>
            <span className="ml-auto text-[13px] opacity-80">{me.name}</span>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-yuzu" style={{ width: `${me.nextLevel ? Math.round(((me.credits - me.level.min) / (me.nextLevel.min - me.level.min)) * 100) : 100}%` }} />
            </div>
            <span className="shrink-0 text-[12px] opacity-90 tabular-nums">{me.nextLevel ? `${me.credits}/${me.nextLevel.min}` : `${me.credits} 满级`}</span>
          </div>
          <p className="mt-1.5 text-[12px] opacity-80">{me.nextLevel ? `再得 ${nextGap} 学分升到 LV${me.nextLevel.level}「${me.nextLevel.title}」` : '已经是最高一级'}</p>
        </div>
        <div className="grid grid-cols-3 divide-x divide-line text-center">
          {[
            ['学分', String(me.credits)],
            ['本月学习', minutesText(me.monthSeconds)],
            ['学完课时', String(me.completedLessons)],
          ].map(([k, v]) => (
            <div key={k} className="px-2 py-2.5">
              <p className="text-[16px] font-bold text-ink tabular-nums">{v}</p>
              <p className="text-[12px] text-ink-3">{k}</p>
            </div>
          ))}
        </div>
      </Card>

      {resume && (
        <Link to={`/oa/academy/lessons/${resume.lessonId}`} className="mo-lift flex items-center gap-3 rounded-lg border border-yuzu/50 bg-yuzu-tint p-3.5" data-testid="academy-resume">
          <Flag className="size-5 shrink-0 text-yuzu-deep" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold text-yuzu-deep">继续学</p>
            <p className="truncate text-[15px] font-bold text-ink">{resume.lessonTitle}</p>
            <p className="truncate text-[12px] text-ink-3">{resume.courseTitle}</p>
          </div>
          <ChevronRight className="size-4 shrink-0 text-ink-4" aria-hidden />
        </Link>
      )}

      <nav className="grid grid-cols-4 gap-2" aria-label="学堂入口">
        {[
          { to: '/oa/academy/paths', label: '学习地图', icon: MapIcon, tone: 'bg-lake-soft text-lake', testId: 'academy-entry-paths' },
          { to: '/oa/academy/daily', label: '每日一练', icon: Brain, tone: 'bg-yuzu-soft text-yuzu-deep', testId: 'academy-entry-daily' },
          { to: '/oa/academy/me', label: '证书与成长', icon: Award, tone: 'bg-ember-soft text-ember-deep', testId: 'academy-entry-me' },
          { to: '/oa/training', label: '知识库', icon: BookOpen, tone: 'bg-pine-soft text-pine', testId: 'academy-entry-knowledge' },
        ].map((e) => (
          <Link key={e.to} to={e.to} className="tap relative flex flex-col items-center gap-1.5 rounded-lg py-2" data-testid={e.testId}>
            <span className={cn('flex size-12 items-center justify-center rounded-full', e.tone)}>
              <e.icon className="size-6" aria-hidden />
            </span>
            <span className="text-[13px] font-semibold text-ink-2">{e.label}</span>
          </Link>
        ))}
      </nav>

      {(canCoach || canManage) && (
        <Link to="/oa/academy/coach" className="mo-lift flex items-center gap-3 rounded-lg border border-line bg-card p-3.5" data-testid="academy-home-coach">
          <ClipboardCheck className="size-6 shrink-0 text-lake" aria-hidden />
          <span className="flex-1 text-[15px] font-bold text-ink">待我签核的实操</span>
          <ChevronRight className="size-4 text-ink-4" aria-hidden />
        </Link>
      )}

      <section className="space-y-2" data-testid="academy-required">
        <h2 className="text-[16px] font-bold text-ink">我的必修</h2>
        {required.length ? required.map((a) => <AssignedCard key={`${a.kind}-${a.id}`} a={a} />) : <p className="text-[13px] text-ink-4">现在没有指派给你的必修。</p>}
      </section>
      {recommended.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[16px] font-bold text-ink">推荐你学</h2>
          {recommended.map((a) => (
            <AssignedCard key={`${a.kind}-${a.id}`} a={a} />
          ))}
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-bold text-ink">学习地图</h2>
          <Link to="/oa/academy/paths" className="text-[13px] font-semibold text-pine">
            全部
          </Link>
        </div>
        {paths.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {paths.slice(0, 4).map((p) => (
              <PathCard key={p.id} p={p} />
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-ink-4">还没有上架的学习地图。</p>
        )}
      </section>

      <section className="space-y-2" data-testid="academy-centers">
        <h2 className="text-[16px] font-bold text-ink">知识中心</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {categories
            .filter((c) => c.count > 0)
            .map((c) => (
              <Link key={c.category} to={`/oa/academy/courses?category=${c.category}`} className="mo-lift rounded-lg border border-line bg-card p-3">
                <p className="text-[15px] font-bold text-ink">{ACADEMY_CATEGORY_LABELS[c.category]}</p>
                <p className="text-[12px] text-ink-3">{c.count} 门课</p>
              </Link>
            ))}
          <Link to="/oa/training" className="mo-lift rounded-lg border border-dashed border-line-strong p-3">
            <p className="text-[15px] font-bold text-ink">培训资料</p>
            <p className="text-[12px] text-ink-3">员工手册、部门文件</p>
          </Link>
        </div>
      </section>

      <RankPreview />

      {canManage && (
        <Link to="/admin/academy" className="flex items-center justify-center gap-1.5 py-2 text-[13px] font-semibold text-ink-3" data-testid="academy-manage-link">
          <Settings className="size-4" aria-hidden />
          学堂管理
        </Link>
      )}
    </AcademyFrame>
  );
}

function RankList({ board, period, scope, limit }: { board: AcademyRankBoard; period: AcademyRankPeriod; scope: AcademyRankScope; limit?: number }) {
  const rank = useAcademyRank(board, period, scope);
  if (rank.isError && !rank.data) return <LoadFailed title="榜单没有取回来" onRetry={() => void rank.refetch()} />;
  if (!rank.data) return <Skeleton className="h-40" />;
  const rows = limit ? rank.data.rows.slice(0, limit) : rank.data.rows;
  const unit = board === 'credits' ? '学分' : '分钟';
  const me = rank.data.me;
  return (
    <div className="space-y-1.5" data-testid={`academy-rank-${board}`}>
      {!rows.length && <EmptyState title="还没有人上榜" description="学完一个课时就有学分" art="calm" />}
      {rows.map((r) => (
        <div key={r.staffId} className={cn('flex items-center gap-3 rounded-lg px-3 py-2', me?.staffId === r.staffId ? 'bg-yuzu-tint' : 'bg-card')}>
          <span
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold',
              r.rank === 1 ? 'bg-yuzu text-on-bright' : r.rank === 2 ? 'bg-paper-3 text-ink' : r.rank === 3 ? 'bg-ember-soft text-ember-deep' : 'text-ink-3',
            )}
          >
            {r.rank}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold text-ink">{r.name}</p>
            <p className="truncate text-[12px] text-ink-3">{[r.storeName, r.departmentName].filter(Boolean).join(' · ')}</p>
          </div>
          <span className="shrink-0 text-[16px] font-bold text-ink tabular-nums">
            {r.value}
            <span className="ml-0.5 text-[12px] font-normal text-ink-3">{unit}</span>
          </span>
        </div>
      ))}
      {me && !rows.some((r) => r.staffId === me.staffId) && (
        <p className="px-3 text-[13px] text-ink-3">
          我排第 {me.rank} 名（{me.value} {unit}）
        </p>
      )}
    </div>
  );
}

function RankPreview() {
  const [board, setBoard] = useState<AcademyRankBoard>('credits');
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[16px] font-bold text-ink">
          <Trophy className="size-4 text-yuzu-deep" aria-hidden />
          本月榜单
        </h2>
        <Link to="/oa/academy/rank" className="text-[13px] font-semibold text-pine">
          更多
        </Link>
      </div>
      <Segmented
        size="sm"
        value={board}
        onChange={setBoard}
        ariaLabel="榜单"
        options={[
          { value: 'credits', label: '学分榜' },
          { value: 'minutes', label: '时长榜' },
        ]}
      />
      <RankList board={board} period="month" scope="company" limit={5} />
    </section>
  );
}

function RankPage() {
  const [board, setBoard] = useState<AcademyRankBoard>('credits');
  const [period, setPeriod] = useState<AcademyRankPeriod>('month');
  const [scope, setScope] = useState<AcademyRankScope>('company');
  return (
    <AcademyFrame title="榜单" back={{ to: '/oa/academy', label: '学堂' }} testId="academy-rank-page">
      <div className="flex flex-wrap gap-2">
        <Segmented
          size="sm"
          value={board}
          onChange={setBoard}
          ariaLabel="榜单"
          options={[
            { value: 'credits', label: '学分榜' },
            { value: 'minutes', label: '时长榜' },
          ]}
        />
        <Segmented
          size="sm"
          value={period}
          onChange={setPeriod}
          ariaLabel="时间"
          options={[
            { value: 'month', label: '本月' },
            { value: 'all', label: '累计' },
          ]}
        />
        <Segmented
          size="sm"
          value={scope}
          onChange={setScope}
          ariaLabel="范围"
          options={[
            { value: 'company', label: '全公司' },
            { value: 'store', label: '本店' },
          ]}
        />
      </div>
      <RankList board={board} period={period} scope={scope} />
    </AcademyFrame>
  );
}

function PathsPage() {
  const home = useAcademyHome();
  return (
    <AcademyFrame title="学习地图" back={{ to: '/oa/academy', label: '学堂' }} testId="academy-paths">
      {home.isError && !home.data ? (
        <LoadFailed title="学习地图没有取回来" onRetry={() => void home.refetch()} />
      ) : !home.data ? (
        <Skeleton className="h-40" />
      ) : home.data.paths.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {home.data.paths.map((p) => (
            <PathCard key={p.id} p={p} />
          ))}
        </div>
      ) : (
        <EmptyState title="还没有上架的学习地图" art="leaf" />
      )}
    </AcademyFrame>
  );
}

const ROW = 112;

/** 学习地图：一条蜿蜒的路，每个阶段（一门课）一个节点，节点上写「学完的课时 / 课时」 */
function PathPage({ id }: { id: number }) {
  const path = useAcademyPath(id);
  if (path.isError && !path.data)
    return (
      <AcademyFrame title="学习地图" back={{ to: '/oa/academy/paths', label: '地图' }}>
        <LoadFailed title="这张地图没有取回来" onRetry={() => void path.refetch()}>
          {errorMessage(path.error)}
        </LoadFailed>
      </AcademyFrame>
    );
  if (!path.data)
    return (
      <AcademyFrame title="学习地图" back={{ to: '/oa/academy/paths', label: '地图' }}>
        <Skeleton className="h-80" />
      </AcademyFrame>
    );
  const p = path.data;
  const stages = p.stages;
  const h = stages.length * ROW;
  const xs = stages.map((_, i) => (i % 2 === 0 ? 24 : 76));
  const ys = stages.map((_, i) => i * ROW + ROW / 2);
  const d = stages.map((_, i) => (i === 0 ? `M ${xs[0]} ${ys[0]}` : `C ${xs[i - 1]} ${ys[i - 1]! + ROW * 0.6}, ${xs[i]} ${ys[i]! - ROW * 0.6}, ${xs[i]} ${ys[i]}`)).join(' ');
  return (
    <AcademyFrame title={p.title} back={{ to: '/oa/academy/paths', label: '地图' }} testId="academy-path-page">
      <Card className={cn('p-4', COVER_CLASS[p.cover].soft)}>
        <p className="text-[14px] leading-relaxed text-ink-2">{p.summary}</p>
        <div className="mt-3 flex items-center gap-2">
          <ProgressBar done={p.doneCount} total={p.courseCount} className="flex-1" />
          <span className="text-[13px] font-semibold text-ink-2 tabular-nums" data-testid="academy-path-progress">
            {p.doneCount}/{p.courseCount}
          </span>
        </div>
        <p className="mt-2 text-[12px] text-ink-3">
          学完另得 {p.credits} 学分并发证书{p.validMonths ? `（${p.validMonths} 个月有效）` : ''}
        </p>
      </Card>
      {stages.length ? (
        <div className="relative" style={{ height: h }} data-testid="academy-path-road">
          <svg className="absolute inset-0 h-full w-full text-line-strong" viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" aria-hidden>
            <path d={d} fill="none" stroke="currentColor" strokeWidth={6} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {stages.map((c, i) => {
            const done = c.lessonCount > 0 && c.doneCount === c.lessonCount;
            const left = i % 2 === 0;
            return (
              <Link
                key={c.id}
                to={`/oa/academy/courses/${c.id}`}
                className={cn('absolute flex w-[88%] items-center gap-2', left ? 'left-[24%] -translate-x-6' : 'right-[24%] translate-x-6 flex-row-reverse text-right')}
                style={{ top: ys[i]! - 24 }}
                data-testid={`academy-stage-${c.id}`}
              >
                <span
                  className={cn(
                    'flex size-12 shrink-0 items-center justify-center rounded-full border-4 border-paper text-[13px] font-bold shadow-card tabular-nums',
                    done ? 'bg-pine text-paper' : c.doneCount > 0 ? 'bg-yuzu text-on-bright' : 'bg-card text-ink-3',
                  )}
                >
                  {c.doneCount}/{c.lessonCount}
                </span>
                <span className="min-w-0 max-w-[60%] rounded-md bg-card px-2.5 py-1.5 shadow-card">
                  <span className="block truncate text-[14px] font-bold text-ink">{c.title}</span>
                  <span className="block text-[12px] text-ink-3">{done ? '已学完' : c.doneCount > 0 ? '学习中' : `第 ${i + 1} 站`}</span>
                </span>
              </Link>
            );
          })}
        </div>
      ) : (
        <EmptyState title="这张地图还没有上架的课" art="leaf" />
      )}
    </AcademyFrame>
  );
}

function CoursesPage() {
  const [params, setParams] = useSearchParams();
  const category = (params.get('category') ?? '') as AcademyCategory | '';
  const courses = useAcademyCourses('', category);
  return (
    <AcademyFrame title={category ? ACADEMY_CATEGORY_LABELS[category] : '知识中心'} back={{ to: '/oa/academy', label: '学堂' }} testId="academy-courses">
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {(['', ...ACADEMY_CATEGORIES] as const).map((c) => (
          <button
            key={c || 'all'}
            type="button"
            onClick={() => setParams(c ? { category: c } : {}, { replace: true })}
            className={cn('tap relative h-8 shrink-0 rounded-full px-3 text-[13px] font-semibold', category === c ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2')}
          >
            {c ? ACADEMY_CATEGORY_LABELS[c] : '全部'}
          </button>
        ))}
      </div>
      {courses.isError && !courses.data ? (
        <LoadFailed title="课程没有取回来" onRetry={() => void courses.refetch()} />
      ) : !courses.data ? (
        <Skeleton className="h-40" />
      ) : courses.data.length ? (
        <div className="space-y-2">
          {courses.data.map((c) => (
            <CourseRow key={c.id} c={c} />
          ))}
        </div>
      ) : (
        <EmptyState title="这一类还没有上架的课" art="search" />
      )}
    </AcademyFrame>
  );
}
