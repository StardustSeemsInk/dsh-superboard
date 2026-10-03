/**
 * End-to-end projection tests.
 *
 * Each half is tested in isolation elsewhere; this file checks the join between them, which is
 * where a plugin of two halves actually breaks:
 *
 *   committed events → fold → board document → wire projection → what the view reads
 *
 * The wire step matters more than it looks. The host hands the client a value that the
 * projection parses through `boardWireSchema` on every change, and parsing **throws** on a
 * mismatch rather than degrading. So a field the fold produces but the wire schema does not
 * declare would take the board view down at runtime, in the user's profile, with the tests all
 * green — which is exactly the class of failure this file exists to catch.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { foldBoard } from '../src/fold.js'
import { emptyBoardDoc } from '../src/model.js'
import { boardDocSchema, boardWireSchema, toWire } from '../src/schema.js'

/** Fold synthetic events from an empty board. */
function fold(events, sessionId = 'sess-e2e') {
  return events.reduce((state, event) => foldBoard(state, event), emptyBoardDoc(sessionId))
}

/** One committed `board_apply` call, arguments stringified as DSH commits them. */
function applied(seq, callId, args) {
  return [
    { type: 'tool/call', seq, data: { callId, name: 'board_apply', arguments: JSON.stringify(args) } },
    { type: 'tool/result', seq: seq + 1, data: { message: { toolCallId: callId, isError: false, content: [] } } },
  ]
}

/**
 * Project a board document the way the session-projection registry does.
 *
 * Mirrors `dsh-session-projection/lib/index.js:415-425`: only a state that changed by
 * `Object.is` is re-projected, and the client-facing value is the schema-parsed result.
 */
function project(doc) {
  const view = toWire(doc)
  return boardWireSchema.parse(view)
}

/** A board with every v1 block kind, two pages, an edge, a region, a group and a layout. */
function richBoard() {
  return fold([
    ...applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', level: 1, text: '架构总览' },
        { op: 'add_block', page: 'main', kind: 'prose', markdown: '登录服务处理会话。' },
        { op: 'add_block', page: 'main', kind: 'list', ordered: true, items: ['读取会话', '校验令牌'] },
        { op: 'add_block', page: 'main', kind: 'code', lang: 'ts', filename: 'session.ts', code: 'const s = 1' },
        { op: 'add_block', page: 'main', kind: 'uml', source: 'flowchart TD\n  A-->B', diagram: 'flowchart' },
        { op: 'add_block', page: 'main', kind: 'image', src: 'docs/arch.png', alt: '架构图' },
        { op: 'add_block', page: 'main', kind: 'pdf-page', src: 'docs/spec.pdf', pdfPage: 4 },
      ],
    }),
    ...applied(30, 'c2', {
      ops: [
        // A slug derived from a sentence keeps its punctuation trimmed but stays readable, which
        // is what makes it usable as an address.
        { op: 'add_edge', from: '架构总览', to: '登录服务处理会话', rel: 'explains' },
        { op: 'add_block', page: 'main', kind: 'group', title: '核心', children: ['架构总览', '登录服务处理会话'] },
        { op: 'set_layout', scope: 'main', template: 'columns', cols: 2 },
        { op: 'set_region', blockIds: ['架构总览', '登录服务处理会话'], label: '核心区', tone: 'warn' },
        { op: 'add_page', page: '设计' },
      ],
    }),
  ])
}

test('a rich board survives the wire schema the client parses', () => {
  const doc = richBoard()
  assert.doesNotThrow(() => project(doc), 'the wire projection must not throw')

  const wire = project(doc)
  assert.equal(wire.model.pages.length, 2)
  // Seven kinds plus the group container.
  assert.equal(wire.model.pages[0].blocks.length, 8)
  assert.equal(wire.model.edges.length, 1)
  assert.equal(wire.model.regions.length, 1)
})

test('the wire value carries everything the view reads, and nothing it should not', () => {
  const wire = project(richBoard())

  // Present: the three things the view renders from.
  assert.equal(typeof wire.model.rev, 'string')
  assert.equal(typeof wire.model.title, 'string')
  assert.ok(Array.isArray(wire.model.pages))

  // Absent: host bookkeeping the client has no use for. `pending` is a two-phase pairing detail
  // and `sessionId` is how the fold derives ids; neither belongs in a browser payload.
  assert.equal(wire.pending, undefined)
  assert.equal(wire.sessionId, undefined)
  assert.equal(wire.lastOpError, undefined)
})

test('every block kind the fold can produce is declared by the wire schema', () => {
  const wire = project(richBoard())
  const kinds = new Set()
  for (const page of wire.model.pages) for (const block of page.blocks) kinds.add(block.kind)

  assert.deepEqual(
    [...kinds].sort(),
    ['code', 'group', 'heading', 'image', 'list', 'pdf-page', 'prose', 'uml'],
  )
})

test('the layout the Agent chose reaches the client', () => {
  const wire = project(richBoard())
  const main = wire.model.pages.find((page) => page.slug === 'main')
  assert.equal(main.layout.template, 'columns')
  assert.equal(main.layout.params.cols, 2)
})

test('an edge survives with both endpoints intact', () => {
  const wire = project(richBoard())
  const edge = wire.model.edges[0]
  assert.equal(edge.rel, 'explains')

  const blockIds = new Set(wire.model.pages.flatMap((page) => page.blocks.map((block) => block.id)))
  assert.ok(blockIds.has(edge.from.blockId), 'the source endpoint exists in the payload')
  assert.ok(blockIds.has(edge.to.blockId), 'the target endpoint exists in the payload')
})

test('a region reaches the client so the view can group its members', () => {
  const wire = project(richBoard())
  const region = wire.model.regions[0]
  assert.equal(region.slug, '核心区')
  assert.equal(region.tone, 'warn')
  assert.equal(region.blockIds.length, 2)
})

test('a rejected batch leaves the client payload byte-identical', () => {
  const good = richBoard()
  const before = project(good)

  // A batch whose op fails: the fold drops it, so the client must see no change at all. This is
  // what makes a failed write invisible on the board while remaining visible in the transcript.
  const stale = {
    type: 'tool/call',
    seq: 90,
    data: {
      callId: 'c9',
      name: 'board_apply',
      arguments: JSON.stringify({ ops: [{ op: 'add_block', page: 'ghost', kind: 'prose', markdown: 'x' }] }),
    },
  }
  const settled = foldBoard(
    foldBoard(good, stale),
    { type: 'tool/result', seq: 91, data: { message: { toolCallId: 'c9', isError: false, content: [] } } },
  )

  assert.equal(settled.model.rev, good.model.rev, 'the revision does not move')
  assert.deepEqual(
    JSON.parse(JSON.stringify(project(settled).model)),
    JSON.parse(JSON.stringify(before.model)),
    'the client payload is unchanged',
  )
  // The rejection is recorded for the outline, but stays out of the wire payload on purpose: it
  // is prompt material, not something the board view draws.
  assert.ok(settled.lastOpError !== undefined)
})

test('a resumed session folds to the same wire value it would have had live', () => {
  // Replay is the property the whole log-native design exists to buy. Folding the same committed
  // events twice stands in for a cold resume from the log.
  const events = [
    ...applied(10, 'c1', { ops: [{ op: 'add_block', page: 'main', kind: 'heading', level: 1, text: '甲' }] }),
    ...applied(30, 'c2', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', level: 1, text: '乙' },
        { op: 'add_edge', from: '甲', to: '乙', rel: 'next' },
      ],
    }),
  ]
  const live = project(fold(events))
  const resumed = project(fold(events))

  assert.equal(live.model.rev, resumed.model.rev)
  assert.equal(JSON.stringify(live.model), JSON.stringify(resumed.model))
})

test('the checkpoint schema accepts every state the wire schema accepts', () => {
  // The state schema guards restored checkpoints, so a document that passes the wire schema but
  // fails this one would break every cold start while live sessions looked fine.
  const doc = richBoard()
  assert.doesNotThrow(() => boardDocSchema.parse(doc))
  assert.doesNotThrow(() => boardDocSchema.parse(foldBoard(doc, { type: 'turn/start', seq: 99, data: {} })))
})
