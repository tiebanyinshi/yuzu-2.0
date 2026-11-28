// 一条公告：标题、谁什么时候发的、正文、附件（图片用短时地址看、文档下载后预览）；打开就记已读。

import type { StaffMpMediaLink } from '../../../../src/shared/staffmp';
import type { OaAnnouncement } from '../../../../src/shared/oa';
import { absoluteUrl, call, download, isApiError, isOffline, messageOf } from '../../utils/api';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';

let item: OaAnnouncement | null = null;

Page({
  data: {
    large: false,
    id: 0,
    state: 'loading',
    error: '',
    title: '',
    meta: '',
    body: '',
    files: [] as { id: number; name: string; isImage: boolean }[],
    actionError: '',
  },

  onLoad(q: Record<string, string | undefined>) {
    this.setData({ large: largeTextOn(), id: Number(q.id) || 0 });
  },

  async onShow() {
    if (!(await requireMe())) return;
    if (this.data.state !== 'ready') this.load();
  },

  async load() {
    try {
      item = await call<OaAnnouncement>('GET', `/oa/announcements/${this.data.id}`);
      this.setData({
        state: 'ready',
        error: '',
        title: item.title,
        meta: `${item.publishedByName} · ${shortTime(item.publishedAt)}`,
        body: item.body,
        files: item.attachments.map((a) => ({ id: a.id, name: a.fileName, isImage: a.isImage })),
      });
      if (!item.readAt) call('POST', `/oa/announcements/${item.id}/read`, {}).catch(() => undefined);
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  async onFile(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const a = item?.attachments.find((x) => x.id === id);
    if (!a) return;
    this.setData({ actionError: '' });
    try {
      if (a.isImage) {
        const link = await call<StaffMpMediaLink>('POST', '/media', { kind: 'attachment', id });
        wx.previewImage({ urls: [absoluteUrl(link.url)] });
        return;
      }
      const ext = (/\.([a-z0-9]+)$/i.exec(a.fileName)?.[1] ?? '').toLowerCase();
      if (!['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) {
        this.setData({ actionError: '这种附件小程序里打不开，请在电脑上的 WCP 里看' });
        return;
      }
      const path = await download(`/oa/attachments/${id}`);
      wx.openDocument({ filePath: path, fileType: ext as 'pdf', showMenu: false, fail: () => this.setData({ actionError: '附件没有打开，请再试一次' }) });
    } catch (err) {
      this.setData({ actionError: messageOf(err) });
    }
  },
});
