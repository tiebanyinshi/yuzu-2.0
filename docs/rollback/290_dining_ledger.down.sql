-- 回滚 290_dining_ledger.sql（8.1.37 餐饮台账的建议权限）。先停服务、先备份；只在回到 8.1.37 以前的版本时执行。
-- 删掉各岗位建议权限里的「餐饮台账」；旧版本不认识这一项权限，留着也不生效，删掉只为干净。配置日志只追加，留着。
BEGIN;
DELETE FROM position_suggestions WHERE permission = 'dining.ledger';
DELETE FROM schema_migrations WHERE version = '290_dining_ledger.sql';
COMMIT;
