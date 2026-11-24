-- 回滚 237_price_catalog_links.sql。先停服务、先备份；先回滚 237，再回滚 236 及之前的。
-- 删掉对接关系与对接的操作编号、这一类作废登记，再把 price_link、price_catalog 从两个约束里去掉（其余类型照旧）。
-- 收银项目上已经同步过去的价格不动（那是收银项目现在的价）；来源为 price_catalog 的菜品改价记录改不了来源（只追加），
-- 所以有这类记录时先停下来，与店主确认后再处理。
BEGIN;
-- op_fences、idempotency_keys 只追加（001、006 的触发器）：维护性删除时临时关掉对应的触发器，删完马上恢复（不然有记录的库上回滚会整笔失败）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dish_price_changes WHERE source = 'price_catalog') THEN
    RAISE EXCEPTION '已有来源为「全品类价目表」的菜品改价记录，不能直接回滚 237，请先与店主确认';
  END IF;
END $$;
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type = 'price_link';
ALTER TABLE op_fences ENABLE TRIGGER op_fences_append_only;
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  expression := replace(expression, ' OR (op_type = ''price_link''::text)', '');
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK (%s)', expression);
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'dish_price_changes'::regclass AND conname = 'dish_price_changes_source_check';
  expression := replace(expression, ' OR (source = ''price_catalog''::text)', '');
  ALTER TABLE dish_price_changes DROP CONSTRAINT dish_price_changes_source_check;
  EXECUTE format('ALTER TABLE dish_price_changes ADD CONSTRAINT dish_price_changes_source_check CHECK (%s)', expression);
END $$;
DROP TABLE IF EXISTS price_catalog_link_ops;
DROP TABLE IF EXISTS price_catalog_links;
DELETE FROM schema_migrations WHERE version = '237_price_catalog_links.sql';
COMMIT;
