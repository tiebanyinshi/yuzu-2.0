-- 回滚 520_mall_pilot.sql（8.1.51 采购商城试点）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 会丢掉：成交方案、接单人、定制的结构化要求（ERP「规格与技术要求」里那段话还在）、收货的待补数。
BEGIN;
ALTER TABLE inv_doc_lines DROP CONSTRAINT inv_doc_lines_redeliver_le_rejected;
ALTER TABLE inv_doc_lines DROP COLUMN redeliver_milli;
DROP TABLE mall_request_quotes;
-- 报价截图留在 erp_images 里（只追加、按内容去重，改不了也删不掉）：图片范围的约束照旧放行 quote，旧版本不读这一类，不影响
ALTER TABLE purchase_requests DROP COLUMN sourcing_claimed_at;
ALTER TABLE purchase_requests DROP COLUMN sourcing_owner_id;
ALTER TABLE purchase_request_lines DROP COLUMN custom_spec;
ALTER TABLE purchase_request_lines DROP COLUMN custom_kind;
DELETE FROM schema_migrations WHERE version = '520_mall_pilot.sql';
COMMIT;
