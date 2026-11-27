// 发卡器「结果待确认」的读卡核对（Codex 审查 34a7c87、b446d09、307b2f4，docs/LOCKERS_V8149.md 第 6.4 节）：不要数据库
import { describe, expect, it } from 'vitest';
import { settleLockerCardPending, type LockerCardPending } from '../src/shared/lockers';

const at = '2026-11-27T20:00:00.000Z';
const pending: LockerCardPending[] = [
  { id: 'w1', op: 'write', code: 'A8067', uid: '04A1B2C3', storeId: 1, at },
  { id: 'c1', op: 'clear', uid: '0499AA11', storeId: 1, at },
];

describe('发卡器待核对：读卡只认做成了的证据，而且要是同一张卡', () => {
  it('写卡：同一张芯片号、卡里就是那个柜算写成了；别的卡早就写成同一个柜不算；同一张卡还是别的柜、空白不下结论', () => {
    expect(settleLockerCardPending(pending, { ok: true, uid: '04A1B2C3', code: 'A8067' })).toEqual([{ id: 'w1', text: expect.stringContaining('写成了') }]);
    expect(settleLockerCardPending(pending, { ok: true, uid: '0ABCDE12', code: 'A8067' })).toEqual([]);
    expect(settleLockerCardPending(pending, { ok: true, uid: '04A1B2C3', code: 'A8068' })).toEqual([]);
    expect(settleLockerCardPending(pending, { ok: true, uid: '04A1B2C3', code: null })).toEqual([]);
  });

  it('清卡：同一张芯片号读回空白算清成了；还写着柜不下结论（原来那次可能还在桥里没做完）；别的卡不下结论', () => {
    expect(settleLockerCardPending(pending, { ok: true, uid: '0499AA11', code: null })).toEqual([{ id: 'c1', text: expect.stringContaining('已清成空白') }]);
    expect(settleLockerCardPending(pending, { ok: true, uid: '0499AA11', code: 'A8060' })).toEqual([]);
    expect(settleLockerCardPending(pending, { ok: true, uid: '0ABCDE12', code: null })).toEqual([]);
  });

  it('同一张卡写同一个柜记了两次：读到写成了，两条都核对掉', () => {
    const twice: LockerCardPending[] = [pending[0]!, { ...pending[0]!, id: 'w2' }];
    expect(settleLockerCardPending(twice, { ok: true, uid: '04A1B2C3', code: 'A8067' }).map((c) => c.id)).toEqual(['w1', 'w2']);
  });

  it('没读到卡、读不出芯片号：什么都不下结论', () => {
    expect(settleLockerCardPending(pending, { ok: false, uid: null, code: null })).toEqual([]);
    expect(settleLockerCardPending(pending, { ok: true, uid: null, code: 'A8067' })).toEqual([]);
  });
});
