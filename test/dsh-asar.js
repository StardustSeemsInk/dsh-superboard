/**
 * Read-only access to the packaged DSH application, for tests that need a fact about the runtime
 * that is actually installed rather than one remembered from a research session.
 *
 * `app.asar` is a single 180 MB file, so this module parses the header once and keeps it; file
 * bodies are sliced out of a buffer that is read lazily, on the first request for one.
 *
 * The format: a Pickle-framed JSON header, then the concatenated bodies. The first sixteen bytes
 * are three nested little-endian lengths — `4`, the header block size, and the JSON string length,
 * each four less than the one before — and the JSON starts at byte 16. A file node's `offset` is
 * relative to the end of the whole header block, i.e. `8 + headerSize`; `offset`/`size` are JSON
 * strings in some writer versions and numbers in others, so both are read through `Number()`.
 *
 * Nothing here is imported by `src/` — this is test infrastructure only, and every caller has to
 * cope with the app being absent (a checkout on a machine that does not run DSH Desktop).
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the packaged app lives, unless overridden. */
export const ASAR =
  process.env.DSH_ASAR ??
  join(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'Programs',
    'DeepSeek Harness',
    'resources',
    'app.asar',
  )

/** The live profile, whose own `node_modules` resolves packages the way the host resolves them. */
export const PROFILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop')

/** `undefined` until loaded, then `null` when the app is absent or unreadable. */
let archive

function load() {
  if (archive !== undefined) return archive
  let bytes
  try {
    bytes = readFileSync(ASAR)
  } catch {
    archive = null
    return archive
  }
  const headerSize = bytes.readUInt32LE(4)
  archive = {
    bytes,
    headerSize,
    header: JSON.parse(bytes.toString('utf8', 16, 8 + headerSize).trim()),
  }
  return archive
}

/**
 * Resolve an archive-relative path to its header node.
 *
 * @param {string} path - slash-separated, e.g. `dsh/package.json`.
 * @returns the node, or `undefined`.
 */
function nodeAt(path) {
  const loaded = load()
  let node = loaded?.header
  for (const segment of path.split('/')) node = node?.files?.[segment]
  return node
}

/**
 * Whether the archive holds this path (a file or a directory).
 *
 * @param {string} path - slash-separated, e.g. `dsh/node_modules/@deepseek-ai/dsh-tools`.
 */
export function asarPathExists(path) {
  return nodeAt(path) !== undefined
}

/**
 * Read one file out of the archive.
 *
 * @param {string} path - slash-separated, e.g. `dsh/package.json`.
 * @returns {Buffer | undefined} the bytes, or `undefined` when the app or the path is absent.
 */
export function readAsarFile(path) {
  const node = nodeAt(path)
  if (!node || node.offset === undefined) return undefined
  const loaded = load()
  const start = 8 + loaded.headerSize + Number(node.offset)
  return loaded.bytes.subarray(start, start + Number(node.size))
}

/**
 * The installed runtime's own manifest (`dsh/package.json`).
 *
 * @returns {{ name: string, version: string } | undefined}
 */
export function installedRuntime() {
  const bytes = readAsarFile('dsh/package.json')
  if (bytes === undefined) return undefined
  const manifest = JSON.parse(bytes.toString('utf8'))
  return { name: manifest.name, version: manifest.version }
}

/**
 * Whether a package name is resolvable on this machine — shipped inside the app, or installed in
 * the live profile. Package names only; subpath entries like `<pkg>/tools` are the caller's job.
 *
 * @param {string} name - a package name, e.g. `@deepseek-ai/dsh-tools`.
 */
export function packageExists(name) {
  return (
    asarPathExists(`dsh/node_modules/${name}`) ||
    existsSync(join(PROFILE, 'node_modules', name, 'package.json'))
  )
}
