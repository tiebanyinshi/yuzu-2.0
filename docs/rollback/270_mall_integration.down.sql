-- 回滚 270_mall_integration.sql。先停服务、先备份。
-- 有商城来的需求单（source = 'mall'）或用了「较急」（high）的单时回滚会失败：先确认这些单怎么处理（店主定），不要直接删。
BEGIN;
CREATE OR REPLACE FUNCTION yuzu_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '需求单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('approved', 'rejected', 'cancelled', 'issued') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION '需求单已结束审核，不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.doc_no, NEW.department_id, NEW.requester_id, NEW.created_at, NEW.client_key)
     IS DISTINCT FROM (OLD.doc_no, OLD.department_id, OLD.requester_id, OLD.created_at, OLD.client_key) THEN
    RAISE EXCEPTION '需求单的单号、部门、提单人不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE purchase_request_lines
  DROP COLUMN tax_rate_bp, DROP COLUMN freight_cents, DROP COLUMN reason_text, DROP COLUMN expected_category,
  DROP COLUMN brand_model, DROP COLUMN price_version, DROP COLUMN mall_sku_code;
ALTER TABLE purchase_request_lines DROP CONSTRAINT purchase_request_lines_applicant_check;
ALTER TABLE purchase_request_lines ADD CONSTRAINT purchase_request_lines_applicant_check CHECK (char_length(applicant) <= 20);
ALTER TABLE purchase_request_lines DROP CONSTRAINT purchase_request_lines_note_check;
ALTER TABLE purchase_request_lines ADD CONSTRAINT purchase_request_lines_note_check CHECK (char_length(note) <= 100);
ALTER TABLE purchase_request_lines DROP CONSTRAINT purchase_request_lines_link_check;
ALTER TABLE purchase_request_lines ADD CONSTRAINT purchase_request_lines_link_check CHECK (char_length(link) <= 500);
ALTER TABLE purchase_request_lines DROP CONSTRAINT purchase_request_lines_details_check;
ALTER TABLE purchase_request_lines ADD CONSTRAINT purchase_request_lines_details_check CHECK (char_length(details) <= 200);
ALTER TABLE purchase_request_lines DROP CONSTRAINT purchase_request_lines_name_check;
ALTER TABLE purchase_request_lines ADD CONSTRAINT purchase_request_lines_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 40);
DROP INDEX purchase_requests_updated_idx;
DROP INDEX purchase_requests_external_no_uq;
ALTER TABLE purchase_requests DROP CONSTRAINT purchase_requests_mall_external;
ALTER TABLE purchase_requests
  DROP COLUMN payment_intent, DROP COLUMN delivery_address, DROP COLUMN budget_project, DROP COLUMN entity_id,
  DROP COLUMN store_id, DROP COLUMN contact_name, DROP COLUMN external_no;
ALTER TABLE purchase_requests DROP CONSTRAINT purchase_requests_note_check;
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_note_check CHECK (char_length(note) <= 200);
ALTER TABLE purchase_requests DROP CONSTRAINT purchase_requests_priority_check;
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_priority_check CHECK (priority IN ('urgent', 'normal'));
ALTER TABLE purchase_requests DROP CONSTRAINT purchase_requests_source_check;
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_source_check CHECK (source IN ('form', 'import', 'sheet'));
DELETE FROM schema_migrations WHERE version = '270_mall_integration.sql';
COMMIT;
