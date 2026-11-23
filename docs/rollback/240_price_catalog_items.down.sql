-- 回滚 240_price_catalog_items.sql：去掉收银项目上的价目表分类列。
-- 先停服务、先备份。
-- 注意：价目表自动新建的收银项目（catalog_managed）不删——已开的单还引用它们；回滚后它们成了普通收银项目，可在后台停用。
BEGIN;
DROP INDEX IF EXISTS service_items_catalog_category_idx;
DROP INDEX IF EXISTS service_items_catalog_managed_uq;
ALTER TABLE service_items
  DROP CONSTRAINT IF EXISTS service_items_catalog_check,
  DROP COLUMN IF EXISTS catalog_sort,
  DROP COLUMN IF EXISTS catalog_group,
  DROP COLUMN IF EXISTS catalog_category_name,
  DROP COLUMN IF EXISTS catalog_category_code,
  DROP COLUMN IF EXISTS catalog_managed,
  DROP COLUMN IF EXISTS catalog_key;
DELETE FROM schema_migrations WHERE version = '240_price_catalog_items.sql';
COMMIT;
