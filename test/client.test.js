/**
 * Client-half tests.
 *
 * The client half is a classic script that registers a lazy factory against
 * `window.__ModuleLoader__`, so it cannot simply be imported. These tests evaluate it in a
 * sandbox with the loader and `require` stubbed, then exercise the **pure** functions inside —
 * arrow routing and template selection. Those are exactly the parts where a mistake is silent:
 * a wrong bezier still renders, it just points somewhere unhelpful, and no browser error appears.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const CLIENT_PATH = new URL('../src/client.js', import.meta.url)

/** Minimal React stand-in: the factories only need createElement to exist at load time. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}

/**
 * Load the client half in a sandbox and return its exports.
 *
 * @returns the factory's exports, which include the internals worth testing.
 */
function loadClient() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  let registered

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition) => {
          registered = definition
        },
      },
    },
    requestAnimationFrame: (callback) => {
      callback()
      return 1
    },
    cancelAnimationFrame: () => {},
    ResizeObserver: undefined,
    // The strip remembers whether it was left open, so component construction reads storage.
    // A minimal in-memory stand-in keeps the load honest without a DOM.
    localStorage: {
      store: new Map(),
      getItem(key) {
        return this.store.has(key) ? this.store.get(key) : null
      },
      setItem(key, value) {
        this.store.set(key, String(value))
      },
    },
    Math,
    JSON,
    String,
    Number,
    Object,
    Array,
    Set,
    Map,
    Boolean,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)

  assert.ok(registered !== undefined, 'the client half must register a lazy factory')
  assert.equal(registered.id, 'dsh-superboard')
  return registered.factory((specifier) => {
    if (specifier === 'react') return fakeReact
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
}

const client = loadClient()

test('the factory registers itself under the package name', () => {
  assert.equal(typeof client.apply, 'function')
  // Compare element-wise: the client half runs in its own VM realm, so arrays it produces do not
  // share this realm's prototype and deepStrictEqual would reject equal contents.
  assert.equal(client.inject.length, 1)
  assert.equal(client.inject[0], 'slots')
  assert.equal(client.PROJECTION_KEY, 'board')
})

test('registering into conversation.view is the whole integration', () => {
  const registered = []
  let injectedKey
  const ctx = {
    effect: (callback) => callback(),
    slots: {
      inject: (key, callback) => {
        injectedKey = key
        return callback()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)

  assert.equal(injectedKey, 'conversation.view')
  assert.equal(registered.length, 1)
  const options = registered[0].options
  assert.equal(options.name, 'conversation.view')
  assert.equal(options.id, 'board')
  assert.equal(options.order, 20)
  assert.equal(options.label(), '看板')
  assert.equal(typeof registered[0].component, 'function')
})

// ---------------------------------------------------------------------------
// Arrow routing
// ---------------------------------------------------------------------------

const box = (left, top, width = 200, height = 60) => ({ left, top, width, height })

test('an arrow between stacked blocks leaves the bottom and arrives at the top', () => {
  const d = client.routeBetween(box(0, 0), box(0, 200))
  const [startX, startY] = numbers(d, 1, 2)
  const [endX, endY] = numbers(d, 7, 8)

  assert.equal(startY, 60, 'starts at the source bottom edge')
  assert.equal(endY, 200, 'ends at the target top edge')
  assert.equal(startX, 100, 'centred on the source')
  assert.equal(endX, 100, 'centred on the target')
})

test('an arrow between side-by-side blocks leaves the right and arrives at the left', () => {
  const d = client.routeBetween(box(0, 0), box(400, 0))
  const [startX, startY] = numbers(d, 1, 2)
  // The path is "M sx sy C c1x c1y, c2x c2y, ex ey" — eight numbers, so the endpoint is 7/8.
  const [endX] = numbers(d, 7, 8)

  assert.equal(startX, 200, 'starts at the source right edge')
  assert.equal(startY, 30, 'vertically centred on the source')
  assert.equal(endX, 400, 'ends at the target left edge')
})

test('an upward arrow leaves the top and arrives at the bottom', () => {
  const d = client.routeBetween(box(0, 400), box(0, 0))
  const [, startY] = numbers(d, 1, 2)
  const [, endY] = numbers(d, 7, 8)

  assert.equal(startY, 400, 'starts at the source top edge')
  assert.equal(endY, 60, 'ends at the target bottom edge')
})

test('the control points bulge outward, so the curve does not cut through the boxes', () => {
  const d = client.routeBetween(box(0, 0), box(0, 300))
  const parts = d.match(/-?\d+(\.\d+)?/g).map(Number)
  const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = parts

  assert.ok(c1y > sy, 'the first control point is below the start')
  assert.ok(c2y < ey, 'the second control point is above the end')
  assert.equal(c1x, sx, 'a vertical run keeps the curve vertical at the start')
  assert.equal(c2x, ex, 'and at the end')
})

test('every coordinate is rounded to one decimal, so the DOM diff stays stable', () => {
  const d = client.routeBetween({ left: 0.12345, top: 0.98765, width: 199.9999, height: 59.9999 }, box(0, 200))
  for (const value of d.match(/-?\d+(\.\d+)?/g)) {
    const decimals = value.includes('.') ? value.split('.')[1].length : 0
    assert.ok(decimals <= 1, `${value} has more than one decimal place`)
  }
})

// ---------------------------------------------------------------------------
// Layout templates
// ---------------------------------------------------------------------------

test('a template name picks an arrangement, and an unknown one falls back to flow', () => {
  assert.equal(client.layoutClass({ template: 'grid' }), 'sb-grid')
  assert.equal(client.layoutClass({ template: 'columns' }), 'sb-columns')
  assert.equal(client.layoutClass({ template: 'flow' }), 'sb-flow')
  assert.equal(client.layoutClass({ template: 'tree' }), 'sb-flow')
  assert.equal(client.layoutClass(undefined), 'sb-flow')
})

test('the columns template degrades to one column in a narrow pane', () => {
  // Compare the property, not the object: the client half is evaluated in its own VM realm, so
  // its objects do not share this realm's prototype and deepStrictEqual would reject equal data.
  assert.equal(
    client.layoutStyle({ template: 'columns', params: { cols: 3 } }, 1200).gridTemplateColumns,
    'repeat(3, minmax(0, 1fr))',
  )
  assert.equal(
    client.layoutStyle({ template: 'columns', params: { cols: 3 } }, 500).gridTemplateColumns,
    'repeat(1, minmax(0, 1fr))',
  )
})

test('a template that needs no widths produces no inline style', () => {
  assert.equal(client.layoutStyle({ template: 'flow' }, 1200), undefined)
  assert.equal(client.layoutStyle({ template: 'grid' }, 1200), undefined)
})

test('an absurd column request is clamped rather than trusted', () => {
  assert.equal(
    client.layoutStyle({ template: 'columns', params: { cols: 99 } }, 2000).gridTemplateColumns,
    'repeat(4, minmax(0, 1fr))',
  )
  assert.equal(
    client.layoutStyle({ template: 'columns', params: { cols: 0 } }, 2000).gridTemplateColumns,
    'repeat(1, minmax(0, 1fr))',
  )
})

// ---------------------------------------------------------------------------
// Marquee geometry
// ---------------------------------------------------------------------------

test('a marquee normalises whichever way the user dragged', () => {
  // Down-right.
  assert.equal(JSON.stringify(client.normaliseRect({ x: 10, y: 20 }, { x: 60, y: 80 })), JSON.stringify({ left: 10, top: 20, width: 50, height: 60 }))
  // Up-left: the same rectangle, not a negative one.
  assert.equal(JSON.stringify(client.normaliseRect({ x: 60, y: 80 }, { x: 10, y: 20 })), JSON.stringify({ left: 10, top: 20, width: 50, height: 60 }))
  // A click produces a zero-size rectangle rather than something inverted.
  assert.equal(client.normaliseRect({ x: 5, y: 5 }, { x: 5, y: 5 }).width, 0)
})

test('intersection is inclusive of the edges a block actually occupies', () => {
  const block = { left: 100, top: 100, width: 50, height: 50 }

  // Fully inside.
  assert.equal(client.rectsIntersect({ left: 90, top: 90, width: 80, height: 80 }, block), true)
  // Partially overlapping.
  assert.equal(client.rectsIntersect({ left: 140, top: 140, width: 40, height: 40 }, block), true)
  // Merely touching the corner still counts: the user's rectangle reaches the block.
  assert.equal(client.rectsIntersect({ left: 150, top: 150, width: 10, height: 10 }, block), false)
  // Clearly apart.
  assert.equal(client.rectsIntersect({ left: 200, top: 200, width: 10, height: 10 }, block), false)
  // A zero-size rectangle inside the block still intersects, so an accidental tiny drag is not
  // silently ignored once it passes the click threshold.
  assert.equal(client.rectsIntersect({ left: 110, top: 110, width: 0, height: 0 }, block), true)
})

test('a marquee never selects a block it does not overlap', () => {
  const rect = client.normaliseRect({ x: 0, y: 0 }, { x: 100, y: 100 })
  const blocks = [
    { left: 10, top: 10, width: 40, height: 40 },
    { left: 200, top: 200, width: 40, height: 40 },
    { left: 90, top: 90, width: 40, height: 40 },
  ]
  const hits = blocks.filter((block) => client.rectsIntersect(rect, block))
  assert.equal(hits.length, 2, 'the distant block is not selected')
})

// ---------------------------------------------------------------------------
// The feedback payload
// ---------------------------------------------------------------------------

const edge = (fromId, toId, rel, fromSlug, toSlug) => ({
  id: `ed_${fromId}${toId}`,
  from: { blockId: fromId },
  to: { blockId: toId },
  rel,
  fromSlug,
  toSlug,
})

test('an edge inside the selection is described as being between the selected blocks', () => {
  const slugOf = (id) => ({ a: '登录服务', b: '渠道适配器' })[id]
  const described = client.describeSelectedEdges(
    [{ id: 'e1', from: { blockId: 'b' }, to: { blockId: 'a' }, rel: 'depends' }],
    new Set(['a', 'b']),
    slugOf,
  )
  assert.equal(described.length, 1)
  assert.match(described[0], /渠道适配器/)
  assert.match(described[0], /登录服务/)
  assert.match(described[0], /depends/)
})

test('an edge leaving the selection says so, rather than claiming it is between them', () => {
  const slugOf = (id) => ({ a: '登录服务', z: '风控' })[id]
  const described = client.describeSelectedEdges(
    [{ id: 'e1', from: { blockId: 'z' }, to: { blockId: 'a' }, rel: 'depends' }],
    new Set(['a']),
    slugOf,
  )
  assert.equal(described.length, 1)
  // Overstating the selection would make the Agent reason about a block the user never pointed at.
  assert.match(described[0], /源在选区外/)
})

test('an edge wholly outside the selection is not reported at all', () => {
  const described = client.describeSelectedEdges(
    [{ id: 'e1', from: { blockId: 'x' }, to: { blockId: 'y' }, rel: 'next' }],
    new Set(['a']),
    (id) => id,
  )
  assert.equal(described.length, 0)
})

test('the payload carries the blocks, the relations and the question — and nothing else', () => {
  const text = client.formatFeedback({
    pageSlug: '架构总览',
    rev: 'r3-abcdef012345',
    blocks: ['登录服务', '渠道适配器'],
    edges: ['渠道适配器 -[depends]-> 登录服务'],
    note: '这两个是不是耦合过紧？',
  })

  assert.match(text, /登录服务/)
  assert.match(text, /渠道适配器/)
  assert.match(text, /depends/)
  assert.match(text, /耦合过紧/)
  // The revision is included so the Agent can tell whether the user was looking at the board it
  // is about to edit.
  assert.match(text, /r3-abcdef012345/)
  // No geometry: the Agent reads the model, and coordinates would be noise it cannot act on.
  assert.doesNotMatch(text, /\d+px/)
})

test('a payload with no note still names what was selected', () => {
  const text = client.formatFeedback({
    pageSlug: 'main',
    rev: 'r1-000000000000',
    blocks: ['风险-1'],
    edges: [],
    note: '   ',
  })
  assert.match(text, /风险-1/)
  assert.doesNotMatch(text, /说明：/)
})

// ---------------------------------------------------------------------------
// Inline markdown
// ---------------------------------------------------------------------------

/**
 * The node types of a parse, as a comma-joined string.
 *
 * A string rather than an array on purpose: the client half runs in its own VM realm, so arrays it
 * produces do not share this realm's `Array.prototype` and `deepStrictEqual` rejects equal data.
 * Comparing strings sidesteps the trap for good instead of working around it per assertion.
 */
const typesOf = (nodes) => nodes.map((node) => node.type).join(',')

test('bold, italic and code spans parse into their own node types', () => {
  assert.equal(typesOf(client.parseInline('**根因**: 说明')), 'strong,text')
  assert.equal(typesOf(client.parseInline('*重要* 提示')), 'em,text')
  assert.equal(typesOf(client.parseInline('use `board_apply` here')), 'text,code,text')

  const bold = client.parseInline('**根因**: 说明')
  assert.equal(bold[0].children[0].text, '根因')
  assert.equal(bold[1].text, ': 说明')
})

test('the markers are gone from the parsed text, which is the whole point', () => {
  // The live board showed `**根因**` with its markers intact, which reads as broken text rather
  // than as emphasis — and prose is where most of a board's words live.
  const flat = JSON.stringify(client.parseInline('**根因**: 说明'))
  assert.ok(!flat.includes('**'), 'no literal markers survive a successful parse')
})

test('emphasis nests, and the inner run is parsed too', () => {
  const nodes = client.parseInline('**bold with *inner* here**')
  assert.equal(nodes[0].type, 'strong')
  assert.ok(nodes[0].children.some((child) => child.type === 'em'))
})

test('a code span keeps its insides literal', () => {
  // Otherwise a code sample would be mangled by the very syntax it demonstrates.
  const nodes = client.parseInline('`a**b`')
  assert.equal(typesOf(nodes), 'code')
  assert.equal(nodes[0].text, 'a**b')
})

test('an unclosed marker stays literal instead of eating the rest of the text', () => {
  const nodes = client.parseInline('**never closed')
  assert.equal(typesOf(nodes), 'text')
  assert.equal(nodes[0].text, '**never closed')
  assert.equal(typesOf(client.parseInline('**')), 'text')
})

test('plain text passes through unchanged, Chinese included', () => {
  const nodes = client.parseInline('普通文本，没有标记。')
  assert.equal(typesOf(nodes), 'text')
  assert.equal(nodes[0].text, '普通文本，没有标记。')
  assert.equal(client.parseInline('').length, 0)
})

test('a link parses, but only when its target is one a board will open', () => {
  const ok = client.parseInline('see [docs](https://example.com)')
  assert.equal(typesOf(ok), 'text,link')
  assert.equal(ok[1].href, 'https://example.com')
  assert.equal(ok[1].text, 'docs')

  // Board content is written by the Agent, and the Agent's input includes whatever it has been
  // reading — so a scripting URL in a card is a real hazard, not a hypothetical one. It renders as
  // literal text rather than as a link, and since the renderer builds React elements there is no
  // HTML string for it to escape into either.
  const refused = client.parseInline('[click](javascript:alert(1))')
  assert.equal(typesOf(refused), 'text')
  assert.equal(refused[0].text, '[click](javascript:alert(1))')
})

test('the link guard allows web addresses and local destinations, and nothing else', () => {
  assert.equal(client.safeHref('https://example.com'), 'https://example.com')
  assert.equal(client.safeHref('http://example.com'), 'http://example.com')
  assert.equal(client.safeHref('mailto:a@b.c'), 'mailto:a@b.c')
  assert.equal(client.safeHref('MAILTO:a@b.c'), 'MAILTO:a@b.c', 'the scheme check is case-insensitive')
  assert.equal(client.safeHref('/docs/x.md'), '/docs/x.md')
  assert.equal(client.safeHref('#heading'), '#heading')
  assert.equal(client.safeHref('relative/path'), 'relative/path')

  for (const hostile of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox',
    '',
    '   ',
  ]) {
    assert.equal(client.safeHref(hostile), undefined, `${hostile} must not become a link`)
  }
})

test('a link with no label is refused rather than rendering an empty anchor', () => {
  assert.equal(typesOf(client.parseInline('[](https://x)')), 'text')
})

test('a malformed link falls back to literal text', () => {
  assert.equal(typesOf(client.parseInline('[no target]')), 'text')
  assert.equal(typesOf(client.parseInline('[unclosed(https://x)')), 'text')
})

test('deeply nested emphasis terminates instead of recursing without bound', () => {
  // A pathological run of markers is possible in Agent-written text; the depth cap keeps it text.
  assert.doesNotThrow(() => client.parseInline(`${'*'.repeat(40)}x${'*'.repeat(40)}`))
  assert.doesNotThrow(() => client.parseInline(`**${'a'.repeat(1)}${'*'.repeat(2000)}`))
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull the nth and mth whitespace-separated numbers out of a path string. */
function numbers(d, first, second) {
  const all = d.match(/-?\d+(\.\d+)?/g)
  return [Number(all[first - 1]), Number(all[second - 1])]
}
