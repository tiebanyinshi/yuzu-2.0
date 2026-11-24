# 柚子官网部署手册（yuzusystem.xyz；给 Codex）

官网是 `website/` 里的纯静态文件（HTML、CSS、JS、字体，没有构建步骤、没有后端、不连数据库），设计与改字见 [`WEBSITE.md`](WEBSITE.md)。这份手册写怎么把它放上 `https://yuzusystem.xyz`，以及 `sys.`、`staff.` 两个子域名怎么换过来。

谁做：店主办域名与备案（第 1 节）；Codex 部署与日常更新（与正式服一样**只部署 `main` 上的版本标签或完整 SHA**，不部署 `claude/*` 分支或没合并的 PR）。

## 0. 一览

```
浏览器 ──HTTPS──▶ yuzusystem.xyz / www.yuzusystem.xyz ─▶ Caddy file_server：/srv/yuzu-website（官网静态文件）
       ──HTTPS──▶ sys.yuzusystem.xyz                  ─▶ Caddy reverse_proxy：正式服应用端口（原 yuzu.nextland.com.cn）
       ──HTTPS──▶ staff.yuzusystem.xyz                ─▶ Caddy reverse_proxy：正式服员工端口（原 staff.yuzu.nextland.com.cn）
```

- 官网上所有「进入系统」「登录柚子系统」都链到 `https://sys.yuzusystem.xyz`，「柚子饭堂」链到 `https://staff.yuzusystem.xyz`（写死在 `website/index.html`，换域名要改那里）。
- 官网不经过 yuzu 应用，不读任何业务数据；放在哪台机器、和正式服是不是同机都可以。建议与正式服同一台的 Caddy 多一个站点（证书一起管）。

## 1. 先要有的（店主办）

- [ ] 域名 `yuzusystem.xyz` 解析：`yuzusystem.xyz`、`www.yuzusystem.xyz`、`sys.yuzusystem.xyz`、`staff.yuzusystem.xyz` 四条 A 记录指到放 Caddy 的那台服务器的公网 IP。
- [ ] **ICP 备案**：服务器在中国大陆（阿里云深圳）的，域名没备案阿里云会拦截 80 / 443，Caddy 也签不了证书。备案下来之前官网不上线；`sys.`、`staff.` 照 `RELEASE_V800.md` 第 2.3 节，备案前只经 Tailscale。
- [ ] 安全组开 80（签证书与跳转 https）和 443。

## 2. 第一次部署

在放 Caddy 的服务器上（下面假设仓库克隆在 `~/yuzu-site-src`，只用来取官网文件，不跑应用）：

```bash
# 1) 取 main 上的某个版本（标签或完整 SHA）
git clone https://github.com/Venture-VV/yuzu.git ~/yuzu-site-src   # 已有就跳过
cd ~/yuzu-site-src && git fetch --tags origin main
REV=v8.1.30                                    # 换成要部署的版本标签或完整 SHA
git merge-base --is-ancestor "$REV" origin/main || { echo "不在 main 上，停"; exit 1; }

# 2) 只导出 website/ 到一个新目录，再整体换上去（换的那一下是原子的，访客不会看到一半新一半旧）
STAMP=$(git rev-parse --short=12 "$REV")
sudo mkdir -p /srv/yuzu-website-releases/$STAMP
git archive "$REV" website | sudo tar -x --strip-components=1 -C /srv/yuzu-website-releases/$STAMP
echo "$REV $(git rev-parse "$REV")" | sudo tee /srv/yuzu-website-releases/$STAMP/VERSION.txt >/dev/null
sudo ln -sfn /srv/yuzu-website-releases/$STAMP /srv/yuzu-website.new && sudo mv -T /srv/yuzu-website.new /srv/yuzu-website
```

`/srv/yuzu-website` 是指向某一版目录的软链接；回退就是把它指回上一版的目录（第 4 节）。

Caddyfile 加官网站点（Caddy 自己申请、续期证书）：

```caddyfile
yuzusystem.xyz {
  root * /srv/yuzu-website
  encode zstd gzip
  file_server
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options nosniff
    Referrer-Policy strict-origin-when-cross-origin
    # 官网只用自己的文件：脚本、字体、样式都在 website/ 里，不引外部 CDN
    Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
  }
  # 字体、第三方库换版本时文件名不变，只缓存一天；页面本身每次都核对
  @static path /fonts/* /vendor/*
  header @static Cache-Control "public, max-age=86400"
  header /index.html Cache-Control "no-cache"
  header / Cache-Control "no-cache"
}
www.yuzusystem.xyz {
  redir https://yuzusystem.xyz{uri} permanent
}
```

`script-src` 里的 `'unsafe-inline'` 是给 `index.html` 头上那一行（给 `<html>` 加 `js` 类，让没开脚本的浏览器照样看到全部内容）。`VERSION.txt` 不用挡：只写了版本号与 SHA，和系统登录页常显的一样。

改完 `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`（Caddy 跑在容器里的，照那台机器原来的重载方法）。

## 3. 部署以后核对

```bash
curl -sI https://yuzusystem.xyz | head -1                    # HTTP/2 200
curl -s https://yuzusystem.xyz/VERSION.txt                    # 是刚部署的标签与完整 SHA
curl -s https://yuzusystem.xyz | grep -c 'sys.yuzusystem.xyz' # ≥ 1：系统入口链接在
curl -sI https://www.yuzusystem.xyz | grep -i location       # 跳到 https://yuzusystem.xyz/
curl -sI https://yuzusystem.xyz/fonts/smiley-sans-subset.woff2 | grep -i content-type   # font/woff2
```

浏览器里再看一遍（电脑 Chrome、iPhone Safari、安卓微信里各一次）：

- 首屏「柚子」大字与右边一池柚子汤出来；点水面起涟漪。手机上不卡（卡的话记下机型，WebGL 不可用的设备会显示静态底色，不影响阅读）。
- 往下滚「店里的一天」：宽屏横向走完五个时段，天色从白天到夜里；手机上竖排。
- 「进入柚子系统」「登录柚子系统」打开 `https://sys.yuzusystem.xyz`（第 5 节换好之前会打不开，属预期）。
- 系统设置里打开「减少动态效果」后，页面不再动，内容都在。
- 开发者工具的控制台没有红字（CSP 拦了什么会在这里报）。

## 4. 更新与回退

- **更新**：第 2 节的第 1、2 步换成新的 `REV` 再执行一遍。Caddy 不用重载。
- **回退**：`ls -t /srv/yuzu-website-releases` 找上一版目录，`sudo ln -sfn /srv/yuzu-website-releases/<上一版> /srv/yuzu-website.new && sudo mv -T /srv/yuzu-website.new /srv/yuzu-website`。
- 旧版目录留最近 5 个，其余可以删。
- 官网的改动随主线的版本标签一起发：`website/` 有改动的版本，Codex 部署正式服时顺手更新官网；没改动的不用动（比一下 `git diff --stat <上一版> <这一版> -- website/`）。

## 5. 两个子域名换过来（替换 nextland.com.cn）

店主 2026-11-24 定（`PENDING_DECISIONS.md` YZ2）：

| 新地址                 | 替换                         | 接到哪                               |
| ---------------------- | ---------------------------- | ------------------------------------ |
| `sys.yuzusystem.xyz`   | `yuzu.nextland.com.cn`       | 正式服应用端口（系统统一登录入口）   |
| `staff.yuzusystem.xyz` | `staff.yuzu.nextland.com.cn` | 正式服员工端口（柚子饭堂网页与接口） |

代码里没有写死旧域名（文档里写的是 `<域名>`），换域名只动服务器。

**换之前必须先做（不做不能换，Codex 审查 7a586da）**：每台终端、平板「结果待确认」的记录（充值、结账、退款、交班、ERP 单据……，见 AGENTS.md「开发约定」）存在浏览器里，**按域名分开存**——换到新域名以后，新域名下看不到旧域名记着的原操作编号，页面会当成新的一笔、换一个新编号，已经入账的那一笔就可能被再记一次。所以：

0. 约好的窗口里先停写：前台不再收款、开单，ERP 不再提交；
   - 每台终端、平板、员工手机（柚子饭堂）用**旧域名**打开系统，看顶上有没有「结果待确认」的提示条（门店前台的、ERP 的、发卡台与收银台的都看）；
   - 有的逐笔处理到没有：能查回的点「查询这笔操作的结果」，查不回的原样重提，或经服务端「确认作废」后再说（都不能直接丢掉本机记录）；
   - 每台机器处理完记下设备名，全部清零以后才进行下面第 1 步；有一台处理不了就不换，另约时间。

1. **Caddyfile**：把原来两个站点的名字换成新的，`reverse_proxy` 那几行不动；旧名字先留着、改成跳转，过渡一个月：
   ```caddyfile
   yuzu.nextland.com.cn {
     redir https://sys.yuzusystem.xyz{uri} permanent
   }
   staff.yuzu.nextland.com.cn {
     redir https://staff.yuzusystem.xyz{uri} permanent
   }
   ```
   注意：跳转以后浏览器在新域名下要重新登录（登录 Cookie 跟着域名走），门店终端提前告诉值班经理。
2. **正式服 `.env`**：`COOKIE_SECURE`、`TRUST_PROXY` 不变。员工食堂的员工入口地址（后台「员工食堂 → 设置」里填的那个，注册海报与饭卡二维码用它）改成 `https://staff.yuzusystem.xyz`。
3. **重新打印**员工食堂的注册海报、饭卡二维码（旧的扫出来是旧域名，过渡期内会跳转，过渡期后打不开）。
4. **门店终端**：浏览器书签、添加到桌面的图标、平板菜单的地址都换成新域名；平板菜单重新登录一次。
5. **小程序网关**（`api.<域名>`、`api-test.<域名>`）这次不动：小程序后台登记的合法域名改起来要重新提交，另约时间（小程序线）。
6. 核对：`curl -sI https://sys.yuzusystem.xyz/login` 是 200、登录页常显的实例标识是「正式服」、版本与 SHA 与部署的一致；`curl -sI https://yuzu.nextland.com.cn` 跳到新域名。

时间窗口与店主约（不在营业高峰；换完店主在门店电脑上走一遍登录 → 门户 → 收银台）。

## 6. 不做的

- 官网不放统计脚本、在线客服、外部字体或 CDN（要加先找店主定，CSP 跟着改）。
- 官网不进 yuzu 的 Docker 镜像（`.dockerignore` 已排除 `website/`），也不由 yuzu 应用来发：应用出问题时官网照常打开。
