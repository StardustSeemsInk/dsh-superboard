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

/** A decaying sine — the basis of the kick and the mallet. */
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

/** The notes sounding at `seconds`, so accents can be pitched from the harmony. */
function chordNotesAt(seconds) {
  return chordAt(seconds)[1]
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

/**
 * Seconds per beat, and the reason it is 120.
 *
 * Every scene change in `timeline.json` is a whole number of seconds, so any beat
 * that divides a second puts all eight cuts exactly on a beat. 0.5 s is the slowest
 * such beat that still reads as a tempo rather than as a pulse.
 *
 * At the earlier BPM 100 (0.6 s) the cuts fell *between* beats, and so did most of
 * the inner accents — 22.2 s and 28.8 s landed on the grid while 24.4 s and 26.6 s
 * did not. Four accents in a row alternating on and off the pulse is exactly the
 * "off" feeling a reviewer reported, and no amount of re-voicing fixes it: the grid
 * itself was wrong.
 */
const BPM = 120
const BEAT = 60 / BPM
const BAR = BEAT * 4
/** The eighth note. Inner accents snap to it — a picture event is not precise to better. */
const GRID = BEAT / 2

function kick(at, gain, position = 0) {
  voice(at, 0.42, (time) => {
    // Pitch drops from 130Hz to 44Hz — a synthesised kick without a sample.
    const frequency = 44 + 86 * Math.exp(-time / 0.035)
    return Math.sin(TAU * frequency * time) * Math.exp(-time / 0.16)
  }, { gain, pan: position, attack: 0.001, release: 0.05 })
}

/**
 * A soft shaker.
 *
 * Reviewed on the first cut as "擦擦擦擦": a 9 kHz one-pole over a 60 ms noise burst
 * with an 18 ms decay is a *tick*, and a tick carries no body, so it reads as a click
 * sitting on top of the mix rather than as a shaker inside it. Lower and longer leaves
 * the same noise recognisably a shaker.
 */
function hat(at, gain) {
  const rng = noise(0x9e37 + Math.round(at * 1000))
  const filtered = lowPass(5200)
  voice(at, 0.09, (time) => filtered(rng()) * Math.exp(-time / 0.035), {
    gain,
    pan: 0.22,
    attack: 0.002,
    release: 0.02,
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

/**
 * A soft mallet accent — the replacement for the original inharmonic bell.
 *
 * Two measured complaints drove this, and they have different causes:
 *
 *  * **Timbre.** A fundamental plus partials at 2.76x and 5.4x is the *triangle /
 *    glockenspiel* spectrum. Those partials are inharmonic, so the ear files the
 *    result under "metal", and a metal ping at MIDI 88 (1318 Hz) cuts through a
 *    quiet pad mix no matter how low its gain is. A marimba's characteristic
 *    partial is the **4th**, which is harmonic and reads as wood; it is paired here
 *    with a gentle low-pass and an octave-lower register.
 *  * **Pitch.** Every inner accent used to be the same note (MIDI 88), so a run of
 *    them was a repeated tick with no melodic shape at all. Callers now pitch each
 *    accent from the chord underneath it, so consecutive accents form a line that
 *    belongs to the harmony instead of a metronome.
 */
function mallet(at, midi, gain, position = 0, decay = 0.34) {
  const frequency = hz(midi)
  const tone = lowPass(3600)
  voice(at, decay * 4, (time) => {
    const fundamental = Math.sin(TAU * frequency * time)
    const fourth = 0.2 * Math.sin(TAU * frequency * 4 * time)
    return tone(fundamental + fourth) * Math.exp(-time / decay)
  }, { gain, pan: position, attack: 0.006, release: decay })
}

// Intro: a single low pulse at 4s, then the beat enters at 8s.
kick(4, 0.5)

// A deliberately half-time groove: kick on beat 1 of each bar, a backbeat on beat 3,
// and shakers on the eighths. A kick on every beat drives a film that is meant to
// feel calm, and the whole kit arrives in stages so the film has somewhere to go.
for (let bar = 0; ; bar += 1) {
  const barStart = 8 + bar * BAR
  if (barStart >= DURATION - 3) break
  const stage = barStart < 20 ? 0 : barStart < 47 ? 1 : 2
  kick(barStart, 0.68)
  if (stage >= 2) kick(barStart + BEAT * 2, 0.48)
  if (stage >= 1) {
    for (let beat = 0; beat < 4; beat += 1) {
      const at = barStart + beat * BEAT + GRID
      if (at < DURATION - 3) hat(at, beat % 2 === 1 ? 0.19 : 0.12)
    }
  }
  if (stage >= 2 && bar % 2 === 1) snare(barStart + BEAT * 2, 0.3, -0.15)
}

// Risers into the major scene changes.
for (const cut of timeline.beatGrid.cuts) {
  if (cut >= DURATION - 6) continue
  riser(cut - 1.8, 1.8, 0.16)
}

// Accents on the scene changes themselves, pitched from the chord underneath each
// one so the eight cuts trace a line through the progression rather than repeating.
const CUT_DEGREE = [0, 1, 2, 3, 2, 1, 3, 2]
timeline.beatGrid.cuts.forEach((cut, index) => {
  if (cut >= DURATION) return
  const notes = chordNotesAt(cut)
  const midi = notes[CUT_DEGREE[index] % notes.length] + 12
  mallet(cut, midi, 0.17, index % 2 === 0 ? -0.3 : 0.3)
})

// The inner accents mark picture events inside a scene — a page switch, a template
// change, an arrow landing. Snap them to the eighth note and drop any that lands on a
// subdivision already used, so a cluster of picture events cannot become a fill.
const usedSlots = new Set(timeline.beatGrid.cuts.map((cut) => Math.round(cut / GRID)))
timeline.beatGrid.accents.forEach((accent, index) => {
  if (accent >= DURATION - 0.5) return
  if (timeline.beatGrid.cuts.includes(accent)) return
  const at = Math.round(accent / GRID) * GRID
  const slot = Math.round(at / GRID)
  if (usedSlots.has(slot)) return
  usedSlots.add(slot)
  const notes = chordNotesAt(at)
  const midi = notes[(index * 3 + 1) % notes.length] + 12
  mallet(at, midi, 0.07, index % 3 === 0 ? -0.2 : index % 3 === 1 ? 0.2 : 0, 0.22)
})

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
// A final low thud, and two mallets that ring out past the last frame. Both pitches
// are chord tones of the closing Am add9, so the tail resolves instead of just fading.
kick(outroStart, 0.6)
mallet(outroStart + 0.25, 76, 0.15, 0, 0.5)
mallet(outroStart + 1.1, 71, 0.1, 0.2, 0.45)

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
