/**
 * Host half of `dsh-superboard`.
 *
 * Three jobs:
 *
 *   1. **Own the board's authority.** The board is the fold of this session's own successful
 *      `board_apply` calls — a projection over committed events, so replay, resume, and fork
 *      come for free and no custom event type is needed. See `src/fold.js`.
 *   2. **Give the Agent hands.** Four tools, with `board_apply` as the only write path.
 *   3. **Tell the Agent where things are.** A small standing outline rides every request,
 *      because the Agent cannot see the canvas. Detail is pulled on demand with `board_read`.
 *
 * Rules this file obeys, from `docs/research/dsh-plugin-contract.md`:
 *   - a host half exports `apply(ctx, config)` and nothing else executable;
 *   - dynamic per-request prompt text goes through `ctx.systemPrompt.context()`, which is
 *     re-evaluated every step and appends a snapshot instead of rewriting the system prefix.
 *     `.section()` is for static text only;
 *   - optional services are gated with `ctx.inject([...], …)` so the plugin stays inactive
 *     rather than throwing in a profile that lacks them;
 *   - runtime code does not `import` from `@deepseek-ai/*`. Those must be the host's instances;
 *     a local copy would be a second one. Everything arrives through `ctx`.
 *
 * @module dsh-superboard
 */

import { BOARD_PROJECTION_KEY, BOARD_TOOL_NAME, foldBoard } from './fold.js'
import { emptyBoardDoc } from './model.js'
import { boardDocSchema, boardWireSchema, toWire } from './schema.js'
import { registerBoardTools, renderOutlineText } from './tools.js'

/** The plugin name, used for prompt-context attribution and diagnostics. */
export const PLUGIN_NAME = 'dsh-superboard'

/**
 * Prompt-context order for the standing board line.
 *
 * The three orders the framework defines are `SANDBOX_POLICY: 110`,
 * `APPROVAL_POLICY: 115`, `SUBAGENT_DELEGATION: 120`
 * (`dsh-system-prompt/lib/index.js:44-48`). The board sits just behind that group: it is
 * background state, and anything capable of restricting a call should be stated first.
 * `getContextOrder` only resolves framework-known names, so a plugin's own order is a literal
 * by necessity.
 */
const BOARD_CONTEXT_ORDER = 125

/**
 * How large the standing outline may get before it truncates itself.
 *
 * Smaller than `board_outline`'s default: this rides *every* request, so its cost is paid
 * continuously, and an Agent that needs more can always ask for it.
 */
const STANDING_OUTLINE_CHARS = 1600

/**
 * Install the host half.
 *
 * @param ctx - the plugin's own fiber context. Every registration here is disposed when the
 *   plugin unloads, which is why nothing is registered on any other context.
 */
export function apply(ctx) {
  ctx.inject(['sessionProjections'], (projectionScope) => {
    const projections = projectionScope.sessionProjections

    projections.register({
      key: BOARD_PROJECTION_KEY,
      stateSchema: boardDocSchema,
      // `init` is the only place the session header is visible, and the fold needs the session
      // id to derive element ids deterministically. It travels in the state (and is therefore
      // checkpointed) but stays out of the content hash.
      init: (header) => emptyBoardDoc(header?.id ?? ''),
      apply: (state, event) => foldBoard(state, event),
      wire: { viewSchema: boardWireSchema, view: (state) => toWire(state) },
      stateVersion: 1,
    })

    ctx.inject(['tools'], (scope) => {
      registerBoardTools(scope, projections)
    })

    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: `${PLUGIN_NAME}:board`,
        order: BOARD_CONTEXT_ORDER,
        text: (context) => renderStandingOutline(projections, context),
      })
    })
  })
}

/**
 * Render the standing board line for one step.
 *
 * Called synchronously while a step is assembled — `dsh-system-prompt` invokes
 * `entry.text(context)` without awaiting, and `context` is `{ agent, scope, signal }` at
 * runtime (see `dsh-sandbox-policy/lib/index.js:121-130` for the canonical shape).
 *
 * An empty board renders as an empty string, which the assembler filters. That is the normal
 * state for a conversation that has never used the board, and it is what keeps an unused board
 * costing nothing.
 *
 * @param projections - the session-projection registry.
 * @param context - the assembly context for this step.
 * @returns the prompt line, or `''` while the board has nothing to say.
 */
function renderStandingOutline(projections, context) {
  const session = context?.agent?.session
  if (session === undefined) return ''
  const state = safeStateOf(projections, session)
  if (state === undefined) return ''

  const model = state.model
  const hasContent = model.pages.some((page) => page.blocks.length > 0) || model.edges.length > 0
  if (!hasContent && state.lastOpError === undefined) return ''

  const { text } = renderOutlineText(state, { maxChars: STANDING_OUTLINE_CHARS })
  return [
    text,
    '',
    `Edit the board with ${BOARD_TOOL_NAME}; read it first with board_outline.`,
  ].join('\n')
}

/**
 * Read the board without letting a projection problem break a model request.
 *
 * `stateOf` returns the live state synchronously; an unregistered key is `undefined`. A throw
 * here would fail the step, so a broken board degrades to "no board context" instead.
 *
 * @param projections - the session-projection registry.
 * @param session - the owning session.
 * @returns the board document, or `undefined`.
 */
function safeStateOf(projections, session) {
  try {
    return projections.stateOf(session, BOARD_PROJECTION_KEY)
  } catch {
    return undefined
  }
}
