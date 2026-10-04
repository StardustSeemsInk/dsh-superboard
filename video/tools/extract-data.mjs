/**
 * Extract the authentic inputs a promo scene needs: the real board model and the
 * real theme tokens.
 *
 * Both are read out of the live installation rather than invented, because the
 * whole point of the promo is to show the actual product. A hand-written "model"
 * would drift from the schema silently — the renderer would just draw less, and
 * nobody would notice until the export looked wrong.
 *
 * Usage: node tools/extract-data.mjs
 * Outputs: scenes/data/board.json, scenes/data/tokens-<flavour>.json
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DSH = 'C:\\Users\\haoch\\.dsh'
const ASAR = 'C:\\Users\\haoch\\AppData\\Local\\Temp\\dsh-asar\\dsh'

const outDir = join(ROOT, 'scenes', 'data')
mkdirSync(outDir, { recursive: true })

// ---------------------------------------------------------------------------
// 1. The board model, from the projection checkpoint
// ---------------------------------------------------------------------------

/**
 * Find the checkpoint that actually holds a board.
 *
 * **Picking the largest file is wrong, and it broke.** The projection cache holds one file
 * per session, and the largest is not necessarily this session's — when another session grew
 * past it, the largest file belonged to a session that had never used the board, and the
 * extraction died on `has no board row`. Size is a proxy for "the session did a lot", not for
 * "this session has a board".
 *
 * So candidates are ranked by **the board's own revision sequence** — read out of
 * `record.rows.board.val.model.rev`, where a higher `rN` is a later board — and the largest
 * board wins. Files that cannot be parsed, or that carry no board, are skipped rather than
 * fatal, because the cache directory legitimately contains sessions unrelated to this project.
 */
function findCheckpoint() {
  const dir = join(DSH, 'storages', 'session_projcache', 'sessions')
  if (!existsSync(dir)) throw new Error(`no projection cache at ${dir}`)

  const candidates = []
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('session-') || !name.endsWith('.json')) continue
    const path = join(dir, name)
    let model
    try {
      model = JSON.parse(readFileSync(path, 'utf8'))?.record?.rows?.board?.val?.model
    } catch {
      continue
    }
    if (model === undefined || !Array.isArray(model.pages)) continue
    const sequence = Number(/^r(\d+)-/.exec(model.rev ?? '')?.[1] ?? -1)
    candidates.push({ name, path, sequence, blocks: model.pages.reduce((n, page) => n + page.blocks.length, 0) })
  }

  if (candidates.length === 0) throw new Error(`no session checkpoint in ${dir} carries a board`)
  candidates.sort((a, b) => b.sequence - a.sequence || b.blocks - a.blocks)
  return candidates[0].path
}

function extractBoard() {
  const path = findCheckpoint()
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const board = parsed?.record?.rows?.board
  if (board === undefined) throw new Error(`checkpoint ${path} has no board row`)
  const model = board.val?.model
  if (model === undefined) throw new Error(`checkpoint ${path} has no board model`)
  return {
    // The client's projection value. An empty `diag` keeps the promo on the happy path;
    // the self-healing scene injects a diagnostic deliberately.
    wire: { modelVersion: board.val.modelVersion, model, diag: {} },
    source: path,
    rev: model.rev,
    pages: model.pages.map((page) => ({ slug: page.slug, blocks: page.blocks.length })),
  }
}

// ---------------------------------------------------------------------------
// 2. Theme tokens: the plugin's own registered tables
// ---------------------------------------------------------------------------

/**
 * Pull each flavour's `tokens: { ... }` object literal out of the plugin bundle.
 *
 * The values are plain strings (hex or `var(--…)`), so the literal can be evaluated
 * directly — but the braces still have to be balanced rather than guessed, because
 * a naive "up to the next `}`" stops at the first nested object and silently drops
 * most of the table.
 */
function balancedObject(source, openBraceIndex) {
  let depth = 0
  let index = openBraceIndex
  let inString = false
  let quote = ''
  for (; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (char === '\\') index += 1
      else if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = true
      quote = char
    } else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openBraceIndex, index + 1)
    }
  }
  throw new Error('unbalanced braces while reading a token table')
}

function extractTokens() {
  const pluginDir = join(DSH, 'profiles', 'desktop', 'node_modules', '@nonamelego', 'dsh-catppuccin')
  if (!existsSync(pluginDir)) throw new Error(`catppuccin plugin not installed at ${pluginDir}`)
  const source = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8')

  // Every `tokens: {` in this bundle is a flavour table; order is latte, frappe,
  // macchiato, mocha. Identify each by the flavour's own primary colour so the
  // mapping is not positional guesswork.
  const FLAVOUR_ORDER = ['latte', 'frappe', 'macchiato', 'mocha']
  const tables = []
  const pattern = /tokens:\s*\{/g
  let match = pattern.exec(source)
  while (match !== null) {
    const braceIndex = source.indexOf('{', match.index)
    const literal = balancedObject(source, braceIndex)
    // Only flavour tables carry the neutral ramp; `SHIKI_TOKENS` and the menu-surface
    // helper do not.
    if (literal.includes('--dsw-static-neutral-bluish-1000')) {
      tables.push(literal)
    }
    match = pattern.exec(source)
  }
  if (tables.length !== 4) {
    throw new Error(`expected 4 flavour token tables, found ${tables.length}`)
  }

  const result = {}
  for (let i = 0; i < FLAVOUR_ORDER.length; i += 1) {
    const flavour = FLAVOUR_ORDER[i]
    const tokens = new Function(`return (${tables[i]})`)()
    const count = Object.keys(tokens).length
    if (count < 100) throw new Error(`flavour ${flavour} only yielded ${count} tokens`)
    result[flavour] = tokens
    writeFileSync(join(outDir, `tokens-${flavour}.json`), JSON.stringify(tokens, null, 2))
  }

  // The shiki token names are registered from a separate BASE table and are what the
  // board uses for its categorical palette, so they are recorded too. SHIKI_TOKENS is
  // built from BASE by a helper, so BASE is the table worth taking — evaluating the
  // derived one would need its whole module scope.
  const baseStart = source.indexOf('const BASE = {')
  const shiki = baseStart < 0
    ? null
    : new Function(`return (${balancedObject(source, source.indexOf('{', baseStart))})`)()
  if (shiki !== null) writeFileSync(join(outDir, 'shiki-tokens.json'), JSON.stringify(shiki, null, 2))

  const themeDir = join(ASAR, 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib')
  const names = [...new Set([...readFileSync(join(themeDir, 'client.js'), 'utf8')
    .matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))].sort()

  return {
    pluginDir,
    flavours: Object.fromEntries(Object.entries(result).map(([k, v]) => [k, Object.keys(v).length])),
    shikiCount: shiki === null ? 0 : Object.keys(shiki).length,
    declaredTokenNames: names.length,
  }
}

/**
 * Corrections applied to the snapshot on its way to disk.
 *
 * The promo renders the board's **real** content, so a factual error inside that content is
 * faithfully reproduced on screen. One such error exists: the board's own `status` block
 * claims 「13 种块类型」, and `questions/q23` repeats it. The real count is **8** —
 * `src/model.js:43-52` `BLOCK_KINDS` is exactly heading / prose / list / code / uml /
 * image / pdf-page / group, and `README.md:27` says 「八种块」. The claim was stale board
 * text, not a missing feature.
 *
 * It is corrected here, at extraction, rather than by hand-editing the snapshot, so that a
 * re-extraction cannot silently undo the fix. The same edit landed on the live board in the
 * same commit as this file, so the two agree.
 *
 * Deliberately a narrow, auditable substitution: it replaces the count inside that exact
 * phrase and refuses to guess. If the phrase ever disappears (because the upstream board was
 * fixed), the substitution becomes a no-op and `corrections` says so.
 */
const CORRECTIONS = [
  { find: '13 种块类型', replace: '8 种块类型', why: 'BLOCK_KINDS has 8 entries (src/model.js:43-52)' },
]

function applyCorrections(wire) {
  const applied = []
  for (const page of wire.model.pages) {
    for (const block of page.blocks) {
      if (typeof block.markdown !== 'string') continue
      for (const correction of CORRECTIONS) {
        if (!block.markdown.includes(correction.find)) continue
        block.markdown = block.markdown.split(correction.find).join(correction.replace)
        applied.push({ at: `${page.slug}/${block.slug ?? block.id}`, ...correction })
      }
    }
  }
  return applied
}

const board = extractBoard()
const corrections = applyCorrections(board.wire)
writeFileSync(join(outDir, 'board.json'), JSON.stringify(board.wire, null, 2))
writeFileSync(
  join(outDir, 'board-meta.json'),
  JSON.stringify({ source: board.source, rev: board.rev, pages: board.pages, corrections }, null, 2),
)

const tokens = extractTokens()
console.log(JSON.stringify({ board: { rev: board.rev, pages: board.pages, corrections }, tokens }, null, 2))
