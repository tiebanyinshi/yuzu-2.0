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

1. **首屏**：左边思源宋体大字「柚子」从水里浮上来、之后轻轻漂；右边一池柚子汤——8.2.0 起是 three.js 的实时 3D（`website/hero3d.js`，见第 6 节）：PBR 的水面折射池底的方砖与焦散光纹，几颗 PBR 柚子浮在浪上，会躲开指针、互相碰一碰，点一下水面起涟漪。3D 起不来时换回原来的 2D 柚子池（`website/pool.js`，自己写的着色器，没有抄 Shadertoy）。
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
| 首屏 3D（8.2.0） | three.js 0.186（mrdoob/three.js，约 11 万星，MIT）+ postprocessing 6.39（pmndrs/postprocessing，约 2.6 万星，Zlib）             | PBR 材质、环境光、后期都现成；只打首屏用到的部分，压缩后 220 KB（gzip），见第 6 节                                                       |
| 中文标题字       | 思源宋体 Heavy（adobe-fonts/source-han-serif，OFL；8.2.0 起，以前是得意黑）                                                     | 粗宋的笔画有粗细对比，像杂志、精品店，不是「黑体 + 几何无衬线」的模板感；只取页面用到的字，132 KB                                        |
| 拉丁字与数字     | Gloock（Google Fonts，OFL；8.2.0 起，以前是 Funnel Display）                                                                    | 高反差衬线，钟点、CRM / ERP、yuzu 用；和宋体是一路，不是 Inter、Poppins 那种到处都是的字                                                 |
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

## 4.1 首屏视频与分享图（8.1.46，素材库）

官网的首屏视频、分享图不放在 `website/` 里，从系统的素材库取（`docs/BOARDS.md` 第 5 节）：

- 在系统里「Design → 素材库 → 用途」换「官网 · 首屏视频」「官网 · 分享图」，全公司一份、只在总店换；官网刷新就换上，不用重新部署官网。Design 首页的「官网」卡片写着现在用的哪一份。
- 官网经不要登录的 `https://sys.yuzusystem.xyz/api/public/website/hero-video`、`/share-image` 取：只开这两个用途正在用的那一版，别的素材一律不给。
- 首屏视频开始播放以后盖住柚子池、柚子池停掉；没设（404）、正式服取不到、浏览器不让自动播、开了「减少动效」或省流量时照原来的柚子池。
- 分享图写在 `<meta property="og:image">` 里（建议 1200 × 630）；没设时没有分享图（与以前一样）。

## 5. 改字以后

思源宋体只取了页面上用到的字（8.2.0 以前是得意黑）。改了页面上的中文以后重新取一次子集（要 `fonttools` 与 `brotli`）：

```bash
python3 - <<'PY' > /tmp/chars.txt
import re
s = open('website/index.html', encoding='utf-8').read()
s = re.sub(r'<!--.*?-->', '', s, flags=re.S)
print(''.join(sorted(set(ch for ch in s if ord(ch) > 0x2E80) | set('，。、：；！？「」《》（）·'))))
PY
pyftsubset SourceHanSerifCN-Heavy.otf --text-file=/tmp/chars.txt --unicodes="U+0020-007E" \
  --flavor=woff2 --layout-features='*' --output-file=website/fonts/source-han-serif-heavy-subset.woff2
```

`SourceHanSerifCN-Heavy.otf` 从 adobe-fonts/source-han-serif 的 release 分支 `SubsetOTF/CN/` 取（`https://raw.githubusercontent.com/adobe-fonts/source-han-serif/release/SubsetOTF/CN/SourceHanSerifCN-Heavy.otf`）。

## 6. 首屏 3D 柚子池（8.2.0）

> 店主 2026-11-27：学一下新的高级 UI 库（three.js、postprocessing、react-three-fiber、cables.gl、Hydra、Blender），搜一些不那么 AI 低级的字体，改造官网。

`website/hero3d.js`（模块脚本）在首屏右边那块池子里画一个实时 3D 场景：

- **水面**：three.js 的 `MeshPhysicalMaterial` 透射材质（折射率 1.333、按厚度染成泳池蓝），顶点按四层波浪与点出来的涟漪起伏、法线跟着算；透过水看得到池底和柚子泡在水里的半截。
- **池底**：一片小方砖，上面打着水面焦散的光纹（与 `pool.js` 的光纹同一套算法）和柚子的影子。
- **柚子**：PBR 材质——打蜡的果皮（清漆层）、程序生成的油胞法线贴图、黄里带青的斑驳，顶上一个蒂、有的带一片叶子；浮在浪上跟着起伏、歪一歪，躲开指针，互相碰一碰，点一下水面起涟漪、把附近的柚子推开。
- **光**：`RoomEnvironment`（程序生成的影棚环境光，相当于一张柔和的 HDRI，不用下载 `.hdr`）+ 一盏偏暖的侧光。
- **后期**（postprocessing）：Bloom 只让最亮的光纹和高光微微泛开、ACES 色调映射、一点点色差（只在电脑上）、胶片颗粒、四角压暗——去掉「塑料感」。
- 手机与四核以下的机器：降分辨率、不做色差与 SMAA。「减少动效」时只画一帧。离开屏幕、切走标签页时停下；首屏视频（第 4.1 节）放起来时整个停掉。
- **退路**：不支持 WebGL2、3D 库没加载到、着色器编不过、显卡丢了上下文、老浏览器不认模块脚本时，换回原来的 2D 柚子池（`main.js` 的 `YuzuHeroFallback`）。

`website/vendor/three-bundle.js` 是 esbuild 只打了用到的部分（入口 `website/vendor-src/three-entry.js`）。重新打包（换版本时）：

```bash
mkdir -p /tmp/yz3d && cd /tmp/yz3d && npm i three@0.186.1 postprocessing@6.39.5
cd <仓库> && NODE_PATH=/tmp/yz3d/node_modules node_modules/.bin/esbuild website/vendor-src/three-entry.js \
  --bundle --format=esm --minify --target=es2020 --legal-comments=eof --outfile=website/vendor/three-bundle.js
```

### 那几个库怎么选的

| 库                        | 用了没有 | 为什么                                                                                                                                          |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| three.js                  | 用了     | PBR 材质、透射、环境光、ACES 都自带，首屏的 3D 全靠它                                                                                           |
| postprocessing（pmndrs）  | 用了     | Bloom、颗粒、色差、暗角合成在一两个 pass 里，比 three 自带的后期省；去塑料感主要靠它                                                            |
| react-three-fiber + drei  | 没用     | 官网是纯静态页面、不用 React；为一块首屏引入 React 不值得。系统里（React）以后要做 3D 时再用                                                    |
| cables.gl                 | 没用     | 节点式编辑器，做出来的是它自己的运行时与工程文件，不好放进仓库审代码；适合做 VJ 现场，不适合官网                                                |
| Hydra                     | 没用     | 现场写代码出 2D 反馈画面，风格偏实验、偏迷幻，和汤泉「放松、干净」的调子不搭                                                                    |
| Blender（Cycles / EEVEE） | 这次没用 | 离线渲染质感更高，适合做**首屏视频**：渲一段柚子池的循环视频，在系统「Design → 素材库」换上「官网 · 首屏视频」就行（第 4.1 节），不用改官网代码 |

### 换字（8.2.0）

中文标题：思源宋体 Heavy；拉丁字与数字：Gloock；正文仍用系统字体。都是 SIL OFL，可商用、可随网页分发。
挑字的原则：不要 AI 生成网页最常见的「黑体 / Inter / Poppins + 渐变」；宋体配高反差衬线是杂志与精品店的路子，和「高级感」一致。

## 备案号（店主 2026-11-27）

页脚挂 ICP 备案号「粤ICP备2025486782号-4」，链到工信部备案查询（https://beian.miit.gov.cn/#/Integrated/index，新窗口打开）。号码改了（换备案主体、加网站序号）改 `website/index.html` 页脚的 `.foot-icp` 那一行。公安备案号下来以后照这个位置加。
