-- 回滚 600_gf_role_snapshot.sql（8.2.9 业财法角色映射可改、审批人快照）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 回滚后在审单的审批人改回实时取；映射的修改历史（replaces_id、原因）丢掉，撤销与新建的记录本身还在。
BEGIN;
ALTER TABLE gf_flows DROP COLUMN seat_snapshot;
DROP INDEX gf_role_members_replaces_idx;
ALTER TABLE gf_role_members DROP COLUMN revoke_reason, DROP COLUMN replaces_id;
DELETE FROM schema_migrations WHERE version = '600_gf_role_snapshot.sql';
COMMIT;
