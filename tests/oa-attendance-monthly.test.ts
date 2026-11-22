// OA-09 考勤月报（docs/OA.md 第 12 节）：按每日结算结果汇总每人一个月——应出勤、实际出勤（外勤定为不算出勤的不算）、
// 迟到 / 早退次数与分钟、缺卡（旷工的不重复算）、旷工、外勤；按部门筛；部门负责人只看本部门；员工不能看；导出 Excel 记审计；
// 员工「我的考勤」带本月汇总。结算结果直接写库（结算本身见 oa-attendance-daily.test.ts）。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttendanceMonth, AttendanceSetup, MyAttendance } from '../src/shared/oa';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

const M = '2031-03';
let ctx: TestContext;
type Emp = { id: number; cookie: string };
const emp: Record<string, Emp> = {};
let shiftId: number;

const hire = async (username: string, position: string): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username) };
};
const day = (who: Emp, date: string, cols: Record<string, unknown> = {}) => {
  const row = { store_id: DEFAULT_STORE_ID, staff_id: who.id, business_date: date, shift_id: shiftId, status: 'normal', ...cols };
  return ctx.sql`INSERT INTO oa_attendance_daily ${ctx.sql(row)}`;
};
const month = async (cookie = ctx.owner, extra = '') => {
  const r = await api(ctx.app, cookie, 'GET', `/api/oa/attendance/monthly?month=${M}${extra}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as AttendanceMonth;
};

beforeAll(async () => {
  ctx = await setup();
  emp.front = await hire('am_front', 'front.staff');
  emp.eng = await hire('am_eng', 'eng.staff');
  emp.lead = await hire('am_eng_lead', 'eng.lead');
  const s = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/shifts', { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID, name: '白班', startMinute: 540, endMinute: 1080 });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  shiftId = (s.body as AttendanceSetup).shifts.find((x) => x.name === '白班')!.id;
  await day(emp.front!, `${M}-02`);
  await day(emp.front!, `${M}-03`, { status: 'abnormal', late_minutes: 10 });
  await day(emp.front!, `${M}-04`, { status: 'absent', missing_in: true, missing_out: true });
  await day(emp.front!, `${M}-05`, { status: 'abnormal', missing_out: true, early_minutes: 0 });
  await day(emp.front!, `${M}-06`, { status: 'abnormal', early_minutes: 15 });
  await day(emp.front!, `${M}-07`, { outwork: true, outwork_counted: false });
  await day(emp.front!, `${M}-08`, { outwork: true });
  await day(emp.front!, '2031-04-01'); // 下个月的不算
  await day(emp.eng!, `${M}-02`);
});
afterAll(async () => {
  await ctx.close();
});

describe('OA-09 考勤月报', () => {
  it('按员工汇总：应出勤、实际出勤、迟到、早退、缺卡、旷工、外勤', async () => {
    const m = await month();
    expect(m.month).toBe(M);
    expect(m.rows.find((r) => r.staffId === emp.front!.id)).toMatchObject({
      department: '前厅部',
      scheduledDays: 7,
      attendedDays: 5, // 旷工、外勤不算出勤的两天不算
      lateCount: 1,
      lateMinutes: 10,
      earlyCount: 1,
      earlyMinutes: 15,
      missingCount: 1, // 旷工那天的两张不重复算
      absentCount: 1,
      outworkCount: 2,
    });
    expect(m.rows.find((r) => r.staffId === emp.eng!.id)).toMatchObject({ scheduledDays: 1, attendedDays: 1, department: '工程部' });
  });

  it('按部门筛；部门负责人只看本部门；员工不能看', async () => {
    expect((await month(ctx.owner, '&dept=front')).rows.map((r) => r.staffId)).toEqual([emp.front!.id]);
    const lead = await month(emp.lead!.cookie);
    expect(lead.rows.map((r) => r.staffId)).toEqual([emp.eng!.id]);
    expect(lead.departments).toEqual([{ key: 'eng', name: '工程部' }]);
    expect((await month(emp.lead!.cookie, '&dept=front')).rows).toEqual([]);
    expect((await api(ctx.app, emp.front!.cookie, 'GET', `/api/oa/attendance/monthly?month=${M}`)).status).toBe(403);
  });

  it('导出 Excel：本部门的、记审计', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/oa/attendance/monthly.xlsx?month=${M}`, headers: { cookie: emp.lead!.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(decodeURIComponent(String(res.headers['content-disposition']))).toContain(`考勤月报_${M}.xlsx`);
    expect(res.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const [a] = await ctx.sql<{ detail: { count: number } }[]>`SELECT detail FROM audit_logs WHERE action = 'export' AND target_type = 'oa_attendance_monthly'`;
    expect(a!.detail.count).toBe(1);
  });

  it('员工「我的考勤」带本月汇总', async () => {
    const me = (await api(ctx.app, emp.front!.cookie, 'GET', `/api/oa/me/attendance?month=${M}`)).body as MyAttendance;
    expect(me.summary).toMatchObject({ scheduledDays: 7, attendedDays: 5, lateCount: 1, missingCount: 1, absentCount: 1 });
    const empty = (await api(ctx.app, emp.front!.cookie, 'GET', '/api/oa/me/attendance?month=2031-01')).body as MyAttendance;
    expect(empty.summary).toMatchObject({ scheduledDays: 0, attendedDays: 0 });
  });
});
