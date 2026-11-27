// 员工小程序的微信登录（docs/STAFF_MP.md 第 5.1、6 节）：小程序 wx.login 的 code 由门店系统自己问微信换 openid（code2session）。
// 不在事务里等微信（AGENTS.md「事务里不等外部调用」）；微信连不上、配置没配时只是不能「微信一键进」，账号密码照样能登录。
// 模拟微信（只在开发、测试环境，STAFFMP_MOCK_WECHAT=true）：code 写 mock-<名字>，openid 就是 mock_<名字>，不出网。

import type { StaffMpConfig } from '../../config';
import { AppError } from '../../lib/errors';

const CODE2SESSION = 'https://api.weixin.qq.com/sns/jscode2session';
const MOCK_CODE = /^mock-([a-z0-9]{3,32})$/;

export type Code2Session = (code: string) => Promise<string>;

/** 微信一键登录能不能用 */
export function wechatReady(cfg: StaffMpConfig): boolean {
  return cfg.mockWechat || (!!cfg.appId && !!cfg.appSecret);
}

/** code 换 openid；换不到抛 AppError（文字面向员工） */
export function code2sessionFor(cfg: StaffMpConfig, fetchImpl: typeof fetch = fetch): Code2Session {
  return async (code) => {
    if (cfg.mockWechat) {
      const m = MOCK_CODE.exec(code);
      if (!m) throw new AppError(400, 'WECHAT_CODE_INVALID', '模拟微信的 code 要写 mock-<名字>（3–32 位小写字母、数字）');
      return `mock_${m[1]}`;
    }
    if (!cfg.appId || !cfg.appSecret) throw new AppError(503, 'WECHAT_NOT_CONFIGURED', '门店系统还没配好微信登录，请用账号密码登录');
    if (!/^[0-9A-Za-z_-]{8,128}$/.test(code)) throw new AppError(400, 'WECHAT_CODE_INVALID', '微信登录的凭证不对，请重新打开小程序');
    const url = `${CODE2SESSION}?appid=${encodeURIComponent(cfg.appId)}&secret=${encodeURIComponent(cfg.appSecret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    let body: { openid?: unknown; errcode?: unknown; errmsg?: unknown };
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
      body = (await res.json()) as typeof body;
    } catch {
      throw new AppError(502, 'WECHAT_UNREACHABLE', '门店系统暂时连不上微信，请用账号密码登录');
    }
    if (typeof body.openid === 'string' && body.openid) return body.openid;
    // 40029 code 无效、40163 code 已用过：小程序重新 wx.login 再来
    const errcode = typeof body.errcode === 'number' ? body.errcode : 0;
    if (errcode === 40029 || errcode === 40163) throw new AppError(400, 'WECHAT_CODE_INVALID', '微信登录的凭证过期了，请重新打开小程序');
    throw new AppError(502, 'WECHAT_REJECTED', '微信没有确认这次登录，请用账号密码登录');
  };
}
