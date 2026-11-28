// 工作台的入口（src/utils/entries.ts）：只列这个人能用的、已经做到小程序里的；按组排；按名字或认的词搜。

import { describe, expect, it } from 'vitest';
import { ENTRIES, entryGroups } from '../src/utils/entries';

describe('入口', () => {
  it('每个入口的名字、图标、组都写了；键不重复', () => {
    expect(new Set(ENTRIES.map((e) => e.key)).size).toBe(ENTRIES.length);
    for (const e of ENTRIES) expect(e.label && e.icon && e.group, e.key).toBeTruthy();
  });

  it('只列能用的、已经做到小程序里的，按组排', () => {
    const groups = entryGroups(['knowledge', 'punch', 'payslips']);
    const keys = groups.flatMap((g) => g.entries.map((x) => x.key));
    for (const k of keys) expect(ENTRIES.find((e) => e.key === k)!.page).not.toBeNull();
    expect(keys).toContain('knowledge');
    expect(entryGroups([])).toEqual([]);
  });

  it('搜：名字或认的词都行', () => {
    expect(entryGroups(['knowledge'], '培训').flatMap((g) => g.entries.map((e) => e.key))).toEqual(['knowledge']);
    expect(entryGroups(['knowledge'], '知识').length).toBe(1);
    expect(entryGroups(['knowledge'], '工资')).toEqual([]);
  });
});
