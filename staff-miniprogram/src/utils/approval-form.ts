// 发起申请（docs/STAFF_MP.md 第 2.4 节，SP07）：审批模板是后台定的表单（/api/oa/approval/templates），小程序照模板的字段画表单，
// 提交走网页同一个接口（门店系统照旧按模板核对一遍）。这里是不依赖界面的部分：哪些字段画得了、页面上的值怎么变成提交的表单、
// 先在手机上核对一遍（必填、字数、格式）、从别的页带过来的预填（缺卡补卡、工资条异议）、本机草稿。

import type { ApprovalField, ApprovalFieldType, ApprovalForm, ApprovalTemplate, HalfDay } from '../../../src/shared/oa-approval';
import { centsOf, yuan } from './money';

/** 小程序画得了的字段类型；模板里有别的类型（以后新加的）就整张单请到网页上提交 */
export const SUPPORTED_TYPES: readonly ApprovalFieldType[] = ['text', 'textarea', 'number', 'money', 'date', 'datetime', 'halfday', 'select', 'attachments', 'leave_type', 'shift', 'ref'];

export function templateSupported(t: Pick<ApprovalTemplate, 'fields'>): boolean {
  return t.fields.every((f) => SUPPORTED_TYPES.includes(f.type));
}

/** 附件：页面上记着编号、文件名与手机上的缩略图路径 */
export interface PickedFile {
  id: number;
  fileName: string;
  path: string;
}

/** 页面上的值：文字、数字、金额（元）是字符串；半天是 { date, half }；附件是 PickedFile[]；选的编号是数字 */
export type FieldValue = string | number | HalfDay | PickedFile[] | null;
export type Values = Record<string, FieldValue>;

const TEXT_MAX = 60;
const TEXTAREA_MAX = 2000;
const ATTACH_MAX = 9;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

export const maxOf = (f: Pick<ApprovalField, 'type' | 'max'>) => f.max ?? (f.type === 'text' ? TEXT_MAX : f.type === 'textarea' ? TEXTAREA_MAX : f.type === 'attachments' ? ATTACH_MAX : undefined);

const isEmpty = (v: FieldValue | undefined) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** 页面上的值 → 提交的表单（金额元 → 分，附件 → 编号，空的 → null） */
export function toForm(fields: readonly ApprovalField[], values: Values): ApprovalForm {
  const out: ApprovalForm = {};
  for (const f of fields) {
    const v = values[f.key];
    if (isEmpty(v)) {
      out[f.key] = f.type === 'attachments' ? [] : null;
      continue;
    }
    switch (f.type) {
      case 'money':
        out[f.key] = typeof v === 'string' ? (centsOf(v) ?? (v as never)) : (v as never);
        break;
      case 'number':
        out[f.key] = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : (v as never);
        break;
      case 'attachments':
        out[f.key] = Array.isArray(v) ? (v as PickedFile[]).map((a) => a.id) : [];
        break;
      case 'text':
      case 'textarea':
        out[f.key] = typeof v === 'string' ? v.trim() : (v as never);
        break;
      default:
        out[f.key] = v as never;
    }
  }
  return out;
}

/** 先在手机上核对一遍（门店系统照旧再核对）：第一处问题 { key, message }，没有返回 null */
export function checkValues(fields: readonly ApprovalField[], values: Values): { key: string; message: string } | null {
  for (const f of fields) {
    const v = values[f.key];
    if (isEmpty(v)) {
      if (f.required) return { key: f.key, message: f.type === 'attachments' ? `请上传${f.label}` : `请填写${f.label}` };
      continue;
    }
    const max = maxOf(f);
    switch (f.type) {
      case 'text':
      case 'textarea':
        if (typeof v === 'string' && max !== undefined && [...v.trim()].length > max) return { key: f.key, message: `${f.label}最多 ${max} 个字` };
        break;
      case 'number':
        if (typeof v !== 'string' || !/^-?\d+$/.test(v.trim())) return { key: f.key, message: `${f.label}要填整数` };
        if (f.min !== undefined && Number(v) < f.min) return { key: f.key, message: `${f.label}不能小于 ${f.min}` };
        if (f.max !== undefined && Number(v) > f.max) return { key: f.key, message: `${f.label}不能大于 ${f.max}` };
        break;
      case 'money': {
        const c = typeof v === 'string' ? centsOf(v) : null;
        if (c === null) return { key: f.key, message: `${f.label}按元填，最多两位小数` };
        if (f.min !== undefined && c < f.min) return { key: f.key, message: `${f.label}不能小于 ${yuan(f.min)} 元` };
        if (f.max !== undefined && c > f.max) return { key: f.key, message: `${f.label}不能大于 ${yuan(f.max)} 元` };
        break;
      }
      case 'date':
        if (typeof v !== 'string' || !DATE_RE.test(v)) return { key: f.key, message: `请选${f.label}` };
        break;
      case 'datetime':
        if (typeof v !== 'string' || !DATETIME_RE.test(v)) return { key: f.key, message: `${f.label}要选日期和时间` };
        break;
      case 'halfday': {
        const h = v as Partial<HalfDay>;
        if (!h || typeof h !== 'object' || !DATE_RE.test(h.date ?? '') || (h.half !== 'am' && h.half !== 'pm')) return { key: f.key, message: `${f.label}要选日期和上午 / 下午` };
        break;
      }
      case 'select':
        if (typeof v !== 'string' || !(f.options ?? []).includes(v)) return { key: f.key, message: `${f.label}要从选项里选` };
        break;
      case 'attachments':
        if (max !== undefined && Array.isArray(v) && v.length > max) return { key: f.key, message: `${f.label}最多 ${max} 张` };
        break;
      case 'leave_type':
      case 'shift':
      case 'ref':
        if (typeof v !== 'number' || v <= 0) return { key: f.key, message: `请选${f.label}` };
        break;
    }
  }
  return null;
}

/**
 * 从别的页带过来的预填（与 WCP 网页同一个口径，src/client/features/oa/ApprovalForm.tsx）：
 *   · 补卡（makeup）：date、shiftId、kind（in → 上班卡、out → 下班卡）；
 *   · 工资条异议（payslip_objection）：f.<字段>（文字字段）
 */
export function prefillOf(t: Pick<ApprovalTemplate, 'code' | 'fields'>, query: Record<string, string | undefined>): Values {
  const out: Values = {};
  if (t.code === 'makeup') {
    const date = query.date ?? '';
    if (DATE_RE.test(date)) out.date = date;
    const shiftId = query.shiftId ?? '';
    if (/^\d+$/.test(shiftId) && Number(shiftId) > 0) out.shiftId = Number(shiftId);
    const raw = query.kind ?? '';
    const kind = raw === 'in' ? '上班卡' : raw === 'out' ? '下班卡' : raw;
    const kindField = t.fields.find((f) => f.key === 'kind');
    if (kind && (!kindField?.options || kindField.options.includes(kind))) out.kind = kind;
  }
  for (const f of t.fields) {
    if (f.type !== 'text' && f.type !== 'textarea') continue;
    const v = query[`f.${f.key}`];
    if (typeof v === 'string' && v) out[f.key] = v.slice(0, maxOf(f) ?? 200);
  }
  return out;
}

// ── 页面上每一项怎么画（纯函数） ──

/** 选项类字段要的列表：假种、那天的班次、能关联的单 */
export interface OptionLists {
  leaveTypes: { id: number; name: string }[];
  shifts: { id: number; name: string }[];
  refs: { id: number; name: string }[];
}

export interface FieldView {
  key: string;
  label: string;
  type: ApprovalFieldType;
  required: boolean;
  hint: string;
  /** 文字、数字、金额输入框里的字 */
  text: string;
  maxLength: number;
  /** 选项（下拉）的名字与选中的第几个（没选 -1） */
  options: string[];
  optionIndex: number;
  /** 选好的显示成什么（没选为空） */
  display: string;
  date: string;
  time: string;
  half: string;
  files: PickedFile[];
  /** 还能再加几张图 */
  room: number;
  error: string;
}

const listOf = (f: ApprovalField, lists: OptionLists) =>
  f.type === 'leave_type' ? lists.leaveTypes : f.type === 'shift' ? lists.shifts : f.type === 'ref' ? lists.refs : (f.options ?? []).map((o, i) => ({ id: i, name: o }));

export function fieldViews(fields: readonly ApprovalField[], values: Values, lists: OptionLists, error: { key: string; message: string } | null): FieldView[] {
  return fields.map((f) => {
    const v = values[f.key];
    const max = maxOf(f);
    const list = listOf(f, lists);
    let optionIndex = -1;
    if (f.type === 'select') optionIndex = (f.options ?? []).indexOf(typeof v === 'string' ? v : '');
    else if (f.type === 'leave_type' || f.type === 'shift' || f.type === 'ref') optionIndex = list.findIndex((x) => x.id === v);
    const half = f.type === 'halfday' && v && typeof v === 'object' && !Array.isArray(v) ? (v as HalfDay) : null;
    const dt = f.type === 'datetime' && typeof v === 'string' ? v : '';
    const files = f.type === 'attachments' && Array.isArray(v) ? (v as PickedFile[]) : [];
    const date = f.type === 'date' && typeof v === 'string' ? v : half ? half.date : dt ? dt.slice(0, 10) : '';
    return {
      key: f.key,
      label: f.label,
      type: f.type,
      required: !!f.required,
      hint: f.hint ?? '',
      text: typeof v === 'string' || typeof v === 'number' ? String(v) : '',
      maxLength: max ?? 140,
      options: list.map((x) => x.name),
      optionIndex,
      display: optionIndex >= 0 ? (list[optionIndex]?.name ?? '') : '',
      date,
      time: dt ? dt.slice(11, 16) : '',
      half: half ? half.half : '',
      files,
      room: Math.max(0, (max ?? ATTACH_MAX) - files.length),
      error: error && error.key === f.key ? error.message : '',
    };
  });
}

/** 改了一项（纯函数）：日期、时间、半天、下拉各自怎么并进值里 */
export function applyChange(fields: readonly ApprovalField[], values: Values, lists: OptionLists, key: string, part: 'text' | 'date' | 'time' | 'half' | 'pick', raw: string | number): Values {
  const f = fields.find((x) => x.key === key);
  if (!f) return values;
  const next: Values = { ...values };
  const cur = values[key];
  if (part === 'text') next[key] = String(raw);
  else if (part === 'pick') {
    const idx = Number(raw);
    if (f.type === 'select') next[key] = (f.options ?? [])[idx] ?? null;
    else next[key] = listOf(f, lists)[idx]?.id ?? null;
  } else if (f.type === 'date') next[key] = String(raw);
  else if (f.type === 'datetime') {
    const s = typeof cur === 'string' ? cur : '';
    const date = part === 'date' ? String(raw) : s.slice(0, 10);
    const time = part === 'time' ? String(raw) : s.slice(11, 16) || '09:00';
    next[key] = date ? `${date}T${time}` : null;
  } else if (f.type === 'halfday') {
    const h = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as HalfDay) : { date: '', half: 'am' as const };
    next[key] = part === 'date' ? { date: String(raw), half: h.half } : { date: h.date, half: raw === 'pm' ? 'pm' : 'am' };
  }
  return next;
}

// ── 本机草稿：每个人每个模板一份；提交成功删掉 ──

const draftKey = (staffId: number, code: string) => `wcp_draft:${staffId}:${code}`;

export function readDraft(staffId: number, code: string): Values | null {
  try {
    const v = wx.getStorageSync(draftKey(staffId, code)) as Values | '';
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export function writeDraft(staffId: number, code: string, values: Values): void {
  try {
    wx.setStorageSync(draftKey(staffId, code), values);
  } catch {
    // 存不了：只是下次没有草稿
  }
}

export function clearDraft(staffId: number, code: string): void {
  try {
    wx.removeStorageSync(draftKey(staffId, code));
  } catch {
    // 删不了：下次覆盖
  }
}

// ── 审批单的文字 ──

export const STATUS_LABELS: Record<string, string> = { pending: '审批中', approved: '已通过', rejected: '已驳回', withdrawn: '已撤销' };
export const EVENT_LABELS: Record<string, string> = { submit: '提交', approve: '通过', reject: '驳回', transfer: '转交', withdraw: '撤销', comment: '评论', urge: '催办' };

/** 表单里的一项显示成文字（详情页用） */
export function valueText(f: Pick<ApprovalField, 'type' | 'options'>, v: unknown, names: { leaveTypes?: Record<number, string> } = {}): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (f.type) {
    case 'money':
      return typeof v === 'number' ? `${yuan(v)} 元` : String(v);
    case 'halfday': {
      const h = v as Partial<HalfDay>;
      return h && h.date ? `${h.date} ${h.half === 'am' ? '上午' : '下午'}` : '—';
    }
    case 'datetime':
      return typeof v === 'string' ? v.replace('T', ' ') : String(v);
    case 'leave_type':
      return typeof v === 'number' ? (names.leaveTypes?.[v] ?? `假种 #${v}`) : String(v);
    case 'attachments':
      return Array.isArray(v) ? `${v.length} 个附件` : '—';
    default:
      return String(v);
  }
}
