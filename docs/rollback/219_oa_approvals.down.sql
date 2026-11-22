-- 回滚 219_oa_approvals.sql（OA-10 审批引擎）：删办公审批的五张表；挂在审批单上的附件（oa_attachments，ref_type = 'oa_approval'）一并删掉。
-- 操作编号与确认作废的类型约束里多出的 oa_approval_submit、oa_approval_act 留着（不影响旧代码）。
BEGIN;
DELETE FROM oa_attachments WHERE ref_type = 'oa_approval';
DROP TABLE IF EXISTS oa_approval_cc;
DROP TABLE IF EXISTS oa_approval_events;
DROP TABLE IF EXISTS oa_approval_steps;
DROP TABLE IF EXISTS oa_approvals;
DROP TABLE IF EXISTS oa_approval_templates;
DELETE FROM schema_migrations WHERE version = '219_oa_approvals.sql';
COMMIT;
