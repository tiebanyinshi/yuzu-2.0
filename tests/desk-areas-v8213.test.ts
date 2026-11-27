// 8.2.13 发卡台区域状态（docs/V82213_DESK_UI.md）：空闲 / 正常 / 繁忙 / 已满与推荐顺序。纯函数，不要数据库。

import { describe, expect, it } from 'vitest';
import { areaStatuses, type AreaTag } from '../src/shared/desk-areas';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const tag = (code: string, visitMin: number | null, extra: Partial<AreaTag> = {}): AreaTag => ({
  code,
  zone: 'male',
  kind: 'normal',
  active: true,
  locked: false,
  serviceStatus: 'normal',
  visit: visitMin === null ? null : { checkedInAt: ago(visitMin) },
  ...extra,
});

describe('区域状态', () => {
  it('15 分钟内发了 3 张是繁忙、没发是空闲、没空牌是已满；推荐空闲里在店占比低的；VIP、停用的不算', () => {
    const tags = [
      // A 区：繁忙（最近发了 3 张）
      tag('A01', 1),
      tag('A02', 5),
      tag('A03', 10),
      tag('A04', null),
      // B 区：正常（最近发了 1 张）
      tag('B01', 3),
      tag('B02', null),
      // C 区：空闲，在店 1/2
      tag('C01', 60),
      tag('C02', null),
      // D 区：空闲，在店 0/2 → 推荐
      tag('D01', null),
      tag('D02', null),
      // E 区：已满
      tag('E01', 30),
      tag('E02', null, { locked: true }),
      tag('V01', null, { kind: 'vip' }),
      tag('F01', null, { active: false }),
    ];
    const s = areaStatuses(tags, NOW);
    expect(s.map((x) => [x.area, x.state, x.recommended])).toEqual([
      ['D', 'idle', true],
      ['C', 'idle', false],
      ['B', 'normal', false],
      ['A', 'busy', false],
      ['E', 'full', false],
    ]);
    expect(s.find((x) => x.area === 'A')).toMatchObject({ total: 4, inStore: 3, free: 1, recent: 3 });
  });

  it('男宾、女宾各推荐一个；全满的分区不推荐', () => {
    const s = areaStatuses([tag('A01', null), tag('B01', 2, { zone: 'female' })], NOW);
    expect(s.filter((x) => x.recommended).map((x) => `${x.zone}${x.area}`)).toEqual(['maleA']);
  });
});
