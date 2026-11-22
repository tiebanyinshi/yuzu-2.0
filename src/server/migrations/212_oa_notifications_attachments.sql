-- OA-03 站内通知与附件（docs/OA.md 第 6 节）。只加新表，不改已有的表与数据。
--   · oa_notifications：每位员工的站内通知（哪一类、标题、内容、点开去哪一页、关联的单据）。只追加：已读只记时间；
--     同一人同一件事（类型 + 关联单据）没读的不重复发，只更新内容与时间（refreshed_at）。
--   · oa_attachments：通用附件（单个不超过 10MB，图片另存一张浏览器生成的缩略图）。没挂到单据上的只有上传的人能看；
--     挂上以后（ref_type + ref_id）按那张单据的查看权限，挂上就不再改。
-- 回滚：docs/rollback/212_oa_notifications_attachments.down.sql（删这两张表）。

CREATE TABLE oa_notifications (
  id           bigserial PRIMARY KEY,
  staff_id     bigint NOT NULL REFERENCES staff (id),
  kind         text NOT NULL CHECK (kind IN ('attendance_exception', 'makeup_result', 'approval_todo', 'approval_urge', 'approval_result', 'schedule_change', 'payslip', 'im_message', 'system')),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  body         text NOT NULL DEFAULT '' CHECK (char_length(body) <= 500),
  link         text CHECK (link IS NULL OR (link ~ '^/[^/]' AND char_length(link) <= 300)),
  ref_type     text CHECK (ref_type IS NULL OR ref_type ~ '^[a-z_]{1,40}$'),
  ref_id       bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz,
  CHECK ((ref_type IS NULL) = (ref_id IS NULL))
);
CREATE INDEX oa_notifications_staff_idx ON oa_notifications (staff_id, id DESC);
CREATE INDEX oa_notifications_unread_idx ON oa_notifications (staff_id) WHERE read_at IS NULL;
-- 同一人同一件事只留一条没读的（再发时更新这一条）
CREATE UNIQUE INDEX oa_notifications_unread_ref_uq ON oa_notifications (staff_id, kind, ref_type, ref_id) WHERE read_at IS NULL AND ref_type IS NOT NULL;

CREATE TABLE oa_attachments (
  id          bigserial PRIMARY KEY,
  uploaded_by bigint NOT NULL REFERENCES staff (id),
  file_name   text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  mime        text NOT NULL CHECK (char_length(mime) BETWEEN 3 AND 100),
  size_bytes  integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  data        bytea NOT NULL,
  thumb       bytea CHECK (thumb IS NULL OR octet_length(thumb) <= 204800),
  ref_type    text CHECK (ref_type IS NULL OR ref_type ~ '^[a-z_]{1,40}$'),
  ref_id      bigint,
  bound_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((ref_type IS NULL) = (ref_id IS NULL) AND (ref_type IS NULL) = (bound_at IS NULL))
);
CREATE INDEX oa_attachments_ref_idx ON oa_attachments (ref_type, ref_id) WHERE ref_type IS NOT NULL;
CREATE INDEX oa_attachments_uploader_idx ON oa_attachments (uploaded_by, created_at DESC);
