// Re-derive the desktop profile's preset restatements from the shipped presets.
//
// Why this exists
// ---------------
// billion-context is the only compressor in this profile, and the official one
// is mounted INSIDE each shipped agent preset, as a `compaction` group in that
// preset's `config.plugins`. That list is config data, not loader nodes, so the
// Loader's patch has no address for it: `patch insert` refuses ("entry
// \"preset-standard\" is not a group") and overriding the preset by id replaces
// its whole config. Restating the preset — a copy of it with the group removed —
// is therefore the only lever.
//
// The cost of restating is that the copy no longer follows upstream. So after
// every DSH upgrade, re-run this script: it re-copies the four shipped presets
// with the `compaction` group removed and nothing else changed, then tells you
// whether the live patch had drifted.
//
// Usage
// -----
//   node scripts/restate-presets.mjs            # report drift, change nothing
//   node scripts/restate-presets.mjs --write    # rewrite the patch (backs it up)
//   node scripts/restate-presets.mjs --patch <file> --presets <dir>
//
// Exit code is 1 when --check finds drift, so it can gate a post-upgrade step.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PRESET_IDS = ['minimal', 'ptc', 'standard', 'cordis']

const DEFAULT_PATCH = 'C:/Users/haoch/.dsh/profiles/desktop/cordis.patch.yml'
const DEFAULT_PRESETS = 'C:/Users/haoch/.dsh/profiles/node_modules/@deepseek-ai/dsh-web-app/presets'

/**
 * Turn one shipped preset file into a profile patch row: drop the `- insert:`
 * wrapper, dedent by the row's own indent, and remove the `compaction` group.
 * Text surgery, not a YAML round-trip, so `!!js` tags and comments survive
 * byte-for-byte — a round-trip would silently rewrite expressions that carry
 * meaning the parser cannot represent.
 *
 * @param {string} text - the whole shipped `<id>.patch.yml`.
 * @param {string} id - preset id, used in error messages only.
 * @returns {{row: string, removedLines: number, foundGroup: boolean}}
 */
export function restatePreset (text, id) {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => l.trim() === '- insert:')
  if (at === -1) throw new Error(`${id}: no "- insert:" line`)
  if (!/^\s+- id:\s*preset-/.test(lines[at + 1])) {
    throw new Error(`${id}: expected the preset row right after "- insert:", got "${lines[at + 1]}"`)
  }

  const rowIndent = lines[at + 1].match(/^\s*/)[0].length
  const pad = ' '.repeat(rowIndent)
  const body = lines.slice(at + 1).map((l) => (l.startsWith(pad) ? l.slice(rowIndent) : l))

  const start = body.findIndex((l) => /^\s*- id: compaction\s*$/.test(l))
  if (start === -1) return { row: body.join('\n').replace(/\n+$/, ''), removedLines: 0, foundGroup: false }

  // A group runs until the next sibling at the same indentation.
  const indent = body[start].match(/^\s*/)[0]
  let end = start + 1
  while (end < body.length && !new RegExp(`^${indent}- `).test(body[end])) end++
  const removedLines = end - start
  body.splice(start, removedLines)
  return { row: body.join('\n').replace(/\n+$/, ''), removedLines, foundGroup: true }
}

/**
 * Read every preset row out of a patch file. Located structurally — the banner
 * line that opens the block immediately above the first `- id: preset-<id>` row
 * — because the header wording has been rewritten before, and a text marker
 * silently rots when it does.
 *
 * The **tail** is everything after the last preset row, returned separately so a
 * rewrite can put it back. It exists because the first version of this generator
 * did not: it emitted `head + banner + the four presets` and silently dropped
 * every top-level row that lived *below* the preset block. In this profile that
 * was `agent-preset-registry` (which decides the default and selected preset)
 * and `mcp-dsh-computer-use-win`. `--check` could not see it, because it only
 * ever compares the preset rows against the shipped ones.
 *
 * @param {string} patch - the live profile patch.
 * @returns {{head: string, rows: Map<string, string>, tail: string}}
 */
export function splitPatch (patch) {
  const all = patch.split(/\r?\n/)
  const firstRow = all.findIndex((l) => /^- id: preset-/.test(l))
  if (firstRow === -1) return { head: patch.replace(/\n+$/, ''), rows: new Map(), tail: '' }

  let bannerStart = -1
  for (let i = firstRow - 1; i >= 0; i--) {
    if (/^# -{10,}\s*$/.test(all[i])) { bannerStart = i; break }
  }
  if (bannerStart === -1) throw new Error('could not find the banner that opens the preset block')

  const rows = new Map()
  const lines = all.slice(bannerStart)
  let current
  let tailStart = -1
  for (const [offset, line] of lines.entries()) {
    // A top-level row that is not a preset ends the preset block. Everything from here on belongs
    // to someone else and must survive the rewrite untouched.
    if (/^- id: /.test(line) && !/^- id: preset-/.test(line)) { tailStart = bannerStart + offset; break }
    const m = line.match(/^- id: (preset-(\S+))\s*$/)
    if (m) { current = m[2]; rows.set(current, line); continue }
    if (current) rows.set(current, `${rows.get(current)}\n${line}`)
  }
  for (const [id, row] of rows) rows.set(id, row.replace(/\n+$/, ''))

  const blockEnd = tailStart === -1 ? all.length : tailStart
  return {
    head: all.slice(0, bannerStart).join('\n').replace(/\n+$/, ''),
    rows,
    tail: all.slice(blockEnd).join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
  }
}

const HEADER = `
# ---------------------------------------------------------------------------
# The four shipped agent presets, restated WITHOUT their \`compaction\` group.
#
# Why this file carries a copy of someone else's preset list: a preset row is
# not a group, so \`patch insert\` cannot reach inside it ("entry
# \\"preset-standard\\" is not a group"), and overriding a preset by id replaces
# its whole \`config\`. Restating is therefore the only lever — the same one
# \`dsh-superboard/cordis.patch.yml\` uses, and it accepts the same cost: a
# restated preset cannot follow an upstream change to itself.
#
# Why the group has to go: billion-context owns compression in this profile, and
# two compressors on one conversation double-compress and corrupt message refs
# (billion-context #1206) — which it reported for this profile as "unannounced
# history rewrites". The host-plane rows are already disabled by the web-app
# bundle, because compaction moved to this, the per-session plane; a manual
# \`/compact\` and idle-session compaction still fire there even with
# \`compaction-basic.auto: false\`, which the bundle patch already sets.
#
# GENERATED — do not hand-edit the rows below. Re-run
# \`node scripts/restate-presets.mjs --write\` in the dsh-superboard checkout
# after every DSH upgrade; \`node scripts/restate-presets.mjs\` only reports
# whether these copies have drifted from the shipped presets. Delete the whole
# block to hand the presets back to the bundle, compaction group and all.
`

/**
 * Every top-level `- id:` in a patch, in file order.
 *
 * Used as the before/after guard around a rewrite: the point is not to compare values (a preset is
 * *meant* to change) but to prove that no row disappeared.
 *
 * @param {string} patch - patch text.
 * @returns {string[]} ids.
 */
export function topLevelIds (patch) {
  return patch.split(/\r?\n/).flatMap((line) => {
    const m = line.match(/^- id: (\S+)\s*$/)
    return m === null ? [] : [m[1]]
  })
}

function main (argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(name)
    return i === -1 ? fallback : argv[i + 1]
  }
  const patchPath = arg('--patch', DEFAULT_PATCH)
  const presetsDir = arg('--presets', DEFAULT_PRESETS)
  const write = argv.includes('--write')

  if (!existsSync(patchPath)) throw new Error(`patch not found: ${patchPath}`)
  if (!existsSync(presetsDir)) throw new Error(`shipped presets not found: ${presetsDir}`)

  const wanted = []
  for (const id of PRESET_IDS) {
    const file = `${presetsDir}/${id}.patch.yml`
    if (!existsSync(file)) { console.log(`  preset-${id.padEnd(9)} no shipped file — skipped`); continue }
    const { row, removedLines, foundGroup } = restatePreset(readFileSync(file, 'utf8'), id)
    wanted.push({ id, row })
    console.log(`  preset-${id.padEnd(9)} ${foundGroup ? `compaction group removed (${removedLines} lines)` : 'NO compaction group (already bare?)'}  -> ${row.split('\n').length} lines`)
  }
  if (wanted.length === 0) throw new Error('no preset files found — wrong --presets dir?')

  const live = readFileSync(patchPath, 'utf8')
  const { head, rows, tail } = splitPatch(live)

  let drift = 0
  for (const { id, row } of wanted) {
    const got = rows.get(id)
    if (got === undefined) { console.log(`  preset-${id}: MISSING from the patch`); drift++; continue }
    if (got !== row) {
      drift++
      const a = row.split('\n'); const b = got.split('\n')
      let shown = 0
      for (let i = 0; i < Math.max(a.length, b.length) && shown < 4; i++) {
        if (a[i] !== b[i]) { console.log(`      L${i + 1} shipped: ${a[i] ?? '(none)'}`); console.log(`      L${i + 1} live   : ${b[i] ?? '(none)'}`); shown++ }
      }
    }
  }
  const extra = [...rows.keys()].filter((id) => !wanted.some((w) => w.id === id))

  if (drift === 0 && extra.length === 0) { console.log('\nin sync — nothing to do'); return 0 }
  if (!write) {
    console.log(`\n${drift} drifted, ${extra.length} stale row(s) (${extra.join(', ') || 'none'}). Re-run with --write to re-derive them.`)
    return 1
  }

  copyFileSync(patchPath, `${patchPath}.bak-before-restate`)
  let out = `${head}\n${HEADER}\n`
  for (const { row } of wanted) out += `${row}\n\n`
  // Put back whatever lived below the preset block. Dropping it is not a cosmetic loss: in this
  // profile the tail holds `agent-preset-registry` (the default and selected preset) and the
  // MCP server row. The first version dropped both, and `--check` could not see it.
  if (tail !== '') out += `${tail}\n`

  // **Prove the rewrite before committing it.** `--check` compares preset rows against the shipped
  // ones and cannot notice a row that the rewrite dropped entirely; this can. A profile patch that
  // silently loses its registry row is a much worse outcome than a failed regeneration.
  const before = topLevelIds(live)
  const after = topLevelIds(out)
  const lost = before.filter((id) => !after.includes(id))
  if (lost.length > 0) {
    throw new Error(
      `refusing to write: the rewrite would drop ${lost.length} top-level row(s) — ${lost.join(', ')}. ` +
        `The patch is unchanged; the previous one is at ${patchPath}.bak-before-restate.`,
    )
  }

  writeFileSync(patchPath, out)
  console.log(`\nwrote ${patchPath} (${live.length} -> ${out.length} B); backup at ${patchPath}.bak-before-restate`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)))
}
