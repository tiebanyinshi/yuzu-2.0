// 授权的品牌英文字体（8.1.5，docs/EMENU.md 第 14.2 节，PENDING_DECISIONS.md PP4）：门店服务器上放了 brand-fonts/en.woff2（或 en.ttf 等，PD6）时，
// 平板菜单、工作台、后台的版面预览用它显示英文（字体名 Tangqi Brand En，排在英文字体列表里 Average Sans 的前面）；
// 没放、取不到时什么都不做，照旧用 Average Sans。取到以后根节点带 data-brand-en，样式表去掉给顶替字体补的字距。
// 一个页面取到一次就记住；没取到的 10 分钟内不再取（页面开着时门店放上文件，刷新一下页面就用上）。

import { useEffect, useState } from 'react';
import { useDesignSlotVersion } from '../../lib/design';

export const BRAND_EN_FAMILY = 'Tangqi Brand En';
/**
 * 同一个授权文件的第二个名字，只管拉丁字母（8.1.19，店主「所有的英文字体都要替换为数据包提供的示例字体」，PD5）：
 * 排在中文字体串里朱雀仿宋的前面，中文里夹的字母、数字（手牌号、菜名里的英文）也是品牌字体；
 * 中文标点（“ ” — …）不在这个范围里，照旧由朱雀仿宋出，中文的排版不变
 */
export const BRAND_LATIN_FAMILY = 'Tangqi Brand Latin';
const LATIN_RANGE = 'U+0020-007E, U+00A0-00FF, U+0100-024F';
// 2026-11-22（PD6）：服务器上的授权文件可以是 WOFF2、WOFF、OTF、TTF，地址不带格式、不写 format()，浏览器按文件内容认
const SOURCE = 'url(/api/emenu/fonts/brand-en)';
const RETRY_MS = 10 * 60_000;

let loaded = false;
let pending: Promise<boolean> | null = null;
let failedAt = 0;
/**
 * 现在加载的是哪一份（Design 素材库「平板菜单 · 英文品牌字体」用途的版本编号；没设时是 dir＝服务器 brand-fonts 目录）。
 * 设计师在别的电脑换了或清掉用途（Codex 审查）：版本一变就把注册过的两个字体名拿掉、按新的一份重新取，平板不用整页刷新
 */
let currentKey = 'dir';
let loadedKey: string | null = null;
let faces: FontFace[] = [];
const listeners = new Set<(ok: boolean) => void>();

function unloadFaces() {
  for (const f of faces) document.fonts.delete(f);
  faces = [];
  loaded = false;
  loadedKey = null;
}

/** 取（或换成）key 那一份；不给 key 用最近一次定下来的 */
export function loadBrandFont(key: string = currentKey): Promise<boolean> {
  currentKey = key;
  if (loaded && loadedKey === key) return Promise.resolve(true);
  if (pending) return pending.then(() => (currentKey === key && loadedKey === key ? loaded : loadBrandFont(currentKey)));
  if (loadedKey !== key && typeof document !== 'undefined' && document.fonts) {
    if (faces.length) unloadFaces();
    failedAt = 0;
  }
  if (failedAt && Date.now() - failedAt < RETRY_MS) return Promise.resolve(false);
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return Promise.resolve(false);
  pending = (async () => {
    // 地址带上版本：换了一份，浏览器不拿缓存里旧的那份
    const source = key === 'dir' ? SOURCE : `url(/api/emenu/fonts/brand-en?v=${encodeURIComponent(key)})`;
    try {
      const face = new FontFace(BRAND_EN_FAMILY, source, { display: 'swap' });
      const latin = new FontFace(BRAND_LATIN_FAMILY, source, { display: 'swap', unicodeRange: LATIN_RANGE });
      await Promise.all([face.load(), latin.load()]);
      document.fonts.add(face);
      document.fonts.add(latin);
      faces = [face, latin];
      loaded = true;
      loadedKey = key;
    } catch {
      failedAt = Date.now();
      loadedKey = key;
    }
    pending = null;
    for (const l of listeners) l(loaded);
    return loaded;
  })();
  return pending;
}

/** 字体取到 / 换了 / 拿掉时叫一下（量字宽的地方重新量）；返回取消订阅 */
export function onBrandFontChange(cb: (ok: boolean) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 这个页面用不用得上授权的英文字体（取到了才是 true）；跟着素材库用途的版本换 */
export function useBrandFont(): boolean {
  const version = useDesignSlotVersion('emenu.font.en');
  const [ok, setOk] = useState(loaded);
  useEffect(() => onBrandFontChange(setOk), []);
  useEffect(() => {
    if (version === undefined) return; // 还没取到「现在用的」：等一下再定取哪一份
    let live = true;
    void loadBrandFont(version === null ? 'dir' : String(version)).then((v) => {
      if (live) setOk(v);
    });
    return () => {
      live = false;
    };
  }, [version]);
  return ok;
}

/**
 * 开机就把平板菜单的几款字体备好（8.1.6，QZ4、QZ5）：英文（Average Sans，顶替的那款；8.1.14 起加上衬线展示体 Playfair Display，
 * 顶栏分类的英文与菜品的英文名用）与两个行框字体。
 * 原来第一次切到英文时浏览器才去下载英文字体，那一下字先用别的字体画、下载完再换一次（闪一下、跳一下）。
 * 中文朱雀仿宋按用到的字分块下载，起始页、菜单一出来就用上了，不用另备；授权的品牌英文字体由 loadBrandFont 取。
 */
let warmed = false;
export function warmEmenuFonts(): void {
  if (warmed || typeof document === 'undefined' || !document.fonts?.load) return;
  warmed = true;
  for (const spec of ["16px 'Average Sans'", "16px 'Playfair Display'", "16px 'Em Box En'", "16px 'Em Box Zh'"]) void document.fonts.load(spec, 'Ab0').catch(() => undefined);
}
