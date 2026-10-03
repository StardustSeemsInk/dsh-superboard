# dsh-superboard

An agent-editable canvas for [DeepSeek Harness](https://github.com/deepseek-ai) — a **superboard** that replaces the conversation box as the primary UI surface.

The canvas is where the Agent thinks: markdown blocks, arrows for relationships, rendered diagrams (UML and friends), pinned PDF pages and images. The chat is still there, but as a collapsible right-hand sidebar you can swap with the canvas.

> **Status: design phase.** No implementation yet. The design tree lives in [`docs/design/`](docs/design/), and it is being settled by interview before any code is written.

## The idea

Today the conversation transcript *is* the interface. Every diagram, plan, and relationship the Agent reasons about has to be expressed as prose in a scrolling column. `dsh-superboard` inverts that:

- **The canvas is the subject.** One board per conversation, many pages per board.
- **The Agent edits it directly** through tools — it never sees pixels, it reads and writes a structured scene model.
- **The user points at things** — marquee a region, draw an arrow, drop a pin — and that becomes grounded context for the next message.
- **The Agent is told when it drew something wrong.** Diagram render failures are returned as structured diagnostics instead of silently corrupting the board.
- **Content is pulled, not pushed.** The Agent queries the board outline and reads only the regions it needs; the whole scene is never dumped into context.

## Layout

```
docs/design/        the design tree — decisions and their rationale
docs/research/      API research against the real DSH implementation
scripts/            developer tooling (reference extraction, verification)
src/                plugin source (host half + client half)
```
