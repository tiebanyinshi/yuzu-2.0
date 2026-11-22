-- 回测整改 P07（回测 3-1，docs/YUZU_REQ_V820.md 第 8 节，RT15 起）：房态中心「在用」的房间直接点水吧、果吧。
-- 下单照旧是挂账（来访 → 账单 → 沽清 → 出品单，frontdesk/bills.ts 的 postChargesTx），出品单上写送到哪间房；这里只另记「这一单是从哪间房点的」：
--   · room_orders：一次点单一行——哪间房（空间或客房，二选一）、当时的房号、挂在哪位客人（来访）上、哪个出品口、出品单号、整单备注、
--     下单时的合计、经办人与时间、操作编号（同一编号只记一行）。只追加：撤单是作废账单明细（bill_lines.status），不改这里；
--   · room_order_lines：这一单挂到账单的哪几行（逐行看有没有退、谁退的、为什么）。只追加；
--   · room_order_outlets：门店按出品口配置房态点单能点哪几个分类（水吧按点单小分类，果吧按价目分类）；没有这一行或 categories 为空值的是全部能点。
-- 操作编号与「确认作废」按出品口多两类 room_order_water、room_order_fruit（在当时的约束上追加）；不改已有的表与数据。回滚：docs/rollback/202_room_orders.down.sql（删这三张表；点过的单照旧在账单与出品单上，只是房间卡片上不再显示单数与金额）。

CREATE TABLE room_orders (
  id          bigserial PRIMARY KEY,
  store_id    bigint NOT NULL DEFAULT yuzu_store(),
  op_key      uuid NOT NULL UNIQUE,
  -- 房态中心的空间（技师房、派对房等），或客房的房间；二选一
  space_id    bigint REFERENCES spaces (id),
  room_id     bigint REFERENCES rooms (id),
  room_code   text NOT NULL CHECK (char_length(room_code) BETWEEN 1 AND 32),
  visit_id    bigint NOT NULL REFERENCES visits (id),
  outlet      text NOT NULL CHECK (outlet IN ('water', 'fruit')),
  order_no    text,
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 60),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  staff_id    bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((space_id IS NULL) <> (room_id IS NULL))
);
CREATE INDEX room_orders_space_idx ON room_orders (space_id, id DESC) WHERE space_id IS NOT NULL;
CREATE INDEX room_orders_room_idx ON room_orders (room_id, id DESC) WHERE room_id IS NOT NULL;
CREATE INDEX room_orders_visit_idx ON room_orders (visit_id);
CREATE TRIGGER room_orders_append_only BEFORE UPDATE OR DELETE ON room_orders
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE room_order_lines (
  room_order_id bigint NOT NULL REFERENCES room_orders (id),
  bill_line_id  bigint NOT NULL UNIQUE REFERENCES bill_lines (id),
  PRIMARY KEY (room_order_id, bill_line_id)
);
CREATE TRIGGER room_order_lines_append_only BEFORE UPDATE OR DELETE ON room_order_lines
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE room_order_outlets (
  store_id   bigint NOT NULL DEFAULT yuzu_store(),
  outlet     text NOT NULL CHECK (outlet IN ('water', 'fruit')),
  -- 能点的分类；空值为全部
  categories text[] CHECK (categories IS NULL OR cardinality(categories) <= 50),
  updated_by bigint REFERENCES staff (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, outlet)
);

-- 房态点单的操作编号按出品口单独成类 room_order_water / room_order_fruit（不与挂账 bill_post 共用，水吧、果吧也分开：
-- 只有一个出品口下单权限的人确认作废时，只能作废这个出品口的房态点单，碰不到别人的挂账与另一个出品口的点单，Codex 安全审查 e1c3203、404eb2f）。在当时的约束上追加（写法同 162）
DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''room_order_water'',''room_order_fruit''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
