-- 回滚 231_price_catalog_edits.sql（价目表录入 第三批）。先停服务、先备份；先回滚 231，再回滚 230。删掉改价留痕与条目的版本号。
-- 改价留痕会一起删掉；条目当前的价格不受影响。
BEGIN;
DROP TABLE IF EXISTS price_catalog_changes;
ALTER TABLE price_catalog_entries DROP COLUMN IF EXISTS version;
DELETE FROM schema_migrations WHERE version = '231_price_catalog_edits.sql';
COMMIT;
