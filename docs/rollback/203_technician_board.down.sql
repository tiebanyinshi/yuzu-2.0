-- 回滚 203_technician_board.sql（回测整改 P09 技师上钟轮播的建议权限）。先停服务、先备份；只在回到 这一批回测整改以前的版本时执行。
-- 删掉各岗位建议权限里的「技师上钟轮播」；旧版本不认识这一项权限，留着也不生效，删掉只为干净。配置日志只追加，留着。
BEGIN;
DELETE FROM position_suggestions WHERE permission = 'technician.board';
DELETE FROM schema_migrations WHERE version = '203_technician_board.sql';
COMMIT;
