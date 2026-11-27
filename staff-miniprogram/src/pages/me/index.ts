// 我的（docs/STAFF_MP.md 第 2.5 节）：自己的资料、绑定的微信（解绑）、改密码、大字、振动、关于（小程序版本、门店系统的版本 + SHA、
// 实例标识）、退出（「退出」下次还能微信一键进；「退出并解除这个微信」下次要输密码）。

import type { StaffMpMe } from '../../../../src/shared/staffmp';
import { messageOf } from '../../utils/api';
import { appVersion } from '../../config/env';
import { initialOf } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { instanceTag, versionText } from '../../utils/instance';
import { largeTextOn, loadPrefs, savePrefs } from '../../utils/prefs';
import { logout, refreshMe, watchMe } from '../../utils/session';

let unwatch: (() => void) | null = null;

Page({
  data: {
    large: false,
    ready: false,
    me: null as StaffMpMe | null,
    initial: '',
    subtitle: '',
    largeText: false,
    vibrate: true,
    appVersion: '',
    serverVersion: '',
    tag: '',
    busy: false,
    error: '',
  },

  onLoad() {
    unwatch = watchMe((me) => me && this.show(me));
  },

  onUnload() {
    unwatch?.();
    unwatch = null;
  },

  async onShow() {
    const me = await requireMe();
    if (!me) return;
    this.show(me);
  },

  show(me: StaffMpMe) {
    const prefs = loadPrefs();
    this.setData({
      large: largeTextOn(),
      ready: true,
      me,
      initial: initialOf(me.staff.displayName),
      subtitle: [me.staff.positionTitle, me.store.name].filter(Boolean).join(' · '),
      largeText: largeTextOn(),
      vibrate: prefs.vibrate,
      appVersion: appVersion() || '开发版',
      serverVersion: versionText(me.build.version, me.build.commit),
      tag: instanceTag(me.build.instance),
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

  onPassword() {
    wx.navigateTo({ url: '/pages/password/index' });
  },

  onLargeText(e: WechatMiniprogram.SwitchChange) {
    savePrefs({ ...loadPrefs(), largeText: e.detail.value });
    this.setData({ largeText: e.detail.value, large: e.detail.value });
  },

  onVibrate(e: WechatMiniprogram.SwitchChange) {
    savePrefs({ ...loadPrefs(), vibrate: e.detail.value });
    this.setData({ vibrate: e.detail.value });
  },

  onUnbind() {
    wx.showModal({
      title: '解除这个微信？',
      content: '解除以后，下次打开要用柚子的账号和密码登录。',
      confirmText: '解除',
      cancelText: '先不解除',
      success: (r) => {
        if (r.confirm) this.unbind();
      },
    });
  },

  async unbind() {
    this.setData({ busy: true, error: '' });
    try {
      // 解绑会把小程序上的登录一起退出（门店系统那边），这里跟着去登录页
      await logout(true);
      toLogin();
    } catch (e) {
      this.setData({ error: messageOf(e) });
    } finally {
      this.setData({ busy: false });
    }
  },

  onLogout() {
    // 「退出并解除这个微信」只给这台手机的微信绑定登录的会话（同事手机上「只登录这一次」的，解开的会是自己手机上的微信）
    const bound = !!this.data.me && this.data.me.wechatBound;
    wx.showActionSheet({
      itemList: bound ? ['退出（下次还能微信一键进）', '退出并解除这个微信'] : ['退出'],
      success: async (r) => {
        try {
          await logout(bound && r.tapIndex === 1);
          toLogin();
        } catch (e) {
          // 解开没确认：留在这一页，写清楚
          this.setData({ error: messageOf(e) });
        }
      },
    });
  },
});
