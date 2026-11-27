// 通讯录（docs/STAFF_MP.md 第 2.4 节）：GET /api/oa/directory；按部门分组，搜姓名、工号、手机号；点有手机号的人直接拨。

import type { Directory } from '../../../../src/shared/oa-directory';
import { call, isApiError, isOffline, messageOf } from '../../utils/api';
import type { DeptGroup } from '../../utils/directory';
import { directoryGroups } from '../../utils/directory';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';

/** 上次取到的通讯录与它是谁看的（手机号按看的人打码：换了人登录不能用上一位的） */
let dir: Directory | null = null;
let dirOwner = 0;

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    q: '',
    groups: [] as DeptGroup[],
    total: 0,
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    const me = await requireMe();
    if (!me) return;
    if (dirOwner !== me.staff.id) {
      dir = null;
      dirOwner = me.staff.id;
    }
    // 先画上次的（同一个人的），每次进来都重新取
    if (dir) this.render();
    this.load();
  },

  async load() {
    const owner = dirOwner;
    try {
      const next = await call<Directory>('GET', '/oa/directory');
      if (owner !== dirOwner) return;
      dir = next;
      this.render();
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      // 有上次的就照旧显示
      if (dir) return;
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  render() {
    if (!dir) return;
    const groups = directoryGroups(dir, this.data.q);
    const total = groups.reduce((n, g) => n + g.people.length, 0);
    this.setData({ groups, total, state: total ? 'ready' : 'empty', error: '' });
  },

  onSearch(e: WechatMiniprogram.Input) {
    this.setData({ q: e.detail.value });
    this.render();
  },

  onClear() {
    this.setData({ q: '' });
    this.render();
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  onCall(e: WechatMiniprogram.TouchEvent) {
    const { phone, callable, name } = e.currentTarget.dataset as { phone: string; callable: boolean; name: string };
    if (!callable) {
      wx.showModal({ title: name, content: phone ? '你看不到这位同事的手机号，有事可以找他的主管或人事。' : '这位同事还没有留手机号。', showCancel: false, confirmText: '知道了' });
      return;
    }
    wx.makePhoneCall({ phoneNumber: phone, fail: () => undefined });
  },
});
