// 汤崎 WCP · 员工小程序（员工小程序线，docs/STAFF_MP.md）。
// 打开时先用手机上存的「我是谁」把页面画出来（没信号也能看上次的样子），刷新在后台做（第 2.8 节）：
//   · 有令牌：刷新「我是谁」；令牌过期时 api.ts 悄悄用微信重新登录；
//   · 没令牌、没主动退出过：试一下微信一键进（这个微信绑过账号的）；
//   · 进不去（没绑过、主动退出过、账号停用）：页面去登录页（每个 Tab 页显示时看 needLogin）。

import { isApiError } from './utils/api';
import { currentMe, hasSession, refreshMe, signedOut, wechatLogin } from './utils/session';

/** 现在最上面是哪一页（已经在那一页就不再跳） */
function topRoute(): string {
  try {
    const pages = getCurrentPages();
    return pages.length ? pages[pages.length - 1]!.route : '';
  } catch {
    return '';
  }
}

interface StaffApp {
  /** renderedEarly：启动刷新还没回来时页面已经用上次的「我是谁」画出来了（刷新回来要再核对一次） */
  globalData: { needLogin: boolean; booting: Promise<void> | null; renderedEarly: boolean };
  boot(): Promise<void>;
  afterBoot(): void;
}

App<StaffApp>({
  globalData: { needLogin: false, booting: null, renderedEarly: false },

  onLaunch() {
    this.globalData.booting = this.boot();
  },

  onShow() {
    // 回到前台：有令牌的悄悄刷新一次（权限、岗位、绑定可能在后台改过）
    if (hasSession() && !this.globalData.booting) {
      refreshMe().catch(() => undefined);
    }
  },

  async boot() {
    try {
      if (hasSession()) {
        await refreshMe();
      } else if (!signedOut()) {
        this.globalData.needLogin = !(await wechatLogin());
      } else {
        this.globalData.needLogin = true;
      }
    } catch (e) {
      // 没信号：停在上次的样子；明确没登录（401、账号停用）的去登录页
      if (isApiError(e) && (e.status === 401 || e.status === 403)) this.globalData.needLogin = true;
    } finally {
      this.globalData.booting = null;
      this.afterBoot();
    }
  },

  /** 页面可能已经用上次的「我是谁」画出来了：刷新回来要登录、要改密码、要选岗位的，这时再带过去 */
  afterBoot() {
    if (!this.globalData.renderedEarly) return; // 页面等着这次刷新，它自己会看
    this.globalData.renderedEarly = false;
    const top = topRoute();
    if (!top) return;
    const me = currentMe();
    const go = (route: string, url: string) => {
      if (top !== route) wx.reLaunch({ url });
    };
    if (this.globalData.needLogin || !hasSession() || !me) {
      if (top !== 'pages/login/index') go('pages/login/index', '/pages/login/index');
    } else if (me.mustChangePassword) go('pages/password/index', '/pages/password/index?first=1');
    else if (me.needsPosition) go('pages/position/index', '/pages/position/index');
  },
});
