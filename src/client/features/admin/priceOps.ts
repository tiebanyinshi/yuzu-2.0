// 价目表录入（docs/PRICE_CATALOG.md）：「全品类价目表」页的结果待确认类型，页面与对接卡片共用。

/**
 * 价目表的几类写操作会互相覆盖（导入替换草稿、切换让草稿生效、改条目同步收银价……）：任何一笔结果待确认，
 * 查回或确认作废之前，这一页所有写操作的按钮都不能点（AGENTS.md「结果待确认」）
 */
export const PENDING_TYPES = ['price_import', 'price_rollback', 'price_entry', 'price_set', 'price_link'] as const;
