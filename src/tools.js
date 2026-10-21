/**
 * The Agent's tool surface.
 *
 * Five tools, deliberately. Every tool costs prompt budget, and a model picks correctly from
 * five far more reliably than from twelve. Page and block creation are *ops* of
 * `board_apply`, not tools of their own, so "make a page, put three blocks on it, connect two
 * arrows" is one transaction, one revision, and one round trip.
 *
 * `board_import` is the fifth and the only one that reads a session other than the calling one;
 * it earns its place because "bring that board over" is a request the other four cannot express
 * at all. It reuses `board_apply`'s commit path rather than adding a second write route.
 *
 * The design goal behind the shapes here is **error prevention**, not just capability:
 *
 *   - `board_apply` is the only write path, and it requires `expected_revision`. The Agent
 *     does not remember a version number; it copies the one it just saw in a result. A stale
 *     copy fails loudly instead of clobbering.
 *   - Every result carries the current `rev` and the **actually assigned** slugs, because
 *     "you asked for `风险-1` but got `风险-2`" is information the Agent can only learn from us.
 *   - A failed batch reports nothing-applied, the current rev, the offending `op[i]`, the
 *     reason, the legal values, and the next step — in that order.
 *   - Empty query results return a hint rather than "0 hits", because the value of an empty
 *     answer is entirely in what it suggests doing next.
 *
 * @module dsh-superboard/tools
 */

import { BoardOpError, applyOps, previewRevision, OP_NAMES } from './fold.js'
import { importOps, readSourceBoard } from './import.js'
import { EDGE_RELS, LAYOUT_TEMPLATES, parseRevSeq } from './model.js'
import { renderTextTable } from './pdf.js'
import { blockIndex } from './runtime.js'
import {
  arrayOf,
  bool,
  closedObject,
  defineBoardTool,
  int,
  num,
  oneOfStrings,
  openObject,
  opBranch,
  str,
  textResult,
} from './schema-dsl.js'

/** How long a rendered outline may get before it starts truncating. */
const OUTLINE_DEFAULT_CHARS = 6000
const OUTLINE_MAX_CHARS = 24000

/** How many blocks a single page may contribute to the outline before it summarises. */
const OUTLINE_BLOCKS_PER_PAGE = 24

/**
 * What each layout template means, in the words the Agent gets.
 *
 * This table exists because the templates were, until now, bare names in an enum: the only
 * statement of what `row` or `columns` did lived in a source comment in `model.js`, which the
 * Agent never reads. A model that cannot tell those two apart picks one and learns from the
 * rendering — a round trip spent on something a sentence prevents.
 *
 * The keys are checked against `LAYOUT_TEMPLATES` by the suite, so a template cannot be added,
 * renamed or removed without this text following it.
 */
export const TEMPLATE_MEANING = Object.freeze({
  flow: 'a vertical stack, the default',
  row: 'a horizontal run that wraps',
  columns: 'a fixed number of equal columns (set cols)',
  grid: 'cards that fill the width (set minCardWidth), or named cells with spans (set areas)',
  masonry:
    'a waterfall: cards keep their own height and fill the columns in order (set cols, or ' +
    'minCardWidth to let the width decide)',
  canvas: 'a plain box that arranges nothing — a section, not a surface to position in',
})

/** The template list spelled out for a description string, e.g. `flow: a vertical stack, the default`. */
const TEMPLATE_HELP = LAYOUT_TEMPLATES.map((name) => `${name}: ${TEMPLATE_MEANING[name]}`).join('; ')

/**
 * The in-block half of an edge endpoint.
 *
 * Nine kinds, none of them guessable from `{ blockId, at }` alone — which is all the field used
 * to say, so "point this arrow at line 12 of that code block" was a capability the Agent could
 * not know existed. The fold already rejects a kind that does not suit the target's block kind
 * and names what would (`validateAnchor` in `fold.js`), so this text only has to make the
 * vocabulary visible; after that, a wrong guess is instructive instead of mysterious.
 */
const ANCHOR_HELP =
  'A block reference, or { blockId, at } to aim at a part of it. at is ' +
  "{ kind: 'block' } for the whole block, or { kind: 'field', field }, " +
  "{ kind: 'item', itemId }, { kind: 'lines', from, to }, { kind: 'text', start, end }, " +
  "{ kind: 'child', childId }, { kind: 'node', key }, { kind: 'rect', x, y, w, h } or " +
  "{ kind: 'point', x, y }. " +
  "A `node` key is one the diagram itself names: board_read of a `uml` block lists them after " +
  'the source, and a key that is not on that list is still accepted — the list is what the block ' +
  'says its parts are, not a set of restrictions.'

/**
 * The `at` union.
 *
 * A `oneOf` of `const`-discriminated branches rather than one object with a `kind` enum and
 * every field optional. The loose form would accept `{ kind: 'item' }` with no `itemId`, and the
 * rejection would then have to come from the fold — one round trip later, in a message the model
 * has no reason to connect to what it just wrote. Here it is refused at the call, with the field
 * named.
 */
const ANCHOR_AT = {
  description: 'Which part of the block to aim at. Omit for the whole block.',
  oneOf: [
    closedObject({ kind: { const: 'block', type: 'string' } }, ['kind']),
    closedObject(
      {
        kind: { const: 'field', type: 'string' },
        field: oneOfStrings('Which named field of the block.', ['title', 'code', 'caption', 'filename']),
      },
      ['kind', 'field'],
    ),
    closedObject(
      {
        kind: { const: 'item', type: 'string' },
        itemId: str('A list item id, as board_read prints it.'),
      },
      ['kind', 'itemId'],
    ),
    closedObject(
      {
        kind: { const: 'lines', type: 'string' },
        from: int('First line, 1-based.'),
        to: int('Last line, inclusive.'),
      },
      ['kind', 'from', 'to'],
    ),
    closedObject(
      {
        kind: { const: 'text', type: 'string' },
        start: int('First character offset.'),
        end: int('Last character offset.'),
        quote: str('What you expect that range to say. A mismatch is reported, never rejected.'),
      },
      ['kind', 'start', 'end'],
    ),
    closedObject(
      {
        kind: { const: 'child', type: 'string' },
        childId: str('The child block to aim at.'),
      },
      ['kind', 'childId'],
    ),
    closedObject(
      {
        kind: { const: 'node', type: 'string' },
        key: str('A node key the diagram itself names.'),
      },
      ['kind', 'key'],
    ),
    closedObject(
      {
        kind: { const: 'rect', type: 'string' },
        x: num('Left edge, 0-1 within the block.'),
        y: num('Top edge, 0-1 within the block.'),
        w: num('Width, 0-1 within the block.'),
        h: num('Height, 0-1 within the block.'),
      },
      ['kind', 'x', 'y', 'w', 'h'],
    ),
    closedObject(
      {
        kind: { const: 'point', type: 'string' },
        x: num('X, 0-1 within the block.'),
        y: num('Y, 0-1 within the block.'),
      },
      ['kind', 'x', 'y'],
    ),
  ],
}

/**
 * One edge endpoint.
 *
 * The string form is what every existing edge uses and what `board_read` prints, so it has to
 * keep working; the object form is the same string plus somewhere inside the block to land. A
 * `oneOf` is legal here because the branches cannot both match — one demands a string, the other
 * an object — and it is the only spelling DSH's subset allows, since type arrays are rejected
 * (`schema-dsl.js:13-16`).
 */
function endpoint(description) {
  return {
    description,
    oneOf: [
      { type: 'string' },
      closedObject(
        {
          blockId: str('Block to anchor to: slug, id, or retired alias.'),
          at: ANCHOR_AT,
        },
        ['blockId'],
      ),
    ],
  }
}

/**
 * The points an arrow should be forced through.
 *
 * The coordinate space is the box spanning both endpoints, normalised to `[0,1]` — the space
 * `docs/design/board-model.md:340` fixes, and the only one an Agent can reason about without
 * seeing the canvas, because it moves with the two blocks instead of naming pixels that a reflow
 * would invalidate.
 */
function waypointList() {
  return arrayOf(
    'Points the arrow must pass through, in order, each { x, y } normalised to the box spanning ' +
      'both endpoints. Omit to let the renderer pick its own curve.',
    closedObject({ x: num('X, 0-1 across the endpoint box.'), y: num('Y, 0-1 down it.') }, ['x', 'y']),
  )
}

// ---------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------

/**
 * Resolve a reference string to an element.
 *
 * Order is `id → slug → alias`, and an ambiguous alias fails with the candidates listed
 * rather than picking one: silently guessing would move an arrow to a place the Agent did
 * not ask for, and it would look like success.
 *
 * @param model - the board model.
 * @param ref - a slug, id, or former slug.
 * @param kind - `'page'`, `'block'`, `'edge'`, or `'region'`; omitted searches every kind.
 * @returns `{ kind, element, page }`, or `undefined` when nothing matches.
 * @throws {BoardOpError} when the reference is ambiguous.
 */
export function resolveRef(model, ref, kind = undefined) {
  const needle = String(ref).normalize('NFC')
  const pools = (kind === undefined ? ['page', 'block', 'edge', 'region'] : [kind]).map((each) => ({
    kind: each,
    entries: enumerate(model, each),
  }))

  for (const pool of pools) {
    const hit = pool.entries.find((entry) => entry.element.id === needle)
    if (hit !== undefined) return { kind: pool.kind, ...hit }
  }
  for (const pool of pools) {
    const hits = pool.entries.filter((entry) => entry.element.slug === needle)
    if (hits.length > 1) {
      throw new BoardOpError(
        `reference ${JSON.stringify(needle)} is ambiguous between ${hits
          .map((hit) => hit.element.id)
          .join(', ')}`,
      )
    }
    if (hits.length === 1) return { kind: pool.kind, ...hits[0] }
  }
  for (const pool of pools) {
    const hits = pool.entries.filter((entry) => (entry.element.alias ?? []).includes(needle))
    if (hits.length > 1) {
      throw new BoardOpError(
        `reference ${JSON.stringify(needle)} matches several retired addresses: ${hits
          .map((hit) => `${hit.element.id} (now ${hit.element.slug})`)
          .join(', ')}. Use a current slug or an id.`,
      )
    }
    if (hits.length === 1) return { kind: pool.kind, ...hits[0] }
  }
  return undefined
}

/** Enumerate elements of one kind, carrying the owning page for blocks. */
function enumerate(model, kind) {
  switch (kind) {
    case 'page':
      return model.pages.map((element) => ({ element }))
    case 'block':
      return model.pages.flatMap((page) =>
        page.blocks.map((element) => ({ element, page, siblings: page.blocks })),
      )
    case 'edge':
      return model.edges.map((element) => ({ element }))
    case 'region':
      return model.regions.map((element) => ({ element }))
    default:
      return []
  }
}

/**
 * Describe a block in one line, for the outline.
 *
 * This is what the Agent reads instead of the board, so it has to answer "is this the block I
 * mean" without quoting the whole thing.
 *
 * @param block - the block.
 * @returns a short, type-aware label.
 */
export function blockPreview(block) {
  switch (block.kind) {
    case 'heading':
      return `h${block.level} ${flatten(block.text)}`
    case 'prose':
      return flatten(block.markdown)
    case 'list':
      return `${block.ordered ? 'ordered' : 'unordered'} list, ${block.items.length} item(s): ${flatten(block.items[0]?.text ?? '')}`
    case 'code':
      return `code${block.lang === '' ? '' : ` ${block.lang}`}${block.filename === undefined ? '' : ` (${block.filename})`}, ${block.code.split('\n').length} line(s)`
    case 'uml':
      return `${block.engine} ${block.diagram}, ${block.source.split('\n').length} line(s)`
    case 'image':
      return `image ${block.src}${block.alt === '' ? '' : ` — ${flatten(block.alt)}`}`
    case 'pdf-page':
      return `pdf ${block.src} page ${block.page}`
    case 'group':
      return `group of ${block.children.length}${block.title === undefined ? '' : ` — ${flatten(block.title)}`}`
    default:
      return block.kind
  }
}

/** First line, trimmed and shortened. */
function flatten(value, max = 72) {
  const first = String(value ?? '').split('\n')[0].trim()
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`
}

/**
 * Render the outline text.
 *
 * The same renderer backs both `board_outline` and the standing prompt context, on purpose: if
 * the two disagreed, the Agent would have to learn two formats for one board.
 *
 * @param doc - the board document.
 * @param options - optional page filter, section filter, and character budget.
 * @returns `{ text, truncated, omitted }`.
 */
export function renderOutlineText(doc, options = {}) {
  const model = doc.model
  const include = options.include ?? 'all'
  const budget = Math.min(Number(options.maxChars ?? OUTLINE_DEFAULT_CHARS) || OUTLINE_DEFAULT_CHARS, OUTLINE_MAX_CHARS)

  // A board nobody has written to has nothing worth saying, so it says almost nothing. But it must
  // not say *nothing*: `board_apply` and `board_import` both require `expected_revision`, and this
  // is where it is meant to come from. An outline of a fresh board that returned an empty string
  // left the Agent with no legal way to learn the revision — it had to guess `r0-…`, and one real
  // run guessed it correctly and then reported that `board_outline` "returned no text (twice)".
  // One line is the cheapest possible fix: the rev, and the fact that the board is empty.
  //
  // The per-step injected outline (`index.js`) keeps the silent behaviour, because there the text
  // costs prompt budget on every request of every conversation that never opens the tab — that
  // caller passes `silentWhenEmpty: true`.
  const hasContent = model.pages.some((page) => page.blocks.length > 0) || model.edges.length > 0
  if (!hasContent && doc.lastOpError === undefined) {
    if (options.silentWhenEmpty !== false) return { text: '', truncated: false }
    return {
      text:
        `Board "${model.title}" — ${model.rev}\n` +
        `the board is empty. Pass ${model.rev} as expected_revision to add the first block, ` +
        'or to import a board from another conversation.',
      truncated: false,
    }
  }

  let pages = model.pages
  if (options.page !== undefined) {
    const found = resolveRef(model, options.page, 'page')
    if (found === undefined) {
      throw new BoardOpError(
        `no page matches ${JSON.stringify(options.page)}. Known pages: ${model.pages
          .map((page) => page.slug)
          .join(', ')}`,
      )
    }
    pages = [found.element]
  }

  const lines = []
  if (include === 'all' || include === 'pages' || include === 'blocks') {
    lines.push(`Board "${model.title}" — ${model.rev}`)
    lines.push(`${model.pages.length} page(s), ${model.edges.length} edge(s)`)
    lines.push('')
  }

  if (include === 'all' || include === 'pages' || include === 'blocks') {
    for (const page of pages) {
      const layout = page.layout === undefined ? '' : `  [layout: ${page.layout.template}]`
      lines.push(`page ${page.slug}${layout}  (${page.blocks.length} block(s))`)
      if (include === 'pages') continue
      for (const block of page.blocks.slice(0, OUTLINE_BLOCKS_PER_PAGE)) {
        const region = block.regionId === undefined ? '' : `  {${regionSlug(model, block.regionId)}}`
        lines.push(`  ${block.slug}  [${block.kind}]${region}  ${blockPreview(block)}`)
      }
      if (page.blocks.length > OUTLINE_BLOCKS_PER_PAGE) {
        lines.push(`  … ${page.blocks.length - OUTLINE_BLOCKS_PER_PAGE} more block(s); use board_read`)
      }
    }
  }

  if (include === 'all' || include === 'edges') {
    if (model.edges.length === 0) {
      if (include === 'edges') lines.push('no edges')
    } else {
      if (lines.length > 0 && include !== 'edges') lines.push('')
      for (const edge of model.edges) {
        const rel = edge.rel === undefined ? '' : ` ${edge.rel}`
        const label = edge.label === undefined ? '' : `  "${edge.label}"`
        const dangling = isDangling(model, edge) ? '  ⚠ dangling' : ''
        lines.push(`${slugOf(model, edge.from.blockId)} -[${edge.slug}${rel}]-> ${slugOf(model, edge.to.blockId)}${label}${dangling}`)
      }
    }
  }

  // Three ways an element is known to be broken, printed in one section. The Agent is told the
  // same thing either way — the element is not on the board, and why.
  const renderReports = options.renderReports ?? []
  const pdfFacts = options.pdfFacts ?? []
  const failedFacts = pdfFacts.filter((fact) => fact.status === 'failed')
  if (
    (include === 'all' || include === 'diag') &&
    (Object.keys(doc.diag ?? {}).length > 0 || renderReports.length > 0 || failedFacts.length > 0)
  ) {
    lines.push('')
    lines.push('render failures:')
    for (const report of renderReports) {
      lines.push(`  ${report.blockSlug}  RENDERER: ${report.message}`)
    }
    for (const fact of failedFacts) {
      lines.push(`  ${fact.blockSlug}  ${fact.code}: ${fact.message}`)
    }
    for (const diagnostic of Object.values(doc.diag)) {
      lines.push(`  ${diagnostic.blockSlug}  ${diagnostic.code}: ${diagnostic.message}`)
    }
  }

  if (doc.lastOpError !== undefined) {
    lines.push('')
    lines.push(`the last board_apply was rejected and changed nothing: ${doc.lastOpError.message}`)
  }

  const joined = lines.join('\n')
  if (joined.length <= budget) return { text: joined, truncated: false }

  const kept = []
  let used = 0
  for (const line of lines) {
    if (used + line.length + 1 > budget) break
    kept.push(line)
    used += line.length + 1
  }
  return {
    text: `${kept.join('\n')}\n… truncated at ${budget} characters`,
    truncated: true,
    omitted: `${lines.length - kept.length} line(s) omitted`,
  }
}

/** The current slug of a block id, or the id itself when it no longer exists. */
function slugOf(model, blockId) {
  for (const page of model.pages) {
    for (const block of page.blocks) if (block.id === blockId) return block.slug
  }
  return blockId
}

/** The current slug of a region id. */
function regionSlug(model, regionId) {
  return model.regions.find((region) => region.id === regionId)?.slug ?? regionId
}

/**
 * Whether an edge has lost an endpoint.
 *
 * Derived rather than stored: a stored flag would be a second source of truth that could
 * disagree with the model, and the model can always answer this.
 */
export function isDangling(model, edge) {
  const exists = (blockId) =>
    model.pages.some((page) => page.blocks.some((block) => block.id === blockId))
  return !exists(edge.from.blockId) || !exists(edge.to.blockId)
}

// ---------------------------------------------------------------------------
// Tool 1 — board_outline
// ---------------------------------------------------------------------------

const outlineTool = defineBoardTool({
  name: 'board_outline',
  description:
    'Read the board outline: pages, their blocks (slug, kind, one-line preview), the directed ' +
    'edges between them, and any blocks that failed to render. A short outline is also injected ' +
    'into your context every step, but it is truncated when the board is large — call this tool ' +
    'before editing a board you have not read this turn. The rev it returns is what you pass as ' +
    'expected_revision to board_apply.',
  parameters: closedObject(
    {
      page: str('Optional page reference (slug or id). Omit for every page.'),
      include: oneOfStrings('Sections to include. Defaults to all.', ['all', 'pages', 'blocks', 'edges', 'diag']),
      maxChars: int(`Soft cap on the returned text (default ${OUTLINE_DEFAULT_CHARS}, max ${OUTLINE_MAX_CHARS}).`),
    },
    [],
  ),
  outputSchema: closedObject(
    {
      rev: str('Current board revision.'),
      title: str('Board title.'),
      pages: arrayOf(
        'Pages in order.',
        closedObject(
          {
            id: str('Stable page id.'),
            slug: str('Current page address.'),
            blocks: arrayOf(
              'Blocks in reading order.',
              closedObject(
                {
                  id: str('Stable block id.'),
                  slug: str('Current block address.'),
                  kind: str('Block kind.'),
                  preview: str('One-line preview.'),
                  region: str('Owning region slug, when the block belongs to one.'),
                },
                ['id', 'slug', 'kind', 'preview'],
              ),
            ),
            layout: str('Layout template in force for this page.'),
          },
          ['id', 'slug', 'blocks'],
        ),
      ),
      edges: arrayOf(
        'Directed edges.',
        closedObject(
          {
            id: str('Stable edge id.'),
            slug: str('Edge address.'),
            from: str('Source block address.'),
            to: str('Target block address.'),
            rel: str('Relationship, when declared.'),
            label: str('Free-text label, when declared.'),
            dangling: bool('True when an endpoint block no longer exists.'),
          },
          ['id', 'slug', 'from', 'to'],
        ),
      ),
      diag: arrayOf(
        'Render failures.',
        closedObject({ block: str('Block address.'), code: str('Failure code.'), message: str('Explanation.') }, [
          'block',
          'code',
          'message',
        ]),
      ),
      truncated: bool('Whether the text was cut short.'),
      omitted: str('What was left out, when truncated.'),
      // Declared because `executeOutline` returns it and `additionalProperties: false` makes an
      // undeclared field a failed call, not an ignored one. Read, apply and query all declare
      // theirs; this one was the omission that made every board_outline call fail in a live
      // session while the whole suite stayed green.
      text: str("Rendered outline, also returned as this tool's content."),
    },
    ['rev', 'title', 'pages', 'edges', 'diag', 'truncated', 'text'],
  ),
  render: (_args, value) => textResult(value.text),
})

// ---------------------------------------------------------------------------
// Tool 2 — board_read
// ---------------------------------------------------------------------------

const readTool = defineBoardTool({
  name: 'board_read',
  description:
    'Read the full content of pages, blocks, edges, or regions. Use this when you need actual ' +
    'text — to quote it, rewrite it, or check a field value to patch — rather than the outline ' +
    'preview. Accepts slugs, ids, and former slugs. It never guesses: an unknown or ambiguous ' +
    'reference fails and lists the candidates.',
  parameters: closedObject(
    {
      refs: arrayOf('Page, block, edge, or region references. Mixing kinds is allowed.'),
      depth: oneOfStrings("How much context to include. Defaults to 'block'.", ['block', 'page', 'region']),
      format: oneOfStrings("Output format. Defaults to 'markdown'.", ['markdown', 'json']),
    },
    ['refs'],
  ),
  outputSchema: closedObject(
    {
      rev: str('Current board revision.'),
      format: str('Format actually used.'),
      resolved: arrayOf(
        'What each reference resolved to.',
        closedObject(
          {
            ref: str('The reference as given.'),
            kind: str('Element kind.'),
            id: str('Stable id.'),
            slug: str('Current address.'),
          },
          ['ref', 'kind', 'id', 'slug'],
        ),
      ),
      text: str('The requested content.'),
    },
    ['rev', 'format', 'resolved', 'text'],
  ),
  render: (_args, value) => textResult(value.text),
})

/**
 * Collect every reason a block is known to be broken, for the Agent.
 *
 * Three sources, presented identically, because to the Agent they are one thing — *this element is
 * not on the board, and here is why*. They differ only in how the reason was found:
 *
 *   - the **host lint** is a prediction made while folding, so it is part of the projection and
 *     survives replay;
 *   - a **render report** is an observation the browser sent after actually trying, which is the
 *     more specific of the two and is therefore listed first;
 *   - a **parse fact** is the host's own asynchronous look at a file on disk (`src/pdf.js`), which
 *     is the only one of the three that can tell a password-protected PDF from a missing file, or
 *     say how many pages a document has.
 *
 * @param doc - the board document.
 * @param renderReports - live reports from the board view, if any.
 * @param pdfFacts - live parse facts, if any.
 * @returns `(blockId) => string[]`.
 */
function failureNotes(doc, renderReports, pdfFacts = []) {
  const notes = new Map()
  const push = (blockId, line) => {
    const list = notes.get(blockId)
    if (list === undefined) notes.set(blockId, [line])
    else list.push(line)
  }
  for (const report of renderReports ?? []) {
    push(report.blockId, `⚠ the board renderer reported a failure: ${report.message}`)
  }
  for (const fact of pdfFacts ?? []) {
    if (fact.status !== 'failed') continue
    push(fact.blockId, `⚠ this PDF page cannot be read (${fact.code}): ${fact.message}`)
  }
  for (const diagnostic of Object.values(doc.diag ?? {})) {
    push(
      diagnostic.blockId,
      `⚠ this diagram does not parse (${diagnostic.code}, first failing at ${diagnostic.firstFailedAtRev}): ${diagnostic.message}`,
    )
  }
  return (blockId) => notes.get(blockId) ?? []
}

/** Render one resolved element as markdown, at the requested depth. */
function renderElementMarkdown(model, found, depth, noteFor = () => [], factFor = () => undefined) {
  const element = found.element
  switch (found.kind) {
    case 'page': {
      const header = `# page ${element.slug}  (${element.id})`
      if (depth === 'page' || depth === 'region') {
        const blocks = element.blocks.map((block) => renderBlock(block, noteFor(block.id), factFor(block.id))).join('\n\n')
        return `${header}\n\n${blocks}`
      }
      return `${header}\n\n${element.blocks.length} block(s): ${element.blocks.map((block) => block.slug).join(', ')}`
    }
    case 'block':
      return renderBlock(element, noteFor(element.id), factFor(element.id))
    case 'edge':
      return [
        `edge ${element.slug}  (${element.id})`,
        `${slugOf(model, element.from.blockId)} → ${slugOf(model, element.to.blockId)}`,
        `rel: ${element.rel ?? '(none)'}`,
        `label: ${element.label ?? '(none)'}`,
        isDangling(model, element) ? '⚠ dangling: an endpoint no longer exists' : '',
      ]
        .filter((line) => line !== '')
        .join('\n')
    case 'region': {
      const header = `region ${element.slug}  (${element.id})${element.label === undefined ? '' : ` — ${element.label}`}`
      const members = element.blockIds.map((id) => slugOf(model, id)).join(', ')
      if (depth === 'region') {
        const bodies = element.blockIds
          .map((id) => model.pages.flatMap((page) => page.blocks).find((block) => block.id === id))
          .filter((block) => block !== undefined)
          .map((block) => renderBlock(block, noteFor(block.id), factFor(block.id)))
          .join('\n\n')
        return `${header}\nmembers: ${members}\n\n${bodies}`
      }
      return `${header}\nmembers: ${members}`
    }
    default:
      return JSON.stringify(element, null, 2)
  }
}

/** Render one block as markdown, with its address so the Agent can patch it. */
function renderBlock(block, notes = [], fact = undefined) {
  const head = `▸ ${block.slug}  [${block.kind}]  (${block.id})`
  const tail = notes.length === 0 ? '' : `\n${notes.join('\n')}`
  switch (block.kind) {
    case 'heading':
      return `${head}\n${'#'.repeat(block.level)} ${block.text}${tail}`
    case 'prose':
      return `${head}\n${block.markdown}${tail}`
    case 'list':
      return `${head}\n${block.items
        .map((item, index) => `${'  '.repeat(item.depth)}${block.ordered ? `${index + 1}.` : '-'} ${item.text}`)
        .join('\n')}${tail}`
    case 'code':
      return `${head}\n\`\`\`${block.lang}${block.filename === undefined ? '' : ` ${block.filename}`}\n${block.code}\n\`\`\`${tail}`
    case 'uml': {
      // The node table, when this file could read one out of the source. It is the whole reason a
      // diagram is not a black box: `{kind: 'node', key}` anchors name one of these, and without
      // the list the model would be guessing at keys it wrote several turns ago.
      const nodes = Array.isArray(block.nodeHints) && block.nodeHints.length > 0
        ? `\nnodes: ${block.nodeHints.map((node) => (node.label === node.key ? node.key : `${node.key}=${node.label}`)).join(' · ')}`
        : ''
      return `${head}\n\`\`\`${block.engine} (${block.diagram})\n${block.source}\n\`\`\`${nodes}${tail}`
    }
    case 'image':
      return `${head}\nsrc: ${block.src}\nalt: ${block.alt}${block.caption === undefined ? '' : `\ncaption: ${block.caption}`}${tail}`
    case 'pdf-page': {
      // The text layer, with each line's rectangle. This is the whole point of the host parsing
      // the file at all: the Agent has to name a rectangle to highlight, and it cannot see the
      // page. `board_read` is where it goes to find one, because the outline rides every request
      // and a page of text would swamp it.
      const table = fact === undefined ? '' : renderTextTable(fact)
      return `${head}\nsrc: ${block.src}\npage: ${block.page}${block.caption === undefined ? '' : `\ncaption: ${block.caption}`}${
        table === '' ? '' : `\n${table}`
      }${tail}`
    }    case 'group':
      return `${head}\ntitle: ${block.title ?? '(none)'}\nchildren: ${block.children.join(', ')}${tail}`
    default:
      return `${head}\n${JSON.stringify(block, null, 2)}${tail}`
  }
}

// ---------------------------------------------------------------------------
// Tool 3 — board_apply
// ---------------------------------------------------------------------------

/**
 * The op vocabulary as a discriminated union.
 *
 * This is the compiled JSON Schema form `ctx.tools.register` expects. Two decisions worth
 * stating, because both are traps:
 *
 *   - **`op` is a `const` discriminator, not an `enum`.** `oneOf` requires exactly one branch
 *     to match; an `enum` discriminator can match several and fail the walk with an error the
 *     model cannot act on.
 *   - **`add_block` and `update_block` are single branches.** Splitting `add_block` by `kind`
 *     would force every shared optional field (`slug`, `after`, `region`, `note`) to be
 *     redeclared in all eight branches, and one omission would reject a legal call. Instead
 *     `kind` is an enum inside one branch, and "did you supply the fields this kind needs" is
 *     checked in `execute`, where the error message can name the kind, its required fields,
 *     and an example.
 */
function operationSchema() {
  // Fields shared by every add_block kind, all optional here and enforced per kind in execute.
  const kindFields = {
    text: str('heading: the heading text.'),
    level: int('heading: 1, 2, or 3. Defaults to 2.'),
    markdown: str('prose: block-level markdown.'),
    items: arrayOf('list: the items, in order.'),
    ordered: bool('list: numbered rather than bulleted.'),
    code: str('code: the source text.'),
    lang: str('code: language hint for highlighting.'),
    filename: str('code: file name or origin.'),
    source: str('uml: the diagram source.'),
    engine: oneOfStrings('uml: rendering engine. Defaults to mermaid.', ['mermaid', 'plantuml']),
    diagram: oneOfStrings('uml: diagram type, used in the outline and diagnostics.', [
      'flowchart',
      'sequence',
      'class',
      'state',
      'er',
      'gantt',
      'other',
    ]),
    src: str('image and pdf-page: file path.'),
    alt: str('image: alternative text, also used to derive the slug.'),
    caption: str('image and pdf-page: caption.'),
    // Named `pdfPage`, not `page`, because `page` on this branch already means "the page this
    // block belongs to" (a slug). One name cannot be both a slug and a page number.
    pdfPage: int('pdf-page: 1-based page number.'),
    crop: closedObject(
      {
        x: num('pdf-page: left edge, 0-1 of the page.'),
        y: num('pdf-page: top edge, 0-1 of the page.'),
        w: num('pdf-page: width, 0-1 of the page.'),
        h: num('pdf-page: height, 0-1 of the page.'),
      },
      ['x', 'y', 'w', 'h'],
      'pdf-page: show only this rectangle of the page. Normalised anchors on the block are ' +
        'relative to it, so naming a figure here also moves what an arrow can point at.',
    ),
    title: str('group: container title.'),
    children: arrayOf('group: block references on the same page. Groups may nest.'),
    layout: closedObject(
      {
        template: oneOfStrings(`How this group arranges its children. ${TEMPLATE_HELP}.`, [...LAYOUT_TEMPLATES]),
        params: openObject(
          'Template parameters, such as { cols: 2 } or { minCardWidth: 240 }. A grid also takes ' +
            '{ areas }: named cells, one string per row, whitespace-separated. A cell is a child ' +
            'slug, or "." for an empty cell. "arch arch|tests ." puts arch across the top and tests ' +
            'below it. Every row needs the same number of cells, and one name must fill a solid ' +
            'rectangle. areas replaces cols and minCardWidth rather than combining with them.',
        ),
      },
      ['template'],
      'group: how this container arranges its children. Omit to use the default flow.',
    ),
  }

  return {
    type: 'array',
    // No `minItems`: it is outside DSH's enforced subset, and an empty batch is legal anyway
    // (it is a no-op that reports `changed: false`).
    items: {
      oneOf: [
        opBranch('add_page', { page: str('New page slug or title.'), after: str('Insert after this page.') }, ['page']),
        opBranch('rename_page', { page: str('Page to rename.'), slug: str('The new slug.') }, ['page', 'slug']),
        opBranch('reorder_pages', { order: arrayOf('Every page reference, exactly once, in the wanted order.') }, ['order']),
        opBranch('delete_page', { page: str('Page to delete.'), force: bool('Delete even though blocks and edges are affected.') }, ['page']),
        opBranch(
          'add_block',
          {
            page: str('Owning page reference.'),
            kind: oneOfStrings('Block kind.', [
              'heading',
              'prose',
              'list',
              'code',
              'uml',
              'image',
              'pdf-page',
              'group',
            ]),
            slug: str('Preferred address. A suffix is added when taken.'),
            after: str('Insert after this block.'),
            region: str('Region to join. A region is a label and a border over blocks; it arranges nothing. Use a group to arrange.'),
            note: str('Short human-readable note; not part of the board content.'),
            ...kindFields,
          },
          ['page', 'kind'],
        ),
        opBranch(
          'update_block',
          {
            block: str('Block to update.'),
            slug: str('Rename the block to this address.'),
            note: str('Short human-readable note.'),
            ...kindFields,
            // `page` is accepted here as an alias of `pdfPage`: on this branch there is no
            // owning-page field to collide with, and "update the page number" is the phrasing
            // a model reaches for.
            page: int('pdf-page: 1-based page number. Alias of pdfPage.'),
            anchors: arrayOf('Block-internal anchors.', openObject('An anchor.')),
          },
          ['block'],
        ),
        opBranch('move_block', { block: str('Block to move.'), page: str('Destination page.'), after: str('Insert after this block.') }, ['block', 'page']),
        opBranch('delete_block', { block: str('Block to delete.'), recursive: bool('For a group, delete its children too.') }, ['block']),
        opBranch(
          'add_edge',
          {
            from: endpoint(`Source endpoint. ${ANCHOR_HELP}`),
            to: endpoint(`Target endpoint. ${ANCHOR_HELP}`),
            rel: oneOfStrings('Relationship type. Omit for a plain visual arrow.', [...EDGE_RELS]),
            label: str('Free-text label, shown on the arrow.'),
            style: oneOfStrings('Arrow style.', ['solid', 'dashed', 'dotted']),
            waypoints: waypointList(),
            slug: str('Preferred edge address.'),
          },
          ['from', 'to'],
        ),
        opBranch(
          'update_edge',
          {
            edge: str('Edge to update.'),
            rel: oneOfStrings('New relationship type.', [...EDGE_RELS]),
            label: str('New label.'),
            style: oneOfStrings('New style.', ['solid', 'dashed', 'dotted']),
            from: endpoint('New source endpoint.'),
            to: endpoint('New target endpoint.'),
            waypoints: waypointList(),
          },
          ['edge'],
        ),
        opBranch('delete_edge', { edge: str('Edge to delete.') }, ['edge']),
        opBranch(
          'set_layout',
          {
            scope: str('Page or group reference. A region carries no layout — it only labels blocks.'),
            template: oneOfStrings(`Layout template. ${TEMPLATE_HELP}.`, [...LAYOUT_TEMPLATES]),
            cols: int('columns and masonry: how many equal columns.'),
            gap: int('Spacing between cards, in pixels.'),
            minCardWidth: int('grid and masonry: minimum card width, in pixels. Not with areas.'),
            // One string per row. The fold also accepts a single string with rows separated by `/`
            // or newline, but DSH's validator rejects a `type` array, so the schema declares the one
            // shape and the fold stays the more permissive of the two.
            areas: arrayOf(
              'grid: named cells, one string per row, whitespace-separated. A cell is a child slug ' +
                'or "." for empty. All rows need the same cell count, and one name must fill a solid ' +
                'rectangle. Not with cols or minCardWidth.',
            ),
          },
          ['scope', 'template'],
        ),
        opBranch(
          'set_region',
          {
            region: str('Region to update. Omit to create one.'),
            blockIds: arrayOf(
              'The complete membership list. A block belongs to at most one region, so this ' +
                'replaces the previous membership rather than adding to it.',
            ),
            label: str('Region label.'),
            tone: oneOfStrings('Visual tone.', ['neutral', 'warn', 'danger', 'ok']),
          },
          ['blockIds'],
        ),
        opBranch('delete_region', { region: str('Region to delete. Its blocks stay.') }, ['region']),
      ],
    },
  }
}

const applyTool = defineBoardTool({
  name: 'board_apply',
  // Writes must be serialised. This does not slow down ordinary sequential tool use; it only
  // stops the scheduler from dispatching two board writes in parallel.
  isConcurrencySafe: () => false,
  description:
    'Apply a batch of board edits atomically. This is the ONLY way to change the board. ' +
    'Every call must carry expected_revision, copied from your most recent board_outline, ' +
    'board_read, or board_apply result; if another write landed since, nothing is applied and ' +
    'you get the current revision back, so re-read and re-issue.\n\n' +
    'Ops run in array order and the first failure aborts the whole batch with no state change. ' +
    'Reference pages and blocks by slug or id. Layout is the engine\'s job, and it is the ' +
    'container\'s job rather than the block\'s: a page or a group declares how it arranges its ' +
    'children, and no block carries a coordinate.',
  parameters: closedObject(
    {
      expected_revision: str("The rev string from your most recent board_* result, e.g. 'r17-a3f9c2b1d4e5'."),
      ops: {
        ...operationSchema(),
        description: `Ordered operations (${OP_NAMES.join(', ')}). Applied in order; the first failure aborts the batch.`,
      },
      note: str('One short line describing this batch. Shown in the transcript, not on the board.'),
    },
    ['expected_revision', 'ops'],
  ),
  outputSchema: closedObject(
    {
      ok: bool('Always true on success; failures throw.'),
      rev: str('The revision the board was at when this batch was accepted.'),
      pending_rev: str(
        'The revision this batch will settle at. A preview: read board_outline for the authoritative value.',
      ),
      changed: bool('False for an empty batch, which is legal and does nothing.'),
      applied: int('How many ops were applied.'),
      created: arrayOf(
        'Elements this batch created, by the address the fold assigned them.',
        closedObject(
          {
            kind: str('page, block, edge, region, or item.'),
            slug: str(
              'The address actually assigned, which may carry a suffix. Refer to the element by this ' +
                'in later ops. It is derived from the model rather than from the call, so unlike an ' +
                'id it is already exact here.',
            ),
          },
          ['kind', 'slug'],
        ),
      ),
      renamed: arrayOf(
        'Elements this batch renamed.',
        closedObject(
          {
            id: str('The element id, which a rename preserves and which pre-dates this batch.'),
            from: str('Previous address.'),
            to: str('New address.'),
          },
          ['id', 'from', 'to'],
        ),
      ),
      warnings: arrayOf('Things you should know, such as a slug that was already taken.'),
      dangling: arrayOf('Edges left pointing at a deleted block.'),
      pages: arrayOf('Page addresses in their new order.'),
      text: str("Human-readable summary, also returned as this tool's content."),
    },
    ['ok', 'rev', 'pending_rev', 'changed', 'applied', 'created', 'renamed', 'warnings', 'dangling', 'pages', 'text'],
  ),
  render: (_args, value) => textResult(value.text),
})

/**
 * Run one batch and describe the outcome.
 *
 * The work is a dry run over a clone of the current model, so a batch that fails any op leaves
 * the live board untouched without needing any rollback. The fold applies the same batch again
 * when it sees the committed call.
 *
 * The two runs do **not** agree on element ids: an id is a hash of `(sessionId, callSeq, opIndex,
 * kind)` and only the committed run knows its real `seq`. The dry run's ids are stand-ins, and
 * they must not leave this function — see I8 in `docs/design/board-bugs.md`. Slugs, by contrast,
 * are derived from the model, so the dry run's slugs are the ones the board will carry. That is
 * why everything reported back to the Agent is addressed by slug.
 *
 * @param doc - the current board document.
 * @param args - `{ expected_revision, ops, note }`.
 * @returns the structured outcome, which DSH validates and hands to `render`.
 */
function executeApply(doc, args) {
  const model = doc.model

  // The same comparison the fold makes, and for the same reason: only the sequence half is stable
  // across a model-version bump. Two gates that disagree are worse than one — the tool would report
  // success and the fold would silently drop the batch. See `applyOps` in `src/fold.js`.
  if (parseRevSeq(args.expected_revision) !== parseRevSeq(model.rev)) {
    throw new BoardOpError(
      `stale board revision: expected ${args.expected_revision} but the board is now ${model.rev}.\n` +
        'Nothing was applied. Call board_outline to see the current state, then re-issue the ops you still want.',
    )
  }

  const before = snapshotIndex(model)
  let next
  try {
    next = applyOps(structuredClone(model), args.ops, {
      sessionId: doc.sessionId,
      // The dry run cannot know the seq the committed call will settle at, so element ids
      // derived here are indicative only. The fold derives the authoritative ones.
      callSeq: 'dry-run',
      callerRev: model.rev,
      expectedRevision: args.expected_revision,
      // I9: the only place a batch can still be refused. `commit` re-folds the log and must not
      // re-litigate what it finds there, so the model invariants are checked here and nowhere else.
      validateInvariants: true,
    })
  } catch (error) {
    if (!(error instanceof BoardOpError)) throw error
    throw decorateOpError(error, args.ops, model.rev)
  }

  const after = snapshotIndex(next)

  // I8. The dry run mints element ids from a stand-in callSeq, so an id derived here is not the id
  // the fold will assign — and two of them can collide. Keying the diff by id made that worse than
  // a wrong field: a minted id that happened to equal a live block's id overwrote that block's
  // entry, so the genuinely new block was reported as *not* created and the untouched live block
  // was reported as renamed. Nothing reported back to the Agent carries a dry-run id at all now;
  // what it carries is addresses, which the fold derives from the model rather than the seq.

  // A rename keeps its id, and that id was minted by an *earlier* committed call, so here it is
  // authoritative. The fold retires the old address into `alias` (`src/fold.js:870`), and that is
  // what separates a true rename from the one false positive a collision can still produce: a
  // brand-new element whose stand-in id happened to equal a live one's looks like a rename of it,
  // but its `alias` cannot name an address it never had.
  const renamed = []
  for (const [id, entry] of after.byId) {
    const previous = before.byId.get(id)
    if (previous === undefined || previous.slug === entry.slug) continue
    if (!entry.alias.includes(previous.slug)) continue
    renamed.push({ id, from: previous.slug, to: entry.slug })
  }

  // Everything else whose address is new. A rename's *new* address is new too, so those come out.
  const renamedTo = new Set(renamed.map((entry) => entry.to))
  const created = []
  for (const [slug, entry] of after.bySlug) {
    if (before.bySlug.has(slug) || renamedTo.has(slug)) continue
    created.push({ kind: entry.kind, slug })
  }

  const warnings = warningsFor(before, created, args.ops)
  const dangling = next.edges.filter((edge) => isDangling(next, edge)).map((edge) => edge.slug)
  const pages = next.pages.map((page) => page.slug)

  // A preview: the sequence number is exact, the hash cannot be until the call settles.
  const pendingRev = previewRevision(model, args.ops, { sessionId: doc.sessionId })
  const text = renderApplySummary({
    pendingRev,
    applied: args.ops.length,
    created,
    renamed,
    warnings,
    dangling,
  })

  return {
    ok: true,
    rev: model.rev,
    pending_rev: pendingRev,
    changed: true,
    applied: args.ops.length,
    created,
    renamed,
    warnings,
    dangling,
    pages,
    text,
  }
}

/** One-line-per-element index of a model, for diffing before against after. */
function snapshotIndex(model) {
  const byId = new Map()
  const bySlug = new Map()
  const note = (entry) => {
    const record = { kind: entry.kind, slug: entry.slug, alias: entry.alias ?? [] }
    byId.set(entry.id, record)
    bySlug.set(entry.slug, record)
  }
  let blockCount = 0
  for (const page of model.pages) {
    note({ kind: 'page', id: page.id, slug: page.slug, alias: page.alias })
    for (const block of page.blocks) {
      note({ kind: 'block', id: block.id, slug: block.slug, alias: block.alias })
      blockCount += 1
    }
  }
  for (const edge of model.edges) note({ kind: 'edge', id: edge.id, slug: edge.slug, alias: edge.alias })
  for (const region of model.regions) {
    note({ kind: 'region', id: region.id, slug: region.slug, alias: region.alias })
  }
  return { byId, bySlug, blockCount, edgeCount: model.edges.length }
}

/**
 * Warnings the Agent needs in order to use the addresses it actually got.
 *
 * A slug suffix is the one failure mode where the call succeeds but the Agent's mental model is
 * wrong: it asked for `风险`, got `风险-2`, and every later op depends on which one it believes.
 * So the assigned address has to be stated, not merely implied by the result value.
 *
 * @param before - the index before the batch.
 * @param created - elements the batch created.
 * @param ops - the batch that was applied.
 * @returns model-facing warnings.
 */
function warningsFor(before, created, ops) {
  const warnings = []
  // Only an explicit slug request can be silently overridden; a derived slug was never
  // promised to the Agent, so reporting it would be noise.
  const requestedSlugs = new Set(
    ops
      .filter((op) => typeof op.slug === 'string' && op.slug.trim() !== '')
      .map((op) => op.slug.trim()),
  )
  for (const slug of requestedSlugs) {
    if (created.some((entry) => entry.slug === slug) || before.byId.size === 0) continue
    const assigned = created.find((entry) => !requestedSlugs.has(entry.slug))
    if (assigned !== undefined) {
      warnings.push(
        `'${slug}' was already taken; '${assigned.slug}' was assigned instead. Use '${assigned.slug}' in later ops.`,
      )
    }
  }
  // Every board starts with one empty page, so "is this the first write" means "no blocks and
  // no edges yet", not "no elements in the index".
  if (before.blockCount === 0 && before.edgeCount === 0 && created.length > 0) {
    warnings.push('this batch created the first elements on the board')
  }
  return warnings
}

/** Render the success summary the model reads. */
function renderApplySummary({ pendingRev, applied, created, renamed, warnings, dangling }) {
  const lines = [`Board updated: ${applied} op(s) applied.`]
  if (created.length > 0) {
    lines.push(
      // No `entry.id`: created entries carry `{kind, slug}` only, because a dry-run id is not the id
      // the fold will mint (I8). Printing `(${entry.id})` here said `(undefined)` on every created
      // element — a field that was removed in one place and still read in another.
      `created: ${created.map((entry) => `${entry.kind} ${entry.slug}`).join(', ')}`,
    )
  }
  if (renamed.length > 0) {
    lines.push(`renamed: ${renamed.map((entry) => `${entry.from} → ${entry.to}`).join(', ')}`)
  }
  if (warnings.length > 0) lines.push(`warnings: ${warnings.join(' ')}`)
  if (dangling.length > 0) lines.push(`⚠ dangling edges: ${dangling.join(', ')}`)
  lines.push(
    `Expected new revision: ${pendingRev}. Treat it as a preview — read board_outline to get ` +
      'the authoritative rev and copy it into your next expected_revision.',
  )
  return lines.join('\n')
}

/**
 * Turn an op failure into the five-part message the Agent needs.
 *
 * Batch prefix, precise location, reason, legal values, next step. An error missing any of
 * these leaves the model guessing, and guessing is what produces a second bad batch.
 */
function decorateOpError(error, ops, rev) {
  const opIndex = findFailingIndex(error, ops)
  const opName = opIndex === undefined ? undefined : ops[opIndex]?.op
  const where = opIndex === undefined ? 'the batch' : `op[${opIndex}]${opName === undefined ? '' : ` ${opName}`}`
  return new BoardOpError(
    `board_apply rejected (nothing applied):\n` +
      `  ${where}: ${error.message}\n` +
      `Board is still at ${rev}. Fix ${where === 'the batch' ? 'the ops' : where} and re-issue the whole batch.`,
  )
}

/**
 * Find which op the error came from.
 *
 * The op index is `error.detail.opIndex` when the fold could attach it; otherwise the message
 * is scanned, because a message that cannot say *where* is only half an error.
 */
function findFailingIndex(error, ops) {
  if (typeof error.detail?.opIndex === 'number') return error.detail.opIndex
  const match = /op\[(\d+)\]/.exec(error.message ?? '')
  if (match !== null) return Number(match[1])
  return undefined
}

// ---------------------------------------------------------------------------
// Tool 4 — board_query
// ---------------------------------------------------------------------------

const QUERY_KINDS = Object.freeze([
  'dependents_of',
  'dependencies_of',
  'between',
  'neighbors_of',
  'by_rel',
  'orphans',
  'dangling',
  'path',
])

/** Relationships that carry direction worth following. */
const DIRECTED_RELS = Object.freeze(['depends', 'derives'])

const queryTool = defineBoardTool({
  name: 'board_query',
  description:
    "Ask structural questions about the board's directed edges. Answers come from the edges " +
    'you drew, not from reading prose — use this instead of re-reading pages when the question ' +
    'is about relationships.\n\n' +
    'dependents_of: what points at the target (who depends on it). dependencies_of: what the ' +
    'target points at. between: every edge connecting two refs. neighbors_of: every edge ' +
    'touching a ref. by_rel: every edge with a given rel or label. orphans: blocks with no edge. ' +
    'dangling: edges whose endpoint block is gone. path: directed route from one ref to another.',
  parameters: closedObject(
    {
      kind: oneOfStrings('Which question to ask.', [...QUERY_KINDS]),
      target: str('Reference for the single-target kinds.'),
      from: str("Reference; required for 'between' and 'path'."),
      to: str("Reference; required for 'between' and 'path'."),
      rel: oneOfStrings('Relationship filter.', [...EDGE_RELS]),
      depth: int("Hop limit for 'path'. Defaults to 3, max 8."),
    },
    ['kind'],
  ),
  outputSchema: closedObject(
    {
      rev: str('Current board revision.'),
      kind: str('The question asked.'),
      hits: arrayOf(
        'Matching edges.',
        closedObject(
          {
            edge: str('Edge address.'),
            from: str('Source block address.'),
            to: str('Target block address.'),
            rel: str('Relationship.'),
            label: str('Label.'),
            via: str('Intermediate nodes, for path results.'),
            dangling: bool('An endpoint no longer exists.'),
          },
          ['edge', 'from', 'to'],
        ),
      ),
      empty: bool('True when nothing matched.'),
      hint: str('What to try instead, when nothing matched.'),
      text: str('Rendered answer.'),
    },
    ['rev', 'kind', 'hits', 'empty', 'text'],
  ),
  render: (_args, value) => textResult(value.text),
})

const importTool = defineBoardTool({
  name: 'board_import',
  description:
    "Read another conversation's board, so you can rebuild it here. **This tool writes nothing** " +
    '— it returns the source board in full, plus an op batch you can hand to `board_apply` ' +
    "yourself.\n\n" +
    'Why read-only: the board is the fold of its own `board_apply` calls, so `board_apply` is the ' +
    'only way anything can ever be on a board. A second tool that wrote would be a second write ' +
    'path, and the two would drift. So this one reads, and you apply.\n\n' +
    'Use it when the user says "bring that board over" or when this conversation should continue ' +
    'from a board an earlier one built. The source does not have to be open — a stored ' +
    'conversation is read from its log and folded on demand. Both id forms work: a bare uuid, or a ' +
    'uuid prefixed with `session-`.\n\n' +
    '**Reuse the `ops` array.** It is a complete, correctly ordered `board_apply` batch for that ' +
    'page: blocks with every group after its own children, then edges. The names in it are fixed ' +
    'by the source, so every chunk of every page agrees on them — but that also means a name that ' +
    'already exists on THIS board will collide when you apply it, and `board_apply` will say so ' +
    'and name the element. That is deliberate: this tool writes nothing and the board can change ' +
    'between your calls, so it cannot know what is free, and a name that shifted per call would ' +
    'make one chunk\'s edges point at another chunk\'s blocks. Rename in the batch if you hit that.\n\n' +
    '**Read one page at a time.** Called without `page`, it lists the source pages with their block ' +
    'counts and a preview, and returns no ops — because a whole board in one response runs to ' +
    'hundreds of kilobytes and would be truncated, and a truncated JSON batch looks applicable ' +
    'without being so. Call it again with `page` set to get that page\'s ops.\n\n' +
    'You do not have to send the ops verbatim, and should not send them blindly: feel free to ' +
    'rearrange, drop or rewrite what does not fit here. The point is that this conversation ' +
    'continues from that work, not that it reproduces it byte for byte.',
  isConcurrencySafe: () => true,
  parameters: closedObject(
    {
      from: str('The source session id, e.g. the value in that conversation\u2019s URL or header.'),
      page: str(
        'Which page to return ops for. Omit to list the source pages and their block counts — ' +
          'the first call is always the listing.',
      ),
      chunk: int(
        'Which chunk of that page\'s ops to return. A page is served 8 ops at a time, because ' +
          'the Agent has to copy them back as a tool argument and a long JSON array invites a ' +
          'malformed call. Defaults to 1; the response says when there is another chunk.',
      ),
      reuse_page: str(
        'Slug of an existing EMPTY page that the first imported page should fill instead of ' +
          'creating a new one. Defaults to `main` when this board is untouched (so a blank tab is ' +
          'not left beside the import), and to nothing otherwise.',
      ),
    },
    ['from'],
  ),
  outputSchema: closedObject(
    {
      source_title: str('The title the source board carried.'),
      from: str('The session the board was read from.'),
      pages: int('How many pages the source board has.'),
      blocks: int('How many blocks the source board has.'),
      edges: int('How many edges this response carries. Zero on a listing.'),
      skipped_edges: int('Edges left out because an endpoint no longer exists in the source.'),
      // Deliberately `openObject`: this is the `board_apply` op vocabulary, which that tool already
      // declares. Repeating it here would be a second copy of a discriminated union that has to be
      // kept in step by hand, and a drifted copy would reject a batch the other tool accepts.
      ops: arrayOf(
        'A ready-to-apply `board_apply` batch for one page. Empty when listing.',
        openObject('One board_apply op.'),
      ),
      text: str('The listing, or the page\'s ops plus that page as readable markdown.'),
    },
    ['source_title', 'from', 'pages', 'blocks', 'edges', 'skipped_edges', 'ops', 'text'],
  ),
  render: (_args, value) => textResult(value.text),
})

/**
 * Read an import.
 *
 * This tool **writes nothing**. It reads the source board, builds the op batch that would
 * recreate it, and hands that batch back for the Agent to apply — so there is exactly one write
 * path, `board_apply`, and one set of invariants. An import that applied its own batch would be a
 * second write path, and a batch applied without being seen could not be adapted to the board it
 * lands on.
 *
 * It used to call `executeApply` directly, and that was a real defect rather than a style choice:
 * the fold only replays calls whose name is `board_apply` (`src/fold.js:115`, `:124`, `:133`), so
 * the import reported `r1-…` and a batch size while the board stayed empty. Two identical imports
 * both reporting `r1-f8daf12f546f` is what that looks like. Nothing caught it because every test
 * stubbed the projection instead of folding what the call actually left behind.
 *
 * @param deps - `{ sessionQuery, sessions, projections, persistence }`.
 * @param doc - this board's document, read only for which slugs are already taken.
 * @param args - `{ from, reuse_page }`.
 * @returns the outcome, shaped for the tool's output schema.
 */
/**
 * Render a whole board as readable markdown, for an import to show its source.
 *
 * Not `renderElementMarkdown`: that one is an *address inspector* — every element carries its slug
 * and id so the Agent can patch it — and it stops at a group's children. An import needs the
 * opposite emphasis: the content, expanded all the way down, because the Agent is going to read it
 * and decide what to keep. The slugs are already in `ops`, which is the machine-readable half.
 *
 * Groups are opened as a heading and their children rendered beneath, in the same order the group
 * lays them out — so a nested group reads the way it looks.
 *
 * @param model - the source board's wire model.
 * @returns markdown.
 */
function renderSourceBoard(model, options = {}) {
  const lines = options.includeTitle === false ? [] : [`# ${model.title === '' ? 'untitled' : model.title}`, '']

  for (const page of model.pages) {
    lines.push(`## ${page.slug}`, '')
    const blocks = Array.isArray(page.blocks) ? page.blocks : []
    const byId = new Map(blocks.map((block) => [block.id, block]))
    const claimed = new Set()
    for (const block of blocks) {
      if (block.kind === 'group') for (const id of block.children ?? []) claimed.add(id)
    }
    const seen = new Set()

    const emit = (block, depth) => {
      if (seen.has(block.id)) return
      seen.add(block.id)
      const pad = '  '.repeat(depth)
      if (block.kind === 'group') {
        lines.push(`${pad}### ${block.title ?? '(untitled group)'}`, '')
        for (const id of block.children ?? []) {
          const child = byId.get(id)
          if (child !== undefined) emit(child, depth + 1)
        }
        lines.push('')
        return
      }
      const body = renderBlock({ ...block, slug: '' }).replace(/^▸\s+  \[[a-z-]+\]  \([^)]*\)\n?/, '')
      // Indent a nested block so a group's contents stay visually inside it.
      lines.push(pad === '' ? body : body.split('\n').map((line) => `${pad}${line}`).join('\n'), '')
    }

    for (const block of blocks) if (!claimed.has(block.id)) emit(block, 0)
    // A block claimed by a group that does not exist would otherwise never be printed.
    for (const block of blocks) emit(block, 0)
    lines.push('')
  }

  const edges = Array.isArray(model.edges) ? model.edges : []
  if (edges.length > 0) {
    const slugOf = new Map()
    for (const page of model.pages) {
      for (const block of page.blocks ?? []) slugOf.set(block.id, block.slug)
    }
    lines.push('## relations')
    for (const edge of edges) {
      const fromId = typeof edge.from === 'string' ? edge.from : edge.from?.blockId
      const toId = typeof edge.to === 'string' ? edge.to : edge.to?.blockId
      const label = edge.label === undefined ? '' : `（${edge.label}）`
      lines.push(`- ${slugOf.get(fromId) ?? '?'} → ${slugOf.get(toId) ?? '?'}${edge.rel === undefined ? '' : ` — ${edge.rel}`}${label}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Print an op batch the way it has to be sent back: one op per line.
 *
 * Not `JSON.stringify(ops, null, 2)` — indenting every field of a 20-block page roughly triples the
 * text for no benefit, and this text is the only copy the Agent sees (`ops` is structured output,
 * which never reaches it). One op per line is the compact form that is still diffable and still
 * editable: the Agent can drop a line or change a value without having to re-indent anything.
 *
 * @param ops - the batch.
 * @returns the text, or a note when there is nothing to send.
 */
function printOps(ops) {
  if (ops.length === 0) return '(nothing to apply — this page has no elements)'
  return `[\n  ${ops.map((op) => JSON.stringify(op)).join(',\n  ')}\n]`
}

/**
 * How many ops one response may carry.
 *
 * This is a *copying* budget, not a storage one. The Agent's only copy of the batch is this text,
 * and it has to re-emit it as a tool argument — a 23-op page is already thousands of characters of
 * JSON, and the first real attempt at importing one failed with `tool input is invalid JSON`
 * because the model had to reproduce it by hand. Eight ops keeps every chunk comfortably inside a
 * single tool call.
 */
const IMPORT_OPS_PER_CHUNK = 8

/**
 * One page's worth of a batch, in the order the batch already has.
 *
 * Ops are not tagged with a page in every branch (`add_edge` names only blocks), so the split is by
 * the owning page of each op.
 *
 * **A cross-page edge is deliberately left out.** An `add_edge` needs both endpoints to exist, so an
 * edge from this page to another one cannot be applied until that other page has been imported too.
 * Putting it in this page's batch makes the *whole* batch fail — and it fails atomically, so the
 * page does not arrive either. That is exactly what happened the first time this was tried for
 * real: `op[21] add_edge: no block matches "n-answer"`, and nothing applied. Cross-page edges
 * travel with the last page instead, where both ends are finally present.
 *
 * @param ops - the whole batch.
 * @param pageSlug - the page to take.
 * @param pageOfSlug - resolves the page that owns a block or page slug.
 * @param isLastPage - whether every other page has been applied by the time this one is.
 * @returns that page's ops.
 */
function opsOfPage(ops, pageSlug, pageOfSlug, isLastPage = false) {
  return ops.filter((op) => {
    if (op.op === 'add_page' || op.op === 'update_page' || op.op === 'delete_page') return op.page === pageSlug
    if (op.op === 'add_block' || op.op === 'update_block' || op.op === 'delete_block' || op.op === 'move_block') {
      return op.page === pageSlug || pageOfSlug(op.page) === pageSlug
    }
    if (op.op === 'add_edge') {
      const from = typeof op.from === 'string' ? op.from : op.from?.blockId
      const to = typeof op.to === 'string' ? op.to : op.to?.blockId
      const fromPage = pageOfSlug(from)
      const toPage = pageOfSlug(to)
      // Same-page edges belong here. Cross-page ones wait for the last page.
      if (fromPage === pageSlug && toPage === pageSlug) return true
      return isLastPage && (fromPage === pageSlug || toPage === pageSlug)
    }
    return false
  })
}

async function executeImport(deps, doc, args) {
  const source = await readSourceBoard(deps, args.from)
  const model = source.model

  // A brand-new board is one empty page called `main`. Filling it means the imported board does
  // not arrive beside a blank tab; on any board that has content, every page is added fresh.
  const untouched = doc.model.pages.length === 1 && (doc.model.pages[0].blocks ?? []).length === 0
  const reused =
    typeof args.reuse_page === 'string'
      ? args.reuse_page
      : untouched
        ? doc.model.pages[0].slug
        : undefined

  // **The names this batch uses must not depend on what is currently on the board.**
  //
  // The first version suffixed any slug already taken in the target. That is unstable by
  // construction, because the import *changes* the target: chunk 1 filled `main`, so the next call
  // saw `main` taken and re-slugged the very same page to `main-imported`, its blocks moved with it,
  // and a later chunk's edges then named blocks that no longer existed under those names. The Agent
  // noticed and patched it by hand; a smaller model would have shipped a broken board.
  //
  // So the mapping is now a pure function of the source and the reuse decision: identical on every
  // call, whatever landed in between. A genuine collision with pre-existing content is left to fail
  // loudly at `board_apply`, which names the element and is the only place that can see everything;
  // `reuse_page` is the escape hatch for the ordinary case, and a page the source itself names is
  // never treated as a collision.
  const slugFor = (slug) => slug
  const ops = importOps(model, { slugFor, reusePage: reused })

  const sourceBlocks = model.pages.reduce((total, page) => total + (page.blocks ?? []).length, 0)
  const importedEdgeCount = ops.filter((op) => op.op === 'add_edge').length
  const skipped = (model.edges ?? []).length - importedEdgeCount
  const title = model.title === '' || model.title === undefined ? 'untitled' : model.title

  // Which page holds a block, for splitting a batch by page.
  const pageOf = new Map()
  for (const page of model.pages) {
    const target = page.slug === (model.pages[0]?.slug ?? '') && reused !== undefined ? reused : slugFor(page.slug)
    for (const block of page.blocks ?? []) pageOf.set(slugFor(block.slug ?? block.id), target)
  }
  const pageOfSlug = (slug) => pageOf.get(slug)

  const header = [
    `「${title}」 from session ${args.from} — ${model.pages.length} page(s), ${sourceBlocks} block(s), ${importedEdgeCount} edge(s).`,
    'Nothing has been written to this board yet. It is read-only: bring it over with `board_apply`.',
    skipped > 0 ? `${skipped} edge(s) were left out: an endpoint no longer exists in the source.` : '',
  ].filter((line) => line !== '')

  // A whole board in one response is not readable and would be truncated: 108 blocks runs to
  // roughly 190 KB of JSON, and a truncated JSON array is worse than useless because it looks
  // applicable and is not. So the batch is served one page at a time, and the pages are listed
  // first so the Agent knows what to ask for.
  const targets = model.pages.map((page, index) => ({
    source: page.slug,
    target: page.slug === (model.pages[0]?.slug ?? '') && reused !== undefined ? reused : slugFor(page.slug),
    page,
    isLast: index === model.pages.length - 1,
  }))
  const wanted = typeof args.page === 'string' ? args.page : undefined
  if (wanted === undefined) {
    const listing = targets.map((entry) => {
      const blocks = entry.page.blocks ?? []
      const title = blocks.find((block) => block.kind === 'heading')?.text ?? ''
      const firstProse = blocks.find((block) => block.kind === 'prose')?.markdown ?? ''
      const preview = (title !== '' ? title : firstProse).replace(/\s+/g, ' ').slice(0, 60)
      return `  page ${entry.target}  ${blocks.length} block(s)  ${preview}${preview === '' ? '' : '…'}`
    })
    return {
      source_title: model.title ?? '',
      from: args.from,
      pages: model.pages.length,
      blocks: sourceBlocks,
      edges: importedEdgeCount,
      skipped_edges: skipped,
      ops: [],
      text: [
        ...header,
        reused === undefined
          ? ''
          : `The first page will fill the empty page 「${reused}」 rather than sitting beside it.`,
        'Call board_import again with `page` set to one of these, to get that page\'s ops:',
        '',
        ...listing,
        '',
        'Apply them in the order listed: each page with its own `board_apply`, using the `rev` from',
        'the previous result. Cross-page edges are held back until the last page, because an edge',
        'cannot be added before both of its ends exist.',
        'You may rearrange, drop or rewrite anything that does not fit — the goal is that this',
        'conversation continues from that work, not that it reproduces it byte for byte.',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    }
  }

  const chosen = targets.find((entry) => entry.target === wanted || entry.source === wanted)
  if (chosen === undefined) {
    throw new BoardOpError(
      `no page matches ${JSON.stringify(wanted)}. The source board has: ${targets
        .map((entry) => entry.target)
        .join(', ')}. Call board_import without \`page\` to list them with their block counts.`,
    )
  }

  const allPageOps = opsOfPage(ops, chosen.target, pageOfSlug, chosen.isLast)
  const chunkCount = Math.max(1, Math.ceil(allPageOps.length / IMPORT_OPS_PER_CHUNK))
  const chunk = Number.isInteger(args.chunk) ? args.chunk : 1
  if (chunk < 1 || chunk > chunkCount) {
    throw new BoardOpError(
      `page ${JSON.stringify(chosen.target)} has ${chunkCount} chunk(s) of ${IMPORT_OPS_PER_CHUNK} ` +
        `op(s) each; \`chunk\` must be between 1 and ${chunkCount}.`,
    )
  }
  const pageOps = allPageOps.slice((chunk - 1) * IMPORT_OPS_PER_CHUNK, chunk * IMPORT_OPS_PER_CHUNK)

  const pageModel = { title: model.title, pages: [chosen.page], edges: [] }
  const pageCount = (chosen.page.blocks ?? []).length
  const pageEdgeCount = allPageOps.filter((op) => op.op === 'add_edge').length
  const heldEdges = ops.filter((op) => op.op === 'add_edge').length - pageEdgeCount
  const more = chunk < chunkCount

  return {
    source_title: model.title ?? '',
    from: args.from,
    pages: model.pages.length,
    blocks: sourceBlocks,
    edges: pageOps.filter((op) => op.op === 'add_edge').length,
    skipped_edges: skipped,
    ops: pageOps,
    text: [
      ...header,
      '',
      `── page 「${chosen.target}」 — ${pageCount} block(s); ${allPageOps.length} op(s) in ` +
        `${chunkCount} chunk(s), this is chunk ${chunk} (${pageOps.length} op(s)) ──`,
      '',
      `Apply chunk ${chunk} with \`board_apply\`, passing these as \`ops\` exactly as they appear:`,
      '',
      printOps(pageOps),
      more
        ? `\nThen call board_import again with page="${chosen.target}" and chunk=${chunk + 1}, ` +
          'using the rev from that board_apply.'
        : '',
      heldEdges > 0
        ? `\n${heldEdges} cross-page edge(s) are held back: an edge needs both ends to exist, so ` +
          'they arrive with the last page.'
        : '',
      chunk === 1 ? '\n── the same page as readable markdown ──\n' : '',
      chunk === 1 ? renderSourceBoard(pageModel, { includeTitle: false }) : '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  }
}

/** Execute one query kind against the model. */
function runQuery(model, args) {
  const edges = model.edges.map((edge) => describeEdge(model, edge))
  switch (args.kind) {
    case 'dependents_of': {
      const target = requireRef(model, args.target, 'target')
      return edges.filter((edge) => edge.toId === target.id && DIRECTED_RELS.includes(edge.rel))
    }
    case 'dependencies_of': {
      const target = requireRef(model, args.target, 'target')
      return edges.filter((edge) => edge.fromId === target.id && DIRECTED_RELS.includes(edge.rel))
    }
    case 'between': {
      const from = requireRef(model, args.from, 'from')
      const to = requireRef(model, args.to, 'to')
      return edges.filter(
        (edge) =>
          (edge.fromId === from.id && edge.toId === to.id) || (edge.fromId === to.id && edge.toId === from.id),
      )
    }
    case 'neighbors_of': {
      const target = requireRef(model, args.target, 'target')
      return edges.filter((edge) => edge.fromId === target.id || edge.toId === target.id)
    }
    case 'by_rel': {
      if (args.rel === undefined) {
        throw new BoardOpError("by_rel needs a 'rel'")
      }
      return edges.filter((edge) => edge.rel === args.rel || edge.label?.includes(args.rel))
    }
    case 'orphans': {
      const connected = new Set()
      for (const edge of edges) {
        connected.add(edge.fromId)
        connected.add(edge.toId)
      }
      const orphans = []
      for (const page of model.pages) {
        for (const block of page.blocks) {
          if (!connected.has(block.id)) {
            orphans.push({
              edge: '(none)',
              from: block.slug,
              to: '(none)',
              fromId: block.id,
              toId: block.id,
            })
          }
        }
      }
      return orphans
    }
    case 'dangling':
      return edges.filter((edge) => edge.dangling)
    case 'path': {
      const from = requireRef(model, args.from, 'from')
      const to = requireRef(model, args.to, 'to')
      const depth = Math.min(Math.max(Number(args.depth ?? 3) || 3, 1), 8)
      return findPath(edges, from.id, to.id, depth, model)
    }
    default:
      throw new BoardOpError(`unknown query kind ${JSON.stringify(args.kind)}; expected one of ${QUERY_KINDS.join(', ')}`)
  }
}

/** Flatten an edge into the shape both queries and results use. */
function describeEdge(model, edge) {
  return {
    edge: edge.slug,
    from: slugOf(model, edge.from.blockId),
    to: slugOf(model, edge.to.blockId),
    fromId: edge.from.blockId,
    toId: edge.to.blockId,
    ...(edge.rel === undefined ? {} : { rel: edge.rel }),
    ...(edge.label === undefined ? {} : { label: edge.label }),
    ...(isDangling(model, edge) ? { dangling: true } : {}),
  }
}

/**
 * One query hit, reduced to what the model was promised.
 *
 * `runQuery` works in block ids: `describeEdge` carries `fromId`/`toId` so the filters and the
 * path search can compare them, and `orphans` reuses both for the block it reports. The declared
 * output schema is closed and promises addresses, so the ids are dropped here rather than
 * declared as fields the model has no use for. Left undeclared they failed every `board_query`
 * call in a live session, which is what this projection exists to prevent.
 *
 * @param hit - one raw hit from `runQuery`.
 * @returns the hit with only the fields `board_query` declares.
 */
function modelFacingHit(hit) {
  return {
    edge: hit.edge,
    from: hit.from,
    to: hit.to,
    ...(hit.rel === undefined ? {} : { rel: hit.rel }),
    ...(hit.label === undefined ? {} : { label: hit.label }),
    ...(hit.via === undefined ? {} : { via: hit.via }),
    ...(hit.dangling === undefined ? {} : { dangling: hit.dangling }),
  }
}

/** Resolve a required query reference. */
function requireRef(model, ref, field) {
  if (ref === undefined) throw new BoardOpError(`this query needs a '${field}' reference`)
  const found = resolveRef(model, ref, 'block')
  if (found === undefined) {
    throw new BoardOpError(
      `no block matches ${JSON.stringify(ref)}. Use board_outline to see the current addresses.`,
    )
  }
  return found.element
}

/**
 * Breadth-first search over directed relationships.
 *
 * Bounded by `depth` and by a visited set, so a cycle cannot hang the tool.
 */
function findPath(edges, fromId, toId, depth, model) {
  const follows = edges.filter((edge) => DIRECTED_RELS.includes(edge.rel) || edge.rel === 'next')
  const queue = [{ id: fromId, trail: [] }]
  const seen = new Set([fromId])
  while (queue.length > 0) {
    const current = queue.shift()
    if (current.trail.length >= depth) continue
    for (const edge of follows) {
      if (edge.fromId !== current.id) continue
      const trail = [...current.trail, edge]
      if (edge.toId === toId) {
        return [
          {
            edge: trail.map((hop) => hop.edge).join(' → '),
            from: slugOf(model, fromId),
            to: slugOf(model, toId),
            via: trail.slice(0, -1).map((hop) => hop.to).join(', '),
          },
        ]
      }
      if (seen.has(edge.toId)) continue
      seen.add(edge.toId)
      queue.push({ id: edge.toId, trail })
    }
  }
  return []
}

/**
 * What to try when a query returned nothing.
 *
 * An empty answer is only useful if it says what it means — "no edges with this rel point
 * here, but four other edges touch it" is actionable; "0 hits" is not.
 */
function hintFor(model, args) {
  const edges = model.edges.map((edge) => describeEdge(model, edge))
  const targetRef = args.target ?? args.from
  const found = targetRef === undefined ? undefined : resolveRef(model, targetRef, 'block')
  if (found === undefined) {
    return `The board has ${edges.length} edge(s) between ${model.pages.reduce((sum, page) => sum + page.blocks.length, 0)} block(s). Call board_outline to see the addresses.`
  }
  const touching = edges.filter((edge) => edge.fromId === found.element.id || edge.toId === found.element.id)
  if (touching.length === 0) {
    return `Nothing points at or from ${found.element.slug} yet. Draw a relation with board_apply { op: 'add_edge', from, to, rel }.`
  }
  const rels = [...new Set(touching.map((edge) => edge.rel ?? 'relates'))].join(', ')
  return `${touching.length} edge(s) touch ${found.element.slug}, with rel: ${rels}. Try kind 'neighbors_of' to see them all.`
}

/** Render query hits as a compact table. */
function renderQuery(args, hits, rev) {
  const lines = [`board_query ${args.kind} → ${hits.length} hit(s) (${rev})`]
  for (const hit of hits) {
    if (hit.edge === '(none)') {
      lines.push(`  ${hit.from}  (no edges)`)
      continue
    }
    const rel = hit.rel === undefined ? '' : `-[${hit.rel}]`
    const label = hit.label === undefined ? '' : `  "${hit.label}"`
    const via = hit.via === undefined || hit.via === '' ? '' : `  (via ${hit.via})`
    const dangling = hit.dangling === true ? '  ⚠ dangling' : ''
    lines.push(`  ${hit.from} ${rel}-> ${hit.to}${label}${via}${dangling}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** All five board tools, in the order the Agent should learn them. */
export const BOARD_TOOLS = Object.freeze([outlineTool, readTool, applyTool, queryTool, importTool])

/**
 * Register the board tools.
 *
 * The projection registry is captured in a closure rather than read off the execution object:
 * a tool's `exec` carries `{ callId, name, arguments, agent, signal }` and no services, so the
 * only honest way to depend on a service is to be inside the `ctx.inject` that provides it.
 *
 * @param ctx - the plugin context.
 * @param projections - the session-projection registry, from `ctx.inject`.
 * @param reports - the browser's render reports, or `undefined` without a web server.
 * @param pdfFacts - the host's parse facts, or `undefined`.
 * @param sessionQuery - the cold-capable session reader, or a getter for it. Optional: without it
 *   an import can only read sessions that are still live in this process.
 * @returns the disposers, so the caller can own them in its own effect.
 */
export function registerBoardTools(ctx, projections, reports, pdfFacts, sessionQuery) {
  const read = (exec) => readBoard(projections, exec)
  // Reports are volatile and per-session, so they are resolved at call time rather than held in
  // the projection — see `RenderReports` for why an observation about the DOM cannot live there.
  const reportsFor = (exec, doc) =>
    reports === undefined ? [] : reports.live(exec?.agent?.session?.id, blockIndex(doc.model))

  /**
   * Parse whatever PDF pages are new or stale, then read the facts back.
   *
   * Awaited, because a tool call can afford to wait and the Agent that just placed a page is the one
   * that most needs to hear "that file is a scan with no text layer". The parse is cached by input,
   * so the common case is a map lookup.
   *
   * Failures are swallowed into "no facts". A board whose PDF cannot be parsed is still a board, and
   * an outline that throws because a file moved would be a worse board than one that says so.
   */
  const factsFor = async (exec, doc) => {
    const sessionId = exec?.agent?.session?.id
    try {
      await pdfFacts.ensure(sessionId, doc.model)
    } catch {
      // `ensure` records per-block failures itself; a throw here is a bug in the store, not a fact.
      return []
    }
    return pdfFacts.live(sessionId, blockIndex(doc.model))
  }

  // Without a facts store there is nothing to await, and the tool returns its value directly rather
  // than a promise that resolves to it. `pdfFacts` is optional the same way `reports` is: a profile
  // that never vendored pdf.js, or a test that only cares about the board, gets a working tool.
  const through = (sync, withFacts) =>
    pdfFacts === undefined ? sync : withFacts

  outlineTool.execute = through(
    (args, exec) => executeOutline(read(exec), args, reportsFor(exec, read(exec))),
    async (args, exec) => {
      const doc = read(exec)
      return executeOutline(doc, args, reportsFor(exec, doc), await factsFor(exec, doc))
    },
  )
  readTool.execute = through(
    (args, exec) => executeRead(read(exec), args, reportsFor(exec, read(exec))),
    async (args, exec) => {
      const doc = read(exec)
      return executeRead(doc, args, reportsFor(exec, doc), await factsFor(exec, doc))
    },
  )
  // `board_apply` parses too, and it is the call that most needs to. The dry run's block ids are
  // indicative only, which is why this goes through `ensureInputs` — keyed by the file, not a block.
  applyTool.execute = through(
    (args, exec) => executeApply(read(exec), args),
    async (args, exec) => {
      const result = executeApply(read(exec), args)
      const placed = args.ops
        .filter((op) => op.kind === 'pdf-page' && typeof op.src === 'string' && Number.isInteger(op.pdfPage ?? op.page))
        .map((op) => ({ src: op.src, page: op.pdfPage ?? op.page }))
      if (placed.length === 0) return result
      try {
        const results = await pdfFacts.ensureInputs(placed)
        const problems = [...results.values()].filter((fact) => fact.status === 'failed')
        if (problems.length > 0) {
          // Appended, not thrown: the ops *were* applied, and an unreadable file does not undo them.
          result.warnings = [...result.warnings, ...problems.map((fact) => `⚠ PDF: ${fact.message}`)]
          result.text = `${result.text}\n\n${problems.map((fact) => `⚠ ${fact.message}`).join('\n')}`
        }
      } catch {
        // The board write stands regardless of whether the file could be inspected.
      }
      return result
    },
  )
  queryTool.execute = (args, exec) => executeQuery(read(exec), args)
  // The import needs to resolve *another* session, which no other board tool does — they only ever
  // touch the calling one. It is a **read**, so it never touches `expected_revision`: the batch it
  // returns is applied by `board_apply`, which is the only writer.
  //
  // `sessionQuery` arrives as a **getter** rather than a value: a service this plugin does not
  // inject may finish loading after this registration runs, and capturing `undefined` once would be
  // permanent — the import would refuse a session that is right there.
  //
  // `sessions`, `projections` and `persistence` ride along for profiles without a session query
  // service. `sessionQuery` is genuinely optional — in a headless profile it does not register at
  // all, and a plugin that fails to load is logged and skipped rather than fatal — so an import
  // that needed it would work in the desktop app and refuse every conversation elsewhere. With
  // persistence the stored log is read directly, which is what the query service does internally
  // anyway. All resolved lazily, for the same late-loading reason.
  const resolve = (value) => (typeof value === 'function' ? value() : value)
  importTool.execute = async (args, exec) => {
    // Reading another session never touches this board's state, but the caller's own document still
    // supplies the taken-slug set and the untouched-page test.
    const doc = read(exec)
    return executeImport(
      {
        sessionQuery: resolve(sessionQuery),
        sessions: resolve(ctx.get?.('sessions')),
        projections,
        persistence: resolve(ctx.get?.('sessionPersistence')),
      },
      doc,
      args,
    )
  }
  return BOARD_TOOLS.map((tool) => ctx.tools.register(tool))
}

/**
 * Read the current board, or explain why it cannot be read.
 *
 * `stateOf` is synchronous and returns the live state, which is deliberate: the fold has
 * already advanced past every committed call, so the value here is current and cannot race a
 * write. The result is read-only; callers clone before mutating.
 *
 * @param projections - the session-projection registry.
 * @param exec - the tool execution context.
 * @returns the board document.
 * @throws {BoardOpError} when there is no session or no projection.
 */
function readBoard(projections, exec) {
  const session = exec?.agent?.session
  if (session === undefined) {
    throw new BoardOpError('the board needs an agent session; this call has none')
  }
  const state = projections?.stateOf?.(session, 'board')
  if (state === undefined) {
    throw new BoardOpError(
      'board state unavailable: the board projection is not registered in this profile. ' +
        'The plugin may be loaded without its host half.',
    )
  }
  return state
}

/** `board_outline`. */
function executeOutline(doc, args, renderReports = [], pdfFacts = []) {
  // The tool exists to be asked; a one-line answer on an empty board is exactly the answer.
  const rendered = renderOutlineText(doc, { ...args, renderReports, pdfFacts, silentWhenEmpty: false })
  const model = doc.model

  const failedFacts = pdfFacts.filter((fact) => fact.status === 'failed')

  return {
    rev: model.rev,
    title: model.title,
    pages: model.pages.map((page) => ({
      id: page.id,
      slug: page.slug,
      ...(page.layout === undefined ? {} : { layout: page.layout.template }),
      blocks: page.blocks.map((block) => ({
        id: block.id,
        slug: block.slug,
        kind: block.kind,
        preview: blockPreview(block),
        ...(block.regionId === undefined ? {} : { region: regionSlug(model, block.regionId) }),
      })),
    })),
    edges: model.edges.map((edge) => ({
      id: edge.id,
      slug: edge.slug,
      from: slugOf(model, edge.from.blockId),
      to: slugOf(model, edge.to.blockId),
      ...(edge.rel === undefined ? {} : { rel: edge.rel }),
      ...(edge.label === undefined ? {} : { label: edge.label }),
      ...(isDangling(model, edge) ? { dangling: true } : {}),
    })),
    // One list, three origins. `RENDERER` means the browser tried and failed, which is a stronger
    // statement than any prediction the host can make — so it is listed first. `PDF` facts are the
    // host's own asynchronous look at a file, which is the only source that can say "this file has
    // three pages" or "this file is a scan with no text layer".
    diag: [
      ...renderReports.map((report) => ({
        block: report.blockSlug,
        code: 'RENDERER',
        message: report.message,
      })),
      ...failedFacts.map((fact) => ({
        block: fact.blockSlug,
        code: fact.code,
        message: fact.message,
      })),
      ...Object.values(doc.diag ?? {}).map((diagnostic) => ({
        block: diagnostic.blockSlug,
        code: diagnostic.code,
        message: diagnostic.message,
      })),
    ],
    truncated: rendered.truncated,
    ...(rendered.omitted === undefined ? {} : { omitted: rendered.omitted }),
    text: rendered.text,
  }
}

/** `board_read`. */
function executeRead(doc, args, renderReports = [], pdfFacts = []) {
  const model = doc.model
  const format = args.format ?? 'markdown'
  const depth = args.depth ?? 'block'
  const noteFor = failureNotes(doc, renderReports, pdfFacts)
  const byBlock = new Map(pdfFacts.map((fact) => [fact.blockId, fact]))
  const factFor = (blockId) => byBlock.get(blockId)
  const resolved = []
  const sections = []

  for (const ref of args.refs) {
    const found = resolveRef(model, ref)
    if (found === undefined) {
      throw new BoardOpError(
        `no page, block, edge, or region matches ${JSON.stringify(ref)}. ` +
          `Known pages: ${model.pages.map((page) => page.slug).join(', ') || '(none)'}`,
      )
    }
    resolved.push({ ref: String(ref), kind: found.kind, id: found.element.id, slug: found.element.slug })
    sections.push(
      format === 'json'
        ? JSON.stringify(found.element, null, 2)
        : renderElementMarkdown(model, found, depth, noteFor, factFor),
    )
  }

  return { rev: model.rev, format, resolved, text: sections.join('\n\n---\n\n') }
}

/** `board_query`. */
function executeQuery(doc, args) {
  const model = doc.model
  const hits = runQuery(model, args).map(modelFacingHit)
  const empty = hits.length === 0
  const hint = empty ? hintFor(model, args) : undefined
  const text = empty
    ? `board_query ${args.kind} → nothing (${model.rev})\n${hint}`
    : renderQuery(args, hits, model.rev)

  return { rev: model.rev, kind: args.kind, hits, empty, ...(hint === undefined ? {} : { hint }), text }
}
