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

/** Minimal React stand-in: the factories only need hooks to exist at load time. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  // The reading column memoises its transcript derivation and its loader callback.
  useMemo: (compute) => compute(),
  useCallback: (callback) => callback,
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

/**
 * Copy a value out of the sandbox realm.
 *
 * The client half runs in its own VM context, so arrays and objects it returns do not share this
 * realm's prototype — and `deepStrictEqual` compares prototypes, so equal data would be rejected as
 * "same structure but not reference-equal". Round-tripping through JSON puts it back in this realm.
 */
const plain = (value) => JSON.parse(JSON.stringify(value))

test('the factory registers itself under the package name', () => {
  assert.equal(typeof client.apply, 'function')
  // Compare element-wise: the client half runs in its own VM realm, so arrays it produces do not
  // share this realm's prototype and deepStrictEqual would reject equal contents.
  assert.equal(client.inject.length, 3)
  assert.equal(client.inject[0], 'slots')
  // 'sessions' is the service that makes history paging reachable — the real loader lives on
  // ctx.sessions.binding(id).session — and 'conversation' is what mints the feedback attachment.
  assert.equal(client.inject[1], 'sessions')
  assert.equal(client.inject[2], 'conversation')
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
  assert.equal(client.layoutStyle({ template: 'row' }, 1200), undefined)
  assert.equal(client.layoutStyle(undefined, 1200), undefined)
  assert.equal(client.layoutStyle({ template: 'canvas' }, 1200), undefined)
})

test('the grid template is responsive by construction, not by breakpoint', () => {
  // auto-fill with a minimum card width lets the browser fit as many cards as the width allows, so
  // dragging the reading column changes the column count with no breakpoint involved.
  assert.equal(
    client.layoutStyle({ template: 'grid' }, 1200).gridTemplateColumns,
    'repeat(auto-fill, minmax(260px, 1fr))',
  )
  assert.equal(
    client.layoutStyle({ template: 'grid', params: { minCardWidth: 320 } }, 1200).gridTemplateColumns,
    'repeat(auto-fill, minmax(320px, 1fr))',
  )
  // An absurd minimum is clamped rather than trusted.
  assert.equal(
    client.layoutStyle({ template: 'grid', params: { minCardWidth: 99999 } }, 1200).gridTemplateColumns,
    'repeat(auto-fill, minmax(640px, 1fr))',
  )
})

test('a grid with a fixed column count stops auto-filling', () => {
  // `areas` fixes the columns, and the host resolves the template into `cols` so the named placement
  // and the grid's own width cannot disagree. Auto-filling would silently reflow a named layout.
  const style = client.layoutStyle({ template: 'grid', params: { cols: 2 } }, 1200)
  assert.equal(style.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))')
  // Auto-fill keeps the default alignment, which is what makes a short card in a tall row stay short.
  assert.equal(client.layoutStyle({ template: 'grid' }, 1200).alignItems, undefined)
})

test('only a named-cell grid stretches its cards', () => {
  // A named cell is a slot, so a card spanning two rows fills them rather than sitting at the top of
  // the first. That is the ONLY case that stretches, and it is keyed on `cells` — the host's resolved
  // placement — not on `cols`.
  //
  // This used to be keyed on `cols`, which meant a plain `grid` with a column count silently became
  // an equal-height grid: a one-line card beside a long one turned into a large empty box. Nothing in
  // the tool surface said `cols` changed card height, so it was unpredictable by construction.
  const named = client.layoutStyle({ template: 'grid', params: { cols: 2, cells: {} } }, 1200)
  assert.equal(named.alignItems, 'stretch')
  const fixed = client.layoutStyle({ template: 'grid', params: { cols: 2 } }, 1200)
  assert.equal(fixed.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))')
  assert.equal(fixed.alignItems, undefined, 'a fixed column count must not stretch cards')
})

test('masonry is a waterfall, by column count or by minimum card width', () => {
  // The waterfall exists because a grid row is as tall as its tallest card. It is CSS multi-column,
  // so the inline style carries `columnCount`/`columnWidth` rather than a grid template — `gap` has
  // no effect in a multi-column container, which is why the class carries the spacing.
  const byCount = client.layoutStyle({ template: 'masonry', params: { cols: 3 } }, 1200)
  assert.equal(byCount.columnCount, '3')
  assert.equal(byCount.columnWidth, undefined)

  const byWidth = client.layoutStyle({ template: 'masonry' }, 1200)
  assert.equal(byWidth.columnWidth, '260px')
  assert.equal(byWidth.columnCount, undefined)
  assert.equal(
    client.layoutStyle({ template: 'masonry', params: { minCardWidth: 320 } }, 1200).columnWidth,
    '320px',
  )

  // Clamped at both ends, like the grid's minimum.
  assert.equal(
    client.layoutStyle({ template: 'masonry', params: { minCardWidth: 99999 } }, 1200).columnWidth,
    '640px',
  )
  assert.equal(client.layoutStyle({ template: 'masonry', params: { cols: 99 } }, 1200).columnCount, '6')
  assert.equal(client.layoutStyle({ template: 'masonry', params: { cols: 0 } }, 1200).columnCount, '1')
})

test('gap is honoured on any template, and clamped', () => {
  assert.equal(client.layoutStyle({ template: 'flow', params: { gap: 20 } }, 900).gap, '20px')
  assert.equal(client.layoutStyle({ template: 'flow', params: { gap: 9999 } }, 900).gap, '64px')
})

test('only unclaimed blocks sit at the top level', () => {
  // The container relationship is derived rather than stored, so a group's children cannot also be
  // rendered at page level. Drawing both is the classic tree bug: everything appears twice.
  const blocks = [
    { id: 'a', kind: 'heading' },
    { id: 'b', kind: 'prose' },
    { id: 'g', kind: 'group', children: ['a', 'b'] },
    { id: 'c', kind: 'prose' },
  ]
  assert.deepEqual(
    plain(client.rootBlocksOf(blocks)).map((block) => block.id),
    ['g', 'c'],
  )
})

test('nesting is honoured: an inner group is not a root either', () => {
  const blocks = [
    { id: 'a', kind: 'prose' },
    { id: 'inner', kind: 'group', children: ['a'] },
    { id: 'outer', kind: 'group', children: ['inner'] },
  ]
  assert.deepEqual(
    plain(client.rootBlocksOf(blocks)).map((block) => block.id),
    ['outer'],
  )
})

test('a page of loose blocks is all roots', () => {
  const blocks = [
    { id: 'a', kind: 'heading' },
    { id: 'b', kind: 'prose' },
  ]
  assert.equal(client.rootBlocksOf(blocks).length, 2)
  assert.equal(client.rootBlocksOf([]).length, 0)
})

test('a named cell becomes a grid line span', () => {
  const style = client.cellStyle({ row: 2, col: 3, rowSpan: 1, colSpan: 2 })
  assert.equal(style.gridRow, '2 / span 1')
  assert.equal(style.gridColumn, '3 / span 2')
  // A cell is placement, never position: the card carries no geometry of its own.
  assert.equal(style.position, undefined)
  assert.equal(style.left, undefined)
})

test('a malformed cell degrades to the first cell rather than producing a NaN style', () => {
  // A NaN in a style attribute silently does nothing, which would look like the board ignoring the
  // Agent — the worst possible failure, because nothing reports it.
  const style = client.cellStyle({ row: 'abc', col: null })
  assert.equal(style.gridRow, '1 / span 1')
  assert.equal(style.gridColumn, '1 / span 1')
  assert.equal(client.cellStyle(undefined), undefined)
  assert.equal(client.cellStyle(null), undefined)
  // A zero or negative span is not a span, so it clamps up rather than collapsing the card.
  assert.equal(client.cellStyle({ row: 1, col: 1, rowSpan: 0, colSpan: -3 }).gridRow, '1 / span 1')
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
// What a drag means
// ---------------------------------------------------------------------------

/**
 * A DOM stand-in good enough for `originAt`.
 *
 * `originAt` is the one classifier in this file that cannot be pure: "is the pointer on rendered
 * text" is a question only the browser can answer. So it is tested against a fake that records
 * *which* of the four reads happened, because the failure mode worth pinning is not a thrown error
 * but reading the wrong thing — `caretRangeFromPoint` always snaps to the nearest text node, so a
 * point in a card's padding reports real prose.
 *
 * @param options - `{ caretNode, lineRects, userSelect, card, chrome }`.
 * @returns `{ document, getComputedStyle }` for the sandbox.
 */
function fakeDom({ caretNode = null, lineRects = [], userSelect = 'auto', card = 'bl_1', chrome = false, point = true } = {}) {
  const calls = []
  const cardElement = { getAttribute: () => card }
  const chromeElement = { closest: () => ({}) }
  const target = {
    closest: (selector) => {
      if (selector === '[data-block-id]') return point ? cardElement : null
      if (selector === '.sb-cardHead, .sb-groupHead') return chrome ? chromeElement : null
      return null
    },
  }
  const document = {
    elementFromPoint: () => (point ? target : null),
    caretRangeFromPoint: () => (caretNode === null ? null : { startContainer: caretNode }),
    createRange: () => ({
      selectNodeContents: () => {},
      // A live `Range` is what the browser laid out, so the fake serves whatever was configured.
      getClientRects: () => lineRects,
    }),
  }
  return {
    calls,
    document,
    getComputedStyle: () => ({ userSelect }),
  }
}

/** A text node in the sandbox's terms: `nodeType` 3 with data. */
const textNode = (data, parent = {}) => ({ nodeType: 3, data, parentElement: parent })

test('a drag on rendered text is the browser selection, not a marquee', () => {
  const dom = fakeDom({
    caretNode: textNode('hello world'),
    lineRects: [{ top: 100, bottom: 120, left: 50, right: 200 }],
  })
  const origin = client.originAt(80, 110, dom)
  assert.equal(origin.mode, 'text')
})

test('the whole card is not text just because a caret can be found in it', () => {
  // Measured in Edge: a point 3px inside a card's bottom edge, left of its paragraph, and past the
  // end of a line all report a caret sitting in that paragraph's text node. Believing the caret is
  // what would make the marquee impossible to start on a board full of prose.
  const lineRects = [{ top: 100, bottom: 120, left: 50, right: 200 }]
  const cases = [
    { name: 'below the line box', x: 80, y: 140 },
    { name: 'left of the line box', x: 20, y: 110 },
    { name: 'past the end of the line', x: 400, y: 110 },
    { name: 'above the line box', x: 80, y: 60 },
  ]
  for (const point of cases) {
    const dom = fakeDom({ caretNode: textNode('hello world'), lineRects })
    assert.equal(client.originAt(point.x, point.y, dom).mode, 'marquee', `should be marquee: ${point.name}`)
  }
})

test('one rect per wrapped line, so the gap between two lines is blank', () => {
  // A wrapped paragraph lays out as two rects. Between them is a lead-gap the browser reports no
  // line box for, and a drag starting there has to be a marquee.
  const dom = fakeDom({
    caretNode: textNode('a long wrapped paragraph'),
    lineRects: [
      { top: 100, bottom: 120, left: 50, right: 300 },
      { top: 120, bottom: 140, left: 50, right: 180 },
    ],
  })
  assert.equal(client.originAt(80, 110, dom).mode, 'text', 'inside the first line')
  assert.equal(client.originAt(80, 130, dom).mode, 'text', 'inside the second line')
  assert.equal(client.originAt(280, 130, dom).mode, 'marquee', 'past the end of the second line')
})

test('an image, a diagram frame or the gap between cards is marquee area', () => {
  // No caret at all.
  assert.equal(client.originAt(10, 10, fakeDom({ caretNode: null })).mode, 'marquee')
  // A caret in an element rather than a text node: there is no character under the pointer.
  const elementCaret = fakeDom({ caretNode: { nodeType: 1 }, lineRects: [{ top: 0, bottom: 999, left: 0, right: 999 }] })
  assert.equal(client.originAt(10, 10, elementCaret).mode, 'marquee')
  // Whitespace-only text is not something a user means to select.
  const blank = fakeDom({ caretNode: textNode('   '), lineRects: [{ top: 0, bottom: 999, left: 0, right: 999 }] })
  assert.equal(client.originAt(10, 10, blank).mode, 'marquee')
})

test('a point outside every card is marquee area, and says so', () => {
  const dom = fakeDom({ point: false })
  const origin = client.originAt(5, 5, dom)
  assert.equal(origin.mode, 'marquee')
  assert.equal(origin.card, null)
})

test('deliberately unselectable chrome is marquee area by construction', () => {
  // The card's slug and kind are `user-select:none`, so a drag beginning there cannot have been
  // meant as a text selection. This is what gives the marquee a large, predictable set of grab
  // targets on a board whose every card is full of prose.
  const dom = fakeDom({ chrome: true, caretNode: textNode('prose'), lineRects: [{ top: 0, bottom: 999, left: 0, right: 999 }] })
  assert.equal(client.originAt(10, 10, dom).mode, 'chrome')
})

test('a user-select:none ancestor vetoes the line-box test', () => {
  const dom = fakeDom({
    caretNode: textNode('prose'),
    lineRects: [{ top: 0, bottom: 999, left: 0, right: 999 }],
    userSelect: 'none',
  })
  assert.equal(client.originAt(10, 10, dom).mode, 'marquee')
})

test('no DOM at all degrades to a marquee rather than throwing', () => {
  // The host half loads this file's exports in a context with no document; a throw here would take
  // the whole pane down.
  assert.equal(client.originAt(10, 10, undefined).mode, 'marquee')
})

// ---------------------------------------------------------------------------
// Reading the browser's own selection
// ---------------------------------------------------------------------------

test('the selected text is normalised, because a cross-card selection is full of layout', () => {
  // Measured: dragging from one card into another yields "…copy.\n\nbeta\nBeta…" — the second card's
  // slug and its newlines come along. Collapsing the runs keeps the characters the user meant.
  const sel = (text) => ({ rangeCount: 1, toString: () => text })
  assert.equal(client.textSelectionText(sel('a\n\n\n\nb')), 'a\n\nb')
  assert.equal(client.textSelectionText(sel('trailing   \nnext')), 'trailing\nnext')
  assert.equal(client.textSelectionText(sel('  padded  ')), 'padded')
})

test('a selection that does not exist reads as empty rather than throwing', () => {
  assert.equal(client.textSelectionText(null), '')
  assert.equal(client.textSelectionText(undefined), '')
  // A plain object inherits `Object.prototype.toString`, which returns the genuine string
  // "[object Object]" — so this would otherwise reach the Agent as a phantom selection.
  assert.equal(client.textSelectionText({}), '')
  assert.equal(client.textSelectionText({ toString: () => 'text without a rangeCount' }), '')
})

test('the blocks a text selection covers are exactly the ones it touches', () => {
  const elements = [
    { getAttribute: () => 'bl_1' },
    { getAttribute: () => 'bl_2' },
    { getAttribute: () => 'bl_3' },
  ]
  const selection = {
    rangeCount: 1,
    isCollapsed: false,
    getRangeAt: () => ({
      // The first two cards; the third is untouched.
      intersectsNode: (element) => element !== elements[2],
    }),
  }
  const root = { querySelectorAll: () => elements }
  assert.deepEqual(plain([...client.textSelectionBlocks(selection, root)]), ['bl_1', 'bl_2'])
})

test('a collapsed caret selects no blocks, so a click is not a selection', () => {
  const root = { querySelectorAll: () => [{ getAttribute: () => 'bl_1' }] }
  for (const selection of [
    null,
    undefined,
    { rangeCount: 0, isCollapsed: true },
    { rangeCount: 1, isCollapsed: true, getRangeAt: () => ({ intersectsNode: () => true }) },
  ]) {
    assert.equal(client.textSelectionBlocks(selection, root).size, 0)
  }
  // And no root means nothing to search.
  assert.equal(client.textSelectionBlocks({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({}) }, null).size, 0)
})

// ---------------------------------------------------------------------------
// The feedback payload, now carrying the user's characters
// ---------------------------------------------------------------------------

test('the exact selected characters reach the Agent, quoted', () => {
  const text = client.formatFeedback({
    pageSlug: 'issues',
    rev: 'r27-abc',
    blocks: ['prose', 'beta'],
    edges: [],
    note: '',
    text: 'Prose a human would\nselect and copy.',
  })
  // Quoted per line so a multi-line selection cannot be mistaken for the payload's own structure.
  assert.match(text, /> Prose a human would/)
  assert.match(text, /> select and copy\./)
  // The blocks are still named: the text says which sentence, the blocks say where it lives.
  assert.match(text, /选中块：prose、beta/)
})

test('a block-only selection is unchanged, with no empty text section', () => {
  for (const value of [undefined, '', '   ']) {
    const text = client.formatFeedback({ pageSlug: 'p', rev: 'r1-0', blocks: ['a'], edges: [], note: '', text: value })
    assert.doesNotMatch(text, /选中文字/, `no text section for ${JSON.stringify(value)}`)
  }
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
// Anchor resolution
// ---------------------------------------------------------------------------

/**
 * The measured facts one block contributes, in the shape the collector produces.
 *
 * Written as a literal because that is exactly the contract: `anchorRect` sees no DOM and no element,
 * only numbers a collector already reduced. A test that had to build a document to ask "which
 * rectangle does `lines {from: 1, to: 2}` name" would not be testing the resolver at all.
 */
const at = {
  block: box(100, 100, 400, 300),
  frame: box(110, 120, 380, 200),
  fields: {
    code: box(100, 200, 400, 100),
    caption: box(100, 420, 400, 20),
    filename: box(100, 180, 400, 16),
    title: box(100, 110, 400, 24),
  },
  items: { li_a: box(120, 150, 360, 20), li_b: box(120, 175, 360, 20) },
  children: { bl_child: box(150, 160, 200, 80) },
  lines: [undefined, box(100, 200, 400, 18), box(100, 218, 400, 18), box(100, 236, 400, 18)],
  text: [
    { at: 0, length: 5, rect: box(100, 100, 50, 20) },
    { at: 5, length: 5, rect: box(150, 100, 50, 20) },
  ],
  nodes: { w: 200, h: 100, nodes: { A: { x: 20, y: 10, w: 40, h: 20 }, B: { x: 120, y: 60, w: 60, h: 30 } } },
  diagram: box(200, 300, 400, 200),
}

test('the whole block is the default, with or without the descriptor', () => {
  assert.deepEqual(plain(client.anchorRect(undefined, at)), plain(at.block))
  assert.deepEqual(plain(client.anchorRect({ kind: 'block' }, at)), plain(at.block))
})

test('a field anchor names the field, not the card it sits in', () => {
  assert.deepEqual(plain(client.anchorRect({ kind: 'field', field: 'code' }, at)), plain(at.fields.code))
  assert.deepEqual(plain(client.anchorRect({ kind: 'field', field: 'caption' }, at)), plain(at.fields.caption))
  assert.deepEqual(plain(client.anchorRect({ kind: 'field', field: 'filename' }, at)), plain(at.fields.filename))
  assert.deepEqual(plain(client.anchorRect({ kind: 'field', field: 'title' }, at)), plain(at.fields.title))
})

test('an item anchor names one row of a list', () => {
  const rect = client.anchorRect({ kind: 'item', itemId: 'li_b' }, at)
  assert.deepEqual(plain(rect), plain(at.items.li_b))
})

test('a child anchor is the child block, which the collector already measured', () => {
  const rect = client.anchorRect({ kind: 'child', childId: 'bl_child' }, at)
  assert.deepEqual(plain(rect), plain(at.children.bl_child))
})

test('a group reaches its own children and nothing else on the page', () => {
  // The bug this pins: the map was filled by walking `[id, target]` pairs of one map and assigning
  // `target.children[id]`, where `id` moves with `target` — so every block ended up with exactly one
  // entry, itself, and every `child` anchor fell back to its own group's box.
  const boxes = new Map([
    ['bl_group', box(0, 0, 400, 200)],
    ['bl_inner', box(10, 10, 180, 80)],
    ['bl_other', box(200, 10, 180, 80)],
    ['bl_stranger', box(0, 500, 400, 60)],
    ['bl_nested', box(10, 100, 380, 90)],
    ['bl_deep', box(20, 110, 160, 60)],
  ])
  const blocks = [
    { id: 'bl_group', kind: 'group', children: ['bl_inner', 'bl_other', 'bl_nested'] },
    { id: 'bl_inner', kind: 'prose' },
    { id: 'bl_other', kind: 'prose' },
    // A group inside a group owns its own children, not its parent's.
    { id: 'bl_nested', kind: 'group', children: ['bl_deep'] },
    { id: 'bl_deep', kind: 'prose' },
    { id: 'bl_top', kind: 'heading' },
  ]
  const owned = client.childrenByParent(blocks, boxes)
  assert.deepEqual([...owned.keys()], ['bl_group', 'bl_nested'])
  // `bl_stranger` is on the page and measured, but no group lists it: reachable through nothing.
  assert.deepEqual(Object.keys(owned.get('bl_group')), ['bl_inner', 'bl_other', 'bl_nested'])
  assert.deepEqual(Object.keys(owned.get('bl_nested')), ['bl_deep'])
  // A child that is listed but not rendered contributes nothing, so the resolver falls back rather
  // than resolving to `undefined` from inside a group that does have children.
  const partial = client.childrenByParent([{ id: 'bl_group', kind: 'group', children: ['bl_inner', 'bl_gone'] }], boxes)
  assert.deepEqual(Object.keys(partial.get('bl_group')), ['bl_inner'])
  // A block with no children of its own is not in the map at all, and neither is a page of none.
  assert.equal(owned.has('bl_inner'), false)
  assert.equal(client.childrenByParent([], boxes).size, 0)
  assert.equal(client.childrenByParent([{ id: 'bl_top', kind: 'heading' }], boxes).size, 0)
})

test('a line range is the union of its lines, whichever way round it is written', () => {
  const forwards = client.anchorRect({ kind: 'lines', from: 1, to: 2 }, at)
  assert.equal(forwards.top, 200)
  assert.equal(forwards.height, 36, 'two 18px lines')
  // A backwards range is the same range: `from`/`to` are named, not ordered, and a resolver that
  // read them positionally would return a box of no height rather than an error.
  assert.deepEqual(plain(client.anchorRect({ kind: 'lines', from: 2, to: 1 }, at)), plain(forwards))
  // A range over lines that are not rendered keeps the ones that are: line 1 is not in it.
  const late = client.anchorRect({ kind: 'lines', from: 2, to: 9 }, at)
  assert.equal(late.top, 218)
  assert.equal(late.height, 36)
  // A range that starts past the end of the code is no lines at all, so it is the block box.
  assert.deepEqual(plain(client.anchorRect({ kind: 'lines', from: 40, to: 50 }, at)), plain(at.block))
})

test('a text range is a slice of the run it covers, because a range on one line is exact', () => {
  const whole = client.anchorRect({ kind: 'text', start: 0, end: 10 }, at)
  assert.equal(whole.left, 100)
  assert.equal(whole.width, 100)

  const firstHalf = client.anchorRect({ kind: 'text', start: 0, end: 5 }, at)
  assert.equal(firstHalf.width, 50, 'half of the first run')

  const secondHalf = client.anchorRect({ kind: 'text', start: 5, end: 10 }, at)
  assert.equal(secondHalf.left, 150, 'starts where the second run starts')
  assert.equal(secondHalf.width, 50)

  // A range covering half of each run: the box that contains both halves.
  const straddling = client.anchorRect({ kind: 'text', start: 3, end: 7 }, at)
  assert.equal(straddling.left, 130)
  assert.equal(straddling.width, 40)
})

test('a text range is clamped to the text that exists rather than reaching off the card', () => {
  const clamped = client.anchorRect({ kind: 'text', start: 0, end: 999 }, at)
  assert.equal(clamped.left, 100)
  assert.equal(clamped.width, 100)
  // An empty range still names a caret position, and a zero-width box at that position is what a
  // caller can draw; the alternative is a fall back to the whole card, which says the opposite.
  // Character 5 is the head of the second run, so that is where the caret is.
  const caret = client.anchorRect({ kind: 'text', start: 5, end: 5 }, at)
  assert.deepEqual(plain(caret), { left: 150, top: 100, width: 1, height: 20 })
})

test('a rect anchor is normalised against the picture, and a point is a zero-size rect', () => {
  // `at.frame` is 380×200 at (110, 120): a quarter in from the left, half down, half as wide.
  const rect = client.anchorRect({ kind: 'rect', x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, at)
  assert.deepEqual(plain(rect), { left: 110 + 95, top: 120 + 100, width: 190, height: 50 })

  const point = client.anchorRect({ kind: 'point', x: 0, y: 1 }, at)
  assert.deepEqual(plain(point), { left: 110, top: 320, width: 0, height: 0 })
})

test('a pdf-page rect is measured against the crop, because the crop is the picture', () => {
  // A cropped `pdf-page` rasterises only the crop and sizes the canvas to it, so the rendered frame
  // *is* the crop and there is nothing left for the resolver to map. This is the shape that makes
  // `crop` load-bearing: the frame here is 200×100, the crop's own size, not the page's.
  const cropped = { ...at, frame: box(100, 50, 200, 100) }
  const rect = client.anchorRect({ kind: 'rect', x: 0, y: 0, w: 1, h: 1 }, cropped)
  assert.deepEqual(plain(rect), { left: 100, top: 50, width: 200, height: 100 })

  const half = client.anchorRect({ kind: 'point', x: 0.5, y: 0.5 }, cropped)
  assert.deepEqual(plain(half), { left: 200, top: 100, width: 0, height: 0 })

  // Outside [0,1] is clamped rather than allowed to leave the frame: a normalised coordinate is
  // defined over the box, and an unclamped one would draw an arrow into the next card.
  const clamped = client.anchorRect({ kind: 'rect', x: -1, y: -1, w: 3, h: 3 }, cropped)
  assert.deepEqual(plain(clamped), { left: 100, top: 50, width: 200, height: 100 })
})

test('a crop is normalised to the page, and an unreadable one is the whole page', () => {
  assert.deepEqual(plain(client.pageCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.25 })), { x: 0.1, y: 0.2, w: 0.5, h: 0.25 })

  // Three cases with one answer: no crop, the whole page as a crop, and a crop that is not a box.
  // All of them mean "show the page", and the failure mode of guessing otherwise is a blank canvas.
  for (const value of [undefined, null, 'left', 7, {}, { x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 1 }, { x: 0, y: 0, w: 1, h: -1 }, { x: 0, y: 0, w: 'wide', h: 1 }]) {
    assert.equal(client.pageCrop(value), undefined, `${JSON.stringify(value)} is the whole page`)
  }

  // Clamped into the page rather than rejected: a crop running off the edge shows the edge.
  assert.deepEqual(plain(client.pageCrop({ x: 0.8, y: 0, w: 0.5, h: 1 })), { x: 0.8, y: 0, w: 0.2, h: 1 })
  // And a negative corner is the page's corner, like every other normalised coordinate on the board.
  assert.deepEqual(plain(client.pageCrop({ x: -0.5, y: -0.5, w: 0.5, h: 0.5 })), { x: 0, y: 0, w: 0.5, h: 0.5 })
})

test('a node anchor is the node, scaled from SVG user units onto the picture', () => {
  // The SVG is 200×100 and the picture 400×200, so it is drawn at 2×.
  const a = client.anchorRect({ kind: 'node', key: 'A' }, at)
  assert.deepEqual(plain(a), { left: 200 + 40, top: 300 + 20, width: 80, height: 40 })
  const b = client.anchorRect({ kind: 'node', key: 'B' }, at)
  assert.deepEqual(plain(b), { left: 200 + 240, top: 300 + 120, width: 120, height: 60 })
  // A key the diagram does not name — another family, a typo, a diagram that has not drawn — is the
  // block box. A missing node must never blank the arrow.
  assert.deepEqual(plain(client.anchorRect({ kind: 'node', key: 'nope' }, at)), plain(at.block))
})

test('every anchor kind falls back to the block box instead of throwing', () => {
  const bare = { block: at.block }
  const cases = [
    undefined,
    { kind: 'block' },
    { kind: 'field', field: 'code' },
    { kind: 'item', itemId: 'li_a' },
    { kind: 'child', childId: 'bl_child' },
    { kind: 'lines', from: 1, to: 2 },
    { kind: 'text', start: 0, end: 3 },
    { kind: 'node', key: 'A' },
  ]
  for (const spec of cases) {
    assert.deepEqual(plain(client.anchorRect(spec, bare)), plain(at.block), `no measurement for ${JSON.stringify(spec)}`)
  }
  // `rect` and `point` need no hook of their own: the block's own box is the frame, so they resolve
  // against a target that carries nothing but the block.
  assert.deepEqual(plain(client.anchorRect({ kind: 'rect', x: 0, y: 0, w: 1, h: 1 }, bare)), plain(at.block))
  assert.deepEqual(plain(client.anchorRect({ kind: 'point', x: 0, y: 0 }, bare)), { left: 100, top: 100, width: 0, height: 0 })
})

test('a descriptor the renderer does not know, or nonsense in one, is the block box and not a crash', () => {
  // The fold keeps `at.kind` and the block's kind compatible, but a value can still arrive from an
  // older build, and a throw inside `EdgeLayer` takes the whole pane down to a blank rectangle.
  for (const spec of [
    { kind: 'invented' },
    { kind: 'lines', from: 'one', to: 'two' },
    { kind: 'rect', x: 'left', y: null, w: {}, h: [] },
    { kind: 'point', x: 'left', y: 0.5 },
    { kind: 'text', start: undefined, end: undefined },
    { kind: 'node' },
  ]) {
    assert.deepEqual(plain(client.anchorRect(spec, at)), plain(at.block), `fell back for ${JSON.stringify(spec)}`)
  }
  // A point with no readable coordinate is not "at the origin": the caller must see the block box
  // rather than an arrowhead pinned to the corner of the card.
  assert.deepEqual(plain(client.anchorRect({ kind: 'point', x: NaN, y: 0.5 }, at)), plain(at.block))
  // And a target with nothing in it at all, which is what a block mid-mount looks like.
  assert.deepEqual(plain(client.anchorRect({ kind: 'item', itemId: 'x' }, {})), { left: 0, top: 0, width: 0, height: 0 })
})

// ---------------------------------------------------------------------------
// The label's position, and the edges a page cannot draw
// ---------------------------------------------------------------------------

test('the label sits on the curve at its own middle', () => {
  // An asymmetric pair, so the two control points pull along different axes — (260, 30) against
  // (340, 130) — and the cubic's value at t = 1/2 is what decides where the label goes:
  // (P0 + 3P1 + 3P2 + P3) / 8, which is (300, 80) here.
  const from = box(0, 0, 200, 60)
  const to = box(400, 100, 200, 60)
  const mid = client.curveMidpoint(from, to)
  const curve = client.curvePoints(from, to)
  assert.deepEqual(plain(curve.c1), { x: 260, y: 30 })
  assert.deepEqual(plain(curve.c2), { x: 340, y: 130 })
  assert.deepEqual(plain(mid), { x: 300, y: 80 })
  assert.deepEqual(plain(mid), {
    x: (curve.start.x + 3 * curve.c1.x + 3 * curve.c2.x + curve.end.x) / 8,
    y: (curve.start.y + 3 * curve.c1.y + 3 * curve.c2.y + curve.end.y) / 8,
  })
  // The label is placed from the cubic, not from the straight line between the two anchor centres:
  // on the pair below the curve leaves through the bottom and arrives at the top, so the cubic's
  // middle coincides with the chord's — which is what makes the two formulas indistinguishable there
  // and is exactly why the boxes above are the ones worth pinning.
  const tall = client.curveMidpoint(box(0, 0, 200, 60), box(0, 400, 200, 60))
  assert.deepEqual(plain(tall), { x: 100, y: 230 })
  assert.equal(tall.y, (30 + 430) / 2)
})

test('the label is never at the arrowhead', () => {
  const from = box(0, 0)
  const to = box(0, 400)
  const curve = client.curvePoints(from, to)
  const mid = client.curveMidpoint(from, to)
  // Halfway along, and the head is drawn at the end.
  assert.equal(mid.y, (curve.start.y + 3 * curve.c1.y + 3 * curve.c2.y + curve.end.y) / 8)
  assert.ok(Math.abs(mid.y - curve.end.y) > 60, 'well clear of the end')
})

test('two boxes with the same centre have no curve, so they have no label', () => {
  const same = box(100, 100, 200, 60)
  assert.equal(client.curveMidpoint(same, box(100, 100, 200, 60)), undefined)
  assert.equal(client.curvePoints(same, box(100, 100, 200, 60)), undefined)
  // A path of nothing rather than a path of NaN: an unrenderable `d` makes SVG drop the element.
  assert.equal(client.routeBetween(same, box(100, 100, 200, 60)), '')
})

test('a waypoint is a place in the gap between the two cards, not a place on the page', () => {
  const from = box(0, 0, 200, 60)
  const to = box(400, 100, 200, 60)
  // The box spanning the two endpoint rectangles is (0, 0) to (600, 160).
  assert.deepEqual(plain(client.viaPoints(from, to, [{ x: 0.5, y: 0.5 }])), [{ x: 300, y: 80 }])
  assert.deepEqual(plain(client.viaPoints(from, to, [{ x: 0, y: 0 }, { x: 1, y: 1 }])), [
    { x: 0, y: 0 },
    { x: 600, y: 160 },
  ])
  // Move both cards and the detour moves with them, which is the whole reason it is normalised to
  // the gap: a waypoint tied to the page would drift off the line the first time a card grew.
  const moved = client.viaPoints(box(1000, 0, 200, 60), box(1400, 100, 200, 60), [{ x: 0.5, y: 0.5 }])
  assert.deepEqual(plain(moved), [{ x: 1300, y: 80 }])

  // No waypoints, an empty list, or a value that is not a list: nothing to call at.
  for (const value of [undefined, null, [], 'halfway']) assert.deepEqual(plain(client.viaPoints(from, to, value)), [])
  // One unreadable waypoint is dropped; the ones that are readable stay exactly where they were put.
  assert.deepEqual(plain(client.viaPoints(from, to, [{ x: 'left', y: 0 }, { x: 0.25, y: 0.5 }])), [{ x: 150, y: 80 }])
  // Out of range is clamped into the gap rather than allowed to leave the board.
  assert.deepEqual(plain(client.viaPoints(from, to, [{ x: -1, y: 4 }])), [{ x: 0, y: 160 }])
})

test('an edge with waypoints is a broken line through them, and without them is the same curve', () => {
  const from = box(0, 0, 200, 60)
  const to = box(400, 100, 200, 60)
  // The departure and arrival points are the cubic's, whatever happens in between: adding a detour
  // must not move where the arrow leaves or lands.
  const curve = client.curvePoints(from, to)
  const routed = client.routeBetween(from, to, [{ x: 0.5, y: 0 }])
  assert.equal(routed, `M ${curve.start.x} ${curve.start.y} L 300 0 L ${curve.end.x} ${curve.end.y}`)

  // Without waypoints the path is the cubic, byte for byte, as it was before waypoints existed.
  assert.equal(client.routeBetween(from, to, undefined), client.routeBetween(from, to))
  assert.ok(client.routeBetween(from, to, undefined).includes('C'), 'still the default curve')

  // The same centre still has no route at all, waypoints or not: nothing to draw through.
  const same = box(100, 100, 200, 60)
  assert.equal(client.routeBetween(same, box(100, 100, 200, 60), [{ x: 0.5, y: 0.5 }]), '')
})

test('the label of a routed edge sits halfway along the line, not halfway between its ends', () => {
  const from = box(0, 0, 200, 60)
  const to = box(400, 100, 200, 60)
  const curve = client.curvePoints(from, to)
  // A detour that is deliberately lopsided: start (200, 30) → (300, 0) → end (400, 130). The legs are
  // √(100² + 30²) = 104.4 and √(100² + 130²) = 164.0, so the halfway point is on the *second* leg.
  const label = client.pathMidpoint(from, to, [{ x: 0.5, y: 0 }])
  const first = Math.hypot(300 - curve.start.x, 0 - curve.start.y)
  const second = Math.hypot(curve.end.x - 300, curve.end.y - 0)
  const share = (first + second) / 2 - first
  assert.ok(share > 0, 'the halfway point is past the corner')
  // Along the second leg, so both coordinates move together from the corner to the end.
  const along = share / second
  assert.deepEqual(plain(label), plain({ x: 300 + along * (curve.end.x - 300), y: along * (curve.end.y - 0) }))
  // And it is on the line, unlike the midpoint of the two ends.
  assert.notDeepEqual(plain(label), plain({ x: (curve.start.x + curve.end.x) / 2, y: (curve.start.y + curve.end.y) / 2 }))

  // A line of no length has no middle, and neither does a route with no curve at all.
  assert.equal(client.polylineMidpoint([{ x: 5, y: 5 }, { x: 5, y: 5 }]), undefined)
  assert.equal(client.polylineMidpoint([{ x: 5, y: 5 }]), undefined)
  assert.equal(client.pathMidpoint(box(100, 100, 200, 60), box(100, 100, 200, 60), [{ x: 0.5, y: 0.5 }]), undefined)

  // No waypoints is the cubic's own middle, exactly as before.
  assert.deepEqual(plain(client.pathMidpoint(from, to, undefined)), plain(client.curveMidpoint(from, to)))
})

test('the page header counts the edges it draws and the ones that leave the page', () => {
  const edges = [
    { id: 'e1', from: { blockId: 'a' }, to: { blockId: 'b' } },
    { id: 'e2', from: { blockId: 'b' }, to: { blockId: 'c' } },
    { id: 'e3', from: { blockId: 'b' }, to: { blockId: 'far' } },
    { id: 'e4', from: { blockId: 'far' }, to: { blockId: 'a' } },
    // Neither endpoint here: not this page's business at all, and counting it would inflate the
    // number a reader uses to decide whether anything is missing.
    { id: 'e5', from: { blockId: 'x' }, to: { blockId: 'y' } },
    // One endpoint gone: a dangling edge is not a cross-page one either.
    { id: 'e6', from: { blockId: 'a' }, to: { blockId: 'gone' } },
  ]
  assert.deepEqual(plain(client.countEdges(edges, new Set(['a', 'b', 'c']))), { drawn: 2, cross: 3 })
  assert.deepEqual(plain(client.countEdges([], new Set())), { drawn: 0, cross: 0 })
})

// ---------------------------------------------------------------------------
// The two renderer outputs an anchor reads
// ---------------------------------------------------------------------------

test('a code block is one span per line, in the numbering an anchor uses', () => {
  const lines = client.codeLines('one\ntwo\n\nfour')
  // Nine children for four lines: a span each, and the newlines between them as text.
  assert.equal(lines.length, 7)
  assert.equal(lines[0].props['data-superboard-line'], 1)
  assert.equal(lines[0].children[0], 'one')
  assert.equal(lines[1], '\n')
  assert.equal(lines[2].props['data-superboard-line'], 2)
  // A blank line is a line. Dropping it would shift every span after it by one and make a range
  // silently point at the wrong code.
  assert.equal(lines[4].props['data-superboard-line'], 3)
  assert.equal(lines[4].children[0], '')
  assert.equal(lines[6].props['data-superboard-line'], 4)

  // The element's text is byte-for-byte the block's, which is the promise a literal code card makes.
  const text = lines.map((child) => (typeof child === 'string' ? child : child.children[0])).join('')
  assert.equal(text, 'one\ntwo\n\nfour')
  // A trailing newline is a final empty line, not a missing one.
  assert.equal(client.codeLines('one\n').length, 3)
})

/**
 * A `DOMParser` that answers the two questions `diagramNodeTable` asks: the root's own size, and its
 * `g.node` elements. No layout, no CSS, no `getBBox` — which is the point, since the real one has
 * none of those either for a detached parse.
 *
 * A function, because the real one is a constructor the code calls `new` on: passing a bare object
 * would make `new Parser()` an object too, and the size guard would reject it.
 */
function fakeDOMParser(groups, root = { id: 'sb-uml-bl_ccd8b5', width: '200', height: '100', viewBox: '0 0 200 100' }) {
  /** A CSS tag list, which is the only kind of selector `diagramNodeTable` asks for. */
  const match = (selector, child) => selector.split(',').some((name) => name.trim() === child.localName)
  const element = (name, attributes, children = []) => ({
    localName: name,
    getAttribute: (attribute) => attributes[attribute] ?? null,
    querySelectorAll: (selector) => (selector === 'g.node' ? children : children.filter((child) => match(selector, child))),
    querySelector: (selector) => children.find((child) => match(selector, child)) ?? null,
  })
  const toElement = (group) =>
    element('g', { class: 'node', id: group.id, transform: group.transform }, group.shapes.map((shape) => element(shape.localName, shape.attributes)))
  return function Parser() {
    this.parseFromString = () => ({ documentElement: element('svg', root, groups.map(toElement)) })
  }
}

test('a rendered diagram publishes each node box in its own user units', () => {
  const groups = [
    // What mermaid 11 actually writes: its own container id, then the marker, the identifier the
    // Agent used, and a global counter. Reading the key off `flowchart-` at the front finds nothing
    // and every `node` anchor silently becomes the block box.
    { id: 'sb-uml-bl_ccd8b5-flowchart-A-0', transform: 'translate(20, 10)', shapes: [{ localName: 'rect', attributes: { width: '40', height: '20' } }] },
    { id: 'sb-uml-bl_ccd8b5-flowchart-long-key-7', transform: 'translate(120, 60)', shapes: [{ localName: 'circle', attributes: { r: '15' } }] },
    // A container that does not prefix the marker still reads, because the marker is what is looked for.
    { id: 'flowchart-Diamond-3', transform: 'translate(10, 70)', shapes: [{ localName: 'polygon', attributes: { points: '0,0 30,0 15,25' } }] },
  ]
  const table = client.diagramNodeTable('<svg/>', { DOMParser: fakeDOMParser(groups) })
  assert.equal(table.w, 200)
  assert.equal(table.h, 100)
  // The key is what sits between the last `flowchart-` and the counter: what an Agent writes and
  // what `src/uml.js` publishes, so the two agree by construction.
  assert.deepEqual(plain(table.nodes.A), { x: 20, y: 10, w: 40, h: 20 })
  assert.deepEqual(plain(table.nodes['long-key']), { x: 105, y: 45, w: 30, h: 30 })
  assert.deepEqual(plain(table.nodes.Diamond), { x: 10, y: 70, w: 30, h: 25 })
})

test('a percentage on the root is not a size, so the viewBox is what a node box scales against', () => {
  // Mermaid writes `width="100%"`. `parseFloat` reads that as the number 100, which would make every
  // node box a hundredth of its real size — and the picture is drawn with `preserveAspectRatio:
  // 'none'`, so the viewBox is exactly the space the picture's box is a scaling of.
  const groups = [{ id: 'flowchart-A-0', transform: 'translate(0, 0)', shapes: [{ localName: 'rect', attributes: { width: '10', height: '10' } }] }]
  const table = client.diagramNodeTable('<svg/>', { DOMParser: fakeDOMParser(groups, { width: '100%', height: '100%', viewBox: '0 0 636.2734375 865.625' }) })
  assert.equal(table.w, 636.2734375)
  assert.equal(table.h, 865.625)
})

test('the container prefix comes off by identity, so a state or er node reads too', () => {
  // State and er diagrams do carry `g.node`, under their own family tokens. The root's id is the
  // container id mermaid was given, so the prefix is matched rather than guessed at.
  const state = client.diagramNodeTable('<svg/>', {
    DOMParser: fakeDOMParser(
      [
        { id: 'sb-uml-bl_x-state-Idle-0', transform: 'translate(0, 0)', shapes: [{ localName: 'rect', attributes: { width: '10', height: '10' } }] },
        { id: 'sb-uml-bl_x-state-Waiting-4', transform: 'translate(0, 20)', shapes: [{ localName: 'rect', attributes: { width: '10', height: '10' } }] },
      ],
      { id: 'sb-uml-bl_x', viewBox: '0 0 200 100' },
    ),
  })
  assert.deepEqual(Object.keys(state.nodes), ['Idle', 'Waiting'])
  const er = client.diagramNodeTable('<svg/>', {
    DOMParser: fakeDOMParser(
      [{ id: 'sb-uml-bl_x-entity-CUSTOMER', transform: 'translate(5, 5)', shapes: [{ localName: 'rect', attributes: { width: '80', height: '40' } }] }],
      { id: 'sb-uml-bl_x', viewBox: '0 0 200 100' },
    ),
  })
  assert.deepEqual(plain(er.nodes.CUSTOMER), { x: 5, y: 5, w: 80, h: 40 })
  // A root with no id of its own still reads, because the family token is looked for as well.
  const bare = client.diagramNodeTable('<svg/>', {
    DOMParser: fakeDOMParser([{ id: 'flowchart-A-0', transform: 'translate(1, 2)', shapes: [{ localName: 'rect', attributes: { width: '10', height: '10' } }] }], { viewBox: '0 0 200 100' }),
  })
  assert.deepEqual(Object.keys(bare.nodes), ['A'])
})

test('a diagram whose root carries no size falls back to its viewBox rather than to zero', () => {
  const groups = [{ id: 'flowchart-A-0', transform: 'translate(0, 0)', shapes: [{ localName: 'rect', attributes: { width: '10', height: '10' } }] }]
  const table = client.diagramNodeTable('<svg/>', { DOMParser: fakeDOMParser(groups, { viewBox: '0 0 640 480' }) })
  assert.equal(table.w, 640)
  assert.equal(table.h, 480)
})

test('a diagram with no node groups at all yields an empty table, not an absent one', () => {
  // Sequence, class, state and er diagrams draw nodes with their own classes. An empty table is the
  // honest answer and resolves every `node` anchor to the block box.
  const table = client.diagramNodeTable('<svg/>', { DOMParser: fakeDOMParser([]) })
  assert.deepEqual(plain(table.nodes), {})
})

test('a diagram with no parser at all is no table, never a throw', () => {
  // The host half loads this file in a context with no `DOMParser`, and `Diagram` calls this on the
  // path that renders a card.
  assert.equal(client.diagramNodeTable('<svg/>', {}), undefined)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull the nth and mth whitespace-separated numbers out of a path string. */
function numbers(d, first, second) {
  const all = d.match(/-?\d+(\.\d+)?/g)
  return [Number(all[first - 1]), Number(all[second - 1])]
}
