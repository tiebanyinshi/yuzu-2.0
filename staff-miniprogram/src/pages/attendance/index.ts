// 考勤记录（docs/STAFF_MP.md 第 2.4 节）：本人一个月的汇总与每一班的结果（GET /api/oa/me/attendance?month=）；
// 缺卡、还在 30 天补卡期限内的给「补卡」——带着日期、班次、哪张卡进补卡单（与 WCP 网页同一个预填）；审批中的写「补卡审批中」。

import type { MyAttendance } from '../../../../src/shared/oa';
import { call, isApiError, isOffline, messageOf } from '../../utils/api';
import type { AttendanceRowView } from '../../utils/attendance';
import { attendanceRows } from '../../utils/attendance';
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
    rows: [] as AttendanceRowView[],
    summary: null as null | { attended: string; late: string; early: string; missing: string },
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
      const a = await call<MyAttendance>('GET', `/oa/me/attendance?month=${month}`);
      if (month !== this.data.month) return;
      const s = a.summary;
      const missing = a.rows.filter((r) => r.missingIn || r.missingOut).length;
      this.setData({
        rows: attendanceRows(a),
        summary: {
          attended: `${s.attendedDays} / ${s.scheduledDays} 天`,
          late: s.lateCount ? `${s.lateCount} 次 · ${s.lateMinutes} 分钟` : '没有',
          early: s.earlyCount ? `${s.earlyCount} 次 · ${s.earlyMinutes} 分钟` : '没有',
          missing: missing ? `${missing} 班` : '没有',
        },
        state: a.rows.length ? 'ready' : 'empty',
        error: '',
      });
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

  onMakeup(e: WechatMiniprogram.TouchEvent) {
    const { date, shift, kind } = e.currentTarget.dataset as { date: string; shift: number; kind: string };
    wx.navigateTo({ url: `/pages/apply/index?code=makeup&date=${date}&shiftId=${shift}&kind=${kind}` });
  },

  onPendingApproval(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/approval/index?id=${e.currentTarget.dataset.id}` });
  },
});
