/**
 * Evaluate an expression in a real headless Edge and print the JSON result.
 *
 * This is the fastest way to ask the *actual* renderer a question — what a computed
 * style resolved to, what a token reads as, what the client's own colour pipeline
 * produced — instead of inferring it from a screenshot. Reading a value out of a PNG
 * is guesswork; this is measurement.
 *
 * Usage:
 *   node tools/eval.mjs <url> "<expression>" [--wait ms] [--width px] [--height px] [--scale n]
 *
 * The expression is evaluated with `awaitPromise`, so it may be async, and its value
 * must be JSON-serialisable. Page errors and rejections are collected and printed
 * even when the expression itself succeeds, because a page can be broken in ways the
 * value you asked for does not reveal.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const args = process.argv.slice(2)
const url = args[0]
const expression = args[1]
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

if (url === undefined || expression === undefined) {
  console.error('usage: node tools/eval.mjs <url> "<expression>" [--wait ms]')
  process.exit(2)
}

const WAIT = Number(arg('wait', 6000))
const WIDTH = Number(arg('width', 1280))
const HEIGHT = Number(arg('height', 900))
const SCALE = Number(arg('scale', 1))

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const profile = mkdtempSync(join(tmpdir(), 'sb-eval-'))
const child = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=0',
  '--user-data-dir=' + profile,
  `--window-size=${WIDTH},${HEIGHT}`,
  '--force-device-scale-factor=' + SCALE,
  url,
], { stdio: 'ignore', windowsHide: true })

let exitCode = 0
let socket = null
try {
  const portFile = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + 20000
  let port = 0
  while (Date.now() < deadline && port === 0) {
    if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0].trim())
    else await sleep(120)
  }
  if (port === 0) throw new Error('Edge never wrote DevToolsActivePort')

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
  if (page === undefined) throw new Error('no page target')

  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    socket.addEventListener('open', () => done())
    socket.addEventListener('error', () => fail(new Error('CDP socket failed')))
  })

  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : '')
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.fail(new Error(message.error.message))
    else entry.done(message.result)
  })
  const send = (method, params = {}) => {
    const id = nextId++
    return new Promise((done, fail) => {
      pending.set(id, { done, fail })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  await send('Runtime.enable')
  await sleep(WAIT)

  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails !== undefined) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    console.error('expression threw:\n' + text)
    exitCode = 1
  } else {
    console.log(JSON.stringify(result.result.value, null, 2))
  }

  const errors = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__diag ?? null)',
    returnByValue: true,
  })
  const diag = errors.result.value
  if (diag !== undefined && diag !== null && diag !== 'null') {
    console.error('window.__diag:\n' + diag)
  }
} catch (error) {
  console.error(String(error.stack ?? error))
  exitCode = 1
} finally {
  try { socket?.close() } catch { /* already gone */ }
  child.kill()
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* locked by Edge; harmless */ }
}
process.exit(exitCode)
