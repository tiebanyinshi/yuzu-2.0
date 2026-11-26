// 8.1.41 菜品管理里的成本卡与毛利（docs/V8141.md 第 2 节）：价格下面一行小字。
// 成本卡在「库存 → 用料与扣料」里配；这里只读，有「查看库存」权限的点得过去。

import { Link } from 'react-router';
import { dishMarginBp, marginText, type DishCostRow } from '@shared/dish-cost';
import type { DishRow } from '@shared/dishes';
import { formatYuan } from '@shared/money';
import { useCan } from '../../lib/session';

/** 该配成本卡的菜：没删除、不是套餐（套餐按里面的菜扣料）、还没有在用的配方 */
export const needsRecipe = (d: DishRow, row: DishCostRow | undefined) => !d.deleted && d.combo.length === 0 && !!row && !row.hasRecipe;

export function DishCostText({ d, row, canSeeCost }: { d: DishRow; row: DishCostRow | undefined; canSeeCost: boolean }) {
  const can = useCan();
  if (!row || d.combo.length > 0) return null;
  if (!row.hasRecipe) {
    const text = <span className="text-[12px] font-semibold text-clay">没有成本卡</span>;
    return can('inventory.read') ? (
      <Link to="/inventory/usage" className="underline-offset-2 hover:underline" data-testid={`dish-cost-${d.name}`}>
        {text}
      </Link>
    ) : (
      <span data-testid={`dish-cost-${d.name}`}>{text}</span>
    );
  }
  if (!canSeeCost) return null;
  if (row.missingCost)
    return (
      <span className="text-[12px] text-ember" data-testid={`dish-cost-${d.name}`}>
        成本卡有物料还没成本
      </span>
    );
  // 时价、称重的菜售价是点的时候填的：只写一份（按价目）的成本，不算毛利
  const bp = d.priceMode === 'fixed' ? dishMarginBp(d.price, row.unitCostCents) : null;
  return (
    <span className="text-[12px] text-ink-3" data-testid={`dish-cost-${d.name}`}>
      成本 {formatYuan(row.unitCostCents ?? 0)}
      {bp !== null && <span className={bp < 0 ? 'font-semibold text-clay' : undefined}> · 毛利 {marginText(bp)}</span>}
    </span>
  );
}
