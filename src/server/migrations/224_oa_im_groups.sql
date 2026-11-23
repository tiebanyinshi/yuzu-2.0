-- OA-16 通讯录与群管理（docs/OA.md 第 19 节；需求文档六（二）、六（三））。
--   · oa_im_conversations：dept_key = 部门群对应的部门（没解散的同一个部门只有一个）；notice = 群公告（谁、什么时候）；dissolved_at = 解散时间
--     （解散后不能再发、不能再管，历史照留）。
--   · oa_im_members：source = 进群方式：manual 建群、拉人 / dept 部门同步（部门群里因部门进来的，不能被踢、不能自己退）。
--   · 部门群同步与离职退群：员工（岗位、启用、角色）与员工档案（在职状态）一变，触发器在同一个事务里给这个人进出群，
--     不管是哪条路径改的。不在职（停用、离职、专用账号）的退出全部没解散的群（群主转给最早的管理员，没有就转给最早进群的成员）；
--     在职的：部门同步进来的、部门变了的退出原部门群；本部门有部门群而不在里面的进群（读到的位置记在最新一条，没有积压的未读）。
--     锁顺序：员工 / 员工档案（改的那一句已经锁着）→ 会话行（FOR UPDATE，按会话编号）→ 成员行 → 系统提示消息。
-- 回滚：docs/rollback/224_oa_im_groups.down.sql。

ALTER TABLE oa_im_conversations
  ADD COLUMN dept_key        text REFERENCES org_departments (key),
  ADD COLUMN notice          text CHECK (notice IS NULL OR char_length(notice) <= 500),
  ADD COLUMN notice_by       bigint REFERENCES staff (id),
  ADD COLUMN notice_at       timestamptz,
  ADD COLUMN dissolved_at    timestamptz,
  ADD CONSTRAINT oa_im_conversations_dept_group CHECK (dept_key IS NULL OR kind = 'group');
CREATE UNIQUE INDEX oa_im_conversations_dept_uq ON oa_im_conversations (dept_key) WHERE dept_key IS NOT NULL AND dissolved_at IS NULL;

ALTER TABLE oa_im_members ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'dept'));

-- 在会话里留一条系统提示（会话行已经锁着）
CREATE FUNCTION oa_im_system_message(p_conversation bigint, p_sender bigint, p_body text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO oa_im_messages (conversation_id, sender_id, kind, body) VALUES (p_conversation, p_sender, 'system', p_body) RETURNING id INTO v_id;
  UPDATE oa_im_conversations SET last_message_id = v_id, last_message_at = now() WHERE id = p_conversation;
END $$;

-- 给一位员工进出群：离职 / 停用 / 专用账号退出全部群；部门变了退出原部门群、进新部门群
CREATE FUNCTION oa_im_sync_staff(p_staff bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_on_duty boolean;
  v_dept    text;
  v_name    text;
  r         record;
BEGIN
  SELECT s.active AND NOT s.system AND s.role <> ALL (ARRAY['tablet', 'other_store', 'designer']) AND COALESCE(p.status, 'active') = 'active',
         CASE WHEN s.position IS NULL THEN NULL WHEN s.position = 'president' THEN 'company' WHEN s.position = 'gmo' THEN 'gmo'
              ELSE split_part(s.position, '.', 1) END,
         s.display_name
    INTO v_on_duty, v_dept, v_name
    FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id WHERE s.id = p_staff;
  IF NOT FOUND THEN RETURN; END IF;

  FOR r IN
    SELECT c.id FROM oa_im_members m JOIN oa_im_conversations c ON c.id = m.conversation_id
     WHERE m.staff_id = p_staff AND m.left_at IS NULL AND c.kind = 'group' AND c.dissolved_at IS NULL
       AND (NOT v_on_duty OR (m.source = 'dept' AND c.dept_key IS DISTINCT FROM v_dept))
     ORDER BY c.id
  LOOP
    PERFORM 1 FROM oa_im_conversations WHERE id = r.id FOR UPDATE;
    -- 锁到以后再看一次（等锁期间别人可能已经把他踢了或解散了）
    PERFORM 1 FROM oa_im_members m JOIN oa_im_conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = r.id AND m.staff_id = p_staff AND m.left_at IS NULL AND c.dissolved_at IS NULL;
    CONTINUE WHEN NOT FOUND;
    UPDATE oa_im_members SET left_at = now(), role = 'member' WHERE conversation_id = r.id AND staff_id = p_staff;
    -- 群主走了：转给最早的管理员，没有就转给最早进群的成员
    IF NOT EXISTS (SELECT 1 FROM oa_im_members WHERE conversation_id = r.id AND left_at IS NULL AND role = 'owner') THEN
      UPDATE oa_im_members SET role = 'owner'
       WHERE (conversation_id, staff_id) = (
         SELECT conversation_id, staff_id FROM oa_im_members WHERE conversation_id = r.id AND left_at IS NULL
          ORDER BY (role = 'admin') DESC, joined_at, staff_id LIMIT 1);
    END IF;
    PERFORM oa_im_system_message(r.id, p_staff, v_name || CASE WHEN v_on_duty THEN '调离了部门，退出了群聊' ELSE '已离职，退出了群聊' END);
  END LOOP;

  IF v_on_duty AND v_dept IS NOT NULL THEN
    FOR r IN
      SELECT c.id FROM oa_im_conversations c
       WHERE c.dept_key = v_dept AND c.dissolved_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM oa_im_members m WHERE m.conversation_id = c.id AND m.staff_id = p_staff AND m.left_at IS NULL)
       ORDER BY c.id
    LOOP
      PERFORM 1 FROM oa_im_conversations WHERE id = r.id FOR UPDATE;
      PERFORM 1 FROM oa_im_conversations c WHERE c.id = r.id AND c.dissolved_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM oa_im_members m WHERE m.conversation_id = c.id AND m.staff_id = p_staff AND m.left_at IS NULL);
      CONTINUE WHEN NOT FOUND;
      INSERT INTO oa_im_members (conversation_id, staff_id, role, source, last_read_message_id)
        SELECT r.id, p_staff, 'member', 'dept', COALESCE(last_message_id, 0) FROM oa_im_conversations WHERE id = r.id
      ON CONFLICT (conversation_id, staff_id) DO UPDATE
        SET left_at = NULL, role = 'member', source = 'dept', joined_at = now(),
            last_read_message_id = GREATEST(oa_im_members.last_read_message_id, EXCLUDED.last_read_message_id);
      PERFORM oa_im_system_message(r.id, p_staff, v_name || '加入了群聊');
    END LOOP;
  END IF;
END $$;

CREATE FUNCTION oa_im_staff_sync_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM oa_im_sync_staff(NEW.id);
  RETURN NULL;
END $$;
CREATE FUNCTION oa_im_profile_sync_trg() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM oa_im_sync_staff(NEW.staff_id);
  RETURN NULL;
END $$;

CREATE TRIGGER oa_im_staff_sync_ins AFTER INSERT ON staff FOR EACH ROW EXECUTE FUNCTION oa_im_staff_sync_trg();
CREATE TRIGGER oa_im_staff_sync_upd AFTER UPDATE OF position, active, role ON staff FOR EACH ROW
  WHEN (OLD.position IS DISTINCT FROM NEW.position OR OLD.active IS DISTINCT FROM NEW.active OR OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION oa_im_staff_sync_trg();
CREATE TRIGGER oa_im_profile_sync AFTER INSERT OR UPDATE OF status ON staff_profiles FOR EACH ROW EXECUTE FUNCTION oa_im_profile_sync_trg();
