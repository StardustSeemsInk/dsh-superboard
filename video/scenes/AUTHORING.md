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

- `scenes/data/board.json` — 真实看板 wire 值（`rev r30-7a7a256fcd4f`，5 页 67 块 3 边）
- `scenes/data/board-meta.json` — 抽取来源与**已施加的订正**（见下）
- `scenes/data/tokens-{latte,frappe,macchiato,mocha}.json` — 真实主题 token（各 190 个）
- `scenes/data/shiki-tokens.json` — 真实语法高亮色（分类色板来源）

> **快照里的内容是真实内容，包括它的错。** 看板自己的文字里曾写着「13 种块类型」，而源码
> `src/model.js:43-52` 的 `BLOCK_KINDS` 只有 **8** 个。修法是改 `tools/extract-data.mjs` 里的
> `CORRECTIONS` 表（**抽取时施加**），而不是手改快照——手改会被下一次重抽默默撤销，
> 而 `CORRECTIONS` 会连同理由一起记进 `board-meta.json`，可审计。
> 场景**不要**自己绕开：你渲染的就是真实数据这一层。


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
| **一个文档只能有一种主题** | 主题插件把 token 写成 `<body>` 上的 **inline 自定义属性**，一份文档只有一份值。想挂两块看板同屏展示深/浅，第二次挂载会把第一块重新上色——深色那块穿着浅色配色回来，看起来像产品的主题 bug | 一块看板，顺序 `setFlavour()`；要同屏对比就**先把两种配色的真实产物各钉一份 data URL**，再并排（见 §6） |
| **`<body>` 上的报错图形** | mermaid 的 `suppressErrorRendering` 默认为 `false`：源码解析失败时它把「Syntax error in text」大图插进 `document.body`，而**不是**插进卡片。我们自己的 `catch` 照常跑、卡片照常显示真实原因，于是失败**看起来**被妥善处理了，实际上一张全屏图压在看板上 | 已在 `src/client.js` 传 `suppressErrorRendering: true` 修掉。**教训**：这个图形不在看板 DOM 里，任何只查看板 DOM 的检查都看不到它 |
| **同步量、异步画** | 见上一行并列那条：队列里的手势还没落地就去量 DOM | 手感与渲染排在同一个 promise 上；量位置前先 `until()` 到目标元素存在 |
| **`useChat` 的选择器不能被忽略** | 阅读栏在 **render 期间**调 `useChat(selector)` 取 `snapshot.order` 与 `snapshot.nodes`（`src/client.js:2476-2485`）。桩若无视选择器直接返回一个对象，两个选择器都得到 `undefined`，于是栏里永远写着「这段对话还没有消息。」——**没有任何报错** | `useChat` 必须把选择器作用在快照上；harness 现在用 `useSyncExternalStore` 实现，这也正是「栏能在镜头中途变化」的前提 |
| **`Map.values()` 不是数组** | 阅读栏写的是 `const nodes = chat?.nodes?.values?.()`，紧接着 `if (!Array.isArray(nodes)) return []`。给一个真 `Map` 会拿到 **MapIterator**，于是**静默空栏**——和上一行是同一种失败，原因却完全不同 | `nodes.values()` 必须返回真数组（harness 的 `nodeStore` 就是为这一行存在的） |
| **隐藏时 `scrollHeight` 是 0** | `ReadingColumn` 靠 `[turns.length]` 的 effect 把自己钉到最新一条（`src/client.js:2493-2497`）。多状态场景里每个状态都是**隐藏时挂载**的，那一刻 `scrollHeight`/`clientHeight` 都是 0，写入是空操作、而且不会重跑。表现是「栏里显示的是**最旧**几条」——正好与要表达的意思相反 | 在可见的那一帧自己把它钉到底（本来就是产品自己的行为，只是那个 effect 当时量不到高度） |
| **只有一页的看板没有页签** | 客户端在单页时不渲染 tab 条，`selectPage` 找不到 `.sb-page` | 这不是「缺页」：没有页签就说明那一页已经是当前页，`selectPage` 应当直接返回 |
| **多挂载必须按挂载点查询** | 同一份文档里的多个 `BoardView` 共享**所有**类名，`document.querySelector('.sb-pageOn')` 会回答第一个挂载，读起来像「点了没反应」 | harness 的 `scope()`/`scopeAll()` 一律在**自己的 mount** 里查 |
| **`--wait` 是猜出来的** | 场景越重、启动越慢，某天就会开始截到「还没挂完」的帧 | 让 `renderScene` **await** 场景的就绪 promise（截帧器会 await 它的返回值），而不是把 `--wait` 调大 |
| **`uml` 块是一张还不存在的图** | 挂载返回时图还没渲染完，截到的是几张空卡片，而诊断里 `diagrams: []`、`errors: []` 看起来一切正常 | await 到 `.sb-diagramImage` 数量够了（或 `.sb-diagramError` 出现）再让 `renderScene` 返回：`await api.until(() => document.querySelectorAll('.sb-diagramImage').length >= N || document.querySelector('.sb-diagramError') !== null, …)` |
| **只有当前页的图会渲染** | 多状态场景里某个状态停在**另一页**，它的图永远不出现。按「模型里所有页的 `uml` 数」去等会一直等到超时（实测：算出来要 16，实际只有 13） | 只统计那一拍**实际显示的那一页**上的 `uml` 块 |
| **滚动位置不能用增量算** | 卡片的 `getBoundingClientRect()` **跟着滚动移动**，canvas 自己的 rect 不会，于是两者之差是**视口**位置而不是**内容**位置。拿它设 `scrollTop`，结果就取决于「之前滚到哪」——同一个 `t` 抓两次落到不同位置（实测该到 1846，实际停在 148） | 把当前滚动加回去才是内容坐标：`contentBottom = card.rect.bottom - canvas.rect.top + canvas.scrollTop`。这样任意顺序、任意次调用都得到同一个位置 |
| **量测工具与截帧器不是同一个视口** | `tools/eval.mjs` 曾用 `--window-size`（窗口**外**尺寸），而 `capture/frames.mjs` 用 `Emulation.setDeviceMetricsOverride`（**视口**尺寸）。差的 ~93px 浏览器边框让**每一次量出来的布局都比真实截帧矮 93px**（实测 `innerHeight` 987 对 1080），于是「某个元素在不在画面里」量错，看起来像场景的 bug | eval.mjs 现在施加同一个 override 并 reload 后再等。**任何量测工具都必须与截帧器同视口** |
| **「group 不能排版」是个错觉** | 两份数据里每个 group 都**恰好只有一个孩子**，六种模板长得一模一样；而没写 `layout` 时默认就是 `flow`，于是「没声明」和「只有一个块」在屏幕上无法区分 | group 的 **body** 和页面走同一套六种模板，而且能嵌套（`src/client.js:3196-3201`、`:3202-3213`）。要验证就去 `_probe-groups.html` 读每个 body 的 **computed style**，别靠看 |
| **ffmpeg `tile` 只填一格** | `-i shot-%d.jpg -vf "tile=3x2"` 在图片序列上只输出左上角一格，`-start_number` 也不解决 | 用 `filter_complex` + 六个显式 `-i` + `xstack=inputs=6:layout=…`。另外 ffmpeg **没有 `margin` 滤镜**，留白是 `pad` |

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

---

## 6. 构图：同屏对比（S5 用的做法）

「同一个块，换主题前后」这种对比，**顺序切换**只能让人记住后一张；**斜向劈开**能让人一眼比出来。
但因为「一个文档只能有一种主题」（§3），两半不能是两块同时在挂的看板。做法是**钉两份真实产物**：

1. 在当前配色下让产品渲染出真实 SVG（`img.sb-diagramImage`），把它的 `src`（一个 data URL）**存下来**；
2. `await api.setFlavour('latte')` + `waitForRepaint(旧src, …)`，等 `.src` **真的变了**，再存下第二份；
3. 两份 data URL 各放进一个 `<img>`，用 `clip-path` 各露一半，**重叠在同一个 rect 上**。

关键点：

- **两份必须在同一个 rect 上**，否则劈缝两侧的图会错位。用 `tools/eval.mjs` 量
  `getBoundingClientRect()`，两半应当**完全相等**（S5 实测 `[[653,77,588,786],[653,77,588,786]]`）。
- **劈缝用渐变，不要用旋转的长条**：

  ```css
  background: linear-gradient(to bottom right,
    transparent calc(50% - 1px), var(--accent) calc(50% - 1px),
    var(--accent) calc(50% + 1px), transparent calc(50% + 1px));
  ```

  `to bottom right` 的 50% 线**对任何盒子形状都正好是角到角的反对角线**，
  所以它永远和 `clip-path: polygon(0 0, 100% 0, 0 100%)` / `polygon(100% 0, 100% 100%, 0 100%)`
  对得上；旋转的长条会在面板改尺寸时慢慢错开。
- **面板取产物本身的朝向**。S5 第一版做了个 1040×640 的横版面板，而图是竖的
  （`naturalWidth/naturalHeight` 两种配色都是 112×150，比值 0.75），结果面板大半是空的。
  **量了再定尺寸**，不要按「屏幕是横的」去猜。
- 一半是浅底、一半是深底，所以标签/文字颜色要**分别算**：
  向上找第一个非透明的 `backgroundColor`，再据此挑可读的前景墨色（`inkOn(bg)`）。
- 对比面板要盖住背后的看板，用一层 `#scrim`（S5 用 opacity 0.86），否则背景里的卡片会跟面板抢读。

## 7. 文案：不要写成技术报告

片子第一版被用户评为「比起面向大众的产品宣传片更像一份技术报告」。经一次专门的文案评审，
问题被定位得很清楚：

> **主语和动词都站在产品一侧。** 主语是「产品/机制」（看板、会话日志、归一化矩形、容器），
> 动词是工程动作（折叠 / 回传 / 解析 / 渲染 / 落板 / 挂载）。于是整支片子都在回答
> **「它是怎么做的」**，从没人回答 **「这和我有什么关系」**。

「人机感」的三个具体来源：

1. **把内部术语当公共词汇**——`board_apply`、`expected_revision`、`rev`、`op`、归一化矩形、
   `user-select:none`、交付物、真源；
2. **断言式形容词堆出的技术自信**——唯一、全部、原生、职责范围内、没有第二个真源；
3. **对仗 / 定理式的定位句**——「看板＝…折叠出来的」「取代对话框成为主要界面」。

写作规则：

| 规则 | 说明 |
|---|---|
| **先痛后爽** | 开场说用户的痛（答案滚走了、同一个问题问了三遍），再说产品做什么 |
| **指着画面说** | 字幕描述**观众此刻看得见的东西**，不要描述看不见的机制 |
| **说结果，不说机制** | 「版本对不上，整批拒绝」而不是「没有第二个真源，会话日志是唯一的」 |
| **短到能读完** | 主标 ≤14 字、副标 ≤20 字、caption 标签 ≤14 字、sub ≤24 字 |
| **不吹牛** | 产品把失败交回给 Agent，不等于「它会自己改」——片子没演，就不许写 |
| **人话说人话** | 删掉对仗、删掉「唯一/原生/职责范围」 |

另外，**不要把实现注释留在画面上**（S7 的提示行曾把 `originAt()`、`Range.intersectsNode`、
`user-select:none` 直接显示给观众）。

---

## 8. 自拟的演示数据：看板可以自己造，渲染不许自己造

真实渲染的**数据**不必来自真实会话。S2 就是一个**自拟的多次查询任务**：一次「选一台 14 寸
笔记本」的对话，和它最后落到看板上的五页（数据在 `scenes/data/laptop-demo.json`，品牌与型号
都是编的，所以**没有任何一帧在替真实产品说话**）。判断标准是这条线：

- **可以自拟**：看板的内容、对话的文本、页与卡片的组织。这些是「用户在谈什么」。
- **不许自拟**：卡片的渲染、页签、阅读栏、折叠顺序、主题 token、错误路径。
  也就是**产品怎么表现**。凡是后者，一律加载发布版 `src/client.js` 让它自己跑。

一条配套的诚实要求：**自拟的数据要在文件里写清是自拟的**（`laptop-demo.json` 的 `note`），
否则下一个人会以为它是抽出来的真实输入。

### 阅读栏：怎么让「对话」有内容

`startBoard({ chatTurns })` 收 `[{ role: 'user' | 'assistant', text }]`，最新在最前之后
`api.setChat(turns)` 可以随时续上。两者都走 `useChat` 这个真外部存储，所以栏会自己重渲染。

**多状态场景（S2）的做法**：每个看板状态各自挂一个 mount，各自带**当时**的那一段对话 ——
`chatTurns: conversation.slice(0, N)`。于是「状态 N 的栏」天然只显示第 N 时刻的近几条，
更早的已经滚出去了。这就是镜头要说的那件事，而且它不是一个动画效果，是**两条数据同时增长**。

两个量测过的事实：一轮对话约占 60 px；阅读栏的可见高度约 621 px。想让栏开始滚动，
对话至少要 16 条左右 —— **先量再定条数**，别凭感觉。


