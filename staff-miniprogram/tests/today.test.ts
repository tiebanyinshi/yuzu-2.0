// 「今天」首页（src/utils/today.ts）：此刻卡按设计稿第 2.2 节的先后取第一条成立的，考勤照门店系统回的「下一张卡」；
// 待办最急的在上面；首页「扫一扫」按码分去处。

import { describe, expect, it } from 'vitest';
import type { NextPunchHint, PunchToday } from '../../src/shared/oa';
import { parsePatrolToken } from '../../src/shared/patrol';
import { isMealCode, patrolCodeOf } from '../src/utils/canteen';
import { mealOfNow, rejectedTodo, routeScan, shiftLine, todayCard, todoRows } from '../src/utils/today';
import { markRejectedSeen, seenRejected } from '../src/utils/seen';
import { installFakeWx } from './fake-wx';

const DAY = 20784 * 1440; // 2026-11-27 的 0 点（1970 起第几分钟）
const at = (h: number, m = 0) => DAY + h * 60 + m;

const hint = (over: Partial<NextPunchHint>): NextPunchHint => ({
  action: 'in',
  label: '打上班卡',
  detail: '早班 09:00–18:00',
  shiftId: 1,
  shiftName: '早班',
  businessDate: '2026-11-27',
  windowFrom: null,
  windowTo: null,
  inWindow: true,
  outworkAllowed: false,
  ...over,
});

const punchIn = { id: 1, localTime: '08:58', kind: 'in' } as unknown as NonNullable<PunchToday['slots'][number]['in']>;

const today = (now: number, next: NextPunchHint, clockedIn = false): PunchToday =>
  ({
    now,
    today: '2026-11-27',
    group: { id: 1, name: '前厅', gpsRequired: false, faceRequired: false, locations: [] },
    face: 'none',
    slots: [
      {
        date: '2026-11-27',
        shiftId: 1,
        name: '前厅早班',
        startMinute: 540,
        endMinute: 1080,
        windows: { start: at(9), end: at(18), inFrom: at(7), inTo: at(10), lateAfter: at(9, 5), outFrom: at(17), outTo: at(20) },
        in: clockedIn ? punchIn : null,
        out: null,
      },
    ],
    punches: [],
    nextPunch: next,
  }) as PunchToday;

const meal = { window: '午餐 10:30–14:30', dishes: ['番茄炒蛋', '红烧肉'] };
const patrol = { roundText: '第 2 轮 11:00–14:00', missing: ['锅炉房', '后门'] };

describe('此刻卡', () => {
  it('1 上班卡：还有几分钟 / 已到 / 已迟到（迟到用陶土红）', () => {
    expect(todayCard({ punch: today(at(8, 48), hint({})), now: at(8, 48), patrol: null, meal: null })).toMatchObject({
      title: '09:00 上班 · 前厅早班',
      detail: '还有 12 分钟',
      tone: 'normal',
      page: '/pages/punch/index',
    });
    expect(todayCard({ punch: today(at(9, 2), hint({})), now: at(9, 2), patrol: null, meal: null }).detail).toBe('已到上班时间');
    const late = todayCard({ punch: today(at(9, 8), hint({})), now: at(9, 8), patrol: null, meal: null });
    expect([late.detail, late.tone]).toEqual(['已迟到 8 分钟', 'late']);
  });

  it('上班卡排在吃饭、巡场前面', () => {
    expect(todayCard({ punch: today(at(8, 50), hint({})), now: at(8, 50), patrol, meal }).eyebrow).toBe('上班');
  });

  it('2 下班卡、已到下班时间', () => {
    const c = todayCard({ punch: today(at(18, 3), hint({ action: 'out' }), true), now: at(18, 3), patrol, meal });
    expect(c.title).toBe('18:00 下班 · 已到下班时间');
  });

  it('3 在班、巡场这一轮没巡完：写还有几处、哪几处', () => {
    const c = todayCard({ punch: today(at(12), hint({ action: 'out' }), true), now: at(12), patrol, meal });
    expect(c).toMatchObject({ eyebrow: '巡场', title: '第 2 轮 11:00–14:00 · 还有 2 处没巡', lines: ['锅炉房、后门'], page: '/pages/patrol/index' });
  });

  it('4 开饭时间：写这一餐与今天的菜；没发布菜单的说一声', () => {
    expect(todayCard({ punch: today(at(12), hint({ action: 'out' }), true), now: at(12), patrol: null, meal })).toMatchObject({
      eyebrow: '吃饭',
      title: '午餐 10:30–14:30',
      lines: ['番茄炒蛋 · 红烧肉'],
    });
    expect(todayCard({ punch: null, now: 0, patrol: null, meal: { window: '午餐 10:30–14:30', dishes: [] } }).detail).toBe('今天的菜单还没发布');
  });

  it('5 在班、下班时间没到：「提前下班」是文字按钮，去打卡页确认', () => {
    const c = todayCard({ punch: today(at(15), hint({ action: 'out' }), true), now: at(15), patrol: null, meal: null });
    expect(c).toMatchObject({ eyebrow: '在班', title: '在班 · 18:00 下班', action: { label: '提前下班', page: '/pages/punch/index' } });
  });

  it('6、7 休息、没有排班', () => {
    const c = todayCard({ punch: today(at(10), hint({ action: 'rest', label: '今日休息', detail: '今天没有已发布的排班' })), now: at(10), patrol: null, meal: null });
    expect([c.title, c.page]).toEqual(['今天休息', '/pages/schedule/index']);
  });

  it('8 没进考勤组、缺卡：原样写门店系统的话，缺卡带「去补卡」', () => {
    const ng = todayCard({ punch: today(at(10), hint({ action: 'no_group', label: '未入考勤组', detail: '还没加入考勤组，打卡前请找人力行政部' })), now: at(10), patrol: null, meal: null });
    expect([ng.title, ng.detail]).toEqual(['未入考勤组', '还没加入考勤组，打卡前请找人力行政部']);
    const missed = todayCard({ punch: today(at(21), hint({ action: 'done', label: '打卡窗口已过', detail: '早班 打卡窗口已结束，缺卡可提交补卡' })), now: at(21), patrol: null, meal: null });
    expect(missed.action).toEqual({ label: '去补卡', page: '/pages/apply/index' });
    expect(missed.tone).toBe('late');
  });

  it('忘了打下班卡、下班窗口过了：不算在班（不写「在班」，也不出巡场卡）', () => {
    const c = todayCard({ punch: today(at(21), hint({ action: 'done', label: '打卡窗口已过', detail: '前厅早班 打卡窗口已结束，缺卡可提交补卡' }), true), now: at(21), patrol, meal: null });
    expect(c.eyebrow).toBe('考勤');
    expect(c.action).toEqual({ label: '去补卡', page: '/pages/apply/index' });
  });

  it('上班窗口按本机时钟走过了：不再写「已迟到」（等重新取）', () => {
    const c = todayCard({ punch: today(at(9), hint({})), now: at(10, 30), patrol: null, meal: null });
    expect(c.eyebrow).not.toBe('上班');
  });

  it('读不到考勤（没信号、第一次打开）不出错', () => {
    expect(todayCard({ punch: null, now: 0, patrol: null, meal: null }).title).toBe('读不到今天的考勤');
  });

  it('今天的班次一行', () => {
    expect(shiftLine(today(at(8), hint({})))).toBe('09:00–18:00 · 前厅早班');
    expect(shiftLine(null)).toBe('');
  });
});

describe('待办', () => {
  it('最急的在上面；没有就空', () => {
    expect(todoRows({ pendingPunchAt: null, approvalsTodo: 0, ccUnread: 0, missedPunch: false, unsignedPayslips: [] })).toEqual([]);
    const rows = todoRows({ pendingPunchAt: '09:01', approvalsTodo: 2, ccUnread: 1, missedPunch: true, unsignedPayslips: [{ id: 5, title: '2026 年 10 月工资条' }] });
    expect(rows.map((r) => r.key)).toEqual(['pending', 'missed', 'approvals', 'payslip', 'cc']);
    expect(rows[3]!.page).toBe('/pages/payslip/index?id=5');
    expect(rows[4]!.page).toBe('/pages/approvals/index?box=cc');
  });

  it('多张工资条待确认去列表', () => {
    const rows = todoRows({
      pendingPunchAt: null,
      approvalsTodo: 0,
      ccUnread: 0,
      missedPunch: false,
      unsignedPayslips: [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' },
      ],
    });
    expect(rows[0]).toMatchObject({ text: '2 张工资条待确认', page: '/pages/payslips/index' });
  });
});

describe('待办（第二版）：我的申请被驳回、必修快到期', () => {
  const base = { pendingPunchAt: null, approvalsTodo: 0, ccUnread: 0, missedPunch: false, unsignedPayslips: [] };
  const NOW = Date.parse('2026-11-28T10:00:00+08:00');
  const item = (id: number, status: string, finishedAt: string | null) => ({ id, title: `申请${id}`, status, finishedAt }) as never;

  it('被驳回的：14 天以内、这台手机上没打开看过的才提', () => {
    const items = [item(1, 'rejected', '2026-11-27T09:00:00+08:00'), item(2, 'rejected', '2026-11-01T09:00:00+08:00'), item(3, 'approved', '2026-11-27T09:00:00+08:00'), item(4, 'rejected', '2026-11-26T09:00:00+08:00')];
    expect(rejectedTodo(items, [], NOW).map((x) => x.id)).toEqual([1, 4]);
    expect(rejectedTodo(items, [4], NOW).map((x) => x.id)).toEqual([1]);
    expect(todoRows({ ...base, rejected: [{ id: 1, title: '请假' }] })).toEqual([
      { key: 'rejected', icon: 'approvals', text: '「请假」被驳回了', sub: '看看原因，改了可以重新提交', page: '/pages/approval/index?id=1', urgent: false },
    ]);
    expect(todoRows({ ...base, rejected: [{ id: 1, title: '请假' }, { id: 4, title: '补卡' }] })[0]).toMatchObject({ text: '2 张申请被驳回了', page: '/pages/approvals/index?box=mine' });
  });

  it('打开看过的记在手机上（按人分开存）', () => {
    installFakeWx();
    expect(seenRejected(7)).toEqual([]);
    markRejectedSeen(7, 12);
    markRejectedSeen(7, 12);
    markRejectedSeen(7, 13);
    expect(seenRejected(7)).toEqual([13, 12]);
    expect(seenRejected(8)).toEqual([]);
  });

  it('必修快到期：一门写哪一门、几号截止（逾期的标急）；几门的去「学习」', () => {
    expect(todoRows({ ...base, dueSoon: [{ kind: 'course', id: 3, title: '泡汤安全', dueOn: '2026-11-30', overdue: false }] })).toEqual([
      { key: 'due', icon: 'academy', text: '必修「泡汤安全」11 月 30 日截止', sub: '还没学完', page: '/pages/academy-course/index?id=3', urgent: false },
    ]);
    expect(todoRows({ ...base, dueSoon: [{ kind: 'path', id: 2, title: '新员工地图', dueOn: '2026-11-25', overdue: true }] })[0]).toMatchObject({
      text: '必修「新员工地图」已过截止',
      page: '/pages/academy-path/index?id=2',
      urgent: true,
    });
    expect(
      todoRows({
        ...base,
        dueSoon: [
          { kind: 'course', id: 3, title: 'a', dueOn: '2026-11-25', overdue: true },
          { kind: 'course', id: 4, title: 'b', dueOn: '2026-11-30', overdue: false },
        ],
      })[0],
    ).toMatchObject({ text: '2 门必修快到期', sub: '1 门已过截止', page: '/pages/learn/index', urgent: true });
    // 手机上存的旧数据（第一版）没有这两项：照旧
    expect(todoRows(base)).toEqual([]);
  });
});

describe('扫一扫', () => {
  const parse = { patrol: patrolCodeOf, isMeal: isMealCode };
  const all = { patrol: true, canteenScan: true };
  it('巡场码去巡场；不在巡场名单的说清楚', () => {
    const url = 'https://staff.yuzusystem.xyz/#patrol=ABCDEFGHJKLM';
    expect(routeScan(url, all, parse)).toEqual({ kind: 'patrol', code: parsePatrolToken(url) });
    expect(routeScan(url, { patrol: false, canteenScan: false }, parse)).toMatchObject({ kind: 'refuse', message: expect.stringContaining('不在巡场名单') });
  });

  it('饭卡码给负责人登记；不是负责人的说给负责人扫', () => {
    expect(routeScan('yzc1:1a:k3:abcdefgh', all, parse)).toEqual({ kind: 'meal', code: 'YZC1:1A:K3:ABCDEFGH' });
    expect(routeScan('YZC1:1A:K3:ABCDEFGH', { patrol: true, canteenScan: false }, parse)).toMatchObject({ kind: 'refuse', message: '这是饭卡码：请给食堂负责人扫' });
  });

  it('认不出的码不跳到别处', () => {
    expect(routeScan('https://example.com/x', all, parse)).toEqual({ kind: 'refuse', message: '这不是店里的码' });
    expect(routeScan('', all, parse).kind).toBe('refuse');
  });
});

describe('吃饭（每次画都按此刻重算）', () => {
  const meals = [
    { meal: 'lunch', start: '10:30', end: '14:00', enabled: true },
    { meal: 'dinner', start: '17:00', end: '19:30', enabled: true },
  ];
  const dishes = { lunch: ['番茄炒蛋', '红烧肉'], dinner: ['清蒸鱼'] };
  it('开饭时间里、这一餐没打卡：出吃饭卡；菜一行是这一餐', () => {
    const r = mealOfNow(meals, '12:00', '2026-11-27', dishes, { meal: 'lunch', date: '2026-11-27', checkedIn: false });
    expect(r.meal).toEqual({ window: '午餐 10:30–14:00', dishes: ['番茄炒蛋', '红烧肉'] });
    expect(r.menuLine).toBe('午餐：番茄炒蛋 · 红烧肉');
  });

  it('这一餐打过卡了：不出吃饭卡，菜一行照旧', () => {
    const r = mealOfNow(meals, '12:00', '2026-11-27', dishes, { meal: 'lunch', date: '2026-11-27', checkedIn: true });
    expect(r.meal).toBeNull();
    expect(r.menuLine).toBe('午餐：番茄炒蛋 · 红烧肉');
  });

  it('开饭时间过了：不出吃饭卡，菜一行是下一餐', () => {
    const r = mealOfNow(meals, '14:30', '2026-11-27', dishes, null);
    expect(r.meal).toBeNull();
    expect(r.menuLine).toBe('晚餐：清蒸鱼');
    expect(mealOfNow(meals, '20:00', '2026-11-27', dishes, null).menuLine).toBe('');
  });

  it('跨零点的一餐（夜宵 22:00–01:00）：过了零点按开饭那天核对打过没有，不再叫人去吃（Codex 对 9dbc3ce 的 P2）', () => {
    const night = [{ meal: 'night', start: '22:00', end: '01:00', enabled: true }];
    const late = { night: ['馄饨'] };
    expect(mealOfNow(night, '23:30', '2026-11-27', late, { meal: 'night', date: '2026-11-27', checkedIn: true }).meal).toBeNull();
    expect(mealOfNow(night, '00:30', '2026-11-28', {}, { meal: 'night', date: '2026-11-27', checkedIn: true }).meal).toBeNull();
    const notYet = mealOfNow(night, '00:30', '2026-11-28', late, { meal: 'night', date: '2026-11-27', checkedIn: false }).meal;
    // 过了零点还没打：照样叫去吃，但那一天的菜手机上没有（拿到的是新一天的），不写菜
    expect(notYet && notYet.dishes).toEqual([]);
  });
});
