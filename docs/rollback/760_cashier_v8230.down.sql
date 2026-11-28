-- 回滚 760_cashier_v8230.sql（8.2.30 收银合并：港元现金、班次的港元、收银申请）。先停服务、先备份；只在回到 8.2.30 以前的版本时执行。
-- 收过港元的结账单回滚后照旧是一笔人民币现金（金额不变），只丢掉实给的港元、汇率与找零；收过港元、还没交班的班次先交班再回滚
-- （回滚后旧版本按人民币算应有现金，钱箱里的港元对不上）。
-- 会丢掉：港元的记录、交班时的应有 / 实点港元、交班盲点先提交的实点、收银申请（批准时开的退款单、做的反结账照旧留着）与它们的操作编号和作废登记。
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shifts s WHERE s.status = 'open' AND EXISTS (
       SELECT 1 FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id WHERE c.shift_id = s.id AND p.fx_currency IS NOT NULL)) THEN
    RAISE EXCEPTION '还有收过港元、没交班的班次，请先交班再回滚';
  END IF;
END $$;
ALTER TABLE idempotency_keys DISABLE TRIGGER idempotency_keys_append_only;
DELETE FROM idempotency_keys WHERE op_type IN ('cashier_request', 'cashier_void_approve');
ALTER TABLE idempotency_keys ENABLE TRIGGER idempotency_keys_append_only;
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type IN ('cashier_request', 'cashier_void_approve');
ALTER TABLE op_fences ENABLE TRIGGER op_fences_append_only;
DO $$
DECLARE
  t text;
  expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)', t, t || '_op_type_check',
                   replace(expression, ' OR (op_type = ANY (ARRAY[''cashier_request''::text, ''cashier_void_approve''::text]))', ''));
  END LOOP;
END $$;
DROP TABLE cashier_requests;
DROP TABLE shift_blind_counts;
DROP FUNCTION yuzu_shift_blind_count_guard();
DROP FUNCTION yuzu_cashier_request_guard();
ALTER TABLE shifts DROP COLUMN expected_hkd, DROP COLUMN counted_hkd;
CREATE OR REPLACE FUNCTION yuzu_shift_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  close_cols constant text[] := ARRAY['status', 'ended_at', 'expected_cash', 'counted_cash', 'summary', 'note', 'handed_to', 'closed_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '班次记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (OLD.status = 'open' AND NEW.status = 'closed')
     OR (to_jsonb(NEW) - close_cols) <> (to_jsonb(OLD) - close_cols) THEN
    RAISE EXCEPTION '班次只能交班一次，交班后不能修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_fx_check;
ALTER TABLE checkout_payments DROP COLUMN fx_currency, DROP COLUMN fx_tendered, DROP COLUMN fx_rate_ppm, DROP COLUMN fx_worth, DROP COLUMN fx_change;
DELETE FROM schema_migrations WHERE version = '760_cashier_v8230.sql';
COMMIT;
