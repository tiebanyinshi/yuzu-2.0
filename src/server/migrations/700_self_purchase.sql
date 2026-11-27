-- 8.2.13 采购单可以不选供应商：自购（店主 2026-11-27《采购模块需求补充：单号搜索 / 排序 / 无供应商自购》R3，设计见 docs/V8213_SELF_PURCHASE.md）。
-- 不造「自购」供应商（会弄脏供应商档案、对账与考核）：采购方式 purchase_method 分供应商采购 / 自购，自购时 supplier_id 为空、记自购信息。
-- 风险已知：放开 purchase_orders.supplier_id 的非空约束（旧单都是供应商采购，不回填、不改动）；收货单在挂自购采购单时可以没有供应商。
-- 回滚见 docs/rollback/700_self_purchase.down.sql（有自购单时回滚会失败，先作废或改回）。

ALTER TABLE purchase_orders
  ADD COLUMN purchase_method  text NOT NULL DEFAULT 'supplier' CHECK (purchase_method IN ('supplier', 'self')),
  ADD COLUMN self_reason      text CHECK (self_reason IN ('no_supplier', 'urgent', 'petty', 'other')),
  ADD COLUMN self_reason_note text NOT NULL DEFAULT '' CHECK (char_length(self_reason_note) <= 200),
  ADD COLUMN self_channel     text NOT NULL DEFAULT '' CHECK (char_length(self_channel) <= 100),
  ADD COLUMN self_handler_id  bigint REFERENCES staff (id),
  ADD COLUMN self_pay_method  text CHECK (self_pay_method IN ('employee_advance', 'petty', 'company_transfer', 'other')),
  ADD COLUMN self_bought_on   date;
ALTER TABLE purchase_orders ALTER COLUMN supplier_id DROP NOT NULL;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_method_supplier CHECK ((purchase_method = 'supplier') = (supplier_id IS NOT NULL));
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_self_info CHECK (
  purchase_method <> 'self'
  OR (self_reason IS NOT NULL AND self_channel <> '' AND self_handler_id IS NOT NULL AND self_pay_method IS NOT NULL
      AND (self_reason <> 'other' OR self_reason_note <> ''))
);
CREATE INDEX purchase_orders_self_handler_id_fk_idx ON purchase_orders (self_handler_id);
COMMENT ON COLUMN purchase_orders.purchase_method IS 'supplier 供应商采购（原来的做法）；self 自购：经办人自己买，没有供应商（8.2.13）';
COMMENT ON COLUMN purchase_orders.self_reason IS '自购原因：no_supplier 无供应商可供、urgent 应急、petty 零星采购、other 其他（要写说明）';
COMMENT ON COLUMN purchase_orders.self_channel IS '自购的购买渠道 / 商家名称（自由文字，不是供应商档案）';
COMMENT ON COLUMN purchase_orders.self_pay_method IS '自购付款方式：employee_advance 员工垫付后报销、petty 备用金、company_transfer 对公转账、other 其他';

-- 自购的票据凭证（发票或收据的照片，至少一张；只追加）
CREATE TABLE purchase_order_self_receipts (
  po_id    bigint NOT NULL REFERENCES purchase_orders (id),
  sort_no  integer NOT NULL CHECK (sort_no > 0),
  image_id bigint NOT NULL REFERENCES erp_images (id),
  PRIMARY KEY (po_id, sort_no)
);
CREATE INDEX purchase_order_self_receipts_image_id_fk_idx ON purchase_order_self_receipts (image_id);
CREATE TRIGGER purchase_order_self_receipts_scope BEFORE INSERT ON purchase_order_self_receipts FOR EACH ROW EXECUTE FUNCTION yuzu_image_scope_guard();
COMMENT ON TABLE purchase_order_self_receipts IS '自购采购单的票据凭证（发票或收据照片，8.2.13）';

-- 收货：挂自购采购单的收货单可以没有供应商
ALTER TABLE inv_docs DROP CONSTRAINT inv_docs_check;
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_check CHECK (doc_type <> 'receipt' OR supplier_id IS NOT NULL OR purchase_order_id IS NOT NULL);
