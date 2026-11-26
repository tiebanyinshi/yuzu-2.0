-- 8.1.44（docs/V8144_CASHIER.md 第 1、2 条）：前台备注——记经办人与时间，分「同组备注」与「单人备注」，可带一个标签（客诉、特殊关照……）。
-- 收银台的「备注」板块与发卡台客人卡上的备注是同一份数据，不另建两套。
--   · visit_remarks：一条备注（只追加）。单人备注记在一位客人（一次来访）上；同组备注记在同行组上，组里每位客人都看得到，
--     visit_id 记的是写的时候打开的那位客人；
--   · visit_remark_removals：撤下一条备注（只追加，一条备注只能撤一次）：谁、几点、原因。撤下的照旧留着，页面上划掉显示。
-- 标签是文字（照「数据字典」里「前台备注的标签」写进来，那份清单待业务确认），不建外键：清单改了，以前记的照旧显示原来的字。
-- 回滚：docs/rollback/350_visit_remarks.down.sql。

CREATE TABLE visit_remarks (
  id         bigserial PRIMARY KEY,
  store_id   bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  visit_id   bigint NOT NULL REFERENCES visits (id),
  scope      text NOT NULL CHECK (scope IN ('single', 'group')),
  -- 同组备注：写的时候这位客人所在的同行组；单人备注为空
  group_id   bigint REFERENCES visit_groups (id),
  tag        text NOT NULL DEFAULT '' CHECK (char_length(tag) <= 20),
  note       text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 200),
  -- 这一次操作的编号：一个编号一条，原样重提返回第一次的结果
  op_key     uuid NOT NULL UNIQUE,
  created_by bigint NOT NULL REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'group') = (group_id IS NOT NULL))
);
CREATE INDEX visit_remarks_visit_idx ON visit_remarks (visit_id, id);
CREATE INDEX visit_remarks_group_idx ON visit_remarks (group_id, id) WHERE group_id IS NOT NULL;
CREATE TRIGGER visit_remarks_append_only BEFORE UPDATE OR DELETE ON visit_remarks
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE visit_remark_removals (
  id         bigserial PRIMARY KEY,
  remark_id  bigint NOT NULL UNIQUE REFERENCES visit_remarks (id),
  reason     text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  created_by bigint NOT NULL REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER visit_remark_removals_append_only BEFORE UPDATE OR DELETE ON visit_remark_removals
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
