-- 价目表录入 第四批：对接收银项目（docs/PRICE_CATALOG.md 第 6 节，PC17、PC18）。
-- 价目表的一项（同一张表、同一个板块 / 餐段、同一个分类里的名称，不分大小写、不管空格：priceNameKey）对上一个收银项目（service_items）。
-- 对上以后，切换生效、整体回滚、改生效中的价目时，在同一个事务里把价格写到那个收银项目上——前台开单、房态点单、房态中心登记、
-- 点单页都照旧从收银项目取价，取到的就是价目表的价；已开的单照旧留着开单时的名称与单价。
--   · price_catalog_links：一家门店里一项只对一个收银项目，一个收银项目只对一项；对接、取消对接都记审计；
--   · price_catalog_link_ops：对接、取消对接、按名称自动对接的操作编号（重提返回第一次的结果，不再做一遍；只追加）；
--   · 菜品改价记录 dish_price_changes 的来源多一种 price_catalog（同步改到菜品的价，每一档记一条），在当时的约束上追加（写法见 162）；
--   · op_fences 的类型多一种 price_link（结果待确认时确认作废），同样在当时的约束上追加。

CREATE TABLE price_catalog_links (
  store_id   bigint NOT NULL DEFAULT yuzu_store(),
  entry_key  text NOT NULL CHECK (char_length(entry_key) BETWEEN 3 AND 400),
  item_id    bigint NOT NULL REFERENCES service_items (id),
  created_by bigint NOT NULL REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, entry_key),
  UNIQUE (store_id, item_id)
);
CREATE INDEX price_catalog_links_item_idx ON price_catalog_links (item_id);

CREATE TABLE price_catalog_link_ops (
  op_key     uuid PRIMARY KEY,
  store_id   bigint NOT NULL DEFAULT yuzu_store(),
  action     text NOT NULL CHECK (action IN ('link', 'unlink', 'auto')),
  result     jsonb NOT NULL,
  staff_id   bigint NOT NULL REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER price_catalog_link_ops_append_only BEFORE UPDATE OR DELETE ON price_catalog_link_ops
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'dish_price_changes'::regclass AND conname = 'dish_price_changes_source_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原改价来源约束 dish_price_changes_source_check 不存在'; END IF;
  ALTER TABLE dish_price_changes DROP CONSTRAINT dish_price_changes_source_check;
  EXECUTE format('ALTER TABLE dish_price_changes ADD CONSTRAINT dish_price_changes_source_check CHECK ((%s) OR source = ''price_catalog'')', expression);

  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''price_link''))', expression);
END $$;
