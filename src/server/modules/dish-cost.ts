// 8.1.41 菜品管理里看成本卡与毛利（docs/V8141.md 第 2 节）。
//
// 系统里已有成本卡：库存「用料与扣料」里每个项目的配方（物料、用量、损耗），出品自动扣料，成本报表算理论毛利。
// 缺的是菜品管理里看不到：哪道菜没配成本卡、一份成本多少、毛利多少。这里只读，复用配方列表的算法（listRecipes），
// 物料成本就是采购到货的移动加权平均成本（没进过货的按参考价起算），采购价变了菜品成本自然跟着变。
// 看得到菜品的都能看「有没有成本卡」；金额只给有「看成本」权限的人（与库存成本页一样）。

import type { FastifyInstance } from 'fastify';
import { DISH_PERMISSIONS } from '@shared/dishes';
import { can } from '@shared/permissions';
import type { DishCosts } from '@shared/dish-cost';
import { guardAny } from '../auth/guard';
import { readSnapshot, type Db } from '../db';
import type { Actor, Deps } from '../lib/context';
import { listRecipes } from './stock-usage';

export async function dishCosts(db: Db, actor: Actor): Promise<DishCosts> {
  const canSeeCost = can(actor, 'inventory.cost');
  // 配方列表按有没有成本权限给金额；这里没有权限的同样只给有没有成本卡
  const recipes = await listRecipes(db, actor);
  return {
    canSeeCost,
    rows: recipes.map((r) => {
      const hasRecipe = r.lines.length > 0;
      return {
        itemId: r.itemId,
        hasRecipe,
        unitCostCents: canSeeCost ? r.unitCostCents : null,
        missingCost: canSeeCost && hasRecipe && r.unitCostCents === null,
      };
    }),
  };
}

export function registerDishCostRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/dining/dishes/costs', { preHandler: guardAny(...DISH_PERMISSIONS) }, async (req) => readSnapshot(deps.sql, (tx) => dishCosts(tx, req.actor)));
}
