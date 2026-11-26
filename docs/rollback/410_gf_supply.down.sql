-- 回滚 410_gf_supply.sql（业财法 P02）：只在没有正式数据时用；先删 P02 的事项再收紧类型约束
DROP TABLE IF EXISTS gf_sku_prices;
DROP TABLE IF EXISTS gf_skus;
DROP TABLE IF EXISTS gf_supplier_versions;
DROP TABLE IF EXISTS gf_suppliers;
DROP TABLE IF EXISTS gf_materials;
ALTER TABLE gf_docs DROP CONSTRAINT gf_docs_doc_type_check;
ALTER TABLE gf_docs ADD CONSTRAINT gf_docs_doc_type_check CHECK (doc_type IN ('general'));
