-- 8.2.18 水吧取餐叫号（店主 2026-11-27《新店系统需求现场走场确认》第一节第 2 条：奶茶、咖啡等点单后显示制作中 / 可取，排队叫号，
-- 客人扫小票二维码可看排号进度；设计见 docs/V82218_WATER_BAR.md）：
--   · pickup_tickets：有水吧饮品的点单发一个当天的取餐号（按门店、营业日从 1 起）与一个查进度用的随机编号（印在小票的二维码里）；
--     进度看这一单的出品单状态（待做 / 制作中 = 制作中，已出餐 = 请取餐，已上菜 = 已取）。只追加。
-- 风险已知：只加表。回滚见 docs/rollback/610_pickup_v829.down.sql。

CREATE TABLE pickup_tickets (
  id            bigserial PRIMARY KEY,
  store_id      bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  order_no      text NOT NULL UNIQUE,
  visit_id      bigint NOT NULL REFERENCES visits (id),
  business_date date NOT NULL,
  pickup_no     integer NOT NULL CHECK (pickup_no BETWEEN 1 AND 9999),
  token         uuid NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL
);
COMMENT ON TABLE pickup_tickets IS '8.2.18 水吧取餐号：有水吧饮品的点单一张（当天从 1 起的取餐号 + 小票二维码里查进度的随机编号）；进度看这一单的出品单状态；只追加';
COMMENT ON COLUMN pickup_tickets.order_no IS '出品单号（kitchen_items.order_no）';
COMMENT ON COLUMN pickup_tickets.pickup_no IS '当天的取餐号（按门店、营业日从 1 起）';
COMMENT ON COLUMN pickup_tickets.token IS '小票二维码里的查进度编号（不带登录，只能看这一单的取餐号与进度）';
CREATE UNIQUE INDEX pickup_tickets_no_uq ON pickup_tickets (store_id, business_date, pickup_no);
CREATE INDEX pickup_tickets_visit_idx ON pickup_tickets (visit_id);
CREATE FUNCTION yuzu_pickup_ticket_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '取餐号只追加，不能改、不能删';
END $$;
CREATE TRIGGER pickup_tickets_guard BEFORE UPDATE OR DELETE ON pickup_tickets FOR EACH ROW EXECUTE FUNCTION yuzu_pickup_ticket_guard();
