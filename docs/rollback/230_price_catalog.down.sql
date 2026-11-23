-- 回滚 230_price_catalog.sql（价目表录入 第一批）。先停服务、先备份；只在回到价目表录入以前的版本时执行。
-- 删掉价目表数据集与条目两张表。第一批只是导入成草稿，还没有被开单、房态点单、康美部用到，删掉不影响已有的价格与单据；
-- 回滚前想留底的，在后台价目表页导出一份。schema_migrations 里删掉 230 这一行，以后重新升级会再建（导过的草稿不会回来）。
BEGIN;
DROP TABLE IF EXISTS price_catalog_entries;
DROP TABLE IF EXISTS price_catalog_sets;
DELETE FROM schema_migrations WHERE version = '230_price_catalog.sql';
COMMIT;
