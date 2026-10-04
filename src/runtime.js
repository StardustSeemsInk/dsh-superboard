/**
 * The board's browser-side runtime: mermaid, and the channel the browser uses to say what
 * happened when it tried to draw a diagram.
 *
 * **Why this plugin serves its own copy instead of borrowing one.** The installation has two
 * other mermaid runtimes on the same origin (`dsh-mermaid` serves 3.4 MB at
 * `/dsh-mermaid/mermaid-runtime.js`, `dsh-better-sidebar` serves 7.0 MB at `/sidebar/bundle/`).
 * Both are private to their owner: a chunk belongs to the plugin id that registered it, and
 * neither package exports the engine. More to the point, borrowing one would mean calling a
 * third party's internal route with a revision constant they are free to change — a dependency
 * that fails as a blank diagram rather than as an error. And U4 asks something a borrowed
 * renderer cannot give: **the failure has to come back to the Agent**, which means we own the
 * call that throws.
 *
 * So: one host route, one vendored file, `immutable` for a year. A browser fetches 3.5 MB the
 * first time it draws a diagram and never again.
 *
 * **Cache policy is ETag + `no-cache`, not `immutable` + a versioned path.** The obvious design
 * — put the version in the path and cache forever — is correct for users and useless for us:
 * those bytes are *ours*, and `node scripts/vendor-mermaid.mjs` can replace them at any moment
 * under an unchanged URL. Revalidation costs one conditional request per page load (`304`, a few
 * hundred bytes) and is right in both worlds.
 *
 * @module dsh-superboard/runtime
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the browser loads the vendored mermaid bundle. */
export const MERMAID_ROUTE = '/dsh-superboard/mermaid.min.js'

/** Where the board view reports what a render actually did. */
export const RENDER_REPORT_ROUTE = '/dsh-superboard/render-report'

/**
 * Where the browser loads pdf.js.
 *
 * Two module files and one asset tree, all under one prefix so the things pdf.js is told to fetch
 * (its worker, its CMaps, its standard fonts, its wasm) share a single origin and a single ETag.
 */
export const PDF_MODULE_ROUTE = '/dsh-superboard/pdfjs/pdf.min.mjs'
export const PDF_WORKER_ROUTE = '/dsh-superboard/pdfjs/pdf.worker.min.mjs'
export const PDF_ASSETS_ROUTE = '/dsh-superboard/pdfjs/assets/'

const MANIFEST_URL = new URL('../vendor/mermaid.json', import.meta.url)
const RUNTIME_URL = new URL('../vendor/mermaid.min.js', import.meta.url)
const PDF_MANIFEST_URL = new URL('../vendor/pdf.json', import.meta.url)
const PDF_ROOT = new URL('../vendor/pdf/', import.meta.url)

/** A reported message is model-facing text; keep a paste of a stack trace from becoming one. */
const MAX_MESSAGE_CHARS = 600

/** A mermaid source larger than this is not something the board should be rendering anyway. */
const MAX_INPUT_CHARS = 64 * 1024

/** The request body is bounded before it is parsed, so a bad client cannot allocate here. */
const MAX_BODY_BYTES = 128 * 1024

/**
 * What the asset trees are served as.
 *
 * An allowlist rather than a lookup: the prefix route reads arbitrary paths out of a directory, so
 * a file type nobody named is a request the board has no reason to answer. The two font formats
 * are deliberately generic — the browser is told not to sniff, and pdf.js parses them itself.
 */
const ASSET_TYPES = new Map([
  ['.bcmap', 'application/octet-stream'],
  ['.pfb', 'application/octet-stream'],
  ['.ttf', 'font/ttf'],
  ['.wasm', 'application/wasm'],
])

/**
 * Read the record of what was vendored.
 *
 * Returns `undefined` rather than throwing when the file is absent: a checkout where
 * `scripts/vendor-mermaid.mjs` was never run should degrade to "diagrams show their source",
 * which is what the board did before this milestone, rather than take the plugin down.
 *
 * @returns `{version, bytes, sha256}` for the vendored bundle, or `undefined`.
 */
export function readRuntimeManifest() {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'))
    if (typeof manifest?.version !== 'string' || typeof manifest?.sha256 !== 'string') return undefined
    return manifest
  } catch {
    return undefined
  }
}

/**
 * Read the record of the vendored pdf.js.
 *
 * Same contract as the mermaid manifest, and the same reason: absent means a checkout where
 * `npm run vendor:pdfjs` was never run, and the right answer there is that a page says it cannot
 * be drawn — not that the plugin fails to load.
 *
 * @returns `{version, tree, core}` for the vendored build, or `undefined`.
 */
export function readPdfManifest() {
  try {
    const manifest = JSON.parse(readFileSync(PDF_MANIFEST_URL, 'utf8'))
    if (typeof manifest?.version !== 'string') return undefined
    if (typeof manifest?.tree?.sha256 !== 'string') return undefined
    return manifest
  } catch {
    return undefined
  }
}

/**
 * What the board view reports after trying to draw a diagram.
 *
 * Deliberately volatile. A render report is an observation about DOM that exists right now, and
 * the projection is a fold over committed events — so this cannot live in the board state
 * without inventing an event type, which the whole design forbids. What makes that safe is that
 * a report carries **the render input it was produced from**: it is surfaced only while the block's
 * current source still matches, so editing the diagram retires its own complaint and nothing
 * has to be invalidated or expired.
 *
 * A host-side lint (`src/diagnose.js`) covers the same question from the other side and *is*
 * part of the fold, because it must work when the user never opens the board. Predicted versus
 * observed: both are surfaced as one thing — this diagram has a problem — and the outline does
 * not care which side noticed.
 */
export class RenderReports {
  /** sessionId → (blockId → report) */
  constructor(limit = 32) {
    this.limit = limit
    this.bySession = new Map()
  }

  /**
   * Record a failure, replacing whatever was known about that block.
   *
   * @param sessionId - the owning session.
   * @param report - `{blockId, blockSlug, input, message}`.
   */
  record(sessionId, report) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    let forSession = this.bySession.get(sessionId)
    if (forSession === undefined) {
      forSession = new Map()
      this.bySession.set(sessionId, forSession)
    }
    forSession.set(report.blockId, report)
    // Oldest sessions are dropped first: a report is only useful while its session is live.
    while (this.bySession.size > this.limit) {
      const oldest = this.bySession.keys().next().value
      if (oldest === sessionId) break
      this.bySession.delete(oldest)
    }
  }

  /**
   * The reports that still describe the board as it is now.
   *
   * The comparison is the whole mechanism: a report about a render input the block no longer has
   * is silently dropped rather than shown, so the Agent never reads a complaint about a diagram it
   * has already rewritten, or about a path the block has already stopped pointing at.
   *
   * @param sessionId - the owning session.
   * @param blockById - current blocks, keyed by id.
   * @returns the live reports, in insertion order.
   */
  live(sessionId, blockById) {
    const forSession = this.bySession.get(sessionId)
    if (forSession === undefined) return []
    const live = []
    for (const report of forSession.values()) {
      const block = blockById?.get?.(report.blockId)
      if (block === undefined) continue
      if (renderInputKey(block) !== report.input) continue
      live.push(report)
    }
    return live
  }

  /** Drop everything known about a session. */
  forget(sessionId) {
    this.bySession.delete(sessionId)
  }
}

/**
 * Index a model's blocks by id, across pages.
 *
 * @param model - the board model.
 * @returns a `Map` of block id to block.
 */
export function blockIndex(model) {
  const index = new Map()
  for (const page of model.pages) {
    for (const block of page.blocks) index.set(block.id, block)
  }
  return index
}

/**
 * Register the board's browser-facing routes.
 *
 * Registered on the plugin's own fiber, so both disappear when it unloads. The web server binds
 * to loopback; there is no session cookie on these paths, which is why the report route takes
 * only three bounded strings and can never write to the board.
 *
 * @param ctx - the plugin's fiber context, with `webServer` available.
 * @param reports - the report store the outline reads.
 */
export function registerRuntimeRoutes(ctx, reports) {
  const manifest = readRuntimeManifest()
  if (manifest === undefined) {
    ctx.logger?.warn?.(
      'dsh-superboard: vendor/mermaid.min.js is missing; `uml` blocks will show their source. Run `npm run vendor:mermaid`.',
    )
  }
  const pdf = readPdfManifest()
  if (pdf === undefined) {
    ctx.logger?.warn?.(
      'dsh-superboard: vendor/pdf is missing; `pdf-page` blocks will say they cannot be drawn. Run `npm run vendor:pdfjs`.',
    )
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: MERMAID_ROUTE,
        handler: (req, res) => serveRuntime(req, res, manifest),
      }),
    'dsh-superboard: mermaid runtime route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PDF_MODULE_ROUTE,
        handler: (req, res) => serveVendoredPdf(req, res, pdf, 'pdf.min.mjs', 'text/javascript; charset=utf-8'),
      }),
    'dsh-superboard: pdf.js module route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PDF_WORKER_ROUTE,
        handler: (req, res) => serveVendoredPdf(req, res, pdf, 'pdf.worker.min.mjs', 'text/javascript; charset=utf-8'),
      }),
    'dsh-superboard: pdf.js worker route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: PDF_ASSETS_ROUTE,
        handler: (req, res) => serveVendoredPdf(req, res, pdf, undefined, undefined),
      }),
    'dsh-superboard: pdf.js assets route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RENDER_REPORT_ROUTE,
        handler: (req, res) => receiveReport(req, res, reports),
      }),
    'dsh-superboard: render report route',
  )
}

/**
 * Serve the vendored mermaid bundle.
 *
 * Read from disk on every request rather than cached in memory: the file is 3.5 MB and the
 * request happens once per browser per version, so a resident copy would cost more than it
 * saves — and reading fresh is what makes re-vendoring visible without a restart.
 *
 * @param req - the HTTP request.
 * @param res - the HTTP response.
 * @param manifest - the vendored record, or `undefined` when nothing was vendored.
 */
function serveRuntime(req, res, manifest) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  if (manifest === undefined) {
    res.writeHead(404)
    res.end()
    return
  }

  const etag = `"mermaid-${manifest.version}-${manifest.sha256.slice(0, 16)}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' })
    res.end()
    return
  }

  let body
  try {
    body = readFileSync(RUNTIME_URL)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }

  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': body.length,
    etag,
    'cache-control': 'no-cache',
    // The bundle is mermaid's own minified output; nothing here is a document.
    'x-content-type-options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/**
 * Serve one file out of the vendored pdf.js tree.
 *
 * Two callers and one body, because the module files and the asset tree differ only in how the
 * relative path is arrived at: `name` for the two known modules, and the tail of the request URL
 * for the prefix route. Everything after that is the same question — is this a file that was
 * vendored, and what is it.
 *
 * Read from disk per request. The whole tree shares one ETag because it is versioned as a whole:
 * re-running the vendor script changes every hash it covers, so a stale asset cannot outlive a
 * fresh module.
 *
 * @param req - the HTTP request.
 * @param res - the HTTP response.
 * @param manifest - the vendored record, or `undefined` when nothing was vendored.
 * @param name - a path relative to `vendor/pdf`, or `undefined` to take it from the URL.
 * @param contentType - the type to serve with, or `undefined` to derive it from the extension.
 */
function serveVendoredPdf(req, res, manifest, name, contentType) {
  const notFound = () => {
    res.writeHead(404)
    res.end()
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  if (manifest === undefined) {
    notFound()
    return
  }

  let relative = name
  if (relative === undefined) {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    try {
      relative = `assets/${decodeURIComponent(pathname.slice(PDF_ASSETS_ROUTE.length))}`
    } catch {
      notFound()
      return
    }
  }

  // The prefix route hands over whatever the caller typed, so the rule is a whitelist rather than
  // a sanitiser: no separators of either spelling, no NUL, and no segment that is empty, `.` or
  // `..`. Normalising and then comparing prefixes is the other way to do this, and it is the way
  // that keeps being wrong.
  const parts = relative.split('/')
  if (relative.includes('\0') || relative.includes('\\')) {
    notFound()
    return
  }
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    notFound()
    return
  }

  const type = contentType ?? ASSET_TYPES.get(parts.at(-1).slice(parts.at(-1).lastIndexOf('.')))
  if (type === undefined) {
    notFound()
    return
  }

  const etag = `"pdfjs-${manifest.version}-${manifest.tree.sha256.slice(0, 16)}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' })
    res.end()
    return
  }

  let body
  try {
    body = readFileSync(join(fileURLToPath(PDF_ROOT), ...parts))
  } catch {
    notFound()
    return
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    etag,
    // Not `immutable`: re-running `vendor:pdfjs` replaces these bytes at the same paths.
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/**
 * Accept one render report from the board view.
 *
 * Rejects cross-site callers outright. The route is unauthenticated (the web server has no
 * session cookie on plugin paths), and what it feeds is text the Agent reads — so a page in
 * another tab must not be able to write into the Agent's context. `Sec-Fetch-Site` is the one
 * header a browser will not let a page forge.
 *
 * @param req - the HTTP request.
 * @param res - the HTTP response.
 * @param reports - the report store.
 */
function receiveReport(req, res, reports) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    res.writeHead(403)
    res.end()
    return
  }

  readBody(req, MAX_BODY_BYTES)
    .then((body) => {
      const report = parseReport(body)
      if (report === undefined) {
        res.writeHead(400)
        res.end()
        return
      }
      reports.record(report.sessionId, report)
      res.writeHead(204)
      res.end()
    })
    .catch(() => {
      // A body over the cap, a broken stream, or a disconnect. None of it is worth a status
      // the client acts on: the board is already showing the error inline.
      if (!res.headersSent) res.writeHead(400)
      res.end()
    })
}

/**
 * Read a request body, refusing anything over the cap rather than buffering it.
 *
 * @param req - the HTTP request.
 * @param limit - the maximum accepted byte count.
 * @returns the body, or a rejected promise.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Validate one report.
 *
 * Every field is required and bounded. The render input is carried verbatim because it is the key
 * the report is retired by — a hash would work too, but only if both halves computed it the same
 * way, and the client half is a build-step-free classic script that cannot import this file.
 *
 * @param body - the raw request body.
 * @returns a report, or `undefined` when the body is not one.
 */
function parseReport(body) {
  let value
  try {
    value = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined

  const { sessionId, blockId, blockSlug, input, message } = value
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  if (typeof blockId !== 'string' || blockId === '') return undefined
  if (typeof input !== 'string' || input.length > MAX_INPUT_CHARS) return undefined
  if (typeof message !== 'string' || message === '') return undefined

  return {
    sessionId,
    blockId,
    blockSlug: typeof blockSlug === 'string' ? blockSlug : blockId,
    input,
    message: message.slice(0, MAX_MESSAGE_CHARS),
  }
}

/**
 * What a report about this block is retired by.
 *
 * The client sends the render input it used and the host compares it against the block's current
 * one, so this has to be the value whose change means "that observation is about the past". A
 * diagram's is its source. A picture's is the file it points at — the bytes behind a path can be
 * replaced, but a report about a path the block no longer names is certainly stale. A PDF page's
 * is the path plus which page, because `src` and `page` are separately editable.
 *
 * The client half computes the same three values inline (`renderInput` in `src/client.js`); it
 * cannot import this file. Keep the two in step.
 *
 * @param block - a board block.
 * @returns the key, or `undefined` for a block kind that cannot fail to render.
 */
export function renderInputKey(block) {
  if (block.kind === 'uml') return block.source
  if (block.kind === 'pdf-page') return `${block.src}#${block.page}`
  if (block.kind === 'image') return block.src
  return undefined
}
