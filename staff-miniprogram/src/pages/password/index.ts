// 改密码（docs/STAFF_MP.md 第 6 节）：第一次登录要先改掉初始密码（first=1，改完才能用别的）；平时从「我的」进来。
// 改完别的地方（网页、其他手机）的登录都退出，这台不退。

import type { StaffMpMe } from '../../../../src/shared/staffmp';
import { call, messageOf } from '../../utils/api';
import { enterApp } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';
import { updateMe } from '../../utils/session';

Page({
  data: {
    large: false,
    first: false,
    current: '',
    next: '',
    again: '',
    busy: false,
    error: '',
    nextError: '',
    againError: '',
  },

  onLoad(q: Record<string, string | undefined>) {
    this.setData({ large: largeTextOn(), first: q.first === '1' });
  },

  onCurrent(e: WechatMiniprogram.Input) {
    this.setData({ current: e.detail.value, error: '' });
  },
  onNext(e: WechatMiniprogram.Input) {
    this.setData({ next: e.detail.value, nextError: '', error: '' });
  },
  onAgain(e: WechatMiniprogram.Input) {
    this.setData({ again: e.detail.value, againError: '', error: '' });
  },

  async onSave() {
    if (this.data.busy) return;
    const { current, next, again } = this.data;
    if (!current) return this.setData({ error: '请输入现在的密码' });
    if (next.length < 8) return this.setData({ nextError: '新密码至少 8 位' });
    if (next !== again) return this.setData({ againError: '两次输的新密码不一样' });
    this.setData({ busy: true, error: '' });
    try {
      const me = await call<StaffMpMe>('POST', '/auth/password', { currentPassword: current, newPassword: next });
      updateMe(me);
      if (this.data.first) {
        if (me.needsPosition) wx.reLaunch({ url: '/pages/position/index' });
        else enterApp();
      } else {
        wx.showToast({ title: '密码改好了', icon: 'success', duration: 1500 });
        setTimeout(() => wx.navigateBack({ fail: () => enterApp() }), 900);
      }
    } catch (e) {
      // 现在的密码不对、新密码太简单：门店系统的话原样写在这里
      this.setData({ error: messageOf(e) });
    } finally {
      this.setData({ busy: false });
    }
  },
});
