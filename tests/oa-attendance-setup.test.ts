// OA-04 考勤组、班次、打卡点（docs/OA.md 第 7 节，OA9）：权限、班次的时间与打卡窗口核对、打卡点、考勤组的成员（一人一组）与打卡点、版本、审计。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shiftProblem, SHIFT_WINDOW_DEFAULTS, type AttendanceSetup, type AttendanceSetupSaved } from '../src/shared/oa';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

const hire = async (username: string, position: string) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username) };
};
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
/** 本店（只有一家店时就是默认门店） */
const STORE = DEFAULT_STORE_ID;
const night = { startMinute: 0, endMinute: 480, restStartMinute: null, restEndMinute: null, ...SHIFT_WINDOW_DEFAULTS };

describe('OA-04 班次的时间与打卡窗口', () => {
  it('shiftProblem：跨天班、休息段、窗口重叠', () => {
    expect(shiftProblem(night)).toBeNull();
    expect(shiftProblem({ ...night, startMinute: 1320, endMinute: 360 })).toBeNull(); // 22:00–次日 06:00
    expect(shiftProblem({ ...night, restStartMinute: 240, restEndMinute: 270 })).toBeNull();
    expect(shiftProblem({ ...night, restStartMinute: 600, restEndMinute: 630 })).toContain('休息段');
    expect(shiftProblem({ ...night, restStartMinute: 240, restEndMinute: null })).toContain('休息段');
    expect(shiftProblem({ ...night, lateGraceMinutes: 90 })).toContain('迟到弹性');
    // 2 小时的班：上班后 60 分钟、下班前 60 分钟两个窗口碰上了
    expect(shiftProblem({ ...night, endMinute: 120 })).toContain('上班窗口要在下班窗口开始之前结束');
    // 20 小时的班加上可提前、可延后各 2 小时，连着两天会重叠
    expect(shiftProblem({ ...night, endMinute: 1260 })).toContain('连着两天');
  });
});

describe('OA-04 考勤设置', () => {
  it('权限：人力行政部负责人、员工与总裁能用；前台员工不能', async () => {
    const hrStaff = await hire('att_hr_staff', 'hr.staff');
    const front = await hire('att_front', 'front.staff');
    expect((await api(ctx.app, hrStaff.cookie, 'GET', '/api/oa/attendance/setup')).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/setup')).status).toBe(200);
    expect((await api(ctx.app, front.cookie, 'GET', '/api/oa/attendance/setup')).status).toBe(403);
    expect((await api(ctx.app, front.cookie, 'POST', '/api/oa/attendance/shifts', { clientKey: randomUUID(), storeId: STORE, name: 'x', startMinute: 0, endMinute: 480 })).status).toBe(403);
  });

  it('班次：新建（窗口取默认值）、说不通的不让存、同名拒绝、带版本修改与停用、记审计', async () => {
    let r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/shifts', { clientKey: randomUUID(), storeId: STORE, name: '夜班', startMinute: 0, endMinute: 480 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    let s = (r.body as AttendanceSetup).shifts.find((x) => x.name === '夜班')!;
    expect(s).toMatchObject({ ...SHIFT_WINDOW_DEFAULTS, active: true, version: 1, restStartMinute: null });

    r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/shifts', { clientKey: randomUUID(), storeId: STORE, name: '短班', startMinute: 600, endMinute: 690 });
    expect(r.status).toBe(400);
    r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/shifts', { clientKey: randomUUID(), storeId: STORE, name: ' 夜班 ', startMinute: 600, endMinute: 1080 });
    expect(code(r)).toBe('NAME_TAKEN');

    // 改：带版本；旧版本拒绝；不带版本拒绝
    r = await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/shifts/${s.id}`, { name: '大夜班', startMinute: 1320, endMinute: 360, lateGraceMinutes: 10, version: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    s = (r.body as AttendanceSetup).shifts.find((x) => x.id === s.id)!;
    expect(s).toMatchObject({ name: '大夜班', startMinute: 1320, endMinute: 360, lateGraceMinutes: 10, version: 2 });
    expect(code(await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/shifts/${s.id}`, { name: '大夜班', startMinute: 1320, endMinute: 360, version: 1 }))).toBe('VERSION_CONFLICT');
    expect(code(await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/shifts/${s.id}`, { name: '大夜班', startMinute: 1320, endMinute: 360 }))).toBe('VERSION_REQUIRED');
    r = await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/shifts/${s.id}`, { name: '大夜班', startMinute: 1320, endMinute: 360, active: false, version: 2 });
    expect((r.body as AttendanceSetup).shifts.find((x) => x.id === s.id)).toMatchObject({ active: false, version: 3 });
    const audit = await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'oa_shift_saved' AND target_id = ${String(s.id)}`;
    expect(audit).toHaveLength(3);
  });

  it('打卡点：经纬度与半径；考勤组：要 GPS 的至少一个启用的打卡点；成员一人一组、只能是本店在职员工；停用的组不留成员', async () => {
    let r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/locations', {
      clientKey: randomUUID(),
      storeId: STORE,
      name: '总店大门',
      address: '人民路 1 号',
      lat: 31.230416,
      lng: 121.473701,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const loc = (r.body as AttendanceSetup).locations.find((x) => x.name === '总店大门')!;
    expect(loc).toMatchObject({ lat: 31.230416, lng: 121.473701, radiusM: 300 });
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/locations', { clientKey: randomUUID(), storeId: STORE, name: '坏点', lat: 91, lng: 0 })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/locations', { clientKey: randomUUID(), storeId: STORE, name: '坏点', lat: 30, lng: 120, radiusM: 5 })).status).toBe(400);

    const a = await hire('att_a', 'front.staff');
    const b = await hire('att_b', 'front.staff');
    // 要 GPS 但没有打卡点
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', { clientKey: randomUUID(), storeId: STORE, name: '前厅组', memberIds: [a.id] }))).toBe('LOCATION_REQUIRED');
    // 不要 GPS 的可以没有打卡点
    r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', { clientKey: randomUUID(), storeId: STORE, name: '外勤组', gpsRequired: false, memberIds: [a.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const field = (r.body as AttendanceSetup).groups.find((g) => g.name === '外勤组')!;
    r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', { clientKey: randomUUID(), storeId: STORE, name: '前厅组', locationIds: [loc.id], memberIds: [a.id, b.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    let setup = r.body as AttendanceSetup;
    const front = setup.groups.find((g) => g.name === '前厅组')!;
    expect(front).toMatchObject({ locationIds: [loc.id], memberIds: [a.id, b.id], gpsRequired: true, faceRequired: false });
    // 一人一组：甲从外勤组挪到了前厅组
    expect(setup.groups.find((g) => g.id === field.id)!.memberIds).toEqual([]);
    expect(setup.employees.find((e) => e.staffId === a.id)!.groupId).toBe(front.id);

    // 离职的、不存在的不能加
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${b.id}`;
    expect(code(await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/groups/${field.id}`, { name: '外勤组', gpsRequired: false, memberIds: [b.id], version: field.version }))).toBe(
      'MEMBER_INVALID',
    );
    expect(code(await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/groups/${field.id}`, { name: '外勤组', gpsRequired: false, memberIds: [999999], version: field.version }))).toBe(
      'MEMBER_INVALID',
    );
    await ctx.sql`UPDATE staff SET active = true WHERE id = ${b.id}`;

    // 停用前厅组：成员回到「没进考勤组」
    r = await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/groups/${front.id}`, { name: '前厅组', locationIds: [loc.id], memberIds: [a.id, b.id], active: false, version: front.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    setup = r.body as AttendanceSetup;
    expect(setup.groups.find((g) => g.id === front.id)).toMatchObject({ active: false, memberIds: [] });
    expect(setup.employees.find((e) => e.staffId === a.id)!.groupId).toBeNull();
    // 打卡点停用后，要 GPS 的组只剩停用的打卡点：不让存
    const l2 = (await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/locations/${loc.id}`, { name: '总店大门', lat: 31.230416, lng: 121.473701, active: false, version: loc.version }))
      .body as AttendanceSetup;
    expect(l2.locations.find((x) => x.id === loc.id)!.active).toBe(false);
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', { clientKey: randomUUID(), storeId: STORE, name: '后厨组', locationIds: [loc.id] }))).toBe('LOCATION_REQUIRED');
  });

  it('新建带操作编号：原样重提只建一个；换了内容拒绝；没带编号拒绝；确认作废后原请求晚到也不建', async () => {
    const key = randomUUID();
    const body = { clientKey: key, storeId: STORE, name: '早班', startMinute: 480, endMinute: 960 };
    let r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/shifts', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const first = r.body as AttendanceSetupSaved;
    expect(first.created).toMatchObject({ kind: 'shift', replayed: false });
    r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/shifts', body);
    expect((r.body as AttendanceSetupSaved).created).toEqual({ kind: 'shift', id: first.created!.id, replayed: true });
    expect((r.body as AttendanceSetupSaved).shifts.filter((x) => x.name === '早班')).toHaveLength(1);
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/shifts', { ...body, name: '中班' }))).toBe('IDEMPOTENCY_CONFLICT');
    // 同一编号拿去建打卡点：也拒绝
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/locations', { clientKey: key, storeId: STORE, name: '早班', lat: 30, lng: 120 }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/shifts', { name: '无编号', startMinute: 480, endMinute: 960 }))).toBe('CLIENT_KEY_REQUIRED');
    // 结果待确认的请求换了门店再重提：拒绝（不把别的店的设置建到这家店）
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/shifts', { ...body, clientKey: randomUUID(), storeId: STORE + 999 }))).toBe('STORE_SWITCHED');
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/shifts', { ...body, clientKey: randomUUID(), storeId: undefined }))).toBe('STORE_SWITCHED');
    // 查回
    const look = await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${key}?type=oa_attendance_setup`);
    expect(look.body).toMatchObject({ found: true, refId: first.created!.id });
    // 确认作废
    const late = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${late}/abandon`, { type: 'oa_attendance_setup', summary: '新建考勤组' })).status).toBe(200);
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', { clientKey: late, storeId: STORE, name: '晚到组', gpsRequired: false }))).toBe('OP_ABANDONED');
    expect((await ctx.sql`SELECT 1 FROM oa_attendance_groups WHERE name = '晚到组'`).length).toBe(0);
  });

  it('把员工从别的组挪过来：那个组的版本加一，照着旧页面保存那个组会被拒绝', async () => {
    const c = await hire('att_c', 'front.staff');
    let r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', { clientKey: randomUUID(), storeId: STORE, name: '甲组', gpsRequired: false, memberIds: [c.id] });
    const a = (r.body as AttendanceSetup).groups.find((g) => g.name === '甲组')!;
    r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', { clientKey: randomUUID(), storeId: STORE, name: '乙组', gpsRequired: false, memberIds: [c.id] });
    const setup = r.body as AttendanceSetup;
    expect(setup.groups.find((g) => g.id === a.id)).toMatchObject({ memberIds: [], version: a.version + 1 });
    // 照着旧页面（旧版本、旧名单）保存甲组：拒绝，人不会被挪回去
    expect(code(await api(ctx.app, ctx.owner, 'PUT', `/api/oa/attendance/groups/${a.id}`, { name: '甲组改名', gpsRequired: false, memberIds: [c.id], version: a.version }))).toBe('VERSION_CONFLICT');
    expect(setup.employees.find((e) => e.staffId === c.id)!.groupId).toBe(setup.groups.find((g) => g.name === '乙组')!.id);
  });

  it('别的门店：还挂在那家店的员工不能挪过来；调店以后原门店留下的旧关联不挡新门店', async () => {
    const entity = await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '考勤二店公司', taxNo: '91440300MA5XXXXK04' });
    expect(entity.status, JSON.stringify(entity.body)).toBe(201);
    const store = await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'kq', name: '考勤二店', entityId: entity.body.id });
    expect(store.status, JSON.stringify(store.body)).toBe(201);
    const kq = (store.body as { id: number }).id;
    const both = await hire('att_both', 'front.staff');
    const moved = await hire('att_moved', 'front.staff');
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${both.id}/stores`, { storeIds: [STORE, kq] })).status).toBe(200);
    // 本店的组里放这两个人
    let r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', { clientKey: randomUUID(), storeId: STORE, name: '本店组', gpsRequired: false, memberIds: [both.id, moved.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const home = (r.body as AttendanceSetup).groups.find((g) => g.name === '本店组')!;
    // 调店：moved 只挂二店
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${moved.id}/stores`, { storeIds: [kq] })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId: kq })).status).toBe(200);
    try {
      // both 还挂在本店、在本店的组里：拒绝
      expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', { clientKey: randomUUID(), storeId: kq, name: '二店组', gpsRequired: false, memberIds: [both.id] }))).toBe(
        'MEMBER_IN_OTHER_STORE',
      );
      // moved 已经调走：本店留下的旧关联不挡，挪过来
      r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', { clientKey: randomUUID(), storeId: kq, name: '二店组', gpsRequired: false, memberIds: [moved.id] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((r.body as AttendanceSetup).groups.find((g) => g.name === '二店组')!.memberIds).toEqual([moved.id]);
    } finally {
      expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId: STORE })).status).toBe(200);
    }
    // 本店组的版本加一，成员只剩 both
    const setup = (await api(ctx.app, ctx.owner, 'GET', '/api/oa/attendance/setup')).body as AttendanceSetup;
    expect(setup.groups.find((g) => g.id === home.id)).toMatchObject({ version: home.version + 1, memberIds: [both.id] });
  });
});
