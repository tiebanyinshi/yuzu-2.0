-- 价目表录入：导入草稿带操作编号（Codex 审查 PR #160 P1；docs/PRICE_CATALOG.md 第 3 节）。
-- 导入已经提交、响应却丢了（断网、超时）时，页面原样重提：同一个编号直接返回第一次导入的那份草稿，不再删掉草稿重新导；
-- 那份草稿后来已被替换或放弃的，拒绝（IMPORT_DONE），不会把别人新导的草稿覆盖掉。只追加，导入的编号一直留着。

CREATE TABLE price_catalog_import_ops (
  op_key     text PRIMARY KEY CHECK (char_length(op_key) BETWEEN 8 AND 64),
  store_id   bigint NOT NULL DEFAULT yuzu_store(),
  -- 导入出来的那份草稿；草稿被替换或放弃后为空
  set_id     bigint REFERENCES price_catalog_sets (id) ON DELETE SET NULL,
  -- 文件内容的摘要：同一个编号换了文件的拒绝
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  staff_id   bigint NOT NULL REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
