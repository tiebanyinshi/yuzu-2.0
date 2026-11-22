-- OA-01 的回滚脚本（docs/OA.md 第 4 节）：撤掉 210_oa_org.sql 加的员工档案、部门的上级与主管、hr.org 的建议权限。
-- 用法：先按 docs/RELEASE_V800.md 回滚到 OA-01 以前的版本（代码），再在数据库里执行这一份：
--   psql "$DATABASE_URL" -f docs/rollback/210_oa_org.down.sql
-- 回滚以后的兼容：账号、岗位、权限都没动过；员工档案（工号、手机号、入职 / 离职日期）会丢——回滚前在后台「组织架构」导出或另存一份。
-- 办过离职的员工账号照旧是停用的（停用记在账号上，不在这张表里）。

BEGIN;
DELETE FROM position_suggestions WHERE permission = 'hr.org';
DROP TABLE IF EXISTS staff_profiles;
ALTER TABLE org_departments DROP CONSTRAINT IF EXISTS org_departments_parent_not_self;
ALTER TABLE org_departments DROP COLUMN IF EXISTS version;
ALTER TABLE org_departments DROP COLUMN IF EXISTS head_staff_id;
ALTER TABLE org_departments DROP COLUMN IF EXISTS parent_key;
DELETE FROM schema_migrations WHERE version = '210_oa_org.sql';
COMMIT;
