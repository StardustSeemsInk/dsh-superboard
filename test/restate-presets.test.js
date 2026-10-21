// The restatement generator is the only thing standing between this profile and
// two compressors on one conversation, and it works by text surgery so that
// `!!js` expressions survive. These tests pin the surgery, not the file paths:
// what they protect is "exactly one list item is removed and nothing else
// changes", which is the whole safety argument for the technique.
import test from 'node:test'
import assert from 'node:assert/strict'

import { restatePreset, splitPatch, topLevelIds, PRESET_IDS } from '../scripts/restate-presets.mjs'

const SHIPPED = `# Agent preset standard: the shipped one.
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a coding agent.
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
            config:
              customSkillDirs:
                - !!js process.getBuiltinModule('node:path').join('a', 'b')
`

test('restating a preset removes the compaction group and nothing else', () => {
  const { row, removedLines, foundGroup } = restatePreset(SHIPPED, 'standard')
  assert.equal(foundGroup, true)
  assert.equal(removedLines, 8)
  assert.ok(!row.includes('compaction'), 'the group and its children are gone')
  assert.ok(row.includes('preset-standard'), 'the row itself survives')
  // Everything after the group must be untouched, including the !!js expression.
  assert.ok(row.includes("prefix: You are a coding agent."))
  assert.ok(row.includes("!!js process.getBuiltinModule('node:path').join('a', 'b')"))
  assert.ok(row.includes("name: '@deepseek-ai/dsh-tool-skill'"))
})

test('restating dedents by the row\'s own indent, not a fixed one', () => {
  const { row } = restatePreset(SHIPPED, 'standard')
  assert.ok(row.startsWith("- id: preset-standard\n"), 'the row starts at column 0')
  assert.ok(row.includes('\n  name:'), 'children sit at indent 2')
  assert.ok(!row.includes('\n    name:'), 'nothing is left at the shipped indent')
})

test('a preset with no compaction group comes back unchanged and says so', () => {
  const bare = SHIPPED.replace(/ {10}- id: compaction[\s\S]*?(?= {10}- id: tool-skill)/, '')
  const { row, removedLines, foundGroup } = restatePreset(bare, 'standard')
  assert.equal(foundGroup, false)
  assert.equal(removedLines, 0)
  assert.ok(row.includes('tool-skill'))
})

test('a file with no insert wrapper is an error, not a silent no-op', () => {
  assert.throws(() => restatePreset('- id: preset-standard\n', 'standard'), /no "- insert:" line/)
  assert.throws(() => restatePreset('- insert:\n  - id: something-else\n', 'standard'), /expected the preset row/)
})

test('the patch is split into a head and per-preset rows, and they round-trip', () => {
  const a = restatePreset(SHIPPED, 'standard').row
  const b = restatePreset(SHIPPED.replace(/standard/g, 'ptc'), 'ptc').row
  const live = `- id: something-else\n  disabled: true\n\n${'# ' + '-'.repeat(75)}\n${a}\n\n${b}\n`
  const { head, rows } = splitPatch(live)
  assert.equal(head, '- id: something-else\n  disabled: true')
  assert.deepEqual([...rows.keys()], ['standard', 'ptc'])
  assert.equal(rows.get('standard'), a, 'row A round-trips byte for byte')
  assert.equal(rows.get('ptc'), b, 'row B round-trips byte for byte')
})

test('rows that live BELOW the preset block come back as the tail, not as part of a preset', () => {
  // This is the data-loss regression. The first generator emitted only `head + banner + presets`,
  // so every top-level row after the preset block vanished from the profile on `--write`. In the
  // real profile that was `agent-preset-registry` (which decides the default and selected preset)
  // and the MCP server row — and `--check` could not see it, because it only compares preset rows.
  const row = restatePreset(SHIPPED, 'standard').row
  const below = '- id: agent-preset-registry\n  name: "@deepseek-ai/dsh-agent-preset-registry"\n  config:\n    default: standard\n    selectedDefault: engineer\n\n- id: mcp-dsh-computer-use-win\n  name: dsh-computer-use-win\n'
  const live = `- id: above\n  disabled: true\n\n${'# ' + '-'.repeat(75)}\n${row}\n\n${below}`
  const { head, rows, tail } = splitPatch(live)
  assert.equal(head, '- id: above\n  disabled: true')
  assert.deepEqual([...rows.keys()], ['standard'])
  assert.equal(rows.get('standard'), row, 'the preset row stops at the next top-level row')
  assert.equal(tail, below.replace(/\n+$/, ''), 'everything below the block is the tail, verbatim')
  assert.match(tail, /agent-preset-registry/)
  assert.match(tail, /mcp-dsh-computer-use-win/)
})

test('a patch with no preset rows yields an empty map rather than throwing', () => {
  const { head, rows, tail } = splitPatch('- id: x\n  disabled: true\n')
  assert.equal(rows.size, 0)
  assert.equal(head, '- id: x\n  disabled: true')
  assert.equal(tail, '')
})

test('a rewrite keeps the tail, so a preset edit cannot delete unrelated rows', () => {
  const row = restatePreset(SHIPPED, 'standard').row
  const below = '- id: keep-me\n  disabled: false\n'
  const live = `${'# ' + '-'.repeat(75)}\n${row}\n\n${below}`
  const { head, rows, tail } = splitPatch(live)
  // What `--write` now builds, in the same order the generator uses.
  const rebuilt = `${head}\n${rows.get('standard')}\n\n${tail}\n`
  assert.match(rebuilt, /- id: keep-me\n {2}disabled: false/, 'the row below survives a rewrite')
})

test('the before/after guard sees a dropped row, which is what --check could not', () => {
  const row = restatePreset(SHIPPED, 'standard').row
  const live = `${'# ' + '-'.repeat(75)}\n${row}\n\n- id: agent-preset-registry\n  name: x\n`
  const before = topLevelIds(live)
  assert.deepEqual(before, ['preset-standard', 'agent-preset-registry'])

  // The exact bug the first generator had: emit head + banner + presets, forget the tail.
  const { head, rows } = splitPatch(live)
  const broken = `${head}\n# banner\n\n${rows.get('standard')}\n\n`
  const after = topLevelIds(broken)
  assert.deepEqual(
    before.filter((id) => !after.includes(id)),
    ['agent-preset-registry'],
    'the guard names the row the old rewrite would have silently deleted',
  )
})

test('a nested `- id:` is not mistaken for a top-level row', () => {
  assert.deepEqual(topLevelIds('- id: a\n  config:\n    - id: notTop\n'), ['a'])
})

test('every preset this profile owns is restated — minimal included', () => {
  // minimal mounted no compaction group in 0.2.0-rc.2, so it was deliberately
  // left alone; 0.2.1 gave it one. Naming it here keeps that from silently
  // regressing again.
  assert.deepEqual(PRESET_IDS, ['minimal', 'ptc', 'standard', 'cordis'])
})
