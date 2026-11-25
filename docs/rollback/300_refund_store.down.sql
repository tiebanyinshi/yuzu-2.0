-- 回滚 300_refund_store.sql（8.1.38 退储值只在充值的那家店办）。先停服务、先备份；只在回到 8.1.38 以前的版本时执行。
-- 去掉期初导入与合并转入记的门店；旧版本退储值不分门店，不读这两列。
BEGIN;
ALTER TABLE member_merges DROP COLUMN store_id;
ALTER TABLE opening_imports DROP COLUMN store_id;
DELETE FROM schema_migrations WHERE version = '300_refund_store.sql';
COMMIT;
