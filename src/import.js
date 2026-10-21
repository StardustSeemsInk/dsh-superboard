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

  return ops
}

/**
 * Read another session's board and produce the ops that recreate it.
 *
 * @param deps - `{ sessions, projections }`, both resolved from `ctx.inject`.
 * @param sessionId - the source session.
 * @returns `{ ops, title, pages, blocks, edges }` — the ops, plus what the caller reports back.
 * @throws {BoardOpError} when the session is unknown or has no board projection.
 */
export function readSourceBoard(deps, sessionId) {
  const sessions = deps?.sessions
  const projections = deps?.projections
  if (sessions === undefined || projections === undefined) {
    throw new BoardOpError('importing needs both the session store and the projection registry')
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new BoardOpError('which session should the board be imported from? Pass its id.')
  }
  const session = sessions.get(sessionId)
  if (session === undefined) {
    throw new BoardOpError(
      `session ${JSON.stringify(sessionId)} is not open in this process. Only open sessions can be read; ` +
        'an id from a log that nothing has restored has no fold to read.',
    )
  }
  const state = projections.stateOf(session, 'board')
  if (state === undefined) {
    throw new BoardOpError(
      `session ${JSON.stringify(sessionId)} has no board projection, which means the plugin was not ` +
        'mounted when it ran.',
    )
  }
  return { model: state.model, title: state.model?.title ?? '' }
}

/** Block kinds an import can carry, for the tool's own description and for a guard. */
export const IMPORTABLE_KINDS = Object.freeze([...BLOCK_KINDS])
