-- 回滚 440_gf_payment.sql（业财法 P05）：只在没有正式数据时用；先删付款事项再收紧类型约束
DROP TABLE IF EXISTS gf_payouts;
ALTER TABLE gf_specials DROP COLUMN IF EXISTS payee_account;
ALTER TABLE gf_docs DROP CONSTRAINT gf_docs_doc_type_check;
ALTER TABLE gf_docs ADD CONSTRAINT gf_docs_doc_type_check
  CHECK (doc_type IN ('general', 'supplier_admission', 'supplier_change', 'sku_batch', 'sku_price_change', 'petty_purchase', 'quota_adjust', 'contract'));
