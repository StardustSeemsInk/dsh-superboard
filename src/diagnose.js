/**
 * Host-side diagnostics for `uml` blocks.
 *
 * **What this is for.** The board view reports real render failures (`src/runtime.js`), but only
 * while it is mounted — and the board is a tab. So there is a window where a diagram is broken
 * and nobody has looked at it: the Agent wrote it, the user is elsewhere, and the Agent has no
 * reason to re-read a board it believes it just wrote correctly. This closes that window from
 * the host side, where the fold already sees every write.
 *
 * **What it deliberately does not do.** It does not render, and it does not guess. Mermaid's
 * parser needs a DOM, and running a second copy of the engine in the host to catch what the
 * first copy will catch anyway is a large amount of code for a worse answer. So the checks here
 * are only the ones that are **certain** — each reproduces a decision mermaid itself makes:
 *
 *   1. the engine is the one that is vendored (we ship mermaid, not plantuml);
 *   2. the source is not empty;
 *   3. **mermaid's own `detectType` would find a diagram** — evaluated by running the detector
 *      regexes extracted from the bundle at vendor time, rather than a hand-copied keyword list
 *      that would rot and start accusing working diagrams.
 *
 * Anything subtler — a missing arrow, an unclosed bracket, a bad node shape — is reported by the
 * renderer that actually fails on it. Predicted versus observed; the outline presents both the
 * same way.
 *
 * @module dsh-superboard/diagnose
 */

import { readRuntimeManifest } from './runtime.js'

/** The engine whose runtime is vendored. `src/tools.js` lets the model name others. */
const VENDORED_ENGINE = 'mermaid'

/** Compiled once: the manifest is static for the life of the process. */
let compiledDetectors

/**
 * Compile the detector regexes recorded beside the vendored bundle.
 *
 * @returns an array of `RegExp`, empty when nothing was vendored.
 */
function detectors() {
  if (compiledDetectors !== undefined) return compiledDetectors
  const manifest = readRuntimeManifest()
  const sources = Array.isArray(manifest?.diagramDetectors) ? manifest.diagramDetectors : []
  compiledDetectors = sources.flatMap((source) => {
    try {
      return [new RegExp(source)]
    } catch {
      // A detector we cannot compile is one we cannot apply. Dropping it can only make the lint
      // quieter, which is the safe direction: a false "unsupported" would send the Agent to
      // rewrite a diagram that was already correct.
      return []
    }
  })
  return compiledDetectors
}

/**
 * Would mermaid find a diagram in this source?
 *
 * Reproduces `detectType`'s walk over its registry
 * (`chunks/mermaid.esm.min/chunk-QJSWEUOL.mjs`: `for (let [r, {detector: l}] of Object.entries(xi)) if (l(i, t)) return r`),
 * minus the parts that need mermaid's config object.
 *
 * @param source - the diagram source.
 * @returns the matching detector's source text, or `undefined`.
 */
export function detectDiagramType(source) {
  if (typeof source !== 'string') return undefined
  for (const detector of detectors()) {
    if (detector.test(source)) return detector.source
  }
  return undefined
}

/**
 * The human-readable keyword a detector is anchored on.
 *
 * `^\s*xychart(-beta)?` reads as `xychart`, and `^\s*(flowchart|graph)` as `flowchart` — the
 * leading bracket is the alternation's, not the language's. Used only to make the message
 * concrete: the model is writing mermaid, so naming the token it failed to produce is the whole
 * value of the message.
 *
 * A detector whose first branch does not begin with a letter has no keyword to name — the
 * comment-only detector `^\s*%(?!{)[^\n]+\n?` is exactly that, and printing it inside a list of
 * keywords would be worse than printing nothing.
 *
 * @param detectorSource - one entry from `detectDiagramType`.
 * @returns the leading keyword, or `undefined` when there is not one.
 */
function keywordOf(detectorSource) {
  const stripped = detectorSource.replace(/^\^\\s\*/, '').replace(/^\(/, '')
  const branch = stripped.split('|')[0].replace(/^\^/, '')
  const literal = /^[A-Za-z][A-Za-z0-9-]*/.exec(branch)
  return literal === null ? undefined : literal[0]
}

/**
 * Every keyword the vendored mermaid recognises, for a message that can be acted on.
 *
 * @returns the sorted keywords.
 */
export function knownDiagramKeywords() {
  const keywords = new Set()
  for (const detector of detectors()) {
    const keyword = keywordOf(detector.source)
    if (keyword !== undefined) keywords.add(keyword)
  }
  return [...keywords].sort()
}

/**
 * The exact diagnostic the Agent needs, or `undefined` when the block is fine.
 *
 * @param block - a `uml` block.
 * @returns `{code, message}`, or `undefined`.
 */
export function diagnoseUml(block) {
  if (block.engine !== VENDORED_ENGINE) {
    return {
      code: 'UNSUPPORTED',
      message:
        `this board vendors the ${VENDORED_ENGINE} engine only; a ${block.engine} source is shown verbatim and never rendered. ` +
        `Rewrite it as mermaid, or keep it as a \`code\` block if the source itself is the point.`,
    }
  }

  const source = typeof block.source === 'string' ? block.source : ''
  if (source.trim() === '') {
    return { code: 'PARSE', message: 'the diagram source is empty, so there is nothing to draw' }
  }

  // No manifest means no detectors, and no detectors means no opinion. Saying "unsupported" for
  // every diagram because the runtime was never vendored would be actively wrong.
  if (detectors().length === 0) return undefined
  if (detectDiagramType(source) !== undefined) return undefined

  const keywords = knownDiagramKeywords()
  return {
    code: 'UNSUPPORTED',
    message:
      `mermaid found no diagram in this source: it must begin with a diagram keyword, and none of ${keywords.length} ` +
      `recognised ones matched. The keywords are ${keywords.join(', ')}.`,
  }
}

/**
 * Recompute the whole diagnostic map for a model.
 *
 * Recomputed rather than patched: it is a pure function of the blocks, it runs once per committed
 * batch over a handful of blocks, and a diffing scheme would be a second place for "is this
 * diagram broken" to be decided. A diagnostic that is still true keeps the revision it was first
 * seen at, so the Agent can tell a fresh mistake from one it has ignored for six revisions.
 *
 * @param model - the board model, after the batch.
 * @param previous - the diagnostic map before it.
 * @param rev - the model's new revision.
 * @returns a fresh diagnostic map, keyed by block id.
 */
export function diagnoseModel(model, previous, rev) {
  const diag = {}
  for (const page of model.pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'uml') continue
      const found = diagnoseUml(block)
      if (found === undefined) continue
      const before = previous?.[block.id]
      diag[block.id] = {
        blockId: block.id,
        blockSlug: block.slug,
        pageSlug: page.slug,
        kind: block.kind,
        code: found.code,
        message: found.message,
        ...(found.at === undefined ? {} : { at: found.at }),
        firstFailedAtRev: before !== undefined && before.code === found.code ? before.firstFailedAtRev : rev,
      }
    }
  }
  return diag
}
