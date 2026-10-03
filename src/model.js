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

/** The projection's state version. Bump on any change to `BoardDoc`'s fields or fold semantics. */
export const BOARD_MODEL_VERSION = 1

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

/** Layout templates (Q-E: the Agent declares structure, the engine decides geometry). */
export const LAYOUT_TEMPLATES = Object.freeze(['flow', 'columns', 'grid', 'tree', 'canvas'])

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

/** A slug, after normalisation: letters, digits, underscore, hyphen. Chinese passes via `\p{L}`. */
const SLUG_PATTERN = /^[\p{L}\p{N}_-]+$/u

/** Maximum slug length in Unicode code points. */
const SLUG_MAX = 24

/** How many retired slugs an element remembers. Older ones are dropped, not re-exposed. */
const ALIAS_MAX = 8

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
    // eslint-disable-next-line no-control-regex -- control characters are exactly what we strip
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, '')
    .slice(0, SLUG_MAX)
  const trimmed = normalised.replace(/^-+|-+$/gu, '')
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
      region.layout === undefined ? '' : encodeLayout(region.layout),
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
  parts.push(
    block.at === undefined
      ? ''
      : `${Math.trunc(block.at.x)},${Math.trunc(block.at.y)},${Math.trunc(block.at.w ?? 0)},${Math.trunc(block.at.h ?? 0)}`,
    FIELD_SEP,
  )

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
        FIELD_SEP,
        block.pageCount === undefined ? '' : String(block.pageCount),
      )
      break
    case 'group':
      parts.push(block.title ?? '', FIELD_SEP, block.children.join(','), FIELD_SEP, block.collapsed === true ? '1' : '0')
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
    (hints.bands ?? []).map((band) => band.join(',')).join(';'),
    ':',
    hints.titleBlock === undefined ? '' : hints.titleBlock ? '1' : '0',
  ].join('')
}

/**
 * Encode an anchor's target and in-block location.
 *
 * The edge's own fields are encoded by the caller; only the endpoint shape is produced here.
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
      return `${anchor.blockId}@unknown`
  }
}

// Re-exported for tests and callers that need the separators without duplicating literals.
export { FIELD_SEP, ELEMENT_SEP, ID_PATTERN, SLUG_PATTERN }
