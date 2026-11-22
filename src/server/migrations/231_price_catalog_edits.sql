-- 价目表录入 第三批 编辑与校验（docs/PRICE_CATALOG.md 第 5 节，PENDING_DECISIONS「价目表录入」PC9 起）：
--   · 条目加版本号：页面改价、停用带着读到的版本，别人先改了就拒绝（不悄悄覆盖）；
--   · 改价留痕 price_catalog_changes：新增、修改、停用、启用各记一条——经办人、时间、改前与改后的整项（价格写法由页面按
--     改前 / 改后算「旧价 → 新价」）、原因。只追加：不许改。草稿被新的导入替换或放弃时连同它的条目一起删掉
--     （草稿不参与开单；导入、放弃另有审计记录），所以这里只挡 UPDATE、不挡级联的 DELETE。
--   · 切换生效、整体回滚改的是 price_catalog_sets 的状态（230 已有的列），记审计，不另建表。

ALTER TABLE price_catalog_entries ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);

CREATE TABLE price_catalog_changes (
  id            bigserial PRIMARY KEY,
  set_id        bigint NOT NULL REFERENCES price_catalog_sets (id) ON DELETE CASCADE,
  entry_id      bigint NOT NULL REFERENCES price_catalog_entries (id) ON DELETE CASCADE,
  action        text NOT NULL CHECK (action IN ('create', 'update', 'deactivate', 'reactivate')),
  -- 改后的名称（列表不用再连条目表）
  entry_name    text NOT NULL CHECK (char_length(entry_name) BETWEEN 1 AND 48),
  -- 改前与改后的整项（新增没有改前）
  before        jsonb,
  after         jsonb NOT NULL,
  -- 价格（形态、两个价、比例、加钟 / 超时、封顶、分档价）有没有变：「只看改价」用
  price_changed boolean NOT NULL DEFAULT false,
  reason        text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  staff_id      bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'create') = (before IS NULL))
);
CREATE INDEX price_catalog_changes_set_idx ON price_catalog_changes (set_id, id DESC);
CREATE INDEX price_catalog_changes_entry_idx ON price_catalog_changes (entry_id, id DESC);
CREATE TRIGGER price_catalog_changes_no_update BEFORE UPDATE ON price_catalog_changes
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
