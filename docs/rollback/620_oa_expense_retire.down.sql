-- 回滚 620_oa_expense_retire.sql（8.2.12 报销统一）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 回滚后 WCP「审批」里又能发起报销（又有两套报销入口）。
BEGIN;
UPDATE oa_approval_templates SET active = true, description = '发票至少一张；超过 5000 元加签总经办', updated_at = now() WHERE code = 'expense';
DELETE FROM schema_migrations WHERE version = '620_oa_expense_retire.sql';
COMMIT;
