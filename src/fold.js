/**
 * The log-native fold: a board is the fold of its own successful `board_apply` calls.
 *
 * Why this shape (see `docs/design/board-model.md` §2): the session log is the only source
 * of truth in DSH, and a plugin may not append its own event types. Tool calls *are*
 * committed events, so expressing the board as a fold over them buys replay, resume, and
 * fork for free and needs no new vocabulary.
 *
 * The event pairing is deliberately two-phase, because `tool/result` does not carry the
 * tool name — only a `callId`:
 *
 *   1. `tool/call` (name `board_apply`)  → remember the ops; change nothing.
 *   2. `tool/result` (no error)          → fold the remembered ops.
 *   3. `tool/result` (error)             → forget them; change nothing.
 *   4. anything else                     → return the same reference (the projection's
 *                                          zero-cost requirement for ignored events).
 *
 * PTC mode is a second path and **must** be handled: under `mode: 'ptc'` a sub-dispatch
 * logs `tool/ptc-dispatch-start` / `tool/ptc-dispatch` instead of `tool/call` /
 * `tool/result`, and PTC is an agent-level mode a plugin cannot opt out of. The one real
 * difference is the arguments: the ordinary path stores the model's raw JSON **as a
 * string**, while the PTC path stores an already-parsed object.
 *
 * @module dsh-superboard/fold
 */

import { createHash } from 'node:crypto'
import {
  BOARD_MODEL_VERSION,
  composeRev,
  deriveIdBody,
  encodeModelForHash,
  emptyBoardDoc,
  parseAreas,
  parseRevSeq,
  pushAlias,
  quantise,
  resolveAreas,
  toSlug,
  uniqSlug,
  BLOCK_KINDS,
  EDGE_RELS,
  LAYOUT_TEMPLATES,
  ID_PREFIX,
} from './model.js'
import { diagnoseModel } from './diagnose.js'
import { attachNodeHints } from './uml.js'

/** The tool whose calls this fold consumes. */
export const BOARD_TOOL_NAME = 'board_apply'

/** The projection key the client reads with `useProjection('board')`. */
export const BOARD_PROJECTION_KEY = 'board'

/**
 * Upper bound on remembered-but-unsettled calls.
 *
 * `pending` lives in the projection state, so it is checkpointed — which means it must not
 * grow without limit. A call whose result never arrives (a cancelled turn) would otherwise
 * sit there forever.
 */
const PENDING_LIMIT = 64

/** @returns a sha256 hex digest, the hasher {@link deriveIdBody} and the revision hash share. */
function sha256Hex(material) {
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

/**
 * Parse the `arguments` carried by a tool event.
 *
 * Both dispatch paths must be accepted, and neither may throw: on the ordinary path DSH
 * preserves invalid model JSON as text by design, so a malformed call is skipped rather
 * than allowed to break the fold.
 *
 * @param raw - a JSON string (ordinary path) or an already-parsed value (PTC path).
 * @returns the parsed object, or `undefined` when it is unusable.
 */
function readArguments(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '') return undefined
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Whether a `tool/result`-shaped event reports failure. */
function isErrorResult(data) {
  return data?.message?.isError === true || data?.isError === true
}

/**
 * Fold one session event into the board document.
 *
 * Pure and synchronous: it reads only `event`, writes only into a copy of `state`, and
 * returns the *same reference* for events it ignores. That last part is a framework
 * requirement, not an optimisation — the projection compares by `Object.is` to decide
 * whether anything downstream needs to hear about the event.
 *
 * @param state - the current board document.
 * @param event - one committed session event, `{ type, seq, data }`.
 * @returns the next board document, or `state` itself when nothing changed.
 */
export function foldBoard(state, event) {
  const type = event?.type

  if (type === 'tool/call') {
    const data = event.data
    if (data?.name !== BOARD_TOOL_NAME) return state
    const args = readArguments(data.arguments)
    if (args === undefined) return state
    return withPending(state, String(data.callId), args)
  }

  if (type === 'tool/ptc-dispatch-start') {
    // The PTC call half. Arguments arrive already parsed.
    const data = event.data
    if (data?.name !== BOARD_TOOL_NAME) return state
    const args = readArguments(data.arguments)
    if (args === undefined) return state
    return withPending(state, String(data.subCallId), args)
  }

  if (type === 'tool/ptc-dispatch') {
    // The PTC result half, in one event. Fold when it did not fail.
    const data = event.data
    if (data?.name !== BOARD_TOOL_NAME) return state
    const callId = String(data.subCallId)
    const seen = state.pending?.[callId]
    if (seen === undefined) return state
    if (data.isError === true) return withoutPending(state, callId)
    return commit(state, callId, seen, event.seq)
  }

  if (type === 'tool/result') {
    const data = event.data
    const callId = String(data?.message?.toolCallId ?? '')
    const seen = state.pending?.[callId]
    if (seen === undefined) return state
    if (isErrorResult(data)) return withoutPending(state, callId)
    return commit(state, callId, seen, event.seq)
  }

  return state
}

/** Remember a call's ops without touching the model. */
function withPending(state, callId, args) {
  const keys = Object.keys(state.pending ?? {})
  const pending = { ...(state.pending ?? {}) }
  pending[callId] = args
  // Bound it: drop the oldest remembered calls once the cap is exceeded.
  if (keys.length >= PENDING_LIMIT) {
    for (const stale of keys.slice(0, keys.length - PENDING_LIMIT + 1)) delete pending[stale]
  }
  return { ...state, pending }
}

/** Forget a call without touching the model. */
function withoutPending(state, callId) {
  const pending = { ...(state.pending ?? {}) }
  delete pending[callId]
  return { ...state, pending }
}

/**
 * Fold one settled batch and advance the revision.
 *
 * A batch that fails any op is dropped whole (rule D3): the log keeps the failed call and
 * its error result, the state simply does not move. That is why a failed write is
 * visible in the transcript but invisible on the board — and it is intentional.
 *
 * **The failure must not propagate.** `apply` runs inside the projection's event drive, so a
 * throw here would abort the fold for every registered key, not just this one. A rejected
 * batch is therefore caught and recorded, not raised.
 *
 * @param state - the board document.
 * @param callId - the settled call.
 * @param args - the call's parsed arguments.
 * @param seq - the settling event's seq, used for deterministic id derivation.
 * @returns the next board document.
 */
function commit(state, callId, args, seq) {
  const ops = Array.isArray(args?.ops) ? args.ops : []
  const rest = withoutPending(state, callId)

  // D11: an empty batch is legal and changes nothing, including the revision.
  if (ops.length === 0) return rest

  let draft
  try {
    draft = applyOps(structuredClone(state.model), ops, {
      sessionId: state.sessionId,
      callSeq: seq,
      callerRev: state.model.rev,
      expectedRevision: args.expected_revision,
    })
  } catch (error) {
    if (!(error instanceof BoardOpError)) throw error
    // Remember that the last batch was rejected, so the outline can say so before the Agent
    // thinks to re-read. Only the most recent rejection is kept: older ones are noise.
    return { ...rest, lastOpError: { callId, message: error.message } }
  }

  const revSeq = state.model.revSeq + 1
  const revHash = sha256Hex(encodeModelForHash(draft)).slice(0, 16)
  // `attachNodeHints` is derived data on the same footing as `areas` cells: it is read out of the
  // diagram's own source, it is excluded from the hash above, and it stops the moment the source
  // does. Recomputed here for the same reason diagnostics are — the fold is the only place that
  // knows a write happened.
  const model = attachNodeHints({ ...draft, revSeq, revHash, rev: composeRev(revSeq, revHash) })
  // Diagnostics are recomputed here rather than at read time: the fold is the only place that
  // knows a write happened, and a broken diagram has to reach the Agent even if nobody ever
  // opens the board. See `src/diagnose.js`.
  const next = {
    ...rest,
    model,
    modelVersion: BOARD_MODEL_VERSION,
    diag: diagnoseModel(model, rest.diag, model.rev),
  }
  return next
}

/**
 * Apply a batch of ops to a model, transactionally.
 *
 * Operates on the object it is given and throws on the first failure, so the caller's
 * dry-run is simply "clone first". Nothing here mutates `model` in place, which makes
 * "a failed batch has no effect" a structural property rather than a discipline someone
 * has to remember.
 *
 * @param model - the board model to transform.
 * @param ops - the ordered batch.
 * @param context - session id, call seq, the caller's revision, and the declared expectation.
 * @returns a new model.
 * @throws {BoardOpError} when any op is malformed or its references do not resolve.
 */
export function applyOps(model, ops, context) {
  if (context.expectedRevision !== undefined && context.expectedRevision !== null) {
    const expected = String(context.expectedRevision)
    // Compare the **sequence number only**, never the hash half.
    //
    // That looks weaker than comparing the whole string, and it is deliberately weaker. The hash
    // is a digest of the content encoding, and the content encoding changes whenever a model
    // version does — so the day `BOARD_MODEL_VERSION` moves, every revision string already in an
    // Agent's context has a hash that can no longer be produced, even though its board is
    // perfectly current. Comparing whole strings then rejects writes whose caller is telling the
    // truth, and the rejection is *silent from the Agent's side*: the tool result still reports
    // success (the tool's dry run ran against the live in-memory model, which had not been
    // re-folded), while the fold drops the batch. That is exactly how ten consecutive batches
    // were lost on 2026-10-04 — see `docs/design/board-model.md` and board issue I2.
    //
    // The seq is the honest signal: it counts successful op batches, so a caller that names the
    // current seq has seen the current board. A caller that names an older one is still refused,
    // which is the failure mode this gate exists for (an Agent acting on an outline it read
    // several turns ago). The hash keeps doing its real job: it makes `rev` change when content
    // changes, so the Agent can tell two same-seq boards apart.
    const expectedSeq = parseRevSeq(expected)
    const currentSeq = parseRevSeq(context.callerRev)
    if (expectedSeq !== currentSeq) {
      throw new BoardOpError(
        `stale board revision: expected ${expected} but the board is now ${context.callerRev}. ` +
          'Nothing was applied. Call board_outline to see the current state, then re-issue the ops you still want.',
      )
    }
  }

  let next = model
  ops.forEach((op, index) => {
    try {
      next = applyOne(next, op, { ...context, opIndex: index })
    } catch (error) {
      // Tag the failing position so the tool can quote `op[i]` back to the model. Without it
      // the Agent gets a reason with no location, which is only half an error.
      if (error instanceof BoardOpError && error.detail?.opIndex === undefined) {
        error.detail = { ...(error.detail ?? {}), opIndex: index, op: op?.op }
      }
      throw error
    }
  })
  return next
}

/** A rejected op, carrying the message the model will see. */
export class BoardOpError extends Error {
  /**
   * @param message - the model-facing explanation.
   * @param detail - optional machine-readable context, including the failing `opIndex`.
   */
  constructor(message, detail) {
    super(message)
    this.name = 'BoardOpError'
    this.detail = detail
  }
}

const MAX_ALIAS = 8

/** Collect every slug and alias in use at page scope, for collision-free allocation. */
function takenPageSlugs(model, exceptId) {
  const taken = new Set()
  for (const page of model.pages) {
    if (page.id === exceptId) continue
    taken.add(page.slug)
    for (const alias of page.alias ?? []) taken.add(alias)
  }
  return taken
}

/** Collect every slug and alias in use inside one page, for collision-free allocation. */
function takenBlockSlugs(page, exceptId) {
  const taken = new Set()
  for (const block of page.blocks) {
    if (block.id === exceptId) continue
    taken.add(block.slug)
    for (const alias of block.alias ?? []) taken.add(alias)
  }
  return taken
}

/** Collect every slug and alias in use by edges or regions (both are board-scoped addresses). */
function takenBoardSlugs(model, family, exceptId) {
  const taken = new Set()
  for (const element of family === 'edge' ? model.edges : model.regions) {
    if (element.id === exceptId) continue
    taken.add(element.slug)
    for (const alias of element.alias ?? []) taken.add(alias)
  }
  return taken
}

/**
 * Resolve a reference string to an element.
 *
 * Order is `id → slug → alias` (rule R1). The current slug wins over another element's
 * alias (R2) — and ambiguity *between two aliases* throws rather than guessing, because a
 * silent pick here would move an arrow somewhere the Agent did not ask for.
 */
function resolveElement(model, ref, kind) {
  if (ref === undefined || ref === null || ref === '') {
    throw new BoardOpError(`missing ${kind} reference`)
  }
  const needle = String(ref).normalize('NFC')

  const candidates = collectCandidates(model, kind)
  const byId = candidates.find((entry) => entry.element.id === needle)
  if (byId !== undefined) return byId

  const bySlug = candidates.filter((entry) => entry.element.slug === needle)
  if (bySlug.length === 1) return bySlug[0]
  if (bySlug.length > 1) {
    throw new BoardOpError(
      `${kind} reference ${JSON.stringify(needle)} is ambiguous between ${bySlug
        .map((entry) => entry.element.id)
        .join(', ')}`,
    )
  }

  const byAlias = candidates.filter((entry) => (entry.element.alias ?? []).includes(needle))
  if (byAlias.length === 1) return byAlias[0]
  if (byAlias.length > 1) {
    throw new BoardOpError(
      `${kind} reference ${JSON.stringify(needle)} matches several retired addresses: ${byAlias
        .map((entry) => `${entry.element.id} (now ${entry.element.slug})`)
        .join(', ')}. Use a current slug or an id.`,
    )
  }

  const known = candidates.map((entry) => entry.element.slug).slice(0, 12)
  throw new BoardOpError(
    `no ${kind} matches ${JSON.stringify(needle)}. Known ${kind} addresses: ${
      known.length === 0 ? '(none yet)' : known.join(', ')
    }`,
  )
}

/** Enumerate resolvable elements of one kind, carrying their owning page when relevant. */
function collectCandidates(model, kind) {
  switch (kind) {
    case 'page':
      return model.pages.map((element) => ({ element }))
    case 'block':
      return model.pages.flatMap((page) =>
        page.blocks.map((element) => ({ element, page, listScope: page.blocks })),
      )
    case 'edge':
      return model.edges.map((element) => ({ element }))
    case 'region':
      return model.regions.map((element) => ({ element }))
    default:
      throw new BoardOpError(`unknown element kind ${JSON.stringify(kind)}`)
  }
}

/** Find the page that owns a block id. */
function pageOfBlock(model, blockId) {
  return model.pages.find((page) => page.blocks.some((block) => block.id === blockId))
}

/** Mint a deterministic element id, linear-probing on collision. */
function mintId(model, context, kind, prefix) {
  const exists = (candidate) => idExists(model, candidate)
  let salt = 0
  for (;;) {
    const body = deriveIdBody(sha256Hex, {
      sessionId: context.sessionId ?? '',
      callSeq: `${context.callSeq ?? 0}:${salt}`,
      opIndex: context.opIndex ?? 0,
      kind,
    })
    const candidate = `${prefix}${body}`
    if (!exists(candidate)) return candidate
    salt += 1
  }
}

/** Whether an id is already used anywhere in the model. */
function idExists(model, id) {
  for (const page of model.pages) {
    if (page.id === id) return true
    for (const block of page.blocks) {
      if (block.id === id) return true
      for (const item of block.items ?? []) if (item.id === id) return true
    }
  }
  for (const edge of model.edges) if (edge.id === id) return true
  for (const region of model.regions) if (region.id === id) return true
  return false
}

/** Require a value to be one of a known set, with a model-facing message. */
function requireOneOf(value, allowed, what) {
  if (allowed.includes(value)) return value
  throw new BoardOpError(
    `invalid ${what} ${JSON.stringify(value)}; expected one of ${allowed.join(', ')}`,
  )
}

/**
 * Apply exactly one op.
 *
 * Every op validates its own preconditions and throws {@link BoardOpError} on failure, so
 * the caller never has to inspect a status: an exception means the batch is dropped.
 *
 * @param model - the model so far.
 * @param op - the op to apply.
 * @param context - session id, call seq, op index, and the caller's revision.
 * @returns the next model.
 */
function applyOne(model, op, context) {
  if (typeof op !== 'object' || op === null) {
    throw new BoardOpError(`op[${context.opIndex}] must be an object, got ${JSON.stringify(op)}`)
  }
  const name = op.op
  if (typeof name !== 'string') {
    throw new BoardOpError(
      `op[${context.opIndex}] is missing "op". Expected one of: ${OP_NAMES.join(', ')}`,
    )
  }

  switch (name) {
    case 'add_page':
      return opAddPage(model, op, context)
    case 'rename_page':
      return opRenamePage(model, op, context)
    case 'reorder_pages':
      return opReorderPages(model, op, context)
    case 'delete_page':
      return opDeletePage(model, op, context)
    case 'add_block':
      return opAddBlock(model, op, context)
    case 'update_block':
      return opUpdateBlock(model, op, context)
    case 'move_block':
      return opMoveBlock(model, op, context)
    case 'delete_block':
      return opDeleteBlock(model, op, context)
    case 'add_edge':
      return opAddEdge(model, op, context)
    case 'update_edge':
      return opUpdateEdge(model, op, context)
    case 'delete_edge':
      return opDeleteEdge(model, op, context)
    case 'set_layout':
      return opSetLayout(model, op, context)
    case 'set_region':
      return opSetRegion(model, op, context)
    case 'delete_region':
      return opDeleteRegion(model, op, context)
    default:
      throw new BoardOpError(
        `unknown op ${JSON.stringify(name)}. Expected one of: ${OP_NAMES.join(', ')}`,
      )
  }
}

/** The op vocabulary, in the order `board-model.md` §2.2 lists it. */
export const OP_NAMES = Object.freeze([
  'add_page',
  'rename_page',
  'reorder_pages',
  'delete_page',
  'add_block',
  'update_block',
  'move_block',
  'delete_block',
  'add_edge',
  'update_edge',
  'delete_edge',
  'set_layout',
  'set_region',
  'delete_region',
])

/** Replace one page by id, leaving the rest untouched. */
function replacePage(model, pageId, mutate) {
  return {
    ...model,
    pages: model.pages.map((page) => (page.id === pageId ? mutate(page) : page)),
  }
}

/** `add_page` — append or insert a page. */
function opAddPage(model, op, context) {
  // The tool schema calls this argument `page` (it may be a slug or a human title), while the
  // op's own field is `slug`. Accepting both keeps the model's most likely phrasing working.
  const requested = op.slug ?? op.page ?? op.title
  const base = toSlug(requested === undefined ? 'page' : String(requested), 'page', model.pages.length + 1)
  const slug = uniqSlug(base, takenPageSlugs(model, undefined))
  const page = {
    id: mintId(model, context, 'page', ID_PREFIX.page),
    slug,
    alias: [],
    blocks: [],
    createdAtRev: context.callerRev,
  }
  if (op.after === undefined) return { ...model, pages: [...model.pages, page] }
  const anchor = resolveElement(model, op.after, 'page').element
  const at = model.pages.findIndex((candidate) => candidate.id === anchor.id)
  const pages = [...model.pages]
  pages.splice(at + 1, 0, page)
  return { ...model, pages }
}

/** `rename_page` — retire the old slug into the alias history. */
function opRenamePage(model, op, context) {
  const page = resolveElement(model, op.page, 'page').element
  if (op.slug === undefined) throw new BoardOpError('rename_page requires "slug"')
  const base = toSlug(String(op.slug), 'page', model.pages.length + 1)
  const slug = uniqSlug(base, takenPageSlugs(model, page.id))
  return replacePage(model, page.id, (current) => ({
    ...current,
    slug,
    alias: pushAlias(current.alias ?? [], current.slug),
  }))
}

/** `reorder_pages` — must be a permutation of every page, or it fails. */
function opReorderPages(model, op) {
  if (!Array.isArray(op.order)) throw new BoardOpError('reorder_pages requires "order" as an array')
  if (op.order.length !== model.pages.length) {
    throw new BoardOpError(
      `reorder_pages needs all ${model.pages.length} pages, got ${op.order.length}. ` +
        'Pass every page id or slug exactly once, in the order you want.',
    )
  }
  const ordered = op.order.map((ref) => resolveElement(model, ref, 'page').element)
  const unique = new Set(ordered.map((page) => page.id))
  if (unique.size !== ordered.length) {
    throw new BoardOpError('reorder_pages listed the same page more than once')
  }
  return { ...model, pages: ordered }
}

/** `delete_page` — refuses the last page, and needs `force` when blocks or edges are affected. */
function opDeletePage(model, op) {
  const page = resolveElement(model, op.page, 'page').element
  if (model.pages.length <= 1) {
    throw new BoardOpError('a board must keep at least one page; nothing was deleted')
  }
  const blockIds = new Set(page.blocks.map((block) => block.id))
  const touching = model.edges.filter(
    (edge) => blockIds.has(edge.from.blockId) || blockIds.has(edge.to.blockId),
  )
  if ((page.blocks.length > 0 || touching.length > 0) && op.force !== true) {
    throw new BoardOpError(
      `page ${JSON.stringify(page.slug)} holds ${page.blocks.length} block(s) and ${touching.length} ` +
        'edge(s) would lose an endpoint. Re-issue with force: true to delete it anyway, ' +
        'or move the blocks first with move_block.',
    )
  }
  return { ...model, pages: model.pages.filter((candidate) => candidate.id !== page.id) }
}

/** Build a block of the requested kind from the op's flat content fields. */
function buildBlock(op, context, model, page, id) {
  const kind = requireOneOf(op.kind, BLOCK_KINDS, 'block kind')
  const base = {
    id,
    kind,
    slug: '',
    alias: [],
    anchors: [],
    createdAtRev: context.callerRev,
    updatedAtRev: context.callerRev,
  }
  if (typeof op.region === 'string') {
    base.regionId = resolveElement(model, op.region, 'region').element.id
  }

  switch (kind) {
    case 'heading':
      return { ...base, level: normaliseLevel(op.level), text: text(op.text, 'text') }
    case 'prose':
      return { ...base, markdown: text(op.markdown, 'markdown'), ...collapsed(op.collapsed) }
    case 'list':
      return {
        ...base,
        ordered: op.ordered === true,
        items: normaliseItems(op.items, context, model, page),
      }
    case 'code':
      return {
        ...base,
        lang: typeof op.lang === 'string' ? op.lang : '',
        code: text(op.code, 'code'),
        ...(typeof op.filename === 'string' ? { filename: op.filename } : {}),
      }
    case 'uml':
      return {
        ...base,
        engine: requireOneOf(op.engine ?? 'mermaid', ['mermaid', 'plantuml'], 'uml engine'),
        diagram: requireOneOf(
          op.diagram ?? 'other',
          ['flowchart', 'sequence', 'class', 'state', 'er', 'gantt', 'other'],
          'uml diagram',
        ),
        source: text(op.source, 'source'),
        // No `nodeHints` here: the node table is read out of `source` by `attachNodeHints` at
        // commit time. Accepting it from an op would make the document a second, staler source for
        // something the source already decides.
      }
    case 'image':
      return {
        ...base,
        src: text(op.src, 'src'),
        alt: typeof op.alt === 'string' ? op.alt : '',
        ...(typeof op.caption === 'string' ? { caption: op.caption } : {}),
        ...(op.naturalSize === undefined ? {} : { naturalSize: normaliseSize(op.naturalSize) }),
      }
    case 'pdf-page':
      return {
        ...base,
        src: text(op.src, 'src'),
        // `pdfPage` is the schema name; `page` is the natural phrasing a model reaches for
        // when updating rather than creating. Accept both.
        page: requirePageNumber(op.pdfPage ?? op.page),
        ...(op.crop === undefined ? {} : { crop: normaliseCrop(op.crop) }),
        ...(typeof op.caption === 'string' ? { caption: op.caption } : {}),
      }
    case 'group':
      return {
        ...base,
        ...(typeof op.title === 'string' ? { title: op.title } : {}),
        children: normaliseChildren(op.children, page, id),
        ...collapsed(op.collapsed),
        // The label is best-effort here: a new group has no slug until `add_block` allocates one, so
        // the `areas` *names* are checked there instead, once the slug and the child list are final.
        ...(op.layout === undefined
          ? {}
          : {
              layout: normaliseLayout(
                op.layout,
                typeof op.slug === 'string' && op.slug.trim() !== '' ? `group ${JSON.stringify(op.slug)}` : 'this new group',
              ),
            }),
      }
    default:
      throw new BoardOpError(`unsupported block kind ${JSON.stringify(kind)}`)
  }
}

/** Source text a slug can be derived from, per kind. */
function slugSource(block) {
  switch (block.kind) {
    case 'heading':
      return block.text
    case 'prose':
      return String(block.markdown ?? '').split('\n')[0]
    case 'code':
      return block.filename ?? block.lang ?? 'code'
    case 'image':
      return block.alt !== '' ? block.alt : String(block.src ?? '').split('/').pop()
    case 'pdf-page':
      return `${String(block.src ?? '').split('/').pop()}-p${block.page}`
    case 'group':
      return block.title ?? 'group'
    case 'uml':
      return `${block.diagram ?? 'uml'}-${block.source ?? ''}`.slice(0, 24)
    case 'list':
      return block.items?.[0]?.text ?? 'list'
    default:
      return 'block'
  }
}

/** `add_block` — allocate a slug, then insert at `after` or append. */
function opAddBlock(model, op, context) {
  const page = resolveElement(model, op.page, 'page').element
  const id = mintId(model, context, `block:${op.kind ?? '?'}`, ID_PREFIX.block)
  const block = buildBlock(op, context, model, page, id)

  const explicit = typeof op.slug === 'string' && op.slug.trim() !== ''
  const base = toSlug(explicit ? op.slug : slugSource(block), block.kind === 'list' ? 'item' : block.kind, page.blocks.length + 1)
  block.slug = uniqSlug(base, takenBlockSlugs(page, id))
  // Now that the group has its final slug and child list, a template's names can be checked against
  // them — the message can name the container the Agent just created.
  if (block.kind === 'group') validateAreas(block.layout, childBlocksOf(block, page))

  const blocks = [...page.blocks]
  if (op.after === undefined) blocks.push(block)
  else {
    const anchor = resolveBlockInPage(page, op.after)
    blocks.splice(blocks.indexOf(anchor) + 1, 0, block)
  }
  return replacePage(model, page.id, (current) => ({ ...current, blocks }))
}

/** Resolve a block reference, requiring it to live in the given page. */
function resolveBlockInPage(page, ref) {
  const needle = String(ref).normalize('NFC')
  const candidates = page.blocks.filter(
    (block) => block.id === needle || block.slug === needle || (block.alias ?? []).includes(needle),
  )
  if (candidates.length === 0) {
    throw new BoardOpError(
      `no block in page ${JSON.stringify(page.slug)} matches ${JSON.stringify(needle)}. ` +
        `Blocks here: ${page.blocks.map((block) => block.slug).join(', ') || '(none)'}`,
    )
  }
  const exact = candidates.find((block) => block.id === needle || block.slug === needle)
  return exact ?? candidates[0]
}

/** `update_block` — patch content fields; `kind`, `id`, and `slug` are not patchable. */
function opUpdateBlock(model, op, context) {
  const found = resolveElement(model, op.block, 'block')
  const page = found.page
  const block = found.element

  const patched = { ...block, updatedAtRev: context.callerRev }
  const patchable = [
    'text',
    'markdown',
    'items',
    'ordered',
    'level',
    'code',
    'lang',
    'filename',
    'source',
    'engine',
    'diagram',
    'src',
    'alt',
    'caption',
    'page',
    'crop',
    'title',
    'collapsed',
  ]
  let touched = false
  for (const field of patchable) {
    if (op[field] === undefined) continue
    touched = true
    if (field === 'level') patched.level = normaliseLevel(op.level)
    else if (field === 'items') patched.items = normaliseItems(op.items, context, model, page)
    else if (field === 'crop') patched.crop = normaliseCrop(op.crop)
    else if (field === 'page') patched.page = requirePageNumber(op.pdfPage ?? op.page)
    else if (field === 'ordered') patched.ordered = op.ordered === true
    else if (field === 'collapsed') patched.collapsed = op.collapsed === true
    else patched[field] = typeof op[field] === 'string' ? op[field].normalize('NFC') : op[field]
  }
  if (Array.isArray(op.anchors)) {
    touched = true
    patched.anchors = op.anchors
  }
  // `children` and `layout` are group-only, and they are patched rather than normalised in the
  // loop above because both need the block's own id: `children` to keep a container from adopting
  // itself, and neither is a plain string assignment.
  if (op.children !== undefined) {
    if (block.kind !== 'group') {
      throw new BoardOpError(
        `block ${JSON.stringify(block.slug)} is a ${block.kind}; only a group has children`,
      )
    }
    touched = true
    patched.children = normaliseChildren(op.children, page, block.id)
  }
  if (op.layout !== undefined) {
    if (block.kind !== 'group') {
      throw new BoardOpError(
        `block ${JSON.stringify(block.slug)} is a ${block.kind}; only a group carries a layout — ` +
          'use set_layout for a page',
      )
    }
    touched = true
    patched.layout = normaliseLayout(op.layout, `group ${JSON.stringify(block.slug)}`)
  }
  if (typeof op.slug === 'string' && op.slug.trim() !== '') {
    touched = true
    const base = toSlug(op.slug, block.kind === 'list' ? 'item' : block.kind, page.blocks.length + 1)
    patched.slug = uniqSlug(base, takenBlockSlugs(page, block.id))
    patched.alias = pushAlias(block.alias ?? [], block.slug)
  }
  if (!touched) {
    throw new BoardOpError(
      `update_block on ${JSON.stringify(block.slug)} changed nothing. Pass at least one content ` +
        `field (${patchable.join(', ')}, slug, or anchors).`,
    )
  }
  // After the slug branch, so a template naming a child is checked against the final child list and
  // the final slug.
  if (patched.kind === 'group') validateAreas(patched.layout, childBlocksOf(patched, page))
  return replacePage(model, page.id, (current) => ({
    ...current,
    blocks: current.blocks.map((candidate) => (candidate.id === block.id ? patched : candidate)),
  }))
}

/** `move_block` — reorder within a page or move across pages. */

/** `move_block` — reorder within a page or move across pages. */
function opMoveBlock(model, op) {
  const found = resolveElement(model, op.block, 'block')
  const from = found.page
  const block = found.element
  const to = resolveElement(model, op.page, 'page').element

  const stripped = { ...from, blocks: from.blocks.filter((candidate) => candidate.id !== block.id) }
  const blocks = [...to.blocks]
  if (op.after === undefined) blocks.push(block)
  else blocks.splice(blocks.indexOf(resolveBlockInPage(to, op.after)) + 1, 0, block)

  if (from.id === to.id) {
    return replacePage(model, from.id, (current) => ({
      ...current,
      blocks: blocks.map((candidate) =>
        candidate.id === block.id ? { ...candidate, updatedAtRev: candidate.updatedAtRev } : candidate,
      ),
    }))
  }
  const pages = model.pages.map((page) => {
    if (page.id === from.id) return stripped
    if (page.id === to.id) return { ...page, blocks }
    return page
  })
  // A block can only belong to a region whose membership still makes sense.
  const regions = model.regions.map((region) => {
    if (block.regionId !== region.id || region.blockIds.includes(block.id)) return region
    return { ...region, blockIds: [...region.blockIds, block.id] }
  })
  return { ...model, pages, regions }
}

/** `delete_block` — a group is ungrouped unless `recursive` says otherwise. */
function opDeleteBlock(model, op) {
  const found = resolveElement(model, op.block, 'block')
  const page = found.page
  const block = found.element

  const doomed = new Set([block.id])
  if (block.kind === 'group' && op.recursive === true) {
    for (const child of block.children ?? []) doomed.add(child)
  }

  const blocks = page.blocks
    .filter((candidate) => !doomed.has(candidate.id))
    .map((candidate) =>
      candidate.kind === 'group' && (candidate.children ?? []).some((child) => doomed.has(child))
        ? { ...candidate, children: candidate.children.filter((child) => !doomed.has(child)) }
        : candidate,
    )

  const regions = model.regions.map((region) =>
    region.blockIds.some((id) => doomed.has(id))
      ? { ...region, blockIds: region.blockIds.filter((id) => !doomed.has(id)) }
      : region,
  )

  // Edges pointing at a deleted block are kept and marked dangling: silently dropping them
  // would destroy a relationship the Agent itself expressed, and it should get the chance
  // to repair it instead.
  return replacePage({ ...model, regions }, page.id, (current) => ({ ...current, blocks }))
}

/**
 * Validate one endpoint of an edge.
 *
 * Accepts the shorthand the Agent will reach for — a bare reference means "the whole block" —
 * as well as the full `{ blockId, at }` form. It then checks that the in-block location is
 * meaningful for the target's kind: `lines` only makes sense on a code block, `rect` only on
 * a bitmap or a PDF page. Catching that here is what stops an arrow from pointing at a
 * position that cannot exist.
 *
 * @param model - the board model, for resolution.
 * @param anchor - a reference string or an anchor object.
 * @param which - `'from'` or `'to'`, for the error message.
 * @returns the normalised anchor, anchored to a block id.
 */
function validateAnchor(model, anchor, which) {
  if (typeof anchor === 'string') {
    return { blockId: resolveElement(model, anchor, 'block').element.id }
  }
  if (typeof anchor !== 'object' || anchor === null) {
    throw new BoardOpError(`${which} must be a block reference or { blockId, at }`)
  }
  const target = resolveElement(model, anchor.blockId, 'block').element
  const at = anchor.at
  if (at === undefined || at.kind === 'block') return { blockId: target.id }
  const allowed = {
    field: ['heading', 'prose', 'code', 'image', 'pdf-page'],
    item: ['list'],
    lines: ['code'],
    text: ['prose', 'heading'],
    child: ['group'],
    node: ['uml'],
    rect: ['image', 'pdf-page'],
    point: ['image', 'pdf-page'],
  }
  const kinds = allowed[at.kind]
  if (kinds === undefined) {
    throw new BoardOpError(
      `${which}.at.kind ${JSON.stringify(at.kind)} is not one of ${Object.keys(allowed).join(', ')}`,
    )
  }
  if (!kinds.includes(target.kind)) {
    throw new BoardOpError(
      `${which}.at.kind ${JSON.stringify(at.kind)} needs a ${kinds.join('/')} block, but ` +
        `${JSON.stringify(target.slug)} is ${target.kind}`,
    )
  }
  return { blockId: target.id, at: normaliseAnchorAt(at, which) }
}

/** `add_edge` — rejects an exact duplicate so the Agent cannot draw the same arrow twice. */
function opAddEdge(model, op, context) {
  const from = validateAnchor(model, op.from, 'from')
  const to = validateAnchor(model, op.to, 'to')
  if (op.rel !== undefined) requireOneOf(op.rel, EDGE_RELS, 'edge rel')
  if (op.style !== undefined) requireOneOf(op.style, ['solid', 'dashed', 'dotted'], 'edge style')

  const duplicate = model.edges.find(
    (edge) =>
      edge.from.blockId === from.blockId &&
      edge.to.blockId === to.blockId &&
      (edge.rel ?? 'relates') === (op.rel ?? 'relates') &&
      (edge.label ?? '') === (op.label ?? ''),
  )
  if (duplicate !== undefined) {
    throw new BoardOpError(
      `an identical edge already exists as ${JSON.stringify(duplicate.slug)} ` +
        `(${duplicate.from.blockId} → ${duplicate.to.blockId}). Update it instead of adding another.`,
    )
  }

  const source =
    typeof op.slug === 'string' && op.slug.trim() !== ''
      ? op.slug
      : `${String(op.label ?? op.rel ?? 'edge')}`
  const base = toSlug(source, 'edge', model.edges.length + 1)
  const edge = {
    id: mintId(model, context, 'edge', ID_PREFIX.edge),
    slug: uniqSlug(base, takenBoardSlugs(model, 'edge', undefined)),
    alias: [],
    from,
    to,
    ...(op.rel === undefined ? {} : { rel: op.rel }),
    ...(typeof op.label === 'string' ? { label: op.label.normalize('NFC') } : {}),
    ...(op.style === undefined ? {} : { style: op.style }),
    createdAtRev: context.callerRev,
    updatedAtRev: context.callerRev,
  }
  return { ...model, edges: [...model.edges, edge] }
}

/** `update_edge` — patch relation, label, style, waypoints, or either endpoint. */
function opUpdateEdge(model, op, context) {
  const edge = resolveElement(model, op.edge, 'edge').element
  const patch = typeof op.patch === 'object' && op.patch !== null ? op.patch : op
  const next = { ...edge, updatedAtRev: context.callerRev }

  if (patch.rel !== undefined) next.rel = requireOneOf(patch.rel, EDGE_RELS, 'edge rel')
  if (patch.label !== undefined) {
    if (patch.label === null) delete next.label
    else next.label = String(patch.label).normalize('NFC')
  }
  if (patch.style !== undefined) {
    next.style = requireOneOf(patch.style, ['solid', 'dashed', 'dotted'], 'edge style')
  }
  if (Array.isArray(patch.waypoints)) next.waypoints = normaliseWaypoints(patch.waypoints)
  if (patch.from !== undefined) next.from = validateAnchor(model, patch.from, 'from')
  if (patch.to !== undefined) next.to = validateAnchor(model, patch.to, 'to')

  return { ...model, edges: model.edges.map((candidate) => (candidate.id === edge.id ? next : candidate)) }
}

/** `delete_edge` — a relation that is explicitly withdrawn really goes away. */
function opDeleteEdge(model, op) {
  const edge = resolveElement(model, op.edge, 'edge').element
  return { ...model, edges: model.edges.filter((candidate) => candidate.id !== edge.id) }
}

/**
 * `set_layout` — replace a page's or group's layout wholesale; `null` restores the default.
 *
 * The scope arrives as a plain reference string (the tool schema says `scope` is a page or group
 * reference, and that is what a model sends), but the op form also accepts the explicit
 * `{ page }` / `{ group }` object. Both are honoured: the schema is the model's interface, so it
 * is the one that has to work.
 */
function opSetLayout(model, op) {
  if (op.layout === null) {
    const target = resolveLayoutScope(model, op.scope)
    return withLayout(model, target, undefined)
  }

  // Either a full `layout` object, or the flattened `template` + params the schema declares.
  const spec =
    op.layout !== undefined
      ? op.layout
      : op.template === undefined
        ? undefined
        : {
            template: op.template,
            ...(collectLayoutParams(op) === undefined ? {} : { params: collectLayoutParams(op) }),
          }
  if (spec === undefined) {
    throw new BoardOpError(
      `set_layout needs a "template" (${LAYOUT_TEMPLATES.join(', ')}), or layout: null to restore the default`,
    )
  }

  const target = resolveLayoutScope(model, op.scope)
  const label =
    target.kind === 'page'
      ? `page ${JSON.stringify(target.element.slug)}`
      : `group ${JSON.stringify(target.element.slug)}`
  const layout = normaliseLayout(spec, label)
  // Neither a page's roots nor a group's children change in `set_layout`, so the template's names can
  // be checked against the container as it already stands.
  validateAreas(layout, arrangedBy(target, model))
  return withLayout(model, target, layout)
}

/** Collect the flattened layout parameters the tool schema declares. */
function collectLayoutParams(op) {
  const params = {}
  if (op.cols !== undefined) params.cols = Number(op.cols)
  if (op.gap !== undefined) params.gap = Number(op.gap)
  if (op.minCardWidth !== undefined) params.minCardWidth = Number(op.minCardWidth)
  if (op.areas !== undefined) params.areas = op.areas
  return Object.keys(params).length === 0 ? undefined : params
}

/**
 * Resolve a layout scope, which the schema writes as a bare reference.
 *
 * Pages are tried first because that is the common case, and the error names both families so a
 * miss is actionable rather than a dead end.
 */
function resolveLayoutScope(model, scope) {
  if (typeof scope === 'string') {
    const asPage = tryResolve(model, scope, 'page')
    if (asPage !== undefined) return { kind: 'page', element: asPage.element }
    const asGroup = tryResolve(model, scope, 'block')
    if (asGroup !== undefined && asGroup.element.kind === 'group') {
      return { kind: 'group', element: asGroup.element, page: asGroup.page }
    }
    throw new BoardOpError(
      `set_layout scope ${JSON.stringify(scope)} matches no page or group. Pages: ${
        model.pages.map((page) => page.slug).join(', ') || '(none)'
      }; groups: ${model.pages
        .flatMap((page) => page.blocks.filter((block) => block.kind === 'group'))
        .map((block) => block.slug)
        .join(', ') || '(none)'}`,
    )
  }
  if (typeof scope === 'object' && scope !== null) {
    if (scope.page !== undefined) {
      return { kind: 'page', element: resolveElement(model, scope.page, 'page').element }
    }
    if (scope.group !== undefined) {
      const found = resolveElement(model, scope.group, 'block')
      if (found.element.kind !== 'group') {
        throw new BoardOpError(
          `set_layout scope.group names ${JSON.stringify(found.element.slug)}, a ${found.element.kind}, not a group`,
        )
      }
      return { kind: 'group', element: found.element, page: found.page }
    }
  }
  throw new BoardOpError(
    'set_layout requires "scope" as a page or group reference. Regions are annotation only and carry no layout.',
  )
}

/**
 * Apply a layout (or its absence) to a resolved scope.
 *
 * A `region` is deliberately not a legal scope: the layout grill split "where things go" (a group,
 * or a page) from "what to look at" (a region). Accepting a region here is what made the two
 * ambiguous, so a region scope now fails with a message naming the group alternative.
 */
function withLayout(model, target, layout) {
  if (target.kind === 'page') {
    return replacePage(model, target.element.id, (current) => {
      const next = { ...current }
      if (layout === undefined) delete next.layout
      else next.layout = layout
      return next
    })
  }
  const page = target.page ?? model.pages.find((candidate) =>
    candidate.blocks.some((block) => block.id === target.element.id),
  )
  if (page === undefined) {
    throw new BoardOpError(`set_layout cannot find the page owning group ${JSON.stringify(target.element.slug)}`)
  }
  return replacePage(model, page.id, (current) => ({
    ...current,
    blocks: current.blocks.map((block) => {
      if (block.id !== target.element.id) return block
      const next = { ...block }
      if (layout === undefined) delete next.layout
      else next.layout = layout
      return next
    }),
  }))
}

/** `set_region` — upsert a semantic cluster; membership is replaced wholesale. */
function opSetRegion(model, op, context) {
  const blockIds = Array.isArray(op.blockIds)
    ? op.blockIds.map((ref) => resolveElement(model, ref, 'block').element.id)
    : undefined

  // A block belongs to at most one region, so membership is exclusive in both directions.
  const previous = op.region === undefined ? undefined : tryResolve(model, op.region, 'region')
  const members = new Set(blockIds ?? previous?.element.blockIds ?? [])

  let regions = model.regions
  if (previous !== undefined) {
    regions = regions.map((region) => {
      if (region.id === previous.element.id) {
        const next = { ...region, blockIds: [...members] }
        if (op.label !== undefined) next.label = String(op.label).normalize('NFC')
        if (op.tone !== undefined) {
          next.tone = requireOneOf(op.tone, ['neutral', 'warn', 'danger', 'ok'], 'region tone')
        }
        if (typeof op.slug === 'string' && op.slug.trim() !== '') {
          next.slug = uniqSlug(
            toSlug(op.slug, 'region', model.regions.length + 1),
            takenBoardSlugs(model, 'region', region.id),
          )
          next.alias = pushAlias(region.alias ?? [], region.slug)
        }
        return next
      }
      return { ...region, blockIds: region.blockIds.filter((id) => !members.has(id)) }
    })
  } else {
    if (blockIds === undefined) throw new BoardOpError('set_region requires "blockIds" when creating')
    const base = toSlug(op.slug ?? op.label ?? 'region', 'region', model.regions.length + 1)
    regions = [
      ...regions.map((region) => ({
        ...region,
        blockIds: region.blockIds.filter((id) => !members.has(id)),
      })),
      {
        id: mintId(model, context, 'region', ID_PREFIX.region),
        slug: uniqSlug(base, takenBoardSlugs(model, 'region', undefined)),
        alias: [],
        blockIds: [...members],
        ...(op.label === undefined ? {} : { label: String(op.label).normalize('NFC') }),
        ...(op.tone === undefined
          ? {}
          : { tone: requireOneOf(op.tone, ['neutral', 'warn', 'danger', 'ok'], 'region tone') }),
        createdAtRev: context.callerRev,
      },
    ]
  }

  const pages = model.pages.map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => {
      const inMembers = members.has(block.id)
      const owner = regions.find((region) => region.blockIds.includes(block.id))
      const nextRegionId = owner?.id
      if (block.regionId === nextRegionId) return block
      const next = { ...block }
      if (nextRegionId === undefined) delete next.regionId
      else next.regionId = nextRegionId
      return next
    }),
  }))

  return { ...model, pages, regions }
}

/** `delete_region` — removes the container only; blocks and edges stay. */
function opDeleteRegion(model, op) {
  const region = resolveElement(model, op.region, 'region').element
  return {
    ...model,
    regions: model.regions.filter((candidate) => candidate.id !== region.id),
    pages: model.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => {
        if (block.regionId !== region.id) return block
        const next = { ...block }
        delete next.regionId
        return next
      }),
    })),
  }
}

/** Resolve without throwing, for upsert-shaped ops. */
function tryResolve(model, ref, kind) {
  try {
    return resolveElement(model, ref, kind)
  } catch {
    return undefined
  }
}

/** Require a string field, with a model-facing message. */
function text(value, field) {
  if (typeof value !== 'string') {
    throw new BoardOpError(`"${field}" must be a string, got ${typeof value}`)
  }
  return value.normalize('NFC')
}

/** Narrow a heading level. */
function normaliseLevel(value) {
  const level = value === undefined ? 2 : Number(value)
  if (level !== 1 && level !== 2 && level !== 3) {
    throw new BoardOpError(`heading "level" must be 1, 2, or 3, got ${JSON.stringify(value)}`)
  }
  return level
}

/** A positive 1-based page number. */
function requirePageNumber(value) {
  const page = Number(value)
  if (!Number.isInteger(page) || page < 1) {
    throw new BoardOpError(`"page" must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return page
}

/** Only spread `collapsed` when the author said something about it. */
function collapsed(value) {
  return value === undefined ? {} : { collapsed: value === true }
}

/** Normalise a list's items, minting a stable id per item so anchors do not drift. */
function normaliseItems(value, context, model, page) {
  if (!Array.isArray(value)) throw new BoardOpError('"items" must be an array')
  return value.map((item, index) => {
    if (typeof item === 'string') {
      return {
        id: mintId(model, { ...context, opIndex: `${context.opIndex}:i${index}` }, 'item', ID_PREFIX.listItem),
        text: item.normalize('NFC'),
        depth: 0,
      }
    }
    if (typeof item !== 'object' || item === null) {
      throw new BoardOpError(`items[${index}] must be a string or an object`)
    }
    return {
      id: mintId(model, { ...context, opIndex: `${context.opIndex}:i${index}` }, 'item', ID_PREFIX.listItem),
      text: text(item.text, `items[${index}].text`),
      depth: Number.isInteger(item.depth) && item.depth >= 0 ? item.depth : 0,
      ...(item.checked === undefined ? {} : { checked: item.checked === true }),
    }
  })
}

/**
 * Validate a group's children: same page, existing, and claimed by no other group.
 *
 * **Groups nest**, which is the point of the layout grill's decision: a page lays out its blocks, a
 * group lays out its children, and a group may itself be a child — so the Agent edits a tree, the
 * structure it already reasons in natively.
 *
 * Two rules keep that tree well-formed rather than merely acyclic:
 *
 *   - **Exclusive membership.** A block belongs to at most one group, so the structure is a forest
 *     by construction — which is what makes a cycle impossible without needing a traversal to
 *     detect one. The owner set deliberately excludes `selfId`, since a container's own children
 *     are being replaced and must be free to re-adopt.
 *   - **No self-membership.** With exclusive membership the only cycle left is a group listing
 *     itself, which is cheap to reject outright.
 *
 * @param value - the `children` references.
 * @param page - the owning page.
 * @param selfId - the id of the group being built or patched, excluded from the owner scan.
 * @returns the resolved child ids.
 */
function normaliseChildren(value, page, selfId) {
  if (!Array.isArray(value)) throw new BoardOpError('group "children" must be an array of block references')
  const claimed = new Set()
  for (const block of page.blocks) {
    if (block.kind !== 'group' || block.id === selfId) continue
    for (const child of block.children ?? []) claimed.add(child)
  }
  const seen = new Set()
  return value.map((ref) => {
    const child = resolveBlockInPage(page, ref)
    if (child.id === selfId) {
      throw new BoardOpError(`group ${JSON.stringify(child.slug)} cannot contain itself`)
    }
    if (seen.has(child.id)) {
      throw new BoardOpError(`block ${JSON.stringify(child.slug)} is listed twice in the same group`)
    }
    seen.add(child.id)
    if (claimed.has(child.id)) {
      throw new BoardOpError(
        `block ${JSON.stringify(child.slug)} already belongs to another group; a block may belong to at most one`,
      )
    }
    return child.id
  })
}

/** The heading/prose/code fields an anchor may name. */
const ANCHOR_FIELDS = ['title', 'code', 'caption', 'filename']

/**
 * Require a whole number, which is what every numeric anchor coordinate is.
 *
 * Anchors do not get the block-position default of zero. A half-formed `{ kind: 'lines', from: 1 }`
 * is an Agent that meant a range and lost half of it, and quietly anchoring it at line 0 would
 * point the arrow somewhere nobody asked for while reporting success.
 *
 * @param value - the candidate number.
 * @param what - the dotted path, for the error message.
 * @returns the integer.
 */
function requireInt(value, what) {
  const n = Number(value)
  if (value === undefined || value === null || !Number.isFinite(n)) {
    throw new BoardOpError(`${what} must be a number, got ${JSON.stringify(value)}`)
  }
  return Math.trunc(n)
}

/**
 * Normalise an anchor's in-block location.
 *
 * An anchor's `at` is a discriminated union answering *which part of the block* the arrow points
 * at. It is not a block position, even though both are spelled `at`, and it used to be normalised
 * with the block-position helper — which reads `x`/`y`/`w`/`h` and returns only those, so every
 * located anchor came out of the fold as `{ x: 0, y: 0 }`. Two things followed, both silent:
 * `encodeAnchor` fell through to `@unknown`, so re-anchoring an arrow never moved the revision and
 * the Agent's own retry looked like a no-op; and `boardWireSchema` rejected the edge, which takes
 * the whole board view down. Rebuilding the union member explicitly is what keeps the kind.
 *
 * @param value - the anchor's `at`, already checked against the kinds the target block allows.
 * @param which - `from` or `to`, for the error message.
 * @returns the normalised union member.
 */
function normaliseAnchorAt(value, which) {
  switch (value.kind) {
    case 'field':
      return { kind: 'field', field: requireOneOf(value.field, ANCHOR_FIELDS, `${which}.at.field`) }
    case 'item':
      return { kind: 'item', itemId: requireText(value.itemId, `${which}.at.itemId`) }
    case 'lines':
      return {
        kind: 'lines',
        from: requireInt(value.from, `${which}.at.from`),
        to: requireInt(value.to, `${which}.at.to`),
      }
    case 'text': {
      const text = {
        kind: 'text',
        start: requireInt(value.start, `${which}.at.start`),
        end: requireInt(value.end, `${which}.at.end`),
      }
      if (value.quote !== undefined) text.quote = requireText(value.quote, `${which}.at.quote`)
      return text
    }
    case 'child':
      return { kind: 'child', childId: requireText(value.childId, `${which}.at.childId`) }
    case 'node':
      return { kind: 'node', key: requireText(value.key, `${which}.at.key`) }
    case 'rect':
      return {
        kind: 'rect',
        x: quantise(value.x),
        y: quantise(value.y),
        w: quantise(value.w),
        h: quantise(value.h),
      }
    case 'point':
      return { kind: 'point', x: quantise(value.x), y: quantise(value.y) }
    default:
      // Unreachable: validateAnchor rejects an unknown kind against its `allowed` table first.
      throw new BoardOpError(`${which}.at.kind ${JSON.stringify(value.kind)} has no normaliser`)
  }
}

/** Require a non-empty string, which is what every identifying anchor field is. */
function requireText(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BoardOpError(`${what} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Normalise a layout spec (Q-E: the Agent names a template, the engine does the geometry).
 *
 * An `areas` template is checked for shape here — that it is a rectangle of cells, that it is on a
 * `grid`, and that it is not contradicted by `cols` or `minCardWidth`. Those are all properties of
 * the spec the Agent wrote. The *names* in it are checked separately, once the container's children
 * are known and the container has a slug to name in the error.
 *
 * The two contradicting forms are refused rather than reconciled: silently dropping one of two
 * instructions is how a board ends up looking like neither.
 *
 * @param value - the layout spec.
 * @param label - how to name the container in an error, when the caller knows.
 * @returns the normalised layout.
 */
function normaliseLayout(value, label = 'the container') {
  if (typeof value !== 'object' || value === null) throw new BoardOpError('"layout" must be an object')
  const template = requireOneOf(value.template, LAYOUT_TEMPLATES, 'layout template')
  const layout = { template }
  if (value.params !== undefined) layout.params = { ...value.params }
  if (value.hints !== undefined) layout.hints = { ...value.hints }

  const areas = layout.params?.areas
  if (areas !== undefined) {
    if (template !== 'grid') {
      throw new BoardOpError(`areas is a grid parameter, but ${label} is ${JSON.stringify(template)}`)
    }
    if (layout.params.cols !== undefined || layout.params.minCardWidth !== undefined) {
      throw new BoardOpError('areas already fixes the column count; drop cols and minCardWidth')
    }
    const parsed = parseAreas(areas)
    if (!parsed.ok) throw new BoardOpError(parsed.error)
    // Store the canonical rows so the hash sees one spelling of a template, however it was written.
    layout.params.areas = parsed.rows.map((row) => row.join(' '))
  }
  return layout
}

/**
 * Check an `areas` template against the blocks it names.
 *
 * The *shape* was already checked by {@link normaliseLayout}, which is the only place that knows the
 * template. Names need the children, so they are checked here — and this runs late, after a new
 * group has its allocated slug, so the error can name the container the Agent just created.
 *
 * @param layout - the normalised layout, or none.
 * @param children - the blocks the container arranges.
 */
function validateAreas(layout, children) {
  const areas = layout?.params?.areas
  if (areas === undefined) return
  const parsed = parseAreas(areas)
  if (!parsed.ok) throw new BoardOpError(parsed.error)
  const resolved = resolveAreas(parsed.rows, children)
  if (!resolved.ok) throw new BoardOpError(resolved.error)
}

/** The blocks no container claims, which is what a page-level template arranges. */
function rootBlocksOf(page) {
  const claimed = new Set()
  for (const block of page.blocks) {
    if (block.kind !== 'group') continue
    for (const child of block.children ?? []) claimed.add(child)
  }
  return page.blocks.filter((block) => !claimed.has(block.id))
}

/** A group's children, resolved from ids to blocks; a dangling id is skipped, not invented. */
function childBlocksOf(block, page) {
  return (block.children ?? [])
    .map((id) => page.blocks.find((candidate) => candidate.id === id))
    .filter((child) => child !== undefined)
}

/** The blocks a resolved layout scope arranges: a page's roots, or a group's children. */
function arrangedBy(target, model) {
  if (target.kind === 'page') return rootBlocksOf(target.element)
  const page =
    target.page ?? model.pages.find((candidate) => candidate.blocks.some((block) => block.id === target.element.id))
  return page === undefined ? [] : childBlocksOf(target.element, page)
}

/** Quantise a crop rectangle so float noise cannot reach the hash. */
function normaliseCrop(value) {
  if (typeof value !== 'object' || value === null) throw new BoardOpError('"crop" must be an object')
  return {
    x: quantise(value.x),
    y: quantise(value.y),
    w: quantise(value.w),
    h: quantise(value.h),
  }
}

/** Normalise an image's natural size. */
function normaliseSize(value) {
  if (typeof value !== 'object' || value === null) throw new BoardOpError('"naturalSize" must be an object')
  return { w: Math.trunc(Number(value.w) || 0), h: Math.trunc(Number(value.h) || 0) }
}

/** Quantise edge waypoints. */
function normaliseWaypoints(value) {
  return value.map((point) => ({ x: quantise(point?.x), y: quantise(point?.y) }))
}

/**
 * The revision hash a model encodes to.
 *
 * Exposed because the revision is the Agent's concurrency token, and a tool that cannot tell
 * the Agent what the board will be called afterwards leaves it guessing.
 *
 * @param model - the authoritative board model.
 * @returns the 16-hex content hash.
 */
export function hashModel(model) {
  return sha256Hex(encodeModelForHash(model)).slice(0, 16)
}

/**
 * The revision a batch would settle at, without committing anything.
 *
 * The hash depends on element ids, and element ids are derived from the committed event's
 * `seq`. Until the call settles that seq is unknown, so a preview necessarily uses a stand-in
 * and its hash will differ from the authoritative one. The sequence number, however, is exact —
 * and that is the part the Agent uses to recognise its own write. Callers must therefore say
 * plainly that this string is a preview.
 *
 * @param model - the model to apply against.
 * @param ops - the batch.
 * @param options - session id and the stand-in call seq.
 * @returns the projected `rev` string.
 */
export function previewRevision(model, ops, options = {}) {
  const draft = applyOps(structuredClone(model), ops, {
    sessionId: options.sessionId ?? '',
    callSeq: options.callSeq ?? 'preview',
    callerRev: model.rev,
  })
  const revSeq = model.revSeq + 1
  return composeRev(revSeq, hashModel(draft))
}

export { emptyBoardDoc, MAX_ALIAS }
