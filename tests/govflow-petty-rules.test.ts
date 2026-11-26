// 业财法 P03 的纯规则（不连库）：3,000 元 / 50 件分级、部门日 1 万 / 月 5 万、80% / 90% 预警、采购部门日累计 1 万，都卡整值前后一分钱。

import { describe, expect, it } from 'vitest';
import { pettyAllowed, pettyTemplate, pettyTier, purchaseDeptCheck, quotaCheck } from '../src/shared/govflow-petty';

describe('零星采购分级', () => {
  it('3,000.00 元且 50 件基础审核；3,000.01 或 51 件超出', () => {
    expect(pettyTier(300_000, 50)).toBe('basic');
    expect(pettyTier(300_001, 50)).toBe('enhanced');
    expect(pettyTier(300_000, 51)).toBe('enhanced');
    expect(pettyTier(299_999, 1)).toBe('basic');
  });
  it('只有一般物资走零星快速通道', () => {
    expect(pettyAllowed('goods')).toBe(true);
    for (const k of ['contract', 'engineering', 'service_outsource', 'prepay', 'fixed_asset'] as const) expect(pettyAllowed(k)).toBe(false);
  });
  it('超出只加审核内容不加层级；超额加一级合并特批', () => {
    expect(pettyTemplate({ needSpecial: false })).toHaveLength(2);
    expect(pettyTemplate({ needSpecial: true }).at(-1)).toMatchObject({ kind: 'all', roles: ['finance_chief', 'cfo'] });
  });
});

describe('部门额度', () => {
  const base = { dailyLimit: 1_000_000, monthlyLimit: 5_000_000, dayTaken: 0, monthTaken: 0 };
  it('日 1 万：用到 10,000.00 不超，多一分超', () => {
    expect(quotaCheck({ ...base, dayTaken: 999_999, amount: 1 }).needSpecial).toBe(false);
    expect(quotaCheck({ ...base, dayTaken: 1_000_000, amount: 1 })).toMatchObject({ overDaily: true, needSpecial: true, overCents: 1 });
  });
  it('月 5 万：49,999.99 + 0.01 不超，再多一分超；日、月都超只算一次，超出按超得多的算', () => {
    expect(quotaCheck({ ...base, monthTaken: 4_999_999, amount: 1 }).overMonthly).toBe(false);
    expect(quotaCheck({ ...base, monthTaken: 5_000_000, amount: 1 }).overMonthly).toBe(true);
    const both = quotaCheck({ ...base, dayTaken: 990_000, monthTaken: 4_990_000, amount: 30_000 });
    expect(both).toMatchObject({ overDaily: true, overMonthly: true, needSpecial: true, overCents: 20_000 });
  });
  it('预警：79.99% 没有，80% 起 80，90% 起 90', () => {
    expect(quotaCheck({ ...base, amount: 799_999 }).warn).toBe(null);
    expect(quotaCheck({ ...base, amount: 800_000 }).warn).toBe(80);
    expect(quotaCheck({ ...base, amount: 900_000 }).warn).toBe(90);
  });
});

describe('采购部门日累计', () => {
  it('10,000.00 不超；多一分：非紧急转正式、紧急要特批', () => {
    expect(purchaseDeptCheck(999_999, 1, false)).toBe('ok');
    expect(purchaseDeptCheck(1_000_000, 1, false)).toBe('formal');
    expect(purchaseDeptCheck(1_000_000, 1, true)).toBe('special');
  });
});
