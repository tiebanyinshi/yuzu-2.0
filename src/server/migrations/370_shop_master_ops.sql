-- 采购商城 V1.1 合并前 Codex 审查（586d5b4）：主数据维护（供应商编辑 / 启停、物料编辑 / 启停、物料批量改分类）
-- 统一走操作编号幂等与「确认作废」协议：编号记在 idempotency_keys（shop_master），作废记在 op_fences（shop_master）。
-- 在当时的约束上追加类型（不照旧名单重建，避免覆盖其他分支迁移加入的类型）。
-- 回滚：docs/rollback/370_shop_master_ops.down.sql。

DO $$
DECLARE
  t text;
  expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression
      FROM pg_constraint
     WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN
      RAISE EXCEPTION '找不到 %.%_op_type_check 约束', t, t;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''shop_master''))',
      t,
      t || '_op_type_check',
      expression
    );
  END LOOP;
END $$;
