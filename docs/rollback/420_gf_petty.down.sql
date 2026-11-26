-- 回滚 420_gf_petty.sql（业财法 P03）：只在没有正式数据时用；先删 P03 的事项再收紧类型约束
DROP TABLE IF EXISTS gf_overdue_reviews;
DROP TABLE IF EXISTS gf_quota_specials;
DROP TABLE IF EXISTS gf_quota_ledger;
DROP TABLE IF EXISTS gf_dept_quotas;
DROP TABLE IF EXISTS gf_settings;
ALTER TABLE gf_docs DROP CONSTRAINT gf_docs_doc_type_check;
ALTER TABLE gf_docs ADD CONSTRAINT gf_docs_doc_type_check CHECK (doc_type IN ('general', 'supplier_admission', 'supplier_change', 'sku_batch', 'sku_price_change'));
