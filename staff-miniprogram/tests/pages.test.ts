// 页面的完整性与写法约定（不开微信开发者工具也能查的部分；docs/STAFF_MP.md 第 4 节与第 13.1 节的核对清单）：
//   · app.json 里的页面四个文件齐全；页面上绑的事件在页面代码里有；组件四个文件齐全；
//   · 标签栏图标存在且不超过 40KB；页面用到的本地图片都在、是 PNG、每张不超过 60KB；
//   · 开发者工具的 TypeScript 认得的写法：不用 import { a, type B }、不用数字分隔符；
//   · 样式：不用 flex 的 gap（老 iOS 不认）、不写 transition: all、页面与组件的样式里不写十六进制颜色（只用 app.wxss 的令牌）；
//   · sitemap 全部不收录；只声明要用的隐私接口（getLocation）。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const app = JSON.parse(readFileSync(join(SRC, 'app.json'), 'utf8')) as {
  pages: string[];
  tabBar: { list: { pagePath: string; iconPath: string; selectedIconPath: string }[] };
  usingComponents: Record<string, string>;
  requiredPrivateInfos?: string[];
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f: string) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(SRC);
const read = (p: string) => readFileSync(p, 'utf8');

describe('页面与组件', () => {
  it('每个页面都有 .ts .wxml .wxss .json', () => {
    for (const page of app.pages) for (const ext of ['ts', 'wxml', 'wxss', 'json']) expect(existsSync(join(SRC, `${page}.${ext}`)), `${page}.${ext}`).toBe(true);
  });

  it('全局组件四个文件齐全', () => {
    for (const c of Object.values(app.usingComponents)) for (const ext of ['ts', 'wxml', 'wxss', 'json']) expect(existsSync(join(SRC, `${c}.${ext}`)), `${c}.${ext}`).toBe(true);
  });

  it('页面与组件上绑的事件，代码里都有这个方法', () => {
    const units = [...app.pages, ...Object.values(app.usingComponents).map((c) => c.replace(/^\//, ''))];
    for (const u of units) {
      const wxml = read(join(SRC, `${u}.wxml`));
      const ts = read(join(SRC, `${u}.ts`));
      const handlers = [...wxml.matchAll(/\b(?:bind|catch)[a-z]+="([A-Za-z_]\w*)"/g)].map((m) => m[1]!);
      for (const h of handlers) expect(new RegExp(`\\b${h}\\s*\\(`).test(ts), `${u}: ${h}`).toBe(true);
    }
  });

  it('标签栏页面在 pages 里，图标存在且不超过 40KB', () => {
    for (const t of app.tabBar.list) {
      expect(app.pages).toContain(t.pagePath);
      for (const icon of [t.iconPath, t.selectedIconPath]) {
        const p = join(SRC, icon);
        expect(existsSync(p), icon).toBe(true);
        expect(statSync(p).size).toBeLessThan(40 * 1024);
      }
    }
  });

  it('用到的本地图片都在、是 PNG、每张不超过 60KB', () => {
    const wxml = files.filter((f) => f.endsWith('.wxml'));
    for (const f of wxml) {
      for (const m of read(f).matchAll(/\bsrc="(\/assets\/[^"{}]+)"/g)) {
        const p = join(SRC, m[1]!);
        expect(existsSync(p), `${f}: ${m[1]}`).toBe(true);
        expect(readFileSync(p).subarray(1, 4).toString('ascii')).toBe('PNG');
        expect(statSync(p).size).toBeLessThan(60 * 1024);
      }
    }
  });

  it('入口与列表里按名字拼的图标（/assets/icons/{{…}}.png）都生成了', async () => {
    const { ENTRIES } = await import('../src/utils/entries');
    for (const e of ENTRIES) expect(existsSync(join(SRC, 'assets', 'icons', `${e.icon}.png`)), e.icon).toBe(true);
    for (const name of ['doc', 'image', 'video', 'audio', 'folder', 'chevron', 'back', 'home', 'search']) expect(existsSync(join(SRC, 'assets', 'icons', `${name}.png`)), name).toBe(true);
  });
});

describe('写法约定', () => {
  const ts = files.filter((f) => f.endsWith('.ts'));
  const wxss = files.filter((f) => f.endsWith('.wxss'));

  it('import 里不混写 type（开发者工具的 TypeScript 编译不认）', () => {
    for (const f of ts) expect(/import\s*\{[^}]*\btype\s+\w/.test(read(f)), f).toBe(false);
  });

  it('不用 Array.prototype.at、TextEncoder（老手机的小程序运行环境不一定有）', () => {
    for (const f of ts) {
      const code = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(/\.at\(/.test(code), `${f}: .at(`).toBe(false);
      expect(/\bTextEncoder\b/.test(code), `${f}: TextEncoder`).toBe(false);
    }
  });

  it('不用数字分隔符', () => {
    for (const f of ts) expect(/\d_\d/.test(read(f).replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')), f).toBe(false);
  });

  it('样式不用 flex 的 gap、不写 transition: all', () => {
    for (const f of wxss) {
      const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(/(^|[;{\s])gap\s*:/.test(css), `${f}: gap`).toBe(false);
      expect(/transition\s*:\s*all/.test(css), `${f}: transition all`).toBe(false);
    }
  });

  it('页面与组件的样式里不写十六进制颜色（只用 app.wxss 的令牌）', () => {
    for (const f of wxss.filter((x) => !x.endsWith('app.wxss'))) {
      const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(css.match(/#[0-9a-fA-F]{3,8}\b/g), f).toBeNull();
    }
  });

  it('sitemap 全部不收录；隐私接口只声明要用的', () => {
    const sitemap = JSON.parse(read(join(SRC, 'sitemap.json'))) as { rules: { action: string; page: string }[] };
    expect(sitemap.rules).toEqual([{ action: 'disallow', page: '*' }]);
    for (const p of app.requiredPrivateInfos ?? []) expect(['getLocation']).toContain(p);
  });
});
