# 汤崎 WCP · 员工小程序

员工小程序线的代码（[`docs/STAFF_MP.md`](../docs/STAFF_MP.md)）：原生小程序 + TypeScript，只连 yuzu 的员工小程序端口（`STAFFMP_PORT`，外面是 `https://staff.yuzusystem.xyz/api/staffmp/*`）。打卡、审批、员工培训……的规则都在 yuzu 里（主线），小程序只做界面；员工小程序端口把主线的员工端接口按白名单原样挂上（设计稿第 5.3 节）。

视觉照设计稿第 4 节与第 13.1 节的核对清单：亚麻米白底、墨色字与墨色主按钮、木色只做点缀；颜色、字号写成 `src/app.wxss` 的令牌，页面只用令牌（`tests/pages.test.ts` 查页面样式里没有十六进制颜色，`tests/contrast.test.ts` 核对令牌的对比度）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/app.*` | 页面清单、四个 Tab（今天 / 学习 / 工作台 / 我的）、设计令牌与公共样式、启动时先画后登 |
| `src/components/nav-bar` | 自己画的导航栏：只留微信胶囊，Tab 页是大标题，子页面左上角返回（页面栈只有一页时是「首页」），测试服、演示库常显实例标识 |
| `src/components/state-view` | 加载（短于 300 毫秒不出骨架）、空、出错、连不上 |
| `src/pages/login` `password` `position` | 登录（微信一键登录、账号密码、改绑要确认、同意并登录）、改密码、老账号选新岗位 |
| `src/pages/today` `workbench` `me` | 今天、工作台（按要办的事分组、搜功能名）、我的（微信绑定、改密码、大字、振动、关于） |
| `src/pages/learn*` | 学习：知识库（员工培训的文件夹与资料）、搜索、文档与图片预览、视频音频用短时地址播、记看过 |
| `src/utils` | 接口层与令牌（`api.ts`）、登录与「我是谁」（`session.ts`）、页面的登录核对（`guard.ts`）、入口清单、导航栏、日期文字、本机偏好 |
| `src/config/env.ts` | 按小程序的版本（开发版、体验版、正式版）选门店系统的地址 |
| `scripts/render-icons.mjs` | 生成标签栏与入口的图标（lucide 的图形，ISC 许可见 `assets-src/LUCIDE-LICENSE.txt`） |
| `tests/` | 单元测试（不要开发者工具） |
| `typings/` | 只给类型检查用的声明（不进小程序包） |

接口的类型直接用 yuzu 的 `src/shared/staffmp.ts`、`src/shared/training.ts`（只引类型，编译后不留引用），接口改了这里的类型检查会报错。

## 检查（不要开发者工具）

```bash
cd staff-miniprogram
npm ci
npm run check      # 类型检查 + 单元测试；CI 的「员工小程序：类型检查 · 单元测试」跑的就是这个
```

改了图标在仓库根目录执行 `node staff-miniprogram/scripts/render-icons.mjs`（用根目录装好的 lucide-react 与 Playwright）。

## 在微信开发者工具里打开

1. 本机起一套演示环境（独立演示库，见仓库根目录的 `AGENTS.md`）：yuzu 的 `.env` 加 `YUZU_INSTANCE=demo`、`STAFFMP_PORT=8095`、`STAFFMP_MOCK_WECHAT=true`，`npm run build` 后 `node dist/server/index.js`。
2. 开发者工具「导入项目」选 `staff-miniprogram/` 这个目录（不是 `src/`）；仓库里的 AppID 是占位的 `touristappid`，用测试号或正式 AppID（存在 `project.private.config.json`，不进仓库）。
3. 「详情 → 本地设置」勾上「不校验合法域名」（本机是 http）。
4. 门店系统是模拟微信时，「微信一键登录」用的是这台电脑的模拟微信用户；第一次用演示库的员工账号密码登录、勾上「以后用这个微信直接进」。

真机预览时手机连不到 `127.0.0.1`：把 `src/config/env.ts` 的 `DEV_BASE` 改成电脑的局域网地址（不要提交），手机上打开「开发调试」。

## 各版本连哪里

| 版本 | 地址 | 微信 |
| --- | --- | --- |
| 开发版 | `DEV_BASE`（本机，默认 `http://127.0.0.1:8095`） | 门店系统是模拟微信时用模拟 |
| 体验版 | 测试服的员工小程序域名（定下来以后填进 `src/config/env.ts`；没填之前体验版打不开，不会连到正式服） | 同上 |
| 正式版 | `https://staff.yuzusystem.xyz` | 一律用真的微信登录 |

## 写法上的约定

- 类型检查分两份：`tsconfig.json` 只查 `src/`，不带 Node 的类型；`tests/tsconfig.json` 查测试，带 Node 的类型。
- 开发者工具自带的 TypeScript 编译版本不一定新：`import type` 单独写，不用 `import { a, type B }`；不用数字分隔符。
- 样式不用 flex 的 `gap`（老 iOS 不认），间距用外边距或 grid 的 `grid-gap`；不写 `transition: all`；页面里不写十六进制颜色。
- 每个页面都有加载、空、出错、连不上几种样子；错误写原因和怎么办、留在原地，成功才用一闪而过的提示。
- 写操作带操作编号（`utils/uuid.ts`）；没收到回复的进「结果待确认」，按原编号原样重提（`AGENTS.md` 开发约定）。
- 版本号是本目录 `package.json` 的 `version`（从 `1.0.0` 起），上传体验版、正式版用它；yuzu 自己的版本号另算。
