/**
 * Capture every scene, encode each to a normalised segment, concatenate, and mux
 * the score.
 *
 * The pipeline is deliberately staged and resumable: capture is by far the slowest
 * part (≈2.5 fps at 2× supersampling), so `--only <id>` and a per-scene "frames
 * already complete" check exist to avoid re-doing 20 minutes of work because one
 * scene changed.
 *
 * Usage:
 *   node tools/build.mjs                 full build
 *   node tools/build.mjs --capture-only
 *   node tools/build.mjs --encode-only
 *   node tools/build.mjs --only s2,s5    restrict to some scenes
 *   node tools/build.mjs --skip-capture  reuse existing frames
 *   node tools/build.mjs --no-audio
 *   node tools/build.mjs --out foo.mp4
 *
 * Requires the scene server to be up: `npm run serve` in another job.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const FFMPEG =
  'C:\\Users\\haoch\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe'
const ORIGIN = 'http://127.0.0.1:8788'

const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const timeline = JSON.parse(readFileSync(join(ROOT, 'timeline.json'), 'utf8'))
const { fps, width, height, scale } = timeline
const only = arg('only', null)
const selected = only === null
  ? timeline.scenes
  : timeline.scenes.filter((scene) => only.split(',').map((s) => s.trim()).includes(scene.id))

const FRAMES_DIR = join(ROOT, '.frames')
const SEGMENTS_DIR = join(ROOT, '.segments')
const DATA_DIR = join(ROOT, 'scenes', 'data')
const OUT = resolve(arg('out', join(ROOT, 'dist', 'dsh-superboard-promo.mp4')))

function run(command, commandArgs, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, commandArgs, { stdio: options.quiet ? 'pipe' : 'inherit', windowsHide: true })
    let stderr = ''
    if (options.quiet) {
      child.stderr?.on('data', (chunk) => {
        stderr += chunk
        if (stderr.length > 8000) stderr = stderr.slice(-8000)
      })
    }
    child.on('error', fail)
    child.on('close', (code) => {
      if (code === 0) done()
      else fail(new Error(`${command} exited ${code}\n${stderr}`))
    })
  })
}

async function serverAlive() {
  try {
    const response = await fetch(`${ORIGIN}/repo/src/client.js`, { method: 'HEAD' })
    return response.ok
  } catch {
    return false
  }
}

function frameCount(directory) {
  if (!existsSync(directory)) return 0
  return readdirSync(directory).filter((name) => name.startsWith('frame_')).length
}

async function captureScene(scene) {
  const out = join(FRAMES_DIR, scene.id)
  const expected = Math.round((scene.end - scene.start) * fps)
  const existing = frameCount(out)
  const complete = existsSync(join(out, '.complete'))
  // Everything a scene reads counts as a source, not just its own file: `harness.js`,
  // the shared stylesheet, the scene, and **the extracted data**. Leaving the data out
  // was a real hole — `scenes/data/board.json` is the board every scene renders, so
  // re-extracting it changes the pictures while every scene file's mtime stands still,
  // and the "already captured and up to date" check would happily reuse stale frames.
  const newestSource = Math.max(
    ...['js', 'html', 'css'].map((extension) => {
      const candidates = [
        join(ROOT, 'scenes', 'harness.js'),
        join(ROOT, 'scenes', 'theme.css'),
        join(ROOT, scene.file),
      ]
      return Math.max(...candidates
        .filter((path) => existsSync(path))
        .map((path) => statSync(path).mtimeMs), 0)
    }),
    ...(existsSync(DATA_DIR)
      ? readdirSync(DATA_DIR).map((name) => statSync(join(DATA_DIR, name)).mtimeMs)
      : [0]),
  )
  const stamp = join(out, '.complete')

  if (complete && existing === expected && statSync(stamp).mtimeMs > newestSource && !has('force')) {
    console.log(`  ${scene.id}: ${existing} frames already captured and up to date — skipping`)
    return
  }

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  console.log(`  ${scene.id}: capturing ${expected} frames…`)
  await run('node', [
    join(ROOT, 'capture', 'frames.mjs'),
    `${ORIGIN}/${scene.file}`,
    '--out', out,
    '--duration', String(scene.end - scene.start),
    '--fps', String(fps),
    '--width', String(width),
    '--height', String(height),
    '--scale', String(scale),
    '--wait', '5000',
  ])
  const captured = frameCount(out)
  if (captured !== expected) {
    throw new Error(`${scene.id}: expected ${expected} frames, got ${captured}`)
  }
  writeFileSync(stamp, new Date().toISOString())
}

async function encodeScene(scene) {
  const frames = join(FRAMES_DIR, scene.id)
  const segment = join(SEGMENTS_DIR, `${scene.id}.mp4`)
  if (!existsSync(frames)) throw new Error(`${scene.id}: no frames captured`)
  const count = frameCount(frames)
  if (count === 0) throw new Error(`${scene.id}: frames directory is empty`)
  const pattern = frames.includes('frame_00000.png')
    ? frames
    : join(frames, 'frame_%05d.png')
  console.log(`  ${scene.id}: encoding ${count} frames → ${segment}`)
  await run(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-framerate', String(fps),
    '-i', pattern,
    // Supersampled capture (2×) down to delivery size: this is where the board's
    // small text stays crisp instead of aliasing.
    '-vf', `scale=${width}:${height}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '16',
    '-profile:v', 'high',
    '-level', '4.0',
    '-g', String(fps * 2),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    segment,
  ])
  return segment
}

async function main() {
  console.log(`build: ${selected.length} scene(s), ${width}×${height} @ ${fps}fps (scale ${scale})`)

  if (!has('skip-capture') && !has('encode-only')) {
    if (!(await serverAlive())) {
      throw new Error(`scene server is not answering on ${ORIGIN} — start it with: npm run serve`)
    }
    mkdirSync(FRAMES_DIR, { recursive: true })
    console.log('capture:')
    for (const scene of selected) {
      if (!existsSync(join(ROOT, scene.file))) {
        throw new Error(`${scene.id}: scene file missing (${scene.file})`)
      }
      await captureScene(scene)
    }
  }
  if (has('capture-only')) {
    console.log('capture-only: done')
    return
  }

  mkdirSync(SEGMENTS_DIR, { recursive: true })
  console.log('encode:')
  const segments = []
  for (const scene of selected) segments.push(await encodeScene(scene))

  // Concat: the concat demuxer needs a list file. Every segment is encoded with the
  // same codec, size, fps and pixel format, which is what makes a stream copy safe.
  const listPath = join(SEGMENTS_DIR, 'concat.txt')
  writeFileSync(listPath, segments.map((path) => `file '${path.replace(/\\/g, '/')}'`).join('\n'))

  mkdirSync(resolve(OUT, '..'), { recursive: true })
  const score = join(ROOT, 'audio', 'promo-score.wav')
  const videoOnly = join(SEGMENTS_DIR, 'video-only.mp4')
  console.log('concat:')
  await run(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    videoOnly,
  ])

  if (has('no-audio') || !existsSync(score)) {
    if (!existsSync(score)) console.log(`  note: no score at ${score} — writing video only`)
    await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', videoOnly, '-c', 'copy', '-movflags', '+faststart', OUT])
  } else {
    console.log('mux:')
    await run(FFMPEG, [
      '-y', '-loglevel', 'error',
      '-i', videoOnly,
      '-i', score,
      // `-shortest` would cut on the audio; the score is authored to the same length,
      // so instead pad the audio if a scene came out a frame short.
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-af', 'aresample=async=1:first_pts=0',
      OUT,
    ])
  }
  console.log(`done → ${OUT}`)
}

await main()
