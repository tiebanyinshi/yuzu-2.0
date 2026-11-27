-- 回滚 550_frontdesk_guest.sql（8.2.3 前台：客人类别、偏好、客诉台账、高风险推送、补单、技师预约单独一项）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 会丢掉：客人类别与改类别的记录、客人偏好、客诉台账的「已处理」、高风险推送记录、补单的出单员（补单的明细与 backfill_entries 照旧留着，显示成「补录」）。
-- 权限：删掉这一版加的三项建议权限；后台「岗位权限」、个人微调里多出来的「booking.technician」等旧版本不认识，读的时候忽略，不用改。
-- 配置日志（position_config_log）只追加，留着。
BEGIN;
DELETE FROM position_suggestions WHERE permission IN ('booking.technician', 'frontdesk.supplement', 'frontdesk.complaints');
DROP TABLE bill_supplements;
DROP TABLE visit_risk_alerts;
DROP TABLE visit_remark_resolutions;
DROP TABLE guest_preferences;
DROP TABLE visit_category_changes;
ALTER TABLE visits DROP COLUMN guest_category;
DELETE FROM settings WHERE key = 'frontdesk_guest_rules';
DELETE FROM store_settings WHERE key = 'frontdesk_guest_rules';
DELETE FROM schema_migrations WHERE version = '550_frontdesk_guest.sql';
COMMIT;
