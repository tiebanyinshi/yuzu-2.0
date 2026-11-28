// 生成员工小程序的图标（docs/STAFF_MP.md 第 4 节：1.5 像素细线、单色、不用表情）：
//   · 标签栏 src/assets/tab/<名字>(-on).png：81×81（微信要求本地 PNG、不超过 40KB），未选中 #5F574D、选中 #1C1A17（与 app.json 一致）；
//   · 入口与列表的图标 src/assets/icons/<名字>.png：96×96，墨色 #1C1A17。
// 图形取自 lucide（ISC 许可，许可文本在 assets-src/LUCIDE-LICENSE.txt），从仓库根目录装好的 lucide-react 里读矢量数据，
// 用根目录装好的 Playwright 带的 Chromium 渲染。改了图标在仓库根目录执行：node staff-miniprogram/scripts/render-icons.mjs

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const src = join(here, '..', 'src', 'assets');

let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch {
  ({ chromium } = await import('playwright'));
}

/** lucide 的图形（读 lucide-react 的图标模块里的 __iconData，不执行它） */
function lucide(name) {
  const code = readFileSync(join(root, 'node_modules', 'lucide-react', 'dist', 'esm', 'icons', `${name}.mjs`), 'utf8');
  const m = /const __iconData = (\{[\s\S]*?\n\});/.exec(code);
  if (!m) throw new Error(`lucide 图标 ${name} 读不出来`);
  const data = Function(`"use strict"; return (${m[1]});`)();
  return data.node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
}

const TABS = { today: 'sun', learn: 'book-open', workbench: 'layout-grid', me: 'user-round' };
const ICONS = {
  back: 'chevron-left',
  home: 'house',
  chevron: 'chevron-right',
  search: 'search',
  bell: 'bell',
  folder: 'folder',
  doc: 'file-text',
  image: 'image',
  video: 'clapperboard',
  audio: 'headphones',
  punch: 'fingerprint-pattern',
  schedule: 'calendar-days',
  attendance: 'list-checks',
  leave: 'calendar-off',
  approvals: 'stamp',
  canteen: 'utensils',
  scan: 'scan-line',
  patrol: 'shield-check',
  patrolLog: 'clipboard-list',
  payslips: 'receipt',
  directory: 'contact-round',
  announcements: 'megaphone',
  knowledge: 'book-open-text',
  academy: 'graduation-cap',
};

const browser = await chromium.launch();
async function render(size, body, color, file) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.locator('svg').screenshot({ path: file, omitBackground: true });
  await page.close();
  console.log('写入', file);
}

mkdirSync(join(src, 'tab'), { recursive: true });
mkdirSync(join(src, 'icons'), { recursive: true });
for (const [name, icon] of Object.entries(TABS)) {
  await render(81, lucide(icon), '#5F574D', join(src, 'tab', `${name}.png`));
  await render(81, lucide(icon), '#1C1A17', join(src, 'tab', `${name}-on.png`));
}
for (const [name, icon] of Object.entries(ICONS)) await render(96, lucide(icon), '#1C1A17', join(src, 'icons', `${name}.png`));
await browser.close();
