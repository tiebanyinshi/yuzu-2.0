-- 8.2.27 男汤 / 女汤泡池（docs/V82227_POOL.md）：泡池区刷客人手牌、再刷技师工牌下单，服务进技师的业绩明细。
--   技师多一列工牌芯片号（与手牌芯片号同一个写法：去掉分隔符、转大写，4–32 位数字或大写字母；同一门店里不重复）。
-- 只加一列，不改已有的行。

ALTER TABLE technicians ADD COLUMN card_uid text CHECK (card_uid ~ '^[0-9A-Z]{4,32}$');
CREATE UNIQUE INDEX technicians_card_uid_uq ON technicians (store_id, card_uid) WHERE card_uid IS NOT NULL;

COMMENT ON COLUMN technicians.card_uid IS '8.2.27 技师工牌芯片号（泡池区刷工牌认技师）：写法同 hand_tags.card_uid；同一门店里不重复';
