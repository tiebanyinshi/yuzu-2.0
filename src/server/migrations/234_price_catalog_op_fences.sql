-- 价目表录入：导入草稿、整体回滚接上「结果待确认」（Codex 审查 PR #160；docs/PRICE_CATALOG.md）。
-- 页面提交前把操作编号与原请求存在本机，结果不确定时查回、按原内容重新提交或确认作废（/api/erp/ops，与空间台账导入同一套）。
-- 作废登记在 op_fences：在当时的约束上追加两个类型（读出原表达式再 OR 上新类型，写法见 162），不照旧名单重建。

DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''price_import'', ''price_rollback''))', expression);
END $$;
