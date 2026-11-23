-- 回滚 232_price_catalog_import_ops.sql。先停服务、先备份；先回滚 232，再回滚 231、230。
-- 删掉导入的操作编号记录；价目表与草稿不受影响。
BEGIN;
DROP TABLE IF EXISTS price_catalog_import_ops;
DELETE FROM schema_migrations WHERE version = '232_price_catalog_import_ops.sql';
COMMIT;
