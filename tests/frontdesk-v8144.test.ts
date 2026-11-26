// 8.1.44《前台系统开发》（docs/V8144_FRONTDESK.md）：
//   · 同行：收银台买单时把分批到的手牌记为同行（有结账权限就行），同组的可以只结一张、剩下的稍后单独结；
//   · 买单时查会员（余额、充没充过值、在哪张手牌上），把会员记到散客的手牌上；记了以后结账核对带出他的储值；
//     只能记到没有会员的手牌上，一位会员同时只在一张手牌上，停用的不能记；记的这一下写审计；
//   · 混合支付：储值付一部分 + 现金付剩下的，合计不等于应收拒绝；
//   · 房态看板带当天的预约单（取消的不列）。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CashierMemberHit } from '../src/shared/cashier-member';
import type { RoomCenterBoard } from '../src/shared/room-center';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let am: string;
let tagNo = 0;

const checkIn = async (memberId?: number) => {
  tagNo += 1;
  const code = `V${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male', ...(memberId ? { memberId } : {}) }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.visits[0].id as number, code };
};
const preview = async (ids: number[]) => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${ids.join(',')}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { totalAmount: number; members: { id: number; principalBalance: number }[]; visits: { visitId: number; memberId: number | null }[] };
};
const pay = (ids: number[], total: number, payments: Record<string, unknown>[]) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: ids, expectedTotal: total, payments });
const lookup = async (q: string) => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/member-lookup?q=${encodeURIComponent(q)}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as CashierMemberHit[];
};
const bind = (visitId: number, memberId: number, cookie = ctx.clerk) => api(ctx.app, cookie, 'POST', `/api/frontdesk/visits/${visitId}/member`, { memberId });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  am = await login(ctx.app, 'am');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'V', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('同行：买单时组建与拆分', () => {
  it('分批到的两张手牌买单时记为同行；只结一张，另一张留在组里稍后单独结；没有前台权限的不能改同行', async () => {
    const a = await checkIn();
    const b = await checkIn();
    expect((await api(ctx.app, am, 'POST', `/api/frontdesk/visits/${b.id}/group`, { action: 'join', targetVisitId: a.id })).status).toBe(403);
    const joined = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${b.id}/group`, { action: 'join', targetVisitId: a.id });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body.group.mates.map((m: { tagCode: string }) => m.tagCode).sort()).toEqual([a.code, b.code].sort());

    // 拆分：A 单独结，B 留在组里
    const pa = await preview([a.id]);
    const paidA = await pay([a.id], pa.totalAmount, [{ method: 'cash', amount: pa.totalAmount }]);
    expect(paidA.status, JSON.stringify(paidA.body)).toBe(200);
    expect(paidA.body.remainingMates).toEqual([b.code]);
    const pb = await preview([b.id]);
    expect((await pay([b.id], pb.totalAmount, [{ method: 'cash', amount: pb.totalAmount }])).status).toBe(200);
  });
});

describe('买单时查会员、记到手牌上（混合支付）', () => {
  it('查到充过值的会员，记到散客手牌上，储值付一部分、现金付剩下的', async () => {
    const m = await createMember(ctx, '买单会员', '19900084401');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 5000))).status).toBe(200);
    const fresh = await createMember(ctx, '没充过值', '19900084402');

    // 按手机号查：充过 1 次、余额 ¥50、不在店
    const [hit] = await lookup('19900084401');
    expect(hit).toMatchObject({ id: m.id, rechargeCount: 1, rechargePaid: 5000, principalBalance: 5000, openTagCode: null, merged: false, status: 'active' });
    expect((await lookup('19900084402'))[0]).toMatchObject({ id: fresh.id, rechargeCount: 0, rechargePaid: 0, lastRechargeAt: null });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/member-lookup?q=')).status).toBe(400);

    // 散客手牌：结账核对里没有会员
    const v = await checkIn();
    expect((await preview([v.id])).members).toHaveLength(0);
    // 没有前台权限的不能记
    expect((await bind(v.id, m.id, am)).status).toBe(403);
    const bound = await bind(v.id, m.id);
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    expect(bound.body.member.id).toBe(m.id);
    // 再记一次同一位：原样返回
    expect((await bind(v.id, m.id)).status).toBe(200);
    // 已经记着会员：不能换成别人
    expect((await bind(v.id, fresh.id)).body.error.code).toBe('VISIT_HAS_MEMBER');
    // 一位会员同时只在一张手牌上
    const other = await checkIn();
    expect((await bind(other.id, m.id)).body.error.code).toBe('MEMBER_IN_STORE');
    // 停用的不能记
    await ctx.sql`UPDATE members SET status = 'frozen' WHERE id = ${fresh.id}`;
    expect((await bind(other.id, fresh.id)).body.error.code).toBe('MEMBER_FROZEN');
    // 查的时候看得到在哪张手牌上
    expect((await lookup('19900084401'))[0]).toMatchObject({ openTagCode: v.code, openVisitId: v.id });
    const [audit] = await ctx.sql<{ detail: { memberId: number; tagCode: string } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'frontdesk_bind_member' AND target_id = ${String(v.id)}`;
    expect(audit!.detail).toMatchObject({ memberId: m.id, tagCode: v.code });

    // 结账核对带出会员储值；储值 ¥30 + 现金补剩下的
    const p = await preview([v.id]);
    expect(p.members.map((x) => x.id)).toEqual([m.id]);
    expect(p.totalAmount).toBeGreaterThan(3000);
    const wallet = { method: 'wallet', memberId: m.id, amount: 3000, expectedSplit: { principal: 3000, bonus: 0 } };
    // 合计不等于应收：拒绝
    expect((await pay([v.id], p.totalAmount, [wallet, { method: 'cash', amount: p.totalAmount - 3000 - 100 }])).body.error.code).toBe('NOT_SETTLED');
    const paid = await pay([v.id], p.totalAmount, [wallet, { method: 'cash', amount: p.totalAmount - 3000 }]);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}`)).body.principalBalance).toBe(2000);
    // 结完以后不能再往这张来访上记会员
    const closed = await bind(v.id, fresh.id);
    expect(closed.body.error.code).toBe('VISIT_CLOSED');

    for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
      expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    }
  });
});

describe('房态显示当天预约单', () => {
  it('房态看板带今天的预约（取消的不列），按开始时间排', async () => {
    const [roomType] = await ctx.sql<{ id: number }[]>`INSERT INTO room_types (name, kind, price) VALUES ('合成预约房型', 'daily', 100) RETURNING id`;
    const today = ((await api(ctx.app, ctx.clerk, 'GET', '/api/room-center')).body as RoomCenterBoard).businessDate;
    for (const [no, status, guest] of [
      ['YY-8144-1', 'confirmed', '订房客人'],
      ['YY-8144-2', 'cancelled', '取消的客人'],
    ] as const) {
      await ctx.sql`
        INSERT INTO bookings (booking_no, kind, source, status, guest_name, guests, room_type_id, starts_at, ends_at, hold_until, business_date, created_by, client_key, request_hash,
                              confirmed_by, confirmed_at, cancelled_at, cancelled_by, cancel_reason)
        VALUES (${no}, 'room', 'phone', ${status}, ${guest}, 2, ${roomType!.id}, now() + interval '1 hour', now() + interval '2 hours', now() + interval '3 hours', ${today},
                ${ctx.clerkId}, ${randomUUID()}, ${'c'.repeat(64)}, ${ctx.clerkId}, now(),
                ${status === 'cancelled' ? ctx.sql`now()` : null}, ${status === 'cancelled' ? ctx.clerkId : null}, ${status === 'cancelled' ? '客人改期' : null})`;
    }
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/room-center')).body as RoomCenterBoard;
    expect(board.todayBookings.map((b) => b.bookingNo)).toEqual(['YY-8144-1']);
    expect(board.todayBookings[0]).toMatchObject({ kind: 'room', status: 'confirmed', guest: '订房客人', guests: 2, target: '合成预约房型', arrivalTagCode: null });
  });
});
