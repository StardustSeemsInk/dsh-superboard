# dsh-superboard 发布宣传片

目标：一支 **1920×1080 / 30fps / 约 95 秒** 的发布宣传片，展示 dsh-superboard 截至
`de4d807` 的全部卖点。**无配音**（不涉及 TTS），靠画面 + 字幕 + 配乐 + 音效。

**不宣传教师预设**（未完成），只在预设那一幕一行带过并标明「未完成」。

---

## 一、技术栈与硬约束

| 项 | 决定 | 为什么 |
|---|---|---|
| 看板画面 | **无头 Edge + CDP 截图真实渲染** | 必须「相对真实」。不画假的，直接加载**发布版 `src/client.js`** |
| 动画/图形 | 普通 Web（HTML/CSS/Canvas） | 本片没有 3D 需求；WebGL/Three.js 只会拖慢并增加失败面 |
| 配乐 | **代码合成**（Node 写 PCM → WAV） | 原创、零版权风险、且能精确对齐镜头切换点 |
| 剪辑/编码 | **ffmpeg 9.0.1**（已装） | `C:\Users\haoch\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_...\bin\ffmpeg.exe` |
| 分辨率 | 1920×1080, 30fps, H.264 `yuv420p`, AAC | 通用兼容 |
| 设备像素比 | 截图按 **2×** 渲染再降采样 | 看板文字必须锐利，1× 的细字会糊 |

**关键约束：不要用 `--virtual-time-budget` 去跑动画**——它会推进 `setTimeout` 但在渲染器
被认为隐藏后**停止服务 `requestAnimationFrame`**，等 rAF 的页面会永远挂住。
所有动画必须由**确定性时钟**驱动（见下）。

---

## 二、真实看板画面怎么来（最重要的技术点）

`src/client.js` 是**经典脚本**，注册 `window.__ModuleLoader__.load({ id, factory })`，
factory 只接收 `require`，且**返回值就是模块导出**（不是 `module.exports`）。
它只 `require('react')`，只用 `createElement / Fragment / useState / useRef / useEffect /
useMemo / useCallback`。

所以挂载真实看板的办法是「喂它一个假宿主」：

```js
window.__ModuleLoader__ = { load: (def) => { window.__sbDef = def } }
// 然后
const mod = window.__sbDef.factory(requireStub)   // requireStub('react') → React
```

`mod.BoardStyles()` 给出**真实样式表**，`mod.Block` 给出**真实块渲染器**，
`mod.BoardView({ sessionId, useProjection, useChat, useInput, inputActions, attachFeedback,
loadOlder, useSession })` 给出**真实整屏**（含页面页签、阅读栏、选择托盘）。

- `useProjection('board')` 要返回**真实的 wire 值**：`{ modelVersion: 5, model, diag: {} }`。
  真实模型可从
  `C:\Users\haoch\.dsh\storages\session_projcache\sessions\session-b0e78947-8260-44e5-b61a-14c6f3934b7c.json`
  的 `record.rows.board.val.model` 取出（`rev r28-c577192f84d9`，5 页 / 3 边）。
- **主题 token**：真实来源是 `@deepseek-ai/dsh-client-ui-theme/lib/client.js`（899 个
  `--dsw-*`）。主题插件通过官方 API 注册，`ThemePresenter.apply()` 把 token 写成
  `<body>` 上的**内联自定义属性**，并设 `data-ds-dark-theme`。消费方必须读 DOM。
- `require('react')` 由我们提供；React 18 UMD 从 CDN 下载后**本地留档**（可复现）。

**一个已知坑**：`getComputedStyle` 读不到的 token 会解析为 `rgb(0,0,0)`，与真黑色无法区分。
读 token 一律走元素 `color` 解析（`el.style.color = 'var(--x)'` 再读 computed）。

---

## 三、确定性动画约定（所有场景必须遵守）

任何要动画的 HTML 场景都必须暴露：

```js
window.renderScene = (t) => { /* t = 秒，浮点；把画面画成 t 时刻的样子 */ }
```

**不许用 `requestAnimationFrame`、`setTimeout`、`Date.now()`、CSS `animation`/`transition`
来驱动画面**——截图工具会以任意时刻、任意次数调用 `renderScene(t)`。
CSS `animation` 若要用，必须能在 `renderScene` 里通过设置 `animation-delay` 负值或
`animation-play-state: paused` + `currentTime` 精确定位；**更推荐直接用 JS 设样式**。

截图工具（Lead 提供，`video/capture/frames.mjs`）：

```
node video/capture/frames.mjs <html 文件> <时长秒> <fps> <输出目录> [宽] [高]
```

它对每一帧设 `window.renderScene(t)`，然后 `Page.captureScreenshot` 落盘为
`frame_00000.png` …。**若页面没有 `renderScene`，则只截一帧并重复**（静态场景可用）。

---

## 四、分镜（95 秒）

| # | 时间 | 内容 | 卖点 | 负责 |
|---|---|---|---|---|
| S1 | 0–8 | 标题卡：深色看板缓慢横移做底，`dsh-superboard` 浮出 | 一句话定位 | 场景 |
| S2 | 8–20 | **真实看板**整屏，跨 5 页页签切换（roadmap/architecture/questions/research/issues） | 看板取代对话框；多页 | 真实截图 |
| S3 | 20–34 | Agent 侧：`board_apply` 调用 → 块逐个落上看板 | Agent 原生可编辑；日志原生折叠 | 场景 + 真实截图 |
| S4 | 34–47 | 8 种块类型 + 6 种排版模板巡礼（grid/columns/masonry/row/flow/canvas） | 表达力 | 场景 + 真实截图 |
| S5 | 47–60 | UML 真渲染；深/浅主题切换；渲染错误**回传给 Agent**自愈 | mermaid + 主题自适应 + 自愈 | 真实截图 + 场景 |
| S6 | 60–69 | PDF 整页 + 图片钉在看板上；**宿主解析出的文本行矩形**落在真实页面上 | 空间性内容 | 真实截图 |
| S7 | 69–81 | 框选块 + **选中文字** → 托盘 → 变成给 Agent 的结构化附件（含 `Ctrl+C`） | 双向交互 | 真实截图 + 场景 |
| S8 | 81–89 | 三个预设：工程师 / 研究员 已就绪；**教师标注未完成** | 开箱即用 | 场景 |
| S9 | 89–95 | 结尾：`github.com/StardustSeemsInk/dsh-superboard` + 一行口号 | — | 场景 |

**音乐结构**（供配乐对齐；总长约 95s）：

- 0s 起：低频铺底 + 稀疏脉冲，克制（标题）
- 8s：节拍进入（看板亮相）
- 20s / 34s / 47s / 60s / 69s / 81s / 89s：**每次镜头切换一个明确的音乐事件**
  （鼓击 / riser 收尾 / 和弦转换）
- 89–95s：收束和弦 + 尾音余韵

---

## 五、被驳回的镜头：不要宣传产品没做的事

分镜原写「箭头指进图内」，**这是错的**，已改正。核实过（不是猜的）：

- `src/client.js:1738-1739` 是客户端**唯一**读边的地方：`boxes.get(edge.from.blockId)` /
  `boxes.get(edge.to.blockId)`，而 boxes 来自各卡片自己的 `getBoundingClientRect()`。
  所以连线**永远是整块 → 整块**。
- 在 `src/client.js` 里 `edge.from.at` 出现 **0 次**、`edge.to.at` **0 次**、`block.crop` **0 次**、
  `.anchors` **0 次**。
- `test/render.test.js:349` 把这个能力的删除**钉住**了：
  `assert.ok(!found.includes('sb-anchored'), 'the anchor container existed only for block-level at')`。
- 模型仍然**校验并存储**九种锚点与 `crop`（`src/fold.js:939-972`、`src/model.js:740-761`），
  **词汇表活着，但没有东西渲染它**。
- 看板自己也这么说：`questions/q18`「没做的那一半：几何。箭头末端仍然落在整块上，不落到图里那个方框」；
  `q19`「`rect` / `point` 两个锚点从「等 OCR」变成了「不做」」；`skills/board-layout/SKILL.md:134`
  把 `crop` 列在「Fields that do nothing」；`docs/design/board-model.md:318`
  「扫描件与图片没有页内锚点，这是设计而非缺陷」。

**改成了真实存在的那个能力**：宿主自带 pdf.js 6.3.289 解析 PDF **文本层**，`board_read` 把
每一**视觉行**连同它归一化到 0..1 的矩形一起交给 Agent。实测第 1 页第 1 行就是
`(0.0958, 0.0793, 0.3888, 0.0214)  看板 PDF 渲染验证 · 第 1 页`——与看板自己 `pdfwhy` 块承诺的
**逐字一致**。S6 画的就是这些真实行矩形，标签写作「宿主给出的行矩形」，
而不是「产品把箭头画进了图里」。

**原则：宁可少一个卖点，不可多一个假卖点。** 任何镜头在声称一个能力之前，
先回到源码里确认它真的存在；发现对不上，改镜头并且**在报告里说清楚**。

`video/audio/HITPOINTS.md` 必须写出实际用的时刻表（可与上表差一点，但要写清楚）。
