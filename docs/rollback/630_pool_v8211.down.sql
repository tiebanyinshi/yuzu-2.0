-- 回滚 630_pool_v8211.sql：去掉技师工牌芯片号（绑过的工牌要重新绑）。
DROP INDEX IF EXISTS technicians_card_uid_uq;
ALTER TABLE technicians DROP COLUMN IF EXISTS card_uid;
DELETE FROM schema_migrations WHERE version = '630_pool_v8211.sql';
