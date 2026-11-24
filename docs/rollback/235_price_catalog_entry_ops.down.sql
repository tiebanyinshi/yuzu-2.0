-- 回滚 235_price_catalog_entry_ops.sql。先停服务、先备份；先回滚 235，再回滚 234、233、232、231、230。
-- 删掉单条改动的操作编号与这一类作废登记，再把 price_entry 从 op_fences 的类型约束里去掉（其余类型照旧）。
BEGIN;
-- op_fences、idempotency_keys 只追加（001、006 的触发器）：维护性删除时临时关掉对应的触发器，删完马上恢复（不然有记录的库上回滚会整笔失败）
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type = 'price_entry';
ALTER TABLE op_fences ENABLE TRIGGER op_fences_append_only;
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  expression := replace(expression, ' OR (op_type = ''price_entry''::text)', '');
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK (%s)', expression);
END $$;
ALTER TABLE price_catalog_changes DROP COLUMN IF EXISTS op_key;
DELETE FROM schema_migrations WHERE version = '235_price_catalog_entry_ops.sql';
COMMIT;
