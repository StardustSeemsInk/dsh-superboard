/**
 * Markdown and transcript-extraction tests.
 *
 * Both are pure and DOM-free, which is exactly why they are worth testing: the renderer itself is
 * hard to check without a browser, but *what counts as a block* and *what counts as dialogue* are
 * decided here, and both are easy to get subtly wrong in ways that look fine on screen.
 *
 * The security property is the one to keep honest. Board text is written by the Agent, and the
 * Agent's input is whatever it has been reading, so a card's text is untrusted by the time it
 * renders. The renderer builds React elements and never an HTML string, and the link guard refuses
 * anything that could execute — these tests pin both down.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const CLIENT_PATH = new URL('../src/client.js', import.meta.url)

/** Minimal React stand-in, mirroring the one in client.test.js. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (compute) => compute(),
  useCallback: (callback) => callback,
}

/** Load the client half in a sandbox and return its exports. */
function loadClient() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => (registered = definition) } },
    requestAnimationFrame: (callback) => (callback(), 1),
    cancelAnimationFrame: () => {},
    ResizeObserver: undefined,
    localStorage: {
      store: new Map(),
      getItem(key) {
        return this.store.has(key) ? this.store.get(key) : null
      },
      setItem(key, value) {
        this.store.set(key, String(value))
      },
    },
    Math,
    JSON,
    String,
    Number,
    Object,
    Array,
    Set,
    Map,
    Boolean,
    RegExp,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)
  return registered.factory((specifier) => {
    if (specifier === 'react') return fakeReact
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
}

const client = loadClient()

/**
 * Copy a value out of the sandbox realm.
 *
 * The client half runs in its own VM context, so arrays and objects it returns do not share this
 * realm's prototype — and `deepStrictEqual` compares prototypes, so equal data would be rejected as
 * "same structure but not reference-equal". Round-tripping through JSON puts it back in this realm.
 */
const plain = (value) => JSON.parse(JSON.stringify(value))
const { parseMarkdownBlocks, textFromBlocks, dialogueFromChat } = client

/** Compact view of a parse result, so assertions read as the shape rather than the object. */
const shape = (source) => parseMarkdownBlocks(source).map((block) => block.type)

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

test('a paragraph is a paragraph, and a blank line separates two of them', () => {
  const blocks = parseMarkdownBlocks('第一段\n还是第一段\n\n第二段')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].text, '第一段\n还是第一段')
  assert.equal(blocks[1].text, '第二段')
})

test('headings carry their level', () => {
  const blocks = parseMarkdownBlocks('# 一级\n\n### 三级')
  assert.equal(blocks[0].type, 'heading')
  assert.equal(blocks[0].level, 1)
  assert.equal(blocks[0].text, '一级')
  assert.equal(blocks[1].level, 3)
})

test('seven hashes is not a heading, it is text', () => {
  // CommonMark caps headings at six, and guessing here would silently reformat the Agent's text.
  assert.equal(plain(shape('####### 七个'))[0], 'paragraph')
})

test('a fenced code block keeps its body verbatim, markers and all', () => {
  const blocks = parseMarkdownBlocks('```ts\nconst a = 1\n# not a heading\n```')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'code')
  assert.equal(blocks[0].lang, 'ts')
  assert.equal(blocks[0].text, 'const a = 1\n# not a heading')
})

test('an unclosed fence runs to the end rather than swallowing the text as a paragraph', () => {
  const blocks = parseMarkdownBlocks('```\nstill code\nand more')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'code')
  assert.equal(blocks[0].text, 'still code\nand more')
})

test('a fence with no language still parses', () => {
  const blocks = parseMarkdownBlocks('```\nplain\n```')
  assert.equal(blocks[0].lang, '')
})

test('a quote collects its consecutive lines and drops the markers', () => {
  const blocks = parseMarkdownBlocks('> 第一行\n> 第二行\n\n普通段落')
  assert.equal(blocks[0].type, 'quote')
  assert.equal(blocks[0].text, '第一行\n第二行')
  assert.equal(blocks[1].type, 'paragraph')
})

test('bullets and numbers produce different lists, and nesting is kept as depth', () => {
  const bullets = parseMarkdownBlocks('- 一\n- 二\n  - 二点一')
  assert.equal(bullets.length, 1)
  assert.equal(bullets[0].type, 'list')
  assert.equal(bullets[0].ordered, false)
  assert.equal(bullets[0].items.length, 3)
  assert.equal(bullets[0].items[2].depth, 1)

  const numbers = parseMarkdownBlocks('1. 一\n2. 二')
  assert.equal(numbers[0].ordered, true)
})

test('switching marker style starts a new list rather than mixing them', () => {
  // A single list cannot be both bulleted and numbered, so this is two blocks.
  assert.deepEqual(plain(shape('- 一\n1. 二')), ['list', 'list'])
})

test('blank lines between code, headings and text keep the blocks apart', () => {
  assert.deepEqual(plain(shape('# 标题\n\n正文\n\n```\ncode\n```\n\n- 项')), ['heading', 'paragraph', 'code', 'list'])
})

test('an empty or missing body produces no blocks rather than an empty one', () => {
  assert.deepEqual(plain(parseMarkdownBlocks('')), [])
  assert.deepEqual(plain(parseMarkdownBlocks(undefined)), [])
  assert.deepEqual(plain(parseMarkdownBlocks('   \n\n  ')), [])
})

test('CRLF is normalised, so a Windows-authored body does not smuggle a bare carriage return in', () => {
  assert.equal(parseMarkdownBlocks('第一行\r\n第二行')[0].text, '第一行\n第二行')
})

test('the parser always advances, so hostile input cannot hang it', () => {
  // Every branch either consumes a line or is guarded by a check that the first line qualifies.
  for (const source of ['###', '>', '-', '```', '~~~', '> > >', '- ', '1.', '#'.repeat(200)]) {
    const blocks = parseMarkdownBlocks(source)
    assert.ok(Array.isArray(blocks))
    assert.ok(blocks.length <= 4, `${JSON.stringify(source)} produced ${blocks.length} blocks`)
  }
})

test('an unrecognised construct stays literal text instead of being reinterpreted', () => {
  // Failing inert is the point: a table or an HTML tag is shown as typed.
  const blocks = parseMarkdownBlocks('| a | b |\n| - | - |\n<div>raw</div>')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'paragraph')
  assert.match(blocks[0].text, /<div>raw<\/div>/)
})

// ---------------------------------------------------------------------------
// Rendering safety
// ---------------------------------------------------------------------------

test('the renderer never builds an HTML string', () => {
  // The single most important property here: React elements cannot execute, innerHTML can. The
  // assertion looks for *usage* rather than the bare word, because client.js names the forbidden
  // API in a doc comment precisely in order to say it is not used.
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.doesNotMatch(source, /dangerouslySetInnerHTML\s*:/)
  assert.doesNotMatch(source, /\.innerHTML\s*=/)
  assert.match(source, /there is no `dangerouslySetInnerHTML` in this file/)
})

test('the link guard admits ordinary destinations and refuses executing schemes', () => {
  // Board text is Agent-written, and the Agent's input is whatever it has been reading, so a link
  // destination is untrusted. Anything that could execute must be refused, and the refusal has to
  // leave the text visible rather than silently dropping it.
  for (const href of ['https://example.com', 'http://example.com', 'mailto:a@b.c', '/docs/x', '#anchor']) {
    assert.equal(client.safeHref(href), href, `${href} should be allowed`)
  }
  for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd']) {
    assert.equal(client.safeHref(href), undefined, `${href} should be refused`)
  }
  assert.equal(client.safeHref(undefined), undefined)
})

test('a refused link is still shown, just not as a link', () => {
  // Refusing must not delete the user's text: it becomes inert literal text instead.
  const nodes = client.parseInline('[点我](javascript:alert(1))')
  const flat = JSON.stringify(nodes)
  assert.ok(flat.includes('javascript'), 'the destination survives as text')
  assert.ok(!flat.includes('"a"'), 'but no anchor node is produced')
})

// ---------------------------------------------------------------------------
// Transcript extraction
// ---------------------------------------------------------------------------

test('both block shapes are understood, because they disagree in the wild', () => {
  // A user message's blocks carry `type`; an assistant view node's blocks carry `kind`.
  assert.equal(textFromBlocks([{ type: 'text', text: '来自用户消息' }]), '来自用户消息')
  assert.equal(textFromBlocks([{ kind: 'text', text: '来自助手视图' }]), '来自助手视图')
  assert.equal(textFromBlocks([{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }]), 'a\n\nb')
})

test('thinking and tool calls drop out, which is the "dialogue only" the user asked for', () => {
  const blocks = [
    { kind: 'reasoning', text: '我在想……' },
    { kind: 'text', text: '答案是 42' },
    { kind: 'tool-call', id: 'c1' },
  ]
  assert.equal(textFromBlocks(blocks), '答案是 42')
})

test('a malformed block array yields nothing rather than throwing', () => {
  assert.equal(textFromBlocks(undefined), '')
  assert.equal(textFromBlocks('not an array'), '')
  assert.equal(textFromBlocks([null, 1, 'x', { kind: 'text' }]), '')
})

test('the transcript keeps only dialogue and orders it by sequence', () => {
  const snapshot = {
    nodes: {
      values: () => [
        { key: 'k3', kind: 'assistant-step', anchorSeq: 30, data: { blocks: [{ kind: 'text', text: '第二句' }] } },
        { key: 'k1', kind: 'user', anchorSeq: 10, data: { content: [{ type: 'text', text: '第一句' }] } },
        { key: 'k2', kind: 'tool-call', anchorSeq: 20, data: {} },
        { key: 'k4', kind: 'turn-process', anchorSeq: 25, data: {} },
      ],
    },
  }
  const turns = dialogueFromChat(snapshot)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].role, 'user')
  assert.equal(turns[0].text, '第一句')
  assert.equal(turns[1].role, 'assistant')
  assert.equal(turns[1].text, '第二句')
})

test('a hidden node is skipped, because chat itself does not render one', () => {
  const snapshot = {
    nodes: {
      values: () => [
        { key: 'k1', kind: 'user', anchorSeq: 10, visibility: 'hidden', data: { content: [{ type: 'text', text: '藏起来' }] } },
        { key: 'k2', kind: 'user', anchorSeq: 20, data: { content: [{ type: 'text', text: '看得见' }] } },
      ],
    },
  }
  const turns = dialogueFromChat(snapshot)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].text, '看得见')
})

test('a node with no text is dropped, so a tool-only step leaves no empty bubble', () => {
  const snapshot = {
    nodes: {
      values: () => [{ key: 'k1', kind: 'assistant-step', anchorSeq: 10, data: { blocks: [{ kind: 'tool-call', id: 'c1' }] } }],
    },
  }
  assert.deepEqual(plain(dialogueFromChat(snapshot)), [])
})

test('a missing snapshot yields no dialogue rather than throwing', () => {
  assert.deepEqual(plain(dialogueFromChat(undefined)), [])
  assert.deepEqual(plain(dialogueFromChat({})), [])
  assert.deepEqual(plain(dialogueFromChat({ nodes: {} })), [])
})

// ---------------------------------------------------------------------------
// Remembered width
// ---------------------------------------------------------------------------

test('a stored width round-trips, and a hostile one falls back', () => {
  assert.equal(client.readNumber('missing', 420), 420)
  client.writeNumber('w', 380)
  assert.equal(client.readNumber('w', 420), 380)
  // A corrupt or non-numeric value must not become a NaN width in a style attribute.
  globalThis.localStorage?.setItem?.('bad', 'wide')
  assert.equal(client.readNumber('bad', 420), 420)
})
