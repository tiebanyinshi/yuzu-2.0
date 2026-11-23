-- 回滚 236_price_catalog_set_ops_more.sql。先停服务、先备份；先回滚 236，再回滚 235…230。
-- 删掉切换生效、放弃草稿的操作编号与这一类作废登记，price_catalog_set_ops 回到只记整体回滚，op_fences 去掉 price_set。
BEGIN;
DELETE FROM op_fences WHERE op_type = 'price_set';
DELETE FROM price_catalog_set_ops WHERE action <> 'rollback';
ALTER TABLE price_catalog_set_ops DROP CONSTRAINT price_catalog_set_ops_action_check;
ALTER TABLE price_catalog_set_ops ADD CONSTRAINT price_catalog_set_ops_action_check CHECK (action IN ('rollback'));
ALTER TABLE price_catalog_set_ops ALTER COLUMN from_set_id SET NOT NULL;
ALTER TABLE price_catalog_set_ops ALTER COLUMN to_set_id SET NOT NULL;
ALTER TABLE price_catalog_set_ops ADD CONSTRAINT price_catalog_set_ops_from_set_id_fkey FOREIGN KEY (from_set_id) REFERENCES price_catalog_sets (id);
ALTER TABLE price_catalog_set_ops ADD CONSTRAINT price_catalog_set_ops_to_set_id_fkey FOREIGN KEY (to_set_id) REFERENCES price_catalog_sets (id);
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  expression := replace(expression, ' OR (op_type = ''price_set''::text)', '');
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK (%s)', expression);
END $$;
DELETE FROM schema_migrations WHERE version = '236_price_catalog_set_ops_more.sql';
COMMIT;
