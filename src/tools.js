/**
 * The Agent's tool surface.
 *
 * Four tools, deliberately. Every tool costs prompt budget, and a model picks correctly from
 * four far more reliably than from twelve. Page and block creation are *ops* of
 * `board_apply`, not tools of their own, so "make a page, put three blocks on it, connect two
 * arrows" is one transaction, one revision, and one round trip.
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
import { EDGE_RELS, LAYOUT_TEMPLATES } from './model.js'
import {
  arrayOf,
  bool,
  closedObject,
  defineBoardTool,
  int,
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

  // A board nobody has written to has nothing worth saying. Returning a header and a page name
  // would spend prompt budget on every request of every conversation that never opens the tab.
  const hasContent = model.pages.some((page) => page.blocks.length > 0) || model.edges.length > 0
  if (!hasContent && doc.lastOpError === undefined) {
    return { text: '', truncated: false }
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

  if ((include === 'all' || include === 'diag') && Object.keys(doc.diag ?? {}).length > 0) {
    lines.push('')
    lines.push('render failures:')
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

/** Render one resolved element as markdown, at the requested depth. */
function renderElementMarkdown(model, found, depth) {
  const element = found.element
  switch (found.kind) {
    case 'page': {
      const header = `# page ${element.slug}  (${element.id})`
      if (depth === 'page' || depth === 'region') {
        const blocks = element.blocks.map((block) => renderBlock(block)).join('\n\n')
        return `${header}\n\n${blocks}`
      }
      return `${header}\n\n${element.blocks.length} block(s): ${element.blocks.map((block) => block.slug).join(', ')}`
    }
    case 'block':
      return renderBlock(element)
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
          .map((block) => renderBlock(block))
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
function renderBlock(block) {
  const head = `▸ ${block.slug}  [${block.kind}]  (${block.id})`
  switch (block.kind) {
    case 'heading':
      return `${head}\n${'#'.repeat(block.level)} ${block.text}`
    case 'prose':
      return `${head}\n${block.markdown}`
    case 'list':
      return `${head}\n${block.items
        .map((item, index) => `${'  '.repeat(item.depth)}${block.ordered ? `${index + 1}.` : '-'} ${item.text}`)
        .join('\n')}`
    case 'code':
      return `${head}\n\`\`\`${block.lang}${block.filename === undefined ? '' : ` ${block.filename}`}\n${block.code}\n\`\`\``
    case 'uml':
      return `${head}\n\`\`\`${block.engine} (${block.diagram})\n${block.source}\n\`\`\``
    case 'image':
      return `${head}\nsrc: ${block.src}\nalt: ${block.alt}${block.caption === undefined ? '' : `\ncaption: ${block.caption}`}`
    case 'pdf-page':
      return `${head}\nsrc: ${block.src}\npage: ${block.page}${block.caption === undefined ? '' : `\ncaption: ${block.caption}`}`
    case 'group':
      return `${head}\ntitle: ${block.title ?? '(none)'}\nchildren: ${block.children.join(', ')}`
    default:
      return `${head}\n${JSON.stringify(block, null, 2)}`
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
    title: str('group: container title.'),
    children: arrayOf('group: block references on the same page. Groups may nest.'),
    layout: closedObject(
      {
        template: oneOfStrings('How this group arranges its children.', [...LAYOUT_TEMPLATES]),
        params: openObject('Template parameters, such as { cols: 2 } or { minCardWidth: 240 }.'),
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
            region: str('Region to join.'),
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
            from: str('Source block reference, or { blockId, at }.'),
            to: str('Target block reference, or { blockId, at }.'),
            rel: oneOfStrings('Relationship type. Omit for a plain visual arrow.', [...EDGE_RELS]),
            label: str('Free-text label, shown on the arrow.'),
            style: oneOfStrings('Arrow style.', ['solid', 'dashed', 'dotted']),
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
            from: str('New source endpoint.'),
            to: str('New target endpoint.'),
          },
          ['edge'],
        ),
        opBranch('delete_edge', { edge: str('Edge to delete.') }, ['edge']),
        opBranch(
          'set_layout',
          {
            scope: str('Page or group reference. A region carries no layout.'),
            template: oneOfStrings('Layout template.', [...LAYOUT_TEMPLATES]),
            cols: int('columns: how many equal columns.'),
            gap: int('Spacing between cards, in pixels.'),
            direction: oneOfStrings('row: wrap direction.', ['down', 'right']),
            minCardWidth: int('grid: minimum card width, in pixels.'),
          },
          ['scope', 'template'],
        ),
        opBranch(
          'set_region',
          {
            region: str('Region to update. Omit to create one.'),
            blockIds: arrayOf('The complete membership list.'),
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
    'Reference pages and blocks by slug or id. Layout is the engine\'s job: do not set ' +
    'coordinates unless no template can express the arrangement.',
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
        'Elements this batch created.',
        closedObject(
          {
            kind: str('page, block, edge, region, or item.'),
            id: str('Stable id.'),
            slug: str('The address actually assigned, which may carry a suffix.'),
            ref: str('The address you asked for, when you asked for one.'),
          },
          ['kind', 'id', 'slug', 'ref'],
        ),
      ),
      renamed: arrayOf(
        'Elements this batch renamed.',
        closedObject({ id: str('Stable id.'), from: str('Previous address.'), to: str('New address.') }, [
          'id',
          'from',
          'to',
        ]),
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
 * when it sees the committed call — and because element ids are derived from the log position
 * rather than a counter, both runs derive identical ids.
 *
 * @param doc - the current board document.
 * @param args - `{ expected_revision, ops, note }`.
 * @returns the structured outcome, which DSH validates and hands to `render`.
 */
function executeApply(doc, args) {
  const model = doc.model

  if (args.expected_revision !== model.rev) {
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
    })
  } catch (error) {
    if (!(error instanceof BoardOpError)) throw error
    throw decorateOpError(error, args.ops, model.rev)
  }

  const after = snapshotIndex(next)
  const created = []
  for (const [id, entry] of after.byId) {
    if (!before.byId.has(id)) {
      created.push({ kind: entry.kind, id, slug: entry.slug, ref: entry.slug })
    }
  }
  const renamed = []
  for (const [id, entry] of after.byId) {
    const previous = before.byId.get(id)
    if (previous !== undefined && previous.slug !== entry.slug) {
      renamed.push({ id, from: previous.slug, to: entry.slug })
    }
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
  let blockCount = 0
  for (const page of model.pages) {
    byId.set(page.id, { kind: 'page', slug: page.slug })
    for (const block of page.blocks) {
      byId.set(block.id, { kind: 'block', slug: block.slug })
      blockCount += 1
    }
  }
  for (const edge of model.edges) byId.set(edge.id, { kind: 'edge', slug: edge.slug })
  for (const region of model.regions) byId.set(region.id, { kind: 'region', slug: region.slug })
  return { byId, blockCount, edgeCount: model.edges.length }
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
      `created: ${created.map((entry) => `${entry.kind} ${entry.slug} (${entry.id})`).join(', ')}`,
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

/** All four board tools, in the order the Agent should learn them. */
export const BOARD_TOOLS = Object.freeze([outlineTool, readTool, applyTool, queryTool])

/**
 * Register the board tools.
 *
 * The projection registry is captured in a closure rather than read off the execution object:
 * a tool's `exec` carries `{ callId, name, arguments, agent, signal }` and no services, so the
 * only honest way to depend on a service is to be inside the `ctx.inject` that provides it.
 *
 * @param ctx - the plugin context.
 * @param projections - the session-projection registry, from `ctx.inject`.
 * @returns the disposers, so the caller can own them in its own effect.
 */
export function registerBoardTools(ctx, projections) {
  const read = (exec) => readBoard(projections, exec)
  outlineTool.execute = (args, exec) => executeOutline(read(exec), args)
  readTool.execute = (args, exec) => executeRead(read(exec), args)
  applyTool.execute = (args, exec) => executeApply(read(exec), args)
  queryTool.execute = (args, exec) => executeQuery(read(exec), args)
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
function executeOutline(doc, args) {
  const rendered = renderOutlineText(doc, args)
  const model = doc.model

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
    diag: Object.values(doc.diag ?? {}).map((diagnostic) => ({
      block: diagnostic.blockSlug,
      code: diagnostic.code,
      message: diagnostic.message,
    })),
    truncated: rendered.truncated,
    ...(rendered.omitted === undefined ? {} : { omitted: rendered.omitted }),
    text: rendered.text,
  }
}

/** `board_read`. */
function executeRead(doc, args) {
  const model = doc.model
  const format = args.format ?? 'markdown'
  const depth = args.depth ?? 'block'
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
        : renderElementMarkdown(model, found, depth),
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
