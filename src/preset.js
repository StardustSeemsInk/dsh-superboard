/**
 * Preset-scoped standing guidance for the `dsh-superboard` agent presets.
 *
 * A preset's plugins may contribute "scoped tools, persona, prompt sections, and policies"
 * (`@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:78`), and this module
 * is the prompt-section half of that. Mounted *inside* a preset, `ctx.systemPrompt.section()`
 * contributes to that preset's scope only, so "how this role works" never leaks into another preset
 * or into the plain deployment.
 *
 * Why a `section` rather than `context`: `context` is re-evaluated on every step and appended as a
 * user-role snapshot at the end of the history, while `section` is static and folds into the system
 * prefix. A role statement wants the second. The board's own standing outline rides `context`
 * precisely because it changes as the board changes; a role does not.
 *
 * The text is configuration, not code: every preset states its own guidance in `cordis.patch.yml`,
 * so adding one needs no JavaScript. This file only owns the validation and the registration.
 *
 * @module dsh-superboard/preset
 */

/**
 * The section name, used when a row does not override it.
 *
 * One preset mounts into one scope, and `NamedEntries` rejects a duplicate name within a scope, so a
 * single fixed name is safe — no two presets ever share one.
 */
const DEFAULT_SECTION = 'dsh-superboard:preset-guidance'

/**
 * Where the section sorts.
 *
 * `dsh-system-prompt` owns the placement table (`SECTION_ORDERS`,
 * `dsh-system-prompt/lib/index.js:10-43`) and it has no slot for a deployment's own role guidance,
 * so this is a literal by necessity — the same reason `src/index.js` uses a literal for the board's
 * standing context. `PLAN_POLICY` is 500 and `TEAM_POLICY` is 600, so 550 lands after a policy that
 * can restrict a call and before the delegation policy.
 */
export const PRESET_SECTION_ORDER = 550

/**
 * Validate one preset's guidance row.
 *
 * Written by hand rather than with `@deepseek-ai/schemastery`, because runtime code in this package
 * never imports from `@deepseek-ai/*`: those must be the host's instances, and a local copy would be
 * a second one. `dsh-plan-mode` validates its own `section` the same way
 * (`dsh-plan-mode/lib/index.js:57-63`).
 *
 * @param config - the row's raw `config`.
 * @returns a detached, validated config.
 * @throws {Error} when `section` is missing or empty, or an unknown key is present.
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  const section = raw.section
  if (typeof section !== 'string' || section.trim() === '') {
    throw new Error('dsh-superboard/preset needs a non-empty `section` string')
  }
  const unknown = Object.keys(raw).filter((key) => key !== 'section' && key !== 'name' && key !== 'order')
  if (unknown.length > 0) {
    throw new Error(
      `dsh-superboard/preset has unknown key(s) ${unknown.join(', ')} — config is { section, name?, order? }`,
    )
  }
  const name = raw.name ?? DEFAULT_SECTION
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('dsh-superboard/preset `name` must be a non-empty string when given')
  }
  const order = raw.order ?? PRESET_SECTION_ORDER
  if (!Number.isFinite(order)) throw new Error('dsh-superboard/preset `order` must be a finite number')
  return { section, name, order }
}

/** The service this row needs. Declared so the Loader resolves it before `apply` runs. */
export const inject = ['systemPrompt']

/**
 * Register the guidance section in the mounting preset's scope.
 *
 * @param ctx - the preset plugin's own fiber context; the registration is disposed with it.
 * @param config - the row's raw `config`.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: resolved.name,
    order: resolved.order,
    text: resolved.section,
  })
}

/** The row name used by the preset declarations, for diagnostics and tests. */
export const PRESET_PLUGIN_NAME = 'dsh-superboard/preset'
