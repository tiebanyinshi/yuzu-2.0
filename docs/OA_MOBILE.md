# 员工办公 v1.1（PC + 手机 H5）

> 需求：店主 2026-11-25《员工办公系统建设需求文档 v1.1》（PC 端 + 移动端 · 供开发 AI 执行）。目标：员工在钉钉里的日常（打卡、审批、公告、知识文档）改在柚子的 WCP 里做，手机端从零新建。
> 对齐方案（本文第 1–5 节）店主 2026-11-25 确认；需要店主定的 6 件事全部同意（第 6 节，`docs/PENDING_DECISIONS.md` EO1–EO6）。
> 分 6 批，每批一个 PR、不改版本号，每批做完停下来等店主确认再做下一批；6 批做完统一发一个版本、一次交 PC 与手机全部页面的预览图。

## 一、现状核实表（分端标注）

图例：✅ 已有可用 · 🔧 已有需优化 · ❌ 无

| #   | 功能                                           | PC 端  | 手机端 | 代码位置 / 说明                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 账号登录（复用现有账号）                       | ✅     | ✅     | `src/server/auth/routes.ts`；登录页手机宽度已适配（`features/auth/LoginPage.tsx`）                                                                                                                                                                                                                                     |
| 2   | 微信内扫码访问                                 | —      | ❌     | 没有针对微信内置浏览器的处理；没有扫码入口。打卡要 GPS/摄像头，**必须走 HTTPS 的外网域名**（`docs/RELEASE_V800.md`：Caddy + HTTPS）；门店内网是 HTTP，微信里定位会被拒                                                                                                                                                 |
| 3   | 手机端框架（底部 4 Tab）                       | —      | ❌     | `features/oa/WcpShell.tsx`：宽屏左侧菜单；窄屏变成顶部横滑的一排按钮，没有底部 Tab、没有消息红点、没有「我的」                                                                                                                                                                                                         |
| 4   | 打卡（GPS 围栏、外勤拍照+事由）                | 不要求 | ✅     | `modules/oa/punches.ts`、`features/oa/PunchPage.tsx`；外勤只在围栏外允许，要事由+照片                                                                                                                                                                                                                                  |
| 5   | **打卡窗口判定（5.1）**                        | ✅     | ✅     | `shared/oa.ts` `matchPunch`：按班次窗口判，不按自然日；窗口时长按班次配置（默认上班前 120 / 迟到弹性 / 下班前 60 / 下班后 120）；00:00–08:00 班上班窗口从前一日 22:00 开；业务日期 = 班次开始日；排班唯一键 = 员工+日期+班次，可连班；打卡带操作编号幂等。**核对后与 5.1 一致，不重做**，第 2 批补一组三班倒的回归用例 |
| 6   | 班次 / 考勤组 / 打卡点                         | ✅     | 🔧     | `AttendanceSetupSection.tsx`；手机上能打开但没适配                                                                                                                                                                                                                                                                     |
| 7   | 排班（周表、批量排班）                         | ✅     | 🔧     | `ScheduleTab.tsx`、`ScheduleBatchDialog.tsx`；手机上表格太宽，管理岗没法排                                                                                                                                                                                                                                             |
| 8   | 排班「发布」才通知员工                         | ❌     | ❌     | 现在保存即生效、马上发「排班变更」通知（`modules/oa/schedules.ts`）。5.2 要求只有「发布」才推送                                                                                                                                                                                                                        |
| 9   | **排班授权（5.2）**                            | ❌     | ❌     | 现在只有两个权限：`hr.attendance`（全管）、`hr.attendanceDept`（按岗位所在部门只看）。部门树有（`org_departments.parent_key / head_staff_id`）。**没有**「部门经理授权主管/部长、指定范围与有效期、不可转授、调岗失效、审计」                                                                                          |
| 10  | 每日结算定时任务                               | ✅     | —      | `src/server/jobs.ts` 每 10 分钟结算近 3 天；异常首次出现发通知                                                                                                                                                                                                                                                         |
| 11  | 考勤月报 / 异常处理                            | ✅     | 🔧     | `AttendanceResultsTab.tsx`、`AttendanceMonthlyTab.tsx`（管理端，手机未适配）；员工「我的考勤」手机可用                                                                                                                                                                                                                 |
| 12  | 补卡 / 请假审批                                | ✅     | ✅     | `ApprovalPages.tsx`、模板见迁移 219/220                                                                                                                                                                                                                                                                                |
| 13  | **审批-考勤联动（5.3）**                       | ✅     | —      | 审批终审通过时同一事务写覆盖记录 / 补卡写打卡明细并重新结算（`approval-templates.ts`）；每日结算读这些覆盖。效果与 5.3 一致，不重做                                                                                                                                                                                    |
| 14  | 加班 / 出差 / 报销 / 通用模板                  | ✅     | ✅     | 迁移 219/220                                                                                                                                                                                                                                                                                                           |
| 15  | 用章模板                                       | 🔧     | 🔧     | 没有单独的用章模板，现在让用「通用」。第 4 批加一个                                                                                                                                                                                                                                                                    |
| 16  | 待办 / 我发起 / 抄送 / 转交 / 催办             | ✅     | ✅     | `shared/oa-approval.ts`；催办每小时一次                                                                                                                                                                                                                                                                                |
| 17  | 审批人配置后台                                 | ✅     | 不要求 | `ApprovalAdminSection.tsx`（1–3 级、条件、抄送）                                                                                                                                                                                                                                                                       |
| 18  | 站内通知（审批待办 / 排班变更 / 异常）         | ✅     | 🔧     | `modules/oa/notifications.ts`；铃铛只在门户页，WCP 里没有                                                                                                                                                                                                                                                              |
| 19  | 聊天（单聊 / 群）                              | ✅     | ✅     | `ImPages.tsx`                                                                                                                                                                                                                                                                                                          |
| 20  | 推送提醒（手机收到提醒）                       | ❌     | ❌     | OA 没有任何推送通道（微信模板消息 / 浏览器推送都没有）；预留了 `registerNotifyChannel` 挂钩                                                                                                                                                                                                                            |
| 21  | **公告**（发布 / 查看）                        | ❌     | ❌     | 没有公告。只有聊天群公告                                                                                                                                                                                                                                                                                               |
| 22  | **知识库**（空间 / 文档 / 检索 / 预览）        | 🔧     | 🔧     | 没有单独的知识库。**最接近的是 8.1.36 刚做的「员工培训」**：文件夹（培训资料 + 每个部门一个）= 空间，文件+版本 = 文档，PDF/图片/视频/Excel 页面里看 = 预览，按部门看得到 = 权限；**缺检索**；手机能看但不是专门的视图                                                                                                  |
| 23  | 员工 / 部门 / 账号管理、批量导入               | ✅     | 不要求 | `OrgSection.tsx`、`StaffImportDialog.tsx`（.xlsx/.csv，一次 200 人）                                                                                                                                                                                                                                                   |
| 24  | 人脸录入 + 审核                                | ✅     | ✅     | `FacePage.tsx`、`FaceReviewTab.tsx`                                                                                                                                                                                                                                                                                    |
| 25  | 人脸识别打卡                                   | 🔧     | 🔧     | 接口已预留（`integrations/face.ts`），只有模拟实现；正式服没接供应商，打卡记「待核对」                                                                                                                                                                                                                                 |
| 26  | 假期余额 / 工资条                              | ✅     | ✅     | `MyLeavePage.tsx`、`MyPayslipPages.tsx`                                                                                                                                                                                                                                                                                |
| 27  | 「我的」页（头像、假期、排班月历、人脸、设置） | ❌     | ❌     | 各项都有单独页面，但没有汇总页；改密码 / 退出只在门户页                                                                                                                                                                                                                                                                |

## 二、技术栈与目录（观察结论）

- 前端：React 19 + react-router（`src/client/App.tsx`）+ TanStack Query + Tailwind 4；公共部件在 `src/client/components/`（`ui.tsx`、`DataTable.tsx`、`Overlay.tsx`）。WCP 是一个路由 `/oa/*`，由 `WcpShell` 包着、`OfficePages.tsx` 按路径分发；管理端在「WCP 设置」（`/admin/*`，`src/shared/admin.ts` 登记）。
- 后端：Fastify + postgres.js；OA 在 `src/server/modules/oa/*`；权限 `src/shared/permissions.ts` + `guard()`；写操作带操作编号（`idempotency_keys`）、「确认作废」（`op_fences`）；没有 WebSocket，用轮询。
- 双端共用：**同一套接口、同一份数据**，手机端只是同一个前端在窄屏下换成底部 Tab 布局——符合文档「禁止两端各一套」。
- 「后端按未来能给小程序复用」：现有接口都是 JSON + Cookie 会话，小程序要另加 token 登录（小程序线已有网关 `src/gateway/`，本期不动）。

## 三、本期新建与复用的表

**复用（不改结构）**：`staff`、`staff_profiles`、`org_departments`、`oa_shifts`、`oa_attendance_groups`、`oa_group_members`、`oa_locations`、`oa_punches`、`oa_attendance_daily`、`oa_attendance_covers`、`oa_approval_*`、`oa_notifications`、`oa_im_*`、`oa_face_enrollments`、`oa_leave_*`、`oa_payslips`、`training_*`。

**新建 / 加列**（迁移号先在 ROADMAP 第 7 节登记，预计 `291`–`299`）：

| 批次 | 迁移                                                | 内容                                                                                                                                                                                                                                    |
| ---- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2    | `oa_schedule_publishes` + `oa_schedules` 加发布状态 | 排班先存草稿，「发布」一次推送通知；记谁、何时、发布了哪段日期                                                                                                                                                                          |
| 2    | `oa_schedule_grants`                                | 排班授权：授权人、被授权人、权限点（查看/编排/发布/授权）、范围（考勤组 / 本部门 / 本部门及下级 / 指定人员 / 全公司）、起止日期（默认一年）、被授权人当时的岗位（调岗即失效）、撤销；审计走 `audit_log`。**不可转授**：被授权的不能再授 |
| 4    | `oa_approval_templates` 加一行                      | 用章申请模板                                                                                                                                                                                                                            |
| 5    | `oa_announcements`、`oa_announcement_reads`         | 公告（标题、正文、附件、范围：全员/部门、置顶、发布人、发布时间、撤回）与已读                                                                                                                                                           |
| 5    | `training_*` 加检索                                 | 文件标题、说明、文件名检索（先用 `ILIKE` + 索引，量大了再上全文检索）                                                                                                                                                                   |
| 6    | 无（人脸接入是配置 + 适配器）                       | —                                                                                                                                                                                                                                       |

## 四、接口规划

**双端共用（现有，照用）**：`/api/oa/punches*`、`/api/oa/attendance/*`、`/api/oa/approvals*`、`/api/oa/notifications*`、`/api/oa/im/*`、`/api/oa/leave*`、`/api/oa/payslips*`、`/api/oa/faces*`、`/api/training/*`。

**双端共用（新加）**：

| 批次 | 接口                                                        | 做什么                                                                   |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1    | ~~`GET /api/oa/me`~~                                        | ~~「我的」页汇总~~：第 1 批改为复用现有三个接口，不加（第 7 节）         |
| 2    | `POST /api/oa/attendance/schedule/publish`                  | 发布一段日期的排班，推送通知                                             |
| 2    | `GET/POST/DELETE /api/oa/attendance/schedule-grants`        | 查看、授权、撤销排班授权（服务端统一的授权校验函数，所有排班写入先过它） |
| 2    | `GET /api/oa/attendance/today`                              | 打卡卡片：今天的班次、下一张该打的卡（上班 / 下班 / 外勤）               |
| 5    | `GET /api/oa/announcements`、`GET …/:id`、`POST …/:id/read` | 公告列表、详情、标已读                                                   |
| 5    | `POST/PUT /api/admin/oa/announcements…`                     | PC 发布、修改、撤回、置顶（权限新加 `oa.announce`）                      |
| 5    | `GET /api/training/search?q=`                               | 知识库检索                                                               |

**端专属**：服务端没有；区别只在前端（手机底部 Tab 布局、扫码入口页）。

## 五、分批任务（每批 PC + 手机，作为最后统一出预览图的范围）

| 批次                       | PC 端页面                                                                           | 手机端页面                                                                                                                                                                                       | 工作量                                     |
| -------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| **1 框架与登录**           | WCP 顶栏加通知铃铛与个人菜单（改密码、退出）；本核实表                              | 手机布局：底部 4 Tab（工作台 / 消息 / 知识库 / 我的）、顶部公司名+搜索；工作台（打卡卡片占位 + 宫格入口）；「我的」页；登录页适配微信内置浏览器；扫码入口（后台生成二维码，指向外网 HTTPS 域名） | 中                                         |
| **2 考勤打卡主线**         | 排班加「发布」；排班授权管理页（部门经理给主管/部长授权，范围、有效期、撤销、审计） | 排班查看（月历）+ 管理岗手机排班（按人按天编辑、发布）；打卡卡片接今天班次与「该打什么卡」；三班倒窗口回归用例                                                                                   | **重**（可拆成 2a 发布+手机排班、2b 授权） |
| **3 月报与异常、补卡请假** | 现有，按需小改                                                                      | 我的考勤月报、异常列表、从异常一键补卡；请假 / 补卡发起与审批的手机适配                                                                                                                          | 轻                                         |
| **4 审批扩展与消息**       | 用章模板；审批人配置现有                                                            | 审批发起 / 待办 / 抄送 / 详情 / 转交 / 催办手机适配；「消息」Tab：系统通知与聊天分栏、未读红点                                                                                                   | 中                                         |
| **5 知识库与公告**         | 员工培训加检索（店主确认作为 WCP 知识库）；公告发布页                               | 知识库 H5：空间 → 文档 → 预览，搜索置顶；公告列表 / 详情；公告发布后发站内通知                                                                                                                   | 中                                         |
| **6 收尾**                 | 人脸识别接入（选定供应商后）；批量导入现有                                          | 人脸录入现有；整体回归；**PC 与手机全部新增 / 改动页面的预览图一次交**                                                                                                                           | 中（取决于供应商）                         |

每批：代码跑通 + 自测（相关集成测试 + 手机 360×800 与门店电脑的浏览器用例）+ 简短说明 → 等店主确认 → 下一批。不提前做后面批次的功能。

## 六、店主定的 6 件事（2026-11-25 全部同意）

1. **「WCP 知识模块」就是 8.1.36 的「员工培训」**：用员工培训的文件夹 / 文件 / 版本 / 权限，第 5 批加检索和手机视图，手机 Tab 叫「知识库」，不另建一套。
2. **推送**：本期站内通知 + 红点；微信公众号模板消息等店主提供已认证的服务号后单独做。
3. **人脸识别供应商**：第 6 批前店主选定（腾讯云 / 阿里云 / 百度等）并开通账号，按次收费。
4. **手机端地址**：外网正式服 https 域名下的 `/oa`，微信扫码打开；门店内网 http 地址在微信里拿不到定位，不能打卡。外网正式服对员工开放前，`docs/RELEASE_V800.md` 第 2.3 节的加固先做（Codex 部署）。
5. **排班改成「发布才生效、才通知」**（第 2 批，按需求文档 5.2）。
6. **版本号**：每批一个 PR、不改版本号；6 批做完统一发一个版本，版本号店主定。

## 七、各批进度

### 第 1 批：双端框架与登录（2026-11-25）

- **手机（768 像素以下）**：WCP 外壳换成顶部公司名（门店名）+ 实例标识与版本 + 通知铃铛，Tab 首页下面一行搜索框；底部 4 个 Tab：工作台（`/oa`）、消息（`/oa/im`，通知页也算）、知识库（`/oa/training`；2026-11-27 起改叫「学堂」、指向 `/oa/academy`，员工培训的页面也亮这个 Tab，见 `ACADEMY.md` 第 8 节）、我的（`/oa/me`，假期、人脸也算）；不是 Tab 首页的页面顶栏左边出「返回」，回所在 Tab 的首页。`src/client/features/oa/WcpShell.tsx`、`wcpNav.ts`（`WCP_TABS`）。
- **工作台**：顶上「今天」打卡卡片（今天的班次、上下班卡打了没有，取现有的 `GET /api/oa/attendance/today`；「该打什么卡」第 2 批接上）；下面功能宫格，手机一行四个小图标，电脑照旧是带说明的方块；多一个「补卡」直接进补卡审批；顶栏搜索框按名字筛宫格（`/oa?q=`，知识库检索第 5 批接上）。
- **我的**（`src/client/features/oa/MePage.tsx`）：头像（名字第一个字）、部门与岗位、账号；假期余额；本月排班月历（与「我的排班」同一个月历，`MyScheduleCalendar.tsx`）；人脸录入状态；设置（修改密码、外观、返回门户、退出登录）。**不加新接口**：用现有的 `/api/oa/me/leave`、`/api/oa/me/schedule`、`/api/oa/face/me`（对齐方案原写了一个汇总接口 `GET /api/oa/me`，复用现有三个更省，第 4 节相应划掉）。
- **电脑（1024 以上）**：WCP 顶栏加通知铃铛与头像菜单（改密码、退出）；左边一列加「我的」。平板（768–1024）照旧是顶栏 + 横排入口。
- **登录**：从 `/oa` 被送到登录页的（扫码打开）写「员工登录」、品牌区压矮；手机上不自动弹键盘；不是 https 时提示「拿不到定位、开不了摄像头」；没登录就打开的不再写「登录已过期」（原来任何 401 都写，`src/client/App.tsx`）。登录后回到 `/oa`（原有的「回到原页面」）。
- **扫码入口**：「WCP 设置 → 组织架构 → 手机端入口」生成指向 `<https 域名>/oa` 的二维码（默认取当前页面的 https 地址，否则 `https://sys.yuzusystem.xyz`），只认 https；在浏览器里画，不存服务器。`MobileEntryDialog.tsx`；二维码部件与 Design 工作台共用（`src/client/components/QrCode.tsx`）。
- **没有迁移、没有新接口**。浏览器用例 `e2e/oa-mobile.spec.ts`（360 × 800 微信内置浏览器 + 门店电脑）。

### 第 2 批：考勤打卡主线（2026-11-25）

- **迁移**（预留 `291`–`299`，`290` 已由 8.1.37 使用）：`291_oa_schedule_publish.sql`（发布批次表 `oa_schedule_publishes`、`oa_schedules` 加发布状态与草稿列 `status` / `pending_delete` / `draft_consecutive` / `published_at` / `published_by` / `publish_id`，操作类型追加 `oa_schedule_publish`）；`292_oa_schedule_grants.sql`（排班授权表 `oa_schedule_grants`，操作类型追加 `oa_schedule_grant`）。回滚脚本见 `docs/rollback/291_*.down.sql`、`292_*.down.sql`。
- **排班「发布」（EO5）**：单格与批量排班均先存草稿，不发通知、不影响员工打卡 / 每日结算 / 补卡请假 / 「我的排班」（发布前保留原已发布班次）；`POST /api/oa/attendance/schedule/publish`（带操作编号幂等与确认作废）按日期段发布，仅向排班有变动的员工推送「排班已发布」站内通知，并留发布历史与审计（`oa_schedule_published`）。PC 端「考勤设置 → 排班」展示待发布标记、发布按钮与确认对话框、最近发布记录。
- **排班授权（需求 5.2）**：统一服务端鉴权 `resolveScheduleAccess`（`src/server/modules/oa/schedule-grants.ts`），所有排班读、写、批量、发布先过它；考勤管理员与经核实的部门经理（本部门及下级部门树）内置排班与授权权；`GET /api/oa/attendance/schedule-access`、`GET/POST /api/oa/attendance/schedule-grants`、`POST /api/oa/attendance/schedule-grants/:id/revoke`（新建与撤销均带操作编号幂等与确认作废围栏）支持查看 / 编排 / 发布三项权限点（**不含授权权、不可转授**）、五类范围（考勤组 / 部门 / 部门及下级 / 指定员工 / 全公司，部门经理授出带 `scope_cap_depts` 上限防越权）、有效期（默认一年）、被授权人岗位快照（**调岗 / 离职即自动失效**）、随时撤销与全程审计（`oa_schedule_grant_created` / `oa_schedule_grant_revoked`）。PC 端「考勤设置 → 排班授权」与 WCP `/oa/schedule/grants`（排班管理页直达，覆盖 `org_departments.head_staff_id` 指定且无后台权限的部门经理）均提供授权管理页。
- **手机排班查看与排班管理**：`/oa/schedule`「我的排班」月历支持点选某天在下方看完整班次、时间与跨天/次日 00:00 夜班提示，有排班权限的员工顶部直达 `/oa/schedule/manage`（工作台宫格同步出现「排班管理」）；手机排班管理页（`MobileScheduleManagePage.tsx`）与 PC 共用同一套排班和发布接口，提供「按人 / 按天」单列卡片视图、保存草稿与发布排班，360 × 800 零横向滚动。
- **打卡卡片接上「该打什么卡」**：`GET /api/oa/attendance/today` 返回 `nextPunch`（`src/shared/oa.ts` `nextPunchHint`，与 `matchPunch` 同口径，支持跨天班、次日 00:00 夜班前一日 22:00 开窗、连班交接先下班后上班、早退重打更新与围栏外外勤提示），接入工作台顶部 `TodayCard` 与 `PunchPage`。
- **回归用例**：新增 `tests/oa-schedule-grants.test.ts`（草稿/发布隔离、发布推送与幂等、五类范围授权、不可转授、调岗失效、跨部门防提权、撤销审计）、`tests/oa-three-shifts.test.ts`（24 小时三班倒早/晚/夜班窗口、跨午夜下班卡、连班交接、`nextPunch` 与日结归属回归），并扩展 `e2e/oa-schedule.spec.ts` 与 `e2e/oa-mobile.spec.ts`。

### 第 3 批：月报与异常、补卡请假（2026-11-25）

- **我的考勤月报与异常筛选（`MyAttendancePage.tsx`）**：手机 360 × 800 紧凑标题栏、8 项月度汇总卡片、`全部 / 异常` 分栏切换（支持 `?filter=abnormal`）、顶部快捷进「去请假」「去补卡」。
- **从异常一键补卡（`MyAttendancePage.tsx`、`ApprovalForm.tsx`、`attendance-daily.ts`）**：`GET /api/oa/me/attendance` 新增门店所在地 `today` 与本月审批中补卡单 `pendingMakeups`；缺上班卡 / 缺下班卡 / 旷工行在 30 天（`MAKEUP_BACK_DAYS`）内直接提供「补上班卡 / 补下班卡」一键入口，跳转 `/oa/approvals/new/makeup?date=...&shiftId=...&kind=in|out` 自动带入日期、班次与补哪张卡（不串入其他日子的旧草稿事由；已有审批中补卡单的直达审批详情，超 30 天提示已超期）；请假 / 出差覆盖行直达关联审批单。
- **请假与补卡发起、审批手机适配（`ApprovalForm.tsx`、`ApprovalPages.tsx`、`MyLeavePage.tsx`、`WcpShell.tsx`）**：发起审批页、模板表单（含半天选择器 `halfday` 与班次选择器）、审批列表页（4 个箱体 `Segmented` 横向防溢出）、审批详情页（3 列通过 / 驳回 / 转交按钮、评论栏、长内容换行）与假期余额页全面适配 360 × 800 零横向滚动，并补齐手机顶栏返回按钮的 `.tap relative`。
- **没有迁移**；在 `tests/oa-attendance-link.test.ts` 与 `e2e/oa-mobile.spec.ts` 补齐 `pendingMakeups` 集成回归及 360 × 800 异常一键补卡、请假发起与审批浏览器用例。

### 第 4 批：审批扩展与消息（2026-11-25）

- **迁移**：`293_oa_seal_template.sql` 新增办公审批模板「用章」（`seal`：印章类型、用章文件名称、份数、用章日期、事由、附件，默认一级本部门主管，回滚脚本 `docs/rollback/293_oa_seal_template.down.sql`）；`approval-templates.ts` 挂接 `seal` 标题生成（`用章 · <印章类型> · <文件名称>`）；`wcpNav.ts` 补充审批提示。
- **「消息」Tab 分栏与未读红点去重**：`GET /api/oa/notifications/unread-count?breakdown=1` 返回 `{ unread, systemUnread }`（`systemUnread` 排除 `im_message`，保持不带参数的旧响应完全兼容）；新增 `MessagesBar.tsx` 统一维护 WCP 外壳的聊天同步与通知未读缓存，手机底部「消息」Tab（`wcp-tab-messages-badge`）展示「聊天未读 + 系统通知未读」合计数、不重复计 IM 提醒；`/oa/im` 与 `/oa/notifications` 顶部均提供「聊天 / 系统通知」分栏条与各自未读角标，并适配 360 × 800 零横向滚动（聊天页进会话上报已读后立即同步红点）。
- **回归用例**：在 `tests/oa-approval-templates.test.ts` 补用章模板校验与提交、在 `tests/oa-notify-attach.test.ts` 补 `?breakdown=1` 系统未读拆分、在 `e2e/oa-mobile.spec.ts` 补第 4 批手机 360 × 800 用章发起 / 催办 / 转交审批及消息分栏与合并红点浏览器用例。

### 第 5 批：知识库与公告（2026-11-25）

- **迁移**：`294_oa_announcements_and_kb_search.sql` 新建公司公告主表 `oa_announcements`、已读记录表 `oa_announcement_reads`，向 `position_suggestions` 追加人力行政部负责人默认权限 `oa.announce`，并在现有检查约束上动态追加操作类型 `oa_announcement` 与通知类型 `announcement`（回滚脚本 `docs/rollback/294_oa_announcements_and_kb_search.down.sql`）。
- **知识库检索（EO1，复用员工培训）**：新增 `GET /api/training/search?q=`，按标题、说明、当前版本文件名跨文件夹检索本人可见文档（在职员工隔离、部门文件夹权限过滤、下架 / 停用隐藏、`LIKE` 通配符转义，管理权限可搜全库并含看过人数）。员工端 `TrainingPages.tsx`（`/oa/training`）顶部加置顶检索栏并同步 `?q=`，手机顶栏搜索框在「知识库」Tab 自动切换为知识库检索；PC 后台 `TrainingSection.tsx` 补齐跨文件夹全库检索。
- **公司公告（员工端 + PC 管理端）**：
  - 后端 `src/server/modules/oa/announcements.ts`：员工端 `GET /api/oa/announcements`、`GET /api/oa/announcements/:id`、`POST /api/oa/announcements/:id/read`（标已读并同步消除对应站内通知未读，`FOR SHARE` 与撤回串行）；管理端 `GET/POST /api/admin/oa/announcements`、`GET …/:id/readers`、`PUT …/:id`（乐观锁 `version`）、`POST …/:id/recall`（发布与撤回均带操作编号幂等 + 确认作废围栏 + 审计）；附件访问登记 `strict: true`、站内通知登记可见性过滤（撤回 / 离职 / 调离目标部门 / 跨门店自动隐藏并移出未读计数）。
  - 前端：员工端 `AnnouncementsPage.tsx`（`/oa/announcements` 全部 / 未读筛选、置顶标识、详情自动记已读并刷新红点，360 × 800 零横向滚动），工作台与侧栏新增「公告」入口及未读角标；PC 后台 `AnnouncementsSection.tsx`（`/admin/announcements` 发布、附件、置顶、编辑、已读名单、撤回与结果待确认恢复）。
- **回归用例**：新增 `tests/oa-announcements.test.ts`（发布、范围隔离、附件严格鉴权、幂等与作废围栏、编辑乐观锁、撤回隐藏公告与通知、已读与名单），扩展 `tests/training.test.ts`（知识库检索权限 / 下架 / 通配符转义 / 非员工拒绝）与 `e2e/oa-mobile.spec.ts`（PC 端发公告与知识库检索 + 手机 360 × 800 知识库检索预览与公告阅读 / 撤回）。

### 第 6 批：人脸接入就绪与双端全量收尾回归（2026-11-25）

- **人脸比对服务接入状态就绪（EO3）**：在 `src/shared/oa.ts` 新增 `FaceServiceStatus`，在 `src/server/integrations/face.ts` 新增 `faceServiceStatus()`，并在 `src/server/modules/oa/faces.ts` 暴露只读接口 `GET /api/oa/face/status`（仅 `hr.attendance` 权限可读）；PC 后台「考勤设置 → 人脸审核」（`FaceReviewTab.tsx`）顶部常显接入状态横幅（模拟模式 / 未接入供应商人工核对兜底 / 正式服务已接入），便于店主选定腾讯云 / 阿里云 / 百度等供应商后无缝替换 `FaceVerifyService`，期间不阻断员工打卡。
- **双端全量收尾与 360 × 800 手机适配收口**：统一补齐 `FacePage.tsx`、`DirectoryPage.tsx`、`MyPayslipPages.tsx`、`PunchPage.tsx`、`PayslipCard.tsx` 在 360 × 800 窄屏下的紧凑标题栏、返回入口、边距与长文本换行防护，全站 `/oa/*` 15 个核心页面在 360 × 800 微信内置浏览器下零横向滚动。
- **没有迁移、不改版本号（EO6）**：全部 6 批已完成，等待店主确定人脸比对供应商（EO3）及统一发版版本号（EO6）。
- **回归用例**：在 `tests/oa-faces.test.ts` 补 `faceServiceStatus` 与 `GET /api/oa/face/status` 权限和返回断言；在 `e2e/oa-mobile.spec.ts` 补 PC 端人脸状态横幅与手机 360 × 800 全部 15 个 `/oa/*` 路由零横向滚动巡检。
