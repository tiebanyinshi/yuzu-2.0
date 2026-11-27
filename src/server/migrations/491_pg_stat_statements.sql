-- 数据库评估（8.1.54，docs/DB_REVIEW_V8147.md 第 4、10 节）：建 pg_stat_statements 扩展，记下各条查询的次数与耗时，
-- `node dist/server/cli.js db-report` 看最慢的查询、没用过的索引，按实际耗时再决定加不加索引、删不删索引（不凭猜）。
-- 数据库要带 shared_preload_libraries=pg_stat_statements 启动（compose.yaml 已加）；没预加载时扩展照样建得出来，只是查不到数据。
-- 建扩展要超级用户（Docker 的数据库账号就是）；没权限、镜像里没有这个扩展的不让发版卡住：打一条 NOTICE 跳过，报告里说明没有。
-- 风险已知：只建一个统计用的扩展，不动业务表与数据；回滚见 docs/rollback/491_pg_stat_statements.down.sql。

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
  RAISE NOTICE '没建 pg_stat_statements（%），db-report 里没有最慢的查询这一段', SQLERRM;
END $$;
