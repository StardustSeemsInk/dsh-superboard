/**
 * Zod schemas for the board projection.
 *
 * These exist for one specific job: the session-projection layer parses a **checkpointed**
 * state back through `stateSchema` when it restores a cached cell
 * (`dsh-session-projection/lib/index.js:255,297`). So the schema is the guard that a value
 * written by an older build is not silently accepted by a newer one. That is why
 * `stateVersion` and these shapes must move together.
 *
 * The wire schema is the client-facing projection: it drops `pending` (a two-phase pairing
 * detail the board view has no use for) and `sessionId` (host bookkeeping).
 *
 * @module dsh-superboard/schema
 */

import { z } from 'zod'
import { BLOCK_KINDS, BOARD_MODEL_VERSION, EDGE_RELS, LAYOUT_TEMPLATES, applyAreas } from './model.js'

const anchorAt = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('block') }),
  z.object({ kind: z.literal('field'), field: z.enum(['title', 'code', 'caption', 'filename']) }),
  z.object({ kind: z.literal('item'), itemId: z.string() }),
  z.object({ kind: z.literal('lines'), from: z.number(), to: z.number() }),
  z.object({ kind: z.literal('text'), start: z.number(), end: z.number(), quote: z.string().optional() }),
  z.object({ kind: z.literal('child'), childId: z.string() }),
  z.object({ kind: z.literal('node'), key: z.string() }),
  z.object({
    kind: z.literal('rect'),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }),
  z.object({ kind: z.literal('point'), x: z.number(), y: z.number() }),
])

const anchor = z.object({
  blockId: z.string(),
  at: anchorAt.optional(),
})

const layout = z.object({
  template: z.enum(LAYOUT_TEMPLATES),
  params: z.record(z.string(), z.unknown()).optional(),
  hints: z.record(z.string(), z.unknown()).optional(),
})

const baseBlock = {
  id: z.string(),
  slug: z.string(),
  alias: z.array(z.string()),
  anchors: z.array(anchorAt),
  regionId: z.string().optional(),
  createdAtRev: z.string(),
  updatedAtRev: z.string(),
}

const block = z.discriminatedUnion('kind', [
  z.object({ ...baseBlock, kind: z.literal('heading'), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), text: z.string() }),
  z.object({ ...baseBlock, kind: z.literal('prose'), markdown: z.string(), collapsed: z.boolean().optional() }),
  z.object({
    ...baseBlock,
    kind: z.literal('list'),
    ordered: z.boolean(),
    items: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        depth: z.number(),
        checked: z.boolean().optional(),
      }),
    ),
  }),
  z.object({ ...baseBlock, kind: z.literal('code'), lang: z.string(), code: z.string(), filename: z.string().optional() }),
  z.object({
    ...baseBlock,
    kind: z.literal('uml'),
    engine: z.enum(['mermaid', 'plantuml']),
    diagram: z.enum(['flowchart', 'sequence', 'class', 'state', 'er', 'gantt', 'other']),
    source: z.string(),
    renderedHash: z.string().optional(),
    nodeHints: z.array(z.object({ key: z.string(), label: z.string() })).optional(),
  }),
  z.object({
    ...baseBlock,
    kind: z.literal('image'),
    src: z.string(),
    alt: z.string(),
    naturalSize: z.object({ w: z.number(), h: z.number() }).optional(),
    caption: z.string().optional(),
  }),
  z.object({
    ...baseBlock,
    kind: z.literal('pdf-page'),
    src: z.string(),
    page: z.number(),
    crop: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
    caption: z.string().optional(),
  }),
  z.object({
    ...baseBlock,
    kind: z.literal('group'),
    title: z.string().optional(),
    children: z.array(z.string()),
    collapsed: z.boolean().optional(),
    /**
     * How this container arranges its children.
     *
     * A group is the only thing that lays anything out besides a page, and groups nest — so the
     * visual tree the Agent edits is `page → group → group → … → block`. `region` deliberately has
     * no layout: it is annotation, not arrangement, and giving both a layout is what made them
     * ambiguous in the first place.
     */
    layout: layout.optional(),
  }),
])

const page = z.object({
  id: z.string(),
  slug: z.string(),
  alias: z.array(z.string()),
  blocks: z.array(block),
  layout: layout.optional(),
  createdAtRev: z.string(),
})

/**
 * A region: a labelled, toned set of blocks.
 *
 * **Annotation, not arrangement** (the layout grill's division of labour). A region says "watch
 * these" — it draws attention without moving anything — while a `group` decides where things go.
 * Membership is flat rather than nested on purpose: a highlight should be able to sit inside a
 * layout without fighting it. That is also why there is no `layout` field here any more.
 */
const region = z.object({
  id: z.string(),
  slug: z.string(),
  alias: z.array(z.string()),
  blockIds: z.array(z.string()),
  label: z.string().optional(),
  tone: z.enum(['neutral', 'warn', 'danger', 'ok']).optional(),
  createdAtRev: z.string(),
})

const edge = z.object({
  id: z.string(),
  slug: z.string(),
  alias: z.array(z.string()),
  from: anchor,
  to: anchor,
  rel: z.enum(EDGE_RELS).optional(),
  label: z.string().optional(),
  style: z.enum(['solid', 'dashed', 'dotted']).optional(),
  waypoints: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  createdAtRev: z.string(),
  updatedAtRev: z.string(),
})

const renderDiagnostic = z.object({
  blockId: z.string(),
  blockSlug: z.string(),
  pageSlug: z.string(),
  kind: z.enum(BLOCK_KINDS),
  code: z.enum(['PARSE', 'LIMIT', 'MISSING_ASSET', 'UNSUPPORTED', 'ENGINE_ERROR']),
  message: z.string(),
  at: z.object({ line: z.number(), column: z.number() }).optional(),
  firstFailedAtRev: z.string(),
})

const boardModel = z.object({
  title: z.string(),
  pages: z.array(page).min(1),
  regions: z.array(region),
  edges: z.array(edge),
  revSeq: z.number().int().nonnegative(),
  revHash: z.string(),
  rev: z.string(),
})

/**
 * The projection's state schema.
 *
 * `pending` is a plain record rather than a fixed shape on purpose: its keys are arbitrary
 * call ids, and its values are whatever the model passed, which is by definition not
 * something we can promise a shape for. The fold treats anything unusable as "skip".
 */
export const boardDocSchema = z.object({
  modelVersion: z.literal(BOARD_MODEL_VERSION),
  sessionId: z.string(),
  model: boardModel,
  diag: z.record(z.string(), renderDiagnostic),
  pending: z.record(z.string(), z.unknown()),
  /**
   * The most recent rejected batch, if any.
   *
   * A failed batch changes nothing, by design — which means the board cannot show that the
   * Agent tried. Recording the reason here is what lets the standing outline mention it
   * before the Agent thinks to re-read, without inventing a second source of truth.
   */
  lastOpError: z.object({ callId: z.string(), message: z.string() }).optional(),
})

/** What the client receives. */
export const boardWireSchema = z.object({
  modelVersion: z.literal(BOARD_MODEL_VERSION),
  model: boardModel,
  diag: z.record(z.string(), renderDiagnostic),
})

/**
 * Project the full document down to the client-facing value.
 *
 * This is where an `areas` template becomes the line numbers the renderer uses. The host validated
 * the template while folding, but only the projection spans host and client, so resolving here
 * means one implementation decides the geometry and the two halves cannot drift. The derived values
 * live in `layout.params`, which is an open record on both schemas — so the document never carries
 * them and the revision never sees them.
 *
 * @param state - the board document.
 * @returns the wire value: the model, with placements resolved, and diagnostics.
 */
export function toWire(state) {
  return { modelVersion: state.modelVersion, model: applyAreas(state.model), diag: state.diag }
}
