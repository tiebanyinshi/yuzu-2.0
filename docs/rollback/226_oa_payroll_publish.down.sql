-- 回滚 226_oa_payroll_publish.sql（OA-18 发放、签收与薪资安全审计）：去掉发放、提醒、签收、查看的列与「工资条异议」模板。
-- 已发放的工资表回滚后会违反 status 约束：回滚前先把它们改回草稿或作废，并备份（docs/COMMANDS.md「备份与回滚」）。
-- 「工资条异议」模板只在还没有用它提交的单时才能删。
BEGIN;
DELETE FROM oa_approval_templates WHERE code = 'payslip_objection' AND NOT EXISTS (SELECT 1 FROM oa_approvals a WHERE a.template_id = oa_approval_templates.id);
DROP INDEX IF EXISTS oa_payslips_staff_signed_idx;
ALTER TABLE oa_payslips DROP COLUMN IF EXISTS signed_at, DROP COLUMN IF EXISTS viewed_at;
ALTER TABLE oa_payroll_batches DROP CONSTRAINT IF EXISTS oa_payroll_batches_published,
  DROP COLUMN IF EXISTS published_at, DROP COLUMN IF EXISTS published_by, DROP COLUMN IF EXISTS reminded_at;
DELETE FROM schema_migrations WHERE version = '226_oa_payroll_publish.sql';
COMMIT;
