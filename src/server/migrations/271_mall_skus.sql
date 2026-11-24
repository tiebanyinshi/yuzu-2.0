-- 采购商城并进柚子（8.1.32，店主 2026-11-24，docs/MALL_V8132.md）：供应商 SKU——同一个物料可以挂几家供应商的报价，
-- 部门在商城里比选、加清单、提需求单（提交仍是 270 的采购需求单）。
--   · mall_skus：物料 × 供应商的一条报价（未税单价、税率、起订量、交期、运费、有效期、适用门店、价格版本）。
--     状态 draft 草稿 → pending 待审核 → approved 已上架（可采购）；disabled 停用。上架要有「采购规则」权限的人审核，不能自己批自己提交的（店主除外，代码里核对）。
--     改价、改起订量这些核心信息走 mall_sku_changes：提了以后这条 SKU 暂停采购（core_pending），批了才换成新价、版本号加一。
--   · 金额整数分、数量千分之一单位；一个 SKU 只挂一个物料。
-- 风险已知：只建新表与守卫，不碰已有的表与账本；回滚见 docs/rollback/271_mall_skus.down.sql。

CREATE TABLE mall_skus (
  id              bigserial PRIMARY KEY,
  material_id     bigint NOT NULL REFERENCES materials (id),
  supplier_id     bigint NOT NULL REFERENCES suppliers (id),
  sku_code        text NOT NULL UNIQUE CHECK (char_length(btrim(sku_code)) BETWEEN 1 AND 40),
  price_cents     bigint NOT NULL CHECK (price_cents > 0),
  tax_rate_bp     integer NOT NULL CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  moq_milli       bigint NOT NULL CHECK (moq_milli > 0),
  lead_days       integer NOT NULL CHECK (lead_days BETWEEN 0 AND 365),
  freight_cents   bigint NOT NULL DEFAULT 0 CHECK (freight_cents >= 0),
  valid_until     date NOT NULL,
  -- 适用门店（业态）：空数组 = 全部门店
  store_ids       bigint[] NOT NULL DEFAULT '{}',
  -- 报价按的采购单位与换算（上架审核时照物料抄下来，Codex 审查）：物料的采购单位、换算之后改了，这条 SKU 暂停采购，
  -- 停用后重新上架审核（价格版本加一）——免得清单里「2 箱」的价格被当成「2 个」提交
  unit            text NOT NULL CHECK (char_length(unit) BETWEEN 1 AND 8),
  unit_factor_milli bigint NOT NULL CHECK (unit_factor_milli > 0),
  price_version   integer NOT NULL DEFAULT 1 CHECK (price_version >= 1),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'disabled')),
  core_pending    boolean NOT NULL DEFAULT false,
  note            text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  submitted_by    bigint REFERENCES staff (id),
  submitted_at    timestamptz,
  approved_by     bigint REFERENCES staff (id),
  approved_at     timestamptz,
  created_by      bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1,
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX mall_skus_material_idx ON mall_skus (material_id) WHERE status = 'approved';
CREATE INDEX mall_skus_supplier_idx ON mall_skus (supplier_id);

-- 核心信息的改动（改价、改税率、起订量、运费、有效期、适用门店）：只追加；同一条 SKU 同时最多一张待审的
CREATE TABLE mall_sku_changes (
  id              bigserial PRIMARY KEY,
  sku_id          bigint NOT NULL REFERENCES mall_skus (id),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  before          jsonb NOT NULL,
  after           jsonb NOT NULL,
  reason          text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  requested_by    bigint NOT NULL REFERENCES staff (id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  decided_by      bigint REFERENCES staff (id),
  decided_at      timestamptz,
  decision_note   text NOT NULL DEFAULT '' CHECK (char_length(decision_note) <= 200),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX mall_sku_changes_one_pending ON mall_sku_changes (sku_id) WHERE status = 'pending';

-- SKU 不能删（需求单的行记着 SKU 编码与价格版本）；改动只能把待审的定下来，不能改内容
CREATE FUNCTION yuzu_mall_sku_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '商城 SKU 与改动记录不能删除，请停用' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
-- 两张表各自的规矩分开写（plpgsql 不按 AND 短路，写在一起会去读另一张表才有的列）
CREATE FUNCTION yuzu_mall_sku_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.material_id, NEW.supplier_id, NEW.sku_code) IS DISTINCT FROM (OLD.material_id, OLD.supplier_id, OLD.sku_code) THEN
    RAISE EXCEPTION '提交以后的 SKU 不能换物料、供应商与编码' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION yuzu_mall_sku_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION '已定下来的改动不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.sku_id, NEW.before, NEW.after, NEW.reason, NEW.requested_by) IS DISTINCT FROM (OLD.sku_id, OLD.before, OLD.after, OLD.reason, OLD.requested_by) THEN
    RAISE EXCEPTION '改动的内容不能改，只能定下来' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mall_skus_no_delete BEFORE DELETE ON mall_skus FOR EACH ROW EXECUTE FUNCTION yuzu_mall_sku_guard();
CREATE TRIGGER mall_sku_changes_no_delete BEFORE DELETE ON mall_sku_changes FOR EACH ROW EXECUTE FUNCTION yuzu_mall_sku_guard();
CREATE TRIGGER mall_skus_guard BEFORE UPDATE ON mall_skus FOR EACH ROW EXECUTE FUNCTION yuzu_mall_sku_row_guard();
CREATE TRIGGER mall_sku_changes_guard BEFORE UPDATE ON mall_sku_changes FOR EACH ROW EXECUTE FUNCTION yuzu_mall_sku_change_guard();
