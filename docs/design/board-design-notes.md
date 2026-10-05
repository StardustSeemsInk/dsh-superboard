# 看板设计说明 — 排版、预算、客户端、决策对应与风险

**状态：** 活文档（§4.5 与 §8 的开放/已解决状态随代码更新）。**这里不是模型契约**：字段、op 与折叠语义在
[`board-model.md`](./board-model.md) §0–§2，工具面在 [`board-tools.md`](./board-tools.md)。

**这一节原先在 [`board-model.md`](./board-model.md) 里**，2026-10-05 按体裁拆出。本文件是 §4–§8：排版模板（§4）、
上下文预算（§5）、客户端与镜像（§6）、与已定决策的逐条对应（§7）、风险与未决（§8）。

> **节的编号沿用拆分前的原始编号**（本文件从 §4 开始），所以 `§4.5`、`§5.4`、`§8.1` 之类引用仍然对得上。
> 体裁上是**设计与论证**，不是契约：§4.5 明确记着模板表已被
> [`../../skills/board-layout/SKILL.md`](../../skills/board-layout/SKILL.md) 取代，§8 是动工前的风险台账
> （已解决的条目保留原文，并标上解决它的 commit）。

---

## 4. 排版模板

### 4.1 v1 模板清单

模板是**页级或 `group` 级**的，Agent 通过 `set_layout` 或 `add_page{layout}` 声明。**Agent 不写坐标**（Q-E）。`region` **不能**挂模板——它是标注，不是容器（§4.2）。

| 模板 | Agent 怎么触发 | 引擎算几何的规则 | 需要的额外元数据 |
|---|---|---|---|
| **`flow`** | 默认值。什么都不写就是它。适合「一条推理链」 | 单列 flex column，`gap: 12px`；高度 = 内容自然高度 | 无 |
| **`row`** | 一批要横着排、放不下就换行的卡 | flex row + wrap，`align-items: flex-start`；直接子 `.sb-card` 分得 `flex: 1 1 220px`，`group` 子块按内容宽度 | `gap` |
| **`columns`** | 页的内容明显成栏（对比、并列方案） | **grid，行优先填充**：`repeat(cols, minmax(0,1fr))`。`cols` 缺省 2，上限 6；**容器宽 < 720px 时降为 1 列** | `cols`（可选）, `gap` |
| **`grid`** | 一批同质卡片（风险清单、指标、对照表） | `areas` 给定时按名字落格；否则 `repeat(auto-fill, minmax(minCardWidth,1fr))`。**行按顺序填充；卡高自然，但行轨道高 = 该行最高卡** | `minCardWidth`（默认 **260px**，clamp 120–640）, `cols`（可选）, `areas`（可选）, `gap` |
| **`masonry`** | 卡片高度差异大，想「把空间填满」（信息流、小红书式） | **瀑布流**：CSS multi-column（`column-count` 或 `column-width`），卡高各随内容，`break-inside: avoid` 保证不被切断。**内容超过一栏高度后按列优先填充** | `cols`（可选，上限 6）或 `minCardWidth`（同 grid 默认与 clamp）, `gap` |
| **`canvas`** | 逃生舱：只要一个「什么都不安排」的盒子来做分区 | **不安排任何几何**：`position: relative` 的盒子 + `min-height: 120px`，子块按普通块流纵向堆叠并保持 12px 间距。空间留给「本质上就是空间性的」组件（今天只有箭头层）——见 §4.4 | 无 |
| ~~`tree`~~ | **已删除** | `group` 套 `group` **就是**树；两者并存等于一种东西两种说法 | — |
| ~~`matrix`~~ | 未实现 | — | — |

**约束：`areas` 与 `cols`/`minCardWidth` 互斥**（同时给出是错误，不是「后者忽略前者」），因为它们都在决定列数。

### 4.2 视觉分组：`region` 还是 `group` 块？

两者都存在，职责不同，**取舍写死如下**：

| | `Region` | `GroupBlock` |
|---|---|---|
| 层级 | 看板级对象，**可跨页** | 页内块，属于某一页 |
| 位置 | 块外（`block.regionId` 反向指针 + `region.blockIds`） | 块内（`group.children`） |
| 读序影响 | **无**（块仍在 `page.blocks` 的原位置） | **无**（同上，children 只是引用） |
| 视觉 | 背景色块 + 边框 + 标题，包住成员块（可跨栏） | 可折叠容器，渲染为带标题的盒子 |
| 排版模板 | **不挂模板**（纯标注，与树正交） | **可以挂模板**，且可嵌套（`group.layout`） |
| 典型用途 | 「这些问题都属于风险」「这两个方案是一组」——**语义簇** | 「这一节的细节折叠起来」——**阅读折叠** |

**规则：** 要模板、要跨页、要语义 → `region`；要在页内折叠一段内容 → `group` 块。**一个块最多属于一个 region**，但可以是某个 group 的 child——两者不冲突，因为一个影响背景框，一个影响折叠。

**为什么不让 region 也拥有顺序：** 一旦 region 有序，页的读序就有了两个来源（`page.blocks` 与各 region 的成员序），折叠器要维护一致性。现在 region 只回答「谁和谁是一伙」，不回答「谁先谁后」。

### 4.3 窗口很窄时怎么办

「模板优先」与「响应式」天然冲突：**窗口一窄就重排，会让坐标失去意义，也会让 Agent 的坐标覆盖（`canvas`）在窄窗里变成一堆重叠的方块。** 本设计的处理是一条硬规则加两条降级：

**硬规则：模板在**宽窗**下定义几何，几何不参与模型，也不参与 revision。**

模板算出的坐标是**派生数据**，它：

- 不进 `BoardModel`（模板算出的几何从不进模型，块本身也不携带坐标——§4.4）；
- 不进 `revHash`（board-model.md §2.5）；
- 不落 log。

所以「窄窗重排」根本不构成模型层的问题——它只影响渲染。真正需要小心的是**语义**层面的变化（谁和谁在一栏），那才需要 Agent 知道。

**降级 1（自动，渲染层）：**
`columns` 在容器宽 `< 720px` 时降为 **1 列**——这是实现里唯一存在的窄窗降级（`src/client.js` 的 `width < 720 ? 1 : 6`）。`grid` 和 `masonry` 不需要降级：它们本来就是响应式的（`auto-fill` / `column-width` 让浏览器自己决定列数）。

**降级 2（显式，Agent 层）：**
模板参数支持「窄窗变体」的唯一形式是 `cols` 的**上界**——引擎永远可以选更少的列，不会选更多。Agent 若想要窄窗下不同的**结构**（而不仅是列数），正确做法是**分页**，不是给模板加断点。

> **未实现（曾经写在这里）**：本节原本承诺「容器宽 `< 640px` 时把 `columns`/`grid` 降级为单列 `flow`，并登记一条 `code:'LIMIT'` 诊断」。**这条没有实现**，`src/client.js` 里根本没有 `LIMIT` 这个字符串。真正的窄窗行为只有上面那一条 `720px` 的 `columns` 单列化，且它不产生任何诊断。要么实现它，要么删掉这条承诺——现在记录在此以免继续误导。

**为什么不做真响应式：** 因为 Agent 看不到像素（本设计的中心约束）。一个 Agent 无法感知、无法验证、无法针对其调整的响应式行为，只会制造「模型以为布局是 A、实际是 B」的静默错配。窄窗提示 + 分页把这件事变成 Agent 可以**看见并决定**的。

### 4.4 坐标属于「空间性的组件」，不属于块（`at` 已删除）

**`block.at` 不再存在。** 它曾是「块可以离开流、被放到任意像素」的逃生舱，两次评审后删除，理由是：**坐标只对「本质上是空间性的东西」才有意义**，而一个 Markdown 块不是。

它删掉的直接原因是一类静默失败：Agent 写下一个坐标，既无法看到渲染结果，也无法验证落点，于是「模型以为布局是 A、实际是 B」没有任何通道能暴露。`canvas` 模板因此改为**给空间性组件留出画布**，而不是给每个块发一根坐标笔。

**今天的位置表达只有两种：**

1. **容器声明布局** —— 页或 `group` 上的 `layout.template`（`flow` / `row` / `columns` / `grid` / `masonry` / `canvas`）。这是机制，覆盖绝大多数需求。
2. **容器声明命名单元格** —— `grid` 模板下的 `params.areas`，用**子块引用**（slug / 旧别名 / id）而不是数字填格子，让「哪一块占哪一片」可读、可校验，且不限制容器只能有 9 个块：

   ```
   arch  arch  intro
   tests .     intro
   ```

   行用 `/` 或换行分隔，`.` 是空位。**同一个名字占据的格子必须构成实心矩形**——L 形和不相连会被拒绝，而不是被猜一个包围盒。行列数由模板自身决定；与 `cols`、`minCardWidth` 互斥（同时给出是错误，不是「后者忽略前者」）。

**将来的自由摆放属于组件，不属于块：** 箭头今天已经按端点的实际几何布线；一个 Note 块（特殊 Markdown）以后可以自带位置。它们共同点是——**位置是它们语义的一部分**，而不是覆盖在别人排版上的一层。

**约束（保持不变）：模板优先。** Agent 声明结构与命名，引擎算几何；凡是需要 Agent 手写坐标才能表达的东西，都应该是「有一个组件天然如此」，而不是「给块加一个坐标字段」。

---

### 4.5 本节与实现之间的已知偏差（5 条）

本节表格写于两次排版评审之前。**以代码为准**；下面是已核实的偏差，不要照表格实现：

| 表格里的 | 实现里的 |
|---|---|
| `tree` 模板、`region` 可挂模板（`region.layout`） | `tree` 已删除——**组里套组本身就是一棵树**，另设模板是同一件事的两种说法；改为新增 `row`。`region` 退化为**纯标注**（tone + label），不再有 `layout`；`group` 才是排版容器 |
| `grid` 的 `minCardWidth` 默认 280px、`cols` 默认 4；`hints.bands` | 实现里默认 **260px**，且 `grid` 未给 `cols` 时用 `repeat(auto-fill, minmax(...))` 自适应；`bands`、`matrix` 均未实现（`set_layout` 的 `root`、`direction` 两个死字段已删除） |
| §4.3「窄窗 `< 640px` 降级为单列 + `LIMIT` 诊断」 | **未实现**。`src/client.js` 里没有 `LIMIT`；唯一的窄窗行为是 `columns` 在 `< 720px` 时变单列，且无诊断 |
| `columns` 的 `cols` 上限 4 | 现为 **6**（`masonry` 同上限）。两者都是「静默截断」——见 §4.3 的取舍说明 |
| `grid` + `cols` 会让卡高等高 | **不再如此。** 等高只发生在 `areas`（命名格子是槽位）——`cols` 只决定列数，不改变卡高。这条偏差曾经存在并制造过「短卡变成大空盒」的真实问题 |

### 4.6 图（`uml`）如何跟随主题（2026-10-04）

图用 `<img src="data:image/svg+xml…">` 呈现，所以**主题必须在编码前就烘焙进 SVG**：CSS 进不了 `<img>` 内部，而且 mermaid 本来就把主题写进自己的 `<style>` 块。承担这件事的是 `diagramThemeVariables(read, dark)`（`src/client.js`）。

三条已实测的事实决定了它的形状：

| 事实 | 含义 |
|---|---|
| `theme: 'base'` 是 **唯一**尊重完整变量集的 mermaid 主题（`default`/`dark`/`neutral`/`forest`/`neo`/`redux` 忽略其中大部分） | 必须走 `base`，然后把 DSH 自己的配色喂进去，而不是在 mermaid 的几套内置主题之间选 |
| 顶层 `darkMode` 选项**无效**，只有 `themeVariables.darkMode` 算数 | 放错层会静默地在深色背景上渲染浅色默认值——这正是最初的 bug |
| **mermaid 拒绝 `color-mix()`**：喂给它浏览器解析出的 `color(srgb …)` 会抛 `Unsupported color format` 并**丢掉整张图**，而不只是一个形状 | 颜色一律经 `normaliseColour` 规约为 `rgb()/rgba()`；需要混合时用 `mix()` 自己算，绝不下传 `color-mix` |

主题插件通过**官方 API** `theme.register({id, colorScheme, tokens})` 注册，由 `ThemePresenter` 把 token 写成 `<body>` 上的内联自定义属性（`dsh-client-ui-layout/lib/client.js:512-550`）。因此：

- **必须读 DOM，不能只看 `data-ds-dark-theme`。** 在两个深色主题之间切换时，属性不动而 `style` 变——`useDiagramTheme` 因此同时观察 `style` 与 `data-ds-dark-theme` 两个属性，并用一个 signature 挡住无关的 `<body>` 变动，避免整页图重渲染。
- **一个 token 缺席时解析为 `rgb(0, 0, 0)`**，与真正的黑色无法区分，所以 `readTokenColour` 先单独测存在性。这是本项目最容易踩的坑。

映射中有两处是**派生值**而非直接取 token，两处都来自实测出来的真实缺陷（见 `test/diagram-theme.test.js`）：

| 变量 | 曾经的取法 | 实测到的后果 | 现在的取法 |
|---|---|---|---|
| `quadrant1..4Fill` | `raised`/`overlay`/`accentTint`/`surface` | 深色 Mocha 下 `--dsw-alias-bg-layer-3` 与 `--dsw-alias-bg-overlay` **同值**，象限 1 与 2 对比度 **1.00**——图照样渲染，但象限图唯一要表达的东西没了 | 由 `surface` 向 `text` 按 `QUADRANT_WEIGHTS` 混合四档。表面与文字色既然足以读出文字，就足以分出四档 |
| `pieSectionTextColor` | `text` | `pieSectionTextColor` 是**一个**颜色却要盖在深浅不一的切片上：深色 Mocha 下板块自身文字色只有 **1.03–1.95**，百分号近乎看不见；浅色 Latte 下最好的主题色只有 **2.37**，而消色差极值可达 **6.23**（仅 38%） | 取「最差切片上的对比度」最高的候选：先是主题自己的中性极值，再是黑/白。阈值 `THEME_INK_MINIMUM = 3`（大字号 AA）——若按正文 4.5 要求，深色 Mocha 会为了 3.83→4.29 的 12% 收益丢掉用户整个配色 |

切片以 mermaid 默认的 `pieOpacity: 0.7` 绘制（是 CSS `opacity`，不是 `fill-opacity`），所以对比度必须对着**合成后**的颜色算，而不是 token 值。

`pie1..8` 与 `git0..7` 取自 `--shiki-token-*`，并且**去重**：Catppuccin Mocha 的九个名字只落到**六个**不同颜色（`string` = `string-expression`、`function` = `link`、`comment` = `punctuation`），保留重复会让两块饼同色。主题完全不定义 `--shiki-token-*` 时退到 `--dsw-static-*` 色阶。

**验证方式**：headless Edge 里加载真实的 `src/client.js`（走 stub module loader），把 catppuccin 真实注册的 201 个 token 按 `ThemePresenter` 的方式装到 `<body>` 上，渲染五种图，再用 `getComputedStyle` 量出来。**测量本身有三个坑，都踩过**：脱离文档的 SVG 所有计算样式都是 `''`（读成「无填充」而不是报错）；mermaid 把可见文字放在 `<tspan>` 里（`text.actor>tspan{fill:…}`）而父 `<text>` 带的是方框底色，量父节点等于量错对象；`<svg>` 自己没有背景，`getComputedStyle(svg).backgroundColor` 是透明并会被解析成黑色。证据图：`docs/assets/diagram-theme.png`。

### 4.7 画布上的选择：一次拖拽的两种含义（2026-10-04）

用户提出「现在只能框到组件而无法选中文字」，希望能**选中文字以更精确地传给 Agent**，并支持 `Ctrl+C`。用户选定的手势是**按起点分派**：

| 起点 | 含义 |
|---|---|
| 渲染出的文字（行盒之内） | 浏览器自己的文字选择。不画框、不抑制、不 `preventDefault`；`Ctrl+C` 直接可用；**同时**把所触及的块自动选上（可跨块） |
| 卡片标签（`sb-cardHead` / `sb-groupHead`） | 框选（这些是 `user-select:none` 的装饰，不可能是想选文字） |
| 其余（图片、图的边框、卡片内边距、卡片之间的空隙、空白画布） | 框选 |

**为什么原来的实现「一个字都选不中」**：`.sb-picking` 带着 `user-select:none`，而它在**每一次** `pointerdown` 就加上——于是任何拖动都变成框选。这条规则必须保留（否则画框会把看板自己的正文一起选上），但它只能加在**确实要画框**的那次拖拽上。

**判定「起点是不是文字」是本功能的全部难点，而显然的判法是错的两次**（`src/client.js` 的 `originAt`）：

1. **`caretRangeFromPoint` 永远吸附到最近的可编辑文字**。实测：段落只有一行的卡片，在它**底边内侧 3px**、左内侧、以及一行**末端之后**取点，报告的都还是那一段的真实文本节点。
2. **caret 所在的节点并不是被点中的东西**。在段落左侧 4px 取点，返回的是该段落自己的文本节点。

所以判据必须是「这个点是否落在该文字的**已渲染行盒**之内」，而不是「附近有没有文字」。行盒来自对该文本节点宿主元素建立的 `Range.getClientRects()`——那是浏览器**真正排版出来的**结果，不猜字体度量，而且换行的段落会给出**每行一个 rect**，于是两行之间的行距**正确地算作空白**。三处 1px 余量用来吸收行末的次像素舍入。

**为什么在拖拽中途加抑制类会毁掉选择**（实测，也是 `originAt` 只在 `pointerdown` 求值一次的原因）：对**已有选区**的元素施加 `user-select:none`，浏览器会当场清空该选区——`before: "Prose a human wou"` → `after: ""`。因此这个类只在 `pointerdown` 加、只在 `pointerup` 撤，绝不在拖动过程中加。

**文字选择如何自动选上块**：`document.addEventListener('selectionchange')` 把浏览器的选区镜像进选择状态（`textSelectionBlocks` 用 `Range.intersectsNode`，这正是「跨块」的语义）。实测一次跨两张卡片的拖拽触发 **6 次** `selectionchange`，所以托盘实时跟随高亮，而不是等松手才出现。

两个必须显式处理的异步问题：

- **矩形拖拽期间要忽略 `selectionchange`。** `sb-picking` 阻止的是浏览器**画出**选区，事件仍会带着折叠区间触发；不忽略的话它们会把矩形正要建立的选区清掉。
- **我们自己 `removeAllRanges()` 引发的那一次事件要吞掉。** 它在 `pointerup` 返回**之后**才送达，那时 `marqueeRef` 已经复位，而折叠选区与「一次应清空选区的点击」形状完全一样——于是矩形刚算出的结果会在下一 tick 被自己的回声抹掉。只在确实有待清除的选区时才置标志，避免空调用把标志留下、吃掉之后一次真实事件。

**卡片标签改为 `user-select:none`**（`.sb-cardHead,.sb-groupHead`）有两个作用：复制出来的文字不再被块地址污染（否则跨块选区会带上第二张卡片的 slug），而且标签本身成为框选的落点——在一块满是正文的看板上，这大幅扩展了矩形的可用起手区域。

**载荷**：`textSelectionText()` 规整出的字符原文以**独立字段** `payload.text` 随块列表一起送出，托盘摘要里以 `>` 逐行引用（避免多行选区被误读成载荷自身的结构）。**不折进某一块的 text 里**——Agent 必须能区分「用户指的是这一句」和「这一整块就是答案」。选中文字后，托盘显示的是**字数**而不是块数（`选中 N 字 · M 个块`），因为那才是用户拖过的单位。

> 一个顺带修掉的真 bug：`textSelectionText` 起初只检查 `toString()` 的返回值是不是字符串，但**普通对象继承的 `Object.prototype.toString` 返回的是货真价实的字符串 `"[object Object]"`**，会被当成一次幻影选区送进载荷。改为按接口判断（`typeof selection.rangeCount === 'number'`）。

**验证方式**：headless Edge 加载**真实的** `src/client.js`（stub module loader 取真实 `BOARD_CSS` 与真实 `Block`/`originAt`），用 CDP 派发**真实鼠标事件**，量回来的是：五种起点各自的分类、跨两块拖拽后的原文与块命中、`Ctrl+C` 实际拿到的内容、以及抑制类在拖动中途确实清空选区的反例。纯函数部分（分类器的三种结果、行盒判据、选区规整、载荷格式）由 `test/client.test.js` 覆盖，四处关键判据各做了变异测试。真实拖拽的 `Ctrl+C` 结果实测为两段正文的拼接，与选区原文一致。


---

## 5. 上下文预算

### 5.1 常驻大纲的确切文本格式

通过 `ctx.systemPrompt.context()` 注册（每步重算，F10），函数式 `text` 读 `context.agent?.session` 取该 session 的 `board` 投影。**没有看板（从未调用过 `board_apply`）时返回 `''`**——空串会被过滤掉（F10），零成本。

下面是**真实样例文本**（不是伪代码），内容与标点即为要在提示词里出现的形态：

```
[board] 支付重构评审 · r19-77c1e0ba9d34 · 3 pages / 14 blocks / 9 edges

P 架构总览 (5)
  h   现状                     "目前支付链路串行调用三家渠道…"
  c   渠道适配器               ts · 142 lines · "retry 只覆盖了超时"
  l   风险-1                   3 items · "回调幂等缺失" / "对账延迟" / …
  u   seq-支付时序             mermaid sequence · 12 lines
  g   遗留问题                 2 children

P 依赖分析 (6)
  h   依赖总览
  t   upstream-latency         "上游 P99 直接影响下单成功率"
  …

P 部署拓扑 (3) · region 拓扑区

E  (9)
  渠道适配器 -[depends]-> 回调幂等       "适配器假设回调会重试"
  遗留问题   -[contains]-> 对账延迟
  风险-1     -[causes]->   upstream-latency
  …

D  ⚠ 1 render failure
  seq-支付时序 (uml/mermaid): PARSE at line 7 col 3 — "No diagram type detected"
```

格式规则（实现必须逐条遵守，因为模型的解析习惯建立在稳定性上）：

1. 第 1 行固定 `[board] <title> · <rev> · <n> pages / <n> blocks / <n> edges`。`·` 是 U+00B7。
2. 页行以 `P ` 开头，`<slug> (<block count>)`，若挂了非默认模板追加 `· <template>`，若有 region 追加 `· region <slug>`。
3. 块行缩进 2 空格，以**类型字母**开头：`h` heading / `p` prose / `l` list / `c` code / `u` uml / `i` image / `f` pdf-page / `g` group。字母后接空格 + `slug`，再用空格对齐后接预览。
4. 预览统一加**中文引号 `"…"`**（U+201C/U+201D），这样模型能一眼区分「这是 slug」与「这是正文」。预览截断到 40 个码位。
5. 边区块以 `E  (<n>)` 开头，每条 `  <from> -[<rel>]-> <to>`，有 label 时追加 `  "<label>"`。没有 `rel` 时写 `-[ ]->`。
6. 诊断区块以 `D  ⚠ <n> render failure(s)` 开头，**只在非空时出现**，逐条 `<block slug> (<kind>/<engine>): <CODE> at line L col C — "<message>"`。
7. `dangling` 边在边区块里前缀 `!`：`  ! 风险-1 -[causes]-> (deleted)`。
8. 区块之间用**一个空行**分隔。区块顺序固定：页 → 边 → 诊断。
9. **没有任何视图状态**（不写缩放、不写当前页、不写用户选了什么）。用户看哪一页是用户的事。

### 5.2 规模估算与失控点

按上面格式实测的字符成本（含换行与缩进）：

| 元素 | 字符数 |
|---|---|
| 头部行 | ~60 |
| 页行 | `P <slug> (n)` ≈ 14 + slug 长度 |
| 块行 | 2 + 1 + 1 + slug + 对齐 + 2 + ≤40 + 2 ≈ **55–70** |
| 边行 | 2 + from + 7 + label + to + label ≈ **35–60** |
| 诊断行 | ~70 |

典型单块成本取 **60 字符**，单边取 **48 字符**。

| 规模 | 估算字符 | 约合 token（中英混合） | 判定 |
|---|---|---|---|
| 3 页 / 14 块 / 9 边（样例） | ~1,100 | ~500–700 | 舒适 |
| 5 页 / 40 块 / 30 边 | ~3,600 | ~1,800–2,400 | **可接受上限** |
| 8 页 / 80 块 / 80 边 | ~8,300 | ~4,000–5,500 | **开始失控** |
| 15 页 / 200 块 / 250 边 | ~22,000 | ~11,000–15,000 | **不可接受** |

**失控点：** 块数与边数都是线性项，没有对数项。真正先炸的是**边**——因为每条边要重复两个 slug（可能是 10 个中文字符），一条边 50 字符里 40 字符是地址而不是信息。其次是**长 slug**：`风险-1` 好，`这个块讨论了上游延迟对下单成功率的影响` 是 20 字符 × 每次出现。

因此预算控制有两条**免费**杠杆（v1 必须做）：

1. **slug 截断到 24 码位**（board-model.md §1.7 已定），且 `mkSlug` 优先取短的源（`heading.text` 前 24 字，而不是 `prose` 首行）。
2. **边的显示用 slug 短名**：若两个 slug 都在同一页，可省页前缀（v1 不启用，留作杠杆）。

### 5.3 超预算时的降级策略

预算：**常驻大纲硬上限 4,000 字符**（约 2,000–2,500 token）。超限时按下列顺序逐级降级，每级都**在文本里显式声明降了级**（模型必须知道信息不全）：

| 级 | 内容 | 触发后文本变化 |
|---|---|---|
| **L0** | 全量（§5.1） | — |
| **L1** | 块行只保留 `h`/`u`/`f`/`i`（标题与媒体），`p`/`l`/`c`/`g` 折叠为页行的计数 | 页行变 `P 架构总览 (5: 3 text, 1 code, 1 group)`；追加 `(outline level 1: non-heading blocks omitted; call board_outline for the full list)` |
| **L2** | 边只保留 `dangling` 与 `rel ∈ {depends, causes}` 的边，其余折叠为计数 | 边区块变 `E  (9; showing 3: dangling + depends/causes)` |
| **L3** | 只保留页行（页名 + 计数 + 模板），块与边全部折叠 | 追加 `(outline level 3: pages only; call board_outline{page:'…'} for content)` |
| **L4** | 只保留「有内容的页」的前 N 页（N=5），其余折叠为 `… 7 more pages` | 追加被省略的页名列表 |
| **L5** | 只输出头部行 + 一行提示 | `[board] 支付重构评审 · r19-77c1e0ba9d34 · 15 pages; outline suppressed (too large) — call board_outline` |

**触发点**：每次重算时按当前文档结构**直接计算**（不需要先渲染再测量），用 §5.2 的成本模型估算，从 L0 起逐级降到 ≤ 4,000 字符。

**降级必须保持的性质（三条）：**

1. **头部行永不省略**，且必须包含 `rev`。否则模型失去唯一可靠的 `expected_revision` 来源，`board_apply` 会开始失败。
2. **`D` 区块永不省略。** 渲染失败比内容缺失更急——一个坏掉的图 Agent 不修，用户看到的就是坏图。诊断区块预算独立（上限 600 字符，超出时只保留前 5 条 + `… N more`）。
3. **降级声明必须在文本内**，不能只是某种内部状态。模型对「我以为我看全了」毫无自觉。

**为什么不改用分段注入或按需注入全部：** 常驻大纲的**全部价值**在于「模型不需要想起去看」。一旦常驻部分小到无法回答「有哪些页」，模型每轮都要先 `board_outline`，那就退化成纯拉取，白白多一次往返。L0–L2 覆盖到约 60 块 / 50 边，这是单次评审对话的现实规模上限；L3 以上是「这个看板太大了，Agent 应该分页」的信号，而它会在文本里看到这句话。

### 5.4 还有一块常驻预算：工具 schema

上面算的只是大纲。**常驻的还有工具定义本身**——`board_apply` 的编译后 JSON Schema 有 14 个 `oneOf` 分支、约 70 个属性，序列化后是**全项目最大的一段每请求文本**（数量级在 4,000–6,000 字符，即 ~2,000–3,000 token），而它每一步都在请求头里。三点结论：

1. **这份预算比大纲更硬**：大纲可以降级，工具 schema 不能——它是模型**正确构造调用**的唯一依据。所以大纲的 4,000 字符上限必须为它让路，不能把总预算算成大綱可无限膨胀。
2. **`description` 要省着写。** 每个属性的 `description` 都会进 schema。规则：**参数级 `description` 只写「取值域与格式」，把「什么时候用、为什么」写在工具级 `description` 里**（后者每个工具一份，前者每个属性一份）。[`board-tools.md`](./board-tools.md) §3.2 的属性描述已经是这个标准的示范——例如 `expected_revision` 的属性描述只说明它是什么，而「必须从最近结果复制」这条纪律写在工具描述里。
3. **一个待验证的优化**：DSH 有 `deferLoading` 选项（`defineTool` 的 `options.deferLoading === true`，`dsh-tools` L869）。若它能让 `board_apply` 只在需要时进入请求头，就能省下这 2–3k token。**UNVERIFIED**——我没有读到 `deferLoading` 的消费方语义（见 §8.2 A7）。在验证之前，`board_apply` 按常驻计算预算。

---

## 6. 客户端与镜像（非 v1 重点，但接口已定）

### 6.1 客户端如何读（V）

`conversation.view` 的 board tab 是 session 作用域的 slot，组件拿到标准套件里的 `useProjection(key)`（F9），直接订阅 `board` 键的 wire 值。**不需要 `host.call` 往返来读状态**；`host.call` 只用于写（若未来允许，但 Q-A 已定只有 Agent 写，所以 v1 里 board tab 是**纯读**）。

视图片（平移/缩放/选中）住在 React 状态或一个客户端本地 store 里，**不上行到 host**。这带来一个必须接受的后果：切走 tab 会 unmount（`design-tree.md` Q1 已记录），视图片丢失，回来时回到默认视口。Q4 的存储模型本来就要求「所有状态活在 React 之外」，但视图片是唯一例外，理由充分：它不是真相。

### 6.2 `.dsh-superboard/` 只读镜像

- 位置：`<session.header.cwd>/.dsh-superboard/`（F14：`cwd` 是绝对路径，可直接用）。
- 触发：host 侧订阅 `sessionProjections.onChanged`（F7 的变更馈送），或订阅 `session/event` 后读投影；变化时节流 500ms 落盘。
- 内容：每页一个 `page-<slug>.md`（用 §5.1 的块预览格式 + 全文），加一个 `board.json`（完整 `BoardModel`），加一个 `OUTLINE.md`（§5.1 文本）。
- 目的：**git diff**。它明确是派生数据，可以被删、可以被重建，不作为任何真相。
- 与 DSH 规则的关系：这是文件系统写入，不是 session 事件，不触碰 F13 的红线。

**UNVERIFIED：** `.dsh-superboard/` 是否应写进 session 的 `cwd`（可能是项目根，污染项目）还是写到某个插件自己的目录再由用户软链。**建议 v1 先写 `cwd`，并在 `.gitignore` 提示里说明**；若用户反对，改到 `~/.dsh/superboard/<sessionId>/` 是一行改动。

---

## 7. 与已定决策的逐条对应

> 右列的 § 号沿用拆分前的编号：`§1`/`§2` 在 [`board-model.md`](./board-model.md)，`§3` 在
> [`board-tools.md`](./board-tools.md)，`§4`–`§8` 在本文件。

| 决策 | 本设计如何满足 | 位置 |
|---|---|---|
| Q1 `conversation.view` 第三 tab | board tab 用 `useProjection('board')` 读，与 host 唯一耦合是投影键 | §6.1 |
| Q2 自建 DOM/SVG | 场景模型与渲染器分离：`BoardModel` 无任何像素字段；坐标是派生数据 | §1.1, §4.3 |
| Q3 块流优先 | `Page.blocks` 是有序数组，`region` 是标注，`group` 是排版容器 | §1.2–1.6 |
| Q4 log 原生 | 折叠入口 = `tool/call` + `tool/result` 配对 | §2.7 |
| Q-A 只有 Agent 写 | 唯一的写 op 集在 `board_apply`；客户端纯读；用户手势在**看板本地的反馈托盘**里成形，从不替用户发送 | §3.2.3, §6.1 |
| Q-B v1 范围 | UML 有类型无渲染；`diag` 通道今天就存在但恒空 | §1.8, §1.1 |
| Q-C 多页 | `Page` 是一等对象，`add_page/rename_page/reorder_pages/delete_page` | §1.2, §2.2 |
| Q-D 常驻大纲 + 拉取 | `systemPrompt.context()` 注入 §5.1 文本；细节走 `board_read` | §5.1 |
| Q-E 模板优先 | 6 个模板（`flow`/`row`/`columns`/`grid`/`masonry`/`canvas`）；坐标已从块上删除，自由摆放只属于空间性组件 | §4.1, §4.4 |
| Q-F 有向语义边 | `Edge{from,to,rel?,label?}`，方向即语义，`board_query` 按方向查 | §1.5, §3.2.4 |
| Q-G slug 主地址 | 三层地址 + `uniqSlug` 含 alias + 边锚 id | §1.7 |
| Q-H 结构化文本反馈 | 选区 → 看板本地托盘里可逐条撤销的条目（原文 + 块/边关系），不返回位图；`board_feedback` **从未实现** | §6.1, §3.2.5 |

---

## 8. 风险与未决

> **结局（2026-10-05 整理，实现已落地）**：R1、R6 与 A2/A3/A4/A5、V1/V2/V4/V5 已解决；A6 对路径 1 **被证伪**（`arguments` 是字符串）；A1、V3、V6 作废（实现始终带 `wire`；`board_feedback` 从未实现）；R7 部分解决；其余仍开放。下面每条保留原文，只追加一行「结局」。

### 8.1 我认为最可能错的地方

**R1 —— 折叠入口依赖「`tool/call` 一定落盘且一定先于 `tool/result`」。**
这是整个设计的地基。`tool/call` 与 `tool/result` 的产生位置我读到了（`dsh-agent-loop` L681-707），但**没有读到**「参数校验失败时是否仍写 `tool/call`」、「PTC / `run_code` 路径下的调用是否被表示成 `tool/call`」这两点。若后者不成立，看板在 PTC 模式下会静默不动。**这是最高优先级的验证项。**
→ 验证：§8.3 V1。

**已解决（`03fab27`）**：`tool/call` 与 `tool/result` 在两条派发路径上都落盘，call 先于 result 是结构性的（`tool/result` 用 `sourceEventSeqs` 引用 call）；PTC 路径用 `tool/ptc-dispatch-start` / `tool/ptc-dispatch`，折叠已按两种事件对处理（`ceffabe`）。细节见 [`board-model.md`](./board-model.md) §2.7 与 [`../research/dsh-plugin-contract.md`](../research/dsh-plugin-contract.md) §10。

**R2 —— 投影状态里塞 `pending` 映射是一个「够用但不对」的设计。**
把「未决调用」放进投影状态，意味着投影状态包含了**非模型信息**（虽然不进 `revHash`）。更干净的做法是让投影在 `tool/result` 上重扫最近 N 条日志找配对调用，但那违反「`apply` 纯同步、不得回读会话」的纪律（F7 的 `apply(state, event)` 签名里没有 session）。**当前方案是纪律允许范围内的最优解**，但它是本设计里最不优雅的一处，评审时值得单独讨论。
→ 缓解：`pending` 上限 64 条 + `turn/end` 清空；并在 `stateSchema` 里显式声明它。

**结局：仍开放**——实现保留了 `pending`（纪律不允许在 `apply` 里回读日志），这仍是本设计最不优雅的一处。

**R3 —— slug 作为地址的长期可用性。**
中文 slug 在 transcript 里可读性极好，但它承担了「地址 + 显示 + git 文件名」三重职责。一旦用户把块标题改成一句长话，slug 变长，大纲预算立刻恶化（§5.2）。**风险不在正确性，在预算。**
→ 缓解：24 码位截断；`board_apply` 允许显式给短 slug；未来可引入「显示名 ≠ slug」的第二个字段（现在不加，因为两个名字会让模型必然混用）。

**结局：仍开放**（预算风险，未变）。

**R4 —— `expected_revision` 必填会不会造成大量无效失败。**
如果模型经常忘记带上正确的 rev（例如它读了大纲但中途又调了别的工具），必填就变成摩擦源。我判断不会——因为**每个工具结果都回带 rev**，模型手边总有最新值。但这是判断，不是证据。
→ 缓解：错误文本第一句就是「调 `board_outline` 拿新 rev」，一次往返即可恢复；v1 上线后统计失败率，必要时改为「缺省 = 不校验 + warning」。

**结局：仍开放**；但真实的失败来自别处——见 §2.6.1 的 I2 事故（`6910f21`）：`expected_revision` 曾整串比较哈希，重折时吃掉十个批次。

**R5 —— 「一个块最多属于一个 region」可能太紧。**
真实评审里，「这个块既是风险又是待办」很常见。强制单一归属会逼 Agent 建两个语义重叠的 region。
→ 缓解：v1 保持单一归属（多重归属会让 region 的背景框渲染与跨页布局都变复杂），**若出现需求，正确的扩展是给 region 挂标签而不是允许块属于多个 region**。

**结局：仍开放**（v1 保持单一归属，未变）。

**R6 —— `UmlBlock.engine` 的取值可能选错。**
`design-tree.md` 记录的推荐是 Mermaid（进程内解析、结构化错误）。但 Mermaid 是**客户端**库，而 S7 禁止 iframe；在宿主文档里跑 Mermaid 意味着把它的运行时打进 client bundle，体积与 token 主题适配都是未知数。
→ 原文：**UNVERIFIED**，且在 v1 之外。现在定型 `engine: 'mermaid' | 'plantuml'` 只是保留字段；若最终选了别的渲染路线（例如自研极简 flowchart），`engine` 多一个取值即可，模型不变。

**已解决（`ad4b943` + `6e175e5`）**：mermaid 以**包内 chunk 或宿主路由**加载可行（contract §11）；实现选了宿主路由 + `vendor/mermaid.min.js`（3,572,661 B，随仓库提交，无构建步骤），`uml` 块现在真的会画，失败会回到 `board_outline`/`board_read` 的 diag。`engine` 仍只有 `mermaid`（`plantuml` 预留）。

**R7 —— 大纲的「稳定格式」可能不够稳定。**
§5.1 的格式是我设计的，模型会据此形成解析习惯。若实现时为了省字符改了分隔符，模型不一定报错，可能只是悄悄误解。**格式必须当成对外契约冻结**，但注意它**不进 `stateVersion`**（它只在提示词里，不在投影状态里，board-model.md §2.7.2），所以没有任何机制会自动拦住这种改动——只能靠纪律。

**部分解决**：格式冻结在 `renderOutlineText`（`src/tools.js:332`），`test/tools.test.js:554-588` 覆盖了它的边界（空看板得空串、被拒批次的提示行、`maxChars` 截断、空结果提示）——但还不是逐字符黄金样例。
→ 建议：把 §5.1 的格式规则写成一份**黄金样例测试**（golden test），实现改动若不能让样例逐字符相等就必须先改样例并说明理由。

### 8.2 需要先验证才能动工的断言

| # | 断言 | 为什么要紧 | 若为假的后果 | 结局 |
|---|---|---|---|---|
| A1 | `ctx.sessionProjections.register` 允许省略 `wire` | 若 `wire` 必填，看板必须额外维护一个只给客户端看的视图模型 | 工作量增加，但不致命 | **作废**：实现始终注册 `wire`（`src/index.js:109`） |
| A2 | `stateSchema` 用 zod（F8 已强证据），且**只用最简形状**（对象/数组/字符串/数字/null 联合） | 复杂 zod schema 的 `.parse` 在热路径上对每个事件调用 | 折叠变慢 | **已解决**（`ceffabe`）：`stateSchema` 是 zod，checkpoint 经它解析 |
| A3 | `ctx.systemPrompt.context()` 的 `text` 函数里能同步读到该 session 的投影 | 常驻大纲的实现基础（F10 只证明了能拿到 `session`） | 大纲只能退化为在 `board_apply` 后 `agent.inject()` 推送，模型可能用过期的 | **已解决**（`ad4b943` contract §13）：大纲由 `ctx.systemPrompt.context()` 注入，`text` 里同步读投影 |
| A4 | `exec.agent` 在 `board_apply` 里一定存在（非 agentless 调用） | 无 agent 时我们既不能确认 session 也无法报错 | 需要一个显式的 `throw`，行为已定义 | **已解决**：`exec.agent.session.id` 已在用（`src/tools.js:1423`、`:1437`、`:1450`），代码仍用 `?.` 兜底 |
| A5 | 客户端 `useProjection('board')` 对第三方插件注册的键可用 | board tab 的读路径 | 需要退化为 `host.call` 拉取 + 轮询 | **已解决**（`4da00e8`）：board tab 用 `useProjection('board')` 零 RPC 读 |
| A6 | `tool/call` 的 `data.arguments` 在 log 里是**完整 JSON 对象**（不是字符串、不是 delta） | 折叠的唯一输入 | 需要自己累积 delta，不可能做到纯同步 | **对路径 1 被证伪**（`03fab27`）：普通 `tool/call` 存的是模型原文**字符串**，PTC 子派发才是对象；折叠按工具名接受两种形状 |
| A7 | `defineTool` 的 `deferLoading` 能否让 `board_apply` 的 schema 不常驻请求头 | 省 2–3k token/步 | 保持常驻，预算按 §5.4 计算 | **仍开放**：未验证，预算按常驻计（见 §5.4） |

### 8.3 验证清单（按优先级，动工前跑）

- **V1（阻塞性）** 手工 session 里调一次合法与一次非法的 `board_apply`，导出 session log，确认：`tool/call` 存在且 `data.arguments` 是对象；`tool/result` 配对且 `isError` 正确；顺序为 call→result；**非法参数时 `tool/call` 是否仍然落盘**。 **结局：已解决（`03fab27`）**——两条路径都验证过，非法参数时 `tool/call` 同样落盘，且 `arguments` 的形状按路径不同。
- **V2** 在 PTC / `run_code` 模式下重复 V1。（`tool/ptc-dispatch` 事件类型的存在说明这条路可能不同。） **结局：已解决（`03fab27`）**——PTC 派发记录为 `tool/ptc-dispatch-start`/`tool/ptc-dispatch`，`arguments` 已是对象，折叠已处理。
- **V3** 注册一个 `wire` 缺省的投影，确认不报错。 **结局：作废（`ceffabe`）**——注册时始终提供 `wire`（`src/index.js:109`），「缺省 wire 是否合法」不再是问题。
- **V4** 在某个 `conversation.view` tab 组件里调 `useProjection('board')`，确认能拿到 host 推送的值，且切换 tab 再回来仍然有效。 **结局：已解决（`4da00e8`）**——board tab 用 `useProjection('board')` 读同一套 wire，且组件无权威、unmount 后可自重建。
- **V5** 在 `ctx.systemPrompt.context()` 的 `text` 函数里调 `ctx.sessionProjections.stateOf(session, 'board')`，确认同步可用、返回非 `undefined`，且拿到的是一致切面。 **结局：已解决（`ad4b943`）**——`safeStateOf` 在提示词回调里同步取投影（`src/index.js:160`、`:196-198`）。
- **V6** 确认 `feedback/record` 与 `feedback/message-put` 两个既有事件类型的语义（`board_feedback` 的载荷落点，Q7 的输入）。 **结局：作废（`5da72d2`）**——`board_feedback` 从未实现；反馈落在看板本地的反馈托盘里，不经过 composer，也不经过这两个事件。
