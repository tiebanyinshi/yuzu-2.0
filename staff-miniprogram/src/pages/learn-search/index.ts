// 搜课程与资料（docs/STAFF_MP.md 第 2.3 节）：同一个输入框搜汤崎学堂的课程（学堂的课程列表按关键字，能用学堂的才搜）
// 与培训资料的标题与说明（员工培训的检索接口）；最近搜过的留 5 条（只在这台手机上）。
// 课程没搜成不挡资料：资料照样列出来，课程那一块写「没搜成」，点重试再搜一次。

import { isApiError, messageOf } from '../../utils/api';
import type { CourseRow } from '../../utils/academy';
import { courseRow, searchCourses } from '../../utils/academy';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';
import type { FileRow } from '../../utils/training';
import { fileRow, recentSearches, rememberSearch, searchFiles } from '../../utils/training';

let timer: number | null = null;
let seq = 0;
/** 这个人能不能用学堂（「我是谁」的入口里有 academy） */
let academy = false;

Page({
  data: {
    large: false,
    q: '',
    recent: [] as string[],
    state: 'idle',
    error: '',
    results: [] as FileRow[],
    courses: [] as CourseRow[],
    /** 课程这次没搜成（资料照样列出来） */
    coursesFailed: false,
    academy: false,
  },

  async onLoad() {
    this.setData({ large: largeTextOn(), recent: recentSearches() });
    const me = await requireMe();
    academy = !!me && me.entries.indexOf('academy') >= 0;
    this.setData({ academy });
  },

  onInput(e: WechatMiniprogram.Input) {
    const q = e.detail.value;
    this.setData({ q });
    if (timer !== null) clearTimeout(timer);
    // 停下来 300 毫秒再搜（打字时不每个字都问一次）
    timer = setTimeout(() => this.search(q), 300) as unknown as number;
  },

  onConfirm() {
    this.search(this.data.q, true);
  },

  onRecent(e: WechatMiniprogram.TouchEvent) {
    const q = String(e.currentTarget.dataset.q || '');
    this.setData({ q });
    this.search(q, true);
  },

  onClear() {
    // 等着的那一次不搜了，正在搜的回来也不认
    if (timer !== null) clearTimeout(timer);
    timer = null;
    seq += 1;
    this.setData({ q: '', results: [], courses: [], coursesFailed: false, state: 'idle' });
  },

  async search(raw: string, remember = false) {
    const q = raw.trim();
    const mine = ++seq;
    if (!q) return this.setData({ results: [], courses: [], coursesFailed: false, state: 'idle' });
    this.setData({ state: 'loading', error: '' });
    try {
      const [items, courses] = await Promise.all([
        searchFiles(q),
        academy
          ? searchCourses(q).catch((e: unknown) => {
              if (isApiError(e) && e.status === 401) throw e;
              return null;
            })
          : Promise.resolve([]),
      ]);
      // 打字快时只认最后一次的结果
      if (mine !== seq) return;
      const found = items.length + (courses ? courses.length : 0);
      this.setData({
        results: items.map((i) => fileRow(i.file, i.folderName)),
        courses: (courses ?? []).map(courseRow),
        coursesFailed: courses === null,
        state: found || courses === null ? 'ready' : 'empty',
      });
      if (remember || found) {
        rememberSearch(q);
        this.setData({ recent: recentSearches() });
      }
    } catch (e) {
      if (mine !== seq) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isApiError(e) && e.code === 'NETWORK' ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onRetry() {
    this.search(this.data.q, true);
  },

  onCourse(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/academy-course/index?id=${(e.currentTarget.dataset as { id: number }).id}` });
  },

  onFile(e: WechatMiniprogram.TouchEvent) {
    const { id, folder } = e.currentTarget.dataset as { id: number; folder: number };
    wx.navigateTo({ url: `/pages/learn-file/index?folder=${folder}&id=${id}` });
  },
});
