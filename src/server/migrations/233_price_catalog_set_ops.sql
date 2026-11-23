-- 价目表录入：整体回滚带操作编号（Codex 审查 PR #160 P1；docs/PRICE_CATALOG.md 第 5 节）。
-- 第一次回滚 B→A 已经提交、响应却丢了，之后别人又回滚 A→B：原样重提第一次的请求（生效的还是 B）不能再把它切回 A。
-- 同一个编号直接返回现在的样子、什么都不改。只追加。

CREATE TABLE price_catalog_set_ops (
  op_key      text PRIMARY KEY CHECK (char_length(op_key) BETWEEN 8 AND 64),
  store_id    bigint NOT NULL DEFAULT yuzu_store(),
  action      text NOT NULL CHECK (action IN ('rollback')),
  -- 换下来的那份与恢复生效的那份（之后被放弃的草稿不会是这两份：只有停用 / 生效的才参与回滚）
  from_set_id bigint NOT NULL REFERENCES price_catalog_sets (id),
  to_set_id   bigint NOT NULL REFERENCES price_catalog_sets (id),
  staff_id    bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
