-- 回滚 261_hand_tag_generate_ops.sql。先停服务、先备份；先回滚 261，再回滚 260。
-- 删掉批量添加的操作编号表与这一类作废登记，再把这个类型从 op_fences 的类型约束里去掉（其余类型照旧）。已经建的手牌不动。
BEGIN;
DROP TABLE hand_tag_generate_ops;
-- op_fences 只追加（006 的触发器）：维护性删除时临时关掉这一个触发器，删完马上恢复（Codex 审查 PR #191）
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type = 'hand_tag_generate';
ALTER TABLE op_fences ENABLE TRIGGER op_fences_append_only;
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  expression := replace(expression, ' OR (op_type = ''hand_tag_generate''::text)', '');
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK (%s)', expression);
END $$;
DELETE FROM schema_migrations WHERE version = '261_hand_tag_generate_ops.sql';
COMMIT;
