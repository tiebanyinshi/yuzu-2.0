-- Design 素材库（店主 2026-11-24，docs/BOARDS.md 第 4、9 节）：字体、图片、视频按用途设「当前使用」的一份，一键切换、可切回。
--   · design_assets：一份素材（种类、名字、标签、说明——字体写授权说明）；归档以后不再出现在选择里，被用途用着的不能归档。
--   · design_asset_versions：素材的每一版文件（只追加：「换文件」就是加一版，编号不变、旧版还在）。按内容的 SHA-256 记摘要。
--   · design_slot_assignments：每个用途每一次切换一行（只追加）；用途现在用的是最新一行（版本为空 = 不用素材，照原来的样子）。
--     带操作编号（唯一），原样重提给第一次的结果。
-- 风险已知：只建新表与守卫触发器，不碰已有的表与账本；回滚见 docs/rollback/265_design_assets.down.sql（会删掉素材库里的文件，回滚前先导出）。

CREATE TABLE design_assets (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('font', 'image', 'video')),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  tags        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 10),
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  archived_at timestamptz,
  archived_by bigint REFERENCES staff (id),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((archived_at IS NULL) = (archived_by IS NULL))
);
CREATE INDEX design_assets_kind_idx ON design_assets (kind, archived_at, id DESC);

CREATE TABLE design_asset_versions (
  id          bigserial PRIMARY KEY,
  asset_id    bigint NOT NULL REFERENCES design_assets (id),
  version_no  integer NOT NULL CHECK (version_no >= 1),
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime        text NOT NULL CHECK (mime IN ('font/woff2', 'font/woff', 'font/otf', 'font/ttf', 'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'video/mp4', 'video/webm')),
  size_bytes  integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 31457280),
  data        bytea NOT NULL,
  width       integer CHECK (width IS NULL OR width > 0),
  height      integer CHECK (height IS NULL OR height > 0),
  font_family text CHECK (font_family IS NULL OR char_length(font_family) <= 120),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, version_no),
  CHECK (octet_length(data) = size_bytes)
);

CREATE TABLE design_slot_assignments (
  id          bigserial PRIMARY KEY,
  slot        text NOT NULL CHECK (slot ~ '^[a-z][a-z0-9_.]{1,40}$'),
  version_id  bigint REFERENCES design_asset_versions (id),
  op_key      uuid NOT NULL UNIQUE,
  reason      text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  staff_id    bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX design_slot_assignments_slot_idx ON design_slot_assignments (slot, id DESC);
CREATE INDEX design_slot_assignments_version_idx ON design_slot_assignments (version_id);

-- 版本与切换记录只追加
CREATE FUNCTION yuzu_design_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '素材的版本与切换记录只能追加，不能改、不能删' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER design_asset_versions_guard BEFORE UPDATE OR DELETE ON design_asset_versions FOR EACH ROW EXECUTE FUNCTION yuzu_design_append_only();
CREATE TRIGGER design_slot_assignments_guard BEFORE UPDATE OR DELETE ON design_slot_assignments FOR EACH ROW EXECUTE FUNCTION yuzu_design_append_only();

-- 切换的「确认作废」（Codex 审查）：结果不确定的一笔，查回没有、员工确认不要了，就登记这个操作编号；
-- 之后原请求晚到也不会换（切换在同一把用途锁里先查这张表）。只追加
CREATE TABLE design_assign_fences (
  op_key      uuid PRIMARY KEY,
  slot        text NOT NULL,
  staff_id    bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER design_assign_fences_guard BEFORE UPDATE OR DELETE ON design_assign_fences FOR EACH ROW EXECUTE FUNCTION yuzu_design_append_only();
