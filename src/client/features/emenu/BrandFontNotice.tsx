// 平板菜单的品牌英文字体生效了没有（店主 2026-11-22，PD6）。店主 2026-11-24（docs/BOARDS.md 第 3 节）：品牌字体归 Design，
// 完整的说明在 Design 首页；电子菜单页只在没生效时提醒一行、指过去。

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { BRAND_FONT_FILES, type BrandFontStatus } from '@shared/emenu-brand-font';
import { api } from '../../lib/api';
import { Notice } from '../../components/ui';

/**
 * 品牌英文字体生效了没有（店主 2026-11-22，PD6）：授权文件由部署的人放在服务器的 brand-fonts 目录（不进代码库），
 * 放没放对这里一眼看得到；在用时不占地方，只写一行
 */
export function BrandFontNotice({ compact }: { compact?: boolean }) {
  const q = useQuery({ queryKey: ['admin', 'emenu', 'brand-font'], queryFn: () => api.get<BrandFontStatus>('/api/admin/emenu/brand-font') });
  if (!q.data) return null;
  const d = q.data;
  if (d.state === 'active') {
    if (compact) return null;
    return (
      <p className="text-[12.5px] text-ink-3" data-testid="emenu-brand-font" data-state="active">
        {d.source === 'library' ? `品牌英文字体已生效：Design 素材库「${d.libraryName ?? ''}」。` : `品牌英文字体 ABC Arizona Flare 已生效（服务器 brand-fonts/${d.file}）。`}
      </p>
    );
  }
  if (compact) {
    return (
      <Notice tone="warning" title="品牌英文字体没生效" data-testid="emenu-brand-font" data-state={d.state}>
        平板上的英文现在用顶替的字体。品牌字体在{' '}
        <Link to="/admin/design" className="font-bold text-lake hover:underline">
          Design
        </Link>{' '}
        里看怎么放。
      </Notice>
    );
  }
  const where = `放到服务器 compose.yaml 旁边的 brand-fonts 目录，文件名改成 ${BRAND_FONT_FILES.join('、')} 之一（任选其一，按这个顺序取）；放好后平板刷新页面就生效，不用重启`;
  const title = d.state === 'trial' ? '品牌英文字体没生效：服务器上放的是试用版' : d.state === 'invalid' ? '品牌英文字体没生效：服务器上放的文件不能用' : '品牌英文字体没生效：服务器上还没放授权文件';
  return (
    <Notice tone="warning" title={title} data-testid="emenu-brand-font" data-state={d.state}>
      {d.state === 'trial'
        ? `${d.files
            .filter((f) => f.problem === 'trial')
            .map((f) => f.name)
            .join('、')} 是 Dinamo 的试用版（字体里写着 Unlicensed Trial，条款不许放在服务器上、不许分发），系统不发它。请换成授权包里的字体文件，${where}。`
        : d.state === 'invalid'
          ? `${d.files.map((f) => `${f.name}（${f.problem === 'too_large' ? '超过 8 MB' : '不是字体文件'}）`).join('、')}。请换成授权包里的字体文件，${where}。`
          : `现在英文用顶替的字体（Playfair Display、Average Sans）。把 ABC Arizona Flare 授权包里的 Regular 字体文件（WOFF2 最好，TTF、OTF 也行）${where}。`}
    </Notice>
  );
}
