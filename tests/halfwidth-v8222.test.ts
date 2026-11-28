// 8.2.27 全角转半角（docs/V82227_HOTKEYS.md）：输入法开着时敲的牌号、金额、读卡器打进来的卡号都按半角认。纯函数，不要数据库。

import { describe, expect, it } from 'vitest';
import { createWedgeRecognizer } from '../src/shared/devices';
import { normalizeTagCode } from '../src/shared/frontdesk';
import { normalizeCardUid } from '../src/shared/frontdesk-risk';
import { toHalfWidth } from '../src/shared/halfwidth';
import { parseYuan } from '../src/shared/money';

describe('全角转半角', () => {
  it('全角 ASCII 与全角空格换成半角，中文不动', () => {
    expect(toHalfWidth('８２０１')).toBe('8201');
    expect(toHalfWidth('Ａ０２３　号')).toBe('A023 号');
    expect(toHalfWidth('收银１２８．５元')).toBe('收银128.5元');
  });

  it('牌号、芯片号、金额都认全角', () => {
    expect(normalizeTagCode(' ａ０２３ ')).toBe('A023');
    expect(normalizeCardUid('０４：Ａ１：ｂ２')).toBe('04A1B2');
    expect(parseYuan('１２８．５')).toBe(12850);
    expect(parseYuan('¥１，２８０')).toBe(128000);
  });

  it('键盘式读卡器打进来的全角数字照样认成一次刷卡', () => {
    const w = createWedgeRecognizer();
    let at = 0;
    for (const k of ['１', '２', '３', '４', '５', '６']) expect(w.feed(k, (at += 5))).toBeNull();
    expect(w.feed('Enter', (at += 5))).toBe('123456');
  });
});

describe('结账记录搜索（8.2.27）', () => {
  it('牌号（部分、全角）、单号后几位、金额、经办人、桌号', async () => {
    const { checkoutMatches } = await import('../src/shared/checkout');
    const c = { checkoutNo: 'JZ20261127-0042', tagCodes: ['A023', 'B105'], tableNames: ['V3'], totalAmount: 49900, operatorName: '小周' };
    for (const q of ['', 'a023', '０２３', '105', '0042', '499', '499.00', '小周', 'v3']) expect(checkoutMatches(c, q), q).toBe(true);
    for (const q of ['C001', '0043', '500', '小李']) expect(checkoutMatches(c, q), q).toBe(false);
  });
});
