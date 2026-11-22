// OA-06 打卡（docs/OA.md 第 9 节）：按班次窗口匹配排班（夜班前一天打上班卡、跨天班下班卡记在上班那天）、迟到与早退、
// 有效卡（上班第一次、下班最后一次）、窗口外与休息日打卡、连班交接、GPS 围栏与外勤、同坐标多人告警、幂等与确认作废、
// 已经打过卡的排班不能删、后台打卡记录（部门负责人只看本部门）、没进考勤组不能打卡。
// 打卡按服务端的时间：只假装 Date（会话按数据库的时间，不受影响），门店时区 Asia/Shanghai。
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { matchPunch, punchWindows, type AttendanceSetup, type PunchDay, type PunchResult, type PunchToday } from '../src/shared/oa';
import { shiftDate } from '../src/shared/labels';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

const D = '2030-03-11';
const at = (date: string, hhmm: string) => vi.setSystemTime(new Date(`${date}T${hhmm}:00+08:00`));
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const HERE = { lat: 31.230416, lng: 121.473701 };
const FAR = { lat: 31.25, lng: 121.5 };

let ctx: TestContext;
type Emp = { id: number; cookie: string };
let a: Emp;
let b: Emp;
let c: Emp;
let g1: Emp;
let g2: Emp;
let loner: Emp;
const shifts: Record<string, number> = {};
let plainGroup: number;

const hire = async (username: string, position: string): Promise<Emp> => {
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
const EMPTY = { shiftIds: [] as number[], consecutive: false };
const schedule = async (staffId: number, date: string, names: string[], consecutive = false, expected = EMPTY) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/schedule', {
    clientKey: randomUUID(),
    storeId: DEFAULT_STORE_ID,
    groupId: plainGroup,
    cells: [{ staffId, date, shiftIds: names.map((n) => shifts[n]!), consecutive, expected }],
  });
  return r;
};
const punch = (who: Emp, body: object = {}, clientKey = randomUUID()) => api(ctx.app, who.cookie, 'POST', '/api/oa/attendance/punch', { clientKey, storeId: DEFAULT_STORE_ID, ...body });
const ok = async (who: Emp, body: object = {}) => {
  const r = await punch(who, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as PunchResult;
};

beforeAll(async () => {
  ctx = await setup();
  a = await hire('pc_a', 'front.staff');
  b = await hire('pc_b', 'front.staff');
  c = await hire('pc_c', 'front.staff');
  g1 = await hire('pc_g1', 'eng.staff');
  g2 = await hire('pc_g2', 'eng.staff');
  loner = await hire('pc_loner', 'front.staff');
  vi.useFakeTimers({ toFake: ['Date'] });
  at(shiftDate(D, -1), '09:00');
  const w = { inAdvanceMinutes: 120, lateGraceMinutes: 0, inAfterMinutes: 60, outBeforeMinutes: 60, outDelayMinutes: 120 };
  for (const [name, startMinute, endMinute] of [
    ['夜班', 0, 480],
    ['白班', 540, 1080],
    ['早班', 480, 960],
    ['晚班', 960, 0],
  ] as const) {
    const s = await create('shifts', { name, startMinute, endMinute, ...w });
    shifts[name] = s.shifts.find((x) => x.name === name)!.id;
  }
  let s = await create('groups', { name: '前厅', gpsRequired: false, memberIds: [a.id, b.id, c.id] });
  plainGroup = s.groups.find((x) => x.name === '前厅')!.id;
  s = await create('locations', { name: '本店', lat: HERE.lat, lng: HERE.lng, radiusM: 300 });
  const loc = s.locations.find((x) => x.name === '本店')!.id;
  await create('groups', { name: '工程', gpsRequired: true, locationIds: [loc], memberIds: [g1.id, g2.id] });
  expect((await schedule(a.id, D, ['夜班'])).status).toBe(200);
  expect((await schedule(b.id, D, ['白班'])).status).toBe(200);
  expect((await schedule(a.id, shiftDate(D, 1), ['早班', '晚班'], true)).status).toBe(200);
});
afterEach(() => at(shiftDate(D, -1), '09:00'));
afterAll(async () => {
  vi.useRealTimers();
  await ctx.close();
});

describe('OA-06 打卡', () => {
  it('matchPunch：连班交接先给还没打的那一张；都打过给最近的', () => {
    const early = punchWindows(D, { startMinute: 480, endMinute: 960, inAdvanceMinutes: 120, lateGraceMinutes: 0, inAfterMinutes: 60, outBeforeMinutes: 60, outDelayMinutes: 120 });
    const late = punchWindows(D, { startMinute: 960, endMinute: 0, inAdvanceMinutes: 120, lateGraceMinutes: 0, inAfterMinutes: 60, outBeforeMinutes: 60, outDelayMinutes: 120 });
    const slots = [
      { date: D, shiftId: 1, windows: early, hasIn: true, hasOut: false },
      { date: D, shiftId: 2, windows: late, hasIn: false, hasOut: false },
    ];
    expect(matchPunch(early.end, slots)).toMatchObject({ kind: 'out', slot: { shiftId: 1 } });
    expect(matchPunch(early.end, [{ ...slots[0]!, hasOut: true }, slots[1]!])).toMatchObject({ kind: 'in', slot: { shiftId: 2 } });
    expect(
      matchPunch(early.end + 30, [
        { ...slots[0]!, hasOut: true },
        { ...slots[1]!, hasIn: true },
      ]),
    ).toMatchObject({ kind: 'out', slot: { shiftId: 1 } }); // 都打过了、离两个基准一样近：给先的那个（下班卡取最后一次，等于更新下班时间）
    expect(matchPunch(early.start + 200, slots)).toMatchObject({ kind: 'outside' });
    expect(matchPunch(late.outTo + 1, slots)).toEqual({ kind: 'rest' });
  });

  it('夜班 00:00–08:00：前一天 23:50 打的是这一班的上班卡（不迟到）；07:30 早退、08:05 再打，下班卡取最后一次；原样重提返回原来那一次', async () => {
    at(shiftDate(D, -1), '23:50');
    const first = await ok(a);
    expect(first.punch).toMatchObject({ kind: 'in', businessDate: D, shiftId: shifts['夜班'], lateMinutes: 0, localDate: shiftDate(D, -1), localTime: '23:50' });
    expect(first.effective!.id).toBe(first.punch.id);
    at(D, '07:30');
    const key = randomUUID();
    let r = await punch(a, {}, key);
    const early = r.body as PunchResult;
    expect(early.punch).toMatchObject({ kind: 'out', businessDate: D, earlyMinutes: 30 });
    // 原样重提：时间按第一次
    at(D, '07:45');
    r = await punch(a, {}, key);
    expect(r.body).toMatchObject({ replayed: true, punch: { id: early.punch.id, localTime: '07:30' } });
    at(D, '08:05');
    const last = await ok(a);
    expect(last.punch).toMatchObject({ kind: 'out', businessDate: D, earlyMinutes: 0 });
    expect(last.effective!.id).toBe(last.punch.id);
    // 打卡页：这一班上班 23:50、下班 08:05
    const today = (await api(ctx.app, a.cookie, 'GET', '/api/oa/attendance/today')).body as PunchToday;
    const slot = today.slots.find((s) => s.date === D && s.shiftId === shifts['夜班'])!;
    expect(slot.in!.localTime).toBe('23:50');
    expect(slot.out!.localTime).toBe('08:05');
    expect(today.group).toMatchObject({ name: '前厅', gpsRequired: false });
  });

  it('白班 09:00：09:10 打算迟到 10 分钟；09:20 再打返回第一次那张有效卡；中途打是窗口外；没排班的人是休息日打卡', async () => {
    at(D, '09:10');
    const late = await ok(b);
    expect(late.punch).toMatchObject({ kind: 'in', lateMinutes: 10 });
    at(D, '09:20');
    const again = await ok(b);
    expect(again.punch.kind).toBe('in');
    expect(again.effective!.id).toBe(late.punch.id);
    at(D, '13:00');
    expect((await ok(b)).punch).toMatchObject({ kind: 'outside', businessDate: D, shiftId: null });
    expect((await ok(c)).punch).toMatchObject({ kind: 'rest', businessDate: D, shiftId: null });
  });

  it('连班 08:00–16:00 接 16:00–24:00：16:00 第一次算前一班下班，第二次算后一班上班', async () => {
    const d = shiftDate(D, 1);
    at(d, '07:55');
    expect((await ok(a)).punch).toMatchObject({ kind: 'in', shiftId: shifts['早班'] });
    at(d, '16:00');
    expect((await ok(a)).punch).toMatchObject({ kind: 'out', shiftId: shifts['早班'], earlyMinutes: 0 });
    expect((await ok(a)).punch).toMatchObject({ kind: 'in', shiftId: shifts['晚班'], lateMinutes: 0 });
  });

  it('GPS：要定位、范围外拒绝；外勤要事由与照片；范围内不用外勤；同坐标一分钟内多人告警', async () => {
    at(D, '10:00');
    expect(code(await punch(g1))).toBe('LOCATION_REQUIRED');
    const far = await punch(g1, FAR);
    expect(code(far)).toBe('LOCATION_OUT');
    expect((far.body as { error: { message: string } }).error.message).toContain('本店');
    // 外勤：先传照片
    const up = await api(ctx.app, g1.cookie, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName: '外勤.jpg', mime: 'image/jpeg', data: JPEG.toString('base64') });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const photoId = (up.body as { id: number }).id;
    const out = await ok(g1, { ...FAR, accuracy: 25, outwork: { reason: '去供应商那里验货', photoId } });
    expect(out.punch).toMatchObject({ kind: 'rest', outwork: true, locationOk: false, outworkReason: '去供应商那里验货', accuracyM: 25, locationName: '本店' });
    expect(out.punch.photo).toMatchObject({ id: photoId });
    // 照片挂上以后不能再用；在范围内不用外勤
    expect(code(await punch(g2, { ...HERE, outwork: { reason: 'x', photoId } }))).toBe('OUTWORK_NOT_NEEDED');
    const inside = await ok(g2, HERE);
    expect(inside.punch).toMatchObject({ locationOk: true, outwork: false, locationName: '本店', distanceM: 0, sharedLocation: false });
    const shared = await ok(g1, HERE);
    expect(shared.punch.sharedLocation).toBe(true);
  });

  it('几个打卡点半径不同：在任何一个的范围里就算在范围内（最近的不一定覆盖到），记下的是覆盖到的那个', async () => {
    at(D, '10:30');
    const m = await hire('pc_multi', 'kitchen.staff');
    // 北边约 100 米、半径 50 米（不覆盖）；南边约 200 米、半径 300 米（覆盖）
    let s = await create('locations', { name: '北门', lat: HERE.lat + 0.0009, lng: HERE.lng, radiusM: 50 });
    const north = s.locations.find((x) => x.name === '北门')!.id;
    s = await create('locations', { name: '南院', lat: HERE.lat - 0.0018, lng: HERE.lng, radiusM: 300 });
    const south = s.locations.find((x) => x.name === '南院')!.id;
    await create('groups', { name: '两个点', gpsRequired: true, locationIds: [north, south], memberIds: [m.id] });
    const r = await ok(m, HERE);
    expect(r.punch).toMatchObject({ locationOk: true, outwork: false, locationName: '南院' });
    expect(r.punch.distanceM).toBeGreaterThan(150);
  });

  it('没进考勤组不能打卡；只能查回、作废自己的打卡编号', async () => {
    at(D, '10:00');
    expect(code(await punch(loner))).toBe('PUNCH_NO_GROUP');
    const key = randomUUID();
    expect((await punch(b, {}, key)).status).toBe(200);
    expect((await api(ctx.app, b.cookie, 'GET', `/api/erp/ops/${key}?type=oa_punch`)).body).toMatchObject({ found: true });
    expect((await api(ctx.app, c.cookie, 'GET', `/api/erp/ops/${key}?type=oa_punch`)).status).toBe(403);
    expect((await api(ctx.app, c.cookie, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'oa_punch', summary: '打卡' })).status).toBe(403);
    const late = randomUUID();
    expect((await api(ctx.app, c.cookie, 'POST', `/api/erp/ops/${late}/abandon`, { type: 'oa_punch', summary: '打卡' })).status).toBe(200);
    expect(code(await punch(c, {}, late))).toBe('OP_ABANDONED');
    // 别人拿这个编号原样重提（同一台电脑换人登录以后从「结果待确认」重提）：拒绝，不把 b 的打卡给 c 看
    expect((await punch(c, {}, key)).status).toBe(403);
    expect(code(await punch(b, { device: '换了内容' }, key))).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('已经打过卡的那一班不能从排班里删；没打过的照常改', async () => {
    const d2 = shiftDate(D, 2);
    at(shiftDate(D, 1), '20:00');
    expect((await schedule(b.id, d2, ['夜班'])).status).toBe(200);
    expect((await schedule(b.id, shiftDate(D, 3), ['白班'])).status).toBe(200);
    at(d2, '00:30');
    // 00:30 在夜班的上班窗口里（上班后再开 60 分钟），迟到 30 分钟
    expect((await ok(b)).punch).toMatchObject({ kind: 'in', businessDate: d2, shiftId: shifts['夜班'], lateMinutes: 30 });
    expect(code(await schedule(b.id, d2, ['白班'], false, { shiftIds: [shifts['夜班']!], consecutive: false }))).toBe('SCHEDULE_PUNCHED');
    // 还没打过卡的那一天照常改
    expect((await schedule(b.id, shiftDate(D, 3), [], false, { shiftIds: [shifts['白班']!], consecutive: false })).status).toBe(200);
  });

  it('后台打卡记录：按业务日期，标有效卡；部门负责人只看本部门；员工看不了', async () => {
    const r = await api(ctx.app, ctx.owner, 'GET', `/api/oa/attendance/punches?date=${D}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const day = r.body as PunchDay;
    const nightOuts = day.records.filter((x) => x.staffId === a.id && x.kind === 'out' && x.shiftId === shifts['夜班']);
    expect(nightOuts.map((x) => [x.localTime, x.effective])).toEqual([
      ['07:30', false],
      ['08:05', true],
    ]);
    expect(day.records.some((x) => x.staffId === g1.id && x.outwork && x.photo)).toBe(true);
    expect(day.records.find((x) => x.staffId === a.id)!.deviceInfo).toBeTypeOf('string');
    const eng = await hire('pc_eng_lead', 'eng.lead');
    const mine = (await api(ctx.app, eng.cookie, 'GET', `/api/oa/attendance/punches?date=${D}`)).body as PunchDay;
    expect(new Set(mine.records.map((x) => x.staffId))).toEqual(new Set([g1.id, g2.id]));
    // 部门负责人看得到本部门的外勤照片，看不到别的部门的
    const photo = mine.records.find((x) => x.photo)!.photo!;
    expect((await api(ctx.app, eng.cookie, 'GET', photo.url)).status).toBe(200);
    const front = await hire('pc_front_lead', 'front.lead');
    expect((await api(ctx.app, front.cookie, 'GET', photo.url)).status).toBe(404);
    expect((await api(ctx.app, a.cookie, 'GET', `/api/oa/attendance/punches?date=${D}`)).status).toBe(403);
  });
});
