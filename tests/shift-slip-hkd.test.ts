// 8.2.30 港元现金的交班表打到小票机（Codex 审查 e7132c4）：应有现金扣掉港元折的人民币，要在单据上列出来，
// 交班后再列应有港元、实点港元与港元长短款——与浏览器打印的交班表同一份，打出来的数加得起来。不要数据库。

import { describe, expect, it } from 'vitest';
import type { ShiftRecord, ShiftSummary } from '../src/shared/checkout';
import { decodePrintedText } from '../src/server/devices/escpos';
import { buildShiftSlip } from '../src/server/devices/slips';

const meta = { storeName: '测试门店', instanceLabel: '演示', production: false, timeZone: 'Asia/Shanghai', issuedAt: new Date('2026-11-28T12:00:00Z'), issuedBy: '测试店员' };

const summary: ShiftSummary = {
  from: '2026-11-28T02:00:00Z',
  to: '2026-11-28T10:00:00Z',
  checkouts: { count: 2, total: 80_000 },
  checkoutByMethod: [{ method: 'cash', count: 2, amount: 80_000 }],
  recharges: { count: 0, paid: 0, bonus: 0, byMethod: [] },
  walletConsumes: { count: 0, total: 0 },
  coupons: [],
  voids: [],
  hkd: { count: 1, expected: 60_000, worth: 55_200 },
  // 50000 + 80000 − 55200 = 74800
  cash: { opening: 50_000, checkout: 80_000, recharge: 0, hkd: 55_200, expected: 74_800 },
};

const base: ShiftRecord = {
  id: 1,
  shiftNo: 'BC20261128001',
  staffId: 2,
  staffName: '测试店员',
  status: 'closed',
  businessDate: '2026-11-28',
  startedAt: '2026-11-28T02:00:00Z',
  openingCash: 50_000,
  endedAt: '2026-11-28T10:00:00Z',
  expectedCash: 74_800,
  countedCash: 74_800,
  expectedHkd: 60_000,
  countedHkd: 59_000,
  note: '',
  handedToName: null,
  closedByName: '测试店员',
  summary,
  drawerName: null,
  members: [],
  blindCount: null,
};

const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('交班表（小票机）的港元', () => {
  it('列出扣掉的港元折人民币，交班后列应有港元、实点港元与港元短款', () => {
    const text = flat(decodePrintedText(buildShiftSlip(base, meta)));
    // 小票机字库把 ¥、− 换成全角
    expect(text).toContain('收港元折的人民币（港元另点） ￥552.00');
    expect(text).toContain('= 应有现金 ￥748.00');
    expect(text).toContain('港元应有（1 笔） HK$600.00');
    expect(text).toContain('港元实点 HK$590.00');
    expect(text).toContain('港元短款 HK$10.00');
  });

  it('港元点得对不列长短款；没收过港元的班次不列港元', () => {
    expect(flat(decodePrintedText(buildShiftSlip({ ...base, countedHkd: 60_000 }, meta)))).not.toMatch(/港元(长|短)款/);
    const { hkd: _hkd, ...rest } = summary;
    const plain = flat(
      decodePrintedText(
        buildShiftSlip(
          {
            ...base,
            expectedHkd: null,
            countedHkd: null,
            expectedCash: 130_000,
            countedCash: 130_000,
            summary: { ...rest, cash: { opening: 50_000, checkout: 80_000, recharge: 0, expected: 130_000 } },
          },
          meta,
        ),
      ),
    );
    expect(plain).not.toContain('港元');
  });
});
