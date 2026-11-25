# 柚子官网（店主 2026-11-24）

> 店主：系统中文名「浴族」改叫「柚子」；做一个柚子官网，好玩的风格、炫酷的动效，去 AI 感、要高级设计感，带一个进入柚子系统的链接。
> 官网是独立的静态页面，放在 `website/`，不属于门店系统：Docker 构建不带（`.dockerignore`），lint、排版、用例都不扫这个目录。

## 1. 域名（店主 2026-11-24 定）

| 地址                   | 用途                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `yuzusystem.xyz`       | 柚子介绍官网（本目录），右上角与首屏、收尾都有「进入系统」按钮 |
| `sys.yuzusystem.xyz`   | 系统统一登录入口，替换原来的 `yuzu.nextland.com.cn`            |
| `staff.yuzusystem.xyz` | 柚子饭堂网页与接口，替换原来的 `staff.yuzu.nextland.com.cn`    |

代码里没有写死旧域名（`docs/RELEASE_V800.md`、`docs/CANTEEN.md` 里写的是 `<域名>` 占位）；换域名是服务器上的事：DNS 解析、Caddy 站点、各实例 `.env` 里对外地址（员工入口地址等）改成新的，由店主与 Codex 在约定窗口做，见第 4 节。

## 2. 页面

自上而下（不是「首屏 + 三张功能卡 + 行动号召」的套路）：

1. **首屏**：左边得意黑大字「柚子」从水里浮上来、之后轻轻漂；右边一池柚子汤——WebGL 着色器实时画水面焦散光纹，几颗柚子浮在水上，会躲开指针、互相碰一碰，点一下水面起涟漪（`website/pool.js`，自己写的着色器，没有抄 Shadertoy）。
2. **店里的一天**：五个钟点（开门发牌、上钟、开饭、清台清房、交班日结）。宽屏时钉住横着走，一颗柚子当太阳从左边升起、到右边落下，后半段整段入夜、太阳变月亮；窄屏竖排。
3. **一个账号，四扇门**：与系统里的门户页一致（CRM、ERP、WCP、Design，8.1.43 跟着 `docs/BOARDS.md` 改名），大小不一的四块，跟着指针微微倾斜。
4. **纯天然 AI 制作，零人工代码添加**（8.1.43 重写，以前叫「钱按分记，账只往后写」）：深色一段，底下是第二池暗一点的水；标题逐字被照亮。店主 2026-11-25 嫌原来的话「非常 AI」，改成拿「整套系统都是 AI 写的」自嘲开头，下面四句话一句一行（左边小标签「这套系统是怎么来的」，右边编号 01–04、字放大、句子之间一条细线，最后一句柚子黄；店主定稿，原来讲记钱规矩的那段删了）。写法：说具体的事和数字（版本号、谁干什么），不用对仗口号、排比、「不是……而是……」。
5. **员工也有自己的柚子**：柚子饭堂（饭卡、巡场、办公），链接 `staff.yuzusystem.xyz`。
6. **进门吧**：柚黄底大字、登录按钮，下面一条一直往左走的字条。

页面上不写编出来的数字、客户评价或合作商标；说的都是系统已经有的功能。

## 3. 用了什么（GitHub 上挑的高星库与审美参考）

| 用途             | 选的                                                                                                                            | 为什么                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 滚动动画、时间轴 | GSAP 3.13 + ScrollTrigger（greensock/GSAP，约 3.1 万星）                                                                        | 业界标准的动效库，2025 年起全部插件免费商用                                                                                              |
| 平滑滚动         | Lenis 1.3（darkroomengineering/lenis，约 1.7 万星，MIT）                                                                        | Awwwards 一类网站常用，与 ScrollTrigger 配合                                                                                             |
| 中文标题字       | 得意黑 Smiley Sans（atelier-anchor/smiley-sans，约 1.5 万星，OFL）                                                              | 有个性的中文斜体黑，不是系统字体那种「默认感」；只取页面用到的字，45 KB                                                                  |
| 拉丁字与数字     | Funnel Display（Google Fonts，OFL）                                                                                             | 钟点、ERP 等用                                                                                                                           |
| 审美规则         | Nutlope/hallmark（约 6 万星，去 AI 味的设计规则与 50 种材质）的「Refract」材质（日光、水纹、泳池蓝，关键词就有 bathhouse、spa） | 照它的规则避开 AI 套路：不用紫蓝渐变、不用发光光斑、不在标题上方放小标签、不用等宽字装样子、不做三等分图标卡、动效都有「减少动效」的退路 |
| 设计系统参考     | VoltAgent/awesome-design-md（约 12.9 万星）                                                                                     | 各大品牌设计系统的写法参考                                                                                                               |

也看过、这一版没用的：Motion（motiondivision/motion）、React Bits（DavidHDev/react-bits）、Magic UI——都是 React 组件库，官网是纯静态页面，用不上 React。

颜色取汤崎品牌书：水纹蓝 `#6D94AB`、Relax 蓝 `#4D718C`、Pure 黄 `#E9C75E`、Organic 绿 `#6D673D`、胡桃 `#4A3628`、麻色 `#F8F1E6`（`brand/concept-film/film/assets/brand.json`）。

第三方文件都放在 `website/vendor/`、`website/fonts/`（不走外网 CDN：国内访问 Google Fonts 等不稳），许可见 `website/vendor/LICENSES.md`。

## 4. 部署

完整步骤（取版本、原子切换、Caddy 站点与安全头、核对、回退、两个子域名怎么换过来）见 [`DEPLOY_WEBSITE.md`](DEPLOY_WEBSITE.md)。最简单的样子是 Caddy 加一个站点：

```
yuzusystem.xyz, www.yuzusystem.xyz {
  root * /srv/yuzu-website
  encode zstd gzip
  file_server
}
```

把仓库里 `website/` 的内容拷到 `/srv/yuzu-website`（只用 `main` 上的版本标签或完整 SHA 的内容）。`sys.`、`staff.` 两个子域名按原来 `yuzu.nextland.com.cn`、`staff.yuzu.nextland.com.cn` 的 Caddy 站点照样配，只换名字；员工入口地址（柚子饭堂二维码里的地址）跟着改成 `https://staff.yuzusystem.xyz`，旧二维码要重新打印。

本机看：`cd website && python3 -m http.server 8093`，打开 `http://127.0.0.1:8093`。

## 5. 改字以后

得意黑只取了页面上用到的字。改了页面上的中文以后重新取一次子集（要 `fonttools` 与 `brotli`）：

```bash
python3 - <<'PY' > /tmp/chars.txt
import re
s = open('website/index.html', encoding='utf-8').read()
s = re.sub(r'<!--.*?-->', '', s, flags=re.S)
print(''.join(sorted(set(ch for ch in s if ord(ch) > 0x2E80) | set('，。、：；！？「」《》（）·'))))
PY
pyftsubset SmileySans-Oblique.ttf --text-file=/tmp/chars.txt --unicodes="U+0020-007E" \
  --flavor=woff2 --layout-features='*' --output-file=website/fonts/smiley-sans-subset.woff2
```

`SmileySans-Oblique.ttf` 从 atelier-anchor/smiley-sans 的 v2.0.1 发布包里取。
