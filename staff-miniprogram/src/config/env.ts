// 连哪个员工小程序端口（docs/STAFF_MP.md 第 5、10 节）：按小程序的版本选，小程序只连 /api/staffmp/*。
//   · 开发版（微信开发者工具、真机预览）：本机起的 yuzu（STAFFMP_PORT，默认 8095）；真机预览时手机连不到 127.0.0.1，
//     把 DEV_BASE 改成电脑的局域网地址（不要提交），手机上打开「开发调试」；
//   · 体验版：测试服的演示库（测试服另开员工小程序端口与域名以后填；没填之前体验版打不开，不会连到正式服）；
//   · 正式版：staff.yuzusystem.xyz（店主 2026-11-27 定的员工小程序域名）。
// 门店系统是不是「模拟微信」由它自己报告（/api/staffmp/info），正式版一律不用模拟。

export type EnvVersion = 'develop' | 'trial' | 'release';

/** 开发版连的地址：改成自己电脑的地址时不要提交 */
export const DEV_BASE = 'http://127.0.0.1:8095';

const BASES: Record<EnvVersion, string> = {
  develop: DEV_BASE,
  // 测试服的员工小程序域名定下来以后改成 https://<测试域名>，并在小程序后台加进 request、downloadFile 合法域名
  trial: 'https://staff-test.domain.invalid',
  release: 'https://staff.yuzusystem.xyz',
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
