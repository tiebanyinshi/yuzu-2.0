// 饭卡码（src/utils/meal-code.ts）：与主线柚子饭堂的 signCanteenCode（服务端核对用的同一个算法）逐字一致，30 秒一段。

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signCanteenCode } from '../../src/shared/canteen';
import { codeStepOf, secondsLeft, signMealCode } from '../src/utils/meal-code';

describe('饭卡码', () => {
  it('随机的钥匙、员工、时刻：与主线算出来的一模一样', () => {
    for (let i = 0; i < 200; i++) {
      const key = randomBytes(32).toString('base64url');
      const id = 1 + Math.floor(Math.random() * 100000);
      const at = 1_700_000_000_000 + Math.floor(Math.random() * 1e11);
      expect(signMealCode(key, id, at)).toEqual(signCanteenCode(key, id, at));
    }
  });

  it('30 秒一段；还剩几秒', () => {
    expect(codeStepOf(30_000)).toBe(1);
    expect(codeStepOf(59_999)).toBe(1);
    expect(secondsLeft(31_000)).toBe(29);
    expect(signMealCode('AAAA', 7, 30_000).text).toMatch(/^YZC1:7:1:[A-Z2-7]{8}$/);
  });
});
