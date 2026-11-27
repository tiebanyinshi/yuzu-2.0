// 改密码（docs/STAFF_MP.md 第 6 节）：第一次登录要先改掉初始密码（first=1，改完才能用别的）；平时从「我的」进来。
// 改完别的地方（网页、其他手机）的登录都退出，这台不退。

import type { StaffMpMe } from '../../../../src/shared/staffmp';
import { call, isApiError, isRejected, messageOf } from '../../utils/api';
import { enterApp } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';
import { currentMe, refreshMe, updateMe } from '../../utils/session';

/**
 * 上一次「保存」没收到门店系统的回复（连不上、门店出错）：密码可能已经改好了。
 *   · 第一次登录要改的：问一下「我是谁」，要改密码的标记没了就是改好了（门店系统说了算）；
 *   · 平时改的看不出来：再保存回「现在的密码不对」时不猜，写清楚两种可能与怎么办（也可能是现在的密码输错了）
 */
let uncertain = false;

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
    uncertain = false;
    this.setData({ large: largeTextOn(), first: q.first === '1' });
  },

  /** 改好了：第一次登录的去下一步，平时的回上一页 */
  done(me: StaffMpMe, text: string) {
    uncertain = false;
    updateMe(me);
    if (this.data.first) {
      if (me.needsPosition) wx.reLaunch({ url: '/pages/position/index' });
      else enterApp();
    } else {
      wx.showToast({ title: text, icon: 'success', duration: 1500 });
      setTimeout(() => wx.navigateBack({ fail: () => enterApp() }), 900);
    }
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
    const before = currentMe();
    try {
      const me = await call<StaffMpMe>('POST', '/auth/password', { currentPassword: current, newPassword: next });
      this.done(me, '密码改好了');
    } catch (e) {
      if (uncertain && isApiError(e) && e.message === '现在的密码不对') {
        const me = await refreshMe().catch(() => null);
        if (me && before && before.mustChangePassword && !me.mustChangePassword) {
          // 门店系统那边要改密码的标记没了：之前没收到回复的那一次改好了
          this.setData({ busy: false });
          return this.done(me, '之前那次已经改好了');
        }
        this.setData({
          error:
            '门店系统说「现在的密码不对」：多半是刚才没收到回复的那一次已经改好了（现在的密码就是你刚设的新密码），也可能是现在的密码输错了。下次登录先用新密码，不行再用原来的；都不行找人事重置。',
        });
        return;
      }
      if (!isRejected(e)) {
        // 没收到回复：可能已经改好了。第一次登录要改的，问一下「我是谁」就知道
        uncertain = true;
        const me = await refreshMe().catch(() => null);
        if (me && before && before.mustChangePassword && !me.mustChangePassword) {
          this.setData({ busy: false });
          return this.done(me, '密码改好了');
        }
        this.setData({ error: `没收到门店系统的回复，密码可能已经改好了：连上以后再点一次「保存」核对（改好了的会认出来）。${messageOf(e)}` });
        return;
      }
      // 现在的密码不对、新密码太简单：门店系统的话原样写在这里
      this.setData({ error: messageOf(e) });
    } finally {
      this.setData({ busy: false });
    }
  },
});
