-- OA-14 即时通讯：会话与消息（docs/OA.md 第 17 节；需求文档六（一）、九（二）第 6 条）。
--   · oa_im_conversations：kind = direct 单聊 / group 群聊。单聊的 direct_key = 两人编号小的在前（「3:8」），同两个人只有一个单聊；
--     群聊有群名与群主。last_message_id / last_message_at 给会话列表排序（发消息时在会话行锁里更新）。
--     建群带操作编号（oa_im_group，记在 idempotency_keys，ref_id 是会话）：结果不确定时查回、原样重提或确认作废。
--   · oa_im_members：会话成员。role = owner 群主 / admin 管理员（OA-16）/ member；last_read_message_id = 读到哪一条（只往前走，OA-15 的已读回执用它）；
--     left_at 不为空 = 已经退出（OA-16 踢人、离职退群），历史照留。
--   · oa_im_messages：只追加。kind = text 文本（含表情）/ image 图片 / file 文件（附件 ref_type = 'oa_im_message'）/ system 系统提示；
--     mentions = 被 @ 的人，mention_all = @所有人；client_key = 发送的操作编号（同一个人同一个编号只有一条）；revoked_at = 撤回时间（原内容不再给出）。
-- 回滚：docs/rollback/223_oa_im.down.sql。

CREATE TABLE oa_im_conversations (
  id               bigserial PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('direct', 'group')),
  name             text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 30),
  direct_key       text UNIQUE,
  created_by       bigint NOT NULL REFERENCES staff (id),
  last_message_id  bigint,
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'direct') = (direct_key IS NOT NULL)),
  CHECK ((kind = 'group') = (name IS NOT NULL))
);

CREATE TABLE oa_im_members (
  conversation_id       bigint NOT NULL REFERENCES oa_im_conversations (id),
  staff_id              bigint NOT NULL REFERENCES staff (id),
  role                  text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  last_read_message_id  bigint NOT NULL DEFAULT 0,
  joined_at             timestamptz NOT NULL DEFAULT now(),
  left_at               timestamptz,
  PRIMARY KEY (conversation_id, staff_id)
);
CREATE INDEX oa_im_members_staff_idx ON oa_im_members (staff_id) WHERE left_at IS NULL;

CREATE TABLE oa_im_messages (
  id               bigserial PRIMARY KEY,
  conversation_id  bigint NOT NULL REFERENCES oa_im_conversations (id),
  sender_id        bigint NOT NULL REFERENCES staff (id),
  kind             text NOT NULL CHECK (kind IN ('text', 'image', 'file', 'system')),
  body             text NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  attachment_id    bigint REFERENCES oa_attachments (id),
  mentions         bigint[] NOT NULL DEFAULT '{}',
  mention_all      boolean NOT NULL DEFAULT false,
  client_key       uuid,
  request_hash     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  CHECK ((kind IN ('image', 'file')) = (attachment_id IS NOT NULL)),
  CHECK (kind <> 'text' OR char_length(body) >= 1),
  UNIQUE (sender_id, client_key)
);
CREATE INDEX oa_im_messages_conv_idx ON oa_im_messages (conversation_id, id);
CREATE INDEX oa_im_messages_revoked_idx ON oa_im_messages (conversation_id, revoked_at) WHERE revoked_at IS NOT NULL;
ALTER TABLE oa_im_conversations ADD CONSTRAINT oa_im_conversations_last_fk FOREIGN KEY (last_message_id) REFERENCES oa_im_messages (id);

-- 建群的操作编号：操作编号与「确认作废」的类型约束追加 oa_im_group（在当时的约束上追加）
DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''oa_im_group''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
