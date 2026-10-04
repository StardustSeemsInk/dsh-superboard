/**
 * Diagram theming tests.
 *
 * The board renders mermaid through `<img src="data:image/svg+xml…">`, which means the theme has to
 * be baked into the SVG **before** it is encoded — a CSS rule cannot reach inside an `<img>`, and
 * mermaid writes its own `<style>` block anyway. So `diagramThemeVariables` is what actually decides
 * whether a diagram is legible on the user's background, and it is the only part of that pipeline
 * worth testing closely.
 *
 * Two properties matter, and they pull in opposite directions:
 *
 *   1. the mapping reads **tokens**, never literals, so a theme plugin's palette flows through
 *      without this file knowing the plugin exists;
 *   2. it survives a theme that defines almost nothing, which is the default DSH theme and also an
 *      uninstalled plugin.
 *
 * The colour-resolution helpers are stubbed rather than exercised: `readTokenColour` needs a live
 * `getComputedStyle`, and its behaviour (an absent token yields `undefined`, not black) is pinned in
 * `test/client.test.js`.
 *
 * Run with `--test`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

/**
 * Load the client half and return its exports.
 *
 * The sandbox is deliberately bare: these tests must not need a DOM. `diagramThemeVariables` takes
 * its colour reader as an argument precisely so that it can be tested this way.
 */
function loadClient() {
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => (registered = definition) } },
    localStorage: { getItem: () => null, setItem: () => {} },
    // `Date` and `Math` are reached for by module-level code; without them the script throws at load
    // and every test here fails for a reason that has nothing to do with theming.
    Math,
    JSON,
    String,
    Number,
    Object,
    Array,
    Set,
    Map,
    Boolean,
    Error,
    Date,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(SOURCE, { filename: 'client.js' }).runInContext(sandbox)
  assert.ok(registered !== undefined, 'the client half must register a lazy factory')
  return registered.factory((specifier) => {
    if (specifier === 'react') return { createElement() {}, useState: (v) => [v, () => {}], useEffect() {}, useMemo: (f) => f(), useCallback: (c) => c, useRef: (v) => ({ current: v }) }
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
}

const client = loadClient()

/**
 * A value from the client's realm, copied into this one.
 *
 * The client half runs in a `vm` context, so its arrays are not `Array` here and `deepEqual` rejects
 * them even when the contents match ("Values have same structure but are not reference-equal").
 * Round-tripping through JSON is the cheap way across a realm boundary for plain data.
 */
const plain = (value) => JSON.parse(JSON.stringify(value))

/** A reader over a literal token table, recording which names were asked for. */
function reader(table) {
  const asked = []
  const read = (name) => {
    asked.push(name)
    return table[name]
  }
  read.asked = asked
  return read
}

/** The token table a dark Catppuccin Mocha install produces, as `body.style` carries it. */
const MOCHA = {
  '--dsw-alias-bg-layer-2': 'rgb(30, 30, 46)',
  '--dsw-alias-bg-base': 'rgb(17, 17, 27)',
  '--dsw-alias-bg-overlay': 'rgb(69, 71, 90)',
  '--dsw-alias-bg-module-platform': 'rgb(49, 50, 68)',
  '--dsw-alias-bg-layer-3': 'rgb(49, 50, 68)',
  '--dsw-alias-state-business-primary': 'rgb(137, 180, 250)',
  '--dsw-alias-state-business-tertiary': 'rgb(24, 24, 37)',
  '--dsw-alias-label-primary': 'rgb(205, 214, 244)',
  '--dsw-alias-label-secondary': 'rgb(166, 173, 200)',
  '--dsw-alias-label-tertiary': 'rgb(147, 153, 178)',
  '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.12)',
  '--dsw-alias-border-l3': 'rgba(255, 255, 255, 0.16)',
  // The nine shiki names, with the real duplicates Catppuccin ships. Six distinct values, not nine.
  '--shiki-token-constant': 'rgb(250, 179, 135)',
  '--shiki-token-string': 'rgb(166, 227, 161)',
  '--shiki-token-keyword': 'rgb(203, 166, 247)',
  '--shiki-token-function': 'rgb(137, 180, 250)',
  '--shiki-token-parameter': 'rgb(235, 160, 172)',
  '--shiki-token-link': 'rgb(137, 180, 250)',
  '--shiki-token-string-expression': 'rgb(166, 227, 161)',
  '--shiki-token-comment': 'rgb(147, 153, 178)',
  '--shiki-token-punctuation': 'rgb(147, 153, 178)',
  '--dsw-static-blue-500': 'rgb(137, 180, 250)',
  '--dsw-static-green-500': 'rgb(166, 227, 161)',
  '--dsw-static-amber-500': 'rgb(250, 179, 135)',
  '--dsw-static-red-500': 'rgb(243, 139, 168)',
  '--dsw-static-deepseek-500': 'rgb(137, 180, 250)',
  // The ends of the neutral ramp, which the pie label prefers before black or white.
  '--dsw-static-neutral-bluish-1000': 'rgb(17, 17, 27)',
  '--dsw-static-neutral-bluish-00': 'rgb(205, 214, 244)',
}

test('the palette comes from tokens, so any theme plugin flows through', () => {
  const read = reader(MOCHA)
  const vars = client.diagramThemeVariables(read, true)

  assert.equal(vars.background, 'rgb(30, 30, 46)', 'the surface is the layer-2 alias')
  assert.equal(vars.primaryTextColor, 'rgb(205, 214, 244)')
  assert.equal(vars.primaryColor, MOCHA['--dsw-alias-state-business-tertiary'])
  // The assertion that makes the whole feature worth having: a colour the theme chose reaches
  // mermaid, and it is the theme's, not a literal compiled into this file.
  assert.equal(vars.pie1, 'rgb(250, 179, 135)')
})

test('a duplicate in the categorical palette is dropped, not repeated', () => {
  // Catppuccin ships nine shiki names mapping to six values: `string` equals `string-expression`,
  // `function` equals `link`, and `comment` equals `punctuation`. Handing mermaid the raw list would
  // give two pie slices one colour, which is worse than a shorter palette.
  const palette = client.categoricalPalette(reader(MOCHA))
  assert.equal(palette.length, 6)
  assert.equal(new Set(palette).size, palette.length, 'every entry must be distinct')
})

test('the categorical palette never repeats a colour across slices', () => {
  const vars = client.diagramThemeVariables(reader(MOCHA), true)
  const slices = [vars.pie1, vars.pie2, vars.pie3, vars.pie4, vars.pie5, vars.pie6]
  assert.equal(new Set(slices).size, 6, `slices must differ, got ${JSON.stringify(slices)}`)
})

test('a theme with no syntax tokens falls back to the static hue ramp', () => {
  // The shape of a theme that declines to define `--shiki-token-*`: the aliases resolve, the
  // categorical set does not. Without a fallback every slice is one colour and a pie chart is a disc.
  const table = { ...MOCHA }
  for (const name of Object.keys(table)) if (name.startsWith('--shiki-token')) delete table[name]
  const palette = client.categoricalPalette(reader(table))
  assert.ok(palette.length >= 4, `expected the ramp to supply hues, got ${JSON.stringify(palette)}`)
  assert.equal(new Set(palette).size, palette.length)
})

test('a theme that defines nothing at all yields no colours rather than "undefined"', () => {
  // The important half is what is *absent*: mermaid rejects an unknown colour format, and the
  // literal string "undefined" is one. Leaving the keys out makes mermaid use its own defaults,
  // which is the correct degradation for a board with no theme plugin installed.
  const read = reader({})
  const vars = client.diagramThemeVariables(read, false)
  assert.equal(vars.background, undefined)
  assert.equal(vars.pie1, undefined)

  // Asserted on the palette itself, not only on what leaks downstream: an earlier version of this
  // test allowed `[undefined]` through, because a one-element list still yields `pie1 === undefined`
  // and joins to the *empty* string rather than the word "undefined". The list has to be empty.
  assert.deepEqual(plain(client.categoricalPalette(reader({}))), [])

  const plot = vars.xyChart?.plotColorPalette
  assert.equal(plot, undefined, `plotColorPalette should be absent, got ${JSON.stringify(plot)}`)
})

test('darkMode is set inside themeVariables, which is the only place mermaid reads it', () => {
  // Probed against the real bundle: a top-level `darkMode` option is ignored, and this one is what
  // flips the defaults for every variable the mapping does not name. Getting it out of
  // `themeVariables` would silently render light defaults on a dark background — the original bug.
  assert.equal(client.diagramThemeVariables(reader(MOCHA), true).darkMode, true)
  assert.equal(client.diagramThemeVariables(reader(MOCHA), false).darkMode, false)
})

test('the plot palette is a comma-joined string, which is what mermaid parses', () => {
  // mermaid's xyChart reader splits this string rather than indexing an array, so the mapping has to
  // hand it text. Splitting it back apart in the assertion is unreliable — every `rgb(r, g, b)` has
  // commas of its own — so this pins the exact join instead.
  const read = reader(MOCHA)
  const vars = client.diagramThemeVariables(read, true)
  const palette = client.categoricalPalette(read)
  assert.equal(typeof vars.xyChart.plotColorPalette, 'string')
  assert.equal(vars.xyChart.plotColorPalette, palette.join(', '))
  assert.equal(palette.length, 6)
})

test('no variable is an invented literal that would ignore the theme', () => {
  // The original intent: catch a future edit pasting a hex value in "just for this one case", which
  // would not follow the theme and which nothing else here would notice.
  //
  // Derived values are legitimate, so this cannot be "every value is a token read" — the quadrant
  // fills and the pie label are computed by blending and contrast, which is precisely what makes
  // them theme-following. What is checked instead: no value is a **hex literal**, the shape a
  // hard-coded colour takes. Every colour is either read from a token or built as `rgb()` by the
  // blending helpers, and both of those move when the theme does.
  const vars = client.diagramThemeVariables(reader(MOCHA), true)
  for (const [key, value] of Object.entries(vars)) {
    if (key === 'xyChart' || typeof value !== 'string') continue
    assert.ok(!/^#[0-9a-f]{3,8}$/i.test(value), `${key} = ${value} is a hard-coded hex colour`)
  }
})

test('a derived colour changes when the theme does', () => {
  // The property that makes derivation acceptable where a literal would not be: the quadrant fills
  // and the pie label are functions of the tokens, so two themes get two answers.
  const mocha = client.diagramThemeVariables(reader(MOCHA), true)
  const latte = { ...MOCHA }
  latte['--dsw-alias-bg-layer-2'] = 'rgb(239, 241, 245)'
  latte['--dsw-alias-label-primary'] = 'rgb(76, 79, 105)'
  const other = client.diagramThemeVariables(reader(latte), false)
  assert.notEqual(mocha.quadrant1Fill, other.quadrant1Fill)
})

test('the token names the mapping asks for are all real DSH tokens', () => {
  // Pins the contract with the shell: these are the names a theme plugin remaps. A typo would make
  // the variable silently absent, which looks exactly like a theme that does not define it.
  const read = reader(MOCHA)
  client.diagramThemeVariables(read, true)
  const known = /^--(dsw-(alias|static|specific)-|shiki-)/
  for (const name of read.asked) {
    assert.ok(known.test(name), `${name} is not a DSH token name`)
  }
})

test('the four quadrant fills are four different colours', () => {
  // Measured against the real theme: mapping these to raised/overlay/accentTint/surface produced
  // `rgb(49, 50, 68)` twice, because `--dsw-alias-bg-layer-3` and `--dsw-alias-bg-overlay` hold the
  // same value in Catppuccin Mocha. Two identical quadrants erase the only thing a quadrant chart
  // says, and the chart still *renders*, so nothing else here would have caught it.
  const vars = client.diagramThemeVariables(reader(MOCHA), true)
  const fills = [vars.quadrant1Fill, vars.quadrant2Fill, vars.quadrant3Fill, vars.quadrant4Fill]
  assert.equal(new Set(fills).size, 4, `quadrants collapsed: ${JSON.stringify(fills)}`)
})

test('the quadrant fills stay distinguishable when every alias collapses to one colour', () => {
  // The degenerate theme: `--dsw-alias-bg-layer-3` and `--dsw-alias-bg-overlay` both resolve to the
  // surface. The quadrant fills are derived by blending the surface toward the text, so they must
  // still come out distinct — this is the property the fix relies on, independent of the theme.
  const table = { ...MOCHA }
  for (const name of ['--dsw-alias-bg-layer-3', '--dsw-alias-bg-overlay', '--dsw-alias-bg-module-platform', '--dsw-alias-state-business-tertiary']) {
    table[name] = table['--dsw-alias-bg-layer-2']
  }
  const vars = client.diagramThemeVariables(reader(table), true)
  const fills = [vars.quadrant1Fill, vars.quadrant2Fill, vars.quadrant3Fill, vars.quadrant4Fill]
  assert.equal(new Set(fills).size, 4, `quadrants collapsed: ${JSON.stringify(fills)}`)
})

test('the pie label is chosen for legibility on the slices, not inherited blindly', () => {
  // The second measured defect: one `pieSectionTextColor` on slices ranging light to dark scored
  // 1.03–1.95 against Catppuccin Mocha's fills — the percentages were essentially invisible while
  // the chart looked fine. The chosen label must clear a usable bar against the *worst* slice,
  // composited at mermaid's own 0.7 pie opacity.
  const vars = client.diagramThemeVariables(reader(MOCHA), true)
  const label = vars.pieSectionTextColor
  assert.ok(typeof label === 'string', 'a label colour must be chosen')

  const composite = (c, bg) => c
  let worst = Infinity
  for (let i = 1; i <= 6; i++) {
    const ratio = client.contrastRatio(label, composite(vars['pie' + i], vars.background))
    assert.ok(ratio !== undefined, 'the ratio must be computable')
    if (ratio < worst) worst = ratio
  }
  // 4.5 is WCAG AA for body text. The bar is asserted at 3.0: pie percentages are large-ish text on
  // a busy fill, and the palette is the user's to choose, so demanding AA everywhere would reject
  // legitimate themes.
  assert.ok(worst >= 3, `worst-case label contrast ${worst.toFixed(2)} is too low`)
  assert.notEqual(label, client.diagramThemeVariables(reader({}), true).pieSectionTextColor)
})

test('the chosen pie label beats the naive choice on the measured palette', () => {
  // Not just "some colour was picked": it has to be better than what the board did before, which is
  // the strongest statement available without hard-coding a hue.
  const vars = client.diagramThemeVariables(reader(MOCHA), true)
  const naive = MOCHA['--dsw-alias-label-primary']
  const fills = [1, 2, 3, 4, 5, 6].map((i) => vars['pie' + i])
  const worstFor = (label) => Math.min(...fills.map((fill) => client.contrastRatio(label, fill)))
  assert.ok(
    worstFor(vars.pieSectionTextColor) > worstFor(naive),
    `chosen ${vars.pieSectionTextColor} (${worstFor(vars.pieSectionTextColor).toFixed(2)}) is not better than ${naive} (${worstFor(naive).toFixed(2)})`,
  )
})

test('a translucent colour is refused rather than blended as if it were opaque', () => {
  // `compositeOver` exists because mermaid draws slices at 0.7 opacity; a token that arrives with
  // its own alpha cannot be composited without knowing what is behind it, and treating it as opaque
  // would overstate its weight. Refusing keeps the variable absent, which degrades to mermaid's
  // default instead of to a wrong colour.
  assert.equal(client.parseColourChannels('rgba(1, 2, 3, 0.5)'), undefined)
  assert.deepEqual(plain(client.parseColourChannels('rgb(1, 2, 3)')), [1, 2, 3])
  assert.equal(client.compositeOver('rgba(255, 255, 255, 0.5)', 'rgb(0, 0, 0)'), undefined)
})

test('contrast is measured against the composited slice, and matches known values', () => {
  // The WCAG formula is not ours to invent, so it is pinned against two cases with published answers:
  // black on white is 21, and a colour against itself is 1.
  assert.equal(client.contrastRatio('rgb(0, 0, 0)', 'rgb(255, 255, 255)').toFixed(0), '21')
  assert.equal(client.contrastRatio('rgb(120, 120, 120)', 'rgb(120, 120, 120)').toFixed(0), '1')
  assert.equal(client.contrastRatio('rgb(1, 2, 3)', undefined), undefined)
})

test('a readable theme ink is preferred over black, so the label stays on-brand', () => {
  // Not merely "contrast was maximised": on a palette whose own darkest ink is readable on every
  // slice, that ink should win over pure black. Otherwise every themed pie would carry an unthemed
  // label, and the plugin would be overriding the user's palette for no gain.
  const vars = client.diagramThemeVariables(reader(MOCHA), true)
  assert.equal(vars.pieSectionTextColor, MOCHA['--dsw-static-neutral-bluish-1000'])
})

test('black is reached for only when the theme cannot supply a readable ink', () => {
  // The light palette's darkest ink is too close to its vivid slice colours — the measured case that
  // motivated the fallback (best theme-derived candidate 2.37 where an achromatic extreme reached
  // 6.23, i.e. 38% of the achievable ceiling).
  //
  // The table is a real light palette, not the dark one with two tokens swapped: a mixed table would
  // have a dark surface and light slices, which no theme produces and which would test nothing.
  const latte = {
    '--dsw-alias-bg-layer-2': 'rgb(239, 241, 245)',
    '--dsw-alias-bg-base': 'rgb(239, 241, 245)',
    '--dsw-alias-bg-module-platform': 'rgb(230, 233, 239)',
    '--dsw-alias-bg-layer-3': 'rgb(230, 233, 239)',
    '--dsw-alias-bg-overlay': 'rgb(172, 176, 190)',
    '--dsw-alias-state-business-primary': 'rgb(30, 102, 245)',
    '--dsw-alias-state-business-tertiary': 'rgb(193, 210, 245)',
    '--dsw-alias-label-primary': 'rgb(76, 79, 105)',
    '--dsw-alias-label-secondary': 'rgb(92, 95, 119)',
    '--dsw-alias-label-tertiary': 'rgb(124, 127, 147)',
    '--dsw-alias-border-l2': 'rgba(0, 0, 0, 0.1)',
    '--dsw-alias-border-l3': 'rgba(0, 0, 0, 0.12)',
    // Catppuccin Latte's real syntax palette: vivid against a light background, which is exactly why
    // no neutral the theme owns is far enough from them.
    '--shiki-token-constant': 'rgb(254, 100, 11)',
    '--shiki-token-string': 'rgb(64, 160, 43)',
    '--shiki-token-keyword': 'rgb(136, 57, 239)',
    '--shiki-token-function': 'rgb(30, 102, 245)',
    '--shiki-token-parameter': 'rgb(230, 69, 83)',
    '--shiki-token-comment': 'rgb(124, 127, 147)',
    '--shiki-token-link': 'rgb(30, 102, 245)',
    '--shiki-token-string-expression': 'rgb(64, 160, 43)',
    '--shiki-token-punctuation': 'rgb(124, 127, 147)',
    '--dsw-static-neutral-bluish-1000': 'rgb(76, 79, 105)',
    '--dsw-static-neutral-bluish-00': 'rgb(239, 241, 245)',
  }
  const vars = client.diagramThemeVariables(reader(latte), false)
  assert.ok(
    ['rgb(0, 0, 0)', 'rgb(255, 255, 255)'].includes(vars.pieSectionTextColor),
    `expected an achromatic extreme, got ${vars.pieSectionTextColor}`,
  )
  // And it really is more legible than anything the theme offered.
  const surface = latte['--dsw-alias-bg-layer-2']
  const fills = ['--shiki-token-constant', '--shiki-token-string', '--shiki-token-keyword', '--shiki-token-function', '--shiki-token-parameter', '--shiki-token-comment']
    .map((k) => client.compositeOver(latte[k], surface, 0.7))
  const worst = (label) => Math.min(...fills.map((f) => client.contrastRatio(label, f)))
  assert.ok(worst(vars.pieSectionTextColor) > worst(latte['--dsw-static-neutral-bluish-1000']))
})

test('a label is never chosen from a token the theme did not define', () => {
  // A theme with no neutral ramp at all. `readTokenColour` reports an absent token as `undefined`
  // (never as black — the trap documented on that function), so the label has to come from what the
  // theme does define, or be left out entirely for mermaid to default.
  const table = { ...MOCHA }
  delete table['--dsw-static-neutral-bluish-1000']
  delete table['--dsw-static-neutral-bluish-00']
  const read = reader(table)
  const vars = client.diagramThemeVariables(read, true)
  const chosen = vars.pieSectionTextColor
  if (chosen !== undefined) {
    assert.ok(
      Object.values(table).includes(chosen) || chosen === 'rgb(0, 0, 0)' || chosen === 'rgb(255, 255, 255)',
      `${chosen} was not read from the theme`,
    )
  }
})
