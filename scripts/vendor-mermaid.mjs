/**
 * Vendor mermaid's own prebuilt browser bundle into `vendor/`.
 *
 * Why copy a file instead of bundling one: mermaid already publishes exactly what we need.
 * `dist/mermaid.min.js` is a self-contained IIFE — every dependency inlined by mermaid's own
 * esbuild pass, ending with
 *
 *     globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;
 *
 * — so there is nothing left to resolve, nothing to tree-shake against, and no build tool in
 * this repo's dependency tree. Bundling it ourselves would produce a file within a few percent
 * of the same size (the tested alternative, `dsh-mermaid@0.4.1`, ships 3,449,278 B to this
 * file's 3,572,661 B) while adding a platform binary to every install. The size is paid on the
 * wire once: the host serves it `immutable`, so a browser fetches it on first diagram and never
 * again.
 *
 * The output is committed, because this plugin's promise is that a checkout works with no build
 * step. This script exists so the copy is reproducible and auditable rather than mysterious:
 * `vendor/mermaid.json` records the exact npm version and the sha256 of the bytes on disk.
 *
 *   node scripts/vendor-mermaid.mjs
 *
 * @module scripts/vendor-mermaid
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR_DIR = join(ROOT, 'vendor')
const OUT_FILE = join(VENDOR_DIR, 'mermaid.min.js')
const OUT_MANIFEST = join(VENDOR_DIR, 'mermaid.json')

/**
 * The marker that proves we copied the browser IIFE and not the ESM or core entry.
 *
 * Asserted rather than assumed: `mermaid/package.json`'s `exports["."]` points at
 * `./dist/mermaid.core.mjs`, which is 53 KB and pulls every diagram in at runtime. Copying that
 * by mistake would produce a runtime that loads and then fails on the first render, which is a
 * far worse failure than a build script that refuses to run.
 */
const BROWSER_MARKER = 'globalThis["mermaid"]'

/** Fail loudly rather than vendoring a stub. The real file is ~3.5 MB. */
const MIN_BYTES = 1_000_000

/**
 * Mermaid's own diagram detectors, harvested from the unminified ESM build.
 *
 * The host-side lint has to answer one question — *would mermaid recognise this source at all* —
 * and the only honest source for that answer is mermaid's own registry. A hand-copied keyword
 * list would rot on the next major version and start telling the Agent that working diagrams are
 * unsupported, which is worse than saying nothing.
 *
 * `dist/mermaid.core.mjs` is the unminified build and still carries its original comments
 * (`// src/diagrams/flowchart/flowDetector-v2.ts`), so every registration is readable:
 *
 *     var id7 = "sequence";
 *     var detector7 = /* @__PURE__ * / __name((txt) => /^\s*sequenceDiagram/.test(txt), "detector");
 *
 * Running `detectType` for real would mean loading 3.5 MB of DOM-bound code into the host. What
 * it actually does is walk the registry and return the first detector that matches
 * (`chunk-QJSWEUOL.mjs`: `for (let [r, {detector: l}] of Object.entries(xi)) if (l(i, t)) return r`),
 * so the regex literals *are* the decision, and copying them out reproduces it.
 *
 * This is a build-time extraction, not a runtime dependency: what it finds is frozen into
 * `vendor/mermaid.json` beside the hash of the bytes it describes.
 *
 * @param source - the contents of `dist/mermaid.core.mjs`.
 * @returns `{ ids, detectors }`, where a detector is a regex source string.
 */
function extractDiagramRegistry(source) {
  const ids = new Set()
  for (const match of source.matchAll(/var id\d* = "([^"]+)";/g)) ids.add(match[1])

  const detectors = new Set()
  // Every detector is `\^\s*`-anchored; that prefix is what makes a regex a detector rather than
  // some other test in the same file. The character class cannot cross a `/`, so this cannot run
  // away into unrelated code — and the guard below fails the build if the shape ever changes.
  for (const match of source.matchAll(/\/(\^\\s\*[^/]*)\//g)) detectors.add(match[1])

  if (ids.size < 20 || detectors.size < 20) {
    throw new Error(
      `vendor-mermaid: extracted ${ids.size} diagram ids and ${detectors.size} detectors from mermaid.core.mjs; the registry shape has changed`,
    )
  }
  return { ids: [...ids].sort(), detectors: [...detectors].sort() }
}

const require = createRequire(import.meta.url)
const packagePath = require.resolve('mermaid/package.json')
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
const distDir = join(dirname(packagePath), 'dist')
const sourcePath = join(distDir, 'mermaid.min.js')

const code = await readFile(sourcePath)
const registry = extractDiagramRegistry(await readFile(join(distDir, 'mermaid.core.mjs'), 'utf8'))

if (code.length < MIN_BYTES) {
  throw new Error(`vendor-mermaid: ${sourcePath} is ${code.length} B, expected at least ${MIN_BYTES}`)
}
if (!code.toString('utf8').includes(BROWSER_MARKER)) {
  throw new Error(
    `vendor-mermaid: ${sourcePath} does not contain ${BROWSER_MARKER}; it is not the browser bundle`,
  )
}

const sha256 = createHash('sha256').update(code).digest('hex')
await mkdir(VENDOR_DIR, { recursive: true })
await writeFile(OUT_FILE, code)
await writeFile(
  OUT_MANIFEST,
  `${JSON.stringify(
    {
      name: 'mermaid',
      version: packageJson.version,
      entry: 'vendor/mermaid.min.js',
      bytes: code.length,
      sha256,
      form: 'self-contained IIFE; on execution sets globalThis.mermaid to the default export',
      source: 'node_modules/mermaid/dist/mermaid.min.js',
      regenerate: 'node scripts/vendor-mermaid.mjs',
      diagramIds: registry.ids,
      diagramDetectors: registry.detectors,
    },
    null,
    2,
  )}\n`,
)

console.log(`vendored mermaid ${packageJson.version} → vendor/mermaid.min.js (${code.length} B, sha256 ${sha256.slice(0, 12)}…)`)
