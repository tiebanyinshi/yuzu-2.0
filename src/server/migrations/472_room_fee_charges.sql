-- 福田店整改后续（店主 2026-11-26 定：房费只在收银台收，docs/FUTIAN_1126.md）：房间按时间计费的房费在客人收银台结账时按时间算、挂到账单上，
-- 这里记哪一张登记单的房费记在了哪一行明细上（一张登记单只收一次；那一行被作废了——反结账、退菜——下次结账再算）。只追加。
-- 风险已知：只新建一张表，不改已有数据与账本；回滚见 docs/rollback/472_room_fee_charges.down.sql。

CREATE TABLE room_fee_charges (
  id              bigserial PRIMARY KEY,
  store_id        bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  registration_id bigint NOT NULL REFERENCES room_registrations (id),
  bill_line_id    bigint NOT NULL UNIQUE REFERENCES bill_lines (id),
  amount          integer NOT NULL CHECK (amount > 0),
  -- 计费的时间段与分钟数（显示与对账用的快照）
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  charged_minutes integer NOT NULL CHECK (charged_minutes > 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_fee_charges_registration_idx ON room_fee_charges (registration_id);

CREATE FUNCTION yuzu_room_fee_charges_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '房费记录只追加，不能改、不能删' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER room_fee_charges_append_only BEFORE UPDATE OR DELETE ON room_fee_charges
  FOR EACH ROW EXECUTE FUNCTION yuzu_room_fee_charges_append_only();
