// 轮班周期的格子怎么算（8.1.41，docs/V8141_ROTA.md）：按周期轮转跨月、往回推、错开几段；
// 每月 1 日固定转班遇上 28／29／30／31 天的月份；不要数据库（秒级这一档）。

import { describe, expect, it } from 'vitest';
import { shiftDate } from '../src/shared/labels';
import { rotaCellOn, rotaSummary, rotaTotalDays, type TechRota } from '../src/shared/technician-rota';

const EARLY = 1;
const LATE = 2;
/** 一段连续日子里每天落在第几段 */
const segmentsFrom = (rota: Pick<TechRota, 'mode' | 'anchor' | 'segments'>, from: string, days: number, offset = 0) =>
  Array.from({ length: days }, (_, i) => rotaCellOn(rota, shiftDate(from, i), offset).segment);

describe('按周期轮转', () => {
  const week = {
    mode: 'cycle' as const,
    anchor: '2026-11-02',
    segments: [
      { days: 5, shiftId: EARLY },
      { days: 2, shiftId: null },
    ],
  };

  it('7 天一轮：从起算日起首尾相接，跨月不受影响', () => {
    expect(rotaTotalDays(week)).toBe(7);
    expect(segmentsFrom(week, '2026-11-02', 14)).toEqual([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1]);
    // 11-28、11-29 是周末休息；11-30 起新的一轮，跨进 12 月照常接着排
    expect(segmentsFrom(week, '2026-11-28', 7)).toEqual([1, 1, 0, 0, 0, 0, 0]);
    expect(rotaCellOn(week, '2026-11-07')).toEqual({ segment: 1, shiftId: null, rest: true });
    expect(rotaCellOn(week, '2026-11-02')).toEqual({ segment: 0, shiftId: EARLY, rest: false });
  });

  it('起算日以前按同一个节奏往回推', () => {
    expect(segmentsFrom(week, '2026-10-26', 7)).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(rotaCellOn(week, '2026-11-01').segment).toBe(1);
  });

  it('10 天一转：不看大小月，31 日也照常往下数', () => {
    const tcm = {
      mode: 'cycle' as const,
      anchor: '2026-12-01',
      segments: [
        { days: 10, shiftId: EARLY },
        { days: 10, shiftId: LATE },
        { days: 10, shiftId: null },
      ],
    };
    expect(rotaCellOn(tcm, '2026-12-10').segment).toBe(0);
    expect(rotaCellOn(tcm, '2026-12-11').segment).toBe(1);
    expect(rotaCellOn(tcm, '2026-12-30').segment).toBe(2);
    // 12-31 是第 31 天：新一轮的第一段（与「每月 1 日」的口径不同，这就是两种口径的冲突）
    expect(rotaCellOn(tcm, '2026-12-31').segment).toBe(0);
    expect(rotaCellOn(tcm, '2027-01-01').segment).toBe(0);
    expect(rotaCellOn(tcm, '2027-01-10').segment).toBe(1);
  });

  it('错开几段：从第 k 段开始；负数、超过段数的取余', () => {
    const tcm = {
      mode: 'cycle' as const,
      anchor: '2026-12-01',
      segments: [
        { days: 10, shiftId: EARLY },
        { days: 10, shiftId: LATE },
        { days: 10, shiftId: null },
      ],
    };
    expect([0, 1, 2].map((k) => rotaCellOn(tcm, '2026-12-01', k).segment)).toEqual([0, 1, 2]);
    expect(rotaCellOn(tcm, '2026-12-11', 1).segment).toBe(2);
    expect(rotaCellOn(tcm, '2026-12-21', 1).segment).toBe(0);
    expect(rotaCellOn(tcm, '2026-12-01', -1).segment).toBe(2);
    expect(rotaCellOn(tcm, '2026-12-01', 4).segment).toBe(1);
  });

  it('长短不一的几段错开：按错开后的顺序首尾相接', () => {
    const r = {
      mode: 'cycle' as const,
      anchor: '2026-11-01',
      segments: [
        { days: 3, shiftId: EARLY },
        { days: 1, shiftId: null },
      ],
    };
    expect(segmentsFrom(r, '2026-11-01', 8, 1)).toEqual([1, 0, 0, 0, 1, 0, 0, 0]);
  });
});

describe('每月 1 日固定转班', () => {
  const tcm = {
    mode: 'monthly' as const,
    anchor: null,
    segments: [
      { days: 10, shiftId: EARLY },
      { days: 10, shiftId: LATE },
      { days: 10, shiftId: null },
    ],
  };
  const blocks = (from: string, days: number, offset = 0) => segmentsFrom(tcm, from, days, offset);
  const expected = (days: number, order: number[]) => Array.from({ length: days }, (_, i) => order[Math.min(Math.floor(i / 10), 2)]!);

  it('31 天的月份：第三段多排一天，下个月 1 日回到第一段', () => {
    expect(blocks('2026-12-01', 31)).toEqual(expected(31, [0, 1, 2]));
    expect(rotaCellOn(tcm, '2026-12-31')).toEqual({ segment: 2, shiftId: null, rest: true });
    expect(rotaCellOn(tcm, '2027-01-01')).toEqual({ segment: 0, shiftId: EARLY, rest: false });
  });

  it('30 天的月份正好排完', () => {
    expect(blocks('2026-11-01', 30)).toEqual(expected(30, [0, 1, 2]));
    expect(rotaCellOn(tcm, '2026-12-01').segment).toBe(0);
  });

  it('2 月 28 天：第三段排到 28 日为止，3 月 1 日重新开始；闰年 29 天同理', () => {
    expect(blocks('2027-02-01', 28)).toEqual(expected(28, [0, 1, 2]));
    expect(rotaCellOn(tcm, '2027-03-01').segment).toBe(0);
    expect(blocks('2028-02-01', 29)).toEqual(expected(29, [0, 1, 2]));
  });

  it('错开几段：每月 1 日从第 k 段开始，排完了按错开后的最后一段', () => {
    expect(blocks('2026-12-01', 31, 1)).toEqual(expected(31, [1, 2, 0]));
    expect(blocks('2026-12-01', 31, 2)).toEqual(expected(31, [2, 0, 1]));
    expect(blocks('2027-02-01', 28, 2)).toEqual(expected(28, [2, 0, 1]));
  });

  it('各段加起来超过一个月的：月底截断，下个月照旧从第一段开始', () => {
    const long = {
      mode: 'monthly' as const,
      anchor: null,
      segments: [
        { days: 20, shiftId: EARLY },
        { days: 20, shiftId: LATE },
      ],
    };
    expect(rotaCellOn(long, '2026-11-30').segment).toBe(1);
    expect(rotaCellOn(long, '2026-12-01').segment).toBe(0);
  });
});

it('概述：几天、上哪个班', () => {
  const names = new Map([[EARLY, '早班']]);
  expect(
    rotaSummary(
      {
        segments: [
          { days: 5, shiftId: EARLY },
          { days: 2, shiftId: null },
        ],
      },
      (id) => names.get(id) ?? '?',
    ),
  ).toBe('5 天 早班 → 2 天 休息');
});
