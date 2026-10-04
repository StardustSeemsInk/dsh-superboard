/**
 * Verify the finished video against the claims the deliverable makes.
 *
 * This exists because "the file exists and is roughly 95 seconds" is not evidence
 * that the film is correct. Every check below fails loudly on a specific, real
 * failure mode rather than reporting a number and leaving the judgement to a human.
 *
 * Usage: node tools/verify.mjs [--file dist/dsh-superboard-promo.mp4]
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const FFMPEG =
  'C:\\Users\\haoch\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe'
const FFPROBE = FFMPEG.replace(/ffmpeg\.exe$/, 'ffprobe.exe')

const args = process.argv.slice(2)
const index = args.indexOf('--file')
const FILE = resolve(index >= 0 ? args[index + 1] : join(ROOT, 'dist', 'dsh-superboard-promo.mp4'))

const timeline = JSON.parse(
  (await import('node:fs')).readFileSync(join(ROOT, 'timeline.json'), 'utf8'),
)

function probe(file) {
  return new Promise((done, fail) => {
    const child = spawn(FFPROBE, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file,
    ], { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => (code === 0 ? done(JSON.parse(out)) : fail(new Error(err))))
    child.on('error', fail)
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
}

if (!existsSync(FILE)) {
  check('file exists', false, FILE)
} else {
  const size = statSync(FILE).size
  const info = await probe(FILE)
  const video = info.streams.find((s) => s.codec_type === 'video')
  const audio = info.streams.find((s) => s.codec_type === 'audio')
  const duration = Number(info.format.duration)

  check('file exists', true, `${(size / 1024 / 1024).toFixed(1)} MB`)
  check('has a video stream', video !== undefined, video ? `${video.codec_name} ${video.width}×${video.height} ${video.r_frame_rate}` : 'none')
  check('has an audio stream', audio !== undefined, audio ? `${audio.codec_name} ${audio.sample_rate}Hz ${audio.channels}ch` : 'none')
  check('1920×1080', video?.width === 1920 && video?.height === 1080, `${video?.width}×${video?.height}`)
  check('yuv420p (universal playback)', video?.pix_fmt === 'yuv420p', String(video?.pix_fmt))
  check('30 fps', video?.r_frame_rate === '30/1', String(video?.r_frame_rate))

  const expected = timeline.scenes[timeline.scenes.length - 1].end
  // A frame of slack at each end is normal for a concat of exact-length segments.
  check(
    `duration ≈ ${expected}s (±0.5s)`,
    Math.abs(duration - expected) <= 0.5,
    `${duration.toFixed(2)}s`,
  )
  check('audio covers the whole film', audio !== undefined && Number(audio.duration ?? duration) >= duration - 0.6,
    audio ? `audio ${Number(audio.duration ?? 0).toFixed(2)}s vs video ${duration.toFixed(2)}s` : 'no audio')
}

const failed = results.filter((r) => !r.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail === undefined ? '' : `  — ${result.detail}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
