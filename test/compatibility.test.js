/**
 * The plugin has to survive a DSH upgrade, because that is how it broke once.
 *
 * `dsh-app-boot` refuses to load a profile bundle whose manifest does not accept the running
 * runtime (`evaluatePluginCompatibility` → `unmetRequirements`), and it refuses *silently*: the
 * bundle is caught, added to `skippedBundles`, and nothing is printed. After the 0.2.0-rc.2 →
 * 0.2.1-rc.2 upgrade the board tab and all four `board_*` tools vanished for exactly this reason:
 * the manifest pinned three `@deepseek-ai/dsh-*` peers to the exact version `0.2.0-rc.2`, and an
 * exact pin does not accept its own successor.
 *
 * The rules, verbatim from `dsh-app-boot/lib/index.js`:
 *   - an own `engines.dsh` range decides alone; `peerDependencies` are then ignored;
 *   - otherwise every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer must accept the runtime;
 *   - `workspace:^`, `workspace:~`, `workspace:*` mean "the current runtime";
 *   - prereleases participate in ranges.
 *
 * So this file checks the claim the gate checks — against the runtime actually installed on this
 * machine, read out of `app.asar` — instead of against a remembered version number.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'

import { installedRuntime, PROFILE } from './dsh-asar.js'

const WORKSPACE = 'workspace:'
const DSH_PEER = /^@deepseek-ai\/dsh(?:-.+)?$/

/** The running DSH runtime version, as the gate would see it. */
const runtime = installedRuntime()
const skip = runtime === undefined ? 'no app.asar on this machine — nothing to check against' : false

/** `semver` the way the runtime itself resolves it: from the live profile's own tree. */
function semverFromProfile() {
  try {
    return createRequire(join(PROFILE, 'package.json'))('semver')
  } catch {
    return undefined
  }
}

const semver = semverFromProfile()

/** Does `range` accept `version`, with prereleases participating as the gate documents? */
function accepts(range, version) {
  const effective = range.startsWith(WORKSPACE) ? version : range
  return semver.satisfies(version, effective, { includePrerelease: true })
}

/** Every dsh requirement the manifest states, as `{ field, range }` pairs. */
function requirements(manifest) {
  if (manifest.engines && Object.hasOwn(manifest.engines, 'dsh')) {
    return [{ field: 'engines.dsh', range: manifest.engines.dsh }]
  }
  return Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => DSH_PEER.test(name))
    .map(([name, range]) => ({ field: `peerDependencies.${name}`, range }))
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the manifest states a dsh requirement at all', () => {
  assert.notDeepEqual(
    requirements(manifest),
    [],
    'a bundle with no dsh requirement loads anywhere — including where it was never tested',
  )
})

test('every stated dsh requirement accepts the installed runtime', { skip }, () => {
  assert.ok(semver, 'could not resolve semver from the live profile; cannot evaluate ranges')
  const found = requirements(manifest)
  assert.ok(found.length > 0)
  for (const { field, range } of found) {
    assert.equal(typeof range, 'string', `${field} must be a string`)
    assert.ok(
      accepts(range, runtime.version),
      `${field} is "${range}", which does not accept the installed dsh ${runtime.version}. ` +
        'The bundle would be skipped at load time, silently — see this file\'s header.',
    )
  }
})

test('the stated ranges are ranges, not exact pins', () => {
  // The original defect: `"0.2.0-rc.2"` is a *range* in semver terms — one that accepts exactly
  // one version. It reads like a version check and behaves like a trapdoor, so the shape is
  // asserted directly rather than left to the satisfaction check above (which a co-released
  // minor bump would also catch, but only after the schema of a new runtime exists on disk).
  for (const field of ['engines.dsh']) {
    const range = manifest.engines?.[field]
    if (range !== undefined) {
      assert.ok(
        /[<>=^*~]|\s/.test(range),
        `engines.${field} is "${range}", which pins one exact version`,
      )
    }
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!DSH_PEER.test(name)) continue
    assert.ok(
      /[<>=^*~]|\s/.test(range),
      `peerDependencies.${name} is "${range}", which pins one exact version`,
    )
  }
})

test('an engines.dsh range decides alone, so the peers must not contradict it', { skip }, () => {
  // The gate stops at `engines.dsh`; peers are documentation from then on. This keeps the two
  // statements from drifting apart, which is the only way a dead peer declaration can hurt.
  if (!manifest.engines || !Object.hasOwn(manifest.engines, 'dsh')) return
  assert.ok(semver)
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!DSH_PEER.test(name)) continue
    assert.deepEqual(
      accepts(range, runtime.version),
      accepts(manifest.engines.dsh, runtime.version),
      `peerDependencies.${name} and engines.dsh disagree about dsh ${runtime.version}`,
    )
  }
})
