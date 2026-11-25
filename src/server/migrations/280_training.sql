-- 员工培训第一期（店主 2026-11-25，docs/TRAINING.md、PENDING_DECISIONS PC37）：
--   · 文件夹：「培训资料」（公共）+ 现有 15 个部门各一个，后台可新建部门文件夹、改名、排序、停用（不动 org_departments）；
--   · 文件内容按 SHA-256 只存一份，3 MB 一块存数据库；培训文件带版本（只追加）；
--   · 分块上传（带操作编号）；谁看过（每人每份文件一行）；
--   · 权限项 training.manage 的建议权限：人力行政部负责人（总裁默认都有）。

CREATE TABLE training_folders (
  id             bigserial PRIMARY KEY,
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  kind           text NOT NULL CHECK (kind IN ('public', 'department')),
  department_key text REFERENCES org_departments (key),
  sort           integer NOT NULL DEFAULT 100,
  active         boolean NOT NULL DEFAULT true,
  version        integer NOT NULL DEFAULT 1,
  created_by     bigint REFERENCES staff (id),
  -- 新建时页面带的操作编号：没收到结果原样重提返回原来那个文件夹，不报重名（Codex 审查 a3f5310）
  client_key     uuid UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'department' OR department_key IS NULL)
);
CREATE UNIQUE INDEX training_folders_name_uq ON training_folders (lower(name));
CREATE UNIQUE INDEX training_folders_department_uq ON training_folders (department_key) WHERE department_key IS NOT NULL;
CREATE UNIQUE INDEX training_folders_public_uq ON training_folders (kind) WHERE kind = 'public';

INSERT INTO training_folders (name, kind, sort) VALUES ('培训资料', 'public', 0);
INSERT INTO training_folders (name, kind, department_key, sort)
SELECT name, 'department', key, sort FROM org_departments ORDER BY sort;

CREATE TABLE training_blobs (
  sha256      text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes  bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 209715200),
  chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 100),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE training_blob_chunks (
  sha256 text NOT NULL REFERENCES training_blobs (sha256),
  seq    integer NOT NULL CHECK (seq >= 0),
  data   bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 4194304),
  PRIMARY KEY (sha256, seq)
);

CREATE TABLE training_files (
  id                 bigserial PRIMARY KEY,
  folder_id          bigint NOT NULL REFERENCES training_folders (id),
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description        text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  active             boolean NOT NULL DEFAULT true,
  sort               integer NOT NULL DEFAULT 100,
  current_version_id bigint,
  version            integer NOT NULL DEFAULT 1,
  created_by         bigint NOT NULL REFERENCES staff (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX training_files_folder_idx ON training_files (folder_id, sort, id);

CREATE TABLE training_file_versions (
  id          bigserial PRIMARY KEY,
  file_id     bigint NOT NULL REFERENCES training_files (id),
  version_no  integer NOT NULL CHECK (version_no >= 1),
  file_name   text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  mime        text NOT NULL CHECK (char_length(mime) BETWEEN 3 AND 120),
  sha256      text NOT NULL REFERENCES training_blobs (sha256),
  size_bytes  bigint NOT NULL,
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  uploaded_by bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, version_no)
);
CREATE TRIGGER training_file_versions_append_only BEFORE UPDATE OR DELETE ON training_file_versions
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
ALTER TABLE training_files ADD CONSTRAINT training_files_current_fk FOREIGN KEY (current_version_id) REFERENCES training_file_versions (id);

-- 分块上传：开始时登记要传的文件（名称、类型、大小、块数），一块块传完再「完成」：服务端按块算摘要（内网 HTTP 下浏览器没有 crypto.subtle），
-- 同样的内容已经有了就不再存一份，登记成文件或新版本。
-- 操作编号：完成没收到结果时原样重提，返回第一次登记的那份（不再建一份）
CREATE TABLE training_uploads (
  id          bigserial PRIMARY KEY,
  client_key  uuid NOT NULL UNIQUE,
  size_bytes  bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 209715200),
  chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 100),
  file_name   text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  mime        text NOT NULL CHECK (char_length(mime) BETWEEN 3 AND 120),
  request_hash text NOT NULL,
  -- cancelled = 管理员确认不传了（服务端作废登记，与「完成」互斥；之后同一个编号不能再传、不能再完成）
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  result_file_id    bigint REFERENCES training_files (id),
  result_version_id bigint REFERENCES training_file_versions (id),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'done') = (result_version_id IS NOT NULL))
);
-- 传到一半的块先放这里，完成时搬进 training_blob_chunks（同一个文件已经有了就不再搬）
CREATE TABLE training_upload_chunks (
  upload_id bigint NOT NULL REFERENCES training_uploads (id) ON DELETE CASCADE,
  seq       integer NOT NULL CHECK (seq >= 0),
  data      bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 4194304),
  PRIMARY KEY (upload_id, seq)
);

CREATE TABLE training_views (
  file_id          bigint NOT NULL REFERENCES training_files (id),
  staff_id         bigint NOT NULL REFERENCES staff (id),
  first_viewed_at  timestamptz NOT NULL DEFAULT now(),
  last_viewed_at   timestamptz NOT NULL DEFAULT now(),
  view_count       integer NOT NULL DEFAULT 1 CHECK (view_count >= 1),
  last_version_id  bigint REFERENCES training_file_versions (id),
  PRIMARY KEY (file_id, staff_id)
);

INSERT INTO position_suggestions (position_key, permission) VALUES ('hr.lead', 'training.manage') ON CONFLICT DO NOTHING;
