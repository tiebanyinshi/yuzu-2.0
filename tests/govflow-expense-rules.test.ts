// 业财法 P06 的纯规则（不连库）：报销知会 2 万 / 5 万、招待 2 万 / 5 万（都是「超过」，整值不算、多一分算）、出差分路、用印分路。

import { describe, expect, it } from 'vitest';
import { entertainKeepsApproval, entertainTemplate, expenseCc, expenseTemplate, routeTravel, sealTemplate } from '../src/shared/govflow-expense';
import { nodeLabel } from '../src/shared/govflow';

const labels = (n: Parameters<typeof nodeLabel>[0][]) => n.map(nodeLabel);

describe('报销', () => {
  it('链不因金额升级；无票加财总复核', () => {
    expect(labels(expenseTemplate({ hasInvoice: true }))).toEqual(['部门负责人', '财务审核人', '出纳']);
    expect(labels(expenseTemplate({ hasInvoice: false }))).toEqual(['部门负责人', '财务审核人', '财总', '出纳']);
  });
  it('知会：20,000.00 不知会、20,000.01 CFO；50,000.00 CFO、50,000.01 CFO＋董事长', () => {
    expect(expenseCc(2_000_000)).toEqual([]);
    expect(expenseCc(2_000_001)).toEqual(['cfo']);
    expect(expenseCc(5_000_000)).toEqual(['cfo']);
    expect(expenseCc(5_000_001)).toEqual(['cfo', 'chairman']);
  });
});

describe('商务招待', () => {
  it('20,000.00 部门负责人 → 财务；20,000.01 加财总；50,000.01 再加 CFO；无事前申请至少财总', () => {
    expect(labels(entertainTemplate({ amountCents: 2_000_000, priorApplied: true }))).toEqual(['部门负责人', '财务审核人']);
    expect(labels(entertainTemplate({ amountCents: 2_000_001, priorApplied: true }))).toEqual(['部门负责人', '财务审核人', '财总']);
    expect(labels(entertainTemplate({ amountCents: 5_000_000, priorApplied: true }))).toEqual(['部门负责人', '财务审核人', '财总']);
    expect(labels(entertainTemplate({ amountCents: 5_000_001, priorApplied: true }))).toEqual(['部门负责人', '财务审核人', '财总', 'CFO']);
    expect(labels(entertainTemplate({ amountCents: 100, priorApplied: false }))).toEqual(['部门负责人', '财务审核人', '财总']);
  });
  it('金额、人数减少或不变不重审，任一增加要重审', () => {
    expect(entertainKeepsApproval(1000, 900, 5, 5)).toBe(true);
    expect(entertainKeepsApproval(1000, 1001, 5, 4)).toBe(false);
    expect(entertainKeepsApproval(1000, 900, 5, 6)).toBe(false);
  });
});

describe('出差', () => {
  const base = { amountCents: 100_000, remainingCents: 100_000, priorApplied: true, overStandard: false, majorAbnormal: false, overBudgetMode: null } as const;
  it('预算内（正好用完）部门负责人 → 财务；多一分超预算要选转下月或特批', () => {
    expect(labels(routeTravel(base).nodes)).toEqual(['部门负责人', '财务审核人']);
    expect(routeTravel({ ...base, amountCents: 100_001 }).blockers.length).toBe(1);
    expect(routeTravel({ ...base, amountCents: 100_001, overBudgetMode: 'defer' }).blockers).toEqual([]);
    expect(labels(routeTravel({ ...base, amountCents: 100_001, overBudgetMode: 'special' }).nodes)).toEqual(['部门负责人', '财务审核人', 'CFO', '财总＋CFO 特批（超部门差旅预算）']);
  });
  it('无事前申请 / 超标财总复核；重大异常 CFO；50 万及以上异常 CFO → CEO → 董事长', () => {
    expect(labels(routeTravel({ ...base, priorApplied: false }).nodes)).toEqual(['部门负责人', '财务审核人', '财总']);
    expect(labels(routeTravel({ ...base, majorAbnormal: true }).nodes)).toEqual(['部门负责人', '财务审核人', 'CFO']);
    expect(labels(routeTravel({ ...base, majorAbnormal: true, amountCents: 49_999_999, remainingCents: 99_999_999 }).nodes)).toEqual(['部门负责人', '财务审核人', 'CFO']);
    expect(labels(routeTravel({ ...base, majorAbnormal: true, amountCents: 50_000_000, remainingCents: 99_999_999 }).nodes)).toEqual(['部门负责人', '财务审核人', 'CFO', 'CEO', '董事长']);
  });
});

describe('用印证照', () => {
  it('已批合同没改动不重审；改过的按内容审；高风险到 CEO；空白文件财总＋CEO 特批', () => {
    expect(labels(sealTemplate({ kind: 'contract', contractUnchanged: true, highRisk: false }))).toEqual(['章证管理员']);
    expect(labels(sealTemplate({ kind: 'contract', contractUnchanged: false, highRisk: false }))).toEqual(['部门负责人', '财务、法务按内容审', '章证管理员']);
    expect(labels(sealTemplate({ kind: 'document', contractUnchanged: false, highRisk: true }))).toEqual(['部门负责人', '财务、法务按内容审', 'CEO', '章证管理员']);
    expect(labels(sealTemplate({ kind: 'blank', contractUnchanged: false, highRisk: false }))[1]).toContain('空白文件');
  });
});
