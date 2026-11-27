// 工资条（docs/STAFF_MP.md 第 2.4 节）：发给我的工资条一月一行（列表不带金额，金额只在明细里，明细每次都记审计）；没签收的标出来。

import type { MyPayslipItem } from '../../../../src/shared/oa-payroll';
import { call, isApiError, isOffline, messageOf } from '../../utils/api';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { monthLabel } from '../../utils/month';
import { largeTextOn } from '../../utils/prefs';

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    rows: [] as { id: number; title: string; sub: string; signed: boolean }[],
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    if (!(await requireMe())) return;
    this.load();
  },

  async load() {
    try {
      const items = await call<MyPayslipItem[]>('GET', '/oa/my/payslips');
      const rows = items.map((p) => ({
        id: p.id,
        title: `${monthLabel(p.month)} · ${p.title}`,
        sub: `${shortTime(p.publishedAt)} 发放${p.signedAt ? ` · ${shortTime(p.signedAt)} 签收` : ''}`,
        signed: !!p.signedAt,
      }));
      this.setData({ rows, state: rows.length ? 'ready' : 'empty', error: '' });
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
    wx.navigateTo({ url: `/pages/payslip/index?id=${e.currentTarget.dataset.id}` });
  },
});
