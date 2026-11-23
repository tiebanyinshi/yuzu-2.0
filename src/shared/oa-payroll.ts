// OA-17 工资条模板与制表（docs/OA.md 第 20 节）：模板字段、工资表、导入预览。服务端与页面共用。
// 金额按分存整数；系统不算工资（应发、实发按 HR 填的）。

import { formatAmount } from './money';
import type { OrgDepartment } from './positions';

/** 字段类型：money 金额（分）/ number 数字（如出勤天数，最多两位小数）/ text 文字 */
export type PayslipFieldKind = 'money' | 'number' | 'text';
export const PAYSLIP_FIELD_KINDS: readonly { value: PayslipFieldKind; label: string }[] = [
  { value: 'money', label: '金额' },
  { value: 'number', label: '数字' },
  { value: 'text', label: '文字' },
];

export interface PayslipField {
  /** 字段编号（f1、f2…）：模板里不变，改名不影响已经填的值 */
  key: string;
  label: string;
  kind: PayslipFieldKind;
  /** 员工的工资条列表上显示的那一项（「实发」），最多一个，只能是金额 */
  net?: boolean;
}

export const PAYSLIP_MAX_FIELDS = 40;
export const PAYROLL_MAX_ROWS = 2000;
/** 金额、数字的绝对值上限（元 / 数）：一千万 */
export const PAYROLL_MAX_ABS = 10_000_000;
export const PAYSLIP_TEXT_MAX = 100;

/** 单元格的值：金额是分（整数），数字照原样，文字是字符串；没填为 null */
export type PayslipValue = number | string | null;
export type PayslipValues = Record<string, PayslipValue>;

export interface PayslipTemplate {
  id: number;
  name: string;
  fields: PayslipField[];
  active: boolean;
  version: number;
  updatedAt: string;
  /** 用这个模板建过几张没作废的工资表 */
  batchCount: number;
}

export type PayrollBatchStatus = 'draft' | 'published' | 'void';
export const PAYROLL_STATUS_LABEL: Record<PayrollBatchStatus, string> = { draft: '草稿', published: '已发放', void: '已作废' };

export interface PayrollBatchSummary {
  id: number;
  /** YYYY-MM */
  month: string;
  title: string;
  templateId: number;
  templateName: string;
  status: PayrollBatchStatus;
  /** 几个人 */
  slipCount: number;
  /** 填了至少一项的 */
  filledCount: number;
  /** 已签收的（OA-18，发放以后才有意义） */
  signedCount: number;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  /** 发放时间（OA-18）；草稿为空 */
  publishedAt: string | null;
  /** 最近一次「一键提醒」 */
  remindedAt: string | null;
}

export interface PayrollPerson {
  staffId: number;
  name: string;
  empNo: string | null;
  department: OrgDepartment | null;
  departmentName: string;
}

export interface PayslipRow extends PayrollPerson {
  values: PayslipValues;
  updatedAt: string;
  /** 这一行的人已经不在这个月的在职名单里（建表后改了入职、离职日期，或改成了专用账号） */
  offRoster: string | null;
  /** 员工确认签收、第一次打开的时间（OA-18，发放以后） */
  signedAt: string | null;
  viewedAt: string | null;
}

export interface PayrollFileInfo {
  id: number;
  fileName: string;
  size: number;
  rowCount: number;
  uploadedByName: string;
  uploadedAt: string;
  /** 用现在的密钥解得开（换过密钥的旧原件为 false） */
  readable: boolean;
}

export interface PayrollBatchDetail extends PayrollBatchSummary {
  fields: PayslipField[];
  slips: PayslipRow[];
  /** 这个月在职、表里没有的人 */
  missing: PayrollPerson[];
  files: PayrollFileInfo[];
  /** 服务器配了工资表原件的加密密钥（没配不能上传 Excel） */
  canUpload: boolean;
}

export interface PayrollImportRow {
  /** 文件里的第几行 */
  row: number;
  staffId: number | null;
  name: string;
  empNo: string | null;
  issues: string[];
}

export interface PayrollImportPreview {
  fileName: string;
  rows: PayrollImportRow[];
  okCount: number;
  errorCount: number;
  /** 这个月在职、表里没有的人（提醒，不拦） */
  missing: PayrollPerson[];
}

export interface PayrollImportResult {
  batchId: number;
  slipCount: number;
  fileId: number;
}

/** 表格里认人的三列（在模板字段前面） */
export const PAYROLL_ID_COLUMNS = ['工号', '姓名', '部门'] as const;

const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * 读一个金额、数字单元格：空 → null；不对 → 'invalid'。最多两位小数（Excel 存成二进制小数的，如 0.30000000000000004，四舍五入到分后差不到百万分之一的算两位），
 * 绝对值不超过一千万。金额返回分，数字返回原值（两位小数以内）
 */
export function parseAmountCell(text: string, kind: 'money' | 'number'): number | null | 'invalid' {
  const t = text
    .trim()
    .replace(/[,，\s]/g, '')
    .replace(/^¥/, '');
  if (!t) return null;
  if (!NUMBER_PATTERN.test(t)) return 'invalid';
  const n = Number(t);
  if (!Number.isFinite(n) || Math.abs(n) > PAYROLL_MAX_ABS) return 'invalid';
  const cents = Math.round(n * 100);
  if (Math.abs(cents / 100 - n) > 1e-6) return 'invalid';
  return kind === 'money' ? cents : cents / 100;
}

/** 校验一行的值（导入、在线编辑共用）：返回规范化的值与问题；只认模板里的字段 */
export function normalizeValues(fields: PayslipField[], input: Record<string, unknown>): { values: PayslipValues; issues: string[] } {
  const values: PayslipValues = {};
  const issues: string[] = [];
  for (const f of fields) {
    const raw = input[f.key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (f.kind === 'text') {
      const s = String(raw).trim();
      if (s.length > PAYSLIP_TEXT_MAX) issues.push(`「${f.label}」最多 ${PAYSLIP_TEXT_MAX} 个字`);
      else if (s) values[f.key] = s;
      continue;
    }
    // 金额在线编辑时传的是分（整数），导入时是表格里的文字（元）
    if (typeof raw === 'number') {
      const ok =
        f.kind === 'money'
          ? Number.isSafeInteger(raw) && Math.abs(raw) <= PAYROLL_MAX_ABS * 100
          : Number.isFinite(raw) && Math.abs(raw) <= PAYROLL_MAX_ABS && Math.abs(Math.round(raw * 100) / 100 - raw) < 1e-9;
      if (ok) values[f.key] = raw;
      else issues.push(`「${f.label}」不对`);
      continue;
    }
    const v = parseAmountCell(String(raw), f.kind);
    if (v === 'invalid') issues.push(`「${f.label}」要写数字，最多两位小数${f.kind === 'money' ? '（单位：元）' : ''}`);
    else if (v !== null) values[f.key] = v;
  }
  return { values, issues };
}

/** 显示一个值：金额「1,280.00」，数字照原样，空的「—」 */
export function formatPayslipValue(field: PayslipField, value: PayslipValue | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field.kind === 'money' && typeof value === 'number') return `${value < 0 ? '-' : ''}${formatAmount(Math.abs(value))}`;
  return String(value);
}

/** 「实发」那一项（模板里标了的） */
export const netField = (fields: PayslipField[]) => fields.find((f) => f.net && f.kind === 'money') ?? null;

/** 2026-11 → 2026 年 11 月 */
export const monthLabel = (month: string) => `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`;

// ───────────── OA-18 发放、签收与薪资审计（docs/OA.md 第 21 节） ─────────────

/** 同一张表「一键提醒」的间隔（分钟） */
export const PAYROLL_REMIND_MINUTES = 10;

/** 员工端：本人的一张工资条（列表） */
export interface MyPayslipItem {
  id: number;
  month: string;
  title: string;
  publishedAt: string;
  signedAt: string | null;
}

/** 员工端：本人的一张工资条（明细） */
export interface MyPayslipDetail extends MyPayslipItem {
  /** 「实发」那一项（分）；模板没标或没填为空。只在明细里给（列表不带金额） */
  net: number | null;
  name: string;
  fields: PayslipField[];
  values: PayslipValues;
}

export type PayrollAuditAction = 'view_batch' | 'export_sheet' | 'download_file' | 'publish' | 'remind' | 'employee_view' | 'employee_sign';
export const PAYROLL_AUDIT_LABELS: Record<PayrollAuditAction, string> = {
  view_batch: '查看工资表',
  export_sheet: '下载表格',
  download_file: '下载原件',
  publish: '发放',
  remind: '提醒签收',
  employee_view: '员工查看',
  employee_sign: '员工签收',
};

export interface PayrollAuditItem {
  id: number;
  at: string;
  action: PayrollAuditAction;
  actorName: string | null;
  batchId: number | null;
  /** 2026 年 11 月 · 11 月工资 */
  batchLabel: string | null;
  targetName: string | null;
  ip: string | null;
}

export interface PayrollAuditPage {
  items: PayrollAuditItem[];
  /** 还有更早的：下一页从这个编号以前取 */
  next: number | null;
}
