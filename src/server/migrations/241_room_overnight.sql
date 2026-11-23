-- 价目表重做第五批（docs/PRICE_CATALOG.md 第 7.5 节，PC23–PC26）：
--   · 房态中心登记（按摩房、足浴房、SPA 房的开单 / 续钟）记「客人是否过夜」，随登记单保存，房态中心卡片上看得到；
--   · 收银项目上记价目表的原始编号（catalog_code），点单时按名称或编号搜。

ALTER TABLE room_registrations ADD COLUMN overnight boolean NOT NULL DEFAULT false;

ALTER TABLE service_items
  ADD COLUMN catalog_code text,
  ADD CONSTRAINT service_items_catalog_code_check CHECK (catalog_code IS NULL OR char_length(catalog_code) BETWEEN 1 AND 12);
