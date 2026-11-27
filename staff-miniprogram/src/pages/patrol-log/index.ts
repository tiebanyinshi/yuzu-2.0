// 巡场记录（管理员指定能看的人，员工小程序线 E，docs/STAFF_MP.md 第 5.4 节）：看某一天每一轮巡了几个、漏了哪些、谁巡的。
// 只看不改：作废、导出仍在管理后台。能看哪一天由门店系统核对（不能看以前的只能看今天）。

import { isOffline, messageOf } from '../../utils/api';
import { patrolDay, shiftDate } from '../../utils/canteen';
import { dayLabel, storeClock } from '../../utils/format';
import { requireMe } from '../../utils/guard';
import type { PatrolView } from '../../utils/patrol';
import { patrolView } from '../../utils/patrol';
import { largeTextOn } from '../../utils/prefs';

let seq = 0;

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    date: '',
    today: '',
    minDate: '',
    dateText: '',
    canViewHistory: false,
    view: null as PatrolView | null,
    pick: null as number | null,
  },

  onLoad() {
    const today = storeClock().date;
    this.setData({ today, date: today, minDate: shiftDate(today, -91) });
  },

  onShow() {
    this.setData({ large: largeTextOn() });
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    if (!(await requireMe())) return;
    const mySeq = ++seq;
    const date = this.data.date;
    try {
      const day = await patrolDay(date === this.data.today ? undefined : date);
      if (mySeq !== seq) return;
      const pick = this.data.pick !== null && day.rounds.some((r) => r.no === this.data.pick) ? this.data.pick : null;
      // 营业日还没换（过了零点、没到换日时间）时门店系统回的「今天」不是日历上的今天：选中的日子跟着它，
      // 不然点轮次、下拉刷新会把日历上的日子当成「以后的日子」去问
      this.setData({
        state: 'ready',
        today: day.today,
        date: day.date,
        dateText: (day.date === day.today ? '今天 · ' : '') + dayLabel(day.date),
        canViewHistory: day.canViewHistory,
        view: patrolView(day, pick),
        pick,
      });
    } catch (e) {
      if (mySeq !== seq) return;
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onDate(e: WechatMiniprogram.PickerChange) {
    this.setData({ date: String(e.detail.value), pick: null, state: 'loading' });
    this.load();
  },

  onRound(e: WechatMiniprogram.BaseEvent) {
    const no = Number(e.currentTarget.dataset.no);
    this.setData({ pick: no });
    this.load();
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },
});
