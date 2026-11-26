-- 后端评估（8.1.48，docs/BACKEND_REVIEW_V8148.md 第 5 节）：审计记录记上请求编号。
-- 三个端口每个请求都有编号（认网关、反向代理带来的 x-request-id，没有就生成；响应头带回、日志每行带 reqId），
-- 审计记录 audit_logs 加一列 request_id 记下来：店里报「某某时候那一单不对」时，从审计一行就能找到那次请求的全部日志。
-- 只加一列可以为空的列（旧记录、每分钟的自动任务写的为空），不改已有的行，账本只追加的保护不变。
-- 风险已知：只加一列可空的列与长度约束，不动已有数据；回滚见 docs/rollback/490_audit_request_id.down.sql。

ALTER TABLE audit_logs ADD COLUMN request_id text CHECK (request_id IS NULL OR char_length(request_id) BETWEEN 1 AND 64);
COMMENT ON COLUMN audit_logs.request_id IS '写这条审计的那次请求的编号（响应头 x-request-id、日志里的 reqId）；自动任务写的为空（迁移 490）';
