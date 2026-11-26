// 运行配置全部来自环境变量；本地开发可放在 .env（不进入 Git）。

import { resolve as resolvePath } from 'node:path';
// 版本号只写在 package.json 一处（工程治理一期，docs/GOVERNANCE.md）：打包时带进来，发版只改 package.json 与锁文件
import { version as PACKAGE_VERSION } from '../../package.json';
import { SETTABLE_INSTANCES, type InstanceKind } from '@shared/instance';
import { LOCKER_DRIVERS, type LockerDriverKind } from '@shared/lockers';
import { loadIntegrationsConfig, type IntegrationsConfig } from './integrations/config';
import { loadProtectionConfig, type ProtectionConfig } from './lib/protect';

export type AppEnv = 'development' | 'trial' | 'production' | 'test';

export interface AppConfig {
  env: AppEnv;
  host: string;
  port: number;
  databaseUrl: string;
  timezone: string;
  sessionTtlHours: number;
  cookieSecure: boolean;
  /** 前面的反向代理（Caddy）的地址（TRUST_PROXY，逗号分隔、可写网段）：认它转来的真实来源 IP 与 https；空为不信任转发头 */
  trustProxy: string[];
  logLevel: string;
  /** 页面显示的版本号（不带开头的 v） */
  version: string;
  /** 构建时写入的提交 SHA；直接构建、没有传入时为空 */
  commit: string;
  /** 实例标识（YUZU_INSTANCE） */
  instance: InstanceKind;
  initOwner: { username: string; password: string; displayName: string } | null;
  /** 微信小程序（小程序线，docs/MINIPROGRAM.md 第 12 节）：单开的小程序端口，只挂给网关的 /api/mp/*；没设 MP_PORT 就不开 */
  mp: MpConfig;
  /** 员工食堂 · 柚子饭堂（docs/CANTEEN.md）：单开的员工端口，只挂柚子饭堂的页面与 /api/canteen/*；没设 CANTEEN_PORT 就不开 */
  canteen: CanteenConfig;
  /** 短信通道（8.0.4 批量发券的短信通知，docs/MEMBERSHIP_V804.md 第 6 节）：没配时短信留在待发箱，页面导出手动发 */
  sms: SmsConfig;
  /** 企业微信群机器人（8.0.7 ERP 每周一推，docs/ERP_V807.md 第 4 节）：没配时不推 */
  wecom: WecomConfig;
  /** 对外接口的模式（8.0.21，docs/INTEGRATIONS_V8021.md）：模拟只在开发、测试；正式的看密钥在不在 */
  integrations: IntegrationsConfig;
  /** 过载保护、频率限制、访问网段（8.1.3，docs/RESILIENCE_V813.md 第 3.5 节） */
  protection: ProtectionConfig;
  /**
   * 授权的品牌字体放在哪个目录（8.1.5，docs/EMENU.md 第 14.2 节，PP4）：英文 ABC Arizona Flare 的网页授权文件改名 en.woff2 放进去，
   * 平板菜单就换上；没放照旧用 Average Sans。字体文件不进 Git、不进镜像（Docker 部署挂 compose.yaml 旁边的 ./brand-fonts，只读）
   */
  brandFontPath: string;
  /**
   * 工资表原件的加密密钥（PAYROLL_FILE_KEY，OA-17，docs/OA.md 第 20 节）：至少 32 个字符；没配为空——正式、试用环境不能上传工资表 Excel，
   * 开发、测试用固定的开发密钥
   */
  payrollFileKey: string | null;
  /** 打卡点「搜索地址选点」与地图（考勤排班优化第 1 条）：用哪家的地址搜索与地图底图 */
  geo: GeoConfig;
  /**
   * 采购商城后端的服务密钥（MALL_API_KEY，docs/MALL_V8131.md 第 2 节）：商城后端调 /api/erp/mall/* 时放在 x-mall-key 里。
   * 至少 32 个字符；没配为空——商城接口一律回 503 MALL_NOT_CONFIGURED。只写在 .env，不进 Git
   */
  mallApiKey: string | null;
  /** 热表归档的保留天数（数据库评估，docs/DB_REVIEW_V8147.md 第 5 节）：超过的由每小时的归档任务挪进 archived_* 表 */
  archive: ArchiveConfig;
  /** 智能柜锁（docs/LOCKERS_V8149.md）：控制器到货前是 none */
  lockers: LockerConfig;
}

/** 智能柜锁控制器（LOCKER_DRIVER / LOCKER_BRIDGE_URL / LOCKER_BRIDGE_TOKEN） */
export interface LockerConfig {
  driver: LockerDriverKind;
  /** http：本机柜锁桥的地址（只认 http(s)） */
  bridgeUrl: string | null;
  /** http：调柜锁桥时带的密钥（至少 32 个字符；只放 .env） */
  bridgeToken: string | null;
}

export function loadLockerConfig(env: NodeJS.ProcessEnv): LockerConfig {
  const driver = (env.LOCKER_DRIVER?.trim().toLowerCase() || 'none') as LockerDriverKind;
  if (!(LOCKER_DRIVERS as readonly string[]).includes(driver)) throw new Error(`LOCKER_DRIVER 只能是 ${LOCKER_DRIVERS.join(' / ')}`);
  if (driver !== 'http') return { driver, bridgeUrl: null, bridgeToken: null };
  const url = env.LOCKER_BRIDGE_URL?.trim() ?? '';
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new Error('LOCKER_DRIVER=http 时要设 LOCKER_BRIDGE_URL（柜锁桥的 http 地址）');
  const token = env.LOCKER_BRIDGE_TOKEN?.trim() ?? '';
  if (token.length < 32) throw new Error('LOCKER_BRIDGE_TOKEN 至少 32 个字符（可以用 openssl rand -hex 32 生成）');
  return { driver, bridgeUrl: url.replace(/\/+$/, ''), bridgeToken: token };
}

/** 保留天数：0 = 不归档这一类 */
export interface ArchiveConfig {
  /** 位置事件与轨迹段（ARCHIVE_LOCATION_DAYS，默认 180） */
  locationDays: number;
  /** 对外调用记录（ARCHIVE_INTEGRATION_CALL_DAYS，默认 180） */
  integrationCallDays: number;
  /** 企业微信推送记录，只挪已发完、已失败的（ARCHIVE_WECOM_PUSH_DAYS，默认 365） */
  wecomPushDays: number;
}

export function loadArchiveConfig(env: NodeJS.ProcessEnv): ArchiveConfig {
  const days = (raw: string | undefined, fallback: number, name: string) => {
    const v = raw?.trim();
    if (!v) return fallback;
    if (!/^\d+$/.test(v)) throw new Error(`${name} 要写整数天数（0 = 不归档）`);
    const n = Number(v);
    // 太短会把还在用的挪走：位置轨迹、调用记录页面看的都是近期，至少留 30 天
    if (n !== 0 && n < 30) throw new Error(`${name} 至少 30 天（0 = 不归档）`);
    return n;
  };
  return {
    locationDays: days(env.ARCHIVE_LOCATION_DAYS, 180, 'ARCHIVE_LOCATION_DAYS'),
    integrationCallDays: days(env.ARCHIVE_INTEGRATION_CALL_DAYS, 180, 'ARCHIVE_INTEGRATION_CALL_DAYS'),
    wecomPushDays: days(env.ARCHIVE_WECOM_PUSH_DAYS, 365, 'ARCHIVE_WECOM_PUSH_DAYS'),
  };
}

/**
 * 企业微信群机器人（ERP_WECOM_WEBHOOK）：每周一把本周应付、待审批、快到期的、逾期应收推到群里（开关在「门店基本规则 → 可调的数值」）。
 * 地址里带着机器人的 key，相当于密码：只放 .env，不进 Git、不进库、不写日志。https 的地址才认；开发、测试另认 http（本机模拟）。
 * 和看门狗的告警群（WECOM_WEBHOOK_URL）分开配：告警群里的人不一定该看到应付的金额。
 */
export interface WecomConfig {
  webhook: string | null;
  /** 配了但格式不对（不是 https 地址）：当作没配，页面上提示 */
  invalid: boolean;
}

export function loadWecomConfig(env: NodeJS.ProcessEnv, appEnv: AppEnv): WecomConfig {
  const raw = env.ERP_WECOM_WEBHOOK?.trim() ?? '';
  if (!raw) return { webhook: null, invalid: false };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { webhook: null, invalid: true };
  }
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && (appEnv === 'development' || appEnv === 'test'));
  return ok ? { webhook: raw, invalid: false } : { webhook: null, invalid: true };
}

/**
 * 短信通道（SMS_PROVIDER）：
 *   · aliyun：阿里云短信（SMS_ACCESS_KEY_ID、SMS_ACCESS_KEY_SECRET、SMS_SIGN_NAME、SMS_TEMPLATE_COUPON 都要配；模板要先在阿里云申请）；
 *   · mock：不真发、直接记「已发」，只给开发、测试用（APP_ENV=production 时不认，免得正式服以为发出去了）；
 *   · 不配：不发，留在待发箱。
 * 密钥只放 .env，不进 Git、不写日志。
 */
export interface SmsConfig {
  provider: 'aliyun' | 'mock' | null;
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  /** 「券到账」的模板编号（模板变量 count、coupon、validTo） */
  templateCoupon: string;
  endpoint: string;
}

export function loadSmsConfig(env: NodeJS.ProcessEnv, appEnv: AppEnv): SmsConfig {
  const raw = env.SMS_PROVIDER?.trim().toLowerCase() || '';
  const cfg: SmsConfig = {
    provider: null,
    accessKeyId: env.SMS_ACCESS_KEY_ID?.trim() ?? '',
    accessKeySecret: env.SMS_ACCESS_KEY_SECRET?.trim() ?? '',
    signName: env.SMS_SIGN_NAME?.trim() ?? '',
    templateCoupon: env.SMS_TEMPLATE_COUPON?.trim() ?? '',
    endpoint: env.SMS_ENDPOINT?.trim() || 'https://dysmsapi.aliyuncs.com/',
  };
  if (raw === 'aliyun' && cfg.accessKeyId && cfg.accessKeySecret && cfg.signName && cfg.templateCoupon) cfg.provider = 'aliyun';
  else if (raw === 'mock' && appEnv !== 'production') cfg.provider = 'mock';
  return cfg;
}

export interface CanteenConfig {
  port: number | null;
  host: string;
  /** 饭卡码的密钥（CANTEEN_CODE_SECRET）：员工的码钥匙由它算出；只在 yuzu */
  codeSecret: string | null;
  /** 员工端走 HTTPS 时设 true（Cookie 加 Secure；店里局域网用 http 打开的不加，K18）。https 打开的不设也加 */
  cookieSecure: boolean;
  /** 前面的转发服务器（Caddy）的地址：限次按它转来的真实来源 IP 算；空为不信任转发头 */
  trustProxy: string[];
  /**
   * 饭点提醒（网页推送，docs/CANTEEN.md 第 19 节）告诉推送服务的联系方式（CANTEEN_PUSH_CONTACT，mailto: 或 https: 开头）；
   * 没设时用员工打开柚子饭堂的 https 地址
   */
  pushContact?: string | null;
  /** 开发、测试：认本机 http 的推送地址（CANTEEN_PUSH_LOCAL_ENDPOINTS=true，浏览器验收用模拟的推送服务）；别的环境设了也不认 */
  pushLocalEndpoints?: boolean;
}

/** 员工端口：没设 CANTEEN_PORT 不开；开了就必须配足够长的饭卡码密钥，端口不能与员工后台、小程序端口相同 */
export function loadCanteenConfig(env: NodeJS.ProcessEnv, mainPort: number, mpPort: number | null): CanteenConfig {
  const host = env.CANTEEN_HOST?.trim() || env.HOST || '0.0.0.0';
  const codeSecret = env.CANTEEN_CODE_SECRET?.trim() || null;
  const cookieSecure = env.CANTEEN_COOKIE_SECURE === 'true';
  const trustProxy = (env.CANTEEN_TRUST_PROXY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const contact = env.CANTEEN_PUSH_CONTACT?.trim() ?? '';
  const pushContact = /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(contact) ? contact : null;
  const appEnv = env.APP_ENV ?? 'development';
  const pushLocalEndpoints = env.CANTEEN_PUSH_LOCAL_ENDPOINTS === 'true' && (appEnv === 'development' || appEnv === 'test');
  const push = { pushContact, pushLocalEndpoints };
  const raw = env.CANTEEN_PORT?.trim();
  if (!raw) return { port: null, host, codeSecret, cookieSecure, trustProxy, ...push };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`CANTEEN_PORT 应为 1–65535 的端口号，当前是「${raw}」`);
  if (port === mainPort || port === mpPort) throw new Error('CANTEEN_PORT 不能与 PORT、MP_PORT 相同：员工端口只挂柚子饭堂');
  if (!codeSecret || codeSecret.length < 32) throw new Error('开了 CANTEEN_PORT 就要配 CANTEEN_CODE_SECRET（至少 32 个字符，可以用 openssl rand -hex 32 生成）');
  return { port, host, codeSecret, cookieSecure, trustProxy, ...push };
}

export interface MpConfig {
  port: number | null;
  host: string;
  /** 网关的服务密钥（MP_GATEWAY_KEY）：小程序端口只认它 */
  gatewayKey: string | null;
  /** 会员码的签名密钥（MP_CODE_SECRET）：只在 yuzu，网关不存 */
  codeSecret: string | null;
}

/** 小程序端口只有配了足够长的网关密钥才开；端口不能与员工用的 PORT 相同 */
export function loadMpConfig(env: NodeJS.ProcessEnv, mainPort: number): MpConfig {
  const host = env.MP_HOST?.trim() || env.HOST || '0.0.0.0';
  const gatewayKey = env.MP_GATEWAY_KEY?.trim() || null;
  const codeSecret = env.MP_CODE_SECRET?.trim() || null;
  if (codeSecret && codeSecret.length < 32) throw new Error('MP_CODE_SECRET 至少 32 个字符（可以用 openssl rand -hex 32 生成）');
  const raw = env.MP_PORT?.trim();
  if (!raw) return { port: null, host, gatewayKey, codeSecret };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`MP_PORT 应为 1–65535 的端口号，当前是「${raw}」`);
  if (port === mainPort) throw new Error('MP_PORT 不能与 PORT 相同：小程序端口只挂给网关的接口');
  if (!gatewayKey || gatewayKey.length < 32) throw new Error('开了 MP_PORT 就要配 MP_GATEWAY_KEY（至少 32 个字符，可以用 openssl rand -hex 32 生成）');
  return { port, host, gatewayKey, codeSecret };
}

function readEnvFile() {
  // 仅在开发时读取 .env；容器内由 docker compose 注入环境变量。
  try {
    process.loadEnvFile?.('.env');
  } catch {
    /* 没有 .env 时忽略 */
  }
}

/** YUZU_INSTANCE 没设置时按 APP_ENV 推出；正式环境不推断，页面显示「未设置实例标识」，提醒在 .env 里设置 */
export function resolveInstance(env: AppEnv, raw: string | undefined): InstanceKind {
  const value = raw?.trim();
  if (!value) return env === 'production' ? 'unset' : env === 'trial' ? 'trial' : 'dev';
  if (!(SETTABLE_INSTANCES as readonly string[]).includes(value)) {
    throw new Error(`YUZU_INSTANCE 只能是 ${SETTABLE_INSTANCES.join(' / ')}，当前是「${value}」`);
  }
  if (value === 'prod' && env !== 'production') {
    throw new Error('YUZU_INSTANCE=prod（正式服）只能用于 APP_ENV=production');
  }
  return value as InstanceKind;
}

/** 工资表原件的加密密钥：设了就要够长（短了宁可起不来，也不用弱密钥加密工资表） */
export function loadPayrollFileKey(env: NodeJS.ProcessEnv): string | null {
  const key = env.PAYROLL_FILE_KEY?.trim() || null;
  if (key && key.length < 32) throw new Error('PAYROLL_FILE_KEY 至少 32 个字符（可以用 openssl rand -hex 32 生成）');
  return key;
}

/**
 * 打卡点选点用的地图（店主 2026-11-24《考勤排班功能优化需求说明》第 1 条）：
 *   amap：高德（配了 AMAP_WEB_KEY 就用它；国内地址搜得准，坐标是 GCJ-02，进出都换成手机定位用的 WGS-84）；
 *   osm：OpenStreetMap（不用 key，国内地址少一些，坐标就是 WGS-84）；
 *   mock：开发、测试环境的假数据（不出网）；off：不能搜（只能定位当前位置或手输经纬度）。
 * GEO_PROVIDER 可以指定；没指定时有 key 用高德，测试环境关掉，别的用 OpenStreetMap。
 */
export type GeoProvider = 'amap' | 'osm' | 'mock' | 'off';
export interface GeoConfig {
  provider: GeoProvider;
  amapKey: string | null;
}
export function loadGeoConfig(env: NodeJS.ProcessEnv, appEnv: AppEnv): GeoConfig {
  const amapKey = env.AMAP_WEB_KEY?.trim() || null;
  const want = env.GEO_PROVIDER?.trim().toLowerCase();
  if (want === 'mock' && appEnv !== 'development' && appEnv !== 'test') throw new Error('GEO_PROVIDER=mock 只能在开发、测试环境用');
  if (want === 'amap' && !amapKey) throw new Error('GEO_PROVIDER=amap 要配 AMAP_WEB_KEY（高德 Web 服务的 key）');
  const provider: GeoProvider = want === 'amap' || want === 'osm' || want === 'mock' || want === 'off' ? want : amapKey ? 'amap' : appEnv === 'test' ? 'off' : 'osm';
  return { provider, amapKey };
}

/** 采购商城的服务密钥：没配为空；配了但不到 32 个字符不启动（太短的密钥等于没有） */
export function loadMallApiKey(env: NodeJS.ProcessEnv): string | null {
  const key = env.MALL_API_KEY?.trim() ?? '';
  if (!key) return null;
  if (key.length < 32) throw new Error('MALL_API_KEY 至少 32 个字符（可以用 openssl rand -hex 32 生成）；不对接采购商城就不要设');
  return key;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  if (!overrides.databaseUrl) readEnvFile();
  const env = overrides.env ?? ((process.env.APP_ENV ?? 'development') as AppEnv);
  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('缺少 DATABASE_URL 环境变量，请参考 .env.example 配置数据库连接。');
  }
  const ownerUser = process.env.INIT_OWNER_USERNAME?.trim();
  const ownerPass = process.env.INIT_OWNER_PASSWORD;
  const mainPort = Number(process.env.PORT ?? 8080);
  const mp = overrides.mp ?? loadMpConfig(process.env, mainPort);
  const instance = overrides.instance ?? resolveInstance(env, process.env.YUZU_INSTANCE);
  return {
    env,
    host: process.env.HOST ?? '0.0.0.0',
    port: mainPort,
    databaseUrl,
    timezone: process.env.APP_TIMEZONE ?? 'Asia/Shanghai',
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    trustProxy: (process.env.TRUST_PROXY ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel: process.env.LOG_LEVEL ?? (env === 'test' ? 'silent' : 'info'),
    // update.sh 用 git describe 写入的版本带 v 前缀，页面统一加 v，这里去掉；没传（直接构建、本地开发）时用 package.json 的版本号
    version: (process.env.APP_VERSION || PACKAGE_VERSION).replace(/^v/, ''),
    commit: /^[0-9a-f]{7,40}$/.test(process.env.APP_COMMIT ?? '') ? process.env.APP_COMMIT! : '',
    instance,
    initOwner: ownerUser && ownerPass ? { username: ownerUser, password: ownerPass, displayName: process.env.INIT_OWNER_NAME?.trim() || '店主' } : null,
    mp,
    canteen: overrides.canteen ?? loadCanteenConfig(process.env, mainPort, mp.port),
    sms: overrides.sms ?? loadSmsConfig(process.env, env),
    wecom: overrides.wecom ?? loadWecomConfig(process.env, env),
    integrations: overrides.integrations ?? loadIntegrationsConfig(process.env, env, instance),
    protection: overrides.protection ?? loadProtectionConfig(process.env, env),
    brandFontPath: resolvePath(process.env.BRAND_FONT_PATH?.trim() || 'brand-fonts'),
    payrollFileKey: loadPayrollFileKey(process.env),
    geo: overrides.geo ?? loadGeoConfig(process.env, env),
    mallApiKey: loadMallApiKey(process.env),
    archive: overrides.archive ?? loadArchiveConfig(process.env),
    lockers: overrides.lockers ?? loadLockerConfig(process.env),
    ...overrides,
  };
}
