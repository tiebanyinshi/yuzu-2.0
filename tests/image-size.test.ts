// 从图片文件开头读宽高（src/server/lib/image-size.ts）：员工培训用它拦下像素数过大的图片（Codex 安全审查 9b1dd16）。
import { describe, expect, it } from 'vitest';
import { imageSize } from '../src/server/lib/image-size';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngHead(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([PNG_SIG, ihdr]);
}

describe('imageSize', () => {
  it('PNG', () => expect(imageSize('image/png', pngHead(12000, 12000))).toEqual({ width: 12000, height: 12000 }));
  it('GIF', () => {
    const b = Buffer.from('GIF89a\x00\x00\x00\x00', 'latin1');
    b.writeUInt16LE(640, 6);
    b.writeUInt16LE(480, 8);
    expect(imageSize('image/gif', b)).toEqual({ width: 640, height: 480 });
  });
  it('WebP（VP8X）', () => {
    const b = Buffer.alloc(30);
    b.write('RIFF', 0, 'ascii');
    b.write('WEBP', 8, 'ascii');
    b.write('VP8X', 12, 'ascii');
    b.writeUIntLE(1999, 24, 3);
    b.writeUIntLE(999, 27, 3);
    expect(imageSize('image/webp', b)).toEqual({ width: 2000, height: 1000 });
  });
  it('JPEG：跳过 APP 段找到帧头', () => {
    const app = Buffer.from([0xff, 0xe1, 0x00, 0x06, 1, 2, 3, 4]);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageSize('image/jpeg', Buffer.concat([Buffer.from([0xff, 0xd8]), app, sof]))).toEqual({ width: 640, height: 480 });
  });
  it('读不出的返回 null', () => {
    expect(imageSize('image/png', Buffer.from('not a png'))).toBeNull();
    expect(imageSize('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
    expect(imageSize('application/pdf', pngHead(1, 1))).toBeNull();
  });
});
