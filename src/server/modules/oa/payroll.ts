// OA-17 工资条模板与制表（docs/OA.md 第 20 节，OA21；需求文档七（一）、七（三））：后台「人员与行政 → 工资条」。
//   · 模板：字段（金额 / 数字 / 文字）可配，标一项「实发」；停用不删。建工资表时把字段抄到表上，之后改模板不影响。
//   · 工资表：月份 + 标题建草稿（同月同标题已有就打开那张），按这个月的在职名单每人一行；Excel 上传先预览、整份没问题再整张替换，
//     或在线逐行编辑；与组织架构核对名单（缺的人、已经不在名单里的行）。系统不算工资。
//   · 原件：AES-256-GCM 加密存库（密钥 PAYROLL_FILE_KEY，库里只记指纹），只有 payroll.manage 的人能下载。
//   · 审计：看明细、下载表格、下载原件记进 oa_payroll_audit（不记金额）；建表、导入、改、作废、改模板另写后台操作记录（不带金额）。
// 只认后台核实过的岗位（与组织架构同一道核对）：自己选成人力负责人、后台还没核实的打不开。
// 加锁（docs/LOCKING.md「工资条」）：模板行 → 工资表行（FOR UPDATE）→ 工资条行。不带操作编号：新建按月份 + 标题去重，导入整张替换，编辑按结果写（OA21）。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { departmentOfPosition } from '@shared/oa';
import {
  monthLabel,
  netField,
  normalizeValues,
  PAYROLL_ID_COLUMNS,
  PAYROLL_MAX_ROWS,
  PAYSLIP_MAX_FIELDS,
  PAYROLL_REMIND_MINUTES,
  type PayrollBatchDetail,
  type PayrollAuditAction,
  type PayrollAuditItem,
  type PayrollAuditPage,
  type PayrollBatchStatus,
  type MyPayslipDetail,
  type MyPayslipItem,
  type PayrollBatchSummary,
  type PayrollFileInfo,
  type PayrollImportPreview,
  type PayrollImportResult,
  type PayrollImportRow,
  type PayrollPerson,
  type PayslipField,
  type PayslipRow,
  type PayslipTemplate,
  type PayslipValues,
} from '@shared/oa-payroll';
import { can, type Duty, type Role } from '@shared/permissions';
import { ORG_DEPARTMENTS, type OrgDepartment, type PositionKey } from '@shared/positions';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import { guardAny } from '../../auth/guard';
import { subjectOf } from '../../auth/role-permissions';
import type { AppConfig } from '../../config';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { attachment } from '../../lib/csv';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { readSheet, type Sheet } from '../../lib/sheet-read';
import { parse } from '../../lib/validate';
import { buildWorkbook, colName, type WbSheet } from '../../lib/xlsx';
import { DEFAULT_STORE_ID } from '../../lib/store-context';
import { allowedStores } from '../stores';
import { employeeOnly } from './im';
import { notify } from './notifications';
import { NOT_EMPLOYEE_ROLES } from './org';

/** 时间：库里读出来的可能是文字，统一成 ISO */
const iso = (v: Date | string) => new Date(v).toISOString();

// ───────────────────────── 权限 ─────────────────────────

/** 管工资条的人：有 payroll.manage（按库里现在的岗位、角色、个人微调重算），而且是总裁或岗位由后台给的（不是自己选的） */
export async function managesPayroll(db: Db, actor: Actor): Promise<boolean> {
  const [me] = await db<{ role: Role; duties: Duty[] | null; position: unknown; permissionAdjust: unknown; active: boolean; selfChosen: boolean }[]>`
    SELECT role, duties, position, permission_adjust, active, position_chosen_at IS NOT NULL AS self_chosen FROM staff WHERE id = ${actor.id}`;
  if (!me?.active) return false;
  const now = await subjectOf(db, me);
  return can(now, 'payroll.manage') && (me.role === 'owner' || !me.selfChosen);
}

const guardPayroll = guardAny('payroll.manage');
function canManagePayroll(db: Db): preHandlerAsyncHookHandler {
  return async function (req, reply) {
    await guardPayroll.call(this, req, reply);
    if (!(await managesPayroll(db, req.actor))) throw forbidden('你的岗位还没由后台核实，不能管工资条');
  };
}

// ───────────────────────── 原件加密 ─────────────────────────

/** 开发、测试没配密钥时用的固定密钥（不是秘密；正式、试用环境不用它） */
const DEV_KEY = 'yuzu-development-payroll-file-key-not-a-secret';

export interface PayrollKey {
  key: Buffer;
  id: string;
}

/** 当前的加密密钥：配了用配的；开发、测试没配用开发密钥；正式、试用没配为空（不能上传 Excel） */
export function payrollKeyOf(config: Pick<AppConfig, 'env' | 'payrollFileKey'>): PayrollKey | null {
  const raw = config.payrollFileKey ?? (config.env === 'development' || config.env === 'test' ? DEV_KEY : null);
  if (!raw) return null;
  return {
    key: createHash('sha256').update(`yuzu-payroll-file:${raw}`).digest(),
    id: createHash('sha256').update(`yuzu-payroll-key-id:${raw}`).digest('hex').slice(0, 16),
  };
}

export function encryptFile(k: PayrollKey, data: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k.key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext, keyId: k.id };
}

export function decryptFile(k: PayrollKey, f: { iv: Buffer; tag: Buffer; ciphertext: Buffer }): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', k.key, f.iv);
  decipher.setAuthTag(f.tag);
  return Buffer.concat([decipher.update(f.ciphertext), decipher.final()]);
}

// ───────────────────────── 审计 ─────────────────────────

async function payrollAudit(db: Db, e: { staffId: number; action: PayrollAuditAction; batchId: number; targetId?: number | null; fileId?: number | null; ip?: string }) {
  await db`
    INSERT INTO oa_payroll_audit (staff_id, action, batch_id, target_id, file_id, ip)
    VALUES (${e.staffId}, ${e.action}, ${e.batchId}, ${e.targetId ?? null}, ${e.fileId ?? null}, ${e.ip ?? null})`;
}

// ───────────────────────── 门店范围 ─────────────────────────
// 与组织架构同一个口径（Codex 安全审查 f6c14e7）：总裁（staff.manage）看全部门店；其他管工资条的人只管自己挂着的门店。
// 每张工资表记下建表人的门店范围（store_ids，空 = 全部门店）：名单按它取，看、改、导出、下载都先核对自己的范围包得住它。

type Scope = { all: true } | { all: false; stores: number[] };

async function scopeOf(db: Db, actor: Actor): Promise<Scope> {
  if (can(actor, 'staff.manage')) return { all: true };
  return { all: false, stores: [...new Set((await allowedStores(db, actor)).map((x) => Number(x.id)))].sort((a, b) => a - b) };
}

const batchScope = (storeIds: number[] | null): Scope => (storeIds === null ? { all: true } : { all: false, stores: storeIds.map(Number) });
/** 我的范围包不包得住这张表的范围 */
const covers = (mine: Scope, storeIds: number[] | null) => mine.all || (storeIds !== null && storeIds.every((id) => mine.stores.includes(Number(id))));

/** 员工在不在范围里（s 是 staff 表）：挂的门店都在范围里；没挂门店的算本店 */
function storeCond(db: Db, scope: Scope) {
  if (scope.all) return db`true`;
  // 挂门店的 HR 建的表不含总裁（总裁只在总裁自己建的全店表里，OA-18）
  return db`s.role <> 'owner' AND (NOT EXISTS (SELECT 1 FROM staff_stores x WHERE x.staff_id = s.id AND NOT (x.store_id = ANY(${scope.stores}::bigint[])))
    AND (EXISTS (SELECT 1 FROM staff_stores x WHERE x.staff_id = s.id) OR ${DEFAULT_STORE_ID}::bigint = ANY(${scope.stores}::bigint[])))`;
}

// ───────────────────────── 名单 ─────────────────────────

const deptName = (key: OrgDepartment | null) => (key ? (ORG_DEPARTMENTS.find((d) => d.key === key)?.name ?? key) : '未分部门');

interface RosterEntry extends PayrollPerson {
  /** 在这个月的在职名单里；不在的写原因 */
  offRoster: string | null;
}

const monthStart = (month: string) => `${month}-01`;
function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

/**
 * 全部员工（专用账号不算）与这个月在不在名单里：这个月里在职过 = 入职日期不晚于月底，而且账号启用、没离职，或离职日期不早于月初。
 * 停用了但没办离职的不算（停用就是不在岗）
 */
async function staffFor(db: Db, month: string, scope: Scope): Promise<Map<number, RosterEntry>> {
  const rows = await db<
    {
      staffId: number;
      name: string;
      position: PositionKey | null;
      active: boolean;
      role: string;
      system: boolean;
      empNo: string | null;
      hireDate: string | null;
      leaveDate: string | null;
      status: string | null;
      inScope: boolean;
    }[]
  >`
    SELECT s.id AS staff_id, s.display_name AS name, s.position, s.active, s.role, s.system,
           p.emp_no, p.hire_date::text AS hire_date, p.leave_date::text AS leave_date, p.status, ${storeCond(db, scope)} AS in_scope
    FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
    ORDER BY s.id`;
  const start = monthStart(month);
  const end = monthEnd(month);
  const out = new Map<number, RosterEntry>();
  for (const r of rows) {
    const department = departmentOfPosition(r.position);
    let off: string | null = null;
    if (r.system || NOT_EMPLOYEE_ROLES.includes(r.role)) off = NOT_EMPLOYEE;
    else if (!r.inScope) off = OUT_OF_SCOPE;
    else if (r.hireDate && r.hireDate > end) off = `${r.hireDate} 才入职`;
    else if (r.status === 'left') off = r.leaveDate && r.leaveDate >= start ? null : `已于 ${r.leaveDate ?? '之前'} 离职`;
    else if (!r.active) off = '账号已停用';
    out.set(Number(r.staffId), { staffId: Number(r.staffId), name: r.name, empNo: r.empNo, department, departmentName: deptName(department), offRoster: off });
  }
  return out;
}

const NOT_EMPLOYEE = '不是员工账号';
const OUT_OF_SCOPE = '不在这张表的门店范围';

const person = (e: RosterEntry): PayrollPerson => ({ staffId: e.staffId, name: e.name, empNo: e.empNo, department: e.department, departmentName: e.departmentName });

/** 名单排序：部门（组织架构的顺序）→ 工号 → 姓名 */
const deptOrder = new Map<string, number>(ORG_DEPARTMENTS.map((d, i) => [d.key, i]));
const byDept = (a: PayrollPerson, b: PayrollPerson) =>
  (deptOrder.get(a.department ?? '') ?? 99) - (deptOrder.get(b.department ?? '') ?? 99) || (a.empNo ?? '~').localeCompare(b.empNo ?? '~') || a.name.localeCompare(b.name, 'zh');

// ───────────────────────── 模板 ─────────────────────────

const FieldInput = z.object({
  key: z
    .string()
    .regex(/^f\d{1,3}$/, '字段编号不正确')
    .optional(),
  label: z
    .string()
    .trim()
    .min(1, '字段名称没填')
    .max(20, '字段名称最多 20 个字')
    .refine((s) => !(PAYROLL_ID_COLUMNS as readonly string[]).includes(s), '工号、姓名、部门是表格固定的列，字段不能叫这几个名字'),
  kind: z.enum(['money', 'number', 'text']),
  net: z.boolean().optional(),
});
const TemplateInput = z
  .object({
    name: z.string().trim().min(1, '模板名称没填').max(40, '模板名称最多 40 个字'),
    fields: z.array(FieldInput).min(1, '至少一个字段').max(PAYSLIP_MAX_FIELDS, `最多 ${PAYSLIP_MAX_FIELDS} 个字段`),
  })
  .refine((t) => new Set(t.fields.map((f) => f.label)).size === t.fields.length, '字段名称不能重复')
  .refine((t) => t.fields.filter((f) => f.net).length <= 1, '「实发」只能标一项')
  .refine((t) => t.fields.every((f) => !f.net || f.kind === 'money'), '「实发」只能标金额字段');
const TemplateUpdate = TemplateInput.and(z.object({ active: z.boolean(), version: z.number().int().positive() }));

/** 给新字段编号：已经有的编号不变（改名、换顺序不影响已经填的值），新的接着最大的往后编 */
function assignKeys(input: z.infer<typeof FieldInput>[], existing: PayslipField[] = []): PayslipField[] {
  const known = new Set(existing.map((f) => f.key));
  let next = Math.max(0, ...[...existing, ...input].map((f) => Number(f.key?.slice(1) ?? 0))) + 1;
  const used = new Set<string>();
  return input.map((f) => {
    let key = f.key && known.has(f.key) && !used.has(f.key) ? f.key : `f${next++}`;
    if (used.has(key)) key = `f${next++}`;
    used.add(key);
    return { key, label: f.label, kind: f.kind, ...(f.net ? { net: true } : {}) };
  });
}

/** 比较时不看键的顺序（jsonb 存进去以后键会重排） */
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v);
const sameFields = (a: PayslipField[], b: PayslipField[]) => canonical(a) === canonical(b);
/** 请求里的字段（新加的没有编号）与现有的一一对得上：顺序、名称、类型、实发一样，带了编号的编号也一样 */
const sameShape = (input: z.infer<typeof FieldInput>[], cur: PayslipField[]) =>
  input.length === cur.length &&
  input.every((f, i) => {
    const c = cur[i]!;
    return c.label === f.label && c.kind === f.kind && !!c.net === !!f.net && (!f.key || f.key === c.key);
  });

async function listTemplates(db: Db): Promise<PayslipTemplate[]> {
  const rows = await db<{ id: number; name: string; fields: PayslipField[]; active: boolean; version: number; updatedAt: Date; batchCount: number }[]>`
    SELECT t.id, t.name, t.fields, t.active, t.version, t.updated_at,
           (SELECT count(*)::int FROM oa_payroll_batches b WHERE b.template_id = t.id AND b.status <> 'void') AS batch_count
    FROM oa_payslip_templates t ORDER BY t.active DESC, t.id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), updatedAt: iso(r.updatedAt) }));
}

function translateTemplateUnique(error: unknown): never {
  if (isUniqueViolation(error, 'oa_payslip_templates_name_uq')) throw conflict('TEMPLATE_NAME_EXISTS', '已经有一个同名的模板（在用的）');
  throw error;
}

// ───────────────────────── 工资表 ─────────────────────────

const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份写成 2026-11 这样');
const BatchInput = z.object({
  month: MONTH,
  title: z.string().trim().min(1, '标题没填').max(40, '标题最多 40 个字'),
  templateId: z.number().int().positive(),
});
const BatchParam = z.object({ id: z.coerce.number().int().positive('编号不正确') });
const SlipParam = BatchParam.extend({ staffId: z.coerce.number().int().positive('编号不正确') });
const FileParam = BatchParam.extend({ fileId: z.coerce.number().int().positive('编号不正确') });
const SlipInput = z.object({ values: z.record(z.string(), z.union([z.number(), z.string(), z.null()])) });
/** 补人：只新增；已经在表里（别人刚补进来、填过）的原样不动（Codex 审查 a1bf658） */
const AddInput = z.object({}).strict();
// 只收 Excel（需求文档：上传 Excel）：原件按上传的字节原样加密存档（CSV 在页面上已经按 GBK / UTF-8 解成文字，存不回原件，Codex 审查 3b5a8bf）
const FileInput = z.object({
  fileName: z
    .string()
    .trim()
    .min(1, '缺少文件名')
    .max(200)
    .regex(/\.xlsx$/i, '工资表只收 Excel（.xlsx）文件'),
  xlsxBase64: z.string('工资表只收 Excel（.xlsx）文件').min(1).max(4_000_000),
});

interface BatchRow {
  id: number;
  month: string;
  title: string;
  templateId: number;
  templateName: string;
  fields: PayslipField[];
  status: PayrollBatchStatus;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
  slipCount: number;
  filledCount: number;
  signedCount: number;
  storeIds: number[] | null;
  publishedAt: Date | null;
  remindedAt: Date | null;
}

async function batchRows(db: Db, where: { id?: number; includeVoid?: boolean }): Promise<BatchRow[]> {
  const rows = await db<BatchRow[]>`
    SELECT b.id, b.month, b.title, b.template_id, t.name AS template_name, b.fields, b.status, s.display_name AS created_by_name, b.created_at, b.updated_at, b.store_ids, b.published_at, b.reminded_at,
           (SELECT count(*)::int FROM oa_payslips p WHERE p.batch_id = b.id AND p.signed_at IS NOT NULL) AS signed_count,
           (SELECT count(*)::int FROM oa_payslips p WHERE p.batch_id = b.id) AS slip_count,
           (SELECT count(*)::int FROM oa_payslips p WHERE p.batch_id = b.id AND p.values <> '{}'::jsonb) AS filled_count
    FROM oa_payroll_batches b JOIN oa_payslip_templates t ON t.id = b.template_id JOIN staff s ON s.id = b.created_by
    WHERE ${where.id ? db`b.id = ${where.id}` : where.includeVoid ? db`true` : db`b.status <> 'void'`}
    ORDER BY b.month DESC, b.id DESC`;
  return rows.map((r) => ({ ...r, id: Number(r.id), templateId: Number(r.templateId), storeIds: r.storeIds === null ? null : r.storeIds.map(Number) }));
}

const summaryOf = (r: BatchRow): PayrollBatchSummary => ({
  id: r.id,
  month: r.month,
  title: r.title,
  templateId: r.templateId,
  templateName: r.templateName,
  status: r.status,
  slipCount: r.slipCount,
  filledCount: r.filledCount,
  signedCount: r.signedCount,
  publishedAt: r.publishedAt ? iso(r.publishedAt) : null,
  remindedAt: r.remindedAt ? iso(r.remindedAt) : null,
  createdByName: r.createdByName,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

/** 取一张工资表；我的门店范围包不住它的就当没有（不透露别的门店有哪些工资表） */
async function loadBatch(db: Db, id: number, mine: Scope): Promise<BatchRow> {
  const [b] = await batchRows(db, { id });
  if (!b || !covers(mine, b.storeIds)) throw notFound('工资表不存在');
  return b;
}

async function loadDetail(db: Db, id: number, key: PayrollKey | null, mine: Scope): Promise<PayrollBatchDetail> {
  const b = await loadBatch(db, id, mine);
  const staff = await staffFor(db, b.month, batchScope(b.storeIds));
  const slips = await db<{ staffId: number; values: PayslipValues; updatedAt: Date; signedAt: Date | null; viewedAt: Date | null }[]>`
    SELECT staff_id, values, updated_at, signed_at, viewed_at FROM oa_payslips WHERE batch_id = ${id}`;
  const inBatch = new Set(slips.map((s) => Number(s.staffId)));
  const rows: PayslipRow[] = slips
    .map((s) => {
      const e = staff.get(Number(s.staffId))!;
      return {
        ...person(e),
        values: s.values,
        updatedAt: iso(s.updatedAt),
        offRoster: e.offRoster,
        signedAt: s.signedAt ? iso(s.signedAt) : null,
        viewedAt: s.viewedAt ? iso(s.viewedAt) : null,
      };
    })
    .sort(byDept);
  const missing = [...staff.values()]
    .filter((e) => !e.offRoster && !inBatch.has(e.staffId))
    .map(person)
    .sort(byDept);
  const files = await db<{ id: number; fileName: string; size: number; rowCount: number; keyId: string; uploadedByName: string; uploadedAt: Date }[]>`
    SELECT f.id, f.file_name, f.size, f.row_count, f.key_id, s.display_name AS uploaded_by_name, f.uploaded_at
    FROM oa_payroll_files f JOIN staff s ON s.id = f.uploaded_by WHERE f.batch_id = ${id} ORDER BY f.id DESC`;
  return {
    ...summaryOf(b),
    fields: b.fields,
    slips: rows,
    missing,
    files: files.map(
      (f): PayrollFileInfo => ({
        id: Number(f.id),
        fileName: f.fileName,
        size: f.size,
        rowCount: f.rowCount,
        uploadedByName: f.uploadedByName,
        uploadedAt: iso(f.uploadedAt),
        readable: !!key && key.id === f.keyId,
      }),
    ),
    canUpload: !!key,
  };
}

/** 锁住工资表（草稿才能改）：工资表行 FOR UPDATE */
async function lockDraft(tx: Tx, id: number, mine: Scope): Promise<{ month: string; fields: PayslipField[]; scope: Scope }> {
  const [b] = await tx<{ month: string; fields: PayslipField[]; status: PayrollBatchStatus; storeIds: number[] | null }[]>`
    SELECT month, fields, status, store_ids FROM oa_payroll_batches WHERE id = ${id} FOR UPDATE`;
  if (!b || !covers(mine, b.storeIds)) throw notFound('工资表不存在');
  if (b.status === 'void') throw conflict('PAYROLL_VOID', '这张工资表已经作废了');
  if (b.status !== 'draft') throw conflict('PAYROLL_PUBLISHED', '这张工资表已经发放，不能再改');
  return { month: b.month, fields: b.fields, scope: batchScope(b.storeIds) };
}

async function touch(tx: Tx, id: number, actorId: number) {
  await tx`UPDATE oa_payroll_batches SET updated_at = now(), updated_by = ${actorId} WHERE id = ${id}`;
}

// ───────────────────────── 表格（下载、导入） ─────────────────────────

/** 下载的表格：第 1 行标题，第 2 行表头（工号、姓名、部门 + 模板各列），之后每人一行；已经填过的带上 */
function sheetOf(d: PayrollBatchDetail): Buffer {
  const header = [...PAYROLL_ID_COLUMNS, ...d.fields.map((f) => f.label)];
  const people = [...d.slips, ...d.missing.map((p) => ({ ...p, values: {} as PayslipValues }))];
  const cell = (f: PayslipField, v: PayslipValues[string] | undefined) => {
    if (v === null || v === undefined) return null;
    if (f.kind === 'money' && typeof v === 'number') return v / 100;
    return v;
  };
  const main: WbSheet = {
    name: '工资表',
    active: true,
    widths: header.map((h, i) => (i === 1 ? 10 : i === 2 ? 12 : Math.max(10, h.length * 2 + 2))),
    freezeRows: 2,
    merges: [`A1:${colName(header.length - 1)}1`],
    rows: [
      { height: 32, cells: [{ v: `${monthLabel(d.month)} · ${d.title}`, style: 'title' }] },
      { height: 24, cells: header.map((h, i) => ({ v: h, style: i < 2 ? ('required' as const) : ('optional' as const) })) },
      ...people.map((p) => ({ cells: [p.empNo ?? '', p.name, p.departmentName, ...d.fields.map((f) => cell(f, p.values[f.key]))] })),
    ],
  };
  const guide: WbSheet = {
    name: '填写说明',
    widths: [80],
    rows: [
      { height: 26, cells: [{ v: '工资表 · 填写说明', style: 'title' }] },
      { cells: [{ v: '第 1 行标题、第 2 行表头不要改；从第 3 行起一行一位员工。', style: 'note' }] },
      { cells: [{ v: '按工号对人：工号空着的按姓名对（有重名的要写工号）。部门一列只是方便核对，不按它对人。', style: 'note' }] },
      { cells: [{ v: '金额写元，最多两位小数；扣款写正数还是负数照贵司习惯，系统不算加减，应发、实发按表里写的。', style: 'note' }] },
      { cells: [{ v: '上传：后台「工资条 → 工资表」打开这张表 →「上传 Excel」→ 预览没有问题再「导入」；导入会整张替换表里现有的工资条。', style: 'note' }] },
    ],
  };
  return buildWorkbook([main, guide]);
}

const isHeader = (cells: string[]) => cells.includes('姓名') && cells.includes('工号');
const PAYROLL_XLSX_LIMITS = {
  // 解压后 12 MiB：2000 行 × 40 多列的正常工资表也就几 MB
  maxTotal: 12 * 1024 * 1024,
  maxCells: (PAYROLL_MAX_ROWS + 20) * (PAYSLIP_MAX_FIELDS + 20),
  // 坐标也限住：读表按行号、列号铺成数组，稀疏的大坐标会把内存撑爆（Codex 审查 6190bd4）
  maxRow: PAYROLL_MAX_ROWS + 20,
  maxCols: PAYSLIP_MAX_FIELDS + 20,
  // 解析前先数结构（元素 + 属性），空行、无关属性都算（Codex 安全审查 503f199、f6c14e7）；只读第一张表。
  // 30 万：2000 行 × 60 列、带 WPS 常见行属性的正常工资表约 19 万（复核 139c8f5：80 万时最坏情况一次要阻塞约 1.8 秒）
  maxNodes: 300_000,
  maxSheets: 1,
};

/**
 * 读上传的工资表。有公式却没存计算结果的单元格整份拒绝（Codex 审查 940087b）：读出来会是空的，整张替换时就把原来的金额清掉了；
 * 请先在 Excel 里重新计算、保存（Excel、WPS 保存时都会存结果）
 */
function readPayrollSheet(f: { xlsxBase64: string }): Sheet {
  // 只解析一次，在同一份解析结果里查公式；工资表用更紧的上限（解压后 32 MiB、表头加 2000 行 × 60 列以内），
  // 不让一份异常文件把整个服务的内存撑爆（Codex 安全审查 a205c7f）
  return readSheet(f, {
    findHeader: isHeader,
    xlsxLimits: PAYROLL_XLSX_LIMITS,
    onWorkbook: (book) => {
      for (const line of book.sheets[0]?.rows.values() ?? [])
        for (const c of line.values())
          // 没有存结果时读出来是 null；算出空字符串（t="str" 配 <v></v>）是存了结果的，照常读（Codex 审查 2601251）
          if (c.formula !== null && c.value === null)
            throw unprocessable('IMPORT_FILE_INVALID', `${colName(c.col)}${c.row} 是公式、文件里没有算好的结果：请在 Excel 里重新计算（或打开后直接保存）再上传`);
    },
  });
}

interface ImportPlan extends PayrollImportPreview {
  sha256: string;
  /** 没有问题的行：人 → 值 */
  good: { staffId: number; values: PayslipValues }[];
}

function planImport(sheet: Sheet, fileName: string, fields: PayslipField[], staff: Map<number, RosterEntry>): ImportPlan {
  const col = (name: string) => sheet.header.indexOf(name);
  const missingCols = ['姓名', ...fields.map((f) => f.label)].filter((c) => col(c) < 0);
  if (missingCols.length) throw unprocessable('IMPORT_FILE_INVALID', `表头里没有「${missingCols.join('」「')}」：请用这张工资表「下载表格」得到的表`);
  const data = sheet.rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (data.length === 0) throw unprocessable('IMPORT_EMPTY', '表里没有工资条');
  if (data.length > PAYROLL_MAX_ROWS) throw unprocessable('IMPORT_TOO_LARGE', `一张工资表最多 ${PAYROLL_MAX_ROWS} 行，这份有 ${data.length} 行`);
  const cell = (cells: string[], name: string) => (col(name) < 0 ? '' : (cells[col(name)] ?? '').trim());
  // 专用账号、范围外的员工不参与对人（不按工号、姓名透露别的门店有谁）
  const everyone = [...staff.values()].filter((e) => e.offRoster !== NOT_EMPLOYEE && e.offRoster !== OUT_OF_SCOPE);
  // 工号按原样对；对不上再不分大小写对，但只认唯一的一位（工号区分大小写，E001 与 e001 可以是两个人，Codex 审查 3b5a8bf）
  const byEmpNo = new Map(everyone.filter((e) => e.empNo).map((e) => [e.empNo!, e]));
  const byEmpNoFolded = (no: string) => everyone.filter((e) => e.empNo?.toLowerCase() === no.toLowerCase());
  const seen = new Map<number, number>();
  const good: ImportPlan['good'] = [];
  const rows: PayrollImportRow[] = data.map((r) => {
    const issues: string[] = [];
    const name = cell(r.cells, '姓名');
    const empNo = cell(r.cells, '工号') || null;
    let who: RosterEntry | null = null;
    if (empNo) {
      who = byEmpNo.get(empNo) ?? null;
      if (!who) {
        const folded = byEmpNoFolded(empNo);
        if (folded.length === 1) who = folded[0]!;
        else if (folded.length > 1) issues.push(`工号「${empNo}」大小写对不上，有 ${folded.length} 位员工的工号只差大小写，请照档案写`);
        else issues.push(`工号「${empNo}」对不上员工`);
      }
      // 原样对上、不分大小写对上的都核对姓名（Codex 审查 a1bf658）
      if (who && name && name !== who.name) issues.push(`工号「${empNo}」是「${who.name}」，姓名写的是「${name}」`);
    } else if (!name) issues.push('工号、姓名都没填');
    else {
      const same = everyone.filter((e) => e.name === name);
      const onRoster = same.filter((e) => !e.offRoster);
      const pick = onRoster.length ? onRoster : same;
      if (pick.length === 0) issues.push(`没有叫「${name}」的员工`);
      else if (pick.length > 1) issues.push(`有 ${pick.length} 位叫「${name}」的，请写工号`);
      else who = pick[0]!;
    }
    if (who?.offRoster) issues.push(`${who.name}不在这个月的在职名单里（${who.offRoster}）`);
    if (who && seen.has(who.staffId)) issues.push(`与第 ${seen.get(who.staffId)} 行是同一个人`);
    if (who && !seen.has(who.staffId)) seen.set(who.staffId, r.row);
    const raw = Object.fromEntries(fields.map((f) => [f.key, cell(r.cells, f.label)]));
    const { values, issues: valueIssues } = normalizeValues(fields, raw);
    issues.push(...valueIssues);
    if (who && issues.length === 0) good.push({ staffId: who.staffId, values });
    return { row: r.row, staffId: who?.staffId ?? null, name: who?.name ?? name, empNo: who?.empNo ?? empNo, issues };
  });
  const listed = new Set(rows.map((r) => r.staffId).filter((x): x is number => x !== null));
  const missing = everyone
    .filter((e) => !e.offRoster && !listed.has(e.staffId))
    .map(person)
    .sort(byDept);
  const errorCount = rows.filter((r) => r.issues.length).length;
  return { fileName, rows, okCount: rows.length - errorCount, errorCount, missing, sha256: sheet.sha256, good };
}

// ───────────────────────── 路由 ─────────────────────────

export function registerOaPayrollRoutes(app: FastifyInstance, { sql, config }: Deps) {
  const canManage = canManagePayroll(sql);
  const key = payrollKeyOf(config);

  // 模板
  app.get('/api/oa/payroll/templates', { preHandler: canManage }, async () => listTemplates(sql));

  app.post('/api/oa/payroll/templates', { preHandler: canManage }, async (req, reply) => {
    const input = parse(TemplateInput, req.body);
    const fields = assignKeys(input.fields);
    const id = await sql
      .begin(async (tx) => {
        // 原样重提：在用的同名模板、字段一样的直接算成功
        const [same] = await tx<{ id: number; fields: PayslipField[] }[]>`SELECT id, fields FROM oa_payslip_templates WHERE name = ${input.name} AND active FOR UPDATE`;
        if (same && sameFields(same.fields, fields)) return Number(same.id);
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO oa_payslip_templates (name, fields, created_by, updated_by) VALUES (${input.name}, ${tx.json(fields as never)}, ${req.actor.id}, ${req.actor.id}) RETURNING id`;
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'oa_payslip_template_saved',
          targetType: 'oa_payslip_template',
          targetId: row!.id,
          detail: { name: input.name, fieldCount: fields.length, created: true },
          ip: req.ip,
        });
        reply.code(201);
        return Number(row!.id);
      })
      .catch(translateTemplateUnique);
    return (await listTemplates(sql)).find((t) => t.id === id)!;
  });

  app.put('/api/oa/payroll/templates/:id', { preHandler: canManage }, async (req) => {
    const { id } = parse(BatchParam, req.params);
    const input = parse(TemplateUpdate, req.body);
    await sql
      .begin(async (tx) => {
        const [cur] = await tx<{ name: string; fields: PayslipField[]; active: boolean; version: number }[]>`
          SELECT name, fields, active, version FROM oa_payslip_templates WHERE id = ${id} FOR UPDATE`;
        if (!cur) throw notFound('模板不存在');
        // 原样重提（之前那次已经改好）：现状就是要改成的样子，算成功。新加的字段请求里没有编号，按名称、类型、实发对（Codex 审查 3b5a8bf）
        if (cur.name === input.name && cur.active === input.active && sameShape(input.fields, cur.fields)) return;
        const fields = assignKeys(input.fields, cur.fields);
        if (cur.version !== input.version) throw conflict('VERSION_CONFLICT', '这个模板刚被别人改过，请刷新后再改');
        await tx`
          UPDATE oa_payslip_templates SET name = ${input.name}, fields = ${tx.json(fields as never)}, active = ${input.active},
                 version = version + 1, updated_by = ${req.actor.id}, updated_at = now()
          WHERE id = ${id}`;
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'oa_payslip_template_saved',
          targetType: 'oa_payslip_template',
          targetId: id,
          detail: { name: input.name, fieldCount: fields.length, active: input.active },
          ip: req.ip,
        });
      })
      .catch(translateTemplateUnique);
    return (await listTemplates(sql)).find((t) => t.id === id)!;
  });

  // 工资表
  app.get('/api/oa/payroll/batches', { preHandler: canManage }, async (req) => {
    const mine = await scopeOf(sql, req.actor);
    return (await batchRows(sql, {})).filter((b) => covers(mine, b.storeIds)).map(summaryOf);
  });

  app.post('/api/oa/payroll/batches', { preHandler: canManage }, async (req, reply) => {
    const input = parse(BatchInput, req.body);
    const mine = await scopeOf(sql, req.actor);
    const storeIds = mine.all ? null : mine.stores;
    if (storeIds && storeIds.length === 0) throw forbidden('你没有挂任何门店，不能建工资表');
    const id = await sql.begin(async (tx) => {
      const [t] = await tx<{ fields: PayslipField[]; active: boolean }[]>`SELECT fields, active FROM oa_payslip_templates WHERE id = ${input.templateId} FOR SHARE`;
      if (!t) throw notFound('模板不存在');
      // 同月同标题的新建串行（两个人同时建时后到的读得到先建好的那张，不撞唯一索引，Codex 审查 3b5a8bf）
      // 同月同标题、同一个门店范围的才算同一张（不同门店的 HR 各建各的）
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`oa_payroll_batch:${input.month}:${input.title}:${storeIds?.join(',') ?? '*'}`}))`;
      // 同月同标题已经有（没作废的）：用的是同一个模板就直接打开那张（原样重提、两个人同时建），否则说明
      const [existing] = await tx<{ id: number; templateId: number }[]>`
        SELECT id, template_id FROM oa_payroll_batches
        WHERE month = ${input.month} AND title = ${input.title} AND status <> 'void' AND store_ids IS NOT DISTINCT FROM ${storeIds}::bigint[]`;
      if (existing) {
        if (Number(existing.templateId) !== input.templateId) throw conflict('PAYROLL_TITLE_EXISTS', `${monthLabel(input.month)}已经有一张「${input.title}」（用的是别的模板），换个标题`);
        return Number(existing.id);
      }
      if (!t.active) throw conflict('TEMPLATE_INACTIVE', '这个模板已经停用');
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO oa_payroll_batches (month, title, template_id, fields, store_ids, created_by, updated_by)
        VALUES (${input.month}, ${input.title}, ${input.templateId}, ${tx.json(t.fields as never)}, ${storeIds}::bigint[], ${req.actor.id}, ${req.actor.id}) RETURNING id`;
      const batchId = Number(row!.id);
      const roster = [...(await staffFor(tx, input.month, mine)).values()].filter((e) => !e.offRoster).map((e) => e.staffId);
      if (roster.length) await tx`INSERT INTO oa_payslips (batch_id, staff_id, updated_by) SELECT ${batchId}, unnest(${roster}::bigint[]), ${req.actor.id}`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_payroll_batch_created',
        targetType: 'oa_payroll_batch',
        targetId: batchId,
        detail: { month: input.month, title: input.title, slipCount: roster.length },
        ip: req.ip,
      });
      reply.code(201);
      return batchId;
    });
    return summaryOf(await loadBatch(sql, id, mine));
  });

  app.get('/api/oa/payroll/batches/:id', { preHandler: canManage }, async (req) => {
    const { id } = parse(BatchParam, req.params);
    const detail = await loadDetail(sql, id, key, await scopeOf(sql, req.actor));
    await payrollAudit(sql, { staffId: req.actor.id, action: 'view_batch', batchId: id, ip: req.ip });
    return detail;
  });

  // 在线编辑一行：按结果写（原样重提结果一样）；不在表里的人要在这个月的在职名单里才能补进来
  app.put('/api/oa/payroll/batches/:id/slips/:staffId', { preHandler: canManage }, async (req) => {
    const { id, staffId } = parse(SlipParam, req.params);
    const body = parse(SlipInput, req.body);
    await sql.begin(async (tx) => {
      const b = await lockDraft(tx, id, await scopeOf(tx, req.actor));
      const { values, issues } = normalizeValues(b.fields, body.values);
      if (issues.length) throw unprocessable('PAYSLIP_INVALID', issues.join('；'));
      const [cur] = await tx<{ values: PayslipValues }[]>`SELECT values FROM oa_payslips WHERE batch_id = ${id} AND staff_id = ${staffId} FOR UPDATE`;
      if (!cur) {
        const e = (await staffFor(tx, b.month, b.scope)).get(staffId);
        if (!e) throw notFound('员工不存在');
        if (e.offRoster) throw unprocessable('NOT_ON_ROSTER', `${e.name}不在这个月的在职名单里（${e.offRoster}）`);
        await tx`INSERT INTO oa_payslips (batch_id, staff_id, values, updated_by) VALUES (${id}, ${staffId}, ${tx.json(values as never)}, ${req.actor.id})`;
      } else if (canonical(cur.values) !== canonical(values)) {
        // 调出这张表门店范围的人那一行不能再改，只能移出（OA-17 复核留下的一处）
        const e = (await staffFor(tx, b.month, b.scope)).get(staffId);
        if (e?.offRoster === OUT_OF_SCOPE) throw unprocessable('NOT_ON_ROSTER', `${e.name}已经不在这张表的门店范围里，只能移出`);
        await tx`UPDATE oa_payslips SET values = ${tx.json(values as never)}, updated_by = ${req.actor.id}, updated_at = now() WHERE batch_id = ${id} AND staff_id = ${staffId}`;
      } else return;
      await touch(tx, id, req.actor.id);
      await writeAudit(tx, { staffId: req.actor.id, action: 'oa_payroll_edited', targetType: 'oa_payroll_batch', targetId: id, detail: { staffId, added: !cur }, ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/api/oa/payroll/batches/:id/slips/:staffId/add', { preHandler: canManage }, async (req) => {
    const { id, staffId } = parse(SlipParam, req.params);
    parse(AddInput, req.body ?? {});
    await sql.begin(async (tx) => {
      const b = await lockDraft(tx, id, await scopeOf(tx, req.actor));
      const [cur] = await tx`SELECT 1 FROM oa_payslips WHERE batch_id = ${id} AND staff_id = ${staffId}`;
      if (cur) return;
      const e = (await staffFor(tx, b.month, b.scope)).get(staffId);
      if (!e) throw notFound('员工不存在');
      if (e.offRoster) throw unprocessable('NOT_ON_ROSTER', `${e.name}不在这个月的在职名单里（${e.offRoster}）`);
      await tx`INSERT INTO oa_payslips (batch_id, staff_id, updated_by) VALUES (${id}, ${staffId}, ${req.actor.id})`;
      await touch(tx, id, req.actor.id);
      await writeAudit(tx, { staffId: req.actor.id, action: 'oa_payroll_edited', targetType: 'oa_payroll_batch', targetId: id, detail: { staffId, added: true }, ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/api/oa/payroll/batches/:id/slips/:staffId/remove', { preHandler: canManage }, async (req) => {
    const { id, staffId } = parse(SlipParam, req.params);
    await sql.begin(async (tx) => {
      await lockDraft(tx, id, await scopeOf(tx, req.actor));
      const gone = await tx`DELETE FROM oa_payslips WHERE batch_id = ${id} AND staff_id = ${staffId} RETURNING id`;
      if (gone.length === 0) return;
      await touch(tx, id, req.actor.id);
      await writeAudit(tx, { staffId: req.actor.id, action: 'oa_payroll_edited', targetType: 'oa_payroll_batch', targetId: id, detail: { staffId, removed: true }, ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/api/oa/payroll/batches/:id/void', { preHandler: canManage }, async (req) => {
    const { id } = parse(BatchParam, req.params);
    await sql.begin(async (tx) => {
      const [b] = await tx<{ status: PayrollBatchStatus; storeIds: number[] | null }[]>`SELECT status, store_ids FROM oa_payroll_batches WHERE id = ${id} FOR UPDATE`;
      if (!b || !covers(await scopeOf(tx, req.actor), b.storeIds)) throw notFound('工资表不存在');
      if (b.status === 'void') return;
      if (b.status !== 'draft') throw conflict('PAYROLL_PUBLISHED', '已经发放的工资表不能作废');
      await tx`UPDATE oa_payroll_batches SET status = 'void', voided_by = ${req.actor.id}, voided_at = now(), updated_at = now(), updated_by = ${req.actor.id} WHERE id = ${id}`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'oa_payroll_batch_voided', targetType: 'oa_payroll_batch', targetId: id, ip: req.ip });
    });
    return { ok: true };
  });

  // 下载表格（带上已经填的金额：等于导出，记审计）
  app.get('/api/oa/payroll/batches/:id/sheet.xlsx', { preHandler: canManage }, async (req, reply) => {
    const { id } = parse(BatchParam, req.params);
    const d = await loadDetail(sql, id, key, await scopeOf(sql, req.actor));
    await payrollAudit(sql, { staffId: req.actor.id, action: 'export_sheet', batchId: id, ip: req.ip });
    attachment(reply, `工资表-${d.month}-${d.title}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return reply.send(sheetOf(d));
  });

  // 导入：预览（不改库）→ 导入（锁住工资表、在锁里再核对一遍，整张替换，原件加密存进库）
  const bodyLimit = 5_000_000;
  app.post('/api/oa/payroll/batches/:id/import/preview', { preHandler: canManage, bodyLimit }, async (req): Promise<PayrollImportPreview> => {
    const { id } = parse(BatchParam, req.params);
    const f = parse(FileInput, req.body);
    const b = await loadBatch(sql, id, await scopeOf(sql, req.actor));
    const sheet = readPayrollSheet(f);
    const { sha256: _s, good: _g, ...preview } = planImport(sheet, f.fileName, b.fields, await staffFor(sql, b.month, batchScope(b.storeIds)));
    return preview;
  });

  app.post('/api/oa/payroll/batches/:id/import', { preHandler: canManage, bodyLimit }, async (req): Promise<PayrollImportResult> => {
    const { id } = parse(BatchParam, req.params);
    const f = parse(FileInput, req.body);
    if (!key) throw unprocessable('PAYROLL_KEY_MISSING', '服务器还没配工资表原件的加密密钥（PAYROLL_FILE_KEY），不能上传 Excel；请先在线编辑，或请管理员配好再传');
    const sheet = readPayrollSheet(f);
    const original = Buffer.from(f.xlsxBase64, 'base64');
    const sealed = encryptFile(key, original);
    const mine = await scopeOf(sql, req.actor);
    return sql.begin(async (tx) => {
      const b = await lockDraft(tx, id, mine);
      const p = planImport(sheet, f.fileName, b.fields, await staffFor(tx, b.month, b.scope));
      if (p.errorCount) throw unprocessable('IMPORT_HAS_ERRORS', `有 ${p.errorCount} 行不对，整份没有导入：请先预览、改好再传`);
      // 同一份文件原样重提：工资条照样整张替换（结果一样），原件不重复存
      // 摘要、密钥都一样才复用（换过密钥以后重传同一份，要用新密钥另存一份，原件才下载得了，Codex 审查 940087b）
      const [last] = await tx<{ id: number; sha256: string; keyId: string }[]>`SELECT id, sha256, key_id FROM oa_payroll_files WHERE batch_id = ${id} ORDER BY id DESC LIMIT 1`;
      let fileId = last && last.sha256 === p.sha256 && last.keyId === sealed.keyId ? Number(last.id) : 0;
      if (!fileId) {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO oa_payroll_files (batch_id, file_name, size, sha256, iv, tag, ciphertext, key_id, row_count, uploaded_by)
          VALUES (${id}, ${f.fileName}, ${original.length}, ${p.sha256}, ${sealed.iv}, ${sealed.tag}, ${sealed.ciphertext}, ${sealed.keyId}, ${p.good.length}, ${req.actor.id})
          RETURNING id`;
        fileId = Number(row!.id);
      }
      await tx`DELETE FROM oa_payslips WHERE batch_id = ${id}`;
      for (let i = 0; i < p.good.length; i += 500) {
        const part = p.good.slice(i, i + 500);
        await tx`
          INSERT INTO oa_payslips (batch_id, staff_id, values, updated_by)
          SELECT ${id}, x.staff_id, x.values, ${req.actor.id}
          FROM jsonb_to_recordset(${tx.json(part.map((g) => ({ staff_id: g.staffId, values: g.values })) as never)}) AS x(staff_id bigint, values jsonb)`;
      }
      await touch(tx, id, req.actor.id);
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_payroll_imported',
        targetType: 'oa_payroll_batch',
        targetId: id,
        detail: { fileName: f.fileName, slipCount: p.good.length, fileId },
        ip: req.ip,
      });
      return { batchId: id, slipCount: p.good.length, fileId };
    });
  });

  // 下载原件：解密后原样给（只有 payroll.manage）；换过密钥的解不开时明说
  app.get('/api/oa/payroll/batches/:id/files/:fileId', { preHandler: canManage }, async (req, reply) => {
    const { id, fileId } = parse(FileParam, req.params);
    await loadBatch(sql, id, await scopeOf(sql, req.actor));
    const [f] = await sql<{ fileName: string; iv: Buffer; tag: Buffer; ciphertext: Buffer; keyId: string }[]>`
      SELECT file_name, iv, tag, ciphertext, key_id FROM oa_payroll_files WHERE id = ${fileId} AND batch_id = ${id}`;
    if (!f) throw notFound('原件不存在');
    if (!key || key.id !== f.keyId) throw conflict('PAYROLL_KEY_CHANGED', '这份原件是用之前的密钥加密的，现在的密钥解不开（工资条本身不受影响）');
    let data: Buffer;
    try {
      data = decryptFile(key, f);
    } catch {
      throw conflict('PAYROLL_FILE_BROKEN', '原件解不开（可能被改动过）');
    }
    await payrollAudit(sql, { staffId: req.actor.id, action: 'download_file', batchId: id, fileId, ip: req.ip });
    attachment(reply, f.fileName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return reply.send(data);
  });

  // ───────────── OA-18 发放、提醒、薪资审计 ─────────────

  // 发放：草稿 → 已发放（之后不能改、不能作废）。按结果写：已经发放的再点一次直接算成功、不重复通知
  app.post('/api/oa/payroll/batches/:id/publish', { preHandler: canManage }, async (req) => {
    const { id } = parse(BatchParam, req.params);
    const mine = await scopeOf(sql, req.actor);
    await sql.begin(async (tx) => {
      const [b] = await tx<{ month: string; title: string; status: PayrollBatchStatus; storeIds: number[] | null }[]>`
        SELECT month, title, status, store_ids FROM oa_payroll_batches WHERE id = ${id} FOR UPDATE`;
      if (!b || !covers(mine, b.storeIds)) throw notFound('工资表不存在');
      if (b.status === 'published') return;
      if (b.status === 'void') throw conflict('PAYROLL_VOID', '这张工资表已经作废了');
      // 同月同标题的发放串行：门店范围重叠的两张同名表不会同时发出去
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`oa_payroll_publish:${b.month}:${b.title}`}))`;
      const slips = await tx<{ id: number; staffId: number; values: PayslipValues }[]>`SELECT id, staff_id, values FROM oa_payslips WHERE batch_id = ${id}`;
      if (slips.length === 0) throw unprocessable('PAYROLL_EMPTY', '表里还没有人，不能发放');
      const staff = await staffFor(tx, b.month, batchScope(b.storeIds));
      const off = slips.map((x) => staff.get(Number(x.staffId))).filter((e) => !e || e.offRoster);
      if (off.length) throw unprocessable('PAYROLL_OFF_ROSTER', `${off.map((e) => (e ? `${e.name}（${e.offRoster}）` : '已删除的账号')).join('、')}不在这张表的名单里，请先移出`);
      const blank = slips.filter((x) => Object.keys(x.values).length === 0).map((x) => staff.get(Number(x.staffId))?.name ?? '');
      if (blank.length) throw unprocessable('PAYROLL_BLANK', `${blank.slice(0, 10).join('、')}${blank.length > 10 ? ` 等 ${blank.length} 人` : ''}一项都没填，请填好或移出`);
      // 同一个人同一个月、同一个标题只能有一张已发放的
      const dup = await tx<{ name: string }[]>`
        SELECT DISTINCT s.display_name AS name FROM oa_payslips p
        JOIN oa_payroll_batches o ON o.id = p.batch_id AND o.id <> ${id} AND o.status = 'published' AND o.month = ${b.month} AND o.title = ${b.title}
        JOIN staff s ON s.id = p.staff_id
        WHERE p.staff_id IN (SELECT staff_id FROM oa_payslips WHERE batch_id = ${id})`;
      if (dup.length) throw conflict('PAYROLL_DUPLICATE', `${dup.map((d) => d.name).join('、')}${monthLabel(b.month)}已经发过一张「${b.title}」，同一个人不能重复发`);
      await tx`UPDATE oa_payroll_batches SET status = 'published', published_at = now(), published_by = ${req.actor.id}, updated_at = now(), updated_by = ${req.actor.id} WHERE id = ${id}`;
      for (const x of slips)
        await notify(tx, [Number(x.staffId)], {
          kind: 'payslip',
          title: '您有新的工资条，请查收',
          body: `${monthLabel(b.month)} · ${b.title}`,
          link: `/oa/payslips/${Number(x.id)}`,
          ref: { type: 'oa_payslip', id: Number(x.id) },
        });
      await payrollAudit(tx, { staffId: req.actor.id, action: 'publish', batchId: id, ip: req.ip });
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_payroll_published',
        targetType: 'oa_payroll_batch',
        targetId: id,
        detail: { month: b.month, title: b.title, slipCount: slips.length },
        ip: req.ip,
      });
    });
    return summaryOf(await loadBatch(sql, id, mine));
  });

  // 一键提醒：给已发放、还没签收的人再发一次通知（同一张表 10 分钟一次）
  app.post('/api/oa/payroll/batches/:id/remind', { preHandler: canManage }, async (req) => {
    const { id } = parse(BatchParam, req.params);
    const mine = await scopeOf(sql, req.actor);
    const count = await sql.begin(async (tx) => {
      const [b] = await tx<{ month: string; title: string; status: PayrollBatchStatus; storeIds: number[] | null; recent: boolean }[]>`
        SELECT month, title, status, store_ids, reminded_at > now() - make_interval(mins => ${PAYROLL_REMIND_MINUTES}) AS recent
        FROM oa_payroll_batches WHERE id = ${id} FOR UPDATE`;
      if (!b || !covers(mine, b.storeIds)) throw notFound('工资表不存在');
      if (b.status !== 'published') throw conflict('PAYROLL_NOT_PUBLISHED', '还没发放的工资表不用提醒');
      // 刚提醒过（含上一次回复没收到、原样重试）：按结果算成功，不再发一遍（OA22 按结果写）
      if (b.recent) return null;
      const unsigned = await tx<{ id: number; staffId: number }[]>`SELECT id, staff_id FROM oa_payslips WHERE batch_id = ${id} AND signed_at IS NULL`;
      for (const x of unsigned)
        await notify(tx, [Number(x.staffId)], {
          kind: 'payslip',
          title: '您的工资条还没签收',
          body: `${monthLabel(b.month)} · ${b.title}：请打开看一下，确认无误后签收`,
          link: `/oa/payslips/${Number(x.id)}`,
          ref: { type: 'oa_payslip', id: Number(x.id) },
        });
      await tx`UPDATE oa_payroll_batches SET reminded_at = now() WHERE id = ${id}`;
      await payrollAudit(tx, { staffId: req.actor.id, action: 'remind', batchId: id, ip: req.ip });
      await writeAudit(tx, { staffId: req.actor.id, action: 'oa_payroll_reminded', targetType: 'oa_payroll_batch', targetId: id, detail: { count: unsigned.length }, ip: req.ip });
      return unsigned.length;
    });
    return count === null ? { reminded: 0, recent: true } : { reminded: count, recent: false };
  });

  // 薪资审计：按时间倒序，可按工资表、动作筛；只列谁、做了什么、哪张表、哪个人、IP、时间（不带金额）。门店范围外的工资表的记录不给
  const AuditQuery = z.object({
    batchId: z.coerce.number().int().positive().optional(),
    action: z.enum(['view_batch', 'export_sheet', 'download_file', 'publish', 'remind', 'employee_view', 'employee_sign']).optional(),
    before: z.coerce.number().int().positive().optional(),
  });
  app.get('/api/oa/payroll/audit', { preHandler: canManage }, async (req): Promise<PayrollAuditPage> => {
    const q = parse(AuditQuery, req.query);
    const mine = await scopeOf(sql, req.actor);
    const PAGE = 50;
    const scopeCond = mine.all ? sql`true` : sql`b.store_ids IS NOT NULL AND b.store_ids <@ ${mine.stores}::bigint[]`;
    const rows = await sql<
      {
        id: number;
        createdAt: Date;
        action: PayrollAuditAction;
        actorName: string | null;
        batchId: number | null;
        month: string | null;
        title: string | null;
        targetName: string | null;
        ip: string | null;
      }[]
    >`
      SELECT a.id, a.created_at, a.action, s.display_name AS actor_name, a.batch_id, b.month, b.title, t.display_name AS target_name, a.ip
      FROM oa_payroll_audit a
      JOIN oa_payroll_batches b ON b.id = a.batch_id
      LEFT JOIN staff s ON s.id = a.staff_id
      LEFT JOIN staff t ON t.id = a.target_id
      WHERE ${scopeCond}
        ${q.batchId ? sql`AND a.batch_id = ${q.batchId}` : sql``}
        ${q.action ? sql`AND a.action = ${q.action}` : sql``}
        ${q.before ? sql`AND a.id < ${q.before}` : sql``}
      ORDER BY a.id DESC LIMIT ${PAGE + 1}`;
    const items = rows.slice(0, PAGE).map(
      (r): PayrollAuditItem => ({
        id: Number(r.id),
        at: iso(r.createdAt),
        action: r.action,
        actorName: r.actorName,
        batchId: r.batchId === null ? null : Number(r.batchId),
        batchLabel: r.month && r.title ? `${monthLabel(r.month)} · ${r.title}` : null,
        targetName: r.targetName,
        ip: r.ip,
      }),
    );
    return { items, next: rows.length > PAGE ? items[items.length - 1]!.id : null };
  });

  // ───────────── OA-18 员工端：本人的工资条 ─────────────
  // 一律按「登录的人 = 工资条的人」、已发放的取；别人的、没发放的编号一律当没有（防越权）
  const mineOnly = employeeOnly(sql);
  const SlipIdParam = z.object({ id: z.coerce.number().int().positive('编号不正确') });
  const netOf = (fields: PayslipField[], values: PayslipValues) => {
    const f = netField(fields);
    const v = f ? values[f.key] : null;
    return typeof v === 'number' ? v : null;
  };

  app.get('/api/oa/my/payslips', { preHandler: mineOnly }, async (req): Promise<MyPayslipItem[]> => {
    // 列表不带金额（金额只在明细里给，明细每次都记审计）
    const rows = await sql<{ id: number; month: string; title: string; publishedAt: Date; signedAt: Date | null }[]>`
      SELECT p.id, b.month, b.title, b.published_at, p.signed_at
      FROM oa_payslips p JOIN oa_payroll_batches b ON b.id = p.batch_id
      WHERE p.staff_id = ${req.actor.id} AND b.status = 'published'
      ORDER BY b.month DESC, b.published_at DESC, p.id DESC`;
    return rows.map((r) => ({ id: Number(r.id), month: r.month, title: r.title, publishedAt: iso(r.publishedAt), signedAt: r.signedAt ? iso(r.signedAt) : null }));
  });

  async function mySlip(db: Db, id: number, staffId: number, lock = false) {
    const [r] = await db<
      { id: number; batchId: number; month: string; title: string; fields: PayslipField[]; values: PayslipValues; publishedAt: Date; signedAt: Date | null; viewedAt: Date | null; name: string }[]
    >`
      SELECT p.id, p.batch_id, b.month, b.title, b.fields, p.values, b.published_at, p.signed_at, p.viewed_at, s.display_name AS name
      FROM oa_payslips p JOIN oa_payroll_batches b ON b.id = p.batch_id JOIN staff s ON s.id = p.staff_id
      WHERE p.id = ${id} AND p.staff_id = ${staffId} AND b.status = 'published'
      ${lock ? db`FOR UPDATE OF p` : db``}`;
    if (!r) throw notFound('工资条不存在');
    return r;
  }
  const detailOf = (r: Awaited<ReturnType<typeof mySlip>>): MyPayslipDetail => ({
    id: Number(r.id),
    month: r.month,
    title: r.title,
    net: netOf(r.fields, r.values),
    publishedAt: iso(r.publishedAt),
    signedAt: r.signedAt ? iso(r.signedAt) : null,
    name: r.name,
    fields: r.fields,
    values: r.values,
  });

  app.get('/api/oa/my/payslips/:id', { preHandler: mineOnly }, async (req): Promise<MyPayslipDetail> => {
    const { id } = parse(SlipIdParam, req.params);
    const r = await sql.begin(async (tx) => {
      const slip = await mySlip(tx, id, req.actor.id);
      if (!slip.viewedAt) await tx`UPDATE oa_payslips SET viewed_at = now() WHERE id = ${id} AND viewed_at IS NULL`;
      await payrollAudit(tx, { staffId: req.actor.id, action: 'employee_view', batchId: Number(slip.batchId), targetId: req.actor.id, ip: req.ip });
      return slip;
    });
    return detailOf(r);
  });

  // 确认签收：记签收时间（签过的再点不变）
  app.post('/api/oa/my/payslips/:id/sign', { preHandler: mineOnly }, async (req): Promise<MyPayslipDetail> => {
    const { id } = parse(SlipIdParam, req.params);
    const r = await sql.begin(async (tx) => {
      const slip = await mySlip(tx, id, req.actor.id, true);
      // 签过的再点：签收时间不变、不再记签收；回给的明细照样记一次查看（不能绕过查看审计取金额）
      if (slip.signedAt) {
        await payrollAudit(tx, { staffId: req.actor.id, action: 'employee_view', batchId: Number(slip.batchId), targetId: req.actor.id, ip: req.ip });
        return slip;
      }
      const [row] = await tx<{ signedAt: Date }[]>`UPDATE oa_payslips SET signed_at = now(), viewed_at = COALESCE(viewed_at, now()) WHERE id = ${id} RETURNING signed_at`;
      await payrollAudit(tx, { staffId: req.actor.id, action: 'employee_sign', batchId: Number(slip.batchId), targetId: req.actor.id, ip: req.ip });
      return { ...slip, signedAt: row!.signedAt };
    });
    return detailOf(r);
  });
}
