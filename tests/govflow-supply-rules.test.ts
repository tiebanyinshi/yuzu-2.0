// 业财法 P02 的纯规则（不连库）：统一社会信用代码校验位、资料必填与按品类触发、核心变更判定、SKU 异常（10% 卡整值前后一分钱）。

import { describe, expect, it } from 'vitest';
import { creditCodeProblem, isCoreChange, qualificationProblems, requiredQualifications, skuAbnormal, withCreditCheck } from '../src/shared/govflow-supply';

describe('统一社会信用代码', () => {
  it('真实格式的校验位算得对；改一位就不对', () => {
    const code = withCreditCheck('91440300MA5F00001');
    expect(creditCodeProblem(code)).toBeNull();
    expect(creditCodeProblem(code.toLowerCase())).toBeNull();
    const wrong = code.slice(0, 17) + (code[17] === '0' ? '1' : '0');
    expect(creditCodeProblem(wrong)).toContain('校验位');
    expect(creditCodeProblem('123')).toContain('18 位');
    expect(creditCodeProblem('91440300MA5F0000IO')).toContain('18 位');
  });
});

describe('资料', () => {
  it('统一必填 + 按品类触发', () => {
    expect(requiredQualifications(['general'])).toEqual(['business_license', 'bank_account_proof']);
    expect(requiredQualifications(['engineering', 'food'])).toEqual(['business_license', 'bank_account_proof', 'construction_qualification', 'safety_license', 'food_license']);
  });
  it('缺的、过期的列出来；当天到期还算有效', () => {
    const q = [
      { kind: 'business_license' as const, no: 'A', expiresOn: '2026-11-26' },
      { kind: 'bank_account_proof' as const, no: 'B', expiresOn: '2026-11-25' },
    ];
    expect(qualificationProblems(['food'], q, '2026-11-26')).toEqual(['「开户许可 / 银行账户证明」已过期（2026-11-25）', '缺「食品经营许可证」']);
  });
});

describe('核心变更', () => {
  it('主体、税号、收款账户算核心；电话、地址不算；资质只动了非核心的不算', () => {
    expect(isCoreChange(['bankAccount'])).toBe(true);
    expect(isCoreChange(['name', 'phone'])).toBe(true);
    expect(isCoreChange(['phone', 'address'])).toBe(false);
    const before = [{ kind: 'business_license' as const, no: 'A', expiresOn: null }];
    expect(isCoreChange(['qualifications'], before, [...before, { kind: 'product_certificate', no: 'P', expiresOn: null }])).toBe(false);
    expect(isCoreChange(['qualifications'], before, [{ kind: 'business_license', no: 'A2', expiresOn: null }])).toBe(true);
  });
});

describe('SKU 异常', () => {
  it('比同物料最低有效价高 10%：整值不算，多一分算', () => {
    expect(skuAbnormal({ priceCents: 2200, refCents: 2000, prevCents: null, core: false })).toEqual([]);
    expect(skuAbnormal({ priceCents: 2201, refCents: 2000, prevCents: null, core: false })).toEqual(['price_high']);
    expect(skuAbnormal({ priceCents: 100, refCents: null, prevCents: null, core: false })).toEqual([]);
  });
  it('核心品类、比上一版变动超过 10%（涨跌都算）', () => {
    expect(skuAbnormal({ priceCents: 100, refCents: null, prevCents: null, core: true })).toEqual(['core_category']);
    expect(skuAbnormal({ priceCents: 1100, refCents: null, prevCents: 1000, core: false })).toEqual([]);
    expect(skuAbnormal({ priceCents: 899, refCents: null, prevCents: 1000, core: false })).toEqual(['price_jump']);
  });
});
