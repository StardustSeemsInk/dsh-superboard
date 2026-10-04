/**
 * Host-side diagnostics for `uml` blocks.
 *
 * The lint earns its place by being **certain**. Everything it reports has to be something mermaid
 * itself would refuse, because a false "this is not a diagram" sends the Agent to rewrite a
 * diagram that was already correct — a worse outcome than saying nothing. So the tests below are
 * mostly about the boundary: what is reported, what is deliberately left alone, and what the
 * message actually tells a reader who is about to edit the block.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { detectDiagramType, diagnoseModel, diagnoseUml, knownDiagramKeywords } from '../src/diagnose.js'

const uml = (source, extra = {}) => ({ id: 'bl_1', slug: 'flow', kind: 'uml', engine: 'mermaid', source, ...extra })
const page = (blocks) => ({ id: 'pg_1', slug: 'main', blocks })

// ---------------------------------------------------------------------------
// What mermaid accepts
// ---------------------------------------------------------------------------

test('every diagram family the board claims to support is recognised', () => {
  // These are the families named in the tool description and on the roadmap. If the vendored
  // registry stops covering one of them, the lint would start telling the Agent to rewrite it.
  const sources = {
    flowchart: 'flowchart TD\n  A[开始] --> B{是块吗}\n  B -->|是| C[选区浮条]',
    graph: 'graph LR\n  A --> B',
    sequenceDiagram: 'sequenceDiagram\n  A->>B: 你好',
    classDiagram: 'classDiagram\n  A <|-- B',
    stateDiagram: 'stateDiagram-v2\n  [*] --> Idle',
    erDiagram: 'erDiagram\n  A ||--o{ B : has',
    gantt: 'gantt\n  title 计划\n  section 一\n  任务 :a1, 2024-01-01, 3d',
    pie: 'pie title 去向\n  "看板" : 40\n  "对话" : 60',
    timeline: 'timeline\n  title 历史\n  2024 : 开始',
    mindmap: 'mindmap\n  root((看板))\n    块',
    quadrantChart: 'quadrantChart\n  title 优先级\n  x-axis 低 --> 高\n  y-axis 低 --> 高\n  A: [0.3, 0.6]',
    xychart: 'xychart-beta\n  title "增长"\n  bar [1, 2, 3]',
  }
  for (const [name, source] of Object.entries(sources)) {
    assert.equal(diagnoseUml(uml(source)), undefined, `${name} must be accepted, got ${JSON.stringify(diagnoseUml(uml(source)))}`)
  }
})

test('a source mermaid would not recognise is reported, and the message names real keywords', () => {
  const found = diagnoseUml(uml('hello world\n  this is prose, not a diagram'))
  assert.ok(found !== undefined, 'prose in a uml block must be reported')
  assert.equal(found.code, 'UNSUPPORTED')
  assert.match(found.message, /flowchart/)
  assert.match(found.message, /sequenceDiagram/)
  assert.match(found.message, /xychart/)
})

test('every keyword named in the message is a word, not a fragment of a regex', () => {
  // The keywords are read out of mermaid's own detector regexes, and a regex is not a vocabulary.
  // `^\s*(flowchart|graph)` starts with an alternation bracket, and the comment-only detector is
  // a regex from end to end; both would be printed straight into a message the model then reads.
  const keywords = knownDiagramKeywords()
  assert.ok(keywords.length >= 20, `expected a real vocabulary, saw ${keywords.length}`)
  for (const keyword of keywords) {
    assert.match(keyword, /^[A-Za-z][A-Za-z0-9-]*$/, `${JSON.stringify(keyword)} is not a keyword`)
  }
  assert.ok(keywords.includes('flowchart'), 'the alternation bracket must not survive')
  assert.ok(keywords.includes('graph'), 'both branches of the alternation are keywords')
})

// ---------------------------------------------------------------------------
// The two certain failures
// ---------------------------------------------------------------------------

test('an empty source is a parse failure, not an unsupported diagram', () => {
  // The distinction matters to the reader: one means "write something", the other means
  // "what you wrote is not mermaid". Conflating them produces a message that names 38 keywords
  // in response to an empty field.
  for (const source of ['', '   ', '\n\n']) {
    const found = diagnoseUml(uml(source))
    assert.equal(found?.code, 'PARSE', `${JSON.stringify(source)} must be a parse failure`)
    assert.doesNotMatch(found.message, /recognised ones matched/)
  }
  assert.equal(diagnoseUml(uml(undefined))?.code, 'PARSE', 'a missing source is empty too')
})

test('an engine this board cannot render is reported as such, whatever the source says', () => {
  // Even a perfectly good plantuml source never renders here, so the message must not be about
  // the source. Naming the way out (rewrite it, or make it a code block) is the useful part.
  const found = diagnoseUml(uml('@startuml\nA -> B\n@enduml', { engine: 'plantuml' }))
  assert.equal(found?.code, 'UNSUPPORTED')
  assert.match(found.message, /plantuml/)
  assert.match(found.message, /mermaid/)
  assert.match(found.message, /`code` block/)
})

test('detectDiagramType answers mermaid\u2019s question and nothing else', () => {
  assert.match(detectDiagramType('flowchart TD\n A-->B'), /flowchart/)
  assert.match(detectDiagramType('sequenceDiagram\n A->>B: x'), /sequenceDiagram/)
  assert.equal(detectDiagramType('just some words'), undefined)
  assert.equal(detectDiagramType(''), undefined)
  assert.equal(detectDiagramType(undefined), undefined, 'a missing source is not a diagram')
})

// ---------------------------------------------------------------------------
// The map the projection carries
// ---------------------------------------------------------------------------

test('the diagnostic map covers every page and is keyed by block id', () => {
  const model = {
    pages: [
      page([uml('flowchart TD\n A-->B', { id: 'bl_ok', slug: 'ok' }), uml('nonsense', { id: 'bl_bad', slug: 'bad' })]),
      { id: 'pg_2', slug: 'other', blocks: [uml('', { id: 'bl_empty', slug: 'empty' })] },
    ],
  }
  const diag = diagnoseModel(model, undefined, 'r1')
  assert.deepEqual(Object.keys(diag).sort(), ['bl_bad', 'bl_empty'])
  assert.equal(diag.bl_bad.blockSlug, 'bad')
  assert.equal(diag.bl_bad.pageSlug, 'main')
  assert.equal(diag.bl_empty.pageSlug, 'other', 'a second page is walked too')
  assert.equal(diag.bl_bad.kind, 'uml')
})

test('only uml blocks are diagnosed', () => {
  // A prose block containing the word "hello world" is not a broken diagram.
  const model = {
    pages: [page([
      { id: 'bl_p', slug: 'p', kind: 'prose', markdown: 'hello world' },
      { id: 'bl_c', slug: 'c', kind: 'code', lang: 'mermaid', code: 'not a diagram either' },
    ])],
  }
  assert.deepEqual(diagnoseModel(model, undefined, 'r1'), {})
})

test('a diagnostic keeps the revision it was first seen at, so an ignored mistake is visible', () => {
  // This is the whole reason `firstFailedAtRev` exists: the Agent writes a board across several
  // batches, and a failure that has survived six of them should read differently from one it
  // just introduced.
  const broken = { pages: [page([uml('nonsense', { id: 'bl_bad', slug: 'bad' })])] }
  const first = diagnoseModel(broken, undefined, 'r1')
  assert.equal(first.bl_bad.firstFailedAtRev, 'r1')

  const second = diagnoseModel(broken, first, 'r2')
  assert.equal(second.bl_bad.firstFailedAtRev, 'r1', 'an unchanged failure keeps its first revision')

  // The same block, now failing differently: this is a new mistake and gets the new revision.
  const other = { pages: [page([uml('', { id: 'bl_bad', slug: 'bad' })])] }
  assert.equal(diagnoseModel(other, second, 'r3').bl_bad.firstFailedAtRev, 'r3')

  // And a different bad source with the same code is still the same complaint, unchanged.
  const stillUnsupported = { pages: [page([uml('still nonsense', { id: 'bl_bad', slug: 'bad' })])] }
  assert.equal(diagnoseModel(stillUnsupported, second, 'r4').bl_bad.firstFailedAtRev, 'r1')
})

test('a fixed diagram leaves the map', () => {
  const broken = { pages: [page([uml('nonsense', { id: 'bl_bad', slug: 'bad' })])] }
  const before = diagnoseModel(broken, undefined, 'r1')
  assert.equal(Object.keys(before).length, 1)

  const fixed = { pages: [page([uml('flowchart TD\n A-->B', { id: 'bl_bad', slug: 'bad' })])] }
  assert.deepEqual(diagnoseModel(fixed, before, 'r2'), {})
})

test('a block that disappears takes its diagnostic with it', () => {
  const broken = { pages: [page([uml('nonsense', { id: 'bl_bad', slug: 'bad' })])] }
  const before = diagnoseModel(broken, undefined, 'r1')
  const gone = { pages: [page([])] }
  assert.deepEqual(diagnoseModel(gone, before, 'r2'), {})
})
