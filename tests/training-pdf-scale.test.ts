// 员工培训 PDF 一页画多大（Codex 安全审查 04eb112）：画布像素、边长都有上限，PDF 里写的页面比例再怪也不无限放大。
import { describe, expect, it } from 'vitest';
import { pdfRenderScale, TRAINING_PDF_MAX_PIXELS, TRAINING_PDF_MAX_SIDE } from '../src/shared/training';

const canvas = (w: number, h: number, display: number, ratio: number) => {
  const s = pdfRenderScale(w, h, display, ratio);
  return { w: w * s, h: h * s };
};

describe('pdfRenderScale', () => {
  it('普通 A4 照显示宽度 × 屏幕像素比画（最多 2 倍）', () => {
    const c = canvas(595, 842, 800, 2);
    expect(c.w).toBeCloseTo(1600);
    expect(canvas(595, 842, 800, 3).w).toBeCloseTo(1600);
  });
  it('1:15 的细长页：像素数与边长都压在上限以内', () => {
    const c = canvas(100, 1500, 800, 2);
    expect(c.w * c.h).toBeLessThanOrEqual(TRAINING_PDF_MAX_PIXELS + 1);
    expect(c.h).toBeLessThanOrEqual(TRAINING_PDF_MAX_SIDE + 1e-6);
    expect(c.w).toBeLessThanOrEqual(TRAINING_PDF_MAX_SIDE + 1e-6);
  });
  it('极宽的页：边长不超过上限', () => {
    const c = canvas(100_000, 10, 4000, 2);
    expect(c.w).toBeLessThanOrEqual(TRAINING_PDF_MAX_SIDE + 1e-6);
  });
  it('宽高不对（0、负数、NaN）不画', () => {
    expect(pdfRenderScale(0, 100, 800, 2)).toBe(0);
    expect(pdfRenderScale(100, Number.NaN, 800, 2)).toBe(0);
  });
});
