// 连哪个员工小程序端口（docs/STAFF_MP.md 第 5、10 节）：按小程序的版本选，小程序只连 /api/staffmp/*。
//   · 开发版（微信开发者工具、真机预览）：本机起的 yuzu（STAFFMP_PORT，默认 8095）；真机预览时手机连不到 127.0.0.1，
//     把 DEV_BASE 改成电脑的局域网地址（不要提交），手机上打开「开发调试」；
//   · 体验版：sys.yuzusystem.xyz/trial（正式服那台的 Caddy 去掉 /trial 转给测试服 A 演示库的员工小程序端口，连不到正式服）；
//   · 正式版：sys.yuzusystem.xyz（店主 2026-11-27 定：顾客、员工两个小程序都用这个域名；staff.yuzusystem.xyz 照旧给柚子饭堂网页）。
// 门店系统是不是「模拟微信」由它自己报告（/api/staffmp/info），正式版一律不用模拟。

export type EnvVersion = 'develop' | 'trial' | 'release';

/** 开发版连的地址：改成自己电脑的地址时不要提交 */
export const DEV_BASE = 'http://127.0.0.1:8095';

const BASES: Record<EnvVersion, string> = {
  develop: DEV_BASE,
  // 小程序后台 request、downloadFile 合法域名只填 https://sys.yuzusystem.xyz（/trial 是路径）
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

export function apiBase(): string {
  return BASES[envVersion()];
}

/** 小程序自己的版本号（正式版、体验版有；开发版为空），显示在「我的 → 关于」 */
export function appVersion(): string {
  try {
    return wx.getAccountInfoSync().miniProgram.version || '';
  } catch {
    return '';
  }
}
