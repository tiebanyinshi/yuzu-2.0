// OA 办公（docs/OA.md）：前后端共用的类型与规则。OA-01 组织架构与员工档案。

import type { OrgDepartment, PositionKey } from './positions';

export type EmploymentStatus = 'active' | 'left';
export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = { active: '在职', left: '离职' };

/** 工号：字母、数字、- 与 _，1–20 位；全店唯一 */
export const EMP_NO_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
/** 手机号：11 位、1 开头（在职员工之间不重复） */
export const PHONE_PATTERN = /^1[0-9]{10}$/;

/** 部门（组织架构树的一个节点） */
export interface OrgDepartmentNode {
  key: OrgDepartment;
  name: string;
  parentKey: OrgDepartment | null;
  /** 后台指定的主管（可空） */
  headStaffId: number | null;
  /** 实际生效的主管：指定了用指定的（在职才算），没指定取本部门在职负责人里最早建的一位（OA3） */
  head: { id: number; name: string; designated: boolean } | null;
  /** 在职人数（按岗位所在的部门） */
  memberCount: number;
  /** 版本：改上级、主管时带上，别人先改过就不能覆盖 */
  version: number;
}

/** 员工档案（与账号一对一；没建过档案的员工各项为空、算在职） */
export interface EmployeeProfile {
  staffId: number;
  username: string;
  name: string;
  position: PositionKey | null;
  department: OrgDepartment | null;
  /** 账号是否启用（离职后停用） */
  active: boolean;
  empNo: string | null;
  phone: string | null;
  hireDate: string | null;
  leaveDate: string | null;
  status: EmploymentStatus;
  /** 档案的版本（没建过档案时是 0）：改档案时带上，别人先改过就不能覆盖 */
  version: number;
}

export interface OrgOverview {
  departments: OrgDepartmentNode[];
  employees: EmployeeProfile[];
}

/** 部门所属：岗位键的前半段（president → 公司，gmo → 总经办，`前厅部.负责人` → front） */
export function departmentOfPosition(position: PositionKey | null | undefined): OrgDepartment | null {
  if (!position) return null;
  if (position === 'president') return 'company';
  if (position === 'gmo') return 'gmo';
  return position.split('.')[0] as OrgDepartment;
}

/** 改上级部门会不会绕成环：从新的上级一路往上，碰到自己就是环 */
export function wouldCycle(parents: ReadonlyMap<string, string | null>, key: string, newParent: string | null): boolean {
  let cur = newParent;
  const seen = new Set<string>();
  while (cur) {
    if (cur === key) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = parents.get(cur) ?? null;
  }
  return false;
}

// ───────────── OA-02 账号与批量开通（docs/OA.md 第 5 节） ─────────────

/** 批量开通表格的列（第 2 行是表头；第 1 行是标题） */
export const STAFF_IMPORT_COLUMNS = ['姓名', '手机号', '工号', '部门', '岗位', '入职日期', '登录名'] as const;
export const STAFF_IMPORT_REQUIRED = ['姓名', '手机号', '部门'] as const;
/** 一次最多开多少个账号 */
export const STAFF_IMPORT_MAX_ROWS = 200;
/** 登录名：与「员工账号」同一个规则 */
export const USERNAME_PATTERN = /^[a-z0-9_.-]{2,32}$/;

/** 预览里的一行 */
export interface StaffImportRow {
  /** 文件里的行号（表头是第 2 行） */
  row: number;
  name: string;
  phone: string;
  empNo: string | null;
  department: OrgDepartment | null;
  position: PositionKey | null;
  hireDate: string | null;
  /** 登录名：表里填了用表里的，没填按工号或手机号生成 */
  username: string;
  /** 这一行要先改的地方；空的就能开 */
  issues: string[];
}

export interface StaffImportPreview {
  fileName: string;
  rows: StaffImportRow[];
  /** 有问题的行数：不为 0 时整批不能开 */
  issueCount: number;
}

/** 开好的账号；临时密码只在第一次开通的回答里有（原样重提、查回时是 null，到「员工账号」里重置） */
export interface StaffImportAccount {
  staffId: number;
  username: string;
  name: string;
  position: PositionKey;
  temporaryPassword: string | null;
}

export interface StaffImportResult {
  import: { id: number; fileName: string; createdAt: string; count: number };
  accounts: StaffImportAccount[];
  /** 这个操作编号之前已经开过：这次没有再开，临时密码不再给 */
  replayed: boolean;
}

// ───────────── OA-03 站内通知与附件（docs/OA.md 第 6 节） ─────────────

export const NOTIFICATION_KINDS = ['attendance_exception', 'makeup_result', 'approval_todo', 'approval_urge', 'approval_result', 'schedule_change', 'payslip', 'im_message', 'system'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  attendance_exception: '打卡异常',
  makeup_result: '补卡结果',
  approval_todo: '审批待办',
  approval_urge: '催办',
  approval_result: '审批结果',
  schedule_change: '排班变更',
  payslip: '工资条',
  im_message: '新消息',
  system: '系统',
};

export interface OaNotification {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string;
  /** 点开去哪一页（站内路径） */
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPage {
  items: OaNotification[];
  /** 还有更早的：下一页从这个编号往前取 */
  nextBefore: number | null;
  unread: number;
}

/** 附件单个上限 10MB；缩略图上限 200KB（浏览器生成，长边 320 像素的 JPEG） */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_THUMB_MAX_BYTES = 200 * 1024;

export interface OaAttachment {
  id: number;
  fileName: string;
  mime: string;
  sizeBytes: number;
  isImage: boolean;
  hasThumb: boolean;
  url: string;
  thumbUrl: string | null;
}

// ───────────────────────── OA-04 考勤组、班次、打卡点（docs/OA.md 第 7 节） ─────────────────────────

/** 班次打卡窗口的默认值（OA9）：上班卡可提前 120 分钟、迟到弹性 0、上班窗口在上班后再开 60 分钟、下班窗口在下班前 60 分钟开始、下班卡可延后 120 分钟 */
export const SHIFT_WINDOW_DEFAULTS = { inAdvanceMinutes: 120, lateGraceMinutes: 0, inAfterMinutes: 60, outBeforeMinutes: 60, outDelayMinutes: 120 } as const;
export const OA_SHIFT_NAME_MAX = 20;
export const OA_LOCATION_RADIUS_DEFAULT = 300;

export interface OaShiftTimes {
  /** 当天第几分钟（0–1439）；下班不晚于上班 = 跨天班 */
  startMinute: number;
  endMinute: number;
  restStartMinute: number | null;
  restEndMinute: number | null;
  inAdvanceMinutes: number;
  lateGraceMinutes: number;
  inAfterMinutes: number;
  outBeforeMinutes: number;
  outDelayMinutes: number;
}
export interface OaShift extends OaShiftTimes {
  id: number;
  name: string;
  active: boolean;
  version: number;
}

/** 班次长多少分钟（跨天班照样是正数） */
export const shiftLength = (s: Pick<OaShiftTimes, 'startMinute' | 'endMinute'>) => (s.endMinute - s.startMinute + 1440) % 1440;

/**
 * 班次的时间与打卡窗口说得通吗（服务端、页面共用）：
 * 休息段在班次里面；迟到弹性不超过上班窗口；同一班次的上班窗口在下班窗口之前结束（不然一次打卡分不清上下班）；
 * 连着两天上同一个班，前一天的下班窗口不能伸进第二天的上班窗口。说不通时返回原因
 */
export function shiftProblem(s: OaShiftTimes): string | null {
  const len = shiftLength(s);
  if (len === 0) return '上班和下班不能是同一个时间';
  if ((s.restStartMinute === null) !== (s.restEndMinute === null)) return '休息段要同时填开始和结束';
  if (s.restStartMinute !== null && s.restEndMinute !== null) {
    const rs = (s.restStartMinute - s.startMinute + 1440) % 1440;
    const re = (s.restEndMinute - s.startMinute + 1440) % 1440;
    if (!(rs > 0 && rs < re && re < len)) return '休息段要在上班与下班之间';
  }
  if (s.lateGraceMinutes > s.inAfterMinutes) return '迟到弹性不能比上班窗口在上班后开的时间还长';
  if (s.inAfterMinutes >= len - s.outBeforeMinutes) return '上班窗口要在下班窗口开始之前结束：把「上班后再开」或「下班前开始」改短';
  if (len + s.outDelayMinutes + s.inAdvanceMinutes > 1440) return '下班卡可延后与上班卡可提前加起来太长：连着两天上这个班时两个窗口会重叠';
  return null;
}

export interface OaLocation {
  id: number;
  name: string;
  address: string;
  lat: number;
  lng: number;
  radiusM: number;
  active: boolean;
  version: number;
}

export interface OaAttendanceGroup {
  id: number;
  name: string;
  gpsRequired: boolean;
  faceRequired: boolean;
  active: boolean;
  version: number;
  locationIds: number[];
  memberIds: number[];
}

export interface AttendanceEmployee {
  staffId: number;
  name: string;
  position: PositionKey | null;
  groupId: number | null;
}

export interface AttendanceSetup {
  shifts: OaShift[];
  locations: OaLocation[];
  groups: OaAttendanceGroup[];
  /** 本店在职员工与所在考勤组（没进组的 groupId 为 null） */
  employees: AttendanceEmployee[];
}

/** 保存以后的回答：最新的设置；新建的另给建的是哪一行（结果待确认查回用；replayed = 同一编号原样重提，之前已经建好） */
export interface AttendanceSetupSaved extends AttendanceSetup {
  created: { kind: 'shift' | 'location' | 'group'; id: number; replayed: boolean } | null;
}

// ───────────────────────── OA-05 排班（docs/OA.md 第 8 节） ─────────────────────────

/** 一次最多看几天（一周一屏，月历六周）；最远排到今天之后多少天 */
export const SCHEDULE_MAX_DAYS = 42;
export const SCHEDULE_AHEAD_DAYS = 92;
/** 一格最多几个班次（连班） */
export const SCHEDULE_MAX_SHIFTS_PER_DAY = 4;

/** 排班的一格：员工 × 业务日期；shiftIds 空 = 休息（没排） */
export interface ScheduleCell {
  staffId: number;
  date: string;
  shiftIds: number[];
  /** 标了「连班」：与前后相邻的班次打卡窗口可以首尾相接 */
  consecutive: boolean;
}

export interface ScheduleWeek {
  /** 能看的考勤组（hr.attendance 是本店全部启用的；部门负责人是有本部门员工的） */
  groups: { id: number; name: string }[];
  group: { id: number; name: string } | null;
  from: string;
  to: string;
  /** 今天（业务日期）：之前的日子不能改 */
  today: string;
  /** 能不能改（部门负责人只能看） */
  editable: boolean;
  members: { staffId: number; name: string; position: PositionKey | null }[];
  /** 本店的班次（启用的，加上这段时间里排着的停用班次） */
  shifts: OaShift[];
  cells: ScheduleCell[];
}

export interface MyScheduleItem {
  shiftId: number;
  name: string;
  startMinute: number;
  endMinute: number;
  consecutive: boolean;
}
export interface MySchedule {
  month: string;
  today: string;
  days: { date: string; items: MyScheduleItem[] }[];
}

const DAY_MS = 86_400_000;
/**
 * 一条排班的打卡时段（从上班卡最早能打到下班卡最晚能打），按「1970-01-01 起第几分钟」算，跨天、跨月都能直接比；
 * 同一人两条排班的时段重叠就分不清一次打卡算哪一条（OA-06），除非标了连班
 */
export function scheduleSpan(date: string, s: Pick<OaShiftTimes, 'startMinute' | 'endMinute' | 'inAdvanceMinutes' | 'outDelayMinutes'>): { from: number; to: number } {
  const day = Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
  const start = day * 1440 + s.startMinute;
  return { from: start - s.inAdvanceMinutes, to: start + shiftLength(s) + s.outDelayMinutes };
}
