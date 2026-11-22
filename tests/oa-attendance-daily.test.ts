// OA-08 考勤结算与异常（docs/OA.md 第 11 节）：下班窗口结束以后才结算；迟到、缺下班卡、旷工、正常；第一次算成异常发通知、
// 之后变正常不再发；结算后又有新打卡的重新结算；外勤算不算出勤（人事，带原值）；重新结算某一天；跨天班第二天才结；
// 部门负责人只看本部门；员工「我的考勤」。打卡按服务端时间：只假装 Date，门店时区 Asia/Shanghai。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AttendanceDay, AttendanceSetup, MyAttendance, NotificationPage } from '../src/shared/oa';
import { shiftDate } from '../src/shared/labels';
import { runAttendanceSettlement } from '../src/server/modules/oa/attendance-daily';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

const D = '2030-04-15';
const time = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+08:00`);
const at = (date: string, hhmm: string) => vi.setSystemTime(time(date, hhmm));
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

let ctx: TestContext;
type Emp = { id: number; cookie: string };
const emp: Record<string, Emp> = {};
const shifts: Record<string, number> = {};
let groupId: number;

const hire = async (username: string, position = 'front.staff'): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username) };
};
const create = async (path: string, body: object) => {
  const r = await api(ctx.app, ctx.owner, 'POST', `/api/oa/attendance/${path}`, { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as AttendanceSetup;
};
const schedule = async (who: Emp, date: string, name: string) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/schedule', {
    clientKey: randomUUID(),
    storeId: DEFAULT_STORE_ID,
    groupId,
    cells: [{ staffId: who.id, date, shiftIds: [shifts[name]!], consecutive: false, expected: { shiftIds: [], consecutive: false } }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const punch = async (who: Emp, date: string, hhmm: string) => {
  at(date, hhmm);
  const r = await api(ctx.app, who.cookie, 'POST', '/api/oa/attendance/punch', { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const run = (date: string, hhmm: string) => runAttendanceSettlement({ sql: ctx.sql, config: ctx.config }, time(date, hhmm), true);
const day = async (cookie = ctx.owner, date = D, extra = '') => {
  const r = await api(ctx.app, cookie, 'GET', `/api/oa/attendance/daily?date=${date}${extra}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as AttendanceDay;
};
const rowOf = async (who: Emp, date = D) => (await day(ctx.owner, date)).rows.find((r) => r.staffId === who.id)!;
const unread = async (who: Emp) => ((await api(ctx.app, who.cookie, 'GET', '/api/oa/notifications?status=unread')).body as NotificationPage).items.filter((n) => n.kind === 'attendance_exception');

beforeAll(async () => {
  ctx = await setup();
  for (const n of ['late', 'absent', 'half', 'ok', 'night']) emp[n] = await hire(`ad_${n}`);
  emp.eng = await hire('ad_eng', 'eng.staff');
  vi.useFakeTimers({ toFake: ['Date'] });
  at(shiftDate(D, -1), '09:00');
  const w = { inAdvanceMinutes: 120, lateGraceMinutes: 0, inAfterMinutes: 60, outBeforeMinutes: 60, outDelayMinutes: 120 };
  for (const [name, startMinute, endMinute] of [
    ['白班', 540, 1080],
    ['夜班', 1320, 360],
  ] as const) {
    const s = await create('shifts', { name, startMinute, endMinute, ...w });
    shifts[name] = s.shifts.find((x) => x.name === name)!.id;
  }
  const g = await create('groups', { name: '前厅', gpsRequired: false, memberIds: Object.values(emp).map((e) => e.id) });
  groupId = g.groups.find((x) => x.name === '前厅')!.id;
  for (const n of ['late', 'absent', 'half', 'ok', 'eng']) await schedule(emp[n]!, D, '白班');
  await schedule(emp.night!, D, '夜班');
  await punch(emp.ok!, D, '08:50');
  await punch(emp.half!, D, '08:55');
  await punch(emp.late!, D, '09:10');
  await punch(emp.eng!, D, '09:00');
  await punch(emp.ok!, D, '18:10');
  await punch(emp.late!, D, '18:05');
  await punch(emp.eng!, D, '18:00');
  await punch(emp.night!, D, '21:55');
});
afterAll(async () => {
  vi.useRealTimers();
  await ctx.close();
});

describe('OA-08 考勤结算与异常', () => {
  it('下班窗口结束以前不结算；结束以后：迟到、缺下班卡、旷工、正常；跨天班第二天才结', async () => {
    expect(await run(D, '19:59')).toBe(0);
    expect(await run(D, '20:01')).toBe(5);
    expect(await rowOf(emp.late!)).toMatchObject({ status: 'abnormal', lateMinutes: 10, missingIn: false, missingOut: false, inAt: { time: '09:10' }, outAt: { time: '18:05' } });
    expect(await rowOf(emp.half!)).toMatchObject({ status: 'abnormal', missingOut: true, inAt: { time: '08:55' }, outAt: null });
    expect(await rowOf(emp.absent!)).toMatchObject({ status: 'absent', missingIn: true, missingOut: true });
    expect(await rowOf(emp.ok!)).toMatchObject({ status: 'normal', lateMinutes: 0, earlyMinutes: 0 });
    expect((await day()).rows.find((r) => r.staffId === emp.night!.id)).toBeUndefined();
    // 夜班 22:00–06:00：下班窗口到第二天 08:00
    at(shiftDate(D, 1), '06:10');
    await punch(emp.night!, shiftDate(D, 1), '06:10');
    expect(await run(shiftDate(D, 1), '08:01')).toBe(1);
    expect(await rowOf(emp.night!)).toMatchObject({ status: 'normal', businessDate: D, inAt: { date: D, time: '21:55' }, outAt: { date: shiftDate(D, 1), time: '06:10' } });
    // 没有变化的不再重算
    expect(await run(shiftDate(D, 1), '09:00')).toBe(0);
  });

  it('第一次算成异常发通知；补上打卡以后重新结算变正常，不再发', async () => {
    expect((await unread(emp.late!))[0]).toMatchObject({ title: `考勤异常：${D} 白班`, link: '/oa/attendance' });
    expect((await unread(emp.late!))[0]!.body).toContain('迟到 10 分钟');
    expect(await unread(emp.absent!)).toHaveLength(1);
    expect(await unread(emp.ok!)).toHaveLength(0);
    // 模拟补卡（OA-13 审批通过后写打卡明细）：补一张下班卡
    await ctx.sql`
      INSERT INTO oa_punches (store_id, staff_id, punched_at, kind, business_date, shift_id, location_ok)
      VALUES (${DEFAULT_STORE_ID}, ${emp.half!.id}, ${time(D, '18:00').toISOString()}, 'out', ${D}, ${shifts['白班']!}, true)`;
    expect(await run(shiftDate(D, 1), '10:00')).toBe(1);
    expect(await rowOf(emp.half!)).toMatchObject({ status: 'normal', missingOut: false, outAt: { time: '18:00' } });
    expect(await unread(emp.half!)).toHaveLength(1);
  });

  it('外勤：默认算出勤，人事可以改成不算（带原值，别人先改过拒绝；已经是要的样子照常成功）', async () => {
    const r0 = await rowOf(emp.ok!);
    expect(code(await api(ctx.app, ctx.owner, 'POST', `/api/oa/attendance/daily/${r0.id}/outwork`, { counted: false, expected: true }))).toBe('NOT_OUTWORK');
    await ctx.sql`UPDATE oa_punches SET outwork = true, outwork_reason = '外出采购', lat = 31.2, lng = 121.4 WHERE staff_id = ${emp.ok!.id} AND kind = 'in'`;
    expect(await run(shiftDate(D, 1), '10:00')).toBe(0);
    await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/daily/settle', { date: D, storeId: DEFAULT_STORE_ID });
    const r = await rowOf(emp.ok!);
    expect(r).toMatchObject({ outwork: true, outworkCounted: true });
    const set = (counted: boolean, expected: boolean) => api(ctx.app, ctx.owner, 'POST', `/api/oa/attendance/daily/${r.id}/outwork`, { counted, expected });
    expect((await set(false, true)).body).toMatchObject({ outworkCounted: false });
    expect((await set(false, true)).status).toBe(200);
    expect(code(await set(true, true))).toBe('OUTWORK_CHANGED');
    // 重新结算保留人事的决定
    await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/daily/settle', { date: D, storeId: DEFAULT_STORE_ID });
    expect(await rowOf(emp.ok!)).toMatchObject({ outwork: true, outworkCounted: false });
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'oa_attendance_outwork'`).length).toBe(1);
  });

  it('重新结算：未来的日子拒绝、员工不能点；只看异常；部门负责人只看本部门、不能改；员工看「我的考勤」', async () => {
    at(shiftDate(D, 1), '12:00');
    const settled = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/daily/settle', { date: D, storeId: DEFAULT_STORE_ID });
    expect(settled.body).toEqual({ settled: 6 });
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/daily/settle', { date: shiftDate(D, 3), storeId: DEFAULT_STORE_ID }))).toBe('SETTLE_FUTURE');
    expect((await api(ctx.app, emp.ok!.cookie, 'POST', '/api/oa/attendance/daily/settle', { date: D, storeId: DEFAULT_STORE_ID })).status).toBe(403);
    expect((await api(ctx.app, emp.ok!.cookie, 'GET', `/api/oa/attendance/daily?date=${D}`)).status).toBe(403);
    const abnormal = await day(ctx.owner, D, '&abnormal=1');
    expect(new Set(abnormal.rows.map((r) => r.staffId))).toEqual(new Set([emp.late!.id, emp.absent!.id]));
    const lead = await hire('ad_eng_lead', 'eng.lead');
    const mine = await day(lead.cookie);
    expect(mine.editable).toBe(false);
    expect(mine.rows.map((r) => r.staffId)).toEqual([emp.eng!.id]);
    expect((await api(ctx.app, lead.cookie, 'POST', `/api/oa/attendance/daily/${mine.rows[0]!.id}/outwork`, { counted: false, expected: true })).status).toBe(403);
    const me = (await api(ctx.app, emp.late!.cookie, 'GET', `/api/oa/me/attendance?month=${D.slice(0, 7)}`)).body as MyAttendance;
    expect(me.rows).toHaveLength(1);
    expect(me.rows[0]).toMatchObject({ businessDate: D, status: 'abnormal', lateMinutes: 10 });
  });
});
