// 二维码（饭卡码用，员工小程序线 E）：在手机上离线生成，不联网、不靠插件。
// 饭卡码是大写字母、数字与冒号，用字母数字模式（码更小、扫得更快）；别的文字用字节模式。纠错等级 M，版本 1–3（单个数据块）。
// 按 ISO/IEC 18004 生成：数据位 → 补齐 → 里德-所罗门纠错码 → 功能图形 → 之字形摆放 → 8 种掩模里挑扣分最少的 → 格式信息。
// tests/qr.test.ts 用独立的解码器（jsQR）把生成的码读回来核对。

export interface QrMatrix {
  size: number;
  /** modules[y][x]，true 为深色 */
  modules: boolean[][];
}

interface Version {
  version: number;
  dataCodewords: number;
  ecCodewords: number;
  align: number[];
}

// 纠错等级 M、单个数据块
const VERSIONS: Version[] = [
  { version: 1, dataCodewords: 16, ecCodewords: 10, align: [] },
  { version: 2, dataCodewords: 28, ecCodewords: 16, align: [6, 18] },
  { version: 3, dataCodewords: 44, ecCodewords: 26, align: [6, 22] },
];

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const r: number[] = [];
  for (let i = 0; i < degree - 1; i++) r.push(0);
  r.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j]!, root);
      if (j + 1 < r.length) r[j] = r[j]! ^ r[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const r = divisor.map(() => 0);
  for (let k = 0; k < data.length; k++) {
    const factor = data[k]! ^ (r.shift() as number);
    r.push(0);
    for (let i = 0; i < divisor.length; i++) r[i] = r[i]! ^ gfMul(divisor[i]!, factor);
  }
  return r;
}

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** 文字转成数据位：全是字母数字模式认的字就用它，不然用字节模式（UTF-8） */
function dataBits(text: string): number[] {
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  let alnum = text.length > 0;
  for (let i = 0; i < text.length; i++) if (ALNUM.indexOf(text.charAt(i)) < 0) alnum = false;
  if (alnum) {
    push(0b0010, 4);
    push(text.length, 9);
    for (let i = 0; i < text.length; i += 2) {
      const a = ALNUM.indexOf(text.charAt(i));
      if (i + 1 < text.length) push(a * 45 + ALNUM.indexOf(text.charAt(i + 1)), 11);
      else push(a, 6);
    }
    return bits;
  }
  const bytes = utf8(text);
  push(0b0100, 4);
  push(bytes.length, 8);
  for (let i = 0; i < bytes.length; i++) push(bytes[i]!, 8);
  return bits;
}

function utf8(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00);
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** 编码一段文字；放不下（超过版本 3）时报错 */
export function encodeText(text: string): QrMatrix {
  const bits = dataBits(text);
  let v: Version | undefined;
  for (const c of VERSIONS) {
    if (bits.length <= c.dataCodewords * 8) {
      v = c;
      break;
    }
  }
  if (!v) throw new Error('文字太长，二维码放不下');
  const capacity = v.dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    data.push(b);
  }
  for (let pad = 0xec; data.length < v.dataCodewords; pad ^= 0xec ^ 0x11) data.push(pad);
  const codewords = data.concat(rsRemainder(data, rsDivisor(v.ecCodewords)));

  const size = 17 + 4 * v.version;
  const modules: boolean[][] = [];
  const fixed: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    modules.push(new Array<boolean>(size).fill(false));
    fixed.push(new Array<boolean>(size).fill(false));
  }
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    fixed[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const a = v.align;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === a.length - 1) || (i === a.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(a[i]! + dx, a[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // 纠错等级 M 的格式位是 00
  const drawFormat = (mask: number) => {
    const fdata = mask;
    let rem = fdata;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fbits = ((fdata << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((fbits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);

  let k = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y]![x] && k < total) {
          modules[y]![x] = ((codewords[k >>> 3]! >>> (7 - (k & 7))) & 1) !== 0;
          k++;
        }
      }
    }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y]![x] && maskHit(mask, x, y)) modules[y]![x] = !modules[y]![x];
  };
  let best = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const p = penalty(modules, size);
    if (p < bestPenalty) {
      best = mask;
      bestPenalty = p;
    }
    applyMask(mask);
  }
  applyMask(best);
  drawFormat(best);
  return { size, modules };
}

const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
];

function penalty(m: boolean[][], size: number): number {
  let p = 0;
  const at = (x: number, y: number, row: boolean) => (row ? m[y]![x]! : m[x]![y]!);
  for (const row of [true, false]) {
    for (let y = 0; y < size; y++) {
      let run = 1;
      for (let x = 1; x <= size; x++) {
        if (x < size && at(x, y, row) === at(x - 1, y, row)) run++;
        else {
          if (run >= 5) p += 3 + (run - 5);
          run = 1;
        }
      }
      for (let x = 0; x + 11 <= size; x++) {
        for (const pat of FINDER_LIKE) {
          let hit = true;
          for (let i = 0; i < 11 && hit; i++) hit = at(x + i, y, row) === pat[i];
          if (hit) p += 40;
        }
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y]![x]) dark++;
      if (x + 1 < size && y + 1 < size) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) p += 3;
      }
    }
  }
  const total = size * size;
  p += Math.floor(Math.abs(dark * 100 - total * 50) / (total * 5)) * 10;
  return p;
}

/** 画二维码需要的最少的画布操作（微信的 canvas 2d 与测试里的假画布都满足） */
export interface QrCanvas {
  fillStyle: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/** 在 0,0 到 px,px 的正方形里画（四周留 4 格空白，扫码才好认）；颜色由页面传（墨色、白底） */
export function drawQr(ctx: QrCanvas, qr: QrMatrix, px: number, dark: string, light: string): void {
  const cells = qr.size + 8;
  const cell = px / cells;
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = dark;
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y]![x]) ctx.fillRect((x + 4) * cell, (y + 4) * cell, cell + 0.5, cell + 0.5);
    }
  }
}
