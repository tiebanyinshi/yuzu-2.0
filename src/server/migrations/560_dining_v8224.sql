-- 8.2.4 餐饮（会议纪要「餐饮系统需求对接会」2026-11-26，设计见 docs/V8224_DINING.md）：
--   · 菜单分组的默认档口（存在餐饮规则里）+ 菜品「单独设档口」：service_items.station_pinned；
--   · 手工下的临时项目可以选档口、照常出厨房单：kitchen_items.item_id 可以为空（临时项目没有菜品，名字在账单明细上）；
--   · 包房房型（小房、中房、大房……）：低消、中消（按开台时段或人数用中消）、只收房费；桌台挂房型；
--   · 服务费：桌台没单独设的跟门店默认（存在餐饮规则里）——dining_tables.service_fee_bp 改成可以为空；
--   · 结账自动记的明细多一种「房费」（charge_kind = room_fee）；
--   · 返台：table_session_returns（只追加），从转挂账或已结账回到桌台继续点、补到低消；
--   · 公司承担：结账多一种方式 company（选原因、当场授权），授权用途 company_charge。
-- 风险已知：只加表、加列、放宽约束；dining_tables.service_fee_bp 原来的 0（不收）改成空（跟门店默认，门店默认初始也是 0，结账结果不变）；
-- 三个类型约束都在当时的约束上追加（不照旧名单重建）。回滚见 docs/rollback/560_dining_v8224.down.sql。

-- ───────────── 1. 菜品单独设档口 ─────────────
ALTER TABLE service_items ADD COLUMN station_pinned boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN service_items.station_pinned IS '8.2.4：单独设了出品档口——true 时不跟菜单分组的默认档口，照自己的 station_id 出；false 时分组设了默认档口就按分组走（餐饮规则 groupStations）';

-- ───────────── 2. 临时项目进厨房 ─────────────
ALTER TABLE kitchen_items ALTER COLUMN item_id DROP NOT NULL;
COMMENT ON COLUMN kitchen_items.item_id IS '菜品；手工下的临时项目（8.2.4，选了档口的手动金额）为空，菜名看账单明细 bill_lines.name';

-- ───────────── 3. 包房房型 ─────────────
CREATE TABLE dining_room_types (
  id               bigserial PRIMARY KEY,
  store_id         bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  name             text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 12),
  charge_mode      text NOT NULL DEFAULT 'min_spend' CHECK (charge_mode IN ('min_spend', 'room_fee')),
  min_spend        bigint NOT NULL DEFAULT 0 CHECK (min_spend BETWEEN 0 AND 100000000),
  mid_spend        bigint NOT NULL DEFAULT 0 CHECK (mid_spend BETWEEN 0 AND 100000000),
  mid_start_minute integer CHECK (mid_start_minute BETWEEN 0 AND 1439),
  mid_end_minute   integer CHECK (mid_end_minute BETWEEN 0 AND 1439),
  mid_max_guests   integer CHECK (mid_max_guests BETWEEN 1 AND 99),
  room_fee         bigint NOT NULL DEFAULT 0 CHECK (room_fee BETWEEN 0 AND 100000000),
  sort_order       integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 9999),
  active           boolean NOT NULL DEFAULT true,
  created_by       bigint NOT NULL REFERENCES staff (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((mid_start_minute IS NULL) = (mid_end_minute IS NULL)),
  CHECK (charge_mode = 'min_spend' OR (min_spend = 0 AND mid_spend = 0))
);
CREATE UNIQUE INDEX dining_room_types_name_uq ON dining_room_types (store_id, lower(btrim(name)));
COMMENT ON TABLE dining_room_types IS '8.2.4 包房房型（小房、中房、大房……，可加）：按房型收低消（另有中消档）或只收房费；桌台挂房型后低消取房型的（桌台自己设了低消的优先）。金额单位：分';
COMMENT ON COLUMN dining_room_types.name IS '房型名称（同一家店不重名）';
COMMENT ON COLUMN dining_room_types.charge_mode IS 'min_spend 按低消收（不够的结账时补足或返台）/ room_fee 只收房费（不设低消，结账时记一行房费）';
COMMENT ON COLUMN dining_room_types.min_spend IS '低消（分，0 为不设）';
COMMENT ON COLUMN dining_room_types.mid_spend IS '中消（分，0 为不设）：开台时刻落在中消时段、或人数不超过中消人数的，低消按中消算';
COMMENT ON COLUMN dining_room_types.mid_start_minute IS '中消时段开始（一天里的第几分钟，含）；空为不按时段';
COMMENT ON COLUMN dining_room_types.mid_end_minute IS '中消时段结束（一天里的第几分钟，不含；比开始早的是跨零点）';
COMMENT ON COLUMN dining_room_types.mid_max_guests IS '人数不超过这个数用中消；空为不按人数';
COMMENT ON COLUMN dining_room_types.room_fee IS '房费（分）：只收房费的房型结账时记一行「房费」';
COMMENT ON COLUMN dining_room_types.sort_order IS '排序';
COMMENT ON COLUMN dining_room_types.active IS '启用；不用了停用，不删（挂着的桌台照旧按它算）';
COMMENT ON COLUMN dining_room_types.created_by IS '新建的员工';
COMMENT ON COLUMN dining_room_types.created_at IS '新建时间';
COMMENT ON COLUMN dining_room_types.updated_at IS '最近修改时间';
COMMENT ON COLUMN dining_room_types.store_id IS '门店';

ALTER TABLE dining_tables ADD COLUMN room_type_id bigint;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_room_type_id_fkey FOREIGN KEY (room_type_id) REFERENCES dining_room_types (id) NOT VALID;
ALTER TABLE dining_tables VALIDATE CONSTRAINT dining_tables_room_type_id_fkey;
CREATE INDEX dining_tables_room_type_id_fk_idx ON dining_tables (room_type_id);
COMMENT ON COLUMN dining_tables.room_type_id IS '8.2.4：包房的房型（空为不是包房）；低消、中消、房费按房型算，桌台自己设了低消的优先';

-- ───────────── 4. 服务费跟门店默认 ─────────────
ALTER TABLE dining_tables ALTER COLUMN service_fee_bp DROP NOT NULL;
ALTER TABLE dining_tables ALTER COLUMN service_fee_bp DROP DEFAULT;
-- 风险已知：原来的 0 是「不收」，改成空 = 跟门店默认；门店默认初始为 0，结账结果不变；设了比例的桌照旧
UPDATE dining_tables SET service_fee_bp = NULL WHERE service_fee_bp = 0;
COMMENT ON COLUMN dining_tables.service_fee_bp IS '服务费比例（万分之几，最多 30%）；空为跟门店默认（餐饮规则 serviceFeeBp，8.2.4），0 为这张桌不收';

-- ───────────── 5. 结账自动记的房费 ─────────────
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'bill_lines'::regclass AND conname = 'bill_lines_charge_kind_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原 bill_lines_charge_kind_check 约束不存在'; END IF;
  ALTER TABLE bill_lines DROP CONSTRAINT bill_lines_charge_kind_check;
  EXECUTE format('ALTER TABLE bill_lines ADD CONSTRAINT bill_lines_charge_kind_check CHECK ((%s) OR charge_kind = ''room_fee'')', expression);
END $$;

-- ───────────── 6. 返台 ─────────────
CREATE TABLE table_session_returns (
  id            bigserial PRIMARY KEY,
  store_id      bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  session_id    bigint NOT NULL REFERENCES table_sessions (id),
  table_id      bigint NOT NULL REFERENCES dining_tables (id),
  kind          text NOT NULL CHECK (kind IN ('parked', 'settled')),
  checkout_id   bigint REFERENCES checkouts (id),
  min_spend     bigint NOT NULL CHECK (min_spend > 0),
  subtotal      bigint NOT NULL CHECK (subtotal >= 0),
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 200),
  client_key    uuid NOT NULL UNIQUE,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL,
  CHECK ((kind = 'settled') = (checkout_id IS NOT NULL))
);
CREATE INDEX table_session_returns_session_id_fk_idx ON table_session_returns (session_id);
CREATE INDEX table_session_returns_table_id_fk_idx ON table_session_returns (table_id);
CREATE INDEX table_session_returns_checkout_id_fk_idx ON table_session_returns (checkout_id);
COMMENT ON TABLE table_session_returns IS '8.2.4 返台（只追加）：包房低消没够时，转挂账的单或已结账（还没清台）的单回到桌台继续点、补到低消。金额单位：分';
COMMENT ON COLUMN table_session_returns.session_id IS '返台的开台';
COMMENT ON COLUMN table_session_returns.table_id IS '回到的桌台';
COMMENT ON COLUMN table_session_returns.kind IS 'parked 从转挂账回来 / settled 从已结账回来（同一事务里反结账那张结账单）';
COMMENT ON COLUMN table_session_returns.checkout_id IS '从已结账回来时反结账的结账单';
COMMENT ON COLUMN table_session_returns.min_spend IS '返台时这桌的低消（按房型、中消算好的）';
COMMENT ON COLUMN table_session_returns.subtotal IS '返台时的菜钱（不算服务费、低消补足）';
COMMENT ON COLUMN table_session_returns.reason IS '返台原因';
COMMENT ON COLUMN table_session_returns.client_key IS '操作编号：同一编号重提返回第一次的结果';
COMMENT ON COLUMN table_session_returns.created_by IS '经办人';
COMMENT ON COLUMN table_session_returns.created_at IS '返台时间';
COMMENT ON COLUMN table_session_returns.store_id IS '门店';

-- ───────────── 7. 公司承担 ─────────────
ALTER TABLE checkout_payments ADD COLUMN company_reason text CHECK (company_reason IN ('unwell', 'hosting', 'other'));
COMMENT ON COLUMN checkout_payments.company_reason IS '8.2.4 公司承担的原因：unwell 客人身体不适 / hosting 招待 / other 其他（说明写在 ref）；别的收款方式为空';
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'checkout_payments'::regclass AND conname = 'checkout_payments_method_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原 checkout_payments_method_check 约束不存在'; END IF;
  ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_method_check;
  EXECUTE format('ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_method_check CHECK ((%s) OR method = ''company'')', expression);

  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'auth_grants'::regclass AND conname = 'auth_grants_purpose_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原授权用途约束不存在'; END IF;
  ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_purpose_check;
  EXECUTE format('ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_purpose_check CHECK ((%s) OR purpose = ''company_charge'')', expression);
END $$;
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_company_check CHECK ((method = 'company') = (company_reason IS NOT NULL)) NOT VALID;
ALTER TABLE checkout_payments VALIDATE CONSTRAINT checkout_payments_company_check;
-- 授权人、授权编号原来只许「优惠 / 免单」带；公司承担也要带（同样当场授权）。优惠的原因至少 2 个字照旧
ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_discount_check;
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_discount_check
  CHECK ((method IN ('discount', 'company')) = (approved_by IS NOT NULL) AND (method IN ('discount', 'company')) = (grant_id IS NOT NULL)
         AND (method <> 'discount' OR char_length(btrim(ref)) >= 2)) NOT VALID;
ALTER TABLE checkout_payments VALIDATE CONSTRAINT checkout_payments_discount_check;
