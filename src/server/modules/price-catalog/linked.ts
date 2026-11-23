// 价目表第四批（docs/PRICE_CATALOG.md 第 6 节，PC17）：对接了「全品类价目表」的收银项目，价格以价目表为准。
// 后台价目（单个项目、价目清单导入）、菜品改价、本店价改到这些项目的价格时拒绝（PRICE_LINKED），不再出现两套价格。
// 单独放一个文件：后台价目（catalog.ts）、菜品（dishes.ts）都要用，只依赖数据库，不引价目表的其余模块。

import type { Db, Tx } from '../../db';
import { conflict } from '../../lib/errors';
import { DEFAULT_STORE_ID } from '../../lib/store-context';

/**
 * 调用方已经锁住这几个收银项目（与对接、同步排队）。改的是全公司的价目（本店、后台价目、菜品改价）查编号 1 的对接；
 * 改第二家店的本店价查那家店的对接。
 */
export async function assertNotPriceLinked(db: Db | Tx, itemIds: number[], opts: { storeId?: number } = {}): Promise<void> {
  if (itemIds.length === 0) return;
  const [hit] = await db<{ name: string }[]>`
    SELECT i.name FROM price_catalog_links l JOIN service_items i ON i.id = l.item_id
    WHERE l.store_id = ${opts.storeId ?? DEFAULT_STORE_ID} AND l.item_id IN ${db([...new Set(itemIds)])} ORDER BY i.id LIMIT 1`;
  if (hit) {
    throw conflict('PRICE_LINKED', `「${hit.name}」的价格由「全品类价目表」管：请到 后台 → 价目与套餐 → 全品类价目表 里改价，或先取消对接`);
  }
}
