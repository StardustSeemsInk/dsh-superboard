# 看板已知缺陷 I4–I6 — `move_block` 复制块，与 `created[].id` 不可用

**状态：✅ 三条全部已修复（`f6f93b6`，432 测试全绿）。** 本文由一次外部调研会话在 2026-10-10 写下——它的看板（KitX 项目，写到 8 页 / 16 边）在投入使用中遇到并复现了这些现象。下面的成因分析**原样保留**：它同时是修复的说明书，而且每一条都指向了真正的那一行。编号沿用仓库既有的 I 序号（I2 见 [`board-model.md`](./board-model.md) §2.6.1，I3 记在项目自己那块看板上），本文初稿曾写作 B1–B3，说的是同一件事。

### 修复结果

| # | 结论 |
| --- | --- |
| **I4** | ✅ 修好。`opMoveBlock` 的两个分支现在都从「已把该块摘掉的页面」出发插入（跨页分支本来就是对的——另一个页面不可能含有这个块）。`:872-874` 那个把 `updatedAtRev` 赋给自己的 no-op `.map`、以及 `:855`/`:857` 逐字重复两遍的文档注释，一并删掉。回归测试钉住四件事：同页移动后页面仍是两块、顺序确实变了、两个 id 仍然互异、**移动后仍能按 slug 更新**——最后这条正是报告里那个「ambiguous」症状 |
| **I5** | ✅ 修好，而且**比报告看到的更深**。报告只看到「id 对不上」，但同一个成因还让**整份 diff 都在说谎**：`snapshotIndex` 按 id 建索引，于是 dry run 铸出的 id 一旦撞上某个活块的 id，就会**覆盖**那个块的条目——真正新建的块**根本不出现在 `created` 里**，而那个没被碰过的活块被报成 `renamed`（报告表格第 2 行「解析到了别的块」就是这个）。所以修的不只是「不报 id」：创建的判定改成按 **slug**（slug 由模型与请求的地址推出，与 seq 无关，因此 dry run 的 slug 就是落地后的 slug），而重命名靠 **`alias`** 与撞 id 区分——折叠器会把旧地址收进 `alias`（`src/fold.js:870`），撞出来的假改名不可能 `alias` 一个它从未拥有过的地址。`created[]` 现在只回 `{kind, slug}`；`renamed[].id` **保留**，因为那个 id 铸于更早的批次，在这里是权威的 |
| **I6** | ✅ 加上了。`applyOps` 收尾扫一遍「一个块 id 至多出现一次」，违反即抛 `BoardOpError`，整批拒绝（批是原子的，所以损坏永远不落盘）。但它**只在准入处生效**（`context.validateInvariants`，由工具的 dry run 置位），**重放处刻意不生效**：`commit` 会重折日志里的每一批，而一批在 bug 存在期间**已经提交**的写入是该看板的事实——在那里重新裁定它会静默丢掉那一批以及它之后的全部改动，正是 I2 的失败模式换了一扇门进来。测试同时钉住了这两种行为 |

附 B 的三条使用建议（同页 `move_block` 不要用、不要用 `created[].id`、以 `board_outline` 报出的 id 为准）在修复后都不再必要，`created[]` 里也已经没有 id 可误用。

---

**影响面：** I4 会**永久破坏一块页面**（块在页内出现两次、之后无法按 slug 引用），且没有任何修复 op；I5 让 Agent 拿不到刚创建元素的 id。

标记约定：**V** = 我读了 `src/` 的代码或在自己会话里实际观察到的；**UNVERIFIED** = 推测，未验证。

---

## 0. 速查

| # | 症状 | 位置 | 严重度 |
| --- | --- | --- | --- |
| **I4** | **同页** `move_block` 之后，被移动的块在页面里出现**两份**（同一 id） | `src/fold.js:858-888`（同页分支 `:869-876`） | **高** — 数据损坏，无修复 op |
| **I5** | `board_apply` 返回的 `created[].id` 是 dry-run id，**永远对不上**真实 id | `src/tools.js:997-1004` + `src/model.js:240,249` | 中 — 契约谎报，Agent 会拿它做锚点然后报 not found |
| **I6** | 模型缺少「块 id 在页内唯一」的不变量校验，破坏后要等下一次引用才暴露 | `src/fold.js` 折叠入口 / `src/model.js` | 低 — 是 I4 的放大器 |

---

## I4 — 同页 `move_block` 会复制块（数据损坏）

### 成因（**V**）

`src/fold.js:858-888`：

```js
function opMoveBlock(model, op) {
  const found = resolveElement(model, op.block, 'block')
  const from = found.page
  const block = found.element
  const to = resolveElement(model, op.page, 'page').element

  const stripped = { ...from, blocks: from.blocks.filter((candidate) => candidate.id !== block.id) }
  const blocks = [...to.blocks]        // ← 同页移动时 to.blocks 里【仍然含有】block
  if (op.after === undefined) blocks.push(block)
  else blocks.splice(blocks.indexOf(resolveBlockInPage(to, op.after)) + 1, 0, block)

  if (from.id === to.id) {
    return replacePage(model, from.id, (current) => ({
      ...current,
      blocks: blocks.map((candidate) =>
        candidate.id === block.id ? { ...candidate, updatedAtRev: candidate.updatedAtRev } : candidate,
      ),
    }))
  }
  const pages = model.pages.map((page) => {
    if (page.id === from.id) return stripped   // ← 跨页分支用了 stripped，同页分支没有
    if (page.id === to.id) return { ...page, blocks }
    return page
  })
  ...
}
```

**同页移动时 `from` 与 `to` 是同一个 Page 对象，所以 `to.blocks` 就是 `from.blocks` —— 里面还留着 block。** 于是 `blocks` = 原列表 + 再插入一次 block = **两份同 id 的块**。

`:864` 算出来的 `stripped` 在跨页分支（`:878`）被正确使用，在**同页分支被完全丢弃**。

`:872-874` 那个 `.map` 看起来是想在插入后修一下被移动的条目，但它写的是 `updatedAtRev: candidate.updatedAtRev` —— **把一个字段赋给它自己**，是个 no-op，什么都修不了。

### 最小复现（**V**，本会话实际发生）

```jsonc
[{ "op": "move_block", "block": "<本页任意块>", "page": "<它当前所在的页>", "after": "<同页另一个块>" }]
```

同页移动（`from.id === to.id`）即触发；跨页移动正常。

### 后果（**V**）

1. 该块在 `page.blocks` 里出现两次，**id 与 slug 都相同**。
2. 之后**任何按 slug 的引用都会失败**：`src/fold.js:377-385` 的 `bySlug` 收到 length 2，抛
   `block reference "d-ask" is ambiguous between bl_eace7c, bl_eace7c`
   ——**注意两个 id 是一样的**，报错信息本身就看不出是「重复」而不是「撞名」。
   （按 id 引用仍然可用：`:374-375` 的 `byId` 用 `find`，取第一个。）
3. `delete_block` 按 id 执行时会**一次删掉全部副本**（`opDeleteBlock` 用 `Set` 过滤 id），所以「删一份」是做不到的 —— 只能整块删掉再重建，**内容会丢**。
4. `set_layout` 之类对页面整体生效的 op 不会去重（同页块的数组就是有两份）。
5. 没有任何 op 能把页面修回单份。

### 建议修法（**UNVERIFIED**，未跑）

同页分支应当以 `stripped.blocks` 为基数插入，而不是 `to.blocks`：

```js
  if (from.id === to.id) {
    const base = from.blocks.filter((candidate) => candidate.id !== block.id)
    const next = [...base]
    if (op.after === undefined) next.push(block)
    else next.splice(next.indexOf(resolveBlockInPage(from, op.after)) + 1, 0, block)
    return replacePage(model, from.id, (current) => ({ ...current, blocks: next }))
  }
```

顺带删掉 `:872-874` 那个 no-op `.map`；如果它原本的意图是「移动后刷新 `updatedAtRev`」，那要显式赋值成新的 rev，否则读者会以为它在做去重。

另：`src/fold.js:855` 与 `:857` 的文档注释**逐字重复了两遍**，删一行。

### 事故发生后的手工恢复（**V**，本会话用此法无损恢复）

1. `board_read({ refs: ["<页>"], depth: "page", format: "json" })` 拿整页 JSON；
2. 按 `slug` 归组遍历 `blocks`，找出重复项并**把正文原样捞出来**；
3. `delete_block` 掉重复的 id（会删掉全部副本）；
4. `add_block` 按原文在正确位置重建（用 `after:` 指定插入点）。

代价：块的 id 与 `createdAtRev` 变了，任何指向它的 edge 端点、以及外部记下的 slug→id 都要重接。

---

## I5 — `board_apply` 返回的 `created[].id` 不是权威 id

### 成因（**V**）

`src/tools.js:997-1004`：

```js
    next = applyOps(structuredClone(model), args.ops, {
      sessionId: doc.sessionId,
      // The dry run cannot know the seq the committed call will settle at, so element ids
      // derived here are indicative only. The fold derives the authoritative ones.
      callSeq: 'dry-run',
      callerRev: model.rev,
      expectedRevision: args.expected_revision,
    })
```

`created`（`src/tools.js:1012-1016`）就是从这个 **dry-run 模型**里 diff 出来的。而元素 id 的推导是：

- `src/model.js:240` —— 「The id is a hash of `(sessionId, callSeq, opIndex, kind)`」；
- `src/model.js:249` —— `const material = [parts.sessionId, parts.callSeq, parts.opIndex, parts.kind].join(FIELD_SEP)`；
- `src/fold.js:429-443` —— `mintId` 用 `context.callSeq`；
- 提交路径 `src/fold.js:200` —— `callSeq: seq`。

**dry-run 的 `callSeq` 是字符串 `'dry-run'`，提交路径是真实序号，所以两边必然推出不同的 id。** 代码注释（`:999-1000`）已经承认了这一点。

### 症状（**V**，本会话实际观测）

| 创建的块 | `created[].id` 报告 | 随后 `board_read` | `board_read` 给出的真实 id |
| --- | --- | --- | --- |
| `ch-answer` | `bl_039e71` | **not found** | `bl_554704` |
| `gaps-board` | `bl_ff68b4` | 解析到了别的块（`d-ask` 的真实 id 恰好是 `bl_ff68b4`） | — |

第 2 行更糟：**报告的 id 可能属于另一个已存在的元素**，于是引用会静默地解析到错误的块，而不是报错。

### 为什么这是契约问题而不只是「已知限制」（**V**）

`board_apply` 的结果 schema（`src/tools.js:939` 起）把该字段声明为 **"Stable id"**，并出现在 `outputHint`/字段表（`src/tools.js:964`）里。Agent 读到「Stable id」就会拿它做后续 `add_edge` 的端点或 `at: { blockId }` 锚点 —— 然后失败。**一个字段叫 stable 却不能稳定，比没有这个字段更糟。**

### 建议修法（**UNVERIFIED**，未跑）

真实序号在同一个函数里**已经算出来了**：`src/tools.js:1030` 的 `pendingRev` 就是用真实 seq 算的。所以三选一：

1. **用真实 `callSeq` 再折一次**（`structuredClone` + 内存折叠，成本可接受），把 `created[].id` 填成权威值；
2. 把该字段改名成 `dryRunId` 并从 schema 里移出「stable」的说法；
3. 干脆只返回 `slug`（slug 是权威的，也是 Agent 真正该用的引用）。

方案 1 最好：它让返回载荷与提交后的看板一致。

---

## I6 — 缺「块 id 在页内唯一」的不变量（**UNVERIFIED** 的具体做法）

`mintId` 的 `idExists`（`src/fold.js:446-456`）只保证**新铸**的 id 不与既有 id 冲突，它防不住 I4 这种「把既有块插第二遍」的路径。折叠完成后没有任何地方断言「每个块 id 在页内至多出现一次」。

因此 I4 的损坏不是在写入时被拒绝，而是**要等到下一次按 slug 引用才以「ambiguous」的形式暴露**，而此时块已经被写坏、且没有修复 op。

建议：在 `applyOps` 收尾处加一次廉价的不变量扫描，违反时抛 `BoardOpError`（批校验是原子的，所以损坏根本不会落盘）；或者在 `board_outline`/`board_read` 的 `diag` 里报出来，让 Agent 立刻看见。

---

## 附 A — 本次观测的 revision 轨迹（**V**）

```
r16-8252e92fd663   起点（此前的同页 move_block 已经留下一个重复块，当时未察觉）
r17-72bba6106d2e   同页 move_block 再次触发 → deps 页块数 21 → 23
r18-7d18c2cd046a   set_layout 试图去重 → 无效
r19-264e6429754a   delete_block（按 id，删掉全部副本）
r20-461b28ff8e73   按原文重建 d-ask / d-ask2 → 回到 21 块，内容无损
r21-c9adf38cbd52   后续正常写入
```

**注意 r16 的起点**：重复块在更早的会话里就已经产生，并且**当时没有任何提示**——这正是 I6 说的，损坏是静默的。

## 附 B — 我在自己会话里踩到的三个使用建议（**V**）

1. **同页 `move_block` 一律不要用**，改用「删掉再在目标位置 `add_block`」，或干脆用 `set_layout`/重排整页。
2. **不要用 `created[].id`**，只认 `created[].slug`，或者写入后用 `board_outline` 复查再引用。
3. **引用块以 `board_outline`/`board_read` 报出的 id 为准**，不要以 `board_apply` 返回值为准。