-- 员工小程序线（店主 2026-11-27，docs/STAFF_MP.md 第 6、8.3 节，SP05、SP06）：员工小程序「汤崎 WCP」的微信绑定与会话标记。
--   · staffmp_bindings：微信（小程序的 openid）与员工账号的绑定。第一次用账号密码登录时绑上，之后微信一键进；
--     解开只做标记（谁、什么时候、为什么），不删。同一时刻一个 openid 只绑一个账号、一个账号只绑一个 openid（两个部分唯一索引兜底）。
--   · staffmp_sessions：哪些会话是员工小程序发的。会话本身照旧在 sessions（与网页同样滑动过期，req.actor 与权限一模一样），
--     这张表只多记一笔「是小程序发的、用的哪个绑定」：会话删了（退出、过期清理、改密码）这一行跟着删；
--     解绑、停用时按它只清小程序的会话；员工小程序端口只认这里有的令牌。
-- 只建员工小程序线自己的表，不改已有的表。回滚：docs/rollback/650_staffmp_bindings.down.sql（删这两张表，账号与网页会话不动）。

CREATE TABLE staffmp_bindings (
  id             bigserial PRIMARY KEY,
  staff_id       bigint NOT NULL REFERENCES staff (id),
  openid         text NOT NULL CHECK (char_length(openid) BETWEEN 1 AND 128),
  bound_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  revoked_at     timestamptz,
  -- 谁解开的：员工自己（self）、后台（admin，revoked_by 是那位管理员）、换了别的微信或别的账号绑这个微信（rebind）
  revoked_by     bigint REFERENCES staff (id),
  revoke_reason  text CHECK (revoke_reason IN ('self', 'admin', 'rebind')),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK (revoke_reason IS DISTINCT FROM 'admin' OR revoked_by IS NOT NULL)
);
COMMENT ON TABLE staffmp_bindings IS '员工小程序（docs/STAFF_MP.md）：微信 openid 与员工账号的绑定；解开只做标记不删，同一时刻一对一';
CREATE UNIQUE INDEX staffmp_bindings_openid_live ON staffmp_bindings (openid) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX staffmp_bindings_staff_live ON staffmp_bindings (staff_id) WHERE revoked_at IS NULL;
CREATE INDEX staffmp_bindings_staff_idx ON staffmp_bindings (staff_id, bound_at DESC);

CREATE TABLE staffmp_sessions (
  token_hash  text PRIMARY KEY REFERENCES sessions (token_hash) ON DELETE CASCADE,
  staff_id    bigint NOT NULL REFERENCES staff (id),
  -- 微信一键进、或登录时顺带绑上的会话记绑定；只用账号密码登录、没绑微信的为空
  binding_id  bigint REFERENCES staffmp_bindings (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE staffmp_sessions IS '员工小程序（docs/STAFF_MP.md）：哪些会话（sessions）是员工小程序发的；会话删了跟着删，解绑、停用时按它清小程序的会话';
CREATE INDEX staffmp_sessions_staff_idx ON staffmp_sessions (staff_id);
CREATE INDEX staffmp_sessions_binding_idx ON staffmp_sessions (binding_id);
