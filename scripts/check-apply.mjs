#!/usr/bin/env node
/**
 * Prove the installed host half actually registers what it claims.
 *
 * **Why this is a script and not a shell snippet in a doc.** The snippet that used to live in
 * `CONTRIBUTING.md` was wrong twice, for the same reason both times: `apply` grew a call to a
 * service the snippet's fake context did not have, so it threw — and it threw *after* the plugin
 * was installed, in the one place a reader goes when they are already unsure whether the install
 * worked. A doc that has to be kept in step with the code will not be. This file is imported by
 * `test/apply.test.js`, so the suite fails the moment `apply` needs something the stub lacks.
 *
 * Two things it checks, and they are different questions:
 *
 *   1. **Does `apply` run at all**, without throwing, against a context that provides only what the
 *      plugin declares? That is what a broken install looks like.
 *   2. **Does it register the expected projections and tools?** Exports alone prove nothing: the
 *      M0 scaffold exported the same `PLUGIN_NAME` and `apply` as v1, and that check once gave
 *      false comfort.
 *
 * Usage: `node scripts/check-apply.mjs [--json]`
 */

const EXPECTED_PROJECTIONS = ['board', 'boardActivity']
const EXPECTED_TOOLS = ['board_outline', 'board_read', 'board_apply', 'board_query', 'board_import']

/**
 * A stand-in for the plugin context.
 *
 * `apply` receives a context, and `ctx.inject(names, callback)` hands that callback a **scope**,
 * which is itself a context — it carries the injected services *and* `effect`/`logger`. Passing
 * only the services is what made the old doc snippet throw:
 *
 *   TypeError: ctx.effect is not a function          (src/runtime.js:226, via the webServer scope)
 *   TypeError: ctx.skills.registerProvider is not a function   (src/skill.js:170)
 *
 * Every service the plugin injects must appear here with the members `apply` actually calls. The
 * test drives this exact object, so a new injection point fails loudly instead of silently
 * weakening the check.
 */
export function fakeContext() {
  const projections = []
  const tools = []
  const skills = []
  const routes = new Map()

  const scope = () => ({
    sessionProjections: {
      register(definition) {
        projections.push(definition.key)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        tools.push(definition.name)
        return () => {}
      },
    },
    systemPrompt: { context: () => {} },
    skills: {
      registerProvider(factory) {
        skills.push(factory)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    // Not services — the context members `registerRuntimeRoutes` and the skill provider call.
    effect(factory) {
      factory()
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  })

  return {
    ctx: {
      inject: (names, callback) => callback(scope()),
      // `apply` also reads these directly rather than through `inject`.
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    },
    projections,
    tools,
    skills,
    routes,
  }
}

/**
 * Run `apply` against `fakeContext()` and report what it registered.
 *
 * @param plugin - the module namespace, so a caller can pass a freshly imported copy.
 * @returns `{ projections, tools, skills, routes }`.
 */
export function checkApply(plugin) {
  const harness = fakeContext()
  if (typeof plugin.apply !== 'function') {
    throw new Error('the host half does not export apply() — this is not the plugin')
  }
  plugin.apply(harness.ctx)
  return {
    projections: harness.projections,
    tools: harness.tools,
    skills: harness.skills,
    routes: [...harness.routes.keys()],
  }
}

/** Compare a `checkApply` result against what the plugin promises. */
export function missingFrom(result) {
  const problems = []
  for (const key of EXPECTED_PROJECTIONS) {
    if (!result.projections.includes(key)) problems.push(`projection ${key}`)
  }
  for (const name of EXPECTED_TOOLS) {
    if (!result.tools.includes(name)) problems.push(`tool ${name}`)
  }
  return problems
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const json = process.argv.includes('--json')
  const plugin = await import('../src/index.js')
  let result
  try {
    result = checkApply(plugin)
  } catch (error) {
    // The distinction matters: a throw means the install is broken, a missing name means it is
    // stale. They send the reader to different places.
    if (json) {
      console.log(JSON.stringify({ ok: false, threw: String(error?.message ?? error) }))
    } else {
      console.error(`apply() threw — the plugin cannot load:\n  ${error?.message ?? error}`)
    }
    process.exit(1)
  }
  const problems = missingFrom(result)
  if (json) {
    console.log(JSON.stringify({ ok: problems.length === 0, ...result, missing: problems }))
  } else {
    console.log(`投影: ${result.projections.join(', ')}`)
    console.log(`工具: ${result.tools.join(', ')}`)
    console.log(`技能: ${result.skills.length} 个 provider`)
    console.log(`路由: ${result.routes.join(', ')}`)
    if (problems.length > 0) {
      console.error(`\n缺少: ${problems.join(', ')}`)
    }
  }
  process.exit(problems.length === 0 ? 0 : 1)
}
