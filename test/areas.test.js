/**
 * `areas` tests: a container naming which child sits in which cell.
 *
 * `grid` used to mean "auto-fill with a minimum card width", which cannot express a span — a card
 * across the top with two below it, or a tall card beside a stack. `areas` adds that without adding
 * coordinates: a cell holds a **child reference**, the same vocabulary `children` already uses, so
 * the Agent names things it has already named.
 *
 * The split these tests pin is *where the work happens*. The fold checks the template against the
 * children, while it still has the page; `toWire` resolves names into grid line numbers, because it
 * is the only thing that spans host and client. `layout.params` is an open record on both schemas,
 * so the resolved cells reach the renderer **without the document ever carrying them** — only the
 * authored template enters the hash.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { foldBoard } from '../src/fold.js'
import { emptyBoardDoc, parseAreas, resolveAreas } from '../src/model.js'
import { boardWireSchema, toWire } from '../src/schema.js'

const SESSION = 'sess-areas'

/** Fold synthetic events into a board. */
function fold(events) {
  return events.reduce((state, event) => foldBoard(state, event), emptyBoardDoc(SESSION))
}

/** One committed `board_apply` call. Arguments are stringified as DSH commits them. */
function applied(seq, callId, args) {
  return [
    { type: 'tool/call', seq, data: { callId, name: 'board_apply', arguments: JSON.stringify(args) } },
    { type: 'tool/result', seq: seq + 1, data: { message: { toolCallId: callId, isError: false, content: [] } } },
  ]
}

/** Fold one batch. */
function apply(seq, ops, callId = `c${seq}`) {
  return fold(applied(seq, callId, { ops }))
}

/** Project a board the way the client receives it. */
function wireOf(state) {
  return boardWireSchema.parse(toWire(state))
}

const blocksOf = (state) => state.model.pages[0].blocks
const find = (state, slug) => blocksOf(state).find((block) => block.slug === slug)
const cellsOf = (wire, slug) => wire.model.pages[0].blocks.find((block) => block.slug === slug).layout.params.cells
const idOf = (state, slug) => find(state, slug).id

/** Three sibling cards, which is enough to build every shape below. */
function threeCards() {
  return apply(1, [
    { op: 'add_block', page: 'main', kind: 'heading', slug: 'arch', level: 2, text: '架构总览' },
    { op: 'add_block', page: 'main', kind: 'prose', slug: 'intro', markdown: '导语。' },
    { op: 'add_block', page: 'main', kind: 'prose', slug: 'notes', markdown: '附注。' },
  ])
}

/** A grid group over those cards, with the given `areas` and nothing else. */
function grouped(state, areas, template = 'grid') {
  const [call, result] = applied(2, 'c2', {
    ops: [
      {
        op: 'add_block',
        page: 'main',
        kind: 'group',
        slug: 'pipeline',
        title: '管线',
        children: ['arch', 'intro', 'notes'],
        layout: { template, params: { areas } },
      },
    ],
  })
  return foldBoard(foldBoard(state, call), result)
}

// ---------------------------------------------------------------------------
// Parsing: one shape, two spellings
// ---------------------------------------------------------------------------

test('rows parse from an array, from slashes, and from newlines', () => {
  const expected = [
    ['arch', 'arch'],
    ['intro', 'notes'],
  ]
  assert.deepEqual(parseAreas(['arch arch', 'intro notes']).rows, expected)
  assert.deepEqual(parseAreas('arch arch/intro notes').rows, expected)
  assert.deepEqual(parseAreas('arch arch\nintro notes').rows, expected)
})

test('a hole is a cell nothing occupies', () => {
  const parsed = parseAreas(['arch .', '. notes'])
  assert.deepEqual(parsed.rows, [
    ['arch', '.'],
    ['.', 'notes'],
  ])
})

test('ragged rows are refused, naming both counts', () => {
  const parsed = parseAreas(['a b c', 'd e'])
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'areas row 2 has 2 cells; row 1 has 3')
})

test('an empty or shapeless template is refused rather than treated as no template', () => {
  assert.equal(parseAreas([]).ok, false)
  assert.equal(parseAreas('   ').ok, false)
  assert.equal(parseAreas(42).ok, false)
  assert.equal(parseAreas(['']).ok, false)
})

test('CJK slugs are legal cell names', () => {
  // The reason the template is parsed here instead of handed to CSS: `grid-template-areas` needs
  // identifiers, so 投影层 would have had to be escaped — and a bad declaration is dropped silently.
  const parsed = parseAreas(['投影层 模型层', '渲染层 渲染层'])
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.rows[1], ['渲染层', '渲染层'])
})

// ---------------------------------------------------------------------------
// Resolution: names to line numbers
// ---------------------------------------------------------------------------

test('a resolved cell carries its line numbers and its span', () => {
  const children = [
    { id: 'i1', slug: 'arch', alias: [] },
    { id: 'i2', slug: 'intro', alias: [] },
    { id: 'i3', slug: 'notes', alias: [] },
  ]
  const resolved = resolveAreas(parseAreas(['arch arch', 'intro notes']).rows, children)
  assert.equal(resolved.ok, true)
  assert.deepEqual(resolved.cells.i1, { row: 1, col: 1, rowSpan: 1, colSpan: 2 })
  assert.deepEqual(resolved.cells.i2, { row: 2, col: 1, rowSpan: 1, colSpan: 1 })
  assert.deepEqual(resolved.cells.i3, { row: 2, col: 2, rowSpan: 1, colSpan: 1 })
  assert.equal(resolved.cols, 2)
  assert.equal(resolved.rows, 2)
})

test('a tall cell spans rows', () => {
  const children = [
    { id: 'i1', slug: 'arch', alias: [] },
    { id: 'i2', slug: 'intro', alias: [] },
  ]
  const resolved = resolveAreas(parseAreas(['arch intro', 'arch .']).rows, children)
  assert.deepEqual(resolved.cells.i1, { row: 1, col: 1, rowSpan: 2, colSpan: 1 })
})

test('a retired alias resolves, so renaming a block does not break a template', () => {
  const children = [{ id: 'i1', slug: '架构', alias: ['arch'] }]
  const resolved = resolveAreas(parseAreas(['arch']).rows, children)
  assert.equal(resolved.ok, true)
  assert.deepEqual(resolved.cells.i1, { row: 1, col: 1, rowSpan: 1, colSpan: 1 })
})

test('an unknown name is refused, and the error lists the children', () => {
  const children = [{ id: 'i1', slug: 'arch', alias: [] }]
  const resolved = resolveAreas(parseAreas(['nope']).rows, children)
  assert.equal(resolved.ok, false)
  assert.equal(
    resolved.error,
    'areas names "nope", which is not a child of this container; its children are arch',
  )
})

test('an L-shaped region is refused, naming the rows and columns it covers', () => {
  const children = [{ id: 'i1', slug: 'arch', alias: [] }]
  const resolved = resolveAreas(parseAreas(['arch . arch', '. . arch']).rows, children)
  assert.equal(resolved.ok, false)
  assert.equal(
    resolved.error,
    'areas gives "arch" a region that is not a rectangle: rows 1-2, columns 1 and 3',
  )
})

test('two names for one block are refused rather than one silently winning', () => {
  // A slug and its retired alias both naming a cell would otherwise place the block twice, and the
  // second placement would overwrite the first with no hint that anything was dropped.
  const children = [{ id: 'i1', slug: '架构', alias: ['arch'] }]
  const resolved = resolveAreas(parseAreas(['架构 arch']).rows, children)
  assert.equal(resolved.ok, false)
  assert.match(resolved.error, /already has a region/)
})

// ---------------------------------------------------------------------------
// Through a real board: the fold validates, the projection resolves
// ---------------------------------------------------------------------------

test('a grid group with areas folds, and the wire carries the resolved cells', () => {
  const state = grouped(threeCards(), ['arch arch', 'intro notes'])
  assert.equal(state.lastOpError, undefined)

  const wire = wireOf(state)
  const cells = cellsOf(wire, 'pipeline')
  assert.deepEqual(cells[idOf(state, 'arch')], { row: 1, col: 1, rowSpan: 1, colSpan: 2 })
  assert.deepEqual(cells[idOf(state, 'notes')], { row: 2, col: 2, rowSpan: 1, colSpan: 1 })
  assert.equal(find(wire, 'pipeline').layout.params.cols, 2)
  assert.equal(find(wire, 'pipeline').layout.params.rows, 2)
})

test('the document never carries the resolved cells', () => {
  // Only the authored template is content. A derived cell in the document would enter the hash and
  // make the revision depend on the projection, which the design forbids.
  const state = grouped(threeCards(), ['arch arch', 'intro notes'])
  const stored = find(state, 'pipeline').layout.params
  assert.deepEqual(stored.areas, ['arch arch', 'intro notes'])
  assert.equal('cells' in stored, false)
  assert.equal('rows' in stored, false)
  assert.equal('cols' in stored, false)
})

test('the stored template is canonical, however it was spelled', () => {
  const state = grouped(threeCards(), 'arch arch/intro notes')
  assert.deepEqual(find(state, 'pipeline').layout.params.areas, ['arch arch', 'intro notes'])
})

test('children the template does not name auto-flow instead of failing', () => {
  const state = grouped(threeCards(), ['arch .', '. .'])
  assert.equal(state.lastOpError, undefined)
  const cells = cellsOf(wireOf(state), 'pipeline')
  assert.equal(Object.keys(cells).length, 1)
  assert.equal(cells[idOf(state, 'arch')].colSpan, 1)
})

test('areas and cols are refused together rather than one winning', () => {
  const state = apply(1, [
    { op: 'add_block', page: 'main', kind: 'heading', slug: 'arch', level: 2, text: '甲' },
    {
      op: 'add_block',
      page: 'main',
      kind: 'group',
      slug: 'box',
      children: ['arch'],
      layout: { template: 'grid', params: { cols: 2, areas: ['arch arch'] } },
    },
  ])
  assert.match(state.lastOpError.message, /drop cols and minCardWidth/)
  // The batch is atomic, so nothing was created.
  assert.equal(find(state, 'box'), undefined)
})

test('areas on a template that has no columns is refused', () => {
  const state = apply(1, [
    { op: 'add_block', page: 'main', kind: 'heading', slug: 'arch', level: 2, text: '甲' },
    { op: 'add_block', page: 'main', kind: 'group', slug: 'box', children: ['arch'] },
    { op: 'set_layout', scope: 'box', template: 'row', areas: ['arch'] },
  ])
  assert.match(state.lastOpError.message, /areas is a grid parameter/)
})

test('a template naming a non-child is refused, and names the container', () => {
  const state = grouped(threeCards(), ['arch nope'])
  assert.match(state.lastOpError.message, /areas names "nope", which is not a child/)
  assert.match(state.lastOpError.message, /its children are arch, intro, notes/)
})

test('a non-rectangular region is refused through the tool layer too', () => {
  const state = grouped(threeCards(), ['arch . arch', '. . arch'])
  assert.match(state.lastOpError.message, /is not a rectangle/)
})

test('changing the template changes the revision', () => {
  const cards = threeCards()
  const wide = grouped(cards, ['arch arch', 'intro notes'])
  const tall = grouped(cards, ['arch intro', 'arch notes'])
  assert.notEqual(wide.model.rev, tall.model.rev)
})

test('a page can carry a template over the blocks no group claims', () => {
  const state = apply(1, [
    { op: 'add_block', page: 'main', kind: 'heading', slug: 'arch', level: 2, text: '甲' },
    { op: 'add_block', page: 'main', kind: 'prose', slug: 'intro', markdown: '乙' },
    { op: 'set_layout', scope: 'main', template: 'grid', areas: ['arch intro'] },
  ])
  assert.equal(state.lastOpError, undefined)
  const wire = wireOf(state)
  assert.deepEqual(wire.model.pages[0].layout.params.cells[idOf(state, 'intro')], {
    row: 1,
    col: 2,
    rowSpan: 1,
    colSpan: 1,
  })
})

test('a page template cannot name a block a group already arranges', () => {
  // The page arranges the blocks no group claims, so its vocabulary is the roots — here `box`, not
  // the `arch` inside it. Naming an inner block would place it in two geometries at once.
  const state = apply(1, [
    { op: 'add_block', page: 'main', kind: 'heading', slug: 'arch', level: 2, text: '甲' },
    { op: 'add_block', page: 'main', kind: 'group', slug: 'box', children: ['arch'] },
    { op: 'set_layout', scope: 'main', template: 'grid', areas: ['arch'] },
  ])
  assert.match(state.lastOpError.message, /areas names "arch", which is not a child/)
  assert.match(state.lastOpError.message, /its children are box/)
})

test('a layout update can set the template, and re-checks the names', () => {
  const state = apply(1, [
    { op: 'add_block', page: 'main', kind: 'heading', slug: 'arch', level: 2, text: '甲' },
    { op: 'add_block', page: 'main', kind: 'group', slug: 'box', children: ['arch'] },
    { op: 'update_block', block: 'box', layout: { template: 'grid', params: { areas: ['arch'] } } },
  ])
  assert.equal(state.lastOpError, undefined)
  assert.deepEqual(wireOf(state).model.pages[0].blocks.find((b) => b.slug === 'box').layout.params.cells, {
    [idOf(state, 'arch')]: { row: 1, col: 1, rowSpan: 1, colSpan: 1 },
  })

  const rejected = apply(1, [
    { op: 'add_block', page: 'main', kind: 'heading', slug: 'arch', level: 2, text: '甲' },
    { op: 'add_block', page: 'main', kind: 'group', slug: 'box', children: ['arch'] },
    { op: 'update_block', block: 'box', layout: { template: 'grid', params: { areas: ['ghost'] } } },
  ])
  assert.match(rejected.lastOpError.message, /areas names "ghost"/)
})

test('the whole tree folds identically twice, template included', () => {
  const ops = [
    { op: 'add_block', page: 'main', kind: 'heading', slug: 'arch', level: 2, text: '甲' },
    { op: 'add_block', page: 'main', kind: 'prose', slug: 'intro', markdown: '乙' },
    {
      op: 'add_block',
      page: 'main',
      kind: 'group',
      slug: 'box',
      children: ['arch', 'intro'],
      layout: { template: 'grid', params: { areas: ['arch intro'] } },
    },
  ]
  const once = apply(1, ops)
  const twice = apply(1, ops)
  assert.equal(once.model.rev, twice.model.rev)
  assert.deepEqual(once.model, twice.model)
})
