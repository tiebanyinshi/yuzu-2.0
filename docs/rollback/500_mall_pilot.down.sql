-- 回滚 500_mall_pilot.sql（8.1.49 采购商城试点）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 会丢掉：成交方案、接单人、定制的结构化要求（ERP「规格与技术要求」里那段话还在）、收货的待补数。
BEGIN;
ALTER TABLE inv_doc_lines DROP CONSTRAINT inv_doc_lines_redeliver_le_rejected;
ALTER TABLE inv_doc_lines DROP COLUMN redeliver_milli;
DROP TABLE mall_request_quotes;
ALTER TABLE purchase_requests DROP COLUMN sourcing_claimed_at;
ALTER TABLE purchase_requests DROP COLUMN sourcing_owner_id;
ALTER TABLE purchase_request_lines DROP COLUMN custom_spec;
ALTER TABLE purchase_request_lines DROP COLUMN custom_kind;
DELETE FROM schema_migrations WHERE version = '500_mall_pilot.sql';
COMMIT;
