// 员工培训的纯函数（不要数据库）：PDF 一页画多大（Codex 安全审查 04eb112）、文件名规则（Codex 审查 9b1dd16）。
import { describe, expect, it } from 'vitest';
import { pdfRenderScale, TRAINING_FILE_NAME_MAX, TRAINING_PDF_MAX_PIXELS, TRAINING_PDF_MAX_SIDE, trainingFileNameProblem } from '../src/shared/training';

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

describe('trainingFileNameProblem（页面先查与服务端同一条，Codex 审查 9b1dd16）', () => {
  it('正常的名字没问题；首尾空白不算', () => {
    expect(trainingFileNameProblem('员工手册.pdf')).toBeNull();
    expect(trainingFileNameProblem('  a.pdf ')).toBeNull();
  });
  it('超过 200 个字、空的、带路径或控制字符的都不行', () => {
    expect(trainingFileNameProblem(`${'长'.repeat(TRAINING_FILE_NAME_MAX)}.pdf`)).toMatch(/最多/);
    expect(trainingFileNameProblem('   ')).toBe('缺少文件名');
    expect(trainingFileNameProblem('a/b.pdf')).toMatch(/路径/);
    expect(trainingFileNameProblem('a\u0001.pdf')).toMatch(/控制字符/);
  });
});
