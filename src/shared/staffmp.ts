// 员工小程序「汤崎 WCP」（员工小程序线，docs/STAFF_MP.md）：员工小程序端口与小程序共用的类型与常量。
// 小程序（staff-miniprogram/）只引这里的类型（编译后不留引用），接口改了那边的类型检查会报错。

import type { AcademyLessonView } from './academy';
import type { AcademyBlock } from './academy-markup';
import type { CanteenRole, Meal } from './canteen';
import type { InstanceKind } from './instance';

/** 员工小程序端口上所有接口的前缀：放 Caddy 的服务器按它把 sys.yuzusystem.xyz 上的请求转到员工小程序端口（第 5 节） */
export const STAFFMP_PREFIX = '/api/staffmp';

/**
 * 原样挂上来的 WCP、员工培训、账号接口（第 5.3 节）：外面的地址 /api/staffmp/<外面的段>/… 进的就是 /api/<里面的段>/… 那个处理函数。
 * 只有白名单（src/server/modules/staffmp/allowlist.ts）里的方法 + 路由放行。账号那一段只放行老账号选新岗位的两个接口
 */
export const STAFFMP_PASSTHROUGH = [
  { outside: 'oa', inside: 'oa' },
  { outside: 'training', inside: 'training' },
  { outside: 'academy', inside: 'academy' },
  { outside: 'account', inside: 'auth' },
] as const;

/**
 * 员工小程序上能「确认作废」的操作（/api/staffmp/ops/:key/abandon，第 2.8 节）：打卡、发起申请、处理审批。
 * 原样重提被门店明确拒绝时，小程序先作废原编号再下结论（AGENTS.md「结果待确认」）
 */
export const STAFFMP_FENCE_TYPES = ['oa_punch', 'oa_approval_submit', 'oa_approval_act'] as const;

/** 小程序把接口回来的地址（例如附件的 /api/oa/attachments/12）换成员工小程序端口上的地址 */
export function staffMpPath(path: string): string {
  for (const { outside, inside } of STAFFMP_PASSTHROUGH) {
    if (path.startsWith(`/api/${inside}/`)) return `${STAFFMP_PREFIX}/${outside}/${path.slice(`/api/${inside}/`.length)}`;
  }
  return path;
}

/** 认证用的请求头：Authorization: Bearer <令牌> */
export const STAFFMP_BEARER = 'Bearer ';

/**
 * 「办事」与首页的入口（第 2.4 节）：服务端按这个人能用的给出，小程序按它显示。
 * 每个接口照旧当场核对权限，入口只是方便
 */
export type StaffMpEntryKey =
  | 'punch'
  | 'schedule'
  | 'attendance'
  | 'leave'
  | 'approvals'
  | 'payslips'
  | 'directory'
  | 'announcements'
  | 'knowledge'
  | 'academy'
  | 'canteen'
  | 'canteenScan'
  | 'patrol'
  | 'patrolLog';

/** 不用登录：登录页显示的门店名、版本、实例标识；开没开；是不是模拟微信 */
export interface StaffMpInfo {
  storeName: string;
  version: string;
  commit: string;
  instance: InstanceKind;
  /** 后台「WCP 设置 → 员工小程序」的开关（SP12） */
  open: boolean;
  /** 微信一键登录能不能用：配了小程序的 AppID 与 AppSecret（或开发、测试环境的模拟微信） */
  wechat: boolean;
  /** 模拟微信（只在开发、测试环境）：code 写 mock-<名字> */
  mockWechat: boolean;
  time: string;
}

export interface StaffMpMe {
  staff: {
    id: number;
    username: string;
    displayName: string;
    /** 岗位名称，例如「前厅部员工」；还没选岗位的为空 */
    positionTitle: string | null;
    /** 部门名称（按岗位），没有的为空 */
    department: string | null;
    /** 人事档案里的工号 */
    empNo: string | null;
  };
  store: { id: number; name: string };
  /** 第一次登录要先改密码：别的接口一律回 PASSWORD_CHANGE_REQUIRED */
  mustChangePassword: boolean;
  /** 老账号还没选新岗位：请他先在电脑上登录柚子选岗位 */
  needsPosition: boolean;
  /** 这个账号现在绑着微信（以后微信一键进） */
  /** 这一个会话是不是这台手机的微信绑定登录的（绑定还在）；不是「账号在哪台手机上绑过」 */
  wechatBound: boolean;
  /** 能用的入口（第 2.4 节） */
  entries: StaffMpEntryKey[];
  /** 门店系统今天的日期（自然日，打卡、排班按它） */
  today: string;
  build: { version: string; commit: string; instance: InstanceKind };
}

/**
 * 微信一键进（mode = login）：绑过的直接进；没绑过的回 unbound，小程序转到账号密码登录。
 * 只看看（mode = peek，退出以后的登录页用）：不登录，告诉这个微信绑着谁（登录页据此决定「以后用这个微信直接进」默认勾不勾，第 6 节）
 */
export type StaffMpWechatReply = { status: 'ok'; token: string; me: StaffMpMe } | { status: 'bound'; displayName: string } | { status: 'unbound' };

export interface StaffMpLoginReply {
  token: string;
  me: StaffMpMe;
  /** 这次登录有没有把微信绑上 */
  bound: boolean;
  /** 想绑却没绑上的原因（门店系统连不上微信；这个微信绑着别人、没说要换绑）：登录照样成功 */
  bindError: string | null;
}

/** 吃饭（第 5.4 节）：员工食堂开没开、这个人对没对上饭卡 */
export interface StaffMpCanteenStatus {
  /** 员工食堂开着、门店系统配了饭卡码（关着时小程序不显示吃饭） */
  open: boolean;
  linked: boolean;
  employee: { name: string; empNo: string; role: CanteenRole } | null;
  /** 现在是哪一餐的开饭时间、我这一餐打过卡没有（不在开饭时间、没对上为 null；首页此刻卡用） */
  currentMeal: { meal: Meal; date: string; checkedIn: boolean } | null;
}

/** 后台「员工小程序 → 饭卡对上」：一行是一位员工（对上了的写饭卡，没对上的给按手机号找到的候选） */
export interface StaffMpCanteenLinkRow {
  staffId: number;
  displayName: string;
  phone: string | null;
  linked: { employeeId: number; name: string; empNo: string; method: 'admin' | 'password' | 'created'; linkedAt: string } | null;
  /** 没对上、按人事档案的手机号在饭堂名单里找到一位（只此一位、还没对给别人）：管理员核对后一键对上 */
  suggestion: { employeeId: number; name: string; empNo: string } | null;
}

/** 短时地址（第 5.2 节）：给 <video>、<image> 用，10 分钟有效、只给这个人、只对这一个文件 */
export interface StaffMpMediaLink {
  /** 相对地址（/api/staffmp/media/<票据>），前面拼上门店系统的域名 */
  url: string;
  expiresAt: string;
}

/** 后台「WCP 设置 → 员工小程序」 */
export interface StaffMpBindingRow {
  id: number;
  staffId: number;
  displayName: string;
  username: string;
  positionTitle: string | null;
  boundAt: string;
  lastLoginAt: string | null;
  /** 现在还有几个小程序的会话没过期 */
  liveSessions: number;
}

export interface StaffMpAdminView {
  /** 开关（SP12，默认开） */
  enabled: boolean;
  /** 这台门店系统开没开员工小程序端口（STAFFMP_PORT） */
  portOpen: boolean;
  /** 配没配小程序的 AppID 与 AppSecret（没配只能账号密码登录） */
  wechatConfigured: boolean;
  mockWechat: boolean;
  appId: string | null;
  bindings: StaffMpBindingRow[];
}

/**
 * 汤崎学堂的课时（员工小程序端口上的 GET /api/staffmp/academy/lessons/:id）：学堂原来的回包，
 * 加上员工小程序端口用学堂自己的解析（src/shared/academy-markup.ts）解析好的块——小程序按块画，不另写一份解析（docs/STAFF_MP.md 第 5.3 节）。
 * 只有图文课件有块；别的课时是空数组
 */
export type StaffMpAcademyLesson = AcademyLessonView & { blocks: AcademyBlock[] };
