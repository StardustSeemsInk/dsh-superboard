/**
 * Markdown export tests.
 *
 * The export is a projection of the model, so it is pure and can be checked exhaustively — which
 * matters more here than usual. A block kind that exports as the empty string is indistinguishable
 * from a block the Agent never wrote, and nothing on screen would ever show the difference. So the
 * table below covers **every** kind, and one test asserts that the set of kinds it covers is the
 * set the schema actually allows.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const CLIENT_PATH = new URL('../src/client.js', import.meta.url)
const SCHEMA_PATH = new URL('../src/model.js', import.meta.url)

/** Minimal React stand-in, mirroring the one in client.test.js. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (compute) => compute(),
  useCallback: (callback) => callback,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createContext: (value) => ({ Provider: value, Consumer: value }),
  Fragment: 'Fragment',
}

/** Load the client half under a `window` stub and hand back its exports. */
function loadClient() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  let exports
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ factory }) => {
          exports = factory((name) => (name === 'react' ? fakeReact : undefined))
        },
      },
    },
    document: { createElement: () => ({ style: {}, appendChild() {}, remove() {} }) },
    URL: globalThis.URL,
    Blob: globalThis.Blob,
    Image: class {},
    FileReader: class {},
    XMLSerializer: class {},
    fetch: async () => ({ ok: true }),
    setTimeout,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
  }
  vm.runInNewContext(source, sandbox, { filename: CLIENT_PATH.pathname })
  return exports
}

const client = loadClient()

/** Build one block of each kind, with the minimum the schema requires plus a marker per field. */
function everyKind() {
  const base = { id: 'bl_1', slug: 'one', alias: [], createdAtRev: 'r1', updatedAtRev: 'r1' }
  return [
    { ...base, kind: 'heading', level: 2, text: '标题' },
    { ...base, kind: 'prose', markdown: '正文 **粗体**' },
    { ...base, kind: 'list', ordered: false, items: [{ id: 'i1', text: '甲', depth: 0 }] },
    { ...base, kind: 'list', ordered: true, items: [{ id: 'i1', text: '甲', depth: 0 }] },
    { ...base, kind: 'code', lang: 'js', code: 'const a = 1', filename: 'a.js' },
    { ...base, kind: 'uml', engine: 'mermaid', diagram: 'flowchart', source: 'flowchart LR' },
    { ...base, kind: 'image', src: '/a.png', alt: '图', caption: '说明' },
    { ...base, kind: 'pdf-page', src: '/a.pdf', page: 3, caption: '裁剪' },
    { ...base, kind: 'group', title: '组', children: ['bl_2'], layout: { template: 'flow' } },
  ]
}

/** Wrap blocks into a one-page model. */
function boardOf(blocks, extra = {}) {
  return {
    title: '测试看板',
    pages: [{ id: 'pg_1', slug: 'page-one', alias: [], blocks, createdAtRev: 'r1', layout: { template: 'flow' } }],
    regions: [],
    edges: [],
    revSeq: 1,
    revHash: 'h',
    rev: 'r1',
    ...extra,
  }
}

test('every block kind renders as something, and the set is the schema set', () => {
  const kinds = new Set(everyKind().map((block) => block.kind))
  // The schema is the authority on what can exist. A kind added there and forgotten here would
  // export as nothing at all — the one failure this table exists to prevent.
  const schema = readFileSync(SCHEMA_PATH, 'utf8')
  const declared = schema.match(/export const BLOCK_KINDS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1]
  const known = new Set([...declared.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]))
  assert.deepEqual([...kinds].sort(), [...known].sort(), 'the export covers exactly the declared block kinds')
})

test('each kind produces the Markdown a reader would expect', () => {
  const md = client.blockToMarkdown
  assert.equal(md({ kind: 'heading', level: 3, text: '小标题' }), '### 小标题')
  assert.equal(md({ kind: 'prose', markdown: '一段话' }), '一段话')
  assert.equal(md({ kind: 'list', ordered: false, items: [{ id: 'a', text: '甲', depth: 0 }] }), '- 甲')
  assert.equal(md({ kind: 'list', ordered: true, items: [{ id: 'a', text: '甲', depth: 0 }] }), '1. 甲')
  assert.equal(
    md({ kind: 'list', ordered: false, items: [{ id: 'a', text: '甲', depth: 1 }] }),
    '  - 甲',
    'a nested item keeps its depth as indentation',
  )
  assert.equal(md({ kind: 'code', lang: 'js', code: 'x', filename: 'a.js' }), '**a.js**\n\n```js\nx\n```')
  assert.equal(
    md({ kind: 'uml', engine: 'mermaid', source: 'flowchart LR' }),
    '```mermaid\nflowchart LR\n```',
    'the diagram round-trips as source, which is what the board itself stores',
  )
  assert.equal(
    md({ kind: 'uml', engine: 'plantuml', source: '@startuml' }),
    '```plantuml\n@startuml\n```',
    'the fence follows the engine, not a hard-coded language',
  )
  assert.equal(md({ kind: 'image', src: '/a.png', alt: '图' }), '![图](/a.png)')
  assert.equal(
    md({ kind: 'pdf-page', src: '/a.pdf', page: 3 }),
    '> PDF · `/a.pdf` 第 3 页',
    'a page reference is not an image URL, so it must not be written as one',
  )
})

test('a group renders its children once, and a nested block is never printed twice', () => {
  const model = boardOf([
    { id: 'bl_g', slug: 'grp', alias: [], createdAtRev: 'r1', kind: 'group', title: '组', children: ['bl_h', 'bl_p'] },
    { id: 'bl_h', slug: 'h', alias: [], createdAtRev: 'r1', kind: 'heading', level: 2, text: '组内标题' },
    { id: 'bl_p', slug: 'p', alias: [], createdAtRev: 'r1', kind: 'prose', markdown: '组内正文' },
  ])
  const output = client.exportMarkdown(model)
  assert.match(output, /### 组/)
  assert.equal(output.split('组内标题').length - 1, 1, 'the heading appears exactly once')
  assert.equal(output.split('组内正文').length - 1, 1, 'the prose appears exactly once')
})

test('the document is titled, paged and ordered as the board is', () => {
  const model = {
    title: '选一台 14 寸笔记本',
    pages: [
      { id: 'pg_a', slug: '选型', blocks: [{ id: 'a', slug: 'x', alias: [], createdAtRev: 'r', kind: 'prose', markdown: '甲' }] },
      { id: 'pg_b', slug: '下单前', blocks: [{ id: 'b', slug: 'y', alias: [], createdAtRev: 'r', kind: 'prose', markdown: '乙' }] },
    ],
    regions: [],
    edges: [],
  }
  const output = client.exportMarkdown(model)
  assert.equal(output, '# 选一台 14 寸笔记本\n\n## 选型\n\n甲\n\n## 下单前\n\n乙\n')
})

test('edges are listed by slug, with their relation and label when present', () => {
  const model = boardOf(
    [
      { id: 'bl_a', slug: 'from-here', alias: [], createdAtRev: 'r', kind: 'prose', markdown: 'A' },
      { id: 'bl_b', slug: 'to-there', alias: [], createdAtRev: 'r', kind: 'prose', markdown: 'B' },
    ],
    {
      edges: [
        { id: 'e1', slug: 'e1', alias: [], from: { blockId: 'bl_a' }, to: { blockId: 'bl_b' }, rel: 'next', label: '然后' },
        { id: 'e2', slug: 'e2', alias: [], from: { blockId: 'bl_a' }, to: { blockId: 'bl_b' } },
      ],
    },
  )
  const output = client.exportMarkdown(model)
  assert.match(output, /## 关系/)
  assert.match(output, /- from-here → to-there — next（然后）/)
  assert.match(output, /- from-here → to-there\n/, 'an edge with neither rel nor label stays bare')
})

test('a board with no edges does not grow an empty relations section', () => {
  const output = client.exportMarkdown(boardOf([{ id: 'a', slug: 'x', alias: [], createdAtRev: 'r', kind: 'prose', markdown: 'A' }]))
  assert.doesNotMatch(output, /## 关系/)
})

test('an empty or malformed model exports an empty string rather than throwing', () => {
  assert.equal(client.exportMarkdown(null), '')
  assert.equal(client.exportMarkdown(undefined), '')
  assert.equal(client.exportMarkdown({}), '# Board\n')
})

test('the filename stem is safe and never empty', () => {
  assert.equal(client.exportStem({ title: '选一台 14 寸笔记本' }), '选一台-14-寸笔记本')
  assert.equal(client.exportStem({ title: 'a/b:c*d?e"f<g>h|i' }), 'abcdefghi')
  assert.equal(client.exportStem({ title: '   ' }), 'board')
  assert.equal(client.exportStem(undefined), 'board')
  assert.ok(client.exportStem({ title: 'x'.repeat(200) }).length <= 60, 'a long title is truncated')
})

test('a page serialises into one standalone SVG that carries the stylesheet', () => {
  const svg = client.pageToSvg('<div class="sb-card">x</div>', 900, 400)
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="900" height="400"/)
  assert.match(svg, /<foreignObject[^>]*width="900" height="400"/)
  assert.match(svg, /sb-card/, 'the page body is inside the foreignObject')
  assert.match(svg, /--dsw-alias-bg-layer-0:/, 'the token values the stylesheet needs travel with it')
  assert.match(svg, /\.sb-canvas\{overflow:visible/, 'the canvas sizes to content in the export')
})

test('pages stack without re-laying-out, and the total height covers every page', () => {
  const a = client.pageToSvg('<div>a</div>', 800, 300)
  const b = client.pageToSvg('<div>b</div>', 800, 500)
  const stitched = client.stitchPages([
    { svg: a, width: 800, height: 300 },
    { svg: b, width: 800, height: 500 },
  ])
  // 24 before the first, 24 between, 24 after the last.
  assert.match(stitched, /height="872"/)
  assert.match(stitched, /<g transform="translate\(0,24\)">/)
  assert.match(stitched, /<g transform="translate\(0,348\)">/)
  assert.match(stitched, /<div>a<\/div>/, 'each page keeps its own body')
  assert.match(stitched, /<div>b<\/div>/)
})
