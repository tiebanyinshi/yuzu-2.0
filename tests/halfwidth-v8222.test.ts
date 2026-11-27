// 8.2.22 全角转半角（docs/V82222_HOTKEYS.md）：输入法开着时敲的牌号、金额、读卡器打进来的卡号都按半角认。纯函数，不要数据库。

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
