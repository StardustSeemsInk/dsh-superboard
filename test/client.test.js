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
// Helpers
// ---------------------------------------------------------------------------

/** Pull the nth and mth whitespace-separated numbers out of a path string. */
function numbers(d, first, second) {
  const all = d.match(/-?\d+(\.\d+)?/g)
  return [Number(all[first - 1]), Number(all[second - 1])]
}
