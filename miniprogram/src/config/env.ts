// 连哪个网关（docs/MINIPROGRAM.md 第 6 节）：按小程序的版本选，小程序只连网关，不直接连门店。
//   · 开发版（微信开发者工具、真机预览）：本机起的网关（node dist/gateway/index.js，默认 8300 端口）；
//     真机预览时手机连不到 127.0.0.1，把 DEV_GATEWAY 改成电脑的局域网地址，手机上打开「开发调试」；
//   · 体验版：测试网关（连演示库）；正式版：正式网关。
//   店主 2026-11-27：顾客、员工两个小程序都用 sys.yuzusystem.xyz（api. 子域名撤掉）。正式服那台的 Caddy 把 /v1/* 转给正式网关、
//   /trial/v1/* 去掉 /trial 转给测试网关（docs/DEPLOY_GATEWAY.md 第 0、1.1 节），所以体验版的地址多一段 /trial。
// 网关是不是「模拟微信」由网关自己报告（/v1/health），正式版一律不用模拟。

export type EnvVersion = 'develop' | 'trial' | 'release';

/** 开发版连的网关：改成自己电脑的地址时不要提交 */
export const DEV_GATEWAY = 'http://127.0.0.1:8300';

const GATEWAYS: Record<EnvVersion, string> = {
  develop: DEV_GATEWAY,
  // 小程序后台 request、downloadFile 合法域名填 https://sys.yuzusystem.xyz（只填域名，不带 /trial）
  trial: 'https://sys.yuzusystem.xyz/trial',
  release: 'https://sys.yuzusystem.xyz',
};

export function envVersion(): EnvVersion {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion || 'develop';
  } catch {
    return 'develop';
  }
}

export function gatewayBase(): string {
  return GATEWAYS[envVersion()];
}

/** 版本号（正式版、体验版有；开发版为空），显示在「我的」页底部 */
export function appVersion(): string {
  try {
    return wx.getAccountInfoSync().miniProgram.version || '';
  } catch {
    return '';
  }
}
