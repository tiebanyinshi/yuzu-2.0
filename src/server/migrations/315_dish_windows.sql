-- 8.1.39（餐饮 B，docs/V8139_DINING_B.md）：菜品的售卖时段（分时段自动沽清，R3）与按时段切换出品档口（《门店系统需求梳理》）。
--   · service_items.sale_windows：这道菜在哪几段时间里卖，[{"start": 660, "end": 840}, …]（门店时区一天里的第几分钟，start > end 为跨零点）；
--     NULL 为全天都卖（升级以后什么都不用改）。不在时段里的任何点单入口都下不了单，由接口核对；
--   · dish_station_windows：同一道菜在某一段时间到另一个出品档口出品；不在任何一段里的按 service_items.station_id。
--     时段的重叠、段数由接口核对；这里只约束分钟在 0–1439、开始与结束不一样。
-- 只加列、加表，不改已有数据。回滚：docs/rollback/315_dish_windows.down.sql。

ALTER TABLE service_items ADD COLUMN sale_windows jsonb CHECK (sale_windows IS NULL OR jsonb_typeof(sale_windows) = 'array');

CREATE TABLE dish_station_windows (
  item_id       bigint NOT NULL REFERENCES service_items (id),
  start_minute  integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute    integer NOT NULL CHECK (end_minute BETWEEN 0 AND 1439),
  station_id    bigint NOT NULL REFERENCES kitchen_stations (id),
  PRIMARY KEY (item_id, start_minute),
  CHECK (start_minute <> end_minute)
);
CREATE INDEX dish_station_windows_station_idx ON dish_station_windows (station_id);
