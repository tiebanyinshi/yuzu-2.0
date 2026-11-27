// 学习（docs/STAFF_MP.md 第 2.3 节）：页顶是搜索（上岗前查应知应会最常见）；下面是知识库——员工培训的文件夹（培训资料在前、本部门其次）。
// 汤崎学堂（主线另一个会话在做）的员工端接口合进来以后，在这一页加继续学习、我的必修、每日一练、学习地图、证书。

import { isOffline, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';
import type { FolderRow } from '../../utils/training';
import { folderRows, loadFolders } from '../../utils/training';

const CACHE_KEY = 'wcp_learn_folders';

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    stale: false,
    folders: [] as FolderRow[],
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    if (!(await requireMe())) return;
    this.load();
  },

  async load() {
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
      this.setData({ folders: rows, state: rows.length ? 'ready' : 'empty', stale: false, error: '' });
      try {
        wx.setStorageSync(CACHE_KEY, rows);
      } catch {
        // 存不了：只是下次没信号时没有旧的
      }
    } catch (e) {
      if ((e as { status?: number }).status === 401) return toLogin();
      if (this.data.folders.length) this.setData({ stale: true });
      else this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
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

  onSearch() {
    wx.navigateTo({ url: '/pages/learn-search/index' });
  },

  onFolder(e: WechatMiniprogram.TouchEvent) {
    const { id, name } = e.currentTarget.dataset as { id: number; name: string };
    wx.navigateTo({ url: `/pages/learn-folder/index?id=${id}&name=${encodeURIComponent(name)}` });
  },
});
