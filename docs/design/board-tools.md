# 看板 Agent 工具面 — 工具契约

**状态：** **已实现并投入使用**（`src/tools.js`），所以是活文档。

**这一节原先在 [`board-model.md`](./board-model.md) 里**（那份文件 1592 行，契约、工具面、调研与风险台账混在一起），2026-10-05 按体裁拆出。
模型契约是 [`board-model.md`](./board-model.md) §0–§2；排版、上下文预算、客户端与镜像、决策对应与风险在
[`board-design-notes.md`](./board-design-notes.md)。

> **节的编号沿用拆分前的原始编号**（本文件从 §3 开始，3.1 / 3.2 / 3.2.1… 一个没动），所以其它文档里的
> `§3.2.x` 引用仍然对得上。§3.2.5 记的是**从未实现**的 `board_feedback`，留着只是让 §3.1 的勘误可追溯——
> 不要照着它写代码，工具是四个。

---

## 3. Agent 工具面

### 3.1 工具清单

| 工具 | 职责 | 一句话触发情境 |
|---|---|---|
| `board_outline` | 读大纲（页/块/边/诊断） | 每次要动看板前、以及每轮开始时的默认动作 |
| `board_read` | 按页/按引用读全文 | 需要正文原文时（引用、改写、核对） |
| `board_apply` | 事务性 op 批 + revision 闸 | **唯一**的写入口 |
| `board_query` | 基于语义边的关系查询 | 「谁依赖 X」「X 和 Y 之间是什么」「哪些块孤立」 |

> **勘误（2026-10-05）**：这一节原先列了第五个工具 `board_feedback`（「读用户最近一次框选反馈」）。
> **它从未实现**，`src/tools.js` 里没有它，`grep board_feedback src/` 也是零命中。框选反馈走的是
> **输入框附件**那条路：摘要是草稿文本、选区是 JSON 附件，两者都在 composer 里，不需要工具。
> 所以工具是**四个**，不是五个——README 的「刻意只有四个」才是对的。下面的小节号保留原样，
> 免得打乱其它地方的交叉引用。

**为什么只有 4 个：** 每个工具都占提示词预算，且模型在 4 个里选对的概率远高于在 12 个里。页的增删改**不单独开工具**，它们是 `board_apply` 的 op——这样一次「建页 + 放 3 个块 + 连 2 条箭」是一个事务、一个 rev、一次往返。

### 3.2 四个工具的精确契约

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

`output.render`：产出 **`[{type:'text', text}]`**，文本 = [oard-design-notes.md](./board-design-notes.md) §5.1 的**同一套格式**（工具与大常常驻大纲必须是同一种文本，否则模型要学两套）。

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

> **这个工具从未实现过**（`grep board_feedback src/` 零命中）。保留这一小节只是为了给 §3.1 的勘误和 §7 的 Q-H 行留出处。
> 框选反馈今天走**看板本地的反馈托盘**（`5da72d2`），不走工具，也不需要工具。

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
