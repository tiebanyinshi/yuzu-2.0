-- 回滚 241_room_overnight.sql。先停服务、先备份；先回滚 241，再回滚 240。
-- 登记单上记的「过夜」与收银项目上的价目表编号一起删掉（不影响账单与钟单）。
BEGIN;
ALTER TABLE service_items DROP CONSTRAINT IF EXISTS service_items_catalog_code_check, DROP COLUMN IF EXISTS catalog_code;
ALTER TABLE room_registrations DROP COLUMN IF EXISTS overnight;
DELETE FROM schema_migrations WHERE version = '241_room_overnight.sql';
COMMIT;
