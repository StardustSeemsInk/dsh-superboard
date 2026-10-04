/**
 * The node table: what a diagram says its parts are.
 *
 * This is derived data read out of someone else's grammar, so the tests are mostly about the
 * boundary — the forms it must get exactly right (a label that contains a bracket, an id that
 * contains a hyphen, a word that is an edge's label rather than a node) and the ones it must refuse
 * to answer at all. The failure mode worth guarding against is not a crash; it is a node list that
 * is quietly wrong, because that list is shown to the Agent as fact.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { attachNodeHints, nodeHintsFor } from '../src/uml.js'
import { encodeModelForHash } from '../src/model.js'

/** Just the keys, which is what an anchor names. */
const keys = (source) => nodeHintsFor(source)?.map((node) => node.key)

/** The table as `key=label` pairs, so an assertion reads as the answer rather than the object. */
const pairs = (source) => nodeHintsFor(source)?.map((node) => (node.label === node.key ? node.key : `${node.key}=${node.label}`))

// ---------------------------------------------------------------------------
// Flowchart
// ---------------------------------------------------------------------------

test('a shape declares a node and its label', () => {
  assert.deepEqual(pairs('flowchart TD\n  A[开始] --> B{是块吗}\n  B -->|是| C[选区浮条]\n  B -->|否| D[忽略]'), [
    'A=开始',
    'B=是块吗',
    'C=选区浮条',
    'D=忽略',
  ])
})

test('every shape mermaid accepts yields the label inside it, not the punctuation', () => {
  // The shapes are all "a label wrapped in matched brackets"; `[/text/]` and `[(text)]` are the
  // cases where a naive reader keeps a stray slash or parenthesis in the label.
  const source = [
    'flowchart TD',
    '  A[rect] --> B(round)',
    '  C([stadium]) --> D[[sub]]',
    '  E[(cyl)] --> F((circle))',
    '  G>asym] --> H{rhombus}',
    '  I{{hex}} --> J[/para/]',
    '  K[\\alt\\] --> L[/trap\\]',
  ].join('\n')
  assert.deepEqual(pairs(source), [
    'A=rect',
    'B=round',
    'C=stadium',
    'D=sub',
    'E=cyl',
    'F=circle',
    'G=asym',
    'H=rhombus',
    'I=hex',
    'J=para',
    'K=alt',
    'L=trap',
  ])
})

test('a quoted label is taken verbatim, brackets and pipes and all', () => {
  // Quotes are the only way to put a bracket in a label, so if they are not honoured the label ends
  // early and the rest of the diagram is read as syntax.
  assert.deepEqual(nodeHintsFor('flowchart TD\n  A["含 | 和 ] 的标签"] --> B'), [
    { key: 'A', label: '含 | 和 ] 的标签' },
    { key: 'B', label: 'B' },
  ])
})

test('an inline edge label is not a node', () => {
  // `A -- text --> B` is two link runs with a word between them, and `A --> B --> C` is the same
  // shape with a word between them. The difference is whether the first run carries an arrowhead,
  // and getting it wrong invents a node called `yes` in the first case or loses `B` in the second.
  assert.deepEqual(keys('flowchart TD\n  A -- yes --> B'), ['A', 'B'])
  assert.deepEqual(keys('flowchart TD\n  A --> B --> C'), ['A', 'B', 'C'])
  assert.deepEqual(keys('flowchart TD\n  A -. dotted .-> B'), ['A', 'B'])
  assert.deepEqual(keys('flowchart TD\n  A --- B'), ['A', 'B'])
})

test('a hyphen belongs to an identifier unless a link is starting', () => {
  // The two cases pull in opposite directions and a single pattern gets one of them wrong.
  assert.deepEqual(keys('flowchart TD\n  dash-status --> dash-next'), ['dash-status', 'dash-next'])
  assert.deepEqual(keys('graph LR\n  A-->B-->C'), ['A', 'B', 'C'])
})

test('a node first seen as an endpoint picks up the label it is declared with later', () => {
  const hints = nodeHintsFor('flowchart TD\n  A --> B\n  B[后声明的标签] --> C')
  assert.deepEqual(hints, [
    { key: 'A', label: 'A' },
    { key: 'B', label: '后声明的标签' },
    { key: 'C', label: 'C' },
  ])
})

test('the fan forms name every node they mention', () => {
  assert.deepEqual(keys('flowchart TD\n  A --> B & C\n  D & E --> F'), ['A', 'B', 'C', 'D', 'E', 'F'])
})

test('a subgraph contributes its members and is not itself a node', () => {
  // A subgraph is a container. Listing it as a node would offer the Agent an anchor key that no
  // shape in the picture corresponds to.
  assert.deepEqual(keys('flowchart TD\n  subgraph 一组\n    A[内] --> B[也内]\n  end\n  B --> C[外]'), ['A', 'B', 'C'])
})

test('styling and interaction lines name nothing', () => {
  // These lines are full of bare identifiers, and every one of them would become a phantom node.
  const source = [
    'flowchart TD',
    '  A --> B',
    '  classDef big fill:#f00',
    '  class A big',
    '  style B stroke:#333',
    '  click A href "http://example.com"',
    '  linkStyle 0 stroke:#333',
  ].join('\n')
  assert.deepEqual(keys(source), ['A', 'B'])
})

test('mermaid 11 object shapes are read too', () => {
  assert.deepEqual(pairs('flowchart TD\n  A@{ shape: rect, label: "新语法" } --> B'), ['A=新语法', 'B'])
})

test('a semicolon separates statements like a newline does', () => {
  // `flowchart TD; A-->B` puts the keyword and the first statement on one line. Splitting only on
  // newlines reads the whole thing as the keyword line and finds no nodes at all.
  assert.deepEqual(keys('flowchart TD; A-->B; B-->C'), ['A', 'B', 'C'])
})

test('frontmatter and comments are stripped rather than parsed', () => {
  assert.deepEqual(keys('---\ntitle: 图\n---\nflowchart TD\n  A --> B'), ['A', 'B'])
  assert.deepEqual(keys('%% a comment\nflowchart TD\n  %% inside\n  A --> B'), ['A', 'B'])
})

// ---------------------------------------------------------------------------
// The other four families
// ---------------------------------------------------------------------------

test('sequence participants carry their alias, and messages introduce the rest', () => {
  assert.deepEqual(pairs('sequenceDiagram\n  participant A as 用户\n  actor B as 看板\n  A->>B: 框选\n  B-->>A: 好了'), [
    'A=用户',
    'B=看板',
  ])
  assert.deepEqual(keys('sequenceDiagram\n  用户->>看板: 你好\n  看板->>宿主: POST'), ['用户', '看板', '宿主'])
})

test('the sequence control blocks do not invent participants', () => {
  // `loop`, `alt`, `else`, `end`, `Note over` are all lines whose first word looks like a
  // participant. The colon with an arrow before it is what separates a message from all of them.
  const source = [
    'sequenceDiagram',
    '  loop 每天',
    '    A->>B: x',
    '  end',
    '  alt 是',
    '    A->>C: y',
    '  else 否',
    '    A->>D: z',
    '  end',
    '  Note over A,B: 备注',
  ].join('\n')
  assert.deepEqual(keys(source), ['A', 'B', 'C', 'D'])
})

test('classes come from declarations, relations and member lines alike', () => {
  const source = ['classDiagram', '  class Animal {', '    +int age', '  }', '  Animal <|-- Dog : 继承', '  Dog : +bark()'].join('\n')
  assert.deepEqual(keys(source), ['Animal', 'Dog'])
})

test('a state may be declared with a name, and the pseudo-state is not one', () => {
  const source = ['stateDiagram-v2', '  [*] --> Idle', '  Idle --> Running : start', '  Running --> [*]', '  state "等待中" as Waiting'].join('\n')
  // Idle and Running are named by the transitions that mention them, so key and label coincide;
  // Waiting is the case where the diagram gives it a display name of its own.
  assert.deepEqual(pairs(source), ['Idle', 'Running', 'Waiting=等待中'])
})

test('entities come from relations and from entity blocks', () => {
  const source = ['erDiagram', '  CUSTOMER ||--o{ ORDER : places', '  ORDER {', '    string id', '  }'].join('\n')
  assert.deepEqual(keys(source), ['CUSTOMER', 'ORDER'])
})

// ---------------------------------------------------------------------------
// What it refuses to answer
// ---------------------------------------------------------------------------

test('a family this file cannot read yields no table rather than an empty one', () => {
  // "Unknown" and "none" are different answers. An empty list would be a claim that the diagram has
  // no parts, which for a pie chart is false in the way that matters.
  assert.equal(nodeHintsFor('pie title 去向\n  "a" : 1'), undefined)
  assert.equal(nodeHintsFor('gantt\n  title x\n  section s\n  t :a1, 2024-01-01, 3d'), undefined)
  assert.equal(nodeHintsFor('mindmap\n  root((看板))'), undefined)
})

test('something that is not a diagram at all yields no table', () => {
  // The keyword must open the document. A stray `flowchart` deeper in the text is a word, not a
  // diagram, and reading it as one would decorate a broken block with a confident node list.
  assert.equal(nodeHintsFor(''), undefined)
  assert.equal(nodeHintsFor('   '), undefined)
  assert.equal(nodeHintsFor(undefined), undefined)
  assert.equal(nodeHintsFor('hello world'), undefined)
  assert.equal(nodeHintsFor('这只是散文\nflowchart TD\n  A --> B'), undefined)
})

// ---------------------------------------------------------------------------
// Attaching it to the model
// ---------------------------------------------------------------------------

const board = (blocks) => ({
  title: 'Board',
  pages: [{ id: 'pg_1', slug: 'main', alias: [], blocks, createdAtRev: 'r1-x' }],
  regions: [],
  edges: [],
  revSeq: 1,
  revHash: 'x',
  rev: 'r1-x',
})
const umlBlock = (source, extra = {}) => ({
  id: 'bl_1',
  slug: 'flow',
  alias: [],
  anchors: [],
  createdAtRev: 'r1-x',
  updatedAtRev: 'r1-x',
  kind: 'uml',
  engine: 'mermaid',
  diagram: 'flowchart',
  source,
  ...extra,
})

test('attaching a table sets it on the block and leaves everything else alone', () => {
  const model = board([umlBlock('flowchart TD\n  A[一] --> B')])
  const next = attachNodeHints(model)
  assert.deepEqual(next.pages[0].blocks[0].nodeHints, [
    { key: 'A', label: '一' },
    { key: 'B', label: 'B' },
  ])
  assert.equal(next.rev, model.rev, 'derived data must not move the revision')
  assert.equal(next.pages[0].blocks[0].source, 'flowchart TD\n  A[一] --> B')
})

test('attaching is a no-op when nothing would change', () => {
  // The fold runs this on every committed batch. A board with no diagrams, or one whose diagrams
  // have not changed, should keep its object identity rather than being rebuilt each time.
  const plain = board([{ ...umlBlock('flowchart TD\n  A --> B'), kind: 'heading', text: 'x' }])
  assert.equal(attachNodeHints(plain), plain, 'no uml block means no work')

  const once = attachNodeHints(board([umlBlock('flowchart TD\n  A --> B')]))
  assert.equal(attachNodeHints(once), once, 'the same source produces the same table')
})

test('a table is removed when the source stops being one this file can read', () => {
  // Otherwise a block that was rewritten from a flowchart into a pie chart would keep advertising
  // nodes that are no longer in it.
  const once = attachNodeHints(board([umlBlock('flowchart TD\n  A --> B')]))
  assert.ok(Array.isArray(once.pages[0].blocks[0].nodeHints))

  const rewritten = attachNodeHints({ ...once, pages: [{ ...once.pages[0], blocks: [umlBlock('pie title x\n  "a" : 1')] }] })
  assert.equal('nodeHints' in rewritten.pages[0].blocks[0], false)
})

test('the content hash does not see the node table', () => {
  // This is what makes it safe to improve the parser later: a better table is a better reading of
  // the same document, not a new document, so it must not look like an edit to anyone comparing
  // revisions. `src/model.js` excludes it for this reason and this is the assertion that keeps the
  // exclusion honest.
  const without = board([umlBlock('flowchart TD\n  A[一] --> B')])
  const withHints = board([
    umlBlock('flowchart TD\n  A[一] --> B', {
      nodeHints: [
        { key: 'A', label: '一' },
        { key: 'B', label: 'B' },
      ],
    }),
  ])
  assert.equal(encodeModelForHash(withHints), encodeModelForHash(without))

  // And the source itself does move the hash, so the exclusion is not simply "uml blocks are
  // invisible to the revision".
  const edited = board([umlBlock('flowchart TD\n  A[改写] --> B')])
  assert.notEqual(encodeModelForHash(edited), encodeModelForHash(without))
})
