// 今天（docs/STAFF_MP.md 第 2.2 节）。这一批先有页头（问候、门店、日期，测试服、演示库的实例标识在导航栏上）与常用入口；
// 此刻卡（按门店系统回的「下一张卡」）、三个固定按钮（打卡 · 饭卡码 · 扫一扫）、待办、铃铛在工作台那一批之后的「今天」一批做。

import type { StaffMpMe } from '../../../../src/shared/staffmp';
import type { EntryView } from '../../utils/entries';
import { entryGroups } from '../../utils/entries';
import { dayLabel, greeting } from '../../utils/format';
import { requireMe } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';
import { refreshMe } from '../../utils/session';

Page({
  data: {
    large: false,
    ready: false,
    hello: '',
    sub: '',
    entries: [] as EntryView[],
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    const me = await requireMe();
    if (me) this.show(me);
  },

  show(me: StaffMpMe) {
    const entries = entryGroups(me.entries).flatMap((g) => g.entries).slice(0, 8);
    this.setData({
      ready: true,
      hello: `${greeting()}，${me.staff.displayName}`,
      sub: `${me.store.name} · ${dayLabel(me.today)}`,
      entries,
    });
  },

  async onPullDownRefresh() {
    try {
      this.show(await refreshMe());
    } catch {
      // 没信号：照旧显示上次的
    }
    wx.stopPullDownRefresh();
  },

  onEntry(e: WechatMiniprogram.TouchEvent) {
    const page = String(e.currentTarget.dataset.page || '');
    if (!page) return;
    if (page.startsWith('/pages/learn/index')) wx.switchTab({ url: page });
    else wx.navigateTo({ url: page });
  },
});
