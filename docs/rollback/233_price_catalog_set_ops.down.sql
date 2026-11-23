-- 回滚 233_price_catalog_set_ops.sql。先停服务、先备份；先回滚 233，再回滚 232、231、230。
-- 删掉整体回滚的操作编号记录；价目表本身不受影响。
BEGIN;
DROP TABLE IF EXISTS price_catalog_set_ops;
DELETE FROM schema_migrations WHERE version = '233_price_catalog_set_ops.sql';
COMMIT;
