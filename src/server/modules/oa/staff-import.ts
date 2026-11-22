// OA-02 账号与批量开通（docs/OA.md 第 5 节，OA2）：后台「组织架构 → 批量开通」按表格一次建一批员工账号与员工档案。
// 文档的四种角色对到现有岗位：开的都是「部门 → 负责人 / 员工」岗位，权限照岗位的建议权限来（不另建角色表）。
//   · 模板：标题 + 表头（姓名、手机号、工号、部门、岗位、入职日期、登录名），部门、岗位带下拉；
//   · 预览：逐行核对，有问题的行写原因；有一行不对整批不开；
//   · 开通：一次事务建账号（临时密码，首次登录必须改）、挂经办人当前的门店、建员工档案；整批带操作编号，
//     原样重提不开两遍，结果待确认时走 /api/erp/ops 查回、作废（类型 oa_staff_import）。
// 临时密码只在第一次开通的回答里给出（账号表里只存散列）；原样重提、查回时不再给，到「员工账号」里重置。
// 散列在事务外先算好（几百个 scrypt），事务里只写库。加锁：操作编号 → 批量开通的全局锁（几次开通串行，预览的核对在锁里再做一遍）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EMP_NO_PATTERN,
  PHONE_PATTERN,
  STAFF_IMPORT_COLUMNS,
  STAFF_IMPORT_MAX_ROWS,
  STAFF_IMPORT_REQUIRED,
  USERNAME_PATTERN,
  type StaffImportAccount,
  type StaffImportPreview,
  type StaffImportResult,
  type StaffImportRow,
} from '@shared/oa';
import { can, permissionsOf, PERMISSION_LABELS, type Permission } from '@shared/permissions';
import { LINED_DEPARTMENTS, ORG_DEPARTMENTS, positionLabel, positionOf, type LinedDepartment, type PositionKey } from '@shared/positions';
import { isUniqueViolation, type Db } from '../../db';
import { guardAny } from '../../auth/guard';
import { generateTempPassword, hashPassword } from '../../auth/password';
import { loadRoleOverrides } from '../../auth/role-permissions';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { attachment } from '../../lib/csv';
import { conflict, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { readSheet } from '../../lib/sheet-read';
import { currentStoreId } from '../../lib/store-context';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { buildWorkbook, type WbSheet, type WbValidation } from '../../lib/xlsx';
import { erpOpAbandoned } from '../erp-ops';
import { createStaff } from '../staff';

const canImport = guardAny('hr.org', 'staff.manage');
const TITLE = '员工批量开通';

const FileInput = z
  .object({
    fileName: z.string().trim().min(1, '缺少文件名').max(200),
    csv: z.string().max(3_000_000).optional(),
    xlsxBase64: z.string().max(4_000_000).optional(),
  })
  .refine((f) => (f.csv === undefined) !== (f.xlsxBase64 === undefined), '请选择一个表格文件（.xlsx 或 .csv）');
const ApplyInput = FileInput.and(z.object({ clientKey: z.uuid('操作编号格式不正确') }));

const DEPT_BY_NAME = new Map<string, LinedDepartment>(
  ORG_DEPARTMENTS.filter((d): d is (typeof ORG_DEPARTMENTS)[number] & { key: LinedDepartment } => (LINED_DEPARTMENTS as readonly string[]).includes(d.key)).flatMap((d) => [
    [d.name, d.key],
    [d.key, d.key],
  ]),
);
const deptLabel = (key: string) => ORG_DEPARTMENTS.find((d) => d.key === key)?.name ?? key;

const isHeader = (cells: string[]) => cells.includes('姓名') && cells.includes('手机号');

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/** 没填登录名：工号能当登录名的用工号，否则用「u + 手机号」 */
function defaultUsername(empNo: string | null, phone: string): string {
  const fromEmp = empNo?.toLowerCase() ?? '';
  return USERNAME_PATTERN.test(fromEmp) ? fromEmp : `u${phone}`;
}

/** 读表、逐行核对（预览与开通共用；开通时在锁里再核对一遍） */
async function plan(db: Db, f: z.infer<typeof FileInput>, actor: Actor): Promise<StaffImportPreview & { sha256: string }> {
  const sheet = readSheet(f, { dateColumns: ['入职日期'], findHeader: isHeader });
  const col = (name: string) => sheet.header.indexOf(name);
  const missing = STAFF_IMPORT_REQUIRED.filter((c) => col(c) < 0);
  if (missing.length) throw unprocessable('IMPORT_FILE_INVALID', `表头里没有「${missing.join('」「')}」：请用页面上下载的模板`);
  const data = sheet.rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (data.length === 0) throw unprocessable('IMPORT_EMPTY', '表里没有要开通的员工');
  if (data.length > STAFF_IMPORT_MAX_ROWS) throw unprocessable('IMPORT_TOO_LARGE', `一次最多开 ${STAFF_IMPORT_MAX_ROWS} 个账号，这份有 ${data.length} 行，请分几次`);
  const cell = (cells: string[], name: string) => (col(name) < 0 ? '' : (cells[col(name)] ?? '').trim());
  const canLead = can(actor, 'staff.manage');

  const rows: StaffImportRow[] = data.map((r) => {
    const issues: string[] = [];
    const name = cell(r.cells, '姓名');
    const phone = cell(r.cells, '手机号').replace(/[\s-]/g, '');
    const empNo = cell(r.cells, '工号') || null;
    const deptText = cell(r.cells, '部门');
    const title = cell(r.cells, '岗位');
    const hireDate = cell(r.cells, '入职日期').replace(/\//g, '-') || null;
    const userText = cell(r.cells, '登录名').toLowerCase();
    if (!name) issues.push('姓名没填');
    else if (name.length > 32) issues.push('姓名最多 32 个字');
    if (!PHONE_PATTERN.test(phone)) issues.push('手机号要 11 位数字');
    if (empNo && !EMP_NO_PATTERN.test(empNo)) issues.push('工号为 1–20 位字母、数字、- 或 _');
    let department: LinedDepartment | null = null;
    if (!deptText) issues.push('部门没填');
    else if (deptText === '总经办' || deptText === '公司' || /总裁/.test(deptText)) issues.push('总裁、总经办的账号请总裁在「员工账号」里建');
    else {
      department = DEPT_BY_NAME.get(deptText) ?? null;
      if (!department) issues.push(`没有「${deptText}」这个部门（请从模板的下拉里选）`);
    }
    let level: 'lead' | 'staff' | null = null;
    if (!title || title === '员工' || title === '部门员工') level = 'staff';
    else if (title === '负责人' || title === '部门负责人' || title === '主管') level = 'lead';
    else issues.push('岗位只能写「负责人」或「员工」（空着按员工）');
    if (level === 'lead' && !canLead) issues.push('部门负责人的账号要总裁开（您能开的是部门员工）');
    if (hireDate && !isDate(hireDate)) issues.push('入职日期写成 2026-01-05 这样');
    const username = userText || defaultUsername(empNo, phone);
    if (userText && !USERNAME_PATTERN.test(userText)) issues.push('登录名为 2–32 位小写字母、数字或 _ . -');
    const position = department && level ? (`${department}.${level}` as PositionKey) : null;
    return { row: r.row, name, phone, empNo, department, position, hireDate, username, issues };
  });

  // 只有 hr.org、没有 staff.manage 的（人力行政部负责人）只能开出权限不超过自己的岗位（Codex 安全审查 5eeb9ed）：
  // 开通的人拿得到临时密码，开出比自己权限多的账号就等于给自己加了权限（例如开两个财务部员工，绕过财务的一人经办、另一人复核）
  // 而且只能开人力行政部员工（Codex 安全审查 2d44890、4b31b15）：人事被加了财务的权限、或财务的岗位被加了 hr.org 时，
  // 权限不超过自己也能开出两个财务部员工，一个改供应商账户、另一个复核，绕过「不是同一个人」的双人复核；别的岗位一律总裁开
  if (!canLead) {
    for (const x of rows) {
      if (x.position && x.position !== 'hr.staff') x.issues.push(`您只能开「人力行政部员工」，「${positionLabel(x.position)}」的账号要总裁开`);
    }
    const overrides = await loadRoleOverrides(db);
    const mine = (p: Permission) => (actor.permissions ? actor.permissions.includes(p) : can(actor, p));
    const extraOf = new Map<PositionKey, Permission[]>();
    for (const x of rows) {
      if (!x.position || x.position.endsWith('.lead') || x.issues.length) continue;
      if (!extraOf.has(x.position)) {
        const def = positionOf(x.position);
        extraOf.set(
          x.position,
          permissionsOf({ role: def.legacyRole, duties: def.duties, position: x.position }, overrides).filter((p) => !mine(p)),
        );
      }
      const extra = extraOf.get(x.position)!;
      if (extra.length) x.issues.push(`「${positionLabel(x.position)}」有 ${extra.length} 项您自己没有的权限（如「${PERMISSION_LABELS[extra[0]!].split('：')[0]}」），要总裁开`);
    }
  }

  // 表里自己重复的
  const dupIn = (key: (x: StaffImportRow) => string | null, what: string) => {
    const seen = new Map<string, number>();
    for (const x of rows) {
      const k = key(x);
      if (!k) continue;
      const first = seen.get(k);
      if (first !== undefined) x.issues.push(`${what}与第 ${first} 行重复`);
      else seen.set(k, x.row);
    }
  };
  dupIn((x) => (PHONE_PATTERN.test(x.phone) ? x.phone : null), '手机号');
  dupIn((x) => x.empNo?.toLowerCase() ?? null, '工号');
  dupIn((x) => x.username, '登录名');

  // 与系统里已有的重复
  const phones = rows.map((x) => x.phone).filter((p) => PHONE_PATTERN.test(p));
  const empNos = rows.flatMap((x) => (x.empNo ? [x.empNo] : []));
  const usernames = rows.map((x) => x.username);
  const takenPhones = new Set((await db<{ phone: string }[]>`SELECT phone FROM staff_profiles WHERE status = 'active' AND phone IN ${db(phones.length ? phones : [''])}`).map((x) => x.phone));
  const takenEmp = new Set((await db<{ empNo: string }[]>`SELECT emp_no FROM staff_profiles WHERE emp_no IN ${db(empNos.length ? empNos : [''])}`).map((x) => x.empNo));
  const takenUser = new Set((await db<{ username: string }[]>`SELECT username FROM staff WHERE username IN ${db(usernames)}`).map((x) => x.username));
  for (const x of rows) {
    if (takenPhones.has(x.phone)) x.issues.push('手机号已经是一位在职员工的');
    if (x.empNo && takenEmp.has(x.empNo)) x.issues.push('工号已经有人用了');
    if (takenUser.has(x.username)) x.issues.push(`登录名「${x.username}」已经有人用了，请在「登录名」一列另写一个`);
  }
  return { fileName: f.fileName, rows, issueCount: rows.filter((x) => x.issues.length).length, sha256: sheet.sha256 };
}

async function importResult(db: Db, id: number, replayed: boolean, passwords = new Map<number, string>()): Promise<StaffImportResult> {
  const [imp] = await db<{ id: number; fileName: string; createdAt: string | Date; staffIds: number[] }[]>`
    SELECT id, file_name, created_at, staff_ids FROM oa_staff_imports WHERE id = ${id}`;
  if (!imp) throw unprocessable('IMPORT_NOT_FOUND', '没有这次开通');
  const ids = imp.staffIds.map(Number);
  const staff = await db<{ id: number; username: string; displayName: string; position: PositionKey }[]>`
    SELECT id, username, display_name, position FROM staff WHERE id IN ${db(ids)}`;
  const byId = new Map(staff.map((s) => [Number(s.id), s]));
  const accounts: StaffImportAccount[] = ids.flatMap((sid) => {
    const s = byId.get(sid);
    return s ? [{ staffId: sid, username: s.username, name: s.displayName, position: s.position, temporaryPassword: passwords.get(sid) ?? null }] : [];
  });
  return { import: { id: Number(imp.id), fileName: imp.fileName, createdAt: new Date(imp.createdAt).toISOString(), count: ids.length }, accounts, replayed };
}

async function applyImport(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<StaffImportResult> {
  const f = parse(ApplyInput, raw);
  const requestHash = hashRequest({ ...f, clientKey: undefined });
  const { sql } = deps;
  // 先看这个编号是不是已经开过（开过的不再算散列），再在事务外把这一批的临时密码与散列算好
  const [already] = await sql<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${f.clientKey}`;
  if (already) {
    if (already.opType !== 'oa_staff_import' || already.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重新选择文件');
    return importResult(sql, Number(already.refId), true);
  }
  // 同一时间只开一批（Codex 安全审查 2d44890）：几百个 scrypt 散列很费 CPU，几批同时来会把整个服务拖住；
  // 先占住这一个名额再核对、算散列（一个一个算，不一次全排进线程池），别的批次直接回「正在开通」，等这一批开完再提交
  if (importBusy) throw conflict('IMPORT_BUSY', '另一批员工正在开通，请等它完成后再开（结果待确认的请稍后查回或重新提交）');
  importBusy = true;
  try {
    return await applyLocked(deps, f, requestHash, actor, ip);
  } finally {
    importBusy = false;
  }
}

let importBusy = false;

async function applyLocked(deps: Deps, f: z.infer<typeof ApplyInput>, requestHash: string, actor: Actor, ip?: string): Promise<StaffImportResult> {
  const { sql } = deps;
  const draft = await plan(sql, f, actor);
  if (draft.issueCount) throw invalid(draft);
  const secrets: { password: string; hash: string }[] = [];
  for (let i = 0; i < draft.rows.length; i += 1) {
    const password = generateTempPassword();
    secrets.push({ password, hash: await hashPassword(password) });
  }

  const passwords = new Map<number, string>();
  const outcome = await sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, f.clientKey);
    const [seen] = await tx<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${f.clientKey}`;
    if (seen) {
      if (seen.opType !== 'oa_staff_import' || seen.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重新选择文件');
      return { id: Number(seen.refId), replayed: true };
    }
    await assertNotFenced(tx, f.clientKey, 'oa_staff_import', erpOpAbandoned);
    // 几次批量开通串行：在锁里按库里现在的样子再核对一遍（预览之后别人可能刚建了同名的账号）
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('oa_staff_import', 0))`;
    const p = await plan(tx, f, actor);
    if (p.issueCount) throw invalid(p);
    const storeId = currentStoreId();
    const ids: number[] = [];
    try {
      for (const [i, row] of p.rows.entries()) {
        const id = await createStaff(tx, {
          username: row.username,
          displayName: row.name,
          role: 'clerk',
          position: row.position!,
          password: '',
          passwordHash: secrets[i]!.hash,
          mustChangePassword: true,
        });
        await tx`INSERT INTO staff_stores (staff_id, store_id) VALUES (${id}, ${storeId}) ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO staff_profiles (staff_id, emp_no, phone, hire_date, updated_by) VALUES (${id}, ${row.empNo}, ${row.phone}, ${row.hireDate}, ${actor.id})`;
        ids.push(id);
        passwords.set(id, secrets[i]!.password);
      }
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('IMPORT_CONFLICT', '开通时有登录名、手机号或工号刚被别人用了，请重新预览');
      throw error;
    }
    const [imp] = await tx<{ id: number }[]>`
      INSERT INTO oa_staff_imports (client_key, file_name, file_sha256, staff_ids, created_by)
      VALUES (${f.clientKey}, ${f.fileName}, ${p.sha256}, ${ids}, ${actor.id}) RETURNING id`;
    const importId = Number(imp!.id);
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${f.clientKey}, 'oa_staff_import', ${requestHash}, ${importId}, ${actor.id})`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'oa_staff_imported',
      targetType: 'oa_staff_import',
      targetId: importId,
      detail: { fileName: f.fileName, count: ids.length, usernames: p.rows.map((x) => x.username) },
      ip,
    });
    return { id: importId, replayed: false };
  });
  return importResult(sql, outcome.id, outcome.replayed, outcome.replayed ? undefined : passwords);
}

function invalid(p: StaffImportPreview) {
  const bad = p.rows.filter((x) => x.issues.length);
  return unprocessable(
    'IMPORT_INVALID',
    `有 ${bad.length} 行要先改好才能开通：${bad
      .slice(0, 3)
      .map((x) => `第 ${x.row} 行 ${x.issues[0]}`)
      .join('；')}`,
    { rows: bad.map((x) => ({ row: x.row, issues: x.issues })) },
  );
}

const COLUMN_HOW: Record<(typeof STAFF_IMPORT_COLUMNS)[number], { width: number; how: string; example: string }> = {
  姓名: { width: 12, how: '必填，最多 32 个字', example: '张三' },
  手机号: { width: 16, how: '必填，11 位；在职员工之间不能重复', example: '13800000001' },
  工号: { width: 12, how: '选填，字母、数字、- 或 _，最多 20 位；全店不重复', example: 'E001' },
  部门: { width: 14, how: '必填，下拉选；总裁、总经办的账号请总裁在「员工账号」里建', example: '前厅部' },
  岗位: { width: 10, how: '选填，下拉选负责人或员工，空着按员工；部门负责人的账号要总裁开', example: '员工' },
  入职日期: { width: 14, how: '选填，写成 2026-01-05', example: '2026-01-05' },
  登录名: { width: 16, how: '选填，2–32 位小写字母、数字或 _ . -；空着按工号生成，没有工号用 u + 手机号', example: 'zhangsan' },
};

export function staffImportTemplate(): Buffer {
  const required = new Set<string>(STAFF_IMPORT_REQUIRED);
  const last = STAFF_IMPORT_MAX_ROWS + 2;
  const letter = (i: number) => String.fromCharCode(65 + i);
  const validations: WbValidation[] = STAFF_IMPORT_COLUMNS.map((name, i) => {
    const v: WbValidation = { sqref: `${letter(i)}3:${letter(i)}${last}`, promptTitle: `${name}（${required.has(name) ? '必填' : '选填'}）`, prompt: COLUMN_HOW[name].how };
    if (name === '部门') Object.assign(v, { list: LINED_DEPARTMENTS.map(deptLabel), error: '请从下拉里选部门' });
    if (name === '岗位') Object.assign(v, { list: ['员工', '负责人'], error: '只能选员工或负责人（空着按员工）' });
    return v;
  });
  const n = STAFF_IMPORT_COLUMNS.length;
  const main: WbSheet = {
    name: '员工',
    active: true,
    widths: STAFF_IMPORT_COLUMNS.map((c) => COLUMN_HOW[c].width),
    freezeRows: 2,
    merges: [`A1:${letter(n - 1)}1`],
    rows: [
      { height: 36, cells: [{ v: TITLE, style: 'title' }] },
      { height: 26, cells: STAFF_IMPORT_COLUMNS.map((c) => ({ v: c, style: required.has(c) ? 'required' : 'optional' })) },
    ],
    validations,
  };
  const guide: WbSheet = {
    name: '填写说明',
    widths: [12, 8, 64, 16],
    rows: [
      { height: 26, cells: [{ v: `${TITLE} · 填写说明`, style: 'title' }] },
      { cells: [{ v: '第 1 行标题、第 2 行表头不要改；从第 3 行起一行一位员工。橙色表头必填、灰色选填。', style: 'note' }] },
      { height: 22, cells: ['列', '必填', '怎么填', '例子'].map((v) => ({ v, style: 'optional' as const })) },
      ...STAFF_IMPORT_COLUMNS.map((c) => ({
        cells: [
          { v: c, style: 'body' as const },
          { v: required.has(c) ? '必填' : '选填', style: 'body' as const },
          { v: COLUMN_HOW[c].how, style: 'body' as const },
          { v: COLUMN_HOW[c].example, style: 'body' as const },
        ],
      })),
      { cells: [] },
      { cells: [{ v: `开通：后台「组织架构 → 批量开通」选文件 →「预览」→ 没有问题再「开通」。一次最多 ${STAFF_IMPORT_MAX_ROWS} 人；有一行不对整批不开。`, style: 'note' }] },
      { cells: [{ v: '开通后每人一个临时密码（只显示这一次，请当场复制或下载名单），员工第一次登录必须改密码；权限按岗位来。', style: 'note' }] },
    ],
    merges: ['A1:D1', 'A2:D2', `A${n + 5}:D${n + 5}`, `A${n + 6}:D${n + 6}`],
  };
  return buildWorkbook([main, guide]);
}

export function registerOaStaffImportRoutes(app: FastifyInstance, deps: Deps) {
  const bodyLimit = 5_000_000;
  app.get('/api/oa/employees/import/template', { preHandler: canImport }, async (_req, reply) => {
    attachment(reply, '员工批量开通模板.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return reply.send(staffImportTemplate());
  });
  app.post('/api/oa/employees/import/preview', { preHandler: canImport, bodyLimit }, async (req): Promise<StaffImportPreview> => {
    const { sha256: _sha, ...preview } = await plan(deps.sql, parse(FileInput, req.body), req.actor);
    return preview;
  });
  app.post('/api/oa/employees/import', { preHandler: canImport, bodyLimit }, async (req, reply) => {
    const r = await applyImport(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    return r;
  });
}
