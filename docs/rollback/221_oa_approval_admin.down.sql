-- 回滚 221_oa_approval_admin.sql（OA-12 审批管理端）：去掉两项权限的建议权限。已经按岗位给出去的权限（position_permissions）不动，由店主在「岗位权限」里收回。
BEGIN;
DELETE FROM position_suggestions WHERE permission IN ('oa.templates', 'oa.all');
DELETE FROM schema_migrations WHERE version = '221_oa_approval_admin.sql';
COMMIT;
