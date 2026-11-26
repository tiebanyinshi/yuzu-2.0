-- 回滚 293_oa_seal_template.sql（员工办公 v1.1 第 4 批：用章审批模板）。
-- 先停服务、先备份；仅在尚无使用该模板的审批单且需回退到第 4 批前执行。

DELETE FROM oa_approval_templates WHERE code = 'seal';
DELETE FROM schema_migrations WHERE version = '293_oa_seal_template.sql';
