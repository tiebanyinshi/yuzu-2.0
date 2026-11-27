// 学堂的课程列表（知识中心的一个分类，或全部）：一行一门课（分类、几节、约几分钟、几学分、学到哪）。

import type { AcademyCategory } from '../../../../src/shared/academy';
import type { CourseRow } from '../../utils/academy';
import { CATEGORY_LABELS, courseRow, loadCourses } from '../../utils/academy';
import { isApiError, isOffline, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';

let gen = 0;

Page({
  data: {
    large: false,
    category: '' as AcademyCategory | '',
    name: '全部课程',
    state: 'loading',
    error: '',
    courses: [] as CourseRow[],
  },

  onLoad(q: Record<string, string | undefined>) {
    const category = q.category && q.category in CATEGORY_LABELS ? (q.category as AcademyCategory) : '';
    this.setData({ large: largeTextOn(), category, name: category ? CATEGORY_LABELS[category] : '全部课程' });
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
      const rows = (await loadCourses(this.data.category)).map(courseRow);
      if (my !== gen) return;
      this.setData({ courses: rows, state: rows.length ? 'ready' : 'empty', error: '' });
    } catch (e) {
      if (my !== gen) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      if (!this.data.courses.length) this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
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
