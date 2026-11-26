-- 福田店整改批次 4（2026-11-26《福田店餐饮与房态中心整改需求文档》，docs/FUTIAN_1126.md）：
--   · 休息大厅分区（FT-15）：后台自定义分区（A 区、第一排……），床位（休息大厅一类的空间）归到分区里；开单选床位时按分区列；
--   · 虫洞位（FT-18）：一张「虫洞使用」单——手牌、性别、哪个虫洞、费用（挂在手牌账单上的那一行）；同一个虫洞同时一张、同一位客人同时一张；
--     客人结账离店自动不占（看板按来访是否在店算），也可以点「离开」结束；
--   · 房间事件多几种：同一工位加项目（FT-14）、零售与杂项（FT-17）、虫洞入住 / 离开（FT-18）。
-- 风险已知：只新建两张表、给空间加一个可空列、把房间事件的类型约束放宽成原来的超集；不删数据、不改已有记录与账本；
-- 回滚见 docs/rollback/471_hall_wormhole.down.sql。

CREATE TABLE hall_zones (
  id         bigserial PRIMARY KEY,
  store_id   bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  name       text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 12),
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 同一家店里在用的分区不重名
CREATE UNIQUE INDEX hall_zones_name_uq ON hall_zones (store_id, lower(btrim(name))) WHERE active;

ALTER TABLE spaces ADD COLUMN hall_zone_id bigint REFERENCES hall_zones (id);
CREATE INDEX spaces_hall_zone_idx ON spaces (hall_zone_id) WHERE hall_zone_id IS NOT NULL;

CREATE TABLE wormhole_stays (
  id           bigserial PRIMARY KEY,
  store_id     bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  space_id     bigint NOT NULL REFERENCES spaces (id),
  visit_id     bigint NOT NULL REFERENCES visits (id),
  gender       text NOT NULL CHECK (gender IN ('male', 'female')),
  -- 费用那一行（挂在手牌账单上；不收费的为空）
  bill_line_id bigint REFERENCES bill_lines (id),
  fee_cents    integer NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  open_key     uuid NOT NULL UNIQUE,
  opened_at    timestamptz NOT NULL,
  opened_by    bigint NOT NULL REFERENCES staff (id),
  closed_at    timestamptz,
  closed_by    bigint REFERENCES staff (id),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'open') OR closed_by IS NOT NULL)
);
CREATE UNIQUE INDEX wormhole_stays_space_open_uq ON wormhole_stays (space_id) WHERE status = 'open';
CREATE UNIQUE INDEX wormhole_stays_visit_open_uq ON wormhole_stays (visit_id) WHERE status = 'open';

-- 只能从「开着」变成「结束」，结束以后不能再改；不能删
CREATE FUNCTION yuzu_wormhole_stay_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '虫洞使用单不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '虫洞使用单已结束，不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.space_id <> OLD.space_id OR NEW.visit_id <> OLD.visit_id OR NEW.open_key <> OLD.open_key OR NEW.opened_at <> OLD.opened_at
     OR NEW.fee_cents <> OLD.fee_cents OR NEW.bill_line_id IS DISTINCT FROM OLD.bill_line_id OR NEW.store_id <> OLD.store_id THEN
    RAISE EXCEPTION '虫洞使用单的位置、客人、费用与开始时刻不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wormhole_stays_guard BEFORE UPDATE OR DELETE ON wormhole_stays
  FOR EACH ROW EXECUTE FUNCTION yuzu_wormhole_stay_guard();

ALTER TABLE space_room_events DROP CONSTRAINT space_room_events_kind_check;
ALTER TABLE space_room_events ADD CONSTRAINT space_room_events_kind_check
  CHECK (kind IN ('register', 'move_out', 'move_in', 'checkout', 'extend', 'merge', 'unmerge', 'dirty', 'cleaned', 'maintenance', 'restore',
                  'revoke', 'backfill', 'room_fee', 'add_item', 'goods', 'wormhole_in', 'wormhole_out'));
