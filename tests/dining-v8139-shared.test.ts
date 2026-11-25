// 8.1.39（餐饮 B，docs/V8139_DINING_B.md）前后端共用的判断：售卖时段、档口时段（含跨零点）、后台设的小分类名单。不要数据库。

import { describe, expect, it } from 'vitest';
import { allDiningSlots, DEFAULT_DINING_RULES, DINING_OUTLETS, diningOutletsOf, diningSlotOf, isValidSlot, parseSlotKey, slotOrder } from '../src/shared/dining';
import { inWindow, notOnSaleText, onSaleAt, parseMinute, stationAt, windowsOverlap, windowsProblem, windowsText } from '../src/shared/dining-v8139';

describe('售卖时段', () => {
  it('当天的一段：含开始、不含结束；没设为全天卖', () => {
    const lunch = { start: 660, end: 840 };
    expect(inWindow(lunch, 659)).toBe(false);
    expect(inWindow(lunch, 660)).toBe(true);
    expect(inWindow(lunch, 839)).toBe(true);
    expect(inWindow(lunch, 840)).toBe(false);
    expect(onSaleAt(null, 0)).toBe(true);
    expect(onSaleAt([], 0)).toBe(true);
    expect(onSaleAt([lunch, { start: 1020, end: 1260 }], 1100)).toBe(true);
    expect(onSaleAt([lunch, { start: 1020, end: 1260 }], 900)).toBe(false);
  });

  it('跨零点的一段（22:00–次日 02:00）', () => {
    const night = { start: 1320, end: 120 };
    expect(inWindow(night, 1319)).toBe(false);
    expect(inWindow(night, 1400)).toBe(true);
    expect(inWindow(night, 0)).toBe(true);
    expect(inWindow(night, 119)).toBe(true);
    expect(inWindow(night, 120)).toBe(false);
    expect(windowsText([night])).toBe('22:00–次日 02:00');
    expect(windowsText([{ start: 660, end: 840 }])).toBe('11:00–14:00');
    expect(windowsText([])).toBe('全天');
    expect(notOnSaleText('「早茶虾饺」', [{ start: 420, end: 660 }])).toContain('07:00–11:00');
  });

  it('时间的写法与核对：开始结束不能一样、段数有上限；档口时段不能重叠', () => {
    expect(parseMinute('7:05')).toBe(425);
    expect(parseMinute('23:59')).toBe(1439);
    expect(parseMinute('24:00')).toBeNull();
    expect(windowsProblem([{ start: 600, end: 600 }], '售卖时段', 4)).toContain('不能一样');
    expect(
      windowsProblem(
        [
          { start: 0, end: 1 },
          { start: 2, end: 3 },
        ],
        '售卖时段',
        1,
      ),
    ).toContain('最多 1 段');
    expect(windowsProblem([{ start: 1440, end: 3 }], '售卖时段', 4)).toContain('时间不对');
    // 售卖时段重叠无所谓（合起来卖）；档口时段重叠说不清到哪个档口
    expect(
      windowsProblem(
        [
          { start: 600, end: 800 },
          { start: 700, end: 900 },
        ],
        '售卖时段',
        4,
      ),
    ).toBeNull();
    expect(
      windowsProblem(
        [
          { start: 600, end: 800 },
          { start: 700, end: 900 },
        ],
        '档口时段',
        4,
      ),
    ).toContain('重叠');
    expect(
      windowsOverlap([
        { start: 1320, end: 120 },
        { start: 60, end: 300 },
      ]),
    ).toBe(true);
    expect(
      windowsOverlap([
        { start: 1320, end: 120 },
        { start: 120, end: 300 },
      ]),
    ).toBe(false);
  });

  it('档口时段：落在哪一段到那一段的档口，都不在的用菜品自己的', () => {
    const ws = [{ start: 1320, end: 120, stationId: 9 }];
    expect(stationAt(1, ws, 1400)).toBe(9);
    expect(stationAt(1, ws, 60)).toBe(9);
    expect(stationAt(1, ws, 600)).toBe(1);
    expect(stationAt(1, [], 600)).toBe(1);
  });
});

describe('菜单小分类（R4）', () => {
  it('默认名单与原来写死的一样；旧规则里没有这一项的照默认', () => {
    expect(DEFAULT_DINING_RULES.outletGroups).toEqual({ restaurant: ['餐饮', '酒水'], water: ['手作饮料', '糖水', '调酒'] });
    expect(diningOutletsOf(null)).toBe(DINING_OUTLETS);
    expect(diningOutletsOf({})).toBe(DINING_OUTLETS);
    expect(allDiningSlots().map((s) => `${s.outlet}:${s.group}`)).toEqual(['restaurant:餐饮', 'restaurant:酒水', 'water:手作饮料', 'water:糖水', 'water:调酒', 'fruit:']);
  });

  it('按设的名单核对、排序、按默认归；默认要归的小分类没了归到那一处的第一个', () => {
    const outlets = diningOutletsOf({ outletGroups: { restaurant: ['点心', '中餐', '烧腊', '酒水'], water: ['手作饮料', '糖水', '调酒'] } });
    expect(isValidSlot({ outlet: 'restaurant', group: '点心' }, outlets)).toBe(true);
    expect(isValidSlot({ outlet: 'restaurant', group: '餐饮' }, outlets)).toBe(false);
    expect(parseSlotKey('restaurant:烧腊', outlets)).toEqual({ outlet: 'restaurant', group: '烧腊' });
    expect(parseSlotKey('restaurant:烧腊')).toBeNull();
    expect(slotOrder({ outlet: 'restaurant', group: '中餐' }, outlets)).toBe(1);
    // 价目分类正好是一个小分类 → 归那一类；默认「餐厅 · 餐饮」没了 → 餐厅的第一个（点心）
    expect(diningSlotOf({ outlet: null, group: '', category: '烧腊' }, outlets)).toMatchObject({ outlet: 'restaurant', group: '烧腊', assigned: false });
    expect(diningSlotOf({ outlet: null, group: '', category: '热菜' }, outlets)).toMatchObject({ outlet: 'restaurant', group: '点心', assigned: false });
    expect(diningSlotOf({ outlet: null, group: '', category: '啤酒' }, outlets)).toMatchObject({ outlet: 'restaurant', group: '酒水' });
    // 设过的小分类不在名单里了：归到那一处的第一个
    expect(diningSlotOf({ outlet: 'restaurant', group: '餐饮', category: '' }, outlets)).toMatchObject({ outlet: 'restaurant', group: '点心', assigned: true });
  });
});
