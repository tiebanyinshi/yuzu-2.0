-- 回滚 430_gf_contract.sql（业财法 P04）：只在没有正式数据时用；先删合同事项再收紧类型约束
DROP TABLE IF EXISTS gf_contract_versions;
ALTER TABLE gf_docs DROP CONSTRAINT gf_docs_doc_type_check;
ALTER TABLE gf_docs ADD CONSTRAINT gf_docs_doc_type_check
  CHECK (doc_type IN ('general', 'supplier_admission', 'supplier_change', 'sku_batch', 'sku_price_change', 'petty_purchase', 'quota_adjust'));
