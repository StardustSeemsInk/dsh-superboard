/**
 * Fold tests.
 *
 * The fold is the board's authority, and its correctness claims are specific and checkable:
 * a failed batch must not move the state, the same log must fold to the same board, and both
 * dispatch paths must reach the same result. These tests assert exactly those.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { foldBoard, applyOps, BoardOpError } from '../src/fold.js'
import { emptyBoardDoc, encodeModelForHash, toSlug, uniqSlug, quantise } from '../src/model.js'
import { boardDocSchema } from '../src/schema.js'

const SESSION = 'sess-test'

/** Fold a sequence of synthetic events, starting from an empty board. */
function foldAll(events) {
  return events.reduce((state, event) => foldBoard(state, event), emptyBoardDoc(SESSION))
}

/**
 * Build the ordinary-path event pair: `tool/call` then `tool/result`.
 *
 * Arguments are stringified on purpose. That is what DSH actually commits on this path —
 * the model streams a string and `appendToolCall` never parses it.
 */
function applied(seq, callId, args, { isError = false } = {}) {
  return [
    { type: 'tool/call', seq, data: { callId, name: 'board_apply', arguments: JSON.stringify(args) } },
    {
      type: 'tool/result',
      seq: seq + 1,
      data: { message: { toolCallId: callId, isError, content: [] } },
    },
  ]
}

/** Build the PTC-path event pair: `tool/ptc-dispatch-start` then `tool/ptc-dispatch`. */
function appliedPtc(seq, subCallId, args, { isError = false } = {}) {
  return [
    { type: 'tool/ptc-dispatch-start', seq, data: { subCallId, name: 'board_apply', arguments: args } },
    {
      type: 'tool/ptc-dispatch',
      seq: seq + 1,
      data: { subCallId, name: 'board_apply', arguments: args, isError },
    },
  ]
}

const addHeading = {
  ops: [{ op: 'add_block', page: 'main', kind: 'heading', level: 1, text: '架构总览' }],
}

test('a successful batch folds into the model and advances the revision', () => {
  const state = foldAll(applied(10, 'c1', addHeading))

  assert.equal(state.model.revSeq, 1)
  assert.match(state.model.rev, /^r1-[0-9a-f]{12}$/)
  assert.equal(state.model.pages[0].blocks.length, 1)

  const block = state.model.pages[0].blocks[0]
  assert.equal(block.kind, 'heading')
  assert.equal(block.text, '架构总览')
  // The slug is derived from the heading text, so the Agent gets a readable address.
  assert.equal(block.slug, '架构总览')
  assert.match(block.id, /^bl_[0-9a-f]{6}$/)
})

test('both dispatch paths produce the same board', () => {
  const ordinary = foldAll(applied(10, 'c1', addHeading))
  const ptc = foldAll(appliedPtc(10, 'c1', addHeading))

  // Different call ids would change derived ids, so compare content rather than identity.
  assert.equal(encodeModelForHash(ordinary.model), encodeModelForHash(ptc.model))
  assert.equal(ordinary.model.rev, ptc.model.rev)
})

test('a failed result leaves the model untouched, revision included', () => {
  const before = emptyBoardDoc(SESSION)
  const after = foldAll(applied(10, 'c1', addHeading, { isError: true }))

  assert.equal(after.model.revSeq, before.model.revSeq)
  assert.equal(after.model.pages[0].blocks.length, 0)
  // The call is forgotten, so nothing dangles.
  assert.deepEqual(after.pending, {})
})

test('a failed op drops the whole batch', () => {
  // First op is fine; second references a page that does not exist.
  const batch = {
    ops: [
      { op: 'add_block', page: 'main', kind: 'prose', markdown: 'ok' },
      { op: 'add_block', page: 'nope', kind: 'prose', markdown: 'unreachable' },
    ],
  }
  let state = foldAll(applied(10, 'c1', batch))
  assert.equal(state.model.pages[0].blocks.length, 0, 'nothing from the batch may survive')

  // And the failure must be reported rather than swallowed when applied directly.
  assert.throws(
    () => applyOps(emptyBoardDoc(SESSION).model, batch.ops, { sessionId: SESSION, callSeq: 1, callerRev: 'r0-x' }),
    BoardOpError,
  )
})

test('the same log always folds to the same board', () => {
  const events = [
    ...applied(10, 'c1', addHeading),
    ...applied(20, 'c2', {
      ops: [{ op: 'add_block', page: 'main', kind: 'prose', markdown: '第二块' }],
    }),
  ]
  const first = foldAll(events)
  const second = foldAll(events)

  assert.equal(first.model.rev, second.model.rev)
  assert.deepEqual(
    first.model.pages[0].blocks.map((block) => block.id),
    second.model.pages[0].blocks.map((block) => block.id),
  )
})

test('a stale expected_revision is refused and nothing is applied', () => {
  const stale = {
    expected_revision: 'r7-deadbeef0000',
    ops: [{ op: 'add_block', page: 'main', kind: 'prose', markdown: 'x' }],
  }
  const state = foldAll(applied(10, 'c1', stale))

  // Because the op threw, the batch was dropped: the revision did not move.
  assert.equal(state.model.revSeq, 0)
  assert.equal(state.model.pages[0].blocks.length, 0)
})

test('a matching expected_revision applies', () => {
  const first = foldAll(applied(10, 'c1', addHeading))
  const events = applied(20, 'c2', {
    expected_revision: first.model.rev,
    ops: [{ op: 'add_block', page: 'main', kind: 'prose', markdown: 'ok' }],
  })
  const second = events.reduce((state, event) => foldBoard(state, event), first)

  assert.equal(second.model.revSeq, 2)
  assert.equal(second.model.pages[0].blocks.length, 2)
})

test('ignored events return the same reference', () => {
  const state = emptyBoardDoc(SESSION)
  const ignored = [
    { type: 'tool/call', seq: 1, data: { callId: 'x', name: 'read', arguments: '{}' } },
    { type: 'assistant/message', seq: 2, data: {} },
    { type: 'turn/start', seq: 3, data: {} },
    // Malformed board_apply arguments must be skipped, not thrown on: DSH preserves invalid
    // model JSON as text on purpose.
    { type: 'tool/call', seq: 4, data: { callId: 'y', name: 'board_apply', arguments: '{not json' } },
  ]
  for (const event of ignored) assert.equal(foldBoard(state, event), state)
})

test('an empty batch is legal and changes nothing', () => {
  const state = foldAll(applied(10, 'c1', { ops: [] }))
  assert.equal(state.model.revSeq, 0)
  assert.deepEqual(state.pending, {})
})

test('the checkpoint schema accepts a folded board', () => {
  const state = foldAll([
    ...applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', level: 1, text: '架构' },
        { op: 'add_block', page: 'main', kind: 'list', ordered: true, items: ['一', '二'] },
        { op: 'add_page', slug: '设计' },
      ],
    }),
  ])
  // This is what the projection runs on a restored checkpoint.
  assert.doesNotThrow(() => boardDocSchema.parse(state))
})

test('edges survive a node rename because they anchor to ids', () => {
  const events = [
    ...applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', level: 1, text: 'A' },
        { op: 'add_block', page: 'main', kind: 'heading', level: 1, text: 'B' },
      ],
    }),
    ...applied(30, 'c2', {
      ops: [{ op: 'add_edge', from: 'A', to: 'B', rel: 'depends' }],
    }),
    // Rename the target; the edge must still point at the same block id.
    ...applied(50, 'c3', { ops: [{ op: 'update_block', block: 'B', slug: 'B-renamed' }] }),
  ]
  const state = foldAll(events)
  const blocks = state.model.pages[0].blocks
  const b = blocks.find((block) => block.slug === 'B-renamed')

  assert.ok(b, 'the rename took effect')
  assert.equal(b.alias.includes('B'), true, 'the old slug is retained as an alias')
  assert.equal(state.model.edges[0].to.blockId, b.id, 'the edge still targets the same id')
})

test('slug allocation never reuses a retired address', () => {
  const taken = new Set(['风险-1', '风险-2'])
  // `风险-2` is retired (present in `taken`, which is `slug ∪ alias`), so it must not be
  // handed out again — otherwise an old reference would silently point somewhere new.
  // The suffix stacks on the full base, per the documented algorithm.
  assert.equal(uniqSlug('风险-1', taken), '风险-1-2')

  // And a free base is returned unchanged.
  assert.equal(uniqSlug('风险-3', taken), '风险-3')
})

test('slug normalisation is case-preserving and rejects separators it cannot use', () => {
  assert.equal(toSlug('  Hello   World  '), 'Hello-World')
  assert.equal(toSlug('a/b\\c'), 'abc')
  assert.equal(toSlug('!!!', 'block', 3), 'block-3')
  // Chinese passes the letter class and must not be transliterated or stripped.
  assert.equal(toSlug('架构总览'), '架构总览')
})

test('normalised coordinates are quantised so float noise cannot reach the hash', () => {
  assert.equal(quantise(0.1 + 0.2), 0.3)
  assert.equal(quantise(1 / 3), 0.3333)
})

test('the content hash ignores history and counters', () => {
  const base = emptyBoardDoc(SESSION).model
  const withHistory = {
    ...base,
    revSeq: 99,
    revHash: 'f'.repeat(16),
    rev: 'r99-ffffffffffff',
    pages: base.pages.map((page) => ({ ...page, alias: ['retired'] })),
  }
  assert.equal(encodeModelForHash(base), encodeModelForHash(withHistory))
})
