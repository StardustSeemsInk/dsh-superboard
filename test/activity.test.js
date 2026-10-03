/**
 * Activity-projection tests.
 *
 * This projection is what the condensed chat strip reads. Two properties matter enough to pin
 * down: it must be cheap for the events it ignores (the projection compares by `Object.is`, so
 * allocating on every unrelated event would wake the client for nothing), and it must reduce a
 * message to a preview without inventing content that is not there.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ACTIVITY_STATE_VERSION,
  activityStateSchema,
  activityWireSchema,
  emptyActivity,
  foldActivity,
  previewOf,
} from '../src/activity.js'

/** One committed assistant message. */
function assistant(seq, text, turn = 1) {
  return {
    type: 'assistant/message',
    seq,
    data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

/** One committed user message. */
function user(seq, text, turn = 1) {
  return {
    type: 'user/message',
    seq,
    data: { turn, message: { role: 'user', content: [{ type: 'text', text }] } },
  }
}

test('a fresh record says nothing rather than guessing', () => {
  const state = emptyActivity()
  assert.equal(state.seq, 0)
  assert.equal(state.role, null)
  assert.equal(state.preview, '')
  assert.equal(state.turn, null)
})

test('an assistant message becomes the preview', () => {
  const state = foldActivity(emptyActivity(), assistant(12, '登录服务处理会话。', 3))
  assert.equal(state.seq, 12)
  assert.equal(state.role, 'assistant')
  assert.equal(state.preview, '登录服务处理会话。')
  assert.equal(state.turn, 3)
})

test('a user message is marked as such, so the strip can attribute it', () => {
  const state = foldActivity(emptyActivity(), user(5, '这两个是不是耦合过紧？'))
  assert.equal(state.role, 'user')
  assert.equal(state.preview, '这两个是不是耦合过紧？')
})

test('the latest message wins', () => {
  let state = foldActivity(emptyActivity(), user(5, '第一句'))
  state = foldActivity(state, assistant(9, '第二句'))
  assert.equal(state.seq, 9)
  assert.equal(state.role, 'assistant')
  assert.equal(state.preview, '第二句')
})

test('an ignored event returns the same reference, which is what keeps the client quiet', () => {
  const state = foldActivity(emptyActivity(), assistant(9, '有内容'))
  // The projection compares by Object.is to decide whether to re-project, so an unrelated event
  // must not allocate — otherwise every tool call would republish the strip's value.
  for (const event of [
    { type: 'tool/call', seq: 10, data: { name: 'read' } },
    { type: 'tool/result', seq: 11, data: {} },
    { type: 'turn/start', seq: 12, data: {} },
    { type: 'assistant/attempt', seq: 13, data: {} },
    { type: undefined, seq: 14, data: {} },
    undefined,
  ]) {
    assert.equal(foldActivity(state, event), state)
  }
})

test('a message with no text does not blank the strip', () => {
  // An assistant turn consisting only of tool calls has no text; keeping the previous preview is
  // more useful than showing nothing, and the sequence still advances.
  let state = foldActivity(emptyActivity(), assistant(9, '我在看你的看板。'))
  state = foldActivity(state, {
    type: 'assistant/message',
    seq: 14,
    data: { turn: 2, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1' }] } },
  })

  assert.equal(state.seq, 14, 'the watermark still moves')
  assert.equal(state.preview, '我在看你的看板。')
})

test('a malformed message is skipped rather than thrown on', () => {
  const state = foldActivity(emptyActivity(), assistant(9, 'ok'))
  for (const event of [
    { type: 'assistant/message', seq: 10, data: {} },
    { type: 'assistant/message', seq: 11, data: { message: null } },
    { type: 'user/message', seq: 12, data: { message: { role: 'user', content: 'not an array' } } },
  ]) {
    const next = foldActivity(state, event)
    assert.equal(next.preview, 'ok', 'the previous preview survives')
  }
})

test('multiple text blocks are joined, and whitespace collapsed to one line', () => {
  const state = foldActivity(emptyActivity(), {
    type: 'assistant/message',
    seq: 3,
    data: {
      turn: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段\n换行了' },
        ],
      },
    },
  })
  assert.equal(state.preview, '第一段 第二段 换行了')
})

test('a long message is shortened, because the strip is one line', () => {
  const state = foldActivity(emptyActivity(), assistant(3, '内容'.repeat(400)))
  assert.ok(state.preview.length <= 200)
  assert.ok(state.preview.endsWith('…'))
})

test('only text blocks contribute to a preview', () => {
  assert.equal(previewOf([{ type: 'image', id: 'i1' }]), '')
  assert.equal(previewOf(undefined), '')
  assert.equal(previewOf([{ type: 'text', text: 'a' }, { type: 'image' }]), 'a')
})

test('a restored checkpoint passes the state schema', () => {
  // The projection parses a restored checkpoint through this schema, and parsing throws rather
  // than degrading — so a field the fold produces but the schema omits would break every cold
  // start while live sessions looked fine.
  let state = emptyActivity()
  state = foldActivity(state, assistant(9, 'hello'))
  assert.doesNotThrow(() => activityStateSchema.parse(state))
  assert.doesNotThrow(() => activityWireSchema.parse(state))
})

test('the strip publishes nothing host-only', () => {
  // The wire value is the state itself; if that ever stops being true the client would receive a
  // field the schema rejects.
  const state = foldActivity(emptyActivity(), user(4, 'hi'))
  assert.equal(JSON.stringify(activityWireSchema.parse(state)), JSON.stringify(state))
  assert.equal(typeof ACTIVITY_STATE_VERSION, 'number')
})
