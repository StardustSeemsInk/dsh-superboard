# dsh-superboard — design tree

**Status: in progress — rounds 1 and 2 settled; round 3 open.**
This file is the working record of the design tree. It is not a specification until every
branch is marked settled and the user confirms shared understanding.

| Settled | Open |
|---|---|
| **Q1** board home · **Q2** renderer · **Q3** element model · **Q4** write path · **Q-A** who writes · **Q-B** v1 scope · **Q-C** pages · **Q-D** context injection | **Q7** feedback channel · layout engine · chat strip · addressing · revisions · arrow semantics · Q-F cross-conversation reuse |

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
| **U8** | *"对话框则变为可折叠的右侧边栏模块，且可以和画布互换主体（将对话UI还原，画布变成小地图）"* — chat becomes a collapsible right module, and the two can swap roles | **Superseded.** S13/S14 make it unachievable, and after Q-A it is also unnecessary: the board is a peer tab and doubles as a persistent display surface, so chat needs no demotion. |
| **U9** | Optional simpler path: the canvas lives inside the existing right sidebar, sharing the tab strip with browser and friends. | **Not taken** — it confines the board to a narrow column and abandons "the canvas replaces the conversation as the UI subject". |

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
| **S12** | Verified mechanism for the canvas as primary UI: `main` key `superboard` + a `sidebar.panellist` entry with the same `id`; `ctx.layout.selectPanel("superboard")` shows the canvas, `selectPanel(null)` restores the conversation | The `main`-panel route works mechanically — **but see S13/S14: it is the wrong route for this product.** |
| **S13** | The right sidebar is only shown while `activePanelId === null`: `show(layout.panelInfo.getSnapshot().activePanelId === null ? selected?.sessionId : void 0)` (`dsh-client-ui-sidebar-right/lib/client.js:9062`) | **Any plugin `main` panel auto-hides the right sidebar.** So "canvas in the centre + chat in the right pane" is impossible, and the Q1 option (a) from round 1 is dead. |
| **S14** | The main conversation **cannot** be embedded in a right-pane tab. It lives at `main` key `conversation`; a slot can be declared once (`dsh-client-ui-slots/lib/index.js:191-194`) and `renderSlot` only accepts keys the caller declared (`dsh-client-ui-renderer/lib/client.js:332`, `SlotOwnershipError`). The `sidebar.chat.conversation` slot belongs to `dsh-client-ui-subagent` and binds a **subagent child session**, not the main one. | "Chat becomes a collapsible right-sidebar module" is **not achievable within the framework.** Any chat surface on the board must be rendered by us from session data, not embedded. |
| **S15** | The conversation page's own tab strip is the `conversation.view` **list** slot: declared with `children: { "conversation.view": { kind: "list", scope: "session" } }` on `conversation.session` (`dsh-client-ui-conversation/lib/client.js:18209-18214`); enumerated as `slots.entries("conversation.view")` → `{id, label}` (`:17972-17984`); rendered as a `role="tablist"` of buttons when `tabs.length > 1` (`:16460`, `:16512-16526`); only the active view renders, via `renderSlot("conversation.view", props, { only: viewId })` (`:16412-16421`). The active view persists per session behind `readConversationViewPreference`/`activateView` (`:17985-17991`). Registration is a single ordinary `ctx.slots.register({ name: "conversation.view", id, order, label }, View)`. | **The board is a third tab, not a third panel.** One registration; DSH builds the tab button and the tab strip appears on its own. Because the main panel stays `conversation`, `activePanelId` stays `null` and the right sidebar keeps working. |

---

## Resolved — round 1

### Q1 — where the board lives · **SETTLED: a third `conversation.view` tab**

**Decision (user, after asking to look at the existing tab strip):** the board is added as a
view tab on the conversation page — the same strip that already holds *对话* and *轨迹* — and
the conversation simply stays in its own tab. The user also chose **B** on the follow-up: the
board carries its own **collapsible condensed chat strip**, since the right pane cannot host
the real conversation.

**Mechanism (verified, S15):**

```js
ctx.slots.inject("conversation.view", () => ctx.slots.register({
  name: "conversation.view",
  id: "board",
  order: 20,
  label: () => t("board"),
}, BoardView))
```

That is the whole integration. DSH builds the tab button, and `tabs.length > 1` turns the strip
on. Only the active view renders, so **the board unmounts when the user switches away** — which
is not a new cost, because the settled storage model (Q4: log-native) already requires all board
state to live outside React.

**Why the alternatives were rejected:**

- **Board as a `main` panel** — mechanically works (S12) but S13 kills it: a non-null
  `activePanelId` auto-hides the right sidebar, so U8's collapse behaviour dies with it.
- **Board in the right sidebar** (U9, the user's own simpler proposal) — works, but confines the
  board to a narrow column and abandons "the canvas replaces the conversation as the UI subject".
- **Chat in a right-pane tab** — impossible (S14).

**Consequences accepted:**

1. **U8 is partially unmet and cannot be met.** "Chat becomes a collapsible right-sidebar
   module" is not expressible in the framework (S14). Replaced by: chat and board are peer tabs,
   and the board provides a collapsible condensed chat strip of our own rendering.
2. **Chat and board are mutually exclusive** in view. The right sidebar remains available for the
   map, attachments, and file previews.
3. **Every board state change must survive unmount.** The board's React tree is disposable.

---

### Q4 — the Agent's write path · **SETTLED: log-native**

**Decision (user):** the board *is* the fold of its own committed `board_apply` tool calls.
Every edit is a tool call, therefore a committed session event, therefore replayable. A
read-only `.dsh-superboard/` mirror provides git diffability. No plugin-owned truth.

This is the compliant reading of S8, and it buys fork/resume/replay for free.

**The question it opens (was Q6, now Q-A below):** if the board is a fold over the Agent's tool
calls, then **what happens when the *user* edits the board directly?** A drag or an inline text
edit produces no tool call, so under a strict log-native model the user's edit is either not
durable or not authoritative. The two coherent answers are:

- **Agent-only writes.** The board is read-only to the user; every user gesture becomes input to
  the next message (a selection, a comment, an annotation), and only the Agent writes. Perfectly
  consistent with "log is truth". Cost: the user cannot tidy the board without asking.
- **User writes are also logged.** A user edit must then become a committed event, and the only
  appendable vocabulary is *existing* documented event types (S8) plus tool calls — so a direct
  edit has to be routed through a tool call (the client asks the host to invoke a tool) or
  written into `ctx.storageDomain` and reconciled. Consistent, but the "fold over tool calls"
  claim gets a second author and needs a reconciliation rule.

**This became Q-A, answered below (Agent-only writes).**

---

## Resolved — round 2

### Q2 — rendering technology · **SETTLED**

**Decision (user): own DOM/SVG layer.** A world-coordinate container with a CSS `transform`,
arrows as SVG paths, hand-written pan/zoom/marquee/selection. The scene model and the renderer
stay strictly separated, so the projection is replaceable later.

Rejected: **React Flow** (unresolved attribution/licensing posture, and a node-graph model that
fights a free canvas read), **Excalidraw** (free and MIT, but canvas-drawn text makes markdown
blocks, PDF pages, and images second-class, and UML could only arrive as `image` elements with
unselectable text).

### Q3 — element model · **SETTLED**

**Decision (user): block-flow-first with position overrides.** A page is an ordered list of typed
blocks (heading / prose / list / code / UML / image / PDF-page / group-container), each with a
stable id, plus an optional absolute position override and `region` grouping. Arrows connect
element anchors, not raw pixels. The Agent's canonical view of the board is reading order +
containment + edges.

### Q-B — v1 scope · **SETTLED: option A, the foundation**

Blocks (markdown) + arrows between block anchors + multi-page + marquee→feedback + the `board_*`
tool family + the collapsible condensed chat strip. **UML and the error-feedback loop are
explicitly not v1** — chosen against my recommendation, and the reasoning is sound: the
foundation has to be worth building on before the riskiest feature is bolted to it.

### Q-C — pagination · **SETTLED: explicit pages**

Pages are explicit objects the Agent creates, names, and reorders; the user can navigate them; a
page strip sits at the top of the board. Page names double as addresses, which matters for Q-D.

### Q-D — context injection · **SETTLED: standing outline + pull**

A small standing outline rides every request — which pages exist, which blocks each holds, which
arrows connect them, and which diagrams failed to render — while detail is pulled on demand
through `board_read`. The recommended implementation route for the standing part is
`ctx.systemPrompt.context()` (**per-step, recomputed**) rather than `.section()` (a prompt prefix,
which would break prompt-prefix caching). **Needs verification.**

### Q-A — who may write · **SETTLED: only the Agent**

**Decision (user): only the Agent can modify the board.** Every user gesture — marquee, comment,
arrow drawn by hand — becomes *input to the next message*, never a mutation. The user cannot drag,
retype, or delete.

The user's stated reason reframes the product:

> 这个相当于是提供一个持续向用户展示的面板（而且顺便还有一点点 Agent 记忆的效用），
> 不然很多查询类任务随着对话就会被滚动走，用户想去找还得慢慢翻 + 等对话历史加载。

**This is a product-level upgrade, not just a permission rule.** The board is simultaneously

1. the Agent's workspace, and
2. **a persistent display surface for the user** — answers to query-shaped tasks stay pinned
   instead of scrolling away into history that then has to be re-loaded.

Consequences:

- **U8 ("chat becomes a collapsible right sidebar module") is now genuinely unnecessary**, not
  merely unachievable (S14). The point of the swap was to give the board more room; a persistent
  display surface gets that by *being a separate tab*, and nothing is lost by chat staying in its
  own tab.
- **Readability is a first-class requirement**, on equal footing with editability. The board is
  read far more often than it is written, so layout quality is a feature, not polish.
- **Block alignment is a layout-template problem, not a user-editing problem.** Verbatim intent:
  *"对齐方式/排版模板之类的，进行自动对齐"* — borrow the approach GUI frameworks use. The Agent
  declares **structure and relationships**; a **layout template / auto-layout engine** decides
  geometry. This substantially raises the importance of the layout layer beyond round 1's
  assumption, and makes absolute positioning the exception rather than the default.
- **"A little bit of Agent memory"** is real but must not be over-claimed: the board is a view of
  the session, so it is exactly as durable as the conversation it belongs to. It is *not*
  project-level memory surviving into other conversations (U7). Whether the outline should be
  injectable into a *different* conversation is **Q-F** below.

---

## Open — Q7 (carried from round 1)

| # | Decision | ➡️ Recommendation | Status |
|---|---|---|---|
| **Q7** | User→Agent feedback channel: send immediately / stage into composer / silent attachment / bulletin | **Stage into the composer draft** as a visible, dismissable context object, with an explicit "send now" affordance | ❓ open |

### Q5 — diagram engine · **DEFERRED** (with PDF, per Q-B)

Recommendation on record for when it lands: **Mermaid** (parses in-process, so structured
`{line, column, message}` errors are available) with errors surfaced as (i) in-place error cards,
(ii) structured diagnostics inside the tool result, (iii) a `board_render` dry-run the Agent is
told to call first, and (iv) a post-render **geometric** check for overflow and clipping — the
last one is what catches silent rendering mistakes rather than mere syntax errors.

---

## Round-3 frontier

Recomputed after rounds 1–2. Prerequisites that were missing are now settled.

1. **Layout and auto-alignment engine.** Now the highest-value unknown, because Q-A made
   readability a first-class requirement. What does the Agent declare, what decides geometry, and
   what are the named templates ("排版模板")? Depends on **Q3** + **Q-A**, both settled.
2. **The condensed chat strip.** What it shows, how it reads live session data on the client, and
   what collapses it. Depends on **Q1**(b), settled.
3. **Addressability and naming.** How the Agent names and references blocks and pages
   (`page/block` slugs? generated ids?) — this is the substrate for both `board_apply` and the
   standing outline, so it gates Q4's and Q-D's concrete shapes. Depends on **Q3** + **Q-C**.
4. **Revision and concurrency.** What `board_apply`'s expected-revision check compares (a fold
   hash? a counter?), what happens on a stale write, and what the Agent is told. Depends on **Q4**.
5. **What "an arrow" means semantically.** A pure visual, or a typed relation the Agent can query
   ("what depends on X?")? This decides whether the board is a diagram or a knowledge graph, and
   it changes `board_query`'s whole reason to exist. Depends on **Q3**.
6. **Outline size and context budget.** How much board fits in a standing outline before it needs
   summarising or truncating. Depends on **Q-D**.
7. **Feedback-object shape.** What exactly a marquee produces as a message payload — ids, quoted
   text, a rendered snapshot image, or all three. Depends on **Q7**.
8. **Q-F — cross-conversation reuse.** Should a board (or its outline) be referenceable from
   another conversation? U7 says scope is the conversation; the user's "a little bit of memory"
   remark hints at wanting more. Real tension, worth asking rather than assuming.
9. **Deferred subsystems** — UML + error loop, PDF rasterization and page-space anchoring under
   S7, image pinning, git mirror, freeform layer.
10. **Packaging and install** — package name, how a user installs it, what `Config` exposes.
    Low priority until the shape is fixed.

---

## Decision log

| Round | Date | Outcome |
|---|---|---|
| 1 | 2026-02 | Frontier mapped to 8 questions. API research landed mid-round: S12 initially suggested the `main`-panel route, then S13/S14 killed it. **Q1 settled** — the board is a third `conversation.view` tab (the user's own suggestion, verified in the source). **Q4 settled** — log-native. |
| 2 | 2026-02 | **Q2** own DOM/SVG renderer · **Q3** block-flow model · **Q-B** v1 = foundation only · **Q-C** explicit pages · **Q-D** standing outline + pull. **Q-A settled: only the Agent writes**, which reframed the board as a *persistent display surface* and promoted layout/auto-alignment to the top of the frontier. Q7 carried over. |
