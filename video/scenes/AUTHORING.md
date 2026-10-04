# 场景编写指南（每个做场景的人都先读这个）

## 0. 怎么跑

需要一个静态服务器（`file://` 不能 fetch 同目录文件）：

```powershell
cd E:\Dev\dsh-superboard\video
npm run serve          # http://127.0.0.1:8788   （/ 指向 video/，/repo/ 指向仓库根）
```

截帧（**这是唯一的截帧方式**，不要用 Edge 的 `--screenshot`/`--dump-dom`，在这台机器上不可靠）：

```powershell
node capture\frames.mjs "http://127.0.0.1:8788/scenes/s1-title.html" `
  --out .tmp-check --duration 8 --fps 4 --width 1920 --height 1080 --scale 1 --wait 4000
```

**迭代时务必用低 fps（2–4）和小 `--scale 1`**，只有最终出片才用 30fps / scale 2。
多个人同时开无头 Edge 会互相抢 CPU，所以**你只负责把场景做对，最终渲染由 Lead 统一跑**。

看结果：`read_image` 直接读 PNG。要看动态，用 ffmpeg 拼接触表：

```powershell
$ff='C:\Users\haoch\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-full_build\bin\ffmpeg.exe'
& $ff -y -loglevel error -i "frame_%05d.png" -vf "select='not(mod(n\,10))',scale=480:-1,tile=3x3" -frames:v 1 _sheet.png
```

**量测比看图准。** 需要知道一个真实数值（算出来多少、token 解析成什么颜色、
图片到底有没有加载成功）时，用 `tools/eval.mjs` 在真实的无头 Edge 里求值：

```powershell
node tools\eval.mjs "http://127.0.0.1:8788/scenes/s6-spatial.html" `
  "document.querySelectorAll('img.sb-media').length" --wait 8000
```

**从 PNG 里读数字是猜。** 尤其：一张 404 的图**照样占着一个卡片**，
所以「卡片在」不能证明「图加载了」——要量 `.complete && naturalWidth > 0`。

---

## 1. 铁律：`renderScene(t)` 必须是纯函数

```js
window.renderScene = (t) => { /* t = 秒（本场景内的 0 起点） */ }
```

- **不许**用 `requestAnimationFrame` 驱动画面。
- **不许**用 `setTimeout` 驱动画面。
- **不许**用 CSS `animation` / `transition` 驱动画面。
- **不许**读 `Date.now()` / `performance.now()`。

原因：截帧工具会在任意时刻、任意次数调用 `renderScene(t)`。任何「自己会走」的动画都会
在两次调用之间漂移，于是同一帧号重跑得到不同画面——这种 bug 只在最终成片里才看得见。

要动画就**从 `t` 算出**：

```js
const p = Math.min(1, t / 0.6)            // 进度
el.style.opacity = String(p)
el.style.transform = `translateY(${(1 - p) * 24}px)`
```

**唯一的例外**是「真实渲染」类场景里点击页签这类异步 DOM 操作：那类操作要做成
**幂等 + 记忆化**——用一个 Set 记住已经点过的页签，且返回一个 promise，
`renderScene` 返回它，截帧工具会 await（见 `scenes/s2-pages.html` 的 `queue` 写法）。

如果需要在 `t` 上跳来跳去（比如从 12s 跳到 3s），**状态必须能从 `t` 重建**，不要依赖
「上一个 t」。截帧是按 0,1,2,… 顺序来的，但不要假设这一点。

---

## 2. 真实渲染：怎么把看板挂起来

**不要画假的看板界面。** 加载**发布版** `src/client.js`（由服务器从 `/repo/src/client.js`
提供），它渲染出来的是什么就是什么。

现成的封装在 `scenes/harness.js`：

```html
<link rel="stylesheet" href="/scenes/theme.css" />
<script src="/vendor/react.production.min.js"></script>
<script src="/vendor/react-dom.production.min.js"></script>
<script>window.__ModuleLoader__ = { load: (d) => { window.__sbDef = d } }</script>
<script src="/repo/src/client.js"></script>
<script src="/scenes/harness.js"></script>
<script>
  const api = await window.SuperboardHarness.startBoard({ sessionId: 'promo' })
  await api.selectPage('architecture')   // 真实点击页签
  await api.setFlavour('latte')          // 真实切换主题
</script>
```

`api` 提供：`selectPage(slug)`、`setFlavour(flavour)`、`activePage()`、`blocks()`、
`blockBySlug(slug)`、`until(fn,label)`、`clickElement(el)`、`mod`（模块导出）、`board`。

`startBoard` 选项：`{ sessionId, flavour, mutate(model), diag, chatTurns }`。
`mutate` 是唯一该动模型的地方（做示范用的裁剪），**不要改仓库里的数据文件**。

数据来源（真实，从用户实际安装与运行中抽出）：

- `scenes/data/board.json` — 真实看板 wire 值（`rev r28-c577192f84d9`，5 页 81 块 3 边）
- `scenes/data/tokens-{latte,frappe,macchiato,mocha}.json` — 真实主题 token（各 190 个）
- `scenes/data/shiki-tokens.json` — 真实语法高亮色（分类色板来源）

---

## 3. 已经踩过的坑（**不要重新发现**）

| 坑 | 表现 | 对策 |
|---|---|---|
| **路径** | `./vendor/x.js` 在 `/scenes/` 下解析成 404 | 一律用**绝对路径**（`/vendor/…`、`/scenes/…`、`/repo/…`） |
| **`fetch`** | `file://` 下同目录 fetch 被拒 | 必须走 http（`npm run serve`） |
| **模块导出** | 读 `mod.exports` 得到 `undefined` | factory 的**返回值**才是导出 |
| **rAF** | 等 `requestAnimationFrame` 的页面会永远挂住 | 只等 `setTimeout` |
| **`--virtual-time-budget`** | 推进 `setTimeout` 但停止服务 rAF | 不用它 |
| **静默失败** | 页面报错时截出的是空帧，与「慢」无法区分 | 每个场景都要 `main().catch(把 stack 写进 DOM 标记)` |
| **脱离文档的 SVG** | `getComputedStyle` 全是 `''`（读成「无填充」而不是报错） | 先 append 再量 |
| **mermaid 的文字** | 可见文字在 `<tspan>`，父 `<text>` 是底色 | 量 `text>tspan` |
| **`<svg>` 没有背景** | `backgroundColor` 透明被解析成黑 | 对比度对 surface 量 |
| **`color-mix()`** | mermaid 抛 `Unsupported color format` 并**丢掉整张图** | 别给 mermaid 传 `color-mix`；要混合自己算 `rgb()` |
| **token 缺席** | 解析成 `rgb(0,0,0)`，与真黑无法区分 | 先测存在性（`getPropertyValue` 返回 `''`） |
| **读 token** | `getComputedStyle(body).getPropertyValue('--x')` 对 `var()` 链返回字面量 | 用临时元素：`el.style.color='var(--x)'` 再读 computed `color` |
| **`zoom` 重排** | 放大后 grid **列数变多**——看到的是「更大的更多看板」，不是「更大的更少看板」 | 用 `transform: scale` + `transform-origin`，它像镜头一样放大既有排版 |
| **缩放后的坐标** | `getBoundingClientRect()` 是**变换后**的（实测 837px 的 canvas 报 1548px，比值 1.8499），而 `scrollTop` 是**未变换**的内容像素。两者混用会把位移放大 1.85×，写到 `maxScroll` 被钳住 | 换算：`scale = rect.height / clientHeight`，先把 rect 差值除以它再算 `scrollTop` |
| **`#mount` 被 scale 撑高** | 宿主留 100% 再 `scale(1.85)`，渲染出的 mount 比视口高 1.85 倍；canvas 自认为 1548px 高，而下半部分根本不在截帧里。表现是「滚到 `maxScroll` 却什么都没有」 | 把宿主尺寸写成**未缩放**像素：`width = innerWidth / SCALE`、`height = innerHeight / SCALE`，让缩放后的盒子正好等于窗口 |
| **异步内容变高** | 图片 / PDF 加载完成后卡片才长高，之前量的滚动位置就过期了 | 先轮询到 `img.complete && naturalWidth > 0`、且没有 `canvas.sb-pdfPage` 还挂着 `sb-pdfPending`，**再**在同一队列步骤里应用滚动与高亮 |
| **失败卡片还没出现** | 故意画错的 `uml` 块，其 `.sb-diagramError` 要等 mermaid 真的试过并抛错才存在。提前算好高亮 → 该拍没有任何高亮，而字幕却说「高亮了」 | 用 `until(() => document.querySelector('.sb-diagramError'), …)` 等它出现，再算位置 |
| **同步调用拿不到异步结果** | `renderScene` 同步去读 DOM，而队列里的 `pointerup` 还没处理，于是载荷面板显示 `blocks: []`，旁边的浮条却写着「已选 2 个块」 | 把「手势」与「画结果」排在**同一条返回的 promise** 上 |
| **PNG 哈希不等于像素** | 同一画面的两次编码可能不同（预测行/滤波选择不同），直接比哈希会报假失败。实测某场景 8/42 帧「不同」，解码后只是**一个字形反锯齿里 15 个字节差 1** | 哈希不一致时**解码成原始 RGB 再比**；判据是像素差。`tools/determinism.mjs` 已封装这件事 |
| **空帧的两种成因** | 页面抛错与页面慢，在磁盘上都只留一个空帧 | 见上：`main().catch()` 写 DOM 标记；并且用 `hasScene` 而不是「文件存在」判断 |

---

## 4. 视口与可读性（重要）

看板本身字号偏小，1920×1080 全屏铺开时**块里的字很小**。做法：

- 全景镜头（S2）保持 1:1，靠字幕讲清在发生什么；
- **细节镜头**放大 `#mount`：用 `transform: scale(SCALE)` + `transform-origin: top left`，**不要用 `zoom`**（`zoom` 会重排，grid 会多出列来）。真实渲染 + 放大是**允许**的，也是必要的。
  **放大时把宿主尺寸设成未缩放像素**：`width = innerWidth / SCALE`、`height = innerHeight / SCALE`，
  这样缩放后的盒子正好填满窗口；否则渲染出的 mount 比视口高 SCALE 倍，画布下半部分不在截帧里（见 §3）。
- 需要滚动就把 `.sb-canvas` 的 `scrollTop`/`scrollLeft` 设成确定值（**从 `t` 算**），不要用 `scrollIntoView`。
  **注意缩放**：`getBoundingClientRect()` 报的是变换后的尺寸，`scrollTop` 是未变换的内容像素，
  换算见 §3 的「缩放后的坐标」。

字体：中文用 `"Microsoft YaHei"`，等宽用 `"Cascadia Mono"`，`theme.css` 已经设好。

---

## 5. 交付要求

- 场景文件放在 `scenes/<id>-<name>.html`，**只改你负责的那些文件**。
- 场景必须能被 `capture/frames.mjs` 直接跑通：`hasScene: true` 且 `ok: true`。
- **纯度要自己证明**：`node tools/determinism.mjs --only <你的场景>`。它抓两遍、逐帧比；
  哈希不一致时会**解码成原始 RGB 再比**，所以报 `exact` / `aa` / `DRIFT` 而不是假失败。
  报 `DRIFT` 就是真的不纯——某个地方在读时钟或让动画自己走。
- 场景里**不要**写 `console.log` 噪音；把诊断信息挂到 `window.__diag`。
- 完成后回报：场景文件路径、你跑过的命令、截帧的 `ok/hasScene`、纯度结果、你实际看过的帧号与结论。
- 时长与起止以 `timeline.json` 为准；`renderScene(t)` 的 `t` 是**场景内 0 起点**。
