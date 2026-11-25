// 员工培训的纯函数（不要数据库）：PDF 一页画多大（Codex 安全审查 04eb112）、文件名规则（Codex 审查 9b1dd16）、上传编号有效期与 PDF 内嵌图片检查（Codex 审查 bfc32cd）。
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  newTrainingUploadKey,
  pdfRenderScale,
  TRAINING_FILE_NAME_MAX,
  TRAINING_PDF_MAX_IMAGE_PIXELS,
  TRAINING_PDF_MAX_PIXELS,
  TRAINING_PDF_MAX_SIDE,
  TRAINING_UPLOAD_KEY_FUTURE_MS,
  TRAINING_UPLOAD_KEY_TTL_DAYS,
  trainingFileNameProblem,
  trainingUploadKeyState,
  trainingUploadKeyTime,
} from '../src/shared/training';
import { checkPdfImageLimit, createPdfImageScanner } from '../src/server/lib/pdf-image-limit';

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

describe('UUIDv7 上传操作编号有效期（Codex 审查 bfc32cd）', () => {
  it('生成合法的 UUIDv7 并还原毫秒时间戳；区分有效、过期、超前与非 UUIDv7', () => {
    const now = Date.UTC(2026, 10, 25, 12, 0, 0);
    const key = newTrainingUploadKey(now);
    expect(trainingUploadKeyTime(key)).toBe(now);
    expect(trainingUploadKeyState(key, now)).toBe('valid');
    expect(trainingUploadKeyState(key, now + TRAINING_UPLOAD_KEY_TTL_DAYS * 86_400_000)).toBe('valid');
    expect(trainingUploadKeyState(key, now + TRAINING_UPLOAD_KEY_TTL_DAYS * 86_400_000 + 1)).toBe('expired');
    // 允许客户端时钟略微超前（最多 24 小时），超过拒绝
    expect(trainingUploadKeyState(newTrainingUploadKey(now + TRAINING_UPLOAD_KEY_FUTURE_MS), now)).toBe('valid');
    expect(trainingUploadKeyState(newTrainingUploadKey(now + TRAINING_UPLOAD_KEY_FUTURE_MS + 1), now)).toBe('future');
    // 普通 UUIDv4 认成 invalid（不能绕过过期）
    expect(trainingUploadKeyTime(randomUUID())).toBeNull();
    expect(trainingUploadKeyState(randomUUID(), now)).toBe('invalid');
  });
});

describe('PDF 内嵌图片尺寸流式检查（Codex 安全审查 bfc32cd）', () => {
  const sample = (dict: string) => Buffer.from(`%PDF-1.4\n1 0 obj\n${dict}\nstream\n0000\nendstream\nendobj\n`, 'latin1');

  it('正常尺寸图片与非图片流放行', () => {
    expect(checkPdfImageLimit(sample('<< /Type /XObject /Subtype /Image /Width 2480 /Height 3508 /BitsPerComponent 8 >>'))).toBeNull();
    // 非图片流即使含 /Width /Height 也不误拦
    expect(checkPdfImageLimit(sample('<< /Filter /FlateDecode /Length 4 /Width 20000 /Height 20000 >>'))).toBeNull();
  });

  it('12000×12000 图片、带十六进制转义的 /Subtype、缺少 /Subtype 但有 /BitsPerComponent 的 SMask、单边超限一律拦下', () => {
    expect(checkPdfImageLimit(sample('<< /Type /XObject /Subtype /Image /Width 12000 /Height 12000 /Filter /FlateDecode >>'))).toEqual({ width: 12000, height: 12000 });
    expect(checkPdfImageLimit(sample('<< /Sub#74ype /Image /W 5000 /H 5000 >>'))).toEqual({ width: 5000, height: 5000 });
    expect(checkPdfImageLimit(sample('<< /ColorSpace /DeviceGray /BitsPerComponent 8 /Width 12000 /Height 12000 >>'))).toEqual({ width: 12000, height: 12000 });
    expect(checkPdfImageLimit(sample('<< /Subtype /Image /Width 20000 /Height 10 >>'))).toEqual({ width: 20000, height: 10 });
    expect(TRAINING_PDF_MAX_IMAGE_PIXELS).toBe(16_000_000);
  });

  it('图像字典跨两个分块也能检出；间接引用（10 0 R）不误读对象号', () => {
    const pdf = sample('<< /Type /XObject /Subtype /Image /Width 6000 /Height 4000 /BitsPerComponent 8 >>');
    const scanner = createPdfImageScanner();
    scanner.push(pdf.subarray(0, 40));
    scanner.push(pdf.subarray(40));
    expect(scanner.finish()).toEqual({ width: 6000, height: 4000 });
    expect(checkPdfImageLimit(sample('<< /Subtype /Image /Width 99999 0 R /Height 99999 0 R >>'))).toBeNull();
  });

  it('线性时间与零堆积防护（Codex 审查 7a7016e & 安全审查 26222e1）：3 MB 重复 <<、1 MB 重复 >>stream\\n 与深嵌套不卡主线程且不堆内存，字符串内伪造绕不过限额', () => {
    const repeatedOpens = Buffer.from(`%PDF-1.4\n${'<<'.repeat(1_500_000)}`, 'latin1');
    const tOpen = Date.now();
    expect(checkPdfImageLimit(repeatedOpens)).toBeNull();
    expect(Date.now() - tOpen).toBeLessThan(200);

    const repeated = Buffer.from(`%PDF-1.4\n${'>>stream\n'.repeat(120_000)}`, 'latin1');
    const t0 = Date.now();
    expect(checkPdfImageLimit(repeated)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);

    const nested = Buffer.from(`%PDF-1.4\n${'<<'.repeat(10_000)}${' '.repeat(12_000)}${'>>stream\n'.repeat(10_000)}`, 'latin1');
    const t1 = Date.now();
    expect(checkPdfImageLimit(nested)).toBeNull();
    expect(Date.now() - t1).toBeLessThan(500);

    // 字典字符串里藏 >>stream\n 或 >> 也不能绕过外层超限图片检查
    const sneaky = sample('<< /Comment (>>stream\n) /Type /XObject /Subtype /Image /Width 12000 /Height 12000 >>');
    expect(checkPdfImageLimit(sneaky)).toEqual({ width: 12000, height: 12000 });
    const sneakyClose = sample('<< /Comment (foo >> bar) /Type /XObject /Subtype /Image /Width 12000 /Height 12000 >>');
    expect(checkPdfImageLimit(sneakyClose)).toEqual({ width: 12000, height: 12000 });

    // 前一个二进制流里出现未闭合的 << 与 ( 不影响后一个超限图像对象检出
    const afterBinary = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Length 8 >>\nstream\n<<((raw!\nendstream\nendobj\n2 0 obj\n<< /Type /XObject /Subtype /Image /Width 12000 /Height 12000 >>\nstream\n0000\nendstream\nendobj\n',
      'latin1',
    );
    expect(checkPdfImageLimit(afterBinary)).toEqual({ width: 12000, height: 12000 });

    // 内层子字典正常配对后，外层超限图像字典仍能检出
    const withSubDict = sample('<< /Type /XObject /Subtype /Image /DecodeParms << /Predictor 15 >> /Width 12000 /Height 12000 >>');
    expect(checkPdfImageLimit(withSubDict)).toEqual({ width: 12000, height: 12000 });
  });
});
