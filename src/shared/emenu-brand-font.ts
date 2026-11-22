// 授权的品牌英文字体的状态（8.1.5 PP4；店主 2026-11-22 PD6）：后台「电子菜单」上写明品牌字体生效了没有。
// 授权文件由门店放在服务器的 brand-fonts 目录（不进代码库），en.woff2、en.woff、en.otf、en.ttf 都认。

export const BRAND_FONT_FILES = ['en.woff2', 'en.woff', 'en.otf', 'en.ttf'] as const;

export interface BrandFontStatus {
  /** active：在用；missing：目录里没有；trial：放的是试用版（不能用）；invalid：放的不是字体或太大 */
  state: 'active' | 'missing' | 'trial' | 'invalid';
  /** 在用的那个文件 */
  file: string | null;
  /** 目录里找到的候选文件 */
  files: { name: string; size: number; updatedAt: string; problem: 'invalid' | 'trial' | 'too_large' | null }[];
}
