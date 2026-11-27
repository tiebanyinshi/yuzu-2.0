# v8.2.26 交接说明 · 员工小程序「汤崎 WCP」第一版

员工小程序线集成 PR [tiebanyinshi/yuzu-2.0#53](https://github.com/tiebanyinshi/yuzu-2.0/pull/53)。店主 2026-11-27 立项：员工用的微信小程序，正式、有设计感，把 WCP（打卡、排班、审批、工资条、通讯录、公告）、员工培训与汤崎学堂、饭堂与巡场收进一个小程序，替代柚子饭堂网页的员工端；「不要按照我给的模块搭建，你自己设计」，方案经一位独立的「小程序清晰人性化」评审改过一轮（`docs/STAFF_MP.md` 第 13.2 节）。

按批分了六个子 PR，各自过 CI 与 Codex 审查（每个最多 5 轮）以后合进集成分支 `claude/awesome-wozniak-e0symx`，再由集成 PR 用 8.2.26 合进 main：

| 批           | 子 PR                                                     | 范围                                                                                                                                       | 迁移  |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| 0 立项       | （集成分支直接提交）                                      | 设计稿、三条线分工（`docs/STAFF_MP.md` 第 7 节）、迁移号登记、待确认 SP01 起                                                               |       |
| A 端口与登录 | A [#54](https://github.com/tiebanyinshi/yuzu-2.0/pull/54) | 员工小程序端口 `STAFFMP_PORT`（`/api/staffmp/*`）、Bearer 会话、微信登录与绑定（改绑要确认）、白名单挂接 WCP 与员工培训、选岗位、短时地址；后台「员工小程序」；线范围检查认员工小程序线 | `650` |
| B 骨架与学习 | B [#59](https://github.com/tiebanyinshi/yuzu-2.0/pull/59) | `staff-miniprogram/` 工程、设计令牌、导航栏、登录、四个 Tab、我的、学习 Tab 的知识库                                                        |       |
| C 工作台     | C [#64](https://github.com/tiebanyinshi/yuzu-2.0/pull/64) | 打卡（定位、外勤、提前下班要确认、结果待确认）、排班、考勤记录、假期、发起申请、审批、工资条、通讯录、公告、通知                           |       |
| E 吃饭与巡场 | E [#67](https://github.com/tiebanyinshi/yuzu-2.0/pull/67) | 饭卡对上（后台按手机号、员工用饭堂账号证明、开通）；饭卡码（离线）、菜单、负责人扫码登记、巡场、巡场记录；后台「饭卡对上」                 | `651` |
| D 今天       | D [#71](https://github.com/tiebanyinshi/yuzu-2.0/pull/71) | 首页：此刻卡、固定按钮（打卡 · 饭卡码 · 扫一扫）、待办、今天、公告、铃铛；带上 E 合并后才推的审查修复                                       |       |
| F 学习接学堂 | F [#74](https://github.com/tiebanyinshi/yuzu-2.0/pull/74) | 员工小程序端口挂汤崎学堂（8.2.18）的员工端接口；学习 Tab 的学堂一块，课程、学习地图、课时、测验、每日一练                                  |       |
| 收口         | （集成分支直接提交）                                      | 把 `main` 合进来、版本号 8.2.26、本交接说明、`.dockerignore`                                                                                |       |

- 设计：`docs/STAFF_MP.md`（第 2 节界面与每个 Tab，第 5 节服务端与白名单，第 7 节三条线的分工，第 8 节接口与数据，第 10 节上线手续，第 13 节评审）。
- 默认做法（待确认）：`docs/PENDING_DECISIONS.md`「员工小程序（汤崎 WCP）」SP01–SP18（SP17 域名店主已定）。
- 加锁顺序：`docs/LOCKING.md` 第 11 节。
- 版本号：合并时 main 是 8.2.20；main 的 ROADMAP 写明 8.2.19–8.2.25 排给《新店系统需求现场走场确认》那条线、「别的线请从 8.2.26 起排」，这一版用 8.2.26。员工小程序自己的版本号（`staff-miniprogram/package.json`）从 1.0.0 起，另算。
- 迁移号：原登记 `610`–`619`，与 8.2.9（后排为 8.2.19）水吧的 `610_pickup_v829.sql` 撞号；员工小程序线的迁移没有发布过，合 main 前改成 `650`、`651`（登记 `650`–`659`）。用过员工小程序开发分支的演示库要重建。

## 0. 升级后会看到的变化

- **没设 `STAFFMP_PORT` 的实例什么都不变**：员工小程序端口不开，后台多一个「WCP 设置 → 人员与行政 → 员工小程序」分区（开关默认开、谁绑了微信、饭卡对上）。
- **设了 `STAFFMP_PORT`**（叠加 `compose.staffmp.yaml`）：多一个只给员工小程序用的端口，外面经正式服那台的 Caddy 走 `https://sys.yuzusystem.xyz/api/staffmp/*`；端口上只有员工小程序自己的接口和白名单里的 WCP、员工培训、学堂员工端接口，管理接口一律 404，网页的 Cookie 不认。
- 柚子饭堂网页（`staff.yuzusystem.xyz`）照旧能用；员工小程序上线后什么时候停由店主定（SP11）。

## 1. 迁移、配置与部署

- **迁移**：`650_staffmp_bindings.sql`（`staffmp_bindings` 微信绑定、`staffmp_sessions` 员工小程序发的会话）、`651_staffmp_canteen_links.sql`（`staffmp_canteen_links` 员工账号与饭卡一对一）。只建新表，不动已有表；回滚 `docs/rollback/650_staffmp_bindings.down.sql`、`651_staffmp_canteen_links.down.sql`（先停服务、先备份）。
- **配置**（`.env.example` 的 `STAFFMP_*` 一段）：`STAFFMP_PORT` 不设就不开端口；`STAFFMP_APPID`、`STAFFMP_APP_SECRET` 要么都设、要么都不设（AppSecret 只放服务器 `.env`，不进 Git、不进聊天）；`STAFFMP_MOCK_WECHAT=true` 只在开发、测试环境认。
- **部署**：叠加 `compose.staffmp.yaml`；正式服那台的 Caddy 在 `sys.yuzusystem.xyz` 上加 `/api/staffmp/*`（正式版）与 `/trial/api/staffmp/*`（体验版，去掉 `/trial` 经 Tailscale 转测试服 A 演示库的员工小程序端口）两段，写在转应用端口那一段前面，与顾客小程序的 `/v1/*`、`/trial/v1/*` 写在一处（`docs/DEPLOY_GATEWAY.md` 第 1.1 节，顾客小程序改域名的 [#63](https://github.com/tiebanyinshi/yuzu-2.0/pull/63) 已合）；`staff.yuzusystem.xyz` 只加一句回微信的校验文件（巡场码扫普通链接打开小程序），其余不动。
- **小程序后台的手续**（类目、接口权限、合法域名 `https://sys.yuzusystem.xyz`、隐私指引、审核账号、扫普通链接规则 `https://staff.yuzusystem.xyz/#patrol=` → `pages/patrol/index`）：`docs/STAFF_MP.md` 第 10 节。上传体验版与正式版由店主在微信开发者工具里做（云端没有开发者工具）。
- **开关**：后台「员工小程序」，默认开（SP12）；关上以后员工端除了 `info` 都回「暂停使用」。员工食堂、安保巡场、学堂照各自的开关与权限。

## 2. 演示数据与固定预期

没有变：员工小程序不加演示数据、不改 `src/server/demo/*-expected.json`。验收用独立演示库，员工小程序端口按第 4 节设。

## 3. 已执行的验证

| 检查 | 结果 |
| --- | --- |
| 六个子 PR 各自的 CI（全量：静态检查、秒级用例、集成测试 4 组、浏览器验收 6+2 组、员工食堂手机端、演示数据、从上一版升级；员工小程序、顾客小程序的类型检查与单元测试） | 全绿（D 的两次红都是 runner 慢造成的超时——备份用例 120 秒、迁移回滚用例 30 秒，本机分别都过，重跑一次通过） |
| Codex 代码与安全审查（每个子 PR 最多 5 轮） | A、B、C、E、D、F 报的问题都修了（E 的修复随 D 带进来）；最后一轮没有问题；各子 PR 的安全审查都没有报问题 |
| 开 PR 前的独立复查（B、C、E、D、F 各一次） | 找到的问题在各自的 PR 里修好 |
| 本机（F 的头 `b5b2810`，已合进 main 8.2.20）：`lint` / `typecheck` / `check:code` / `check:docs` / `check:gov` / `format:check` / `build` / `check:bundle`（首屏主包 875 KB，上限 900 KB）/ `check:migrations`（新加 2 份迁移，高风险写法 0 处） | 全部通过 |
| 本机：`npm run test:unit` | 72 个文件、629 条通过 |
| 本机：`npm test`（全量集成，独立测试库） | 384 个文件、3481 条通过 |
| 本机：新建的独立演示库 `demo-prepare`（`APP_ENV=development`、`YUZU_INSTANCE=demo`） | 一致性自检 87 项全部一致，演示库核对通过 |
| `staff-miniprogram`：`npm run check`（类型检查 + 单元测试） | 149 条通过 |
| 本机：收口提交（版本号、交接说明、变更记录）以后 `lint` / `check:docs` / `check:gov` / `version-source` | 见集成 PR 上最后一个提交的 CI |
| 集成 PR 的 Codex 审查第 1 轮（`e6c9954`，报 1 条 P1、2 条 P2） | 都修了：打卡、申请、审批原样重提被拒时先确认作废原编号（新接口 `POST /api/staffmp/ops/:key/abandon`，`tests/staffmp-ops.test.ts`）；饭卡开通的兜底工号也核对是不是本人的卡；学习页的搜索也搜学堂的课程。`staff-miniprogram` 的 `npm run check` 152 条通过 |
| 第 2 轮（`02d8a3d`，报 2 条 P2） | 都修了：学堂派必修课、学习地图的通知点开进课程、地图页（Tab 页改用 `switchTab` 打开）；打卡页开着跨过「下一张卡」的时间段时，旧按钮不给、自己去门店系统重新取。`npm run check` 154 条通过 |
| 微信开发者工具、真机 | **受阻未测**（云端没有开发者工具与手机；第 5 节） |

## 4. 验收要点

1. **端口与登录**（独立演示库，`.env` 设 `STAFFMP_PORT=<端口>`、`STAFFMP_MOCK_WECHAT=true`）
   - `GET /api/staffmp/info` 不用登录，回门店名、版本 + SHA、实例标识。
   - 账号密码登录拿到令牌；带模拟微信 code 登录并绑定，之后 `POST /api/staffmp/auth/wechat` 一键进；同一个微信绑给另一位时不带 `replace` 只登录这一次、不顶掉。
   - 白名单外的接口一律 404（例如 `/api/staffmp/oa/payroll/batches`、`/api/staffmp/academy/coach`）；直接请求 `/api/oa/...`、`/api/academy/...` 内部路径 404；网页的 Cookie 不认。
   - 首次登录没改密码、老账号没选岗位的：WCP、吃饭巡场、学堂的接口一律 403（`PASSWORD_CHANGE_REQUIRED` / `POSITION_REQUIRED`）。
   - 确认作废（`POST /api/staffmp/ops/<编号>/abandon`，`type` 只认 `oa_punch` / `oa_approval_submit` / `oa_approval_act`）：没办过的编号作废以后，再用这个编号打卡回 409 `OP_ABANDONED`、不记打卡；办过的回 `found: true`；别人的编号 403；别的业务类型 400；网页的 `/api/erp/ops/*` 在这个端口上 404。
   - 后台解开绑定后，那位员工小程序上的令牌马上 401；只有人事权限（`hr.org`）的只看、只解自己门店范围的，不列总裁。
2. **吃饭与巡场**（饭堂开着、配了 `CANTEEN_CODE_SECRET`）：员工第一次点饭卡码，用旧饭堂账号密码对上（错的回「账号或密码不对」）；没登记过的「开通饭卡」，重试、同时点两次都只有一张；后台「饭卡对上」按手机号一键对上、解开（解开后那张饭卡的 `code_epoch` 加一）。小程序生成的饭卡码被负责人扫码登记接受，同一餐第二次回「已经打过」。巡场部门的人扫场所码记一次。
3. **学堂**（学堂里有上架的课）：`GET /api/staffmp/academy/lessons/:id` 的图文课件带 `blocks`；学完了只给一次学分；测验开卷同一个编号回同一份，交卷重提回第一次的结果；每日一练同一个编号回同一次。
4. **小程序**（要微信开发者工具，第 5 节受阻项）：登录、四个 Tab、打卡（迟到、早退要确认、外勤照片、结果待确认重提）、发起请假与补卡、审批、工资条签收、通讯录拨号、公告、通知、饭卡码亮屏、负责人连续扫码、巡场、学习 Tab 的学堂（课件阅读、课中小测、测验、每日一练）、首页此刻卡与待办。

## 5. 已知的限度

- **没在微信开发者工具和真机上跑过**（云端没有）：页面结构、绑的事件、图片、写法约定都有单元测试核对，但相机、亮度、二维码画布、定位、文档预览、扫普通链接要在开发者工具与真机上走一遍。
- 「扫普通链接二维码」对带 `#` 的巡场码地址能不能匹配，要真机试；不行就给巡场点换一批路径形式的新码（`docs/STAFF_MP.md` 第 10 节第 5 条）。
- 学堂这一版没有：课程评分、带教签核、问柚子、榜单页、证书页（学堂网页上都有）；首页待办里的「必修快到期」、「我的」里的学分与等级下一版加。
- 待办这一版没有「我的申请被驳回」。

## 6. 可复制给测试 AI 的指令

```
验收 tiebanyinshi/yuzu-2.0 的 v8.2.26 员工小程序线（集成 PR #53 的最新提交，报告第一行写「【员工小程序线·测试】→ 员工小程序线 · PR #53 · <完整 SHA>」；合进 main 以后在 main 的 v8.2.26 上验收）。
只用新建的独立演示库（APP_ENV=development，不是 trial / production / 测试服）：
  npm ci && npm run typecheck && npm run build
  node dist/server/cli.js demo-prepare        # 最后自带 check 与 demo-check，要全部 ✓
  TEST_DATABASE_URL=<独立测试库> npx vitest run tests/staffmp-*.test.ts
  TEST_DATABASE_URL=<独立测试库> npm test
  (cd staff-miniprogram && npm ci && npm run check)
员工小程序端口：.env 设 STAFFMP_PORT=<端口>、STAFFMP_MOCK_WECHAT=true，按 docs/HANDOFF_STAFFMP1.md 第 4 节逐条核对；
有微信开发者工具的：导入 staff-miniprogram/，project.config.json 的 appid 换成测试号，config/env.ts 的 DEV_BASE 指向演示库的员工小程序端口，勾「不校验合法域名」。
问题发在 PR #53 上（合进 main 以后发在员工小程序线当时开着的 PR 上），标 P1 / P2，附复现步骤；账错、串单、越权、数据丢失是阻断项。
```
