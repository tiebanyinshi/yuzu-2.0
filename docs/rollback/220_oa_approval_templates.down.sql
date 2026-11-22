-- 回滚 220_oa_approval_templates.sql（OA-11 六类审批模板）：删请假、加班、出差、报销、补卡五个模板。
-- 已经用它们提交过的单会挡住删除（外键）：那种情况不回滚模板，改成停用（UPDATE oa_approval_templates SET active = false WHERE code IN (...)）。
BEGIN;
DELETE FROM oa_approval_templates WHERE code IN ('leave', 'overtime', 'trip', 'expense', 'makeup');
DELETE FROM schema_migrations WHERE version = '220_oa_approval_templates.sql';
COMMIT;
