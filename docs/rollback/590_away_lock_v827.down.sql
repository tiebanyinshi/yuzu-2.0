-- 回滚 600_away_lock_v827.sql（8.2.7 收银台锁牌外出）。先停服务、先备份；只在回到 8.2.7 以前的版本时执行。
-- 还锁着的先在收银台解锁（或等到时间自动解锁）再回滚；锁牌前收的预售是手牌押金，留在 tag_deposits 里照旧（结账时抵扣、能一键退）。
-- 会丢掉：锁牌记录、锁牌与解锁的操作编号与作废登记。
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM visit_tag_locks WHERE released_at IS NULL) THEN
    RAISE EXCEPTION '还有锁着的手牌（锁牌外出），请先在收银台解锁再回滚';
  END IF;
END $$;
ALTER TABLE idempotency_keys DISABLE TRIGGER idempotency_keys_append_only;
DELETE FROM idempotency_keys WHERE op_type IN ('tag_away_lock', 'tag_away_unlock');
ALTER TABLE idempotency_keys ENABLE TRIGGER idempotency_keys_append_only;
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type IN ('tag_away_lock', 'tag_away_unlock');
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
                   replace(expression, ' OR (op_type = ANY (ARRAY[''tag_away_lock''::text, ''tag_away_unlock''::text]))', ''));
  END LOOP;
END $$;
DROP TABLE visit_tag_locks;
DROP FUNCTION yuzu_visit_tag_lock_guard();
DELETE FROM schema_migrations WHERE version = '590_away_lock_v827.sql';
COMMIT;
