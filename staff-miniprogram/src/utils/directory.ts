// 通讯录（docs/STAFF_MP.md 第 2.4 节）：按部门分组；搜姓名、工号、手机号（打码的不按手机号搜，与门店系统 matchPerson 同一口径）。
// 手机号谁能看由门店系统定（看不到的给打码的）；打码的不能直接拨。

import type { Directory, DirectoryPerson } from '../../../src/shared/oa-directory';

export function matchPerson(p: DirectoryPerson, q: string): boolean {
  const k = q.trim().toLowerCase();
  if (!k) return true;
  return p.name.toLowerCase().includes(k) || (p.empNo ?? '').toLowerCase().includes(k) || (!p.phoneMasked && (p.phone ?? '').includes(k));
}

export interface PersonRow {
  id: number;
  name: string;
  /** 头像上写的姓名首字 */
  initial: string;
  sub: string;
  phone: string;
  callable: boolean;
  head: boolean;
}

export interface DeptGroup {
  key: string;
  name: string;
  people: PersonRow[];
}

/** 按部门分组（部门的顺序照门店系统给的，主管排在前面）；没有部门的放最后 */
export function directoryGroups(dir: Directory, q = ''): DeptGroup[] {
  const people = dir.people.filter((p) => matchPerson(p, q));
  const order = dir.departments.map((d) => ({ key: d.key as string, name: d.name }));
  const groups: DeptGroup[] = [];
  const rowOf = (p: DirectoryPerson): PersonRow => ({
    id: p.staffId,
    name: p.name,
    initial: p.name.trim().charAt(0) || '·',
    sub: [p.positionName, p.empNo ? `工号 ${p.empNo}` : ''].filter(Boolean).join(' · '),
    phone: p.phone ?? '',
    callable: !!p.phone && !p.phoneMasked,
    head: p.headOf.length > 0,
  });
  for (const d of order) {
    const list = people.filter((p) => p.department === d.key);
    if (list.length) groups.push({ key: d.key, name: d.name, people: list.sort((a, b) => Number(b.headOf.length > 0) - Number(a.headOf.length > 0)).map(rowOf) });
  }
  const rest = people.filter((p) => !p.department || !order.some((d) => d.key === p.department));
  if (rest.length) groups.push({ key: '_none', name: '其他', people: rest.map(rowOf) });
  return groups;
}
