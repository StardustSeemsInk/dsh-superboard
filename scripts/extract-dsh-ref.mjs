#!/usr/bin/env node
/**
 * Extract read-only reference copies of official DSH packages out of app.asar
 * so the plugin can be built against the real contracts instead of guesses.
 *
 * These copies are gitignored (`.ref/`) and exist only for local reference —
 * nothing here is imported at runtime, and nothing here ships.
 *
 *   node scripts/extract-dsh-ref.mjs                        # a default package set
 *   node scripts/extract-dsh-ref.mjs dsh-tools dsh-storage  # specific packages
 *   node scripts/extract-dsh-ref.mjs --list dsh-client-     # list matching packages
 *
 * Override the app location with DSH_ASAR=/path/to/app.asar
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ASAR = 'C:\\Users\\haoch\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const ASAR = process.env.DSH_ASAR ?? DEFAULT_ASAR

/** Packages worth having on hand for canvas / panel / storage work. */
const DEFAULT_PACKAGES = [
  'dsh-client-ui-slots',
  'dsh-client-ui-layout',
  'dsh-client-ui-sidebar-right',
  'dsh-client-ui-primitives',
  'dsh-client-ui-theme',
  'dsh-client-ui-conversation',
  'dsh-client-ui-chat',
]

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const refRoot = join(repoRoot, '.ref', 'dsh-official')
const cacheDir = join(repoRoot, '.ref', '.cache')
const listingFile = join(cacheDir, 'asar-list.txt')

function die(message) {
  console.error(`extract-dsh-ref: ${message}`)
  process.exit(1)
}

function asarList() {
  if (existsSync(listingFile)) return readFileSync(listingFile, 'utf8').split(/\r?\n/)
  mkdirSync(cacheDir, { recursive: true })
  console.log('listing app.asar (one-off, this takes a moment)...')
  const result = spawnSync('npx', ['--yes', '@electron/asar', 'list', ASAR], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) die(`could not list ${ASAR}\n${result.stderr ?? ''}`)
  const lines = result.stdout.split(/\r?\n/)
  writeFileSync(listingFile, result.stdout)
  return lines
}

function listPackages(lines) {
  const names = new Set()
  for (const line of lines) {
    const match = /^\\dsh\\node_modules\\@deepseek-ai\\([^\\]+)\\/.exec(line)
    if (match) names.add(match[1])
  }
  return [...names].sort()
}

function extractOne(relativePath, target) {
  // @electron/asar writes the file into the current working directory.
  const leaf = relativePath.split('/').pop()
  const result = spawnSync(
    'npx',
    ['--yes', '@electron/asar', 'extract-file', ASAR, relativePath],
    { cwd: cacheDir, encoding: 'utf8', shell: process.platform === 'win32' },
  )
  if (result.status !== 0) return false
  const produced = join(cacheDir, leaf)
  if (!existsSync(produced)) return false
  mkdirSync(dirname(target), { recursive: true })
  rmSync(target, { force: true })
  renameSync(produced, target)
  return true
}

const args = process.argv.slice(2)

if (!existsSync(ASAR)) die(`app.asar not found at ${ASAR} — set DSH_ASAR`)
const lines = asarList()

if (args[0] === '--list') {
  const needle = args[1] ?? ''
  for (const name of listPackages(lines)) if (name.includes(needle)) console.log(name)
  process.exit(0)
}

const packages = args.length > 0 ? args : DEFAULT_PACKAGES
let total = 0

for (const pkg of packages) {
  const prefix = `\\dsh\\node_modules\\@deepseek-ai\\${pkg}\\`
  const files = lines.filter((line) => line.startsWith(prefix) && !line.endsWith('\\'))
  if (files.length === 0) {
    console.warn(`  ${pkg}: not found in this build — skipped`)
    continue
  }
  let written = 0
  for (const file of files) {
    const relative = file.slice(1).replaceAll('\\', '/')
    const target = join(refRoot, pkg, file.slice(prefix.length))
    if (extractOne(relative, target)) written += 1
  }
  total += written
  console.log(`  ${pkg}: ${written}/${files.length} files -> .ref/dsh-official/${pkg}/`)
}

rmSync(cacheDir, { recursive: true, force: true })
console.log(`extracted ${total} files into ${refRoot}`)
