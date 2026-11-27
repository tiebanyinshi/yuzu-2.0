// 菜单（员工小程序线 E，docs/STAFF_MP.md 第 5.4 节）：今天起 7 天已经发布的菜单，按天、按餐列；每道菜可以点个赞（再点取消）。
// 厨师改菜单仍在柚子饭堂网页上（小程序只看、点赞）。

import { isOffline, messageOf } from '../../utils/api';
import type { DayView } from '../../utils/canteen';
import { likeDish, loadMenus, menuDays, shiftDate } from '../../utils/canteen';
import { storeClock } from '../../utils/format';
import { requireMe } from '../../utils/guard';
import { buzz, largeTextOn } from '../../utils/prefs';

Page({
  data: { large: false, state: 'loading', error: '', days: [] as DayView[], liking: '' },

  onShow() {
    this.setData({ large: largeTextOn() });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    if (!(await requireMe())) return;
    const today = storeClock().date;
    try {
      const menus = await loadMenus(today, shiftDate(today, 6));
      const days = menuDays(
        menus.filter((m) => m.published),
        today,
      );
      this.setData({ days, state: days.length ? 'ready' : 'empty' });
    } catch (e) {
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  /** 点赞 / 取消：先改页面（马上有反应），门店系统回了以后按回的数改；失败改回来 */
  async onLike(e: WechatMiniprogram.BaseEvent) {
    const { day, meal, dish } = e.currentTarget.dataset as { day: number; meal: number; dish: number };
    const d = this.data.days[day]?.meals[meal]?.dishes[dish];
    if (!d || this.data.liking === d.key) return;
    const path = `days[${day}].meals[${meal}].dishes[${dish}]`;
    const liked = !d.liked;
    buzz();
    this.setData({ liking: d.key, [`${path}.liked`]: liked, [`${path}.likes`]: Math.max(0, d.likes + (liked ? 1 : -1)) });
    try {
      const r = await likeDish(d.menuId, d.id, liked);
      this.setData({ [`${path}.liked`]: r.liked, [`${path}.likes`]: r.likes });
    } catch (err) {
      this.setData({ [`${path}.liked`]: d.liked, [`${path}.likes`]: d.likes });
      wx.showToast({ title: messageOf(err), icon: 'none' });
    } finally {
      this.setData({ liking: '' });
    }
  },
});
