-- 价目表录入：切换生效、放弃草稿也带操作编号（Codex 审查 PR #160；docs/PRICE_CATALOG.md 第 5 节）。
-- 与整体回滚同一张表 price_catalog_set_ops：结果不确定原样重提什么都不改、返回现在的样子；页面查回、重提或确认作废
-- （/api/erp/ops，类型 price_set）。放弃的草稿连同数据集一起删掉，所以两个数据集编号改成可以为空、不再引用数据集
-- （编号照样留着，便于对审计）。作废登记在 op_fences：在当时的约束上追加类型（写法见 162）。

ALTER TABLE price_catalog_set_ops DROP CONSTRAINT price_catalog_set_ops_action_check;
ALTER TABLE price_catalog_set_ops ADD CONSTRAINT price_catalog_set_ops_action_check CHECK (action IN ('rollback', 'activate', 'discard'));
ALTER TABLE price_catalog_set_ops DROP CONSTRAINT price_catalog_set_ops_from_set_id_fkey;
ALTER TABLE price_catalog_set_ops DROP CONSTRAINT price_catalog_set_ops_to_set_id_fkey;
ALTER TABLE price_catalog_set_ops ALTER COLUMN from_set_id DROP NOT NULL;
ALTER TABLE price_catalog_set_ops ALTER COLUMN to_set_id DROP NOT NULL;

DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''price_set''))', expression);
END $$;
