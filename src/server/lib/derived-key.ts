// 由一个种子算出固定的操作编号（UUID 的样子）：同一笔里要连带写的几行（例如自动折扣）各要一个编号，原样重提时还是同一个。
import { createHash } from 'node:crypto';

export function derivedKey(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
