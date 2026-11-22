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
/** 一次保存最多几格（页面按员工分批，一个人一周的格子总在同一批里） */
export const SCHEDULE_SAVE_MAX_CELLS = 500;

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
  /** 下个月 1 号：00:00 上班的在这个月最后一天写「今晚 24:00 上班」 */
  following: { date: string; items: MyScheduleItem[] };
}
/** 排班保存的结果（saved.id 是考勤组；结果待确认查回用） */
export interface ScheduleSaved {
  changed: number;
  saved: { id: number };
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

// ───────────────────────── OA-06 打卡（docs/OA.md 第 9 节） ─────────────────────────

/** in / out：某条排班的上班 / 下班卡；outside：上班中途（在打卡时段里、不在两个窗口里）；rest：不在任何排班的打卡时段里 */
export const PUNCH_KINDS = ['in', 'out', 'outside', 'rest'] as const;
export type PunchKind = (typeof PUNCH_KINDS)[number];
export const PUNCH_KIND_LABELS: Record<PunchKind, string> = { in: '上班卡', out: '下班卡', outside: '窗口外', rest: '休息日打卡' };
/** 同一坐标（约 1 米内）这么多秒内有别人也打了卡：标「同坐标多人」告警 */
export const PUNCH_SHARED_SECONDS = 60;
export const OUTWORK_REASON_MAX = 200;

/** 「1970-01-01 起第几分钟」（门店所在地的钟点，与 scheduleSpan 一致）↔ 日期与钟点 */
export const epochMinuteOf = (date: string, minute: number) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS) * 1440 + minute;
export const dateOfEpochMinute = (m: number) => new Date(Math.floor(m / 1440) * DAY_MS).toISOString().slice(0, 10);
export const minuteOfEpochMinute = (m: number) => ((m % 1440) + 1440) % 1440;

/** 一条排班的两个打卡窗口（都按「1970-01-01 起第几分钟」）：上班窗口 inFrom–inTo，lateAfter 之后打的算迟到；下班窗口 outFrom–outTo，end 之前打的算早退 */
export interface PunchWindows {
  start: number;
  end: number;
  inFrom: number;
  inTo: number;
  lateAfter: number;
  outFrom: number;
  outTo: number;
}
export function punchWindows(
  date: string,
  s: Pick<OaShiftTimes, 'startMinute' | 'endMinute' | 'inAdvanceMinutes' | 'lateGraceMinutes' | 'inAfterMinutes' | 'outBeforeMinutes' | 'outDelayMinutes'>,
): PunchWindows {
  const start = epochMinuteOf(date, s.startMinute);
  const end = start + shiftLength(s);
  return {
    start,
    end,
    inFrom: start - s.inAdvanceMinutes,
    inTo: start + s.inAfterMinutes,
    lateAfter: start + s.lateGraceMinutes,
    outFrom: end - s.outBeforeMinutes,
    outTo: end + s.outDelayMinutes,
  };
}

/** 参与匹配的一条排班：窗口与已经打过的卡 */
export interface PunchSlot {
  date: string;
  shiftId: number;
  windows: PunchWindows;
  hasIn: boolean;
  hasOut: boolean;
}
export type PunchMatch = { kind: 'in' | 'out'; slot: PunchSlot; lateMinutes: number; earlyMinutes: number } | { kind: 'outside'; slot: PunchSlot } | { kind: 'rest' };

/**
 * 一次打卡算哪一条排班的哪张卡（OA-06，严禁「当天第一次打卡 = 上班卡」）：
 *   · 落在上班窗口 → 上班卡；落在下班窗口 → 下班卡。
 *   · 同时落在几个窗口里（连班交接）：按窗口时间先后（同一时刻下班卡在前），先给还没打的那一个；都打过了给时间最近的那一个。
 *   · 不在窗口里、但在某条排班的打卡时段里 → outside；都不在 → rest。
 * 迟到分钟从上班时间算起（过了迟到弹性才算），早退分钟算到下班时间（OA10）
 */
export function matchPunch(t: number, slots: readonly PunchSlot[]): PunchMatch {
  const hits: { kind: 'in' | 'out'; slot: PunchSlot; anchor: number; filled: boolean }[] = [];
  for (const slot of slots) {
    const w = slot.windows;
    if (t >= w.inFrom && t <= w.inTo) hits.push({ kind: 'in', slot, anchor: w.start, filled: slot.hasIn });
    if (t >= w.outFrom && t <= w.outTo) hits.push({ kind: 'out', slot, anchor: w.end, filled: slot.hasOut });
  }
  if (hits.length) {
    hits.sort((a, b) => a.anchor - b.anchor || (a.kind === b.kind ? 0 : a.kind === 'out' ? -1 : 1));
    const pick = hits.find((h) => !h.filled) ?? hits.reduce((best, h) => (Math.abs(t - h.anchor) < Math.abs(t - best.anchor) ? h : best));
    const w = pick.slot.windows;
    return {
      kind: pick.kind,
      slot: pick.slot,
      lateMinutes: pick.kind === 'in' && t > w.lateAfter ? t - w.start : 0,
      earlyMinutes: pick.kind === 'out' && t < w.end ? w.end - t : 0,
    };
  }
  const within = slots.find((s) => t >= s.windows.inFrom && t <= s.windows.outTo);
  return within ? { kind: 'outside', slot: within } : { kind: 'rest' };
}

/** 两点间的距离（米，球面近似，打卡点几百米的半径足够准） */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** 一条打卡明细 */
export interface OaPunch {
  id: number;
  punchedAt: string;
  /** 门店所在地的日期与钟点（HH:MM） */
  localDate: string;
  localTime: string;
  kind: PunchKind;
  businessDate: string;
  shiftId: number | null;
  shiftName: string | null;
  lateMinutes: number;
  earlyMinutes: number;
  locationName: string | null;
  distanceM: number | null;
  accuracyM: number | null;
  locationOk: boolean;
  outwork: boolean;
  outworkReason: string | null;
  photo: OaAttachment | null;
  sharedLocation: boolean;
  /** 人脸（OA-07）：pass 通过、pending 比对服务没配置或不可用（待人工核对）；不要人脸的组为 null */
  faceResult: FaceResult | null;
  facePhoto: OaAttachment | null;
}
/** 打卡页上的一条排班：窗口与有效卡（上班卡第一次、下班卡最后一次） */
export interface PunchSlotView {
  date: string;
  shiftId: number;
  name: string;
  startMinute: number;
  endMinute: number;
  windows: PunchWindows;
  in: OaPunch | null;
  out: OaPunch | null;
}
export interface PunchGroupInfo {
  id: number;
  name: string;
  gpsRequired: boolean;
  faceRequired: boolean;
  locations: { id: number; name: string; lat: number; lng: number; radiusM: number }[];
}
/** 员工打卡页：现在（门店所在地，第几分钟）、考勤组与打卡点、前后几天的排班、今天的明细 */
export interface PunchToday {
  now: number;
  today: string;
  group: PunchGroupInfo | null;
  /** 本人的人脸录入状态（考勤组要人脸时，已通过才能打卡） */
  face: FaceStatus;
  slots: PunchSlotView[];
  punches: OaPunch[];
}
export interface PunchResult {
  punch: OaPunch;
  /** 这一张卡所在那一格的有效卡（上班卡第一次、下班卡最后一次）；窗口外、休息日打卡为 null */
  effective: OaPunch | null;
  replayed: boolean;
}
/** 后台「打卡记录」的一行 */
export interface PunchRecord extends OaPunch {
  staffId: number;
  staffName: string;
  deviceInfo: string;
  ip: string;
  /** 这一张是不是所在那一格的有效卡 */
  effective: boolean;
}
export interface PunchDay {
  date: string;
  groups: { id: number; name: string }[];
  groupId: number | null;
  records: PunchRecord[];
}

// ───────────────────────── OA-07 人脸录入与审核（docs/OA.md 第 10 节） ─────────────────────────

/** 一份录入要几张照片（正面、稍向左、稍向右） */
export const FACE_PHOTO_COUNT = 3;
export const FACE_PHOTO_LABELS = ['正面', '稍向左', '稍向右'] as const;
export const FACE_NOTE_MAX = 200;
export type FaceEnrollmentStatus = 'pending' | 'approved' | 'rejected' | 'revoked' | 'replaced';
export const FACE_STATUS_LABELS: Record<FaceEnrollmentStatus, string> = { pending: '待审核', approved: '已通过', rejected: '被退回', revoked: '已停用', replaced: '已换新' };
export type FaceResult = 'pass' | 'pending';
export const FACE_RESULT_LABELS: Record<FaceResult, string> = { pass: '人脸通过', pending: '人脸待人工核对' };
/** 本人人脸：none 没录（或都停用了）；有已通过的就能打卡 */
export type FaceStatus = 'none' | 'pending' | 'approved' | 'rejected';

export interface FaceEnrollment {
  id: number;
  staffId: number;
  staffName: string;
  status: FaceEnrollmentStatus;
  submittedAt: string;
  reviewedAt: string | null;
  reviewerName: string | null;
  reviewNote: string | null;
  photos: OaAttachment[];
}
/** 员工「人脸录入」页：已通过的那份、最近提交的那份（可能就是同一份） */
export interface MyFace {
  status: FaceStatus;
  approved: FaceEnrollment | null;
  latest: FaceEnrollment | null;
}
export interface FaceEnrollSaved {
  enrollment: FaceEnrollment;
  replayed: boolean;
}

