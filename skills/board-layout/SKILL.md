---
name: board-layout
description: How a board actually renders — card height, row-major filling, when a heading and its list become two separate cards, what a group buys you, and every field whose visual effect is not what its name suggests. Read this before writing or rearranging more than a couple of blocks.
whenToUse: Before laying out a board, choosing a layout template, or reorganising a page whose arrangement looks wrong.
---

# Laying out a board

A board is a tree of blocks, and the Agent declares the structure while the engine decides the
geometry. That works only if you know what the engine does with what you declared — you cannot see
the canvas, and a plausible-looking structure can render badly in ways no error message mentions.

This skill is that missing feedback. Read it before you lay out anything non-trivial.

## The one rule that explains most ugly boards

**Every block is its own card.** A card has a border, a slug label, and a kind badge. Nothing
groups blocks visually unless you say so.

So this is wrong, and it is the single most common mistake:

```
add_block heading text "Keep unchanged"
add_block list    items [...]
```

That renders **two separate bordered cards**, each with its own slug and its own `HEADING` / `LIST`
badge, and nothing to say they belong together. The heading and its list will also drift apart the
moment the layout reflows.

Wrap them instead:

```
add_block group children ["keep", "keep-list"] layout { template: "flow" }
```

A `group` is the only thing that draws one box around several blocks. Use it for every heading +
content pair, and for any set of blocks that is one unit of meaning.

## Templates, and what each one actually does

| Template | What it renders as | Fields it reads |
|---|---|---|
| `flow` | A vertical stack. The default. | `gap` |
| `row` | A horizontal run that wraps. Direct cards share the width; a `group` child sizes to its content instead. | `gap` |
| `columns` | A grid of `cols` equal columns. **Filled row-major**, not column-by-column. | `cols` (default 2), `gap` |
| `grid` | Cards that fill the width. `minCardWidth` sets the floor; `areas` names cells instead. | `minCardWidth` (default 260), `cols`, `areas`, `gap` |
| `masonry` | A waterfall. Cards keep their own height and fill the columns in order. | `cols`, or `minCardWidth`, `gap` |
| `canvas` | A plain box. Arranges nothing and positions nothing. | `gap` |

### Choosing between `grid` and `masonry`

A `grid` row is as tall as its tallest card, so a short card beside a long one leaves a hole
underneath it. A `masonry` card keeps its own height, and the next card flows into the shortest
column — the Pinterest / 小红书 shape.

**Reach for `masonry` when your cards have very different heights** (a one-line note next to a long
analysis). Reach for `grid` when they are roughly uniform, or when you want named cells.

`masonry` fills **column by column** once the content is taller than one column, so reading order
is down each column rather than across each row. Do not use it for content whose order matters.

### `areas`: named cells

On a `grid`, `areas` says which child occupies which cells, which is how you get a spanning header
or a sidebar. One string per row, whitespace-separated, `.` for a hole:

```
areas: ["nav body body", "nav side foot"]
```

Rows are separated by newlines or `/`. Every row needs the same number of cells, and one name must
fill a solid rectangle. A cell is a child reference (slug, id, or retired alias).

`areas` replaces `cols` and `minCardWidth` — passing both is refused rather than reconciled.

**Name every child you care about.** Unnamed children still flow into whatever cells are left, in
row-major order, so an unnamed heading can land in a leftover hole far from its list.

## Traps worth knowing by name

**Cards are not stretched by default.** They were once — a grid with an explicit `cols` used to make
every card in a row as tall as the tallest, so a one-line card became a large empty box with its
text at the top. That only happens now with `areas`, where a named cell is a slot by definition.
If you want equal heights, use `areas`; otherwise heights are natural.

**`columns` is not columns of content.** It is a row-major grid of N equal columns. With
`cols: 2` and six blocks you get three rows of two, not three blocks stacked in each of two
columns. It also collapses to a single column on a narrow pane — the canvas width is not something
you can see, so never rely on a particular column count.

**`canvas` is not a free canvas.** Nothing on the board has coordinates. `canvas` is a plain box
for sectioning; its children stack vertically with the normal spacing and nothing is positioned.
Do not reach for it to place anything.

**A `region` does not wrap anything.** It tints each member's own card and adds a label chip. It is
annotation: members that sit far apart in a grid stay far apart. Use a `group` when you want one
visible box.

**Adjacency is not ownership.** Under `grid`, `columns`, `row` and `masonry`, the number of columns
depends on the window width and the reading column, both of which change as the user drags things.
"The block after this one sits beside it" is true only until the next reflow. Express ownership
with a `group`, never by putting blocks next to each other.

**Arrows are faint, and their labels are hover-only.** An edge is a 1.5px line in the muted text
colour. Its `label` renders as a tooltip on that line, and `rel` (`depends`, `causes`, …) has no
visual effect at all — it is metadata for `board_query`. Put any words the reader needs into a
block, not into `label`.

**An edge shows only when both endpoints are on the page you are looking at.** Cross-page edges and
edges to a deleted block are simply not drawn, with no marker. Keep a connected structure on one
page, or accept that the arrows read as absent.

## Write for the reader, not for the model

The board has a second purpose: it is what the user reads. A few consequences:

- **Put the title in `group.title`**, not in a `heading` block whose only job is a title above a
  group. A group's title renders inline with its head; a separate heading card is chrome.
- **An empty body still renders a card.** A block with `text: ""`, `markdown: ""`, or `items: []`
  shows its slug and kind around nothing. Do not create a block to hold a placeholder.
- **`prose` is one paragraph unless you give it structure.** Consecutive newlines, `#`, `-`/`1.`,
  `>`, fenced code, and pipe tables *with a separator row* all become real block structure. A wall
  of text with single newlines stays a wall of text with single newlines.
- **Only a little inline markdown is interpreted**: `**bold**`, `*em*`, `` `code` ``, and
  `[text](url)` for http/https/mailto/fragment targets. Anything else stays literal. Block-level
  syntax like `# x` is only parsed inside `prose` — a `heading` block's `text` is a heading field,
  not markdown.

## Fields that do nothing

Do not spend effort on these; they are accepted and stored but have no visual effect:

`collapsed` (on `prose` and `group`), `checked` (on list items), `naturalSize`, `crop`, and
`waypoints` on edges. Groups never collapse, and a list item's `checked` renders as a plain bullet.

## Before you call `set_layout`

1. Is every heading grouped with the blocks it governs? If not, group it first.
2. Do the cards have very different heights? If so, `masonry`, not `grid`.
3. Do you actually need named cells? If so, `areas`, and name every child.
4. Are you relying on two blocks being adjacent? Replace that with a `group`, or it will break on
   the next reflow.
5. Does the page have edges? If the structure is about relationships, draw them — a board with
   zero edges has no arrow layer at all.
