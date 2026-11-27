-- 回滚 700_self_purchase.sql（8.2.13 自购）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 有自购单或没有供应商的收货单时会失败（旧版本要求都有供应商）：先撤回、作废这些单据。
BEGIN;
ALTER TABLE inv_docs DROP CONSTRAINT inv_docs_check;
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_check CHECK (doc_type <> 'receipt' OR supplier_id IS NOT NULL);
DROP TABLE purchase_order_self_receipts;
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_self_info;
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_method_supplier;
ALTER TABLE purchase_orders ALTER COLUMN supplier_id SET NOT NULL;
ALTER TABLE purchase_orders
  DROP COLUMN self_bought_on,
  DROP COLUMN self_pay_method,
  DROP COLUMN self_handler_id,
  DROP COLUMN self_channel,
  DROP COLUMN self_reason_note,
  DROP COLUMN self_reason,
  DROP COLUMN purchase_method;
DELETE FROM schema_migrations WHERE version = '700_self_purchase.sql';
COMMIT;
