-- 回滚 234_price_catalog_op_fences.sql。先停服务、先备份；先回滚 234，再回滚 233、232、231、230。
-- 删掉价目表的两种作废登记，再把这两个类型从 op_fences 的类型约束里去掉（其余类型照旧）。
BEGIN;
DELETE FROM op_fences WHERE op_type IN ('price_import', 'price_rollback');
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  expression := replace(expression, ' OR (op_type = ANY (ARRAY[''price_import''::text, ''price_rollback''::text]))', '');
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK (%s)', expression);
END $$;
DELETE FROM schema_migrations WHERE version = '234_price_catalog_op_fences.sql';
COMMIT;
