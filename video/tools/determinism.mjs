/**
 * Prove every scene is a pure function of `t`.
 *
 * `AUTHORING.md` §1 makes purity the iron law, and the reason is not academic: the
 * capture tool calls `renderScene(t)` at arbitrary instants and any number of times, so
 * a scene that *animates itself* (rAF, setTimeout, a CSS transition, a clock read) drifts
 * between two calls at the same `t`. That bug is invisible in a contact sheet and visible
 * only in the finished film, as a jitter on the beat.
 *
 * So each scene is captured twice from scratch and the two runs are compared.
 *
 * **PNG hashes are a weaker test than they look, and a stronger one than you would
 * expect.** Weaker, because two encodes of identical pixels can differ (different
 * predictor rows or filter choices), which reports a false failure. Stronger, because a
 * byte-identical PNG really does mean identical pixels. So a hash mismatch is not a
 * verdict — every mismatching frame is decoded to raw RGB and compared again, and the
 * verdict is the *pixel* difference. That distinction has already mattered: one scene
 * flagged 8 of 42 frames on hashes, and all 8 turned out to be 15 changed bytes at delta 1
 * inside a single glyph's antialiasing (the region `x716-723 y115-117`, the word "Board").
 *
 * A delta of 1–2 in a handful of antialiased pixels is font rasterisation jitter and is
 * reported as `aa` (acceptable). A delta that moves whole shapes, or any difference at a
 * held instant that changes layout, is reported as `DRIFT` and should be treated as a real
 * defect: something in the scene is reading a clock or an animation frames the picture.
 *
 * Usage:
 *   node tools/determinism.mjs                  every scene, 2 fps
 *   node tools/determinism.mjs --fps 3
 *   node tools/determinism.mjs --only s3,s5
 *   node tools/determinism.mjs --keep           leave the two capture sets on disk
 *   node tools/determinism.mjs --wait 16000     per-scene page settle budget
 *
 * Requires the scene server: `npm run serve`.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const FFMPEG =
  'C:\\Users\\haoch\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe'
const ORIGIN = 'http://127.0.0.1:8788'
const WIDTH = 1920
const HEIGHT = 1080

const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const FPS = Number(arg('fps', 2))
const WAIT = Number(arg('wait', 14000))
const only = arg('only', null)
const KEEP = has('keep')

const timeline = JSON.parse(readFileSync(join(ROOT, 'timeline.json'), 'utf8'))
const scenes = only === null
  ? timeline.scenes
  : timeline.scenes.filter((scene) => only.split(',').map((s) => s.trim()).includes(scene.id))

const WORK = join(ROOT, '.determinism')

function run(command, commandArgs) {
  return new Promise((done, fail) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('error', fail)
    child.on('close', (code) => (code === 0 ? done(out) : fail(new Error(`${command} exited ${code}\n${out.slice(-4000)}`))))
  })
}

async function capture(scene, directory) {
  rmSync(directory, { recursive: true, force: true })
  const seconds = scene.end - scene.start
  const out = await run(process.execPath, [
    join(ROOT, 'capture', 'frames.mjs'),
    `${ORIGIN}/${scene.file}`,
    '--out', directory,
    '--duration', String(seconds),
    '--fps', String(FPS),
    '--width', String(WIDTH),
    '--height', String(HEIGHT),
    '--scale', '1',
    '--wait', String(WAIT),
  ])
  const parsed = JSON.parse(out.slice(out.indexOf('{')))
  return { ...parsed, seconds }
}

/** Decode a PNG to raw RGB24 bytes, so a comparison is about pixels and not encoding. */
async function decode(png, target) {
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', target])
  return readFileSync(target)
}

/**
 * Compare two runs of one scene.
 *
 * Returns `{ frames, identical, jitter, drift, worst }` where `jitter` counts frames whose
 * pixels differ but only by antialiasing-sized deltas, and `drift` counts frames where a
 * difference is big enough to be a moved shape rather than a resampled edge.
 */
async function compare(scene, left, right) {
  const names = readdirSync(left).filter((name) => name.startsWith('frame_')).sort()
  const scratch = join(WORK, scene.id, 'raw')
  mkdirSync(scratch, { recursive: true })
  const report = { frames: 0, identical: 0, jitter: 0, drift: 0, worst: null, examples: [] }

  for (const name of names) {
    const other = join(right, name)
    if (!existsSync(other)) continue
    report.frames += 1

    const a = readFileSync(join(left, name))
    const b = readFileSync(other)
    if (a.equals(b)) { report.identical += 1; continue }

    // Hashes disagreed; ask the pixels.
    const rgbA = await decode(join(left, name), join(scratch, 'a.rgb'))
    const rgbB = await decode(other, join(scratch, 'b.rgb'))
    let changed = 0
    let maxDelta = 0
    let minX = WIDTH
    let minY = HEIGHT
    let maxX = -1
    let maxY = -1
    for (let i = 0; i < rgbA.length; i++) {
      const delta = Math.abs(rgbA[i] - rgbB[i])
      if (delta === 0) continue
      changed += 1
      if (delta > maxDelta) maxDelta = delta
      const pixel = (i / 3) | 0
      const x = pixel % WIDTH
      const y = (pixel / WIDTH) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }

    const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
    const entry = { name, changed, maxDelta, box, percent: (100 * changed) / rgbA.length }
    // A handful of bytes moving by one level is resampling; anything else is a moved shape.
    const small = maxDelta <= 2 && entry.percent < 0.01
    if (small) report.jitter += 1
    else report.drift += 1
    if (report.worst === null || changed > report.worst.changed) report.worst = entry
    if (report.examples.length < 5) report.examples.push(entry)
  }

  return report
}

async function main() {
  const table = []
  for (const scene of scenes) {
    const left = join(WORK, scene.id, 'a')
    const right = join(WORK, scene.id, 'b')
    process.stdout.write(`${scene.id} … `)
    const first = await capture(scene, left)
    const second = await capture(scene, right)
    if (!first.ok || !second.ok || !first.hasScene || !second.hasScene) {
      console.log(`FAILED ok=${first.ok}/${second.ok} hasScene=${first.hasScene}/${second.hasScene}`)
      table.push({ id: scene.id, verdict: 'CAPTURE-FAILED' })
      continue
    }
    const report = await compare(scene, left, right)
    const verdict = report.drift > 0 ? 'DRIFT' : report.jitter > 0 ? 'aa' : 'exact'
    console.log(
      `${verdict}  frames=${report.frames} exact=${report.identical}` +
      (report.jitter ? ` antialias=${report.jitter}` : '') +
      (report.drift ? ` drift=${report.drift}` : '') +
      (report.worst ? `  worst=${report.worst.changed}B delta${report.worst.maxDelta} ${report.worst.percent.toFixed(4)}%` : ''),
    )
    table.push({ id: scene.id, verdict, ...report })
  }

  console.log('\nsummary:')
  for (const row of table) {
    const detail = row.verdict === 'exact'
      ? 'byte-identical pixels'
      : row.verdict === 'aa'
        ? `${row.jitter}/${row.frames} frames differ only by antialiasing (delta <= 2, < 0.01% of bytes)`
        : row.verdict === 'DRIFT'
          ? `${row.drift}/${row.frames} frames show a moved shape — NOT pure`
          : 'could not capture'
    console.log(`  ${row.id.padEnd(3)} ${row.verdict.padEnd(15)} ${detail}`)
  }

  const drifted = table.filter((row) => row.verdict === 'DRIFT' || row.verdict === 'CAPTURE-FAILED')
  if (!KEEP) rmSync(WORK, { recursive: true, force: true })
  else console.log(`\ncaptures kept in ${WORK}`)
  console.log(drifted.length === 0 ? '\nall scenes are pure functions of t' : `\n${drifted.length} scene(s) need attention`)
  process.exit(drifted.length === 0 ? 0 : 1)
}

await main()
