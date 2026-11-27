// 8.2.1 批 1 收银台（docs/V8221_CASHIER.md）：
//   · 单项打折：按折扣 / 折后价打一行；四档下限（默认 90 / 70 / 50 / 0），超了要当场授权、授权人的下限也要够；操作编号幂等、审计；
//     结账时自动记一笔「单项折扣」，收款只收折后，部门营业额快照按行记；打过折的行不用券、次卡、会员折扣；转单要先恢复原价；
//     反结账后折扣还在、可以重结；
//   · 经办人工号与手机尾号、改价标记；
//   · 换牌：「柜锁故障」不锁原牌；
//   · 手牌押金：现金 / 储值收，一键退，结账时一起退（储值退回原卡），进交班与日结；储值押金不能在会员那里单独撤销；押着押金不能撤销来访。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutPreview, CheckoutDetail } from '../src/shared/checkout';
import type { FrontdeskRules, VisitDetail } from '../src/shared/frontdesk';
import { DEFAULT_LINE_DISCOUNT_FLOORS, discountedAmount, lineDiscountTierOf, rateLabel, withinFloor } from '../src/shared/line-discount';
import { createStaff } from '../src/server/modules/staff';
import { couponLines } from '../src/server/modules/coupon-checkout';
import { api, balanceOf, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let tagNo = 0;
let duty = '';
let lead = '';
let itemId = 0;
let dutyUser = 'zduty';

const enter = async (extra: Record<string, unknown> = {}) => {
  tagNo += 1;
  const tagCode = `Z${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', ...extra }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0] as { id: number; tagCode: string };
};
const post = async (visitId: number, quantity = 1) => {
  const r = await api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines: [{ itemId, quantity }], expectedTotal: 59900 * quantity });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.lines.filter((l) => l.status === 'active').at(-1)!;
};
const discount = (who: string, lineId: number, body: Record<string, unknown>) =>
  api<VisitDetail>(ctx.app, who, 'POST', `/api/frontdesk/lines/${lineId}/discount`, { clientKey: randomUUID(), ...body });
const authorize = (username: string, scope: Record<string, unknown>, who = ctx.clerk) =>
  api(ctx.app, who, 'POST', '/api/auth/authorize', { username, password: PASSWORD, purpose: 'line_discount', scope });
const preview = async (ids: number[]) => (await api<CheckoutPreview>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${ids.join(',')}`)).body;
const code = (r: { body: unknown }) => (r.body as { error?: { code: string } }).error?.code;
const checks = async () => {
  const fd = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; label: string; detail: string }[];
  for (const c of fd) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
};

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'Z', from: 1, to: 60, width: 3, zone: 'male' })).status).toBe(200);
  await createStaff(ctx.sql, { username: dutyUser, displayName: '值班丙', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'zlead', displayName: '店总丁', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, dutyUser);
  lead = await login(ctx.app, 'zlead');
  const a = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '精油开背', category: '保健', price: 59900 });
  itemId = a.body.items.find((i: { name: string }) => i.name === '精油开背').id;
  // 经办人的工号与手机号（员工档案）
  await ctx.sql`INSERT INTO staff_profiles (staff_id, emp_no, phone) VALUES (${ctx.clerkId}, 'QT007', '13800001234') ON CONFLICT (staff_id) DO UPDATE SET emp_no = 'QT007', phone = '13800001234'`;
});
afterAll(async () => {
  await ctx?.close();
});

describe('单项打折的档与下限（共用规则）', () => {
  it('四档：店主 / 店总、负责人 / 值班经理 / 其余；默认 90 / 70 / 50 / 0；折后价四舍五入到分', () => {
    expect(lineDiscountTierOf({ role: 'owner' })).toBe('owner');
    expect(lineDiscountTierOf({ role: 'clerk', position: 'president' })).toBe('owner');
    expect(lineDiscountTierOf({ role: 'store_manager' })).toBe('lead');
    expect(lineDiscountTierOf({ role: 'duty_manager', position: 'front.lead' })).toBe('lead');
    expect(lineDiscountTierOf({ role: 'duty_manager' })).toBe('duty');
    expect(lineDiscountTierOf({ role: 'clerk', position: 'front.staff' })).toBe('cashier');
    expect(DEFAULT_LINE_DISCOUNT_FLOORS).toEqual({ cashier: 90, duty: 70, lead: 50, owner: 0 });
    expect(discountedAmount(59900, 80)).toBe(47920);
    expect(discountedAmount(999, 85)).toBe(849);
    expect(withinFloor(59900, 53910, 90)).toBe(true);
    expect(withinFloor(59900, 53909, 90)).toBe(false);
    expect([rateLabel(80), rateLabel(85), rateLabel(0)]).toEqual(['8 折', '8.5 折', '免单']);
  });

  it('后台改下限：高一档不能比低一档还高；店员不能改', async () => {
    const bad = await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { lineDiscountFloors: { cashier: 60, duty: 70, lead: 50, owner: 0 } });
    expect(bad.status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/frontdesk/rules', { lineDiscountFloors: { cashier: 80, duty: 70, lead: 50, owner: 0 } })).status).toBe(403);
    const rules = (await api<FrontdeskRules>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/rules')).body;
    expect(rules.lineDiscountFloors).toEqual({ cashier: 90, duty: 70, lead: 50, owner: 0 });
    expect(rules.tagDepositDefaultCents).toBe(10000);
  });
});

describe('单项打折', () => {
  it('收银员九折以内直接打；明细带原价、折后价、谁打的；账单带折扣合计；同一编号重提只记一次；审计', async () => {
    const v = await enter();
    const line = await post(v.id);
    // 经办人放到前面：工号与手机尾号
    expect(line).toMatchObject({ postedByName: '测试店员', postedByEmpNo: 'QT007', postedByPhoneTail: '1234', manualPrice: false, discount: null });
    const key = randomUUID();
    const body = { clientKey: key, rate: 90, reason: '老客' };
    const r = await api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line.id}/discount`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const l = r.body.lines.find((x) => x.id === line.id)!;
    expect(l.amount).toBe(59900);
    expect(l.discount).toMatchObject({ listAmount: 59900, finalAmount: 53910, rate: 90, reason: '老客', byName: '测试店员', byEmpNo: 'QT007', approvedByName: null });
    expect(r.body.bill.discountCents).toBe(5990);
    const again = await api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line.id}/discount`, body);
    expect(again.status).toBe(200);
    expect((await ctx.sql`SELECT id FROM bill_line_discounts WHERE line_id = ${line.id}`).length).toBe(1);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line.id}/discount`, { ...body, rate: 95 })).status).toBe(409);
    const look = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=line_discount`)).body;
    expect(look).toMatchObject({ found: true, type: 'line_discount', visit: { id: v.id } });
    const [audit] = await ctx.sql<{ detail: { finalAmount: number; tier: string; floor: number } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'frontdesk_line_discount' AND target_id = ${String(v.id)}`;
    expect(audit!.detail).toMatchObject({ finalAmount: 53910, tier: 'cashier', floor: 90 });
    // 只能撤下、不能改
    await expect(ctx.sql`UPDATE bill_line_discounts SET final_amount = 1 WHERE line_id = ${line.id}`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM bill_line_discounts WHERE line_id = ${line.id}`).rejects.toThrow();
  });

  it('超过收银员的下限要当场授权：值班经理能授权七折、授权不了五折；店主能免单；授权绑定这一行与折后价', async () => {
    const v = await enter();
    const line = await post(v.id);
    const no = await discount(ctx.clerk, line.id, { rate: 80 });
    expect(no.status).toBe(422);
    expect(code(no)).toBe('LINE_DISCOUNT_AUTH_REQUIRED');
    // 没超的不用授权
    expect(code(await authorize(dutyUser, { lineId: line.id, finalAmount: 55000 }))).toBe('GRANT_NOT_NEEDED');
    // 值班经理最低七折：五折授权不了
    const tooLow = await authorize(dutyUser, { lineId: line.id, finalAmount: 29950 });
    expect(tooLow.status).toBe(403);
    expect(code(tooLow)).toBe('AUTH_NOT_ALLOWED');
    const g = await authorize(dutyUser, { lineId: line.id, finalAmount: 47920, reason: '客诉补偿' });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    // 授权的价与这次不一致
    expect(code(await discount(ctx.clerk, line.id, { rate: 75, grantId: g.body.grantId }))).toBe('GRANT_SCOPE');
    const ok = await discount(ctx.clerk, line.id, { rate: 80, grantId: g.body.grantId, reason: '客诉补偿' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.lines.find((x) => x.id === line.id)!.discount).toMatchObject({ finalAmount: 47920, approvedByName: '值班丙' });
    // 用过的授权不能再用
    expect(code(await discount(ctx.clerk, line.id, { finalAmount: 47000, grantId: g.body.grantId }))).toBe('GRANT_USED');
    // 店主免单（改折扣 = 撤下原来的、记一条新的）
    const owner = await authorize('owner', { lineId: line.id, finalAmount: 0 });
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
    const free = await discount(ctx.clerk, line.id, { finalAmount: 0, grantId: owner.body.grantId });
    expect(free.status).toBe(200);
    expect(free.body.bill.discountCents).toBe(59900);
    const rows = await ctx.sql<{ status: string }[]>`SELECT status FROM bill_line_discounts WHERE line_id = ${line.id} ORDER BY id`;
    expect(rows.map((x) => x.status)).toEqual(['revoked', 'active']);
    // 店总（部门负责人）自己就能打五折
    const v2 = await enter();
    const l2 = await post(v2.id);
    expect((await discount(lead, l2.id, { rate: 50 })).status).toBe(200);
    expect(code(await discount(lead, l2.id, { rate: 40 }))).toBe('LINE_DISCOUNT_AUTH_REQUIRED');
  });

  it('恢复原价要原因；门票不能打；转单要先恢复原价；打过折的行不用券、次卡、会员折扣', async () => {
    const v = await enter();
    const line = await post(v.id);
    expect((await discount(ctx.clerk, line.id, { finalAmount: 55000 })).status).toBe(200);
    const billId = (await api<VisitDetail>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v.id}`)).body.bill.id;
    expect((await couponLines(ctx.sql, [billId])).map((l) => l.id)).toEqual([]);
    const other = await enter();
    const move = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/lines/move', { clientKey: randomUUID(), lineIds: [line.id], toTagCode: other.tagCode, reason: '挂错手牌' });
    expect(code(move)).toBe('LINE_NOT_MOVABLE');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line.id}/discount/revoke`, { clientKey: randomUUID(), reason: '' })).status).toBe(400);
    const back = await api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line.id}/discount/revoke`, { clientKey: randomUUID(), reason: '客人不要了' });
    expect(back.status).toBe(200);
    expect(back.body.bill.discountCents).toBe(0);
    expect((await couponLines(ctx.sql, [billId])).map((l) => l.id)).toEqual([line.id]);
    expect(code(await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line.id}/discount/revoke`, { clientKey: randomUUID(), reason: '再撤一次' }))).toBe('NO_DISCOUNT');
    // 手动金额的明细标「改价」
    const custom = await api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/charges`, {
      clientKey: randomUUID(),
      customLines: [{ name: '开瓶费', amount: 5000 }],
      expectedTotal: 5000,
    });
    expect(custom.body.lines.find((l) => l.name === '开瓶费')!.manualPrice).toBe(true);
  });

  it('结账：收款只收折后，自动记一笔「单项折扣」；部门快照按行记；确认时看到的折扣变了拒绝；反结账后折扣还在、能重结；自检通过', async () => {
    const v = await enter();
    const line = await post(v.id);
    expect((await discount(ctx.clerk, line.id, { rate: 90 })).status).toBe(200);
    const p = await preview([v.id]);
    expect(p.lineDiscountAmount).toBe(5990);
    expect(p.visits[0]!.lineDiscount).toBe(5990);
    const total = p.totalAmount;
    const due = total - 5990;
    const pay = (extra: Record<string, unknown>) =>
      api<CheckoutDetail>(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
        clientKey: randomUUID(),
        visitIds: [v.id],
        expectedTotal: total,
        payments: [{ method: 'cash', amount: due }],
        ...extra,
      });
    expect(code(await pay({ expectedLineDiscount: 1000 }))).toBe('PRICE_CHANGED');
    expect(
      code(await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [v.id], expectedTotal: total, payments: [{ method: 'cash', amount: total }] })),
    ).toBe('NOT_SETTLED');
    const done = await pay({ expectedLineDiscount: 5990 });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.totalAmount).toBe(total);
    expect(done.body.payments.map((x) => [x.method, x.amount])).toEqual(
      expect.arrayContaining([
        ['cash', due],
        ['line_discount', 5990],
      ]),
    );
    const items = await ctx.sql<{ name: string; amount: number; discount: number }[]>`SELECT name, amount, discount FROM checkout_items WHERE checkout_id = ${done.body.id} ORDER BY name`;
    expect(items.find((i) => i.name === '精油开背')).toMatchObject({ amount: 59900, discount: 5990 });
    expect(items.filter((i) => i.name !== '精油开背').every((i) => Number(i.discount) === 0)).toBe(true);
    await checks();
    // 反结账：账单恢复在店，折扣还在那一行上；重结照样记
    const back = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${done.body.id}/void`, { reason: '收错方式' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const p2 = await preview([v.id]);
    expect(p2.lineDiscountAmount).toBe(5990);
    const again = await api<CheckoutDetail>(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v.id],
      expectedTotal: p2.totalAmount,
      payments: [{ method: 'wechat', amount: p2.totalAmount - 5990 }],
      expectedLineDiscount: 5990,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    await checks();
  });
});

describe('换牌：柜锁故障不锁原牌', () => {
  it('不勾锁定时原牌照旧能发（服务端默认不锁）', async () => {
    const v = await enter();
    tagNo += 1;
    const to = `Z${String(tagNo).padStart(3, '0')}`;
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/swap`, { clientKey: randomUUID(), toTagCode: to, reason: '柜锁故障' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [old] = await ctx.sql<{ locked: boolean }[]>`SELECT locked FROM hand_tags WHERE code = ${v.tagCode}`;
    expect(old!.locked).toBe(false);
  });
});

describe('手牌押金', () => {
  const collect = (visitId: number, body: Record<string, unknown>, who = ctx.clerk) =>
    api<VisitDetail>(ctx.app, who, 'POST', `/api/frontdesk/visits/${visitId}/deposits`, { clientKey: randomUUID(), reason: '外出留牌', ...body });
  const refund = (depositId: number) => api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/deposits/${depositId}/refund`, { clientKey: randomUUID() });

  it('现金收、一键退；进交班（应有现金）；同一编号只收一次；押着的不能撤销来访', async () => {
    const shift = await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 });
    expect(shift.status, JSON.stringify(shift.body)).toBe(200);
    const v = await enter();
    const key = randomUUID();
    const body = { clientKey: key, amount: 20000, method: 'cash', reason: '外出留牌' };
    const r = await api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/deposits`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/deposits`, body)).status).toBe(200);
    expect(r.body.deposits).toHaveLength(1);
    const dep = r.body.deposits![0]!;
    expect(dep).toMatchObject({ method: 'cash', amount: 20000, status: 'held', staffName: '测试店员' });
    expect(dep.depositNo).toMatch(/^YJ\d{8}-\d{4}$/);
    const cancel = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/cancel`, { reason: '开错手牌' });
    expect(code(cancel)).toBe('DEPOSIT_HELD');
    let cur = (await api(ctx.app, ctx.clerk, 'GET', '/api/shifts/current')).body.shift;
    expect(cur.summary.deposits.received).toEqual([{ method: 'cash', count: 1, amount: 20000 }]);
    const back = await refund(dep.id);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.deposits![0]).toMatchObject({ status: 'refunded', refundKind: 'manual' });
    expect(code(await refund(dep.id))).toBe('DEPOSIT_REFUNDED');
    cur = (await api(ctx.app, ctx.clerk, 'GET', '/api/shifts/current')).body.shift;
    expect(cur.summary.deposits.refunded).toEqual([{ method: 'cash', count: 1, amount: 20000 }]);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/cancel`, { reason: '开错手牌' })).status).toBe(200);
    await expect(ctx.sql`UPDATE tag_deposits SET amount = 1 WHERE id = ${dep.id}`).rejects.toThrow();
  });

  it('储值扣押金：余额减少；在会员那里不能单独撤销；结账时退回原卡再按退回后的余额扣；结账核对列出押金', async () => {
    const m = await createMember(ctx, '押金会员');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 100000, 0))).status).toBe(200);
    const v = await enter({ memberId: m.id });
    const r = await collect(v.id, { amount: 30000, method: 'wallet', expectedSplit: { principal: 30000, bonus: 0 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await balanceOf(ctx, m.id)).principal).toBe(70000);
    const [c] = await ctx.sql<{ consumptionId: number }[]>`SELECT consumption_id FROM tag_deposits WHERE visit_id = ${v.id}`;
    const rev = await api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${c!.consumptionId}/reverse`, { idempotencyKey: randomUUID(), reason: '想撤销押金' });
    expect(code(rev)).toBe('DEPOSIT_LINKED');
    // 现金押金也押一笔
    expect((await collect(v.id, { amount: 10000, method: 'cash' })).status).toBe(200);
    const p = await preview([v.id]);
    expect(p.deposits!.map((d) => [d.method, d.amount])).toEqual([
      ['wallet', 30000],
      ['cash', 10000],
    ]);
    // 余额按退回以后的给
    expect(p.members[0]!.principalBalance).toBe(100000);
    const total = p.totalAmount;
    const done = await api<CheckoutDetail>(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v.id],
      expectedTotal: total,
      payments: [
        { method: 'cash', amount: 10000 },
        { method: 'wallet', memberId: m.id, amount: total - 10000, expectedSplit: { principal: total - 10000, bonus: 0 } },
      ],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await balanceOf(ctx, m.id)).principal).toBe(100000 - (total - 10000));
    const rows = await ctx.sql<{ status: string; refundKind: string; checkoutId: number }[]>`SELECT status, refund_kind, checkout_id FROM tag_deposits WHERE visit_id = ${v.id} ORDER BY id`;
    expect(rows.map((x) => [x.status, x.refundKind, Number(x.checkoutId)])).toEqual([
      ['refunded', 'checkout', done.body.id],
      ['refunded', 'checkout', done.body.id],
    ]);
    await checks();
    // 日结：押金一块有手牌押金（储值扣的不算钱箱里的钱）
    const today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
    const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
    expect(st.deposits.received.find((x: { method: string }) => x.method === 'cash').amount).toBeGreaterThanOrEqual(10000);
    expect(st.deposits.received.some((x: { method: string }) => x.method === 'wallet')).toBe(false);
  });

  it('储值押金只能扣这张手牌上的会员；没有消费权限的岗位不能用储值', async () => {
    const v = await enter();
    expect(code(await collect(v.id, { amount: 5000, method: 'wallet', expectedSplit: { principal: 5000, bonus: 0 } }))).toBe('NO_MEMBER');
    expect((await collect(v.id, { amount: 0, method: 'cash' })).status).toBe(400);
    expect((await collect(v.id, { amount: 5000, method: 'cash', reason: '' })).status).toBe(400);
    expect(duty).toBeTruthy();
  });
});
