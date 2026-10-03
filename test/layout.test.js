/**
 * Container-model tests.
 *
 * The layout grill split "where things go" from "what to look at":
 *
 *   - **`group`** is the layout container. It nests, and it carries a `layout`.
 *   - **`region`** is annotation. It has a tone and a label and **no layout at all**, so a
 *     highlight can sit inside a layout without fighting it.
 *
 * None of this was covered before the change — the old code forbade nesting outright and the suite
 * never exercised it — so these tests exist as much to pin the new rules as to prove the old ones
 * gone. The whole tree is also checked end to end: a nested container and an `at` offset both have
 * to survive the wire projection, because a field the fold produces but the wire schema omits takes
 * the board view down at runtime with every unit test still green.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { foldBoard } from '../src/fold.js'
import { emptyBoardDoc, BOARD_MODEL_VERSION, LAYOUT_TEMPLATES } from '../src/model.js'
import { boardWireSchema } from '../src/schema.js'

const SESSION = 'sess-layout'

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

/** Fold one batch, which is what most of these tests want. */
function apply(seq, ops, callId = `c${seq}`) {
  return fold(applied(seq, callId, { ops }))
}

/** Project a board the way the client receives it. */
function wireOf(state) {
  return boardWireSchema.parse({ modelVersion: state.modelVersion, model: state.model, diag: state.diag })
}

const heading = (text) => ({ op: 'add_block', page: 'main', kind: 'heading', level: 2, text })

/** The default page's blocks. */
const blocksOf = (state) => state.model.pages[0].blocks
/** Find a block by slug. */
const find = (state, slug) => blocksOf(state).find((block) => block.slug === slug)
/** Find the only block of a kind, for tests where the derived slug is not the point. */
const findByKind = (state, kind) => blocksOf(state).filter((block) => block.kind === kind)

// ---------------------------------------------------------------------------
// The template vocabulary
// ---------------------------------------------------------------------------

test('the vocabulary is the CSS-shaped set, with `row` in and `tree` out', () => {
  assert.deepEqual([...LAYOUT_TEMPLATES], ['flow', 'row', 'columns', 'grid', 'canvas'])
  // A group nested in a group *is* a tree, so having a `tree` template as well would be two ways to
  // say one thing.
  assert.equal(LAYOUT_TEMPLATES.includes('tree'), false)
})

test('the model version moved, which is what forces an old checkpoint to re-fold', () => {
  assert.equal(BOARD_MODEL_VERSION, 2)
  assert.equal(emptyBoardDoc(SESSION).modelVersion, 2)
})

// ---------------------------------------------------------------------------
// Groups nest
// ---------------------------------------------------------------------------

test('a group may contain a group', () => {
  let state = apply(10, [
    heading('甲'),
    heading('乙'),
    { op: 'add_block', page: 'main', kind: 'group', title: '内层', children: ['甲', '乙'] },
    { op: 'add_block', page: 'main', kind: 'group', title: '外层', children: ['内层'] },
  ])
  assert.equal(state.lastOpError, undefined, 'the batch applies')

  const outer = find(state, '外层')
  const inner = find(state, '内层')
  assert.deepEqual(outer.children, [inner.id])
  assert.deepEqual(inner.children, [find(state, '甲').id, find(state, '乙').id])
})

test('nesting goes deeper than two levels', () => {
  const state = apply(10, [
    heading('叶子'),
    { op: 'add_block', page: 'main', kind: 'group', title: 'L1', children: ['叶子'] },
    { op: 'add_block', page: 'main', kind: 'group', title: 'L2', children: ['L1'] },
    { op: 'add_block', page: 'main', kind: 'group', title: 'L3', children: ['L2'] },
  ])
  assert.equal(state.lastOpError, undefined)
  assert.deepEqual(find(state, 'L3').children, [find(state, 'L2').id])
  assert.deepEqual(find(state, 'L1').children, [find(state, '叶子').id])
})

test('a block still belongs to at most one group', () => {
  // Exclusive membership is what makes the structure a forest, and a forest is what makes a cycle
  // impossible without needing a traversal to detect one.
  const state = apply(10, [
    heading('共享'),
    { op: 'add_block', page: 'main', kind: 'group', title: 'A', children: ['共享'] },
    { op: 'add_block', page: 'main', kind: 'group', title: 'B', children: ['共享'] },
  ])
  assert.ok(state.lastOpError !== undefined)
  assert.match(state.lastOpError.message, /already belongs to another group/)
  assert.equal(find(state, 'B'), undefined, 'the failed batch changed nothing')
})

test('a group cannot contain itself', () => {
  const first = apply(10, [{ op: 'add_block', page: 'main', kind: 'group', title: '自指', children: [] }])
  const group = find(first, '自指')
  const second = foldBoard(first, {
    type: 'tool/call',
    seq: 30,
    data: { callId: 'c30', name: 'board_apply', arguments: JSON.stringify({ ops: [{ op: 'update_block', block: '自指', children: ['自指'] }] }) },
  })
  const settled = foldBoard(second, {
    type: 'tool/result',
    seq: 31,
    data: { message: { toolCallId: 'c30', isError: false, content: [] } },
  })

  assert.ok(settled.lastOpError !== undefined)
  assert.match(settled.lastOpError.message, /cannot contain itself/)
  assert.deepEqual(find(settled, group.slug).children, [])
})

test('a block listed twice in one group is refused', () => {
  const state = apply(10, [
    heading('重复'),
    { op: 'add_block', page: 'main', kind: 'group', title: 'G', children: ['重复', '重复'] },
  ])
  assert.ok(state.lastOpError !== undefined)
  assert.match(state.lastOpError.message, /listed twice/)
})

test('update_block can re-parent and may re-adopt its own former children', () => {
  // The owner scan excludes the group being patched, which is what lets a container be edited
  // without first emptying it.
  const first = apply(10, [
    heading('甲'),
    heading('乙'),
    { op: 'add_block', page: 'main', kind: 'group', title: 'G', children: ['甲'] },
  ])
  const second = foldBoard(first, {
    type: 'tool/call',
    seq: 30,
    data: {
      callId: 'c30',
      name: 'board_apply',
      arguments: JSON.stringify({ ops: [{ op: 'update_block', block: 'G', children: ['甲', '乙'] }] }),
    },
  })
  const settled = foldBoard(second, {
    type: 'tool/result',
    seq: 31,
    data: { message: { toolCallId: 'c30', isError: false, content: [] } },
  })

  assert.equal(settled.lastOpError, undefined)
  assert.deepEqual(find(settled, 'G').children, [find(settled, '甲').id, find(settled, '乙').id])
})

test('non-groups cannot take children or a layout', () => {
  const state = apply(10, [heading('甲'), heading('乙')])
  for (const op of [
    { op: 'update_block', block: '甲', children: ['乙'] },
    { op: 'update_block', block: '甲', layout: { template: 'row' } },
  ]) {
    const next = foldBoard(state, {
      type: 'tool/call',
      seq: 30,
      data: { callId: 'c30', name: 'board_apply', arguments: JSON.stringify({ ops: [op] }) },
    })
    const settled = foldBoard(next, {
      type: 'tool/result',
      seq: 31,
      data: { message: { toolCallId: 'c30', isError: false, content: [] } },
    })
    assert.ok(settled.lastOpError !== undefined, `${JSON.stringify(op)} should be refused`)
    assert.match(settled.lastOpError.message, /only a group/)
  }
})

// ---------------------------------------------------------------------------
// Layout: pages and groups, never regions
// ---------------------------------------------------------------------------

test('set_layout addresses a page', () => {
  const state = apply(10, [
    heading('甲'),
    { op: 'set_layout', scope: 'main', template: 'columns', cols: 2 },
  ])
  assert.equal(state.lastOpError, undefined)
  assert.equal(state.model.pages[0].layout.template, 'columns')
  assert.equal(state.model.pages[0].layout.params.cols, 2)
})

test('set_layout addresses a group, which is the whole point of nesting', () => {
  const state = apply(10, [
    heading('甲'),
    { op: 'add_block', page: 'main', kind: 'group', title: '簇', children: ['甲'] },
    { op: 'set_layout', scope: '簇', template: 'row' },
  ])
  assert.equal(state.lastOpError, undefined)
  assert.equal(find(state, '簇').layout.template, 'row')
})

test('a group can be created with a layout in one transaction', () => {
  const state = apply(10, [
    heading('甲'),
    { op: 'add_block', page: 'main', kind: 'group', title: '簇', children: ['甲'], layout: { template: 'grid', params: { minCardWidth: 300 } } },
  ])
  assert.equal(state.lastOpError, undefined)
  const group = find(state, '簇')
  assert.equal(group.layout.template, 'grid')
  assert.equal(group.layout.params.minCardWidth, 300)
})

test('set_layout refuses a region, and says what to use instead', () => {
  const state = apply(10, [
    heading('甲'),
    heading('乙'),
    { op: 'set_region', blockIds: ['甲', '乙'], label: '重点', tone: 'warn' },
    { op: 'set_layout', scope: '重点', template: 'row' },
  ])
  assert.ok(state.lastOpError !== undefined)
  assert.match(state.lastOpError.message, /no page or group/)
  // The message has to name the alternative, or the Agent is left guessing at a dead end.
  assert.match(state.lastOpError.message, /groups:/)
})

test('an unknown template is refused', () => {
  const state = apply(10, [heading('甲'), { op: 'set_layout', scope: 'main', template: 'tree' }])
  assert.ok(state.lastOpError !== undefined, '`tree` is no longer a template')
  assert.match(state.lastOpError.message, /layout template/)
})

// ---------------------------------------------------------------------------
// Regions are annotation
// ---------------------------------------------------------------------------

test('a region carries a tone and a label, and no layout', () => {
  const state = apply(10, [
    heading('甲'),
    heading('乙'),
    { op: 'set_region', blockIds: ['甲', '乙'], label: '重点', tone: 'danger' },
  ])
  assert.equal(state.lastOpError, undefined)
  const region = state.model.regions[0]
  assert.equal(region.label, '重点')
  assert.equal(region.tone, 'danger')
  assert.equal('layout' in region, false, 'a region must not carry a layout')
  // Membership is mirrored onto the blocks, so the renderer can tone them without a lookup.
  assert.equal(find(state, '甲').regionId, region.id)
  assert.equal(find(state, '乙').regionId, region.id)
})

test('membership is exclusive: a block moves between regions rather than joining both', () => {
  const state = apply(10, [
    heading('甲'),
    heading('乙'),
    { op: 'set_region', blockIds: ['甲'], label: 'A' },
    { op: 'set_region', blockIds: ['乙'], label: 'B' },
    { op: 'set_region', region: 'B', blockIds: ['甲', '乙'] },
  ])
  assert.equal(state.lastOpError, undefined)
  assert.equal(state.model.regions.length, 2)
  assert.deepEqual(state.model.regions.find((region) => region.slug === 'A').blockIds, [])
  assert.equal(find(state, '甲').regionId, state.model.regions.find((region) => region.slug === 'B').id)
})

test('deleting a region keeps its blocks and clears their tone', () => {
  const state = apply(10, [
    heading('甲'),
    { op: 'set_region', blockIds: ['甲'], label: '重点', tone: 'ok' },
    { op: 'delete_region', region: '重点' },
  ])
  assert.equal(state.lastOpError, undefined)
  assert.equal(state.model.regions.length, 0)
  assert.equal(find(state, '甲').regionId, undefined, 'the block survives without a region')
})

// ---------------------------------------------------------------------------
// Coordinates are an escape hatch, not a layout
// ---------------------------------------------------------------------------

test('an explicit position round-trips, including its size', () => {
  const state = apply(10, [
    { op: 'add_block', page: 'main', kind: 'prose', markdown: '绝对定位', at: { x: 40, y: 120, w: 320, h: 180 } },
  ])
  assert.equal(state.lastOpError, undefined)
  assert.deepEqual(findByKind(state, 'prose')[0].at, { x: 40, y: 120, w: 320, h: 180 })
})

test('a position with no size is legal — the block keeps its measured height', () => {
  const state = apply(10, [{ op: 'add_block', page: 'main', kind: 'prose', markdown: 'x', at: { x: 10, y: 20 } }])
  assert.deepEqual(findByKind(state, 'prose')[0].at, { x: 10, y: 20 })
})

test('changing a position changes the revision, because it is content', () => {
  const first = apply(10, [{ op: 'add_block', page: 'main', kind: 'prose', markdown: 'x' }])
  const moved = apply(10, [{ op: 'add_block', page: 'main', kind: 'prose', markdown: 'x', at: { x: 0, y: 0 } }])
  assert.notEqual(first.model.rev, moved.model.rev)
})

test('changing a container layout changes the revision too', () => {
  const base = [
    heading('甲'),
    { op: 'add_block', page: 'main', kind: 'group', title: '簇', children: ['甲'] },
  ]
  const flow = apply(10, base)
  const row = apply(10, [...base, { op: 'set_layout', scope: '簇', template: 'row' }])
  assert.notEqual(flow.model.rev, row.model.rev)
})

// ---------------------------------------------------------------------------
// The tree and the escape hatch both reach the client
// ---------------------------------------------------------------------------

test('a nested container, its layout, a region tone and an offset all survive the wire schema', () => {
  const state = apply(10, [
    { op: 'add_block', page: 'main', kind: 'prose', markdown: '自由定位', at: { x: 12, y: 34 } },
    heading('甲'),
    { op: 'add_block', page: 'main', kind: 'group', title: '内层', children: ['甲'], layout: { template: 'row' } },
    { op: 'add_block', page: 'main', kind: 'group', title: '外层', children: ['内层'], layout: { template: 'columns', params: { cols: 3 } } },
    { op: 'set_region', blockIds: ['甲'], label: '重点', tone: 'warn' },
  ])
  assert.equal(state.lastOpError, undefined)

  // Parsing throws rather than degrading, so a shape the schema does not know would break the view
  // at runtime while every unit test here still passed.
  const wire = wireOf(state)
  const outer = wire.model.pages[0].blocks.find((block) => block.slug === '外层')
  const inner = wire.model.pages[0].blocks.find((block) => block.slug === '内层')

  assert.deepEqual(outer.children, [inner.id])
  assert.equal(outer.layout.template, 'columns')
  assert.equal(outer.layout.params.cols, 3)
  assert.equal(inner.layout.template, 'row')
  assert.equal(wire.model.regions[0].tone, 'warn')
  assert.equal(wire.model.pages[0].blocks.find((block) => block.kind === 'prose').at.x, 12)
})

test('the whole tree folds identically twice, nested containers included', () => {
  const events = applied(10, 'c1', {
    ops: [
      heading('甲'),
      { op: 'add_block', page: 'main', kind: 'group', title: '内层', children: ['甲'] },
      { op: 'add_block', page: 'main', kind: 'group', title: '外层', children: ['内层'], layout: { template: 'row' } },
    ],
  })
  assert.equal(JSON.stringify(fold(events).model), JSON.stringify(fold(events).model))
})
