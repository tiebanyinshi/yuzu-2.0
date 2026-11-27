-- 回滚 570_review_v825.sql（8.2.5：一报多的预约标记、返台进「结果待确认」）。先停服务、先备份；只在回到 8.2.5 以前的版本时执行。
-- 会丢掉：一报多预约的标记（预约照旧在，自检会把一报多的重叠报出来，与 8.2.4 一样）；返台的操作编号与作废登记
-- （返台记录 table_session_returns 照旧在，旧版本按那里认重提）。
BEGIN;
ALTER TABLE idempotency_keys DISABLE TRIGGER idempotency_keys_append_only;
DELETE FROM idempotency_keys WHERE op_type = 'table_return';
ALTER TABLE idempotency_keys ENABLE TRIGGER idempotency_keys_append_only;
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type = 'table_return';
ALTER TABLE op_fences ENABLE TRIGGER op_fences_append_only;
-- 操作类型约束：只去掉 570 追加的那一段（别的版本追加的照留）
DO $$
DECLARE
  t text;
  expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)', t, t || '_op_type_check', replace(expression, ' OR (op_type = ''table_return''::text)', ''));
  END LOOP;
END $$;
ALTER TABLE bookings DROP COLUMN technician_overlap;
DELETE FROM schema_migrations WHERE version = '570_review_v825.sql';
COMMIT;
