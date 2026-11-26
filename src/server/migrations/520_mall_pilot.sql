-- 8.1.51 采购商城试点（店主 2026-11-26：自主申请分定制 / 非定制、退回后在原单补资料、供应链 BP 从需求池接单并把成交方案记回系统、
-- 到货按合格数入库并记拒收与待补；设计见 docs/MALL_V8151.md）。
-- 风险已知：只加列、加一张表，不改已有数据；回滚见 docs/rollback/520_mall_pilot.down.sql。

-- 自主申请的一行是「非定制」（商城里没有的现成品）还是「定制」；定制的尺寸、材质工艺、使用场景、打样、预算存结构化的一份（商城页面回显、改单用），
-- ERP 看的「规格与技术要求」里同时写成一段话
ALTER TABLE purchase_request_lines ADD COLUMN custom_kind text CHECK (custom_kind IN ('standard', 'custom'));
ALTER TABLE purchase_request_lines ADD COLUMN custom_spec jsonb CHECK (custom_spec IS NULL OR jsonb_typeof(custom_spec) = 'object');
COMMENT ON COLUMN purchase_request_lines.custom_kind IS '商城自主申请：standard 非定制（现成品）/ custom 定制；选品的行为空（8.1.51）';
COMMENT ON COLUMN purchase_request_lines.custom_spec IS '定制的结构化要求：size 尺寸规格、craft 材质工艺、scene 使用场景、sample 是否打样、budgetCents 预算（8.1.51）';

-- 需求池接单：哪位供应链 BP 在跟这张单
ALTER TABLE purchase_requests ADD COLUMN sourcing_owner_id bigint REFERENCES staff (id);
ALTER TABLE purchase_requests ADD COLUMN sourcing_claimed_at timestamptz;
COMMENT ON COLUMN purchase_requests.sourcing_owner_id IS '接单跟进的供应链 BP（商城需求池「接单」，8.1.51）';
COMMENT ON COLUMN purchase_requests.sourcing_claimed_at IS '接单时间';

-- 成交方案：BP 在微信上跟供应商谈好的，回到系统记下供应商、含税单价、运费、交期、报价截图；部门在系统里确认（或 BP 记「已在微信确认」）。
-- 部门看得到方案说明、供应商、交期，看不到价格与报价截图（店主 2026-11-24：成交价不给商城）。转采购单时带上选定方案的供应商与单价
CREATE TABLE mall_request_quotes (
  id              bigserial PRIMARY KEY,
  request_id      bigint NOT NULL REFERENCES purchase_requests (id),
  line_id         bigint NOT NULL REFERENCES purchase_request_lines (id),
  client_key      uuid NOT NULL UNIQUE,
  supplier_id     bigint REFERENCES suppliers (id),
  supplier_name   text NOT NULL CHECK (length(supplier_name) BETWEEN 1 AND 80),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  tax_rate_bp     integer NOT NULL CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  freight_cents   integer NOT NULL DEFAULT 0 CHECK (freight_cents >= 0),
  lead_days       integer NOT NULL CHECK (lead_days BETWEEN 0 AND 365),
  valid_until     date,
  plan_note       text NOT NULL DEFAULT '' CHECK (length(plan_note) <= 500),
  internal_note   text NOT NULL DEFAULT '' CHECK (length(internal_note) <= 500),
  image_ids       bigint[] NOT NULL DEFAULT '{}' CHECK (cardinality(image_ids) <= 9),
  recommended     boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'selected', 'withdrawn')),
  selected_mode   text CHECK (selected_mode IN ('dept', 'wechat')),
  selected_by     bigint REFERENCES staff (id),
  selected_at     timestamptz,
  selected_note   text NOT NULL DEFAULT '' CHECK (length(selected_note) <= 200),
  created_by      bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'selected') = (selected_at IS NOT NULL AND selected_mode IS NOT NULL AND selected_by IS NOT NULL))
);
CREATE INDEX mall_request_quotes_request_id_fk_idx ON mall_request_quotes (request_id);
CREATE INDEX mall_request_quotes_line_id_fk_idx ON mall_request_quotes (line_id);
CREATE INDEX mall_request_quotes_supplier_id_fk_idx ON mall_request_quotes (supplier_id) WHERE supplier_id IS NOT NULL;
-- 一行最多一个选定的方案
CREATE UNIQUE INDEX mall_request_quotes_one_selected ON mall_request_quotes (line_id) WHERE status = 'selected';
COMMENT ON TABLE mall_request_quotes IS '商城需求的成交方案（8.1.51）：供应链 BP 记下的供应商、含税单价、运费、交期与报价截图；部门确认或 BP 记已在微信确认后为 selected，转采购单时带上';
COMMENT ON COLUMN mall_request_quotes.unit_price_cents IS '含税单价（分，每个需求单位）；部门看不到';
COMMENT ON COLUMN mall_request_quotes.plan_note IS '给部门看的方案说明（规格、材质、样品情况等）';
COMMENT ON COLUMN mall_request_quotes.internal_note IS '只给采购看的备注（谈价过程等）';
COMMENT ON COLUMN mall_request_quotes.image_ids IS '报价截图、样品照片（erp_images；只给采购看）';
COMMENT ON COLUMN mall_request_quotes.selected_mode IS 'dept 部门在系统里确认；wechat BP 记已在微信上确认';

-- 收货：拒收的数量里，供应商要补发的（待补）有多少；其余是退回不补
ALTER TABLE inv_doc_lines ADD COLUMN redeliver_milli bigint NOT NULL DEFAULT 0 CHECK (redeliver_milli >= 0);
ALTER TABLE inv_doc_lines ADD CONSTRAINT inv_doc_lines_redeliver_le_rejected CHECK (redeliver_milli <= coalesce(rejected_milli, 0));
COMMENT ON COLUMN inv_doc_lines.redeliver_milli IS '收货拒收里供应商要补发的数量（待补，库存单位千分；不超过拒收数，8.1.51）';
