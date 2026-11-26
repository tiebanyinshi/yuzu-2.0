// 业财法 P07 的纯规则（不连库）：凭证必备、审批链不看金额、出纳三项复核、分摊（尾差、合计 100%）。

import { describe, expect, it } from 'vitest';
import { allocate, cashierMismatch, hrTemplate, missingEvidence } from '../src/shared/govflow-hr';
import { nodeLabel } from '../src/shared/govflow';

describe('HR 批次', () => {
  it('工资、提成要主责部门确认；常规与异常一样都是财总＋CFO，不转董事长', () => {
    expect(hrTemplate('salary').map(nodeLabel)).toEqual(['部门负责人', '人力资源', '财务审核人', '财总＋CFO 共同审批', '出纳']);
    expect(hrTemplate('cash_benefit').map(nodeLabel)).toEqual(['人力资源', '财务审核人', '财总＋CFO 共同审批', '出纳']);
    expect(hrTemplate('supplement').map(nodeLabel)).not.toContain('董事长');
  });
  it('只有总额表不够：按类型必备凭证', () => {
    expect(missingEvidence('salary', ['total_sheet'])).toEqual(['payroll_sheet', 'attendance', 'social_tax_account']);
    expect(missingEvidence('commission', ['performance_confirm', 'commission_rules', 'calc_detail'])).toEqual([]);
    expect(missingEvidence('separation', ['original_batch'])).toEqual(['abnormal_reason', 'diff_detail']);
  });
  it('出纳复核：人数、总额、账户三者都要一致', () => {
    const b = { headcount: 3, totalCents: 1000, accountsDigest: 'x' };
    expect(cashierMismatch(b, b)).toEqual([]);
    expect(cashierMismatch(b, { ...b, headcount: 2, accountsDigest: 'y' }).length).toBe(2);
  });
});

describe('分摊', () => {
  it('按比例分，尾差给最后一个，合计等于原金额；比例合计不是 100% 报错', () => {
    expect(
      allocate(1000, [
        { departmentId: 1, bp: 3333 },
        { departmentId: 2, bp: 3333 },
        { departmentId: 3, bp: 3334 },
      ]),
    ).toEqual([
      { departmentId: 1, cents: 333 },
      { departmentId: 2, cents: 333 },
      { departmentId: 3, cents: 334 },
    ]);
    expect(() => allocate(1000, [{ departmentId: 1, bp: 5000 }])).toThrow();
  });
});
