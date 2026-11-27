-- 回滚 600_dining_meals_v828.sql（8.2.8 餐厅：含几餐、入口登记、自动折扣）。先停服务、先备份；只在回到 8.2.8 以前的版本时执行。
-- 会丢掉：进餐登记（餐费明细照旧在账单上）；自动折扣改成旧版本认得的样子——还生效的自动折扣撤下（那几行恢复原价，结账前请核对），
-- 已撤下的留着但去掉规则；票种的含几餐；入口登记的操作编号与作废登记。
BEGIN;
-- 单项打折的守卫触发器（530）只许「生效 → 撤下」且账单要开着、档不能改；回滚要改已结账单上的、改档，先停它，最后再开（同一个事务里）
ALTER TABLE bill_line_discounts DISABLE TRIGGER bill_line_discounts_guard;
UPDATE bill_line_discounts SET status = 'revoked', revoked_by = staff_id, revoked_at = now(), revoke_reason = '回滚 8.2.8 撤下自动折扣'
WHERE tier = 'auto' AND status = 'active';
ALTER TABLE bill_line_discounts DROP CONSTRAINT bill_line_discounts_auto_check;
UPDATE bill_line_discounts SET tier = 'cashier', rule = NULL WHERE tier = 'auto';
ALTER TABLE bill_line_discounts DROP COLUMN rule;
ALTER TABLE bill_line_discounts ENABLE TRIGGER bill_line_discounts_guard;
DROP TABLE meal_entries;
DROP FUNCTION yuzu_meal_entry_guard();
ALTER TABLE idempotency_keys DISABLE TRIGGER idempotency_keys_append_only;
DELETE FROM idempotency_keys WHERE op_type = 'meal_entry';
ALTER TABLE idempotency_keys ENABLE TRIGGER idempotency_keys_append_only;
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type = 'meal_entry';
ALTER TABLE op_fences ENABLE TRIGGER op_fences_append_only;
DO $$
DECLARE
  t text;
  expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'bill_line_discounts'::regclass AND conname = 'bill_line_discounts_tier_check';
  ALTER TABLE bill_line_discounts DROP CONSTRAINT bill_line_discounts_tier_check;
  EXECUTE format('ALTER TABLE bill_line_discounts ADD CONSTRAINT bill_line_discounts_tier_check CHECK (%s)', replace(expression, ' OR (tier = ''auto''::text)', ''));
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)', t, t || '_op_type_check', replace(expression, ' OR (op_type = ''meal_entry''::text)', ''));
  END LOOP;
END $$;
ALTER TABLE ticket_types DROP COLUMN meals_24h;
ALTER TABLE ticket_types DROP COLUMN meals_12h;
DELETE FROM schema_migrations WHERE version = '600_dining_meals_v828.sql';
COMMIT;
