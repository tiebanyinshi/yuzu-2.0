-- 手牌管理审查修正（Codex 审查 PR #189，docs/FRONTDESK_TAGS_V8127.md 第 3 节）：按规则批量添加带操作编号。
-- 生成提交了、回复丢了或超时时，页面按原编号查回、原样重提（返回第一次的结果，不会再建一批）或确认作废。
-- 编号记在这张表上（不进 idempotency_keys），作废登记在 op_fences：在当时的约束上追加类型（读出原表达式再 OR 上，写法见 162）。

CREATE TABLE hand_tag_generate_ops (
  id           bigserial PRIMARY KEY,
  op_key       uuid NOT NULL UNIQUE,
  store_id     bigint NOT NULL DEFAULT 1 REFERENCES stores (id),
  request_hash text NOT NULL,
  codes        text[] NOT NULL CHECK (cardinality(codes) BETWEEN 1 AND 500),
  created_by   bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER hand_tag_generate_ops_append_only BEFORE UPDATE OR DELETE ON hand_tag_generate_ops
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''hand_tag_generate''))', expression);
END $$;
