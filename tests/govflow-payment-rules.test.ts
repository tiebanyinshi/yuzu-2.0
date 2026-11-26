// 业财法 P05 的纯规则（不连库）：付款分路、必须签合同的 1 万线、无合同高额 5 万线（整值前后一分钱）、先票后款、重复支付、账户在审。

import { describe, expect, it } from 'vitest';
import { routePayment, type PaymentFacts } from '../src/shared/govflow-payment';

const f = (over: Partial<PaymentFacts>): PaymentFacts => ({
  hasContract: true,
  contractValid: true,
  category: 'service',
  amountCents: 100_000,
  remainingCents: 1_000_000,
  hasAcceptanceBasis: true,
  prepay: false,
  invoice: 'received',
  accountChangePending: false,
  abnormal: false,
  emergency: false,
  ...over,
});
const roles = (r: ReturnType<typeof routePayment>) => r.nodes.map((n) => (n.kind === 'role' ? n.role : n.kind));

describe('付款分路', () => {
  it('正常付款：部门负责人 → 财务 → 出纳；异常的加 CFO', () => {
    expect(roles(routePayment(f({})))).toEqual(['dept_head', 'finance_reviewer', 'cashier']);
    expect(roles(routePayment(f({ abnormal: true })))).toEqual(['dept_head', 'finance_reviewer', 'cfo', 'cashier']);
  });
  it('剩余应付：正好付完可以，多一分拦截', () => {
    expect(routePayment(f({ amountCents: 1_000_000 })).blockers).toEqual([]);
    expect(routePayment(f({ amountCents: 1_000_001 })).blockers.join()).toContain('重复支付');
  });
  it('合同无效、没有验收依据（非预付）、账户在审都拦截', () => {
    expect(routePayment(f({ contractValid: false })).blockers.length).toBe(1);
    expect(routePayment(f({ hasAcceptanceBasis: false })).blockers.length).toBe(1);
    expect(routePayment(f({ hasAcceptanceBasis: false, prepay: true })).blockers.length).toBe(0);
    expect(routePayment(f({ accountChangePending: true })).blockers.join()).toContain('账户');
  });
  it('先票后款：只有预付款可以不先取票', () => {
    expect(routePayment(f({ invoice: 'not_required' })).blockers.length).toBe(1);
    expect(routePayment(f({ invoice: 'not_required', prepay: true })).blockers.length).toBe(0);
    expect(routePayment(f({ invoice: 'later' })).blockers.length).toBe(0);
  });
});

describe('无合同付款', () => {
  const nc = (over: Partial<PaymentFacts>) => f({ hasContract: false, contractValid: false, remainingCents: null, ...over });
  it('采购 / 服务 / 工程：9,999.99 可以，10,000.00 必须签合同；其他类别不受限', () => {
    expect(routePayment(nc({ category: 'engineering', amountCents: 999_999 })).blockers).toEqual([]);
    expect(routePayment(nc({ category: 'engineering', amountCents: 1_000_000 })).blockers.join()).toContain('必须签合同');
    expect(routePayment(nc({ category: 'rent', amountCents: 1_000_000 })).blockers).toEqual([]);
  });
  it('49,999.99 走普通链，50,000.00 起 CFO → CEO → 董事长', () => {
    expect(routePayment(nc({ category: 'tax', amountCents: 4_999_999 })).path).toBe('no_contract');
    const high = routePayment(nc({ category: 'tax', amountCents: 5_000_000 }));
    expect(high.path).toBe('no_contract_high');
    expect(roles(high)).toEqual(['dept_head', 'finance_reviewer', 'cfo', 'entity_head', 'chairman', 'cashier']);
  });
  it('紧急特批只要出纳独立核验', () => {
    expect(roles(routePayment(nc({ emergency: true })))).toEqual(['cashier']);
  });
});
