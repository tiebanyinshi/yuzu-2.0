// 一门课：简介、在哪几张学习地图里、课时一节一节（图文课件、视频 / 文件、测验、实操签核），学到哪一目了然。
// 第二版：「问柚子」（就这门课的课件提问）；学完了能评 1–5 星、写一句（学堂按人、按课存一条，再评是改成新的，原样重发不会多一条）。

import type { LessonRow } from '../../utils/academy';
import { CATEGORY_LABELS, lessonRow, loadCourse, rateCourse } from '../../utils/academy';
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
    /** 学完了才能评分 */
    canRate: false,
    stars: [1, 2, 3, 4, 5],
    rating: 0,
    comment: '',
    rated: '',
    rateBusy: false,
    rateError: '',
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
        canRate: done,
        rated: c.rating && c.rating.count ? `${c.rating.avg.toFixed(1)} 分 · ${c.rating.count} 人评过` : '',
        // 正在改的评分不被刷新盖掉
        ...(this.data.rating ? {} : { rating: c.myFeedback?.rating ?? 0, comment: c.myFeedback?.comment ?? '' }),
      });
    } catch (e) {
      if (my !== gen) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      if (this.data.state !== 'ready') this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onTutor() {
    wx.navigateTo({ url: `/pages/academy-tutor/index?course=${this.data.id}&title=${encodeURIComponent(this.data.title)}` });
  },

  onStar(e: WechatMiniprogram.TouchEvent) {
    if (this.data.rateBusy) return;
    this.setData({ rating: Number(e.currentTarget.dataset.n) || 0, rateError: '' });
  },

  onComment(e: WechatMiniprogram.Input) {
    this.setData({ comment: e.detail.value.slice(0, 300) });
  },

  /** 评分：同一门课一人一条，再评就是改成这一次的（没收到回复再点一次也一样） */
  async onRate() {
    if (this.data.rateBusy) return;
    if (!this.data.rating) return this.setData({ rateError: '点星星评 1–5 星' });
    const my = gen;
    this.setData({ rateBusy: true, rateError: '' });
    try {
      await rateCourse(this.data.id, this.data.rating, this.data.comment.trim());
      if (my !== gen) return;
      wx.showToast({ title: '评好了', icon: 'success', duration: 1200 });
      this.setData({ rateBusy: false });
      this.load();
    } catch (e) {
      if (my !== gen) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ rateBusy: false, rateError: isApiError(e) && (e.status === 0 || e.status >= 500) ? '没收到门店系统的回复：再点一次（评分会改成这一次的，不会多一条）' : messageOf(e) });
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
