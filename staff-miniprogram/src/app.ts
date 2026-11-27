// 汤崎 WCP · 员工小程序（员工小程序线，docs/STAFF_MP.md）。
// 打开时先用手机上存的「我是谁」把页面画出来（没信号也能看上次的样子），刷新在后台做（第 2.8 节）：
//   · 有令牌：刷新「我是谁」；令牌过期时 api.ts 悄悄用微信重新登录；
//   · 没令牌、没主动退出过：试一下微信一键进（这个微信绑过账号的）；
//   · 进不去（没绑过、主动退出过、账号停用）：页面去登录页（每个 Tab 页显示时看 needLogin）。

import { isApiError } from './utils/api';
import { hasSession, refreshMe, signedOut, wechatLogin } from './utils/session';

interface StaffApp {
  globalData: { needLogin: boolean; booting: Promise<void> | null };
  boot(): Promise<void>;
}

App<StaffApp>({
  globalData: { needLogin: false, booting: null },

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
    }
  },
});
