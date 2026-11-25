-- 员工办公 v1.1 第 2 批（docs/OA_MOBILE.md 第 3、5 节；需求文档 5.2）：排班授权。
--   · oa_schedule_grants：人事（hr.attendance）或部门经理把本范围的排班权限授给下属（主管 / 部长 / 指定员工）。
--   · 权限点 permissions：非空，只能是 view / edit / publish 的子集，绝不含 grant（不可转授）。
--   · 范围 scope_type：all_company / group / dept / dept_tree / staff；
--     scope_cap_depts：部门经理授出时记下其授权当时内置可管的部门树（人事为 NULL），实时校验时再交一次，防外部门人员加进考勤组后越权。
--   · 有效期 valid_from – valid_to（默认一年），过期自动失效。
--   · grantee_position：授权当时被授权人的岗位快照；调岗（staff.position 变化）或离职停用即自动失效。
--   · 撤销：写 revoked_at / revoked_by / revoke_reason，不删行；全程写 audit_logs。
--   · 操作编号与「确认作废」的类型约束追加 oa_schedule_grant（在当时的约束上追加）。
-- 回滚：docs/rollback/292_oa_schedule_grants.down.sql。

CREATE TABLE oa_schedule_grants (
  id               bigserial PRIMARY KEY,
  store_id         bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  grantor_staff_id bigint NOT NULL REFERENCES staff (id),
  grantee_staff_id bigint NOT NULL REFERENCES staff (id),
  permissions      text[] NOT NULL,
  scope_type       text NOT NULL CHECK (scope_type IN ('all_company', 'group', 'dept', 'dept_tree', 'staff')),
  scope_group_id   bigint REFERENCES oa_attendance_groups (id),
  scope_dept_key   text REFERENCES org_departments (key),
  scope_staff_ids  bigint[],
  scope_cap_depts  text[],
  valid_from       date NOT NULL,
  valid_to         date NOT NULL,
  grantee_position text NOT NULL,
  note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  client_key       uuid NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoked_by       bigint REFERENCES staff (id),
  revoke_reason    text CHECK (revoke_reason IS NULL OR char_length(revoke_reason) <= 200),
  CHECK (grantor_staff_id <> grantee_staff_id),
  CHECK (cardinality(permissions) > 0 AND permissions <@ ARRAY['view', 'edit', 'publish']::text[]),
  CHECK (valid_to >= valid_from),
  CHECK (scope_type <> 'all_company' OR (scope_group_id IS NULL AND scope_dept_key IS NULL AND scope_staff_ids IS NULL)),
  CHECK (scope_type <> 'group' OR (scope_group_id IS NOT NULL AND scope_dept_key IS NULL AND scope_staff_ids IS NULL)),
  CHECK (scope_type NOT IN ('dept', 'dept_tree') OR (scope_dept_key IS NOT NULL AND scope_group_id IS NULL AND scope_staff_ids IS NULL)),
  CHECK (scope_type <> 'staff' OR (scope_staff_ids IS NOT NULL AND cardinality(scope_staff_ids) > 0 AND scope_group_id IS NULL AND scope_dept_key IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_by IS NOT NULL)
);
CREATE INDEX oa_schedule_grants_grantee_active_idx
  ON oa_schedule_grants (store_id, grantee_staff_id, valid_from, valid_to)
  WHERE revoked_at IS NULL;
CREATE INDEX oa_schedule_grants_store_created_idx
  ON oa_schedule_grants (store_id, created_at DESC, id DESC);

DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''oa_schedule_grant''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
