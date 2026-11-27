// 线范围检查认员工小程序线（docs/STAFF_MP.md 第 7 节）：标题【员工小程序线】或同名标签的 PR 只改员工小程序线的目录与登记处；
// 小程序线与员工小程序线互相不改对方的文件；主线改到员工小程序线的目录只提醒。

import { describe, expect, it } from 'vitest';
// @ts-expect-error 检查脚本是 .mjs，没有类型声明
import { classify, classifyStaff, isMpLinePr, isStaffLinePr, parseNameStatus, report } from '../scripts/check-line-scope.mjs';

const kind = (status: string, path: string, from?: string): string => classifyStaff({ status, path, from }).kind;

describe('员工小程序线的 PR', () => {
  it('按标题或标签认，不按分支（分支照旧是 claude/*）', () => {
    expect(isStaffLinePr({ title: '【员工小程序线】A 端口与登录', labels: [] })).toBe(true);
    expect(isStaffLinePr({ title: '端口', labels: ['员工小程序线'] })).toBe(true);
    expect(isStaffLinePr({ title: '【主线】8.2.6', labels: ['主线'] })).toBe(false);
    expect(isStaffLinePr({ title: '【小程序线】领券', labels: ['小程序线'] })).toBe(false);
    expect(isMpLinePr({ branch: 'claude/x', title: '【员工小程序线】A', labels: [] })).toBe(false);
  });

  it('自己的目录、文件、用例、文档、回滚脚本', () => {
    for (const p of [
      'staff-miniprogram/src/app.ts',
      'src/server/modules/staffmp/app.ts',
      'src/client/features/staffmp/StaffMpSection.tsx',
      'src/shared/staffmp.ts',
      'compose.staffmp.yaml',
      'tests/staffmp-port.test.ts',
      'docs/STAFF_MP.md',
      'docs/HANDOFF_STAFFMP' + '1.md',
      'docs/rollback/610_staffmp_bindings.down.sql',
    ])
      expect(kind('M', p), p).toBe('free');
  });

  it('登记处允许、列出来复核；不能删', () => {
    for (const p of [
      'src/server/app.ts',
      'src/server/index.ts',
      'src/server/config.ts',
      'src/shared/admin.ts',
      'src/server/modules/oa/index.ts',
      'src/server/modules/canteen/index.ts',
      'src/server/modules/patrol/index.ts',
      'docs/LOCKING.md',
      'docs/DATA_DICTIONARY.md',
      '.github/workflows/ci.yml',
      'docs/ROADMAP.md',
    ])
      expect(kind('M', p), p).toBe('registry');
    expect(kind('D', 'src/server/index.ts')).toBe('blocked');
    expect(kind('M', 'GEMINI.md')).toBe('blocked');
  });

  it('迁移：只能新加 NNN_staffmp_<用途>.sql；改别的迁移、小程序线的迁移名都不行', () => {
    expect(kind('A', 'src/server/migrations/611_staffmp_canteen_links.sql')).toBe('migration');
    expect(kind('A', 'src/server/migrations/611_mp_x.sql')).toBe('blocked');
    expect(kind('M', 'src/server/migrations/610_staffmp_bindings.sql')).toBe('blocked');
  });

  it('核心、小程序线的文件一律拦下', () => {
    for (const p of ['src/server/modules/wallet.ts', 'src/server/modules/oa/punches.ts', 'src/server/modules/training.ts', 'miniprogram/src/app.ts', 'src/gateway/index.ts', 'src/shared/mp.ts'])
      expect(kind('M', p), p).toBe('blocked');
  });

  it('小程序线也不能改员工小程序线的文件', () => {
    expect(classify({ status: 'M', path: 'staff-miniprogram/src/app.ts' }).kind).toBe('blocked');
    expect(classify({ status: 'M', path: 'src/server/modules/staffmp/app.ts' }).kind).toBe('blocked');
  });

  it('报告：员工小程序线越界的不通过；主线改到员工小程序线的只提醒', () => {
    const bad = report({ branch: 'claude/x', title: '【员工小程序线】x', labels: [] }, parseNameStatus('M\tsrc/server/modules/staffmp/app.ts\nM\tsrc/server/modules/wallet.ts'));
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('员工小程序线的 PR 改了 1 个不该改的文件');
    const good = report({ branch: 'claude/x', title: '【员工小程序线】x', labels: [] }, parseNameStatus('M\tsrc/server/modules/staffmp/app.ts\nM\tsrc/server/app.ts'));
    expect(good.ok).toBe(true);
    const mainline = report({ branch: 'claude/y', title: '【主线】y', labels: [] }, parseNameStatus('M\tstaff-miniprogram/src/app.ts'));
    expect(mainline.ok).toBe(true);
    expect(mainline.text).toContain('不是小程序线的 PR');
    expect(mainline.text).toContain('员工小程序线的文件');
  });
});
