// 登录（docs/STAFF_MP.md 第 6 节，SP05）：
//   · 上面是「微信一键登录」（这个微信绑过账号的，点了直接进）；下面是柚子的账号 + 密码；
//   · 「以后用这个微信直接进」：这个微信没绑过默认勾上；绑着别人（例如在同事的手机上）默认不勾，要勾先确认会顶掉谁；
//   · 「同意并登录」一并同意隐私保护指引（之后第一次打卡只剩定位一个弹窗）；
//   · 门店系统暂停了员工小程序（SP12）、连不上的，写清楚；错误留在原地。

import { instanceTag, versionText } from '../../utils/instance';
import { isApiError, isOffline, messageOf } from '../../utils/api';
import { enterApp } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';
import { info, passwordLogin, peekWechat, wechatLogin } from '../../utils/session';

Page({
  data: {
    large: false,
    loading: true,
    closed: false,
    offline: false,
    storeName: '',
    tag: '',
    version: '',
    wechat: false,
    boundName: '',
    username: '',
    password: '',
    showPassword: false,
    bind: true,
    busy: false,
    error: '',
    usernameError: '',
    passwordError: '',
  },

  onLoad() {
    this.setData({ large: largeTextOn() });
    this.load();
  },

  async load() {
    this.setData({ loading: true, offline: false });
    try {
      const i = await info(true);
      this.setData({ storeName: i.storeName, tag: instanceTag(i.instance), version: versionText(i.version, i.commit), closed: !i.open, wechat: i.wechat });
      if (i.open && i.wechat) {
        const peek = await peekWechat().catch(() => ({ bound: false as const }));
        // 这个微信绑着别人：一键登录进的是那个人；用自己的账号登录时默认不绑
        this.setData({ boundName: peek.bound ? peek.displayName : '', bind: !peek.bound });
      }
    } catch (e) {
      this.setData({ offline: isOffline(e), error: isOffline(e) ? '' : messageOf(e) });
    } finally {
      this.setData({ loading: false });
    }
  },

  onRetry() {
    this.load();
  },

  onUsername(e: WechatMiniprogram.Input) {
    this.setData({ username: e.detail.value, usernameError: '', error: '' });
  },

  onPassword(e: WechatMiniprogram.Input) {
    this.setData({ password: e.detail.value, passwordError: '', error: '' });
  },

  onTogglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },

  onToggleBind() {
    this.setData({ bind: !this.data.bind });
  },

  onPrivacy() {
    wx.openPrivacyContract({ fail: () => undefined });
  },

  async onWechat() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      if (await wechatLogin()) enterApp();
      else this.setData({ boundName: '', bind: true, error: '这个微信还没绑账号：第一次要用柚子的账号登录一次，之后就能一键进' });
    } catch (e) {
      this.setData({ error: messageOf(e) });
    } finally {
      this.setData({ busy: false });
    }
  },

  /** 绑着别人、员工勾了「以后用这个微信直接进」：先确认会顶掉谁 */
  confirmReplace(): Promise<boolean> {
    if (!this.data.bind || !this.data.boundName) return Promise.resolve(false);
    return new Promise((resolve) => {
      wx.showModal({
        title: '改绑这个微信？',
        content: `这个微信现在绑着「${this.data.boundName}」。改绑给你以后，${this.data.boundName}在这台手机上就不能一键进了。`,
        confirmText: '改绑给我',
        cancelText: '只登录这次',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      });
    });
  },

  async onLogin() {
    if (this.data.busy) return;
    const username = this.data.username.trim();
    const password = this.data.password;
    this.setData({ usernameError: username ? '' : '请输入账号', passwordError: password ? '' : '请输入密码', error: '' });
    if (!username || !password) return;
    this.setData({ busy: true });
    try {
      const replace = await this.confirmReplace();
      const bind = this.data.bind && (!this.data.boundName || replace);
      const r = await passwordLogin(username, password, { bind, replace });
      // 要绑却没绑上（门店系统说了原因，或者取不到微信的登录凭证）：说一声，下次还要输密码
      if (bind && !r.bound) wx.showToast({ title: '登录了，这次没绑微信', icon: 'none', duration: 2000 });
      enterApp();
    } catch (e) {
      // 账号密码不对、账号停用、专用账号、离职：门店系统的话原样写在这里
      this.setData({ error: isApiError(e) && e.code === 'STAFFMP_CLOSED' ? '员工小程序暂停使用了，请找管理员' : messageOf(e) });
    } finally {
      this.setData({ busy: false });
    }
  },
});
