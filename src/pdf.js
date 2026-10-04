/**
 * Host-side PDF parsing: the text layer, with geometry, so an anchor can name a place on a page.
 *
 * **Why the host parses at all, when the browser already rasterises these pages.** The user's
 * framing settles it: document *understanding* is not this plugin's job (DSH has its own PDF
 * support), and what the board owes the Agent is the ability to **highlight and anchor** —
 * "我们的PDF解析是为了能够执行Agent对PDF的高亮和内容锚点用的". An anchor needs a rectangle, a
 * rectangle needs the text layer's own coordinates, and a rasterised canvas cannot be read back.
 * So the text table is not a by-product of this module; it *is* the deliverable.
 *
 * **Why it cannot happen in the fold.** `sessionProjections` calls `apply` synchronously and never
 * awaits it (`dsh-session-projection/lib/index.js:303,370,392,411`), and the standing prompt's
 * `text(context)` is synchronous too (`dsh-system-prompt/lib/index.js:342,350`). Parsing is I/O.
 * A tool's `execute` *may* be async (`dsh-tools/lib/index.js:3310`), which is where this gets
 * called from. That has a consequence worth stating plainly: a parse result **cannot be written
 * back into the board state**, because a projection only republishes when `apply` returns a new
 * value — an async write would be invisible. So this is volatile host state, exactly like
 * `RenderReports`, and for the same reason. `pageCount` used to be a field on the block for this
 * to write into; it was unreachable from the tool schema, so it was dead, and now it is gone.
 *
 * **The parser is the legacy build, and both halves use it.** The ordinary build cannot run in the
 * host process at all: it calls `Uint8Array.prototype.toHex`, which Node v24 does not provide and
 * has no flag to enable. The legacy build is the one pdf.js publishes for that environment, and it
 * was measured working in the browser too — so there is one copy, not two.
 *
 * **A trap worth writing down: `cMapUrl` must be a plain filesystem path.** A `file://` URL makes
 * every CMap lookup fail, and pdf.js reports that by writing a `console.warn` and then returning
 * **empty strings as text** — `getTextContent()` resolves successfully with nothing in it. A page
 * of Chinese becomes a page with no words, which is the same observable result as a scanned page,
 * which is a state this design deliberately supports. That is the worst kind of failure: silent,
 * and indistinguishable from a legitimate one. Plain paths avoid it; `pdfAssetPaths()` exists so
 * there is exactly one place that decides, and `test/pdf.test.js` pins the exact shape.
 *
 * @module dsh-superboard/pdf
 */

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { quantise } from './model.js'
import { readPdfManifest } from './runtime.js'

/** Where the vendored pdf.js module and its worker live, as absolute filesystem paths. */
const PDF_ROOT = fileURLToPath(new URL('../vendor/pdf/', import.meta.url))

/** The CMap and standard-font trees pdf.js is pointed at. */
const PDF_ASSETS = fileURLToPath(new URL('../vendor/pdf/assets/', import.meta.url))

/**
 * A PDF larger than this is not something the board should be parsing on a tool call.
 *
 * The cap is deliberately generous — the fixture this repo tests with is 170 KB and real documents
 * are single-digit megabytes — and it exists so that one bad path cannot turn a tool call into a
 * multi-second one. Over the cap the block is still reported and still renders on screen; it just
 * has no text layer to anchor to.
 */
const MAX_PDF_BYTES = 64 * 1024 * 1024

/** Text items retained per page. A page with more than this is a scanned table, not a document. */
const MAX_BOXES_PER_PAGE = 500

/** Line segments retained per page. */
const MAX_LINES_PER_PAGE = 400

/** Documents kept open, least-recently-used first. */
const MAX_OPEN_DOCUMENTS = 8

/** Inputs whose parse result is remembered, so an edit that does not touch them is free. */
const MAX_REMEMBERED_INPUTS = 64

/**
 * How wide a gap has to be, relative to the glyph height, before two boxes are different segments.
 *
 * Measured rather than guessed (`test/pdf.test.js` records the numbers): in this fixture a word
 * space inside a sentence comes out at 0.0054–0.0063 of the page width against a glyph height of
 * 0.0143, while the gap between two table columns is 0.0698–0.1437. That is a ratio of about 0.4
 * against 5+. The threshold sits in the middle of an eightfold margin, which is why a ratio works
 * here and a fixed constant would not: a 24 pt heading and a 6 pt footnote have the same word space
 * *to their own height*, and different ones in page units.
 */
const SEGMENT_GAP_RATIO = 0.6

/** Two boxes share a row when their vertical overlap is more than this share of the shorter one. */
const ROW_OVERLAP_RATIO = 0.5

/** A message the Agent reads; keep a stack trace from becoming one. */
const MAX_MESSAGE_CHARS = 400

/**
 * The pdf.js module, imported once.
 *
 * Loaded lazily rather than at module load: `pdf.min.mjs` is 519 KB and initialises a worker, and
 * a session that never puts a PDF on the board should not pay for it. A profile where
 * `npm run vendor:pdfjs` was never run resolves to `undefined` once, rather than retrying on every
 * call.
 *
 * @returns the module namespace, or `undefined` when nothing was vendored.
 */
let pdfjsPromise
function loadPdfjs() {
  if (pdfjsPromise !== undefined) return pdfjsPromise
  pdfjsPromise = (async () => {
    if (readPdfManifest() === undefined) return undefined
    try {
      const module = await import(new URL('../vendor/pdf/pdf.min.mjs', import.meta.url).href)
      // A plain `file://` URL here, unlike the CMap paths below: this one is handed to a worker
      // thread rather than fetched, and it is the form that was measured working in the host.
      module.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf/pdf.worker.min.mjs', import.meta.url).href
      return module
    } catch {
      return undefined
    }
  })()
  return pdfjsPromise
}

/**
 * What pdf.js is told about the vendored asset trees.
 *
 * Exported for one reason: the `file://` trap above is invisible at the call site — it produces an
 * empty page, not an error — so it needs a test that can assert on the values rather than on a
 * comment. Both strings must be plain filesystem paths with a trailing separator.
 *
 * The trailing character is a **forward slash**, not the platform's: pdf.js rejects anything else
 * outright (`getFactoryUrlProp`: `if (t.endsWith("/")) return t; throw new Error(\`Invalid factory
 * url: "${t}" must include trailing slash.\`)`). On Windows the result is therefore deliberately
 * mixed — `…\assets\cmaps/` — because pdf.js does plain concatenation onto it.
 *
 * @returns `{cMapUrl, cMapPacked, standardFontDataUrl}`.
 */
export function pdfAssetPaths() {
  return {
    cMapUrl: `${PDF_ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDF_ASSETS}standard_fonts/`,
  }
}

/**
 * Reduce whatever pdf.js threw to what the Agent needs.
 *
 * The codes are the ones `src/schema.js` already uses for render diagnostics, so the Agent reads
 * one vocabulary whether a failure was predicted by the host lint, observed by the browser, or
 * found here.
 *
 * @param error - whatever pdf.js threw.
 * @returns `{code, message}`.
 */
function describeFailure(error) {
  const name = error?.constructor?.name ?? 'Error'
  const text = String(error?.message ?? error).split('\n')[0]
  const message = `${name}: ${text}`.slice(0, MAX_MESSAGE_CHARS)

  // A password is its own thing and worth naming, because the fix is different: the Agent should
  // stop pointing at this file rather than re-check the path.
  if (name === 'PasswordException') {
    return { code: 'UNSUPPORTED', message: `this PDF is password-protected and cannot be read: ${message}` }
  }
  // `InvalidPDFException` covers junk, a truncated file, and a body with no xref — all of which are
  // "this is not a PDF I can read", which is what the Agent has to be told.
  if (name === 'InvalidPDFException') {
    return { code: 'PARSE', message: `this file is not a PDF the board can read: ${message}` }
  }
  return { code: 'PARSE', message }
}

/**
 * The raw text boxes on one page.
 *
 * Coordinates are relative to the page, origin top-left, in 0..1 — the convention
 * `docs/design/board-model.md` already fixes for `rect`/`point` anchors, so a box taken from here
 * can be handed to `update_block`'s `anchors` with no conversion. Normalised rather than
 * pixel-valued because page space is independent of render DPI, container width, and zoom.
 *
 * Quantised through `quantise` so that a rectangle the Agent copies back into the model is the
 * *same* value the content hash sees; an unrounded `0.09600000000000002` would move the revision
 * on what the Agent believes is a no-op edit.
 *
 * @param pdfjs - the module namespace.
 * @param page - a pdf.js page proxy.
 * @returns an array of `{text, x, y, w, h}`.
 */
async function pageBoxes(pdfjs, page) {
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const boxes = []

  for (const item of content.items) {
    // `getTextContent` also yields marked-content markers, which carry no `str`.
    if (typeof item?.str !== 'string' || item.str.trim() === '') continue
    const tx = pdfjs.Util.transform(viewport.transform, item.transform)
    const height = Math.hypot(tx[2], tx[3])
    const width = item.width
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue

    const box = {
      text: item.str,
      x: quantise(tx[4] / viewport.width),
      // `Util.transform` has already composed the viewport transform, which includes the y-flip —
      // so `tx[5]` is the baseline's distance from the *top* edge, and the glyph box's top is one
      // glyph height above it. Flipping again here mirrors the page vertically while keeping every
      // box inside 0..1, which no bounds check can catch and which points an anchor at the wrong
      // end of the document. `test/pdf.test.js` pins the direction by asserting reading order.
      y: quantise((tx[5] - height) / viewport.height),
      w: quantise(width / viewport.width),
      h: quantise(height / viewport.height),
    }
    // A box entirely off the page is a layout artefact, not a place to point at.
    if (box.x + box.w <= 0 || box.y + box.h <= 0 || box.x >= 1 || box.y >= 1) continue
    boxes.push(box)
    if (boxes.length >= MAX_BOXES_PER_PAGE) break
  }

  return boxes
}

/**
 * Group raw text boxes into line segments, in reading order.
 *
 * This is what makes the table usable. A PDF's text layer breaks a sentence at every style change,
 * so the raw items sit closer to syllables than to lines — the fixture's first paragraph arrives as
 * three boxes. A rectangle over a fragment is a bad anchor; a rectangle over a line is the thing
 * the Agent actually means when it says "the paragraph under the heading".
 *
 * Two rows are the same when their vertical extents overlap; within a row, two boxes stay in one
 * segment while the gap between them is small relative to the glyph height, and split when it is
 * not. That split is what keeps a table's columns separate: in the fixture, "要验证的" and
 * "怎么看" are one visual row but two segments, which is the correct granularity for pointing.
 *
 * @param boxes - the page's raw boxes.
 * @returns an array of `{text, x, y, w, h}`, one per segment, in reading order.
 */
export function groupLines(boxes) {
  if (!Array.isArray(boxes) || boxes.length === 0) return []

  const ordered = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows = []
  for (const box of ordered) {
    const row = rows[rows.length - 1]
    if (row !== undefined) {
      const overlap = Math.min(row.bottom, box.y + box.h) - Math.max(row.top, box.y)
      const shorter = Math.min(row.bottom - row.top, box.h)
      if (shorter > 0 && overlap > ROW_OVERLAP_RATIO * shorter) {
        row.items.push(box)
        row.top = Math.min(row.top, box.y)
        row.bottom = Math.max(row.bottom, box.y + box.h)
        continue
      }
    }
    rows.push({ top: box.y, bottom: box.y + box.h, items: [box] })
  }

  const lines = []
  for (const row of rows) {
    const items = [...row.items].sort((a, b) => a.x - b.x)
    let run = []
    for (const box of items) {
      const previous = run[run.length - 1]
      if (previous !== undefined) {
        const gap = box.x - (previous.x + previous.w)
        const limit = SEGMENT_GAP_RATIO * Math.min(box.h, previous.h)
        if (gap > limit) {
          lines.push(segment(run))
          run = []
        }
      }
      run.push(box)
    }
    if (run.length > 0) lines.push(segment(run))
    if (lines.length >= MAX_LINES_PER_PAGE) break
  }
  return lines.slice(0, MAX_LINES_PER_PAGE)
}

/**
 * Collapse a run of adjacent boxes into one segment.
 *
 * @param run - the boxes, already in x order.
 * @returns `{text, x, y, w, h}`.
 */
function segment(run) {
  const left = Math.min(...run.map((box) => box.x))
  const top = Math.min(...run.map((box) => box.y))
  const right = Math.max(...run.map((box) => box.x + box.w))
  const bottom = Math.max(...run.map((box) => box.y + box.h))
  return {
    text: run.map((box) => box.text).join(' '),
    x: quantise(left),
    y: quantise(top),
    w: quantise(right - left),
    h: quantise(bottom - top),
  }
}

/**
 * Open documents, keyed by path and validated by stamp.
 *
 * Keyed by path because pages of one file are separate blocks: asking for page 3 must not download
 * and parse the document that page 1 already opened. Validated by `mtime:size` rather than trusted
 * forever, because a path is a live reference to the filesystem — the file can be rewritten under
 * us, and a page count cached from before the rewrite would be a confident lie.
 */
const openDocuments = new Map()

/**
 * Open (or reuse) the document behind a path.
 *
 * @param pdfjs - the module namespace.
 * @param src - the absolute path the block names.
 * @returns `{task, doc, stamp, pageCount}`.
 * @throws an error carrying a `code` of `ENOENT` or `ELIMIT`, or whatever pdf.js threw.
 */
async function openDocument(pdfjs, src) {
  let stat
  try {
    stat = statSync(src)
  } catch {
    const error = new Error('no such file')
    error.code = 'ENOENT'
    throw error
  }
  if (!stat.isFile()) {
    const error = new Error('not a regular file')
    error.code = 'ENOENT'
    throw error
  }

  const stamp = `${stat.mtimeMs}:${stat.size}`
  const cached = openDocuments.get(src)
  if (cached !== undefined && cached.stamp === stamp) {
    // Re-insert so the first key stays the least recently used one.
    openDocuments.delete(src)
    openDocuments.set(src, cached)
    return cached
  }
  if (cached !== undefined) {
    openDocuments.delete(src)
    cached.task.destroy().catch(() => {})
  }

  if (stat.size > MAX_PDF_BYTES) {
    const error = new Error(`${stat.size} bytes exceeds the ${MAX_PDF_BYTES}-byte limit`)
    error.code = 'ELIMIT'
    throw error
  }

  const bytes = readFileSync(src)
  // A fresh copy per attempt: `getDocument` transfers — and therefore detaches — the buffer it is
  // handed, so reusing one is how a second call fails with a `structuredClone` error that reads
  // like a pdf.js limitation and is not.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...pdfAssetPaths() })
  let doc
  try {
    doc = await task.promise
  } catch (error) {
    await task.destroy().catch(() => {})
    throw error
  }

  const entry = { task, doc, stamp, pageCount: doc.numPages }
  openDocuments.set(src, entry)
  while (openDocuments.size > MAX_OPEN_DOCUMENTS) {
    const oldest = openDocuments.keys().next().value
    if (oldest === src) break
    const evicted = openDocuments.get(oldest)
    openDocuments.delete(oldest)
    // Fire and forget: the worker is going away whether or not anyone waits for it.
    evicted.task.destroy().catch(() => {})
  }
  return entry
}

/**
 * Parse one page of one file.
 *
 * @param src - the absolute path.
 * @param pageNumber - 1-based.
 * @returns `{status:'ok', pageCount, lines}` or `{status:'failed', code, message, pageCount?}`.
 */
async function parsePage(src, pageNumber) {
  const pdfjs = await loadPdfjs()
  if (pdfjs === undefined) {
    return {
      status: 'failed',
      code: 'ENGINE_ERROR',
      message: 'pdf.js was never vendored, so no PDF page can be parsed. Run `npm run vendor:pdfjs`.',
    }
  }

  let entry
  try {
    entry = await openDocument(pdfjs, src)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 'failed', code: 'MISSING_ASSET', message: `there is no file at ${src}` }
    }
    if (error?.code === 'ELIMIT') {
      return { status: 'failed', code: 'LIMIT', message: `this PDF is too large to parse: ${String(error.message)}` }
    }
    const { code, message } = describeFailure(error)
    return { status: 'failed', code, message }
  }

  const pageCount = entry.pageCount
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
    return {
      status: 'failed',
      code: 'LIMIT',
      pageCount,
      message: `this PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}, so page ${pageNumber} does not exist`,
    }
  }

  try {
    const page = await entry.doc.getPage(pageNumber)
    const boxes = await pageBoxes(pdfjs, page)
    return { status: 'ok', pageCount, lines: groupLines(boxes) }
  } catch (error) {
    const { code, message } = describeFailure(error)
    return { status: 'failed', code, pageCount, message }
  }
}

/**
 * The parse facts for every `pdf-page` block in one session.
 *
 * Volatile, per-session, and keyed by block id — the same shape as `RenderReports`, and for the
 * same reason: a parse result is an observation about a file on disk, not a committed edit, and the
 * projection is a fold over committed events. Writing it into the state would not even be visible;
 * a projection republishes only when `apply` returns a new value.
 *
 * What keeps that honest is that each fact records **the input it was produced from** — `src` and
 * page number — and is only surfaced while the block still names that input. Editing the block
 * retires its own fact, and nothing has to be invalidated or expired.
 */
export class PdfFacts {
  /** sessionId → (blockId → fact) */
  constructor(limit = 32) {
    this.limit = limit
    this.bySession = new Map()
    /**
     * In-flight parses, keyed by input. Deliberately *not* per-session: the key is the file and the
     * page, so two sessions looking at one PDF should share the work rather than open two workers.
     */
    this.inFlight = new Map()
    /**
     * Every input ever parsed this process, keyed by `src#page`.
     *
     * Separate from `bySession` because the two answer different questions. `bySession` is indexed
     * by *block* and is what a tool reads back; this is indexed by *input* and is what lets
     * `board_apply` report on a page that has no block id yet — the dry run's ids are indicative,
     * so a fact filed under one would be dropped by `live()` the moment it was written.
     */
    this.byInput = new Map()
  }

  /**
   * Parse inputs that are not already known, and return the results keyed by input.
   *
   * @param inputs - `{src, page}` pairs; duplicates are collapsed.
   * @returns a `Map` of `src#page` to a parse result.
   */
  async ensureInputs(inputs) {
    const wanted = new Map()
    for (const input of inputs ?? []) {
      if (typeof input?.src !== 'string' || input.src === '') continue
      if (!Number.isInteger(input.page)) continue
      wanted.set(`${input.src}#${input.page}`, input)
    }

    const results = new Map()
    for (const [key, input] of wanted) {
      const known = this.byInput.get(key)
      if (known !== undefined) {
        results.set(key, known)
        continue
      }
      const result = await this.#parseOnce(key, input.src, input.page)
      this.byInput.set(key, result)
      results.set(key, result)
    }

    // Bounded like everything else here: this is a cache of observations, not a record.
    while (this.byInput.size > MAX_REMEMBERED_INPUTS) {
      const oldest = this.byInput.keys().next().value
      this.byInput.delete(oldest)
    }
    return results
  }

  /**
   * Bring the facts up to date for a model, parsing whatever is missing or stale.
   *
   * Called from the tools that can afford to wait — `board_apply`, `board_outline`, `board_read`.
   * The standing prompt deliberately does **not** call this: it is synchronous and rides every
   * request, so it reads whatever facts already exist and never blocks on I/O.
   *
   * Re-entering this with an unchanged model costs nothing: a fact whose input still matches is
   * kept as-is, so the common case is a map lookup per block and no file access at all.
   *
   * @param sessionId - the owning session.
   * @param model - the board model.
   * @returns the facts for this session, keyed by block id.
   */
  async ensure(sessionId, model) {
    if (typeof sessionId !== 'string' || sessionId === '') return new Map()

    const blocks = []
    for (const page of model?.pages ?? []) {
      for (const block of page.blocks) {
        if (block.kind === 'pdf-page') blocks.push({ block, pageSlug: page.slug })
      }
    }

    let forSession = this.bySession.get(sessionId)
    if (forSession === undefined) {
      forSession = new Map()
      this.bySession.set(sessionId, forSession)
    }

    // A block that stopped being a `pdf-page`, or was deleted, leaves a fact nobody can retire:
    // `live()` looks facts up by id and only ever walks current blocks.
    const current = new Set(blocks.map(({ block }) => block.id))
    for (const blockId of [...forSession.keys()]) {
      if (!current.has(blockId)) forSession.delete(blockId)
    }

    const stale = blocks.filter(({ block }) => {
      const known = forSession.get(block.id)
      return known === undefined || known.key !== `${block.src}#${block.page}`
    })
    const results = await this.ensureInputs(stale.map(({ block }) => ({ src: block.src, page: block.page })))

    for (const { block, pageSlug } of blocks) {
      const key = `${block.src}#${block.page}`
      const known = forSession.get(block.id)
      if (known !== undefined && known.key === key) {
        // Cheap to keep the address current, and this matters: a rename must not force a reparse,
        // and the Agent reads facts by slug.
        if (known.blockSlug !== block.slug || known.pageSlug !== pageSlug) {
          forSession.set(block.id, { ...known, blockSlug: block.slug, pageSlug })
        }
        continue
      }
      const result = results.get(key)
      if (result === undefined) continue
      forSession.set(block.id, {
        blockId: block.id,
        blockSlug: block.slug,
        pageSlug,
        src: block.src,
        page: block.page,
        key,
        ...result,
      })
    }

    // Oldest sessions are dropped first: a fact is only useful while its session is live.
    while (this.bySession.size > this.limit) {
      const oldest = this.bySession.keys().next().value
      if (oldest === sessionId) break
      this.bySession.delete(oldest)
    }

    return forSession
  }

  /**
   * Parse one input, reusing an in-flight attempt for the same input.
   *
   * @param key - the input identity.
   * @param src - the absolute path.
   * @param page - the 1-based page number.
   * @returns the parse result.
   */
  async #parseOnce(key, src, page) {
    const existing = this.inFlight.get(key)
    if (existing !== undefined) return existing
    const promise = parsePage(src, page).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, promise)
    return promise
  }

  /**
   * The facts that still describe the board as it is now.
   *
   * Same contract as `RenderReports.live`: a fact about an input the block no longer names is
   * silently dropped rather than shown, so the Agent never reads a page count for a file the block
   * has already stopped pointing at.
   *
   * Synchronous on purpose — the standing outline calls this on every request.
   *
   * @param sessionId - the owning session.
   * @param blockById - current blocks, keyed by id.
   * @returns the live facts, in insertion order.
   */
  live(sessionId, blockById) {
    const forSession = this.bySession.get(sessionId)
    if (forSession === undefined) return []
    const live = []
    for (const fact of forSession.values()) {
      const block = blockById?.get?.(fact.blockId)
      if (block === undefined) continue
      if (`${block.src}#${block.page}` !== fact.key) continue
      live.push(fact)
    }
    return live
  }

  /** Facts for a model that has not been committed yet, keyed by slug instead of id. */
  static bySlug(facts) {
    const map = new Map()
    for (const fact of facts) map.set(fact.blockSlug, fact)
    return map
  }

  /** Drop everything known about a session. */
  forget(sessionId) {
    this.bySession.delete(sessionId)
  }
}

/**
 * The text table for one page, as lines of model-facing text.
 *
 * A line is printed as its own rectangle followed by its text, because the rectangle is the point:
 * the Agent has to be able to copy four numbers straight into `{kind:'rect'}`. Printing the text
 * alone would leave it able to *find* the paragraph and not to *point* at it.
 *
 * @param fact - a live parse fact.
 * @param limit - the most lines to print.
 * @returns the table, or `''` when there is nothing to print.
 */
export function renderTextTable(fact, limit = 60) {
  if (fact?.status !== 'ok') return ''
  if (fact.lines.length === 0) {
    return (
      'text layer: none. This page has no extractable text — it is a scan or an image — so there ' +
      'is nothing here to anchor an arrow to. `point`/`rect` anchors need a text layer.'
    )
  }
  const shown = fact.lines.slice(0, limit)
  const rows = shown.map(
    (line) => `  (${line.x}, ${line.y}, ${line.w}, ${line.h})  ${line.text}`,
  )
  if (fact.lines.length > shown.length) {
    rows.push(`  … ${fact.lines.length - shown.length} more line(s), not printed`)
  }
  return [`text layer (${fact.lines.length} line(s), normalized 0..1, origin top-left):`, ...rows].join('\n')
}
