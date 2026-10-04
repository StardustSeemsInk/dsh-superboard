/**
 * The host-side runtime: the vendored mermaid bundle, the route that serves it, and the reports
 * the board view sends back.
 *
 * The bundle is committed, so the first test here is the one that keeps it honest — the file on
 * disk is hashed and compared against the record written beside it by `scripts/vendor-mermaid.mjs`.
 * A vendored artefact nobody can verify is a vendored artefact nobody should trust.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  blockIndex,
  MERMAID_ROUTE,
  RENDER_REPORT_ROUTE,
  readRuntimeManifest,
  registerRuntimeRoutes,
  RenderReports,
} from '../src/runtime.js'

const MANIFEST = readRuntimeManifest()
const BUNDLE = readFileSync(new URL('../vendor/mermaid.min.js', import.meta.url))

/** A plugin context that records the routes instead of serving them. */
function fakeContext() {
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {}, error: () => {} },
    effect: (factory) => {
      factory()
    },
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  return { ctx, routes }
}

/** A request whose body is delivered when the handler subscribes. */
function fakeRequest(method, { body, headers = {} } = {}) {
  const handlers = new Map()
  const req = {
    method,
    headers,
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return req
    },
    destroy() {},
  }
  req.flush = () => {
    if (body !== undefined) {
      for (const handler of handlers.get('data') ?? []) handler(Buffer.from(body, 'utf8'))
    }
    for (const handler of handlers.get('end') ?? []) handler()
  }
  return req
}

/** A response that records what it was told. */
function fakeResponse() {
  const res = { status: undefined, headers: {}, body: undefined, headersSent: false }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers ?? {}
    res.headersSent = true
  }
  res.end = (chunk) => {
    res.body = chunk
  }
  return res
}

/** Let the report handler's promise chain settle. */
const settled = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// The vendored artefact
// ---------------------------------------------------------------------------

test('the committed bundle is the one the manifest describes', () => {
  // The whole point of committing a 3.5 MB artefact: it can be checked. Without this, the file and
  // its record could drift apart silently and the recorded version would be a claim, not a fact.
  assert.ok(MANIFEST !== undefined, 'vendor/mermaid.json must exist; run `npm run vendor:mermaid`')
  assert.equal(BUNDLE.length, MANIFEST.bytes, 'vendor/mermaid.min.js is a different length than recorded')
  assert.equal(
    createHash('sha256').update(BUNDLE).digest('hex'),
    MANIFEST.sha256,
    'vendor/mermaid.min.js does not match the sha256 in its manifest',
  )
  assert.equal(MANIFEST.source, 'node_modules/mermaid/dist/mermaid.min.js')
})

test('the vendored file is the browser bundle, not the ESM entry', () => {
  // `mermaid/package.json` points `exports["."]` at `dist/mermaid.core.mjs`, which is 53 KB and
  // expects its diagrams to be registered by imports this file cannot make. Copying that by mistake
  // would produce a runtime that loads fine and then fails on the first render.
  const head = BUNDLE.subarray(0, 64).toString('utf8')
  const text = BUNDLE.toString('utf8')
  assert.match(head, /^"use strict"/)
  assert.ok(text.includes('globalThis["mermaid"]'), 'the IIFE must set the global it is loaded for')
})

test('the manifest carries the diagram registry read out of mermaid itself', () => {
  // The lint asks mermaid's own question — "is there a diagram here" — by running mermaid's own
  // detector regexes, so that list has to be the real one and not a hand-typed approximation.
  assert.ok(Array.isArray(MANIFEST.diagramDetectors), 'diagramDetectors must be recorded')
  assert.ok(MANIFEST.diagramDetectors.length >= 20, `only ${MANIFEST.diagramDetectors.length} detectors`)
  assert.ok(MANIFEST.diagramIds.includes('sequence'), 'the registry must include sequence')
  assert.ok(MANIFEST.diagramIds.includes('flowchart-v2'), 'the registry must include flowchart-v2')
})

// ---------------------------------------------------------------------------
// The runtime route
// ---------------------------------------------------------------------------

test('the runtime route serves the bundle and revalidates instead of re-sending it', async () => {
  const { ctx, routes } = fakeContext()
  registerRuntimeRoutes(ctx, new RenderReports())
  const route = routes.get(MERMAID_ROUTE)
  assert.ok(route !== undefined, `${MERMAID_ROUTE} must be registered`)
  assert.equal(route.kind, 'exact')

  const first = fakeResponse()
  await route.handler(fakeRequest('GET'), first)
  assert.equal(first.status, 200)
  assert.equal(first.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(first.headers['cache-control'], 'no-cache')
  assert.equal(first.body.length, BUNDLE.length, 'the body must be the whole bundle')
  assert.match(first.headers.etag, /^"mermaid-/)

  // The second request carries the tag back. This is what keeps the file editable under a stable
  // URL: the browser stores 3.5 MB and asks about it instead of fetching it again.
  const second = fakeResponse()
  await route.handler(fakeRequest('GET', { headers: { 'if-none-match': first.headers.etag } }), second)
  assert.equal(second.status, 304)
  assert.equal(second.body, undefined, 'a 304 must not carry a body')
})

test('the runtime route answers HEAD without a body and refuses anything else', async () => {
  const { ctx, routes } = fakeContext()
  registerRuntimeRoutes(ctx, new RenderReports())
  const route = routes.get(MERMAID_ROUTE)

  const head = fakeResponse()
  await route.handler(fakeRequest('HEAD'), head)
  assert.equal(head.status, 200)
  assert.equal(head.body, undefined, 'HEAD must report the length without sending it')
  assert.equal(head.headers['content-length'], BUNDLE.length)

  const post = fakeResponse()
  await route.handler(fakeRequest('POST', { body: '{}' }), post)
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET, HEAD')
})

// ---------------------------------------------------------------------------
// The report route
// ---------------------------------------------------------------------------

test('a render report is stored, and stops applying when the block is rewritten', async () => {
  const { ctx, routes } = fakeContext()
  const reports = new RenderReports()
  registerRuntimeRoutes(ctx, reports)
  const route = routes.get(RENDER_REPORT_ROUTE)

  const payload = JSON.stringify({
    sessionId: 'sess-1',
    blockId: 'bl_1',
    blockSlug: 'flow',
    source: 'flowchart TD\n  A-->',
    message: 'Parse error on line 2',
  })
  const req = fakeRequest('POST', { body: payload })
  const res = fakeResponse()
  await route.handler(req, res)
  req.flush()
  await settled()
  assert.equal(res.status, 204)

  const blocks = new Map([['bl_1', { id: 'bl_1', source: 'flowchart TD\n  A-->' }]])
  const live = reports.live('sess-1', blocks)
  assert.equal(live.length, 1)
  assert.equal(live[0].blockSlug, 'flow')

  // The Agent fixes the source. Nothing has to be invalidated: the report simply no longer
  // describes the block, which is why an observation about the DOM is safe to keep out of the fold.
  blocks.set('bl_1', { id: 'bl_1', source: 'flowchart TD\n  A-->B' })
  assert.deepEqual(reports.live('sess-1', blocks), [])

  // And a report for a block that no longer exists at all is not surfaced either.
  blocks.delete('bl_1')
  assert.deepEqual(reports.live('sess-1', blocks), [])
})

test('reports are per session, and one can be forgotten', async () => {
  const reports = new RenderReports()
  const report = { blockId: 'bl_1', blockSlug: 'flow', source: 'graph TD', message: 'boom' }
  reports.record('sess-1', report)
  reports.record('sess-2', report)

  const blocks = new Map([['bl_1', { id: 'bl_1', source: 'graph TD' }]])
  assert.equal(reports.live('sess-1', blocks).length, 1)
  assert.equal(reports.live('sess-2', blocks).length, 1)
  assert.deepEqual(reports.live('sess-3', blocks), [], 'an unknown session has nothing to say')

  reports.forget('sess-1')
  assert.deepEqual(reports.live('sess-1', blocks), [])
  assert.equal(reports.live('sess-2', blocks).length, 1, 'forgetting one session must not clear another')
})

test('the report route refuses a cross-site caller and a body that is not a report', async () => {
  const { ctx, routes } = fakeContext()
  const reports = new RenderReports()
  registerRuntimeRoutes(ctx, reports)
  const route = routes.get(RENDER_REPORT_ROUTE)

  // What this route feeds is text the Agent reads, so another tab must not be able to write to it.
  const crossSite = fakeResponse()
  await route.handler(
    fakeRequest('POST', {
      headers: { 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ sessionId: 's', blockId: 'b', source: '', message: 'x' }),
    }),
    crossSite,
  )
  assert.equal(crossSite.status, 403)

  for (const body of ['not json', '{}', '{"sessionId":"s","blockId":"b"}', '{"sessionId":"","blockId":"b","source":"","message":"m"}']) {
    const req = fakeRequest('POST', { body })
    const res = fakeResponse()
    await route.handler(req, res)
    req.flush()
    await settled()
    assert.equal(res.status, 400, `${body} must be refused`)
  }

  assert.deepEqual(reports.live('s', new Map()), [], 'nothing invalid was stored')

  const get = fakeResponse()
  await route.handler(fakeRequest('GET'), get)
  assert.equal(get.status, 405)
  assert.equal(get.headers.allow, 'POST')
})

test('a report is recorded only after its body has been read', async () => {
  // The handler is asynchronous, so a test that never flushes the body would pass with an empty
  // store and prove nothing. This one drives the stream the way a real request does.
  const { ctx, routes } = fakeContext()
  const reports = new RenderReports()
  registerRuntimeRoutes(ctx, reports)
  const route = routes.get(RENDER_REPORT_ROUTE)

  const req = fakeRequest('POST', {
    body: JSON.stringify({
      sessionId: 'sess',
      blockId: 'bl_9',
      blockSlug: 'seq',
      source: 'sequenceDiagram\n  A->>B: x',
      message: 'boom',
    }),
  })
  const res = fakeResponse()
  const pending = route.handler(req, res)
  await pending
  assert.equal(res.status, undefined, 'nothing is written before the body arrives')
  req.flush()
  await settled()
  assert.equal(res.status, 204)
  assert.equal(reports.live('sess', new Map([['bl_9', { id: 'bl_9', source: 'sequenceDiagram\n  A->>B: x' }]])).length, 1)
})

test('blockIndex finds blocks across pages, keyed by id', () => {
  const model = {
    pages: [
      { id: 'pg_1', blocks: [{ id: 'bl_1' }, { id: 'bl_2' }] },
      { id: 'pg_2', blocks: [{ id: 'bl_3' }] },
    ],
  }
  const index = blockIndex(model)
  assert.equal(index.size, 3)
  assert.equal(index.get('bl_3').id, 'bl_3')
})
