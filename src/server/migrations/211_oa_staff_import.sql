-- OA-02 账号与批量开通（docs/OA.md 第 5 节）：后台「组织架构 → 批量开通」按表格一次建一批员工账号与员工档案。
--   · oa_staff_imports：一次开通一行——操作编号（同一编号只开一次）、文件名与摘要、开了哪些账号、经办人与时间。只追加；
--     临时密码只在开通的那一次回答里给出（账号表里只存散列），这里不记。
-- 操作编号与「确认作废」多一类 oa_staff_import（在当时的约束上追加）；不改已有的表与数据。
-- 回滚：docs/rollback/211_oa_staff_import.down.sql（删这张表；开好的账号与档案照旧在）。

CREATE TABLE oa_staff_imports (
  id          bigserial PRIMARY KEY,
  client_key  uuid NOT NULL UNIQUE,
  file_name   text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  staff_ids   bigint[] NOT NULL CHECK (cardinality(staff_ids) BETWEEN 1 AND 500),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''oa_staff_import''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
