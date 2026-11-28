-- 8.2.30 收银合并的餐饮补全（店主 2026-11-27 评审 PR #68，设计见 docs/V8230_CASHIER.md 第 4 节）：
--   · 出品单的标记（CM-16）：等叫（hold：先不做，等「起菜」）、加急、打包；只是标记，不动金额；
--   · 分次上菜（CM-19）：一行几份，出餐以后可以先上几份（served_qty），上齐了才算「已上菜」。
-- 出品单原来的保护（yuzu_kitchen_item_guard）只管下单信息与状态，这几列照它放行；等叫只在「待做」时有。
-- 风险已知：只加有默认值的列与约束，旧数据都是 false / 0。回滚见 docs/rollback/761_dining_v8230.down.sql。

ALTER TABLE kitchen_items
  ADD COLUMN hold boolean NOT NULL DEFAULT false,
  ADD COLUMN urgent boolean NOT NULL DEFAULT false,
  ADD COLUMN takeaway boolean NOT NULL DEFAULT false,
  ADD COLUMN served_qty integer NOT NULL DEFAULT 0;
ALTER TABLE kitchen_items ADD CONSTRAINT kitchen_items_hold_check CHECK (NOT hold OR status IN ('queued', 'cancelled')) NOT VALID;
ALTER TABLE kitchen_items VALIDATE CONSTRAINT kitchen_items_hold_check;
ALTER TABLE kitchen_items ADD CONSTRAINT kitchen_items_served_qty_check
  CHECK (served_qty >= 0 AND served_qty <= quantity AND (served_qty = 0 OR status IN ('done', 'served', 'cancelled'))) NOT VALID;
ALTER TABLE kitchen_items VALIDATE CONSTRAINT kitchen_items_served_qty_check;
COMMENT ON COLUMN kitchen_items.hold IS '8.2.30 等叫：先不做，等服务员点「起菜」（只在待做时有）';
COMMENT ON COLUMN kitchen_items.urgent IS '8.2.30 加急：厨房屏、出品单上标出来';
COMMENT ON COLUMN kitchen_items.takeaway IS '8.2.30 打包：厨房屏、出品单上标出来';
COMMENT ON COLUMN kitchen_items.served_qty IS '8.2.30 分次上菜：出餐以后已经先上了几份；上齐了状态改成已上菜';
