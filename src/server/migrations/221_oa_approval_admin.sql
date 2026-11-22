-- OA-12 审批管理端（docs/OA.md 第 15 节）：两项新权限的建议权限（与 src/shared/positions.ts 的 POSITION_DEFAULTS 一致）。
--   · oa.templates（办公审批的模板设置：谁审批、谁抄送，算「账号与权限配置」）：人力行政部负责人；总裁默认都有。
--   · oa.all（全部办公审批单、催办、导出、看板，算「跨部门数据」）：总经办、人力行政部负责人。
-- 没有新表；催办沿用 oa_approval_act 的操作编号。回滚：docs/rollback/221_oa_approval_admin.down.sql。
INSERT INTO position_suggestions (position_key, permission) VALUES ('hr.lead', 'oa.templates'), ('hr.lead', 'oa.all'), ('gmo', 'oa.all') ON CONFLICT DO NOTHING;
