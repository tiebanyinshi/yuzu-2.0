// OA-10 办公审批引擎（docs/OA.md 第 13 节；需求文档五（一））：模板、表单字段、审批链、单据与时间线的类型，
// 以及表单的核对（服务端提交时与页面上用同一份）。另建的办公审批，与审批中心（@shared/approvals）无关。

import type { OaAttachment } from './oa';

/** 表单字段的类型 */
export type ApprovalFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'money'
  | 'date'
  | 'datetime'
  | 'halfday'
  | 'select'
  | 'attachments'
  /** 假种（OA-09 的编号） */
  | 'leave_type'
  /** 班次（补卡那天自己排的班，OA-04 的编号） */
  | 'shift'
  /** 关联单：自己已通过的某个模板的单（refTemplate） */
  | 'ref';

export interface ApprovalField {
  /** 表单里的键（字母、数字） */
  key: string;
  label: string;
  type: ApprovalFieldType;
  required?: boolean;
  /** 文字：最多几个字；数字、金额（分）：最大值；附件：最多几个 */
  max?: number;
  /** 数字、金额（分）：最小值 */
  min?: number;
  /** 选项（select） */
  options?: string[];
  /** 关联单（ref）：哪个模板的单 */
  refTemplate?: string;
  hint?: string;
}

/** 日期 + 上午 / 下午（请假精确到半天） */
export interface HalfDay {
  date: string;
  half: 'am' | 'pm';
}
export type ApprovalFormValue = string | number | HalfDay | number[] | null;
export type ApprovalForm = Record<string, ApprovalFormValue>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const isDateTime = (v: unknown): v is string => typeof v === 'string' && DATETIME_RE.test(v) && isDate(v.slice(0, 10));

/** 默认上限 */
export const APPROVAL_TEXT_MAX = 60;
export const APPROVAL_TEXTAREA_MAX = 2000;
export const APPROVAL_ATTACHMENTS_MAX = 9;
export const APPROVAL_COMMENT_MAX = 500;

/**
 * 按模板的字段核对、整理表单：去掉多余的键、文字去首尾空白、空的记 null。
 * 返回整理好的表单，或第一处问题（给人看的话）
 */
export function checkApprovalForm(fields: readonly ApprovalField[], raw: unknown): { form: ApprovalForm } | { error: string } {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const form: ApprovalForm = {};
  for (const f of fields) {
    let v = input[f.key];
    if (typeof v === 'string') v = v.trim();
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required) return { error: `请填写${f.label}` };
      form[f.key] = f.type === 'attachments' ? [] : null;
      continue;
    }
    switch (f.type) {
      case 'text':
      case 'textarea': {
        if (typeof v !== 'string') return { error: `${f.label}不正确` };
        const max = f.max ?? (f.type === 'text' ? APPROVAL_TEXT_MAX : APPROVAL_TEXTAREA_MAX);
        if ([...v].length > max) return { error: `${f.label}最多 ${max} 个字` };
        form[f.key] = v;
        break;
      }
      case 'number':
      case 'money': {
        const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isInteger(n)) return { error: `${f.label}${f.type === 'money' ? '按分填整数' : '要是整数'}` };
        if (f.min !== undefined && n < f.min) return { error: `${f.label}不能小于 ${f.type === 'money' ? f.min / 100 : f.min}` };
        if (f.max !== undefined && n > f.max) return { error: `${f.label}不能大于 ${f.type === 'money' ? f.max / 100 : f.max}` };
        form[f.key] = n;
        break;
      }
      case 'date':
        if (!isDate(v)) return { error: `${f.label}按 YYYY-MM-DD 填` };
        form[f.key] = v;
        break;
      case 'datetime':
        if (!isDateTime(v)) return { error: `${f.label}要选日期与时间` };
        form[f.key] = v;
        break;
      case 'leave_type':
      case 'shift':
      case 'ref': {
        const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return { error: `${f.label}要从列表里选` };
        form[f.key] = n;
        break;
      }
      case 'halfday': {
        const h = v as Partial<HalfDay>;
        if (!h || typeof h !== 'object' || !isDate(h.date) || (h.half !== 'am' && h.half !== 'pm')) return { error: `${f.label}要选日期与上午 / 下午` };
        form[f.key] = { date: h.date, half: h.half };
        break;
      }
      case 'select':
        if (typeof v !== 'string' || !(f.options ?? []).includes(v)) return { error: `${f.label}要从选项里选` };
        form[f.key] = v;
        break;
      case 'attachments': {
        if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x) || (x as number) <= 0)) return { error: `${f.label}不正确` };
        const ids = [...new Set(v as number[])];
        const max = f.max ?? APPROVAL_ATTACHMENTS_MAX;
        if (ids.length > max) return { error: `${f.label}最多 ${max} 个` };
        form[f.key] = ids;
        break;
      }
    }
  }
  return { form };
}

/** 表单里所有附件的编号 */
export function formAttachmentIds(fields: readonly ApprovalField[], form: ApprovalForm): number[] {
  return fields.filter((f) => f.type === 'attachments').flatMap((f) => (Array.isArray(form[f.key]) ? (form[f.key] as number[]) : []));
}

/** 一级审批人怎么取：指定人 / 本部门主管 / 上级部门主管 / 人力行政部负责人（OA-18 工资条异议） */
export type ApprovalLevelSpec = { kind: 'staff'; staffId: number } | { kind: 'dept_head' } | { kind: 'parent_head' } | { kind: 'hr_head' };
/** 抄送：指定人 / 本部门主管 */
export type ApprovalCcSpec = { kind: 'staff'; staffId: number } | { kind: 'dept_head' };
export const LEVEL_KIND_LABELS: Record<ApprovalLevelSpec['kind'] | 'gmo', string> = {
  staff: '指定人',
  dept_head: '本部门主管',
  parent_head: '上级部门主管',
  hr_head: '人力行政部负责人',
  gmo: '总经办',
};

/** 条件开关（硬编码在引擎里，模板里开或关） */
export const APPROVAL_CONDITIONS = {
  leave_over_3_days: '请假超过 3 天加一级上级部门主管',
  expense_over_5000: '报销金额超过 5000 元加一级总经办',
} as const;
export type ApprovalCondition = keyof typeof APPROVAL_CONDITIONS;

export interface ApprovalTemplate {
  id: number;
  code: string;
  name: string;
  description: string;
  fields: ApprovalField[];
  levels: ApprovalLevelSpec[];
  conditions: Partial<Record<ApprovalCondition, boolean>>;
  cc: ApprovalCcSpec[];
  active: boolean;
  sort: number;
  version: number;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = { pending: '审批中', approved: '已通过', rejected: '已驳回', withdrawn: '已撤销' };
export type ApprovalStepStatus = 'waiting' | 'pending' | 'approved' | 'rejected' | 'transferred' | 'cancelled';
export type ApprovalEventKind = 'submit' | 'approve' | 'reject' | 'transfer' | 'withdraw' | 'comment' | 'urge';
export const APPROVAL_EVENT_LABELS: Record<ApprovalEventKind, string> = {
  submit: '提交',
  approve: '通过',
  reject: '驳回',
  transfer: '转交',
  withdraw: '撤销',
  comment: '评论',
  urge: '催办',
};
export type ApprovalAction = 'approve' | 'reject' | 'transfer' | 'withdraw' | 'comment' | 'urge';
/** 催办：同一张单多久一次 */
export const APPROVAL_URGE_GAP_MINUTES = 60;

export interface ApprovalStep {
  id: number;
  seq: number;
  label: string;
  approverId: number;
  approverName: string;
  status: ApprovalStepStatus;
  comment: string;
  actedAt: string | null;
  /** 转交给了谁（这一步是被转出去的那一步） */
  transferredToName: string | null;
}
export interface ApprovalEvent {
  id: number;
  kind: ApprovalEventKind;
  actorId: number;
  actorName: string;
  toName: string | null;
  comment: string;
  createdAt: string;
}
export interface ApprovalListItem {
  id: number;
  title: string;
  templateCode: string;
  templateName: string;
  applicantId: number;
  applicantName: string;
  status: ApprovalStatus;
  /** 审批中时当前的审批人 */
  currentApproverName: string | null;
  revision: number;
  submittedAt: string;
  finishedAt: string | null;
  /** 抄送给我的：读过没有 */
  ccReadAt?: string | null;
}
export interface ApprovalDetail extends ApprovalListItem {
  fields: ApprovalField[];
  form: ApprovalForm;
  steps: ApprovalStep[];
  events: ApprovalEvent[];
  cc: { staffId: number; name: string; readAt: string | null }[];
  attachments: OaAttachment[];
  previousId: number | null;
  /** 重新提交成的下一版 */
  nextId: number | null;
  /** 当前待处理的那一步（处理时带上，别人先处理了就拒绝） */
  pendingStepId: number | null;
  can: Record<ApprovalAction | 'resubmit', boolean>;
}
export type ApprovalBox = 'todo' | 'done' | 'mine' | 'cc';
export interface ApprovalPage {
  items: ApprovalListItem[];
  /** 下一页从哪个编号往前取 */
  next: number | null;
}
export interface ApprovalSummary {
  todo: number;
  ccUnread: number;
}
export interface ApprovalSaved {
  approval: ApprovalDetail;
  replayed: boolean;
}

/** 转交时选的人：在职员工 */
export interface ApprovalPerson {
  id: number;
  name: string;
  department: string;
}

/** 请假时长（半天）、加班分钟等由服务端算好放进表单的几项（不是模板字段，页面单独显示） */
export function derivedText(code: string, form: ApprovalForm): string | null {
  if (code === 'leave' && typeof form.durationHalves === 'number') return `${form.durationHalves / 2} 天`;
  if (code === 'overtime' && typeof form.minutes === 'number') return `${Math.round((form.minutes / 60) * 10) / 10} 小时`;
  if (code === 'trip' && typeof form.days === 'number') return `${form.days} 天`;
  return null;
}
/** 请假开始 / 结束的时间点比较用：日期 + 上午 0 / 下午 1 */
export const halfDayKey = (h: HalfDay) => `${h.date}${h.half === 'am' ? 0 : 1}`;

// ───────────────────────── OA-12 审批管理端（docs/OA.md 第 15 节） ─────────────────────────

/** 看板里「超时未处理」：当前这一级等了超过几小时（OA14） */
export const APPROVAL_OVERDUE_HOURS = 24;
export interface AdminApprovalItem extends ApprovalListItem {
  /** 发起人的部门 */
  department: string;
}
export interface AdminApprovalPage {
  items: AdminApprovalItem[];
  next: number | null;
}
export interface ApprovalBoard {
  month: string;
  templates: { code: string; name: string; submitted: number; approved: number; rejected: number; withdrawn: number; pending: number; avgHours: number | null }[];
  overdue: { id: number; title: string; applicantName: string; approverName: string; waitedHours: number }[];
}
/** 条件开关适用于哪个模板（后台只给适用的显示） */
export const CONDITION_TEMPLATE: Record<ApprovalCondition, string> = { leave_over_3_days: 'leave', expense_over_5000: 'expense' };
