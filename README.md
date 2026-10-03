# dsh-superboard

An agent-editable canvas for [DeepSeek Harness](https://github.com/deepseek-ai) — a **superboard** that replaces the conversation box as the primary UI surface.

The canvas is where the Agent thinks: markdown blocks, arrows for relationships, rendered diagrams (UML and friends), pinned PDF pages and images. The chat is still there, but as a collapsible right-hand sidebar you can swap with the canvas.

> **状态：v1 里程碑全部完成。** 82 个测试通过，已装进 desktop profile。
> 设计阶段四轮访谈见 [`docs/design/design-tree.md`](docs/design/design-tree.md)（15 条决定），
> 可照着实现的契约在 [`docs/design/board-model.md`](docs/design/board-model.md)，
> 已验证的框架约束在 [`docs/research/dsh-plugin-contract.md`](docs/research/dsh-plugin-contract.md)，
> 里程碑与验收标准在 [`docs/design/build-plan.md`](docs/design/build-plan.md)。

## v1 交付的能力

- **多页看板**，层级是**对话**（一个对话一块看板）
- **八种 markdown 块**：标题 / 正文 / 列表 / 代码 / UML（数据就位，渲染推迟）/ 图片 / PDF 页 / 分组
- **语义箭头**：有方向、可查询（`board_query` 能回答「谁依赖 X」）、可选类型与标签
- **模板优先排版**：Agent 只声明结构与关系，`flow` / `grid` / `columns` 决定几何
- **框选反馈托盘**：拖框选中 → 写下问题 → 可逐个删除的草稿，**永不代替用户发送**
- **四个工具**：`board_outline` / `board_read` / `board_apply` / `board_query`，`board_apply` 是唯一写入口并带 revision 闸
- **常驻大纲**：每步注入一段小大纲，细节由 Agent 按需拉取
- **可折叠对话条**：与看板**同屏**，显示 Agent 状态与最新消息

## 刻意推迟（已设计，未实现）

UML 渲染与错误反馈回路 · PDF 栅格化与页空间锚定 · 图片钉住 · Agent 主动发起的位图查询 · `.dsh-superboard/` 只读镜像。

## ⚠️ 唯一未完成的验收

**视觉与交互确认需要一个真人刷新页面。** 静态验证（语法、DSH 自己的 schema 校验器、端到端数据流、宿主导入）全过，但「标签页出不出现、看板画得对不对、框选手感如何」只有用户能确认。


## 安装（开发期）

本仓库直接作为 DSH bundle 装进某个 profile。在 DSH 里用 `plugin_manager` 的 `install_bundle`，目标写本目录：

```
file:E:/Dev/dsh-superboard
```

它会向该 profile 的 `package.json` 写入 `file:` 依赖、把 `dsh-superboard` 追加到 `dsh.profile.bundles`，并把 `node_modules/dsh-superboard` 链接到本目录。**改完源码在浏览器里刷新页面即可生效**，不需要重装。

卸载：从 profile 的 `dsh.profile.bundles` 与 `dependencies` 里移除 `dsh-superboard` 那一行，重跑一次 pnpm install。

**注意**：`file:` 依赖在启用时会追加到 bundle 列表末尾，而这会改变配置优先级——这是 DSH 已知的行为。

## 目录结构


## The idea

Today the conversation transcript *is* the interface. Every diagram, plan, and relationship the Agent reasons about has to be expressed as prose in a scrolling column. `dsh-superboard` inverts that:

- **The canvas is the subject.** One board per conversation, many pages per board.
- **The Agent edits it directly** through tools — it never sees pixels, it reads and writes a structured scene model.
- **The user points at things** — marquee a region, draw an arrow, drop a pin — and that becomes grounded context for the next message.
- **The Agent is told when it drew something wrong.** Diagram render failures are returned as structured diagnostics instead of silently corrupting the board.
- **Content is pulled, not pushed.** The Agent queries the board outline and reads only the regions it needs; the whole scene is never dumped into context.

## Layout

```
src/index.js          host half — apply(ctx), the board fold, the board_* tools
src/client.js         client half — served as-is; registers the 看板 tab
cordis.patch.yml      inserts this bundle into a profile's layer stack
docs/design/          the design tree, the model contract, the build plan
docs/research/        verified constraints and API research against real DSH 0.2.0-rc.2
scripts/              developer tooling (reference extraction)
```

Two deliberate constraints on the source, both from `docs/research/dsh-plugin-contract.md`:

- **No build step yet.** The client half is hand-written browser JavaScript using
  `React.createElement` — `dsh.client` serves `src/client.js` literally, so what you edit is
  what runs. A bundler only becomes necessary when something must be code-split (the UML
  chunk) or type-checked.
- **`.ref/` is gitignored.** It holds read-only extracts of the official packages the
  research was verified against. Regenerate with `node scripts/extract-dsh-ref.mjs`.

