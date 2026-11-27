// 日期与文字（src/utils/format.ts）：按门店时区（东八区），不随手机的时区变。

import { describe, expect, it } from 'vitest';
import { dayLabel, fileSize, greeting, hhmm, initialOf, shortTime, storeClock } from '../src/utils/format';

describe('门店时区', () => {
  it('问候按门店的钟点', () => {
    expect(greeting(new Date('2026-11-27T00:30:00Z'))).toBe('早上好'); // 08:30
    expect(greeting(new Date('2026-11-27T04:00:00Z'))).toBe('中午好'); // 12:00
    expect(greeting(new Date('2026-11-27T08:00:00Z'))).toBe('下午好'); // 16:00
    expect(greeting(new Date('2026-11-27T13:00:00Z'))).toBe('晚上好'); // 21:00
    expect(greeting(new Date('2026-11-26T20:30:00Z'))).toBe('晚上好'); // 04:30 还没到早上（5 点起算早上）
    expect(greeting(new Date('2026-11-26T21:30:00Z'))).toBe('早上好'); // 05:30
  });

  it('日期、钟点', () => {
    expect(storeClock(new Date('2026-11-26T17:00:00Z'))).toMatchObject({ date: '2026-11-27', hour: 1 });
    expect(dayLabel('2026-11-27')).toBe('11 月 27 日 · 星期五');
    expect(hhmm(545)).toBe('09:05');
    expect(hhmm(1470)).toBe('次日 00:30');
  });

  it('时间：今天的只写钟点，别的天写月日', () => {
    const now = new Date('2026-11-27T04:00:00Z');
    expect(shortTime('2026-11-27T01:05:00Z', now)).toBe('09:05');
    expect(shortTime('2026-11-20T02:00:00Z', now)).toBe('11-20 10:00');
    expect(shortTime('bad', now)).toBe('');
  });

  it('文件大小、姓名首字', () => {
    expect(fileSize(1258291)).toBe('1.2 MB');
    expect(fileSize(20 * 1024 * 1024)).toBe('20 MB');
    expect(fileSize(860 * 1024)).toBe('860 KB');
    expect(initialOf(' 阿丽 ')).toBe('阿');
    expect(initialOf('')).toBe('·');
  });
});
