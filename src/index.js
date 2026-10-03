/**
 * Host half of `dsh-superboard`.
 *
 * At M0 this half does one thing: prove the bundle loads and that a standing prompt
 * context can be registered. The board itself is a fold over this session's own
 * `board_apply` tool calls (see `docs/design/board-model.md` §2), which lands at M1/M2.
 *
 * Rules this file obeys, from `docs/research/dsh-plugin-contract.md`:
 *   - A host half exports `apply(ctx, config)` and nothing else executable.
 *   - Dynamic per-request prompt text goes through `ctx.systemPrompt.context()`, which is
 *     re-evaluated every step and appends a snapshot instead of rewriting the system
 *     prefix. `.section()` is for static text only — putting dynamic text there would
 *     break prompt-prefix caching.
 *   - Optional services are gated with `ctx.inject([...], …)` so the plugin stays inactive
 *     rather than throwing in a profile that lacks them.
 *
 * @module dsh-superboard
 */

/** The plugin name, used for prompt-context attribution and diagnostics. */
export const PLUGIN_NAME = 'dsh-superboard'

/**
 * Prompt-context order for the standing board line.
 *
 * The three orders the framework defines are `SANDBOX_POLICY: 110`,
 * `APPROVAL_POLICY: 115`, `SUBAGENT_DELEGATION: 120`
 * (`dsh-system-prompt/lib/index.js:44-48`). We sit just behind that group: the board is
 * background state, and anything capable of restricting a call should be stated first.
 * `getContextOrder` only resolves framework-known names, so a plugin's own order is a
 * literal by necessity.
 */
const BOARD_CONTEXT_ORDER = 125

/**
 * Install the host half.
 *
 * @param ctx - the plugin's own fiber context. Every registration here is disposed when the
 *   plugin unloads, which is exactly why nothing is registered on any other context.
 */
export function apply(ctx) {
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: `${PLUGIN_NAME}:board`,
      order: BOARD_CONTEXT_ORDER,
      text: (context) => renderBoardContext(context),
    })
  })
}

/**
 * Render the standing board line for one step.
 *
 * Called synchronously while a step is assembled — `dsh-system-prompt` invokes
 * `entry.text(context)` without awaiting, and `context` is `{ agent, scope, signal }` at
 * runtime (see `dsh-sandbox-policy/lib/index.js:121-130` for the canonical shape). Returning
 * an empty string renders nothing, because the assembler filters empty text, so M0 stays
 * invisible in the transcript until there is a real board to describe.
 *
 * @param context - the assembly context for this step.
 * @returns the prompt line, or `''` while the board has nothing to say.
 */
function renderBoardContext(context) {
  const session = context?.agent?.session
  if (session === undefined) return ''
  return ''
}
