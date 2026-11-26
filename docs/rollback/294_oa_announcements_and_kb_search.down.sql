-- 回滚 294_oa_announcements_and_kb_search.sql（员工办公 v1.1 第 5 批：公司公告）。
-- 先停服务、先备份；仅在回退到第 5 批以前时执行。

DROP TABLE IF EXISTS oa_announcement_reads;
DROP TABLE IF EXISTS oa_announcements;
DELETE FROM position_suggestions WHERE position_key = 'hr.lead' AND permission = 'oa.announce';
DELETE FROM schema_migrations WHERE version = '294_oa_announcements_and_kb_search.sql';
