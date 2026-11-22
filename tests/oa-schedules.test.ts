// OA-05 排班（docs/OA.md 第 8 节）：按格子保存（别人先改过拒绝、原样重提成功）、过去的不能改、同一人前后班次打卡时段不能重叠（连班除外）、
// 跨天班、部门负责人只看本部门、员工「我的排班」、排班变更通知、审计。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scheduleSpan, type AttendanceSetup, type MySchedule, type NotificationPage, type ScheduleWeek } from '../src/shared/oa';
import { shiftDate } from '../src/shared/labels';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let groupId: number;
let a: { id: number; cookie: string };
let b: { id: number; cookie: string };
let early: number;
let night: number;
let late: number;
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

const hire = async (username: string, position: string) => {
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
const week = async (cookie = ctx.owner, from: string | undefined = today) => {
  const r = await api(ctx.app, cookie, 'GET', `/api/oa/attendance/schedule?groupId=${groupId}${from ? `&from=${from}` : ''}&days=7`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as ScheduleWeek;
};
const EMPTY = { shiftIds: [] as number[], consecutive: false };
const save = (cells: object[]) => api(ctx.app, ctx.owner, 'PUT', '/api/oa/attendance/schedule', { groupId, cells });

beforeAll(async () => {
  ctx = await setup();
  a = await hire('sch_a', 'front.staff');
  b = await hire('sch_b', 'front.staff');
  await create('shifts', { name: '早班', startMinute: 480, endMinute: 960 });
  await create('shifts', { name: '夜班', startMinute: 0, endMinute: 480 });
  const s = await create('shifts', { name: '晚班', startMinute: 960, endMinute: 0, inAdvanceMinutes: 60, outDelayMinutes: 60 });
  early = s.shifts.find((x) => x.name === '早班')!.id;
  night = s.shifts.find((x) => x.name === '夜班')!.id;
  late = s.shifts.find((x) => x.name === '晚班')!.id;
  const g = await create('groups', { name: '前厅组', gpsRequired: false, memberIds: [a.id, b.id] });
  groupId = g.groups.find((x) => x.name === '前厅组')!.id;
  today = (await week()).today;
});
afterAll(async () => ctx.close());

describe('OA-05 排班', () => {
  it('scheduleSpan：跨天班的时段伸到第二天；00:00 的班上班卡从前一天开始', () => {
    const n = scheduleSpan('2026-11-23', { startMinute: 0, endMinute: 480, inAdvanceMinutes: 120, outDelayMinutes: 120 });
    const d = Math.round(Date.parse('2026-11-23T00:00:00Z') / 86_400_000) * 1440;
    expect(n).toEqual({ from: d - 120, to: d + 600 });
    const l = scheduleSpan('2026-11-23', { startMinute: 1320, endMinute: 360, inAdvanceMinutes: 60, outDelayMinutes: 60 });
    expect(l).toEqual({ from: d + 1260, to: d + 1440 + 420 });
  });

  it('按格子保存：别人先改过拒绝；原样重提成功；过去的不能改；记审计、发通知', async () => {
    const tomorrow = shiftDate(today, 1);
    let r = await save([{ staffId: a.id, date: tomorrow, shiftIds: [early], expected: EMPTY }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ changed: 1 });
    // 原样重提：已经是要的样子，跳过
    r = await save([{ staffId: a.id, date: tomorrow, shiftIds: [early], expected: EMPTY }]);
    expect(r.body).toEqual({ changed: 0 });
    // 照着旧页面改成夜班：拒绝
    expect(code(await save([{ staffId: a.id, date: tomorrow, shiftIds: [night], expected: EMPTY }]))).toBe('SCHEDULE_CHANGED');
    // 过去的
    expect(code(await save([{ staffId: a.id, date: shiftDate(today, -1), shiftIds: [early], expected: EMPTY }]))).toBe('SCHEDULE_PAST');
    // 不在组里的员工
    const c = await hire('sch_c', 'front.staff');
    expect(code(await save([{ staffId: c.id, date: tomorrow, shiftIds: [early], expected: EMPTY }]))).toBe('SCHEDULE_MEMBER');
    const w = await week();
    expect(w.cells).toContainEqual({ staffId: a.id, date: tomorrow, shiftIds: [early], consecutive: false });
    expect(w.editable).toBe(true);
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'oa_schedule_saved'`).length).toBe(1);
    const n = (await api(ctx.app, a.cookie, 'GET', '/api/oa/notifications?status=unread')).body as NotificationPage;
    expect(n.items[0]).toMatchObject({ kind: 'schedule_change', link: '/oa/schedule' });
    expect(n.items[0]!.body).toContain(tomorrow);
  });

  it('同一人前后班次打卡时段不能重叠：晚班接第二天夜班重叠，标了连班可以；同一天早班加晚班不重叠', async () => {
    const d2 = shiftDate(today, 2);
    const d3 = shiftDate(today, 3);
    // 晚班 16:00–24:00（延后 60 分）与第二天夜班 00:00–08:00（提前 120 分）重叠
    let r = await save([
      { staffId: b.id, date: d2, shiftIds: [late], expected: EMPTY },
      { staffId: b.id, date: d3, shiftIds: [night], expected: EMPTY },
    ]);
    expect(code(r)).toBe('SCHEDULE_OVERLAP');
    expect((r.body as { error: { message: string } }).error.message).toContain('sch_b');
    // 整批回滚：什么都没存
    expect((await week()).cells.filter((x) => x.staffId === b.id)).toEqual([]);
    // 标了连班
    r = await save([
      { staffId: b.id, date: d2, shiftIds: [late], expected: EMPTY },
      { staffId: b.id, date: d3, shiftIds: [night], consecutive: true, expected: EMPTY },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // 同一天早班 08:00–16:00 加晚班 16:00–24:00：早班延后 120 分与晚班提前 60 分重叠 → 要标连班
    expect(code(await save([{ staffId: a.id, date: d2, shiftIds: [early, late], expected: EMPTY }]))).toBe('SCHEDULE_OVERLAP');
    r = await save([{ staffId: a.id, date: d2, shiftIds: [early, late], consecutive: true, expected: EMPTY }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await week()).cells).toContainEqual({ staffId: a.id, date: d2, shiftIds: [early, late], consecutive: true });
    // 清空 = 休息
    r = await save([{ staffId: a.id, date: d2, shiftIds: [], expected: { shiftIds: [late, early], consecutive: true } }]);
    expect(r.body).toEqual({ changed: 1 });
  });

  it('部门负责人只看本部门、不能改；别的部门的负责人看不到这个组；员工看不了排班表', async () => {
    const lead = await hire('sch_front_lead', 'front.lead');
    const other = await hire('sch_eng_lead', 'eng.lead');
    const w = await week(lead.cookie);
    expect(w.editable).toBe(false);
    expect(w.members.map((m) => m.staffId).sort()).toEqual([a.id, b.id].sort());
    expect((await api(ctx.app, lead.cookie, 'PUT', '/api/oa/attendance/schedule', { groupId, cells: [{ staffId: a.id, date: today, shiftIds: [], expected: EMPTY }] })).status).toBe(403);
    expect((await api(ctx.app, other.cookie, 'GET', `/api/oa/attendance/schedule?groupId=${groupId}`)).status).toBe(404);
    expect((await api(ctx.app, other.cookie, 'GET', '/api/oa/attendance/schedule')).body).toMatchObject({ groups: [], group: null });
    expect((await api(ctx.app, a.cookie, 'GET', '/api/oa/attendance/schedule')).status).toBe(403);
  });

  it('我的排班：本人一个月，每天一行；只看自己的', async () => {
    const tomorrow = shiftDate(today, 1);
    const r = await api(ctx.app, a.cookie, 'GET', `/api/oa/me/schedule?month=${tomorrow.slice(0, 7)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const m = r.body as MySchedule;
    expect(m.days[0]!.date).toBe(`${tomorrow.slice(0, 7)}-01`);
    expect(m.days.find((d) => d.date === tomorrow)!.items).toEqual([{ shiftId: early, name: '早班', startMinute: 480, endMinute: 960, consecutive: false }]);
    const mine = (await api(ctx.app, b.cookie, 'GET', `/api/oa/me/schedule?month=${tomorrow.slice(0, 7)}`)).body as MySchedule;
    expect(mine.days.find((d) => d.date === tomorrow)!.items).toEqual([]);
    expect((await api(ctx.app, a.cookie, 'GET', '/api/oa/me/schedule?month=2026-12')).body).toMatchObject({ month: '2026-12' });
    expect(((await api(ctx.app, a.cookie, 'GET', '/api/oa/me/schedule?month=2026-12')).body as MySchedule).days).toHaveLength(31);
  });
});
