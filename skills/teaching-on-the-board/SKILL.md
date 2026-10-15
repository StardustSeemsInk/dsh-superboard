---
name: teaching-on-the-board
description: >-
  How to lay a lesson out on a board: a map page first, one concept per block, a
  check question at the end of each, one page per unit linked with `next` edges,
  and a Markdown write-up beside it.
whenToUse: >-
  When the board is carrying a lesson or an explanation for someone learning the
  material, rather than a report of findings or a record of engineering work.
---

# Teaching on the board

A lesson has a different shape from a report or a project tracker: it is read once, in
order, by someone meeting the material for the first time. These are the practices that
held up when this was used to teach a sixteen-unit course, with the values that were
actually used rather than the ones that sound reasonable.

## The map comes first

Before the first concept, put the shape of the topic on its own page: the few things the
subject is made of, and how they relate. A `uml` flowchart or a `list` block is usually
enough. Keep it to one screen — it is what the learner navigates by, so it has to be
legible at a glance, not exhaustive.

## One concept per block, one unit per page

- **A block is one idea.** If a `prose` block wants a second heading inside it, it is two
  blocks.
- **A page is one unit of the course**, not the course. A page that scrolls for three
  screens is a wall, and the learner stops reading it.
- **Link the units with `next` edges.** That is what makes the pages a course rather than a
  pile: the learner can see where they are and what comes next.

## `masonry cols=2` is the right default for a lecture page

Concept blocks differ a lot in height, and a fixed grid leaves holes under the short ones.
`masonry` fills those holes, so a page of uneven explanations still reads as a column of
material instead of a checkerboard.

    set_layout  scope=<page>  template=masonry  cols=2

Reach for `grid` with `areas` only when the material is genuinely tabular — a comparison, a
schedule — where a row has to line up with its neighbours.

## Put the source page beside the explanation

When the material is a slide deck or a problem set, attach the page as a `pdf-page` block
next to the explanation rather than telling the learner to go open the PDF. `board_read` on
a `pdf-page` block returns its text layer with a normalized rectangle per line, which is how
you point at one line of the original while unable to see it — an anchor of
`{ kind: 'lines', from, to }` or `{ kind: 'rect', … }` on that block.

The same move rescues a bad source. If the original page contains the confusion — a label
that contradicts its own figure, say — do not reproduce it. Draw the comparison yourself and
attach the original beside it, so the learner can see both.

## A check question belongs at the end of its block

One question per concept, then stop and wait for the answer. A question with a numeric
answer tells you *which step* went wrong; a question that asks for a definition only tells
you the learner has not memorised it, which you already knew.

A wrong answer is information about **your previous block**, not about the learner: it means
that block was too large. Split it and explain again with a different example.

## Two artifacts

The board is the lesson as it happens. A Markdown document is what survives it — write each
unit out as a standalone file beside its page, without waiting to be asked. Measured in
practice, the write-up was rated higher than the live explanation was.

## Mechanics

Everything above is a decision the board already supports:

- `set_layout` on a page: `masonry` + `cols`, or `grid` + `areas` for tabular material.
- `pdf-page` blocks for source pages, with `board_read` for the per-line rectangles.
- `add_edge` with `rel: 'next'` between unit pages.
- `uml` blocks for the map and for structure; the board renders the mermaid itself.

The `board-layout` skill has the full template vocabulary, including how a `group` arranges
its own children.
