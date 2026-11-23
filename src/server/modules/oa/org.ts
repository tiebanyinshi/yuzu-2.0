// OA-01 组织架构与员工档案（docs/OA.md 第 4 节，OA1–OA5）。
// 部门沿用 8.1.18 的 15 个部门（不增删），这里只改上级部门与指定主管；员工档案（工号、手机号、入职 / 离职日期）与账号一对一。
// 办理离职 = 档案记离职、账号停用、登录会话作废；考勤、审批、工资条等历史都不删。
// 加锁顺序（docs/LOCKING.md「组织架构与员工档案」）：在职店主行 → 目标员工行 → 员工档案行 → 部门行（按 key）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { departmentOfPosition, EMP_NO_PATTERN, PHONE_PATTERN, wouldCycle, type EmployeeProfile, type EmploymentStatus, type OrgDepartmentNode, type OrgOverview } from '@shared/oa';
import type { OrgDepartment, PositionKey } from '@shared/positions';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import { maskPhone } from '@shared/labels';
import { can } from '@shared/permissions';
import { guardAny } from '../../auth/guard';
import { destroyStaffSessions } from '../../auth/session';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { DEFAULT_STORE_ID } from '../../lib/store-context';
import { dateSchema, idParam, parse } from '../../lib/validate';
import { allowedStores } from '../stores';

const canManage = guardAny('hr.org', 'staff.manage');

/**
 * 专用账号（点餐平板、他店查询、设计师）不是员工：不进组织架构，也不用办公（考勤、审批、即时通讯）。
 * 与 staff.ts 的 isSpecialRole 同一份名单（设计师 OA-14 安全审查 8a64f95 补上）
 */
export const NOT_EMPLOYEE_ROLES = ['tablet', 'other_store', 'designer'];

const DeptInput = z.object({
  parentKey: z
    .string()
    .regex(/^[a-z]+$/, '上级部门不正确')
    .nullable(),
  headStaffId: z.number().int().positive().nullable(),
  version: z.number().int().positive(),
});
const ProfileInput = z.object({
  empNo: z.string().trim().regex(EMP_NO_PATTERN, '工号为 1–20 位字母、数字、- 或 _').nullable(),
  phone: z.string().trim().regex(PHONE_PATTERN, '手机号为 11 位数字').nullable(),
  hireDate: dateSchema('入职日期').nullable(),
  version: z.number().int().nonnegative(),
});
const LeaveInput = z.object({ leaveDate: dateSchema('离职日期'), version: z.number().int().nonnegative() });
const RehireInput = z.object({ version: z.number().int().nonnegative() });
const keyParam = z.object({ key: z.string().regex(/^[a-z]+$/, '部门不正确') });

/**
 * 门店范围（Codex 安全审查 19dacb2，与 PUT /api/staff/:id 的负责人范围同一个规则）：总裁（staff.manage）看、改全店；
 * 只有 hr.org 的（人力行政部负责人）只看、只改挂的门店都在自己能进的门店里的员工（没挂门店的按本店算），
 * 也不能给总裁办离职、复职、改档案。部门的上下级与主管是全公司的，照旧能改，但指定的主管也要在自己的范围里。
 */
type OrgScope = { all: true } | { all: false; stores: number[] };

async function orgScope(db: Db, actor: Actor): Promise<OrgScope> {
  if (can(actor, 'staff.manage')) return { all: true };
  return { all: false, stores: (await allowedStores(db, actor)).map((x) => Number(x.id)) };
}

/** 员工在不在范围里的条件；s 是 staff 表 */
function storeCond(db: Db, scope: OrgScope) {
  if (scope.all) return db`true`;
  return db`(NOT EXISTS (SELECT 1 FROM staff_stores x WHERE x.staff_id = s.id AND NOT (x.store_id = ANY(${scope.stores}::bigint[])))
    AND (EXISTS (SELECT 1 FROM staff_stores x WHERE x.staff_id = s.id) OR ${DEFAULT_STORE_ID}::bigint = ANY(${scope.stores}::bigint[])))`;
}

/**
 * 锁住员工行之后另起一句核对门店范围（Codex 审查 f036fc2）：调店（PUT /api/staff/:id/stores）先锁员工行再改 staff_stores，
 * 写在加锁那一句里的子查询用的是等锁之前的快照，等到锁以后照旧按调店前的门店放行；分开写，读到的是调店提交后的
 */
async function inStoreScope(tx: Tx, staffId: number, scope: OrgScope): Promise<boolean> {
  if (scope.all) return true;
  const [row] = await tx<{ ok: boolean }[]>`SELECT ${storeCond(tx, scope)} AS ok FROM staff s WHERE s.id = ${staffId}`;
  return row?.ok === true;
}

interface EmployeeRow {
  staffId: number;
  username: string;
  name: string;
  position: PositionKey | null;
  active: boolean;
  createdAt: Date;
  empNo: string | null;
  phone: string | null;
  hireDate: string | null;
  leaveDate: string | null;
  status: EmploymentStatus | null;
  version: number | null;
  inScope: boolean;
}

async function employeeRows(db: Db, scope: OrgScope): Promise<EmployeeRow[]> {
  return db<EmployeeRow[]>`
    SELECT s.id AS staff_id, s.username, s.display_name AS name, s.position, s.active, s.created_at,
           p.emp_no, p.phone, p.hire_date::text AS hire_date, p.leave_date::text AS leave_date, p.status, p.version,
           ${storeCond(db, scope)} AS in_scope
    FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
    WHERE NOT s.system AND s.role <> ALL(${NOT_EMPLOYEE_ROLES})
    ORDER BY s.id`;
}

const toProfile = (r: EmployeeRow): EmployeeProfile => ({
  staffId: r.staffId,
  username: r.username,
  name: r.name,
  position: r.position,
  department: departmentOfPosition(r.position),
  active: r.active,
  empNo: r.empNo,
  phone: r.phone,
  hireDate: r.hireDate,
  leaveDate: r.leaveDate,
  status: r.status ?? 'active',
  version: r.version ?? 0,
});

/** 在职：账号启用、档案不是离职 */
const isOnDuty = (e: EmployeeProfile) => e.active && e.status === 'active';

/** 部门实际的主管（OA3）：指定的在职就用指定的；否则本部门在职负责人里最早建的；总经办取总经办岗位，公司取总裁 */
export function effectiveHead(dept: { key: OrgDepartment; headStaffId: number | null }, employees: readonly EmployeeProfile[]): OrgDepartmentNode['head'] {
  const onDuty = employees.filter(isOnDuty);
  if (dept.headStaffId) {
    const e = onDuty.find((x) => x.staffId === dept.headStaffId);
    if (e) return { id: e.staffId, name: e.name, designated: true };
  }
  const leadKey = dept.key === 'company' ? 'president' : dept.key === 'gmo' ? 'gmo' : `${dept.key}.lead`;
  const lead = onDuty.filter((e) => e.position === leadKey).sort((a, b) => a.staffId - b.staffId)[0];
  return lead ? { id: lead.staffId, name: lead.name, designated: false } : null;
}

/** 整份组织架构；主管与人数按全店算，员工名单只给范围里的（看不到别的门店员工的手机号等） */
export async function loadOrg(db: Db, scope: OrgScope = { all: true }): Promise<OrgOverview> {
  const rows = await employeeRows(db, scope);
  const employees = rows.map(toProfile);
  const visible = new Set(rows.filter((r) => r.inScope).map((r) => r.staffId));
  const depts = await db<{ key: OrgDepartment; name: string; parentKey: OrgDepartment | null; headStaffId: number | null; version: number }[]>`
    SELECT key, name, parent_key, head_staff_id, version FROM org_departments ORDER BY sort`;
  const departments = depts.map((d) => ({
    ...d,
    head: effectiveHead(d, employees),
    memberCount: employees.filter((e) => isOnDuty(e) && e.department === d.key).length,
  }));
  return { departments, employees: employees.filter((e) => visible.has(e.staffId)) };
}

/** 锁住在职店主行（与 PUT /api/staff/:id 同一个顺序），保证办理离职后至少还有一位在职总裁 */
async function lockOwners(tx: Tx) {
  await tx`SELECT id FROM staff WHERE role = 'owner' FOR NO KEY UPDATE`;
}

async function lockEmployee(tx: Tx, id: number, scope: OrgScope) {
  const [row] = await tx<{ id: number; system: boolean; role: string }[]>`SELECT id, system, role FROM staff WHERE id = ${id} FOR NO KEY UPDATE`;
  if (!row || row.system || NOT_EMPLOYEE_ROLES.includes(row.role) || !(await inStoreScope(tx, id, scope))) throw notFound('员工不存在');
  if (!scope.all && row.role === 'owner') throw forbidden('总裁的档案、离职与复职只有总裁能办');
  const [profile] = await tx<{ version: number; status: EmploymentStatus; hireDate: string | null }[]>`
    SELECT version, status, hire_date::text AS hire_date FROM staff_profiles WHERE staff_id = ${id} FOR UPDATE`;
  return profile ?? null;
}

function assertVersion(profile: { version: number } | null, version: number) {
  if ((profile?.version ?? 0) !== version) throw conflict('VERSION_CONFLICT', '这份档案刚被别人改过，请刷新后再改');
}

function translateUnique(error: unknown): never {
  if (isUniqueViolation(error, 'staff_profiles_emp_no_key')) throw conflict('EMP_NO_EXISTS', '这个工号已经有人用了');
  if (isUniqueViolation(error, 'staff_profiles_phone_key')) throw conflict('PHONE_EXISTS', '这个手机号已经是另一位在职员工的');
  throw error;
}

export function registerOaOrgRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/oa/org', { preHandler: canManage }, async (req) => loadOrg(sql, await orgScope(sql, req.actor)));

  app.put('/api/oa/org/departments/:key', { preHandler: canManage }, async (req) => {
    const { key } = parse(keyParam, req.params);
    const input = parse(DeptInput, req.body);
    const scope = await orgScope(sql, req.actor);
    await sql.begin(async (tx) => {
      // 锁顺序（LOCKING 第 9 节）：员工 → 员工档案 → 部门。先锁住要指定的主管（与办理离职互斥：离职先锁员工再清部门主管），
      // 免得这边刚核对完在职、那边办完离职，部门上留下一位离职的指定主管
      if (input.headStaffId) {
        const [head] = await tx<{ id: number }[]>`SELECT id FROM staff WHERE id = ${input.headStaffId} AND active AND NOT system FOR SHARE`;
        if (head && !(await inStoreScope(tx, head.id, scope))) throw unprocessable('HEAD_INVALID', '主管要选一位在职员工');
        const [profile] = head ? await tx<{ status: EmploymentStatus }[]>`SELECT status FROM staff_profiles WHERE staff_id = ${head.id} FOR SHARE` : [];
        if (!head || profile?.status === 'left') throw unprocessable('HEAD_INVALID', '主管要选一位在职员工');
      }
      const rows = await tx<{ key: string; parentKey: string | null; headStaffId: number | null; version: number }[]>`
        SELECT key, parent_key, head_staff_id, version FROM org_departments ORDER BY key FOR UPDATE`;
      const before = rows.find((r) => r.key === key);
      if (!before) throw notFound('部门不存在');
      if (before.version !== input.version) throw conflict('VERSION_CONFLICT', '这个部门刚被别人改过，请刷新后再改');
      if (key === 'company' ? input.parentKey !== null : !input.parentKey) throw unprocessable('PARENT_INVALID', '公司在最上面，其余部门都要选上级部门');
      if (input.parentKey && !rows.some((r) => r.key === input.parentKey)) throw unprocessable('PARENT_INVALID', '上级部门不存在');
      const parents = new Map(rows.map((r) => [r.key, r.parentKey]));
      if (wouldCycle(parents, key, input.parentKey)) throw unprocessable('PARENT_CYCLE', '上级部门不能选自己或自己下面的部门');
      await tx`UPDATE org_departments SET parent_key = ${input.parentKey}, head_staff_id = ${input.headStaffId}, version = version + 1 WHERE key = ${key}`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'org_department_updated',
        targetType: 'org_department',
        detail: { key, before, after: { parentKey: input.parentKey, headStaffId: input.headStaffId } },
        ip: req.ip,
      });
    });
    return loadOrg(sql, scope);
  });

  app.put('/api/oa/employees/:id/profile', { preHandler: canManage }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(ProfileInput, req.body);
    const scope = await orgScope(sql, req.actor);
    try {
      await sql.begin(async (tx) => {
        const profile = await lockEmployee(tx, id, scope);
        assertVersion(profile, input.version);
        await tx`
          INSERT INTO staff_profiles (staff_id, emp_no, phone, hire_date, updated_by)
          VALUES (${id}, ${input.empNo}, ${input.phone}, ${input.hireDate}, ${req.actor.id})
          ON CONFLICT (staff_id) DO UPDATE SET emp_no = EXCLUDED.emp_no, phone = EXCLUDED.phone, hire_date = EXCLUDED.hire_date,
            version = staff_profiles.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`;
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'employee_profile_updated',
          targetType: 'staff',
          targetId: id,
          // 审计按经办人的当前门店归档、看审计的不再核对员工范围（Codex 审查 7d52b44）：手机号只记打码的，不把别的门店员工的号码带进审计
          detail: { empNo: input.empNo, phone: input.phone === null ? null : maskPhone(input.phone), hireDate: input.hireDate },
          ip: req.ip,
        });
      });
    } catch (error) {
      translateUnique(error);
    }
    return loadOrg(sql, scope);
  });

  app.post('/api/oa/employees/:id/leave', { preHandler: canManage }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(LeaveInput, req.body);
    const scope = await orgScope(sql, req.actor);
    if (id === req.actor.id) throw unprocessable('SELF_LEAVE', '不能给自己办理离职');
    await sql.begin(async (tx) => {
      await lockOwners(tx);
      const profile = await lockEmployee(tx, id, scope);
      assertVersion(profile, input.version);
      if (profile?.status === 'left') throw conflict('ALREADY_LEFT', '这位员工已经办过离职');
      if (profile?.hireDate && input.leaveDate < profile.hireDate) throw unprocessable('LEAVE_BEFORE_HIRE', '离职日期不能早于入职日期');
      await tx`
        INSERT INTO staff_profiles (staff_id, status, leave_date, updated_by) VALUES (${id}, 'left', ${input.leaveDate}, ${req.actor.id})
        ON CONFLICT (staff_id) DO UPDATE SET status = 'left', leave_date = EXCLUDED.leave_date,
          version = staff_profiles.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await tx`UPDATE staff SET active = false, updated_at = now() WHERE id = ${id}`;
      const [owners] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM staff WHERE role = 'owner' AND active`;
      if (!owners || owners.count < 1) throw unprocessable('LAST_OWNER', '至少需要保留一位在职总裁');
      // 指定的主管离职：这个部门改回按负责人岗位自动取。先按 key 锁住全部部门（与改部门同一个顺序），
      // 一位员工是好几个部门的指定主管时，批量 UPDATE 自己挑的加锁顺序可能与改部门相反而死锁（Codex 审查 f5465fe）
      await tx`SELECT key FROM org_departments ORDER BY key FOR UPDATE`;
      await tx`UPDATE org_departments SET head_staff_id = NULL, version = version + 1 WHERE head_staff_id = ${id}`;
      await destroyStaffSessions(tx, id);
      await writeAudit(tx, { staffId: req.actor.id, action: 'employee_left', targetType: 'staff', targetId: id, detail: { leaveDate: input.leaveDate }, ip: req.ip });
    });
    return loadOrg(sql, scope);
  });

  app.post('/api/oa/employees/:id/rehire', { preHandler: canManage }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(RehireInput, req.body);
    const scope = await orgScope(sql, req.actor);
    try {
      await sql.begin(async (tx) => {
        await lockOwners(tx);
        const profile = await lockEmployee(tx, id, scope);
        assertVersion(profile, input.version);
        if (!profile || profile.status !== 'left') throw conflict('NOT_LEFT', '这位员工没有办过离职');
        await tx`UPDATE staff_profiles SET status = 'active', leave_date = NULL, version = version + 1, updated_at = now(), updated_by = ${req.actor.id} WHERE staff_id = ${id}`;
        await tx`UPDATE staff SET active = true, updated_at = now() WHERE id = ${id}`;
        await writeAudit(tx, { staffId: req.actor.id, action: 'employee_rehired', targetType: 'staff', targetId: id, ip: req.ip });
      });
    } catch (error) {
      translateUnique(error);
    }
    return loadOrg(sql, scope);
  });
}
