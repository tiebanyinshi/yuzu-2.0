// 业财法 P04 的纯规则（不连库）：经济实质判定与混合合同、全合同期口径、1 / 5 / 30 万档位（整值前后一分钱）、工程至少 CEO、变更是否保留原审批。

import { describe, expect, it } from 'vitest';
import { approvalAmount, changeKeepsApproval, classifyContract, contractFinals, contractTemplate, type ContractSubstance } from '../src/shared/govflow-contract';

const s = (over: Partial<ContractSubstance>): ContractSubstance => ({
  ownership: false,
  laborResult: false,
  construction: false,
  periodUse: false,
  jointOperation: false,
  equipmentInseparable: false,
  generalInstallOnly: false,
  frameworkOrdersPriced: false,
  hasAmount: true,
  ...over,
});

describe('按经济实质判定（场景 36）', () => {
  it('单一实质', () => {
    expect(classifyContract(s({ ownership: true })).type).toBe('purchase');
    expect(classifyContract(s({ laborResult: true })).type).toBe('service');
    expect(classifyContract(s({ construction: true })).type).toBe('engineering');
    expect(classifyContract(s({ periodUse: true })).type).toBe('lease');
    expect(classifyContract(s({ jointOperation: true })).type).toBe('cooperation');
    expect(classifyContract(s({ hasAmount: false })).type).toBe('no_amount');
  });
  it('混合合同的归并：施工附带设备不可分归工程、设备附带一般安装归采购、资产使用实质共同经营归经营合作、框架无价订单有价不归无金额', () => {
    expect(classifyContract(s({ construction: true, ownership: true, equipmentInseparable: true }))).toMatchObject({ type: 'engineering', splitAdvice: null });
    expect(classifyContract(s({ ownership: true, construction: true, generalInstallOnly: true }))).toMatchObject({ type: 'purchase', splitAdvice: null });
    expect(classifyContract(s({ periodUse: true, jointOperation: true }))).toMatchObject({ type: 'cooperation', splitAdvice: null });
    expect(classifyContract(s({ hasAmount: false, frameworkOrdersPriced: true })).type).toBe('purchase');
  });
  it('没有归并规则的混合：提示能拆则拆', () => {
    expect(classifyContract(s({ ownership: true, laborResult: true })).splitAdvice).toContain('拆');
  });
});

describe('金额口径', () => {
  it('租赁、经营合作按全合同期（每期 × 期数），没填期数报错', () => {
    expect(approvalAmount({ type: 'lease', totalExTaxCents: null, perPeriodExTaxCents: 1_000_000, periods: 36 })).toBe(36_000_000);
    expect(() => approvalAmount({ type: 'cooperation', totalExTaxCents: 100, perPeriodExTaxCents: null, periods: null })).toThrow();
    expect(approvalAmount({ type: 'no_amount', totalExTaxCents: null, perPeriodExTaxCents: null, periods: null })).toBe(0);
  });
});

describe('档位（场景 6–10、44）', () => {
  it.each([
    [999_999, ['finance_chief']],
    [1_000_000, ['cfo']],
    [4_999_999, ['cfo']],
    [5_000_000, ['entity_head']],
    [29_999_999, ['entity_head']],
    [30_000_000, ['chairman']],
  ])('%i 分 → %j', (cents, finals) => {
    expect(contractFinals('purchase', cents, [])).toEqual(finals);
  });
  it('重大风险 / 预付款 / 超预算至少 CFO', () => {
    expect(contractFinals('service', 100, ['prepay'])).toEqual(['cfo']);
  });
  it('工程任何金额至少 CEO；299,999.99 CEO 终审，300,000.00 起 CEO → 董事长', () => {
    expect(contractFinals('engineering', 100, [])).toEqual(['entity_head']);
    expect(contractFinals('engineering', 29_999_999, [])).toEqual(['entity_head']);
    expect(contractFinals('engineering', 30_000_000, [])).toEqual(['entity_head', 'chairman']);
  });
  it('链：部门负责人 → 履约执行人 → 财法并行 → 终审', () => {
    expect(contractTemplate('purchase', 100, []).map((n) => n.kind)).toEqual(['dept_head', 'performer', 'all', 'role']);
  });
});

describe('变更', () => {
  it('只减金额保留原审批；加金额或改了别的重新路由', () => {
    expect(changeKeepsApproval(['amount'], 1000, 999)).toBe(true);
    expect(changeKeepsApproval(['amount'], 1000, 1001)).toBe(false);
    expect(changeKeepsApproval(['amount', 'party'], 1000, 900)).toBe(false);
    expect(changeKeepsApproval(['scope'], 1000, 1000)).toBe(false);
  });
});
