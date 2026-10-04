/**
 * Tool-surface tests.
 *
 * The claim worth checking is not "the handler returns a value" — it is that the schemas we
 * hand `ctx.tools.register` are ones the **real** registry would accept. So these tests load
 * DSH's own `assertSupportedJsonSchema` and `validateJsonSchemaValue` out of the installed
 * application and run our definitions through them. A schema that passes our own assertions but
 * fails theirs would fail at plugin load, in the user's profile, with no board to show for it —
 * and our hand-written schemas are exactly where that risk lives, because the plugin cannot
 * import DSH's `defineTool` compiler.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { foldBoard } from '../src/fold.js'
import { LAYOUT_TEMPLATES, emptyBoardDoc } from '../src/model.js'
import {
  BOARD_TOOLS,
  TEMPLATE_MEANING,
  blockPreview,
  isDangling,
  registerBoardTools,
  renderOutlineText,
  resolveRef,
} from '../src/tools.js'

/** DSH's real validators, when the extracted application is available. */
const DSH_TOOLS = 'C:/Users/haoch/AppData/Local/Temp/dsh-asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const dsh = existsSync(DSH_TOOLS) ? await import(`file:///${DSH_TOOLS}`) : undefined

/** Fold synthetic events into a board document. */
function foldEvents(events, sessionId = 'sess-tools') {
  return events.reduce((state, event) => foldBoard(state, event), emptyBoardDoc(sessionId))
}

/** One committed `board_apply` call. Arguments are stringified because that is what DSH commits. */
function applied(seq, callId, args) {
  return [
    { type: 'tool/call', seq, data: { callId, name: 'board_apply', arguments: JSON.stringify(args) } },
    { type: 'tool/result', seq: seq + 1, data: { message: { toolCallId: callId, isError: false, content: [] } } },
  ]
}

/** A board with two blocks on the default page, so references resolve. */
function seededDoc() {
  return foldEvents(
    applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', level: 1, text: '架构总览' },
        { op: 'add_block', page: 'main', kind: 'prose', markdown: '登录服务处理会话。' },
      ],
    }),
  )
}

/**
 * Register every board tool against a fake registry with a board in hand.
 *
 * Going through `registerBoardTools` rather than calling handlers directly is deliberate: each
 * tool's `execute` is installed at registration and closes over the projection registry, so
 * this is the only way to exercise the real wiring. A handler wired to the wrong service would
 * pass a direct call and fail here.
 *
 * @param doc - the board document the tools should read.
 * @returns `{ call, registered }`.
 */
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
        agent: { session: { id: 'sess-tools' } },
        callId: 'test',
        name,
        arguments: args,
      })
    },
  }
}

/** Build a harness and call one tool. */
function callTool(name, args, doc) {
  return harness(doc).call(name, args)
}

// ---------------------------------------------------------------------------
// Shapes the registry must accept
// ---------------------------------------------------------------------------

test("every board tool satisfies DSH's own schema validators", (t) => {
  if (dsh === undefined) {
    t.skip('extracted DSH application not present')
    return
  }
  for (const tool of BOARD_TOOLS) {
    assert.doesNotThrow(
      () => dsh.assertSupportedJsonSchema(tool.parameters),
      `${tool.name}: parameters rejected by DSH`,
    )
    assert.doesNotThrow(
      () => dsh.assertSupportedJsonSchema(tool.output.schema),
      `${tool.name}: output schema rejected by DSH`,
    )
  }
})

test('every board tool has the shape ctx.tools.register requires', () => {
  const names = BOARD_TOOLS.map((tool) => tool.name)
  assert.deepEqual(names, ['board_outline', 'board_read', 'board_apply', 'board_query'])
  for (const tool of BOARD_TOOLS) {
    // `output.render` is the only content channel the registry accepts, so it must be on the
    // definition itself rather than installed at registration.
    assert.equal(typeof tool.output.render, 'function', `${tool.name}.output.render`)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 80, `${tool.name} should teach the model when to use it`)
    assert.notEqual(tool.name, 'run_code')
  }
})

test('every value the model may pick is named in the description it reads', () => {
  // The tool descriptions are the *entire* documentation surface. There is no skill and no
  // agent-instructions injection (both are disabled in the profile's plugin list), and
  // `docs/design/board-model.md` never reaches the Agent. So an enum whose values are bare names
  // is a vocabulary the model has to guess at — which is exactly what `flow` / `row` / `columns` /
  // `grid` / `canvas` were until this test existed. `oneOfStrings` carries the legal values in
  // `enum`, and a model reads the description, not the shape of the schema.
  assert.deepEqual(
    Object.keys(TEMPLATE_MEANING).sort(),
    [...LAYOUT_TEMPLATES].sort(),
    'TEMPLATE_MEANING must cover exactly the templates the model can choose, no more and no less',
  )

  const branches = BOARD_TOOLS.find((tool) => tool.name === 'board_apply').parameters.properties.ops.items
    .oneOf
  const branch = (op) => branches.find((each) => each.properties.op.const === op)

  // A template reachable through either path must be explained on both, or the model learns it
  // from one op and guesses at the other.
  for (const description of [
    branch('add_block').properties.layout.properties.template.description,
    branch('set_layout').properties.template.description,
  ]) {
    for (const template of LAYOUT_TEMPLATES) {
      assert.ok(
        description.includes(`${template}:`),
        `a template description must say what ${template} does, or the model picks blind`,
      )
    }
  }

  // Nine anchor kinds, none of them guessable from `{ blockId, at }` — which is all the field
  // used to say, making "aim this arrow at line 12 of that code" a capability the Agent could
  // not know existed.
  for (const endpoint of ['from', 'to']) {
    const description = branch('add_edge').properties[endpoint].description
    for (const kind of ['block', 'field', 'item', 'lines', 'text', 'child', 'node', 'rect', 'point']) {
      assert.ok(description.includes(`'${kind}'`), `${endpoint} must name the ${kind} anchor kind`)
    }
  }
})

test('registering the tools installs an execute on each, and returns one disposer per tool', () => {
  const { registered } = harness(emptyBoardDoc('s'))
  assert.equal(registered.length, 4)
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function', `${tool.name}.execute after registration`)
  }

  const disposers = registerBoardTools(
    { tools: { register: () => () => {} } },
    { stateOf: () => undefined },
  )
  assert.equal(disposers.length, BOARD_TOOLS.length)
  for (const dispose of disposers) assert.equal(typeof dispose, 'function')
})

test('board_apply is serialised, because two parallel writes would race the revision gate', () => {
  const apply = BOARD_TOOLS.find((tool) => tool.name === 'board_apply')
  assert.equal(apply.isConcurrencySafe({}), false)
})

test("arguments the model is likely to send pass DSH's validator", (t) => {
  if (dsh === undefined) {
    t.skip('extracted DSH application not present')
    return
  }
  const byName = (name) => BOARD_TOOLS.find((tool) => tool.name === name)

  assert.deepEqual(dsh.validateJsonSchemaValue(byName('board_outline').parameters, {}, ''), [])
  assert.deepEqual(dsh.validateJsonSchemaValue(byName('board_read').parameters, { refs: ['架构总览'] }, ''), [])
  assert.deepEqual(dsh.validateJsonSchemaValue(byName('board_query').parameters, { kind: 'orphans' }, ''), [])

  // A batch touching the op shapes the model is most likely to reach for.
  const batch = {
    expected_revision: 'r1-abcdef012345',
    ops: [
      { op: 'add_page', page: '设计' },
      { op: 'add_block', page: '设计', kind: 'heading', text: '标题' },
      { op: 'add_block', page: '设计', kind: 'list', items: ['一', '二'], ordered: true },
      { op: 'add_block', page: '设计', kind: 'code', code: 'x', lang: 'ts' },
      { op: 'add_edge', from: '标题', to: '标题', rel: 'relates', label: '自指' },
      { op: 'set_layout', scope: '设计', template: 'columns', cols: 2 },
      { op: 'set_region', blockIds: ['标题'], label: '簇', tone: 'warn' },
    ],
  }
  assert.deepEqual(dsh.validateJsonSchemaValue(byName('board_apply').parameters, batch, ''), [])
})

test('an unknown op violates the union rather than being silently ignored', (t) => {
  if (dsh === undefined) {
    t.skip('extracted DSH application not present')
    return
  }
  const apply = BOARD_TOOLS.find((tool) => tool.name === 'board_apply')
  const violations = dsh.validateJsonSchemaValue(
    apply.parameters,
    { expected_revision: 'r1-x', ops: [{ op: 'nope' }] },
    '',
  )
  assert.ok(violations.length > 0, 'an unknown op must fail oneOf')
})

test('a missing expected_revision is rejected', (t) => {
  if (dsh === undefined) {
    t.skip('extracted DSH application not present')
    return
  }
  const apply = BOARD_TOOLS.find((tool) => tool.name === 'board_apply')
  const violations = dsh.validateJsonSchemaValue(apply.parameters, { ops: [{ op: 'delete_edge', edge: 'x' }] }, '')
  assert.ok(
    violations.some((violation) => violation.includes('expected_revision')),
    `expected a violation naming expected_revision, got ${JSON.stringify(violations)}`,
  )
})

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('board_outline describes the board without quoting it', () => {
  const doc = seededDoc()
  const result = callTool('board_outline', {}, doc)

  assert.equal(result.rev, doc.model.rev)
  assert.equal(result.pages.length, 1)
  assert.equal(result.pages[0].blocks.length, 2)
  assert.equal(result.pages[0].blocks[0].slug, '架构总览')
  assert.equal(result.pages[0].blocks[0].kind, 'heading')
  assert.equal(result.truncated, false)
  assert.match(result.text, /page main/)
})

test('board_read resolves a block by slug and renders its text', () => {
  const doc = seededDoc()
  const result = callTool('board_read', { refs: ['架构总览'] }, doc)

  assert.equal(result.resolved.length, 1)
  assert.equal(result.resolved[0].kind, 'block')
  assert.match(result.text, /# 架构总览/)
})

test('board_read refuses an unknown reference instead of guessing', () => {
  const doc = seededDoc()
  assert.throws(
    () => callTool('board_read', { refs: ['不存在的东西'] }, doc),
    /no page, block, edge, or region matches/,
  )
})

test('a page is still reachable through its retired slug', () => {
  const doc = foldEvents([
    ...applied(10, 'c1', { ops: [{ op: 'add_page', slug: 'A' }, { op: 'add_page', slug: 'B' }] }),
    ...applied(30, 'c2', { ops: [{ op: 'rename_page', page: 'B', slug: 'C' }] }),
  ])
  assert.equal(resolveRef(doc.model, 'C', 'page').element.slug, 'C')
  // The old address still resolves, which is what keeps references from earlier turns usable.
  assert.equal(resolveRef(doc.model, 'B', 'page').element.slug, 'C')
})

test('resolution order is id, then current slug, then alias', () => {
  const doc = foldEvents([
    ...applied(10, 'c1', { ops: [{ op: 'add_block', page: 'main', kind: 'heading', level: 1, text: '原名' }] }),
    ...applied(30, 'c2', { ops: [{ op: 'update_block', block: '原名', slug: '新名' }] }),
  ])
  const block = doc.model.pages[0].blocks[0]

  assert.equal(resolveRef(doc.model, block.id).element.slug, '新名')
  assert.equal(resolveRef(doc.model, '新名').element.id, block.id)
  assert.equal(resolveRef(doc.model, '原名').element.id, block.id)
})

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

test('board_apply applies a batch and reports what it created', () => {
  const doc = emptyBoardDoc('sess-tools')
  const result = callTool(
    'board_apply',
    {
      expected_revision: doc.model.rev,
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', level: 1, text: '架构' },
        { op: 'add_block', page: 'main', kind: 'prose', markdown: '说明' },
      ],
    },
    doc,
  )

  assert.equal(result.ok, true)
  assert.equal(result.applied, 2)
  assert.equal(result.created.length, 2)
  assert.equal(result.created[0].kind, 'block')
  assert.match(result.pending_rev, /^r1-[0-9a-f]{12}$/)
  assert.match(result.text, /created:/)
  // The Agent must be told the preview is a preview, or it will pass it back as authoritative.
  assert.match(result.text, /preview/)
})

test('a stale expected_revision is refused, with the current one quoted back', () => {
  const doc = seededDoc()
  assert.throws(
    () =>
      callTool(
        'board_apply',
        {
          expected_revision: 'r99-deadbeef0000',
          ops: [{ op: 'add_block', page: 'main', kind: 'prose', markdown: 'x' }],
        },
        doc,
      ),
    (error) => {
      assert.match(error.message, /stale board revision/)
      assert.match(error.message, /Nothing was applied/)
      assert.ok(error.message.includes(doc.model.rev), 'the current revision must be quoted')
      return true
    },
  )
})

test('a failing op is reported with its position, reason, and next step', () => {
  const doc = emptyBoardDoc('sess-tools')
  assert.throws(
    () =>
      callTool(
        'board_apply',
        {
          expected_revision: doc.model.rev,
          ops: [
            { op: 'add_block', page: 'main', kind: 'prose', markdown: 'fine' },
            { op: 'add_block', page: 'nope', kind: 'prose', markdown: 'unreachable' },
          ],
        },
        doc,
      ),
    (error) => {
      assert.match(error.message, /board_apply rejected \(nothing applied\)/)
      assert.match(error.message, /op\[1\] add_block/)
      assert.match(error.message, /no page matches/)
      assert.match(error.message, /re-issue the whole batch/)
      return true
    },
  )
})

test('a slug collision is reported, because later ops need the address actually assigned', () => {
  const doc = foldEvents([
    ...applied(10, 'c1', { ops: [{ op: 'add_block', page: 'main', kind: 'prose', markdown: 'first', slug: '风险' }] }),
  ])
  const result = callTool(
    'board_apply',
    {
      expected_revision: doc.model.rev,
      ops: [{ op: 'add_block', page: 'main', kind: 'prose', markdown: 'second', slug: '风险' }],
    },
    doc,
  )

  assert.equal(result.created.length, 1)
  assert.notEqual(result.created[0].slug, '风险')
  assert.equal(result.warnings.length, 1)
  assert.ok(result.warnings[0].includes(result.created[0].slug))
  assert.match(result.text, /warnings:/)
})

test('board_apply refuses to run against a projection that is not registered', () => {
  const registered = []
  registerBoardTools(
    { tools: { register: (definition) => (registered.push(definition), () => {}) } },
    { stateOf: () => undefined },
  )
  const apply = registered.find((tool) => tool.name === 'board_apply')
  assert.throws(
    () => apply.execute({ expected_revision: 'r0-x', ops: [] }, { agent: { session: { id: 's' } } }),
    /board state unavailable/,
  )
})

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

test('board_query answers what depends on a block from the edges, not from prose', () => {
  const doc = foldEvents([
    ...applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', level: 2, text: '登录服务' },
        { op: 'add_block', page: 'main', kind: 'heading', level: 2, text: '渠道适配器' },
      ],
    }),
    ...applied(30, 'c2', {
      ops: [{ op: 'add_edge', from: '渠道适配器', to: '登录服务', rel: 'depends', label: '假设会话长期有效' }],
    }),
  ])
  const result = callTool('board_query', { kind: 'dependents_of', target: '登录服务' }, doc)

  assert.equal(result.empty, false)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].from, '渠道适配器')
  assert.equal(result.hits[0].to, '登录服务')
  assert.equal(result.hits[0].rel, 'depends')
  assert.equal(result.hits[0].label, '假设会话长期有效')
})

test('an empty query returns a hint, because the value of nothing is what to try next', () => {
  const doc = seededDoc()
  const result = callTool('board_query', { kind: 'dependents_of', target: '架构总览' }, doc)

  assert.equal(result.empty, true)
  assert.equal(typeof result.hint, 'string')
  assert.ok(result.hint.length > 0)
  assert.ok(result.text.includes(result.hint))
})

test('orphans finds blocks no edge touches', () => {
  const doc = foldEvents([
    ...applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', level: 2, text: 'A' },
        { op: 'add_block', page: 'main', kind: 'heading', level: 2, text: 'B' },
        { op: 'add_block', page: 'main', kind: 'heading', level: 2, text: 'C' },
      ],
    }),
    ...applied(30, 'c2', { ops: [{ op: 'add_edge', from: 'A', to: 'B', rel: 'next' }] }),
  ])
  const result = callTool('board_query', { kind: 'orphans' }, doc)

  assert.deepEqual(
    result.hits.map((hit) => hit.from),
    ['C'],
  )
})

test('deleting a block leaves its edges marked dangling rather than silently removed', () => {
  const doc = foldEvents([
    ...applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', level: 2, text: 'A' },
        { op: 'add_block', page: 'main', kind: 'heading', level: 2, text: 'B' },
      ],
    }),
    ...applied(30, 'c2', { ops: [{ op: 'add_edge', from: 'A', to: 'B', rel: 'depends' }] }),
    ...applied(50, 'c3', { ops: [{ op: 'delete_block', block: 'B' }] }),
  ])

  assert.equal(doc.model.edges.length, 1, 'the edge survives the block')
  assert.equal(isDangling(doc.model, doc.model.edges[0]), true)

  const result = callTool('board_query', { kind: 'dangling' }, doc)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].dangling, true)
})

test('board_query finds a directed path and reports the hops', () => {
  const doc = foldEvents([
    ...applied(10, 'c1', {
      ops: [
        { op: 'add_block', page: 'main', kind: 'heading', level: 2, text: 'A' },
        { op: 'add_block', page: 'main', kind: 'heading', level: 2, text: 'B' },
        { op: 'add_block', page: 'main', kind: 'heading', level: 2, text: 'C' },
      ],
    }),
    ...applied(30, 'c2', {
      ops: [
        { op: 'add_edge', from: 'A', to: 'B', rel: 'next' },
        { op: 'add_edge', from: 'B', to: 'C', rel: 'next' },
      ],
    }),
  ])
  const result = callTool('board_query', { kind: 'path', from: 'A', to: 'C', depth: 4 }, doc)

  assert.equal(result.empty, false)
  assert.equal(result.hits[0].from, 'A')
  assert.equal(result.hits[0].to, 'C')
  assert.match(result.hits[0].via, /B/)
})

// ---------------------------------------------------------------------------
// Outline rendering
// ---------------------------------------------------------------------------

test('an empty board renders no outline at all', () => {
  assert.equal(renderOutlineText(emptyBoardDoc('s'), {}).text.trim(), '')
})

test('a rejected batch is stated in the outline, so the Agent need not re-read to learn it', () => {
  // The result is not an error, so the fold drops the batch and records why. The board did not
  // move, yet the Agent should hear about the attempt.
  const doc = foldEvents(
    applied(10, 'c1', { ops: [{ op: 'add_block', page: 'ghost', kind: 'prose', markdown: 'x' }] }),
  )

  assert.equal(doc.model.revSeq, 0, 'a rejected batch does not advance the revision')
  assert.ok(doc.lastOpError !== undefined)
  assert.match(renderOutlineText(doc, {}).text, /last board_apply was rejected/)
})

test('a large outline truncates itself and says so', () => {
  const ops = Array.from({ length: 120 }, (_, index) => ({
    op: 'add_block',
    page: 'main',
    kind: 'prose',
    markdown: `段落 ${index} ${'内容'.repeat(20)}`,
  }))
  const doc = foldEvents(applied(10, 'c1', { ops }))
  const rendered = renderOutlineText(doc, { maxChars: 600 })

  assert.equal(rendered.truncated, true)
  assert.ok(rendered.text.length <= 700, 'the text respects the budget')
  assert.ok(rendered.omitted !== undefined)
})

test('the outline can be asked for edges alone, which is the cheap way to re-check relations', () => {
  const doc = foldEvents([
    ...applied(10, 'c1', { ops: [{ op: 'add_block', page: 'main', kind: 'heading', level: 2, text: 'A' }] }),
  ])
  assert.match(renderOutlineText(doc, { include: 'edges' }).text, /no edges/)
})

test('block previews are one line, so the outline stays scannable', () => {
  assert.equal(blockPreview({ kind: 'prose', markdown: 'first line\nsecond line' }), 'first line')
  assert.ok(blockPreview({ kind: 'prose', markdown: 'x'.repeat(500) }).length < 80)
})

// ---------------------------------------------------------------------------
// The output contract DSH actually enforces
// ---------------------------------------------------------------------------

/**
 * Every tool's return value must satisfy the schema that tool declared, and its `render` must
 * return the content blocks themselves.
 *
 * Neither half is covered by rendering text or folding events, and both only surface in a live
 * session: the registry validates the **value** against `output.schema` (where
 * `additionalProperties: false` turns one undeclared field into a failed call) and then treats
 * the `render` result as `content`, calling array methods on it. The first `board_outline` and
 * `board_read` calls ever made against a real host failed on exactly those two points, while
 * the suite was green — so they are asserted here, through the real wiring, per tool.
 *
 * This is the smoke test, at the point of use. `test/output-contract.test.js` drives the same
 * pipeline across every query kind, every read target, and the empty, dangling and rejection
 * paths — and it fails when a tool is added without coverage.
 */
test("every tool's value satisfies its own output schema, and its render returns content blocks", async (t) => {
  if (dsh === undefined) {
    t.skip('extracted DSH application not present')
    return
  }

  const doc = seededDoc()
  const exec = (name, args) => ({ agent: { session: { id: 'sess-tools' } }, callId: 'test', name, arguments: args })
  const calls = [
    ['board_outline', {}],
    ['board_read', { refs: ['main'] }],
    ['board_query', { kind: 'orphans' }],
    [
      'board_apply',
      {
        expected_revision: doc.model.rev,
        ops: [{ op: 'add_block', page: 'main', kind: 'prose', markdown: '新块' }],
      },
    ],
  ]
  const { registered } = harness(doc)

  for (const [name, args] of calls) {
    const tool = registered.find((each) => each.name === name)
    const value = await tool.execute(args, exec(name, args))

    assert.deepEqual(
      dsh.validateJsonSchemaValue(tool.output.schema, value, 'value'),
      [],
      `${name}: its return value violates the schema it declared`,
    )

    const content = tool.output.render(args, value)
    assert.ok(Array.isArray(content), `${name}: output.render must return the content-block array`)
    assert.ok(content.length > 0, `${name}: rendered no content at all`)
    for (const block of content) {
      assert.equal(block.type, 'text', `${name}: unexpected content block type`)
      assert.equal(typeof block.text, 'string', `${name}: content block without text`)
    }
  }
})
