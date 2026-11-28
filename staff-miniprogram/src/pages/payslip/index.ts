// 一张工资条（docs/STAFF_MP.md 第 2.4 节）：实发放大写在上面，各项一行一行（等宽数字）；「确认签收」记签收时间（签过的不再显示）；
// 「有异议」进「工资条异议」单，工资条那一栏自动填好（与 WCP 网页同一个预填）。打开明细门店系统会记一次查看（薪资审计）。

import type { MyPayslipDetail } from '../../../../src/shared/oa-payroll';
import { call, isApiError, isOffline, messageOf } from '../../utils/api';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import type { PayslipView } from '../../utils/payslip';
import { payslipView } from '../../utils/payslip';
import { largeTextOn } from '../../utils/prefs';

Page({
  data: {
    large: false,
    id: 0,
    state: 'loading',
    error: '',
    view: null as PayslipView | null,
    signedText: '',
    busy: false,
    actionError: '',
  },

  onLoad(q: Record<string, string | undefined>) {
    this.setData({ large: largeTextOn(), id: Number(q.id) || 0 });
  },

  async onShow() {
    if (!(await requireMe())) return;
    if (this.data.state !== 'ready') this.load();
  },

  show(d: MyPayslipDetail) {
    const view = payslipView(d);
    this.setData({ view, signedText: view.signed ? `${shortTime(view.signed)} 已签收` : '', state: 'ready', error: '' });
  },

  async load() {
    try {
      this.show(await call<MyPayslipDetail>('GET', `/oa/my/payslips/${this.data.id}`));
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  /** 签收：签过的再点也不变（门店系统那边一样），所以不用操作编号与「结果待确认」 */
  async onSign() {
    if (this.data.busy) return;
    this.setData({ busy: true, actionError: '' });
    try {
      this.show(await call<MyPayslipDetail>('POST', `/oa/my/payslips/${this.data.id}/sign`, {}));
      wx.showToast({ title: '签收了', icon: 'success', duration: 1500 });
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ actionError: messageOf(e) });
    } finally {
      this.setData({ busy: false });
    }
  },

  onObjection() {
    const v = this.data.view;
    if (!v) return;
    wx.navigateTo({ url: `/pages/apply/index?code=payslip_objection&f.payslip=${encodeURIComponent(v.objection)}` });
  },
});
