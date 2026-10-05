# 看板数据模型 — 设计契约

**状态：** **已实现并投入使用**，所以这份文件是**活文档**——它记录契约，代码照着它写。「待评审」是它出生时的状态，那版在 git 历史里。

**目标运行时：** DSH Desktop `0.2.0-rc.2`
**上游文档：** [`design-tree.md`](./design-tree.md)（已定决策 Q1–Q-H）、[`../research/dsh-plugin-contract.md`](../research/dsh-plugin-contract.md)（硬约束）、[`../research/dsh-host-plugin-api.md`](../research/dsh-host-plugin-api.md)（API 一手调研）

本文只讲模型本身：**看板的场景模型长什么样，以及它如何从 session log 折叠出来。**

> **2026-10-05 已按体裁拆分。** 本文件留下契约本体（§0–§2）与速查；Agent 工具面移到 [`board-tools.md`](./board-tools.md)，
> 排版模板、上下文预算、客户端与镜像、决策对应表、风险与未决移到 [`board-design-notes.md`](./board-design-notes.md)。
> **节的编号沿用拆分前的原始编号，没有重排**，所以三份文件之间、以及其它文档里的 `§3.2` 之类引用仍然对得上。
>
> 这里同时是**框架事实的档案**：§0 的 F1–F16 与 §2.6.1 的 I2 事故记录，是仓库里唯一写下这些的地方，
> 所以改代码前若结论与本文冲突，先确认是哪一边过时了。

**目录**（改头部时别增删行：`src/client.js:1724`、`src/client.js:2074`、`src/schema-dsl.js:44`、`src/tools.js:201`、`video/PLAN.md:123`、`video/scenes/s4-blocks.html:270` 里有指向本文件的 `file:line` 引用——`:265`、`:306-308`、`:318`、`:340`、`:507`——它们依赖 §0 从第 38 行开始。）

- **§0** 设计所依赖的 DSH 事实（全部已核）
- **§1** 场景模型 — 1.1 `BoardDoc` / 1.2 `Page` / 1.3 `Block` / 1.4 `Anchor`（块内锚点）/ 1.5 `Edge` / 1.6 `Region` / 1.7 命名与 slug / 1.8 为什么 UML 现在就要定型
- **§2** 折叠语义 — 2.1 权威状态 / 2.2 op 集合 / 2.3 确定性 / 2.4 批校验的执行位置 / 2.5 revision 算法 / 2.6 stale write / 2.6.1 I2 事故 / 2.7 投影入口
- **§3** Agent 工具面 → [`board-tools.md`](./board-tools.md)（3.1 工具清单 / 3.2 四个工具的精确契约 / 3.3 如何系统性降低笔误）
- **§4** 排版模板 → [`board-design-notes.md`](./board-design-notes.md)（4.5 是模板表与实现之间的已知偏差）
- **§5** 上下文预算（大纲格式、降级阶梯、schema 常驻成本）→ 同上
- **§6** 客户端与镜像（渲染、`.dsh-superboard/` 只读镜像）→ 同上
- **§7** 与已定决策的逐条对应（Q1–Q-H）→ 同上
- **§8** 风险与未决（最可能错的地方、动工前要验的断言）→ 同上
- **§附** 一页速查

标记约定：

- **V** = 本次从 `app.asar` 实际读到的代码或已有调研文档中的一手结论，行内给出证据。
- **UNVERIFIED** = 我没有读到一手证据，必须在动工前先验证。
- 所有 TypeScript 定义是**给实现者抄的契约**，不是实现。

---

## 0. 设计所依赖的 DSH 事实（全部已核）

| # | 事实 | 证据 |
|---|---|---|
| **F1** | `defineTool({ name, description, parameters, output: {schema, render}, execute })`；`parameters` 是**裸属性表**（无顶层 `type:"object"`，`required: true` 写在每个属性上，DSH 上提为 JSON-Schema 的 `required` 数组） | `dsh-tools/lib/index.js` L802-811 `parameterSchemaSpecToJsonSchema` + `compilePropertyMap`；L601-616 逐属性收集 required |
| **F2** | 作者类型词汇：`string/number/integer/boolean/null/array/object/json` + `oneOf`；注解键仅 `description/title/default/examples`；`required` **只在属性位置合法**，值节点（数组 `items`、`oneOf` 分支）不接受 | 同上 L537-542 `ANNOTATION_KEYS`，L655 `authorKeys`，L751 default 分支 |
| **F3** | `type:"object"` 必须显式写 `additionalProperties: boolean`，否则编译期报错 | 同上 L699 |
| **F4** | `output.schema` 走 `valueSchemaSpecToJsonSchema`（**值根**，`type` 在根上）；返回值经 `validateJsonSchemaValue` 校验后 `deepFreeze`，再调 `output.render(args, value)` 产出模型可见块 | 同上 L792-796、L971-982 `createSuccessResult` |
| **F5** | 工具让模型看到错误的唯一路径是 `execute` 里 `throw`；结果为 `{content:[{type:'text',text:'Error: …'}], isError:true}` | 同上 L3616-3630 `toolErrorResult` |
| **F6** | session log 中，一次工具调用产生**两个**已提交事件：`tool/call`（`data = {turn, step, callId, name, arguments}`）与 `tool/result`（`data = {turn, step, message:{role:'tool', toolCallId, content, isError}, error?, meta?}`，`sourceEventSeqs:[callSeq]`） | `dsh-agent-loop/lib/index.js` L681-707；`dsh-llm/lib/index.js` L101-112 `createToolResultMessage` |
| **F7** | `ctx.sessionProjections.register({key, stateSchema, init, apply, wire?, stateVersion})`；`apply(state, event)` 对**每个已提交事件**被调用；注册是 effect（随 fiber 释放）；`stateVersion` 必须是安全非负整数 | `dsh-session-projection/lib/index.js` L68-103、L81；L401-428 `drive`；L389-399 `advanceCell` |
| **F8** | 投影的 `stateSchema`/`wire.viewSchema` 是 **zod schema**（被 `.parse()` 调用），与工具参数的裸属性表是两套东西 | `dsh-tool-todo/lib/index.js` L1、L64、L71（`zod v4`）；`dsh-session-projection` README L91 |
| **F9** | 只注册 `wire` 的投影会**推送**到客户端；客户端 session 组件可用 `useProjection(key)` 订阅该键的 wire 值 | `dsh-api-session-controller/lib/client.js` L2810 `apply(frame.key, frame.value, frame.seq)`、L2549-2580 基线拉取；`dsh-client-ui-session/lib/client.js` L121-130 `keyedHooks: ["projection"]` |
| **F10** | 上下文注入两条正路：`ctx.systemPrompt.section()`（提示词前缀）与 `ctx.systemPrompt.context()`（**每步重算**的 runtime 快照，函数式 `text` 可读 `context.agent?.session`，空串被过滤掉） | `dsh-system-prompt/lib/index.js` L240-269、L338-354、L104-136；真实用法 `dsh-sandbox-policy/lib/index.js` L114-130 |
| **F11** | `agent.inject(message)` → `send(input, "next-step", false)`：进入 inbox 但**不唤醒 driver** | `dsh-agent-loop/lib/index.js` L800-814 |
| **F12** | `ctx.storageDomain.open(spec)`，`defineDomain({name, version, layout:'per-record', tables})`；官方 `session_projcache` 就是一 session 一记录 | `dsh-session-projection-cache/lib/index.js` L66-102、L152-161；`dsh-storage-domain/lib/index.js` L61-76 |
| **F13** | 不能追加自定义 session 事件类型；可追加的是**既有**已文档化类型 | `dsh-session/lib/index.js` L79-139 已知类型集 + `ignorable` 规则 |
| **F14** | `exec.agent.session.append(type, data)` 返回**已提交事件**（含 `seq`）；`session.header.cwd` 是绝对路径；`session.inheritedEventCount` 标记 fork 继承前缀长度 | 同上 L1441-1481；L1044-1046；L1342-1349 |
| **F15** | 工具并发：`isConcurrencySafe(args)` 返回 `true` 才允许并行，否则该工具在调度里是 `exclusive` | `dsh-tools/lib/index.js` L3059-3061 |
| **F16** | 投影服务有两个**同步**读面：`stateOf(session, key)` → 原始 state（未注册返回 `undefined`，返回值是 live 引用，调用方不得改）与 `snapshot(session, keys?)` → `{asOfSeq, values}`，每个值过 `wire.viewSchema.parse` | `dsh-session-projection/lib/index.js` L121-156 |

---

## 1. 场景模型

### 1.1 顶层：`BoardDoc`（投影状态，纯 JSON）

看板被明确切成两片，**这个切分是后面 revision、折叠、持久化三件事的共同基础**：

- **模型片 `model`** —— Agent 写的、在 log 里、参与 revision 的一切。
- **视图片 `view`** —— 用户的平移/缩放/选中/反馈草稿。**不进 log、不参与 revision、不进上下文**，只存在于客户端内存与（可选）`ctx.storageDomain`。

```ts
/** 投影的完整状态。纯 JSON，可 structuredClone。 */
interface BoardDoc {
  /** 模型版本号；投影语义变更时递增（对应 stateVersion）。 */
  modelVersion: 5        // BOARD_MODEL_VERSION（`src/model.js:40`）
  /** Agent 权威状态。 */
  model: BoardModel
  /**
   * 渲染失败登记表。派生自「模型片 + 渲染器能力」，不参与 revision。
   * v1 恒为空对象（UML/PDF 不在 v1），但字段现在就有，加渲染时无需改模型。
   */
  diag: Record<string /* blockId */, RenderDiagnostic>
}

interface RenderDiagnostic {
  blockId: string
  blockSlug: string
  pageSlug: string
  kind: BlockKind
  code: 'PARSE' | 'LIMIT' | 'MISSING_ASSET' | 'UNSUPPORTED' | 'ENGINE_ERROR'
  message: string
  /** 引擎给出的结构化位置，例如 mermaid 的 {line, column}。 */
  at?: { line: number; column: number }
  /** 该块第几次修订时首次失败（用于 outline 说「3 步前就坏了」）。 */
  firstFailedAtRev: string
}

type BlockKind = 'heading' | 'prose' | 'list' | 'code' | 'uml' | 'image' | 'pdf-page' | 'group'
```

```ts
interface BoardModel {
  /** 看板标题；也是 .dsh-superboard/ 目录名来源。 */
  title: string
  /** 页序。至少一页；不允许为空数组。 */
  pages: Page[]
  /** 跨页的语义分组容器（见 §1.6；排版含义见 board-design-notes.md §4.2）。 */
  regions: Region[]
  /** 语义边。全看板一张表，边不隶属页。 */
  edges: Edge[]
  /** 单调递增；每成功折叠一个 op 批 +1。 */
  revSeq: number
  /** 内容哈希；见 §2.5。 */
  revHash: string
  /** 便捷合并串，格式 `r<revSeq>-<revHash 前 12 位>`。 */
  rev: string
}
```

`rev` 是 `board_apply` 的 `expected_revision` 唯一接受的形式；`r17-a3f9c2b1d4e5` 这种串人可读、模型可复制、日志里好认。

### 1.2 `Page`

```ts
interface Page {
  /** 机器稳定 id，永不变。mk 前缀便于 grep。 */
  id: string                 // 'pg_7f3a1c'
  /** 人读地址；page 内唯一、跨看板唯一（页名可直接当地址用，Q-C）。 */
  slug: string               // '架构总览'
  /** 曾用 slug，重命名时入栈（§1.7）。用于让旧引用继续可解析。 */
  alias: string[]
  /** 有序列。渲染顺序 = 数组顺序，不额外维护 order 字段。 */
  blocks: Block[]
  /** 排版模板与参数（§4，见 board-design-notes.md）。缺省 = 引擎默认。 */
  layout?: LayoutSpec
  /** 创建该页的 rev，便于「这页是我刚建的吗」。 */
  createdAtRev: string
}

interface LayoutSpec {
  template: LayoutTemplate   // §4.1（board-design-notes.md）
  /** 模板参数；见 board-design-notes.md §4.1 每个模板的元数据表。 */
  params?: LayoutParams
  /** 覆盖模板自动推导的列/根/顺序。留空则由引擎推导。 */
  hints?: LayoutHints
}

type LayoutTemplate = 'flow' | 'row' | 'columns' | 'grid' | 'masonry' | 'canvas'

interface LayoutParams {
  /** columns/grid 的列数上限（窄窗口会被 board-design-notes.md §4.4 的降级覆盖）。 */
  cols?: number
  /** grid 卡片最小宽度，px。引擎按此与容器宽度算列数。 */
  minCardWidth?: number
  /** flow 的方向。v1 只允许 'down'；'right' 预留。 */
  direction?: 'down' | 'right'
  /** 卡片间距，px。 */
  gap?: number
  /** tree 的根块 id/slug。缺省 = 该页第一条 heading。 */
  root?: string
}

interface LayoutHints {
  /** 显式分组：模板把这些块的顺序当作一个 band。 */
  bands?: string[][]          // 每项是 block id/slug 列表
  /** 首条块是否作为页标题渲染（默认 true 当模板为 flow/columns）。 */
  titleBlock?: boolean
}
```

### 1.3 `Block`（discriminated union）

```ts
type Block =
  | HeadingBlock | ProseBlock | ListBlock | CodeBlock
  | UmlBlock | ImageBlock | PdfPageBlock | GroupBlock

/** 所有块的公共字段。 */
interface BlockBase {
  /** 机器稳定 id，永不变。边只锚这个（Q-G）。 */
  id: string                 // 'bl_9c02e1'
  /** 人读地址；page 内唯一（冲突加后缀，§1.7）。Agent 可用它引用。 */
  slug: string               // '风险-1'
  /** 曾用 slug。 */
  alias: string[]
  /** 块内锚点（§1.4）。空数组 = 该块没有可被箭头指向的逻辑位置。 */
  anchors: Anchor[]
  /** 归属 region（§1.6）。一个块最多属于一个 region。 */
  regionId?: string          // 'rg_2b8d'
  /** 块**没有**坐标字段：块级 `at` 已删除（`f8c13b9`），位置由容器决定—— */
  /** page.layout 或 group.layout（§4.4，见 board-design-notes.md）。Agent 从不写坐标（Q-E）。 */
  /** 该块创建时的 rev。 */
  createdAtRev: string
  /** 折叠时写入；两条 op 之间没有中间态。 */
  updatedAtRev: string
}

interface HeadingBlock extends BlockBase {
  kind: 'heading'
  level: 1 | 2 | 3
  text: string
}

interface ProseBlock extends BlockBase {
  kind: 'prose'
  /** 块级 markdown（不含标题与围栏代码；那些用专门块）。 */
  markdown: string
}

interface ListBlock extends BlockBase {
  kind: 'list'
  ordered: boolean
  items: ListItem[]
}

interface ListItem {
  /** 列表项锚点需要稳定 id，否则「箭头指向第 3 条」会随插入漂移。 */
  id: string                 // 'li_5a1f'
  text: string
  /** 缩进层级，0 起。 */
  depth: number
}

interface CodeBlock extends BlockBase {
  kind: 'code'
  /** 语言标记；仅用于高亮，不参与语义。 */
  lang: string               // 'ts' | 'json' | '' …
  code: string
  /** 文件名/来源标注。 */
  filename?: string
}

/**
 * UML 块。v1 不渲染（Q-B），但类型与存储位置现在定死：
 * 它是一个普通块，占 pages[].blocks 里的位置，锚点语义与其他块一致。
 * 未来加渲染只增加 `engine` 的合法取值与 diag 的产生者，不动模型。
 */
interface UmlBlock extends BlockBase {
  kind: 'uml'
  /** 只接受 'mermaid'；'plantuml' 预留（见 board-design-notes.md §8 风险 R6，已解决）。 */
  engine: 'mermaid' | 'plantuml'
  /** 图类型标签，仅用于大纲与诊断文案。 */
  diagram: 'flowchart' | 'sequence' | 'class' | 'state' | 'er' | 'gantt' | 'other'
  /** 引擎源码原文。解析失败的原文必须原样保留 —— 这是错误反馈回路的前提。 */
  source: string
  /** 最近一次成功渲染的源码哈希；与 source 不等即「脏」。v1 恒等于 source 的哈希。 */
  renderedHash?: string
  /** 块内锚点：节点/参与者。v1 由 Agent 显式声明（见下），未来可由解析器回填。 */
  nodeHints?: { key: string; label: string }[]
}

interface ImageBlock extends BlockBase {
  kind: 'image'
  /** 工作区相对路径或绝对路径。禁止 data: URL（会进 log）。 */
  src: string               // 'docs/assets/arch.png'
  alt: string
  caption?: string
}

interface PdfPageBlock extends BlockBase {
  kind: 'pdf-page'
  src: string               // 'docs/spec.pdf'
  /** 1 起。 */
  page: number
  /** 页内裁剪（PDF 用户空间单位）。省略 = 整页。 */
  crop?: { x: number; y: number; w: number; h: number }
  caption?: string
}

interface GroupBlock extends BlockBase {
  kind: 'group'
  /** 容器标题（可空）。 */
  title?: string
  /** 子块 id，有序。子块仍然物理存在于同一页的 blocks 数组里（见下）。 */
  children: string[]
}
```

**关键不变量（`GroupBlock`）：** 子块**不会被移出** `page.blocks`，`group.children` 只是引用列表。这样：

- 块的顺序（读序）仍然由 `page.blocks` 唯一决定，折叠逻辑没有「嵌套树」这个第二真相；
- 一个块不可能同时出现在两个 group 里（校验：任何 block id 至多在**一个** `children` 数组中出现一次）；
- 删除 group 不删子块（`delete_block` 对 group 的语义 = 解组，除非显式带 `recursive: true`）。

### 1.4 `Anchor`（指向「块内的一个逻辑位置」）

锚点是箭头两端的类型化地址。**锚点必须能表达「PDF 第 4 页左下角那块表格」和「图片上这个人头」，而不只是一张卡片。**

```ts
interface Anchor {
  /** 目标块。边只存 id，slug 只是别名（Q-G）。 */
  blockId: string
  /** 块内位置的类型化描述。'block' 表示整块，不需要 kind。 */
  at?: AnchorAt
}

type AnchorAt =
  /** 整块。等价于缺省。 */
  | { kind: 'block' }
  /** 结构化块的逻辑字段位置。 */
  | { kind: 'field'; field: 'title' | 'code' | 'caption' | 'filename' }
  /** 列表项。 */
  | { kind: 'item'; itemId: string }
  /** 代码块的行区间（1 起，闭区间）。 */
  | { kind: 'lines'; from: number; to: number }
  /** markdown 内的字符区间（含端点，UTF-16 code unit 偏移）。 */
  | { kind: 'text'; start: number; end: number; quote?: string }
  /** 容器内某个子块。 */
  | { kind: 'child'; childId: string }
  /** 引擎图里的节点；key 由 UmlBlock.nodeHints 或解析器提供。 */
  | { kind: 'node'; key: string }
  /** 位图/PDF 页内的归一化矩形，(0,0)=左上，(1,1)=右下。 */
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  /** 位图/PDF 页内的归一化点。 */
  | { kind: 'point'; x: number; y: number }
```

**为什么 PDF/图片用归一化坐标：** 页空间坐标是「相对该页/该图」的比例，与渲染 DPI、容器宽度、缩放级别全部无关。**换算的基准是实测出来的渲染框**——浏览器量出的 `<img>` 或 `<canvas>` 的实际盒子（PDF 用 crop 框）——不是模型里的任何固有尺寸。模型里**没有**固有尺寸这种东西：`naturalSize` 曾经承担这个角色，但它只能和磁盘上的文件不一致，所以已经删掉（见 §1.3）。这样：

- 同一个锚点在 4K 屏和右侧栏小窗里指向同一个物理位置；
- 模型不需要知道任何像素——Agent 只会说「第 4 页，左边那栏的表」，由一条 `rect(0.06,0.42,0.34,0.18)` 表达；
- `crop` 改变不影响归一化锚点（相对 crop 框归一化）。

**不变量：**

1. `Anchor.blockId` 必须存在于同一看板；否则该 Anchor 所属的 Edge 被标 `dangling: true`（**不删除**，见 §2.3 规则 D4）。
2. `at.kind` 必须与目标块的 `kind` 兼容：`lines` 仅 `code`；`item` 仅 `list`；`rect`/`point` 仅 `image`/`pdf-page`；`node` 仅 `uml`；`text` 仅 `prose`/`heading`；`child` 仅 `group`。
3. `text.start <= text.end`，且 `quote` 若存在，应与该区间当前内容相等——不相等意味着正文被改过，校验器把该锚点标 `staleHint`（进 diag，不改模型）。

**`rect`/`point` 的坐标从哪来：宿主解析 PDF 文本层。** Agent 看不到像素，所以一个「第 4 页左边那栏的表」的矩形它自己算不出来。`src/pdf.js` 用自带的 pdf.js 在宿主侧解析每一页，把文本框按视觉行归并，并在 `board_read` 里连同**每行的归一化矩形**一起打印出来——Agent 复制那四个数就能写 `rect`。这就是「宿主侧 PDF 解析」存在的唯一理由：**文档理解不是本插件的活，锚点与高亮才是**。因此：

- **扫描件与图片没有页内锚点，这是设计而非缺陷。** 它们没有文本层，所以没有矩形可给。`rect`/`point` 留在模型里是因为将来接上分块识别（OCR）就能启用，不需要改模型——但那是另一轮的事。
- 解析结果**不进模型**。它是宿主侧的易失存储（`PdfFacts`），和浏览器上报的渲染失败同类：投影的 `apply` 是同步的，而解析是 I/O。块上曾经声明过一个 `pageCount`，谁也写不进去，已经删除（模型版本 3 → 4）。

### 1.5 `Edge`

```ts
interface Edge {
  /** 机器稳定 id。 */
  id: string                 // 'ed_4d90aa'
  /** 人读地址；全看板唯一。 */
  slug: string               // '登录依赖会话'
  alias: string[]
  /** 方向即语义：from → to（Q-F）。 */
  from: Anchor
  to: Anchor
  /** 关系类型，受控小词表。缺省 'relates'。 */
  rel?: EdgeRel
  /** 自由文本标签，与 rel 并存（Q-F：既能当纯箭头，也能被查询）。 */
  label?: string
  /** 视觉箭型。不影响语义。 */
  style?: 'solid' | 'dashed' | 'dotted'
  /** 手工折线经过点，归一化到端点包围盒；省略 = 引擎自动布线。 */
  waypoints?: { x: number; y: number }[]
  createdAtRev: string
  updatedAtRev: string
}

/** 受控词表，但 `rel` 是可选的 —— 不强迫每一笔都进本体。 */
type EdgeRel =
  | 'depends'      // A 依赖 B
  | 'causes'       // A 导致 B
  | 'contains'     // A 包含 B（结构，非地理分组）
  | 'next'         // A 之后是 B（流程顺序）
  | 'explains'     // A 解释 B
  | 'derives'      // A 由 B 推导
  | 'contradicts'  // A 与 B 冲突（评审场景高频）
  | 'relates'      // 兜底 / 纯视觉
```

**方向即语义的实现要点：** `board_query` 的 `dependents_of(X)` 查 `edge.to` 命中 X 且 `rel ∈ {depends, derives}` 的边，返回 `edge.from`。所以「谁依赖 X」是一次索引查询，不需要模型推理。`relates` 与无标签边**不**参与方向性查询（它们是视觉边），但参与 `between(X,Y)` 与 `orphans` 检查。

### 1.6 `Region`

```ts
interface Region {
  id: string                 // 'rg_2b8d'
  slug: string               // '风险区'
  alias: string[]
  /** 语义分组：这些块属于同一簇，排版应把它们放在一起。 */
  blockIds: string[]
  /** 分组标题是否渲染。 */
  label?: string
  /** region 是标注，不是容器：它**不能**挂模板——`set_layout` 的合法 scope 只有 page 与 group。 */
  /* 原来的 `region.layout` 字段已删除（§4.4，见 board-design-notes.md）。 */
  /** 视觉边框样式提示；不影响语义。 */
  tone?: 'neutral' | 'warn' | 'danger' | 'ok'
  createdAtRev: string
}
```

### 1.7 命名、slug 生成与重命名（Q-G 的完整规则）

**三层地址，职责严格分开：**

| 层 | 字段 | 谁用 | 会变吗 | 冲突吗 |
|---|---|---|---|---|
| 机器稳定 id | `id` | 边、region、group children、所有内部引用 | **永不** | 不可能（随机 6 hex + 前缀 + 去重） |
| 人读主地址 | `slug` | Agent 的 `board_read`/`board_apply` 参数、大纲文本、`.dsh-superboard/` 文件名 | 可重命名 | 会，靠后缀消解 |
| 历史别名 | `alias[]` | 只有解析器读；用户看历史消息时仍然对得上 | 只增不减 | 不参与新分配 |

**生成算法（`mkSlug`）：**

1. 取源文本：块用 `heading.text` / `prose` 首行前 24 字 / `code.filename` 或 `lang` / `image.alt` 或文件名 / `pdf-page` 的 `<pdf 名>-p<页号>` / `group.title`。若块在 `board_add_block` 里显式给了 `slug`，用它作为源。
2. 归一化：`NFC` → trim → 内部连续空白折成 `-` → 去掉 `\/:*?"<>|` 与不可见控制符 → 截断到 24 个 Unicode 码位。
3. 校验：必须匹配 `/^[\p{L}\p{N}_-]+$/u`。中文天然通过（`\p{L}` 覆盖），拉丁字母保持原样**不做大小写折叠**（`风险-1` 与 `Risk-1` 都是合法且互不冲突的地址；折叠会制造无谓碰撞）。不通过则整体替换为 `<kind>-<n>`（`n` = 该页内该 kind 的序号，从 1 起）。
4. 空结果（例如源全是标点）落到第 3 步的兜底分支。

**查重与冲突消解（`uniqSlug(scope, base)`）：**

比较域是 **`slug` ∪ `alias`**（这一点很关键，见规则 R3）：

```
candidate = base
i = 2
while candidate ∈ (scope 内所有元素的 slug ∪ alias):
    candidate = base + '-' + i
    i += 1
return candidate
```

页名与页名的比较域是整块看板（页名是顶层地址）；块 slug 的比较域是**它所在页**（`page.blocks` 与**该页块**的 alias）；边 slug 与 region slug 的比较域是全看板。跨页同名块是允许的（`架构/风险-1` 与 `设计/风险-1` 是两个地址）。

**重命名（`rename_page` / `update_block{slug}`）：**

1. 旧 slug 压入 `alias`（去重，保留最近 8 个，更老的丢弃并在 outline 里不给）。
2. 新 slug 经 `uniqSlug` 分配（**注意 `uniqSlug` 的循环包含自己当前的 slug**，实现时需把自己先排除，否则 `a → a` 会变成 `a-2`）。
3. **箭头绝对不受影响**：`Edge.from.blockId` / `to.blockId` 存的是 id，重命名根本不碰 `edges` 数组。这是 Q-G 的核心承诺，模型层面直接成立，不需要任何补偿逻辑。

**三条必须写进实现的不变量：**

- **R1 — 解析顺序是 `id → slug → alias`。** `board_read`/`board_apply` 收到一个引用串时，先按 id 精确匹配（`/^(pg|bl|ed|rg|li)_[0-9a-f]{6}$/`），再按当前 slug，最后按 alias。三种都失败才 `throw`。
- **R2 — 解析歧义显式失败。** 若一个引用同时命中「某元素的当前 slug」与「另一元素的 alias」，以**当前 slug** 为准；若同时命中两个 alias（理论上被 `uniqSlug` 阻止，但 fork/手改日志可能造出来），**抛错并列出候选**，不猜。
- **R3 — 退役的 slug 永不被重新分配。** 这是 alias 机制能成立的前提。若允许 `风险-1` 被退役后又分配给另一个块，任何旧引用都会静默改指。实现上就是 `uniqSlug` 把 `alias` 一并纳入占用集。
- **R4 — 删除元素时，指向它的边不删。** 边改标 `dangling: true` 并由 `board_outline` 的 `⚠` 区块上报。理由：静默删边会让 Agent 丢掉「我曾经表达过这个关系」这一信息，而这是它自己写的；报错让它来修，比消失好。

### 1.8 为什么 UML 现在就要定型

`UmlBlock` 在 v1 里是**一个数据形状 + 一个 diag 通道**，没有任何渲染器。现在定型的收益：

1. `board_apply` 的 op 集合不必为它留扩展位（`add_block{kind:'uml'}` 今天就合法），未来加渲染**只增加一个消费者**，不加字段。
2. `diag` 的形状（`code`/`message`/`at`）与 `outline` 的 `⚠` 区块今天就存在且被 Agent 读到，v1 里它恒为空。加 UML 时是「同一个通道开始有内容」，不是「新增一条反馈回路」。
3. `AnchorAt.node` 与 `nodeHints` 现在就定义了「箭头从流程图的一个节点出发」的表达方式，否则未来要改锚点模型——那是破坏性变更。

---

## 2. 折叠语义

### 2.1 权威状态的定义

> **看板 = 该 session 内所有「成功的 `board_apply` 工具调用」按 log 顺序折叠的结果。**

三个词各自的含义必须精确：

- **成功的** = 其 `tool/result` 事件存在且 `data.message.isError !== true`。
- **按 log 顺序** = 按 `tool/call` 事件的 `seq` 升序（不是按 `tool/result` 的顺序，不是按调用发起顺序）。
- **折叠** = 顺序执行 §2.2 的 op 集；失败批整体丢弃，不留痕。

因为工具调用本身是已提交事件（F6），这条定义让 fork / resume / replay / 投影缓存全部免费（F7）。**这是 Q4 决策的机制化表述。**

**两个必须一起成立的附带条件（否则「免费」是假的）：**

1. **所有分配出来的东西都必须是折叠时确定性推导的**——元素 id（D8）、slug（`uniqSlug` 的输入是内容与顺序，见 §1.7）、边端的解析结果。任何一处用了 `Math.random()`、`Date.now()`、内存计数器或文件系统状态，resume 之后同一段 log 会折出两份不同的看板。
2. **工具结果里的一切都不进模型。** `board_apply` 返回的 `created[].slug` 只是**给模型看的信息**；它在 log 里只体现为 `tool/result.data.message.content` 的文本。折叠器**不得**从工具结果里解析任何东西（这是备选入口 C 被否掉的原因，§2.7.4）。


### 2.2 op 集合

`board_apply` 的 `ops` 是一个**按序执行的事务批**。批内第一个失败中止整批（§2.4）。所有 op 共用一个信封形状：

```ts
type Op =
  | AddPageOp | RenamePageOp | ReorderPagesOp | DeletePageOp
  | AddBlockOp | UpdateBlockOp | MoveBlockOp | DeleteBlockOp
  | AddEdgeOp | UpdateEdgeOp | DeleteEdgeOp
  | SetLayoutOp | SetRegionOp | DeleteRegionOp

interface OpBase {
  /**
   * 供人类与日志阅读的短说明；**不参与折叠语义、不进 revHash**。
   * 只在 `update_block` / `update_edge` / `set_layout` / `set_region` 上建议使用；
   * 其他 op 的意图已由 op 名表达，写 note 只是浪费 token。
   */
  note?: string
}
```

> 注意区分两个 `note`：op 上的 `OpBase.note` 属于模型片、随块/边一起被记（但不进哈希）；`board_apply` 参数上的顶层 `note` 是**批级**说明，属于工具调用参数、**不进模型**（它只在 transcript 与 git 镜像的 commit message 里出现）。

| op | 参数 | 不变量 / 语义 |
|---|---|---|
| `add_page` | `page`(slug, 可选 after) | `page` 必须在整块看板内唯一；缺 `after` 则追加到末尾。返回新 `pageId`。 |
| `rename_page` | `page`, `slug` | 按 §1.7 R1/R3 处理 alias；改的是 `Page.slug`，`id` 不动。 |
| `reorder_pages` | `order: string[]` | 必须是**当前全部页 id/slug 的一个排列**；长度不符或缺项即失败（不做「只移动一页」的模糊语义——那会造出两种实现）。 |
| `delete_page` | `page`, `force?` | 若该页有块或有边端点在页内块上，且 `force !== true`，失败并回报计数；`force` 时删除该页及其块，相关边标 `dangling`。删最后一页失败（`pages.length >= 1` 是不变量）。 |
| `add_block` | `page`, `kind`, `slug?`, `after?`, `region?` + **该 kind 的内容字段（同层平铺，不是嵌套的 `block` 对象）** | slug 经 `uniqSlug`；`kind:'group'` 时 `children` 必须引用**同页已存在**的块，且每个子块至多属于一个 group。 |
| `update_block` | `block` + **要改的内容字段（同层平铺，至少一个）** | 允许改的字段：`text/markdown/items/ordered/level/code/lang/filename/source/engine/diagram/src/alt/caption/page/crop/title/anchors`。禁止改 `kind`/`id`/`slug`（slug 走 `rename_block` 语义时仍用本 op 的 `slug` 字段）。改 `kind` 是「删+加」，刻意不给 op。 |
| `move_block` | `block`, `page`, 可选 `after` | 跨页移动时块内的 `AnchorAt.rect` 归一化坐标**保持原值**（它是相对该块自己的媒体，不是相对页面）；`regionId` 若指向的 region 不含新页块，region 的 `blockIds` 自动同步。 |
| `delete_block` | `block`, `recursive?` | 删块；指向它的边标 `dangling`。`kind:'group'` 默认只解组（保留子块），`recursive:true` 连子块一起删。 |
| `add_edge` | `from`, `to`, `rel?`, `label?`, `style?`, `slug?` | 两端锚点按 §1.4 校验（kind 兼容性）；重复边（同 from、同 to、同 rel、同 label）被**拒绝**并回报已存在的 edge slug —— 防模型重复画同一支箭。 |
| `update_edge` | `edge`, `patch` | 可改 `rel/label/style/waypoints/from/to`（改端点走同样的锚点校验）。 |
| `delete_edge` | `edge` | 真删（与 block 的 dangling 策略不同：边是关系，关系被显式撤回就该消失）。 |
| `set_layout` | `scope`(page 或 region 的引用), `layout` | 整块替换 `LayoutSpec`；`layout: null` 表示回到引擎默认。 |
| `set_region` | `region`(slug 或 id) 或新建, `blockIds`, `label?`, `layout?`, `tone?` | upsert 语义。`blockIds` 是**全量替换**；被移出的块 `regionId` 清空，移入的设置。 |
| `delete_region` | `region` | 只删容器，块与边都不动。 |

**引用解析**：所有 `page`/`block`/`edge`/`region` 参数都是**引用串**（id / slug / alias 皆可，§1.7 R1）。返回值里一律回带解析后的 `id` 与当前 `slug`——这是「避免笔误」的主要手段（[`board-tools.md`](./board-tools.md) §3.3）。

### 2.3 确定性规则

| # | 规则 | 内容 |
|---|---|---|
| **D1** | 顺序 | 折叠顺序 = `tool/call` 事件的 `seq` 升序。批内 = `ops` 数组下标升序。没有任何其他排序来源。 |
| **D2** | 忽略 | 非 `board_apply` 的调用、`isError` 的结果、以及任何非 `tool/call`/`tool/result` 事件，一律**原引用返回**（F7 的零成本要求）。 |
| **D3** | 批的原子性 | 批内任一 op 失败 → 整批丢弃。**失败批在 log 里留下 `tool/call` + `isError` 的 `tool/result`，但折叠器跳过它**，所以「log 有记录、状态无变化」是正常且可解释的。 |
| **D4** | 冲突裁定 | 不存在「最后写入获胜」以外的裁定：折叠是顺序的，后来者看到前者的结果。唯一例外是 `expected_revision`（§2.6），它在**批开始前**闸住整个批。 |
| **D5** | 引用失效 | 指向已删元素的**边**改标 `dangling:true` 而保留（R4）；指向已删元素的**op 引用**直接失败（不猜测）。 |
| **D6** | 幂等边界 | 折叠**不**做去重。同一个 op 批被模型重发两次，就会执行两次（第二次大概率因 slug 冲突或引用失效而失败，从而被 D3 丢弃）。真正的防重入由 `expected_revision` 负责。**不要**引入「按 op 内容哈希去重」——那会让两条合法的同内容 op（例如在两个位置各加一个同名块）行为不一致。 |
| **D7** | 相同序列 ⇒ 相同结果 | 因为：id 生成是**折叠时确定性推导**的（不是随机数），见下。 |
| **D8** | id 的确定性 | 元素 id **不由 `Math.random()` 生成**，而由 `sha256(sessionId + '\x1f' + callSeq + '\x1f' + opIndex + '\x1f' + kind)[0..5]` 取 6 位十六进制，前缀 `pg_/bl_/ed_/rg_/li_`。`callSeq` 是 `tool/call` 事件的 `seq`（log 位置，重放稳定）。若碰撞（同会话同前缀 6 hex 撞车），线性探测 `+1` 直到空闲。这把 D7 从「大概成立」变成**可证成立**。 |
| **D9** | 浮点 | `AnchorAt.rect/point` 存**归一化或整数**；`rect/point` 由模型侧量化到 4 位小数（`Math.round(v * 1e4) / 1e4`），避免 `0.1+0.2` 这类跨引擎差异进入哈希。块自身不再有坐标（[`board-design-notes.md`](./board-design-notes.md) §4.4），所以这条只约束箭头端点 |
| **D10** | 字符串 | 所有入模型字符串走 `NFC` 归一化后存储。**NFC 归一化必须在 op 应用时做，不是在哈希时做**，否则模型里的值与哈希的输入会漂移。 |
| **D11** | 空批 | `ops: []` 合法但无变化：`revSeq` **不**递增，返回 `changed: false`。 |

### 2.4 批校验的执行位置（这里有个必须写清的顺序）

`board_apply.execute` 的步骤顺序是强制的：

1. **参数形状**由 DSH 在 `defineTool` 包装里校验（`validateJsonSchemaValue`，F1/F4）。注意裸属性表**无法表达**「`oneOf` 之外还要求某个字段」这类约束，所以 `op` 与 `kind` 的**取值合法性由我们在 execute 里再查一遍**，非法即 `throw`。
2. **解析折叠当前状态**：`const doc = ctx.sessionProjections.stateOf(session, 'board')`（F16：同步、返回 live 引用；**只读，不得就地修改**，干跑必须 `structuredClone`）。此时该 session 里此前**所有** `board_apply` 的结果都已提交、投影已前进（F7 的 eager drive），所以读到的是最新状态；本次调用自己的 `tool/call` 因为尚无结果而被投影忽略（§2.7.2 第 1 步），**不会把自己算进去**——这正是把折叠点放在 `tool/result` 而不是 `tool/call` 的第二个理由。`stateOf` 返回 `undefined` 即投影未注册 → `throw new Error('board state unavailable: the board projection is not registered')`。（`snapshot(session, ['board']).values.board` 是等价但会多跑一次 zod 校验的读法，只在需要 `asOfSeq` 时用。）
3. **revision 闸**：`expected_revision` 比对（§2.6）。
4. **干跑**：把 ops 施加到一个 `structuredClone(model)` 上。**任何失败都在这里发生，且不产生任何副作用**——这条让「失败批不影响状态」成为实现上的自然结果，而不是需要小心维护的性质。
5. **不写日志**。看板的 log 写入由 DSH 自己完成（它已经写了 `tool/call`）。我们**只在工具结果里回带新状态摘要**。
6. 返回 `{ ok: true, rev, changed, applied, created, warnings }`。

**已验证（原为 UNVERIFIED）**：第 5 步意味着权威状态完全由「已提交的 `tool/call` 事件」驱动——这一点已在 `dsh-agent-loop` 源码里核实（`03fab27`）：`appendToolCall` 先于 `prepare`/dispatch 落盘，`tool/result` 必须以 `sourceEventSeqs` 引用它，abort 路径也两个事件都写。**两条派发路径都落盘，形状不同**：普通调用存的是模型原文**字符串**（运行循环另行解析），PTC / `run_code` 子派发用 `tool/ptc-dispatch-start` + `tool/ptc-dispatch` 且 `arguments` 已是对象；非法参数时 `tool/call` 同样落盘。折叠因此要按工具名接受两种形状（§2.7）。核实细节见 [`../research/dsh-plugin-contract.md`](../research/dsh-plugin-contract.md) §10，原验证清单见 [`board-design-notes.md`](./board-design-notes.md) §8.3 V1。

### 2.5 revision 算法

```
rev = 'r' + revSeq + '-' + revHash[0..11]

revSeq  : 每成功折叠一个 op 批 +1（D11 的空批 +0）
revHash : sha256(encodeModelForHash(model)) 的十六进制，取前 16 位存储、前 12 位展示
```

`encodeModelForHash` 是**手写的结构编码，不是 `JSON.stringify`**。理由：`JSON.stringify` 的结果依赖对象键的插入顺序，而插入顺序在「先 add 后 update」与「先 add 带全字段」两条路径上会不同，于是同一份内容会得到两个哈希。手写编码把每个元素的字段按固定顺序拼成一个字符串流，字段间用 `\x1f`、元素间用 `\x1e` 分隔。

**参与哈希的字段（穷举）：**

```
model.title
pages[]           按数组顺序:
  id, slug, (layout: template, params 的固定键序, hints 的固定键序)
  blocks[]        按数组顺序:
    id, kind, slug, regionId|null（块级 at 已删除，见 §4.4——位置由容器决定）
    以及该 kind 的内容字段，固定顺序:
      heading : level, text
      prose   : markdown
      list    : ordered, items[](id, text, depth)
      code    : lang, code, filename
      uml     : engine, diagram, source          ← renderedHash 不参与
      image   : src, alt, caption
      pdf-page: src, page, crop, caption
      group   : title, children[]
    anchors[]     按数组顺序: blockId, at(kind + 该 kind 的字段)
regions[]         按数组顺序: id, slug, blockIds[], label, tone（region 没有 layout）
edges[]           按数组顺序: id, slug, rel, label, style,
                            from(全部字段), to(全部字段), waypoints[](量化后)
```

**明确不参与哈希的字段（也必须写在实现里，否则未来有人加字段就会误伤）：**

| 字段 | 为什么不参与 |
|---|---|
| `revSeq` / `revHash` / `rev` | 自指 |
| `alias[]` | 纯历史，改它不该让「内容变了」成立 |
| `createdAtRev` / `updatedAtRev` | 派生自 revSeq，进哈希等于把计数器混进内容哈希 |
| `diag`（全部） | 派生自渲染器能力与工作区文件，不是 Agent 写的内容 |
| `renderedHash` | 渲染器派生 |
| `UmlBlock.nodeHints` | 解析器派生（v1 由 Agent 给，仍**不**参与——把它当渲染提示，不是模型内容，避免同一份源码因 hint 差异产生两个 rev） |
| `Page.blocks[].anchors[].at.quote` 的 `staleHint` | 校验器派生 |
| 任何视图片字段（平移/缩放/选中/反馈草稿） | 不进 `model`，见 §1.1 |
| `edge.dangling` | 派生自「目标块是否还在」，可由模型重算 |

**量化规则（D9）：** 箭头的 `rect/point` 端点坐标在写入模型时量化到 4 位小数（`Math.round(v * 1e4) / 1e4`），跨引擎一致；块自身没有坐标可量化（见 §4.4）。

**`rev` 的比对宽严（已实现，见 §2.6）：** `expected_revision` **只比 `revSeq`**，不比 hash。这不是当初设计里写的（原文建议「只接受完整 rev」），而是 2026-10-04 一次真实数据丢失事故改出来的结论：

- **必须只比 `revSeq`。** `revHash` 是内容编码的摘要，而内容编码随 `BOARD_MODEL_VERSION` 变化。版本一涨，Agent 上下文里**所有**旧 rev 的 hash 就再也算不出来，可它们指向的看板完全是最新的。此时比整串会拒绝诚实的写入——而且**从 Agent 那侧看不见**：工具的 dry run 跑在内存里的活模型上、照样报成功，只有折叠把这一批丢掉。
- **`revSeq` 是诚实信号**：它数的是成功折叠的 op 批数，所以一个报出当前 seq 的调用者就是见过当前看板的。报旧 seq 的仍然被拒——那正是这道闸存在的理由（Agent 拿着几轮前读的大纲来写）。
- **两处比对必须走同一个函数（`parseRevSeq`），但只有一处该执行它。** `board_apply` 的 `executeApply` 是**接纳闸**：那里可以告诉调用者「你落后了」。折叠（`commit`）**不再咨询它**——`commit` 只跑在日志已记为成功结算的调用上，而在线路径上 stale 调用早就以 `isError: true` 止步于 `withoutPending`，所以再查一遍保护不了任何东西，只会让重折去重新裁定已提交的批次、从而截断自己的历史（详见 §2.6.1 的第二层）。
- 完整 rev 仍然照常作为**展示与识别**用途：seq 相同而内容不同的两块看板，靠 hash 区分。

**代价（诚实记下来）：** 只比 seq 确实放过了「Agent 用同一 seq、但 hash 是别的串」这种情形。为什么可以接受：

1. 同一 seq 出现不同 hash，只可能来自**编码版本不同**或**同一份日志被算出两次**，两者都不代表调用者落后；
2. 真正的并发写防护在别处——`board_apply` 显式 `isConcurrencySafe: () => false`，调度器不会并行派发两个看板写；折叠本身也是顺序的，后来者看到前者（D4）；
3. 「读了 seq=N，中间有写入却没让 seq 前进」不可能发生：`revSeq` 只在成功折叠时 +1（D11 的空批是唯一不动 seq 的合法批，而它按定义不改变任何内容），而被闸拒的批同样什么都没改。

换句话说，这道闸的**目的**是回答「Agent 有没有落后」，而「落后」由 seq 定义。比 hash 是**超出目的**的额外限制——而正是那条额外限制造成了 I2。

### 2.6 旧写入（stale write）的行为

**`board_apply` 带 `expected_revision`；`revSeq` 不匹配时 `throw`**，于是模型看到（F5）：

```
Error: stale board revision: expected r17-a3f9c2b1d4e5 but board is now r19-77c1e0ba9d34
(2 other writes landed first). Nothing was applied. Call board_outline to see the current
state, then re-issue the ops you still want.
```

要点：

1. **错误文本本身承担教学职责。** 它必须包含：期望值、当前值、差了多少次写入、**「什么都没应用」**、以及下一步动作（`board_outline`）。工具面没有其他渠道告诉模型这些（F5：只有 throw）。
2. **不做自动重试、不做自动变基。** 看板 op 是语义操作，自动变基可能把一个「删除风险-1」应用到一个已经不存在的块上，或者更糟——应用到一个**恰好复用了那个 slug 的新块**上。宁让 Agent 重读一次。
3. **`expected_revision` 是可选还是必需？** 建议：**必填**。理由：可选就意味着模型会省略它，而省略后并发写没有任何保护；而 DSH 的工具调度允许并行（F15），看板必须显式 `isConcurrencySafe: () => false` 来串行化（见 [`board-tools.md`](./board-tools.md) §3.2）。两道防线都要有。
4. **每个工具结果都回带当前 `rev`**，包括失败前读到的。这样模型即使不主动读大纲，也在对话里有最新版本号。
5. **失败必须是响亮的。** 2026-10-04 的事故里，工具报了成功（dry run 通过）而折叠静默丢弃——十批写入凭空消失，用户看到的是看板「回滚」。所以：两处比对必须用同一个函数，且「折叠拒绝」与「工具接受」这两种结果的组合必须是不可能状态。

### 2.6.1 I2 —— 一次因比整串 rev 而丢十批写入的事故（2026-10-04）

**症状**：看板整体退回 `r11`，其后十次 `board_apply` 的成果全部消失；用户描述为「看板中途被回滚过一次」。更怪的是同一块看板出现过三个不同的 `r11-*`。

**根因**：**重折会把日志里记录的 `expected_revision` 重新拿去比一遍，所以编码一变，重放会自己把自己截断。**

具体链条：

1. `7fe6a18` 把 `BOARD_MODEL_VERSION` 从 3 提到 4（删掉了 `pdf-page.pageCount` 那一段编码）。哈希是内容编码的摘要，于是同一块看板在新编码下算出**不同的 hash**。
2. DSH 重启后载入新代码，投影发现 checkpoint 行的 `ver`（3）与注册的 `stateVersion`（4）不符，**整行丢弃、从 log 重折**——这是设计里的正常行为，也正是 log-native 的意义。
3. 但重折不是「把 op 无条件重放」：它走的是同一个 `applyOps`，而那个函数会拿**日志里原文记录的 `expected_revision`** 去和当时算出的 `rev` 比。第 12 批（seq 9968）记录的是旧编码下的 `r11-bae2d898101b`，而重折到那一刻算出的是新编码下的 `r11-513c602416f3`——整串不等，于是**判为 stale、丢弃**。其后每一批的 `expected_revision` 都是旧编码的串，于是一路丢到底。

结果是：**折叠在重折时截断了自己的历史。**十批内容仍然完好地躺在日志里，丢的只是「重折时要不要接受它们」这个判断。

**证据链**（`session-b0e78947`，12998 条事件全量重折）：
- 新编码重折：11 次 bump，停在 `r11-513c602416f3`；旧编码重折：21 次 bump，落到 `r21-19e7eba12d30`，与宿主在 seq 12285 的 runtime-context 里给出的 rev **完全一致**。
- 十批被丢的 `tool/result`，`isError` 全是 `false`，文本都是「Board updated: N op(s) applied」——**工具报了成功**（dry run 跑在内存模型上），只有折叠丢弃。
- 落地检查点 `session_projcache/sessions/session-b0e78947-….json` 的 `board.val.lastOpError` 原文写着：`stale board revision: expected r20-e1dbe4683e79 but the board is now r11-513c602416f3`。

**修复（两层）：**

1. **共享闸只比 `revSeq`**（`parseRevSeq`，`src/model.js`）。「调用者是不是落后」是**时间**问题，只有计数器能答；hash 回答的是「是不是同一块看板」。
2. **折叠不再咨询这道闸**（`src/fold.js` 的 `commit`）。这才是真正的根因修复，见下。修后同一条日志重折出 **24 批**，五页块数 `10/10/22/12/6`——不但找回原来的十批，还保住了后来写在被截断看板上的那三批。

**为什么第 2 层才是根因：** `commit` 只在日志记录为**成功结算**的调用上运行。在线路径上，DSH 的管线**已经**跑过 `board_apply` 自己的闸：stale 调用抛错 → 结果以 `isError: true` 送达 → 折叠在 `withoutPending` 里就把它丢掉了，**根本到不了 `commit`**。实测 25 次 `board_apply`：1 次以 error 送达，**0 次**以「成功但带 stale 消息」送达。所以在 `commit` 里再查一遍，在线路径上什么也没保护。

它真正造成的后果是：**重折可以截断自己的历史**。`applyOps` 会拿**日志里记录的 `expected_revision`** 去和「这次重折恰好走到哪」比，于是一旦版本升级换了 hash 那一半，整条尾巴都看起来 stale、被丢弃。**一个已提交的批次是事实；重放要复现它，而不是重新裁定它该不该被接纳。** 接纳判断属于 `board_apply` 的 `executeApply`（`src/tools.js`），那里才还有「你落后了」可以告诉调用者。

**为什么这条比第 1 层更根本：** 第 1 层只是让比较变宽——但「重折时重新裁定已提交的批次」这个结构性错误还在。任何未来的收紧（比如换一种 staleness 判据）都会再犯一次。第 2 层把 `commit` 变成**日志的纯函数**，那正是 log-native 设计赖以成立的前提。

**因此 `BOARD_MODEL_VERSION` 提到 5**：折叠语义变了就必须 +1，而且它也是恢复路径——现存 checkpoint 是被截断的，丢弃它才会从日志重折出完整看板。

**教训**：一个派生自内容编码的值，不能用来判断「调用者是否落后」；而**接纳判断（admission）与重放（replay）是两件事**，把前者放进后者会让折叠依赖自己的进度而不是日志。任何让重放依赖「走到哪」的方案，都会让折叠变成一个随版本、随历史变化的函数——而它必须是 log 的函数。


### 2.7 与 `ctx.sessionProjections` 的结合（折叠入口）

#### 2.7.1 结论：入口存在，且是既有事件词汇

**入口 = `tool/call` 事件 + `tool/result` 事件的配对。** 都是既有事件（F6），无新类型（F13）。

```ts
ctx.sessionProjections.register({
  key: 'board',                       // 客户端 useProjection('board')
  stateVersion: BOARD_MODEL_VERSION,   // = 5
  stateSchema: boardDocSchema,        // zod（F8）
  init: () => EMPTY_BOARD_DOC,        // 纯 JSON
  apply: (state, event) => boardFold(state, event),   // 纯同步，忽略即原引用（D2）
  wire: { viewSchema: boardWireSchema, view: (s) => s },
})
```

`stateVersion` 的纪律（F7）：**只要 `BoardDoc` 的字段或折叠语义变了就必须 +1**，否则已 checkpoint 的旧行会被当成可用，冷启动会读到一份按旧语义折出来的状态。具体会触发 +1 的改动：op 集合的语义变化、`revHash` 的编码规则变化、slug 生成算法变化、`diag` 形状变化。**不会**触发 +1 的改动：新增工具、模板几何、outline 文本格式（后者只是提示词，不进状态——但它有自己的冻结要求，见 [`board-design-notes.md`](./board-design-notes.md) §8.1 R7）。

#### 2.7.2 `apply` 收到的两个事件形状（V）

```ts
// 事件 1 —— dsh-agent-loop/lib/index.js L681-688
{
  type: 'tool/call',
  seq: 412,
  time: 1790000000000,
  data: {
    turn: number, step: number,
    callId: string,          // 模型给的调用 id
    name: string,            // 'board_apply'
    arguments: unknown,      // 模型给的原始 JSON（已 JSON.parse）
  }
}

// 事件 2 —— dsh-agent-loop/lib/index.js L691-707 + dsh-llm L101-112
{
  type: 'tool/result',
  seq: 419,
  time: ...,
  surfaceOp: 'append',
  sourceEventSeqs: [412],
  data: {
    turn: number, step: number,
    message: {
      role: 'tool', toolCallId: string,   // = callId
      content: [{ type: 'text', text: string }],
      isError: boolean,
    },
    error?: { name: string, code: string, ... },
    meta?: unknown,
  }
}
```

**注意 `tool/result` 里没有工具名**——只有 `callId`。所以折叠必须**两阶段**：

1. `tool/call` 且 `name === 'board_apply'`：把 `{seq, arguments}` 存进 `state.pending[callId]`。**此时不改模型。**
2. `tool/result` 且 `isError !== true`：从 `state.pending` 取回 `arguments`，执行 §2.2 折叠，写入模型，`revSeq += 1`，重算 `revHash`；然后从 `pending` 删除该 `callId`。
3. `tool/result` 且 `isError === true`：只从 `pending` 删除，模型不动。
4. 其他事件：`return state`（同引用）。

`pending` 是投影状态的一部分（纯 JSON：`Record<callId, {seq, ops}>`），因此会被 checkpoint 一起持久化（F12 的 `session_projcache` 就是这么做的），冷启动重放不会丢。**它必须有界**：`pending` 只保留最近 64 条，且每次成功折叠后清理已收到结果的条目；`tool/call` 无结果（turn 被取消）的条目在收到 `turn/end` 事件时清空。

#### 2.7.3 为什么这个入口是干净的

| 关注点 | 结论 |
|---|---|
| 是否发明事件名 | 否。只用 `tool/call` / `tool/result` / `turn/end`（都是 F13 列表成员）。 |
| 是否违反「不追加自定义事件类型」 | 否。我们一条事件都不追加。 |
| `apply` 是否纯同步 | 是。只读 `event`，只操作 `state`，不调任何 service、不读文件、不 await。 |
| 忽略事件是否原引用 | 是。D2 强制 `return state`。 |
| fork 是否免费 | 是。fork 的继承前缀里就有 `tool/call` 的 `arguments`；`session.inheritedEventCount` 存在（F14），折叠不需要特殊处理。 |
| resume/replay 是否免费 | 是。**但前提是 D8 的 id 推导只用 `callSeq`**——绝不能用 `time`、`Date.now()`、随机数或内存计数器。 |
| 客户端怎么看到 | 注册了 `wire` 就会推（F9）；客户端 `conversation.view` 的 board tab 用 `useProjection('board')`（F9）读，零额外 RPC。 |
| host 自己怎么读 | `ctx.sessionProjections.stateOf(session, 'board')`（原始 state，同步，live 引用只读）；需要 `asOfSeq` 时用 `snapshot(session, ['board'])`（F16）。 |

#### 2.7.4 备选入口（若 V1 验证失败时用）

**备选 B —— 只认「调用」，不认结果。**
`apply` 在 `tool/call` 上直接折叠，忽略 `isError`。代价：失败的批也会改状态，与 D3 冲突。**不建议**，但可作为「`tool/result` 顺序不可靠」时的退路（此时 `apply` 必须对 op 失败保持静默跳过）。

**备选 C —— 工具结果自带摘要。**
`board_apply` 的 `output.render` 产出可机器解析的首行（如 `[board-apply ok rev=r18 ops=3]`），投影从 `tool/result.data.message.content[0].text` 解析。问题：这要求渲染文本既是给模型看的又是给机器看的（两个消费者抢一个字符串），且 `output.schema` 的结构化值**不进 log**（log 里只有 `message.content`，见 F6），所以只能靠文本。**不推荐**。

**判定方法（[`board-design-notes.md`](./board-design-notes.md) §8.3 V1）：** 在一个测试 session 里手工调 `board_apply`，然后 dump session log（`.dsh/sessions/` 下的 jsonl，或 session 导出），确认：

- 存在 `tool/call` 且 `data.arguments` 是完整 JSON 对象；
- 存在配对的 `tool/result` 且 `data.message.isError === false`；
- 两者顺序为 call 在前；
- 参数校验失败（故意给错 `op`）时 `tool/call` 是否仍然落盘（**这是最关键的未知**：如果 DSH 在参数校验失败时根本不写 `tool/call`，那我们的 `pending` 机制反而更简单，但要确认不会出现「有 call 无 result」的常驻悬挂）。

---

## 附：一页速查

```
BoardDoc = { modelVersion, model: BoardModel, diag }

BoardModel = { title, pages[], regions[], edges[], revSeq, revHash, rev }
Page       = { id, slug, alias[], blocks[], layout?, createdAtRev }
Block      = BlockBase & (heading|prose|list|code|uml|image|pdf-page|group)
BlockBase  = { id, slug, alias[], anchors[], regionId?, createdAtRev, updatedAtRev }   // 无坐标字段
Anchor     = { blockId, at?: block|field|item|lines|text|child|node|rect|point }
Edge       = { id, slug, alias[], from, to, rel?, label?, style?, waypoints?, … }
Region     = { id, slug, alias[], blockIds[], label?, tone?, createdAtRev }   // layout 已删除

折叠       = 成功的 (tool/call{name:'board_apply'}) + 其配对的 (tool/result{isError:false})
             → 顺序施加 ops → revSeq+1 → 重算 revHash
rev        = 'r' + revSeq + '-' + sha256(encodeModelForHash(model))[0..11]

工具       = board_outline / board_read / board_apply / board_query（四个；board_feedback 从未实现）
写入口     = 只有 board_apply（事务批 + expected_revision 必填 + isConcurrencySafe:false）
常驻文本   = board-design-notes.md §5.1 的格式，预算 4000 字符，L0→L5 逐级降级，头部行与诊断区块永不省略
             另计 board-design-notes.md §5.4：board_apply 的编译后 schema 常驻请求头，~4–6k 字符
```
