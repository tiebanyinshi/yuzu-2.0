// OA-05 排班（docs/OA.md 第 8 节）：按格子保存（别人先改过拒绝、原样重提成功）、过去的不能改、同一人前后班次打卡时段不能重叠（连班除外）、
// 跨天班、部门负责人只看本部门、员工「我的排班」、排班变更通知、审计。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scheduleSpan, type AttendanceSetup, type MySchedule, type NotificationPage, type ScheduleBatchResult, type ScheduleWeek } from '../src/shared/oa';
import { shiftDate } from '../src/shared/labels';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { overlapProblem } from '../src/server/modules/oa/schedule-overlap';
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
const save = (cells: object[], clientKey: string = randomUUID(), cookie = ctx.owner) =>
  api(ctx.app, cookie, 'POST', '/api/oa/attendance/schedule', { clientKey, storeId: DEFAULT_STORE_ID, groupId, cells });
const publish = (from: string, to: string, cookie = ctx.owner, clientKey: string = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/oa/attendance/schedule/publish', { clientKey, storeId: DEFAULT_STORE_ID, groupId, from, to });

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

  it('按格子保存先存草稿不发通知；发布后才生效并推送通知；别人先改过拒绝；原样重提成功；过去的不能改', async () => {
    const tomorrow = shiftDate(today, 1);
    const key = randomUUID();
    const first = [{ staffId: a.id, date: tomorrow, shiftIds: [early], expected: EMPTY }];
    let r = await save(first, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ changed: 1, saved: { id: groupId } });
    // 同一编号原样重提：返回原来那次；换了内容拒绝；查回得到考勤组
    expect((await save(first, key)).body).toEqual({ changed: 0, saved: { id: groupId } });
    expect(code(await save([{ ...first[0], shiftIds: [night] }], key))).toBe('IDEMPOTENCY_CONFLICT');
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${key}?type=oa_schedule_save`)).body).toMatchObject({ found: true, refId: groupId });
    // 新编号、内容一样：已经是要的样子，跳过
    r = await save(first);
    expect(r.body).toEqual({ changed: 0, saved: { id: groupId } });
    // 确认作废的编号：原请求后到也不保存
    const lateKey = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${lateKey}/abandon`, { type: 'oa_schedule_save', summary: '保存排班' })).status).toBe(200);
    expect(code(await save([{ staffId: b.id, date: tomorrow, shiftIds: [early], expected: EMPTY }], lateKey))).toBe('OP_ABANDONED');
    // 换了门店的页面
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/schedule', { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID + 999, groupId, cells: first }))).toBe('STORE_SWITCHED');
    // 照着旧页面改成夜班：拒绝
    expect(code(await save([{ staffId: a.id, date: tomorrow, shiftIds: [night], expected: EMPTY }]))).toBe('SCHEDULE_CHANGED');
    // 过去的
    expect(code(await save([{ staffId: a.id, date: shiftDate(today, -1), shiftIds: [early], expected: EMPTY }]))).toBe('SCHEDULE_PAST');
    // 不在组里的员工
    const c = await hire('sch_c', 'front.staff');
    expect(code(await save([{ staffId: c.id, date: tomorrow, shiftIds: [early], expected: EMPTY }]))).toBe('SCHEDULE_MEMBER');
    // 保存草稿后：周表标待发布，员工「我的排班」暂不可见，也不发通知
    let w = await week();
    expect(w.cells).toContainEqual({ staffId: a.id, date: tomorrow, shiftIds: [early], consecutive: false, unpublished: true });
    expect(w.unpublishedCount).toBe(1);
    expect(w.editable).toBe(true);
    expect(w.publishable).toBe(true);
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'oa_schedule_saved'`).length).toBe(1);
    const beforePub = (await api(ctx.app, a.cookie, 'GET', '/api/oa/notifications?status=unread')).body as NotificationPage;
    expect(beforePub.items.some((x) => x.kind === 'schedule_change')).toBe(false);
    const meDraft = (await api(ctx.app, a.cookie, 'GET', `/api/oa/me/schedule?month=${tomorrow.slice(0, 7)}`)).body as MySchedule;
    expect(meDraft.days.find((d) => d.date === tomorrow)!.items).toEqual([]);
    // 发布排班：正式生效、推通知、记发布审计与历史
    const pubRes = await publish(tomorrow, tomorrow);
    expect(pubRes.status, JSON.stringify(pubRes.body)).toBe(200);
    expect(pubRes.body).toMatchObject({ staffCount: 1, cellCount: 1, replayed: false });
    w = await week();
    expect(w.cells).toContainEqual({ staffId: a.id, date: tomorrow, shiftIds: [early], consecutive: false });
    expect(w.unpublishedCount).toBe(0);
    expect(w.recentPublishes.length).toBeGreaterThanOrEqual(1);
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'oa_schedule_published'`).length).toBe(1);
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
    expect((await week()).cells).toContainEqual({ staffId: a.id, date: d2, shiftIds: [early, late], consecutive: true, unpublished: true });
    // 清空 = 休息
    r = await save([{ staffId: a.id, date: d2, shiftIds: [], expected: { shiftIds: [late, early], consecutive: true } }]);
    expect(r.body).toEqual({ changed: 1, saved: { id: groupId } });
  });

  it('隔一天的两条排班打卡时段也可能重叠（提前、延后都放到 12 小时）：分两次保存也拒绝', async () => {
    const s = await create('shifts', { name: '长延后', startMinute: 1380, endMinute: 660, inAdvanceMinutes: 0, outDelayMinutes: 720 });
    const wide = s.shifts.find((x) => x.name === '长延后')!.id;
    const t = await create('shifts', { name: '长提前', startMinute: 0, endMinute: 480, inAdvanceMinutes: 720, outDelayMinutes: 0 });
    const early0 = t.shifts.find((x) => x.name === '长提前')!.id;
    const d10 = shiftDate(today, 10);
    const d12 = shiftDate(today, 12);
    expect((await save([{ staffId: b.id, date: d10, shiftIds: [wide], expected: EMPTY }])).status).toBe(200);
    // d10 23:00 起、延后到 d12 前一天 23:00；d12 00:00 的班提前 12 小时，d11 12:00 起就能打
    expect(code(await save([{ staffId: b.id, date: d12, shiftIds: [early0], expected: EMPTY }]))).toBe('SCHEDULE_OVERLAP');
    expect((await save([{ staffId: b.id, date: d10, shiftIds: [], expected: { shiftIds: [wide], consecutive: false } }])).status).toBe(200);
  });

  it('改班次时间：今天起已排的班会因此重叠的拒绝；不影响的照常改', async () => {
    const z = { inAdvanceMinutes: 0, outDelayMinutes: 0 };
    let st = await create('shifts', { name: '白8', startMinute: 480, endMinute: 960, ...z });
    const day = st.shifts.find((x) => x.name === '白8')!.id;
    st = await create('shifts', { name: '晚18', startMinute: 1080, endMinute: 1320, ...z });
    const eve = st.shifts.find((x) => x.name === '晚18')!.id;
    const d = shiftDate(today, 20);
    expect((await save([{ staffId: a.id, date: d, shiftIds: [day, eve], expected: EMPTY }])).status).toBe(200);
    const version = st.shifts.find((x) => x.id === day)!.version;
    const put = (endMinute: number) => api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/shifts/${day}`, { name: '白8', startMinute: 480, endMinute, ...z, version });
    // 白8 改到 20:00 下班：与同一天的晚18（18:00 起）重叠
    const r = await put(1200);
    expect(code(r)).toBe('SCHEDULE_OVERLAP');
    expect((await ctx.sql`SELECT end_minute FROM oa_shifts WHERE id = ${day}`)[0]!.endMinute).toBe(960);
    // 改到 17:00 不重叠
    expect((await put(1020)).status).toBe(200);
    expect((await save([{ staffId: a.id, date: d, shiftIds: [], expected: { shiftIds: [day, eve], consecutive: false } }])).status).toBe(200);
  });

  it('部门经理可查看并编排本部门排班；别的部门负责人看不到也不能改；未获授权员工看不了排班表', async () => {
    const lead = await hire('sch_front_lead', 'front.lead');
    const other = await hire('sch_eng_lead', 'eng.lead');
    const w = await week(lead.cookie);
    expect(w.editable).toBe(true);
    expect(w.publishable).toBe(true);
    expect(w.members.map((m) => m.staffId).sort()).toEqual([a.id, b.id].sort());
    expect(
      (
        await api(ctx.app, other.cookie, 'POST', '/api/oa/attendance/schedule', {
          clientKey: randomUUID(),
          storeId: DEFAULT_STORE_ID,
          groupId,
          cells: [{ staffId: a.id, date: today, shiftIds: [], expected: EMPTY }],
        })
      ).status,
    ).toBe(403);
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
    expect(m.days.find((d) => d.date === tomorrow)!.items).toEqual([{ shiftId: early, name: '早班', startMinute: 480, endMinute: 960, inAdvanceMinutes: 120, consecutive: false }]);
    const mine = (await api(ctx.app, b.cookie, 'GET', `/api/oa/me/schedule?month=${tomorrow.slice(0, 7)}`)).body as MySchedule;
    expect(mine.days.find((d) => d.date === tomorrow)!.items).toEqual([]);
    expect((await api(ctx.app, a.cookie, 'GET', '/api/oa/me/schedule?month=2026-12')).body).toMatchObject({ month: '2026-12' });
    expect(((await api(ctx.app, a.cookie, 'GET', '/api/oa/me/schedule?month=2026-12')).body as MySchedule).days).toHaveLength(31);
    // 下个月 1 号的也带上（00:00 上班的在这个月最后一天提醒）
    await ctx.sql`INSERT INTO oa_schedules (staff_id, work_date, shift_id) VALUES (${b.id}, '2027-01-01', ${night})`;
    const dec = (await api(ctx.app, b.cookie, 'GET', '/api/oa/me/schedule?month=2026-12')).body as MySchedule;
    expect(dec.following).toEqual({ date: '2027-01-01', items: [{ shiftId: night, name: '夜班', startMinute: 0, endMinute: 480, inAdvanceMinutes: 120, consecutive: false }] });
    expect(dec.days.some((d) => d.date === '2027-01-01')).toBe(false);
  });

  it('我的排班的四种状态（排班优化第 4 条）：上班、休息、请假（审批通过的覆盖，半天也算）、缺勤（有一班结算成旷工）', async () => {
    const d1 = shiftDate(today, 2);
    const d2 = shiftDate(today, 3);
    const d3 = shiftDate(today, 4);
    const month = d1.slice(0, 7);
    await ctx.sql`INSERT INTO oa_schedules (staff_id, work_date, shift_id) VALUES (${b.id}, ${d1}, ${early}), (${b.id}, ${d2}, ${early}), (${b.id}, ${d3}, ${early})`;
    // d2 下午请假（审批通过的覆盖）
    const [t] = await ctx.sql<{ id: number }[]>`SELECT id FROM oa_approval_templates WHERE code = 'leave'`;
    const [lt] = await ctx.sql<{ id: number }[]>`SELECT id FROM oa_leave_types ORDER BY id LIMIT 1`;
    const [ap] = await ctx.sql<{ id: number }[]>`
      INSERT INTO oa_approvals (template_id, template_code, template_name, fields, applicant_id, title, form, status, finished_at)
      VALUES (${t!.id}, 'leave', '请假', '[]', ${b.id}, '演练请假', '{}', 'approved', now()) RETURNING id`;
    await ctx.sql`INSERT INTO oa_attendance_covers (staff_id, work_date, kind, part, halves, leave_type_id, approval_id) VALUES (${b.id}, ${d2}, 'leave', 'pm', 1, ${lt!.id}, ${ap!.id})`;
    // d3 结算成旷工
    const [st] = await ctx.sql<{ storeId: number }[]>`SELECT store_id FROM oa_shifts WHERE id = ${early}`;
    await ctx.sql`INSERT INTO oa_attendance_daily (store_id, staff_id, business_date, shift_id, status) VALUES (${st!.storeId}, ${b.id}, ${d3}, ${early}, 'absent')`;
    const m = (await api(ctx.app, b.cookie, 'GET', `/api/oa/me/schedule?month=${month}`)).body as MySchedule;
    const day = (d: string) => m.days.find((x) => x.date === d);
    if (day(d1)) expect(day(d1)).toMatchObject({ status: 'work' });
    if (day(d2)) expect(day(d2)).toMatchObject({ status: 'leave', leavePart: 'pm' });
    if (day(d3)) expect(day(d3)).toMatchObject({ status: 'absent' });
    // 没排班的日子是休息
    const rest = m.days.find((x) => x.items.length === 0 && ![d1, d2, d3].includes(x.date));
    if (rest) expect(rest.status).toBe('rest');
    expect(m.days.every((x) => ['work', 'rest', 'leave', 'absent'].includes(x.status))).toBe(true);
    // 别人看不到这位的状态（只看本人）
    const other = (await api(ctx.app, a.cookie, 'GET', `/api/oa/me/schedule?month=${month}`)).body as MySchedule;
    if (other.days.some((x) => x.date === d2)) expect(other.days.find((x) => x.date === d2)!.status).not.toBe('leave');
  });
  it('调走的员工：原门店今后的排班不再算数（不进「我的排班」、不挡新门店的排班），历史照留', async () => {
    const mv = await hire('sch_mv', 'front.staff');
    const g = ((await api(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/setup')).body as AttendanceSetup).groups.find((x) => x.id === groupId)!;
    const put = await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/groups/${groupId}`, { name: g.name, gpsRequired: false, active: true, version: g.version, memberIds: [a.id, b.id, mv.id] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const d = shiftDate(today, 30);
    expect((await save([{ staffId: mv.id, date: d, shiftIds: [early], expected: EMPTY }])).status).toBe(200);
    expect((await publish(d, d)).status).toBe(200);
    const month = async () => ((await api(ctx.app, mv.cookie, 'GET', `/api/oa/me/schedule?month=${d.slice(0, 7)}`)).body as MySchedule).days.find((x) => x.date === d)!.items;
    expect(await month()).toHaveLength(1);
    // 调到二店
    const entity = await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '排班二店公司', taxNo: '91440300MA5XXXXK05' });
    expect(entity.status, JSON.stringify(entity.body)).toBe(201);
    const store = await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'pb', name: '排班二店', entityId: (entity.body as { id: number }).id });
    expect(store.status, JSON.stringify(store.body)).toBe(201);
    const pb = (store.body as { id: number }).id;
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${mv.id}/stores`, { storeIds: [pb] })).status).toBe(200);
    expect(await month()).toEqual([]);
    // 二店同一天排晚班（与原门店那条早班的打卡时段重叠）：原门店那条不算，不重叠
    await ctx.sql`INSERT INTO oa_schedules (store_id, staff_id, work_date, shift_id) VALUES (${pb}, ${mv.id}, ${d}, ${late})`;
    expect(await ctx.sql.begin((tx) => overlapProblem(tx, [mv.id], d, d))).toBeNull();
    // 原门店的那条还在（历史不删）
    expect((await ctx.sql`SELECT 1 FROM oa_schedules WHERE staff_id = ${mv.id} AND store_id = ${DEFAULT_STORE_ID}`).length).toBe(1);
  });

  describe('批量排班（店主 2026-11-24《考勤排班功能优化需求说明》第 2、3 条）', () => {
    const batch = (body: object, cookie = ctx.owner) => api(ctx.app, cookie, 'POST', '/api/oa/attendance/schedule/batch', { storeId: DEFAULT_STORE_ID, groupId, ...body });
    const range = (from: string, n: number) => Array.from({ length: n }, (_, i) => shiftDate(from, i));
    const cellsOf = async (staffId: number, dates: string[]) =>
      ctx.sql<
        { workDate: string; shiftId: number }[]
      >`SELECT work_date::text AS work_date, shift_id FROM oa_schedules WHERE staff_id = ${staffId} AND NOT pending_delete AND work_date IN ${ctx.sql(dates)} ORDER BY work_date`;

    it('单员工一个月一次排完：预览只读、写几格；已有别的排班的不勾覆盖跳过、勾了换掉；原样重提不重复；发布后推通知', async () => {
      const m = await hire('sch_month', 'front.staff');
      const g = ((await api(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/setup')).body as AttendanceSetup).groups.find((x) => x.id === groupId)!;
      expect(
        (await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/groups/${groupId}`, { name: g.name, gpsRequired: false, active: true, version: g.version, memberIds: [...g.memberIds, m.id] }))
          .status,
      ).toBe(200);
      const days = range(shiftDate(today, 40), 30);
      // 其中一天先排了晚班
      await ctx.sql`INSERT INTO oa_schedules (staff_id, work_date, shift_id) VALUES (${m.id}, ${days[5]!}, ${late})`;
      const pv = await batch({ staffIds: [m.id], dates: days, shiftId: early, preview: true });
      expect(pv.status, JSON.stringify(pv.body)).toBe(200);
      expect(pv.body).toMatchObject({ staff: 1, days: 30, total: 30, write: 29, overwrite: 0, same: 0 });
      expect((pv.body as ScheduleBatchResult).skipped).toEqual([{ staffId: m.id, name: 'sch_month', date: days[5], reason: 'exists' }]);
      expect(await cellsOf(m.id, days)).toHaveLength(1); // 预览不写
      // 勾覆盖预览以后，别人又在另一天排了晚班：保存拒绝（SCHEDULE_CHANGED），一格不写，不悄悄覆盖
      const stale = (await batch({ staffIds: [m.id], dates: days, shiftId: early, overwrite: true, preview: true })).body as ScheduleBatchResult;
      expect(stale).toMatchObject({ write: 30, overwrite: 1 });
      await ctx.sql`INSERT INTO oa_schedules (staff_id, work_date, shift_id) VALUES (${m.id}, ${days[9]!}, ${late})`;
      expect(code(await batch({ clientKey: randomUUID(), staffIds: [m.id], dates: days, shiftId: early, overwrite: true, revision: stale.revision }))).toBe('SCHEDULE_CHANGED');
      expect(await cellsOf(m.id, days)).toHaveLength(2);
      // 没带预览版本的保存：拒绝
      expect((await batch({ clientKey: randomUUID(), staffIds: [m.id], dates: days, shiftId: early, overwrite: true })).status).toBe(400);
      // 重新预览（看到 2 格覆盖）再保存：30 格都是早班（草稿态）
      const fresh = (await batch({ staffIds: [m.id], dates: days, shiftId: early, overwrite: true, preview: true })).body as ScheduleBatchResult;
      expect(fresh).toMatchObject({ write: 30, overwrite: 2 });
      const key = randomUUID();
      const r = await batch({ clientKey: key, staffIds: [m.id], dates: days, shiftId: early, overwrite: true, revision: fresh.revision });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ write: 30, overwrite: 2, changed: 30, skipped: [] });
      const rows = await cellsOf(m.id, days);
      expect(rows).toHaveLength(30);
      expect(rows.every((x) => Number(x.shiftId) === early)).toBe(true);
      // 原样重提：不重复；换了内容拒绝
      expect((await batch({ clientKey: key, staffIds: [m.id], dates: days, shiftId: early, overwrite: true, revision: fresh.revision })).body).toMatchObject({ changed: 0 });
      expect(code(await batch({ clientKey: key, staffIds: [m.id], dates: days, shiftId: night, overwrite: true, revision: fresh.revision }))).toBe('IDEMPOTENCY_CONFLICT');
      // 再排一次：都已经是早班
      expect((await batch({ staffIds: [m.id], dates: days, shiftId: early, preview: true })).body).toMatchObject({ write: 0, same: 30 });
      // 批量后单格照样能改
      const wk = await week(ctx.owner, days[0]);
      expect(wk.cells.find((c) => c.staffId === m.id && c.date === days[0])).toMatchObject({ shiftIds: [early], unpublished: true });
      expect((await save([{ staffId: m.id, date: days[0], shiftIds: [late], expected: { shiftIds: [early], consecutive: false } }])).status).toBe(200);
      expect((await cellsOf(m.id, [days[0]!]))[0]).toMatchObject({ shiftId: late });
      // 未发布前不推送通知；发布后员工收到「排班已发布」通知
      const before = (await api(ctx.app, m.cookie, 'GET', '/api/oa/notifications')).body as NotificationPage;
      expect(before.items.some((x) => x.kind === 'schedule_change')).toBe(false);
      expect((await publish(days[0]!, days.at(-1)!)).status).toBe(200);
      const n = (await api(ctx.app, m.cookie, 'GET', '/api/oa/notifications')).body as NotificationPage;
      expect(n.items.some((x) => x.kind === 'schedule_change' && x.title === '排班已发布')).toBe(true);
    });

    it('多员工 × 一段日子统一排：请假的日子自动跳过并列出；过去的跳过；不在组里的拒绝；外部门负责人与无授权员工不能排', async () => {
      const g = ((await api(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/setup')).body as AttendanceSetup).groups.find((x) => x.id === groupId)!;
      const c3 = await hire('sch_c3', 'front.staff');
      expect(
        (await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/groups/${groupId}`, { name: g.name, gpsRequired: false, active: true, version: g.version, memberIds: [...g.memberIds, c3.id] }))
          .status,
      ).toBe(200);
      const staffIds = [a.id, b.id, c3.id];
      const days = range(shiftDate(today, 75), 10);
      // c3 第 3 天请假（审批通过的覆盖）
      const [t] = await ctx.sql<{ id: number }[]>`SELECT id FROM oa_approval_templates WHERE code = 'leave'`;
      const [lt] = await ctx.sql<{ id: number }[]>`SELECT id FROM oa_leave_types ORDER BY id LIMIT 1`;
      const [ap] = await ctx.sql<{ id: number }[]>`
        INSERT INTO oa_approvals (template_id, template_code, template_name, fields, applicant_id, title, form, status, finished_at)
        VALUES (${t!.id}, 'leave', '请假', '[]', ${c3.id}, '批量排班演练请假', '{}', 'approved', now()) RETURNING id`;
      await ctx.sql`INSERT INTO oa_attendance_covers (staff_id, work_date, kind, part, halves, leave_type_id, approval_id) VALUES (${c3.id}, ${days[2]!}, 'leave', 'full', 2, ${lt!.id}, ${ap!.id})`;
      const pv = (await batch({ staffIds, dates: days, shiftId: early, preview: true })).body as ScheduleBatchResult;
      expect(pv).toMatchObject({ staff: 3, days: 10, total: 30, write: 29 });
      expect(pv.skipped).toEqual([{ staffId: c3.id, name: 'sch_c3', date: days[2], reason: 'leave' }]);
      const r = await batch({ clientKey: randomUUID(), staffIds, dates: days, shiftId: early, revision: pv.revision });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ changed: 29 });
      for (const id of staffIds) expect(await cellsOf(id, days)).toHaveLength(id === c3.id ? 9 : 10);
      expect((await cellsOf(c3.id, [days[2]!])).length).toBe(0);
      // 过去的、太远的跳过
      const odd = (await batch({ staffIds: [a.id], dates: [shiftDate(today, -1), shiftDate(today, 200)], shiftId: early, preview: true })).body as ScheduleBatchResult;
      expect(odd.skipped.map((x) => x.reason).sort()).toEqual(['past', 'too_far']);
      // 不在这个组里的员工：拒绝
      const out = await hire('sch_out', 'front.staff');
      expect(code(await batch({ staffIds: [out.id], dates: days, shiftId: early, preview: true }))).toBe('SCHEDULE_MEMBER');
      // 外部门负责人与未获授权员工：拒绝
      const otherLead = await hire('sch_other_lead', 'eng.lead');
      expect((await batch({ staffIds: [a.id], dates: days, shiftId: early, preview: true }, otherLead.cookie)).status).toBe(403);
      expect((await batch({ staffIds: [a.id], dates: days, shiftId: early, preview: true }, a.cookie)).status).toBe(403);
      // 保存要操作编号
      expect((await batch({ staffIds: [a.id], dates: days, shiftId: early, revision: pv.revision })).status).toBe(400);
    });
  });
});
