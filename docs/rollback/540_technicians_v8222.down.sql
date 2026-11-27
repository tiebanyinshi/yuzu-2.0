-- 回滚 540_technicians_v8222.sql（8.2.2 技师）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 会丢掉：扩钟（改记成点钟）、加钟标记、挂账时的星级、换项目记录、休假单的自动上牌、技师的手机身高体重星级、
-- 各店自己保存的提成规则（只留全公司一份的）、每月业绩任务、预约的手牌号。
BEGIN;
-- 扩钟改回点钟（原来的约束只认点钟、轮钟）。明细有保护触发器：维护性改动时临时关掉，改完马上恢复
ALTER TABLE bill_lines DISABLE TRIGGER bill_lines_guard;
UPDATE bill_lines SET call_type = 'designated' WHERE call_type = 'call';
ALTER TABLE bill_lines ENABLE TRIGGER bill_lines_guard;
UPDATE technician_sessions SET call_type = 'designated' WHERE call_type = 'call';
ALTER TABLE bill_lines DROP CONSTRAINT bill_lines_call_type_check;
ALTER TABLE bill_lines ADD CONSTRAINT bill_lines_call_type_check CHECK (call_type IN ('designated', 'rotation'));
ALTER TABLE technician_sessions DROP CONSTRAINT technician_sessions_call_type_check;
ALTER TABLE technician_sessions ADD CONSTRAINT technician_sessions_call_type_check CHECK (call_type IN ('designated', 'rotation'));
ALTER TABLE bill_lines DROP COLUMN clock_extension;
ALTER TABLE bill_lines DROP COLUMN tech_star;
-- 钟房日志：换项目的记录删掉，约束去掉 540 追加的那一段
ALTER TABLE technician_events DISABLE TRIGGER technician_events_append_only;
DELETE FROM technician_events WHERE kind = 'change';
ALTER TABLE technician_events ENABLE TRIGGER technician_events_append_only;
DO $$
DECLARE
  expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint
   WHERE conrelid = 'technician_events'::regclass AND conname = 'technician_events_kind_check';
  ALTER TABLE technician_events DROP CONSTRAINT technician_events_kind_check;
  EXECUTE format('ALTER TABLE technician_events ADD CONSTRAINT technician_events_kind_check CHECK (%s)', replace(expression, ' OR (kind = ''change''::text)', ''));
END $$;
DROP TABLE technician_session_changes;
DROP INDEX technician_leaves_return_idx;
ALTER TABLE technician_leaves DROP COLUMN auto_return;
ALTER TABLE technician_leaves DROP COLUMN returned_at;
ALTER TABLE technicians DROP COLUMN phone;
ALTER TABLE technicians DROP COLUMN height_cm;
ALTER TABLE technicians DROP COLUMN weight_kg;
ALTER TABLE technicians DROP COLUMN star;
-- 各店自己的提成规则（只追加的表：维护性删除时临时关掉触发器）
ALTER TABLE commission_rule_versions DISABLE TRIGGER commission_rule_versions_append_only;
DELETE FROM commission_rule_versions WHERE store_id IS NOT NULL;
ALTER TABLE commission_rule_versions ENABLE TRIGGER commission_rule_versions_append_only;
ALTER TABLE commission_rule_versions DROP COLUMN store_id;
DROP TABLE technician_targets;
ALTER TABLE bookings DROP COLUMN tag_code;
-- 两项建议权限删掉（配置日志只追加，留着）
DELETE FROM position_suggestions WHERE permission = 'technician.voidLate';
DELETE FROM position_suggestions WHERE position_key = 'finance.lead' AND permission = 'report.technicians';
DELETE FROM schema_migrations WHERE version = '540_technicians_v8222.sql';
COMMIT;
