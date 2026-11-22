// 授权的品牌字体（8.1.5，docs/EMENU.md 第 14.2 节，PENDING_DECISIONS.md PP4）：英文 ABC Arizona Flare 是商业字体，
// 授权的文件不进 Git（代码库是公开的）、不进镜像，由门店把文件放在服务器的 brand-fonts 目录里（config.brandFontPath）。
// 只认固定的几个文件名，不按请求里的路径找文件；按文件头认格式，放错了文件当没放。
// 店主 2026-11-22（PD6）：授权包里给的不一定是 WOFF2——en.woff2、en.woff、en.otf、en.ttf 都认（按这个顺序取第一个能用的）；
// 字体里写着「Unlicensed Trial」的是 Dinamo 的试用版（条款不许放在服务器上、不许分发），放了也不发，后台写明原因。

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrandFontStatus } from '@shared/emenu-brand-font';

const CANDIDATES = [
  { name: 'en.woff2', mime: 'font/woff2', magic: (b: Buffer) => b.subarray(0, 4).toString('latin1') === 'wOF2' },
  { name: 'en.woff', mime: 'font/woff', magic: (b: Buffer) => b.subarray(0, 4).toString('latin1') === 'wOFF' },
  { name: 'en.otf', mime: 'font/otf', magic: (b: Buffer) => b.subarray(0, 4).toString('latin1') === 'OTTO' || isTrueType(b) },
  { name: 'en.ttf', mime: 'font/ttf', magic: (b: Buffer) => isTrueType(b) || b.subarray(0, 4).toString('latin1') === 'OTTO' },
] as const;
const isTrueType = (b: Buffer) => b.readUInt32BE(0) === 0x00010000 || b.subarray(0, 4).toString('latin1') === 'true';
/** 网页字体一般几十到几百 KB，桌面版的可变字体一两 MB；大于这个的不发 */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * 试用版：字体的名称表里写着「Unlicensed Trial」（Dinamo 的试用文件都这样，TTF / OTF 的名称表是 UTF-16BE）。
 * WOFF / WOFF2 是压缩过的，看不到名称表——那是网页授权包的格式，不查
 */
function isTrial(data: Buffer): boolean {
  const marker = 'Unlicensed Trial';
  if (data.includes(Buffer.from(marker, 'latin1'))) return true;
  return data.includes(Buffer.from(marker, 'utf16le').swap16());
}

interface Found {
  name: string;
  mime: string;
  data: Buffer;
  size: number;
  mtimeMs: number;
  problem: 'invalid' | 'trial' | 'too_large' | null;
}

async function inspect(dir: string): Promise<Found[]> {
  const found: Found[] = [];
  for (const c of CANDIDATES) {
    try {
      const info = await stat(join(dir, c.name));
      if (!info.isFile()) continue;
      if (info.size > MAX_BYTES) {
        found.push({ name: c.name, mime: c.mime, data: Buffer.alloc(0), size: info.size, mtimeMs: info.mtimeMs, problem: 'too_large' });
        continue;
      }
      const data = await readFile(join(dir, c.name));
      const problem = data.length < 12 || !c.magic(data) ? 'invalid' : isTrial(data) ? 'trial' : null;
      found.push({ name: c.name, mime: c.mime, data, size: info.size, mtimeMs: info.mtimeMs, problem });
    } catch {
      // 没有这个文件
    }
  }
  return found;
}

/** 发给平板的那一个：按 en.woff2 → en.woff → en.otf → en.ttf 取第一个能用的；都不能用为 null（页面用顶替的字体） */
export async function readBrandFont(dir: string): Promise<{ data: Buffer; etag: string; mime: string } | null> {
  const ok = (await inspect(dir)).find((f) => f.problem === null);
  if (!ok) return null;
  return { data: ok.data, mime: ok.mime, etag: `"${ok.name}-${ok.size.toString(16)}-${Math.floor(ok.mtimeMs).toString(16)}"` };
}

/** 后台「电子菜单」上的状态：品牌字体生效了没有，没有的话为什么 */
export async function brandFontStatus(dir: string): Promise<BrandFontStatus> {
  const found = await inspect(dir);
  const ok = found.find((f) => f.problem === null);
  const files = found.map((f) => ({ name: f.name, size: f.size, updatedAt: new Date(f.mtimeMs).toISOString(), problem: f.problem }));
  if (ok) return { state: 'active', file: ok.name, files };
  if (found.some((f) => f.problem === 'trial')) return { state: 'trial', file: null, files };
  if (found.length) return { state: 'invalid', file: null, files };
  return { state: 'missing', file: null, files };
}
