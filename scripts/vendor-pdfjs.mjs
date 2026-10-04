/**
 * Copy pdf.js out of `node_modules` and into `vendor/pdf/`.
 *
 * **Why vendor rather than depend.** The board renders a PDF page in the browser, so the browser
 * has to be able to fetch the renderer. `node_modules` is not served, and the plugin loader only
 * serves this plugin's own `client.js`. So the files have to live inside the package, at a path a
 * host route can read — exactly the arrangement `vendor/mermaid.min.js` uses, and for the same
 * reason.
 *
 * **Why the assets too.** pdf.js fetches three trees lazily, and each one is the difference between
 * a correct page and a quietly wrong one:
 *
 *   - `standard_fonts/` — a PDF may rely on Helvetica or Times without embedding it.
 *   - `cmaps/` — CID-keyed CJK text without a `ToUnicode` map. Without these, Chinese text comes
 *     out as the wrong glyphs rather than as an error, which is the worst way to be wrong.
 *   - `wasm/` — JPEG 2000, JBIG2 and ICC profiles: scanned pages, mostly.
 *
 * `quickjs-eval.wasm` is deliberately **not** copied. It exists so a PDF's embedded JavaScript can
 * run, which is a capability this board has no use for and every reason not to hand a document.
 *
 * Run with `npm run vendor:pdfjs`. The output is committed, so a checkout needs no build step; the
 * manifest is what lets the host tell "vendored" from "someone cloned without running this", and
 * what the routes serve their ETags from.
 */

import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules', 'pdfjs-dist')
const target = join(root, 'vendor', 'pdf')

/**
 * The two files loaded as modules. Everything else is fetched on demand.
 *
 * **`legacy/`, not the modern build, and this is load-bearing.** The host parses PDFs too — that
 * is how a `rect` anchor gets its coordinates and how a path that does not exist is noticed
 * without anyone opening the board — and the modern build cannot run in Node: it calls
 * `Uint8Array.prototype.toHex`, which Node v24 does not have (nor `toBase64`/`fromHex`, and there
 * is no flag that adds them). The failure is `n.toHex is not a function`, thrown from inside the
 * bundle's own exception machinery, which reads as a corrupt document rather than as a missing
 * platform method.
 *
 * The legacy build is the one pdf.js publishes for exactly this environment: it polyfills those
 * methods and picks its code paths at load time. Measured, in a real browser: it imports in 31 ms
 * and rasterises the Chinese test page correctly, CMap glyphs and all. So it serves both halves,
 * one copy, one parser — rather than 1.84 MB of duplicated bytes and two engines that could
 * disagree about the same file.
 */
const CORE = ['legacy/build/pdf.min.mjs', 'legacy/build/pdf.worker.min.mjs']

/**
 * The trees copied into `vendor/pdf/assets/`, and the subdirectory each lands in.
 *
 * `wasm/` is listed file by file because the directory also holds the PDF-JavaScript interpreter
 * and its pure-JavaScript fallbacks, neither of which belongs in a viewer.
 */
const TREES = {
  standard_fonts: undefined,
  cmaps: undefined,
  wasm: ['openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm'],
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function fail(message) {
  console.error(`vendor-pdfjs: ${message}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

const core = {}
for (const name of CORE) {
  const bytes = readFileSync(join(source, name))
  // The worker is the bigger of the two and the one a wrong file would break silently: a
  // non-module worker loads without complaint and then fails on every document.
  if (bytes.byteLength < 200_000) fail(`${name} is only ${bytes.byteLength} bytes — wrong build?`)
  const flat = name.replace(/^(?:legacy\/)?build\//, '')
  writeFileSync(join(target, flat), bytes)
  core[flat] = { bytes: bytes.byteLength, sha256: sha256(bytes) }
}

if (!readFileSync(join(target, 'pdf.worker.min.mjs'), 'utf8').includes('WorkerMessageHandler')) {
  fail('the vendored worker does not look like pdf.js')
}

const assets = []
for (const [tree, only] of Object.entries(TREES)) {
  const from = join(source, tree)
  const to = join(target, 'assets', tree)
  mkdirSync(to, { recursive: true })
  for (const name of only ?? readdirSync(from).sort()) {
    cpSync(join(from, name), join(to, name))
    assets.push(`assets/${tree}/${name}`)
  }
}

// One hash over the whole tree, name and contents, so a single ETag covers every asset route and
// re-vendoring any file invalidates all of them.
const digest = createHash('sha256')
let treeBytes = 0
for (const name of [...assets, ...Object.keys(core)].sort()) {
  const bytes = readFileSync(join(target, name))
  treeBytes += bytes.byteLength
  digest.update(name).update('\0').update(bytes).update('\0')
}

const manifest = {
  package: pkg.name,
  version: pkg.version,
  tree: { files: assets.length + Object.keys(core).length, bytes: treeBytes, sha256: digest.digest('hex') },
  core,
  assets,
}
writeFileSync(join(root, 'vendor', 'pdf.json'), `${JSON.stringify(manifest, null, 2)}\n`)

for (const [name, entry] of Object.entries(core)) {
  console.log(`${name.padEnd(24)} ${String(entry.bytes).padStart(10)} B  ${entry.sha256.slice(0, 16)}`)
}
console.log(`${'assets'.padEnd(24)} ${String(treeBytes).padStart(10)} B  ${assets.length} files`)
console.log(`pdfjs-dist ${pkg.version} → vendor/pdf/`)
