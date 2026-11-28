# v8.2.31 交接说明 · 员工小程序「汤崎 WCP」第二版

员工小程序线 PR [tiebanyinshi/yuzu-2.0#75](https://github.com/tiebanyinshi/yuzu-2.0/pull/75)。第一版 8.2.26（[#53](https://github.com/tiebanyinshi/yuzu-2.0/pull/53)，交接说明 `docs/HANDOFF_STAFFMP1.md`）合进 main、打了 `v8.2.26` 标签以后，店主 2026-11-28：「你直接全部开发完就行」「用一次提交」——第二版排期（`docs/STAFF_MP.md` 第 11.1 节）里能做的都在一个提交里做完，不再拆子 PR。

- 设计：`docs/STAFF_MP.md` 第 2.2 节（首页待办）、第 2.3 节（学习 Tab「第二版加的」）、第 2.5 节（我的）、第 8.2 节（白名单）、第 11.1 节（排期与进度）。
- 默认做法：`docs/PENDING_DECISIONS.md` SP18（更新）、SP19（首页待办的两样）、SP20（带教签核与问柚子放进小程序，店主已定）。
- 版本号：8.2.30 是收银合并（店主已定），8.2.27–8.2.29 没查到排给谁，避开不用，这一版用 8.2.31；合并时 main 已经到更高的照 main 当时的安排改。员工小程序自己的版本号 1.1.0。
- **没有数据库迁移**，没有新的环境变量，部署照第一版（`compose.staffmp.yaml`、Caddy 两段不变）。

## 0. 升级后会看到的变化

- **没设 `STAFFMP_PORT` 的实例什么都不变**。
- 员工小程序端口的白名单多 7 个学堂员工端接口（第 1 节），都是学堂原来的处理函数，权限、部门范围、每日次数、学分照学堂当场核对；管理端照旧 404。
- 「我是谁」的入口清单里，有带教权限（`academy.coach` 或学堂管理）的多一个 `academyCoach`。
- 小程序：学习 Tab 的学堂一块多「我的证书与掌握度」「学习榜」「带教签核」（有权限的才有）；课程页多「问柚子」与「评分」；首页待办多「必修快到期」「我的申请被驳回」；「我的」多一张学习卡；工作台的「学习」一组多「带教签核」（有权限的才有）。

## 1. 改了什么

| 块 | 内容 |
| --- | --- |
| 白名单（`src/server/modules/staffmp/allowlist.ts`） | `GET academy/me`、`GET academy/rank`、`POST academy/courses/:id/feedback`、`GET/POST academy/courses/:id/tutor`、`GET academy/coach`、`POST academy/signoffs`；地图列表照旧不挂 |
| 我是谁（`auth.ts`、`src/shared/staffmp.ts`） | 入口 `academyCoach` |
| 我的学习（`pages/academy-me`） | 等级与学分、证书（过期、撤销写清楚）、掌握度、每日一练连续天数；去学习榜、带教签核 |
| 学习榜（`pages/academy-rank`） | 学分 / 时长，本月 / 全部，全公司 / 本店；自己那一行标出来 |
| 课程页（`pages/academy-course`） | 「问柚子」入口；学完了才能评分（再评是改成新的） |
| 问柚子（`pages/academy-tutor`） | 提问带操作编号、先存手机再发（`academy_tutor`）；没收到回复隔 5 秒原样重提，在想的隔 5 秒刷新，最多等 3 分钟 |
| 带教签核（`pages/academy-coach`、`pages/academy-signoff`） | 待签列表；一项一项点「达标 / 没达标」、签「通过」或「再练」、评语；带操作编号与检查项版本，先存手机再发（`academy_signoff`，按「员工-课时」分开存），没确定的只能原样再提交 |
| 首页待办（`utils/today.ts`、`utils/seen.ts`、`pages/today`） | 必修快到期（3 天内或已逾期，逾期的标急）、我的申请被驳回（14 天以内、这台手机上没打开看过的；打开那张单记在手机上） |
| 我的（`pages/me`） | 学习卡：等级、学分、离下一级、证书几张有效（手机上留一份） |

## 2. 演示数据与固定预期

没有变：不加演示数据、不改 `src/server/demo/*-expected.json`。

## 3. 已执行的验证

| 检查 | 结果 |
| --- | --- |
| 本机：`lint` / `typecheck` / `check:code` / `check:docs` / `check:gov` / `format:check` | 见 #75 上最后一个提交的 CI（本机提交前都跑过） |
| 本机：`TEST_DATABASE_URL=<独立测试库> npx vitest run tests/staffmp-*.test.ts` | 全部通过（新加：我的、榜单、评分、问柚子、带教签核走一遍；白名单外的照旧 404） |
| `staff-miniprogram`：`npm run check` | 全部通过（新加：证书、掌握度、榜单、问柚子、带教、必修快到期、被驳回的待办） |
| 微信开发者工具、真机 | **受阻未测**（云端没有开发者工具与手机） |

## 4. 验收要点

1. **白名单**（独立演示库，员工小程序端口照第一版的第 4 节设）：上面 7 个接口带员工小程序的令牌能用；`/api/staffmp/academy/paths`、管理端、内部地址照旧 404。
2. **带教签核**：岗位是部门负责人（例如 `front.lead`）的员工，「我是谁」的入口里有 `academyCoach`；本部门有人打开过某个实操课时以后，`GET /api/staffmp/academy/coach` 列出它；签「通过」完成那一课时（学分照学堂），同一个操作编号再交回第一次的结果、不签两次；普通员工 `GET coach` 403。
3. **评分**：学完了的课能评，再评是改成新的；没学完的 403。
4. **问柚子**：没配模型服务的门店 `GET tutor` 回 `mode: off`，提问回 409（`AI_` 开头）；配了的（`mock` 也行）提问回答案与出处，同一个编号再交回同一个问题。
5. **小程序**（要微信开发者工具）：我的学习、学习榜、课程评分、问柚子（等回复、重提）、带教签核（没收到回复以后原样再提交）、首页的两样待办、「我的」的学习卡。

## 5. 已知的限度

- 真机试过以后的修正（相机、亮屏、二维码、定位、文档预览、扫普通链接）要等店主上传体验版、真机走一遍（`docs/STAFF_MP.md` 第 11.1 节第 1 样）。
- 「我的申请被驳回」的「看过了」只记在这台手机上（审批中心没有发起人已读），换了手机会再提一次（SP19）。

## 5.1 可复制给测试 AI 的指令

```
验收 tiebanyinshi/yuzu-2.0 的 v8.2.31 员工小程序线第二版（PR #75 的最新提交，报告第一行写「【员工小程序线·测试】→ 员工小程序线 · PR #75 · <完整 SHA>」；合进 main 以后在 main 的 v8.2.31 上验收）。
只用新建的独立演示库（APP_ENV=development，不是 trial / production / 测试服）：
  npm ci && npm run typecheck && npm run build
  node dist/server/cli.js demo-prepare        # 最后自带 check 与 demo-check，要全部 ✓
  TEST_DATABASE_URL=<独立测试库> npx vitest run tests/staffmp-*.test.ts
  (cd staff-miniprogram && npm ci && npm run check)
员工小程序端口：.env 设 STAFFMP_PORT=<端口>、STAFFMP_MOCK_WECHAT=true，按 docs/HANDOFF_STAFFMP2.md 第 4 节逐条核对。
问题发在 PR #75 上，标 P1 / P2，附复现步骤；账错、串单、越权、数据丢失是阻断项。
```
