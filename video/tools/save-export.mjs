/**
 * Save the probe's exported PNG to disk so it can be looked at.
 *
 * `_probe-export.html` already computes the picture; this only pulls the data URL out of the page
 * and writes the bytes. Kept as a file rather than an inline `node -e` because the quoting through
 * PowerShell mangles escape sequences.
 *
 * Usage: node tools/save-export.mjs <out.png>
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const OUT = process.argv[2] ?? '.tmp-export.png'
const URL = 'http://127.0.0.1:8788/scenes/_probe-export.html'
const PORT = 9333

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const profile = mkdtempSync(join(tmpdir(), 'sb-export-'))
const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

try {
  let socket
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      if (list.length > 0) {
        socket = new WebSocket(list[0].webSocketDebuggerUrl)
        break
      }
    } catch {
      // The port is not up yet; the loop is the wait.
    }
  }
  if (socket === undefined) throw new Error('headless Edge never exposed a debug target')

  let nextId = 0
  const pending = new Map()
  await new Promise((resolve) => {
    socket.onopen = resolve
  })
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message.result)
      pending.delete(message.id)
    }
  }
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
    })

  await send('Page.enable')
  // The same viewport override the film's capture path uses, so the export is produced at the
  // width the board is actually laid out at rather than at the outer window size.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: URL })

  let value
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(1000)
    const result = await send('Runtime.evaluate', {
      expression:
        'window.__probe === undefined ? null : (window.__probe.pngDataUrl ?? window.__probe.error ?? null)',
      returnByValue: true,
    })
    value = result?.result?.value
    if (typeof value === 'string' && value !== '') break
  }

  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) {
    throw new Error(`the probe did not produce a PNG: ${String(value).slice(0, 600)}`)
  }
  const bytes = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64')
  writeFileSync(OUT, bytes)
  console.log(`wrote ${OUT} (${bytes.length} bytes)`)
} finally {
  child.kill()
}
