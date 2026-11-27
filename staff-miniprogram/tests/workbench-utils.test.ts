// 工作台各页的显示（排班、考勤记录、假期余额、工资条、通讯录、通知的跳转、月份与金额）。

import { describe, expect, it } from 'vitest';
import type { MyAttendance, MySchedule } from '../../src/shared/oa';
import type { Directory } from '../../src/shared/oa-directory';
import type { MyPayslipDetail } from '../../src/shared/oa-payroll';
import { attendanceRows, balanceRows, dayRows, entryText } from '../src/utils/attendance';
import { directoryGroups } from '../src/utils/directory';
import { pageOfLink } from '../src/utils/links';
import { centsOf, yuan } from '../src/utils/money';
import { dayOfMonthLabel, monthLabel, shiftMonth, shiftRange } from '../src/utils/month';
import { payslipView } from '../src/utils/payslip';

describe('月份与金额', () => {
  it('加减月份跨年、写法', () => {
    expect(shiftMonth('2026-11', 1)).toBe('2026-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(monthLabel('2026-03')).toBe('2026 年 3 月');
    expect(dayOfMonthLabel('2026-11-27')).toBe('27 日 周五');
    expect(shiftRange(540, 1080)).toBe('09:00–18:00');
    expect(shiftRange(1320, 120)).toBe('22:00–次日 02:00');
  });

  it('金额：分 → 元（千分位）；元 → 分', () => {
    expect(yuan(128000)).toBe('1,280.00');
    expect(yuan(-5)).toBe('-0.05');
    expect(yuan(123456789)).toBe('1,234,567.89');
    expect(centsOf('12.5')).toBe(1250);
    expect(centsOf('0.01')).toBe(1);
    expect(centsOf('1.234')).toBeNull();
    expect(centsOf('abc')).toBeNull();
  });
});

describe('排班与考勤', () => {
  it('排班：今天标出来，请假半天写上午 / 下午', () => {
    const s = {
      month: '2026-11',
      today: '2026-11-27',
      days: [
        { date: '2026-11-26', items: [{ shiftId: 1, name: '早班', startMinute: 540, endMinute: 1080, inAdvanceMinutes: 0, consecutive: false }], status: 'work' },
        { date: '2026-11-27', items: [], status: 'leave', leavePart: 'am' },
        { date: '2026-11-28', items: [], status: 'rest' },
      ],
      following: { date: '2026-12-01', items: [] },
    } as unknown as MySchedule;
    const rows = dayRows(s);
    expect(rows[0]).toMatchObject({ shifts: '早班 09:00–18:00', past: true, isToday: false });
    expect(rows[1]).toMatchObject({ isToday: true, statusText: '请假（上午）' });
    expect(rows[2]!.statusText).toBe('休息');
  });

  it('考勤：缺卡、30 天内、没有审批中的补卡单才给补卡', () => {
    const row = (id: number, date: string, over: Record<string, unknown> = {}) => ({
      id,
      staffId: 1,
      staffName: 'a',
      businessDate: date,
      shiftId: 1,
      shiftName: '早班',
      startMinute: 540,
      endMinute: 1080,
      status: 'abnormal',
      lateMinutes: 0,
      earlyMinutes: 0,
      missingIn: true,
      missingOut: false,
      inAt: null,
      outAt: { date, time: '18:01' },
      outwork: false,
      outworkCounted: true,
      facePending: false,
      cover: null,
      coverApprovalId: null,
      settledAt: '',
      ...over,
    });
    const a = {
      month: '2026-11',
      today: '2026-11-27',
      rows: [row(1, '2026-11-26'), row(2, '2026-10-20'), row(3, '2026-11-25'), row(4, '2026-11-24', { status: 'normal', missingIn: false })],
      summary: {},
      pendingMakeups: [{ date: '2026-11-25', shiftId: 1, kind: 'in', approvalId: 99 }],
    } as unknown as MyAttendance;
    const rows = attendanceRows(a);
    expect(rows.map((r) => r.id)).toEqual([1, 3, 4, 2]);
    expect(rows[0]).toMatchObject({ makeup: { kind: 'in', date: '2026-11-26', shiftId: 1 }, issues: '缺上班卡', bad: true, times: '--:-- – 18:01' });
    expect(rows[1]).toMatchObject({ makeup: null, pendingApprovalId: 99 });
    expect(rows[2]).toMatchObject({ makeup: null, issues: '', bad: false });
    expect(rows[3]!.makeup).toBeNull(); // 超过 30 天
  });

  it('假期余额（半天为单位）', () => {
    expect(balanceRows([{ leaveTypeId: 1, name: '年假', grantedHalves: 10, usedHalves: 3 }])).toEqual([{ id: 1, name: '年假', left: '3.5 天', detail: '共 5 天 · 用了 1.5 天' }]);
    expect(entryText({ kind: 'use', halves: -2, leaveTypeName: '年假' })).toBe('年假 · 请假扣减 -1 天');
    expect(entryText({ kind: 'grant', halves: 10, leaveTypeName: '年假' })).toBe('年假 · 按规则发放 +5 天');
  });
});

describe('工资条、通讯录、通知', () => {
  it('工资条：实发放上面，其余一行一行；异议带上那一月', () => {
    const d = {
      id: 1,
      month: '2026-10',
      title: '十月工资',
      publishedAt: '',
      signedAt: null,
      net: 650050,
      name: 'a',
      fields: [
        { key: 'f1', label: '基本工资', kind: 'money' },
        { key: 'f2', label: '出勤天数', kind: 'number' },
        { key: 'f3', label: '实发', kind: 'money', net: true },
        { key: 'f4', label: '备注', kind: 'text' },
      ],
      values: { f1: 600000, f2: 26, f3: 650050, f4: null },
    } as unknown as MyPayslipDetail;
    const v = payslipView(d);
    expect(v.net).toBe('6,500.50');
    expect(v.rows).toEqual([
      { key: 'f1', label: '基本工资', value: '6,000.00', money: true },
      { key: 'f2', label: '出勤天数', value: '26', money: false },
      { key: 'f4', label: '备注', value: '—', money: false },
    ]);
    expect(v.objection).toBe('2026 年 10 月 · 十月工资');
  });

  it('通讯录：按部门分组、主管在前；搜姓名、工号，打码的不按手机号搜、不能拨', () => {
    const person = (staffId: number, name: string, department: string | null, over: Record<string, unknown> = {}) => ({
      staffId,
      name,
      empNo: `E${staffId}`,
      department,
      position: null,
      positionName: '员工',
      phone: '13800000000',
      phoneMasked: false,
      headOf: [],
      ...over,
    });
    const dir = {
      departments: [
        { key: 'front', name: '前厅部', parentKey: null, headId: 2, group: null, canCreateGroup: false },
        { key: 'spa', name: '水疗部', parentKey: null, headId: null, group: null, canCreateGroup: false },
      ],
      people: [person(1, '阿丽', 'front'), person(2, '大卫', 'front', { headOf: ['front'] }), person(3, '小卡', 'spa', { phone: '138****0000', phoneMasked: true }), person(4, '临时', null)],
      phoneScope: 'managers',
      canSeePhones: true,
      canConfigure: false,
    } as unknown as Directory;
    const g = directoryGroups(dir);
    expect(g.map((x) => x.name)).toEqual(['前厅部', '水疗部', '其他']);
    expect(g[0]!.people.map((p) => p.name)).toEqual(['大卫', '阿丽']);
    expect(g[1]!.people[0]).toMatchObject({ callable: false, initial: '小' });
    expect(directoryGroups(dir, 'E3').flatMap((x) => x.people.map((p) => p.name))).toEqual(['小卡']);
    // 按手机号搜：打码的那位（小卡）不出来
    expect(directoryGroups(dir, '0000').flatMap((x) => x.people.map((p) => p.name))).toEqual(['大卫', '阿丽', '临时']);
  });

  it('通知的跳转：网页地址换成小程序页面；对不上的只看文字', () => {
    expect(pageOfLink('/oa/approvals/12')).toBe('/pages/approval/index?id=12');
    expect(pageOfLink('/oa/payslips/3?x=1')).toBe('/pages/payslip/index?id=3');
    expect(pageOfLink('/oa/my/payslips/3')).toBe('/pages/payslip/index?id=3');
    expect(pageOfLink('/oa/announcements/5')).toBe('/pages/announcement/index?id=5');
    expect(pageOfLink('/oa/schedule')).toBe('/pages/schedule/index');
    expect(pageOfLink('/oa/im/7')).toBeNull();
    expect(pageOfLink(null)).toBeNull();
  });
});
