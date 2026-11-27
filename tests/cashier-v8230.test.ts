// 8.2.30 收银合并（docs/V8230_CASHIER.md）：
//   · 港元现金（CM-2、CM-3）：门店设了汇率才能收；汇率按页面看到的核对；折成的人民币不够拒绝；结账单金额照旧人民币，
//     找零给人民币；交班时应有现金扣掉港元折的人民币、另按港元对实点（应有港元 = 实给的港元）；
//   · 交班盲点与大额找零是页面的事，规则能存能读（CM-4、CM-9）；
//   · 收银申请（CM-5、CM-6）：没权限的店员申请退款、反结账；有权限的人批准时按当时的数据走原来的退款单 / 反结账执行，
//     结果通知申请人；同一张结账单只能有一张待审批；有待审批时不能直接退款、反结账；单子变了的记失效；24 小时没人批自动失效；
//     不能批自己的；能撤回；同一操作编号重提不重复。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hkdDue, hkdWorth } from '../src/shared/cashier-v8230';
import { sweepCashierRequests } from '../src/server/modules/frontdesk/cashier-requests';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let dutyId: number;
let tagNo = 0;

const RATE = 920_000; // 1 港元 = 0.92 人民币

const sale = async (payments: (total: number) => Record<string, unknown>[], cookie = ctx.clerk) => {
  tagNo += 1;
  const code = `H${String(tagNo).padStart(3, '0')}`;
  const v = await api(ctx.app, cookie, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.visits[0].id as number;
  const pre = (await api(ctx.app, cookie, 'GET', `/api/frontdesk/checkout-preview?ids=${id}`)).body;
  const c = await api(ctx.app, cookie, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [id], expectedTotal: pre.totalAmount, payments: payments(pre.totalAmount) });
  return { res: c, total: pre.totalAmount as number, visitId: id };
};
const shiftOf = async (cookie: string) =>
  (await api(ctx.app, cookie, 'GET', '/api/shifts/current')).body.shift as {
    id: number;
    summary: { cash: { expected: number; checkout: number; hkd?: number }; hkd?: { count: number; expected: number; worth: number } };
  };
const notices = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/oa/notifications')).body;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  dutyId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'duty'`)[0]!.id);
  duty = await login(ctx.app, 'duty');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'H', from: 1, to: 60, width: 3, zone: 'male' })).status).toBe(200);
  expect((await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 50000 })).status).toBe(200);
  expect((await api(ctx.app, duty, 'POST', '/api/shifts', { openingCash: 0 })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('港元现金', () => {
  it('折算：实给的港元向下折人民币，应收向上折港元', () => {
    expect(hkdWorth(20000, RATE)).toBe(18400);
    expect(hkdDue(49900, RATE)).toBe(54240); // 499 / 0.92 = 542.391… → 542.40
    expect(hkdWorth(hkdDue(49900, RATE), RATE)).toBeGreaterThanOrEqual(49900);
  });

  it('门店没设汇率不能收港元；规则能存能读', async () => {
    const r = await sale((t) => [{ method: 'cash', amount: t, hkd: { tendered: 60000, ratePpm: RATE } }]);
    expect(r.res.status).toBe(422);
    expect(r.res.body.error.code).toBe('HKD_DISABLED');
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/frontdesk/rules', { hkdRatePpm: RATE })).status).toBe(403);
    const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { hkdRatePpm: RATE, bigChangeCents: 30000, shiftBlind: true });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ hkdRatePpm: RATE, bigChangeCents: 30000, shiftBlind: true });
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { hkdRatePpm: 50 })).status).toBe(400);
    // 别的规则没被冲掉
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/rules')).body).toMatchObject({ selfVoidMinutes: 15, hkdRatePpm: RATE });
  });

  it('只有现金能带港元；汇率过时、港元不够都拒绝', async () => {
    // 结账失败会留下在店的客人：用同一张牌再试一次之前先结掉，这里每次都换新牌（sale 自动编号）
    const wrongMethod = await sale((t) => [{ method: 'wechat', amount: t, hkd: { tendered: 60000, ratePpm: RATE } }]);
    expect(wrongMethod.res.status).toBe(400);
    const stale = await sale((t) => [{ method: 'cash', amount: t, hkd: { tendered: 60000, ratePpm: 900_000 } }]);
    expect(stale.res.status).toBe(409);
    expect(stale.res.body.error.code).toBe('HKD_RATE_CHANGED');
    const short = await sale((t) => [{ method: 'cash', amount: t, hkd: { tendered: hkdDue(t, RATE) - 1, ratePpm: RATE } }]);
    expect(short.res.status).toBe(422);
    expect(short.res.body.error.code).toBe('HKD_SHORT');
  });

  it('收港元：结账单按人民币，记实给的港元、汇率与找的人民币；交班扣掉港元折的人民币、另对港元', async () => {
    const before = await shiftOf(ctx.clerk);
    const r = await sale((t) => [{ method: 'cash', amount: t, hkd: { tendered: 60000, ratePpm: RATE } }]);
    expect(r.res.status, JSON.stringify(r.res.body)).toBe(200);
    expect(r.res.body.totalAmount).toBe(r.total);
    const [p] = await ctx.sql<{ amount: number; fxTendered: number; fxRatePpm: number; fxWorth: number; fxChange: number }[]>`
      SELECT amount, fx_tendered, fx_rate_ppm, fx_worth, fx_change FROM checkout_payments WHERE checkout_id = ${r.res.body.id}`;
    expect(p).toEqual({ amount: r.total, fxTendered: 60000, fxRatePpm: RATE, fxWorth: 55200, fxChange: 55200 - r.total });
    const after = await shiftOf(ctx.clerk);
    // 结账现金照旧按人民币算进来，港元折的 552.00（收款 + 找零）从应有现金扣掉：钱箱里人民币少了找零，多了港元
    expect(after.summary.cash.checkout - before.summary.cash.checkout).toBe(r.total);
    expect(after.summary.cash.hkd).toBe(55200);
    expect(after.summary.cash.expected - before.summary.cash.expected).toBe(r.total - 55200);
    expect(after.summary.hkd).toEqual({ count: 1, expected: 60000, worth: 55200 });
  });

  it('交班：收过港元要填实点港元，看到的应有港元要对；记下应有与实点', async () => {
    const s = await shiftOf(ctx.clerk);
    const noHkd = await api(ctx.app, ctx.clerk, 'POST', `/api/shifts/${s.id}/close`, { countedCash: s.summary.cash.expected, expectedCash: s.summary.cash.expected });
    expect(noHkd.status).toBe(400);
    const stale = await api(ctx.app, ctx.clerk, 'POST', `/api/shifts/${s.id}/close`, {
      countedCash: s.summary.cash.expected,
      expectedCash: s.summary.cash.expected,
      countedHkd: 60000,
      expectedHkd: 50000,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('SHIFT_CHANGED');
    const ok = await api(ctx.app, ctx.clerk, 'POST', `/api/shifts/${s.id}/close`, {
      countedCash: s.summary.cash.expected,
      expectedCash: s.summary.cash.expected,
      countedHkd: 59000,
      expectedHkd: 60000,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'closed', expectedHkd: 60000, countedHkd: 59000 });
    // 没收过港元的班次不用填
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 })).status).toBe(200);
    const s2 = await shiftOf(ctx.clerk);
    expect(s2.summary.hkd).toBeUndefined();
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { shiftBlind: false })).status).toBe(200);
  });
});

describe('收银申请', () => {
  let checkoutId: number;
  let reqId: number;

  it('没有权限的店员提交退款申请；值班经理收到待审批通知；同一操作编号重提不重复', async () => {
    const r = await sale((t) => [{ method: 'cash', amount: t }]);
    expect(r.res.status).toBe(200);
    checkoutId = r.res.body.id;
    // 店员直接开退款单没有权限，但能看能退多少
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/checkouts/${checkoutId}/refunds`, { clientKey: randomUUID(), items: [], payments: [], reason: '测试' })).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts/${checkoutId}/refund-options`)).status).toBe(200);
    const opts = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts/${checkoutId}/refund-options`)).body;
    const body = {
      clientKey: randomUUID(),
      kind: 'refund',
      checkoutId,
      refund: { items: [{ category: opts.items[0].category, name: opts.items[0].name, quantity: 0, amount: 1000 }], payments: [{ method: 'cash', amount: 1000 }], reason: '客人投诉水温' },
    };
    const s = await api(ctx.app, ctx.clerk, 'POST', '/api/cashier-requests', body);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toMatchObject({ kind: 'refund', status: 'pending', amount: 1000, checkoutId });
    reqId = s.body.id;
    const again = await api(ctx.app, ctx.clerk, 'POST', '/api/cashier-requests', body);
    expect(again.body.id).toBe(reqId);
    const n = await notices(duty);
    expect(JSON.stringify(n)).toContain(`退款申请待审批：${s.body.checkoutNo}`);
    // 同一张结账单不能再提一张
    const dup = await api(ctx.app, ctx.clerk, 'POST', '/api/cashier-requests', { clientKey: randomUUID(), kind: 'void', checkoutId, reason: '收错了' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('REQUEST_PENDING');
  });

  it('有待审批的申请时，有权限的人也不能直接退款、反结账；店员不能批自己的', async () => {
    const opts = (await api(ctx.app, duty, 'GET', `/api/frontdesk/checkouts/${checkoutId}/refund-options`)).body;
    const direct = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${checkoutId}/refunds`, {
      clientKey: randomUUID(),
      items: [{ category: opts.items[0].category, name: opts.items[0].name, quantity: 0, amount: 500 }],
      payments: [{ method: 'cash', amount: 500 }],
      reason: '直接退',
    });
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('REQUEST_PENDING');
    const v = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${checkoutId}/void`, { reason: '直接反结账' });
    expect(v.status).toBe(409);
    expect(v.body.error.code).toBe('REQUEST_PENDING');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/cashier-requests/${reqId}/approve`, { clientKey: randomUUID() })).status).toBe(403);
  });

  it('值班经理批准：按当时的数据开退款单（现金记到批准人的班次），申请人收到结果；重复批准不重复退', async () => {
    const before = await shiftOf(duty);
    const key = randomUUID();
    const a = await api(ctx.app, duty, 'POST', `/api/cashier-requests/${reqId}/approve`, { clientKey: key });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ status: 'approved', decidedByName: '值班经理' });
    expect(a.body.refundNo).toBeTruthy();
    const after = await shiftOf(duty);
    expect(before.summary.cash.expected - after.summary.cash.expected).toBe(1000);
    // 同一编号重提（回复丢了）：查回同一张退款单，不重复退；换编号再批：已经处理过了
    const again = await api(ctx.app, duty, 'POST', `/api/cashier-requests/${reqId}/approve`, { clientKey: key });
    expect(again.status).toBe(200);
    expect(again.body.refundNo).toBe(a.body.refundNo);
    const other = await api(ctx.app, duty, 'POST', `/api/cashier-requests/${reqId}/approve`, { clientKey: randomUUID() });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('REQUEST_DECIDED');
    const [cnt] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM refunds WHERE checkout_id = ${checkoutId} AND status = 'completed'`;
    expect(cnt!.n).toBe(1);
    expect(JSON.stringify(await notices(ctx.clerk))).toContain('已批准');
  });

  it('驳回要写原因、通知申请人；申请人能撤回自己的', async () => {
    const r = await sale((t) => [{ method: 'cash', amount: t }]);
    const s = await api(ctx.app, ctx.clerk, 'POST', '/api/cashier-requests', { clientKey: randomUUID(), kind: 'void', checkoutId: r.res.body.id, reason: '收款方式记错' });
    expect(s.status).toBe(200);
    expect(s.body.amount).toBe(r.total);
    expect((await api(ctx.app, duty, 'POST', `/api/cashier-requests/${s.body.id}/reject`, { note: '' })).status).toBe(400);
    const rej = await api(ctx.app, duty, 'POST', `/api/cashier-requests/${s.body.id}/reject`, { note: '客人已经走了，不用反结账' });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ status: 'rejected', decisionNote: '客人已经走了，不用反结账' });
    expect(JSON.stringify(await notices(ctx.clerk))).toContain('被驳回');
    const s2 = await api(ctx.app, ctx.clerk, 'POST', '/api/cashier-requests', { clientKey: randomUUID(), kind: 'void', checkoutId: r.res.body.id, reason: '再申请一次' });
    expect(s2.status).toBe(200);
    expect((await api(ctx.app, duty, 'POST', `/api/cashier-requests/${s2.body.id}/cancel`, {})).status).toBe(403);
    const c = await api(ctx.app, ctx.clerk, 'POST', `/api/cashier-requests/${s2.body.id}/cancel`, {});
    expect(c.body.status).toBe('cancelled');
  });

  it('批准反结账：走原来的反结账，客人回到在店', async () => {
    const r = await sale((t) => [{ method: 'cash', amount: t }]);
    const s = await api(ctx.app, ctx.clerk, 'POST', '/api/cashier-requests', { clientKey: randomUUID(), kind: 'void', checkoutId: r.res.body.id, reason: '收款方式记错' });
    const a = await api(ctx.app, duty, 'POST', `/api/cashier-requests/${s.body.id}/approve`, {});
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.status).toBe('approved');
    const [c] = await ctx.sql<{ status: string; voidedBy: number; voidReason: string }[]>`SELECT status, voided_by, void_reason FROM checkouts WHERE id = ${r.res.body.id}`;
    expect(c).toMatchObject({ status: 'voided', voidedBy: dutyId });
    expect(c!.voidReason).toContain(s.body.requestNo);
    const [v] = await ctx.sql<{ status: string }[]>`SELECT status FROM visits WHERE id = ${r.visitId}`;
    expect(v!.status).toBe('open');
  });

  it('单子已经变了的申请批准时记失效、通知申请人', async () => {
    const r = await sale((t) => [{ method: 'cash', amount: t }]);
    const opts = (await api(ctx.app, duty, 'GET', `/api/frontdesk/checkouts/${r.res.body.id}/refund-options`)).body;
    const item = opts.items[0];
    const s = await api(ctx.app, ctx.clerk, 'POST', '/api/cashier-requests', {
      clientKey: randomUUID(),
      kind: 'refund',
      checkoutId: r.res.body.id,
      refund: { items: [{ category: item.category, name: item.name, quantity: 0, amount: r.total }], payments: [{ method: 'cash', amount: r.total }], reason: '全退' },
    });
    expect(s.status).toBe(200);
    // 模拟单子变了：有待审批时直接退款会被拦，所以先撤回、值班经理退一部分、再提一张全退的申请
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/cashier-requests/${s.body.id}/cancel`, {})).status).toBe(200);
    const part = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${r.res.body.id}/refunds`, {
      clientKey: randomUUID(),
      items: [{ category: item.category, name: item.name, quantity: 0, amount: 100 }],
      payments: [{ method: 'cash', amount: 100 }],
      reason: '先退一点',
    });
    expect(part.status, JSON.stringify(part.body)).toBe(201);
    const s2 = await api(ctx.app, ctx.clerk, 'POST', '/api/cashier-requests', {
      clientKey: randomUUID(),
      kind: 'refund',
      checkoutId: r.res.body.id,
      refund: { items: [{ category: item.category, name: item.name, quantity: 0, amount: r.total }], payments: [{ method: 'cash', amount: r.total }], reason: '全退' },
    });
    expect(s2.status).toBe(200);
    const a = await api(ctx.app, duty, 'POST', `/api/cashier-requests/${s2.body.id}/approve`, { clientKey: randomUUID() });
    expect(a.status).toBe(422);
    expect(a.body.error.code).toBe('REFUND_EXCEEDS');
    const after = (await api(ctx.app, ctx.clerk, 'GET', `/api/cashier-requests/${s2.body.id}`)).body;
    expect(after.status).toBe('expired');
    expect(after.decisionNote).toContain('单子已经变了');
    expect(JSON.stringify(await notices(ctx.clerk))).toContain('已失效');
  });

  it('24 小时没人批：扫描记失效；交接清单列出本人没处理完的申请', async () => {
    const r = await sale((t) => [{ method: 'cash', amount: t }]);
    const s = await api(ctx.app, ctx.clerk, 'POST', '/api/cashier-requests', { clientKey: randomUUID(), kind: 'void', checkoutId: r.res.body.id, reason: '收错了' });
    const h = (await api(ctx.app, ctx.clerk, 'GET', '/api/cashier-requests/handover')).body;
    expect(h.myPendingRequests.map((x: { requestNo: string }) => x.requestNo)).toContain(s.body.requestNo);
    expect((await api(ctx.app, duty, 'GET', '/api/cashier-requests/handover')).body.toApprove).toBeGreaterThanOrEqual(1);
    const n = await sweepCashierRequests({ sql: ctx.sql, config: ctx.config }, new Date(Date.now() + 25 * 3_600_000));
    expect(n).toBeGreaterThanOrEqual(1);
    const x = (await api(ctx.app, ctx.clerk, 'GET', `/api/cashier-requests/${s.body.id}`)).body;
    expect(x.status).toBe('expired');
    // 失效以后能直接反结账，也能重新提交
    const again = await api(ctx.app, ctx.clerk, 'POST', '/api/cashier-requests', { clientKey: randomUUID(), kind: 'void', checkoutId: r.res.body.id, reason: '重新申请' });
    expect(again.status).toBe(200);
  });

  it('前台自检全部通过', async () => {
    for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
      expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    }
  });
});
