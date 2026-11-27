// 员工办公（OA）领域对外的入口（8.2.3 起新加的引用从这里走；以前的引用照旧，check:gov 的 module-internal 只降不升）。

export { notify } from './notifications';
// 在职员工的判断（学堂与员工培训一样只给在职员工用，docs/ACADEMY.md 第 8 节）
export { onDuty, onDutyIds } from './im';

// 员工小程序线（docs/STAFF_MP.md 第 5.3 节）：员工小程序端口把这些员工端接口原样挂上（只放行白名单里的），在职员工的判定与网页同一条
export { managesOrg, NOT_EMPLOYEE_ROLES, orgScope, storeCond } from './org';
export type { OrgScope } from './org';
export { registerOaPunchRoutes } from './punches';
export { registerOaScheduleRoutes } from './schedules';
export { registerOaAttendanceDailyRoutes } from './attendance-daily';
export { registerOaLeaveRoutes } from './leave';
export { registerOaAttachmentRoutes } from './attachments';
export { registerOaApprovalRoutes } from './approvals';
export { registerOaNotificationRoutes } from './notifications';
export { registerOaAnnouncementRoutes } from './announcements';
export { registerOaPayrollRoutes } from './payroll';
export { registerOaDirectoryRoutes } from './directory';
