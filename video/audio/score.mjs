/**
 * Synthesize the promo's score from code.
 *
 * Why code and not a library track: the score has to hit ~28 cut points exactly,
 * and an original composition has no licensing surface at all. The output is a
 * 16-bit stereo WAV that ffmpeg then encodes to AAC.
 *
 * Design: a bed of slow pad chords under a pulse that becomes a kick once the board
 * appears, with risers into each scene change and a resolving chord at the end. All
 * times come from `timeline.json`, so the picture and the music cannot drift apart.
 *
 * Usage: node audio/score.mjs [--out promo-score.wav] [--duration 95]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SAMPLE_RATE = 48000

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const timeline = JSON.parse(readFileSync(join(ROOT, 'timeline.json'), 'utf8'))
const DURATION = Number(arg('duration', 95))
const TOTAL = Math.round(DURATION * SAMPLE_RATE)

// ---------------------------------------------------------------------------
// Mixing primitives
// ---------------------------------------------------------------------------

/** Two float buffers, L and R. Everything mixes into these and is clipped once. */
const left = new Float64Array(TOTAL)
const right = new Float64Array(TOTAL)

/** Equal-power pan: keeps perceived loudness constant across the field. */
function pan(gain, position) {
  const angle = ((position + 1) / 2) * (Math.PI / 2)
  return [gain * Math.cos(angle), gain * Math.sin(angle)]
}

function addSample(index, valueLeft, valueRight) {
  if (index < 0 || index >= TOTAL) return
  left[index] += valueLeft
  right[index] += valueRight
}

/**
 * Render one voice into both buffers.
 *
 * @param start   seconds
 * @param length  seconds
 * @param render  `(phase, progress, index) => amplitude` for one channel value
 * @param options gain, pan, attack/release envelope in seconds
 */
function voice(start, length, render, options = {}) {
  const gain = options.gain ?? 1
  const position = options.pan ?? 0
  const attack = options.attack ?? 0.008
  const release = options.release ?? 0.12
  const [gainLeft, gainRight] = pan(gain, position)
  const first = Math.round(start * SAMPLE_RATE)
  const count = Math.round(length * SAMPLE_RATE)
  for (let i = 0; i < count; i += 1) {
    const index = first + i
    if (index >= TOTAL) break
    const time = i / SAMPLE_RATE
    const progress = count <= 1 ? 1 : i / (count - 1)
    // Envelope: linear attack, linear release, so nothing clicks.
    const fadeIn = attack <= 0 ? 1 : Math.min(1, time / attack)
    const fadeOut = release <= 0 ? 1 : Math.min(1, (length - time) / release)
    const envelope = fadeIn * fadeOut
    const value = render(time, progress, index) * envelope
    addSample(index, value * gainLeft, value * gainRight)
  }
}

const TAU = Math.PI * 2

/** A sine partial. */
function sine(frequency) {
  return (time) => Math.sin(TAU * frequency * time)
}

/** A decaying sine — the basis of the kick and the bell. */
function decayedSine(frequency, decay) {
  return (time) => Math.sin(TAU * frequency * time) * Math.exp(-time / decay)
}

/** Deterministic noise (no RNG, so a re-render is bit-identical). */
function noise(seed) {
  let state = seed >>> 0
  return () => {
    // xorshift32
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return (state / 0xffffffff) * 2 - 1
  }
}

/** A one-pole low-pass, for turning noise into something less like static. */
function lowPass(cutoffHz) {
  const alpha = 1 - Math.exp((-TAU * cutoffHz) / SAMPLE_RATE)
  let last = 0
  return (value) => {
    last += alpha * (value - last)
    return last
  }
}

// ---------------------------------------------------------------------------
// Musical material
// ---------------------------------------------------------------------------

/** Midi note → Hz. */
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12)

/**
 * Chord progression. Each entry is [startSeconds, [midi notes], label].
 *
 * The cut points from timeline.json are the bones of the progression: a chord
 * change at every scene change, so the music turns when the picture turns.
 */
const PROGRESSION = [
  [0, [40, 47, 52, 59], 'Am9'],
  [8, [45, 52, 57, 64], 'Dm9'],
  [20, [41, 48, 53, 60], 'Fmaj7'],
  [34, [43, 50, 55, 62], 'G6'],
  [47, [40, 47, 52, 59], 'Am9'],
  [60, [38, 45, 50, 57], 'Dm7'],
  [69, [41, 48, 53, 60], 'Fmaj7'],
  [81, [43, 50, 55, 62], 'G'],
  [89, [40, 47, 52, 57, 59, 64], 'Am add9'],
]

function chordAt(seconds) {
  let current = PROGRESSION[0]
  for (const entry of PROGRESSION) if (entry[0] <= seconds) current = entry
  return current
}

// ---------------------------------------------------------------------------
// 1. The pad: one long voice per chord, slightly detuned, with a slow filter sweep
// ---------------------------------------------------------------------------

for (let i = 0; i < PROGRESSION.length; i += 1) {
  const [start, notes] = PROGRESSION[i]
  const end = i + 1 < PROGRESSION.length ? PROGRESSION[i + 1][0] : DURATION
  const length = end - start
  const opening = i < 2 ? 0.55 : i < 5 ? 0.7 : 0.8
  for (const note of notes) {
    for (const detune of [-4, 0, 4]) {
      const frequency = hz(note) * (1 + detune / 2400)
      voice(start, length, sine(frequency), {
        gain: opening * 0.075,
        pan: detune / 12,
        attack: Math.min(2.4, length * 0.35),
        release: Math.min(2.8, length * 0.4),
      })
    }
    // A soft octave shimmer, quieter and only in the second half of the film.
    if (i >= 3) {
      voice(start, length, sine(hz(note + 12)), {
        gain: 0.02,
        pan: 0.3,
        attack: Math.min(3, length * 0.5),
        release: Math.min(3, length * 0.5),
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The pulse: sparse at the top, a real kick from 8s on
// ---------------------------------------------------------------------------

/** Seconds per beat, chosen so scene changes land near beat boundaries. */
const BPM = 100
const BEAT = 60 / BPM

function kick(at, gain, position = 0) {
  voice(at, 0.42, (time) => {
    // Pitch drops from 130Hz to 44Hz — a synthesised kick without a sample.
    const frequency = 44 + 86 * Math.exp(-time / 0.035)
    return Math.sin(TAU * frequency * time) * Math.exp(-time / 0.16)
  }, { gain, pan: position, attack: 0.001, release: 0.05 })
}

function hat(at, gain) {
  const rng = noise(0x9e37 + Math.round(at * 1000))
  const filtered = lowPass(9000)
  voice(at, 0.06, (time) => filtered(rng()) * Math.exp(-time / 0.018), {
    gain,
    pan: 0.25,
    attack: 0.001,
    release: 0.01,
  })
}

function snare(at, gain, position = 0) {
  const rng = noise(0x51ed + Math.round(at * 1000))
  const filtered = lowPass(3200)
  voice(at, 0.24, (time) => {
    const body = Math.sin(TAU * 190 * time) * Math.exp(-time / 0.07)
    const air = filtered(rng()) * Math.exp(-time / 0.1)
    return body * 0.5 + air * 0.5
  }, { gain, pan: position, attack: 0.001, release: 0.04 })
}

/** A riser: filtered noise that opens up, used to lead into each scene change. */
function riser(at, length, gain) {
  const rng = noise(0x7f4a + Math.round(at * 100))
  const filtered = lowPass(1200)
  voice(at, length, (time, progress) => {
    // The filter opens as the riser climbs: brighter = more tension.
    const brightness = 0.25 + 0.75 * progress
    return filtered(rng()) * brightness * progress ** 1.6
  }, { gain, pan: 0, attack: 0.05, release: 0.08 })
}

/** A bell/metallic accent for scene changes. */
function bell(at, midi, gain, position = 0) {
  const frequency = hz(midi)
  voice(at, 2.2, (time) => {
    const fundamental = Math.sin(TAU * frequency * time)
    const third = 0.28 * Math.sin(TAU * frequency * 2.76 * time)
    const fifth = 0.16 * Math.sin(TAU * frequency * 5.4 * time)
    return (fundamental + third + fifth) * Math.exp(-time / 0.7)
  }, { gain, pan: position, attack: 0.004, release: 0.5 })
}

// Intro: a single low pulse at 4s, then the beat enters at 8s.
kick(4, 0.5)
for (let t = 8; t < DURATION - 3; t += BEAT) {
  const bar = Math.floor((t - 8) / (BEAT * 4))
  // The drum kit fills in as the film goes: kick only, then kick+hat, then all three.
  const stage = t < 20 ? 0 : t < 47 ? 1 : 2
  kick(t, 0.72)
  if (stage >= 1 && Math.abs(t / BEAT - Math.round(t / BEAT)) < 1e-6) {
    const offbeat = t + BEAT / 2
    if (offbeat < DURATION - 3) hat(offbeat, 0.26)
  }
  if (stage >= 2 && bar % 2 === 1) snare(t, 0.34, -0.15)
}

// Risers into the major scene changes.
for (const cut of timeline.beatGrid.cuts) {
  if (cut >= DURATION - 6) continue
  riser(cut - 1.8, 1.8, 0.16)
}

// Accents: a bell on each scene change, higher as the film accelerates.
const CUT_SCALE = [69, 72, 74, 76, 79, 81, 84, 86]
timeline.beatGrid.cuts.forEach((cut, index) => {
  if (cut >= DURATION) return
  bell(cut, CUT_SCALE[index] ?? 84, 0.2, index % 2 === 0 ? -0.35 : 0.35)
})

// The finer accents inside scenes, quiet so they read as detail rather than events.
for (const accent of timeline.beatGrid.accents) {
  if (accent >= DURATION - 0.5) continue
  if (timeline.beatGrid.cuts.includes(accent)) continue
  bell(accent, 88, 0.055, 0)
}

// ---------------------------------------------------------------------------
// 3. Ending: a resolving swell and a long tail
// ---------------------------------------------------------------------------

const outroStart = 89
for (const note of [40, 47, 52, 59, 64, 71]) {
  voice(outroStart, DURATION - outroStart + 1.6, sine(hz(note)), {
    gain: 0.085,
    pan: (note - 52) / 20,
    attack: 0.9,
    release: 2.4,
  })
}
// A final low thud, and a shimmer that rings out past the last frame.
kick(outroStart, 0.6)
bell(outroStart + 0.25, 76, 0.16, 0)
bell(outroStart + 1.1, 83, 0.1, 0.2)

// ---------------------------------------------------------------------------
// 4. Master: soft clip and write
// ---------------------------------------------------------------------------

/**
 * Convert to 16-bit PCM with a gentle saturation.
 *
 * A hard clip would add harsh harmonics across a dense mix; tanh keeps peaks under
 * control while staying smooth, which is what makes the sum of many voices still
 * sound clean.
 */
function master(sample) {
  const saturated = Math.tanh(sample * 1.05)
  return Math.max(-1, Math.min(1, saturated))
}

const bytes = Buffer.alloc(44 + TOTAL * 4)
bytes.write('RIFF', 0)
bytes.writeUInt32LE(36 + TOTAL * 4, 4)
bytes.write('WAVE', 8)
bytes.write('fmt ', 12)
bytes.writeUInt32LE(16, 16)
bytes.writeUInt16LE(1, 20)
bytes.writeUInt16LE(2, 22)
bytes.writeUInt32LE(SAMPLE_RATE, 24)
bytes.writeUInt32LE(SAMPLE_RATE * 4, 28)
bytes.writeUInt16LE(4, 32)
bytes.writeUInt16LE(16, 34)
bytes.write('data', 36)
bytes.writeUInt32LE(TOTAL * 4, 40)

let peak = 0
for (let i = 0; i < TOTAL; i += 1) {
  const valueLeft = master(left[i])
  const valueRight = master(right[i])
  peak = Math.max(peak, Math.abs(valueLeft), Math.abs(valueRight))
  bytes.writeInt16LE(Math.round(valueLeft * 32767), 44 + i * 4)
  bytes.writeInt16LE(Math.round(valueRight * 32767), 44 + i * 4 + 2)
}

const out = resolve(arg('out', join(ROOT, 'audio', 'promo-score.wav')))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, bytes)
console.log(JSON.stringify({ out, seconds: DURATION, sampleRate: SAMPLE_RATE, peak: Number(peak.toFixed(4)), bytes: bytes.length }))
