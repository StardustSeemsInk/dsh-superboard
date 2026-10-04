/**
 * The host-side PDF parse.
 *
 * Two of these tests exist because of a failure the probes produced that nothing else would have
 * caught, and both are the kind that reads as success:
 *
 *   1. **`cMapUrl` as a `file://` URL.** pdf.js cannot read CMaps that way. It does not throw — it
 *      writes a `console.warn` and returns **empty strings as text**, so a page of Chinese comes
 *      back as a page with no words. That is indistinguishable from a scanned page, which this
 *      design supports on purpose. The regression is pinned by asserting the shape of the paths
 *      *and* by parsing a fixture that genuinely requires a CMap.
 *   2. **The y-flip.** `Util.transform` has already composed the viewport transform, so applying
 *      another flip mirrors the page while keeping every box inside 0..1 — no bounds check can
 *      catch it, and it points an anchor at the wrong end of the document. Pinned by asserting
 *      reading order against the text that is known to be at the top of the page.
 *
 * The fixture for (1) is built here rather than committed: it is a CID-keyed page with a
 * non-embedded `STSong-Light` font, which cannot produce any text without the CMap file. Every
 * other PDF in this repo embeds its font *and* a ToUnicode map, which makes it forgiving — parsing
 * one of those and seeing correct Chinese proves nothing about CMaps at all.
 *
 * The last group of tests goes through `registerBoardTools` rather than calling the handlers
 * directly, for the reason `test/tools.test.js` gives: a handler wired to the wrong thing passes a
 * direct call. Here the wiring is the *new* part — a store that has to be reached from three
 * different tools and from the standing outline — so testing the parse alone would prove the least
 * interesting half.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'

import { applyOps } from '../src/fold.js'
import { emptyBoardDoc } from '../src/model.js'
import { PdfFacts, groupLines, pdfAssetPaths, renderTextTable } from '../src/pdf.js'
import { registerBoardTools } from '../src/tools.js'

const SESSION = 'pdf-test'
const FIXTURE = 'docs/assets/pdf-check.pdf'

/** The fixture is committed, so its absence is a broken checkout rather than a missing runtime. */
function skipWithoutFixture(t) {
  if (existsSync(FIXTURE)) return false
  t.skip(`${FIXTURE} is not present`)
  return true
}

/** A model holding one `pdf-page` block. */
function modelWith(blocks) {
  return { pages: [{ id: 'pg', slug: 'page', blocks }] }
}

/** A block. */
function pdfBlock(id, src, page) {
  return { id, slug: id, kind: 'pdf-page', src, page }
}

/** Run `ensure` and return the facts keyed by slug. */
async function factsFor(blocks) {
  const store = new PdfFacts()
  const model = modelWith(blocks)
  await store.ensure(SESSION, model)
  return PdfFacts.bySlug(store.live(SESSION, new Map(blocks.map((block) => [block.id, block]))))
}

/**
 * Build a PDF that cannot be read without a CMap.
 *
 * `STSong-Light` is a predefined Adobe CID font, so nothing is embedded, and `UniGB-UCS2-H` means
 * the content stream is UCS-2 that can only become text by way of the CMap file of that name. With
 * no CMap the page yields no text at all — which is the signal, and the reason this fixture is
 * worth the fifteen lines.
 *
 * @param text - the Chinese text to place on the page.
 * @returns the PDF bytes.
 */
function buildCidPdf(text) {
  const hex = [...text].map((ch) => ch.codePointAt(0).toString(16).padStart(4, '0')).join('').toUpperCase()
  const content = `BT /F1 28 Tf 72 760 Td <${hex}> Tj ET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light ' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> ' +
      '/FontDescriptor 6 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -250 1000 900] ' +
      '/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const startxref = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

// ---------------------------------------------------------------------------
// The trap: CMaps are read from a filesystem path, never a file:// URL
// ---------------------------------------------------------------------------

test('the CMap URL is a filesystem path ending in a forward slash, as pdf.js demands', () => {
  const paths = pdfAssetPaths()
  // The whole point. A `file://` URL here makes `getTextContent()` resolve with empty strings —
  // every page becomes "a scan", which is a legitimate state this board supports, so the bug would
  // never be reported by a user and would never fail a bounds check.
  assert.equal(paths.cMapUrl.startsWith('file://'), false)
  assert.equal(paths.standardFontDataUrl.startsWith('file://'), false)
  // A literal `/`, not the platform separator: pdf.js rejects anything else outright, with
  // `Invalid factory url: "…" must include trailing slash.` On Windows the value is therefore
  // deliberately mixed, because pdf.js concatenates the file name onto it.
  assert.ok(paths.cMapUrl.endsWith('/'), paths.cMapUrl)
  assert.ok(paths.cMapUrl.endsWith('cmaps/'), paths.cMapUrl)
  assert.ok(paths.standardFontDataUrl.endsWith('standard_fonts/'), paths.standardFontDataUrl)
  assert.equal(paths.cMapPacked, true)
})

test('a page that needs a CMap gets its text, which is what the path above is for', async (t) => {
  const dir = 'E:/Dev/.tmp-superboard-pdf-test'
  const file = `${dir}/cid.pdf`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, buildCidPdf('看板测试中文'))
    const facts = await factsFor([pdfBlock('cid', file, 1)])
    const fact = facts.get('cid')
    assert.equal(fact.status, 'ok')
    const text = fact.lines.map((line) => line.text).join('')
    // The exact assertion. With a `file://` cMapUrl this is "" and the status is still 'ok'.
    assert.equal(text, '看板测试中文')
  } catch (error) {
    // A checkout without `npm run vendor:pdfjs` cannot parse anything; that is a skip, not a failure.
    if (String(error?.message ?? '').includes('EENGINE')) return t.skip(String(error.message))
    throw error
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The trap: the y axis already points down
// ---------------------------------------------------------------------------

test('boxes are in reading order, so y grows downward from the top of the page', async (t) => {
  if (skipWithoutFixture(t)) return
  const facts = await factsFor([pdfBlock('p1', FIXTURE, 1)])
  const fact = facts.get('p1')
  assert.equal(fact.status, 'ok', JSON.stringify(fact))
  assert.ok(fact.lines.length > 5)

  // The fixture's first line is its title, and its last is a footnote. If the axis were flipped the
  // whole list would still sit inside 0..1 — the title would simply be reporting y≈0.9. So the
  // assertion has to be about *content*, not bounds.
  const title = fact.lines.find((line) => line.text.includes('第 1 页'))
  const footnote = fact.lines.find((line) => line.text.includes('render failures'))
  assert.ok(title !== undefined, 'the title line was not found')
  assert.ok(footnote !== undefined, 'the footnote line was not found')
  assert.ok(title.y < footnote.y, `title y=${title.y} should be above footnote y=${footnote.y}`)
  // And near the top, not merely above the footnote.
  assert.ok(title.y < 0.2, `title y=${title.y} should be near the top edge`)
})

test('every box stays inside the page, which the flip above cannot be caught by', async (t) => {
  if (skipWithoutFixture(t)) return
  const facts = await factsFor([pdfBlock('p1', FIXTURE, 1), pdfBlock('p3', FIXTURE, 3)])
  for (const fact of facts.values()) {
    assert.equal(fact.status, 'ok')
    for (const line of fact.lines) {
      assert.ok(line.x >= 0 && line.x < 1, `x=${line.x} for ${JSON.stringify(line.text)}`)
      assert.ok(line.y >= 0 && line.y < 1, `y=${line.y} for ${JSON.stringify(line.text)}`)
      assert.ok(line.x + line.w <= 1.001, `right edge for ${JSON.stringify(line.text)}`)
      assert.ok(line.y + line.h <= 1.001, `bottom edge for ${JSON.stringify(line.text)}`)
      assert.ok(line.w > 0 && line.h > 0)
    }
  }
})

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

test('adjacent boxes join into one line, and a column gap splits them', () => {
  const tight = groupLines([
    { text: 'a', x: 0.1, y: 0.2, w: 0.05, h: 0.02 },
    { text: 'b', x: 0.151, y: 0.2, w: 0.05, h: 0.02 },
  ])
  assert.equal(tight.length, 1)
  assert.equal(tight[0].text, 'a b')
  // The joined rectangle spans both, rather than being the first box's.
  assert.ok(Math.abs(tight[0].w - 0.101) < 0.002, String(tight[0].w))

  const apart = groupLines([
    { text: 'a', x: 0.1, y: 0.2, w: 0.05, h: 0.02 },
    { text: 'b', x: 0.6, y: 0.2, w: 0.05, h: 0.02 },
  ])
  assert.equal(apart.length, 2)
})

test('the split threshold scales with glyph height, not page width', () => {
  // The same absolute gap, against two glyph heights: a 24pt heading and a 6pt footnote have the
  // same word space *relative to themselves* and different ones in page units. A fixed constant
  // would join one and split the other for no reason the text supports.
  const big = groupLines([
    { text: 'a', x: 0.1, y: 0.2, w: 0.05, h: 0.04 },
    { text: 'b', x: 0.17, y: 0.2, w: 0.05, h: 0.04 },
  ])
  const small = groupLines([
    { text: 'a', x: 0.1, y: 0.2, w: 0.05, h: 0.01 },
    { text: 'b', x: 0.17, y: 0.2, w: 0.05, h: 0.01 },
  ])
  assert.equal(big.length, 1, 'a gap smaller than the glyph height is a space')
  assert.equal(small.length, 2, 'the same gap against a short glyph is a column break')
})

test('two rows are separate lines even when they overlap horizontally', () => {
  const lines = groupLines([
    { text: 'top', x: 0.1, y: 0.2, w: 0.3, h: 0.02 },
    { text: 'bottom', x: 0.1, y: 0.3, w: 0.3, h: 0.02 },
  ])
  assert.equal(lines.length, 2)
  assert.equal(lines[0].text, 'top')
})

test('grouping is sorted into reading order regardless of input order', () => {
  const lines = groupLines([
    { text: 'second', x: 0.1, y: 0.3, w: 0.2, h: 0.02 },
    { text: 'first', x: 0.1, y: 0.2, w: 0.2, h: 0.02 },
  ])
  assert.deepEqual(lines.map((line) => line.text), ['first', 'second'])
})

test('grouping nothing is empty rather than an error', () => {
  assert.deepEqual(groupLines([]), [])
  assert.deepEqual(groupLines(undefined), [])
})

test('the fixture groups its table columns apart, which is what makes an anchor usable', async (t) => {
  if (skipWithoutFixture(t)) return
  const facts = await factsFor([pdfBlock('p1', FIXTURE, 1)])
  const fact = facts.get('p1')
  const texts = fact.lines.map((line) => line.text)
  // These are the two header cells of the fixture's first table. One visual row, two segments —
  // the granularity an arrow has to be able to point at.
  assert.ok(texts.includes('要验证的'), JSON.stringify(texts.slice(0, 8)))
  assert.ok(texts.includes('怎么看'), JSON.stringify(texts.slice(0, 8)))
  // And a sentence that arrived as three boxes is one line again.
  assert.ok(
    texts.some((text) => text.includes('这一页是为了确认') && text.includes('画到卡片里')),
    'the paragraph was not rejoined',
  )
})

// ---------------------------------------------------------------------------
// Failure paths: each one is a distinct, actionable answer
// ---------------------------------------------------------------------------

test('a missing file is reported as a missing asset, naming the path', async (t) => {
  if (skipWithoutFixture(t)) return
  const facts = await factsFor([pdfBlock('gone', 'E:/Dev/definitely-not-here.pdf', 1)])
  const fact = facts.get('gone')
  assert.equal(fact.status, 'failed')
  assert.equal(fact.code, 'MISSING_ASSET')
  assert.ok(fact.message.includes('E:/Dev/definitely-not-here.pdf'))
})

test('a file that is not a PDF is a parse failure, not a crash', async (t) => {
  if (skipWithoutFixture(t)) return
  const facts = await factsFor([pdfBlock('junk', 'package.json', 1)])
  const fact = facts.get('junk')
  assert.equal(fact.status, 'failed')
  assert.equal(fact.code, 'PARSE')
})

test('a page number past the end quotes how many pages there are', async (t) => {
  if (skipWithoutFixture(t)) return
  const facts = await factsFor([pdfBlock('p99', FIXTURE, 99)])
  const fact = facts.get('p99')
  assert.equal(fact.status, 'failed')
  assert.equal(fact.code, 'LIMIT')
  // The number is the actionable part: the Agent cannot learn it any other way, because pdf.js is
  // the only thing that knows and the host deliberately does not guess.
  assert.equal(fact.pageCount, 3)
  assert.ok(fact.message.includes('3 page'), fact.message)
  assert.ok(fact.message.includes('99'), fact.message)
})

// ---------------------------------------------------------------------------
// Caching and retirement
// ---------------------------------------------------------------------------

test('parsing is cached by input, so a second read touches no file', async (t) => {
  if (skipWithoutFixture(t)) return
  const store = new PdfFacts()
  const blocks = [pdfBlock('p1', FIXTURE, 1), pdfBlock('alsoP1', FIXTURE, 1)]
  const model = modelWith(blocks)
  await store.ensure('s', model)
  const index = new Map(blocks.map((block) => [block.id, block]))

  const started = process.hrtime.bigint()
  await store.ensure('s', model)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  // A cold parse of this fixture is tens of milliseconds. Any file access would show up here.
  assert.ok(elapsedMs < 10, `second ensure took ${elapsedMs.toFixed(1)} ms; it re-parsed`)

  // Two blocks on one page share one parse and each get their own fact.
  const live = store.live('s', index)
  assert.equal(live.length, 2)
  assert.deepEqual(live[0].lines, live[1].lines)
})

test('a fact is retired the moment its block stops naming that input', async (t) => {
  if (skipWithoutFixture(t)) return
  const store = new PdfFacts()
  const block = pdfBlock('p1', FIXTURE, 1)
  await store.ensure('s', modelWith([block]))
  const index = new Map([[block.id, block]])
  assert.equal(store.live('s', index).length, 1)

  // Retargeted at a different page. The fact about page 1 must not be shown for page 2, or the
  // Agent would anchor to a rectangle from the wrong page.
  const moved = { ...block, page: 2 }
  assert.equal(store.live('s', new Map([[block.id, moved]])).length, 0)
  // Deleted block: same.
  assert.equal(store.live('s', new Map()).length, 0)
})

test('a renamed block keeps its fact and its address is kept current', async (t) => {
  if (skipWithoutFixture(t)) return
  const store = new PdfFacts()
  const block = pdfBlock('p1', FIXTURE, 1)
  await store.ensure('s', modelWith([block]))

  // A rename must not force a reparse, but the Agent reads facts by slug — so the slug in the fact
  // has to follow the block or the outline would name an address that no longer resolves.
  const renamed = { ...block, slug: 'renamed' }
  await store.ensure('s', modelWith([renamed]))
  const live = store.live('s', new Map([[block.id, renamed]]))
  assert.equal(live.length, 1)
  assert.equal(live[0].blockSlug, 'renamed')
})

test('a block that is no longer a pdf-page drops its fact', async (t) => {
  if (skipWithoutFixture(t)) return
  const store = new PdfFacts()
  const block = pdfBlock('p1', FIXTURE, 1)
  await store.ensure('s', modelWith([block]))
  const replaced = { id: 'p1', slug: 'p1', kind: 'prose', markdown: 'now a paragraph' }
  await store.ensure('s', modelWith([replaced]))
  assert.equal(store.live('s', new Map([['p1', replaced]])).length, 0)
})

test('an empty session id parses nothing, because a fact needs an owner', async () => {
  const store = new PdfFacts()
  const result = await store.ensure('', modelWith([pdfBlock('p1', FIXTURE, 1)]))
  assert.equal(result.size, 0)
})

// ---------------------------------------------------------------------------
// The table the Agent reads
// ---------------------------------------------------------------------------

test('the text table prints a rectangle with every line, because that is the point', async (t) => {
  if (skipWithoutFixture(t)) return
  const facts = await factsFor([pdfBlock('p1', FIXTURE, 1)])
  const table = renderTextTable(facts.get('p1'))
  assert.ok(table.startsWith('text layer ('))
  // Every printed line carries four numbers: the Agent has to copy them into a rect anchor, and
  // printing the text alone would let it find a paragraph without being able to point at it.
  const rows = table.split('\n').slice(1)
  for (const row of rows.filter((line) => line.startsWith('  ('))) {
    assert.match(row, /^\s+\(-?[\d.]+, -?[\d.]+, [\d.]+, [\d.]+,?\)\s+\S/, row)
  }
})

test('a page with no text layer says so, rather than printing an empty table', async (t) => {
  if (skipWithoutFixture(t)) return
  // A failed parse has no table at all — the failure is reported through `failureNotes` instead, so
  // printing "no text" here too would say the same thing twice.
  const failed = await factsFor([pdfBlock('gone', 'E:/Dev/nope.pdf', 1)])
  assert.equal(renderTextTable(failed.get('gone')), '')

  // A parse that succeeded with nothing in it is the scanned-page case, and that one *must* speak,
  // because "no text layer" is a fact the Agent has to plan around.
  const empty = { status: 'ok', lines: [] }
  assert.ok(renderTextTable(empty).includes('no extractable text'))
})

test('a long page truncates its table instead of returning all of it', async (t) => {
  if (skipWithoutFixture(t)) return
  const fact = { status: 'ok', lines: Array.from({ length: 200 }, (_, index) => ({
    text: `line ${index}`,
    x: 0.1,
    y: index / 1000,
    w: 0.5,
    h: 0.01,
  })) }
  const table = renderTextTable(fact, 10)
  assert.ok(table.includes('more line(s), not printed'))
  assert.ok(table.split('\n').length < 20)
})

// ---------------------------------------------------------------------------
// Through the real tools, because the wiring is the new part
// ---------------------------------------------------------------------------

/**
 * Register every board tool against a stub registry and a real `PdfFacts`.
 *
 * @param model - the board model the tools should read.
 * @param facts - the parse store; pass `undefined` to exercise the no-store path.
 * @returns `{ call, registered }`.
 */
function toolHarness(model, facts) {
  const registered = []
  const doc = { model, sessionId: SESSION, diag: {}, pending: {} }
  registerBoardTools(
    { tools: { register: (definition) => (registered.push(definition), () => {}) } },
    { stateOf: () => doc },
    undefined,
    facts,
  )
  return {
    registered,
    async call(name, args) {
      const tool = registered.find((each) => each.name === name)
      if (tool === undefined) throw new Error(`tool ${name} was not registered`)
      return tool.execute(args, {
        agent: { session: { id: SESSION } },
        callId: 'test',
        name,
        arguments: args,
      })
    },
  }
}

/** A committed board with a heading, a readable page and a missing file. */
function e2eModel() {
  const model = emptyBoardDoc(SESSION).model
  return applyOps(
    model,
    [
      { op: 'add_page', page: 'main' },
      { op: 'add_block', page: 'main', kind: 'heading', text: 'PDF 验收' },
      { op: 'add_block', page: 'main', kind: 'pdf-page', src: FIXTURE, pdfPage: 1, slug: 'pdf1' },
      { op: 'add_block', page: 'main', kind: 'pdf-page', src: 'E:/Dev/nope.pdf', pdfPage: 1, slug: 'gone' },
    ],
    { sessionId: SESSION, callSeq: 1 },
  )
}

test('board_read carries the text table, which is the reason the host parses at all', async (t) => {
  if (skipWithoutFixture(t)) return
  const { call } = toolHarness(e2eModel(), new PdfFacts())
  const value = await call('board_read', { refs: ['pdf1'] })
  // The rectangles are the deliverable: the Agent has to copy four numbers into a rect anchor.
  assert.match(value.text, /\(0\.\d+, 0\.\d+, 0\.\d+, 0\.\d+\)\s+看板 PDF/, value.text.slice(0, 400))
  assert.ok(value.text.includes('normalized 0..1'))
})

test('a PDF failure reaches the Agent through the outline, in the same diag list', async (t) => {
  if (skipWithoutFixture(t)) return
  const { call } = toolHarness(e2eModel(), new PdfFacts())
  const value = await call('board_outline', {})
  // One list, three origins. A PDF failure has to be as visible as a broken diagram, because to the
  // Agent the two are the same problem: something it placed is not on the board.
  const codes = value.diag.map((entry) => entry.code)
  assert.ok(codes.includes('MISSING_ASSET'), JSON.stringify(value.diag))
  assert.equal(value.diag.find((entry) => entry.code === 'MISSING_ASSET').block, 'gone')
  assert.ok(value.text.includes('render failures'))
})

test('board_read attaches the failure to the block rather than only to the outline', async (t) => {
  if (skipWithoutFixture(t)) return
  const { call } = toolHarness(e2eModel(), new PdfFacts())
  const value = await call('board_read', { refs: ['gone'] })
  assert.ok(value.text.includes('cannot be read'), value.text)
  assert.ok(value.text.includes('MISSING_ASSET'), value.text)
  // And a failed parse prints no table — the failure is the message, and an empty table under it
  // would read as "this page has no text", which is a different and wrong fact.
  assert.equal(value.text.includes('text layer'), false)
})

test('without a facts store the tools still work, unenriched', async (t) => {
  if (skipWithoutFixture(t)) return
  // The store is optional the same way the web server is: a profile that never vendored pdf.js
  // should get a working board with no text layer, not a broken one.
  const { call } = toolHarness(e2eModel(), undefined)
  const value = await call('board_read', { refs: ['pdf1'] })
  assert.equal(value.text.includes('text layer'), false)
  assert.ok(value.text.includes('page: 1'))
  const outline = await call('board_outline', {})
  assert.deepEqual(outline.diag, [])
})

test('board_apply reports an unreadable page in the turn that placed it', async (t) => {
  if (skipWithoutFixture(t)) return
  const model = emptyBoardDoc(SESSION).model
  const facts = new PdfFacts()
  const { call } = toolHarness(model, facts)
  const value = await call('board_apply', {
    expected_revision: model.rev,
    ops: [
      { op: 'add_page', page: 'main' },
      { op: 'add_block', page: 'main', kind: 'pdf-page', src: 'E:/Dev/nope.pdf', pdfPage: 1 },
    ],
  })
  // The ops were applied — an unreadable file does not undo a write — so this is a warning on a
  // successful call, not an error. Getting that the wrong way round would make the Agent re-issue
  // an op that already succeeded.
  assert.equal(value.ok, true)
  assert.ok(value.warnings.some((warning) => warning.includes('no file at')), JSON.stringify(value.warnings))
  assert.ok(value.text.includes('⚠'), value.text)
})
