-- 回滚 320_coupon_limits.sql（8.1.40 券的使用限制）。先停服务、先备份；只在回到 8.1.40 以前的版本时执行。
-- 旧版本不认识这几项：设了限制的券回滚以后不再受限（全天、全公司、所有技师项目都能用），回滚前请确认。
BEGIN;
ALTER TABLE coupon_templates DROP CONSTRAINT coupon_templates_time_check;
ALTER TABLE coupon_templates DROP COLUMN designated_only;
ALTER TABLE coupon_templates DROP COLUMN store_ids;
ALTER TABLE coupon_templates DROP COLUMN time_to;
ALTER TABLE coupon_templates DROP COLUMN time_from;
ALTER TABLE coupon_templates DROP COLUMN weekdays;
DELETE FROM schema_migrations WHERE version = '320_coupon_limits.sql';
COMMIT;
