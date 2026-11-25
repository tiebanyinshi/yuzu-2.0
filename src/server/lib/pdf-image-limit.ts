// 培训 PDF 上传前的内嵌图片尺寸检查（Codex 安全审查 bfc32cd）：
// PDF 规范（ISO 32000-1 §7.5.7）规定流对象（图像 XObject、SMask、ImageMask）不能放在压缩对象流（ObjStm）里，
// 其字典（<< ... >>）直接以明文出现在 `stream` 关键字前面。按分块流式扫描，只留 64 KB 跨块窗口，不把整份大 PDF 读进内存，
// 也不解压图片流：发现单张内嵌图片超过像素或边长上限立即拒绝，配合前端 PDF.js 6.5.438 的 maxImageSize 形成双道防线。

import { TRAINING_PDF_MAX_IMAGE_PIXELS, TRAINING_PDF_MAX_IMAGE_SIDE } from '@shared/training';

export interface PdfImageProblem {
  width: number;
  height: number;
}

export interface PdfImageLimits {
  maxPixels?: number;
  maxSide?: number;
}

/** 跨块保留的尾部字节数：足够容纳跨过 3 MB 块边界的图像字典 */
const TAIL_KEEP = 65_536;
/** 从 `stream` 往前最多回看这么多字节找对应的 `<< ... >>` 字典 */
const DICT_LOOKBACK = 32_768;

const isWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x00;
const isDelim = (c: number) => isWs(c) || c === 0x2f || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x28 || c === 0x29 || c === 0x25;

/** 解码 PDF 名称里的 #XX 十六进制转义（例如 /Sub#74ype -> /Subtype） */
function decodePdfName(raw: string): string {
  if (!raw.includes('#')) return raw;
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
}

/** 线性解析一个顶层 PDF 字典（不含嵌套子字典里的同名键），只取关心的标量键 */
function parseTopDict(text: string): { isImage: boolean; width: number | null; height: number | null } {
  let i = 0;
  const n = text.length;
  let depth = 0;
  let isImage = false;
  let width: number | null = null;
  let height: number | null = null;

  const skipWsAndComments = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (isWs(c)) {
        i += 1;
      } else if (c === 0x25) {
        // % 注释到行尾
        while (i < n && text.charCodeAt(i) !== 0x0a && text.charCodeAt(i) !== 0x0d) i += 1;
      } else {
        break;
      }
    }
  };

  const readName = (): string => {
    const start = i;
    i += 1; // skip '/'
    while (i < n && !isDelim(text.charCodeAt(i))) i += 1;
    return decodePdfName(text.slice(start, i));
  };

  const readToken = (): string => {
    const start = i;
    while (i < n && !isDelim(text.charCodeAt(i))) i += 1;
    return text.slice(start, i);
  };

  const skipLiteralString = () => {
    let parens = 1;
    i += 1;
    while (i < n && parens > 0) {
      const c = text.charCodeAt(i);
      if (c === 0x5c) {
        i += 2; // 转义字符
      } else if (c === 0x28) {
        parens += 1;
        i += 1;
      } else if (c === 0x29) {
        parens -= 1;
        i += 1;
      } else {
        i += 1;
      }
    }
  };

  const readPositiveIntIfDirect = (): number | null => {
    skipWsAndComments();
    if (i >= n) return null;
    const saved = i;
    const first = readToken();
    if (!/^\d{1,12}$/.test(first)) {
      i = saved;
      return null;
    }
    // 排除间接引用（如 "10 0 R"）：往前偷看两个 token
    const afterFirst = i;
    skipWsAndComments();
    const second = readToken();
    if (/^\d+$/.test(second)) {
      skipWsAndComments();
      const third = readToken();
      if (third === 'R') return null;
    }
    i = afterFirst;
    const val = Number.parseInt(first, 10);
    return Number.isSafeInteger(val) && val > 0 ? val : null;
  };

  while (i < n) {
    skipWsAndComments();
    if (i >= n) break;
    const c = text.charCodeAt(i);
    if (c === 0x3c && text.charCodeAt(i + 1) === 0x3c) {
      depth += 1;
      i += 2;
      continue;
    }
    if (c === 0x3e && text.charCodeAt(i + 1) === 0x3e) {
      depth -= 1;
      i += 2;
      continue;
    }
    if (c === 0x28) {
      skipLiteralString();
      continue;
    }
    if (c === 0x3c) {
      // 十六进制字符串 <...>
      i += 1;
      while (i < n && text.charCodeAt(i) !== 0x3e) i += 1;
      if (i < n) i += 1;
      continue;
    }
    if (c === 0x5b || c === 0x5d) {
      i += 1;
      continue;
    }
    if (c === 0x2f) {
      const name = readName();
      if (depth !== 1) continue;
      if (name === '/Subtype') {
        skipWsAndComments();
        if (i < n && text.charCodeAt(i) === 0x2f && readName() === '/Image') isImage = true;
      } else if (name === '/ImageMask' || name === '/IM') {
        skipWsAndComments();
        if (readToken() === 'true') isImage = true;
      } else if (name === '/BitsPerComponent' || name === '/BPC') {
        isImage = true;
      } else if (name === '/Width' || name === '/W') {
        const v = readPositiveIntIfDirect();
        if (v !== null) width = v;
      } else if (name === '/Height' || name === '/H') {
        const v = readPositiveIntIfDirect();
        if (v !== null) height = v;
      }
      continue;
    }
    // 其他标量 token
    const before = i;
    readToken();
    if (i === before) i += 1;
  }
  return { isImage, width, height };
}

/** 从 `>>` 往前找到配对的顶层 `<<` 起点（只看 DICT_LOOKBACK 字节以内） */
function findMatchingDictStart(buf: Buffer, endExclusive: number): number {
  const minPos = Math.max(0, endExclusive - DICT_LOOKBACK);
  let depth = 0;
  let i = endExclusive - 2;
  while (i >= minPos) {
    if (buf[i] === 0x3e && buf[i + 1] === 0x3e) {
      depth += 1;
      i -= 2;
      continue;
    }
    if (buf[i] === 0x3c && buf[i + 1] === 0x3c) {
      depth -= 1;
      if (depth === 0) return i;
      i -= 2;
      continue;
    }
    i -= 1;
  }
  return -1;
}

const STREAM_NEEDLE = Buffer.from('stream', 'ascii');

/** 在一段字节里扫所有紧跟在 `>>` 后面的 `stream` 字典，查有没有超限的图片 */
function scanBuffer(buf: Buffer, maxPixels: number, maxSide: number): PdfImageProblem | null {
  let pos = 0;
  while (pos < buf.length) {
    const idx = buf.indexOf(STREAM_NEEDLE, pos);
    if (idx === -1) break;
    pos = idx + STREAM_NEEDLE.length;
    // 排除 endstream，且 stream 后面必须是 CR/LF（PDF 规范 §7.3.8.1）
    if (idx >= 3 && buf[idx - 3] === 0x65 && buf[idx - 2] === 0x6e && buf[idx - 1] === 0x64) continue;
    const after = idx + STREAM_NEEDLE.length;
    if (after >= buf.length || (buf[after] !== 0x0a && buf[after] !== 0x0d)) continue;
    // 跳过 stream 前面的空白，紧挨着的必须是 `>>`
    let end = idx - 1;
    while (end >= 0 && isWs(buf[end]!)) end -= 1;
    if (end < 1 || buf[end] !== 0x3e || buf[end - 1] !== 0x3e) continue;
    const start = findMatchingDictStart(buf, end + 1);
    if (start < 0) continue;
    const dictText = buf.subarray(start, end + 1).toString('latin1');
    const parsed = parseTopDict(dictText);
    if (!parsed.isImage || parsed.width === null || parsed.height === null) continue;
    if (parsed.width > maxSide || parsed.height > maxSide || parsed.width * parsed.height > maxPixels) {
      return { width: parsed.width, height: parsed.height };
    }
  }
  return null;
}

/** 分块流式扫描器：每次 push 一块（3 MB），只保留少量跨块尾部字节 */
export function createPdfImageScanner(limits: PdfImageLimits = {}) {
  const maxPixels = limits.maxPixels ?? TRAINING_PDF_MAX_IMAGE_PIXELS;
  const maxSide = limits.maxSide ?? TRAINING_PDF_MAX_IMAGE_SIDE;
  let tail = Buffer.alloc(0);
  let problem: PdfImageProblem | null = null;
  return {
    push(chunk: Buffer) {
      if (problem || !chunk.length) return;
      const combined = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      problem = scanBuffer(combined, maxPixels, maxSide);
      if (problem) {
        tail = Buffer.alloc(0);
        return;
      }
      tail = combined.length > TAIL_KEEP ? Buffer.from(combined.subarray(combined.length - TAIL_KEEP)) : Buffer.from(combined);
    },
    finish(): PdfImageProblem | null {
      return problem;
    },
  };
}

/** 一次性检查整份 PDF 缓冲区（给单元测试用） */
export function checkPdfImageLimit(buf: Buffer, limits: PdfImageLimits = {}): PdfImageProblem | null {
  const s = createPdfImageScanner(limits);
  s.push(buf);
  return s.finish();
}
