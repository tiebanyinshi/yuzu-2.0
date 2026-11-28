// 前台「结果待确认」查回、作废走哪个地址（8.1.15，Codex 审查 f6327a4）：点单页的下单（挂账）走餐饮的地址——
// 下单只要「餐饮点单」，康美部没有前台权限；其余照旧走前台的。不要数据库。

import { describe, expect, it } from 'vitest';
import { CLIENT_ERROR_CODES } from '../src/shared/error-codes';
import { CASH_RULES_STALE_CODES, isCashierApproval, opsPath, pendingFor, type FrontdeskPendingOp } from '../src/client/features/frontdesk/pending';

describe('结果待确认的查回、作废地址', () => {
  it('点单页的下单走 /api/dining/ops；前台加项目、桌台点单、发牌照旧走 /api/frontdesk/ops', () => {
    expect(opsPath({ key: 'k1', type: 'bill_post', url: '/api/dining/orders' })).toBe('/api/dining/ops/k1');
    expect(opsPath({ key: 'k2', type: 'bill_post', url: '/api/frontdesk/visits/3/charges' })).toBe('/api/frontdesk/ops/k2');
    expect(opsPath({ key: 'k3', type: 'table_post', url: '/api/dining/tables/sessions/5/orders' })).toBe('/api/frontdesk/ops/k3');
    expect(opsPath({ key: 'k4', type: 'checkin', url: '/api/frontdesk/checkins' })).toBe('/api/frontdesk/ops/k4');
  });

  it('桌台动作（Codex 审查 9ef9424）：清台、维修、恢复按桌台认，并台、拆台按开台认', () => {
    const base = { url: '', body: {}, visitId: null, tagCodes: [], summary: '', amount: null, staffName: '', createdAt: '' };
    const list: FrontdeskPendingOp[] = [
      { ...base, key: 'a', type: 'table_state', tableId: 5 },
      { ...base, key: 'b', type: 'table_merge', sessionIds: [9] },
    ];
    expect(pendingFor(list, 'table_state', null, { tableId: 5 })?.key).toBe('a');
    expect(pendingFor(list, 'table_state', null, { tableId: 6 })).toBeUndefined();
    expect(pendingFor(list, 'table_merge', null, { sessionId: 9 })?.key).toBe('b');
    expect(pendingFor(list, 'table_merge', null, { sessionId: 8 })).toBeUndefined();
  });

  it('收银申请的批准（8.2.30 Codex 审查 06b2eee）：退款记作退款单、反结账记作 cashier_void_approve，按结账单认，走前台的查回地址', () => {
    const base = { body: {}, visitId: null, tagCodes: [], summary: '', amount: null, staffName: '', createdAt: '' };
    const list: FrontdeskPendingOp[] = [
      { ...base, key: 'r', type: 'checkout_refund', url: '/api/cashier-requests/7/approve', checkoutIds: [3] },
      { ...base, key: 'v', type: 'cashier_void_approve', url: '/api/cashier-requests/8/approve', checkoutIds: [4] },
      { ...base, key: 'd', type: 'checkout_refund', url: '/api/frontdesk/checkouts/5/refunds', checkoutIds: [5] },
    ];
    expect(list.filter(isCashierApproval).map((p) => p.key)).toEqual(['r', 'v']);
    expect(pendingFor(list, 'checkout_refund', null, { checkoutId: 3 })?.key).toBe('r');
    expect(pendingFor(list, 'cashier_void_approve', null, { checkoutId: 4 })?.key).toBe('v');
    expect(pendingFor(list, 'cashier_void_approve', null, { checkoutId: 3 })).toBeUndefined();
    expect(opsPath(list[1]!)).toBe('/api/frontdesk/ops/v');
  });

  it('结账因港元规则变了被拒（汇率改了、停收港元）：重新取收银台规则（8.2.30 Codex 审查 1d6d77e）', () => {
    expect([...CASH_RULES_STALE_CODES].sort()).toEqual(['HKD_DISABLED', 'HKD_RATE_CHANGED']);
    for (const c of CASH_RULES_STALE_CODES) expect(CLIENT_ERROR_CODES).toHaveProperty(c);
  });
});
