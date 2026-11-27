-- 8.2.5：8.2.4 合并前没等完的 Codex 审查（PR #46，524001a）报的两处要改库：
--   · 一报多（8.2.2）建的技师预约是有意不查同一位技师同一时段别的预约的——记在 bookings.technician_overlap，
--     前台自检「预约不重叠」不再把这种当成数据错误（别的重叠照旧报）；
--   · 返台（8.2.4）改成前台「结果待确认」的一类：操作编号记在 idempotency_keys（op_type = table_return，ref_id 是那次开台），
--     没收到回复时能查回、原样重提或确认作废（确认作废以后原请求整笔回滚，连反结账一起）。8.2.4 已经返过台的补记编号，
--     这样查回得到、不会被误作废。
-- 风险已知：只加列（默认 false）、在当时的约束上追加一个类型、补记编号（只插不改）。回滚见 docs/rollback/570_review_v825.down.sql。

ALTER TABLE bookings ADD COLUMN technician_overlap boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN bookings.technician_overlap IS '8.2.5：一报多（8.2.2）建的技师预约——指定技师时有意不查他同一时段别的预约；前台自检「预约不重叠」不把它当错误';

DO $$
DECLARE
  t text;
  expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression
    FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type = ''table_return'')', t, t || '_op_type_check', expression);
  END LOOP;
END $$;

-- 8.2.4 已经返过台的：补记操作编号（请求摘要留空——返台查回只认编号与那次开台）
INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id, created_at)
SELECT r.client_key, 'table_return', '', r.session_id, r.created_by, r.created_at
FROM table_session_returns r
ON CONFLICT (key) DO NOTHING;
