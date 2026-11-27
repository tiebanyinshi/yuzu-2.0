# 数据字典

> 由 `scripts/gen-data-dictionary.mjs` 从迁移跑完的库生成，**不要手改**。说明取自库内注释（`COMMENT ON`，迁移 `481` 起），
> 改表的迁移里同时写注释，再按脚本开头的命令重新生成；`tests/schema-health.test.ts` 核对这份文档与库一致。评估与规则见 `docs/DB_REVIEW_V8147.md`。

通用约定：金额一律整数「分」（`*_cents`、`amount`、`price` 等整数列）；时刻一律 `timestamptz`；营业日用 `date`；
「只追加」的表（账本、流水、审批动作、归档表）有触发器拒绝改删，改错走冲正或作废登记。
列表里「键」：`PK` 主键；「引用」是外键指向的表。

共 0 张表、0 列。

## 目录

