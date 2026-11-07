import assert from 'node:assert/strict'
import test from 'node:test'

import * as plugin from '../src/index.js'
import { checkApply, fakeContext, missingFrom } from '../scripts/check-apply.mjs'

// These tests exist because the documented self-check was wrong **twice**, in the same way: `apply`
// grew a call to a context member the stub did not have, and the snippet threw at the one moment a
// reader is least able to interpret it — right after installing, when they are already unsure
// whether it worked. A doc cannot be kept in step with code by discipline; this can.

test('apply runs against a context that provides only what the plugin declares', () => {
  // A throw here is what a broken install looks like: the plugin is present, `apply` is exported,
  // and loading it fails on a service it expected. The old doc snippet died on
  // `ctx.effect is not a function`, then on `ctx.skills.registerProvider`, and each time the
  // message pointed at the plugin rather than at the stub.
  assert.doesNotThrow(() => checkApply(plugin))
})

test('apply registers the projections and tools the README promises', () => {
  const result = checkApply(plugin)

  // Exports alone prove nothing. The M0 scaffold exported the same `PLUGIN_NAME` and `apply` as v1,
  // so a check that stopped at the export list once reported a working install over stale code.
  assert.deepEqual(result.projections.sort(), ['board', 'boardActivity'])
  assert.deepEqual(result.tools.sort(), [
    'board_apply',
    'board_import',
    'board_outline',
    'board_query',
    'board_read',
  ])
  assert.deepEqual(missingFrom(result), [])
})

test('the context stub itself is exercised, so a new injection point cannot go unnoticed', () => {
  // `inject` here ignores which services were asked for and always hands back the same scope. That
  // is deliberate: it means the stub cannot silently satisfy a new dependency by accident. If
  // `apply` starts needing a service this object does not define, the first test in this file
  // fails — which is the whole point of checking them together.
  const harness = fakeContext()
  plugin.apply(harness.ctx)

  assert.deepEqual(harness.skills.length, 1, 'the board-layout skill provider is registered')
  // The runtime routes carry the vendored mermaid and pdf assets. Their presence is what makes a
  // packaged install (which ships `vendor/`) equivalent to a checkout.
  assert.ok(harness.routes.has('/dsh-superboard/mermaid.min.js'))
  assert.ok(harness.routes.has('/dsh-superboard/render-report'))
})
