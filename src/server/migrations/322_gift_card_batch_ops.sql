-- 8.1.40 合并前 Codex 审查 8a7023d：生成礼品卡一批也要有「结果待确认」——回复丢了，按原编号查回、原样重提（返回第一次那批，不会再建一批）或确认作废。
-- 编号记在批次上（gift_card_batches.client_key，迁移 321），不进 idempotency_keys；作废登记在 op_fences：在当时的约束上追加类型（写法同 261）。

DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''gift_card_batch''))', expression);
END $$;
