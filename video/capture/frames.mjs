/**
 * Capture frames from an HTML scene by driving a real headless Edge over CDP.
 *
 * The scene contract (see ../PLAN.md §3) is a single function:
 *
 *     window.renderScene = (t) => { ... }
 *
 * where `t` is seconds. **The page must be a pure function of `t`** — no
 * requestAnimationFrame, no setTimeout, no CSS animation unless it can be
 * positioned deterministically. That is what makes the output reproducible and
 * what keeps us clear of `--virtual-time-budget`, which stops servicing rAF once
 * the renderer is considered hidden and would hang a page that awaits a frame.
 *
 * Usage:
 *   node frames.mjs <file-or-url> [options]
 *
 * Options:
 *   --out <dir>        output directory                       (default ./frames)
 *   --duration <sec>   total seconds                          (default 1)
 *   --fps <n>          frames per second                      (default 30)
 *   --width <px>       viewport width                         (default 1920)
 *   --height <px>      viewport height                        (default 1080)
 *   --scale <n>        device scale factor                    (default 2)
 *   --static           capture exactly one frame and stop
 *   --wait <ms>        extra settle time before the first frame (default 1200)
 *   --port <n>         CDP port; 0 picks a free one           (default 0)
 *   --timeout <ms>     per-frame timeout                      (default 20000)
 *
 * Node 24 has a global `WebSocket`, so CDP needs no dependency.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const flagOnly = new Set(['static'])
      if (flagOnly.has(name)) {
        args[name] = true
        continue
      }
      args[name] = argv[i + 1]
      i += 1
    } else {
      args._.push(token)
    }
  }
  return args
}

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return EDGE_CANDIDATES[0]
}

async function sleep(ms) {
  await new Promise((done) => setTimeout(done, ms))
}

/** Poll the DevTools HTTP endpoint until the page target appears. */
async function waitForTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch (error) {
      lastError = String(error.message ?? error)
    }
    await sleep(120)
  }
  throw new Error(`no CDP page target on port ${port} within ${timeoutMs}ms (${lastError})`)
}

/** A tiny CDP client: one socket, incrementing ids, promise per call. */
class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.ready = new Promise((done, fail) => {
      this.socket.addEventListener('open', () => done())
      this.socket.addEventListener('error', (event) => fail(new Error(`CDP socket error: ${event.message ?? 'unknown'}`)))
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : '')
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.fail(new Error(`${entry.method}: ${message.error.message}`))
      else entry.done(message.result)
    })
  }

  async send(method, params = {}) {
    await this.ready
    const id = this.nextId
    this.nextId += 1
    const payload = JSON.stringify({ id, method, params })
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail, method })
      this.socket.send(payload)
    })
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails !== undefined) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`page threw: ${text}`)
    }
    return result.result.value
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const target = args._[0]
  if (target === undefined) {
    console.error('usage: node frames.mjs <file-or-url> [--out dir] [--duration sec] [--fps n]')
    process.exit(2)
  }

  const outDir = resolve(args.out ?? 'frames')
  const duration = Number(args.duration ?? 1)
  const fps = Number(args.fps ?? 30)
  const width = Number(args.width ?? 1920)
  const height = Number(args.height ?? 1080)
  const scale = Number(args.scale ?? 2)
  const waitMs = Number(args.wait ?? 1200)
  const perFrameTimeout = Number(args.timeout ?? 20000)
  const isStatic = args.static === true
  const port = Number(args.port ?? 0)
  const format = args.format === 'jpeg' ? 'jpeg' : 'png'
  const quality = Number(args.quality ?? 92)

  const url = /^https?:\/\//.test(target) ? target : pathToFileURL(resolve(target)).href
  const profile = mkdtempSync(join(tmpdir(), 'sb-frames-'))
  mkdirSync(outDir, { recursive: true })

  const edge = findEdge()
  const edgeArgs = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=' + scale,
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    `--window-size=${width},${height}`,
    url,
  ]

  const child = spawn(edge, edgeArgs, { stdio: 'ignore', windowsHide: true })
  let cdp = null
  let exitCode = 0
  try {
    // With port 0 Edge picks one; read it back from the profile's DevToolsActivePort file.
    let actualPort = port
    if (actualPort === 0) {
      const portFile = join(profile, 'DevToolsActivePort')
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        if (existsSync(portFile)) {
          actualPort = Number(readFileSync(portFile, 'utf8').split('\n')[0].trim())
          break
        }
        await sleep(120)
      }
      if (actualPort === 0) throw new Error('Edge never wrote DevToolsActivePort')
    }

    const wsUrl = await waitForTarget(actualPort, 20000)
    cdp = new Cdp(wsUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    })

    // Collect page errors loudly: a scene that throws and a scene that is merely
    // slow look identical on disk (both leave an empty frame), and that has cost
    // real debugging time before.
    await cdp.eval(`
      window.__errors = [];
      window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + String(e.reason)));
      true
    `)

    await sleep(waitMs)

    const hasScene = await cdp.eval('typeof window.renderScene === "function"')
    const errors = await cdp.eval('window.__errors')
    if (Array.isArray(errors) && errors.length > 0) {
      console.error('page reported errors before capture:')
      for (const line of errors) console.error('  ' + line)
    }

    const count = isStatic || !hasScene ? 1 : Math.round(duration * fps)
    if (!hasScene && !isStatic) {
      console.error('no window.renderScene — capturing a single static frame')
    }

    for (let index = 0; index < count; index += 1) {
      const t = fps === 0 ? 0 : index / fps
      if (hasScene) {
        await Promise.race([
          // `Promise.resolve(...)` so an async scene is awaited: a scene that awaits
          // its own work would otherwise be screenshotted mid-flight, which looks
          // like a rendering bug rather than a timing one.
          cdp.eval(`Promise.resolve(window.renderScene(${t})).then(() => true)`),
          sleep(perFrameTimeout).then(() => {
            throw new Error(`renderScene(${t}) did not settle within ${perFrameTimeout}ms`)
          }),
        ])
        // Let style/layout settle without depending on rAF in the page.
        await cdp.eval('new Promise((done) => setTimeout(done, 0)).then(() => true)')
      }
      const shot = await cdp.send('Page.captureScreenshot', {
        format,
        ...(format === 'jpeg' ? { quality } : {}),
        captureBeyondViewport: false,
      })
      const extension = format === 'jpeg' ? 'jpg' : 'png'
      const name = `frame_${String(index).padStart(5, '0')}.${extension}`
      writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'))
      if (index % 30 === 0 || index === count - 1) {
        process.stderr.write(`  ${index + 1}/${count} ${name}\n`)
      }
    }

    const finalErrors = await cdp.eval('window.__errors')
    if (Array.isArray(finalErrors) && finalErrors.length > 0) {
      console.error('page errors during capture:')
      for (const line of finalErrors) console.error('  ' + line)
      exitCode = 1
    }
    console.log(JSON.stringify({ ok: exitCode === 0, frames: count, outDir, url, hasScene }, null, 2))
  } catch (error) {
    console.error(String(error.stack ?? error))
    exitCode = 1
  } finally {
    cdp?.close()
    child.kill()
    // Edge keeps a lock on the profile dir for a moment; an EPERM here is harmless.
    await sleep(300)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* the OS still holds it — leaving a temp dir behind is not a failure */
    }
  }
  process.exit(exitCode)
}

await main()
