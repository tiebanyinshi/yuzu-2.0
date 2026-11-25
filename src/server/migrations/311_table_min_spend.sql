-- 8.1.39（docs/V8139.md 第 3、4 节）：桌台的低消与服务费、结账时自动记的两种明细、包房转挂账（《餐饮新店新系统功能需求文档》R6、R9、R14）。
--   · dining_tables.min_spend：低消（分，0 为不设）；service_fee_bp：服务费比例（万分之几，0 为不收，最多 30%）。现有的桌都是 0，结账照旧；
--   · bill_lines.charge_kind：结账时按规则自动记的明细——service_fee 服务费（按这一桌没赠送、没退的菜算）、min_spend 低消补足；
--     反结账后重新结账，原来自动记的作废、按此刻重算（不会重复收）；人点的菜、手动金额为空；
--   · table_sessions.parked_at / parked_by / park_reason：转挂账（批房挂账）——账单不结，桌台空出来给下一桌，挂账的单之后再结；
--     「一张桌同时只有一个没结的开台」改成只管没转挂账、不是拼台的；
--   · table_sessions.shared：拼台（R2）——一张桌已经有客人，另一拨客人坐过来另开一张单（各点各的、各结各的），看板上归在一起显示。
-- 回滚：docs/rollback/311_table_min_spend.down.sql。

ALTER TABLE dining_tables ADD COLUMN min_spend bigint NOT NULL DEFAULT 0 CHECK (min_spend >= 0 AND min_spend <= 100000000);
ALTER TABLE dining_tables ADD COLUMN service_fee_bp integer NOT NULL DEFAULT 0 CHECK (service_fee_bp BETWEEN 0 AND 3000);

ALTER TABLE bill_lines ADD COLUMN charge_kind text CHECK (charge_kind IN ('service_fee', 'min_spend'));

ALTER TABLE table_sessions ADD COLUMN parked_at timestamptz;
ALTER TABLE table_sessions ADD COLUMN parked_by bigint REFERENCES staff (id);
ALTER TABLE table_sessions ADD COLUMN park_reason text CHECK (char_length(park_reason) <= 200);
ALTER TABLE table_sessions ADD CONSTRAINT table_sessions_parked_check CHECK ((parked_at IS NULL) = (parked_by IS NULL) AND (parked_at IS NULL) = (park_reason IS NULL));

ALTER TABLE table_sessions ADD COLUMN shared boolean NOT NULL DEFAULT false;

DROP INDEX table_sessions_table_open_uq;
CREATE UNIQUE INDEX table_sessions_table_open_uq ON table_sessions (table_id) WHERE status = 'open' AND parked_at IS NULL AND NOT shared;
CREATE INDEX table_sessions_parked_idx ON table_sessions (store_id) WHERE status = 'open' AND parked_at IS NOT NULL;
