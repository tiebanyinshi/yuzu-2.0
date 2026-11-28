// 假期余额（docs/STAFF_MP.md 第 2.4 节）：今年每个假种还剩几天、最近的发放与扣减（GET /api/oa/me/leave）；「请假」进请假单。

import type { MyLeave } from '../../../../src/shared/oa';
import { call, isApiError, isOffline, messageOf } from '../../utils/api';
import type { BalanceRow } from '../../utils/attendance';
import { balanceRows, entryText } from '../../utils/attendance';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    year: 0,
    balances: [] as BalanceRow[],
    entries: [] as { id: number; text: string; sub: string }[],
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    if (!(await requireMe())) return;
    this.load();
  },

  async load() {
    try {
      const l = await call<MyLeave>('GET', '/oa/me/leave');
      this.setData({
        year: l.year,
        balances: balanceRows(l.balances),
        entries: l.entries.slice(0, 20).map((e) => ({ id: e.id, text: entryText(e), sub: [shortTime(e.createdAt), e.reason, e.createdByName].filter(Boolean).join(' · ') })),
        state: 'ready',
        error: '',
      });
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  onApply() {
    wx.navigateTo({ url: '/pages/apply/index?code=leave' });
  },
});
