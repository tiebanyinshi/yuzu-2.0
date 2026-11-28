// 带教签核（docs/STAFF_MP.md 第 2.3 节，第二版）：本部门同事在学、还没签「通过」的实操课时（学堂管理员看全部）；
// 照学堂的 /api/academy/coach，能不能签、签谁由学堂当场核对。点一项去签。

import type { CoachRow } from '../../utils/academy';
import { coachRow, loadCoachQueue } from '../../utils/academy';
import { isApiError, isOffline, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';

let gen = 0;

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    rows: [] as CoachRow[],
  },

  onLoad() {
    this.setData({ large: largeTextOn() });
  },

  async onShow() {
    if (!(await requireMe())) return;
    this.load();
  },

  onHide() {
    gen += 1;
  },

  onUnload() {
    gen += 1;
  },

  async load() {
    const my = ++gen;
    try {
      const list = await loadCoachQueue();
      if (my !== gen) return;
      this.setData({ state: list.length ? 'ready' : 'empty', error: '', rows: list.map(coachRow) });
    } catch (e) {
      if (my !== gen) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
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

  onItem(e: WechatMiniprogram.TouchEvent) {
    const { staff, lesson } = e.currentTarget.dataset as { staff: number; lesson: number };
    wx.navigateTo({ url: `/pages/academy-signoff/index?staff=${staff}&lesson=${lesson}` });
  },
});
