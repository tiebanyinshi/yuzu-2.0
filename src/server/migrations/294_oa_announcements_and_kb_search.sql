-- 员工办公 v1.1 第 5 批（docs/OA_MOBILE.md 第 5 节）：
--   · oa_announcements：公司 / 部门公告（置顶、全员或指定部门、正文、附件、发布 / 撤回与乐观锁版本号）；
--   · oa_announcement_reads：员工已读记录（每人每条公告一行）；
--   · 权限项 oa.announce 的建议权限：人力行政部负责人（总裁默认都有）；
--   · 操作编号与确认作废的类型约束动态追加 oa_announcement；
--   · oa_notifications 的 kind 约束动态追加 announcement。
-- 回滚：docs/rollback/294_oa_announcements_and_kb_search.down.sql。

CREATE TABLE oa_announcements (
  id             bigserial PRIMARY KEY,
  store_id       bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  body           text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  scope          text NOT NULL CHECK (scope IN ('all', 'dept')),
  target_depts   text[] NOT NULL DEFAULT '{}',
  pinned         boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'recalled')),
  published_by   bigint NOT NULL REFERENCES staff (id),
  published_at   timestamptz NOT NULL DEFAULT now(),
  recalled_by    bigint REFERENCES staff (id),
  recalled_at    timestamptz,
  recall_reason  text NOT NULL DEFAULT '' CHECK (char_length(recall_reason) <= 200),
  version        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (scope = 'all' OR cardinality(target_depts) >= 1),
  CHECK ((status = 'recalled') = (recalled_at IS NOT NULL)),
  CHECK ((status = 'recalled') = (recalled_by IS NOT NULL))
);

CREATE INDEX oa_announcements_store_list_idx
  ON oa_announcements (store_id, status, pinned DESC, published_at DESC, id DESC);

CREATE TABLE oa_announcement_reads (
  announcement_id bigint NOT NULL REFERENCES oa_announcements (id),
  staff_id        bigint NOT NULL REFERENCES staff (id),
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, staff_id)
);

CREATE INDEX oa_announcement_reads_staff_idx
  ON oa_announcement_reads (staff_id, announcement_id);

INSERT INTO position_suggestions (position_key, permission)
VALUES ('hr.lead', 'oa.announce')
ON CONFLICT DO NOTHING;

-- 在当时的约束上追加 oa_announcement（不照旧名单重建，避免覆盖其他迁移加的类型）
DO $$
DECLARE
  t text;
  expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression
      FROM pg_constraint
     WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN
      RAISE EXCEPTION '找不到 %.%_op_type_check 约束', t, t;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''oa_announcement''))', t, t || '_op_type_check', expression);
  END LOOP;
END $$;

-- 站内通知 kind 约束追加 announcement
DO $$
DECLARE
  expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression
    FROM pg_constraint
   WHERE conrelid = 'oa_notifications'::regclass AND conname = 'oa_notifications_kind_check';
  IF expression IS NULL THEN
    RAISE EXCEPTION '找不到 oa_notifications.oa_notifications_kind_check 约束';
  END IF;
  ALTER TABLE oa_notifications DROP CONSTRAINT oa_notifications_kind_check;
  EXECUTE format('ALTER TABLE oa_notifications ADD CONSTRAINT oa_notifications_kind_check CHECK ((%s) OR kind IN (''announcement''))', expression);
END $$;
