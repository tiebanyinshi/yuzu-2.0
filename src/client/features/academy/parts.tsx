// 汤崎学堂 · 页面共用的几块（外框、进度条、没确认的操作、地图卡、课程行）。

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronLeft, ChevronRight, GraduationCap, Map as MapIcon, RotateCw } from 'lucide-react';
import { ACADEMY_CATEGORY_LABELS, type AcademyCourseSummary, type AcademyPathSummary } from '@shared/academy';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Notice } from '../../components/ui';
import { COVER_CLASS, useAcademyOp, useAcademyOps, useAcademyRefresh } from './data';

/** 页面外框：手机上全宽、宽屏居中；顶上一行返回 + 标题 */
export function AcademyFrame({ title, back, children, testId }: { title: string; back?: { to: string; label: string }; children: ReactNode; testId?: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-3 md:p-7" data-testid={testId}>
      <div className="flex min-w-0 items-center gap-2">
        {back && (
          <Link to={back.to} className="tap relative inline-flex shrink-0 items-center gap-0.5 text-[14px] font-semibold text-pine">
            <ChevronLeft className="size-4" />
            {back.label}
          </Link>
        )}
        <h1 className="min-w-0 flex-1 truncate text-[20px] font-bold tracking-tight text-ink">{title}</h1>
      </div>
      {children}
    </div>
  );
}

export function ProgressBar({ done, total, tone = 'pine', className }: { done: number; total: number; tone?: 'pine' | 'yuzu' | 'lake'; className?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const bar = { pine: 'bg-pine', yuzu: 'bg-yuzu', lake: 'bg-lake' }[tone];
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-paper-3', className)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full transition-[width] duration-500', bar)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 没收到结果的学堂操作：原样重提（新建带编号、交卷带编号，重提不会多一份） */
export function AcademyOpsPanel() {
  const sendAcademyOp = useAcademyOp();
  const ops = useAcademyOps();
  const toast = useToast();
  const refresh = useAcademyRefresh();
  const [busy, setBusy] = useState<string | null>(null);
  if (!ops.length) return null;
  return (
    <Notice tone="warning" title="有操作没收到结果" data-testid="academy-pending-ops">
      <ul className="mt-1 space-y-1.5">
        {ops.map((op) => (
          <li key={op.key} className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="min-w-0 flex-1">{op.summary}</span>
            <Button
              size="sm"
              loading={busy === op.key}
              icon={<RotateCw className="size-3.5" />}
              onClick={async () => {
                setBusy(op.key);
                try {
                  await sendAcademyOp(op);
                  toast({ tone: 'success', title: '已确认：这次操作已生效' });
                  await refresh();
                } catch (e) {
                  toast({ tone: 'error', title: '还是没确认', body: errorMessage(e) });
                } finally {
                  setBusy(null);
                }
              }}
            >
              原样重提
            </Button>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/** 新建对话框里这一笔是不是还没确认（提交过、没收到结果） */
export function useOpPending(key: string) {
  return useAcademyOps().some((op) => op.key === key);
}

/**
 * 新建对话框的内容锁（Codex 审查 34b9815）：这一笔没收到结果时内容锁住、按钮改成「按原内容重新提交」——
 * 同一个操作编号只能原样重提（AGENTS.md 开发约定），改了内容再提服务端会拒绝。关掉对话框以后在页面上方照样能重提。
 */
export function PendingLock({ pending, className, children }: { pending: boolean; className?: string; children: ReactNode }) {
  return (
    <fieldset disabled={pending} className={cn('min-w-0', className)}>
      {pending && (
        <Notice tone="warning" title="这次提交没收到结果" data-testid="academy-op-locked">
          内容先锁住：点下面的「按原内容重新提交」核对结果；也可以关掉，在页面上方的提醒里重提。确认以后再改。
        </Notice>
      )}
      {children}
    </fieldset>
  );
}

export function PathCard({ p }: { p: AcademyPathSummary }) {
  const cover = COVER_CLASS[p.cover];
  const done = p.courseCount > 0 && p.doneCount === p.courseCount;
  return (
    <Link to={`/oa/academy/paths/${p.id}`} className="mo-lift block overflow-hidden rounded-lg border border-line bg-card" data-testid={`academy-path-${p.id}`}>
      <div className={cn('flex h-20 items-end justify-between px-3.5 pb-2.5', cover.solid)}>
        <p className="min-w-0 truncate text-[17px] font-bold">{p.title}</p>
        <MapIcon className="size-6 shrink-0 opacity-70" aria-hidden />
      </div>
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
        <p className="line-clamp-1 min-w-0 text-[13px] text-ink-3">{p.summary}</p>
        <Badge tone={done ? 'pine' : 'neutral'}>{done ? '已完成' : `${p.doneCount}/${p.courseCount}`}</Badge>
      </div>
    </Link>
  );
}

export function CourseRow({ c }: { c: AcademyCourseSummary }) {
  const done = c.lessonCount > 0 && c.doneCount === c.lessonCount;
  return (
    <Link to={`/oa/academy/courses/${c.id}`} className="mo-lift flex items-center gap-3 rounded-lg border border-line bg-card p-3" data-testid={`academy-course-${c.id}`}>
      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-md', COVER_CLASS[c.cover].soft, COVER_CLASS[c.cover].text)}>
        <GraduationCap className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold text-ink">{c.title}</p>
        <p className="truncate text-[12px] text-ink-3">
          {ACADEMY_CATEGORY_LABELS[c.category]} · {c.lessonCount} 节 · 约 {c.minutes} 分钟 · {c.credits} 学分{c.rating ? ` · ${c.rating.avg} 分` : ''}
        </p>
      </div>
      {done ? (
        <Badge tone="pine">已学完</Badge>
      ) : c.doneCount > 0 ? (
        <Badge tone="yuzu">{`${c.doneCount}/${c.lessonCount}`}</Badge>
      ) : (
        <ChevronRight className="size-4 shrink-0 text-ink-4" aria-hidden />
      )}
    </Link>
  );
}
