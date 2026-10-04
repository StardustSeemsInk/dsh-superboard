# dsh-superboard 发布宣传片

一支 **1920×1080 / 30fps / 95 秒** 的发布宣传片，展示 dsh-superboard 截至目前的全部卖点。
**无配音**（不涉及 TTS）——靠画面 + 字幕 + 配乐 + 音效。

出片：`dist/dsh-superboard-promo.mp4`

---

## 一条原则

**不画假的看板界面。**

每个镜头都加载**发布版** `src/client.js`（由本地服务器从 `/repo/src/client.js` 提供），
喂给真实板数据（`scenes/data/board.json`，从用户实际安装的会话日志里抽出来的 wire 值）
和真实主题 token（`scenes/data/tokens-*.json`），在无头 Edge 里挂载真实的 `BoardView`，
再用 CDP 逐帧截图。

所以片子里出现的每一个卡片、每一条连线、每一张图、每一次框选，**都是产品自己在跑**。

这条线要划得更准一点：**「真实」约束的是渲染，不是内容。** 片子里有两类镜头——

- 大多数镜头喂的是**真实数据**：`scenes/data/board.json` 是从用户实际安装的会话日志里抽出来的 wire 值；
- **S2** 喂的是**自拟的演示数据**（`scenes/data/laptop-demo.json`）：一次「选一台 14 寸笔记本」的
  多次查询对话，和它落到看板上的五页。品牌与型号（Aurora / Meridian / Tern）都是编的，
  所以它不构成对任何真实产品的说法。

两类的渲染路径**完全相同**：都加载发布版 `src/client.js`，由它自己渲染卡片、页签、**阅读栏**、
折叠顺序。自拟的只是「用户在谈什么」，绝不是「产品怎么表现」。判断标准写在
`scenes/AUTHORING.md` §8。

**S2 为什么要自拟**：它要说的那件事，一张看板的静态截图说不出来——**对话一直往上滚，看板一直往下攒，
问过的不用再问第二遍**。所以它挂五个看板状态，每个状态各带「当时」那一段对话：
状态越靠后，页越多、对话越长，而阅读栏永远只显示最近几条。这不是动画效果，是**两条数据同时增长**。
原先这一拍是开发看板的五页巡礼，看板上写着「13 种块类型」这类只有开发者看得懂的东西。

这条原则有一个直接推论，写进了 `PLAN.md` §5：**宁可少一个卖点，不可多一个假卖点。**
任何镜头在声称一个能力之前，先回源码里确认它真的存在。分镜原写「箭头指进图内」，
核实后发现客户端根本不读锚点（`edge.from.at` 在 `src/client.js` 里出现 **0 次**），
于是改成宣传真实存在的那个能力——宿主解析 PDF 文本层并把行矩形交给 Agent。

---

## 怎么跑

```powershell
cd E:\Dev\dsh-superboard\video
npm run serve      # 127.0.0.1:8788，另开一个窗口常驻（必须常驻，不能 Start-Job）
npm run data       # 从真实安装抽取 board / token → scenes/data/
npm run score      # 合成配乐 → audio/promo-score.wav
npm run build      # 截帧 → 逐场景编码 → 拼接 → 混音
npm run verify     # ffprobe 对成片做断言
```

`npm run build` 是**分阶段且可续跑**的：截帧是最慢的一步（2× 超采样下 ~2.5 fps），
所以 `--only s2,s5` 与「这个场景的帧已经齐了」的检查都在，避免因为改了一个场景
就重做 20 分钟。另外 `--capture-only`、`--encode-only`、`--skip-capture`、`--no-audio`、`--force`。

**迭代时务必用低 fps（2–3）和 `--scale 1`**，只有最终出片才用 30fps / scale 2。

### 什么进 git，什么不进

进 git 的是**源码**：场景、工具、配乐合成器、文档、以及抽取出来的真实输入。
不进 git 的（见 `.gitignore`）是**派生物**：`.frames/`（~1.8 GB 截图）、`.segments/`、
`audio/promo-score.wav`、`dist/`。理由很直接——截帧缓存 1.8 GB 且没有任何 diff 可看，
而 20 MB 的成片每次重渲都会再进一份 pack。成片请挂到 release 资产上。

代价是：clone 之后要跑一遍 `npm run build` 才有片子（约 19 分钟），这不是 bug。

---

## 目录

| 路径 | 作用 |
|---|---|
| `PLAN.md` | 分镜表、技术栈与硬约束、被驳回的镜头与理由 |
| `timeline.json` | **权威**：分辨率、帧率、九个场景的起止与文件、`beatGrid`（剪辑点与重音） |
| `scenes/AUTHORING.md` | 场景契约、踩过的坑、纯度要求 |
| `scenes/theme.css` | 共享视觉语言，颜色从真实 `--dsw-*` token 读取 |
| `scenes/harness.js` | 挂载真实看板的封装（`startBoard` / `setFlavour` / `selectPage` …） |
| `scenes/s1..s9-*.html` | 九个场景 |
| `scenes/data/board.json` | 从真实安装里抽出来的看板 wire 值 |
| `scenes/data/laptop-demo.json` | **自拟**的演示任务（S2 用）：一次多次查询的对话 + 它落成的五页 |
| `capture/frames.mjs` | CDP 截帧器（**唯一的截帧方式**） |
| `capture/_smoke.html` | 最小的合法场景（一个会随 `t` 移动的方块）——用来验证截帧器本身 |
| `tools/serve.mjs` | 本地静态服务器，镜像 `/repo/*`、`/api/file`、插件的宿主路由 |
| `tools/extract-data.mjs` | 抽取真实输入，并施加**可审计的数据订正**（见下） |
| `tools/eval.mjs` | 在真实无头 Edge 里求值并打印 JSON——**这是量测工具**，从 PNG 里读数字是猜 |
| `tools/determinism.mjs` | 纯度审计：每个场景抓两遍，逐帧比 |
| `tools/build.mjs` | 分阶段、可续跑的构建 |
| `tools/verify.mjs` | 对成片做断言（分辨率、像素格式、帧率、时长、音轨覆盖） |
| `audio/score.mjs` | 代码合成配乐 |
| `audio/HITPOINTS.md` | 实际用的时刻表 |
| `vendor/` | React 18.3.1 UMD，本地留档以便复现 |

---

## 三条硬规矩

### 1. `renderScene(t)` 必须是 `t` 的纯函数

```js
window.renderScene = (t) => { /* t = 秒，本场景内 0 起点 */ }
```

不许用 `requestAnimationFrame` / `setTimeout` / `Date.now()` / `performance.now()` /
CSS `animation` / `transition` **驱动画面**。

原因不是洁癖：截帧工具会在**任意时刻、任意次数**调用 `renderScene(t)`。任何「自己会走」的
动画都会在两次调用之间漂移，于是同一帧号重跑得到不同画面——**这种 bug 只在最终成片里才看得见**，
在接触表上看不出来。

**唯一的例外**是「真实渲染」里点击页签这类异步 DOM 操作：那类要做成**幂等 + 记忆化**，
并且把 promise 从 `renderScene` 返回，截帧工具会 await。

`node tools/determinism.mjs` 会把这条规矩变成可执行的检查。

### 2. 静默失败是默认形态

页面抛错与页面只是慢，在磁盘上**都留下一个空帧**。所以每个场景都要
`main().catch()` 把 `String(error.stack)` 写进一个可见的 DOM 标记；
并且判断用 `hasScene`，不要用「文件存在」。

（还有个具体的坑：`main` 若是**同步**函数，`main().catch(...)` 会在顶层抛
`TypeError: main(...) is undefined`，**在 `renderScene` 被定义之前就中止整个脚本**，
表现出来是 `hasScene: false` 而不是报错。要用 `Promise.resolve().then(main).catch(...)`。）

### 3. 缩放用 `transform: scale`，不用 `zoom`

`zoom` 会**重排**：一个 `grid` 会因此多出列来，你看到的是「更大的更多看板」，
而不是「更大的更少看板」。`scale` 像镜头一样放大既有排版。

配套的一条：放大时要把宿主尺寸设成**未缩放**像素
（`width = innerWidth / SCALE`），否则渲染出的 mount 比视口高 SCALE 倍，
画布下半部分根本不在截帧里——表现是「滚到底了却什么都没有」。

---

## 数据订正（重要）

宣传片渲染的是看板的**真实内容**，所以内容里的一个事实错误会被如实搬上银幕。
确实存在一个：看板自己的 `status` 块写着「13 种块类型」，`questions/q23` 也重复了。

**真实数量是 8**——`src/model.js:43-52` 的 `BLOCK_KINDS` 恰好是
`heading / prose / list / code / uml / image / pdf-page / group`，`README.md:27` 也写「八种块」。
那是**过期的看板正文**，不是缺失的功能。

订正放在 `tools/extract-data.mjs` 的 `CORRECTIONS` 表里，在抽取时施加，
**而不是手工改快照**——这样重新抽取不会静默把这个修正弄丢（这一条是有意的：
"hand-edit the generated file" 是那种下次谁重跑一遍就前功尽弃的修法）。
同一个改动也落在了真实看板上，两边一致。

`scenes/data/board-meta.json` 里记录了这份快照的来源会话、revision 和**实际施加了哪些订正**。

---

## 文案与配乐：两处按评审结论重做过

第一版成片被用户指出四点：卖点与痛点不突出、像技术报告；「叮」声尖锐；
四连鼓点不协；主题那拍希望改成对比图。前两条与第三条按下面处理，第四条见 `scenes/AUTHORING.md` §6。

**文案**交给了一个 `deepseek-v4-pro` 的会话专门评审（经 `dsh headless --patch` 覆盖
`agent-default-model` 的 provider/model 实现——DSH Desktop 的「自定义模型」子代理只在**新会话**里生效，
当前会话里选它不会真的换模型）。评审给出 86 处改动，落成 84 处替换 + 6 处手改，规则见
`scenes/AUTHORING.md` §7。根因不是用词，是**主语和动词都站在产品一侧**：整支片子都在回答
「它是怎么做的」，没人回答「这和我有什么关系」。

**配乐**的两处改动都是**按测量改的**，不是按口味：

- 「叮」原来是 `bell()`，分音是基频 + **2.76×** + **5.4×**——那是不谐的三角铁频谱，
  在密集混音里像针。换成 `mallet()`：基频 + 第 4 分音（马林巴的谐波特征）+ 低通 + 降八度。
- **四连鼓点不协的根因是网格**：`timeline.json` 里每个切换点都是整秒，而 BPM 100 的一拍是 0.6 s，
  除不尽整秒，于是八个切换点都落在拍与拍之间。`BPM = 120`（一拍 0.5 s）整除任何整秒，
  八个点全部落在拍上；同时把节奏型从「每拍一鼓」改成 half-time。
  实测 30–120 Hz 频带能量（t = 70.0 s）：**-25.8 dB → -16.9 dB**。

细节见 `audio/HITPOINTS.md`。

---

## 成片断言

`npm run verify` 逐条检查，每一条都对应一个**具体的失败形态**，而不是打印一堆数字让人自己看：

- 文件存在
- 有视频流、有音频流
- 1920×1080
- `yuv420p`（通用播放）
- 30 fps
- 时长 = 最后一个场景的结束时间 ±0.5 s
- 音轨覆盖整个片子

---

## 环境（实测，非假设）

| 工具 | 位置／版本 |
|---|---|
| ffmpeg | **9.0.1**，`C:\Users\haoch\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-full_build\bin\ffmpeg.exe` |
| Node | **v24.21.0**（自带全局 `WebSocket`，所以 CDP 不需要任何依赖） |
| Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |

**注意**：这台机器上 `msedge --dump-dom` / `--screenshot` 不可靠。所以量测一律走
`tools/eval.mjs`（CDP），截帧一律走 `capture/frames.mjs`（CDP）。
另外 `Start-Job` 起的服务器会随父 PowerShell 进程一起死——常驻服务器必须是**托管的后台任务**。
