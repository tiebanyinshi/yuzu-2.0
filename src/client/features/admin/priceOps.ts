// 价目表录入（docs/PRICE_CATALOG.md）：「全品类价目表」页的结果待确认类型，页面与对接卡片共用。

/**
 * 价目表的几类写操作会互相覆盖（导入替换草稿、切换让草稿生效、改条目同步收银价……）：任何一笔还在提交中
 * 或结果待确认（用 useErpRecorded，含在途的），回来了或查回 / 确认作废之前，这一页所有写操作的按钮都不能点（AGENTS.md「结果待确认」）
 */
export const PENDING_TYPES = ['price_import', 'price_rollback', 'price_entry', 'price_set', 'price_link'] as const;

/** 会被价目表同步改到的缓存：价目表本身、对接与生效中的价目（['price-catalog', …]）、收银项目与本店价（['catalog', …]）、菜品与点单菜单 */
const SYNCED_PREFIXES = [['admin', 'price-catalog'], ['price-catalog'], ['catalog'], ['dining', 'dishes'], ['dining', 'menu']] as const;

/**
 * 改生效中的条目、启停、切换生效、整体回滚、对接，服务端都会在同一个事务里同步收银价、改名时挪对接（syncLinkedPrices）；
 * 只刷新价目表那一份，对接卡片会把改了名的显示成孤立、改了价的显示成「不一致」，所以写成功（或结果查回）后一起刷新（Codex 审查）
 */
export const invalidatePriceCaches = (qc: { invalidateQueries: (f: { queryKey: readonly unknown[] }) => Promise<void> }) =>
  Promise.all(SYNCED_PREFIXES.map((queryKey) => qc.invalidateQueries({ queryKey })));
