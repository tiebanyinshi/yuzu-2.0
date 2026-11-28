// 我的（docs/STAFF_MP.md 第 2.5 节）：自己的资料、绑定的微信（解绑）、改密码、大字、振动、关于（小程序版本、门店系统的版本 + SHA、
// 实例标识）、退出（「退出」下次还能微信一键进；「退出并解除这个微信」下次要输密码）。
// 第二版：能用学堂的，资料下面一张「学习」卡：等级、学分、离下一级还差多少、证书几张（学堂的「我的」，手机上留一份，没信号也先画上次的）。

import type { StaffMpMe } from '../../../../src/shared/staffmp';
import { messageOf } from '../../utils/api';
import { appVersion } from '../../config/env';
import { initialOf } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { instanceTag, versionText } from '../../utils/instance';
import type { LevelView } from '../../utils/academy';
import { levelView, loadAcademyMe } from '../../utils/academy';
import { largeTextOn, loadPrefs, savePrefs } from '../../utils/prefs';
import { logout, refreshMe, watchMe } from '../../utils/session';

let unwatch: (() => void) | null = null;
let acGen = 0;

const LEVEL_KEY = 'wcp_academy_level:';
type LevelCard = LevelView & { certs: string };
function loadLevel(staffId: number): LevelCard | null {
  try {
    const v = wx.getStorageSync(LEVEL_KEY + staffId) as LevelCard | '';
    return v && typeof v.title === 'string' ? v : null;
  } catch {
    return null;
  }
}

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
    hasAcademy: false,
    level: null as LevelCard | null,
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
    this.loadLevel(me);
  },

  /** 学习卡：先画手机上的上一份，再取新的（取不到照旧显示上一份） */
  async loadLevel(me: StaffMpMe) {
    const has = me.entries.indexOf('academy') >= 0;
    const my = ++acGen;
    this.setData({ hasAcademy: has, level: has ? loadLevel(me.staff.id) : null });
    if (!has) return;
    try {
      const d = await loadAcademyMe();
      if (my !== acGen) return;
      const valid = d.certificates.filter((c) => !c.revoked && !c.expired).length;
      const level: LevelCard = { ...levelView(d.me), certs: d.certificates.length ? `证书 ${valid} 张有效` : '还没有证书' };
      this.setData({ level });
      try {
        wx.setStorageSync(LEVEL_KEY + me.staff.id, level);
      } catch {
        // 存不了：只是下次没信号时没有上一份
      }
    } catch {
      // 取不到：照旧显示上一份
    }
  },

  onAcademy() {
    wx.navigateTo({ url: '/pages/academy-me/index' });
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
      const me = await refreshMe();
      this.show(me);
      await this.loadLevel(me);
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
