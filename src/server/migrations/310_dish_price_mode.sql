-- 8.1.39（docs/V8139.md 第 2 节）：菜品的计价方式（《餐饮新店新系统功能需求文档》R5 杂项、R15 海鲜改价、R16 杂项改价）。
-- fixed 按价目（默认，现有的菜都是）/ open 时价、杂项（点的时候填每份多少钱）/ weight 称重（点的时候填斤数，每斤单价默认是价目的价、可改）。
-- 只加一列、有默认值；明细表不改（称重的一行记一份，单价就是这一份的钱，名称带斤数）。
-- 回滚：docs/rollback/310_dish_price_mode.down.sql。

ALTER TABLE service_items ADD COLUMN price_mode text NOT NULL DEFAULT 'fixed' CHECK (price_mode IN ('fixed', 'open', 'weight'));
