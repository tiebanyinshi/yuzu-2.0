// 学习（docs/STAFF_MP.md 第 2.3 节）：页顶是搜索（上岗前查应知应会最常见）；下面是汤崎学堂（主线的学堂，docs/ACADEMY.md）——
// 等级与学分、继续学习、每日一练、我的必修 / 推荐、学习地图、知识中心（按分类的课程）；最下面是知识库（员工培训的文件夹）。
// 学堂与知识库各取各的，一块取不到不挡另一块；都先画手机上存的（按人存，换了人登录不用上一位的），取不到时标「之前的信息」。

import type { AcademyHome } from '../../../../src/shared/academy';
import type { AssignedRow, CategoryRow, LevelView, PathRow } from '../../utils/academy';
import { assignedRows, categoryRows, dailyLine, levelView, loadAcademyHome, loadDaily, pathRow } from '../../utils/academy';
import { isApiError, isOffline, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';
import type { FolderRow } from '../../utils/training';
import { folderRows, loadFolders } from '../../utils/training';

const CACHE_KEY = 'wcp_learn_folders';
/** 学堂首页画出来的样子（带员工编号：换了人不用上一位的） */
const ACADEMY_KEY = 'wcp_academy_home';

interface AcademyView {
  staffId: number;
  level: LevelView;
  resume: AcademyHome['resume'];
  daily: string;
  required: AssignedRow[];
  recommended: AssignedRow[];
  paths: PathRow[];
  categories: CategoryRow[];
}

/** 离开以后才回来的结果不再画（每次取都加一；知识库与学堂各数各的，重试一块不丢另一块） */
let genKb = 0;
let genAc = 0;

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    stale: false,
    folders: [] as FolderRow[],
    hasAcademy: false,
    acState: 'loading',
    acError: '',
    acStale: false,
    ac: null as AcademyView | null,
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    const me = await requireMe();
    if (!me) return;
    const hasAcademy = me.entries.indexOf('academy') >= 0;
    this.setData({ hasAcademy });
    this.load(++genKb);
    if (hasAcademy) this.loadAcademy(++genAc, me.staff.id);
  },

  onHide() {
    genKb += 1;
    genAc += 1;
  },

  async load(my: number) {
    if (!this.data.folders.length) {
      // 先用上次的把页面画出来（没信号也能看到有哪些文件夹）
      try {
        const cached = wx.getStorageSync(CACHE_KEY) as FolderRow[] | '';
        if (Array.isArray(cached) && cached.length) this.setData({ folders: cached, state: 'ready', stale: true });
      } catch {
        // 读不了当没有
      }
    }
    try {
      const rows = folderRows(await loadFolders());
      if (my !== genKb) return;
      this.setData({ folders: rows, state: rows.length ? 'ready' : 'empty', stale: false, error: '' });
      try {
        wx.setStorageSync(CACHE_KEY, rows);
      } catch {
        // 存不了：只是下次没信号时没有旧的
      }
    } catch (e) {
      if (my !== genKb) return;
      if ((e as { status?: number }).status === 401) return toLogin();
      if (this.data.folders.length) this.setData({ stale: true });
      else this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  async loadAcademy(my: number, staffId: number) {
    if (!this.data.ac || this.data.ac.staffId !== staffId) {
      let cached: AcademyView | null = null;
      try {
        const v = wx.getStorageSync(ACADEMY_KEY) as AcademyView | '';
        if (v && v.staffId === staffId) cached = v;
      } catch {
        // 读不了当没有
      }
      this.setData({ ac: cached, acState: cached ? 'ready' : 'loading', acStale: !!cached });
    }
    try {
      // 每日一练取不到不挡首页（只少一行字）
      const [home, daily] = await Promise.all([loadAcademyHome(), loadDaily().catch(() => null)]);
      if (my !== genAc) return;
      const view: AcademyView = {
        staffId,
        level: levelView(home.me),
        resume: home.resume,
        daily: daily ? dailyLine(daily) : '每天几道题，按记忆曲线复习',
        required: assignedRows(home.required),
        recommended: assignedRows(home.recommended),
        paths: home.paths.map(pathRow),
        categories: categoryRows(home.categories),
      };
      this.setData({ ac: view, acState: 'ready', acStale: false, acError: '' });
      try {
        wx.setStorageSync(ACADEMY_KEY, view);
      } catch {
        // 存不了：只是下次没信号时没有旧的
      }
    } catch (e) {
      if (my !== genAc) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      if (this.data.ac) this.setData({ acStale: true });
      else this.setData({ acState: isOffline(e) ? 'offline' : 'error', acError: messageOf(e) });
    }
  },

  async onPullDownRefresh() {
    const me = await requireMe();
    if (me) await Promise.all([this.load(++genKb), this.data.hasAcademy ? this.loadAcademy(++genAc, me.staff.id) : Promise.resolve()]);
    wx.stopPullDownRefresh();
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load(++genKb);
  },

  async onAcademyRetry() {
    const me = await requireMe();
    if (!me) return;
    this.setData({ acState: 'loading' });
    this.loadAcademy(++genAc, me.staff.id);
  },

  onSearch() {
    wx.navigateTo({ url: '/pages/learn-search/index' });
  },

  onFolder(e: WechatMiniprogram.TouchEvent) {
    const { id, name } = e.currentTarget.dataset as { id: number; name: string };
    wx.navigateTo({ url: `/pages/learn-folder/index?id=${id}&name=${encodeURIComponent(name)}` });
  },

  onResume() {
    const r = this.data.ac?.resume;
    if (r) wx.navigateTo({ url: `/pages/academy-lesson/index?id=${r.lessonId}` });
  },

  onDaily() {
    wx.navigateTo({ url: '/pages/academy-daily/index' });
  },

  onAssigned(e: WechatMiniprogram.TouchEvent) {
    const { kind, id } = e.currentTarget.dataset as { kind: 'path' | 'course'; id: number };
    wx.navigateTo({ url: kind === 'path' ? `/pages/academy-path/index?id=${id}` : `/pages/academy-course/index?id=${id}` });
  },

  onPath(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/academy-path/index?id=${(e.currentTarget.dataset as { id: number }).id}` });
  },

  onCategory(e: WechatMiniprogram.TouchEvent) {
    const { category, label } = e.currentTarget.dataset as { category: string; label: string };
    wx.navigateTo({ url: `/pages/academy-courses/index?category=${category}&name=${encodeURIComponent(label)}` });
  },

  onAllCourses() {
    wx.navigateTo({ url: '/pages/academy-courses/index' });
  },
});
