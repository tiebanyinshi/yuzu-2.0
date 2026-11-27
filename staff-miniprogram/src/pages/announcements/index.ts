// 公告（docs/STAFF_MP.md 第 2.4 节）：公司公告一条一行（置顶的在前，没读的加粗）；点开看全文。GET /api/oa/announcements。

import type { OaAnnouncement, OaAnnouncementList } from '../../../../src/shared/oa';
import { call, isApiError, isOffline, messageOf } from '../../utils/api';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';

interface AnnouncementRow {
  id: number;
  title: string;
  sub: string;
  pinned: boolean;
  unread: boolean;
}

const announcementRow = (a: OaAnnouncement): AnnouncementRow => ({
  id: a.id,
  title: a.title,
  sub: `${a.publishedByName} · ${shortTime(a.publishedAt)}`,
  pinned: a.pinned,
  unread: !a.readAt,
});

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    rows: [] as AnnouncementRow[],
    unread: 0,
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    if (!(await requireMe())) return;
    this.load();
  },

  async load() {
    try {
      const l = await call<OaAnnouncementList>('GET', '/oa/announcements');
      const rows = l.items
        .slice()
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.publishedAt.localeCompare(a.publishedAt))
        .map(announcementRow);
      this.setData({ rows, unread: l.unreadCount, state: rows.length ? 'ready' : 'empty', error: '' });
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

  onOpen(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/announcement/index?id=${e.currentTarget.dataset.id}` });
  },
});
