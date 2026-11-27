-- 8.2.10 业财法「流程与阈值」（店主 2026-11-27《业财法审批与 WCP 模块 需求变更》A2，WB4，设计见 docs/V8210_GF_CONFIG.md）。
--   · gf_settings 多一个键 rules：零星采购基础审核线、部门备用金日 / 月额度默认值、采购部门日累计、验收期限、升级审核角色（金额都是分）；
--     没有这一行的按代码里的默认值（与原来的常量一样，升级后行为不变）。
--   · gf_flow_configs：每类事项店主自己设的流程（按顺序的节点 + 知会角色），只追加：每次保存、清除都新加一版，
--     生效的是最新一版（enabled = false 表示清除，回到内置流程）。在途单不受影响：提交时排好的链已经存在 gf_flows 上。
--   · gf_flows.config_version：这一轮用的是第几版流程（内置的为空）。
-- 回滚见 docs/rollback/610_gf_flow_config.down.sql。

ALTER TABLE gf_settings DROP CONSTRAINT gf_settings_key_check;
ALTER TABLE gf_settings ADD CONSTRAINT gf_settings_key_check CHECK (key IN ('purchase_dept_id', 'rules')) NOT VALID;
ALTER TABLE gf_settings VALIDATE CONSTRAINT gf_settings_key_check;

CREATE TABLE gf_flow_configs (
  id          bigserial PRIMARY KEY,
  doc_type    text NOT NULL CHECK (char_length(doc_type) BETWEEN 1 AND 40),
  version     integer NOT NULL CHECK (version > 0),
  -- false = 清除（回到内置流程）
  enabled     boolean NOT NULL,
  -- 按顺序的节点（引擎的节点格式）；空 = 审批链用内置的
  nodes       jsonb CHECK (nodes IS NULL OR (jsonb_typeof(nodes) = 'array' AND jsonb_array_length(nodes) BETWEEN 1 AND 6)),
  -- 通过后知会的角色；空 = 用内置的，空数组 = 不知会
  cc_roles    text[],
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_type, version),
  CHECK (enabled OR (nodes IS NULL AND cc_roles IS NULL))
);
COMMENT ON TABLE gf_flow_configs IS '610 业财法各类事项店主设的流程（8.2.10，docs/V8210_GF_CONFIG.md）：只追加，每次保存 / 清除一版，生效的是最新一版（enabled = false 为清除、用内置流程）；nodes 是引擎的节点、cc_roles 是知会角色，空 = 用内置的';
COMMENT ON COLUMN gf_flow_configs.nodes IS '按顺序的审批节点（dept_head / performer / role 或签 / all 会签），1–6 级；空 = 审批链用内置的';
COMMENT ON COLUMN gf_flow_configs.cc_roles IS '通过后知会的角色；空 = 用内置的，空数组 = 不知会';

ALTER TABLE gf_flows ADD COLUMN config_version integer CHECK (config_version IS NULL OR config_version > 0);
COMMENT ON COLUMN gf_flows.config_version IS '这一轮按「流程与阈值」里第几版流程排的（8.2.10）；空 = 内置流程';
