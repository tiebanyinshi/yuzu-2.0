// 二维码（src/utils/qr.ts）：画到假画布上，用独立的解码器（jsQR）读回来，与原文一致；饭卡码用字母数字模式，别的文字用字节模式。

import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { drawQr, encodeText } from '../src/utils/qr';

function decode(text: string): string | null {
  const qr = encodeText(text);
  const px = (qr.size + 8) * 6;
  const pixels = new Uint8ClampedArray(px * px * 4).fill(255);
  let style = '';
  const ctx = {
    get fillStyle() {
      return style;
    },
    set fillStyle(v: unknown) {
      style = String(v);
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const v = style === '#000' ? 0 : 255;
      for (let yy = Math.floor(y); yy < Math.min(px, Math.ceil(y + h)); yy++) {
        for (let xx = Math.floor(x); xx < Math.min(px, Math.ceil(x + w)); xx++) {
          const i = (yy * px + xx) * 4;
          pixels[i] = pixels[i + 1] = pixels[i + 2] = v;
        }
      }
    },
  };
  drawQr(ctx, qr, px, '#000', '#fff');
  return jsQR(pixels, px, px)?.data ?? null;
}

describe('二维码', () => {
  it('饭卡码（字母数字模式）读得回来，版本不超过 2', () => {
    const code = 'YZC1:2N9:1BLMK2:ABCDE234';
    expect(decode(code)).toBe(code);
    expect(encodeText(code).size).toBeLessThanOrEqual(25);
  });

  it('别的文字（字节模式、中文）也读得回来', () => {
    expect(decode('https://staff.yuzusystem.xyz/#patrol=ABCD')).toBe('https://staff.yuzusystem.xyz/#patrol=ABCD');
    expect(decode('汤崎 WCP')).toBe('汤崎 WCP');
  });

  it('太长放不下就报错', () => {
    expect(() => encodeText('x'.repeat(200))).toThrow();
  });
});
