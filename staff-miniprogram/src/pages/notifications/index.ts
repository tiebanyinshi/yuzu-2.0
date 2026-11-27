// 通知（首页铃铛点进来，docs/STAFF_MP.md 第 2.1 节，SP03）：审批结果、排班变更、工资条、公告……一条一行，没读的加粗；
// 点一条记已读，能对上小程序页面的（审批单、工资条、公告、排班……）直接跳过去；「全部标为已读」。往下滑接着取更早的。

import type { NotificationPage, OaNotification } from '../../../../src/shared/oa';
import { call, isApiError, isOffline, messageOf } from '../../utils/api';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { pageOfLink } from '../../utils/links';
import { largeTextOn } from '../../utils/prefs';

interface Row {
  id: number;
  title: string;
  body: string;
  time: string;
  unread: boolean;
  page: string;
}

const rowOf = (n: OaNotification): Row => ({ id: n.id, title: n.title, body: n.body, time: shortTime(n.createdAt), unread: !n.readAt, page: pageOfLink(n.link) ?? '' });

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    rows: [] as Row[],
    unread: 0,
    next: null as number | null,
    loadingMore: false,
    actionError: '',
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    if (!(await requireMe())) return;
    this.load();
  },

  async load() {
    try {
      const p = await call<NotificationPage>('GET', '/oa/notifications?status=all');
      const rows = p.items.map(rowOf);
      this.setData({ rows, unread: p.unread, next: p.nextBefore, state: rows.length ? 'ready' : 'empty', error: '' });
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  async onReachBottom() {
    const { next, loadingMore } = this.data;
    if (!next || loadingMore) return;
    this.setData({ loadingMore: true });
    try {
      const p = await call<NotificationPage>('GET', `/oa/notifications?status=all&before=${next}`);
      this.setData({ rows: this.data.rows.concat(p.items.map(rowOf)), next: p.nextBefore });
    } catch {
      // 下一页没取到：再往下滑会再试
    } finally {
      this.setData({ loadingMore: false });
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

  async onOpen(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const row = this.data.rows.find((r) => r.id === id);
    if (!row) return;
    if (row.unread) {
      this.setData({ rows: this.data.rows.map((r) => (r.id === id ? { ...r, unread: false } : r)), unread: Math.max(0, this.data.unread - 1) });
      call('POST', '/oa/notifications/read', { ids: [id] }).catch(() => undefined);
    }
    if (row.page) wx.navigateTo({ url: row.page });
  },

  async onReadAll() {
    this.setData({ actionError: '' });
    try {
      await call('POST', '/oa/notifications/read', { all: true });
      this.setData({ rows: this.data.rows.map((r) => ({ ...r, unread: false })), unread: 0 });
    } catch (e) {
      this.setData({ actionError: messageOf(e) });
    }
  },
});
