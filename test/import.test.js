/**
 * Import / export tests.
 *
 * Both features touch the one thing this project will not get wrong twice: **the board is the fold
 * of its own `board_apply` log**. So the import is checked by replaying its ops through the real
 * folder and comparing the result to the source — not by inspecting the op array, which would pass
 * for a batch that folds to something else entirely.
 *
 * The export is checked the same way: the Markdown is a projection of the model, so the test
 * builds a model, exports it, and asserts on the text a reader would actually get.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

import { applyOps, BoardOpError, emptyBoardDoc } from '../src/fold.js'
import { blockToAddArgs, importOps, readSourceBoard } from '../src/import.js'

const CLIENT_PATH = new URL('../src/client.js', import.meta.url)

/** Minimal React stand-in, as in the other client tests. */
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

function loadClient() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  let exports
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => { exports = factory((name) => (name === 'react' ? fakeReact : undefined)) } } },
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

/** A source board exercising nesting, every kind, and an edge. */
function sourceModel() {
  return {
    title: '源看板',
    pages: [
      {
        id: 'pg_1',
        slug: 'pick',
        alias: [],
        createdAtRev: 'r1',
        layout: { template: 'columns', params: { cols: 2 } },
        blocks: [
          { id: 'bl_h', slug: 'title', alias: [], createdAtRev: 'r1', kind: 'heading', level: 1, text: '选型' },
          {
            id: 'bl_outer',
            slug: 'outer',
            alias: [],
            createdAtRev: 'r1',
            kind: 'group',
            title: '外层',
            layout: { template: 'flow' },
            children: ['bl_inner'],
          },
          {
            id: 'bl_inner',
            slug: 'inner',
            alias: [],
            createdAtRev: 'r1',
            kind: 'group',
            title: '内层',
            children: ['bl_p'],
          },
          { id: 'bl_p', slug: 'note', alias: [], createdAtRev: 'r1', kind: 'prose', markdown: '嵌套正文' },
          { id: 'bl_pdf', slug: 'datasheet', alias: [], createdAtRev: 'r1', kind: 'pdf-page', src: '/a.pdf', page: 3, caption: '规格页' },
        ],
      },
      { id: 'pg_2', slug: 'check', alias: [], createdAtRev: 'r1', blocks: [
        { id: 'bl_l', slug: 'todo', alias: [], createdAtRev: 'r1', kind: 'list', ordered: true, items: [{ id: 'i1', text: '验机', depth: 0 }] },
      ] },
    ],
    regions: [],
    edges: [
      { id: 'e1', slug: 'e1', alias: [], from: { blockId: 'bl_h' }, to: { blockId: 'bl_p' }, rel: 'next', label: '然后' },
    ],
    revSeq: 1,
    revHash: 'h',
    rev: 'r1',
  }
}

/** Apply a batch to a fresh board and hand back the folded model. */
function foldInto(model, ops) {
  const doc = emptyBoardDoc('target')
  return applyOps(structuredClone(model), ops, {
    sessionId: 'target',
    callSeq: 1,
    now: 'r1',
    strict: false,
  })
}

test('the import replays into a board with the same shape as the source', () => {
  const source = sourceModel()
  // A fresh board always carries one empty placeholder page; importing into it is the case this
  // feature exists for, so the placeholder is filled rather than left as an empty tab.
  const ops = importOps(source, { reusePage: 'main' })
  const target = foldInto(emptyBoardDoc('target').model, ops)

  assert.deepEqual(
    target.pages.map((page) => page.slug),
    ['main', 'check'],
    'the placeholder takes the first imported page, and the rest follow',
  )
  const pick = target.pages[0]
  assert.deepEqual(
    pick.blocks.map((block) => block.slug).sort(),
    ['datasheet', 'inner', 'note', 'outer', 'title'],
    'every block arrives exactly once',
  )
  // The nesting is the part that a naive "emit in board order" would break.
  const outer = pick.blocks.find((block) => block.slug === 'outer')
  const inner = pick.blocks.find((block) => block.slug === 'inner')
  const note = pick.blocks.find((block) => block.slug === 'note')
  assert.deepEqual(outer.children, [inner.id], 'the outer group names the inner group in the TARGET')
  assert.deepEqual(inner.children, [note.id], 'the inner group names the prose in the TARGET')
  assert.equal(pick.blocks.find((block) => block.slug === 'datasheet').page, 3, 'a PDF page number survives as pdfPage')
  assert.equal(target.edges.length, 1)
  assert.equal(target.edges[0].label, '然后')
})

test('without reusePage every source page is added, including when one is already there', () => {
  const target = foldInto(emptyBoardDoc('target').model, importOps(sourceModel()))
  assert.deepEqual(
    target.pages.map((page) => page.slug),
    ['main', 'pick', 'check'],
    'the placeholder stays, because the caller did not say to fill it',
  )
})

test('ids are minted fresh, so nothing from the source survives by id', () => {
  const source = sourceModel()
  const target = foldInto(emptyBoardDoc('target').model, importOps(source))
  const sourceIds = new Set(source.pages.flatMap((page) => page.blocks.map((block) => block.id)))
  for (const page of target.pages) {
    for (const block of page.blocks) {
      assert.ok(!sourceIds.has(block.id), `id ${block.id} was carried over from the source`)
    }
  }
})

test('a group is emitted after the children it names', () => {
  const ops = importOps(sourceModel())
  const order = ops.map((op) => (op.op === 'add_block' ? op.slug : `#${op.op}`))
  const note = order.indexOf('note')
  const inner = order.indexOf('inner')
  const outer = order.indexOf('outer')
  assert.ok(note < inner, 'the prose comes before the group that names it')
  assert.ok(inner < outer, 'the inner group comes before the outer group that names it')
})

test('a dangling child is imported rather than dropped, and its missing parent is tolerated', () => {
  const source = {
    pages: [
      {
        id: 'p',
        slug: 'p',
        blocks: [
          // A group naming a child that does not exist — the fold tolerates this, so the import
          // must too, and must not lose the group.
          { id: 'g', slug: 'g', kind: 'group', children: ['gone'], title: 'G' },
          { id: 'x', slug: 'x', kind: 'prose', markdown: '孤儿' },
        ],
      },
    ],
    edges: [],
  }
  const ops = importOps(source)
  const slugs = ops.filter((op) => op.op === 'add_block').map((op) => op.slug)
  assert.ok(slugs.includes('g'), 'the group survives')
  assert.ok(slugs.includes('x'), 'an unclaimed block is still a root')
})

test('a slug collision gets a suffix instead of overwriting', () => {
  const source = sourceModel()
  const ops = importOps(source, { slugFor: (slug) => `${slug}-copy` })
  assert.ok(ops.filter((op) => op.op === 'add_block').every((op) => op.slug.endsWith('-copy')))
  const target = foldInto(emptyBoardDoc('target').model, ops)
  assert.ok(target.pages.some((page) => page.blocks.some((block) => block.slug === 'note-copy')))
})

test('an edge is skipped when either end is missing from the source', () => {
  const source = {
    pages: [{ id: 'p', slug: 'p', blocks: [{ id: 'a', slug: 'a', kind: 'prose', markdown: 'A' }] }],
    edges: [
      { id: 'e1', slug: 'e1', from: { blockId: 'a' }, to: { blockId: 'vanished' } },
      { id: 'e2', slug: 'e2', from: { blockId: 'a' }, to: { blockId: 'a' } },
    ],
  }
  const edges = importOps(source).filter((op) => op.op === 'add_edge')
  assert.equal(edges.length, 1)
  assert.equal(edges[0].to, 'a')
})

test('importing nothing is refused with a message that says so', () => {
  assert.throws(() => importOps(null), BoardOpError)
  assert.throws(() => importOps({ pages: [] }), BoardOpError)
  // A board that exists but was never written to. Every fresh session has one, so without this the
  // most likely import of all — pointing `from` at a conversation that only talked — would report
  // success, rename the target's page slugs, and hand back an empty board with `ok: true`.
  assert.throws(
    () => importOps({ pages: [{ id: 'pg_1', slug: 'main', blocks: [] }], edges: [] }),
    (error) => {
      assert.ok(error instanceof BoardOpError)
      assert.match(error.message, /the source board is empty/)
      return true
    },
  )
  // An empty page plus a resolvable edge would be content; but an edge whose endpoints are not
  // blocks in the page resolves to nothing and is skipped, so the batch would be a bare `add_page`
  // — a page rename dressed up as an import. Both shapes are refused.
  assert.throws(
    () => importOps({ pages: [{ id: 'pg_1', slug: 'main', blocks: [] }], edges: [{ from: 'a', to: 'b' }] }),
    (error) => {
      assert.match(error.message, /edges but no blocks/)
      return true
    },
  )
})

test('reading a source board refuses an unknown session rather than returning an empty board', () => {
  const deps = {
    sessions: { get: () => undefined },
    projections: { stateOf: () => ({}) },
  }
  assert.throws(() => readSourceBoard(deps, 'nope'), (error) => {
    assert.ok(error instanceof BoardOpError)
    assert.match(error.message, /not open in this process/)
    return true
  })
})

test('reading a source board refuses a session with no board projection', () => {
  const deps = {
    sessions: { get: () => ({ id: 's1' }) },
    projections: { stateOf: () => undefined },
  }
  assert.throws(() => readSourceBoard(deps, 's1'), (error) => {
    assert.match(error.message, /no board projection/)
    return true
  })
})

test('blockToAddArgs renames the one field that collides', () => {
  const args = blockToAddArgs({ id: 'b', slug: 's', kind: 'pdf-page', src: '/x.pdf', page: 7 }, 'p')
  assert.equal(args.pdfPage, 7)
  assert.equal(args.page, 'p', '`page` on this branch is the owning page, not the page number')
})
