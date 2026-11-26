-- 410 业财法 P02：供应商与商品 SKU 两级库（docs/APPROVAL_V4.md 第 6 节）。
--   · gf_materials：集团物料（SKU 映射到它）；
--   · gf_suppliers：一级供应商库，统一社会信用代码唯一；状态 待准入 / 审核中 / 已入库 / 停用 / 退出；历史迁移的标 legacy，先进待审；
--   · gf_supplier_versions：供应商每次入库、核心或一般变更通过后的快照（只追加），历史单据记着当时的版本；
--   · gf_skus：二级 SKU，归属供应商、映射集团物料，适用经营主体与业态；gf_sku_prices：协议价版本（只追加）；
--   · gf_docs 的事项类型加 supplier_admission（入库）、supplier_change（变更）、sku_batch（SKU 批量提报）、sku_price_change（协议价变更）。

DO $$
BEGIN
  ALTER TABLE gf_docs DROP CONSTRAINT gf_docs_doc_type_check;
  ALTER TABLE gf_docs ADD CONSTRAINT gf_docs_doc_type_check
    CHECK (doc_type IN ('general', 'supplier_admission', 'supplier_change', 'sku_batch', 'sku_price_change'));
END $$;

CREATE TABLE gf_materials (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,30}$'),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  category    text NOT NULL CHECK (category IN ('general', 'food', 'engineering', 'equipment', 'chemical', 'service')),
  unit        text NOT NULL CHECK (char_length(unit) BETWEEN 1 AND 10),
  core        boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gf_suppliers (
  id                  bigserial PRIMARY KEY,
  supplier_no         text NOT NULL UNIQUE,
  name                text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  credit_code         text NOT NULL CHECK (credit_code ~ '^[0-9A-Z]{18}$'),
  categories          text[] NOT NULL DEFAULT '{general}',
  contact             text NOT NULL DEFAULT '' CHECK (char_length(contact) <= 30),
  phone               text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 30),
  address             text NOT NULL DEFAULT '' CHECK (char_length(address) <= 120),
  bank_name           text NOT NULL DEFAULT '' CHECK (char_length(bank_name) <= 60),
  bank_account        text NOT NULL DEFAULT '' CHECK (bank_account ~ '^[0-9]{0,30}$'),
  account_name        text NOT NULL DEFAULT '' CHECK (char_length(account_name) <= 80),
  qualifications      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(qualifications) = 'array'),
  note                text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'active', 'disabled', 'exited')),
  legacy              boolean NOT NULL DEFAULT false,
  version             integer NOT NULL DEFAULT 1,
  admission_doc_id    bigint REFERENCES gf_docs (id),
  pending_change_doc_id bigint REFERENCES gf_docs (id),
  client_key          uuid UNIQUE,
  created_by          bigint NOT NULL REFERENCES staff (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX gf_suppliers_credit_code_uq ON gf_suppliers (credit_code);

CREATE TABLE gf_supplier_versions (
  id           bigserial PRIMARY KEY,
  supplier_id  bigint NOT NULL REFERENCES gf_suppliers (id),
  version      integer NOT NULL,
  snapshot     jsonb NOT NULL,
  doc_id       bigint REFERENCES gf_docs (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, version)
);
CREATE TRIGGER gf_supplier_versions_append_only BEFORE UPDATE OR DELETE ON gf_supplier_versions FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE gf_skus (
  id                    bigserial PRIMARY KEY,
  sku_code              text NOT NULL UNIQUE,
  supplier_id           bigint NOT NULL REFERENCES gf_suppliers (id),
  material_id           bigint NOT NULL REFERENCES gf_materials (id),
  name                  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  spec                  text NOT NULL DEFAULT '' CHECK (char_length(spec) <= 60),
  unit                  text NOT NULL CHECK (char_length(unit) BETWEEN 1 AND 10),
  -- 提报价 / 现行协议价（不含税，分）与税率（万分比）
  price_cents           bigint NOT NULL CHECK (price_cents > 0),
  price_version         integer NOT NULL DEFAULT 0,
  tax_rate_bp           integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 3000),
  entity_ids            bigint[] NOT NULL DEFAULT '{}',
  formats               text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'reviewing' CHECK (status IN ('reviewing', 'active', 'rejected', 'disabled')),
  doc_id                bigint REFERENCES gf_docs (id),
  pending_change_doc_id bigint REFERENCES gf_docs (id),
  created_by            bigint NOT NULL REFERENCES staff (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gf_skus_supplier_idx ON gf_skus (supplier_id, status);
CREATE INDEX gf_skus_material_idx ON gf_skus (material_id, status);

CREATE TABLE gf_sku_prices (
  id           bigserial PRIMARY KEY,
  sku_id       bigint NOT NULL REFERENCES gf_skus (id),
  version      integer NOT NULL CHECK (version >= 1),
  price_cents  bigint NOT NULL CHECK (price_cents > 0),
  tax_rate_bp  integer NOT NULL,
  doc_id       bigint NOT NULL REFERENCES gf_docs (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku_id, version)
);
CREATE TRIGGER gf_sku_prices_append_only BEFORE UPDATE OR DELETE ON gf_sku_prices FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
