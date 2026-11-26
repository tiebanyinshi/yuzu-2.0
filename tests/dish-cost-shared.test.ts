// 8.1.41 菜品毛利率的算法（docs/V8141.md 第 2 节）。
import { describe, expect, it } from 'vitest';
import { dishMarginBp, marginText } from '../src/shared/dish-cost';

describe('菜品毛利率', () => {
  it('（售价 − 成本）÷ 售价，万分比四舍五入；没有成本、售价不是正数为空', () => {
    expect(dishMarginBp(500, 100)).toBe(8000);
    expect(dishMarginBp(3800, 1234)).toBe(6753);
    expect(dishMarginBp(500, 600)).toBe(-2000);
    expect(dishMarginBp(500, null)).toBeNull();
    expect(dishMarginBp(0, 100)).toBeNull();
  });
  it('写成百分比，整数不带 .0', () => {
    expect(marginText(8000)).toBe('80%');
    expect(marginText(6753)).toBe('67.5%');
    expect(marginText(-2000)).toBe('-20%');
  });
});
