/**
 * A tiny static server for the promo scenes.
 *
 * Needed for three reasons:
 *   1. `file://` pages cannot fetch sibling files (opaque origin), so the harness
 *      could not read the extracted board model and token tables.
 *   2. It serves the *shipped* `src/client.js` straight out of the repo, so the
 *      promo always renders the current build rather than a copy that can go stale.
 *   3. The client half loads its vendored runtimes from **plugin-owned host routes**
 *      (`/dsh-superboard/mermaid.min.js`, `/dsh-superboard/pdfjs/*`), not from a path
 *      a plain static server would produce — so those routes are mirrored here. Without
 *      them a diagram silently degrades to showing its source, which looks like a
 *      rendering bug in the product when it is a gap in this harness.
 *
 * Usage: node tools/serve.mjs [--port 8788] [--root .]
 *   /repo/*            → the dsh-superboard repository root
 *   /dsh-superboard/*  → the same routes the plugin's host half registers
 *   /*                 → the video/ directory
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const ROOT = resolve(arg('root', '.'))
const REPO = resolve(ROOT, '..')
const PORT = Number(arg('port', 8788))

/**
 * The plugin's host routes, mapped to the files they actually serve.
 *
 * `mermaid.min.js` is the vendored 3.5 MB bundle; the pdf.js assets live under
 * `vendor/pdf/`. Keeping this table here (rather than serving all of `vendor/`)
 * means a route the real host does *not* have cannot accidentally start working
 * only in the promo.
 */
const PLUGIN_ROUTES = {
  '/mermaid.min.js': join(REPO, 'vendor', 'mermaid.min.js'),
}
const PLUGIN_PREFIXES = {
  '/pdfjs/': join(REPO, 'vendor', 'pdf'),
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

/** Resolve a url path to a file inside `base`, refusing anything that escapes it. */
function safeJoin(base, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const target = normalize(join(base, decoded))
  if (!target.startsWith(base)) return null
  return target
}

/**
 * DSH's own authenticated byte route.
 *
 * The client renders an image or a PDF page by pointing at
 * `/api/file?path=<absolute path>`, so the promo needs this or every picture and every
 * PDF page comes out blank — which looks like a layout bug in the board rather than a
 * hole in this harness. The real route requires the session cookie; there is no auth
 * here because this server only ever listens on loopback for the renderer.
 *
 * The path is taken verbatim (it is an absolute Windows path in the model) and read
 * directly. There is no sandbox to escape: this is a local dev server whose entire job
 * is to hand the browser files the model already names.
 */
async function serveAbsoluteFile(urlPath, response) {
  const query = urlPath.slice(urlPath.indexOf('?') + 1)
  const path = new URLSearchParams(query).get('path')
  if (path === null || path === '') {
    response.writeHead(400).end('missing path')
    return
  }
  try {
    const body = await readFile(path)
    response.writeHead(200, {
      'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    response.end(body)
  } catch (error) {
    // The board surfaces a 404 as "读不到这张图" / "这一页画不出来", which is the
    // honest outcome for a file that really is missing.
    response.writeHead(404).end(String(error.message ?? error))
  }
}

const server = createServer(async (request, response) => {
  try {
    const urlPath = request.url === '/' ? '/index.html' : request.url

    if (urlPath.startsWith('/api/file')) {
      await serveAbsoluteFile(urlPath, response)
      return
    }

    // The plugin's render-report endpoint. The client POSTs observations here and
    // deliberately ignores the answer (`a board that also throws because a telemetry
    // POST failed would be a worse board`), so accepting and echoing is enough — but
    // it must exist, or the diagram error path never completes.
    if (urlPath.startsWith('/dsh-superboard/render-report')) {
      let body = ''
      for await (const chunk of request) body += chunk
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, received: body.length }))
      return
    }

    if (urlPath.startsWith('/dsh-superboard/')) {
      const rest = urlPath.slice('/dsh-superboard'.length)
      let target = PLUGIN_ROUTES[rest]
      if (target === undefined) {
        for (const [prefix, base] of Object.entries(PLUGIN_PREFIXES)) {
          if (rest.startsWith(prefix)) {
            target = safeJoin(base, rest.slice(prefix.length))
            break
          }
        }
      }
      if (target === undefined || target === null) {
        response.writeHead(404).end('no such plugin route')
        return
      }
      const body = await readFile(target)
      response.writeHead(200, {
        'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      response.end(body)
      return
    }

    let base = ROOT
    let relative = urlPath
    if (urlPath.startsWith('/repo/')) {
      base = REPO
      relative = urlPath.slice('/repo'.length)
    }
    const target = safeJoin(base, relative)
    if (target === null) {
      response.writeHead(403).end('forbidden')
      return
    }
    const info = await stat(target)
    if (info.isDirectory()) {
      response.writeHead(404).end('not a file')
      return
    }
    const body = await readFile(target)
    response.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    response.end(body)
  } catch (error) {
    response.writeHead(404).end(String(error.message ?? error))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} (repo at /repo, plugin routes at /dsh-superboard) on http://127.0.0.1:${PORT}`)
})
