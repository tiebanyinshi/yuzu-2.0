-- 回滚 350_visit_remarks.sql（8.1.44 前台备注）。先停服务、先备份；只在回到 8.1.44 以前的版本时执行。
-- 删掉前台备注与撤下记录（旧版本没有备注，不读这两张表）；要留底的先导出这两张表。
BEGIN;
DROP TABLE visit_remark_removals;
DROP TABLE visit_remarks;
DELETE FROM schema_migrations WHERE version = '350_visit_remarks.sql';
COMMIT;
