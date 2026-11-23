-- 回滚 225_oa_payroll.sql（OA-17 工资条模板与制表）：删掉工资条模板、工资表、工资条、加密的原件与薪资审计，去掉 payroll.manage 的建议权限。
-- 工资表的数据会一起删掉：回滚前先备份（docs/COMMANDS.md「备份与回滚」）。
BEGIN;
DROP TABLE IF EXISTS oa_payroll_audit;
DROP TABLE IF EXISTS oa_payroll_files;
DROP TABLE IF EXISTS oa_payslips;
DROP TABLE IF EXISTS oa_payroll_batches;
DROP TABLE IF EXISTS oa_payslip_templates;
DELETE FROM position_suggestions WHERE permission = 'payroll.manage';
DELETE FROM schema_migrations WHERE version = '225_oa_payroll.sql';
COMMIT;
