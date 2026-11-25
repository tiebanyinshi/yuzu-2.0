// 员工办公 v1.1 第 2 批：排班授权与统一权限校验（docs/OA_MOBILE.md 第 3–5 节；需求文档 5.2）。
//   · 服务端唯一入口 resolveScheduleAccess：所有排班读、写、批量、发布都经过它，禁止模块自行绕过。
//   · 内置权限：
//       1. hr.attendance（人事 / 店主）：全门店（all_company）查看、编排、发布、授权。
//       2. 部门经理（org_departments.head_staff_id 指定，或岗位由后台核实且为 <dept>.lead / gmo 并带 hr.attendanceDept）：
//          本部门及下级部门（dept_tree）查看、编排、发布、授权。
//       3. 未经后台核实的自选岗位（position_chosen_at IS NOT NULL）带 hr.attendanceDept：仅可查看本部门，不能编排、发布、授权。
//   · 排班授权（oa_schedule_grants）：
//       - 权限点仅限 view / edit / publish，绝不含 grant（不可转授；授权能力只认内置角色，不叠加获授权限）。
//       - 范围：group / dept / dept_tree / staff / all_company（部门经理受 scope_cap_depts 上限约束，防外部门人员后来加入考勤组越权）。
//       - 有效期：默认 1 年、最长 2 年；到期自动失效。
//       - 调岗失效：实时比对 grantee_position 与员工当前 staff.position 及在职状态，岗位变化或离职停用立即失效。
//       - 全程记 audit_logs（oa_schedule_grant_created / oa_schedule_grant_revoked）。
// 加锁顺序（docs/LOCKING.md「排班授权」）：
//   新建授权：lockOpKey → staff（授权人与被授权人按 id 升序 FOR SHARE）→ 插入 oa_schedule_grants。
//   撤销授权：oa_schedule_grants（FOR UPDATE）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  departmentOfPosition,
  SCHEDULE_GRANT_DEFAULT_DAYS,
  SCHEDULE_GRANT_MAX_DAYS,
  SCHEDULE_GRANT_NOTE_MAX,
  SCHEDULE_GRANT_PERM_LABELS,
  SCHEDULE_GRANT_PERMS,
  SCHEDULE_SCOPE_LABELS,
  SCHEDULE_SCOPE_TYPES,
  type ScheduleAccessSummary,
  type ScheduleGrant,
  type ScheduleGrantPage,
  type ScheduleGrantPerm,
  type ScheduleGrantSaved,
  type ScheduleGrantStatus,
  type ScheduleScopeType,
} from '@shared/oa';
import { shiftDate } from '@shared/labels';
import { can, type Duty, type Role } from '@shared/permissions';
import { ORG_DEPARTMENTS, type OrgDepartment, type PositionKey } from '@shared/positions';
import type { Db } from '../../db';
import { guard } from '../../auth/guard';
import { subjectOf } from '../../auth/role-permissions';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { daysBetween, todayIn } from '../../lib/dates';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { currentStoreId } from '../../lib/store-context';
import { dateSchema, idParam, parse } from '../../lib/validate';
import { erpOpAbandoned } from '../erp-ops';
import { storeEmployee } from './attendance-setup';
import { notify } from './notifications';
import { NOT_EMPLOYEE_ROLES } from './org';

const DEPT_NAMES = new Map<string, string>(ORG_DEPARTMENTS.map((d) => [d.key, d.name]));

interface DeptRow {
  key: OrgDepartment;
  parentKey: OrgDepartment | null;
  headStaffId: number | null;
}

interface LiveActorRow {
  id: number;
  role: Role;
  duties: Duty[] | null;
  position: PositionKey | null;
  permissionAdjust: unknown;
  active: boolean;
  selfChosen: boolean;
  employmentStatus: string;
}

interface BuiltInAccess {
  role: 'hr' | 'dept_head' | 'none';
  /** dept_head 为内置可管的部门树；hr 为 null（全公司）；none 为 [] */
  depts: OrgDepartment[] | null;
  /** 未经后台核实的自选负责人（有 hr.attendanceDept 但 selfChosen）：只读本部门 */
  viewOnlyDept: OrgDepartment | null;
  livePosition: PositionKey | null;
  active: boolean;
}

export interface ResolvedScheduleAccess {
  summary: ScheduleAccessSummary;
  /** hr 时为 true（全门店所有在职员工均有 view / edit / publish） */
  allCompany: boolean;
  viewStaff: ReadonlySet<number>;
  editStaff: ReadonlySet<number>;
  publishStaff: ReadonlySet<number>;
  /** 用于审计：操作目标员工时动用了哪些授权单（内置权限已覆盖的不计） */
  grantIdsFor: (perm: 'edit' | 'publish', staffIds: readonly number[]) => number[];
}

/** 按 org_departments.parent_key 向下展开整棵子部门树（含根部门本身） */
function expandDeptTree(depts: readonly DeptRow[], roots: readonly OrgDepartment[]): OrgDepartment[] {
  const children = new Map<OrgDepartment, OrgDepartment[]>();
  for (const d of depts) {
    if (d.parentKey) children.set(d.parentKey, [...(children.get(d.parentKey) ?? []), d.key]);
  }
  const seen = new Set<OrgDepartment>();
  const queue: OrgDepartment[] = [...roots];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const child of children.get(cur) ?? []) queue.push(child);
  }
  return [...seen].sort();
}

async function loadDepts(db: Db): Promise<DeptRow[]> {
  const rows = await db<DeptRow[]>`SELECT key, parent_key, head_staff_id FROM org_departments ORDER BY sort, key`;
  return rows.map((r) => ({ ...r, headStaffId: r.headStaffId === null ? null : Number(r.headStaffId) }));
}

/**
 * 实时计算操作人的「内置」排班职权（绝不混入获授权限，供授权校验与统一鉴权共用）。
 * 读库里最新的岗位、启用与离职状态，防止调岗/停用后会话缓存残留越权。
 */
async function resolveBuiltIn(db: Db, actor: Actor, depts: readonly DeptRow[], lockActor: boolean): Promise<BuiltInAccess> {
  const [me] = await db<LiveActorRow[]>`
    SELECT s.id, s.role, s.duties, s.position, s.permission_adjust, s.active,
           s.position_chosen_at IS NOT NULL AS self_chosen,
           coalesce(p.status, 'active') AS employment_status
    FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
    WHERE s.id = ${actor.id}
    ${lockActor ? db`FOR SHARE OF s` : db``}`;
  if (!me || !me.active || me.employmentStatus === 'left') {
    return { role: 'none', depts: [], viewOnlyDept: null, livePosition: null, active: false };
  }
  const live = await subjectOf(db, me);
  if (can(live, 'hr.attendance')) {
    return { role: 'hr', depts: null, viewOnlyDept: null, livePosition: me.position, active: true };
  }
  const designated = depts.filter((d) => d.headStaffId === actor.id && d.key !== 'company').map((d) => d.key);
  const posDept = departmentOfPosition(me.position);
  const isLeadPos = me.position === 'gmo' || (!!me.position && me.position.endsWith('.lead'));
  const verifiedLeadDept = !me.selfChosen && isLeadPos && can(live, 'hr.attendanceDept') && posDept && posDept !== 'company' ? [posDept] : [];
  const roots = [...new Set([...designated, ...verifiedLeadDept])];
  if (roots.length > 0) {
    return { role: 'dept_head', depts: expandDeptTree(depts, roots), viewOnlyDept: null, livePosition: me.position, active: true };
  }
  const viewOnlyDept = me.selfChosen && can(live, 'hr.attendanceDept') && posDept && posDept !== 'company' ? posDept : null;
  return { role: 'none', depts: [], viewOnlyDept, livePosition: me.position, active: true };
}

interface RawActiveGrant {
  id: number;
  permissions: ScheduleGrantPerm[];
  scopeType: ScheduleScopeType;
  scopeGroupId: number | null;
  scopeDeptKey: OrgDepartment | null;
  scopeStaffIds: number[] | null;
  scopeCapDepts: OrgDepartment[] | null;
  granteePosition: PositionKey;
}

/**
 * 服务端统一的排班权限与范围校验：
 * 计算 actor 在当前门店于 today 这一天能查看 / 编排 / 发布的员工集合，以及是否具备授权能力。
 */
export async function resolveScheduleAccess(db: Db, actor: Actor, today: string, opts?: { lock?: boolean }): Promise<ResolvedScheduleAccess> {
  const store = currentStoreId();
  const lock = !!opts?.lock;
  const depts = await loadDepts(db);
  const builtIn = await resolveBuiltIn(db, actor, depts, lock);

  const builtInEdit = new Set<number>();
  const builtInPublish = new Set<number>();
  const viewStaff = new Set<number>();
  const editStaff = new Set<number>();
  const publishStaff = new Set<number>();
  const editGrantsByStaff = new Map<number, number[]>();
  const publishGrantsByStaff = new Map<number, number[]>();

  if (!builtIn.active) {
    return {
      summary: { canView: false, canEdit: false, canPublish: false, canGrant: false, builtInRole: 'none', builtInDepts: [] },
      allCompany: false,
      viewStaff,
      editStaff,
      publishStaff,
      grantIdsFor: () => [],
    };
  }

  const employees = await db<{ id: number; position: PositionKey | null }[]>`
    SELECT s.id, s.position FROM staff s WHERE ${storeEmployee(db)} ORDER BY s.id`;
  const empList = employees.map((e) => ({ id: Number(e.id), position: e.position, dept: departmentOfPosition(e.position) }));

  if (builtIn.role === 'hr') {
    for (const e of empList) {
      viewStaff.add(e.id);
      editStaff.add(e.id);
      publishStaff.add(e.id);
    }
    return {
      summary: { canView: true, canEdit: true, canPublish: true, canGrant: true, builtInRole: 'hr', builtInDepts: null },
      allCompany: true,
      viewStaff,
      editStaff,
      publishStaff,
      grantIdsFor: () => [],
    };
  }

  if (builtIn.role === 'dept_head' && builtIn.depts) {
    const allowed = new Set<OrgDepartment>(builtIn.depts);
    for (const e of empList) {
      if (e.dept && allowed.has(e.dept)) {
        builtInEdit.add(e.id);
        builtInPublish.add(e.id);
        viewStaff.add(e.id);
        editStaff.add(e.id);
        publishStaff.add(e.id);
      }
    }
  } else if (builtIn.viewOnlyDept) {
    for (const e of empList) {
      if (e.dept === builtIn.viewOnlyDept) {
        viewStaff.add(e.id);
      }
    }
  }

  // 叠加当前门店中生效、未撤销、在有效期内、且未调岗（grantee_position 与现岗位一致）的排班授权
  const rawGrants = builtIn.livePosition
    ? await db<RawActiveGrant[]>`
        SELECT id, permissions, scope_type, scope_group_id, scope_dept_key, scope_staff_ids, scope_cap_depts, grantee_position
        FROM oa_schedule_grants
        WHERE store_id = ${store} AND grantee_staff_id = ${actor.id}
          AND revoked_at IS NULL AND valid_from <= ${today}::date AND valid_to >= ${today}::date
        ORDER BY id
        ${lock ? db`FOR SHARE` : db``}`
    : [];

  const activeGrants = rawGrants.filter((g) => g.granteePosition === builtIn.livePosition);
  if (activeGrants.length > 0) {
    const needGroups = activeGrants.some((g) => g.scopeType === 'group');
    const groupMembers = new Map<number, Set<number>>();
    if (needGroups) {
      const mRows = await db<{ groupId: number; staffId: number }[]>`
        SELECT m.group_id, m.staff_id FROM oa_group_members m JOIN oa_attendance_groups g ON g.id = m.group_id
        WHERE g.store_id = ${store} AND g.active`;
      for (const r of mRows) {
        const gid = Number(r.groupId);
        const set = groupMembers.get(gid) ?? new Set<number>();
        set.add(Number(r.staffId));
        groupMembers.set(gid, set);
      }
    }
    for (const g of activeGrants) {
      const gid = Number(g.id);
      const cap = g.scopeCapDepts ? new Set<OrgDepartment>(g.scopeCapDepts) : null;
      const tree = g.scopeType === 'dept_tree' && g.scopeDeptKey ? new Set<OrgDepartment>(expandDeptTree(depts, [g.scopeDeptKey])) : null;
      const groupSet = g.scopeType === 'group' && g.scopeGroupId !== null ? (groupMembers.get(Number(g.scopeGroupId)) ?? new Set<number>()) : null;
      const staffSet = g.scopeType === 'staff' && g.scopeStaffIds ? new Set<number>(g.scopeStaffIds.map(Number)) : null;
      const hasEdit = g.permissions.includes('edit');
      const hasPublish = g.permissions.includes('publish');
      const hasView = g.permissions.includes('view') || hasEdit || hasPublish;
      for (const e of empList) {
        if (cap && (!e.dept || !cap.has(e.dept))) continue;
        const hit =
          g.scopeType === 'all_company'
            ? true
            : g.scopeType === 'group'
              ? !!groupSet?.has(e.id)
              : g.scopeType === 'dept'
                ? e.dept === g.scopeDeptKey
                : g.scopeType === 'dept_tree'
                  ? !!e.dept && !!tree?.has(e.dept)
                  : !!staffSet?.has(e.id);
        if (!hit) continue;
        if (hasView) viewStaff.add(e.id);
        if (hasEdit) {
          editStaff.add(e.id);
          if (!builtInEdit.has(e.id)) editGrantsByStaff.set(e.id, [...(editGrantsByStaff.get(e.id) ?? []), gid]);
        }
        if (hasPublish) {
          publishStaff.add(e.id);
          if (!builtInPublish.has(e.id)) publishGrantsByStaff.set(e.id, [...(publishGrantsByStaff.get(e.id) ?? []), gid]);
        }
      }
    }
  }

  const canGrant = builtIn.role === 'dept_head';
  const canView = canGrant || builtIn.viewOnlyDept !== null || viewStaff.size > 0;
  const canEdit = canGrant || editStaff.size > 0;
  const canPublish = canGrant || publishStaff.size > 0;

  return {
    summary: {
      canView,
      canEdit,
      canPublish,
      canGrant,
      builtInRole: builtIn.role,
      builtInDepts: builtIn.depts,
    },
    allCompany: false,
    viewStaff,
    editStaff,
    publishStaff,
    grantIdsFor: (perm, staffIds) => {
      const map = perm === 'edit' ? editGrantsByStaff : publishGrantsByStaff;
      const used = new Set<number>();
      for (const id of staffIds) for (const gid of map.get(id) ?? []) used.add(gid);
      return [...used].sort((a, b) => a - b);
    },
  };
}

interface GrantListRow {
  id: number;
  grantorStaffId: number;
  grantorName: string;
  granteeStaffId: number;
  granteeName: string;
  granteePosition: PositionKey;
  granteeCurrentPosition: PositionKey | null;
  granteeActive: boolean;
  granteeEmploymentStatus: string;
  permissions: ScheduleGrantPerm[];
  scopeType: ScheduleScopeType;
  scopeGroupId: number | null;
  scopeGroupName: string | null;
  scopeDeptKey: OrgDepartment | null;
  scopeStaffIds: number[] | null;
  scopeCapDepts: OrgDepartment[] | null;
  validFrom: string;
  validTo: string;
  note: string;
  createdAt: Date;
  revokedAt: Date | null;
  revokedByName: string | null;
  revokeReason: string | null;
}

function grantStatusOf(r: GrantListRow, today: string): ScheduleGrantStatus {
  if (r.revokedAt) return 'revoked';
  if (!r.granteeActive || r.granteeEmploymentStatus === 'left' || r.granteeCurrentPosition !== r.granteePosition) return 'transferred';
  if (today < r.validFrom) return 'pending';
  if (today > r.validTo) return 'expired';
  return 'active';
}

async function hydrateGrants(db: Db, rows: GrantListRow[], today: string, actorId: number, isHr: boolean): Promise<ScheduleGrant[]> {
  const staffIds = [...new Set(rows.flatMap((r) => (r.scopeStaffIds ?? []).map(Number)))];
  const staffNames = new Map<number, string>();
  if (staffIds.length) {
    const sRows = await db<{ id: number; displayName: string }[]>`SELECT id, display_name FROM staff WHERE id IN ${db(staffIds)}`;
    for (const s of sRows) staffNames.set(Number(s.id), s.displayName);
  }
  return rows.map((r) => {
    const sids = r.scopeStaffIds ? r.scopeStaffIds.map(Number) : null;
    const status = grantStatusOf(r, today);
    return {
      id: Number(r.id),
      grantorStaffId: Number(r.grantorStaffId),
      grantorName: r.grantorName,
      granteeStaffId: Number(r.granteeStaffId),
      granteeName: r.granteeName,
      granteePosition: r.granteePosition,
      granteeCurrentPosition: r.granteeCurrentPosition,
      permissions: r.permissions,
      scopeType: r.scopeType,
      scopeGroupId: r.scopeGroupId === null ? null : Number(r.scopeGroupId),
      scopeGroupName: r.scopeGroupName,
      scopeDeptKey: r.scopeDeptKey,
      scopeDeptName: r.scopeDeptKey ? (DEPT_NAMES.get(r.scopeDeptKey) ?? r.scopeDeptKey) : null,
      scopeStaffIds: sids,
      scopeStaffNames: sids ? sids.map((id) => staffNames.get(id) ?? `#${id}`) : [],
      scopeCapDepts: r.scopeCapDepts,
      validFrom: r.validFrom,
      validTo: r.validTo,
      note: r.note,
      status,
      createdAt: new Date(r.createdAt).toISOString(),
      revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
      revokedByName: r.revokedByName,
      revokeReason: r.revokeReason,
      canRevoke: !r.revokedAt && (isHr || Number(r.grantorStaffId) === actorId),
    };
  });
}

async function queryGrantRows(db: Db, where: ReturnType<Db>): Promise<GrantListRow[]> {
  return db<GrantListRow[]>`
    SELECT g.id, g.grantor_staff_id, gr.display_name AS grantor_name,
           g.grantee_staff_id, ge.display_name AS grantee_name,
           g.grantee_position, ge.position AS grantee_current_position,
           ge.active AS grantee_active, coalesce(gp.status, 'active') AS grantee_employment_status,
           g.permissions, g.scope_type, g.scope_group_id, grp.name AS scope_group_name,
           g.scope_dept_key, g.scope_staff_ids, g.scope_cap_depts,
           g.valid_from::text AS valid_from, g.valid_to::text AS valid_to,
           g.note, g.created_at, g.revoked_at, rv.display_name AS revoked_by_name, g.revoke_reason
    FROM oa_schedule_grants g
    JOIN staff gr ON gr.id = g.grantor_staff_id
    JOIN staff ge ON ge.id = g.grantee_staff_id
    LEFT JOIN staff_profiles gp ON gp.staff_id = ge.id
    LEFT JOIN oa_attendance_groups grp ON grp.id = g.scope_group_id
    LEFT JOIN staff rv ON rv.id = g.revoked_by
    WHERE ${where}
    ORDER BY g.created_at DESC, g.id DESC`;
}

const CreateGrantInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  storeId: z.number().int().positive(),
  granteeStaffId: z.number().int().positive('请选择被授权员工'),
  permissions: z.array(z.enum(SCHEDULE_GRANT_PERMS, '不支持授出该权限点（授权权不可转授）')).min(1, '请至少勾选一项排班权限'),
  scopeType: z.enum(SCHEDULE_SCOPE_TYPES, '授权范围不正确'),
  scopeGroupId: z.number().int().positive().nullable().optional(),
  scopeDeptKey: z
    .string()
    .regex(/^[a-z]+$/, '部门不正确')
    .nullable()
    .optional(),
  scopeStaffIds: z.array(z.number().int().positive()).max(200, '一次最多指定 200 位员工').nullable().optional(),
  validFrom: dateSchema('生效开始日期').optional(),
  validTo: dateSchema('生效截止日期').optional(),
  note: z.string().trim().max(SCHEDULE_GRANT_NOTE_MAX, `备注最多 ${SCHEDULE_GRANT_NOTE_MAX} 个字`).default(''),
});

const RevokeInput = z.object({
  reason: z.string().trim().max(SCHEDULE_GRANT_NOTE_MAX, `撤销原因最多 ${SCHEDULE_GRANT_NOTE_MAX} 个字`).default(''),
});

const PERM_ORDER: Record<ScheduleGrantPerm, number> = { view: 0, edit: 1, publish: 2 };
function normalizePerms(perms: readonly ScheduleGrantPerm[]): ScheduleGrantPerm[] {
  const set = new Set<ScheduleGrantPerm>(perms);
  // 能编排或发布必然能查看
  if (set.has('edit') || set.has('publish')) set.add('view');
  return [...set].sort((a, b) => PERM_ORDER[a] - PERM_ORDER[b]);
}

function scopeSummaryText(g: ScheduleGrant): string {
  if (g.scopeType === 'all_company') return '全公司';
  if (g.scopeType === 'group') return `考勤组「${g.scopeGroupName ?? g.scopeGroupId}」`;
  if (g.scopeType === 'dept') return `部门「${g.scopeDeptName ?? g.scopeDeptKey}」`;
  if (g.scopeType === 'dept_tree') return `部门及下级「${g.scopeDeptName ?? g.scopeDeptKey}」`;
  return `指定员工 ${g.scopeStaffNames.slice(0, 4).join('、')}${g.scopeStaffNames.length > 4 ? ` 等 ${g.scopeStaffNames.length} 人` : ''}`;
}

export function registerOaScheduleGrantRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const todayOf = () => todayIn(deps.config.timezone);

  // 登录即查本人的排班权限摘要（WCP 用于决定是否展示「排班管理」入口）
  app.get('/api/oa/attendance/schedule-access', { preHandler: guard() }, async (req): Promise<ScheduleAccessSummary> => {
    const access = await resolveScheduleAccess(sql, req.actor, todayOf());
    return access.summary;
  });

  // 排班授权管理页数据（仅内置授权人：考勤管理员或部门经理；被授权人不可转授，拒绝访问管理列表）
  app.get('/api/oa/attendance/schedule-grants', { preHandler: guard() }, async (req): Promise<ScheduleGrantPage> => {
    const today = todayOf();
    const store = currentStoreId();
    const access = await resolveScheduleAccess(sql, req.actor, today);
    if (!access.summary.canGrant) throw forbidden('只有考勤管理员或部门经理可以管理排班授权；获授权限不可转授');
    const isHr = access.summary.builtInRole === 'hr';
    const allowedDepts = access.summary.builtInDepts ? new Set<OrgDepartment>(access.summary.builtInDepts) : null;

    const rows = await queryGrantRows(sql, isHr ? sql`g.store_id = ${store}` : sql`g.store_id = ${store} AND (g.grantor_staff_id = ${req.actor.id} OR g.grantee_staff_id = ${req.actor.id})`);
    const grants = await hydrateGrants(sql, rows, today, req.actor.id, isHr);

    const empRows = await sql<{ id: number; displayName: string; position: PositionKey | null }[]>`
      SELECT s.id, s.display_name, s.position FROM staff s
      WHERE ${storeEmployee(sql)} AND s.position IS NOT NULL
      ORDER BY s.id`;
    const candidates = empRows
      .map((e) => ({ staffId: Number(e.id), name: e.displayName, position: e.position!, department: departmentOfPosition(e.position) }))
      .filter((e) => !allowedDepts || (e.department !== null && allowedDepts.has(e.department)));

    const candidateIds = candidates.map((c) => c.staffId);
    const groupRows =
      isHr || candidateIds.length > 0
        ? await sql<{ id: number; name: string }[]>`
            SELECT g.id, g.name FROM oa_attendance_groups g
            WHERE g.store_id = ${store} AND g.active
              ${isHr ? sql`` : sql`AND EXISTS (SELECT 1 FROM oa_group_members m WHERE m.group_id = g.id AND m.staff_id = ANY(${candidateIds}::bigint[]))`}
            ORDER BY g.id`
        : [];

    const departments = ORG_DEPARTMENTS.filter((d) => d.key !== 'company' && (!allowedDepts || allowedDepts.has(d.key))).map((d) => ({ key: d.key, name: d.name }));

    return {
      today,
      access: access.summary,
      grants,
      candidates,
      groups: groupRows.map((g) => ({ id: Number(g.id), name: g.name })),
      departments,
    };
  });

  // 新增排班授权（带操作编号幂等与作废围栏；不可转授）
  app.post('/api/oa/attendance/schedule-grants', { preHandler: guard() }, async (req, reply): Promise<ScheduleGrantSaved> => {
    const input = parse(CreateGrantInput, req.body);
    const store = currentStoreId();
    if (input.storeId !== store) throw conflict('STORE_SWITCHED', '这次授权是在别的门店页面发起的：请切回那家门店再试');
    const today = todayOf();
    const perms = normalizePerms(input.permissions);
    const validFrom = input.validFrom ?? today;
    const validTo = input.validTo ?? shiftDate(validFrom, SCHEDULE_GRANT_DEFAULT_DAYS);
    if (validTo < validFrom) throw unprocessable('GRANT_DATES', '截止日期不能早于开始日期');
    if (daysBetween(validFrom, validTo) > SCHEDULE_GRANT_MAX_DAYS) throw unprocessable('GRANT_TOO_LONG', `授权有效期最长 ${SCHEDULE_GRANT_MAX_DAYS} 天（约 2 年）`);
    if (validTo < today) throw unprocessable('GRANT_EXPIRED', '截止日期不能早于今天');
    if (input.granteeStaffId === req.actor.id) throw unprocessable('GRANT_SELF', '不能给自己授排班权限');

    const scopeGroupId = input.scopeType === 'group' ? (input.scopeGroupId ?? null) : null;
    const scopeDeptKey = input.scopeType === 'dept' || input.scopeType === 'dept_tree' ? ((input.scopeDeptKey as OrgDepartment | null) ?? null) : null;
    const scopeStaffIds = input.scopeType === 'staff' ? [...new Set(input.scopeStaffIds ?? [])].sort((a, b) => a - b) : null;
    if (input.scopeType === 'group' && !scopeGroupId) throw unprocessable('GRANT_SCOPE', '请选择要授权的考勤组');
    if ((input.scopeType === 'dept' || input.scopeType === 'dept_tree') && !scopeDeptKey) throw unprocessable('GRANT_SCOPE', '请选择要授权的部门');
    if (input.scopeType === 'staff' && (!scopeStaffIds || scopeStaffIds.length === 0)) throw unprocessable('GRANT_SCOPE', '请至少选择一位范围员工');

    const hash = hashRequest({
      staffId: req.actor.id,
      storeId: store,
      granteeStaffId: input.granteeStaffId,
      permissions: perms,
      scopeType: input.scopeType,
      scopeGroupId,
      scopeDeptKey,
      scopeStaffIds,
      validFrom,
      validTo,
      note: input.note,
    });

    const out = await sql.begin(async (tx): Promise<{ id: number; replayed: boolean; isHr: boolean }> => {
      await lockOpKey(tx, input.clientKey);
      const [seen] = await tx<{ opType: string; requestHash: string; refId: number; staffId: number }[]>`
        SELECT op_type, request_hash, ref_id, staff_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
      if (seen) {
        if (Number(seen.staffId) !== req.actor.id && !can(req.actor, 'hr.attendance')) throw forbidden('该操作编号属于他人，不能重提');
        if (seen.opType !== 'oa_schedule_grant' || seen.requestHash !== hash) {
          throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重试');
        }
        return { id: Number(seen.refId), replayed: true, isHr: can(req.actor, 'hr.attendance') };
      }
      await assertNotFenced(tx, input.clientKey, 'oa_schedule_grant', erpOpAbandoned);

      // 按员工 id 升序锁授权人与被授权人（FOR SHARE），与调岗 / 离职串行且不成环
      const pair = [req.actor.id, input.granteeStaffId].sort((a, b) => a - b);
      await tx`SELECT id FROM staff WHERE id IN ${tx(pair)} ORDER BY id FOR SHARE`;

      const depts = await loadDepts(tx);
      const builtIn = await resolveBuiltIn(tx, req.actor, depts, false);
      if (builtIn.role === 'none') {
        throw forbidden('只有考勤管理员或部门经理可以授出排班权限；获授权限不可转授');
      }
      const isHr = builtIn.role === 'hr';
      const capDepts = isHr ? null : builtIn.depts!;
      const capSet = capDepts ? new Set<OrgDepartment>(capDepts) : null;

      // 核对被授权人：本店在职员工、有岗位；部门经理只能授给本部门及下级部门员工
      const [grantee] = await tx<{ id: number; displayName: string; position: PositionKey | null; active: boolean; role: string; system: boolean; employmentStatus: string }[]>`
        SELECT s.id, s.display_name, s.position, s.active, s.role, s.system, coalesce(p.status, 'active') AS employment_status
        FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
        WHERE s.id = ${input.granteeStaffId} AND ${storeEmployee(tx)}`;
      if (!grantee || grantee.system || NOT_EMPLOYEE_ROLES.includes(grantee.role) || !grantee.active || grantee.employmentStatus === 'left') {
        throw unprocessable('GRANT_GRANTEE', '被授权人不是本店在职员工');
      }
      if (!grantee.position) throw unprocessable('GRANT_GRANTEE_POSITION', '被授权员工还没设定岗位，请先设定岗位再授权');
      const granteeDept = departmentOfPosition(grantee.position);
      if (capSet && (!granteeDept || !capSet.has(granteeDept))) {
        throw forbidden('部门经理只能授权给本部门及下级部门的员工');
      }

      // 按范围校验，确保部门经理无法越出自己的部门树
      if (input.scopeType === 'all_company') {
        if (!isHr) throw forbidden('部门经理不能授予全公司范围，请选本部门、考勤组或指定员工');
      } else if (input.scopeType === 'group') {
        const [grp] = await tx<{ id: number; name: string }[]>`SELECT id, name FROM oa_attendance_groups WHERE id = ${scopeGroupId!} AND store_id = ${store} AND active`;
        if (!grp) throw notFound('所选考勤组不存在或已停用');
        if (capSet) {
          const members = await tx<{ position: PositionKey | null }[]>`
            SELECT s.position FROM oa_group_members m JOIN staff s ON s.id = m.staff_id WHERE m.group_id = ${grp.id} AND ${storeEmployee(tx)}`;
          if (
            !members.some((m) => {
              const d = departmentOfPosition(m.position);
              return !!d && capSet.has(d);
            })
          ) {
            throw unprocessable('GRANT_SCOPE', '这个考勤组里目前没有本部门及下级部门的员工');
          }
        }
      } else if (input.scopeType === 'dept' || input.scopeType === 'dept_tree') {
        const deptRow = depts.find((d) => d.key === scopeDeptKey && d.key !== 'company');
        if (!deptRow) throw unprocessable('GRANT_SCOPE', '所选部门不存在');
        if (capSet && !capSet.has(scopeDeptKey!)) throw forbidden('不能授权本部门及下级部门以外的部门');
      } else if (input.scopeType === 'staff') {
        const targets = await tx<{ id: number; position: PositionKey | null }[]>`
          SELECT s.id, s.position FROM staff s WHERE s.id IN ${tx(scopeStaffIds!)} AND ${storeEmployee(tx)}`;
        if (targets.length !== scopeStaffIds!.length) throw unprocessable('GRANT_SCOPE', '指定员工中有人已离职或不在本店，请刷新后重选');
        if (
          capSet &&
          targets.some((t) => {
            const d = departmentOfPosition(t.position);
            return !d || !capSet.has(d);
          })
        ) {
          throw forbidden('指定员工中包含本部门及下级部门以外的人员');
        }
      }

      const [inserted] = await tx<{ id: number }[]>`
        INSERT INTO oa_schedule_grants
          (store_id, grantor_staff_id, grantee_staff_id, permissions, scope_type, scope_group_id, scope_dept_key,
           scope_staff_ids, scope_cap_depts, valid_from, valid_to, grantee_position, note, client_key)
        VALUES
          (${store}, ${req.actor.id}, ${grantee.id}, ${perms}::text[], ${input.scopeType}, ${scopeGroupId}, ${scopeDeptKey},
           ${scopeStaffIds}::bigint[], ${capDepts}::text[],
           ${validFrom}::date, ${validTo}::date, ${grantee.position}, ${input.note}, ${input.clientKey})
        RETURNING id`;
      const id = Number(inserted!.id);
      await tx`
        INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id)
        VALUES (${input.clientKey}, 'oa_schedule_grant', ${hash}, ${id}, ${req.actor.id})`;

      const permText = perms.map((p) => SCHEDULE_GRANT_PERM_LABELS[p]).join('、');
      const [hydrated] = await hydrateGrants(tx, await queryGrantRows(tx, tx`g.id = ${id}`), today, req.actor.id, isHr);
      const scopeText = hydrated ? scopeSummaryText(hydrated) : SCHEDULE_SCOPE_LABELS[input.scopeType];
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_schedule_grant_created',
        targetType: 'oa_schedule_grant',
        targetId: id,
        detail: {
          grantId: id,
          granteeStaffId: grantee.id,
          granteeName: grantee.displayName,
          granteePosition: grantee.position,
          permissions: perms,
          scopeType: input.scopeType,
          scopeGroupId,
          scopeDeptKey,
          scopeStaffIds,
          scopeCapDepts: capDepts,
          validFrom,
          validTo,
          note: input.note,
          summary: `排班授权给「${grantee.displayName}」：${permText}，范围 ${scopeText}，有效期 ${validFrom} 至 ${validTo}`,
        },
        ip: req.ip,
      });
      await notify(tx, [grantee.id], {
        kind: 'system',
        title: '收到排班授权',
        body: `${req.actor.displayName} 授予你${permText}权限（${scopeText}，有效期至 ${validTo}，调岗自动失效、不可转授）`,
        link: '/oa/schedule/manage',
        ref: { type: 'oa_schedule_grant', id },
      });
      return { id, replayed: false, isHr };
    });

    const [grant] = await hydrateGrants(sql, await queryGrantRows(sql, sql`g.id = ${out.id}`), today, req.actor.id, out.isHr);
    if (!out.replayed) reply.code(201);
    return { grant: grant!, replayed: out.replayed };
  });

  // 撤销排班授权（考勤管理员可撤本店任意条，部门经理可撤自己授出的）
  app.delete('/api/oa/attendance/schedule-grants/:id', { preHandler: guard() }, async (req): Promise<{ grant: ScheduleGrant }> => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(RevokeInput, req.body ?? {});
    const store = currentStoreId();
    const today = todayOf();

    const isHr = await sql.begin(async (tx): Promise<boolean> => {
      const depts = await loadDepts(tx);
      const builtIn = await resolveBuiltIn(tx, req.actor, depts, false);
      if (!builtIn.active || builtIn.role === 'none') {
        throw forbidden('只有考勤管理员或部门经理可以撤销排班授权');
      }
      const [row] = await tx<{ id: number; grantorStaffId: number; granteeStaffId: number; revokedAt: Date | null }[]>`
        SELECT id, grantor_staff_id, grantee_staff_id, revoked_at FROM oa_schedule_grants
        WHERE id = ${id} AND store_id = ${store} FOR UPDATE`;
      if (!row) throw notFound('排班授权记录不存在');
      const hr = builtIn.role === 'hr';
      if (!hr && Number(row.grantorStaffId) !== req.actor.id) {
        throw forbidden('只能撤销自己授出的排班授权（考勤管理员可撤销全店授权）');
      }
      if (row.revokedAt) throw conflict('GRANT_ALREADY_REVOKED', '这条排班授权已经撤销过了');
      await tx`
        UPDATE oa_schedule_grants
        SET revoked_at = now(), revoked_by = ${req.actor.id}, revoke_reason = ${reason || null}
        WHERE id = ${id}`;
      const [grantee] = await tx<{ displayName: string }[]>`SELECT display_name FROM staff WHERE id = ${row.granteeStaffId}`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_schedule_grant_revoked',
        targetType: 'oa_schedule_grant',
        targetId: id,
        detail: {
          grantId: id,
          granteeStaffId: Number(row.granteeStaffId),
          granteeName: grantee?.displayName ?? '',
          reason,
          summary: `撤销「${grantee?.displayName ?? `#${row.granteeStaffId}`}」的排班授权${reason ? `（${reason}）` : ''}`,
        },
        ip: req.ip,
      });
      return hr;
    });

    const [grant] = await hydrateGrants(sql, await queryGrantRows(sql, sql`g.id = ${id}`), today, req.actor.id, isHr);
    return { grant: grant! };
  });
}
