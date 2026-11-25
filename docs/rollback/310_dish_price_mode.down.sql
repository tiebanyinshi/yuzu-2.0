-- 回滚 310_dish_price_mode.sql（8.1.39 菜品的计价方式）。先停服务、先备份；只在回到 8.1.39 以前的版本时执行。
-- 去掉计价方式这一列；已经按时价、称重记下的明细不动（金额、名称都在明细上）。
BEGIN;
ALTER TABLE service_items DROP COLUMN price_mode;
DELETE FROM schema_migrations WHERE version = '310_dish_price_mode.sql';
COMMIT;
