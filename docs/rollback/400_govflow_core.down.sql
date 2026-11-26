-- 回滚 400_govflow_core.sql（业财法审批流 P01）：只在没有正式数据时用；表里有数据的先导出留档
DROP TABLE IF EXISTS gf_files;
DROP TABLE IF EXISTS gf_specials;
DROP TABLE IF EXISTS gf_cc;
DROP TABLE IF EXISTS gf_flow_actions;
DROP TABLE IF EXISTS gf_flows;
DROP TABLE IF EXISTS gf_docs;
DROP TABLE IF EXISTS gf_role_members;
