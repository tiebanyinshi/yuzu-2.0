// 页面显示时核对登录（docs/STAFF_MP.md 第 6 节、第 2.8 节）：
//   · 等小程序启动时的那一次刷新做完（app.ts 的 boot）；
//   · 要登录的去登录页；第一次登录要改密码的去改密码页；老账号要选新岗位的去选岗位页；
//   · 没信号、但手机上存着「我是谁」的：照样进页面，用上次的样子（页面上标「之前的信息」）。

import type { StaffMpMe } from '../../../src/shared/staffmp';
import { currentMe, hasSession } from './session';

interface AppData {
  globalData: { needLogin: boolean; booting: Promise<void> | null; renderedEarly: boolean };
}

/** 进得了这一页就返回「我是谁」；要去别的页（登录、改密码、选岗位）返回 null */
export async function requireMe(): Promise<StaffMpMe | null> {
  const app = getApp<AppData>();
  // 手机上有令牌、也存着「我是谁」：不等启动时的那一次刷新，先用上次的把页面画出来（没信号也不干等）；
  // 刷新回来要登录、要改密码、要选岗位的，由 app.ts 再把人带过去
  const cached = hasSession() ? currentMe() : null;
  if (app.globalData.booting) {
    if (cached) app.globalData.renderedEarly = true;
    else await app.globalData.booting;
  }
  const me = currentMe();
  if (app.globalData.needLogin || !hasSession() || !me) {
    wx.reLaunch({ url: '/pages/login/index' });
    return null;
  }
  if (me.mustChangePassword) {
    wx.reLaunch({ url: '/pages/password/index?first=1' });
    return null;
  }
  if (me.needsPosition) {
    wx.reLaunch({ url: '/pages/position/index' });
    return null;
  }
  return me;
}

/** 登录、改密码、选岗位做完以后回首页 */
export function enterApp(): void {
  getApp<AppData>().globalData.needLogin = false;
  wx.reLaunch({ url: '/pages/today/index' });
}

/** 接口回 401（登录过期、悄悄重新登录也不行）：去登录页 */
export function toLogin(): void {
  getApp<AppData>().globalData.needLogin = true;
  wx.reLaunch({ url: '/pages/login/index' });
}
