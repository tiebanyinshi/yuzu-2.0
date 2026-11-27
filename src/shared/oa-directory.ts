// OA-16 通讯录（docs/OA.md 第 19 节）：部门树、员工资料卡、手机号可见范围。服务端与页面共用。

import type { OrgDepartment, PositionKey } from './positions';

/** 手机号谁能看（OA19）：managers 主管以上（默认）/ all 所有员工 / hr 只有管组织架构的人；自己的总能看 */
export type DirectoryPhoneScope = 'managers' | 'all' | 'hr';
export const DIRECTORY_PHONE_SCOPES: readonly { value: DirectoryPhoneScope; label: string }[] = [
  { value: 'managers', label: '主管以上（部门主管、管组织架构的人）' },
  { value: 'all', label: '所有员工' },
  { value: 'hr', label: '只有管组织架构的人' },
];
export const DEFAULT_DIRECTORY_PHONE_SCOPE: DirectoryPhoneScope = 'managers';

export interface DirectoryPerson {
  staffId: number;
  name: string;
  empNo: string | null;
  department: OrgDepartment | null;
  position: PositionKey | null;
  positionName: string;
  /** 看不到的给打码的（138****0000），没填的为空 */
  phone: string | null;
  phoneMasked: boolean;
  /** 是哪个部门的主管 */
  headOf: OrgDepartment[];
}

export interface DirectoryDepartment {
  key: OrgDepartment;
  name: string;
  parentKey: OrgDepartment | null;
  headId: number | null;
  /** 没解散的部门群（我在里面才给编号，不在的只标有） */
  group: { id: number | null } | null;
  /** 我能不能建这个部门的部门群（管组织架构的人、部门主管） */
  canCreateGroup: boolean;
}

export interface Directory {
  departments: DirectoryDepartment[];
  people: DirectoryPerson[];
  phoneScope: DirectoryPhoneScope;
  /** 我能看别人的手机号 */
  canSeePhones: boolean;
  /** 我能改手机号的可见范围（管组织架构的人） */
  canConfigure: boolean;
}

export { maskPhoneCompact as maskPhone } from './mask';

/** 搜索：姓名、工号、手机号（打码的不按手机号搜） */
export function matchPerson(p: DirectoryPerson, q: string): boolean {
  const k = q.trim().toLowerCase();
  if (!k) return true;
  return p.name.toLowerCase().includes(k) || (p.empNo ?? '').toLowerCase().includes(k) || (!p.phoneMasked && (p.phone ?? '').includes(k));
}
