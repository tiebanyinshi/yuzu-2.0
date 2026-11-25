-- 回滚 315_dish_windows.sql（8.1.39 菜品的售卖时段与档口时段）。先停服务、先备份；只在回到 8.1.39 以前的版本时执行。
-- 删掉售卖时段与档口时段；旧版本不认识这两样，菜品照全天卖、照自己的档口出品。已经下的出品单记着当时的档口，不受影响。
BEGIN;
DROP TABLE dish_station_windows;
ALTER TABLE service_items DROP COLUMN sale_windows;
DELETE FROM schema_migrations WHERE version = '315_dish_windows.sql';
COMMIT;
