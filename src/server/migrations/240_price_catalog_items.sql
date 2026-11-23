-- 价目表重做第一批（店主 2026-11-23《汤崎宝安全品类价目表录入系统需求说明》重做，docs/PRICE_CATALOG.md 第 7 节，PC19–PC21）：
-- 价目表落库到收银项目。生效中的价目表每一项（服务费、房型这类不卖给客人的除外）都有一个收银项目：
-- 没对接的自动新建一个（catalog_managed），已对接的照旧用原来那个；分类编码 + 分类名称 + 上一级 + 排序另存在收银项目上，
-- 前台开单、房态中心登记、点单页的分类切换都按它分。原来的 category（部门营业额、券、会员折扣按它算）不动。

ALTER TABLE service_items
  ADD COLUMN catalog_key           text,
  ADD COLUMN catalog_managed       boolean NOT NULL DEFAULT false,
  ADD COLUMN catalog_category_code text,
  ADD COLUMN catalog_category_name text,
  ADD COLUMN catalog_group         text,
  ADD COLUMN catalog_sort          integer,
  ADD CONSTRAINT service_items_catalog_check CHECK (
    (catalog_category_code IS NULL) = (catalog_category_name IS NULL)
    AND (catalog_category_code IS NULL OR (char_length(catalog_category_code) <= 40 AND char_length(catalog_category_name) BETWEEN 1 AND 20))
    AND (catalog_group IS NULL OR char_length(catalog_group) <= 20)
    AND (catalog_key IS NULL OR char_length(catalog_key) <= 400)
    AND (NOT catalog_managed OR catalog_key IS NOT NULL)
  );

-- 价目表新建的收银项目一项一个（同一个价目表项不会建出两个）
CREATE UNIQUE INDEX service_items_catalog_managed_uq ON service_items (catalog_key) WHERE catalog_managed;
CREATE INDEX service_items_catalog_category_idx ON service_items (catalog_sort, catalog_category_code) WHERE catalog_category_code IS NOT NULL;
