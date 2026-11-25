// Design 首页（店主 2026-11-24，docs/BOARDS.md 第 3 节）：门户的 Design 板块进到这里——品牌与设计有关的分区
// （UI 工作台、对客导览）各一张卡片，加上平板菜单的品牌英文字体生效了没有。素材库、官网在后面两批加进来。

import { Link } from 'react-router';
import { ArrowRight, Images, Map as MapIcon, PenTool, Type, type LucideIcon } from 'lucide-react';
import { ADMIN_SECTIONS, boardSections, type AdminSection } from '@shared/admin';
import { useCan } from '../../lib/session';
import { Card, SectionTitle } from '../../components/ui';
import { BrandFontNotice } from '../emenu/BrandFontNotice';
import { AdminPage, useAdminSections } from './AdminShell';

const CARDS: Partial<Record<AdminSection, { icon: LucideIcon; hint: string }>> = {
  library: { icon: Images, hint: '字体、图片、视频存在这里；每个用途（平板菜单字体、门户横幅、大屏视频……）选一份当前用的，一点就换、随时切回' },
  studio: { icon: PenTool, hint: '平板菜单、员工食堂手机端的版面：拖、点、改颜色与字体，预览、检查、发布、回滚' },
  guide: { icon: MapIcon, hint: '对客导览图的区域色块与设施图标、门店大屏轮播' },
};

export function DesignHome() {
  const can = useCan();
  const sections = useAdminSections();
  const items = boardSections('design').filter((k) => k !== 'design' && sections.includes(k));
  const fonts = can('emenu.manage') || can('studio.edit');
  return (
    <AdminPage section="design" description="品牌与设计：对客的界面长什么样、用什么字体与图片，都在这里改。">
      <div className="space-y-5" data-testid="design-home">
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="design-cards">
          {items.map((k) => {
            const c = CARDS[k];
            const Icon = c?.icon ?? PenTool;
            return (
              <li key={k}>
                <Link
                  to={ADMIN_SECTIONS[k].path}
                  className="group mo-lift flex h-full items-start gap-3 rounded-xl border border-line bg-card p-4 shadow-card hover:border-pine/50"
                  data-testid={`design-card-${k}`}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-pine-tint text-pine">
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-bold text-ink">{ADMIN_SECTIONS[k].label}</span>
                    <span className="mt-0.5 block text-[12.5px] text-ink-3">{c?.hint}</span>
                  </span>
                  <ArrowRight className="mt-1 size-4 text-ink-4 group-hover:text-pine" />
                </Link>
              </li>
            );
          })}
        </ul>
        {fonts && (
          <Card className="p-5" data-testid="design-fonts">
            <SectionTitle>
              <span className="flex items-center gap-2">
                <Type className="size-4 text-pine" /> 品牌字体
              </span>
            </SectionTitle>
            <p className="mt-1 mb-3 text-[12.5px] text-ink-3">
              平板菜单的英文标题用品牌字体 ABC Arizona Flare（授权文件放在门店服务器上，不进代码库）。在「素材库 → 用途」里换成库里的字体；没设时读服务器上的授权文件。
            </p>
            <BrandFontNotice />
          </Card>
        )}
      </div>
    </AdminPage>
  );
}
