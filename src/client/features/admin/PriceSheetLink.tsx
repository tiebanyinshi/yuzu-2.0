// 各模块页面上的「价目表」入口（店主 2026-11-24《价目表模板替换与页面维护需求说明》）：门票、房态中心房型、菜品、技师项目
// 这些页面不另写一套导入 / 改价，点过去到「价目与套餐 → 全品类价目表」，直接是这个模块的那张表（导入、模板、导出、新增、改价、停用都在那里）。

import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { PRICE_SHEET_NAMES, type PriceSheet } from '@shared/price-catalog';

export function PriceSheetLink({ sheet, className }: { sheet: PriceSheet; className?: string }) {
  return (
    <Link
      to={`/admin/catalog/full?sheet=${sheet}`}
      className={`tap relative inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3 hover:text-ink ${className ?? ''}`}
      data-testid={`price-sheet-link-${sheet}`}
    >
      价目表「{PRICE_SHEET_NAMES[sheet]}」：导入 / 模板 / 导出 / 改价
      <ArrowRight className="size-4" />
    </Link>
  );
}
