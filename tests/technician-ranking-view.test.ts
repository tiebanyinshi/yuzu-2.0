// 技师榜单第三批（docs/TECH_RANKING.md）：页面上的排序、前三名、倒计时与进度、筛选与分页（不要数据库）。

import { describe, expect, it } from 'vitest';
import { countdownText, filterRanking, matchesRankingText, pageOf, podiumOf, rankOf, serviceProgress, type RankingService, type RankingTech } from '../src/shared/technician-ranking';

const tech = (no: string, over: Partial<RankingTech> = {}): RankingTech => ({
  id: Number(no.replace(/\D/g, '')) || 1,
  techNo: no,
  name: `技师${no}`,
  realName: `真名${no}`,
  kind: '足浴',
  photoUrl: null,
  status: 'idle',
  note: null,
  popularity: 0,
  overallRank: 1,
  service: null,
  ...over,
});

describe('技师榜单的页面逻辑', () => {
  it('综合榜照服务端顺序；人气榜按人气值从高到低，同分按综合榜先后', () => {
    const list = [tech('01', { overallRank: 1, popularity: 2 }), tech('02', { overallRank: 2, popularity: 5 }), tech('03', { overallRank: 3, popularity: 2 }), tech('04', { overallRank: 4 })];
    expect(rankOf(list, 'overall').map((r) => `${r.rank}:${r.tech.techNo}`)).toEqual(['1:01', '2:02', '3:03', '4:04']);
    expect(rankOf(list, 'popular').map((r) => `${r.rank}:${r.tech.techNo}`)).toEqual(['1:02', '2:01', '3:03', '4:04']);
  });

  it('前三名的标识只在人气榜、人气值大于 0 时给', () => {
    expect(podiumOf(1, 5, 'popular')).toBe(1);
    expect(podiumOf(3, 1, 'popular')).toBe(3);
    expect(podiumOf(4, 9, 'popular')).toBeNull();
    expect(podiumOf(1, 0, 'popular')).toBeNull();
    expect(podiumOf(1, 5, 'overall')).toBeNull();
  });

  it('服务进度与剩余：按服务器时间算，到点以后剩余为 0、进度满；待上钟的没有', () => {
    const start = Date.parse('2026-11-24T10:00:00Z');
    const s: RankingService = {
      sessionId: 1,
      itemName: '足疗',
      phase: 'serving',
      startedAt: new Date(start).toISOString(),
      minutes: 60,
      plannedEnd: new Date(start + 3_600_000).toISOString(),
      elapsedSeconds: 0,
      remainingSeconds: 3600,
    };
    expect(serviceProgress(s, start + 15 * 60_000)).toEqual({ elapsed: 900, remaining: 2700, ratio: 0.25 });
    expect(serviceProgress(s, start + 59 * 60_000 + 59_500)).toMatchObject({ remaining: 1 });
    expect(serviceProgress(s, start + 70 * 60_000)).toEqual({ elapsed: 4200, remaining: 0, ratio: 1 });
    expect(serviceProgress({ ...s, phase: 'waiting', startedAt: null, plannedEnd: null }, start)).toBeNull();
  });

  it('剩余时间的写法', () => {
    expect(countdownText(0)).toBe('0:00');
    expect(countdownText(65)).toBe('1:05');
    expect(countdownText(45 * 60 + 9)).toBe('45:09');
    expect(countdownText(3600 + 5 * 60 + 9)).toBe('1:05:09');
  });

  it('搜索：技师号（可带 No.）、显示名、名册姓名，不分大小写', () => {
    const t = tech('A12', { name: '小雅', realName: '张小明' });
    for (const q of ['a12', 'No.A12', 'no a1', '小雅', '张小', '']) expect(matchesRankingText(t, q)).toBe(true);
    expect(matchesRankingText(t, 'B1')).toBe(false);
  });

  it('筛选三样叠加；分页超出落到最后一页', () => {
    const list = [tech('01'), tech('02', { kind: '按摩' }), tech('03', { status: 'off' }), tech('04', { kind: '按摩', status: 'serving' })];
    expect(filterRanking(list, { kind: '按摩', status: 'all', text: '' }).map((t) => t.techNo)).toEqual(['02', '04']);
    expect(filterRanking(list, { kind: '按摩', status: 'idle', text: '' }).map((t) => t.techNo)).toEqual(['02']);
    expect(filterRanking(list, { kind: null, status: 'all', text: '03' }).map((t) => t.techNo)).toEqual(['03']);
    const many = Array.from({ length: 13 }, (_, i) => i);
    expect(pageOf(many, 1, 12)).toMatchObject({ page: 1, pages: 2 });
    expect(pageOf(many, 2, 12).items).toEqual([12]);
    expect(pageOf(many, 9, 12)).toMatchObject({ page: 2, items: [12] });
    expect(pageOf([], 1, 12)).toEqual({ items: [], page: 1, pages: 1 });
  });
});
