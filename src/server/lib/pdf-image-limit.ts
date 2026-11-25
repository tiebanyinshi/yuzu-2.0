// 培训 PDF 上传前的内嵌图片尺寸检查（Codex 安全审查 bfc32cd、26222e1）：
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
/** 环形队列容量（2 的幂）：32 KB 窗口内最多 DICT_LOOKBACK / 2 + 1 = 16385 个 `<<`，32768 永不溢出且固定占 128 KB 零堆增长 */
const OPEN_RING_CAP = 32_768;
const OPEN_RING_MASK = OPEN_RING_CAP - 1;

const STREAM_NEEDLE = Buffer.from('stream', 'ascii');
const OPEN_DICT_NEEDLE = Buffer.from('<<', 'ascii');

const isWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x00;
const isDelim = (c: number) => isWs(c) || c === 0x2f || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x28 || c === 0x29 || c === 0x25;
const isCandidateKeyStart = (c: number) => c === 0x53 || c === 0x49 || c === 0x42 || c === 0x57 || c === 0x48 || c === 0x23;

/** 解码 PDF 名称里的 #XX 十六进制转义（例如 /Sub#74ype -> /Subtype） */
function decodePdfName(raw: string): string {
  if (!raw.includes('#')) return raw;
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
}

function skipWsAndCommentsBuf(buf: Buffer, i: number, end: number): number {
  while (i < end) {
    const c = buf[i]!;
    if (isWs(c)) {
      i += 1;
    } else if (c === 0x25) {
      while (i < end && buf[i] !== 0x0a && buf[i] !== 0x0d) i += 1;
    } else {
      break;
    }
  }
  return i;
}

function skipTokenEnd(buf: Buffer, i: number, end: number): number {
  while (i < end && !isDelim(buf[i]!)) i += 1;
  return i;
}

function isAllDigitsBuf(buf: Buffer, s: number, e: number): boolean {
  if (e <= s) return false;
  for (let k = s; k < e; k += 1) {
    const c = buf[k]!;
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

function parseDigitsBuf(buf: Buffer, s: number, e: number): number | null {
  if (e <= s || e - s > 12) return null;
  let val = 0;
  for (let k = s; k < e; k += 1) {
    const c = buf[k]!;
    if (c < 0x30 || c > 0x39) return null;
    val = val * 10 + (c - 0x30);
  }
  return Number.isSafeInteger(val) && val > 0 ? val : null;
}

/**
 * 直接在 Buffer 切片 `[start, end)` 上解析顶层 `<< ... >>` 里的图像标量键（零 subarray / 整段字符串分配）：
 * 嵌套子字典、数组、字面量字符串（含转义）、十六进制字符串、% 注释都会跳过；
 * 仅在发现超限图片时返回 PdfImageProblem，否则返回 null。
 */
function checkTopDictProblem(buf: Buffer, start: number, end: number, maxPixels: number, maxSide: number): PdfImageProblem | null {
  if (end - start < 16) return null;
  let i = start;
  let depth = 0;
  let isImage = false;
  let width: number | null = null;
  let height: number | null = null;

  while (i < end) {
    i = skipWsAndCommentsBuf(buf, i, end);
    if (i >= end) break;
    const c = buf[i]!;
    if (c === 0x3c && i + 1 < end && buf[i + 1] === 0x3c) {
      depth += 1;
      i += 2;
      continue;
    }
    if (c === 0x3e && i + 1 < end && buf[i + 1] === 0x3e) {
      depth -= 1;
      i += 2;
      continue;
    }
    if (c === 0x28) {
      let parens = 1;
      i += 1;
      while (i < end && parens > 0) {
        const ch = buf[i]!;
        if (ch === 0x5c) {
          i += 2;
        } else if (ch === 0x28) {
          parens += 1;
          i += 1;
        } else if (ch === 0x29) {
          parens -= 1;
          i += 1;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (c === 0x3c) {
      i += 1;
      while (i < end && buf[i] !== 0x3e) i += 1;
      if (i < end) i += 1;
      continue;
    }
    if (c === 0x5b || c === 0x5d) {
      i += 1;
      continue;
    }
    if (c === 0x2f) {
      const s = i;
      i = skipTokenEnd(buf, i + 1, end);
      if (depth !== 1 || i <= s + 1 || !isCandidateKeyStart(buf[s + 1]!)) continue;
      const name = decodePdfName(buf.toString('latin1', s, i));
      if (name === '/Subtype') {
        i = skipWsAndCommentsBuf(buf, i, end);
        if (i < end && buf[i] === 0x2f) {
          const vs = i;
          i = skipTokenEnd(buf, i + 1, end);
          if (decodePdfName(buf.toString('latin1', vs, i)) === '/Image') isImage = true;
        }
      } else if (name === '/ImageMask' || name === '/IM') {
        i = skipWsAndCommentsBuf(buf, i, end);
        const ts = i;
        i = skipTokenEnd(buf, i, end);
        if (i - ts === 4 && buf[ts] === 0x74 && buf[ts + 1] === 0x72 && buf[ts + 2] === 0x75 && buf[ts + 3] === 0x65) {
          isImage = true;
        }
      } else if (name === '/BitsPerComponent' || name === '/BPC') {
        isImage = true;
      } else if (name === '/Width' || name === '/W' || name === '/Height' || name === '/H') {
        i = skipWsAndCommentsBuf(buf, i, end);
        if (i < end) {
          const saved = i;
          const e1 = skipTokenEnd(buf, i, end);
          const val = parseDigitsBuf(buf, saved, e1);
          if (val !== null) {
            let p = skipWsAndCommentsBuf(buf, e1, end);
            const s2 = p;
            p = skipTokenEnd(buf, p, end);
            let indirect = false;
            if (isAllDigitsBuf(buf, s2, p)) {
              p = skipWsAndCommentsBuf(buf, p, end);
              const s3 = p;
              p = skipTokenEnd(buf, p, end);
              if (p - s3 === 1 && buf[s3] === 0x52) indirect = true;
            }
            i = indirect ? p : e1;
            if (!indirect) {
              if (name === '/Width' || name === '/W') width = val;
              else height = val;
            }
          }
        }
      }
      continue;
    }
    const next = skipTokenEnd(buf, i, end);
    i = next === i ? i + 1 : next;
  }

  if (isImage && width !== null && height !== null && (width > maxSide || height > maxSide || width * height > maxPixels)) {
    return { width, height };
  }
  return null;
}

/** 判断 `>>`（结束于 closeEnd）之后跳过空白是否紧跟 `stream` + CR/LF（PDF 规范 §7.3.8.1）；是则返回 `stream` 结束位置，否则 -1 */
function streamAfterDictClose(buf: Buffer, closeEnd: number): number {
  let i = closeEnd;
  const n = buf.length;
  while (i < n && isWs(buf[i]!)) i += 1;
  if (i + 6 < n && buf[i] === 0x73 && buf[i + 1] === 0x74 && buf[i + 2] === 0x72 && buf[i + 3] === 0x65 && buf[i + 4] === 0x61 && buf[i + 5] === 0x6d && (buf[i + 6] === 0x0a || buf[i + 6] === 0x0d)) {
    return i + 7;
  }
  return -1;
}

/** 用原生 C++ `Buffer.indexOf('stream')` 找从 from 开始下一个紧跟在 `>>` + 空白后的真实 `stream` + CR/LF（排除 `endstream`） */
function findNextAnchoredStream(buf: Buffer, from: number): { streamIdx: number; closeEnd: number } | null {
  const n = buf.length;
  let p = from;
  let wsFloor = from;
  while (p < n) {
    const idx = buf.indexOf(STREAM_NEEDLE, p);
    if (idx === -1) return null;
    const after = idx + 6;
    if (after < n && (buf[after] === 0x0a || buf[after] === 0x0d) && !(idx >= 3 && buf[idx - 3] === 0x65 && buf[idx - 2] === 0x6e && buf[idx - 1] === 0x64)) {
      let end = idx - 1;
      while (end >= wsFloor && isWs(buf[end]!)) end -= 1;
      if (end >= wsFloor + 1 && buf[end] === 0x3e && buf[end - 1] === 0x3e) {
        return { streamIdx: idx, closeEnd: end + 1 };
      }
      wsFloor = after + 1;
    }
    p = after;
  }
  return null;
}

/**
 * 零堆增长 + 严格 O(buf.length) 单遍扫描一段字节里所有紧跟在 `>>` 后面的 `stream` 字典（Codex 代码与安全审查修复）：
 *   · 栈空时先用原生 C++ `Buffer.indexOf('stream')` 与 `Buffer.indexOf('<<')` 跳过不含流字典的整段区域（200 MB 重复 `<<` 或
 *     `>>stream\n`、以及流正文二进制数据均仅 ~110 ms、零堆分配），回看窗口锚定在 `stream` 前的 `>>`（跳过任意长度空白，
 *     与 `streamAfterDictClose` 语义完全一致）。
 *   · 预分配固定 128 KB `Int32Array(32768)` 环形队列存 `DICT_LOOKBACK`（32 KB）窗口内尚未配对的 `<<` 起点（窗口内最多 16385 个，
 *     永不溢出且零数组扩容），彻底杜绝 200 MB 重复 `<<` 的 33 MB 堆堆积与 20 秒卡顿。
 *   · 遇到 `>>` 时按 `opens` 栈顶起点保留 `(...)` 字面量字符串与 `%` 注释上下文，跳过字符串/注释内的假 `>>` / `>>stream\n`；
 *     遇到未闭合的前段二进制垃圾 `<<(` 时栈顶已被后续真实图像字典的 `<<` 覆盖，不依赖 `endstream` 边界也不会被 `/Comment (>>)`、
 *     `/Comment (endstream) % >>\n` 绕过。
 */
function scanBuffer(buf: Buffer, openRing: Int32Array, maxPixels: number, maxSide: number): PdfImageProblem | null {
  const n = buf.length;
  let openHead = 0;
  let openCount = 0;

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

  let nextStream = -1;
  let nextCloseEnd = -1;
  let nextOpen = -1;

  /** 栈空时用 SIMD 快进到下一个可能包含流字典的 `<<`（回看窗口锚定在 `>>` 闭合处）；没有更多流字典返回 n */
  const seekNextCandidate = (from: number): number => {
    let p = from;
    while (p < n - 1) {
      if (nextStream < p) {
        const hit = findNextAnchoredStream(buf, p);
        if (!hit) return n;
        nextStream = hit.streamIdx;
        nextCloseEnd = hit.closeEnd;
      }
      const winStart = Math.max(p, nextCloseEnd - DICT_LOOKBACK);
      if (nextOpen < winStart) {
        nextOpen = buf.indexOf(OPEN_DICT_NEEDLE, winStart);
        if (nextOpen === -1) return n;
      }
      if (nextOpen < nextCloseEnd) return nextOpen;
      // [winStart, nextCloseEnd) 内没有任何 `<<`，且 `<<` 本身不是空白，因此 `nextOpen` 之前不可能再有含 `<<` 的 `>>` + 空白 + `stream`
      p = Math.max(nextStream + 7, nextOpen);
    }
    return n;
  };

  let i = seekNextCandidate(0);
  while (i < n - 1) {
    if (i > nextStream) {
      const hit = findNextAnchoredStream(buf, i);
      if (!hit) break;
      nextStream = hit.streamIdx;
      nextCloseEnd = hit.closeEnd;
      if (nextCloseEnd - DICT_LOOKBACK > i) {
        openHead = 0;
        openCount = 0;
        resetSyntax();
        i = seekNextCandidate(nextCloseEnd - DICT_LOOKBACK);
        continue;
      }
    }
    const c = buf[i]!;
    if (c === 0x3c && buf[i + 1] === 0x3c) {
      while (openCount > 0 && i - openRing[openHead]! > DICT_LOOKBACK) {
        openHead = (openHead + 1) & OPEN_RING_MASK;
        openCount -= 1;
      }
      openRing[(openHead + openCount) & OPEN_RING_MASK] = i;
      openCount += 1;
      i += 2;
      continue;
    }
    if (c === 0x3e && buf[i + 1] === 0x3e) {
      while (openCount > 0 && i + 2 - openRing[openHead]! > DICT_LOOKBACK) {
        openHead = (openHead + 1) & OPEN_RING_MASK;
        openCount -= 1;
      }
      if (openCount === 0) {
        resetSyntax();
        const afterStream = streamAfterDictClose(buf, i + 2);
        i = seekNextCandidate(afterStream >= 0 ? afterStream : i + 2);
        continue;
      }
      const start = openRing[(openHead + openCount - 1) & OPEN_RING_MASK]!;
      if (inStringOrCommentAt(start, i)) {
        const limit = Math.min(n, start + DICT_LOOKBACK);
        const resumed = skipOutOfStringOrComment(limit);
        if (synParens === 0 && !synComment) {
          i = resumed;
          continue;
        }
        // 字符串/注释超长未闭合：放弃这个起点，避免卡死
        openCount -= 1;
        resetSyntax();
        i = openCount === 0 ? seekNextCandidate(i + 2) : i + 2;
        continue;
      }
      const afterStream = streamAfterDictClose(buf, i + 2);
      if (afterStream < 0) {
        openCount -= 1;
        resetSyntax();
        i = openCount === 0 ? seekNextCandidate(i + 2) : i + 2;
        continue;
      }
      // 真实流字典：清空栈、零分配解析并快进到下一个流字典候选区
      openHead = 0;
      openCount = 0;
      resetSyntax();
      const problem = checkTopDictProblem(buf, start, i + 2, maxPixels, maxSide);
      if (problem) return problem;
      i = seekNextCandidate(afterStream);
      continue;
    }
    i += 1;
  }
  return null;
}

/** 分块流式扫描器：每次 push 一块（3 MB），只保留少量跨块尾部字节与固定 128 KB 环形缓冲 */
export function createPdfImageScanner(limits: PdfImageLimits = {}) {
  const maxPixels = limits.maxPixels ?? TRAINING_PDF_MAX_IMAGE_PIXELS;
  const maxSide = limits.maxSide ?? TRAINING_PDF_MAX_IMAGE_SIDE;
  const openRing = new Int32Array(OPEN_RING_CAP);
  let tail = Buffer.alloc(0);
  let problem: PdfImageProblem | null = null;
  return {
    push(chunk: Buffer) {
      if (problem || !chunk.length) return;
      const combined = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      problem = scanBuffer(combined, openRing, maxPixels, maxSide);
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
