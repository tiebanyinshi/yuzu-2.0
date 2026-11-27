# 数据库 Schema 评估与整改（8.1.47）

店主 2026-11-26：审查现有 PostgreSQL 库结构，从规范化、主外键与约束完整性、索引覆盖、慢查询风险、数据归档几方面出评估报告，按优先级列改进建议；结构改动一律写新迁移（不改已发布的迁移）、可回滚，并补数据字典；先出方案，再参考 GitHub 上成熟、星标多的同类项目调整方案，然后整改，给新版本号。

本文按这个顺序写：第 1 节总结；第 2–6 节是逐项的评估（现状、问题、本版怎么改）；第 7 节是迁移流程与护栏；第 8 节是初版方案；第 9 节是参考的开源项目与据此做的调整；第 10 节是按优先级的改进清单（已做 / 待定）；第 11 节是本版改动、验证与回滚。

## 1. 结论

评估对象是迁移 `001`–`472` 跑完的空库（PostgreSQL 16）：**445 张表、5,274 列、1,357 个外键、1,422 个索引、301 个触发器**（本版以后 449 张表、1,703 个索引）。

**底子是好的**：每张表都有主键；外键两端类型都一致；类型用得规范（金额一律整数分、时刻一律 `timestamptz`、没有 `timestamp without time zone`、`money`、`varchar(n)`、`json`）；约束写得多（2,358 个 CHECK、329 个 UNIQUE 约束、941 个唯一索引、468 个部分索引）；账本、流水、审批动作这些「只追加」的表有 164 张挂着拒绝改删的触发器；迁移已经有只增不改的检查与高风险写法检查（`scripts/check-migrations.mjs`，参照 squawk、strong_migrations）。

**主要问题**（按影响排）：

| # | 问题 | 影响 | 本版 |
| --- | --- | --- | --- |
| 1 | **816 个外键没有以它打头的索引**（其中 544 个指向员工、门店） | 删父表的行、按父找子（这张单的明细、这位会员的流水）要整表扫子表；数据一多就慢、锁的范围大 | 迁移 `480` 补 272 个；规则写进用例 |
| 2 | **库里一条注释都没有**，没有数据字典 | 列的含义、单位、取值只能翻 470 份迁移；新人、AI 会话、外部审计都难读 | 迁移 `481` 写进 445 张表、637 列；生成 `docs/DATA_DICTIONARY.md` |
| 3 | **流水型表只增不减、没有归档**（位置事件、轨迹段、对外调用、企业微信推送） | 位置事件每次刷卡一条，量最大；表与索引越来越大 | 迁移 `483` 归档表 + 每小时的归档任务 |
| 4 | **8 张表的 `store_id` 没挂门店外键** | 写错门店号拦不住（多店以后会是真问题） | 迁移 `482` 补上 |
| 5 | **迁移等锁没有上限** | 前面有长事务时，迁移的表锁排着等，后面的读写又排在它后面，整店卡住 | 迁移执行器设 `lock_timeout` |
| 6 | 读卡器列表每个读卡器整表扫位置事件取「最后一次刷卡」 | 位置事件越多越慢 | 迁移 `480` 补索引 |
| 7 | 一个与主键完全重复的索引 | 白占写入与空间 | 迁移 `480` 删掉 |
| 8 | 没有结构规范的自动检查（外键索引、注释、重复索引、NOT VALID） | 上面这些问题会再长出来 | `tests/schema-health.test.ts` |

## 2. 主键、外键与约束完整性

### 2.1 主键

445 张表都有主键。除 `oa_holiday_years`（年份，`integer`）外都是 `bigint`/`bigserial`/`identity` 或业务自然键（`settings.key`、`sessions.token_hash`、`spaces.code` 等），没有 `int4` 自增快溢出的风险。

### 2.2 外键

- 1,357 个外键（7 个多列），两端类型全部一致。
- 删除规则：1,348 个 `NO ACTION`（默认，拒绝删有引用的父行），8 个 `CASCADE`（都是「单据 → 自己的明细」：采购单行、菜单页上的菜、套餐换菜、价目表条目、培训上传的块），1 个 `SET NULL`。账本、资金类没有级联删除，符合「只追加、改错走冲正」。保持现状，不改成 `RESTRICT`（效果相同，`NO ACTION` 还能延迟到语句末检查）。
- **漏挂外键的 `store_id`**：价目表 5 张（`price_catalog_sets`、`_import_ops`、`_set_ops`、`_links`、`_link_ops`）、房态点单 2 张（`room_orders`、`room_order_outlets`）、桌台事件 `table_events`。迁移 `482` 补上（先 `NOT VALID` 再 `VALIDATE`，见第 7 节）。

### 2.3 以 `_id` 结尾却没挂外键的列

一共 69 列（不算归档表），逐类看过，**除上面 8 个 `store_id` 外都是有意的**，白名单写在 `tests/schema-health.test.ts`，新加的 `_id` 列要么挂外键、要么进白名单并在这里写明：

| 类别 | 列 | 为什么不挂 |
| --- | --- | --- |
| 多态引用 | `*.ref_id`、`*.target_id`、`custom_field_values.entity_id`、`gf_files.owner_id`、`approval_*.doc_id` | 指向哪张表由另一列决定，PostgreSQL 外键表达不了 |
| 外部编号 | 微信的 `prepay_id`、`transaction_id`、`wx_refund_id`、`template_id`，`concierge_*` 的 `request_id`/`object_id`，`erp_drafts.last_save_id`，`technician_announcer.client_id`，`studio_comments.node_id`，`oa_payroll_files.key_id`，`canteen_likes.dish_id` | 不是库内的行 |
| 位置遥测 | `location_events.*`、`location_tracks.*`、`current_locations.*` 的人与地点 | 035 有意不挂：刷卡要快，来访、空间改了不能挡住写位置 |
| 会被删的目标 | `price_catalog_set_ops.from_set_id / to_set_id` | 236 有意去掉：草稿、旧版本会删，操作记录要留着 |
| 不碰锁的设计 | `stock_usage_events.*`、`stock_usage_batches.warehouse_id` | 销售扣料先记事件、批处理再入账，有意不跟物料、仓库表抢锁 |
| 冗余指针 | `materials / warehouse_stock.last_move_id`、`inv_doc_lines.book_move_id`、`pay_transactions.consumed_id`、`payment_batch_items.payment_id`、`oa_im_members.last_read_message_id`、`invoice_requests.source_id` | 「最后一次 / 对应的那条」的快捷指针，以流水为准；部分是多态 |
| 小程序线 | `mp_booking_ops.member_id`、`mp_food_orders.member_id` | 小程序线的表，主线不动 |

### 2.4 其他约束

- `NOT VALID`（没核对过旧行的）约束只有一个：`checkout_payments_other_note_check`（017 有意只约束新写入）。白名单固定，新的必须 `VALIDATE`。
- CHECK 约束大量用来表达状态机（「状态是已结束 ⇔ 结束时刻有值」这类成对约束），这是好的做法，继续保持。

## 3. 索引覆盖

### 3.1 外键索引

**816 个外键没有以它打头的索引**。PostgreSQL 不会给外键自动建索引：删父表的行（或改它的主键）时要在子表里找引用，没有索引就整表扫，并对扫到的行加锁；按父找子的查询也走不了索引。

- **指向员工 `staff`（499 个）、门店 `stores`（45 个）的不补**：这两张是主数据，代码里从不删、主键不改；「按经办人 / 按门店」的查询各模块已有自己的复合索引（如 `(store_id, business_date)`）。给几百个「经办人」列各建一个索引，写入成本大、几乎用不上。
- **其余 272 个全部补上**（迁移 `480`）：可以为空的 181 个建部分索引 `WHERE 列 IS NOT NULL`（审批人、合并到谁这类大多为空的列，索引小得多；外键检查的 `col = $1` 照样用得上）；7 个多列外键里没覆盖的 4 个建同样几列的复合索引。
- 补完以后单表索引最多的是 `checkout_payments`（15 个），没有超过 GitLab 建议的「单表不超过 15 个」。
- 规则写进 `tests/schema-health.test.ts` ②：以后的新外键必须同时建索引（指向员工、门店的除外）。

### 3.2 重复与冗余

- `wecom_pushes_recent_idx (id DESC)` 与主键同列（B 树正反向都能扫），迁移 `480` 删掉。用例 ④ 以后拦完全重复的索引。
- 前缀冗余（一个索引是另一个的前几列）还有，如 `refund_items_checkout_idx (checkout_id)` 是新建的 `(checkout_id, category, name)` 的前缀。前缀冗余不一定是浪费（短索引更小、更快），要看线上的使用次数再删，列入 P2。

## 4. 慢查询风险

| 位置 | 写法 | 风险 | 处理 |
| --- | --- | --- | --- |
| 位置 · 读卡器列表 | 每个读卡器 `SELECT max(at) FROM location_events WHERE reader_id = …` | 位置事件只增不减，原来每个读卡器整表扫一遍 | 迁移 `480` 建 `(reader_id, at DESC)` 部分索引 |
| 位置 · 自检 | `DISTINCT ON` 扫全部生效的位置事件 | 后台自检，随事件量变慢 | 归档后热表只留近 180 天 |
| 各种「按父找子」 | 单据明细、会员流水、审批记录 | 外键列没索引时整表扫 | 迁移 `480` |
| 会员、客户查找 | `name ILIKE '%…%'`、`phone LIKE '%…%'` 的 OR | 前后都带 `%`，B 树用不上，整表扫会员 | **不在本版改**：中文名多是 1–2 个字，`pg_trgm` 三字一组的索引对它基本无效；单店会员几万人整表扫仍在毫秒级。先上线 `pg_stat_statements` 看实际耗时再定（P2） |
| 跨表 OR 的查找 | `r.doc_no ILIKE … OR m.name ILIKE …`（单据 + 会员） | 跨表的 OR 走不了索引 | 同上，按实际耗时再拆成 UNION（P2） |
| 全局 | 连接上没有 `statement_timeout` | 一条失控的报表查询能一直跑 | 业务事务已经各自设了 5 秒锁、10 秒语句上限（`setTxTimeouts`）；只读报表的上限列入 P1 |

## 5. 数据归档

原来只有三处清理：没挂上单据的附件（24 小时）、没传完的培训上传、过期一天以上的登录。其余表只增不减。

逐类判断：

- **永久保留、不归档**：账本、充值、消费、冲正、结账收款、日结、审计日志、审批动作、所有单据与明细（财务与审计要求，且只追加）。
- **归档**（迁移 `483`、`src/server/modules/archive.ts`）：只增不减、又只在近期有用的流水型记录——
  - 位置事件 `location_events`、轨迹段 `location_tracks`：保留 180 天（`ARCHIVE_LOCATION_DAYS`）。轨迹段先挪（它引用事件），只挪结束了、不是谁当前所在的那段；事件只挪没有留下的轨迹段与当前位置还引用着的。
  - 对外调用记录 `integration_calls`：180 天（`ARCHIVE_INTEGRATION_CALL_DAYS`；后台只看最近 100 条）。
  - 企业微信推送记录 `wecom_pushes`：365 天，只挪已发完、已失败的（`ARCHIVE_WECOM_PUSH_DAYS`；「每周一次」的去重只看本周）。
  - 设成 `0` 就不归档这一类；少于 30 天拒绝启动（太短会把还在用的挪走）。
- **做法**：挪进同一个库里的 `archived_*` 表（与原表同列，多一列 `archived_at`，原编号不变，也只追加）。不删、不另建模式——备份核对的数据指纹、演示库重置都按 `public` 一个模式处理，放在 `public` 下归档表照样进备份与指纹。热表变小、索引变小，历史还在库里，要查就查归档表。
- **怎么不破坏「只追加」**：原表的触发器换成同样拒绝改删、只在同一事务里 `SET LOCAL yuzu.archiving = 'on'` 时放行 DELETE（只有归档任务这么设，UPDATE 一律拒绝）。这道保护防的是代码写错，不是防有库权限的人（他们本来就能关触发器）。
- **节奏**：每小时一次，每类每次最多 10 批 × 2,000 行，每批一个短事务（5 秒锁上限），挪不完下一小时接着挪；第一次上线若积压很多，几天内挪完，不会一次长时间占锁。
- **以后**：归档表要清理时用 `pg_dump -t 'archived_*'` 导出后 `TRUNCATE`（不触发行级触发器）。表到上亿行再考虑按月分区（见第 9 节，本店规模用不上）。

## 6. 规范化与数据字典

- **范式**：主数据（员工、会员、项目、物料、供应商）都是独立的表，用编号引用；没有发现同一事实在两处可改的地方。有意的冗余都是「快照」：单据明细记下单时的名称与价格、结账记当时的折扣与档阶，这是账务需要（改了价目不能改历史单），不算违反范式。少数「最后一次」指针（第 2.3 节）以流水为准。
- **JSONB**：108 列，基本是请求 / 结果摘要、配置、快照、导入原始行这类「整体读写、不按字段查」的内容，合适；按字段查的都已拆成列。数组 52 列，多是权限、标签、职责这类短清单。
- **类型**：见第 1 节，规范。唯一的浮点是两列坐标（`double precision`），可以接受。
- **数据字典**：原来 0 条库内注释。迁移 `481` 把建表那份迁移里的说明搬进库（`COMMENT ON`）：表取建表语句前紧挨着的注释、没有的取那份迁移开头的说明，末尾写建表迁移号；列取建表语句里这一列的注释、`ADD COLUMN` 前的注释；以 `_cents` 结尾的列加「单位：分」。`scripts/gen-data-dictionary.mjs` 从库里生成 [`docs/DATA_DICTIONARY.md`](DATA_DICTIONARY.md)（按模块分组：表、列、类型、主键、可空、默认、外键指向、说明）。**说明的唯一来源是库内注释**：以后建表的迁移里写 `COMMENT ON`，重新生成；用例 ③ 拦没注释的新表，⑧ 拦没重新生成的字典。
- 自动搬来的说明有的偏长（整段迁移说明）、有的只写了「见迁移说明」级别的信息；后续改到哪张表顺手在新迁移里改写那张表的注释（P2）。

## 7. 迁移流程与护栏

| 项 | 现状 | 本版 |
| --- | --- | --- |
| 只增不改 | `check:migrations` 拦改了已有迁移 | 不变 |
| 高风险写法 | `check:migrations` 拦删表删列、整表改写、改账本、改类型、改名、加 NOT NULL 等，要写「风险已知」 | 不变；本版 4 份迁移都写了 |
| 等锁上限 | 没有 | 执行器拿到咨询锁后设 `lock_timeout`（默认 30 秒，`MIGRATION_LOCK_TIMEOUT` 可调）：等不到就整份回滚、启动失败、由容器重启重试，不会让整店排队 |
| 加外键 / 约束 | 直接加（扫全表时一直持锁） | 先 `NOT VALID`（只拦新写入、不扫旧行）再 `VALIDATE`（只要很轻的锁）；旧数据真有问题时不让发版卡住，留在 NOT VALID 并打警告 |
| 建索引 | 普通 `CREATE INDEX`（建时这张表不能写） | 不变：执行器把全部迁移放在一个事务里，`CONCURRENTLY` 不能在事务里用。门店库是单店规模，本版约 280 个索引在空库上 1 秒内建完、有演示数据的库几秒；改执行器支持「不在事务里跑的迁移」列为 P1 |
| 回滚 | 每份迁移在 `docs/rollback/` 有回滚脚本，没有自动验证 | `tests/db-review-rollback.test.ts`：迁移 → 回滚 → 再迁移，结构逐项与第一次一致；归档的记录回滚时挪回原表 |
| 结构规范 | 没有 | `tests/schema-health.test.ts` 八条（第 1 节表格第 8 行） |

## 8. 初版方案（参考同类项目以前）

1. 给 244 个指向「交易型」父表（单据、会员、班次……）的外键补索引，其余（员工、门店、各种主数据）不补。
2. `COMMENT ON` 写进库，手写一份数据字典文档。
3. 补 `store_id` 外键、删重复索引。
4. 新建 `archive` 模式放归档表；改共用的只追加函数 `yuzu_forbid_mutation`，在归档时放行删除。
5. 给会员查找加 `pg_trgm` 三字索引。
6. 一份 CI 用例拦没索引的新外键（按当时的名单做基线）。

## 9. 参考的开源项目与据此做的调整

调研的是星标多、维护多年、库结构规范公开、在 AI 辅助开发里常被当作范本的项目与工具：

| 项目 | 学到的 | 本版怎么用 |
| --- | --- | --- |
| **GitLab**（数据库开发规范 `doc/development/database`） | 每个外键都要有索引（有专门的检查）；单表索引不超过 15 个；加外键、CHECK 先 `NOT VALID` 后 `VALIDATE`；大表建索引用 `CONCURRENTLY`；迁移要能回滚并在 CI 里验证 | 外键索引从「挑交易型的」改成「除员工、门店外全补」，规则固定进用例，不靠名单；`482` 用 NOT VALID + VALIDATE；新增回滚往返用例；控制单表索引数 |
| **Supabase splinter**（库结构检查规则集） | `unindexed_foreign_keys`、`duplicate_index`、`no_primary_key` 等规则在库上直接查 | `schema-health` 的 ①②④ 照这几条写，直接查系统表 |
| **strong_migrations**（Rails，Mastodon、Discourse 都在用）与 **squawk**（PostgreSQL 迁移检查） | 危险写法清单；`lock_timeout` 防止迁移排队拖垮线上 | 本项目的 `check:migrations` 早就照它们写了；本版补上执行器的 `lock_timeout` |
| **PostHog** | 迁移设 `lock_timeout`（他们用 20 秒）、超时重试 | 默认 30 秒、可调，由容器重启重试 |
| **TigerBeetle**（金融账本库） | 账本只追加，改错用反向记账，不删不改 | 本项目早已如此；归档只碰流水型表，账本与单据明确排除 |
| **tbls**（从库生成文档的工具） | 库内注释是唯一来源，文档由库生成，CI 里比对是否过期 | 不引入外部工具（要另装二进制），写一个几十行的脚本 `gen-data-dictionary.mjs` 做同样的事，并在用例 ⑧ 比对 |
| **PostgreSQL wiki「Don't Do This」** | 不用 `timestamp`（无时区）、`money`、`varchar(n)`、`serial` 混用、`NOT IN` 子查询等 | 逐项核对，现状都没犯 |

**据此对初版方案的调整**：

- 第 1 条：从「挑交易型父表的 244 个」改成「除员工、门店外全补（272 个）+ 用例固定规则」（GitLab、splinter）；可空列改建部分索引，多列外键建复合索引。
- 第 2 条：从「手写字典」改成「库内注释是唯一来源、脚本生成、用例比对」（tbls）。
- 第 3 条：加外键改用 NOT VALID + VALIDATE，旧数据有问题时不让发版卡住（GitLab、strong_migrations）。
- 第 4 条：不改共用的 `yuzu_forbid_mutation`（它保护着账本，开口子风险太大），改成只给 3 张流水表换一个新函数；不另建 `archive` 模式（备份指纹、演示库重置只认 `public`），改成 `archived_*` 表（TigerBeetle 的「账本不动」原则 + 本项目自己的约束）。
- 第 5 条：**撤掉**。`pg_trgm` 对 1–2 个汉字的查找基本无效，同类项目的建议都是先用 `pg_stat_statements` 量了再加。
- 第 6 条：不用名单做基线，改成规则 + 极少的白名单（只有员工、门店两个例外父表，`_id` 无外键列逐条写明理由）。
- 新增：执行器 `lock_timeout`（strong_migrations、PostHog）、回滚往返用例（GitLab）。
- 不采纳：逻辑外键（只在应用层校验）、把归档挪到列存库（ClickHouse）、给小表分区——这些是为千万级以上数据设计的，单店规模用不上，反而增加出错面。

## 10. 改进清单（按优先级）

| 优先级 | 项 | 状态 |
| --- | --- | --- |
| P0 | 外键补索引（272 个）+ 规则进用例 | ✅ 本版（`480`、用例 ②） |
| P0 | 迁移执行器 `lock_timeout` | ✅ 本版 |
| P0 | 漏挂的 `store_id` 外键（8 张） | ✅ 本版（`482`） |
| P1 | 库内注释 + 数据字典 + 用例比对 | ✅ 本版（`481`、`DATA_DICTIONARY.md`、用例 ③⑧） |
| P1 | 流水型热表归档 | ✅ 本版（`483`、归档任务） |
| P1 | 读卡器最后一次刷卡的慢查询 | ✅ 本版（`480`） |
| P1 | 回滚往返用例、结构体检用例 | ✅ 本版 |
| P1 | 执行器支持「不在事务里跑」的迁移，以后大表用 `CREATE INDEX CONCURRENTLY` | 待定：改执行器要同时改迁移记录与失败重试，单独一版做 |
| P1 | 只读报表连接设 `statement_timeout`（如 30 秒） | 待定：要先列出各报表的实际耗时，避免误伤月度报表 |
| P2 | 正式服开 `pg_stat_statements`，按实际耗时决定会员查找是否加 `pg_trgm` / 拆 UNION | 待定：要改正式服 PostgreSQL 配置（`shared_preload_libraries`），需要重启数据库，等店主排时间 |
| P2 | 按线上 `pg_stat_user_indexes.idx_scan = 0` 清理没用过的索引、前缀冗余的索引 | 待定：要正式服跑满一个营业周期的统计 |
| P2 | 自动搬来的偏长、偏泛的表注释逐步改写 | 随改到的表做 |
| P2 | 归档表超过一定量后导出清理的运维说明、按月分区 | 等量到了再做 |

## 11. 本版改动、验证与回滚

**迁移**（ROADMAP 第 7 节登记 `480`–`489`）：

| 迁移 | 内容 | 回滚 |
| --- | --- | --- |
| `480_fk_indexes` | 272 个外键索引、读卡器索引、删重复索引 | `docs/rollback/480_fk_indexes.down.sql`（删索引、重建重复的那个） |
| `481_schema_comments` | 445 张表、637 列的注释 | `docs/rollback/481_schema_comments.down.sql`（清空注释） |
| `482_store_fks` | 8 个门店外键（NOT VALID → VALIDATE） | `docs/rollback/482_store_fks.down.sql`（删约束） |
| `483_archive_tables` | 4 张归档表、归档时放行删除的触发器 | `docs/rollback/483_archive_tables.down.sql`（归档的挪回原表、删归档表、触发器换回原样） |

回滚顺序 483 → 480，每份自带事务；先停服务、先备份。

**代码**：`src/server/migrate.ts`（`lock_timeout`）、`src/server/config.ts`（`ARCHIVE_*_DAYS`）、`src/server/modules/archive.ts` 与 `jobs.ts`（每小时归档）、`scripts/gen-data-dictionary.mjs`。

**用例**：`tests/schema-health.test.ts`（结构体检八条）、`tests/hot-archive.test.ts`（挪什么、不挪什么、保护照旧）、`tests/db-review-rollback.test.ts`（迁移 → 回滚 → 再迁移）、`tests/db-review-config.test.ts`（两处配置）。

**上线注意**：

- 迁移在应用启动时执行。本版建约 280 个索引（含归档表的），建索引时那张表的写入要等（读不受影响）；空库 1 秒、单店库几秒到十几秒。表很大的环境先在影子库量一下。
- 第一次启动后一小时内开始归档，日志写「热表归档：位置事件 …」。不想归档的类别把对应的环境变量设成 `0`。
- `482` 若在启动日志里打了「门店号不存在」的警告，照提示人工核对后补 `VALIDATE CONSTRAINT`。

## 12. 后续进度（店主 2026-11-27「审查报告的都请做完」）

**8.1.54**（第 10 节余下的 P1、P2）：

- **执行器支持「不在事务里跑」的迁移**：
  - 第一行写 `-- yuzu:no-transaction` 的迁移，先提交前面的普通迁移，再单独占一条连接、逐句执行（会话级咨询锁、同样的等锁上限），然后接着往下。
  - 以后大表建索引就写 `DROP INDEX CONCURRENTLY IF EXISTS …; CREATE INDEX CONCURRENTLY …;`，建的时候不挡写入。
  - 规矩写在 `src/server/migrate.ts`：只写简单语句、每句能重复执行。
  - 用例 `tests/migrate-no-tx.test.ts`。
- **页面报表的语句上限**：`readSnapshot`（页面上的报表、看板都走它）每句最多 60 秒。命令行的自检（`cli.js check`）、对账不限。
- **查询统计**：
  - 数据库带 `shared_preload_libraries=pg_stat_statements` 启动，`compose.yaml` 已加。
  - 迁移 `491` 建扩展；没权限、没有这个扩展时跳过，不让发版卡住。
- **体检报告**：`node dist/server/cli.js db-report`，列最耗时的查询、没用过的索引（不含主键与唯一约束）、最大的表。
  - 删不删没用过的索引、要不要给会员查找加 `pg_trgm`，等正式服跑满一个营业周期，按这份报告定，不凭猜。
- **表注释改写**：随改到的表在新迁移里改写，不批量改。
