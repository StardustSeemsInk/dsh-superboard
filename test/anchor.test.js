/**
 * Edge-anchor tests.
 *
 * An edge endpoint is `{ blockId, at? }`, and `at` is a discriminated union saying *which part*
 * of the block the arrow points at — a field, a list item, a line range, a rectangle on an image.
 *
 * These exist because `validateAnchor` normalised that union with the block-position helper
 * (`normaliseAt`), which reads `x`/`y`/`w`/`h` and drops everything else. Every reachable anchor
 * kind therefore came out of the fold as `{ x: 0, y: 0 }`:
 *
 *   - `encodeAnchor` fell through to its `default: ... @unknown`, so different anchors hashed the
 *     same and a revision never moved;
 *   - `boardWireSchema` rejected the edge outright, and a rejected wire value takes the whole
 *     board view down — the "blank board" failure, reached this time by writing a valid edge.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { foldBoard } from '../src/fold.js'
import { emptyBoardDoc, encodeAnchor } from '../src/model.js'
import { boardWireSchema } from '../src/schema.js'

const SESSION = 'sess-anchor'

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

/** Fold one extra batch onto a board. */
function append(state, seq, ops) {
  const [call, result] = applied(seq, `c${seq}`, { ops })
  return foldBoard(foldBoard(state, call), result)
}

/** Project a board the way the client receives it. */
function wireOf(state) {
  return boardWireSchema.parse({ modelVersion: state.modelVersion, model: state.model, diag: state.diag })
}

/**
 * A board with one block per anchor-capable kind.
 *
 * The `allowed` table in `validateAnchor` pairs each anchor kind with block kinds, so the target
 * has to match the anchor for the test to be about normalisation rather than about rejection.
 */
function boardWithTargets() {
  return fold(
    applied(1, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'code', slug: 'snippet', lang: 'js', code: 'a\nb\nc' },
        { op: 'add_block', page: 'main', kind: 'list', slug: 'steps', items: ['one', 'two'] },
        { op: 'add_block', page: 'main', kind: 'prose', slug: 'intro', markdown: 'hello world' },
        { op: 'add_block', page: 'main', kind: 'group', slug: 'box', title: 'Box', children: [] },
        {
          op: 'add_block',
          page: 'main',
          kind: 'uml',
          slug: 'diagram',
          engine: 'mermaid',
          diagram: 'flowchart',
          source: 'graph TD; A-->B',
        },
        { op: 'add_block', page: 'main', kind: 'image', slug: 'shot', src: 'x.png', alt: 'shot' },
      ],
    }),
  )
}

/** The single edge of a board. */
const edgeOf = (state) => state.model.edges[0]

/** Add one edge onto `boardWithTargets()`, from `from` to `to`. */
function edgeFrom(state, from, to = 'intro') {
  return append(state, 2, [{ op: 'add_edge', from, to, rel: 'explains' }])
}

/** Every anchor kind, with a target block it is valid against. */
const KINDS = [
  ['field', { kind: 'field', field: 'code' }, 'snippet'],
  ['item', { kind: 'item', itemId: 'i1' }, 'steps'],
  ['lines', { kind: 'lines', from: 1, to: 2 }, 'snippet'],
  ['text', { kind: 'text', start: 0, end: 5 }, 'intro'],
  ['child', { kind: 'child', childId: 'anything' }, 'box'],
  ['node', { kind: 'node', key: 'A' }, 'diagram'],
  ['rect', { kind: 'rect', x: 4, y: 8, w: 20, h: 10 }, 'shot'],
  ['point', { kind: 'point', x: 12, y: 30 }, 'shot'],
]

// ---------------------------------------------------------------------------
// The regression these tests were written for
// ---------------------------------------------------------------------------

test('an anchor keeps its kind through the fold', () => {
  const state = edgeFrom(boardWithTargets(), { blockId: 'snippet', at: { kind: 'lines', from: 1, to: 2 } })
  assert.deepEqual(edgeOf(state).from.at, { kind: 'lines', from: 1, to: 2 })
})

test('a field anchor survives the wire projection', () => {
  const state = edgeFrom(boardWithTargets(), { blockId: 'snippet', at: { kind: 'field', field: 'code' } })
  assert.deepEqual(edgeOf(state).from.at, { kind: 'field', field: 'code' })
  // A rejected wire value blanks the whole board view, so this parse is the assertion that matters.
  assert.doesNotThrow(() => wireOf(state))
})

for (const [name, at, target] of KINDS) {
  test(`a ${name} anchor round-trips through the wire schema`, () => {
    const state = edgeFrom(boardWithTargets(), { blockId: target, at })
    assert.deepEqual(edgeOf(state).from.at, at)
    assert.deepEqual(wireOf(state).model.edges[0].from.at, at)
  })
}

test('an explicit block anchor stays a plain block target', () => {
  const state = edgeFrom(boardWithTargets(), { blockId: 'snippet', at: { kind: 'block' } })
  // `{ kind: 'block' }` is the default, so it normalises away rather than being stored.
  assert.equal(edgeOf(state).from.at, undefined)
})

test('a node key the diagram does not name is still an anchor', () => {
  // The node table is what a diagram says its parts are, not a set of restrictions on what may be
  // anchored. A parser that reads one mermaid version too narrowly must cost a missing line in a
  // listing; refusing the write would turn a display detail into a blocked edit.
  const state = edgeFrom(boardWithTargets(), {
    blockId: 'diagram',
    at: { kind: 'node', key: 'not-in-this-diagram' },
  })
  assert.deepEqual(edgeOf(state).from.at, { kind: 'node', key: 'not-in-this-diagram' })
})

test('an anchor without at is unchanged', () => {
  const state = edgeFrom(boardWithTargets(), 'snippet')
  assert.equal(edgeOf(state).from.at, undefined)
  assert.equal(edgeOf(state).from.blockId, boardWithTargets().model.pages[0].blocks[0].id)
})

// ---------------------------------------------------------------------------
// The hash: an anchor's location has to reach the revision, or nothing moves
// ---------------------------------------------------------------------------

test('two different anchors on the same block encode differently', () => {
  const lines = encodeAnchor({ blockId: 'b1', at: { kind: 'lines', from: 1, to: 2 } })
  const text = encodeAnchor({ blockId: 'b1', at: { kind: 'text', start: 1, end: 2 } })
  assert.notEqual(lines, text)
})

test('no valid anchor encodes as unknown', () => {
  for (const [name, at] of KINDS) {
    const encoded = encodeAnchor({ blockId: 'b1', at })
    assert.ok(!encoded.includes('unknown'), `${name} encoded as ${encoded}`)
    assert.ok(encoded.startsWith('b1@'), `${name} encoded as ${encoded}`)
  }
})

test('moving an anchor changes the revision', () => {
  const board = boardWithTargets()
  const before = edgeFrom(board, { blockId: 'snippet', at: { kind: 'lines', from: 1, to: 2 } })
  const after = edgeFrom(board, { blockId: 'snippet', at: { kind: 'lines', from: 1, to: 3 } })
  assert.notEqual(before.model.rev, after.model.rev)
})

// ---------------------------------------------------------------------------
// Rejections stay rejections
// ---------------------------------------------------------------------------

test('an unknown anchor kind is refused', () => {
  const state = edgeFrom(boardWithTargets(), { blockId: 'snippet', at: { kind: 'nonsense' } })
  assert.match(state.lastOpError.message, /at\.kind "nonsense" is not one of/)
})

test('an anchor kind the target block cannot carry is refused', () => {
  // `lines` needs a code block; `intro` is prose.
  const state = edgeFrom(boardWithTargets(), { blockId: 'intro', at: { kind: 'lines', from: 1, to: 2 } })
  assert.match(state.lastOpError.message, /needs a code block/)
})

test('an anchor with a missing required field is refused', () => {
  const state = edgeFrom(boardWithTargets(), { blockId: 'snippet', at: { kind: 'lines', from: 1 } })
  assert.equal(edgeOf(state), undefined)
  assert.ok(state.lastOpError !== undefined)
})

test('an anchor to a missing block is refused', () => {
  const state = edgeFrom(boardWithTargets(), 'nope')
  assert.match(state.lastOpError.message, /nope/)
})
