// 员工小程序端口上原样挂着的 WCP、员工培训接口（docs/STAFF_MP.md 第 5.3、8.2 节）。
// 这些模块整个挂上来（管理用的接口也在同一个模块里），只有这张表里的「方法 + 路由」放行，别的一律当没有这个接口（404）。
// 规则、权限照旧由各模块自己的守卫当场核对；这张表只决定员工小程序能碰哪些接口。加一条要在设计稿第 8.2 节写清用途，
// tests/staffmp-port.test.ts 核对每一条都对得上真实的路由、没有管理接口。

import { STAFFMP_PASSTHROUGH, STAFFMP_PREFIX } from '@shared/staffmp';
import { decodedPath } from '../../lib/paths';

export const STAFFMP_ALLOWLIST: readonly string[] = [
  // 打卡与考勤：今天的打卡页、打卡（外勤带照片）、我的排班、我的考勤、我的假期
  'GET /api/oa/attendance/today',
  'POST /api/oa/attendance/punch',
  'GET /api/oa/me/schedule',
  'GET /api/oa/me/attendance',
  'GET /api/oa/me/leave',
  // 附件：外勤照片上传；审批单、公告上的附件与缩略图（各模块登记了谁能看）
  'POST /api/oa/attachments',
  'GET /api/oa/attachments/:id',
  'GET /api/oa/attachments/:id/thumb',
  // 审批：发起申请（模板、提交，带操作编号）、列表（待我审批、我的申请、抄送我的）、红点数、详情、同意 / 驳回 / 转交、标已读
  'GET /api/oa/approval/templates',
  'POST /api/oa/approvals',
  'GET /api/oa/approvals',
  'GET /api/oa/approvals/summary',
  'GET /api/oa/approvals/:id',
  'POST /api/oa/approvals/:id/act',
  'POST /api/oa/approvals/:id/read',
  // 通知与公告
  'GET /api/oa/notifications',
  'GET /api/oa/notifications/unread-count',
  'POST /api/oa/notifications/read',
  'GET /api/oa/announcements',
  'GET /api/oa/announcements/:id',
  'POST /api/oa/announcements/:id/read',
  // 人事：我的工资条（明细每次记审计）、签收；通讯录
  'GET /api/oa/my/payslips',
  'GET /api/oa/my/payslips/:id',
  'POST /api/oa/my/payslips/:id/sign',
  'GET /api/oa/directory',
  // 员工培训（知识库）：文件夹、搜索、文件列表、文件内容（分段）、记看过
  'GET /api/training/folders',
  'GET /api/training/search',
  'GET /api/training/folders/:id/files',
  'GET /api/training/files/:id/content',
  'POST /api/training/files/:id/viewed',
  // 账号：老账号第一次登录选新岗位（8.1.18，GW7）——一线员工不用去找电脑（外面的地址 /api/staffmp/account/…）
  'GET /api/auth/position-options',
  'POST /api/auth/position',
];

const ALLOWED = new Set(STAFFMP_ALLOWLIST);

/** 这次请求能不能进：员工小程序自己的接口都能进；挂上来的只认白名单（HEAD 按 GET 算） */
export function passthroughAllowed(method: string, route: string): boolean {
  if (route.startsWith(`${STAFFMP_PREFIX}/`)) return true;
  const m = method === 'HEAD' ? 'GET' : method;
  return ALLOWED.has(`${m} ${route}`);
}

/** 直接用里面的地址（不带 /api/staffmp 前缀）进来的：当作没有这个接口 */
const BLOCKED = `${STAFFMP_PREFIX}/_not_found`;

/**
 * 改写地址（Fastify 的 rewriteUrl，在找路由之前）：/api/staffmp/oa/… → /api/oa/…，/api/staffmp/training/… → /api/training/…，
 * /api/staffmp/account/… → /api/auth/…；不带前缀直接打里面的地址的，改到一个不存在的地址（放 Caddy 的服务器只转 /api/staffmp/*，
 * 端口上也不认里面的地址）。按解码后的路径判断（/api/staffmp/%6fa/… 与 /api/staffmp/oa/… 是同一个，lib/paths）
 */
export function rewriteStaffMpUrl(url: string): string {
  const path = decodedPath(url);
  const q = url.indexOf('?');
  const query = q >= 0 ? url.slice(q) : '';
  for (const { outside, inside } of STAFFMP_PASSTHROUGH) {
    const prefix = `${STAFFMP_PREFIX}/${outside}/`;
    // 余下的部分按段重新编码（解码后的「?」「#」不会被当成查询串）
    if (path.startsWith(prefix)) return `/api/${inside}/${path.slice(prefix.length).split('/').map(encodeURIComponent).join('/')}${query}`;
  }
  for (const { inside } of STAFFMP_PASSTHROUGH) {
    if (path === `/api/${inside}` || path.startsWith(`/api/${inside}/`)) return BLOCKED;
  }
  return url;
}
