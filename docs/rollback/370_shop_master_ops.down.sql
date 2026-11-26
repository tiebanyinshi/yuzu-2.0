-- 回滚 370_shop_master_ops.sql（采购商城 V1.1 主数据维护操作编号与确认作废）。
-- 先停服务、先备份；仅在回退到本迁移以前时执行。
BEGIN;
-- op_fences、idempotency_keys 只追加（001、006 的触发器）：维护性删除时临时关掉对应的触发器，删完马上恢复
ALTER TABLE idempotency_keys DISABLE TRIGGER idempotency_keys_append_only;
DELETE FROM idempotency_keys WHERE op_type = 'shop_master';
ALTER TABLE idempotency_keys ENABLE TRIGGER idempotency_keys_append_only;
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type = 'shop_master';
ALTER TABLE op_fences ENABLE TRIGGER op_fences_append_only;
DO $$
DECLARE
  t text;
  expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression
      FROM pg_constraint
     WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NOT NULL THEN
      expression := replace(expression, ' OR (op_type = ''shop_master''::text)', '');
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)', t, t || '_op_type_check', expression);
    END IF;
  END LOOP;
END $$;
DELETE FROM schema_migrations WHERE version = '370_shop_master_ops.sql';
COMMIT;
