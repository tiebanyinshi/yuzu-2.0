// 我的排班（docs/STAFF_MP.md 第 2.4 节）：按月看每一天上什么班（今天标出来），上下月切换；请假、缺勤、休息照门店系统给的状态写。
// 接口：GET /api/oa/me/schedule?month=YYYY-MM（WCP 网页同一个）。

import type { MySchedule } from '../../../../src/shared/oa';
import { call, isApiError, isOffline, messageOf } from '../../utils/api';
import type { DayRow } from '../../utils/attendance';
import { dayRows } from '../../utils/attendance';
import { requireMe, toLogin } from '../../utils/guard';
import { monthLabel, shiftMonth } from '../../utils/month';
import { largeTextOn } from '../../utils/prefs';

Page({
  data: {
    large: false,
    month: '',
    monthText: '',
    state: 'loading',
    error: '',
    rows: [] as DayRow[],
    workDays: 0,
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    const me = await requireMe();
    if (!me) return;
    if (!this.data.month) this.setData({ month: me.today.slice(0, 7) });
    this.load();
  },

  async load() {
    const month = this.data.month;
    this.setData({ monthText: monthLabel(month) });
    try {
      const s = await call<MySchedule>('GET', `/oa/me/schedule?month=${month}`);
      // 连点上下月时只认最后一次
      if (month !== this.data.month) return;
      const workDays = s.days.filter((d) => d.items.length > 0).length;
      this.setData({ rows: dayRows(s), workDays, state: workDays ? 'ready' : 'empty', error: '' });
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      if (month === this.data.month) this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onPrev() {
    this.setData({ month: shiftMonth(this.data.month, -1), state: 'loading' });
    this.load();
  },

  onNext() {
    this.setData({ month: shiftMonth(this.data.month, 1), state: 'loading' });
    this.load();
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },
});
