// 打卡页（src/utils/punch.ts）：照门店系统回的「下一张卡」画按钮；下班卡没到下班时间只有「提前下班」（SP15）；
// 要刷脸、没进考勤组的不给按钮（SP13）；结果的一句话。

import { describe, expect, it } from 'vitest';
import type { NextPunchHint, PunchToday } from '../../src/shared/oa';
import { clockOfEpochMinute, punchResultText, punchView } from '../src/utils/punch';

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

const today = (now: number, next: NextPunchHint, group: Partial<NonNullable<PunchToday['group']>> | null = {}): PunchToday =>
  ({
    now,
    today: '2026-11-27',
    group: group === null ? null : { id: 1, name: '前厅', gpsRequired: false, faceRequired: false, locations: [], ...group },
    face: 'none',
    slots: [
      {
        date: '2026-11-27',
        shiftId: 1,
        name: '早班',
        startMinute: 540,
        endMinute: 1080,
        windows: { start: at(9), end: at(18), inFrom: at(7), inTo: at(10), lateAfter: at(9), outFrom: at(17), outTo: at(20) },
        in: null,
        out: null,
      },
    ],
    punches: [],
    nextPunch: next,
  }) as PunchToday;

describe('打卡页的按钮', () => {
  it('上班卡：主按钮上班打卡；时间按门店的钟', () => {
    const v = punchView(today(at(8, 55), hint({})));
    expect(v).toMatchObject({ primary: 'in', early: false, blocked: '', clock: '08:55' });
  });

  it('下班卡：到了下班时间是主按钮；没到只有「提前下班」并写会记早退几分钟', () => {
    expect(punchView(today(at(18, 2), hint({ action: 'out', label: '打下班卡' })))).toMatchObject({ primary: 'out', early: false });
    const early = punchView(today(at(17, 20), hint({ action: 'out', label: '打下班卡' })));
    expect(early).toMatchObject({ primary: null, early: true, earlyMinutes: 40 });
    // 按本机时钟往前走：同一份数据到了 18:00 就变成主按钮
    expect(punchView(today(at(17, 20), hint({ action: 'out' })), at(18, 0)).primary).toBe('out');
  });

  it('待打、打完、休息：不给按钮，写门店系统的话', () => {
    for (const action of ['wait', 'done', 'rest'] as const) {
      const v = punchView(today(at(12), hint({ action, label: `x-${action}`, detail: 'd' })));
      expect(v).toMatchObject({ primary: null, early: false, label: `x-${action}`, detail: 'd' });
    }
  });

  it('没进考勤组、要刷脸的考勤组：不给按钮，写清楚找谁或去网页', () => {
    expect(punchView(today(at(9), hint({ action: 'no_group' }), null)).blocked).toContain('考勤组');
    const face = punchView(today(at(9), hint({}), { faceRequired: true }));
    expect(face).toMatchObject({ primary: null, blocked: '这个考勤组要刷脸，请在 WCP 网页上打卡' });
  });

  it('要定位、能外勤照门店系统的', () => {
    expect(punchView(today(at(9), hint({ outworkAllowed: true }), { gpsRequired: true }))).toMatchObject({ needGps: true, outworkAllowed: true });
  });
});

describe('文字', () => {
  it('钟点、结果的一句话', () => {
    expect(clockOfEpochMinute(at(9, 5))).toBe('09:05');
    expect(clockOfEpochMinute(at(0, 0) - 1)).toBe('23:59');
    expect(punchResultText({ localTime: '09:02', kind: 'in', lateMinutes: 0, earlyMinutes: 0, outwork: false })).toBe('09:02 上班卡 · 准时');
    expect(punchResultText({ localTime: '09:12', kind: 'in', lateMinutes: 12, earlyMinutes: 0, outwork: true })).toBe('09:12 上班卡 · 迟到 12 分钟 · 外勤');
    expect(punchResultText({ localTime: '17:20', kind: 'out', lateMinutes: 0, earlyMinutes: 40, outwork: false })).toBe('17:20 下班卡 · 早退 40 分钟');
    expect(punchResultText({ localTime: '12:00', kind: 'rest', lateMinutes: 0, earlyMinutes: 0, outwork: false })).toBe('12:00 休息日打卡 · 已记下');
  });
});
