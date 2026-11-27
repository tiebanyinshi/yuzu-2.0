-- 回滚 580_mall_dispatch.sql（8.2.6 采购商城 v0.2）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 会丢掉：发配记录（领料单本身还在库存单据里）、退回的必补项、版本快照、终止申请记录、收货的待判数量。
BEGIN;
ALTER TABLE idempotency_keys DISABLE TRIGGER idempotency_keys_append_only;
DELETE FROM idempotency_keys WHERE op_type IN ('request_dispatch', 'mall_terminate');
ALTER TABLE idempotency_keys ENABLE TRIGGER idempotency_keys_append_only;
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type IN ('request_dispatch', 'mall_terminate');
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
      expression := replace(expression, ' OR (op_type = ANY (ARRAY[''request_dispatch''::text, ''mall_terminate''::text]))', '');
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)', t, t || '_op_type_check', expression);
    END IF;
  END LOOP;
END $$;
ALTER TABLE inv_doc_lines DROP COLUMN hold_milli;
DROP TABLE request_terminations;
DROP TABLE purchase_request_versions;
DROP TABLE request_fix_items;
DROP TABLE request_line_issues;
DELETE FROM schema_migrations WHERE version = '580_mall_dispatch.sql';
COMMIT;
