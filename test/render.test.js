/**
 * Render smoke tests.
 *
 * Every other client test drives a **pure** function. That leaves the largest failure mode
 * untested: the components themselves. A slot that throws while rendering does not degrade, and it
 * does not log anything the user can see — the pane goes blank, which is indistinguishable from
 * "the plugin never loaded" and from "the projection is still empty". Both of those are states this
 * view renders on purpose, so a blank board has no diagnostic signature at all.
 *
 * So these tests actually evaluate the component tree: a stubbed React supplies hooks, every
 * function component is called, and the result is walked. Anything that throws on mount — a
 * mistyped identifier, a helper used before it exists, a prop that arrives `undefined` where an
 * object is assumed — fails here instead of in the user's profile.
 *
 * The board fed in is built by the **real** fold and passed through the **real** wire schema, so a
 * host/client shape mismatch fails here too. Hooks are stubbed permissively: a hook the slot kit
 * does not inject is `undefined`, which is exactly the shape that has to survive.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

import { foldBoard } from '../src/fold.js'
import { emptyBoardDoc } from '../src/model.js'
import { renderInputKey } from '../src/runtime.js'
import { boardWireSchema, toWire } from '../src/schema.js'

const CLIENT_PATH = new URL('../src/client.js', import.meta.url)

/**
 * A React stand-in that can be rendered through, not just loaded.
 *
 * `useEffect` deliberately does **not** run: the effects here observe layout (a ResizeObserver and
 * a scroll container), which a DOM-free test cannot provide, and running them would test the stub
 * rather than the component. `useState` returns the initial value and a no-op setter, so a
 * component is rendered in its initial state.
 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('react.fragment'),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (compute) => compute(),
  useCallback: (callback) => callback,
}

/** Every `fetch` the client made, as `[url, init]`. Cleared by the tests that assert on it. */
const fetchCalls = []

/** Load the client half and return its exports, as `test/client.test.js` does. */
function loadClient() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  let registered

  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => (registered = definition) } },
    requestAnimationFrame: (callback) => {
      callback()
      return 1
    },
    // A report is fire-and-forget, so the stub only has to be thenable-shaped: `reportRenderFailure`
    // calls `.catch` on whatever comes back and never looks at a response.
    fetch: (url, init) => {
      fetchCalls.push([url, init])
      return { catch: () => {} }
    },
    cancelAnimationFrame: () => {},
    ResizeObserver: undefined,
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
    Error,
    Date,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)

  assert.ok(registered !== undefined, 'the client half must register a lazy factory')
  return registered.factory((specifier) => {
    if (specifier === 'react') return fakeReact
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
}

const client = loadClient()

/** One committed `board_apply` call, arguments stringified as DSH commits them. */
function applied(seq, callId, args) {
  return [
    { type: 'tool/call', seq, data: { callId, name: 'board_apply', arguments: JSON.stringify(args) } },
    { type: 'tool/result', seq: seq + 1, data: { message: { toolCallId: callId, isError: false, content: [] } } },
  ]
}

/**
 * A board that exercises everything the renderer has a branch for: a nested container carrying its
 * own layout, a page layout, a region tone, and an edge.
 *
 * Explicit slugs are used for the blocks that are referenced as children, because a slug derived
 * from a sentence is deliberately not guessable.
 */
function richWire() {
  const doc = [
    ...applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', level: 1, text: '架构总览', slug: 'arch' },
        { op: 'add_block', page: 'main', kind: 'prose', markdown: '登录服务**处理**会话。', slug: 'intro' },
        { op: 'add_block', page: 'main', kind: 'code', lang: 'ts', filename: 'session.ts', code: 'const s = 1' },
        { op: 'add_block', page: 'main', kind: 'list', ordered: true, items: ['读取会话', '校验令牌'] },
        { op: 'add_block', page: 'main', kind: 'uml', source: 'flowchart TD\n  A-->B', diagram: 'flowchart' },
        { op: 'add_block', page: 'main', kind: 'image', src: 'docs/arch.png', alt: '架构图' },
        { op: 'add_block', page: 'main', kind: 'pdf-page', src: 'docs/spec.pdf', pdfPage: 4, caption: '规格书第 4 页' },
        { op: 'add_block', page: 'main', kind: 'prose', markdown: '附注说明。', slug: 'notes' },
        // The inner container first: a group can only adopt what already exists.
        { op: 'add_block', page: 'main', kind: 'group', title: '内层', slug: 'inner', layout: { template: 'row' }, children: ['arch', 'intro'] },
        { op: 'add_block', page: 'main', kind: 'group', title: '外层', slug: 'outer', layout: { template: 'columns', params: { cols: 2 } }, children: ['inner', 'notes'] },
        { op: 'set_layout', scope: 'main', template: 'grid', params: { minCardWidth: 240 } },
        { op: 'set_region', region: 'focus', blockIds: ['arch'], label: '重点', tone: 'warn' },
        { op: 'add_edge', from: 'arch', to: 'intro', rel: 'explains', label: '说明' },
      ],
    }),
    ...applied(30, 'c2', { ops: [{ op: 'add_page', page: '设计' }] }),
  ].reduce((state, event) => foldBoard(state, event), emptyBoardDoc('sess-render'))

  // Through the wire schema, because that parse is what the host actually performs. A field the
  // fold produces and the schema omits throws here rather than in the browser.
  return boardWireSchema.parse(toWire(doc))
}

/**
 * A board whose grid container names its cells.
 *
 * `areas` is resolved by `toWire`, so this fixture is also the check that the resolution survives
 * the wire schema — the placement arrives as `layout.params.cells`, and the renderer reads it from
 * the parent, not from the block.
 */
function areasWire() {
  const doc = [
    ...applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', slug: 'arch', level: 2, text: '架构总览' },
        { op: 'add_block', page: 'main', kind: 'prose', slug: 'intro', markdown: '导语。' },
        {
          op: 'add_block',
          page: 'main',
          kind: 'group',
          slug: 'pipeline',
          title: '管线',
          children: ['arch', 'intro'],
          layout: { template: 'grid', params: { areas: ['arch arch', 'intro .'] } },
        },
      ],
    }),
  ].reduce((state, event) => foldBoard(state, event), emptyBoardDoc('sess-render'))

  return boardWireSchema.parse(toWire(doc))
}

/**
 * A board whose prose carries a table, beside one that does not.
 *
 * The table is the case that broke: a card body only ran the inline parser, so the header, the
 * separator and the body row all arrived in the paragraph branch and were printed with their pipes
 * intact — which reads as a rendering fault rather than as a table.
 */
function tableWire() {
  const doc = [
    ...applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'prose', slug: 'plain', markdown: '一句普通话。' },
        {
          op: 'add_block',
          page: 'main',
          kind: 'prose',
          slug: 'tabled',
          markdown: '| 候选 | 为什么不行 |\n| --- | --- |\n| 槽位 | 拿不到 |',
        },
      ],
    }),
  ].reduce((state, event) => foldBoard(state, event), emptyBoardDoc('sess-render'))
  return boardWireSchema.parse(toWire(doc))
}

/** The board above, rendered. */
function tableView() {
  return render(
    client.BoardView(
      props({ useProjection: (key) => (key === 'board' ? tableWire() : undefined) }),
    ),
  )
}

/**
 * A chat snapshot whose nodes are the two kinds the reading column keeps, plus two it drops.
 *
 * `nodes.values()` returning an **array** is the real shape, not a Map iterator: the shipped
 * `EMPTY_CHAT_SNAPSHOT` declares `values: () => EMPTY_LIST`, so a fixture built on a `Map` would
 * pass while the view showed nothing at all.
 */
function chatSnapshot() {
  return {
    nodes: {
      get: () => undefined,
      values: () => [
        { key: 'n1', kind: 'user', anchorSeq: 1, data: { content: [{ type: 'text', text: '为什么登录会超时？' }] } },
        { key: 'n2', kind: 'reasoning', anchorSeq: 2, data: { text: '想一想' } },
        { key: 'n3', kind: 'assistant-step', anchorSeq: 3, data: { blocks: [{ kind: 'text', text: '# 结论\n\n令牌校验阻塞了。' }] } },
        { key: 'n4', kind: 'tool-call', anchorSeq: 4, data: {} },
        { key: 'n5', kind: 'user', anchorSeq: 5, visibility: 'hidden', data: { content: [{ type: 'text', text: '隐藏' }] } },
      ],
    },
  }
}

/**
 * Evaluate a component tree.
 *
 * Function components are called; host elements are kept as plain records. The depth cap is a guard
 * against a component that renders itself, which would otherwise present as a stack overflow rather
 * than a named failure.
 */
function render(element, depth = 0) {
  if (element === null || element === undefined || typeof element === 'boolean') return null
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map((child) => render(child, depth + 1))
  assert.ok(depth < 60, 'the render tree is too deep — a component is probably rendering itself')

  const { type, props, children } = element
  const resolved = children !== undefined && children.length > 0 ? children : props?.children
  if (typeof type === 'symbol') return render(resolved ?? [], depth + 1)
  if (typeof type === 'function') return render(type({ ...(props ?? {}), children: resolved }), depth + 1)
  return { type, props: props ?? {}, children: (resolved ?? []).map((child) => render(child, depth + 1)) }
}

/** Every class name in a rendered tree, so assertions can name what should be on screen. */
function classes(tree, found = []) {
  if (tree === null || tree === undefined) return found
  if (Array.isArray(tree)) {
    for (const child of tree) classes(child, found)
    return found
  }
  if (typeof tree === 'string') return found
  if (typeof tree.props.className === 'string') found.push(...tree.props.className.split(/\s+/).filter(Boolean))
  classes(tree.children, found)
  return found
}

/** Every string of text in a rendered tree. */
function textOf(tree, found = []) {
  if (tree === null || tree === undefined) return found
  if (typeof tree === 'string') {
    found.push(tree)
    return found
  }
  if (Array.isArray(tree)) {
    for (const child of tree) textOf(child, found)
    return found
  }
  textOf(tree.children, found)
  return found
}

/** Every host element in a rendered tree, so a test can inspect classes and props together. */
function elements(tree, found = []) {
  if (tree === null || tree === undefined || typeof tree === 'string') return found
  if (Array.isArray(tree)) {
    for (const child of tree) elements(child, found)
    return found
  }
  found.push(tree)
  elements(tree.children, found)
  return found
}

/** Props for `BoardView`, with every injected hook present. */
function props(overrides = {}) {
  return {
    sessionId: 'sess-render',
    useProjection: (key) => (key === 'board' ? richWire() : undefined),
    useChat: (selector) => selector(chatSnapshot()),
    useInput: (selector) => selector({ draft: '已经有草稿了' }),
    inputActions: { setDraft: () => {}, addAttachments: () => {}, submit: () => {} },
    attachFeedback: async () => ['draft-1'],
    loadOlder: async () => true,
    // Whether older history remains is a session *standard prop*, not an injected field: it is the
    // only form that re-renders when a page lands.
    useSession: (selector) => selector({ hasMore: false }),
    ...overrides,
  }
}

test('the board view renders a rich board without throwing', () => {
  let tree
  assert.doesNotThrow(() => {
    tree = render(client.BoardView(props()))
  }, 'a throw here is the user-visible blank board')
  assert.ok(tree !== null, 'the view must return something')
})

test('the rendered board shows every block kind and both containers', () => {
  const tree = render(client.BoardView(props()))
  const text = textOf(tree).join(' ')

  assert.match(text, /架构总览/)
  assert.match(text, /登录服务/)
  assert.match(text, /session\.ts/)
  assert.match(text, /校验令牌/)
  assert.match(text, /内层/, 'a nested group must render its title')
  assert.match(text, /外层/)
  // A group's children render inside it, so the deepest block appears exactly once.
  assert.equal(textOf(tree).filter((part) => part === '架构总览').length, 1)
})

test('the container and tone classes all reach the output', () => {
  const found = classes(render(client.BoardView(props())))

  // The page layout.
  assert.ok(found.includes('sb-grid'), `expected the page grid, saw ${found.join(' ')}`)
  // A nested container with its own layout: the inner row sits inside the outer columns.
  assert.ok(found.includes('sb-columns'), 'the outer group carries its layout')
  assert.ok(found.includes('sb-row'), 'the inner group carries its own layout')
  assert.ok(found.includes('sb-groupBox'))
  // A region is annotation: it colours a block without moving it.
  assert.ok(found.includes('sb-tone-warn'), 'a region tone must reach the card')
  // Nothing generic is positioned any more: pixel freedom belongs to spatial components, and the
  // classes that carried it are gone rather than merely unused.
  assert.ok(!found.includes('sb-pinned'), 'block-level positioning was deleted')
  assert.ok(!found.includes('sb-anchored'), 'the anchor container existed only for block-level at')
})

test('a resolved cell reaches the card as grid line numbers', () => {
  // The whole `areas` path, end to end: authored on the host, resolved by the projection, and turned
  // into a style here. A card that lost its cell would flow into the next free one, which looks like
  // a layout choice rather than a bug — so the assertion is on the line numbers themselves.
  const tree = render(client.BoardView(props({ useProjection: (key) => (key === 'board' ? areasWire() : undefined) })))
  const cards = elements(tree).filter((node) => node.props.className === 'sb-card')
  const pinned = cards.find((card) => card.props['data-block-slug'] === 'arch')
  const inner = cards.find((card) => card.props['data-block-slug'] === 'intro')

  assert.equal(pinned.props.style.gridRow, '1 / span 1')
  assert.equal(pinned.props.style.gridColumn, '1 / span 2')
  assert.equal(inner.props.style.gridRow, '2 / span 1')
  assert.equal(inner.props.style.gridColumn, '1 / span 1')
  // A cell is placement, never position.
  assert.equal(pinned.props.style.position, undefined)

  // And the container's own template follows the resolved column count instead of auto-filling.
  const bodies = elements(tree).filter((node) => node.props.className?.includes('sb-groupBody'))
  const gridBody = bodies.find((body) => body.props.style?.gridTemplateColumns !== undefined)
  assert.equal(gridBody.props.style.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))')
})

test('the reading column renders the dialogue from the chat snapshot', () => {
  const tree = render(client.ReadingColumn({ sessionId: 'sess-render', useChat: (selector) => selector(chatSnapshot()), loadOlder: async () => {}, hasOlder: () => false, width: 420, onResize: () => {} }))
  const text = textOf(tree).join(' ')

  assert.match(text, /为什么登录会超时/)
  assert.match(text, /令牌校验阻塞了/)
  // Reasoning and tool-call nodes are separate kinds, and a hidden node is not shown at all.
  assert.doesNotMatch(text, /想一想/)
  assert.doesNotMatch(text, /隐藏/)
  // The markdown is rendered, not echoed: the heading marker is gone, its emphasis retained.
  assert.doesNotMatch(text, /# 结论/)
})

test('a landed page of history appears without a remount', () => {
  // `nodes` is a *stable* keyed store: `ChatSnapshotBuilder.snapshot()` hands back the same
  // `MutableChatNodeStore` instance on every publication (`chat-snapshot-builder.ts:1172-1184`),
  // so subscribing to it compares equal forever and React bails out of the re-render. The column
  // then only caught up when something else remounted it — the "switch tabs and come back" the
  // user reported. A React stub whose `useMemo` ignores its dependency array cannot tell the
  // difference, so this test installs one that honours deps, and drives two publications past a
  // store whose identity deliberately never changes.
  const earlier = {
    key: 'n0',
    kind: 'user',
    anchorSeq: 0,
    data: { content: [{ type: 'text', text: '更早的问题' }] },
  }
  let landed = false
  const visible = chatSnapshot().nodes.values()
  const store = {
    get: () => undefined,
    values: () => (landed ? [earlier, ...visible] : visible),
  }
  // Only `order` moves, which is exactly what a prepend does: the store instance is the same one.
  const publication = () => ({ order: landed ? ['n0', ...visible.map((node) => node.key)] : visible.map((node) => node.key), nodes: store })
  const column = () =>
    client.ReadingColumn({
      sessionId: 'sess-render',
      useChat: (selector) => selector(publication()),
      loadOlder: async () => true,
      hasOlder: true,
      width: 420,
      onResize: () => {},
    })

  const originalMemo = fakeReact.useMemo
  const cells = []
  let next = 0
  fakeReact.useMemo = (compute, deps) => {
    const index = next++
    const previous = cells[index]
    const unchanged =
      previous !== undefined &&
      Array.isArray(deps) &&
      Array.isArray(previous.deps) &&
      deps.length === previous.deps.length &&
      deps.every((value, at) => Object.is(value, previous.deps[at]))
    if (unchanged) return previous.value
    const value = compute()
    cells[index] = { deps, value }
    return value
  }

  try {
    next = 0
    assert.doesNotMatch(textOf(render(column())).join(' '), /更早的问题/)

    landed = true
    next = 0
    assert.match(
      textOf(render(column())).join(' '),
      /更早的问题/,
      'a page that landed must show without the user leaving the tab',
    )
  } finally {
    fakeReact.useMemo = originalMemo
  }
})

test('a view with no projection, no hooks and no history still renders', () => {
  // The three "nothing yet" states. Each renders a placeholder on purpose, so none of them may
  // throw — a blank pane would be indistinguishable from a crash.
  const bare = {
    sessionId: 'sess-render',
    useProjection: () => undefined,
    useChat: () => undefined,
    useInput: () => undefined,
    inputActions: undefined,
    attachFeedback: undefined,
    loadOlder: undefined,
    hasOlder: undefined,
  }

  let tree
  assert.doesNotThrow(() => {
    tree = render(client.BoardView(bare))
  })
  assert.ok(textOf(tree).join(' ').length > 0, 'the empty state must say something')

  // And an empty board, which is the state before the Agent has written anything.
  assert.doesNotThrow(() =>
    render(client.BoardView({ ...bare, useProjection: () => boardWireSchema.parse(toWire(emptyBoardDoc('sess-render'))) })),
  )
})

test('a hook that is injected but returns nothing does not take the view down', () => {
  // The slot kit injects every declared hook into every session-scoped entry, so a hook can exist
  // and still resolve to `undefined` before its provider has produced a value. The selectors here
  // dereference the snapshot, which is the shape that would throw if the guard were missing.
  const tree = render(
    client.BoardView(
      props({
        useChat: (selector) => selector(undefined),
        useInput: (selector) => selector(undefined),
      }),
    ),
  )
  assert.ok(tree !== null)
})

/**
 * A permissive synthetic event.
 *
 * Handlers here reach for pointer capture, a scroll container and a bounding rect; a fake that
 * stubbed only some of them would fail for its own reasons and hide the real one.
 */
function fakeEvent(overrides = {}) {
  const element = {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    clientWidth: 1200,
    scrollLeft: 0,
    scrollTop: 0,
    // A pointer landing on empty canvas is the `null` case, and it is the one worth exercising:
    // the block-hit path is what a click on a card would produce, which is not what a marquee is.
    closest: () => null,
    contains: () => false,
    parentElement: { parentElement: { clientWidth: 1200, getBoundingClientRect: () => ({ left: 0, top: 0 }) } },
  }
  return {
    button: 0,
    pointerId: 1,
    clientX: 600,
    clientY: 300,
    key: 'Enter',
    shiftKey: false,
    currentTarget: element,
    target: element,
    preventDefault: () => {},
    stopPropagation: () => {},
    ...overrides,
  }
}

test('every event handler in the rendered board survives being called', () => {
  // A handler is only reached on a gesture, so a name that does not resolve there stays invisible
  // until the user tries it — and inside a slot, a throw during a pointer move takes the pane down.
  const failures = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    for (const [name, value] of Object.entries(node.props ?? {})) {
      if (typeof value !== 'function' || !/^on[A-Z]/.test(name)) continue
      try {
        value(fakeEvent())
      } catch (error) {
        failures.push(`${name} → ${error.message}`)
      }
    }
    visit(node.children)
  }

  visit(render(client.BoardView(props())))
  assert.deepEqual(failures, [], 'a handler threw when called')
})

test('the selection bar is absent until something is selected', () => {
  // No idle state on purpose: a permanent instruction line is noise on every visit.
  assert.equal(client.SelectionBar({ count: 0, slugs: [], note: '', setNote: () => {}, sending: false, error: null, onSend: () => {}, onCancel: () => {} }), null)

  const tree = render(
    client.SelectionBar({
      count: 2,
      slugs: ['arch', 'intro'],
      note: '为什么？',
      setNote: () => {},
      sending: false,
      error: null,
      onSend: () => {},
      onCancel: () => {},
    }),
  )
  const text = textOf(tree).join(' ')
  assert.match(text, /2/)
  assert.match(text, /arch/)
  assert.match(text, /intro/)

  // The controls are the shared primitives, not bare elements. `sb-input` and `sb-button` used to
  // have no rules anywhere in the stylesheet, so the browser drew them and the bar read as a form
  // bolted onto the board rather than a control belonging to it.
  const names = elements(tree).flatMap((node) => String(node.props.className ?? '').split(/\s+/))
  assert.ok(names.includes('sb-selbarField'), 'the field must be the wrapper that owns the border and the focus ring')
  assert.ok(names.includes('sb-buttonPrimary'), 'the primary action must be a styled Button')
  const field = elements(tree).find((node) => String(node.props.className ?? '').split(/\s+/).includes('sb-selbarField'))
  assert.equal(elements(field).filter((node) => node.type === 'input').length, 1)
})

test('a long selection collapses into an overflow count instead of a wall of chips', () => {
  // The bar has to stay one row. It used to print every selected slug inline, which pushed the
  // field and both buttons off the end of the line — the controls you needed were the ones that
  // scrolled away.
  const slugs = ['dash-status', 'dash-next', 'dash-materials', 'dash-power', 'dash-blackhide', 'dash-pitfalls']
  const tree = render(
    client.SelectionBar({
      count: slugs.length,
      slugs,
      note: '',
      setNote: () => {},
      sending: false,
      error: null,
      onSend: () => {},
      onCancel: () => {},
    }),
  )

  const byClass = (wanted) => (node) => String(node.props.className ?? '').split(/\s+/).includes(wanted)
  const chips = elements(tree).filter(byClass('sb-chip'))
  assert.deepEqual(
    chips.map((chip) => textOf(chip).join('')),
    ['dash-status', 'dash-next', 'dash-materials', 'dash-power', '+2'],
  )

  // The collapse hides nothing: the whole selection is still named, and the count still counts it.
  assert.equal(elements(tree).find(byClass('sb-selbarChips')).props.title, slugs.join('、'))
  assert.match(textOf(tree).join(' '), /已选 6 个块/)
})

test('exactly one element per group carries that group\'s layout', () => {
  const LAYOUTS = ['sb-flow', 'sb-row', 'sb-columns', 'sb-grid', 'sb-absBox']
  const boxes = elements(render(client.BoardView(props()))).filter((node) =>
    String(node.props.className ?? '')
      .split(/\s+/)
      .includes('sb-groupBox'),
  )
  assert.ok(boxes.length >= 2, 'the fixture has an outer group and a nested one')

  for (const box of boxes) {
    const names = String(box.props.className).split(/\s+/)
    // A layout class on the *box* was a real bug, and an invisible one. `.sb-grid` sets
    // `align-items: start`; the box is a flex column, and a start-aligned body stops stretching —
    // so the body resolved its own `repeat(auto-fill, minmax(...))` against a shrink-to-fit width
    // and drew two columns where five would have fitted.
    for (const layout of LAYOUTS) {
      assert.ok(!names.includes(layout), `a group box must not carry ${layout}: ${names.join(' ')}`)
    }

    const body = (box.children ?? []).find((child) =>
      String(child?.props?.className ?? '')
        .split(/\s+/)
        .includes('sb-groupBody'),
    )
    assert.ok(body !== undefined, 'every group renders a body')
    // The body is the element that arranges the children, so it is the one that says how.
    assert.ok(
      LAYOUTS.some((layout) =>
        String(body.props.className)
          .split(/\s+/)
          .includes(layout),
      ),
      `the body must carry a layout, saw ${body.props.className}`,
    )
  }
})

test('the load-earlier button follows the session snapshot, not a one-time read', () => {
  const label = '加载更早'

  const withMore = render(client.BoardView(props({ useSession: (selector) => selector({ hasMore: true }) })))
  assert.ok(
    textOf(withMore).some((part) => part.includes(label)),
    'history the session says exists must offer the button',
  )

  const withoutMore = render(client.BoardView(props({ useSession: (selector) => selector({ hasMore: false }) })))
  assert.ok(
    !textOf(withoutMore).some((part) => part.includes(label)),
    'a session with no older history must not offer it',
  )

  // The hook is the whole point, so the view must also survive not having one.
  assert.doesNotThrow(() => render(client.BoardView(props({ useSession: undefined }))))
})

test('a table written into a prose block renders as a table, not as pipes', () => {
  const tree = tableView()

  const tables = elements(tree).filter((node) => node.type === 'table')
  assert.equal(tables.length, 1, 'the table must become a table element')
  assert.ok(classes(tree).includes('sb-mdTable'), 'and carry the table class')

  const text = textOf(tree).join(' ')
  assert.match(text, /为什么不行/, 'a header cell must be visible')
  assert.match(text, /拿不到/, 'a body cell must be visible')
  assert.ok(!text.includes('| 候选 |'), `the pipes must not be shown literally: ${text}`)
  assert.ok(!/\|\s*-{2,}/.test(text), `the separator row must not survive as text: ${text}`)
})

test('prose that is a single sentence keeps its plain paragraph', () => {
  const tree = tableView()
  const paragraphs = elements(tree).filter((node) => node.props.className === 'sb-p')

  assert.equal(paragraphs.length, 1, 'only the prose with no block structure stays a paragraph')
  assert.ok(
    textOf(paragraphs[0]).join('').includes('一句普通话。'),
    'and it is the one-line block',
  )
})

test('a table in an assistant turn renders in the reading column too', () => {
  // The card path and the transcript path share the block parser but not the call site, so the
  // same source is asserted through both.
  const snapshot = {
    nodes: {
      get: () => undefined,
      values: () => [
        {
          key: 'n1',
          kind: 'assistant-step',
          anchorSeq: 1,
          data: { blocks: [{ kind: 'text', text: '| 候选 | 为什么不行 |\n| --- | --- |\n| 槽位 | 拿不到 |' }] },
        },
      ],
    },
  }

  const tree = render(client.BoardView(props({ useChat: (selector) => selector(snapshot) })))
  assert.equal(elements(tree).filter((node) => node.type === 'table').length, 1)
  assert.ok(!textOf(tree).join(' ').includes('| 候选 |'), 'the transcript must not show raw pipes')
})

// ---------------------------------------------------------------------------
// Code and diagrams
// ---------------------------------------------------------------------------

/**
 * Two ways a language reaches a `<code>`: a typed code block, and a fence written inside prose.
 *
 * Both matter for the same reason. An installed diagram renderer finds its work by scanning for a
 * `<code>` whose class list holds exactly `language-mermaid`, and a board that emits no class is
 * simply invisible to it — the diagram stays source text on an installation that would have drawn
 * it. The class is also just what markdown is supposed to produce, so the plugin case is a
 * consequence of being correct rather than a special accommodation.
 */
function codeWire() {
  const doc = [
    ...applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'code', lang: 'mermaid', code: 'flowchart TD\n  A-->B' },
        { op: 'add_block', page: 'main', kind: 'code', code: '没有语言的一段' },
        { op: 'add_block', page: 'main', kind: 'prose', markdown: '```mermaid\nsequenceDiagram\n  A->>B: 你好\n```' },
      ],
    }),
  ].reduce((state, event) => foldBoard(state, event), emptyBoardDoc('sess-render'))
  return boardWireSchema.parse(toWire(doc))
}

/** Render a board built from one of the wire fixtures above. */
function renderWire(wire) {
  return render(client.BoardView(props({ useProjection: (key) => (key === 'board' ? wire : undefined) })))
}

test('both a code block and a fenced paragraph tag their code with the language', () => {
  const classNames = elements(renderWire(codeWire()))
    .filter((node) => node.type === 'code')
    .map((node) => node.props.className)

  assert.equal(
    classNames.filter((name) => name === 'language-mermaid').length,
    2,
    `the block path and the fence path must agree, saw ${classNames.join(' | ')}`,
  )
  assert.equal(
    classNames.filter((name) => name === undefined).length,
    1,
    'a block with no language gets no class, rather than an empty or invented one',
  )
})

test('the language class names a language, and says nothing when there is not one', () => {
  assert.equal(client.codeClass('ts'), 'language-ts')
  assert.equal(client.codeClass('mermaid'), 'language-mermaid')
  // `language-undefined` would be a lie about the content, and the renderers that read this class
  // treat any `language-` prefix as a claim worth acting on.
  assert.equal(client.codeClass(undefined), undefined)
  assert.equal(client.codeClass(''), undefined)
})

test('a diagram shows its source until the runtime resolves, tagged for a plugin to find', () => {
  // The loading and failing states are the same shape on purpose: in both, the thing on screen is
  // what the Agent wrote. A card that went blank would hide the only text either party can act on.
  const tree = render(client.BoardView(props()))
  const diagram = elements(tree).find((node) => node.props['data-superboard-diagram'] !== undefined)
  assert.ok(diagram !== undefined, 'a uml block must render as a diagram card')

  const text = textOf(diagram).join(' ')
  assert.match(text, /flowchart TD/, 'the source stays visible while the runtime loads')
  assert.match(text, /正在渲染图/)

  const code = elements(diagram).find((node) => node.type === 'code')
  assert.equal(code.props.className, 'language-mermaid', 'the fallback is tagged as mermaid too')
})

test('a diagram document becomes a data URL that cannot escape the attribute it is written into', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>a &amp; "b"</text></svg>'
  const url = client.svgDataUrl(svg)

  assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'), url.slice(0, 40))
  assert.ok(!url.includes('<'), 'markup must not survive into the URL')
  assert.ok(!url.includes('"'), 'a quote here would close the src attribute early')
  assert.equal(decodeURIComponent(url.slice('data:image/svg+xml;charset=utf-8,'.length)), svg)
})

test('a file path becomes a URL the host route can read', () => {
  // Windows paths carry a colon and backslashes, and a user's filename carries whatever it likes.
  // The query string has to survive all of it, so it is encoded rather than interpolated.
  const url = client.fileUrl('E:\\参考 资料\\shot 1.png')
  assert.ok(url.startsWith('/api/file?path='), url)
  assert.ok(!url.includes(' '), 'a space must be encoded')
  assert.equal(decodeURIComponent(url.slice('/api/file?path='.length)), 'E:\\参考 资料\\shot 1.png')
})

test('the client and the host agree on what a report is retired by', () => {
  // Both halves compute this, on purpose: the client half is a classic script served through the
  // plugin loader and cannot import `src/runtime.js`. A drift between them would be silent — the
  // report would simply never surface — so the agreement is asserted here rather than assumed.
  const blocks = [
    { kind: 'uml', source: 'flowchart TD\n  A-->B' },
    { kind: 'image', src: 'E:\\shot.png' },
    { kind: 'pdf-page', src: 'E:\\doc.pdf', page: 3 },
    { kind: 'heading', text: '没有可渲染的东西' },
  ]
  for (const block of blocks) {
    assert.equal(
      client.renderInput(block),
      renderInputKey(block),
      `${block.kind}: the two halves must derive the same key`,
    )
  }
  // `undefined` is the answer for a kind that cannot fail to render, and it has to be `undefined`
  // on both sides — a report is refused outright when its key is not a string.
  assert.equal(client.renderInput({ kind: 'prose', markdown: 'x' }), undefined)
})

test('a picture points at the host file route, and an unreadable one reports why', () => {
  fetchCalls.length = 0
  const block = { id: 'bl_shot', slug: 'shot', kind: 'image', src: 'E:\\gone.png', alt: '截图' }
  const tree = render(client.Picture({ block, sessionId: 'sess-1' }))

  const image = elements(tree).find((node) => node.type === 'img')
  assert.ok(image !== undefined, 'a picture block renders an img')
  assert.equal(image.props.src, '/api/file?path=E%3A%5Cgone.png')
  assert.equal(image.props.alt, '截图')

  image.props.onError()
  assert.equal(fetchCalls.length, 1, 'an image that will not decode is reported once')
  const [url, init] = fetchCalls[0]
  assert.equal(url, '/dsh-superboard/render-report')
  const body = JSON.parse(init.body)
  assert.equal(body.blockId, 'bl_shot')
  assert.equal(body.input, 'E:\\gone.png', 'the report is keyed by the path, not by a source it has not got')
  assert.ok(body.message.includes('E:\\gone.png'), 'the message names the path too')
})

test('a picture that could not be read shows which path failed, and no broken image', () => {
  // The only thing either party can act on is *which* path went missing, so the failure state has
  // to name it — and it must not leave a browser broken-image glyph standing in for an explanation.
  const original = fakeReact.useState
  fakeReact.useState = () => [true, () => {}]
  try {
    const block = { id: 'bl_shot', slug: 'shot', kind: 'image', src: 'E:\\gone.png', alt: '截图' }
    const tree = render(client.Picture({ block, sessionId: 'sess-1' }))
    assert.ok(textOf(tree).join(' ').includes('E:\\gone.png'), 'the failed path is named on screen')
    assert.equal(
      elements(tree).some((node) => node.type === 'img'),
      false,
      'the broken image is replaced rather than shown',
    )
  } finally {
    fakeReact.useState = original
  }
})

test('one PDF is opened once, however many of its pages are on the board', async () => {
  // Three page blocks of one document are one download and one parse. The assets are named on the
  // same options object because PDFs routinely need a CMap or a standard font, and a missing one
  // shows up as wrong glyphs rather than as an error.
  const calls = []
  const pdfjs = {
    getDocument: (options) => {
      calls.push(options)
      return { promise: Promise.resolve({ numPages: 8 }) }
    },
  }

  const first = client.openDocument(pdfjs, 'E:\\共享\\spec.pdf')
  const second = client.openDocument(pdfjs, 'E:\\共享\\spec.pdf')
  assert.equal(first, second, 'the second page joins the first load rather than starting another')
  assert.equal((await first).numPages, 8)
  assert.equal(calls.length, 1)

  assert.equal(calls[0].url, '/api/file?path=E%3A%5C%E5%85%B1%E4%BA%AB%5Cspec.pdf')
  assert.equal(calls[0].cMapUrl, '/dsh-superboard/pdfjs/assets/cmaps/')
  assert.equal(calls[0].cMapPacked, true)
  assert.equal(calls[0].standardFontDataUrl, '/dsh-superboard/pdfjs/assets/standard_fonts/')
  assert.equal(calls[0].wasmUrl, '/dsh-superboard/pdfjs/assets/wasm/')
})

test('a PDF that would not open is not remembered as unopenable', async () => {
  // The likeliest failure is a path the Agent has just been told is wrong, so the next attempt has
  // to be a real attempt: a cached rejection would keep the card broken after the file appeared.
  let attempts = 0
  const pdfjs = {
    getDocument: () => {
      attempts += 1
      return {
        promise: attempts === 1 ? Promise.reject(new Error('404 not a regular file')) : Promise.resolve({ numPages: 2 }),
      }
    },
  }

  await assert.rejects(client.openDocument(pdfjs, 'E:\\moved.pdf'), /404/)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await client.openDocument(pdfjs, 'E:\\moved.pdf')).numPages, 2)
  assert.equal(attempts, 2, 'the failure was forgotten, so the retry reached the loader')
})

test('a pdf page renders a canvas tagged with the document and the page', () => {
  const block = { id: 'bl_pdf', slug: 'spec', kind: 'pdf-page', src: 'E:\\spec.pdf', page: 4 }
  const tree = render(client.PdfPage({ block, sessionId: 'sess-1' }))

  const canvas = elements(tree).find((node) => node.type === 'canvas')
  assert.ok(canvas !== undefined, 'a pdf block renders a canvas')
  assert.equal(canvas.props['data-superboard-pdf'], 'E:\\spec.pdf#4')
  // White in both themes, so showing it before there is anything on it would flash a light
  // rectangle into a dark board.
  assert.match(canvas.props.className, /sb-pdfPending/)
  assert.match(textOf(tree).join(' '), /正在渲染/)
})

test('a pdf page that could not be drawn names the page it tried', () => {
  // "8 pages, no page 12" is the mistake this is most likely to see, and it is precisely the kind
  // of thing the Agent cannot work out on its own — only pdf.js knows the page count.
  const original = fakeReact.useState
  fakeReact.useState = () => [{ status: 'failed', message: '这份 PDF 一共 8 页，没有第 12 页' }, () => {}]
  try {
    const block = { id: 'bl_pdf', slug: 'spec', kind: 'pdf-page', src: 'E:\\spec.pdf', page: 12 }
    const tree = render(client.PdfPage({ block, sessionId: 'sess-1' }))
    const text = textOf(tree).join(' ')

    assert.match(text, /没有第 12 页/)
    assert.match(text, /E:\\spec\.pdf 第 12 页/, 'the card still says which page of which file')
    assert.equal(
      elements(tree).some((node) => node.type === 'canvas'),
      false,
      'an empty canvas is replaced rather than left standing',
    )
  } finally {
    fakeReact.useState = original
  }
})
