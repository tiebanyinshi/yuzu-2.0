-- 8.2.9 业财法角色映射可改、看得到变更记录、提交时快照审批人（店主 2026-11-27《业财法审批与 WCP 模块 需求变更》A1，WB1、WB2，设计见 docs/V829_GF_ROLES.md）。
--   · 改一条映射（换人、改经营主体范围、改备注）= 把旧的一条撤销、新建一条，新的一条记 replaces_id 指回旧的；角色本身不能改（WB1：停用后新建）。
--     撤销、修改都要写原因（revoke_reason），映射的增、改、撤整个历史就是变更记录，不另建表。
--   · gf_flows.seat_snapshot：提交那一刻各角色是谁、部门负责人是谁（WB2 方案 A：改映射不影响在途单）。旧的在审单为空，照旧实时取。
-- 回滚见 docs/rollback/600_gf_role_snapshot.down.sql。

ALTER TABLE gf_role_members
  ADD COLUMN replaces_id   bigint REFERENCES gf_role_members (id),
  ADD COLUMN revoke_reason text NOT NULL DEFAULT '' CHECK (char_length(revoke_reason) <= 200);
CREATE INDEX gf_role_members_replaces_idx ON gf_role_members (replaces_id) WHERE replaces_id IS NOT NULL;
COMMENT ON COLUMN gf_role_members.replaces_id IS '修改映射时新的一条指回被替换的旧一条（8.2.9）';
COMMENT ON COLUMN gf_role_members.revoke_reason IS '撤销或被修改替换的原因（8.2.9）';

ALTER TABLE gf_flows ADD COLUMN seat_snapshot jsonb CHECK (seat_snapshot IS NULL OR jsonb_typeof(seat_snapshot) = 'object');
COMMENT ON COLUMN gf_flows.seat_snapshot IS '提交时的审批人快照 {members: {角色: [staff_id]}, deptHeadId}（8.2.9，WB2）；空 = 旧单，实时取';
