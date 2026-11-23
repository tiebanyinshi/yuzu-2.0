-- 价目表录入 第一批（店主 2026-11-22《汤崎宝安全品类价目表录入系统需求说明》，docs/PRICE_CATALOG.md，PC1 起）：
-- 把《汤崎宝安全品类价目表 1119》六张表录成一份「价目表数据集」。导入先落草稿，核对条数无误后再切换生效（第三批），
-- 生效的那一份由前台开单、房态点单、康美部项目统一取（第四批）。这一批只建数据结构，不改已有的表与数据。
--   · price_catalog_sets：一次导入（或一份手工维护的价目表）一行；status 草稿 draft / 生效 active / 停用 retired，
--     同一家门店同时最多一份草稿、一份生效；切换生效时原来生效的那份转停用（可整体回滚到它）；
--   · price_catalog_entries：一份价目表里的一项（门票、餐票、娱乐、房型、菜品、按摩助浴、服务费）。价格以分存整数：
--       price_mode 三种——dual 双价（专业价 price_cents + 资深价 price2_cents）、single 单价（只有 price_cents）、
--       none 无价格（待定价或免费，两个价格都是空值，不存 0）；服务费按比例 rate_bp（万分之几，10% = 1000），不存成价格；
--       时长一律分钟；娱乐、房间的「基础价含几分钟」「加钟 / 超时单价」「封顶价」分字段存；台位数、房号清单、供应时段另存；
--       板块 / 餐段 / 菜品分类、原始编号保留，便于与表格核对。不物理删除：停用 active = false。

CREATE TABLE price_catalog_sets (
  id            bigserial PRIMARY KEY,
  store_id      bigint NOT NULL DEFAULT yuzu_store(),
  status        text NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  -- 导入的文件（手工维护的为空）：文件名与内容摘要，同一份文件导两次能认出来
  file_name     text CHECK (file_name IS NULL OR char_length(file_name) <= 120),
  file_sha256   text CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  -- 表里不录入、只记下来的内容（储值政策那一句等）
  notes         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  activated_by  bigint REFERENCES staff (id),
  activated_at  timestamptz,
  retired_at    timestamptz,
  CHECK ((status = 'draft') = (activated_at IS NULL)),
  CHECK ((activated_at IS NULL) = (activated_by IS NULL))
);
CREATE UNIQUE INDEX price_catalog_sets_one_draft ON price_catalog_sets (store_id) WHERE status = 'draft';
CREATE UNIQUE INDEX price_catalog_sets_one_active ON price_catalog_sets (store_id) WHERE status = 'active';

CREATE TABLE price_catalog_entries (
  id               bigserial PRIMARY KEY,
  set_id           bigint NOT NULL REFERENCES price_catalog_sets (id) ON DELETE CASCADE,
  -- 六张表：门店价格、娱乐价格、房间价格、零点菜品价格、按摩及助浴价格（储值政策本次不录入）
  sheet            text NOT NULL CHECK (sheet IN ('store', 'entertainment', 'room', 'dish', 'massage')),
  kind             text NOT NULL CHECK (kind IN (
                     'ticket', 'night_ticket', 'meal_ticket', 'service_fee',
                     'play_pass', 'entertainment',
                     'room_type', 'party_room', 'dining_room',
                     'dish', 'massage')),
  -- 板块（康疗、SPA……）/ 餐段（2 楼零点、早餐、午餐、晚餐）/ 门店价格的「类型」
  section          text NOT NULL DEFAULT '' CHECK (char_length(section) <= 20),
  -- 菜品分类（中式零点、生滚粥……）
  category         text NOT NULL DEFAULT '' CHECK (char_length(category) <= 20),
  -- 表格里的原始编号（按摩及助浴 1–76，编号 43 空缺）
  code             text NOT NULL DEFAULT '' CHECK (char_length(code) <= 12),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 48),
  price_mode       text NOT NULL CHECK (price_mode IN ('dual', 'single', 'none', 'rate')),
  price_cents      bigint CHECK (price_cents IS NULL OR price_cents > 0),
  price2_cents     bigint CHECK (price2_cents IS NULL OR price2_cents > 0),
  rate_bp          integer CHECK (rate_bp IS NULL OR rate_bp BETWEEN 1 AND 10000),
  CHECK (
    (price_mode = 'dual' AND price_cents IS NOT NULL AND price2_cents IS NOT NULL AND rate_bp IS NULL) OR
    (price_mode = 'single' AND price_cents IS NOT NULL AND price2_cents IS NULL AND rate_bp IS NULL) OR
    (price_mode = 'none' AND price_cents IS NULL AND price2_cents IS NULL AND rate_bp IS NULL) OR
    (price_mode = 'rate' AND price_cents IS NULL AND price2_cents IS NULL AND rate_bp IS NOT NULL)
  ),
  -- 计价单位（位、份、只、次、晚……）
  unit             text NOT NULL DEFAULT '' CHECK (char_length(unit) <= 8),
  -- 服务时长（按摩）、门票时长（12H / 24H）、基础价含的时长（娱乐、房间 2H 起开），一律分钟
  duration_minutes integer CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 2880),
  -- 加钟价（娱乐）/ 超时单价（房间），以及多少分钟算一次
  extra_price_cents bigint CHECK (extra_price_cents IS NULL OR extra_price_cents > 0),
  extra_minutes    integer CHECK (extra_minutes IS NULL OR extra_minutes BETWEEN 1 AND 1440),
  -- 封顶价（房间过夜封顶）
  cap_cents        bigint CHECK (cap_cents IS NULL OR cap_cents > 0),
  -- 台位数（PS5 17 台……）/ 房型的总间数
  units_count      integer CHECK (units_count IS NULL OR units_count BETWEEN 0 AND 999),
  -- 房号清单（S301、S302……）
  room_numbers     text[] NOT NULL DEFAULT '{}',
  -- 供应 / 使用时段（餐票的早餐 7:30–10:00、夜间票 21:00–次日 11:00），时刻按 0–1439 分钟存，跨零点的结束小于开始
  window_start     integer CHECK (window_start IS NULL OR window_start BETWEEN 0 AND 1439),
  window_end       integer CHECK (window_end IS NULL OR window_end BETWEEN 0 AND 1439),
  CHECK ((window_start IS NULL) = (window_end IS NULL)),
  -- 是否含餐（门票）
  includes_meal    boolean,
  -- 适用房型（房间 / 大堂 / 浴区，可以几种）与适用性别（助浴表「资深价」一列写的其实是性别）
  venues           text[] NOT NULL DEFAULT '{}' CHECK (venues <@ ARRAY['room', 'lobby', 'bath']::text[]),
  gender           text CHECK (gender IS NULL OR gender IN ('female', 'male', 'any')),
  audience         text NOT NULL DEFAULT '' CHECK (char_length(audience) <= 400),
  content          text NOT NULL DEFAULT '' CHECK (char_length(content) <= 800),
  highlight        text NOT NULL DEFAULT '' CHECK (char_length(highlight) <= 400),
  note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 400),
  -- 一项里还分几档、几种位价的（轰趴房按面积分档、客房大小房、餐饮包房的位价与低消、棋牌房 8H 价），结构见 src/shared/price-catalog.ts
  variants         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(variants) = 'array'),
  -- 能不能下单：2 楼零点暂无售价的菜「待定价、不可下单」，补价后启用
  orderable        boolean NOT NULL DEFAULT true,
  active           boolean NOT NULL DEFAULT true,
  -- 表格里第几行（报错、核对用）与排序
  source_row       integer,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (price_mode <> 'none' OR NOT orderable OR kind <> 'dish')
);
CREATE INDEX price_catalog_entries_set_idx ON price_catalog_entries (set_id, sheet, sort_order, id);
