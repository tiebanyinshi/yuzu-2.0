// 从图片文件开头读出宽高（不解码图片）：PNG、GIF、WebP、JPEG。读不出返回 null。
// 员工培训用它在登记前拦下像素数过大的图片（Codex 安全审查 9b1dd16：几百 KB 的 PNG 可以写成 12000 × 12000，浏览器一打开就要几百 MB 内存）。

export interface ImageSize {
  width: number;
  height: number;
}

const ok = (width: number, height: number): ImageSize | null => (width > 0 && height > 0 ? { width, height } : null);

function png(b: Buffer): ImageSize | null {
  if (b.length < 24 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return ok(b.readUInt32BE(16), b.readUInt32BE(20));
}

function gif(b: Buffer): ImageSize | null {
  if (b.length < 10) return null;
  return ok(b.readUInt16LE(6), b.readUInt16LE(8));
}

function webp(b: Buffer): ImageSize | null {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return ok(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return ok(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
  }
  if (kind === 'VP8 ') return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  return null;
}

/** JPEG：顺着段往后找第一个 SOF（帧头）里的宽高 */
function jpeg(b: Buffer): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // 没有长度的段：RST0–7、SOI、EOI、TEM
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0–SOF15，除了 DHT(C4)、JPG(C8)、DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
    i += 2 + len;
  }
  return null;
}

export function imageSize(mime: string, head: Buffer): ImageSize | null {
  switch (mime) {
    case 'image/png':
      return png(head);
    case 'image/gif':
      return gif(head);
    case 'image/webp':
      return webp(head);
    case 'image/jpeg':
      return jpeg(head);
    default:
      return null;
  }
}
