// 学习地图：一张地图按顺序的几个阶段（每个阶段是一门课），学到哪一目了然；学完整张地图有学分、有证书（学堂发）。

import type { CourseRow } from '../../utils/academy';
import { courseRow, loadPath } from '../../utils/academy';
import { isApiError, isOffline, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';

let gen = 0;

Page({
  data: {
    large: false,
    id: 0,
    state: 'loading',
    error: '',
    title: '学习地图',
    summary: '',
    meta: '',
    stages: [] as (CourseRow & { no: number })[],
  },

  onLoad(q: Record<string, string | undefined>) {
    this.setData({ large: largeTextOn(), id: Number(q.id) || 0 });
  },

  async onShow() {
    if (!(await requireMe())) return;
    this.load();
  },

  onHide() {
    gen += 1;
  },

  async load() {
    const my = ++gen;
    try {
      const p = await loadPath(this.data.id);
      if (my !== gen) return;
      const done = p.courseCount > 0 && p.doneCount >= p.courseCount;
      this.setData({
        state: 'ready',
        error: '',
        title: p.title,
        summary: p.summary,
        meta: `${p.courseCount} 个阶段 · ${done ? '已学完' : `完成 ${p.doneCount}/${p.courseCount}`} · 学完得 ${p.credits} 学分${p.validMonths ? `、证书 ${p.validMonths} 个月有效` : ''}`,
        stages: p.stages.map((c, k) => ({ ...courseRow(c), no: k + 1 })),
      });
    } catch (e) {
      if (my !== gen) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      if (this.data.state !== 'ready') this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  onCourse(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/academy-course/index?id=${(e.currentTarget.dataset as { id: number }).id}` });
  },
});
