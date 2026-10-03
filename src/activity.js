/**
 * The board's activity projection.
 *
 * Feeds the condensed chat strip (Q-K) without the client needing any transport of its own. The
 * client half has no plugin event bus and no `host.call`, so the only cheap way to get live
 * session facts into the browser is a wired projection — which is exactly how the board's own
 * state already arrives. This is the second of the plugin's two projections.
 *
 * Why a projection rather than reusing a stock one: `inbox` folds *pending* input, not the latest
 * message, and the transcript itself is not projected for this purpose. Folding two existing event
 * kinds (`assistant/message`, `user/message`) is cheap and adds no new event vocabulary — the rule
 * the whole design rests on.
 *
 * What it deliberately does **not** do:
 *   - It stores a short preview, not the message. The strip answers "what is happening", and the
 *     full text is one tab away; duplicating the transcript would double the memory for no gain.
 *   - It does not decide what is "unread". Read state is a property of the viewer, not of the
 *     session, so the client keeps its own watermark and compares it against `seq` here.
 *
 * @module dsh-superboard/activity
 */

import { z } from 'zod'

/** How much of a message to keep for the strip. */
const PREVIEW_CHARS = 200

/** The projection key the client reads with `useProjection('boardActivity')`. */
export const ACTIVITY_PROJECTION_KEY = 'boardActivity'

/** Bump on any change to the fields below or the fold's semantics. */
export const ACTIVITY_STATE_VERSION = 1

/** @returns a fresh, empty activity record. */
export function emptyActivity() {
  return {
    /** Messages seen so far, used as the client's read watermark. */
    seq: 0,
    /** `assistant` or `user` for the most recent message, or `null` before any. */
    role: null,
    /** One-line preview of the most recent message. */
    preview: '',
    /** Turn number of the most recent message, when the event carried one. */
    turn: null,
  }
}

/**
 * Fold one session event into the activity record.
 *
 * Pure and synchronous, and it returns the **same reference** for events it ignores — the
 * projection compares by `Object.is` to decide whether anything downstream needs to hear about the
 * event, so allocating on every unrelated event would wake the client for nothing.
 *
 * @param state - the current record.
 * @param event - one committed session event.
 * @returns the next record, or `state` itself when nothing changed.
 */
export function foldActivity(state, event) {
  const type = event?.type
  if (type !== 'assistant/message' && type !== 'user/message') return state

  const message = event.data?.message
  if (message === undefined || message === null) return state

  const preview = previewOf(message.content)
  // An assistant turn whose content is only tool calls has no text worth showing; keeping the
  // previous preview is more useful than blanking the strip.
  if (preview === '' && state.preview !== '') {
    return { ...state, seq: Number(event.seq ?? state.seq) }
  }

  return {
    seq: Number(event.seq ?? state.seq),
    role: message.role === 'user' ? 'user' : 'assistant',
    preview,
    turn: typeof event.data?.turn === 'number' ? event.data.turn : state.turn,
  }
}

/**
 * Reduce a message's content blocks to one line of text.
 *
 * Only `text` blocks contribute. Tool calls, images and the like are real content but not
 * summarisable into a preview, and inventing a placeholder for each would make the strip noisier
 * than the thing it is meant to summarise.
 *
 * @param content - the message's content blocks.
 * @returns the preview, possibly empty.
 */
export function previewOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const joined = parts.join(' ').replace(/\s+/gu, ' ').trim()
  return joined.length <= PREVIEW_CHARS ? joined : `${joined.slice(0, PREVIEW_CHARS - 1)}…`
}

/** The projection's own state schema, parsed when a checkpoint is restored. */
export const activityStateSchema = z.object({
  seq: z.number().int().nonnegative(),
  role: z.union([z.literal('assistant'), z.literal('user'), z.null()]),
  preview: z.string(),
  turn: z.number().int().nonnegative().nullable(),
})

/** The client-facing value. Identical to the state: there is nothing host-only in it. */
export const activityWireSchema = activityStateSchema

/**
 * Project the state down to the wire value.
 *
 * @param state - the activity record.
 * @returns the wire value.
 */
export function activityToWire(state) {
  return state
}
