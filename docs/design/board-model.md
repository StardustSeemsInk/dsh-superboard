# 看板数据模型与 Agent 工具面 — 设计契约

**状态：** 待评审（可照着实现的接口契约，不含实现代码）
**目标运行时：** DSH Desktop `0.2.0-rc.2`
**上游文档：** [`design-tree.md`](./design-tree.md)（已定决策 Q1–Q-H）、[`../research/dsh-plugin-contract.md`](../research/dsh-plugin-contract.md)（硬约束）、[`../research/dsh-host-plugin-api.md`](../research/dsh-host-plugin-api.md)（API 一手调研）

本文只回答一件事：**看板的场景模型长什么样，它如何从 session log 折叠出来，以及 Agent 通过哪些工具读写它。**

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
  modelVersion: 1
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
  /** 跨页的语义分组容器（见 §1.6 与 §4.2）。 */
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
  /** 排版模板与参数（§4）。缺省 = 引擎默认。 */
  layout?: LayoutSpec
  /** 创建该页的 rev，便于「这页是我刚建的吗」。 */
  createdAtRev: string
}

interface LayoutSpec {
  template: LayoutTemplate   // §4.1
  /** 模板参数；见 §4.1 每个模板的元数据表。 */
  params?: LayoutParams
  /** 覆盖模板自动推导的列/根/顺序。留空则由引擎推导。 */
  hints?: LayoutHints
}

type LayoutTemplate = 'flow' | 'row' | 'columns' | 'grid' | 'masonry' | 'canvas'

interface LayoutParams {
  /** columns/grid 的列数上限（窄窗口会被 §4.4 的降级覆盖）。 */
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
  /** 绝对位置覆盖。省略 = 交给排版模板（Q-E：这是例外）。 */
  at?: { x: number; y: number; w?: number; h?: number }
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
  /** 折叠态？纯渲染提示。 */
  collapsed?: boolean
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
  /** 已勾选（仅用于视觉，不构成任务系统）。 */
  checked?: boolean
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
  /** v1 只接受 'mermaid'；'plantuml' 预留（见 §8 风险 R6）。 */
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
  /** 自然尺寸，用于锚点坐标换算。缺失 = 渲染后回填，回填前锚点用归一化坐标。 */
  naturalSize?: { w: number; h: number }
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
  /** 折叠态。 */
  collapsed?: boolean
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
  /** 引擎图里的节点/边；key 由 UmlBlock.nodeHints 或解析器提供。 */
  | { kind: 'node'; key: string }
  /** 位图/PDF 页内的归一化矩形，(0,0)=左上，(1,1)=右下。 */
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  /** 位图/PDF 页内的归一化点。 */
  | { kind: 'point'; x: number; y: number }
```

**为什么 PDF/图片用归一化坐标：** 页空间坐标是「相对该页/该图」的比例，与渲染 DPI、容器宽度、缩放级别全部无关。宿主栅格化到任何 `pixelWidth` 时都按 `x * naturalWidth`（PDF 用 crop 宽）换算。这样：

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
  /** 分组自身也可以指定模板（例如「这一簇用 tree」）。 */
  layout?: LayoutSpec
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
| `update_block` | `block` + **要改的内容字段（同层平铺，至少一个）** | 允许改的字段：`text/markdown/items/ordered/level/code/lang/filename/source/engine/diagram/src/alt/caption/page/crop/title/collapsed/anchors`。禁止改 `kind`/`id`/`slug`（slug 走 `rename_block` 语义时仍用本 op 的 `slug` 字段）。改 `kind` 是「删+加」，刻意不给 op。 |
| `move_block` | `block`, `page`, 可选 `after` | 跨页移动时块内的 `AnchorAt.rect` 归一化坐标**保持原值**（它是相对该块自己的媒体，不是相对页面）；`regionId` 若指向的 region 不含新页块，region 的 `blockIds` 自动同步。 |
| `delete_block` | `block`, `recursive?` | 删块；指向它的边标 `dangling`。`kind:'group'` 默认只解组（保留子块），`recursive:true` 连子块一起删。 |
| `add_edge` | `from`, `to`, `rel?`, `label?`, `style?`, `slug?` | 两端锚点按 §1.4 校验（kind 兼容性）；重复边（同 from、同 to、同 rel、同 label）被**拒绝**并回报已存在的 edge slug —— 防模型重复画同一支箭。 |
| `update_edge` | `edge`, `patch` | 可改 `rel/label/style/waypoints/from/to`（改端点走同样的锚点校验）。 |
| `delete_edge` | `edge` | 真删（与 block 的 dangling 策略不同：边是关系，关系被显式撤回就该消失）。 |
| `set_layout` | `scope`(page 或 region 的引用), `layout` | 整块替换 `LayoutSpec`；`layout: null` 表示回到引擎默认。 |
| `set_region` | `region`(slug 或 id) 或新建, `blockIds`, `label?`, `layout?`, `tone?` | upsert 语义。`blockIds` 是**全量替换**；被移出的块 `regionId` 清空，移入的设置。 |
| `delete_region` | `region` | 只删容器，块与边都不动。 |

**引用解析**：所有 `page`/`block`/`edge`/`region` 参数都是**引用串**（id / slug / alias 皆可，§1.7 R1）。返回值里一律回带解析后的 `id` 与当前 `slug`——这是「避免笔误」的主要手段（§3.3）。

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
| **D9** | 浮点 | `AnchorAt.rect/point` 存**归一化或整数**；`rect/point` 由模型侧量化到 4 位小数（`Math.round(v * 1e4) / 1e4`），避免 `0.1+0.2` 这类跨引擎差异进入哈希。块自身不再有坐标（§4.4），所以这条只约束箭头端点 |
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

**UNVERIFIED（重要）**：第 5 步意味着权威状态完全由「已提交的 `tool/call` 事件」驱动。若 DSH 在某些路径下**不写** `tool/call`（例如 PTC / `run_code` 模式的转发调用，F13 里存在 `tool/ptc-dispatch` 事件类型），本设计的根基会松动。**动工前必须验证：`board_apply` 被调用时，`tool/call` 一定先于 `tool/result` 落盘，且 `data.arguments` 就是模型给的原始 JSON。** 验证方法见 §8.3 V1。

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
    id, kind, slug, regionId|null, at|null(量化后)
    以及该 kind 的内容字段，固定顺序:
      heading : level, text
      prose   : markdown, collapsed
      list    : ordered, items[](id, text, depth, checked)
      code    : lang, code, filename
      uml     : engine, diagram, source          ← renderedHash 不参与
      image   : src, alt, caption, naturalSize
      pdf-page: src, page, crop, caption
      group   : title, children[], collapsed
    anchors[]     按数组顺序: blockId, at(kind + 该 kind 的字段)
regions[]         按数组顺序: id, slug, blockIds[], label, layout, tone
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

**量化规则（D9）：** `rect/point` 的 `x/y/w/h` 在写入模型时按 `round(v*1e4)/1e4`；`at.x/y/w/h` 是整数像素，直接取整。

**`rev` 的比对宽严：** `expected_revision` 接受：

- 完整 `rev`（`r17-a3f9c2b1d4e5`）——精确匹配；
- 仅 `revSeq`（`r17`，或裸数字 `17`）——**UNVERIFIED：建议 v1 只接受完整 rev。** 放宽会掩盖「Agent 读的是旧大纲」这一真实故障。

### 2.6 旧写入（stale write）的行为

**`board_apply` 带 `expected_revision`；不匹配时 `throw`**，于是模型看到（F5）：

```
Error: stale board revision: expected r17-a3f9c2b1d4e5 but board is now r19-77c1e0ba9d34
(2 other writes landed first). Nothing was applied. Call board_outline to see the current
state, then re-issue the ops you still want.
```

要点：

1. **错误文本本身承担教学职责。** 它必须包含：期望值、当前值、差了多少次写入、**「什么都没应用」**、以及下一步动作（`board_outline`）。工具面没有其他渠道告诉模型这些（F5：只有 throw）。
2. **不做自动重试、不做自动变基。** 看板 op 是语义操作，自动变基可能把一个「删除风险-1」应用到一个已经不存在的块上，或者更糟——应用到一个**恰好复用了那个 slug 的新块**上。宁让 Agent 重读一次。
3. **`expected_revision` 是可选还是必需？** 建议：**必填**。理由：可选就意味着模型会省略它，而省略后并发写没有任何保护；而 DSH 的工具调度允许并行（F15），看板必须显式 `isConcurrencySafe: () => false` 来串行化（见 §3.2）。两道防线都要有。
4. **每个工具结果都回带当前 `rev`**，包括失败前读到的。这样模型即使不主动读大纲，也在对话里有最新版本号。

### 2.7 与 `ctx.sessionProjections` 的结合（折叠入口）

#### 2.7.1 结论：入口存在，且是既有事件词汇

**入口 = `tool/call` 事件 + `tool/result` 事件的配对。** 都是既有事件（F6），无新类型（F13）。

```ts
ctx.sessionProjections.register({
  key: 'board',                       // 客户端 useProjection('board')
  stateVersion: 1,
  stateSchema: boardDocSchema,        // zod（F8）
  init: () => EMPTY_BOARD_DOC,        // 纯 JSON
  apply: (state, event) => boardFold(state, event),   // 纯同步，忽略即原引用（D2）
  wire: { viewSchema: boardWireSchema, view: (s) => s },
})
```

`stateVersion` 的纪律（F7）：**只要 `BoardDoc` 的字段或折叠语义变了就必须 +1**，否则已 checkpoint 的旧行会被当成可用，冷启动会读到一份按旧语义折出来的状态。具体会触发 +1 的改动：op 集合的语义变化、`revHash` 的编码规则变化、slug 生成算法变化、`diag` 形状变化。**不会**触发 +1 的改动：新增工具、模板几何、outline 文本格式（后者只是提示词，不进状态——但它有自己的冻结要求，见 §8.1 R7）。

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

**判定方法（§8.3 V1）：** 在一个测试 session 里手工调 `board_apply`，然后 dump session log（`.dsh/sessions/` 下的 jsonl，或 session 导出），确认：

- 存在 `tool/call` 且 `data.arguments` 是完整 JSON 对象；
- 存在配对的 `tool/result` 且 `data.message.isError === false`；
- 两者顺序为 call 在前；
- 参数校验失败（故意给错 `op`）时 `tool/call` 是否仍然落盘（**这是最关键的未知**：如果 DSH 在参数校验失败时根本不写 `tool/call`，那我们的 `pending` 机制反而更简单，但要确认不会出现「有 call 无 result」的常驻悬挂）。

---

## 3. Agent 工具面

### 3.1 工具清单

| 工具 | 职责 | 一句话触发情境 |
|---|---|---|
| `board_outline` | 读大纲（页/块/边/诊断） | 每次要动看板前、以及每轮开始时的默认动作 |
| `board_read` | 按页/按引用读全文 | 需要正文原文时（引用、改写、核对） |
| `board_apply` | 事务性 op 批 + revision 闸 | **唯一**的写入口 |
| `board_query` | 基于语义边的关系查询 | 「谁依赖 X」「X 和 Y 之间是什么」「哪些块孤立」 |
| `board_feedback` | 读用户最近一次框选反馈 | 收到一条带框选的消息后 |

**为什么只有 5 个：** 每个工具都占提示词预算，且模型在 5 个里选对的概率远高于在 12 个里。页的增删改**不单独开工具**，它们是 `board_apply` 的 op——这样一次「建页 + 放 3 个块 + 连 2 条箭」是一个事务、一个 rev、一次往返。

### 3.2 五个工具的精确契约

下面的 `parameters` 一律写作 **DSH 裸属性表**：无顶层 `type:"object"`，`required: true` 写在每个属性上（F1）。`output.schema` 是**值根**（`type` 在根上），对象必须显式 `additionalProperties: boolean`（F3），属性的 `required: true` 同样写在属性上（F2）。

#### 3.2.1 `board_outline`

```
description:
  "Read the board outline: pages, their blocks (slug + kind + one-line preview),
   the directed edges between them, and any blocks that failed to render.
   The outline is also injected into your context every step, but it is truncated
   when large; call this tool for the complete outline of a board you are about to edit.
   Always call this before board_apply when you have not read the board this turn."

parameters: {
  page: {
    type: "string", required: false,
    description: "Optional page reference (slug or id). Omit for every page."
  },
  include: {
    type: "string", required: false,
    enum: ["all", "pages", "blocks", "edges", "diag"],
    description: "Sections to include. Defaults to 'all'. Use 'edges' alone to re-check relations cheaply."
  },
  maxChars: {
    type: "integer", required: false,
    description: "Soft cap on returned text length (default 6000, max 24000). Truncation is reported explicitly."
  }
}
```

`output.schema`（值根）：

```
{
  type: "object", additionalProperties: false,
  properties: {
    rev:         { type: "string",  required: true },
    title:       { type: "string",  required: true },
    pages: {
      type: "array", required: true,
      items: { type: "object", additionalProperties: false, properties: {
        id:      { type: "string", required: true },
        slug:    { type: "string", required: true },
        blocks:  { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
          id:      { type: "string", required: true },
          slug:    { type: "string", required: true },
          kind:    { type: "string", required: true },
          preview: { type: "string", required: true },
          region:  { type: "string", required: false }
        } } },
        layout:  { type: "string", required: false }
      } }
    },
    edges: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
      id:     { type: "string", required: true },
      slug:   { type: "string", required: true },
      from:   { type: "string", required: true },
      to:     { type: "string", required: true },
      rel:    { type: "string", required: false },
      label:  { type: "string", required: false },
      dangling: { type: "boolean", required: false }
    } } },
    diag: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
      block:   { type: "string", required: true },
      code:    { type: "string", required: true },
      message: { type: "string", required: true }
    } } },
    truncated: { type: "boolean", required: true },
    omitted:   { type: "string", required: false }
  }
}
```

`output.render`：产出 **`[{type:'text', text}]`**，文本 = §5.1 的**同一套格式**（工具与大常常驻大纲必须是同一种文本，否则模型要学两套）。

**触发情境与防错作用：** 模型即将改看板但尚未在本轮读过它；或收到 stale revision 错误之后。它给出的 `rev` **就是** `expected_revision` 的取值来源——不是让模型记版本号，而是让它**复制刚看到的那个串**。这是防笔误的第一道闸。

#### 3.2.2 `board_read`

```
description:
  "Read the full content of a page or of specific blocks. Use this when you need the
   actual text (to quote it, rewrite it, or check it) rather than the outline preview.
   Accepts slugs, ids, or former slugs. Never guesses: an ambiguous or unknown
   reference returns an error listing the candidates."

parameters: {
  refs: {
    type: "array", required: true,
    items: { type: "string" },
    description: "Page refs, block refs, edge refs, or region refs. Mixing is allowed."
  },
  depth: {
    type: "string", required: false,
    enum: ["block", "page", "region"],
    description: "How much context to include around each matched ref. 'page' also returns the whole page's blocks in order. Defaults to 'block'."
  },
  format: {
    type: "string", required: false,
    enum: ["markdown", "json"],
    description: "Defaults to 'markdown' (cheapest, best for reading). Use 'json' when you need exact field values to patch."
  }
}
```

`output.schema`：

```
{
  type: "object", additionalProperties: false,
  properties: {
    rev:     { type: "string", required: true },
    text:    { type: "string", required: true },   // markdown 形式（format='json' 时是 JSON 文本）
    format:  { type: "string", required: true, enum: ["markdown","json"] },
    resolved: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
      ref:       { type: "string", required: true },   // 输入原样
      id:        { type: "string", required: true },
      slug:      { type: "string", required: true },   // 当前 slug —— 可能是重命名后的新值
      kind:      { type: "string", required: true },
      viaAlias:  { type: "boolean", required: false }  // 输入用的是旧 slug
    } } },
    missing: { type: "array", required: true, items: { type: "string" } }
  }
}
```

**防错作用（这是它最重要的设计点）：** `resolved[]` 明确回带「你给的 ref → 我实际解析到的当前 slug」，并且 `viaAlias: true` 会告诉模型**它手里的地址已经过期**。模型因此能在同一轮里改用新 slug，而不是三条 op 之后才发现自己在改错块。

`missing[]` **不抛错**（与 `board_apply` 不同）：读操作容忍部分失败，把未命中的列出来即可。写操作必须全命中，否则抛错。

**`output.render` 产出什么：** 单个 `{type:'text'}` 块，内容 = `value.text`。**不在 render 里做任何加工**——`text` 已经由 `execute` 按 `format` 渲染好，`render` 只负责把它交给模型。这样「模型看到什么」与「结构化值里有什么」永远一致，也避免 render 抛错（F4：render 抛错会被包成 projection error，比 execute 抛错难查）。

`missing` 非空时，`execute` 在 `text` 末尾追加一段固定提示（不靠 render）：

```
not found: 风险-9, page:部署
(the board has: pages 架构总览, 依赖分析, 部署拓扑 — call board_outline for slugs)
```


#### 3.2.3 `board_apply`

```
description:
  "Apply a batch of board edits atomically. This is the ONLY way to change the board.
   Every call must carry expected_revision, copied from the most recent board_outline,
   board_read, or board_apply result. If another write landed since, nothing is applied
   and you get the current revision back: re-read, then re-issue.

   Ops are applied in array order. The first failing op aborts the whole batch and no
   state changes. Reference blocks and pages by slug; ids also work. Layout is chosen by
   the engine: do not set coordinates unless a template cannot express the arrangement."

parameters: {
  expected_revision: {
    type: "string", required: true,
    description: "The rev string from your most recent board_* result (for example 'r17-a3f9c2b1d4e5')."
  },
  ops: {
    type: "array", required: true,
    description: "Ordered operations. Applied in array order; first failure aborts the batch.",
    items: {
      oneOf: [ AddPage, RenamePage, ReorderPages, DeletePage,
               AddBlock, UpdateBlock, MoveBlock, DeleteBlock,
               AddEdge, UpdateEdge, DeleteEdge,
               SetLayout, SetRegion, DeleteRegion ]
    }
  },
  note: {
    type: "string", required: false,
    description: "One short line describing the intent of this batch (shown in the transcript and the git mirror commit)."
  }
}
```

**批内每个 op 的完整形状。**

**头号实现陷阱（先读这条）：** 编译后的 op 分支是 `{type:'object', additionalProperties:false, properties:{…}, required:[…]}`，而 `oneOf` 要求**恰好一个**分支匹配。因此：

1. **`op` 必须是每个分支唯一的判别键，且用 `const` 而非 `enum`。** 若两个 `oneOf` 分支只有一个字段不同，模型给出另一个取值时会 0 匹配或 2 匹配，`oneOf` 失败 → `ToolArgsError(INVALID_ARGS)`，错误文案是 schema 走查结果，**不是你写的**。所以判别键必须硬。
2. **不要用 `oneOf` 表达「`add_block` 的 8 种 kind」。** 若把 kind 拆成 8 个分支，每个分支都带 `additionalProperties:false`，那么公共可选字段（`slug`/`after`/`region`/`note`）必须在**每一个**分支里重复声明，漏一个就会让合法调用被拒。**正确做法：`add_block` 是单个分支，`kind` 是 `enum`，所有 kind 的内容字段都在该分支里平铺声明；只把 `op`+`page`+`kind` 标 `required:true`，其余内容字段全部 `required:false`，由 `execute` 按 kind 校验必填（见下方实现注记）。** 这样「按 kind 二选一」的约束从 schema 层挪到了我们自己能写好错误文案的地方。
3. 同理，`update_block`/`update_edge` 是单分支 + 全字段 optional，`execute` 负责「至少要改一个字段」与「字段属于该 kind」。

| 分支 | 属性（`required:true` 者加粗语义；其余 optional） |
|---|---|
| `add_page` | `op`(`const`), **`page`**(string: 新页 slug), `after`(string), `layout`(string) |
| `rename_page` | `op`(`const`), **`page`**(string), **`slug`**(string) |
| `reorder_pages` | `op`(`const`), **`order`**(array of string) |
| `delete_page` | `op`(`const`), **`page`**(string), `force`(boolean) |
| `add_block` | `op`(`const`), **`page`**(string), **`kind`**(enum), `slug`(string), `after`(string), `region`(string), `note`(string), + 下方 kind 字段表里的**全部**字段（均 optional） |
| `update_block` | `op`(`const`), **`block`**(string), `slug`(string), `after`(string), `region`(string), `note`(string), + 可改字段（均 optional，至少一个由 execute 校验） |
| `move_block` | `op`(`const`), **`block`**(string), **`page`**(string), `after`(string) |
| `delete_block` | `op`(`const`), **`block`**(string), `recursive`(boolean) |
| `add_edge` | `op`(`const`), **`from`**(string), **`to`**(string), `rel`(enum), `label`(string), `style`(enum: solid/dashed/dotted), `slug`(string) |
| `update_edge` | `op`(`const`), **`edge`**(string), `rel`, `label`, `style`, `from`, `to`(均 optional，至少一个由 execute 校验) |
| `delete_edge` | `op`(`const`), **`edge`**(string) |
| `set_layout` | `op`(`const`), **`scope`**(string: page 或 region 引用), **`template`**(enum: flow/row/columns/grid/masonry/canvas), `cols`(integer), `gap`(integer), `minCardWidth`(integer) |
| `set_region` | `op`(`const`), **`region`**(string), **`blockIds`**(array of string), `label`(string), `tone`(enum), `template`(enum) |
| `delete_region` | `op`(`const`), **`region`**(string) |

**`add_block` 的 kind 内容字段（全部平铺在同一分支里，全部 `required:false`）：**

| kind | 必需（由 execute 强制） | 可选 |
|---|---|---|
| `heading` | `text`(string) | `level`(integer, 1–3, 默认 2) |
| `prose` | `markdown`(string) | — |
| `list` | `items`(array of string) | `ordered`(boolean) |
| `code` | `code`(string) | `lang`(string), `filename`(string) |
| `uml` | `source`(string) | `engine`(enum: mermaid/plantuml), `diagram`(enum) |
| `image` | `src`(string), `alt`(string) | `caption`(string) |
| `pdf-page` | `src`(string), `page`(integer) | `caption`(string) |
| `group` | `children`(array of string) | `title`(string) |

> **实现注记（必读）：** 声明层**不做**「`kind:'code'` 就必须有 `code`」这类条件必填——裸属性表表达不了，而把它硬塞进 `oneOf` 会产生上面第 2 条的重复声明陷阱。DSH 只校验每个属性**出现时**的类型；「属于该 kind 的字段是否齐全」留给 `execute` 抛错（F5）。因此 `add_block` 的 execute 第一步是 `requireFieldsForKind(kind, args)`。**这不是妥协，是正确的位置**：错误由我们自己写，才能给出该 kind 的必填清单、一个合法示例、以及「用 `board_read` 看一眼现有同类块」的建议。schema 层做不到这些。

`output.schema`（成功时）：

```
{
  type: "object", additionalProperties: false,
  properties: {
    ok:      { type: "boolean", required: true },
    rev:     { type: "string",  required: true },   // 应用后的新 rev
    changed: { type: "boolean", required: true },   // false = 空批（D11）
    applied: { type: "integer", required: true },
    created: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
      kind:  { type: "string", required: true },    // 'page' | 'block' | 'edge' | 'region' | 'item'
      id:    { type: "string", required: true },
      slug:  { type: "string", required: true },    // 实际分配的 slug（可能带 -2 后缀！）
      ref:   { type: "string", required: true }     // 你在 ops 里给的那个串（新建时等于 slug）
    } } },
    renamed: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
      id:       { type: "string", required: true },
      from:     { type: "string", required: true },
      to:       { type: "string", required: true },
      aliasKept:{ type: "boolean", required: true }
    } } },
    warnings: { type: "array", required: true, items: { type: "string" } },
    dangling: { type: "array", required: true, items: { type: "string" } },
    pages:    { type: "array", required: true, items: { type: "string" } }  // 新页序的 slug 列表
  }
}
```

失败时：**`throw`**，无返回值（F5）。

**`output.render` 产出什么（这是本工具最关键的一处设计）：**

- **成功：** 一行摘要 + 必要的纠正信息，纯文本：

  ```
  Board updated: r19-77c1e0ba9d34 (3 ops applied).
  created: block 风险-2 (bl_5c1a09), edge 登录依赖会话 (ed_4d90bb), page 部署拓扑 (pg_1a77cd)
  warnings: block slug '风险-1' was taken; '风险-2' was assigned instead
  ```

  **`warnings` 必须进模型可见文本**，不能只进结构化值：slug 后缀是「Agent 以为它叫 A、实际叫 A-2」的唯一告知渠道，而后续所有 op 都要用真实 slug。
- **失败：** 由 DSH 生成 `Error: <message>`（F5）。我们的 `throw` 消息模板：

  ```
  board_apply rejected (nothing applied):
    op[2] add_edge: 'bl_9c02e1' is a code block and 'lines' anchors are valid; 'rect' is not.
    Valid anchors for code: block, field, lines
  Board is still at r19-77c1e0ba9d34. Fix op[2] and re-issue the whole batch.
  ```

  即：**批级前缀（"nothing applied" + 当前 rev）+ 精确定位（`op[i]` + op 名）+ 原因 + 合法取值 + 下一步**。五段齐全才算合格错误。

`isConcurrencySafe: () => false`（F15）—— 看板写入必须串行。这不会拖慢正常的串行工具调用，只挡住 DSH 把两个 `board_apply` 并行派发。

#### 3.2.4 `board_query`

```
description:
  "Ask structural questions about the board's directed edges. Answers come from the
   edges you drew, not from reading prose. Use this instead of re-reading pages when
   the question is about relationships."

parameters: {
  kind: {
    type: "string", required: true,
    enum: ["dependents_of","dependencies_of","between","neighbors_of","by_rel","orphans","dangling","path"],
    description:
      "dependents_of: what points AT the target with rel depends/derives (i.e. what depends on it).
       dependencies_of: what the target points at with those rels.
       between: every edge connecting two refs in either direction.
       neighbors_of: all edges touching a ref, direction marked.
       by_rel: all edges with a given rel or label.
       orphans: blocks with no edge at all.
       dangling: edges whose endpoint block no longer exists.
       path: directed path from 'from' to 'to' following depends/next."
  },
  target: { type: "string", required: false, description: "Ref for the single-target kinds." },
  from:   { type: "string", required: false, description: "Ref; required for 'between' and 'path'." },
  to:     { type: "string", required: false, description: "Ref; required for 'between' and 'path'." },
  rel:    { type: "string", required: false, enum: ["depends","causes","contains","next","explains","derives","contradicts","relates"] },
  depth:  { type: "integer", required: false, description: "Hop limit for 'path' and transitive variants (default 3, max 8)." }
}
```

`output.schema`：

```
{
  type: "object", additionalProperties: false,
  properties: {
    rev:     { type: "string", required: true },
    kind:    { type: "string", required: true },
    hits:    { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
      edge:    { type: "string", required: true },   // edge slug
      from:    { type: "string", required: true },   // 端点块 slug
      to:      { type: "string", required: true },
      rel:     { type: "string", required: false },
      label:   { type: "string", required: false },
      via:     { type: "string", required: false },  // path 时的中间节点，逗号分隔
      dangling:{ type: "boolean", required: false }
    } } },
    empty:   { type: "boolean", required: true },
    hint:    { type: "string", required: false }     // empty 时给下一步建议
  }
}
```

**触发情境：** 用户问「什么依赖登录服务」「这两块之间有什么关系」「有没有没连上的块」；或 Agent 在删块前自查影响面（`dependents_of` 先看一眼，再决定要不要 `delete_edge`）。

**防错作用：** `hits[].from/to` 一律是**当前 slug**，`empty: true` 时 `hint` 直接给出下一步（例如 `"no edges with rel=depends point at 登录服务; 4 edges touch it with other rels — call board_query{kind:'neighbors_of'}"`）。模型不需要自己判断「空结果意味着什么」。

**`output.render` 产出什么：** 单个 `{type:'text'}` 块，用**紧凑表格式文本**（比 JSON 省一半字符）：

```
board_query dependents_of 登录服务 → 2 hits (r19-77c1e0ba9d34)
  渠道适配器 -[depends]-> 登录服务   "适配器假设会话长期有效"
  风控校验   -[depends]-> 登录服务
```

`empty: true` 时 render 输出 `hint` 全文而不是「0 hits」——空结果的价值全在那句话里。


#### 3.2.5 `board_feedback`

```
description:
  "Read the user's most recent marquee selection or annotation on the board, if any.
   The user cannot edit the board; a marquee is how they point at things. Call this when
   a user message refers to 'this', 'these', 'the selected part', or arrives with no
   obvious textual referent."

parameters: {
  index: {
    type: "integer", required: false,
    description: "Which staged feedback to read, 0 = most recent (default), 1 = the one before it. Max 9."
  },
  includeText: {
    type: "boolean", required: false,
    description: "Include each selected block's full text (default true). Set false to get only refs and edges."
  }
}
```

`output.schema`：

```
{
  type: "object", additionalProperties: false,
  properties: {
    present: { type: "boolean", required: true },
    age:     { type: "integer", required: false },     // 距现在多少条用户消息之前
    blocks:  { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
      id:     { type: "string", required: true },
      slug:   { type: "string", required: true },
      kind:   { type: "string", required: true },
      page:   { type: "string", required: true },
      text:   { type: "string", required: false }
    } } },
    edges:   { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
      id:    { type: "string", required: true },
      slug:  { type: "string", required: true },
      from:  { type: "string", required: true },
      to:    { type: "string", required: true },
      label: { type: "string", required: false }
    } } },
    comment: { type: "string", required: false },      // 用户在手势里附带的一句话
    rect:    { type: "object", additionalProperties: false, required: true, properties: {
      page:  { type: "string", required: true },
      x:     { type: "number", required: true },
      y:     { type: "number", required: true },
      w:     { type: "number", required: true },
      h:     { type: "number", required: true }
    } }
  }
}
```

**触发情境：** 用户消息里出现「这个/这块/选中的/这些箭头」；或用户消息很短且看起来在回答一个需要指代的问题。

**防错作用：** 它把「用户指着什么」变成**当前 slug 列表 + 原文**（Q-H 的 v1 结构化载荷），并顺带回带 `edges[]` ——「选中的块之间有什么关系」。这正好覆盖「用户框选了两块问它们什么关系」这一高频场景，不需要额外的工具。它还把「没有反馈」这一情形**显式化**（`present:false` + 「去问用户」），避免模型在空结果上编造指代对象。

**持久化：** 反馈载荷由客户端在用户发消息时随消息一起提交（Q7 待定，见 `design-tree.md`）；`board_feedback` 只读取。**UNVERIFIED：** 尚未确定它落在哪条既有事件上（候选：`user/message` 的附件、`feedback/message-put` / `feedback/record` —— 后两者存在于 F13 的类型集中，语义待确认）。见 §8.3 V6。

**`output.render` 产出什么：** 单个 `{type:'text'}` 块。`present: false` 时输出固定的三行，**不输出空结构**：

```
no board selection is staged for this session.
The user may have selected on the board without sending, or this session's board has no user
gestures yet. Ask the user which part they mean instead of guessing.
```

`present: true` 时输出**用户视角的引述块**（这是唯一一处工具输出偏向人类阅读而非模型解析的地方，因为它的内容最终会被回述给用户）：

```
[board selection] page 架构总览 · rect (0.12, 0.30, 0.44, 0.18)
  block 风险-1 (list): "回调幂等缺失" / "对账延迟" / "重试放大"
  block 渠道适配器 (code): "retry 只覆盖了超时"
  edges between them: 风险-1 -[causes]-> 渠道适配器  "重试放大导致重复扣款"
  user note: "这两块是不是同一个问题？"
```


### 3.3 工具面如何系统性降低笔误

| 机制 | 作用 |
|---|---|
| 每次结果都回带 `rev` | 模型永远有新鲜的 `expected_revision` 可复制，不需要记忆 |
| `created[].slug` 回带**实际**分配的 slug | 后缀消解（`风险-2`）不会被静默吞掉 |
| `renamed[]` + `aliasKept` | 重命名后模型知道旧地址仍然能读（但提议用新地址） |
| `resolved[].viaAlias` | 模型知道自己在用过期地址 |
| 批级错误前缀 "nothing applied" + 当前 rev | 模型不会误以为「部分成功」 |
| 错误里带 `op[i]` 与合法取值枚举 | 模型能修对，而不是重发同一个错 |
| `board_query` 的 `empty.hint` | 空结果被解释，不被误读为「没有关系」 |
| `board_outline` 的 `truncated` + `omitted` | 模型知道大纲不全，不会基于残缺信息下结论 |
| 写工具单一入口（只有 `board_apply`） | 不存在「用哪个工具改」的歧义 |
| slug 用中文 | 用户与模型在 transcript 里都能直接读懂（Q-G 的初衷） |

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
- 不进 `revHash`（§2.5）；
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

### 4.5 本节与实现的两处已知偏差

本节表格写于两次排版评审之前。**以代码为准**；下面是已核实的偏差，不要照表格实现：

| 表格里的 | 实现里的 |
|---|---|
| `tree` 模板、`region` 可挂模板（`region.layout`） | `tree` 已删除——**组里套组本身就是一棵树**，另设模板是同一件事的两种说法；改为新增 `row`。`region` 退化为**纯标注**（tone + label），不再有 `layout`；`group` 才是排版容器 |
| `grid` 的 `minCardWidth` 默认 280px、`cols` 默认 4；`hints.bands` | 实现里默认 **260px**，且 `grid` 未给 `cols` 时用 `repeat(auto-fill, minmax(...))` 自适应；`bands`、`matrix` 均未实现（`set_layout` 的 `root`、`direction` 两个死字段已删除） |
| §4.3「窄窗 `< 640px` 降级为单列 + `LIMIT` 诊断」 | **未实现**。`src/client.js` 里没有 `LIMIT`；唯一的窄窗行为是 `columns` 在 `< 720px` 时变单列，且无诊断 |
| `columns` 的 `cols` 上限 4 | 现为 **6**（`masonry` 同上限）。两者都是「静默截断」——见 §4.3 的取舍说明 |
| `grid` + `cols` 会让卡高等高 | **不再如此。** 等高只发生在 `areas`（命名格子是槽位）——`cols` 只决定列数，不改变卡高。这条偏差曾经存在并制造过「短卡变成大空盒」的真实问题 |


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

1. **slug 截断到 24 码位**（§1.7 已定），且 `mkSlug` 优先取短的源（`heading.text` 前 24 字，而不是 `prose` 首行）。
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
2. **`description` 要省着写。** 每个属性的 `description` 都会进 schema。规则：**参数级 `description` 只写「取值域与格式」，把「什么时候用、为什么」写在工具级 `description` 里**（后者每个工具一份，前者每个属性一份）。本文 §3.2 的属性描述已经是这个标准的示范——例如 `expected_revision` 的属性描述只说明它是什么，而「必须从最近结果复制」这条纪律写在工具描述里。
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

| 决策 | 本设计如何满足 | 位置 |
|---|---|---|
| Q1 `conversation.view` 第三 tab | board tab 用 `useProjection('board')` 读，与 host 唯一耦合是投影键 | §6.1 |
| Q2 自建 DOM/SVG | 场景模型与渲染器分离：`BoardModel` 无任何像素字段；坐标是派生数据 | §1.1, §4.3 |
| Q3 块流优先 | `Page.blocks` 是有序数组，`region` 是标注，`group` 是排版容器 | §1.2–1.6 |
| Q4 log 原生 | 折叠入口 = `tool/call` + `tool/result` 配对 | §2.7 |
| Q-A 只有 Agent 写 | 唯一的写 op 集在 `board_apply`；客户端纯读；用户手势只产出 `board_feedback` | §3.2.3, §6.1 |
| Q-B v1 范围 | UML 有类型无渲染；`diag` 通道今天就存在但恒空 | §1.8, §1.1 |
| Q-C 多页 | `Page` 是一等对象，`add_page/rename_page/reorder_pages/delete_page` | §1.2, §2.2 |
| Q-D 常驻大纲 + 拉取 | `systemPrompt.context()` 注入 §5.1 文本；细节走 `board_read` | §5.1 |
| Q-E 模板优先 | 5 个模板（`flow`/`row`/`columns`/`grid`/`canvas`）；坐标已从块上删除，自由摆放只属于空间性组件 | §4.1, §4.4 |
| Q-F 有向语义边 | `Edge{from,to,rel?,label?}`，方向即语义，`board_query` 按方向查 | §1.5, §3.2.4 |
| Q-G slug 主地址 | 三层地址 + `uniqSlug` 含 alias + 边锚 id | §1.7 |
| Q-H 结构化文本反馈 | `board_feedback` 返回 id/原文/关系；不返回位图 | §3.2.5 |

---

## 8. 风险与未决

### 8.1 我认为最可能错的地方

**R1 —— 折叠入口依赖「`tool/call` 一定落盘且一定先于 `tool/result`」。**
这是整个设计的地基。`tool/call` 与 `tool/result` 的产生位置我读到了（`dsh-agent-loop` L681-707），但**没有读到**「参数校验失败时是否仍写 `tool/call`」、「PTC / `run_code` 路径下的调用是否被表示成 `tool/call`」这两点。若后者不成立，看板在 PTC 模式下会静默不动。**这是最高优先级的验证项。**
→ 验证：§8.3 V1。

**R2 —— 投影状态里塞 `pending` 映射是一个「够用但不对」的设计。**
把「未决调用」放进投影状态，意味着投影状态包含了**非模型信息**（虽然不进 `revHash`）。更干净的做法是让投影在 `tool/result` 上重扫最近 N 条日志找配对调用，但那违反「`apply` 纯同步、不得回读会话」的纪律（F7 的 `apply(state, event)` 签名里没有 session）。**当前方案是纪律允许范围内的最优解**，但它是本设计里最不优雅的一处，评审时值得单独讨论。
→ 缓解：`pending` 上限 64 条 + `turn/end` 清空；并在 `stateSchema` 里显式声明它。

**R3 —— slug 作为地址的长期可用性。**
中文 slug 在 transcript 里可读性极好，但它承担了「地址 + 显示 + git 文件名」三重职责。一旦用户把块标题改成一句长话，slug 变长，大纲预算立刻恶化（§5.2）。**风险不在正确性，在预算。**
→ 缓解：24 码位截断；`board_apply` 允许显式给短 slug；未来可引入「显示名 ≠ slug」的第二个字段（现在不加，因为两个名字会让模型必然混用）。

**R4 —— `expected_revision` 必填会不会造成大量无效失败。**
如果模型经常忘记带上正确的 rev（例如它读了大纲但中途又调了别的工具），必填就变成摩擦源。我判断不会——因为**每个工具结果都回带 rev**，模型手边总有最新值。但这是判断，不是证据。
→ 缓解：错误文本第一句就是「调 `board_outline` 拿新 rev」，一次往返即可恢复；v1 上线后统计失败率，必要时改为「缺省 = 不校验 + warning」。

**R5 —— 「一个块最多属于一个 region」可能太紧。**
真实评审里，「这个块既是风险又是待办」很常见。强制单一归属会逼 Agent 建两个语义重叠的 region。
→ 缓解：v1 保持单一归属（多重归属会让 region 的背景框渲染与跨页布局都变复杂），**若出现需求，正确的扩展是给 region 挂标签而不是允许块属于多个 region**。

**R6 —— `UmlBlock.engine` 的取值可能选错。**
`design-tree.md` 记录的推荐是 Mermaid（进程内解析、结构化错误）。但 Mermaid 是**客户端**库，而 S7 禁止 iframe；在宿主文档里跑 Mermaid 意味着把它的运行时打进 client bundle，体积与 token 主题适配都是未知数。
→ **UNVERIFIED**，且在 v1 之外。现在定型 `engine: 'mermaid' | 'plantuml'` 只是保留字段；若最终选了别的渲染路线（例如自研极简 flowchart），`engine` 多一个取值即可，模型不变。

**R7 —— 大纲的「稳定格式」可能不够稳定。**
§5.1 的格式是我设计的，模型会据此形成解析习惯。若实现时为了省字符改了分隔符，模型不一定报错，可能只是悄悄误解。**格式必须当成对外契约冻结**，但注意它**不进 `stateVersion`**（它只在提示词里，不在投影状态里，§2.7.2），所以没有任何机制会自动拦住这种改动——只能靠纪律。
→ 建议：把 §5.1 的格式规则写成一份**黄金样例测试**（golden test），实现改动若不能让样例逐字符相等就必须先改样例并说明理由。

### 8.2 需要先验证才能动工的断言

| # | 断言 | 为什么要紧 | 若为假的后果 |
|---|---|---|---|
| A1 | `ctx.sessionProjections.register` 允许省略 `wire` | 若 `wire` 必填，看板必须额外维护一个只给客户端看的视图模型 | 工作量增加，但不致命 |
| A2 | `stateSchema` 用 zod（F8 已强证据），且**只用最简形状**（对象/数组/字符串/数字/null 联合） | 复杂 zod schema 的 `.parse` 在热路径上对每个事件调用 | 折叠变慢 |
| A3 | `ctx.systemPrompt.context()` 的 `text` 函数里能同步读到该 session 的投影 | 常驻大纲的实现基础（F10 只证明了能拿到 `session`） | 大纲只能退化为在 `board_apply` 后 `agent.inject()` 推送，模型可能用过期的 |
| A4 | `exec.agent` 在 `board_apply` 里一定存在（非 agentless 调用） | 无 agent 时我们既不能确认 session 也无法报错 | 需要一个显式的 `throw`，行为已定义 |
| A5 | 客户端 `useProjection('board')` 对第三方插件注册的键可用 | board tab 的读路径 | 需要退化为 `host.call` 拉取 + 轮询 |
| A6 | `tool/call` 的 `data.arguments` 在 log 里是**完整 JSON 对象**（不是字符串、不是 delta） | 折叠的唯一输入 | 需要自己累积 delta，不可能做到纯同步 |
| A7 | `defineTool` 的 `deferLoading` 能否让 `board_apply` 的 schema 不常驻请求头 | 省 2–3k token/步 | 保持常驻，预算按 §5.4 计算 |

### 8.3 验证清单（按优先级，动工前跑）

- **V1（阻塞性）** 手工 session 里调一次合法与一次非法的 `board_apply`，导出 session log，确认：`tool/call` 存在且 `data.arguments` 是对象；`tool/result` 配对且 `isError` 正确；顺序为 call→result；**非法参数时 `tool/call` 是否仍然落盘**。
- **V2** 在 PTC / `run_code` 模式下重复 V1。（`tool/ptc-dispatch` 事件类型的存在说明这条路可能不同。）
- **V3** 注册一个 `wire` 缺省的投影，确认不报错。
- **V4** 在某个 `conversation.view` tab 组件里调 `useProjection('board')`，确认能拿到 host 推送的值，且切换 tab 再回来仍然有效。
- **V5** 在 `ctx.systemPrompt.context()` 的 `text` 函数里调 `ctx.sessionProjections.stateOf(session, 'board')`，确认同步可用、返回非 `undefined`，且拿到的是一致切面。
- **V6** 确认 `feedback/record` 与 `feedback/message-put` 两个既有事件类型的语义（`board_feedback` 的载荷落点，Q7 的输入）。

---

## 附：一页速查

```
BoardDoc = { modelVersion, model: BoardModel, diag }

BoardModel = { title, pages[], regions[], edges[], revSeq, revHash, rev }
Page       = { id, slug, alias[], blocks[], layout?, createdAtRev }
Block      = BlockBase & (heading|prose|list|code|uml|image|pdf-page|group)
BlockBase  = { id, slug, alias[], anchors[], regionId?, at?, createdAtRev, updatedAtRev }
Anchor     = { blockId, at?: block|field|item|lines|text|child|node|rect|point }
Edge       = { id, slug, alias[], from, to, rel?, label?, style?, waypoints?, … }
Region     = { id, slug, alias[], blockIds[], label?, layout?, tone?, createdAtRev }

折叠       = 成功的 (tool/call{name:'board_apply'}) + 其配对的 (tool/result{isError:false})
             → 顺序施加 ops → revSeq+1 → 重算 revHash
rev        = 'r' + revSeq + '-' + sha256(encodeModelForHash(model))[0..11]

工具       = board_outline / board_read / board_apply / board_query / board_feedback
写入口     = 只有 board_apply（事务批 + expected_revision 必填 + isConcurrencySafe:false）
常驻文本   = §5.1 格式，预算 4000 字符，L0→L5 逐级降级，头部行与诊断区块永不省略
             另计 §5.4：board_apply 的编译后 schema 常驻请求头，~4–6k 字符
```
