// 8.2.2 技师（《技师排班系统需求沟通会》，docs/V8222_TECHNICIANS.md）：扩钟单独一类、一报多、超时退技师、换项目 / 换工种、
// 长假到期自动上牌、已带、扩钟与十天业绩统计、每月任务、网页导入技师、按星级与门店的提成。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { batchRowKey } from '../src/server/modules/bookings';
import { sweepLeaveReturns } from '../src/server/modules/technician-leave-return';
import { lineCommission, DEFAULT_COMMISSION_RULES, techFilterOf, TECH_FILTER_LABELS } from '../src/shared/clockroom';
import { parseHeight, parseStar, parseWeight, parsePhone } from '../src/shared/technician-import';
import { monthSegments } from '../src/shared/technician-stats';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let finance: string;
let foot: number; // 足疗 198、60 分钟、分类「足疗」
let ear: number; // 采耳 88、分类「采耳」
let tagNo = 0;
const tech: Record<string, number> = {};

const board = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom')).body;
const enter = async () => {
  tagNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: `K${String(tagNo).padStart(3, '0')}`, zone: 'female' }] });
  expect(r.status).toBe(201);
  return r.body.visits[0].id as number;
};
const dispatch = (body: Record<string, unknown>, cookie = ctx.clerk) => api(ctx.app, cookie, 'POST', '/api/clockroom/dispatch', { clientKey: randomUUID(), quantity: 1, startNow: true, ...body });
type Sess = { id: number; visitId: number; status: string; techNo: string; itemId: number; callType: string; clocks: number; changed: boolean };
const sessionsOf = async (visitId: number) => ((await board()).sessions as Sess[]).filter((s) => s.visitId === visitId);
const queue = async () =>
  ((await board()).technicians as { techNo: string; position: number | null; kind: string }[])
    .filter((t) => t.position !== null && t.techNo !== '09')
    .sort((a, b) => a.position! - b.position!)
    .map((t) => t.techNo);
const state = (no: string, action: string, reason?: string) => api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech[no]}/state`, { action, ...(reason ? { reason } : {}) });
const lineUp = async (nos: string[]) => {
  for (const no of nos) expect((await state(no, 'to_end', '排回用例的顺序')).status).toBe(200);
};
const pay = async (visitId: number) => {
  const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: preview.totalAmount,
    payments: [{ method: 'cash', amount: preview.totalAmount }],
    confirmUnstarted: [],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const voidAll = async () => {
  for (const s of (await board()).sessions as { id: number }[]) await api(ctx.app, ctx.owner, 'POST', `/api/clockroom/sessions/${s.id}/void`, { reason: '用例收尾' });
};

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'fin', displayName: '财务', role: 'backoffice', duties: ['payable'], password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  finance = await login(ctx.app, 'fin');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'K', from: 1, to: 80, width: 3, zone: 'female' })).status).toBe(200);
  const add = async (body: Record<string, unknown>) => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { technicianRequired: true, ...body });
    expect(r.status).toBe(200);
    return r.body.items.find((i: { name: string }) => i.name === body.name).id as number;
  };
  foot = await add({ name: '足疗', category: '足疗', durationMinutes: 60, price: 19800 });
  ear = await add({ name: '采耳', category: '采耳', durationMinutes: 30, price: 8800 });
  for (const [no, skills] of [
    ['01', ['足疗']],
    ['02', ['足疗']],
    ['03', ['足疗']],
    ['09', ['采耳']],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name: `技师${no}`, gender: 'female', grade: 'standard', skills, star: no === '02' ? 5 : undefined });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/sign-in-all')).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('状态名与已带', () => {
  it('在岗、手上没钟：今天做过钟的是「已带」，没做过的是「空闲」；大屏与榜单照旧只分到空闲', () => {
    const t = { suspendedAt: null, busy: null, state: 'on' as const };
    expect(techFilterOf({ ...t, todayClocks: 2 }, true)).toBe('brought');
    expect(techFilterOf({ ...t, todayClocks: 0 }, true)).toBe('idle');
    expect(techFilterOf({ ...t, todayClocks: 2 })).toBe('idle');
    expect(techFilterOf({ ...t, busy: { status: 'waiting' } }, true)).toBe('waiting');
    expect([
      TECH_FILTER_LABELS.idle,
      TECH_FILTER_LABELS.waiting,
      TECH_FILTER_LABELS.serving,
      TECH_FILTER_LABELS.brought,
      TECH_FILTER_LABELS.rest,
      TECH_FILTER_LABELS.leave,
      TECH_FILTER_LABELS.off,
    ]).toEqual(['空闲', '待中', '上钟', '已带', '暂离', '休假', '未上牌']);
  });
});

describe('扩钟单独一类', () => {
  it('扩钟做完、出单后排位不动；点钟照旧下钟排到队尾；加钟在明细上单列', async () => {
    await lineUp(['01', '02', '03']);
    expect(await queue()).toEqual(['01', '02', '03']);
    // 02 扩钟（排第 2）：派钟、下钟后还是第 2
    const v = await enter();
    expect((await dispatch({ visitId: v, itemId: foot, technicianId: tech['02'], callType: 'call', expectedTotal: 19800 })).status).toBe(200);
    const [s] = await sessionsOf(v);
    expect(s).toMatchObject({ techNo: '02', callType: 'call', status: 'serving' });
    // 加钟一个：明细标加钟
    const ext = await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s!.id}/extend`, { clientKey: randomUUID(), quantity: 1, expectedTotal: 19800 });
    expect(ext.status, JSON.stringify(ext.body)).toBe(200);
    const lines = await ctx.sql<{ callType: string; clockExtension: boolean; techStar: number | null }[]>`
      SELECT call_type, clock_extension, tech_star FROM bill_lines WHERE session_id = ${s!.id} ORDER BY id`;
    expect(lines).toEqual([
      { callType: 'call', clockExtension: false, techStar: 5 },
      { callType: 'designated', clockExtension: true, techStar: 5 },
    ]);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s!.id}/finish`)).status).toBe(200);
    expect(await queue()).toEqual(['01', '02', '03']);
    expect((await board()).today.call).toBe(1);
    // 03 点钟：下钟后排到队尾
    const w = await enter();
    expect((await dispatch({ visitId: w, itemId: foot, technicianId: tech['03'], callType: 'designated', expectedTotal: 19800 })).status).toBe(200);
    const [d] = await sessionsOf(w);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${d!.id}/finish`)).status).toBe(200);
    expect(await queue()).toEqual(['01', '02', '03']);
    // 02 下了钟、今天做过：按状态是「已带」
    const t02 = ((await board()).technicians as { techNo: string; todayClocks: number; busy: unknown; state: 'on'; suspendedAt: null }[]).find((t) => t.techNo === '02')!;
    expect(techFilterOf(t02, true)).toBe('brought');

    // 结账以后：报表把扩钟、点钟、加钟分开；扩钟奖励没单独设时与点钟一样
    await pay(v);
    await pay(w);
    const date = (await board()).businessDate as string;
    const r = (await api(ctx.app, ctx.owner, 'GET', `/api/reports/technicians?from=${date}&to=${date}`)).body;
    const row = (no: string) => r.rows.find((x: { techNo: string }) => x.techNo === no);
    expect(row('02')).toMatchObject({ clocks: 2, call: 1, extension: 1, designated: 0, rotation: 0 });
    expect(row('03')).toMatchObject({ clocks: 1, designated: 1, call: 0, extension: 0 });
    expect(row('02').commission.bonus).toBe(2000); // 扩钟 10 + 加钟（记点钟）10
    // 财务职责能看技师业绩（8.2.2）与提成
    const fin = await api(ctx.app, finance, 'GET', `/api/reports/technicians?from=${date}&to=${date}`);
    expect(fin.status).toBe(200);
    expect(fin.body.totals.commission).toBeDefined();
    // 后台单独设扩钟奖励 ¥30、5 星每钟固定 ¥80：之后结账的按新规则（本店自己的一份）
    const put = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/commission', {
      rules: { base: { kind: 'percent', rateBp: 4000 }, designatedBonus: 1000, items: {}, callBonus: 3000, stars: { '5': { kind: 'fixed', perClock: { standard: 8000 } } } },
      note: '扩钟单独定',
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await ctx.sql`SELECT store_id FROM commission_rule_versions ORDER BY id DESC LIMIT 1`)[0]!.storeId).not.toBeNull();
    const x = await enter();
    expect((await dispatch({ visitId: x, itemId: foot, technicianId: tech['02'], callType: 'call', expectedTotal: 19800 })).status).toBe(200);
    await pay(x);
    const r2 = (await api(ctx.app, ctx.owner, 'GET', `/api/reports/technicians?from=${date}&to=${date}`)).body;
    const c2 = r2.rows.find((x2: { techNo: string }) => x2.techNo === '02').commission;
    expect(c2.bonus - row('02').commission.bonus).toBe(3000);
    expect(c2.base - row('02').commission.base).toBe(8000);
  });

  it('提成按星级：项目覆盖优先，其次星级，最后默认；扩钟奖励没设按点钟', () => {
    const rules = { ...DEFAULT_COMMISSION_RULES, stars: { '3': { kind: 'percent' as const, rateBp: 5000 } } };
    const line = { itemId: 1, tier: null, quantity: 1, amount: 10000, callType: 'call' as const };
    expect(lineCommission(rules, { ...line, star: 3 })).toEqual({ base: 5000, bonus: 1000 });
    expect(lineCommission(rules, { ...line, star: 4 })).toEqual({ base: 4000, bonus: 1000 });
    expect(lineCommission({ ...rules, items: { '1': { kind: 'percent', rateBp: 1000 } } }, { ...line, star: 3 })).toEqual({ base: 1000, bonus: 1000 });
    expect(lineCommission({ ...rules, callBonus: 0 }, { ...line, star: 3 }).bonus).toBe(0);
  });
});

describe('退技师', () => {
  it('超过本人更正时限：店员提示走退项（不再写「请由店主处理」），值班经理（超时退技师）直接退', async () => {
    await lineUp(['01', '02', '03']);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { selfVoidMinutes: 0 })).status).toBe(200);
    const v = await enter();
    expect((await dispatch({ visitId: v, itemId: foot, technicianId: tech['01'], callType: 'rotation', expectedTotal: 19800 })).status).toBe(200);
    const [s] = await sessionsOf(v);
    await ctx.sql`SELECT pg_sleep(0.05)`;
    const refused = await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s!.id}/void`, { reason: '客人不满意' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('VOID_LATE');
    expect(refused.body.error.message).toContain('退项');
    expect(refused.body.error.message).not.toContain('店主处理');
    const ok = await api(ctx.app, duty, 'POST', `/api/clockroom/sessions/${s!.id}/void`, { reason: '客人不满意' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await sessionsOf(v)).toEqual([]);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { selfVoidMinutes: 15 })).status).toBe(200);
  });
});

describe('换项目 / 换工种', () => {
  it('同一位技师换项目：钟单改项目、原明细作废、标「换过项目」，排位不动；超时不能换', async () => {
    await voidAll();
    await lineUp(['01', '02', '03']);
    const deep = await api(ctx.app, ctx.owner, 'POST', '/api/items', { technicianRequired: true, name: '深层足疗', category: '足疗', durationMinutes: 90, price: 25800 });
    const deepId = deep.body.items.find((i: { name: string }) => i.name === '深层足疗').id as number;
    const v = await enter();
    expect((await dispatch({ visitId: v, itemId: foot, technicianId: tech['01'], callType: 'rotation', expectedTotal: 19800 })).status).toBe(200);
    const before = await queue();
    const [s] = await sessionsOf(v);
    const key = randomUUID();
    const body = { clientKey: key, itemId: deepId, quantity: 1, reason: '客人要深一点的', expectedTotal: 25800 };
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s!.id}/change`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // 同一个编号原样重提：不再挂一笔
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s!.id}/change`, body)).status).toBe(200);
    const [after] = await sessionsOf(v);
    expect(after).toMatchObject({ id: s!.id, itemId: deepId, techNo: '01', status: 'serving', changed: true });
    const lines = await ctx.sql<{ status: string; amount: number }[]>`SELECT status, amount FROM bill_lines WHERE session_id = ${s!.id} ORDER BY id`;
    expect(lines).toEqual([
      { status: 'voided', amount: 19800 },
      { status: 'active', amount: 25800 },
    ]);
    expect(await queue()).toEqual(before);
    expect(((await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/events')).body as { kind: string; text: string }[]).find((e) => e.kind === 'change')!.text).toContain('足疗 → 深层足疗');
    // 上钟满规定分钟数就不能换
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/clockroom-rules', { changeItemMinutes: 0 })).status).toBe(200);
    const late = await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s!.id}/change`, { ...body, clientKey: randomUUID(), itemId: foot, expectedTotal: 19800 });
    expect(late.body.error.code).toBe('CHANGE_TOO_LATE');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/clockroom-rules', { changeItemMinutes: 15 })).status).toBe(200);
  });

  it('换到原技师做不了的项目（换工种）：原技师回到派钟以前的排位，不算被退钟；新技师上钟', async () => {
    await voidAll();
    await lineUp(['01', '02', '03']);
    const v = await enter();
    // 01 轮钟：派钟时排到队尾
    expect((await dispatch({ visitId: v, itemId: foot, technicianId: tech['01'], callType: 'rotation', expectedTotal: 19800 })).status).toBe(200);
    expect(await queue()).toEqual(['02', '03', '01']);
    const [s] = await sessionsOf(v);
    // 原技师做不了采耳，不换人的拒绝
    const streak = async () => (await ctx.sql`SELECT reject_streak FROM technician_status WHERE technician_id = ${tech['01']!}`)[0]!.rejectStreak as number;
    const streakBefore = await streak();
    const own = await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s!.id}/change`, { clientKey: randomUUID(), itemId: ear, quantity: 1, reason: '改做采耳', expectedTotal: 8800 });
    expect(own.body.error.code).toBe('TECHNICIAN_UNAVAILABLE');
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s!.id}/change`, {
      clientKey: randomUUID(),
      itemId: ear,
      quantity: 1,
      technicianId: tech['09'],
      callType: 'designated',
      reason: '改做采耳',
      expectedTotal: 8800,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await queue()).toEqual(['01', '02', '03']);
    const now = await sessionsOf(v);
    expect(now).toEqual([expect.objectContaining({ techNo: '09', itemId: ear, status: 'serving', changed: true })]);
    const [old] = await ctx.sql<{ status: string; voidReason: string }[]>`SELECT status, void_reason FROM technician_sessions WHERE id = ${s!.id}`;
    expect(old).toEqual({ status: 'rejected', voidReason: '换工种：改做采耳' });
    expect(await streak()).toBe(streakBefore);
    const [ch] = await ctx.sql<{ kind: string; newSessionId: number | null }[]>`SELECT kind, new_session_id FROM technician_session_changes WHERE session_id = ${s!.id}`;
    expect(ch!.kind).toBe('technician');
    expect(ch!.newSessionId).not.toBeNull();
    await voidAll();
  });
});

describe('休假', () => {
  it('钟房一次设好几天：有名册权限的直接批准、今天起休假；休完后的第一个营业日自动上牌、排到队尾', async () => {
    await voidAll();
    const r = await api(ctx.app, ctx.owner, 'POST', `/api/clockroom/technicians/${tech['03']}/leave-days`, { clientKey: randomUUID(), days: 1, reason: '回老家', leaveType: 'personal' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.technicians.find((t: { techNo: string }) => t.techNo === '03')).toMatchObject({ state: 'leave' });
    // 店员（没有名册权限）设的是待审批，今天照旧
    const pending = await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech['01']}/leave-days`, { clientKey: randomUUID(), days: 3, reason: '调休三天' });
    expect(pending.status).toBe(200);
    expect(pending.body.technicians.find((t: { techNo: string }) => t.techNo === '01').state).toBe('on');
    expect((await ctx.sql`SELECT status FROM technician_leaves WHERE technician_id = ${tech['01']!} ORDER BY id DESC LIMIT 1`)[0]!.status).toBe('pending');
    // 今天还在休：不上牌
    expect(await sweepLeaveReturns({ sql: ctx.sql, config: ctx.config }, new Date())).toBe(0);
    // 明天：自动上牌，排到队尾；再跑一次不再上
    const tomorrow = new Date(Date.now() + 26 * 3600_000);
    expect(await sweepLeaveReturns({ sql: ctx.sql, config: ctx.config }, tomorrow)).toBe(1);
    expect(await sweepLeaveReturns({ sql: ctx.sql, config: ctx.config }, tomorrow)).toBe(0);
    const [st] = await ctx.sql<{ state: string; queueKey: Date }[]>`SELECT state, queue_key FROM technician_status WHERE technician_id = ${tech['03']!}`;
    expect(st!.state).toBe('on');
    expect(new Date(st!.queueKey).getTime()).toBe(tomorrow.getTime());
    const [ev] = await ctx.sql<{ detail: { auto: string } }[]>`SELECT detail FROM technician_events WHERE technician_id = ${tech['03']!} AND kind = 'sign_in' ORDER BY id DESC LIMIT 1`;
    expect(ev!.detail.auto).toBe('leave_return');
    // 销假、上牌，后面的用例照旧
    const [leave] = await ctx.sql<{ id: number }[]>`SELECT id FROM technician_leaves WHERE technician_id = ${tech['03']!} ORDER BY id DESC LIMIT 1`;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/technician-admin/leaves/${leave!.id}/cancel`, { reason: '用例收尾' })).status).toBe(200);
    expect((await state('03', 'sign_in')).status).toBe(200);
  });
});

describe('一报多', () => {
  it('一次几位客人：同一位技师同一时段约几位不设上限；一个编号重提不重复建；有一行不行整批不建', async () => {
    const date = (await board()).businessDate as string;
    const tomorrow = new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const slots = (await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/slots?kind=technician&date=${tomorrow}&itemId=${foot}`)).body as { startsAt: string }[];
    const at = slots[4]!.startsAt;
    const rows = [
      { guestName: '王', tagCode: 'k001', guestPhone: '13900000011', itemId: foot, technicianId: tech['02'], startsAt: at },
      { guestName: '李', guestPhone: '', itemId: foot, technicianId: tech['02'], startsAt: at },
      { guestName: '张', itemId: foot, technicianId: null, startsAt: at },
    ];
    const clientKey = randomUUID();
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/bookings/batch', { clientKey, rows });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.bookings.map((b: { guestName: string; tagCode: string; technicianId: number | null }) => [b.guestName, b.tagCode, b.technicianId])).toEqual([
      ['王', 'K001', tech['02']],
      ['李', '', tech['02']],
      ['张', '', null],
    ]);
    const again = await api(ctx.app, ctx.clerk, 'POST', '/api/bookings/batch', { clientKey, rows });
    expect(again.body.bookings.map((b: { id: number }) => b.id)).toEqual(r.body.bookings.map((b: { id: number }) => b.id));
    expect((await ctx.sql`SELECT count(*)::int AS n FROM bookings WHERE client_key IN ${ctx.sql([0, 1, 2].map((i) => batchRowKey(clientKey, i)))}`)[0]!.n).toBe(3);
    // 第 2 行的技师做不了足疗：整批不建，提示写第几行
    const bad = await api(ctx.app, ctx.clerk, 'POST', '/api/bookings/batch', {
      clientKey: randomUUID(),
      rows: [rows[0], { ...rows[1], technicianId: tech['09'] }],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toContain('第 2 行');
    expect(bad.body.error.details.row).toBe(1);
    expect((await ctx.sql`SELECT count(*)::int AS n FROM bookings`)[0]!.n).toBe(3);
  });
});

describe('统计与每月任务', () => {
  it('每天的扩钟数、每 10 天一段按工种小计、每月任务看完成度', async () => {
    const date = (await board()).businessDate as string;
    const calls = (await api(ctx.app, ctx.owner, 'GET', `/api/reports/technicians/calls?from=${date}&to=${date}`)).body;
    expect(calls.rows.find((r: { techNo: string }) => r.techNo === '02')).toMatchObject({ total: 2, days: { [date]: 2 } });
    expect(calls.total).toBe(2);
    const month = date.slice(0, 7);
    expect(monthSegments('2026-02').map((s) => s.to)).toEqual(['2026-02-10', '2026-02-20', '2026-02-28']);
    const periods = (await api(ctx.app, finance, 'GET', `/api/reports/technicians/periods?month=${month}`)).body;
    expect(periods.segments).toHaveLength(3);
    expect(periods.total.amount).toBeGreaterThan(0);
    const seg = periods.segments.find((s: { from: string; to: string }) => s.from <= date && date <= s.to);
    expect(seg.kinds.reduce((n: number, k: { amount: number }) => n + k.amount, 0)).toBe(seg.total.amount);
    // 目标：02 一个月 ¥1,000；财务不能设
    expect((await api(ctx.app, finance, 'PUT', '/api/admin/technician-targets', { month, targets: [] })).status).toBe(403);
    const put = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technician-targets', { month, targets: [{ technicianId: tech['02'], amount: 100000, clocks: 10 }] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const view = (await api(ctx.app, finance, 'GET', `/api/reports/technicians/targets?month=${month}`)).body;
    expect(view.targets[0]).toMatchObject({ label: '02 号 技师02', amount: 100000, clocks: 10 });
    expect(view.targets[0].rate).toBe(Math.round((view.targets[0].actualAmount / 100000) * 100));
    expect(view.targets[0].actualAmount).toBeGreaterThan(0);
  });
});

describe('网页导入技师', () => {
  it('认表头与别名、先预览、有问题一行都不写；原样再导结果一样；手机打码', async () => {
    expect([parsePhone('138-0013-8000'), parseHeight('1.65'), parseHeight('165cm'), parseWeight('100斤'), parseStar('三星'), parseStar('★★★★'), parseStar('11')]).toEqual([
      '13800138000',
      165,
      165,
      50,
      3,
      4,
      undefined,
    ]);
    const tpl = await ctx.app.inject({ method: 'GET', url: '/api/admin/technicians/import-template.csv', headers: { cookie: ctx.owner } });
    expect(tpl.statusCode).toBe(200);
    expect(tpl.body).toContain('工号,姓名,花名,性别,电话,组别');
    const csv = ['填写须知', '工号,姓名,花名,电话,组别,身高,体重,星级', '31,周一,小周,13800138031,A组,163,48,3星', '02,技师02,,13800138002,,,,'].join('\n');
    const bad = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians/import/preview', { fileName: 'a.csv', csv });
    expect(bad.status).toBe(200);
    expect(bad.body.errors[0].message).toContain('要写性别');
    const refused = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians/import', { fileName: 'a.csv', csv, planHash: bad.body.planHash });
    expect(refused.body.error.code).toBe('IMPORT_INVALID');
    expect((await ctx.sql`SELECT count(*)::int AS n FROM technicians WHERE tech_no = '31'`)[0]!.n).toBe(0);
    // 选「没写性别的按女」
    const preview = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians/import/preview', { fileName: 'a.csv', csv, defaultGender: 'female' });
    expect(preview.body).toMatchObject({ create: 1, update: 1, same: 0, errors: [], groupsCreated: ['A组'] });
    expect(preview.body.rows[1].changes).toEqual(['电话 空 → 138 **** 8002']);
    const applied = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians/import', { fileName: 'a.csv', csv, defaultGender: 'female', planHash: preview.body.planHash });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.applied).toBe(true);
    const [t31] = await ctx.sql`SELECT gender, phone, height_cm, weight_kg, star, nickname FROM technicians WHERE tech_no = '31'`;
    expect(t31).toEqual({ gender: 'female', phone: '13800138031', heightCm: 163, weightKg: 48, star: 3, nickname: '小周' });
    // 原样再导：全都不变
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians/import/preview', { fileName: 'a.csv', csv, defaultGender: 'female' });
    expect(again.body).toMatchObject({ create: 0, update: 0, same: 2, errors: [] });
    // 旧的预览摘要对不上了
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians/import', { fileName: 'a.csv', csv, defaultGender: 'female', planHash: preview.body.planHash })).body.error.code).toBe(
      'IMPORT_STALE',
    );
    // 名册里手机号打码
    const admin = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/technicians')).body;
    const row = admin.technicians.find((t: { techNo: string }) => t.techNo === '31');
    expect(row).toMatchObject({ phoneMasked: '138 **** 8031', hasPhone: true, heightCm: 163, star: 3 });
    expect(JSON.stringify(admin)).not.toContain('13800138031');
    // 店员不能导
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/technicians/import/preview', { fileName: 'a.csv', csv })).status).toBe(403);
  });
});
