# dsh-superboard — design tree

**Status: open — round 1 of the design interview has not been answered yet.**
This file is the working record of the design tree. It is not a specification until the
settled/blocked columns say so.

Read [`../research/dsh-plugin-contract.md`](../research/dsh-plugin-contract.md) first: it holds
the verified Harness constraints these decisions must respect.

---

## Reference points

| Ref | Meaning |
|---|---|
| **U1** | *"看板由 Agent 编辑"* — the Agent authors the board through tools; no hand-drawing tools needed. |
| **U2** | *"用户则是可以标记框选以向 Agent 反馈和提问"* — the user marquees a region to give feedback / ask. |
| **U3** | *"画布上还能画箭头等以用于标记逻辑关系"* — arrows express logical relationships. |
| **U4** | *"支持 UML 绘图渲染（而且渲染错误等信息也要能反馈给 Agent 防止 Agent 笔误却无从得知）"* — UML rendering, **and render errors must reach the Agent**. |
| **U5** | *"可以贴上 PDF 页面、图片等，箭头也可以从 PDF 界面和图片上的位置指向文字块"* — pin PDF pages and images; arrows from a point on a page/image to a text block. |
| **U6** | *"画布支持多页，采用 Agent 主动查询的方式将内容注入上下文，而不是直接全量注入（不过可以考虑注入大纲之类的信息）"* — multi-page; the Agent **pulls** context rather than receiving the whole board. |
| **U7** | *"画布的层级是对话而非项目"* — scope is the conversation, not the project. |
| **U8** | *"对话框则变为可折叠的右侧边栏模块，且可以和画布互换主体（将对话UI还原，画布变成小地图）"* — chat becomes a collapsible right module, and the two can swap roles. |
| **U9** | Optional simpler path: the canvas lives inside the existing right sidebar, sharing the tab strip with browser and friends. |

---

## Settled

These are not open for debate — they are Harness facts, verified in the contract document.
Each one *removes* options, which is why they come first.

| # | Constraint | Consequence for this design |
|---|---|---|
| **S1** | `main` is a keyed, root-scoped slot; the layout renders it as `renderSlot("main", {}, { entryKey: activePanelId ?? "conversation" })` | **U8 is a first-class shell facility, not a custom layout.** Registering a `main` panel and adding a `sidebar.panellist` row gives a real panel that swaps with the conversation. |
| **S2** | `sidebar.panellist` is a `list` slot; `PanelRow` calls `ctx.layout.selectPanel(id)`; `layout.selectPanel(null)` clears the active panel, and `activePanelId === null` renders `conversation` | The left-rail panel registry is **the** navigation surface. A third-party panel icon is a normal contribution. Switching back to chat is "select nothing". |
| **S3** | Right-sidebar tabs are two registrations: `ctx.sidebarRightTabs.register({id, …})` + `sidebar.right.pane.tab` keyed by that `id`; the tab `id` is conventionally the package name | **U9 is cheap** — and so is putting the chat itself in the right pane. |
| **S4** | `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`; registering into an **undeclared** slot throws; `slots.inject` on a slot that never appears **degrades silently** | Every slot we claim must be verified against the live catalog, not assumed. A typo produces no error, just nothing. |
| **S5** | A client plugin gets: restricted `ctx`, **React without JSX transform**, `host.call()`, `styles.insert(css)`, `console`. No plugin event bus; 8 client services, 4 client events | The client half talks to its own host half over `host.call`. Any board state that must be shared between the two halves flows through our own RPC, not a shared store. |
| **S6** | **Do not `require('@deepseek-ai/dsh-client-ui-primitives')`.** Copy markup/CSS/behaviour under our own class prefix; keep only `--dsw-alias-*` token references | We hand-write every control on the canvas, including tabs, menus, and inputs. Budget for it — and for keeping the interaction model small enough that hand-writing is viable. |
| **S7** | **No iframes for plugin pages** — an iframe loses theme tokens, light/dark, and `ctx.locale` | **U5's PDF rendering cannot be an embedded viewer.** PDF pages must be rasterized into the host document. This is the single most expensive consequence in the whole tree. |
| **S8** | **The session log is the only source of truth**; plugin memory is a derived cache. Custom session event `type`s are **not** appendable | The board's durable representation must be reconstructable from committed events. Tool calls *are* committed events, so "board = fold over its own `board_apply` calls" is the compliant shape. |
| **S9** | Context injection has exactly two supported routes: `ctx.systemPrompt.section()` and `agent.inject()` (which does **not** wake the driver) | **U6 is natively supported.** `inject()` can wait in the inbox until other input arrives — exactly the "outline attached to the turn that needs it" behaviour. |
| **S10** | `ctx.tools.register({ parameters })` takes **plain JSON Schema**; `execute` returns content blocks | The Agent-facing tool surface is unconstrained by schema-library ceremony. Design it for the model, not the framework. |
| **S11** | Client `layout` service: `selectPanel`, `toggleSidebar`, `openRightbar(track, fullscreen)`, `closeRightbar` | U8's three layout states (canvas-primary / chat-primary / both) are all expressible with one service. |
| **S12** | Verified mechanism for the canvas as primary UI: `main` key `superboard` + a `sidebar.panellist` entry with the same `id`; `ctx.layout.selectPanel("superboard")` shows the canvas, `selectPanel(null)` restores the conversation | **U8's swap is available in v1**, contradicting round 1's "phase it" recommendation. |

---

## Open — round 1

Asked, unanswered. Recommendations marked ➡️. Rationale lives in the interview; only the
decision and its consequence are recorded here.

| # | Decision | ➡️ Recommendation | Consequence if yes |
|---|---|---|---|
| **Q1** | Where the canvas lives and how the swap works: (a) `main` panel + chat in right pane, (b) right-sidebar tab only, (c) both, with a live swap | **(c)** — upgraded from "phased" to **full v1** after S12 turned out to be a shell facility | Canvas becomes a peer of the conversation; `sidebar.panellist` gains a row; the right pane hosts either chat or a live canvas minimap |
| **Q2** | Rendering technology: own DOM/SVG layer / React Flow / Excalidraw | **Own DOM/SVG layer**, with the scene model strictly separated from the renderer | A few hundred lines of pan/zoom/marquee/selection plumbing; total control over PDF anchoring and real editable markdown DOM; React Flow's attribution licensing stays unresolved rather than becoming a dependency |
| **Q3** | Primary element model: freeform absolute rectangles vs block-flow with optional absolute offsets | **Block-flow-first** — ordered typed blocks with stable ids, plus optional position overrides and region grouping; arrows connect element anchors | The Agent reasons in reading order and relationships instead of guessing pixel coordinates |
| **Q4** | Agent write path: granular per-op tools / transactional `board_apply(ops[])` / DSL source file / raw `fs` | **Transactional `board_apply` with expected-revision check**, plus `board_outline`, `board_read`, `board_render`, `board_query` | A 12-node diagram costs one tool call, not twelve; a stale write fails loudly instead of clobbering |
| **Q5** | Diagram engine and how render errors reach the Agent | **Mermaid** (parses in-process → structured `{line, column, message}`), errors surfaced as (i) in-place error cards, (ii) structured diagnostics in the tool result, (iii) a `board_render` dry-run, (iv) a post-render **geometric** check for overflow/clipping | Catches silent rendering mistakes, not just syntax errors — the part most projects skip |
| **Q6** | Durable representation: session storage + derived mirror / two-way file sync / workspace file as truth | **Session-owned storage as truth, plus a derived read-only `.dsh-superboard/boards/<sessionId>/` mirror**; no two-way sync in v1 | Git diffability without referee-ing conflicts against an Agent that also writes files. **Needs re-checking against S8** — see below. |
| **Q7** | User→Agent feedback: send immediately / stage into the composer draft / silent context attachment / polling bulletin | **Stage into the composer draft** as a visible, dismissable context object, with an explicit "send now" affordance | Prevents a turn per stray marquee; keeps selection a first-class object the user can see and remove |
| **Q8** | v1 scope: core canvas + tools / UML + error loop / PDF & image anchoring / git mirror / minimap | **v1 = core canvas + UML with the error loop.** PDF/image anchoring deferred to v1.5 | UML in v1 specifically because the error-feedback loop is most likely to reveal a wrong agent-facing model, and finding that early is worth more than PDF support |

### The one question S8 forces

**Q6 is now under-determined.** S8 says the log is the truth and plugin memory is a derived
cache, while Q6 proposed plugin-owned storage *as* the truth. The two candidate shapes:

- **Q6a — log-native.** The board is the fold of its own committed `board_apply` tool calls.
  Fully compliant; fork and resume work for free; "what the model saw" is provably the board.
  Cost: every edit is a tool call in the transcript, and the board cannot change without the
  Agent (or a user action routed through a tool) being the author.
- **Q6b — storage-owned.** The board lives in `ctx.storageDomain`; tool calls are the write
  path, and the log references revisions. Cheaper for large boards and for user-side edits
  made while the Agent is idle, but it is a cache by the framework's own definition, so a
  rebuild path from the log must exist anyway or the board is not reproducible from its
  session.

This is a **new round-2 question** and it should be answered before Q6 is treated as settled.
The pragmatic reading: Q6a is the honest default, and the *mirror* in Q6 is what absorbs the
"want a file to diff" need. Q6b only earns its complexity if board content becomes large enough
that log-folding is too slow, or if the user must be able to edit with no Agent involvement.

---

## Round-2 frontier (unblocked, not yet asked)

Recomputed after the API research. Each of these had an unsettled prerequisite in round 1.

1. **Storage shape** — Q6a vs Q6b (above). Now askable because S8 is known.
2. **Anchor representation.** How a pin is addressed (`element + logical position` vs
   `page-space coordinates` vs `pixel offsets`) is now askable, but only once Q3 fixes the
   element model. Depends on **Q3**.
3. **How the Agent learns *where* things are.** The Agent cannot see the canvas, so spatial
   reasoning is a model-design problem, not a rendering problem. Feeds Q4 and Q6.
4. **Right-pane chat embedding.** `sidebar.right.pane.tab` + the session standard kit
   (`useChat, useConversation, useSession, sessionId`) and the existing
   `sidebar.chat.conversation` slot suggest a plugin can host a real Conversation in a tab.
   Needs verification before Q1(a) can be promised. Depends on **Q1**.
5. **Minimap semantics** (U8). Live and navigable, or a static overview? Depends on **Q1**.
6. **Concurrency and revision model.** What happens when the Agent writes while the user is
   mid-edit, and what `board_apply`'s expected-revision check should compare. Depends on **Q4**.
7. **Board sizing and the context budget.** What "outline" means concretely, and how much of
   the board fits. Depends on **Q4** and **Q6**.
8. **Deferred subsystems** — PDF rasterization and page-space anchoring under S7, image
   pinning, git mirror, multi-page navigation UI. Depends on **Q8**.
9. **Packaging and install** — package name, whether the board ships as a bundle in this
   repo, how a user installs it, and what `Config` exposes. Depends on nothing but is low
   priority until the shape is fixed.

---

## Decision log

| Round | Date | Outcome |
|---|---|---|
| 1 | 2026-02 | Frontier mapped into 8 questions; API research landed mid-round and **S12 upgraded Q1's recommendation from phased to full-v1**, and **S8 split Q6 into a new Q6a/Q6b question**. Awaiting answers. |
