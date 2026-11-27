// 汤崎学堂 · 页面的数据层（docs/ACADEMY.md）：查询的键与钩子、写操作（结果待确认走 lib/localOps）、封面色、学习计时。

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcademyCourseDetail,
  AcademyCourseSummary,
  AcademyCover,
  AcademyDaily,
  AcademyHome,
  AcademyLessonView,
  AcademyMeDetail,
  AcademyPathDetail,
  AcademyRank,
  AcademyRankBoard,
  AcademyRankPeriod,
  AcademyRankScope,
} from '@shared/academy';
import { api } from '../../lib/api';
import { createLocalOps, type LocalOp } from '../../lib/localOps';
import { useSession } from '../../lib/session';

export const academyKeys = {
  all: ['academy'] as const,
  home: ['academy', 'home'] as const,
  courses: (q: string, category: string) => ['academy', 'courses', q, category] as const,
  course: (id: number) => ['academy', 'course', id] as const,
  lesson: (id: number) => ['academy', 'lesson', id] as const,
  path: (id: number) => ['academy', 'path', id] as const,
  daily: ['academy', 'daily'] as const,
  me: ['academy', 'me'] as const,
  rank: (board: string, period: string, scope: string) => ['academy', 'rank', board, period, scope] as const,
  coach: ['academy', 'coach'] as const,
  tutor: (courseId: number) => ['academy', 'tutor', courseId] as const,
};

export const useAcademyHome = () => useQuery({ queryKey: academyKeys.home, queryFn: () => api.get<AcademyHome>('/api/academy/home') });
export const useAcademyCourses = (q: string, category: string, enabled = true) =>
  useQuery({
    queryKey: academyKeys.courses(q, category),
    queryFn: () => api.get<AcademyCourseSummary[]>(`/api/academy/courses?${new URLSearchParams({ ...(q ? { q } : {}), ...(category ? { category } : {}) })}`),
    enabled,
  });
export const useAcademyCourse = (id: number) => useQuery({ queryKey: academyKeys.course(id), queryFn: () => api.get<AcademyCourseDetail>(`/api/academy/courses/${id}`) });
export const useAcademyLesson = (id: number) => useQuery({ queryKey: academyKeys.lesson(id), queryFn: () => api.get<AcademyLessonView>(`/api/academy/lessons/${id}`) });
export const useAcademyPath = (id: number) => useQuery({ queryKey: academyKeys.path(id), queryFn: () => api.get<AcademyPathDetail>(`/api/academy/paths/${id}`) });
export const useAcademyDaily = () => useQuery({ queryKey: academyKeys.daily, queryFn: () => api.get<AcademyDaily>('/api/academy/daily') });
export const useAcademyMe = () => useQuery({ queryKey: academyKeys.me, queryFn: () => api.get<AcademyMeDetail>('/api/academy/me') });
export const useAcademyRank = (board: AcademyRankBoard, period: AcademyRankPeriod, scope: AcademyRankScope) =>
  useQuery({
    queryKey: academyKeys.rank(board, period, scope),
    queryFn: () => api.get<AcademyRank>(`/api/academy/rank?board=${board}&period=${period}&scope=${scope}`),
  });

/** 学了以后：首页、课程、地图、我的、榜单都重新取 */
export function useAcademyRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: academyKeys.all });
}

// 学堂的写操作都能原样重提（新建带操作编号、交卷与每日一练带编号、修改带版本、学完与报时长重复做不变）：
// 没收到结果的记在本机，学堂首页与「WCP 设置 → 学堂」顶上列出来原样重提
//   · 记录带经办人（Codex 审查 6dffa29）：门店电脑上换人登录，只列、只重提本人的——别人的每日一练原样重提会记到现在登录的人头上；
//   · AI 出题重提时还在出（ACADEMY_AI_RUNNING）：不能断定结果，记录留着。
const ops = createLocalOps('yuzu.academyOps.v1', { stillRunning: ['ACADEMY_AI_RUNNING'] });
type AcademyOpInput = Omit<LocalOp, 'createdAt' | 'staffId'>;

/** 本人没确认的学堂操作 */
export function useAcademyOps(): LocalOp[] {
  const me = useSession().staff.id;
  const all = ops.useOps();
  return useMemo(() => all.filter((op) => op.staffId === me), [all, me]);
}

/** 发一次学堂的写操作（新的或原样重提），记录带上现在登录的人；各组件开头取一次：const sendAcademyOp = useAcademyOp() */
export function useAcademyOp() {
  const me = useSession().staff.id;
  return useCallback(<T = unknown>(op: AcademyOpInput) => ops.send<T>({ ...op, staffId: me }), [me]);
}

/** 封面色：取样式表里已有的几种颜色（深色模式跟着变） */
export const COVER_CLASS: Record<AcademyCover, { solid: string; soft: string; text: string }> = {
  pine: { solid: 'bg-pine text-paper', soft: 'bg-pine-soft', text: 'text-pine' },
  lake: { solid: 'bg-lake text-paper', soft: 'bg-lake-soft', text: 'text-lake' },
  yuzu: { solid: 'bg-yuzu text-on-bright', soft: 'bg-yuzu-soft', text: 'text-yuzu-deep' },
  ember: { solid: 'bg-ember text-paper', soft: 'bg-ember-soft', text: 'text-ember-deep' },
  clay: { solid: 'bg-clay text-paper', soft: 'bg-clay-soft', text: 'text-clay' },
  moss: { solid: 'bg-moss text-paper', soft: 'bg-moss-soft', text: 'text-moss' },
};

/** 秒 → 「1 小时 20 分」 */
export function minutesText(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/**
 * 学习计时：打开课时先报一次（记「开始学」），之后页面在前台时每分钟报一次这一分钟里看了多少秒；切到后台不计。
 * 服务端按两次上报的真实间隔封顶，这里多报也不会多算。
 */
export function useStudyTimer(lessonId: number, enabled: boolean) {
  const visibleSince = useRef<number | null>(null);
  const banked = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const ping = (seconds: number) => api.post(`/api/academy/lessons/${lessonId}/ping`, { seconds: Math.min(600, Math.round(seconds)) }).catch(() => undefined);
    const now = () => Date.now();
    const bank = () => {
      if (visibleSince.current !== null) banked.current += (now() - visibleSince.current) / 1000;
      visibleSince.current = document.visibilityState === 'visible' ? now() : null;
    };
    visibleSince.current = document.visibilityState === 'visible' ? now() : null;
    banked.current = 0;
    void ping(0);
    const onVisibility = () => bank();
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => {
      bank();
      if (banked.current >= 1) {
        void ping(banked.current);
        banked.current = 0;
      }
    }, 60_000);
    return () => {
      bank();
      if (banked.current >= 5) void ping(banked.current);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, [lessonId, enabled]);
}
