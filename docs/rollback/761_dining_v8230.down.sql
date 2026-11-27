-- 回滚 761_dining_v8230.sql（8.2.30 出品单的等叫 / 加急 / 打包、分次上菜）。先停服务、先备份；只在回到 8.2.30 以前的版本时执行。
-- 会丢掉：等叫、加急、打包的标记，分次上菜上了几份（还没上齐的照旧是「已出餐」，回滚后要整份上菜）。
-- 等叫着的菜回滚后会直接出现在厨房的待做里。
BEGIN;
ALTER TABLE kitchen_items DROP CONSTRAINT kitchen_items_hold_check, DROP CONSTRAINT kitchen_items_served_qty_check;
ALTER TABLE kitchen_items DROP COLUMN hold, DROP COLUMN urgent, DROP COLUMN takeaway, DROP COLUMN served_qty;
DELETE FROM schema_migrations WHERE version = '761_dining_v8230.sql';
COMMIT;
