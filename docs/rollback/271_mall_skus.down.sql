-- 回滚 271_mall_skus.sql。先停服务、先备份；商城的 SKU 与改价记录会一起删掉（已经提交的需求单行上记着的 SKU 编码与价格版本还在）。
BEGIN;
DROP TABLE mall_sku_changes;
DROP TABLE mall_skus;
DROP FUNCTION yuzu_mall_sku_guard();
DROP FUNCTION yuzu_mall_sku_row_guard();
DROP FUNCTION yuzu_mall_sku_change_guard();
DELETE FROM schema_migrations WHERE version = '271_mall_skus.sql';
COMMIT;
