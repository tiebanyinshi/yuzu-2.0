// OA-13 考勤与审批联动（docs/OA.md 第 16 节）：请假通过扣余额、覆盖考勤（整天记请假、上午只免上班这一头）、余额被减到不够时通过被拒；
// 出差记出差、算出勤；补卡（窗口没过、已有那张卡、重复的不让提，通过写补卡、消缺卡）；加班按节假日表核对类型、计入月报；
// 节假日表（整年保存、带版本、记审计）；月报的出差、请假、加班与请假明细，只有加班的员工也列出来；员工「我的考勤」汇总。
// 打卡、审批按服务端时间：只假装 Date，门店时区 Asia/Shanghai。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AttendanceDay, AttendanceMonth, AttendanceSetup, HolidayYear, LeaveType, MyAttendance, PunchDay } from '../src/shared/oa';
import type { ApprovalDetail, ApprovalSaved, ApprovalTemplate } from '../src/shared/oa-approval';
import { shiftDate } from '../src/shared/labels';
import { runAttendanceSettlement } from '../src/server/modules/oa/attendance-daily';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

const D = '2030-04-15';
const D2 = shiftDate(D, 1);
const time = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+08:00`);
const at = (date: string, hhmm: string) => vi.setSystemTime(time(date, hhmm));
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

let ctx: TestContext;
type Emp = { id: number; cookie: string };
const emp: Record<string, Emp> = {};
const tpl: Record<string, ApprovalTemplate> = {};
let shiftId: number;
let groupId: number;
let annual: LeaveType;
let personal: LeaveType;

const hire = async (username: string, position = 'front.staff'): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username) };
};
const schedule = async (who: Emp, date: string) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/schedule', {
    clientKey: randomUUID(),
    storeId: DEFAULT_STORE_ID,
    groupId,
    cells: [{ staffId: who.id, date, shiftIds: [shiftId], consecutive: false, expected: { shiftIds: [], consecutive: false } }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const pub = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/schedule/publish', {
    clientKey: randomUUID(),
    storeId: DEFAULT_STORE_ID,
    groupId,
    from: date,
    to: date,
  });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
};
const punch = async (who: Emp, date: string, hhmm: string) => {
  at(date, hhmm);
  const r = await api(ctx.app, who.cookie, 'POST', '/api/oa/attendance/punch', { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const post = (who: Emp, c: string, form: object) => api<ApprovalSaved>(ctx.app, who.cookie, 'POST', '/api/oa/approvals', { clientKey: randomUUID(), templateId: tpl[c]!.id, form });
const submit = async (who: Emp, c: string, form: object) => {
  const r = await post(who, c, form);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.approval;
};
const approve = (a: ApprovalDetail) => api<ApprovalSaved>(ctx.app, emp.lead!.cookie, 'POST', `/api/oa/approvals/${a.id}/act`, { clientKey: randomUUID(), action: 'approve', stepId: a.pendingStepId });
const approved = async (a: ApprovalDetail) => {
  const r = await approve(a);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.approval.status).toBe('approved');
};
const settle = (date: string, hhmm: string) => runAttendanceSettlement({ sql: ctx.sql, config: ctx.config }, time(date, hhmm), true);
const rowOf = async (who: Emp, date = D) => ((await api(ctx.app, ctx.owner, 'GET', `/api/oa/attendance/daily?date=${date}`)).body as AttendanceDay).rows.find((r) => r.staffId === who.id)!;
const halfDay = (date: string, half: 'am' | 'pm') => ({ date, half });

beforeAll(async () => {
  ctx = await setup();
  for (const n of ['leave', 'half', 'trip', 'makeup', 'short', 'ot']) emp[n] = await hire(`al_${n}`);
  emp.lead = await hire('al_lead', 'front.lead');
  vi.useFakeTimers({ toFake: ['Date'] });
  at(shiftDate(D, -1), '09:00');
  for (const t of (await api(ctx.app, emp.leave!.cookie, 'GET', '/api/oa/approval/templates')).body as ApprovalTemplate[]) tpl[t.code] = t;
  const types = (await api(ctx.app, emp.leave!.cookie, 'GET', '/api/oa/leave/types')).body as LeaveType[];
  annual = types.find((t) => t.name === '年假')!;
  personal = types.find((t) => t.name === '事假')!;
  const s = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/shifts', { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID, name: '白班', startMinute: 540, endMinute: 1080 });
  shiftId = (s.body as AttendanceSetup).shifts.find((x) => x.name === '白班')!.id;
  const members = ['leave', 'half', 'trip', 'makeup', 'short'].map((n) => emp[n]!.id);
  const g = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID, name: '前厅', gpsRequired: false, memberIds: members });
  groupId = (g.body as AttendanceSetup).groups.find((x) => x.name === '前厅')!.id;
  for (const n of ['leave', 'half', 'trip', 'makeup', 'short']) await schedule(emp[n]!, D);
  await schedule(emp.leave!, D2);
  for (const who of [emp.leave!, emp.short!]) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/leave/adjust', {
      clientKey: randomUUID(),
      storeId: DEFAULT_STORE_ID,
      staffId: who.id,
      leaveTypeId: annual.id,
      year: 2030,
      halves: 10,
      reason: '测试发放',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
});
afterAll(async () => {
  vi.useRealTimers();
  await ctx.close();
});

describe('OA-13 考勤与审批联动', () => {
  it('请假：通过扣余额、整天记请假（之前算成旷工的当场改过来），还没下班的那天之后结算也是请假', async () => {
    at(D, '08:00');
    const a = await submit(emp.leave!, 'leave', { leaveTypeId: annual.id, start: halfDay(D, 'am'), end: halfDay(D2, 'pm'), reason: '回老家' });
    expect(a.form.durationHalves).toBe(4);
    await settle(D, '21:00');
    expect(await rowOf(emp.leave!)).toMatchObject({ status: 'absent' });
    at(D, '21:10');
    await approved(a);
    expect(await rowOf(emp.leave!)).toMatchObject({ status: 'leave', cover: 'leave', coverApprovalId: a.id, missingIn: false, missingOut: false });
    const [b] = await ctx.sql<{ usedHalves: number }[]>`SELECT used_halves FROM oa_leave_balances WHERE staff_id = ${emp.leave!.id} AND leave_type_id = ${annual.id} AND year = 2030`;
    expect(b!.usedHalves).toBe(4);
    const [e] = await ctx.sql<{ halves: number; refId: number }[]>`SELECT halves, ref_id FROM oa_leave_entries WHERE staff_id = ${emp.leave!.id} AND kind = 'use'`;
    expect(e).toMatchObject({ halves: -4, refId: a.id });
    await settle(D2, '21:00');
    expect(await rowOf(emp.leave!, D2)).toMatchObject({ status: 'leave' });
    // 已经通过的单再点通过：单子已结束，不会扣第二次
    expect(code(await approve(a))).toBe('APPROVAL_CLOSED');
    expect((await ctx.sql`SELECT 1 FROM oa_leave_entries WHERE staff_id = ${emp.leave!.id} AND kind = 'use'`).length).toBe(1);
  });

  it('半天请假：只请上午的不判上班这一头，下班卡照常算', async () => {
    at(D, '08:00');
    const a = await submit(emp.half!, 'leave', { leaveTypeId: personal.id, start: halfDay(D, 'am'), end: halfDay(D, 'am'), reason: '看病' });
    expect(a.form.durationHalves).toBe(1);
    await approved(a);
    await punch(emp.half!, D, '18:05');
    await settle(D, '21:00');
    expect(await rowOf(emp.half!)).toMatchObject({ status: 'normal', cover: 'leave_am', missingIn: false, missingOut: false, lateMinutes: 0 });
    // 不管余额的事假不扣余额
    expect((await ctx.sql`SELECT 1 FROM oa_leave_entries WHERE staff_id = ${emp.half!.id}`).length).toBe(0);
  });

  it('提交以后余额被人事减到不够：通过被拒绝，单子还在审批中', async () => {
    at(D, '08:00');
    const a = await submit(emp.short!, 'leave', { leaveTypeId: annual.id, start: halfDay(D, 'am'), end: halfDay(D, 'pm'), reason: '有事' });
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/leave/adjust', {
      clientKey: randomUUID(),
      storeId: DEFAULT_STORE_ID,
      staffId: emp.short!.id,
      leaveTypeId: annual.id,
      year: 2030,
      halves: -9,
      reason: '多发了',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(code(await approve(a))).toBe('LEAVE_BALANCE_SHORT');
    const d = await api<ApprovalDetail>(ctx.app, emp.short!.cookie, 'GET', `/api/oa/approvals/${a.id}`);
    expect(d.body.status).toBe('pending');
    expect((await ctx.sql`SELECT 1 FROM oa_attendance_covers WHERE approval_id = ${a.id}`).length).toBe(0);
  });

  it('提交以后排班改了、时长与提交时不一样：通过被拒绝（扣的余额与覆盖要一致）', async () => {
    at(D, '08:00');
    // 后天、大后天只有大后天排了班：提交时 1 天
    const d3 = shiftDate(D, 2);
    const d4 = shiftDate(D, 3);
    await schedule(emp.short!, d4);
    const a = await submit(emp.short!, 'leave', { leaveTypeId: personal.id, start: halfDay(d3, 'am'), end: halfDay(d4, 'pm'), reason: '搬家' });
    expect(a.form.durationHalves).toBe(2);
    await schedule(emp.short!, d3);
    expect(code(await approve(a))).toBe('LEAVE_SCHEDULE_CHANGED');
    expect((await ctx.sql`SELECT 1 FROM oa_attendance_covers WHERE approval_id = ${a.id}`).length).toBe(0);
  });

  it('出差：那天记出差、不用打卡、算出勤（已经结算过的由后台任务按新的覆盖重算）', async () => {
    at(D, '08:00');
    const a = await submit(emp.trip!, 'trip', { destination: '杭州', startDate: D, endDate: D, transport: '火车', reason: '考察' });
    expect(await rowOf(emp.trip!)).toMatchObject({ status: 'absent' });
    // 审批时（假装）还没下班：当场不重算；之后后台任务看到结算以后有新的覆盖，重算
    await approved(a);
    expect(await rowOf(emp.trip!)).toMatchObject({ status: 'absent' });
    await settle(D, '21:30');
    expect(await rowOf(emp.trip!)).toMatchObject({ status: 'trip', cover: 'trip', missingIn: false, missingOut: false });
    const day = (await api(ctx.app, ctx.owner, 'GET', `/api/oa/attendance/daily?date=${D}&abnormal=1`)).body as AttendanceDay;
    expect(day.rows.some((r) => r.staffId === emp.trip!.id || r.staffId === emp.leave!.id)).toBe(false);
  });

  it('补卡：窗口没过、已有那张卡、重复的不让提；通过写一张补卡、缺下班卡消掉', async () => {
    await punch(emp.makeup!, D, '09:00');
    at(D, '12:00');
    expect(code(await post(emp.makeup!, 'makeup', { date: D, shiftId, kind: '下班卡', reason: '忘了打' }))).toBe('MAKEUP_TOO_EARLY');
    await settle(D, '21:00');
    expect(await rowOf(emp.makeup!)).toMatchObject({ status: 'abnormal', missingOut: true });
    at(D, '21:05');
    expect(code(await post(emp.makeup!, 'makeup', { date: D, shiftId, kind: '上班卡', reason: 'x' }))).toBe('MAKEUP_NOT_NEEDED');
    const a = await submit(emp.makeup!, 'makeup', { date: D, shiftId, kind: '下班卡', reason: '忘了打' });
    expect(code(await post(emp.makeup!, 'makeup', { date: D, shiftId, kind: '下班卡', reason: '再提一次' }))).toBe('MAKEUP_PENDING');
    await approved(a);
    expect(await rowOf(emp.makeup!)).toMatchObject({ status: 'normal', missingOut: false, earlyMinutes: 0, outAt: { date: D, time: '18:00' } });
    const punches = (await api(ctx.app, ctx.owner, 'GET', `/api/oa/attendance/punches?date=${D}`)).body as PunchDay;
    const mine = punches.records.filter((p) => p.staffId === emp.makeup!.id);
    expect(mine.map((p) => [p.kind, p.localTime, p.makeup, p.effective])).toEqual([
      ['in', '09:00', false, true],
      ['out', '18:00', true, true],
    ]);
  });

  it('节假日表：整年保存、带版本、不在这一年的拒绝、记审计', async () => {
    const get = async () => (await api<HolidayYear>(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/holidays?year=2030')).body;
    expect(await get()).toMatchObject({ year: 2030, version: 0, days: [] });
    const save = (version: number, days: object[]) => api<HolidayYear>(ctx.app, ctx.owner, 'PUT', '/api/oa/attendance/holidays/2030', { version, days });
    expect(code(await save(0, [{ day: '2031-01-01', kind: 'holiday', name: '元旦' }]))).toBe('HOLIDAY_YEAR');
    const r = await save(0, [
      { day: '2030-05-01', kind: 'holiday', name: '劳动节' },
      { day: '2030-04-28', kind: 'workday', name: '劳动节调休' },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      version: 1,
      days: [
        { day: '2030-04-28', kind: 'workday' },
        { day: '2030-05-01', kind: 'holiday' },
      ],
    });
    expect(code(await save(0, []))).toBe('VERSION_CONFLICT');
    expect((await api(ctx.app, emp.ot!.cookie, 'GET', '/api/oa/attendance/holidays')).status).toBe(403);
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'oa_holidays_saved'`).length).toBe(1);
  });

  it('加班：按节假日表核对类型；通过的计入月报（只有加班、没有排班的员工也列出来）', async () => {
    at(D, '20:00');
    const form = (start: string, end: string, kind: string) => ({ start, end, kind, reason: '盘点' });
    expect(code(await post(emp.ot!, 'overtime', form('2030-05-01T10:00', '2030-05-01T14:00', '休息日')))).toBe('FORM_INVALID');
    expect(code(await post(emp.ot!, 'overtime', form('2030-04-20T10:00', '2030-04-20T14:00', '节假日')))).toBe('FORM_INVALID');
    await approved(await submit(emp.ot!, 'overtime', form('2030-04-20T10:00', '2030-04-20T14:00', '休息日')));
    await approved(await submit(emp.ot!, 'overtime', form('2030-04-16T19:00', '2030-04-16T20:30', '工作日')));
    // 在别的门店提交的不算进这家门店的月报（一人挂几家门店时不重复算），本人的汇总照算
    const other = await submit(emp.ot!, 'overtime', form('2030-04-22T10:00', '2030-04-22T11:00', '休息日'));
    await approved(other);
    const [store2] = await ctx.sql<{ id: number }[]>`INSERT INTO stores (code, name, entity_id) VALUES ('AL2', '二店', 1) RETURNING id`;
    await ctx.sql`UPDATE oa_approvals SET store_id = ${store2!.id} WHERE id = ${other.id}`;
    // 五月的不算进四月
    await approved(await submit(emp.ot!, 'overtime', form('2030-05-01T10:00', '2030-05-01T12:00', '节假日')));
    // 审批中的不算
    await submit(emp.ot!, 'overtime', form('2030-04-21T10:00', '2030-04-21T12:00', '休息日'));
    const m = (await api<AttendanceMonth>(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/monthly?month=2030-04')).body;
    expect(m.rows.find((r) => r.staffId === emp.ot!.id)).toMatchObject({ scheduledDays: 0, overtimeRestMinutes: 240, overtimeWorkdayMinutes: 90, overtimeHolidayMinutes: 0 });
  });

  it('月报与「我的考勤」：请假天数与明细、出差天数；整天请假不算实际出勤，出差算；导出带假种列', async () => {
    const m = (await api<AttendanceMonth>(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/monthly?month=2030-04')).body;
    const row = (who: Emp) => m.rows.find((r) => r.staffId === who.id)!;
    expect(row(emp.leave!)).toMatchObject({ scheduledDays: 2, attendedDays: 0, absentCount: 0, leaveHalves: 4, leave: [{ name: '年假', halves: 4 }] });
    expect(row(emp.half!)).toMatchObject({ scheduledDays: 1, attendedDays: 1, leaveHalves: 1, leave: [{ name: '事假', halves: 1 }] });
    expect(row(emp.trip!)).toMatchObject({ scheduledDays: 1, attendedDays: 1, tripDays: 1, absentCount: 0 });
    // 出差那天有一张外勤卡、人事定为不算出勤：出差照样算出勤
    await punch(emp.trip!, D, '09:00');
    await ctx.sql`UPDATE oa_punches SET outwork = true, outwork_reason = '在外', lat = 30, lng = 120 WHERE staff_id = ${emp.trip!.id}`;
    await settle(D, '22:00');
    await ctx.sql`UPDATE oa_attendance_daily SET outwork_counted = false WHERE staff_id = ${emp.trip!.id}`;
    const again = (await api<AttendanceMonth>(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/monthly?month=2030-04')).body;
    expect(again.rows.find((r) => r.staffId === emp.trip!.id)).toMatchObject({ attendedDays: 1, tripDays: 1, outworkCount: 1 });
    expect(row(emp.makeup!)).toMatchObject({ missingCount: 0 });
    const res = await ctx.app.inject({ method: 'GET', url: '/api/oa/attendance/monthly.xlsx?month=2030-04', headers: { cookie: ctx.owner } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const mine = (await api<MyAttendance>(ctx.app, emp.leave!.cookie, 'GET', '/api/oa/me/attendance?month=2030-04')).body;
    expect(mine.summary).toMatchObject({ leaveHalves: 4, scheduledDays: 2, attendedDays: 0 });
    expect(mine.rows.map((r) => r.status)).toEqual(['leave', 'leave']);
    const ot = (await api<MyAttendance>(ctx.app, emp.ot!.cookie, 'GET', '/api/oa/me/attendance?month=2030-04')).body;
    expect(ot.summary).toMatchObject({ overtimeRestMinutes: 300, overtimeWorkdayMinutes: 90 });
  });
});
