-- 8.2.17 报销统一成一套（店主 2026-11-27《业财法审批与 WCP 模块 需求变更》7.2，WB11，设计见 docs/V8217_EXPENSE_UNIFY.md）：
-- WCP「审批」里的报销模板停用，新报销都在「业财法审批 → 报销」发起（WCP 是发起 / 查看入口，业财法是审批规则与执行后台）。
-- 已经提的 WCP 报销不合并、不改：在审的照旧在原来的审批里走完，历史照旧能看、能导出（WB11、7.2「不做静默合并」）。
-- 回滚见 docs/rollback/730_oa_expense_retire.down.sql。

UPDATE oa_approval_templates
   SET active = false,
       description = '报销已统一到「业财法审批 → 报销」（8.2.17），这里不再发起',
       updated_at = now()
 WHERE code = 'expense';
