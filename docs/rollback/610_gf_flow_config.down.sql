-- 回滚 610_gf_flow_config.sql（8.2.10 业财法流程与阈值）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 回滚后各类事项都回到内置流程、阈值回到代码里的常量；店主设过的流程与阈值丢掉（操作日志里还有改前改后）。已经提交的单照旧按存好的链审。
BEGIN;
ALTER TABLE gf_flows DROP COLUMN config_version;
DROP TABLE gf_flow_configs;
DELETE FROM gf_settings WHERE key = 'rules';
ALTER TABLE gf_settings DROP CONSTRAINT gf_settings_key_check;
ALTER TABLE gf_settings ADD CONSTRAINT gf_settings_key_check CHECK (key IN ('purchase_dept_id'));
DELETE FROM schema_migrations WHERE version = '610_gf_flow_config.sql';
COMMIT;
