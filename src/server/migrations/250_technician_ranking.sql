-- 技师榜单第一批（docs/TECH_RANKING.md，店主 2026-11-24《技师榜单模块需求说明》）：名册上挂一张技师照片。
--   · 照片按门店存、按内容去重（同一家店同一张图只存一份），只追加；换照片只改技师上挂的是哪一张，旧图留着（审计里能对上）。
--   · 浏览器先压缩，1 MB 以内，JPEG / PNG / WebP（服务端按文件头认）。
--   · 照片的版本号（photo_version，每换一次、去掉一次加 1）：页面带着看到的版本提交，对不上就拒绝，
--     没收到结果的原样重提不会把别人后来换的照片改回去（与换房间的版本号同一个做法）。
-- 只加表、加列，已有的技师都没有照片（榜单显示占位头像）。

CREATE TABLE technician_photos (
  id          bigserial PRIMARY KEY,
  store_id    bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime        text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data        bytea NOT NULL,
  size_bytes  integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(data) = size_bytes)
);
CREATE UNIQUE INDEX technician_photos_sha_uq ON technician_photos (store_id, sha256);
CREATE TRIGGER technician_photos_append_only BEFORE UPDATE OR DELETE ON technician_photos
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

ALTER TABLE technicians
  ADD COLUMN photo_id      bigint REFERENCES technician_photos (id),
  ADD COLUMN photo_version integer NOT NULL DEFAULT 0 CHECK (photo_version >= 0);
