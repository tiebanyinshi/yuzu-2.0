// 配色的对比度（docs/STAFF_MP.md 第 4 节、核对清单第 8 条）：从 app.wxss 读令牌，正文与各种状态的字在自己的底上不低于 4.5 : 1，
// 要认得出边界的控件边（输入框、次按钮）不低于 3 : 1。木色只做图形，不在这里核对。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/app.wxss', import.meta.url), 'utf8');
const token = (name: string) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(css);
  if (!m) throw new Error(`没有令牌 --${name}`);
  return m[1]!;
};
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(token(a)), lum(token(b))].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe('对比度', () => {
  it('正文、次要字、做字的木色在底色与卡片上 ≥ 4.5', () => {
    for (const fg of ['ink', 'ink-2', 'wood-text']) for (const bg of ['bg', 'surface', 'surface-2']) expect(ratio(fg, bg), `${fg} / ${bg}`).toBeGreaterThanOrEqual(4.5);
    // 「新」标签：木色字在浅木色底上
    expect(ratio('wood-text', 'wood-soft')).toBeGreaterThanOrEqual(4.5);
  });

  it('主按钮的字、状态色的字在自己的浅底上 ≥ 4.5', () => {
    expect(ratio('on-ink', 'ink')).toBeGreaterThanOrEqual(4.5);
    for (const t of ['success', 'danger', 'info', 'warn']) expect(ratio(t, `${t}-soft`), t).toBeGreaterThanOrEqual(4.5);
    for (const t of ['success', 'danger', 'info']) expect(ratio(t, 'surface'), `${t} / surface`).toBeGreaterThanOrEqual(4.5);
  });

  it('输入框、次按钮的边 ≥ 3', () => {
    for (const bg of ['bg', 'surface', 'surface-2']) expect(ratio('line-strong', bg), bg).toBeGreaterThanOrEqual(3);
  });
});
