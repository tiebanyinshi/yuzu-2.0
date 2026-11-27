// OA-09 假种与假期余额（docs/OA.md 第 12 节）：默认五种假；年假按入职日期自动发放（按到那天满几年套档、每人每年一次、
// 不满一年的不发、没填入职日期的不发）；人事调整带操作编号（重提不重复、编号换了内容拒绝、不够减拒绝、不管余额的不调、确认作废）；
// 新建假种带操作编号、修改带版本、有余额的不能改成不管余额；员工看自己的余额与明细、不能调整。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LeaveAdjustSaved, LeaveEntry, LeaveType, LeaveTypeSaved, LeaveYear, MyLeave, NotificationPage } from '../src/shared/oa';
import { grantAnnualLeave } from '../src/server/modules/oa/leave';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { todayIn } from '../src/server/lib/dates';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
type Emp = { id: number; cookie: string };
const emp: Record<string, Emp> = {};
let annual: LeaveType;
let personal: LeaveType;
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

const hire = async (username: string, hireDate: string | null): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position: 'front.staff', password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = (r.body as { id: number }).id;
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE id = ${id}`;
  if (hireDate) await ctx.sql`INSERT INTO staff_profiles (staff_id, hire_date) VALUES (${id}, ${hireDate}) ON CONFLICT (staff_id) DO UPDATE SET hire_date = EXCLUDED.hire_date`;
  return { id, cookie: await login(ctx.app, username) };
};
const year = async (y: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/oa/leave/balances?year=${y}`)).body as LeaveYear;
const balanceOf = async (who: Emp, y: number, typeId = annual.id) => (await year(y)).staff.find((s) => s.staffId === who.id)!.balances.find((b) => b.leaveTypeId === typeId)!;
const adjust = (body: object, cookie = ctx.owner) =>
  api<LeaveAdjustSaved>(ctx.app, cookie, 'POST', '/api/oa/leave/adjust', { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID, year: 2031, leaveTypeId: annual.id, ...body });

beforeAll(async () => {
  ctx = await setup();
  emp.senior = await hire('lv_senior', '2019-03-01');
  emp.mid = await hire('lv_mid', '2029-06-15');
  emp.fresh = await hire('lv_fresh', '2030-09-01');
  emp.nodate = await hire('lv_nodate', null);
  const types = (await api(ctx.app, emp.mid!.cookie, 'GET', '/api/oa/leave/types')).body as LeaveType[];
  annual = types.find((t) => t.name === '年假')!;
  personal = types.find((t) => t.name === '事假')!;
});
afterAll(async () => {
  await ctx.close();
});

describe('OA-09 假种与假期余额', () => {
  it('默认五种假：年假管余额、按工龄分档；员工也看得到假种', async () => {
    const types = (await api(ctx.app, emp.mid!.cookie, 'GET', '/api/oa/leave/types')).body as LeaveType[];
    expect(types.map((t) => t.name)).toEqual(['年假', '事假', '病假', '婚假', '产假']);
    expect(annual).toMatchObject({
      paid: true,
      hasBalance: true,
      annualTiers: [
        { years: 1, days: 5 },
        { years: 10, days: 10 },
        { years: 20, days: 15 },
      ],
    });
    expect(personal).toMatchObject({ paid: false, hasBalance: false, annualTiers: null });
    expect(types.find((t) => t.name === '病假')).toMatchObject({ paid: true, proofRequired: true });
  });

  it('年假自动发放：按到那天满几年套档；不满一年、没填入职日期的不发；每人每年一次；满一年那天再发', async () => {
    const n = await grantAnnualLeave(ctx.sql, '2031-01-05', null);
    expect(await balanceOf(emp.senior!, 2031)).toMatchObject({ grantedHalves: 20, usedHalves: 0 }); // 满 11 年 → 10 天
    expect(await balanceOf(emp.mid!, 2031)).toMatchObject({ grantedHalves: 10 }); // 满 1 年 → 5 天
    expect(await balanceOf(emp.fresh!, 2031)).toMatchObject({ grantedHalves: 0 }); // 不满一年
    expect(await balanceOf(emp.nodate!, 2031)).toMatchObject({ grantedHalves: 0 });
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await grantAnnualLeave(ctx.sql, '2031-01-06', null)).toBe(0);
    // 满一年那天再发
    expect(await grantAnnualLeave(ctx.sql, '2031-09-01', null)).toBe(1);
    expect(await balanceOf(emp.fresh!, 2031)).toMatchObject({ grantedHalves: 10 });
    const unread = ((await api(ctx.app, emp.mid!.cookie, 'GET', '/api/oa/notifications?status=unread')).body as NotificationPage).items;
    expect(unread.find((x) => x.title === '2031 年年假已发放：5 天')).toMatchObject({ link: '/oa/leave' });
  });

  it('人事调整：带操作编号，重提不重复；编号换了内容拒绝；不够减拒绝；不管余额的不调；员工不能调；查回与确认作废', async () => {
    const key = randomUUID();
    const body = { clientKey: key, staffId: emp.mid!.id, halves: 3, reason: '去年未休补发' };
    const r1 = await adjust(body);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toMatchObject({ replayed: false, balance: { grantedHalves: 13, usedHalves: 0 } });
    expect((await adjust(body)).body).toMatchObject({ replayed: true, entryId: r1.body.entryId, balance: { grantedHalves: 13 } });
    expect(code(await adjust({ ...body, halves: 4 }))).toBe('IDEMPOTENCY_CONFLICT');
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${key}?type=oa_leave_adjust`)).body).toMatchObject({ found: true, refId: r1.body.entryId });
    expect(code(await adjust({ staffId: emp.mid!.id, halves: -14, reason: '多发了' }))).toBe('LEAVE_BALANCE_SHORT');
    expect((await adjust({ staffId: emp.mid!.id, halves: -13, reason: '离职清零' })).body).toMatchObject({ balance: { grantedHalves: 0 } });
    expect(code(await adjust({ staffId: emp.mid!.id, leaveTypeId: personal.id, halves: 2, reason: '事假' }))).toBe('LEAVE_NO_BALANCE');
    expect((await adjust({ staffId: emp.mid!.id, halves: 2, reason: '自己加' }, emp.mid!.cookie)).status).toBe(403);
    expect((await adjust({ staffId: emp.mid!.id, halves: 0, reason: '零' })).status).toBe(400);
    // 确认作废以后，原编号的请求晚到也不生效
    const late = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${late}/abandon`, { type: 'oa_leave_adjust', summary: '调整假期余额' })).status).toBe(200);
    expect((await adjust({ clientKey: late, staffId: emp.mid!.id, halves: 2, reason: '晚到' })).status).toBe(409);
    expect(await balanceOf(emp.mid!, 2031)).toMatchObject({ grantedHalves: 0 });
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'oa_leave_adjusted'`).length).toBe(2);
    const entries = (await api(ctx.app, ctx.owner, 'GET', `/api/oa/leave/entries?staffId=${emp.mid!.id}&year=2031`)).body as LeaveEntry[];
    expect(entries.map((e) => [e.kind, e.halves])).toEqual([
      ['adjust', -13],
      ['adjust', 3],
      ['grant', 10],
    ]);
  });

  it('新建假种带操作编号（重提返回同一个）；重名拒绝；修改带版本；有余额的不能改成不管余额；按工龄发放的要管余额', async () => {
    const key = randomUUID();
    const body = { name: '调休', paid: true, proofRequired: false, hasBalance: true, annualTiers: null, clientKey: key };
    const r1 = await api<LeaveTypeSaved>(ctx.app, ctx.owner, 'POST', '/api/oa/leave/types', body);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const r2 = await api<LeaveTypeSaved>(ctx.app, ctx.owner, 'POST', '/api/oa/leave/types', body);
    expect(r2.body).toMatchObject({ id: r1.body.id, replayed: true });
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/leave/types', { ...body, clientKey: randomUUID() }))).toBe('NAME_TAKEN');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/oa/leave/types', { ...body, name: '丧假', hasBalance: false, annualTiers: [{ years: 1, days: 3 }], clientKey: randomUUID() })).status).toBe(
      400,
    );
    expect((await api(ctx.app, emp.mid!.cookie, 'POST', '/api/oa/leave/types', { ...body, name: '自建', clientKey: randomUUID() })).status).toBe(403);
    const put = (patch: object) => api(ctx.app, ctx.owner, 'PUT', `/api/oa/leave/types/${annual.id}`, { ...annual, ...patch });
    expect(code(await put({ hasBalance: false, annualTiers: null }))).toBe('LEAVE_HAS_BALANCE');
    const ok = await put({ annualTiers: [{ years: 1, days: 6 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(code(await put({ annualTiers: [{ years: 1, days: 7 }] }))).toBe('VERSION_CONFLICT');
  });

  it('员工「假期余额」：本人今年的余额与明细；人事点「按规则发放」只发本店员工、已经发过的不重复', async () => {
    // 门店时区的今年（年末那晚进程时区与门店差一天）
    const thisYear = Number(todayIn(ctx.config.timezone).slice(0, 4));
    const lastYear = `${thisYear - 3}-01-01`;
    const e = await hire('lv_now', lastYear);
    const g = await api<{ granted: number }>(ctx.app, ctx.owner, 'POST', '/api/oa/leave/grant', {});
    expect(g.body.granted).toBeGreaterThanOrEqual(1);
    expect((await api<{ granted: number }>(ctx.app, ctx.owner, 'POST', '/api/oa/leave/grant', {})).body.granted).toBe(0);
    const me = (await api(ctx.app, e.cookie, 'GET', '/api/oa/me/leave')).body as MyLeave;
    expect(me.year).toBe(thisYear);
    expect(me.balances.find((b) => b.leaveTypeId === annual.id)).toMatchObject({ grantedHalves: 12 }); // 满 3 年，上一条把满 1 年改成 6 天
    expect(me.entries).toHaveLength(1);
    expect(me.entries[0]).toMatchObject({ kind: 'grant', halves: 12, leaveTypeName: '年假' });
    expect((await api(ctx.app, e.cookie, 'GET', `/api/oa/leave/balances?year=${thisYear}`)).status).toBe(403);
  });
  it('调整与关掉「管余额」同时进行：调整等假种的锁，关掉以后不再加上（Codex 审查 3c1cf1b）', async () => {
    const [t] = await ctx.sql<{ id: number }[]>`INSERT INTO oa_leave_types (name, paid, has_balance, sort) VALUES ('补休', true, true, 9) RETURNING id`;
    const typeId = Number(t!.id);
    let pending: ReturnType<typeof adjust> | undefined;
    await ctx.sql.begin(async (tx) => {
      // 模拟修改假种：锁住那一行、核对没人有余额，再关掉「管余额」
      await tx`SELECT 1 FROM oa_leave_types WHERE id = ${typeId} FOR UPDATE`;
      pending = adjust({ staffId: emp.senior!.id, leaveTypeId: typeId, halves: 2, reason: '同时调整' });
      await new Promise((r) => setTimeout(r, 300));
      await tx`UPDATE oa_leave_types SET has_balance = false WHERE id = ${typeId}`;
    });
    expect(code(await pending!)).toBe('LEAVE_NO_BALANCE');
    expect(await ctx.sql`SELECT 1 FROM oa_leave_balances WHERE leave_type_id = ${typeId} AND granted_halves <> 0`).toHaveLength(0);
  });
});
