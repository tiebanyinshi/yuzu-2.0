// 一门课：简介、在哪几张学习地图里、课时一节一节（图文课件、视频 / 文件、测验、实操签核），学到哪一目了然。

import type { LessonRow } from '../../utils/academy';
import { CATEGORY_LABELS, lessonRow, loadCourse } from '../../utils/academy';
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
    title: '',
    summary: '',
    meta: '',
    paths: '',
    lessons: [] as LessonRow[],
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
      const c = await loadCourse(this.data.id);
      if (my !== gen) return;
      const done = c.lessonCount > 0 && c.doneCount >= c.lessonCount;
      this.setData({
        state: 'ready',
        error: '',
        title: c.title,
        summary: c.summary,
        meta: `${CATEGORY_LABELS[c.category] ?? ''} · ${c.lessonCount} 节 · 约 ${c.minutes} 分钟 · ${done ? '已学完' : `学了 ${c.doneCount}/${c.lessonCount}`}`,
        paths: c.paths.length ? `在学习地图：${c.paths.map((p) => p.title).join('、')}` : '',
        lessons: c.lessons.map(lessonRow),
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

  onLesson(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/academy-lesson/index?id=${(e.currentTarget.dataset as { id: number }).id}` });
  },
});
