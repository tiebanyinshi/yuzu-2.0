// 知识库的一个文件夹：资料一行一个（标题、格式、大小、什么时候更新），没看过这一版的标「新」。

import { isOffline, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';
import type { FileRow } from '../../utils/training';
import { fileRow, loadFiles } from '../../utils/training';

/** 文件夹名是编码过带过来的；坏了的原样显示，不让页面出错 */
function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

Page({
  data: {
    large: false,
    id: 0,
    name: '',
    state: 'loading',
    error: '',
    files: [] as FileRow[],
    unseen: 0,
  },

  onLoad(q: Record<string, string | undefined>) {
    this.setData({ large: largeTextOn(), id: Number(q.id) || 0, name: q.name ? decodeSafe(q.name) : '资料' });
  },

  async onShow() {
    if (!(await requireMe())) return;
    this.load();
  },

  async load() {
    try {
      const rows = (await loadFiles(this.data.id)).map((f) => fileRow(f));
      this.setData({ files: rows, unseen: rows.filter((r) => r.isNew).length, state: rows.length ? 'ready' : 'empty', error: '' });
    } catch (e) {
      if ((e as { status?: number }).status === 401) return toLogin();
      if (!this.data.files.length) this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
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

  onFile(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/learn-file/index?folder=${this.data.id}&id=${e.currentTarget.dataset.id}` });
  },
});
