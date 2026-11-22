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
