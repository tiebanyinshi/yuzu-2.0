-- 回滚 322_gift_card_batch_ops.sql。先停服务、先备份；先回滚 322，再回滚 321。
-- 删掉「生成礼品卡」这一类作废登记，再把这个类型从 op_fences 的类型约束里去掉（其余类型照旧）。已经生成的礼品卡不动。
BEGIN;
-- op_fences 只追加（006 的触发器）：维护性删除时临时关掉这一个触发器，删完马上恢复
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type = 'gift_card_batch';
ALTER TABLE op_fences ENABLE TRIGGER op_fences_append_only;
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  expression := replace(expression, ' OR (op_type = ''gift_card_batch''::text)', '');
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK (%s)', expression);
END $$;
DELETE FROM schema_migrations WHERE version = '322_gift_card_batch_ops.sql';
COMMIT;
