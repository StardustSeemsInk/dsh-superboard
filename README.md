# dsh-superboard

An agent-editable canvas for [DeepSeek Harness](https://github.com/deepseek-ai) — a **superboard** that replaces the conversation box as the primary UI surface.

The canvas is where the Agent thinks: markdown blocks, arrows for relationships, rendered diagrams (UML and friends), pinned PDF pages and images. The chat is still there, but as a collapsible right-hand sidebar you can swap with the canvas.

> **状态：M0 骨架已落地。** 设计阶段四轮访谈已完成并封口——15 条决定在 [`docs/design/design-tree.md`](docs/design/design-tree.md)，可照着实现的契约在 [`docs/design/board-model.md`](docs/design/board-model.md)，已验证的框架约束在 [`docs/research/dsh-plugin-contract.md`](docs/research/dsh-plugin-contract.md)，里程碑与验收标准在 [`docs/design/build-plan.md`](docs/design/build-plan.md)。

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

