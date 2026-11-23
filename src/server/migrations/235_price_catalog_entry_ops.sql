-- 价目表录入：单条新增、修改、停用 / 启用带操作编号（Codex 审查 PR #160；docs/PRICE_CATALOG.md 第 5 节）。
-- 结果不确定（断网、超时、服务器出错）时页面在上方查回、按原内容重新提交或确认作废（/api/erp/ops，类型 price_entry），
-- 同一个编号只记一次：编号写在那一条改动留痕上（price_catalog_changes.op_key）。
-- 作废登记在 op_fences：在当时的约束上追加类型（读出原表达式再 OR 上新类型，写法见 162），不照旧名单重建。

ALTER TABLE price_catalog_changes ADD COLUMN op_key uuid UNIQUE;

DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''price_entry''))', expression);
END $$;
