// 8.1.41 菜品的成本卡与毛利（docs/V8141.md 第 2 节；《门店系统需求梳理与优化方案》「成本卡」）：前后端共用。
//
// 成本卡就是库存「用料与扣料」里的配方（一份用哪些物料、多少、损耗）；物料的成本是采购到货的移动加权平均成本，
// 采购进价一变，下一次算的菜品成本就跟着变——不另存一份菜品成本。

export interface DishCostRow {
  itemId: number;
  /** 配了成本卡（有在用的配方） */
  hasRecipe: boolean;
  /** 一份的理论成本（分）；看不到成本、没配成本卡、或有物料还没有成本时为空 */
  unitCostCents: number | null;
  /** 配了成本卡、但有物料还没有成本（没进过货也没参考价） */
  missingCost: boolean;
}

export interface DishCosts {
  /** 有「看成本」权限（inventory.cost）才给金额 */
  canSeeCost: boolean;
  rows: DishCostRow[];
}

/** 毛利率（万分比，四舍五入）；售价不是正数或没有成本时为空 */
export function dishMarginBp(price: number, unitCostCents: number | null): number | null {
  if (unitCostCents === null || price <= 0) return null;
  return Math.round(((price - unitCostCents) * 10000) / price);
}

/** 「毛利 62.5%」 */
export const marginText = (bp: number) => `${(bp / 100).toFixed(1).replace(/\.0$/, '')}%`;
