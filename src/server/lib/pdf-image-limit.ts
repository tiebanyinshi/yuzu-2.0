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

const STREAM_NEEDLE = Buffer.from('stream', 'ascii');
const OPEN_DICT_NEEDLE = Buffer.from('<<', 'ascii');

/** 检查从 pos 开始（跳过空白后）是否紧跟 PDF 流关键字 `stream` + CR/LF */
function isFollowedByStream(buf: Buffer, pos: number): boolean {
  const n = buf.length;
  let i = pos;
  while (i < n && isWs(buf[i]!)) i += 1;
  if (i + 6 >= n) return false;
  if (buf[i] !== 0x73 || buf[i + 1] !== 0x74 || buf[i + 2] !== 0x72 || buf[i + 3] !== 0x65 || buf[i + 4] !== 0x61 || buf[i + 5] !== 0x6d) {
    return false;
  }
  const after = buf[i + 6]!;
  return after === 0x0a || after === 0x0d;
}

interface ParsedDictResult {
  isImage: boolean;
  width: number | null;
  height: number | null;
  depth: number;
  unclosed: 'none' | 'string' | 'comment';
  crossedSoftEnd: boolean;
  endPos: number;
}

const isCandidateKeyStart = (c: number) => c === 0x53 || c === 0x49 || c === 0x42 || c === 0x57 || c === 0x48 || c === 0x23;

function skipTokenEnd(buf: Buffer, i: number, stop: number): number {
  while (i < stop && !isDelim(buf[i]!)) i += 1;
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

function skipWsAndCommentsBuf(buf: Buffer, i: number, stop: number, softEnd: number, out: ParsedDictResult): number {
  while (i < stop) {
    const c = buf[i]!;
    if (isWs(c)) {
      i += 1;
    } else if (c === 0x25) {
      const startedBeforeSoft = i < softEnd;
      while (i < stop && buf[i] !== 0x0a && buf[i] !== 0x0d) i += 1;
      if (startedBeforeSoft && i >= softEnd) out.crossedSoftEnd = true;
      if (i >= stop && (i >= buf.length || (buf[i] !== 0x0a && buf[i] !== 0x0d))) {
        out.unclosed = 'comment';
      }
    } else {
      break;
    }
  }
  return i;
}

/**
 * 直接在 Buffer 上词法解析 `[start, softEnd)` 内的顶层字典（零闭包、零字符串/对象分配）：
 * - 遇到新的顶层 `<<`（depth === 0）时清掉前一个非流对象的键，防跨对象串味；
 * - 若抵达 `softEnd` 时仍处于未闭合字符串/注释或嵌套字典（depth > 0），继续向后单趟读完当前顶层字典（最多至 `hardEnd`），
 *   避免同一个字典里的多个 `(>>stream\n)` 诱饵触发重复回扫。
 */
function parseDictRange(buf: Buffer, start: number, softEnd: number, hardEnd: number, out: ParsedDictResult): ParsedDictResult {
  let i = start;
  let limit = Math.max(softEnd, hardEnd);
  let depth = 0;
  let isImage = false;
  let width: number | null = null;
  let height: number | null = null;
  out.unclosed = 'none';
  out.crossedSoftEnd = false;

  while (i < softEnd || (depth > 0 && i < limit)) {
    if (i >= softEnd && depth > 0) out.crossedSoftEnd = true;
    const stop = depth > 0 ? limit : softEnd;
    i = skipWsAndCommentsBuf(buf, i, stop, softEnd, out);
    if (i >= stop) break;
    const c = buf[i]!;
    if (c === 0x3c && i + 1 < stop && buf[i + 1] === 0x3c) {
      if (depth === 0) {
        isImage = false;
        width = null;
        height = null;
        limit = Math.min(hardEnd, Math.max(softEnd, i + DICT_LOOKBACK));
      }
      depth += 1;
      i += 2;
      continue;
    }
    if (c === 0x3e && i + 1 < stop && buf[i + 1] === 0x3e) {
      if (depth > 0) depth -= 1;
      i += 2;
      if (depth === 0 && i >= softEnd) break;
      continue;
    }
    if (c === 0x28) {
      const startedBeforeSoft = i < softEnd;
      let parens = 1;
      i += 1;
      while (i < stop && parens > 0) {
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
      if (i > stop) i = stop;
      if (startedBeforeSoft && (i > softEnd || (i === softEnd && parens > 0))) out.crossedSoftEnd = true;
      if (parens > 0) {
        out.unclosed = 'string';
        break;
      }
      continue;
    }
    if (c === 0x3c) {
      i += 1;
      while (i < stop && buf[i] !== 0x3e) i += 1;
      if (i < stop) i += 1;
      continue;
    }
    if (c === 0x5b || c === 0x5d) {
      i += 1;
      continue;
    }
    if (c === 0x2f) {
      const s = i;
      i = skipTokenEnd(buf, i + 1, stop);
      if (depth !== 1 || i <= s + 1 || !isCandidateKeyStart(buf[s + 1]!)) continue;
      const name = decodePdfName(buf.toString('latin1', s, i));
      if (name === '/Subtype') {
        i = skipWsAndCommentsBuf(buf, i, stop, softEnd, out);
        if (i < stop && buf[i] === 0x2f) {
          const vs = i;
          i = skipTokenEnd(buf, i + 1, stop);
          if (decodePdfName(buf.toString('latin1', vs, i)) === '/Image') isImage = true;
        }
      } else if (name === '/ImageMask' || name === '/IM') {
        i = skipWsAndCommentsBuf(buf, i, stop, softEnd, out);
        const ts = i;
        i = skipTokenEnd(buf, i, stop);
        if (i - ts === 4 && buf[ts] === 0x74 && buf[ts + 1] === 0x72 && buf[ts + 2] === 0x75 && buf[ts + 3] === 0x65) {
          isImage = true;
        }
      } else if (name === '/BitsPerComponent' || name === '/BPC') {
        isImage = true;
      } else if (name === '/Width' || name === '/W' || name === '/Height' || name === '/H') {
        i = skipWsAndCommentsBuf(buf, i, stop, softEnd, out);
        if (i < stop) {
          const saved = i;
          const e1 = skipTokenEnd(buf, i, stop);
          const val = parseDigitsBuf(buf, saved, e1);
          if (val !== null) {
            let p = skipWsAndCommentsBuf(buf, e1, stop, softEnd, out);
            const s2 = p;
            p = skipTokenEnd(buf, p, stop);
            let indirect = false;
            if (isAllDigitsBuf(buf, s2, p)) {
              p = skipWsAndCommentsBuf(buf, p, stop, softEnd, out);
              const s3 = p;
              p = skipTokenEnd(buf, p, stop);
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
    const next = skipTokenEnd(buf, i, stop);
    i = next === i ? i + 1 : next;
  }

  out.isImage = isImage;
  out.width = width;
  out.height = height;
  out.depth = depth;
  out.endPos = i;
  return out;
}

function imageProblemOf(parsed: { isImage: boolean; width: number | null; height: number | null }, maxPixels: number, maxSide: number): PdfImageProblem | null {
  if (!parsed.isImage || parsed.width === null || parsed.height === null) return null;
  if (parsed.width > maxSide || parsed.height > maxSide || parsed.width * parsed.height > maxPixels) {
    return { width: parsed.width, height: parsed.height };
  }
  return null;
}

/** 在 [floor, endExclusive) 里从后往前找与最末尾 `>>` 配平的最近一个 `<<`（用于前一段二进制流含孤立 `<<(` 时的兜底） */
function findInnerBalancedOpen(buf: Buffer, floor: number, endExclusive: number): number {
  let depth = 0;
  let j = endExclusive - 2;
  while (j >= floor) {
    if (buf[j] === 0x3e && buf[j + 1] === 0x3e) {
      depth += 1;
      j -= 2;
      continue;
    }
    if (buf[j] === 0x3c && buf[j + 1] === 0x3c) {
      depth -= 1;
      if (depth === 0) return j;
      j -= 2;
      continue;
    }
    j -= 1;
  }
  return -1;
}

function makeParsedSlot(): ParsedDictResult {
  return { isImage: false, width: null, height: null, depth: 0, unclosed: 'none', crossedSoftEnd: false, endPos: 0 };
}

/**
 * 兜底单趟线性扫描（仅在极端对抗输入耗尽快路径预算时触发，严格 O(n) 时间 + O(1) 堆内存）：
 * 顺序扫描剩余字节，完整保留字符串/注释与字典深度，同时在单段字符串超过 DICT_LOOKBACK 未闭合时重置状态并做内层配平核对。
 */
function scanBufferLinearFallback(buf: Buffer, startPos: number, maxPixels: number, maxSide: number): PdfImageProblem | null {
  const n = buf.length;
  let i = startPos;
  let depth = 0;
  let isImage = false;
  let width: number | null = null;
  let height: number | null = null;
  let inString = false;
  let parens = 0;
  let stringStart = 0;
  let lastInnerEnd = startPos;
  const innerSlot = makeParsedSlot();

  while (i < n) {
    if (inString) {
      const c = buf[i]!;
      if (c === 0x5c) {
        i += 2;
      } else if (c === 0x28) {
        parens += 1;
        i += 1;
      } else if (c === 0x29) {
        parens -= 1;
        i += 1;
        if (parens === 0) inString = false;
      } else if (c === 0x3e && i + 1 < n && buf[i + 1] === 0x3e && isFollowedByStream(buf, i + 2)) {
        const endExclusive = i + 2;
        const floor = Math.max(lastInnerEnd, endExclusive - DICT_LOOKBACK);
        lastInnerEnd = endExclusive;
        const innerOpen = findInnerBalancedOpen(buf, floor, endExclusive);
        if (innerOpen >= 0) {
          const problem = imageProblemOf(parseDictRange(buf, innerOpen, endExclusive, endExclusive, innerSlot), maxPixels, maxSide);
          if (problem) return problem;
        }
        i += 2;
      } else {
        i += 1;
      }
      if (inString && i - stringStart > DICT_LOOKBACK) {
        // 超过最大字典回看窗口仍未闭合，说明前文是二进制垃圾里的孤立 `(`，复位继续扫描
        inString = false;
        parens = 0;
        depth = 0;
      }
      continue;
    }

    const c = buf[i]!;
    if (c === 0x25) {
      while (i < n && buf[i] !== 0x0a && buf[i] !== 0x0d) i += 1;
      continue;
    }
    if (c === 0x28) {
      if (depth > 0) {
        inString = true;
        parens = 1;
        stringStart = i;
      }
      i += 1;
      continue;
    }
    if (c === 0x3c && i + 1 < n && buf[i + 1] === 0x3c) {
      if (depth === 0) {
        isImage = false;
        width = null;
        height = null;
      }
      depth += 1;
      i += 2;
      continue;
    }
    if (c === 0x3e && i + 1 < n && buf[i + 1] === 0x3e) {
      if (depth > 0) depth -= 1;
      i += 2;
      if (depth === 0 && isFollowedByStream(buf, i)) {
        if (isImage && width !== null && height !== null && (width > maxSide || height > maxSide || width * height > maxPixels)) {
          return { width, height };
        }
        lastInnerEnd = Math.max(lastInnerEnd, i);
      }
      continue;
    }
    if (c === 0x2f && depth === 1) {
      const s = i;
      i = skipTokenEnd(buf, i + 1, n);
      if (i <= s + 1 || !isCandidateKeyStart(buf[s + 1]!)) continue;
      const name = decodePdfName(buf.toString('latin1', s, i));
      if (
        name === '/Subtype' ||
        name === '/ImageMask' ||
        name === '/IM' ||
        name === '/BitsPerComponent' ||
        name === '/BPC' ||
        name === '/Width' ||
        name === '/W' ||
        name === '/Height' ||
        name === '/H'
      ) {
        while (i < n && (isWs(buf[i]!) || buf[i] === 0x25)) {
          if (buf[i] === 0x25) {
            while (i < n && buf[i] !== 0x0a && buf[i] !== 0x0d) i += 1;
          } else {
            i += 1;
          }
        }
        if (name === '/BitsPerComponent' || name === '/BPC') {
          isImage = true;
        } else if (name === '/Subtype' && i < n && buf[i] === 0x2f) {
          const vs = i;
          i = skipTokenEnd(buf, i + 1, n);
          if (decodePdfName(buf.toString('latin1', vs, i)) === '/Image') isImage = true;
        } else if (name === '/ImageMask' || name === '/IM') {
          const vs = i;
          i = skipTokenEnd(buf, i, n);
          if (i - vs === 4 && buf[vs] === 0x74 && buf[vs + 1] === 0x72 && buf[vs + 2] === 0x75 && buf[vs + 3] === 0x65) isImage = true;
        } else if (name === '/Width' || name === '/W' || name === '/Height' || name === '/H') {
          const vs = i;
          i = skipTokenEnd(buf, i, n);
          const val = parseDigitsBuf(buf, vs, i);
          if (val !== null) {
            const afterFirst = i;
            let p = i;
            while (p < n && isWs(buf[p]!)) p += 1;
            const s2 = p;
            while (p < n && buf[p]! >= 0x30 && buf[p]! <= 0x39) p += 1;
            let indirect = false;
            if (p > s2) {
              while (p < n && isWs(buf[p]!)) p += 1;
              if (p < n && buf[p] === 0x52 && (p + 1 >= n || isDelim(buf[p + 1]!))) indirect = true;
            }
            i = afterFirst;
            if (!indirect) {
              if (name === '/Width' || name === '/W') width = val;
              else height = val;
            }
          }
        }
      }
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * 零堆分配 + 严格 O(n) 上界扫描一段字节里所有紧跟在 `>>` 后面的 `stream` 字典（Codex 代码与安全审查修复）：
 *   · 先用原生 C++ `Buffer.indexOf('<<')` / `Buffer.indexOf('stream')` 快速跳过不含成对标记的字节
 *     （200 MB 重复 `<<` ~110 ms，200 MB 重复 `>>stream\n` ~110 ms，均零数组分配）。
 *   · 找到 `>>` + 空白 + `stream` + CR/LF 后，从 `[max(0, end - DICT_LOOKBACK, noOpenBefore), end)` 内最早的 `<<` 正向直接在 Buffer 上解析，
 *     完整保留外层 `(...)` 字符串与 `%` 注释上下文（防 `/Comment (>><< >>stream\n)` 绕过）；若跨越 `end` 仍在外层字典内，
 *     单趟继续读完外层字典并同步用内层配平字典兜底，避免多个诱饵触发重复扫描。
 *   · 若对抗输入（如大量未闭合 `<<(>>stream\n`）使快路径扫描字节超过 `2 * n`，自动切到严格 O(n) / O(1) 内存单趟线性兜底。
 */
function scanBuffer(buf: Buffer, maxPixels: number, maxSide: number): PdfImageProblem | null {
  const n = buf.length;
  let nextOpen = buf.indexOf(OPEN_DICT_NEEDLE, 0);
  if (nextOpen === -1) return null;

  const maxWork = Math.max(DICT_LOOKBACK * 4, n * 2);
  let work = 0;
  let pos = 0;
  let noOpenBefore = 0;
  let lastInnerEnd = 0;
  const parsed = makeParsedSlot();
  const innerParsed = makeParsedSlot();

  while (pos < n) {
    const idx = buf.indexOf(STREAM_NEEDLE, pos);
    if (idx === -1) break;
    pos = idx + STREAM_NEEDLE.length;
    // 排除 endstream，且 stream 后面必须是 CR/LF（PDF 规范 §7.3.8.1）
    if (idx >= 3 && buf[idx - 3] === 0x65 && buf[idx - 2] === 0x6e && buf[idx - 1] === 0x64) continue;
    const after = idx + STREAM_NEEDLE.length;
    if (after >= n || (buf[after] !== 0x0a && buf[after] !== 0x0d)) continue;
    // 跳过 stream 前面的空白，紧挨着的必须是 `>>`
    let end = idx - 1;
    while (end >= 0 && isWs(buf[end]!)) end -= 1;
    if (end < 1 || buf[end] !== 0x3e || buf[end - 1] !== 0x3e) continue;

    const endExclusive = end + 1;
    const floor = Math.max(0, endExclusive - DICT_LOOKBACK, noOpenBefore);
    if (nextOpen < floor) {
      nextOpen = buf.indexOf(OPEN_DICT_NEEDLE, floor);
      if (nextOpen === -1) break;
    }
    if (nextOpen >= endExclusive) {
      noOpenBefore = endExclusive;
      pos = Math.max(pos, nextOpen + 2);
      continue;
    }

    const earliestOpen = nextOpen;
    if (earliestOpen + 2 >= endExclusive - 2) {
      noOpenBefore = endExclusive;
      continue;
    }
    const hardEnd = Math.min(n, Math.max(endExclusive, earliestOpen + DICT_LOOKBACK * 2));
    parseDictRange(buf, earliestOpen, endExclusive, hardEnd, parsed);
    work += Math.max(1, parsed.endPos - earliestOpen);

    if (!parsed.crossedSoftEnd && parsed.unclosed === 'none') {
      noOpenBefore = endExclusive;
      const problem = imageProblemOf(parsed, maxPixels, maxSide);
      if (problem) return problem;
      continue;
    }

    // 兜底：若前一个二进制流里出现孤立 `<<(` 造成外层未闭合，检查内层配平字典是否已是超限图像（按单调下界避免重复回扫）
    const innerFloor = Math.max(earliestOpen + 2, lastInnerEnd);
    lastInnerEnd = Math.max(lastInnerEnd, endExclusive);
    const innerOpen = findInnerBalancedOpen(buf, innerFloor, endExclusive);
    if (innerOpen >= 0) {
      work += endExclusive - innerOpen;
      parseDictRange(buf, innerOpen, endExclusive, endExclusive, innerParsed);
      const innerProblem = imageProblemOf(innerParsed, maxPixels, maxSide);
      if (innerProblem) return innerProblem;
    }

    if (parsed.unclosed === 'none' && parsed.depth === 0) {
      if (isFollowedByStream(buf, parsed.endPos)) {
        const problem = imageProblemOf(parsed, maxPixels, maxSide);
        if (problem) return problem;
      }
      noOpenBefore = Math.max(noOpenBefore, parsed.endPos);
      pos = Math.max(pos, parsed.endPos);
      continue;
    }

    noOpenBefore = endExclusive;
    if (work >= maxWork) {
      return scanBufferLinearFallback(buf, endExclusive, maxPixels, maxSide);
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
