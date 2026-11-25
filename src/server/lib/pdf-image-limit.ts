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

/** 判断 `>>`（结束于 closeEnd）之后跳过空白是否紧跟 `stream` + CR/LF（PDF 规范 §7.3.8.1）；是则返回 `stream` 结束位置，否则 -1 */
function streamAfterDictClose(buf: Buffer, closeEnd: number): number {
  let i = closeEnd;
  const n = buf.length;
  while (i < n && isWs(buf[i]!)) i += 1;
  if (
    i + 6 < n &&
    buf[i] === 0x73 && // s
    buf[i + 1] === 0x74 && // t
    buf[i + 2] === 0x72 && // r
    buf[i + 3] === 0x65 && // e
    buf[i + 4] === 0x61 && // a
    buf[i + 5] === 0x6d && // m
    (buf[i + 6] === 0x0a || buf[i + 6] === 0x0d)
  ) {
    return i + 7;
  }
  return -1;
}

/**
 * 单遍线性扫描一段字节里所有紧跟在 `>>` 后面的 `stream` 字典（O(buf.length)，不回扫）：
 *   · 顺序维护尚未配对的 `<<` 栈；遇到 `>>` 且后面不是 `stream` 时 O(1) 弹出内层字典起点。
 *   · 遇到 `>>` + 空白 + `stream` + CR/LF：若栈里没有 DICT_LOOKBACK 内的 `<<`，O(1) 跳过（防止重复 `>>stream\n` 触发 O(N·32KB) 回扫卡住主线程）。
 *   · 若当前 `>>stream` 落在字典字符串字面量 `(...)` 或 `%` 注释里，向前跳到该字符串/注释结尾并保留外层 `<<`（防构造 `/Comment (>>stream\n)` 绕过）；
 *     并限制整块的语法复查工作量上限，最坏情况下总扫描与解析工作量严格线性。
 *   · 确认是一条真实流字典后，解析一次并清空 `<<` 栈（流字典彼此不重叠，保证总解析字节数不超过 buf.length）。
 */
function scanBuffer(buf: Buffer, maxPixels: number, maxSide: number): PdfImageProblem | null {
  const n = buf.length;
  const opens: number[] = [];
  let openHead = 0;

  // 单调复查光标：只检查 `>>stream` 是否落在当前候选字典的 `(...)` 字符串或 `%` 注释中
  let synStart = -1;
  let synPos = 0;
  let synParens = 0;
  let synComment = false;
  let synWork = 0;
  const maxSynWork = Math.max(DICT_LOOKBACK * 4, n * 2);

  const resetSyntax = () => {
    synStart = -1;
    synPos = 0;
    synParens = 0;
    synComment = false;
  };

  /** 把 synPos 从当前位置推进到 target（不超过 target），返回 target 处是否仍在字符串或注释里 */
  const inStringOrCommentAt = (start: number, target: number): boolean => {
    if (synWork >= maxSynWork) return false;
    if (synStart !== start || synPos > target) {
      synStart = start;
      synPos = start;
      synParens = 0;
      synComment = false;
    }
    while (synPos < target) {
      synWork += 1;
      const c = buf[synPos]!;
      if (synComment) {
        if (c === 0x0a || c === 0x0d) synComment = false;
        synPos += 1;
        continue;
      }
      if (synParens > 0) {
        if (c === 0x5c) {
          synPos += 2;
          continue;
        }
        if (c === 0x28) synParens += 1;
        else if (c === 0x29) synParens -= 1;
        synPos += 1;
        continue;
      }
      if (c === 0x25) {
        synComment = true;
      } else if (c === 0x28) {
        synParens = 1;
      }
      synPos += 1;
    }
    return synParens > 0 || synComment;
  };

  /** 从当前位置向前跳出未闭合的 `(...)` 字符串或 `%` 注释（不超过 limit） */
  const skipOutOfStringOrComment = (limit: number): number => {
    while (synPos < limit && (synParens > 0 || synComment)) {
      synWork += 1;
      const c = buf[synPos]!;
      if (synComment) {
        if (c === 0x0a || c === 0x0d) synComment = false;
        synPos += 1;
        continue;
      }
      if (c === 0x5c) {
        synPos += 2;
        continue;
      }
      if (c === 0x28) synParens += 1;
      else if (c === 0x29) synParens -= 1;
      synPos += 1;
    }
    return synPos;
  };

  let i = 0;
  while (i < n - 1) {
    const c = buf[i]!;
    if (c === 0x3c && buf[i + 1] === 0x3c) {
      opens.push(i);
      i += 2;
      continue;
    }
    if (c === 0x3e && buf[i + 1] === 0x3e) {
      // 丢弃超过 DICT_LOOKBACK 的旧 `<<`（均摊 O(1)）
      while (openHead < opens.length && i + 2 - opens[openHead]! > DICT_LOOKBACK) openHead += 1;
      if (openHead >= opens.length) {
        opens.length = 0;
        openHead = 0;
        resetSyntax();
        const afterStream = streamAfterDictClose(buf, i + 2);
        i = afterStream >= 0 ? afterStream : i + 2;
        continue;
      }
      const start = opens[opens.length - 1]!;
      if (inStringOrCommentAt(start, i)) {
        const limit = Math.min(n, start + DICT_LOOKBACK);
        const resumed = skipOutOfStringOrComment(limit);
        if (synParens === 0 && !synComment) {
          i = resumed;
          continue;
        }
        // 字符串/注释超长未闭合：放弃这个起点，避免卡死
        opens.pop();
        resetSyntax();
        i += 2;
        continue;
      }
      const afterStream = streamAfterDictClose(buf, i + 2);
      if (afterStream < 0) {
        opens.pop();
        resetSyntax();
        i += 2;
        continue;
      }
      // 真实流字典：只解析一次并清空栈，确保后续流字典不与本段重叠
      opens.length = 0;
      openHead = 0;
      resetSyntax();
      const dictText = buf.subarray(start, i + 2).toString('latin1');
      const parsed = parseTopDict(dictText);
      if (parsed.isImage && parsed.width !== null && parsed.height !== null) {
        if (parsed.width > maxSide || parsed.height > maxSide || parsed.width * parsed.height > maxPixels) {
          return { width: parsed.width, height: parsed.height };
        }
      }
      i = afterStream;
      continue;
    }
    i += 1;
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
