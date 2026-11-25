-- 回滚 267_design_blob_storage.sql：文件列改回默认的存储方式（EXTENDED），数据不动。
BEGIN;
ALTER TABLE design_asset_versions ALTER COLUMN data SET STORAGE EXTENDED;
DELETE FROM schema_migrations WHERE version = '267_design_blob_storage.sql';
COMMIT;
