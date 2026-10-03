/**
 * Host half of `dsh-superboard`.
 *
 * Two jobs at M1:
 *
 *   1. **Own the board's authority.** The board is the fold of this session's own successful
 *      `board_apply` calls — a projection over committed events, so replay/resume/fork come
 *      for free and no custom event type is needed. See `src/fold.js`.
 *   2. **Tell the Agent where things are.** A small standing outline rides every request,
 *      because the Agent cannot see the canvas. Detail is pulled on demand with `board_read`
 *      (which arrives at M2 alongside the write path).
 *
 * Rules this file obeys, from `docs/research/dsh-plugin-contract.md`:
 *   - a host half exports `apply(ctx, config)` and nothing else executable;
 *   - dynamic per-request prompt text goes through `ctx.systemPrompt.context()`, which is
 *     re-evaluated every step and appends a snapshot rather than rewriting the system
 *     prefix. `.section()` is for static text only;
 *   - optional services are gated with `ctx.inject([...], …)` so the plugin stays inactive
 *     rather than throwing in a profile that lacks them;
 *   - runtime code must not `import` from `@deepseek-ai/*`. Those are the host's instances;
 *     a local copy would be a second instance. Only `ctx` is used.
 *
 * @module dsh-superboard
 */

import { BOARD_PROJECTION_KEY, BOARD_TOOL_NAME, foldBoard } from './fold.js'
import { emptyBoardDoc } from './model.js'
import { boardDocSchema, boardWireSchema, toWire } from './schema.js'

/** The plugin name, used for prompt-context attribution and diagnostics. */
export const PLUGIN_NAME = 'dsh-superboard'

/**
 * Prompt-context order for the standing board line.
 *
 * The three orders the framework defines are `SANDBOX_POLICY: 110`,
 * `APPROVAL_POLICY: 115`, `SUBAGENT_DELEGATION: 120`
 * (`dsh-system-prompt/lib/index.js:44-48`). The board sits just behind that group: it is
 * background state, and anything capable of restricting a call should be stated first.
 * `getContextOrder` only resolves framework-known names, so a plugin's own order is a
 * literal by necessity.
 */
const BOARD_CONTEXT_ORDER = 125

/**
 * Install the host half.
 *
 * @param ctx - the plugin's own fiber context. Every registration here is disposed when the
 *   plugin unloads, which is why nothing is registered on any other context.
 */
export function apply(ctx) {
  ctx.inject(['sessionProjections'], (scope) => {
    scope.sessionProjections.register({
      key: BOARD_PROJECTION_KEY,
      stateSchema: boardDocSchema,
      // `init` is the only place the session header is visible, and the fold needs the
      // session id to derive element ids deterministically. It is carried in the state
      // (and therefore checkpointed) but excluded from the content hash.
      init: (header) => emptyBoardDoc(header?.id ?? ''),
      apply: (state, event) => foldBoard(state, event),
      wire: { viewSchema: boardWireSchema, view: (state) => toWire(state) },
      stateVersion: 1,
    })
  })

  ctx.inject(['systemPrompt', 'sessionProjections'], (scope) => {
    scope.systemPrompt.context({
      name: `${PLUGIN_NAME}:board`,
      order: BOARD_CONTEXT_ORDER,
      text: (context) => renderBoardContext(scope, context),
    })
  })
}

/**
 * Render the standing board line for one step.
 *
 * Called synchronously while a step is assembled — `dsh-system-prompt` invokes
 * `entry.text(context)` without awaiting, and `context` is `{ agent, scope, signal }` at
 * runtime (see `dsh-sandbox-policy/lib/index.js:121-130`). Returning an empty string
 * renders nothing, because the assembler filters empty text. That is the normal state for a
 * conversation that has not used the board yet, and it is what keeps an unused board free.
 *
 * @param scope - the plugin scope carrying the projection registry.
 * @param context - the assembly context for this step.
 * @returns the prompt line, or `''` while the board has nothing to say.
 */
function renderBoardContext(scope, context) {
  const session = context?.agent?.session
  if (session === undefined) return ''
  const state = safeStateOf(scope, session)
  if (state === undefined) return ''
  return renderOutline(state.model, state.diag)
}

/**
 * Read the board without letting a projection problem break a model request.
 *
 * `stateOf` returns the live state synchronously; an unregistered key is `undefined`. A
 * throw here would fail the step, so a broken board degrades to "no board context" instead.
 *
 * @param scope - the plugin scope.
 * @param session - the owning session.
 * @returns the board document, or `undefined`.
 */
function safeStateOf(scope, session) {
  try {
    return scope.sessionProjections.stateOf(session, BOARD_PROJECTION_KEY)
  } catch {
    return undefined
  }
}

/** How many block lines to show per page before the outline starts summarising. */
const OUTLINE_BLOCKS_PER_PAGE = 24

/**
 * Render the standing outline.
 *
 * Deliberately terse: the Agent's canonical view is *structure and relationships*, never
 * geometry. It is told what exists and what points at what, and is expected to call
 * `board_read` for anything it needs to quote or edit.
 *
 * @param model - the board model.
 * @param diag - the render-failure ledger; empty in v1, wired now so UML needs no new channel.
 * @returns the outline text, or `''` for an empty board.
 */
export function renderOutline(model, diag = {}) {
  const hasContent = model.pages.some((page) => page.blocks.length > 0) || model.edges.length > 0
  if (!hasContent) return ''

  const lines = [`Board ${model.rev} — ${model.pages.length} page(s), ${model.edges.length} edge(s).`]

  for (const page of model.pages) {
    const layout = page.layout === undefined ? '' : ` [${page.layout.template}]`
    lines.push(`▸ ${page.slug}${layout} (${page.blocks.length} block(s))`)
    for (const block of page.blocks.slice(0, OUTLINE_BLOCKS_PER_PAGE)) {
      lines.push(`  · ${block.slug} — ${describeBlock(block)}`)
    }
    if (page.blocks.length > OUTLINE_BLOCKS_PER_PAGE) {
      lines.push(`  … ${page.blocks.length - OUTLINE_BLOCKS_PER_PAGE} more block(s) in this page`)
    }
  }

  for (const edge of model.edges) {
    const rel = edge.rel ?? 'relates'
    const label = edge.label === undefined ? '' : ` "${edge.label}"`
    lines.push(`→ ${edge.from.blockId} ${rel} ${edge.to.blockId}${label}`)
  }

  const broken = Object.values(diag ?? {})
  if (broken.length > 0) {
    lines.push(`⚠ ${broken.length} block(s) failed to render:`)
    for (const diagnostic of broken.slice(0, 8)) {
      lines.push(`  · ${diagnostic.blockSlug}: ${diagnostic.message}`)
    }
  }

  lines.push(
    `Use ${BOARD_TOOL_NAME} to edit the board, reading it first with board_outline/board_read.`,
  )
  return lines.join('\n')
}

/**
 * One-line description of a block for the outline.
 *
 * @param block - the block to describe.
 * @returns a short, type-aware label.
 */
function describeBlock(block) {
  switch (block.kind) {
    case 'heading':
      return `h${block.level} ${truncate(block.text)}`
    case 'prose':
      return `prose: ${truncate(block.markdown)}`
    case 'list':
      return `list of ${block.items.length}${block.ordered ? ' (ordered)' : ''}: ${truncate(block.items[0]?.text ?? '')}`
    case 'code':
      return `code${block.lang === '' ? '' : ` (${block.lang})`}${block.filename === undefined ? '' : ` ${block.filename}`}`
    case 'uml':
      return `uml ${block.diagram} (${block.engine}), ${block.source.split('\n').length} line(s) of source`
    case 'image':
      return `image ${block.src}${block.alt === '' ? '' : ` — ${truncate(block.alt)}`}`
    case 'pdf-page':
      return `pdf ${block.src} page ${block.page}`
    case 'group':
      return `group${block.title === undefined ? '' : ` ${truncate(block.title)}`} of ${block.children.length}`
    default:
      return block.kind
  }
}

/**
 * Collapse a value to one short line.
 *
 * @param value - the text to shorten.
 * @param max - maximum characters.
 * @returns the first line, truncated with an ellipsis when cut.
 */
function truncate(value, max = 60) {
  const first = String(value ?? '').split('\n')[0].trim()
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`
}
