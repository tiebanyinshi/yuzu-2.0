// 员工办公 v1.1 第 2 批（docs/OA_MOBILE.md 第五节）：24 小时三班倒打卡窗口与「该打什么卡」回归用例。
//   · 早班 08:00–16:00（in 06:00–09:00，out 15:00–18:00）
//   · 晚班 16:00–00:00（in 14:00–17:00，out 23:00–次日 02:00；跨午夜下班卡业务日期归上班日）
//   · 夜班 00:00–08:00（in 前一日 22:00–当日 01:00，out 07:00–10:00；前一日 22:00 起可打上班卡，业务日期归次日）
//   · 覆盖：全部边界分钟、连班交接（早+晚 16:00、晚+夜 00:00）、未发布草稿不可打卡、nextPunch 提示流转、三班日结归属。
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  epochMinuteOf,
  matchPunch,
  nextPunchHint,
  punchWindows,
  type AttendanceDay,
  type AttendanceSetup,
  type PunchGroupInfo,
  type PunchResult,
  type PunchSlotView,
  type PunchToday,
} from '../src/shared/oa';
import { shiftDate } from '../src/shared/labels';
import { runAttendanceSettlement } from '../src/server/modules/oa/attendance-daily';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

const D = '2030-05-15';
const D_PREV = shiftDate(D, -1);
const D_NEXT = shiftDate(D, 1);
const W_DEF = { inAdvanceMinutes: 120, lateGraceMinutes: 0, inAfterMinutes: 60, outBeforeMinutes: 60, outDelayMinutes: 120 };
const SHIFT_DEF = {
  early: { name: '早班', startMinute: 480, endMinute: 960, ...W_DEF },
  evening: { name: '晚班', startMinute: 960, endMinute: 0, ...W_DEF },
  night: { name: '夜班', startMinute: 0, endMinute: 480, ...W_DEF },
} as const;

const GROUP_INFO: PunchGroupInfo = { id: 1, name: '三班倒组', gpsRequired: true, faceRequired: false, locations: [] };
const fakePunch = (time: string, earlyMinutes = 0) => ({
  id: 1,
  punchedAt: '2030-05-15T00:00:00.000Z',
  localDate: D,
  localTime: time,
  kind: 'out' as const,
  businessDate: D,
  shiftId: 1,
  shiftName: '早班',
  lateMinutes: 0,
  earlyMinutes,
  locationName: null,
  distanceM: null,
  accuracyM: null,
  locationOk: true,
  outwork: false,
  outworkReason: null,
  photo: null,
  sharedLocation: false,
  faceResult: null,
  facePhoto: null,
  makeup: false,
});

const mkView = (date: string, shiftId: number, def: (typeof SHIFT_DEF)[keyof typeof SHIFT_DEF], hasIn = false, hasOut = false, earlyOut = 0): PunchSlotView => ({
  date,
  shiftId,
  name: def.name,
  startMinute: def.startMinute,
  endMinute: def.endMinute,
  windows: punchWindows(date, def),
  in: hasIn ? fakePunch('08:00') : null,
  out: hasOut ? fakePunch('15:30', earlyOut) : null,
});

describe('三班倒打卡窗口与 nextPunchHint 纯函数回归', () => {
  it('早 / 晚 / 夜三班全部窗口边界精确匹配，不按自然日硬切', () => {
    const night = { date: D, shiftId: 3, windows: punchWindows(D, SHIFT_DEF.night), hasIn: false, hasOut: false };
    // 夜班 00:00–08:00：前一日 21:59 不在窗口，22:00 准点开窗，00:00 不迟到，00:01 迟到 1 分，01:00 迟到 60 分，01:01 窗口外
    expect(matchPunch(epochMinuteOf(D_PREV, 21 * 60 + 59), [night])).toEqual({ kind: 'rest' });
    expect(matchPunch(epochMinuteOf(D_PREV, 22 * 60), [night])).toMatchObject({ kind: 'in', lateMinutes: 0, slot: { date: D, shiftId: 3 } });
    expect(matchPunch(epochMinuteOf(D, 0), [night])).toMatchObject({ kind: 'in', lateMinutes: 0, slot: { date: D } });
    expect(matchPunch(epochMinuteOf(D, 1), [night])).toMatchObject({ kind: 'in', lateMinutes: 1 });
    expect(matchPunch(epochMinuteOf(D, 60), [night])).toMatchObject({ kind: 'in', lateMinutes: 60 });
    expect(matchPunch(epochMinuteOf(D, 61), [night])).toMatchObject({ kind: 'outside', slot: { date: D } });
    expect(matchPunch(epochMinuteOf(D, 7 * 60), [night])).toMatchObject({ kind: 'out', earlyMinutes: 60 });
    expect(matchPunch(epochMinuteOf(D, 8 * 60), [night])).toMatchObject({ kind: 'out', earlyMinutes: 0 });
    expect(matchPunch(epochMinuteOf(D, 10 * 60), [night])).toMatchObject({ kind: 'out', earlyMinutes: 0 });
    expect(matchPunch(epochMinuteOf(D, 10 * 60 + 1), [night])).toEqual({ kind: 'rest' });

    // 晚班 16:00–00:00：跨午夜下班卡 00:00–02:00 业务日期仍归 D
    const eve = { date: D, shiftId: 2, windows: punchWindows(D, SHIFT_DEF.evening), hasIn: true, hasOut: false };
    expect(matchPunch(epochMinuteOf(D, 23 * 60), [eve])).toMatchObject({ kind: 'out', earlyMinutes: 60, slot: { date: D } });
    expect(matchPunch(epochMinuteOf(D_NEXT, 0), [eve])).toMatchObject({ kind: 'out', earlyMinutes: 0, slot: { date: D } });
    expect(matchPunch(epochMinuteOf(D_NEXT, 2 * 60), [eve])).toMatchObject({ kind: 'out', earlyMinutes: 0, slot: { date: D } });
    expect(matchPunch(epochMinuteOf(D_NEXT, 2 * 60 + 1), [eve])).toEqual({ kind: 'rest' });
  });

  it('跨午夜连班交接（D 晚班 16:00–00:00 + D+1 夜班 00:00–08:00）：00:00 先打前班下班卡再打次班上班卡', () => {
    const eve = { date: D, shiftId: 2, windows: punchWindows(D, SHIFT_DEF.evening), hasIn: true, hasOut: false };
    const night = { date: D_NEXT, shiftId: 3, windows: punchWindows(D_NEXT, SHIFT_DEF.night), hasIn: false, hasOut: false };
    const midnight = epochMinuteOf(D_NEXT, 0);
    // 第一卡：D 晚班下班卡
    expect(matchPunch(midnight, [eve, night])).toMatchObject({ kind: 'out', earlyMinutes: 0, slot: { date: D, shiftId: 2 } });
    // 第二卡（晚班已打下班卡）：D+1 夜班上班卡
    expect(matchPunch(midnight, [{ ...eve, hasOut: true }, night])).toMatchObject({ kind: 'in', lateMinutes: 0, slot: { date: D_NEXT, shiftId: 3 } });

    // nextPunchHint 同口径：先提示打晚班下班卡，打完立刻切换提示打夜班上班卡，再打完切到待打夜班下班卡
    const vEveOpen = mkView(D, 2, SHIFT_DEF.evening, true, false);
    const vNightOpen = mkView(D_NEXT, 3, SHIFT_DEF.night, false, false);
    expect(nextPunchHint(midnight, D_NEXT, [vEveOpen, vNightOpen], GROUP_INFO)).toMatchObject({ action: 'out', label: '打下班卡', shiftName: '晚班', businessDate: D, outworkAllowed: true });
    const vEveDone = mkView(D, 2, SHIFT_DEF.evening, true, true);
    expect(nextPunchHint(midnight, D_NEXT, [vEveDone, vNightOpen], GROUP_INFO)).toMatchObject({ action: 'in', label: '打上班卡', shiftName: '夜班', businessDate: D_NEXT });
    const vNightIn = mkView(D_NEXT, 3, SHIFT_DEF.night, true, false);
    expect(nextPunchHint(midnight + 5, D_NEXT, [vEveDone, vNightIn], GROUP_INFO)).toMatchObject({ action: 'wait', label: '待打下班卡', shiftName: '夜班' });
  });

  it('nextPunchHint：早退重打提示「更新下班卡」、未入组与休息日提示准确', () => {
    const earlyEarlyOut = mkView(D, 1, SHIFT_DEF.early, true, true, 30);
    expect(nextPunchHint(epochMinuteOf(D, 16 * 60 + 5), D, [earlyEarlyOut], GROUP_INFO)).toMatchObject({ action: 'out', label: '更新下班卡', inWindow: true });
    expect(nextPunchHint(epochMinuteOf(D, 10 * 60), D, [], null)).toMatchObject({ action: 'no_group', label: '未入考勤组', outworkAllowed: false });
    expect(nextPunchHint(epochMinuteOf(D, 10 * 60), D, [], GROUP_INFO)).toMatchObject({ action: 'rest', label: '今日休息' });
  });
});

describe('三班倒端到端打卡、today 接口与日结回归', () => {
  const time = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+08:00`);
  const at = (date: string, hhmm: string) => vi.setSystemTime(time(date, hhmm));

  let ctx: TestContext;
  type Emp = { id: number; cookie: string };
  let empEarly: Emp;
  let empEve: Emp;
  let empNight: Emp;
  let empCombo: Emp;
  let groupId: number;
  const sid: Record<'early' | 'evening' | 'night', number> = { early: 0, evening: 0, night: 0 };

  const hire = async (username: string): Promise<Emp> => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position: 'front.staff', password: PASSWORD });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
    return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username) };
  };
  const punch = async (who: Emp, date: string, hhmm: string) => {
    at(date, hhmm);
    const r = await api<PunchResult>(ctx.app, who.cookie, 'POST', '/api/oa/attendance/punch', { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };
  const todayOf = async (who: Emp, date: string, hhmm: string) => {
    at(date, hhmm);
    const r = await api<PunchToday>(ctx.app, who.cookie, 'GET', '/api/oa/attendance/today');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };

  beforeAll(async () => {
    ctx = await setup();
    empEarly = await hire('ts_early');
    empEve = await hire('ts_eve');
    empNight = await hire('ts_night');
    empCombo = await hire('ts_combo');
    vi.useFakeTimers({ toFake: ['Date'] });
    at(shiftDate(D, -2), '09:00');
    const make = async (path: string, body: object) => {
      const r = await api<AttendanceSetup>(ctx.app, ctx.owner, 'POST', `/api/oa/attendance/${path}`, { clientKey: randomUUID(), storeId: DEFAULT_STORE_ID, ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body;
    };
    for (const k of ['early', 'evening', 'night'] as const) {
      const res = await make('shifts', SHIFT_DEF[k]);
      sid[k] = res.shifts.find((x) => x.name === SHIFT_DEF[k].name)!.id;
    }
    const g = await make('groups', { name: '三班倒', gpsRequired: false, memberIds: [empEarly.id, empEve.id, empNight.id, empCombo.id] });
    groupId = g.groups.find((x) => x.name === '三班倒')!.id;
  });

  afterEach(() => at(shiftDate(D, -2), '09:00'));
  afterAll(async () => {
    vi.useRealTimers();
    await ctx.close();
  });

  it('三班排班草稿未发布前按休息处理；发布后完整走完早/晚/夜/跨午夜连班打卡与日结归属', async () => {
    const empty = { shiftIds: [], consecutive: false };
    // 保存三班倒排班草稿
    const save = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/schedule', {
      clientKey: randomUUID(),
      storeId: DEFAULT_STORE_ID,
      groupId,
      cells: [
        { staffId: empEarly.id, date: D, shiftIds: [sid.early], consecutive: false, expected: empty },
        { staffId: empEve.id, date: D, shiftIds: [sid.evening], consecutive: false, expected: empty },
        { staffId: empNight.id, date: D, shiftIds: [sid.night], consecutive: false, expected: empty },
        { staffId: empCombo.id, date: D, shiftIds: [sid.evening], consecutive: false, expected: empty },
        { staffId: empCombo.id, date: D_NEXT, shiftIds: [sid.night], consecutive: true, expected: empty },
      ],
    });
    expect(save.status, JSON.stringify(save.body)).toBe(200);

    // 未发布前：夜班员工在前一日 22:15 看 today 仍是「今日休息」，打卡按休息日处理
    expect((await todayOf(empNight, D_PREV, '22:15')).nextPunch).toMatchObject({ action: 'rest', label: '今日休息' });
    expect((await punch(empNight, D_PREV, '22:15')).punch.kind).toBe('rest');

    // 发布排班
    at(shiftDate(D, -2), '10:00');
    const pub = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/schedule/publish', {
      clientKey: randomUUID(),
      storeId: DEFAULT_STORE_ID,
      groupId,
      from: D,
      to: D_NEXT,
    });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);

    // 1. 夜班（D 00:00–08:00）：前一日 21:30 待打上班卡 → 22:20 打上班卡 → 22:25 待打下班卡 → D 08:05 打下班卡 → 今日已打卡
    expect((await todayOf(empNight, D_PREV, '21:30')).nextPunch).toMatchObject({ action: 'wait', label: '待打上班卡', shiftName: '夜班', businessDate: D });
    expect((await todayOf(empNight, D_PREV, '22:20')).nextPunch).toMatchObject({ action: 'in', label: '打上班卡', shiftName: '夜班', businessDate: D, inWindow: true });
    expect((await punch(empNight, D_PREV, '22:20')).punch).toMatchObject({ kind: 'in', businessDate: D, shiftId: sid.night, lateMinutes: 0 });
    expect((await todayOf(empNight, D_PREV, '22:25')).nextPunch).toMatchObject({ action: 'wait', label: '待打下班卡', shiftName: '夜班', businessDate: D });
    expect((await todayOf(empNight, D, '08:05')).nextPunch).toMatchObject({ action: 'out', label: '打下班卡', shiftName: '夜班', businessDate: D });
    expect((await punch(empNight, D, '08:05')).punch).toMatchObject({ kind: 'out', businessDate: D, shiftId: sid.night, earlyMinutes: 0 });
    expect((await todayOf(empNight, D, '08:10')).nextPunch).toMatchObject({ action: 'done', label: '今日已打卡' });

    // 2. 早班（D 08:00–16:00）：07:50 上班、16:10 下班
    expect((await punch(empEarly, D, '07:50')).punch).toMatchObject({ kind: 'in', businessDate: D, shiftId: sid.early, lateMinutes: 0 });
    expect((await punch(empEarly, D, '16:10')).punch).toMatchObject({ kind: 'out', businessDate: D, shiftId: sid.early, earlyMinutes: 0 });

    // 3. 晚班（D 16:00–00:00）：D 15:55 上班、D+1 00:20 跨午夜下班，业务日期归 D
    expect((await punch(empEve, D, '15:55')).punch).toMatchObject({ kind: 'in', businessDate: D, shiftId: sid.evening, lateMinutes: 0 });
    expect((await todayOf(empEve, D_NEXT, '00:20')).nextPunch).toMatchObject({ action: 'out', label: '打下班卡', shiftName: '晚班', businessDate: D });
    expect((await punch(empEve, D_NEXT, '00:20')).punch).toMatchObject({ kind: 'out', businessDate: D, shiftId: sid.evening, earlyMinutes: 0 });

    // 4. 跨午夜连班（D 晚班 + D+1 夜班）：00:00 连续打两卡，分别落晚班下班卡与夜班上班卡
    expect((await punch(empCombo, D, '15:50')).punch).toMatchObject({ kind: 'in', businessDate: D, shiftId: sid.evening });
    expect((await todayOf(empCombo, D_NEXT, '00:00')).nextPunch).toMatchObject({ action: 'out', label: '打下班卡', shiftName: '晚班', businessDate: D });
    expect((await punch(empCombo, D_NEXT, '00:00')).punch).toMatchObject({ kind: 'out', businessDate: D, shiftId: sid.evening, earlyMinutes: 0 });
    expect((await todayOf(empCombo, D_NEXT, '00:00')).nextPunch).toMatchObject({ action: 'in', label: '打上班卡', shiftName: '夜班', businessDate: D_NEXT });
    expect((await punch(empCombo, D_NEXT, '00:00')).punch).toMatchObject({ kind: 'in', businessDate: D_NEXT, shiftId: sid.night, lateMinutes: 0 });
    expect((await punch(empCombo, D_NEXT, '08:02')).punch).toMatchObject({ kind: 'out', businessDate: D_NEXT, shiftId: sid.night, earlyMinutes: 0 });

    // 5. 日结：D+1 10:30 所有三班均已过下班延后窗口，全部结成 normal 且归属各自班次开始日
    expect(await runAttendanceSettlement({ sql: ctx.sql, config: ctx.config }, time(D_NEXT, '10:30'), true)).toBe(5);
    const dayD = (await api<AttendanceDay>(ctx.app, ctx.owner, 'GET', `/api/oa/attendance/daily?date=${D}`)).body;
    expect(dayD.rows.map((r) => [r.staffId, r.shiftId, r.status]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual(
      [
        [empEarly.id, sid.early, 'normal'],
        [empEve.id, sid.evening, 'normal'],
        [empNight.id, sid.night, 'normal'],
        [empCombo.id, sid.evening, 'normal'],
      ].sort((a, b) => Number(a[0]) - Number(b[0])),
    );
    const dayNext = (await api<AttendanceDay>(ctx.app, ctx.owner, 'GET', `/api/oa/attendance/daily?date=${D_NEXT}`)).body;
    expect(dayNext.rows).toHaveLength(1);
    expect(dayNext.rows[0]).toMatchObject({ staffId: empCombo.id, shiftId: sid.night, status: 'normal' });
  });
});
