-- 回滚 211_oa_staff_import.sql（OA-02 账号与批量开通）。先停服务、先备份；只在回到 OA-02 以前的版本时执行。
-- 删掉批量开通的记录表。开好的账号与员工档案照旧在（只是查不到「是哪一次批量开通的」）。
-- oa_staff_import 这一类操作编号与作废登记留着（只追加的记录不删）；约束里多出的一类不影响旧版本。
BEGIN;
DROP TABLE IF EXISTS oa_staff_imports;
DELETE FROM schema_migrations WHERE version = '211_oa_staff_import.sql';
COMMIT;
