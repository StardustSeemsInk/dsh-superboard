/**
 * Output-contract tests: what DSH actually does with a tool's return value.
 *
 * This file exists because of a real miss. The other suites call each tool's `execute` and assert
 * on the returned object — which is exactly what the tool author *thinks* is the contract. DSH's
 * contract is larger:
 *
 *   `execute(args, exec)` → returned value
 *     → `validateJsonSchemaValue(tool.output.schema, value, "value")`   ← throws on mismatch
 *     → `deepFreeze(value)`
 *     → `tool.output.render(args, value)` → `content`
 *     → `result.content.some(...)` / `.map(...)`                        ← content must be an ARRAY
 *
 * `dsh-tools/lib/index.js:3541-3571` (the pipeline), `:3552` (the render return *is* the content),
 * `:1384` and `:2602` (array methods called on it).
 *
 * Three defects lived in the gap between those two contracts and every existing test stayed green:
 *
 *   1. `textResult` wrapped its blocks in `{ content: [...] }`, so `content.some` was not a
 *      function — every board tool call failed *after* passing its schema check.
 *   2. `board_outline` returned a `text` field it never declared, and `additionalProperties:
 *      false` turns an undeclared field into a failed call rather than an ignored one.
 *   3. `board_query` leaked `fromId`/`toId` — internal to its filtering — into a closed schema.
 *
 * The lesson is not "add three assertions". It is that **a hand-written schema plus a hand-written
 * return value is a contract with two sides, and testing one side proves nothing.** So this file
 * drives the real pipeline for every tool and every code path, rather than asserting that a
 * function exists.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { foldBoard } from '../src/fold.js'
import { emptyBoardDoc } from '../src/model.js'
import { BOARD_TOOLS, registerBoardTools } from '../src/tools.js'

/** DSH's real validators, when the extracted application is available. */
const DSH_TOOLS = 'C:/Users/haoch/AppData/Local/Temp/dsh-asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const dsh = existsSync(DSH_TOOLS) ? await import(`file:///${DSH_TOOLS}`) : undefined

/** Fold synthetic events into a board document. */
function foldEvents(events, sessionId = 'sess-out') {
  return events.reduce((state, event) => foldBoard(state, event), emptyBoardDoc(sessionId))
}

/** One committed `board_apply` call. Arguments are stringified because that is what DSH commits. */
function applied(seq, callId, args) {
  return [
    { type: 'tool/call', seq, data: { callId, name: 'board_apply', arguments: JSON.stringify(args) } },
    { type: 'tool/result', seq: seq + 1, data: { message: { toolCallId: callId, isError: false, content: [] } } },
  ]
}

/**
 * A board exercising every shape the tools can return: several block kinds, an edge, a region, a
 * page, a group, a dangling edge, and multi-page output.
 */
function richDoc() {
  return foldEvents([
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
        { op: 'add_edge', from: '架构总览', to: '登录服务处理会话', rel: 'explains', label: '说明' },
        { op: 'add_block', page: 'main', kind: 'group', title: '核心', children: ['架构总览'] },
        { op: 'set_layout', scope: 'main', template: 'columns', cols: 2 },
        { op: 'set_region', blockIds: ['架构总览', '登录服务处理会话'], label: '核心区', tone: 'warn' },
        { op: 'add_page', page: '设计' },
        { op: 'add_block', page: '设计', kind: 'prose', markdown: '第二页' },
      ],
    }),
    // A deleted target leaves a dangling edge, so query kinds that report one get exercised too.
    ...applied(50, 'c3', { ops: [{ op: 'add_block', page: 'main', kind: 'prose', markdown: '将被删除' }] }),
    ...applied(70, 'c4', { ops: [{ op: 'delete_block', block: '将被删除' }] }),
  ])
}

/** Register the tools against a fake registry and return a caller bound to one board. */
function harness(doc) {
  const registered = []
  registerBoardTools(
    { tools: { register: (definition) => (registered.push(definition), () => {}) } },
    { stateOf: () => doc },
  )
  return {
    registered,
    call(name, args) {
      const tool = registered.find((each) => each.name === name)
      if (tool === undefined) throw new Error(`tool ${name} was not registered`)
      return tool.execute(args, {
        agent: { session: { id: 'sess-out' } },
        callId: 'test',
        name,
        arguments: args,
      })
    },
    tool: (name) => registered.find((each) => each.name === name),
  }
}

/**
 * Drive one tool through the real pipeline.
 *
 * Mirrors `createSuccessResult`: validate the returned value against the tool's own output schema,
 * then run `render` and check the shape DSH will treat as the model-facing content.
 *
 * @param name - the tool to drive.
 * @param args - its arguments.
 * @param doc - the board it should read.
 * @returns the validated value and the rendered content.
 */
function drive(name, args, doc) {
  const h = harness(doc)
  const tool = h.tool(name)
  const value = h.call(name, args)

  if (dsh !== undefined) {
    const violations = dsh.validateJsonSchemaValue(tool.output.schema, value, 'value')
    assert.deepEqual(
      violations,
      [],
      `${name}: the returned value does not satisfy its own output schema — DSH would fail this call with ToolOutputError`,
    )
  }

  const content = tool.output.render(args, value)
  assert.ok(
    Array.isArray(content),
    `${name}: output.render must return the content ARRAY, not a wrapper — DSH assigns it to ` +
      `result.content and then calls .some/.map on it`,
  )
  for (const block of content) {
    assert.equal(block.type, 'text', `${name}: only text blocks are expected here`)
    assert.equal(typeof block.text, 'string', `${name}: a text block needs a string body`)
  }
  return { value, content }
}

// ---------------------------------------------------------------------------
// Every tool, every path
// ---------------------------------------------------------------------------

test('board_outline satisfies its output schema and renders content', () => {
  const doc = richDoc()
  const { value, content } = drive('board_outline', {}, doc)
  assert.equal(value.rev, doc.model.rev)
  assert.ok(content[0].text.includes('page main'))
})

test('board_outline on one page also satisfies the contract', () => {
  drive('board_outline', { page: '设计' }, richDoc())
})

test('board_outline asked for edges alone satisfies the contract', () => {
  drive('board_outline', { include: 'edges' }, richDoc())
})

test('board_outline against an empty board satisfies the contract', () => {
  const { value, content } = drive('board_outline', {}, emptyBoardDoc('sess-out'))
  assert.equal(value.truncated, false)
  assert.equal(content[0].text, '')
})

test('board_read of every element kind satisfies the contract', () => {
  const doc = richDoc()
  for (const refs of [
    ['架构总览'],
    ['登录服务处理会话'],
    ['main'],
    ['设计'],
    ['核心'],
    ['核心区'],
    ['session.ts'],
  ]) {
    drive('board_read', { refs }, doc)
  }
  drive('board_read', { refs: ['架构总览'], format: 'json' }, doc)
  drive('board_read', { refs: ['main'], depth: 'page' }, doc)
  drive('board_read', { refs: ['核心区'], depth: 'region' }, doc)
})

test('board_read of a dangling edge satisfies the contract', () => {
  const doc = richDoc()
  // The edge drawn earlier survives the later block deletion, so reading it exercises the branch
  // that reports a missing endpoint.
  const slug = doc.model.edges[0].slug
  const { value } = drive('board_read', { refs: [slug] }, doc)
  assert.equal(value.resolved[0].kind, 'edge')
})

test('board_apply satisfies the contract, and so does its failure path', () => {
  const doc = emptyBoardDoc('sess-out')
  const { value, content } = drive(
    'board_apply',
    {
      expected_revision: doc.model.rev,
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', level: 1, text: '甲' },
        { op: 'add_block', page: 'main', kind: 'prose', markdown: '乙' },
        { op: 'add_edge', from: '甲', to: '乙', rel: 'next' },
      ],
    },
    doc,
  )
  assert.equal(value.changed, true)
  assert.equal(value.applied, 3)
  assert.ok(content[0].text.includes('created:'))

  // The rejection path returns nothing at all: it throws, and DSH turns that into the error text.
  assert.throws(
    () => harness(doc).call('board_apply', { expected_revision: 'r9-deadbeef0000', ops: [] }),
    /stale board revision/,
  )
})

test('board_apply with a slug collision still satisfies the contract', () => {
  const doc = foldEvents([
    ...applied(10, 'c1', { ops: [{ op: 'add_block', page: 'main', kind: 'prose', markdown: 'x', slug: '风险' }] }),
  ])
  const { value } = drive(
    'board_apply',
    { expected_revision: doc.model.rev, ops: [{ op: 'add_block', page: 'main', kind: 'prose', markdown: 'y', slug: '风险' }] },
    doc,
  )
  assert.equal(value.warnings.length, 1)
})

test('every board_query kind satisfies the contract', () => {
  const doc = richDoc()
  const kinds = [
    { kind: 'dependents_of', target: '登录服务处理会话' },
    { kind: 'dependencies_of', target: '架构总览' },
    { kind: 'between', from: '架构总览', to: '登录服务处理会话' },
    { kind: 'neighbors_of', target: '架构总览' },
    { kind: 'by_rel', rel: 'explains' },
    { kind: 'orphans' },
    { kind: 'dangling' },
    { kind: 'path', from: '架构总览', to: '登录服务处理会话', depth: 3 },
  ]
  for (const args of kinds) {
    const { value } = drive('board_query', args, doc)
    assert.equal(value.kind, args.kind)
  }
})

test('an empty query result satisfies the contract, hint included', () => {
  // A real block that nothing points at, so this is the genuinely-empty path rather than an
  // unresolvable reference (which throws, and is covered by its own assertion below).
  const { value } = drive('board_query', { kind: 'dependencies_of', target: '第二页' }, richDoc())
  assert.equal(value.empty, true)
  assert.equal(typeof value.hint, 'string')
  assert.ok(value.text.includes(value.hint), 'the hint is the whole value of an empty answer')

  // An unresolvable reference is an error, not an empty result — it must not be reported as "no
  // matches", which would tell the Agent the relation does not exist when really the name is wrong.
  assert.throws(
    () => harness(richDoc()).call('board_query', { kind: 'dependents_of', target: '不存在' }),
    /no block matches/,
  )
})

test('a query hit carries only the fields its schema declares', () => {
  // This is the defect class in miniature: `runQuery` works in block ids because the filters need
  // them, and the output schema is closed and promises addresses. The id fields must not survive
  // into the value, or `additionalProperties: false` fails the whole call.
  const { value } = drive('board_query', { kind: 'neighbors_of', target: '架构总览' }, richDoc())
  assert.ok(value.hits.length > 0, 'the fixture must produce at least one hit')
  const declared = new Set(['edge', 'from', 'to', 'rel', 'label', 'via', 'dangling'])
  for (const hit of value.hits) {
    for (const key of Object.keys(hit)) {
      assert.ok(declared.has(key), `board_query leaked an undeclared hit field: ${key}`)
    }
  }
})

test('an orphan hit satisfies the contract too', () => {
  // `orphans` builds its hit from the block rather than from an edge, so it takes a different path
  // through the same schema.
  const doc = foldEvents([
    ...applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'prose', markdown: 'A' },
        { op: 'add_block', page: 'main', kind: 'prose', markdown: 'B' },
      ],
    }),
    ...applied(30, 'c2', { ops: [{ op: 'add_edge', from: 'A', to: 'B', rel: 'next' }] }),
    ...applied(50, 'c3', { ops: [{ op: 'add_block', page: 'main', kind: 'prose', markdown: 'C' }] }),
  ])
  const { value } = drive('board_query', { kind: 'orphans' }, doc)
  assert.deepEqual(
    value.hits.map((hit) => hit.from),
    ['C'],
  )
})

test('every tool declares the field its render reads', () => {
  // The board_outline defect was one missing declaration in a properties table. Rather than trust
  // a reviewer to spot the next one, drive each tool and confirm render had something to read.
  const doc = richDoc()
  for (const args of [
    ['board_outline', {}],
    ['board_read', { refs: ['架构总览'] }],
    ['board_query', { kind: 'orphans' }],
  ]) {
    const { content } = drive(args[0], args[1], doc)
    assert.equal(content.length, 1, `${args[0]}: expected exactly one content block`)
  }
})

test('the whole tool set is covered by this file', () => {
  // A guard against the failure mode this file was written for: a new tool added without its
  // output contract being driven end to end.
  const driven = new Set(['board_outline', 'board_read', 'board_apply', 'board_query'])
  for (const tool of BOARD_TOOLS) {
    assert.ok(driven.has(tool.name), `${tool.name} has no output-contract coverage — add it here`)
  }
})
