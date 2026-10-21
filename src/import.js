/**
 * Importing another session's board.
 *
 * The board is the fold of its own `board_apply` log, so "import" is not a copy of anything the
 * plugin owns — it is **reading another session's projection and replaying it as ops**. That is
 * why there is no import format, no file, and no schema of our own: the wire value the target
 * session already folded is the source, and `board_apply`'s own op vocabulary is the destination.
 *
 * Two properties are load-bearing.
 *
 * **The source is a live session, not a file.** `ctx.sessions` holds the sessions this process has
 * open; `ctx.sessionProjections.stateOf(session, 'board')` folds any of them on demand, including
 * ones this process restored. Reading a log off disk would mean re-implementing the fold and the
 * migration chain, and a second fold is a second chance to disagree.
 *
 * **Ids are not carried over.** An id is a hash of `(sessionId, callSeq, opIndex, kind)`, so the ids
 * in the source session cannot name anything in the target. Everything is addressed by **slug**,
 * which is derived from the model, and the fold mints fresh ids on the way in. That is also why a
 * slug collision in the target gets a suffix rather than an error — the import is additive by
 * design and never overwrites.
 */

import { BLOCK_KINDS } from './model.js'
import { BoardOpError } from './fold.js'

/** The kinds whose field names differ between the wire block and an `add_block` op. */
const FIELD_ALIASES = Object.freeze({
  'pdf-page': (block) => ({ pdfPage: block.page }),
})

/**
 * Turn one wire block into the arguments of an `add_block` op.
 *
 * The two shapes are close but not identical, and the differences are exactly the trap: a wire
 * block says `page: 3` for a PDF page number while an op says `pdfPage`, because `page` on that
 * branch already means the owning page. Passing the wire object straight through would silently
 * drop the page number.
 *
 * @param block - a wire block from the source board.
 * @param pageSlug - the slug of the page it is being added to.
 * @param slugFor - maps a source slug to an address that is free in the target.
 * @returns the op arguments.
 */
export function blockToAddArgs(block, pageSlug, slugFor = (slug) => slug) {
  const args = { page: pageSlug, kind: block.kind, slug: slugFor(block.slug ?? block.id) }
  const carry = {
    heading: ['text', 'level'],
    prose: ['markdown'],
    list: ['ordered', 'items'],
    code: ['lang', 'code', 'filename'],
    uml: ['engine', 'diagram', 'source'],
    image: ['src', 'alt', 'caption'],
    'pdf-page': ['src', 'caption', 'crop'],
    group: ['title', 'layout'],
  }[block.kind]
  for (const field of carry ?? []) {
    if (block[field] !== undefined) args[field] = block[field]
  }
  const alias = FIELD_ALIASES[block.kind]
  if (alias !== undefined) Object.assign(args, alias(block))
  return args
}

/**
 * Build the op batch that recreates one board inside a target page.
 *
 * Order matters and is not cosmetic: a group names its children, so every child has to exist
 * before the group does — which means a post-order walk rather than the board's own order.
 *
 * @param model - the source board's wire model.
 * @param opts - `{ slugFor, reusePage }`. `slugFor` maps a page or block slug onto a target
 *   address. `reusePage` is the slug of an existing **empty** page to fill instead of creating a
 *   new one — which is the case this feature exists for: importing into a fresh board, whose
 *   placeholder page would otherwise be left behind as an empty tab.
 * @returns the ops, ready for `board_apply`.
 */
export function importOps(model, opts = {}) {
  if (model === null || typeof model !== 'object') throw new BoardOpError('nothing to import')
  const pages = Array.isArray(model.pages) ? model.pages : []
  if (pages.length === 0) throw new BoardOpError('the source board has no pages')
  // A board with pages but nothing on them is the state a session is in before it has written
  // anything at all. Importing it would report success and change the target's page slugs for no
  // benefit, so it is refused here — "that conversation never built a board" is the answer the
  // caller needs, and an empty batch would hide it.
  const hasContent = pages.some((page) => (page.blocks ?? []).length > 0) || (model.edges ?? []).length > 0
  if (!hasContent) {
    throw new BoardOpError(
      'the source board is empty: that conversation has pages but nothing on them, so there is ' +
        'nothing to import. Import is for a board that was actually built.',
    )
  }
  const slugFor = typeof opts.slugFor === 'function' ? opts.slugFor : (slug) => slug
  const reusePage = typeof opts.reusePage === 'string' ? opts.reusePage : undefined
  const ops = []

  for (const [index, page] of pages.entries()) {
    // The placeholder page is filled by the first imported page rather than sitting beside it: a
    // board that arrives with an empty tab named `main` is a board the user has to tidy up.
    const pageSlug = index === 0 && reusePage !== undefined ? reusePage : slugFor(page.slug)
    if (!(index === 0 && reusePage !== undefined)) ops.push({ op: 'add_page', page: pageSlug })
    const blocks = Array.isArray(page.blocks) ? page.blocks : []
    const byId = new Map(blocks.map((block) => [block.id, block]))

    /** Only what no group claims is a root; a claimed block is emitted through its parent. */
    const claimed = new Set()
    for (const block of blocks) {
      if (block.kind === 'group') for (const id of block.children ?? []) claimed.add(id)
    }

    const emitted = new Set()
    /**
     * Emit a block **after** its children.
     *
     * A group names its children by slug, so they have to exist by the time the group is added —
     * which makes this a post-order walk, not board order. Doing it the other way round fails at
     * the fold with `no block in page "…" matches "…"`, the same message a genuine typo produces.
     *
     * A child id that resolves to nothing is dropped from the `children` list rather than passed
     * on: the source fold tolerated the dangling reference, but this batch does not have to
     * reproduce a defect.
     */
    const emit = (block) => {
      if (emitted.has(block.id)) return
      emitted.add(block.id)
      if (block.kind === 'group') {
        for (const id of block.children ?? []) {
          const child = byId.get(id)
          if (child !== undefined) emit(child)
        }
      }
      const args = blockToAddArgs(block, pageSlug, slugFor)
      if (block.kind === 'group') {
        args.children = (block.children ?? [])
          .filter((id) => byId.has(id))
          .map((id) => slugFor(byId.get(id).slug ?? id))
      }
      ops.push({ op: 'add_block', ...args })
    }

    // Roots first in board order — then a second pass for anything claimed but orphaned, so a
    // dangling child that no group actually exists for is still imported rather than lost.
    for (const block of blocks) if (!claimed.has(block.id)) emit(block)
    for (const block of blocks) emit(block)
  }

  const slugOfBlock = new Map()
  for (const page of pages) {
    for (const block of page.blocks ?? []) slugOfBlock.set(block.id, slugFor(block.slug ?? block.id))
  }

  // Only edges whose both ends landed somewhere. A cross-page edge is legal in the target because
  // every page exists by now; an edge naming a block the source no longer has is not.
  for (const edge of model.edges ?? []) {
    const fromId = typeof edge.from === 'string' ? edge.from : edge.from?.blockId
    const toId = typeof edge.to === 'string' ? edge.to : edge.to?.blockId
    if (!slugOfBlock.has(fromId) || !slugOfBlock.has(toId)) continue
    const args = { from: slugOfBlock.get(fromId), to: slugOfBlock.get(toId) }
    for (const field of ['rel', 'label', 'style', 'waypoints']) {
      if (edge[field] !== undefined) args[field] = edge[field]
    }
    ops.push({ op: 'add_edge', ...args })
  }

  // The guard at the top counts what the source *holds*; this counts what the target would
  // actually *receive*. They differ when a board has edges and nothing for them to attach to: the
  // endpoints never resolve, every edge is skipped, and the batch is `add_page` alone. That is not
  // an import — it is a page rename dressed up as one — so it is refused too.
  if (!ops.some((op) => op.op === 'add_block' || op.op === 'add_edge')) {
    throw new BoardOpError(
      'the source board has edges but no blocks for them to attach to, so importing it would ' +
        'create nothing. Import is for a board that was actually built.',
    )
  }

  return ops
}

/**
 * Read another session's board.
 *
 * Two shapes of session share one path here, and the difference is not cosmetic. A session that
 * is **live** in this process has a projection the registry has already folded, and `stateOf`
 * hands it over synchronously. A session that is **stored but cold** — the user switched away, or
 * the process restarted — has no in-memory session at all, so `ctx.sessions.get` returns
 * `undefined` and there is nothing to read. `sessionQuery.read` is the host seam that covers both:
 * it prefers the live session, and otherwise reads the stored log and folds a fresh `Session` from
 * it (`dsh-session-query/lib/index.js:350-397`), then hydrates every registered projection over
 * that fold (`:509-513` → `dsh-session-projection/lib/index.js:329-361`).
 *
 * Without it, "import the board from that conversation" would only work for conversations that
 * happen to still be in memory, which is the one case where the user does not need it.
 *
 * Both branches end up with a wire value, and both wire values carry `model`; only the wire drops
 * `pending` and `sessionId`, neither of which an import wants. So the source id in the error
 * message is the *stored* one, and reading either shape returns the same thing.
 *
 * @param deps - `{ sessionQuery, sessions, projections }`, any of which may be a getter.
 * @param sessionId - the source session.
 * @returns `{ model, title }` — the source board's wire model.
 * @throws {BoardOpError} when no session has that id, or it never had this plugin mounted.
 */
export async function readSourceBoard(deps, sessionId) {
  const read = (value) => (typeof value === 'function' ? value() : value)
  const sessionQuery = read(deps?.sessionQuery)
  const sessions = read(deps?.sessions)
  const projections = read(deps?.projections)
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new BoardOpError('which session should the board be imported from? Pass its id.')
  }

  let model
  if (typeof sessionQuery?.observeSession === 'function') {
    // The cold-capable path. `sessionQuery` is a service whose method is `observeSession`, **not**
    // `read`: `read` is the private observation reader's method, one layer down
    // (`dsh-session-query/lib/index.js:350`), while the service exposes
    // `observeSession(sessionId, options)` (`:1064-1066`). Calling a method that does not exist
    // throws inside this `try` and would be reported as "the session could not be read", which is
    // a lie about the session.
    //
    // `projectionMode` defaults to "all", which is what we want: the registry hydrates every unit
    // and hands the board back inside `values`.
    let observation
    try {
      observation = await sessionQuery.observeSession(sessionId)
    } catch (error) {
      throw new BoardOpError(describeQueryFailure(sessionId, error))
    }
    const board = observation?.projections?.values?.board
    if (board === undefined) {
      throw new BoardOpError(
        `session ${JSON.stringify(sessionId)} has no board projection, so this plugin was not ` +
          'mounted while that conversation ran. There is no board to import from it.',
      )
    }
    model = board.model
  } else if (projections !== undefined) {
    // No `sessionQuery` in this profile. That service is *optional* and, as this project learned
    // the hard way (board issue I11), a plugin that fails to load is logged and skipped rather
    // than fatal — so its absence says nothing about the session. Read the stored log directly
    // instead, through the services that are always there.
    //
    // The live store is checked first but is not required: it is only ever a fast path, and in a
    // process that has never reopened that conversation it holds nothing. Persistence is what makes
    // the cold case work, and it is the same bytes `sessionQuery` would have read.
    const live = sessions?.get?.(sessionId)
    if (live !== undefined) {
      const state = projections.stateOf(live, 'board')
      if (state === undefined) throw noBoard(sessionId)
      model = state.model
    } else {
      const persistence = read(deps?.persistence)
      if (persistence === undefined) {
        throw new BoardOpError(
          `session ${JSON.stringify(sessionId)} is not open in this process, and this profile has ` +
            'neither a session query service nor session persistence, so a stored one cannot be read.',
        )
      }
      // `session` is carried through only so a test can inject the module; production leaves it
      // undefined and `readStoredBoard` loads its peer dependency.
      model = await readStoredBoard(
        { persistence, projections, session: deps?.session },
        sessionId,
      )
    }
  } else {
    throw new BoardOpError(
      'importing needs the session store and the projection registry, or a session query service',
    )
  }

  if (model === null || typeof model !== 'object') {
    throw new BoardOpError(`session ${JSON.stringify(sessionId)} returned no board model`)
  }
  return { model, title: model.title ?? '' }
}

/**
 * Read a stored session's board without the optional `sessionQuery` service.
 *
 * `sessionQuery` is the tidy way to do this, and it is what `dsh-session-query` exists for. But it
 * is an **optional** service: in the headless profile it does not register at all, and a service
 * that fails to load is logged and skipped rather than fatal (board issue I11). So an import that
 * depended on it would work in the desktop app and refuse every conversation in a fresh profile —
 * with the misleading explanation that the session "is not open in this process".
 *
 * The pieces it is built from are always present: `sessionPersistence.open` reads a stored log,
 * `dsh-session`'s `Session` folds one, and the projection registry hydrates over it. This is the
 * same shape `dsh-session-query` uses (`lib/index.js:34-54` for the read, `:367-379` for the
 * prepared session, `:509-513` for the hydration) — reproduced rather than reached for, because
 * the service may not be there.
 *
 * The log is read **read-only** and the folded session is never entered into the store: this must
 * not make that conversation live, must not touch its write handle, and must not change its
 * revision. Everything here is a borrowed view.
 *
 * @param deps - `{ persistence, projections }`.
 * @param sessionId - the stored session.
 * @returns the source board's wire model.
 */
async function readStoredBoard(deps, sessionId) {
  const { persistence, projections } = deps
  const sessionModule = deps.session ?? (await loadSessionModule())
  const { Session, SessionLogOffset, interruptedTurnClosers } = sessionModule
  let handle
  let read
  try {
    handle = await persistence.open(sessionId, 'read')
    read = await handle.read(0, undefined)
  } catch (error) {
    throw new BoardOpError(describeStorageFailure(sessionId, error))
  } finally {
    // Close even on the failure path: a leaked read handle holds a file open on Windows.
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // A close failure cannot change the outcome we already decided on.
      }
    }
  }

  const events = [...read.events, ...interruptedTurnClosers(read.events)]
  let session
  try {
    // The second argument is the **seed**, not a base sequence: the constructor validates it is
    // contiguous from 0 and folds it itself (`dsh-session/lib/index.js:1399-1413`). Handing it a
    // zero offset here would build an empty session and the board would come back as "never
    // mounted" — the exact sort of wrong-but-quiet this import is meant to avoid.
    session = new Session(sessionId, events, handle.header, 'snapshot', handle.inheritedEventCount)
  } catch (error) {
    throw new BoardOpError(
      `session ${JSON.stringify(sessionId)} could not be folded: ${
        typeof error?.message === 'string' ? error.message : String(error)
      }`,
    )
  }

  // `hydrate(session, checkpoint, events, baseSeq)` installs the folded state on the session's
  // cells and returns the wire snapshot. An empty checkpoint means "fold from the beginning",
  // which is exactly what a session nothing has cached needs.
  const snapshot = projections.hydrate(session, {}, events, SessionLogOffset(0))
  const board = snapshot?.values?.board
  if (board === undefined) throw noBoard(sessionId)
  return board.model
}

/** The refusal every path uses when a session exists but never mounted this plugin. */
function noBoard(sessionId) {
  return new BoardOpError(
    `session ${JSON.stringify(sessionId)} has no board projection, so this plugin was not mounted ` +
      'while that conversation ran. There is no board to import from it.',
  )
}

let sessionModulePromise
/** `dsh-session` is a peer dependency, so it resolves from the host that mounted this plugin. */
function loadSessionModule() {
  sessionModulePromise ??= import('@deepseek-ai/dsh-session')
  return sessionModulePromise
}

/** Map a persistence failure onto an import refusal, distinguishing missing from corrupt. */
function describeStorageFailure(sessionId, error) {
  const name = error?.name ?? ''
  const message = typeof error?.message === 'string' ? error.message : String(error)
  if (name === 'SessionPersistenceNotFoundError' || /not found/i.test(message)) {
    return (
      `no session has the id ${JSON.stringify(sessionId)}. Copy it from that conversation's URL — ` +
      'every session id on this machine is either a bare uuid or a uuid prefixed with `session-`, ' +
      'and both forms are read as given.'
    )
  }
  if (name === 'SessionPersistenceCorruptionError' || /corrupt/i.test(message)) {
    return `session ${JSON.stringify(sessionId)} could not be read: its stored log is corrupt (${message})`
  }
  return `session ${JSON.stringify(sessionId)} could not be loaded from storage (${message})`
}

/**
 * Turn a `sessionQuery` failure into an import refusal that names which failure it was.
 *
 * The three cases are told apart because they lead to different advice: a bad id is a typo, an
 * unknown session is an id from elsewhere, and a corrupt log is neither.
 */
function describeQueryFailure(sessionId, error) {
  const code = error?.code ?? ''
  const message = typeof error?.message === 'string' ? error.message : String(error)
  if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
    return (
      `no session has the id ${JSON.stringify(sessionId)}. Copy it from that conversation's URL — ` +
      'every session id present on this machine is either a bare uuid or a uuid prefixed with `session-`, ' +
      'and both forms are read as given.'
    )
  }
  if (code === 'SESSION_QUERY_CORRUPT_SESSION') {
    return `session ${JSON.stringify(sessionId)} could not be read: its stored log is corrupt (${message})`
  }
  if (code === 'SESSION_QUERY_SOURCE_CONFLICT' || code === 'SESSION_QUERY_PERSISTENCE_FAILED') {
    return `session ${JSON.stringify(sessionId)} could not be loaded from storage (${message})`
  }
  return `reading session ${JSON.stringify(sessionId)} failed: ${message}`
}

/** Block kinds an import can carry, for the tool's own description and for a guard. */
export const IMPORTABLE_KINDS = Object.freeze([...BLOCK_KINDS])
