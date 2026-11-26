-- 回滚 520_mall_pilot.sql（8.1.51 采购商城试点）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 会丢掉：成交方案、接单人、定制的结构化要求（ERP「规格与技术要求」里那段话还在）、收货的待补数。
BEGIN;
-- 记方案、补资料重提、选定 / 撤下方案的操作编号与作废（只追加的表：维护性删除时临时关掉触发器，删完马上恢复）
ALTER TABLE idempotency_keys DISABLE TRIGGER idempotency_keys_append_only;
DELETE FROM idempotency_keys WHERE op_type IN ('mall_quote', 'mall_resubmit', 'mall_quote_act');
ALTER TABLE idempotency_keys ENABLE TRIGGER idempotency_keys_append_only;
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type IN ('mall_quote', 'mall_resubmit', 'mall_quote_act');
ALTER TABLE op_fences ENABLE TRIGGER op_fences_append_only;
-- 操作类型的约束去掉 520 追加的那一段（与 370 的回滚同一写法），再迁移时结构与第一次一样
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
      expression := replace(expression, ' OR (op_type = ANY (ARRAY[''mall_quote''::text, ''mall_resubmit''::text, ''mall_quote_act''::text]))', '');
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)', t, t || '_op_type_check', expression);
    END IF;
  END LOOP;
END $$;
ALTER TABLE inv_doc_lines DROP CONSTRAINT inv_doc_lines_redeliver_le_rejected;
ALTER TABLE inv_doc_lines DROP COLUMN redeliver_milli;
DROP TABLE mall_request_quotes;
-- 报价截图留在 erp_images 里（只追加、按内容去重，改不了也删不掉）：图片范围的约束照旧放行 quote，旧版本不读这一类，不影响
DROP TABLE mall_request_sourcing;
ALTER TABLE purchase_request_lines DROP COLUMN custom_spec;
ALTER TABLE purchase_request_lines DROP COLUMN custom_kind;
DELETE FROM schema_migrations WHERE version = '520_mall_pilot.sql';
COMMIT;
