---
name: teaching-on-the-board
description: >-
  How to lay a lesson out on a board and how to write the material beside it: decide scope
  and verify page numbers before the first block, a map page first, one concept per block,
  one check question per block, one page per unit linked with `next` edges, and a Markdown
  write-up whose shape follows what the reader will do with it.
whenToUse: >-
  When the board is carrying a lesson or an explanation for someone learning the
  material, rather than a report of findings or a record of engineering work.
---

# Teaching on the board

A lesson has a different shape from a report or a project tracker: it is read once, in
order, by someone meeting the material for the first time. These are the practices that
held up when this was used to teach two TU/e courses end to end — a sixteen-unit graphics
course and a ten-unit networks course — with the values that were actually used rather than
the ones that sound reasonable.

Three rounds of first-hand records sit behind this, in `docs/suggestions/archive/`. Where a rule
below came from being wrong first, it says so. The rules are the live thing; the records are the
evidence, kept separate on purpose — tidying them into agreement would destroy what makes them worth
citing.

## Before the first block: scope, page numbers, and which shape

Nothing here is about explaining. It is about making sure the explaining is about the right
thing.

### Decide what is in scope, and put that decision on the map

If the material has a history — an older exam still circulating, a textbook edition that
differs from the slides, a deck that was revised — decide what is **in scope** before
teaching anything, and put the decision on the map page rather than in a footnote.

In one course this removed **48 of 110 exam points** from the revision load. That is not
teaching, and it was the single most valuable half hour of the term.

### Verify that a page number means what you think

A deck can carry a footer numbering that differs from its PDF page count, because deleted
slides leave no gap marker. One deck here had 103 PDF pages with footers running to 105:

```
Slide 2–6    → PDF page k
Slide 7–82   → PDF page k+1
Slide 84–105 → PDF page k+2
```

Every other deck was 1:1. **Check all of them, including the ones that turn out to be 1:1,
and record how you checked** — if you never verified, you cannot tell a 1:1 deck from an
unchecked one, and every 「slide p. X」 in the write-up is then wrong while looking normal.

### Extracted text is a hypothesis, not a source

A PDF's **own text layer** — not just OCR — corrupts exactly the characters a technical
question depends on. Measured corruption rates from one problem set:

| corruption | seen |
|---|---|
| `>` → `7` | ≥4 |
| `×` → `#` | 3 |
| `<` → `6` | 1 |
| figure axis labels spliced into the middle of the question | 1 |
| a whole code listing glued to the end of the question | 1 |
| running header glued to the end of the question | 2 |
| a forwarding table flattened to one line | 2 |

None of this raises an error. Render the page and read it before quoting anything carrying
a number, a formula, or a table. Watch those three character pairs specifically. A table
spanning more than two columns is almost always damaged — rebuild it from the image.

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

**Pause every two or three concept blocks, not once per unit.** A single question at the end
of a unit looks like compliance and tests almost nothing: the unit's one question may not
touch the block that was unclear, so a block that was taught badly produces no signal at
all. (Doing this wrong once was survivable only because the units were short.)

**Never put the solution's skeleton in the question.** Give the situation and the known
quantities only — no formula shape, no letters, no step order. A question that names the
matrix has already made the one choice it was meant to test.

A wrong answer is information about **your previous block**, not about the learner: it means
that block was too large. Split it and explain again with a different example.

## When the material contradicts itself

Adjacency with the source is not the goal; correctness is. When a slide contradicts its own
figure, or an answer key fails its own internal check, adjudicate with a third source, say
which way you ruled, and keep the correction in **one findable place** — not a footnote on
the page it came from.

**The answer key is a source, not the truth.** Official solutions get misprinted. One round
found **eight** printed errors across thirteen past papers, including one that was doubly
wrong: even using the coefficients the key itself printed, it does not produce the result the
key itself printed. Recompute from the definitions, verify against a second and independent
route (differentiate vs. eliminate the parameter; geometric vs. algebraic), and record the
correction.

**Never write an attribution you cannot produce.** No 「common solutions say」, no 「most
references give」. Either cite something checkable — a page number, a line number, a command
output — or say 「this is my inference」. A subagent on one round caught itself doing exactly
this and deleted the sentence, which is the behaviour to want.

## A blank area may be a rendering failure

A diagram can fail to render while every API call reports success. On this board a mermaid
label containing `<br/>` produced an **unclosed** `<br>` inside the XHTML `foreignObject`;
the SVG is then served as a strict-XML `data:` URL, the parse fails, and the image silently
never loads with **no diagnostic at all**. (Fixed in the renderer since, but the lesson
generalises.)

When something on the board looks empty, suspect the renderer before suspecting the content.
Keep mermaid labels on one line anyway; a `·` and brackets read better than a line break in
a node label.

## Explaining a concept: the four-step form

Every time you introduce a concept, work through these four steps in this order:

1. **Scenario, with real numbers.** Open on a concrete problem that needs the idea — "a
   surface's normal is 30° from the sun; how much light does it receive?" Never open with
   "let V be a vector".
2. **Work it out, or say what is missing without it.** Actually compute the example. Do not
   skip steps, and do not give the formula.
3. **Name it — now.** Only here do the term and the formula appear. The name is a label for
   something the learner already understands.
4. **One use.** A single sentence on where it shows up later. Not a list.

The commonest failure is compressing all four into one sentence — a term, a formula, several
uses and a citation at once. That is a manual page, and it does not land even when every
fact in it is correct.

Two hard rules on notation: **every symbol is explained the first time it appears** (what it
is, how it is measured, what units it carries) before it goes into a formula, and **one use
per concept**. And when the learner asks what something *is*, answer **that** — answering
which convention is correct is a different question and does not satisfy it.

## What the write-up is for decides its shape

Two requests sound alike and are not:

- **"explain this to me"** → the reader wants to UNDERSTAND. Scenario, worked number, then
  the name, then one use. That is the four-step form above.
- **"show me how to solve this"** → the reader wants to REPRODUCE it under exam conditions.
  Numbered steps with the arithmetic visible, then the answer, then the same steps in the
  exam's language.

Answering the second with the first form is the failure mode, and it is expensive: it
produces an explanation of **why the answer is correct**, which the reader can follow and
cannot reproduce. Twenty-three worked solutions were rewritten because of it. The reader's
words: 「你给的讲解基本上是类似于『证明为什么答案是对的』，但是我需要的是『如何推导/解答以得到答案』」.

Check for it mechanically: if a "derivation" contains 「substituting gives」 or 「it is easily
seen」 without a numbered step that does the substitution, it is the wrong form. A checker
that verifies the answer instead of deriving it is a post-mortem — readable, and useless to
someone who has to walk the route themselves.

### The worked-solution shape

```
**怎么下手**   1–2 sentences: seeing which word in the question should trigger which tool
**推导**       numbered steps, each with its arithmetic visible
**答案**       the answer, at the end, once
**English solution**   the SAME numbered steps in the exam's language
**Answer**     the answer again
```

**「怎么下手」 is its own block and cannot be absorbed into the derivation.** It answers a
retrieval question: in the first ten seconds, which word in the question maps to which tool.
It is not background and not a definition — if it grows into either, it belongs elsewhere.

| seeing this in a question | reach for this |
|---|---|
| `tangent direction` | differentiate; constrains direction only (1 DOF) |
| `tangent vector` | differentiate; constrains magnitude too (2 DOF) |
| `degrees of freedom` | (control points × 2) − constraints already used |
| `passes through the centre` | ⚠ often an identity for a Bézier — cannot fix the parameter |
| `N tiles across the width` | decide which parameter N maps to, then `s = N·(u−u₀)/(u₁−u₀)` |
| `orthogonal projection onto a plane` | normal first, then `M = I − nnᵀ/(n·n)` |

### Bilingual means step-aligned, not summarised

If the exam is in English and the reader studies in another language, the English must be
laid out against **the same numbered steps**, not summarised at the end. The reader copies
the English step for step in the exam hall; a paragraph cannot be copied step by step.

    Bad:   **English model answer**
           The tangent must be parallel to AD, so we differentiate and solve.

    Good:  **English solution**
           1. We have P₀ = A and P₃ = C.
           2. Differentiating the cubic Bézier gives P'(t) = …
           3. At t = 1/2 all three weights equal 3/4, so …

An `English model answer` paragraph is the English of the **answer**, not of the **process**.
Having that box ticked on a checklist is exactly how 「指标通过但目标未达」 happens.

### Guard rails belong where the reader already has a path

An 「易错」 paragraph is valuable once the reader knows the route and needs its edges. Before
the route exists, a list of ways to fail raises anxiety rather than lowering it. **Keep these
in concept chapters; do not require them in worked solutions.** A uniformly formatted 易错
section on every worked solution — even one full of genuine traps — is the part readers skip.

But keep a numeric check at the end of any algebra: in one round, **all three** wrong student
answers were wrong in the last step (units, over-simplification, no table) and none was wrong
in the approach. "Recheck the magnitude after every derivation" is a revision action worth
ten seconds.

### Budget the smallest repeatable unit, not the file

State the length limit **per smallest unit** — per sub-question, per block — and let the file
length follow from the count. "60–100 lines per question" is ambiguous when questions have one
to six sub-questions, and a range the exemplar itself violates is not a budget: it is a trap
that makes every writer look non-compliant. (Once, three writers were all "over budget" and
none of them was: the exemplar ran 44 lines per sub-question against a 60–100 per *question*
spec.)

### Freeze the shape on one example before delegating

When several units are written in parallel, write ONE unit to the agreed shape, show it, and
only then fan out. A wrong shape multiplied by four writers is four rewrites, and the
writers' work is not the expensive part — re-reading and re-verifying it is. One round lost
882 lines plus a round from each of three writers to a spec that had never been shown.

## One document, two shapes, on purpose

A single write-up may legitimately mix two forms, because different parts serve different
reading:

| part | form | why |
|---|---|---|
| body, concept chapters | four-step: scenario → worked number → name → one use | the reader is putting a **concept** together |
| check questions at the end | how-to-start → derivation → answer → English steps | the reader will perform this **sequence** in an exam |
| past-paper solutions | question, translation, derivation, English | checking work against a paper |
| full-course summary | neither — dense reference | rereading, not learning |

**Do not "unify" the body into the exercise form.** That is not consistency; it is turning a
concept chapter into a procedure chapter the reader did not ask for. The test for each part
is still: *what will the reader do with this?*

Ask before converting a body section. Offered exactly this change, the reader said: 「不加。
单元讲义的正文是为了理解知识，不是为了理解怎么答题。」

## Two artifacts

The board is the lesson as it happens. A Markdown document is what survives it — write each
unit out as a standalone file beside its page, without waiting to be asked. Measured over two
courses, the write-up was rated higher than the live explanation was, and by the end the
learner had read every unit file and asked for the remaining exercises to be turned into
documents too: 「我没有精力做了」 is a request for something readable offline, not for more
interaction.

**So get the document right on the first version.** A unit write-up and an exercise solution
are different artifacts:

- **Unit**: four-step explanations, an 「容易搞错」 paragraph per section that explains *why*
  the mistake happens, a hand-computable check question, and a 考点 list.
- **Exercise**: the **verbatim original question**, its **translation**, then the working,
  then a model answer in the exam's own language.

Put the original text in from the first version, whenever the material has one. A solution
that omits it will be sent back — once, twice, and then you will have rebuilt it anyway.

## Before you assert something, decide whether it has an answer a machine can compute

This was the highest-value change in one whole round. Every real mistake that round was the
same shape: **a claim that was never checked**, not an arithmetic slip.

- 「guessing has zero expected value」 — false once a grade floor exists; the floor lifts it
  above zero.
- 「the retransmitted packet is outside the receiver's window」 — false for `N = 3, k = 2`;
  the window wraps and the packet is accepted as new, so the rule is `N ≤ 2^(k−1)`.

Neither was an error in reasoning. Both were statements written down without being computed.
**The test for whether to check is simple: does the sentence have an answer a script or a
hand calculation could produce? If yes, produce it.** This covers 「is X in the set」,
「what order of magnitude」, 「does this algorithm degenerate」, and any number at all.

## Mechanics

Everything above is a decision the board already supports:

- `set_layout` on a page: `masonry` + `cols`, or `grid` + `areas` for tabular material.
- `pdf-page` blocks for source pages, with `board_read` for the per-line rectangles.
- `add_edge` with `rel: 'next'` between unit pages.
- `uml` blocks for the map and for structure; the board renders the mermaid itself.

The `board-layout` skill has the full template vocabulary, including how a `group` arranges
its own children.
