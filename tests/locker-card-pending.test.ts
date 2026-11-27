// 发卡器「结果待确认」的读卡核对（Codex 审查 34a7c87，docs/LOCKERS_V8149.md 第 6.4 节）：不要数据库
import { describe, expect, it } from 'vitest';
import { settleLockerCardPending, type LockerCardPending } from '../src/shared/lockers';

const at = '2026-11-27T20:00:00.000Z';
const pending: LockerCardPending[] = [
  { id: 'w1', op: 'write', code: 'A8067', storeId: 1, at },
  { id: 'c1', op: 'clear', uid: '04A1B2C3', storeId: 1, at },
  { id: 'c2', op: 'clear', uid: null, storeId: 1, at },
];

describe('发卡器待核对：读卡下结论', () => {
  it('写卡：卡里就是那个柜算写成了；别的柜、空白卡不下结论', () => {
    expect(settleLockerCardPending(pending, { ok: true, uid: '0499AA11', code: 'A8067' })).toEqual([{ id: 'w1', outcome: 'done', text: expect.stringContaining('写成了') }]);
    expect(settleLockerCardPending(pending, { ok: true, uid: '0499AA11', code: 'A8068' })).toEqual([]);
    expect(settleLockerCardPending(pending, { ok: true, uid: '0499AA11', code: null })).toEqual([]);
  });

  it('清卡：同一张芯片号空白算清成了、还写着柜算没清成；别的卡、没记芯片号的不下结论', () => {
    expect(settleLockerCardPending(pending, { ok: true, uid: '04A1B2C3', code: null })).toEqual([{ id: 'c1', outcome: 'done', text: expect.stringContaining('已清成空白') }]);
    expect(settleLockerCardPending(pending, { ok: true, uid: '04A1B2C3', code: 'A8060' })).toEqual([{ id: 'c1', outcome: 'not_done', text: expect.stringContaining('没清成') }]);
    expect(settleLockerCardPending(pending, { ok: true, uid: '0499AA11', code: null })).toEqual([]);
  });

  it('没读到卡：什么都不下结论', () => {
    expect(settleLockerCardPending(pending, { ok: false, uid: null, code: null })).toEqual([]);
  });
});
