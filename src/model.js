/**
 * The board's scene model.
 *
 * A board is plain JSON: `structuredClone`-able, hashable, and — because the projection
 * checkpoints it — serialisable across restarts. Nothing here reads the clock, a random
 * number, or the filesystem, because every value in it must be reproducible from the
 * session log alone. That property is what makes fork/resume/replay free.
 *
 * See `docs/design/board-model.md` §1 for the authoritative shapes.
 *
 * @module dsh-superboard/model
 */

/**
 * The projection's state version.
 *
 * Bumped to 2 by the layout grill: `group` blocks gained a `layout`, `region` lost one, and the
 * template vocabulary changed (`tree` out — nested groups *are* a tree; `row` in). Bumping is what
 * makes an old checkpoint get re-folded from the log rather than parsed into a shape it no longer
 * matches, and re-folding is exactly what the log-native design buys.
 *
 * Bumped to 3 by the areas grill, which **deleted** the block-level `at`. Adding an optional field
 * would not need a bump — an old checkpoint simply lacks it — but removing one does: a stored `at`
 * would still parse into a shape nothing reads any more, so those boards have to be re-folded. The
 * reverse case matters just as much: an `at` the fold used to produce can no longer be produced, so
 * any revision computed from one is stale.
 *
 * Bumped to 4 by the PDF parse, which **deleted** `pdf-page.pageCount` and changed that arm's
 * encoding. Both halves of the same rule: a checkpoint may still hold the field, and the hash that
 * used to include it can no longer be produced. It was worth removing rather than leaving in place
 * — no tool could ever set it, so it was a field the document could not see, and a page count is a
 * fact about a file rather than about a board.
 *
 * Bumped to 5 by the I2 fix (§2.6.1): the revision gate now compares only the sequence half, never
 * the hash. That is a change to *which batches a re-fold accepts* — a fold-semantics change — so it
 * takes a bump like any other. The bump is also the recovery: version 4's checkpoint was truncated
 * (the fold had been rejecting its own replayed history, so ten batches never landed), and
 * discarding that row is what makes DSH re-fold the whole log and get them back.
 */
export const BOARD_MODEL_VERSION = 5

/** Block kinds, in the order `board-model.md` §1.3 lists them. */
export const BLOCK_KINDS = Object.freeze([
  'heading',
  'prose',
  'list',
  'code',
  'uml',
  'image',
  'pdf-page',
  'group',
])

/** Relationship vocabulary for edges. `rel` is optional — not every stroke needs an ontology. */
export const EDGE_RELS = Object.freeze([
  'depends',
  'causes',
  'contains',
  'next',
  'explains',
  'derives',
  'contradicts',
  'relates',
])

/**
 * Layout templates — the arrangement vocabulary (Q-E, extended after the layout grill).
 *
 * Each name maps to something the model already knows cold from CSS, because the Agent cannot see
 * the canvas: it reasons about a **tree**, the way it reasons about DOM or any GUI toolkit. A
 * vocabulary it has read a million times beats a bespoke one it has to learn.
 *
 *   `flow`    — a vertical stack; the default.
 *   `row`     — a horizontal run that wraps when it runs out of width.
 *   `columns` — a grid of `cols` equal columns.
 *   `grid`    — a grid that fits as many `minCardWidth` cards per row as the width allows, or a
 *               named-cell grid when `params.areas` says which child occupies which cells.
 *   `masonry` — a waterfall: `cols` columns (or as many as `minCardWidth` allows), each card
 *               keeping its own height, filled in order down the shortest column.
 *   `canvas`  — no arrangement at all: a plain box, for sectioning rather than for position.
 *
 * **There is no coordinate template.** Free placement was `canvas` plus a per-block `at`, and both
 * are gone: a position the Agent can neither see nor verify has no channel through which it could
 * report "the model thinks A and the rendering says B", so the arrangement has to be something
 * that can be *declared* — a template and a tree. What remains spatially free is the arrow layer,
 * whose geometry is measured rather than authored.
 *
 * **`masonry` is the one template whose arrangement is not CSS Grid, and that is deliberate.**
 * A grid row is as tall as its tallest card, so in a `grid` a one-line card beside a long one
 * leaves a hole underneath it; `masonry` is what an Agent means when it says "fill the space".
 * There is no native CSS masonry in the target runtime (probed: Edge 153 lays `grid-template-rows:
 * masonry` out as an ordinary grid), so this is CSS multi-column — `columns` + `break-inside:
 * avoid`. The consequence to know about is that a multi-column container is filled **column by
 * column** once the content exceeds one column's balanced height, so it is a waterfall and not a
 * row-order grid. Each card still carries `margin-bottom` rather than a `gap`, because `gap` has
 * no effect in a multi-column container.
 *
 * The former `tree` template is gone: nesting a `group` inside a `group` *is* a tree, and having
 * both would be two ways to say one thing.
 *
 * Whatever this list contains must also appear in `TEMPLATE_MEANING` in `tools.js` — the Agent
 * never reads this comment, so the description string is where a template actually gets explained.
 * The suite checks the two lists agree.
 */
export const LAYOUT_TEMPLATES = Object.freeze(['flow', 'row', 'columns', 'grid', 'masonry', 'canvas'])

/** Element-id prefixes, one per addressable element kind. */
export const ID_PREFIX = Object.freeze({
  page: 'pg_',
  block: 'bl_',
  edge: 'ed_',
  region: 'rg_',
  listItem: 'li_',
})

/**
 * Every id an element can be addressed by, matched by `board_read`/`board_apply`.
 *
 * Resolution order is always `id → slug → alias` (`board-model.md` §1.7 R1).
 */
const ID_PATTERN = /^(pg|bl|ed|rg|li)_[0-9a-f]{6}$/

/**
 * A slug, after normalisation.
 *
 * Letters, digits, underscore, hyphen — plus the punctuation a real sentence ends with. That last
 * part matters for this project's actual usage: `\p{N}`/`\p{L}` cover Chinese characters, but the
 * full-width period in `登录服务处理会话。` is punctuation, so without it a perfectly ordinary
 * Chinese sentence would fail validation and fall back to a generic `prose-2` address. An address
 * nobody can read is the thing slugs exist to prevent (Q-G).
 *
 * Characters genuinely unsafe in an address are stripped before this test, so anything surviving
 * to here is safe to carry. Narrower than `\p{P}` or `\p{S}` on purpose: these are the marks prose
 * actually ends with, and the set stays small enough to reason about when it becomes a filename.
 */
const SLUG_PATTERN = /^[\p{L}\p{N}_\-.。、，,·]+$/u

/** Maximum slug length in Unicode code points. */
const SLUG_MAX = 24

/** How many retired slugs an element remembers. Older ones are dropped, not re-exposed. */
const ALIAS_MAX = 8

/** Path-hostile and invisible characters, removed before validation. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what we strip
const UNSAFE_IN_SLUG = /[\\/:*?"<>|\u0000-\u001f\u007f]/gu

/** Trail and lead punctuation is trimmed so an address never starts or ends with a separator. */
const SLUG_EDGE_TRIM = /^[-.。、，,·]+|[-.。、，,·]+$/gu

/** Separation bytes for the hand-written hash encoding — never present in normal text. */
const FIELD_SEP = '\u001f'
const ELEMENT_SEP = '\u001e'

/**
 * A fresh, empty board.
 *
 * Starts with exactly one page: `pages.length >= 1` is an invariant, so there is no such
 * thing as a board with nowhere to write.
 *
 * `sessionId` is carried in the state because element ids are derived from it — and because
 * the fold only ever receives `(state, event)`, with no session in scope. It is deliberately
 * **not** part of the content hash.
 *
 * @param sessionId - the owning session, taken from the session header at projection `init`.
 * @returns a brand-new `BoardDoc`.
 */
export function emptyBoardDoc(sessionId = '') {
  return {
    modelVersion: BOARD_MODEL_VERSION,
    sessionId,
    model: {
      title: 'Board',
      pages: [
        {
          id: `${ID_PREFIX.page}000000`,
          slug: 'main',
          alias: [],
          blocks: [],
          createdAtRev: 'r0-000000000000',
        },
      ],
      regions: [],
      edges: [],
      revSeq: 0,
      revHash: '0'.repeat(16),
      rev: 'r0-000000000000',
    },
    diag: {},
    /** `callId → parsed arguments` for calls seen but not yet settled. Bounded. */
    pending: {},
  }
}

/**
 * Compose the convenience revision string from its two parts.
 *
 * @param revSeq - how many op batches have been folded successfully.
 * @param revHash - the 16-hex content hash.
 * @returns the `r<revSeq>-<hash[0..12]>` form the Agent passes as `expected_revision`.
 */
export function composeRev(revSeq, revHash) {
  return `r${revSeq}-${revHash.slice(0, 12)}`
}

/**
 * Read the sequence half back out of a revision string.
 *
 * The revision has two halves and they answer different questions. The **sequence** counts
 * successfully folded op batches, so it says how far along the board is. The **hash** is a digest
 * of the content encoding, so it says *which* board that is.
 *
 * Only the sequence is stable across a model-version bump: the encoding changes, so every hash
 * already in an Agent's context becomes unproducible even though its board is current. That is why
 * every staleness comparison goes through here rather than comparing `rev` strings whole — see the
 * note in `applyOps` in `src/fold.js`.
 *
 * @param rev - a revision string, `r<seq>-<hash>`, or anything else.
 * @returns the sequence number, or `-1` when the string is not a revision at all. An
 *   unparseable value must never compare equal to a real one.
 */
export function parseRevSeq(rev) {
  const match = /^r(\d+)-[0-9a-f]+$/.exec(String(rev ?? ''))
  return match === null ? -1 : Number(match[1])
}

/**
 * Whether a string is a machine id rather than a human address.
 *
 * @param value - candidate reference.
 * @returns `true` for `pg_`/`bl_`/`ed_`/`rg_`/`li_` + 6 hex digits.
 */
export function isElementId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/**
 * Derive a stable element id from the board's own history.
 *
 * The id is a hash of `(sessionId, callSeq, opIndex, kind)`, so replaying the same log
 * yields the same ids. A counter or a random number would not: after resume, the same log
 * would fold into two different boards.
 *
 * @param hasher - a synchronous `sha256`-style digest over a string, returning hex.
 * @param parts - session id, the `tool/call` seq, the op index within the batch, and the kind.
 * @returns a 6-hex id body (not yet prefixed).
 */
export function deriveIdBody(hasher, parts) {
  const material = [parts.sessionId, parts.callSeq, parts.opIndex, parts.kind].join(FIELD_SEP)
  return hasher(material).slice(0, 6)
}

/**
 * Turn arbitrary author text into a candidate slug.
 *
 * Normalises to NFC, folds internal whitespace to `-`, strips characters that would be
 * unusable in a filename or confusing in prose, and truncates. Case is deliberately **not**
 * folded: `风险-1` and `Risk-1` are distinct, legal addresses, and folding them would
 * invent collisions that need not exist.
 *
 * @param source - the author's text (a heading, a filename, an explicit `slug`, …).
 * @param fallbackBase - used when nothing usable survives normalisation, e.g. `'block'`.
 * @param fallbackIndex - sequence within the fallback family, so several bare blocks differ.
 * @returns a slug matching {@link SLUG_PATTERN}.
 */
export function toSlug(source, fallbackBase = 'item', fallbackIndex = 1) {
  const normalised = String(source ?? '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, '-')
    .replace(UNSAFE_IN_SLUG, '')
    .slice(0, SLUG_MAX)
  const trimmed = normalised.replace(SLUG_EDGE_TRIM, '')
  if (trimmed !== '' && SLUG_PATTERN.test(trimmed)) return trimmed
  return `${fallbackBase}-${fallbackIndex}`
}

/**
 * Allocate a slug that collides with nothing already taken in its scope.
 *
 * The comparison set is `slug ∪ alias`, which is what makes retired addresses
 * non-reassignable (`board-model.md` §1.7 R3) — if a retired slug could be handed to a new
 * element, every old reference would silently point somewhere new.
 *
 * @param base - the desired slug.
 * @param taken - every slug and alias already in use in this scope.
 * @returns `base`, or `base-2`, `base-3`, … until free.
 */
export function uniqSlug(base, taken) {
  const used = taken instanceof Set ? taken : new Set(taken)
  if (!used.has(base)) return base
  let index = 2
  let candidate = `${base}-${index}`
  while (used.has(candidate)) {
    index += 1
    candidate = `${base}-${index}`
  }
  return candidate
}

/**
 * Push an old slug onto an element's alias history.
 *
 * Bounded and newest-first, so a reference from a few renames ago still resolves while the
 * outline stays short.
 *
 * @param alias - the existing history.
 * @param oldSlug - the slug being retired.
 * @returns a new history array.
 */
export function pushAlias(alias, oldSlug) {
  const next = [oldSlug, ...alias.filter((entry) => entry !== oldSlug)]
  return next.slice(0, ALIAS_MAX)
}

/**
 * Round a normalised coordinate so that float noise cannot enter the hash.
 *
 * `0.1 + 0.2` differs between engines; a hash over such a value would report "changed" for
 * an edit that changed nothing. Quantising to 4 decimals removes the class of problem.
 *
 * @param value - a normalised coordinate in `[0, 1]` (or a size).
 * @returns the value rounded to 4 decimals.
 */
export function quantise(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.round(numeric * 1e4) / 1e4
}

/**
 * Encode the model as a deterministic string for hashing.
 *
 * Hand-written rather than `JSON.stringify`, and that is deliberate: `JSON.stringify`
 * depends on key insertion order, so `{a, b}` and `{b, a}` hash differently even though
 * they describe the same board. Listing fields explicitly makes the hash a function of
 * content alone.
 *
 * Fields excluded on purpose: `revSeq`/`revHash`/`rev` (self-reference), `alias` (history),
 * `createdAtRev`/`updatedAtRev` (derived from the counter), `diag` (renderer-derived),
 * `renderedHash` and `nodeHints` (renderer/parser-derived), and edge `dangling` (derivable).
 *
 * @param model - the authoritative board model.
 * @returns the canonical encoding to digest.
 */
export function encodeModelForHash(model) {
  const out = []
  out.push(model.title ?? '')
  out.push(ELEMENT_SEP)

  for (const page of model.pages) {
    out.push(page.id, FIELD_SEP, page.slug, FIELD_SEP)
    out.push(page.layout === undefined ? '' : encodeLayout(page.layout))
    out.push(FIELD_SEP, ELEMENT_SEP)
    for (const block of page.blocks) out.push(encodeBlock(block))
    out.push(ELEMENT_SEP)
  }

  for (const region of model.regions) {
    out.push(
      region.id,
      FIELD_SEP,
      region.slug,
      FIELD_SEP,
      region.blockIds.join(','),
      FIELD_SEP,
      region.label ?? '',
      FIELD_SEP,
      region.tone ?? '',
      FIELD_SEP,
      ELEMENT_SEP,
    )
  }

  for (const edge of model.edges) {
    out.push(
      edge.id,
      FIELD_SEP,
      edge.slug,
      FIELD_SEP,
      edge.rel ?? '',
      FIELD_SEP,
      edge.label ?? '',
      FIELD_SEP,
      edge.style ?? '',
      FIELD_SEP,
      encodeAnchor(edge.from),
      FIELD_SEP,
      encodeAnchor(edge.to),
      FIELD_SEP,
      (edge.waypoints ?? []).map((point) => `${quantise(point.x)},${quantise(point.y)}`).join(';'),
      FIELD_SEP,
      ELEMENT_SEP,
    )
  }

  return out.join('')
}

/**
 * Encode one block's content fields in a fixed order.
 *
 * @param block - the block to encode.
 * @returns the encoded fragment.
 */
function encodeBlock(block) {
  const parts = [block.id, FIELD_SEP, block.kind, FIELD_SEP, block.slug, FIELD_SEP]
  parts.push(block.regionId ?? '', FIELD_SEP)

  switch (block.kind) {
    case 'heading':
      parts.push(String(block.level), FIELD_SEP, block.text)
      break
    case 'prose':
      parts.push(block.markdown, FIELD_SEP, block.collapsed === true ? '1' : '0')
      break
    case 'list':
      parts.push(block.ordered === true ? '1' : '0', FIELD_SEP)
      for (const item of block.items) {
        parts.push(
          item.id,
          ':',
          String(item.depth),
          ':',
          item.checked === true ? '1' : '0',
          ':',
          item.text,
          ';',
        )
      }
      break
    case 'code':
      parts.push(block.lang, FIELD_SEP, block.code, FIELD_SEP, block.filename ?? '')
      break
    case 'uml':
      // `renderedHash` and `nodeHints` are renderer/parser-derived and stay out.
      parts.push(block.engine, FIELD_SEP, block.diagram, FIELD_SEP, block.source)
      break
    case 'image':
      parts.push(
        block.src,
        FIELD_SEP,
        block.alt,
        FIELD_SEP,
        block.caption ?? '',
        FIELD_SEP,
        block.naturalSize === undefined ? '' : `${block.naturalSize.w}x${block.naturalSize.h}`,
      )
      break
    case 'pdf-page':
      // `pageCount` is not here because it is not a field any more: it needs a parse, a parse is
      // I/O, and the fold is synchronous. It lives in the host's volatile `PdfFacts` (src/pdf.js)
      // and is merged in when a tool reads the board. A block cannot carry a fact it cannot see.
      parts.push(
        block.src,
        FIELD_SEP,
        String(block.page),
        FIELD_SEP,
        block.crop === undefined
          ? ''
          : `${quantise(block.crop.x)},${quantise(block.crop.y)},${quantise(block.crop.w)},${quantise(block.crop.h)}`,
        FIELD_SEP,
        block.caption ?? '',
      )
      break
    case 'group':
      parts.push(
        block.title ?? '',
        FIELD_SEP,
        block.children.join(','),
        FIELD_SEP,
        block.collapsed === true ? '1' : '0',
        FIELD_SEP,
        // A container's layout is content, not presentation: changing it changes the board.
        block.layout === undefined ? '' : encodeLayout(block.layout),
      )
      break
    default:
      parts.push(JSON.stringify(block))
      break
  }

  parts.push(FIELD_SEP)
  for (const anchor of block.anchors) parts.push(encodeAnchor({ blockId: block.id, at: anchor }), ';')
  parts.push(ELEMENT_SEP)
  return parts.join('')
}

/**
 * Encode a layout spec with its params and hints in a fixed key order.
 *
 * `params` is an open record, so enumerating the keys that matter is the only way a param reaches
 * the hash — a param that is not listed here can be changed without the revision moving, which is
 * how a layout edit once became invisible to the Agent. `areas` is listed for that reason even
 * though resolving it is the projection's job: the *template* is authored, so it is content.
 *
 * @param layout - the layout spec.
 * @returns the encoded fragment.
 */
function encodeLayout(layout) {
  const params = layout.params ?? {}
  const hints = layout.hints ?? {}
  return [
    layout.template,
    ':',
    String(params.cols ?? ''),
    ':',
    String(params.minCardWidth ?? ''),
    ':',
    params.direction ?? '',
    ':',
    String(params.gap ?? ''),
    ':',
    params.root ?? '',
    ':',
    (params.areas ?? []).join(';'),
    ':',
    (hints.bands ?? []).map((band) => band.join(',')).join(';'),
    ':',
    hints.titleBlock === undefined ? '' : hints.titleBlock ? '1' : '0',
  ].join('')
}

/** The cell token that means "nothing sits here". */
const AREA_HOLE = '.'

/**
 * Parse a layout's `areas` template into a rectangular grid of cell tokens.
 *
 * A token is a **child reference** — the same vocabulary `children` already uses — so naming a cell
 * introduces no new concept for the Agent to learn. Whitespace separates cells, which is safe
 * because a slug can never contain whitespace (`toSlug` collapses it to `-`), and `.` is a hole,
 * which is safe because `toSlug` strips leading and trailing dots and `.` is never a slug alone.
 *
 * Only the *shape* is checked here; the *names* are checked by the caller, which is the only place
 * that has the container's children. Keeping that split is what lets this stay pure.
 *
 * @param value - an array of row strings, or one string with rows separated by `/` or a newline.
 * @returns `{ ok: true, rows }` with canonical rows, or `{ ok: false, error }`.
 */
export function parseAreas(value) {
  let raw
  if (Array.isArray(value)) raw = value.map((row) => String(row))
  else if (typeof value === 'string') raw = value.split(/\r?\n|\//u)
  else return { ok: false, error: 'areas must be an array of row strings, or one string' }

  const rows = raw.map((row) => row.trim().split(/\s+/u).filter((cell) => cell !== ''))
  if (rows.every((row) => row.length === 0)) return { ok: false, error: 'areas is empty' }

  const width = rows[0].length
  if (width === 0) return { ok: false, error: 'areas row 1 has no cells' }
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].length !== width) {
      return {
        ok: false,
        error: `areas row ${index + 1} has ${rows[index].length} cells; row 1 has ${width}`,
      }
    }
  }
  return { ok: true, rows }
}

/**
 * Resolve parsed `areas` against a container's children.
 *
 * The template says *which child goes where*, by name. Resolving it here rather than in the browser
 * is deliberate: CSS `grid-template-areas` needs CSS identifiers, so a CJK slug would have to be
 * escaped, and an invalid declaration is dropped in silence — the layout would simply collapse with
 * nothing to report. Computing line numbers ourselves keeps every slug legal and keeps every failure
 * in a validator that can say what went wrong.
 *
 * @param rows - canonical rows from {@link parseAreas}.
 * @param children - the container's child blocks, in order.
 * @returns `{ ok: true, cols, rows, cells }` or `{ ok: false, error }`, with `cells` keyed by block id.
 */
export function resolveAreas(rows, children) {
  const byToken = new Map()
  for (const child of children) {
    for (const token of [child.id, child.slug, ...(child.alias ?? [])]) {
      if (typeof token === 'string' && token !== '') byToken.set(token, child.id)
    }
  }

  /** token → the cells it occupies, in reading order. */
  const occupied = new Map()
  for (let row = 0; row < rows.length; row += 1) {
    for (let col = 0; col < rows[row].length; col += 1) {
      const token = rows[row][col]
      if (token === AREA_HOLE) continue
      const seen = occupied.get(token)
      if (seen === undefined) occupied.set(token, [{ row, col }])
      else seen.push({ row, col })
    }
  }

  const cells = {}
  for (const [token, list] of occupied) {
    const id = byToken.get(token)
    if (id === undefined) {
      const known = children.map((child) => child.slug).join(', ')
      return {
        ok: false,
        error:
          `areas names ${JSON.stringify(token)}, which is not a child of this container; ` +
          `its children are ${known === '' ? '(none)' : known}`,
      }
    }
    if (cells[id] !== undefined) {
      return {
        ok: false,
        error: `areas names ${JSON.stringify(token)} for a block that already has a region; one name per block`,
      }
    }

    const top = Math.min(...list.map((cell) => cell.row))
    const bottom = Math.max(...list.map((cell) => cell.row))
    const left = Math.min(...list.map((cell) => cell.col))
    const right = Math.max(...list.map((cell) => cell.col))
    // A name's cells have to fill its own bounding box. Otherwise "the region" is a guess, and the
    // browser would silently place the block in the first cell of a shape nobody can see.
    if (list.length !== (bottom - top + 1) * (right - left + 1)) {
      const columns = [...new Set(list.map((cell) => cell.col + 1))].sort((a, b) => a - b)
      return {
        ok: false,
        error:
          `areas gives ${JSON.stringify(token)} a region that is not a rectangle: ` +
          `rows ${top + 1}-${bottom + 1}, columns ${columns.join(' and ')}`,
      }
    }
    cells[id] = {
      row: top + 1,
      col: left + 1,
      rowSpan: bottom - top + 1,
      colSpan: right - left + 1,
    }
  }

  return { ok: true, cols: rows[0].length, rows: rows.length, cells }
}

/**
 * Resolve every `areas` template in a model into explicit placements.
 *
 * This is the projection half of the split: the fold validates a template while it still has the
 * page, and this turns the surviving templates into the line numbers the renderer needs. The result
 * lands in `layout.params` because that record is already open on both the doc and the wire, so no
 * schema changes and — more importantly — **the document never carries derived data**. Only the
 * authored template reaches the hash.
 *
 * A template that fails to resolve here is skipped so the container falls back to auto-flow. It
 * cannot legitimately fail — the fold rejected anything malformed — but a throw in the projection
 * blanks the entire board, which is a failure this project has already paid for once.
 *
 * @param model - the board model.
 * @returns the model with resolved placements, or the same object when there is nothing to resolve.
 */
export function applyAreas(model) {
  let changed = false

  const pages = model.pages.map((page) => {
    const placements = new Map()
    const layoutOf = (layout, children) => {
      const areas = layout?.params?.areas
      if (areas === undefined) return undefined
      const parsed = parseAreas(areas)
      if (!parsed.ok) return undefined
      const resolved = resolveAreas(parsed.rows, children)
      return resolved.ok ? resolved : undefined
    }

    const pagePlacement = layoutOf(page.layout, rootBlocksOf(page.blocks))
    if (pagePlacement !== undefined) placements.set(page.id, pagePlacement)

    for (const block of page.blocks) {
      if (block.kind !== 'group') continue
      const byId = new Map(page.blocks.map((candidate) => [candidate.id, candidate]))
      const children = (block.children ?? []).map((id) => byId.get(id)).filter((child) => child !== undefined)
      const placement = layoutOf(block.layout, children)
      if (placement !== undefined) placements.set(block.id, placement)
    }

    if (placements.size === 0) return page
    changed = true

    const withPlacement = (holder) => {
      const placement = placements.get(holder.id)
      if (placement === undefined) return holder
      return {
        ...holder,
        layout: {
          ...holder.layout,
          params: { ...holder.layout.params, cols: placement.cols, rows: placement.rows, cells: placement.cells },
        },
      }
    }

    return {
      ...page,
      blocks: page.blocks.map(withPlacement),
      ...(placements.has(page.id) ? withPlacement(page) : {}),
    }
  })

  return changed ? { ...model, pages } : model
}

/**
 * The blocks no container claims.
 *
 * The client has its own copy, because the client half is a standalone bundle with no imports. Both
 * derive the top level instead of storing it, so the tree cannot disagree with the page order.
 *
 * @param blocks - a page's blocks.
 * @returns the blocks that sit at the top level.
 */
function rootBlocksOf(blocks) {
  const claimed = new Set()
  for (const block of blocks) {
    if (block.kind !== 'group') continue
    for (const child of block.children ?? []) claimed.add(child)
  }
  return blocks.filter((block) => !claimed.has(block.id))
}

/**
 * Encode an anchor's target and in-block location.
 *
 * The edge's own fields are encoded by the caller; only the endpoint shape is produced here.
 *
 * The `switch` is deliberately exhaustive with no `default`. This function used to fall through to
 * `${blockId}@unknown`, and that branch was a scar: `validateAnchor` normalised the anchor's `at`
 * with the block-position helper, which dropped `kind`, so *every* located anchor reached the
 * default and hashed identically — an arrow could be re-anchored without the revision moving. A
 * silent fallback would hide that class of bug again, so an unrecognised kind now throws where the
 * invariant is broken instead of quietly producing a wrong hash.
 *
 * @param anchor - the anchor to encode.
 * @returns the encoded fragment.
 */
export function encodeAnchor(anchor) {
  const at = anchor.at
  if (at === undefined || at.kind === 'block') return `${anchor.blockId}@block`
  switch (at.kind) {
    case 'field':
      return `${anchor.blockId}@field:${at.field}`
    case 'item':
      return `${anchor.blockId}@item:${at.itemId}`
    case 'lines':
      return `${anchor.blockId}@lines:${at.from}-${at.to}`
    case 'text':
      return `${anchor.blockId}@text:${at.start}-${at.end}`
    case 'child':
      return `${anchor.blockId}@child:${at.childId}`
    case 'node':
      return `${anchor.blockId}@node:${at.key}`
    case 'rect':
      return `${anchor.blockId}@rect:${quantise(at.x)},${quantise(at.y)},${quantise(at.w)},${quantise(at.h)}`
    case 'point':
      return `${anchor.blockId}@point:${quantise(at.x)},${quantise(at.y)}`
    default:
      throw new Error(`encodeAnchor: unknown anchor kind ${JSON.stringify(at.kind)}`)
  }
}

// Re-exported for tests and callers that need the separators without duplicating literals.
export { FIELD_SEP, ELEMENT_SEP, ID_PATTERN, SLUG_PATTERN }
