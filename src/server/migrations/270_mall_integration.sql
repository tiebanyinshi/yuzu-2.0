-- 采购商城 V1.1 对接（店主 2026-11-24，docs/MALL_V8131.md）：商城后端经 /api/erp/mall/* 把部门的采购需求提进 yuzu，生成同一种采购需求单（XQ）。
--   · 需求单：来源多一种「商城」（mall），带商城申请单号（全局唯一，同一笔申请只建一张单）、实际经办人、适用门店、费用承担主体、
--     预算项目、收货地点、拟定支付方式；紧急程度从两档改成三档（urgent 紧急 / high 较急 / normal 普通，对应商城的红 / 黄 / 绿）；备注放宽到 500 字。
--   · 明细行：品名、详情、链接、备注、申请人放宽（商城自主申请写得长）；多商城的 SKU 编码与价格版本、品牌型号、预期分类、采购理由、运费、税率。
--   · 来源、商城单号建了以后不能改（需求单的守卫触发器一起管）。
-- 风险已知：只加列、放宽约束、改写守卫函数（多管两列，原有的判断不变），不删数据、不改账本；回滚见 docs/rollback/270_mall_integration.down.sql。

ALTER TABLE purchase_requests DROP CONSTRAINT purchase_requests_source_check;
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_source_check CHECK (source IN ('form', 'import', 'sheet', 'mall'));

ALTER TABLE purchase_requests DROP CONSTRAINT purchase_requests_priority_check;
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_priority_check CHECK (priority IN ('urgent', 'high', 'normal'));

ALTER TABLE purchase_requests DROP CONSTRAINT purchase_requests_note_check;
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_note_check CHECK (char_length(note) <= 500);

ALTER TABLE purchase_requests
  ADD COLUMN external_no text CHECK (external_no IS NULL OR char_length(btrim(external_no)) BETWEEN 1 AND 64),
  ADD COLUMN contact_name text NOT NULL DEFAULT '' CHECK (char_length(contact_name) <= 40),
  ADD COLUMN store_id bigint REFERENCES stores (id),
  ADD COLUMN entity_id bigint REFERENCES legal_entities (id),
  ADD COLUMN budget_project text NOT NULL DEFAULT '' CHECK (char_length(budget_project) <= 80),
  ADD COLUMN delivery_address text NOT NULL DEFAULT '' CHECK (char_length(delivery_address) <= 120),
  ADD COLUMN payment_intent text CHECK (payment_intent IS NULL OR payment_intent IN ('company_direct', 'dept_petty'));
-- 商城单号只有商城来的单有
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_mall_external CHECK ((source = 'mall') = (external_no IS NOT NULL));
CREATE UNIQUE INDEX purchase_requests_external_no_uq ON purchase_requests (external_no) WHERE external_no IS NOT NULL;
-- 商城按更新时间增量取
CREATE INDEX purchase_requests_updated_idx ON purchase_requests (updated_at DESC, id DESC);

ALTER TABLE purchase_request_lines DROP CONSTRAINT purchase_request_lines_name_check;
ALTER TABLE purchase_request_lines ADD CONSTRAINT purchase_request_lines_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 100);
ALTER TABLE purchase_request_lines DROP CONSTRAINT purchase_request_lines_details_check;
ALTER TABLE purchase_request_lines ADD CONSTRAINT purchase_request_lines_details_check CHECK (char_length(details) <= 1000);
ALTER TABLE purchase_request_lines DROP CONSTRAINT purchase_request_lines_link_check;
ALTER TABLE purchase_request_lines ADD CONSTRAINT purchase_request_lines_link_check CHECK (char_length(link) <= 1000);
ALTER TABLE purchase_request_lines DROP CONSTRAINT purchase_request_lines_note_check;
ALTER TABLE purchase_request_lines ADD CONSTRAINT purchase_request_lines_note_check CHECK (char_length(note) <= 500);
ALTER TABLE purchase_request_lines DROP CONSTRAINT purchase_request_lines_applicant_check;
ALTER TABLE purchase_request_lines ADD CONSTRAINT purchase_request_lines_applicant_check CHECK (char_length(applicant) <= 40);

ALTER TABLE purchase_request_lines
  ADD COLUMN mall_sku_code text NOT NULL DEFAULT '' CHECK (char_length(mall_sku_code) <= 40),
  ADD COLUMN price_version text NOT NULL DEFAULT '' CHECK (char_length(price_version) <= 20),
  ADD COLUMN brand_model text NOT NULL DEFAULT '' CHECK (char_length(brand_model) <= 150),
  ADD COLUMN expected_category text NOT NULL DEFAULT '' CHECK (char_length(expected_category) <= 32),
  ADD COLUMN reason_text text NOT NULL DEFAULT '' CHECK (char_length(reason_text) <= 1000),
  ADD COLUMN freight_cents bigint CHECK (freight_cents IS NULL OR freight_cents >= 0),
  ADD COLUMN tax_rate_bp integer CHECK (tax_rate_bp IS NULL OR tax_rate_bp BETWEEN 0 AND 10000);

-- 守卫：原来的三条照旧；来源、商城单号也不能改
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
  IF (NEW.source, NEW.external_no) IS DISTINCT FROM (OLD.source, OLD.external_no) THEN
    RAISE EXCEPTION '需求单的来源、商城单号不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 进度变动记号（Codex 审查）：采购单改版时解开了与需求行的关联（purchase_order_line_requests 删行；询价的关联只追加，不会删），
-- 需求单本身不变，跟着关联算的「进度最后变动时刻」会往回走，增量同步（updatedSince）就漏了这张单。删关联时记一笔，只追加。
CREATE TABLE purchase_request_progress_marks (
  id bigserial PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES purchase_requests (id),
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX purchase_request_progress_marks_req_idx ON purchase_request_progress_marks (request_id, at);

CREATE OR REPLACE FUNCTION yuzu_request_progress_mark() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO purchase_request_progress_marks (request_id)
  SELECT l.request_id FROM purchase_request_lines l WHERE l.id = OLD.request_line_id;
  RETURN OLD;
END $$;
CREATE TRIGGER purchase_order_line_requests_progress_mark AFTER DELETE ON purchase_order_line_requests
  FOR EACH ROW EXECUTE FUNCTION yuzu_request_progress_mark();

CREATE OR REPLACE FUNCTION yuzu_request_progress_mark_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '进度变动记号只追加' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER purchase_request_progress_marks_guard BEFORE UPDATE OR DELETE ON purchase_request_progress_marks
  FOR EACH ROW EXECUTE FUNCTION yuzu_request_progress_mark_guard();
