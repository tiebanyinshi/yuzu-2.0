-- 8.1.40（docs/V8140.md 第 2 节）：券的使用限制（店主 8.1.37 留下的新需求：券限星期 / 时段 / 门店、点钟券）。
--   · weekdays：哪几天能用（1 = 周一 … 7 = 周日，按营业日算）；空 = 不限；
--   · time_from / time_to：每天几点到几点能用（分钟，0–1439；to 不晚于 from 表示到次日）；都空 = 不限；
--   · store_ids：哪几家店能用；空 = 全公司；
--   · designated_only：点钟券——只抵客人点名（点钟）的技师项目（代金券、折扣券才有）。
-- 和面额、门槛一样是券的条件，发过券以后不能改。现有的模板都是不限，结账照旧。
-- 回滚：docs/rollback/320_coupon_limits.down.sql。

ALTER TABLE coupon_templates ADD COLUMN weekdays smallint[] NOT NULL DEFAULT '{}';
ALTER TABLE coupon_templates ADD COLUMN time_from integer CHECK (time_from BETWEEN 0 AND 1439);
ALTER TABLE coupon_templates ADD COLUMN time_to integer CHECK (time_to BETWEEN 0 AND 1439);
ALTER TABLE coupon_templates ADD COLUMN store_ids bigint[] NOT NULL DEFAULT '{}';
ALTER TABLE coupon_templates ADD COLUMN designated_only boolean NOT NULL DEFAULT false;
ALTER TABLE coupon_templates ADD CONSTRAINT coupon_templates_time_check CHECK ((time_from IS NULL) = (time_to IS NULL) AND (time_from IS NULL OR time_from <> time_to));
