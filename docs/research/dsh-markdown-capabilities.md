# What DSH 0.2.0-rc.2 renders inside markdown — math, mermaid, charts

Research date: this session. Target: **DSH Desktop 0.2.0-rc.2** as shipped in
`C:\Users\haoch\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`.

This document answers what the *framework* already does, so that a plugin deciding
which of these to support on its own canvas knows what is free, what is forbidden, and
what it must build. It builds on and does not re-derive
[`dsh-plugin-contract.md`](./dsh-plugin-contract.md), [`dsh-client-rendering.md`](./dsh-client-rendering.md)
and [`dsh-chat-reuse.md`](./dsh-chat-reuse.md).

## 0. Scope, artifacts, and how to read the citations

| Symbol | Absolute path |
| --- | --- |
| `$ASAR` | `C:\Users\haoch\AppData\Local\Temp\dsh-asar\` (complete extraction of the asar; 12 967 files, 372 430 062 bytes) |
| `$PKG` | `$ASAR` + `dsh\node_modules\@deepseek-ai\` (~320 DSH packages, plus 696 node_modules packages in total) |
| `$DIST` | `$PKG` + `dsh-web-frontend\dist\` |
| `$PRIM` | `$PKG` + `dsh-client-ui-primitives\lib\index.js` (530 719 bytes, 12 383 lines — the built ESM bundle of the official markdown layer) |
| `$REPO` | `E:\Dev\dsh-superboard\` |

Every `path:line` below is real and was read, not inferred from a package name. The
primitives bundle keeps the source region markers (`//#region lib/types/markdown/parse.js`),
so line numbers are stable and the original source file is named in-text even though
the shipped artifact is one file.

Where this document cites a negative ("there is none"), it also lists what was searched
so the negative can be re-tested — see §6, the search ledger.

Two artifacts carry unusual weight because they are complete inventories rather than greps:

- `$ASAR\dsh\desktop-runtime.json` (2 817 387 bytes) — the shipped runtime's full file list
  with hashes. A library that is not in this list is not in the product.
- `$DIST\index.html` (825 bytes) — the shell page, which shows exactly which bundles and
  stylesheets load unconditionally on every page.

## 1. Math — KaTeX 0.16.47, dollar **and** TeX delimiters, always on, already styled

### 1.1 Which library

**KaTeX, version 0.16.47.** The chain, all in `$PRIM`:

```
51: import { mathFromMarkdown } from "mdast-util-math";
53: import { math } from "micromark-extension-math";
61: import katex from "katex";
64: import "katex/dist/katex.min.css";
```

KaTeX is imported directly as a library — `katex.renderToString(...)` at
`$PRIM:11007` and `$PRIM:11013`. The version is confirmed a second way, from the
compiled stylesheet: `$DIST\assets\vendor-BNsW4eBh.css` contains the literal rule
`.katex .katex-version:after{content:"0.16.47"}`.

`package.json` of the layer pins the dependency as `"katex": "^0.16.47"` at
`$PKG\dsh-client-ui-primitives\package.json:33`.

There is **no MathJax** anywhere. There is no separate math package; math is a feature of
the markdown layer and nothing else.

### 1.2 Which delimiters are recognized

Three syntaxes, from two extensions.

**(a) Dollar math** — inherited from upstream `micromark-extension-math`, which is
dollar-only by construction: its `singleDollarTextMath` default enables `$…$` inline and
`$$…$$` flow. DSH registers it as `math()` (`$PRIM:53`).

**(b) `\(…\)` and `\[…\]`** — a DSH-authored compatibility extension. Its doc comment is
the design statement, verbatim (`$PRIM:10433`):

> `/** Extend upstream dollar-only math syntax with TeX delimiters while reusing its token vocabulary. */`

The extension is assembled at `$PRIM:10683-10691`:

```js
10683: const backslashMathFlow = createMathFlow(codes.backslash, codes.leftSquareBracket, codes.rightSquareBracket, true);
10684: const sameLineDollarMathFlow = createMathFlow(codes.dollarSign, codes.dollarSign, codes.dollarSign, false);
10685: const backslashMath = {
10686: 	flow: {
10687: 		[codes.backslash]: backslashMathFlow,
10688: 		[codes.dollarSign]: sameLineDollarMathFlow
10689: 	},
10690: 	text: { [codes.backslash]: backslashMathText }
10691: };
```

and exported as `mathCompatibility()` (`$PRIM:10699-10701`):

```js
10699: function mathCompatibility() {
10700: 	return backslashMath;
10701: }
```

Reading the two extra tokenizers precisely:

- `createMathFlow(codes.backslash, codes.leftSquareBracket, codes.rightSquareBracket, true)`
  — `\[ … \]`, the trailing `true` meaning multiline is allowed. A `\[ … \]` block may
  span lines.
- `createMathFlow(codes.dollarSign, codes.dollarSign, codes.dollarSign, false)` — a
  **same-line** `$$ … $$` display block; the `false` means it may not span lines. So
  `$$a + b$$` on one line is display math, but a `$$` that only closes several lines
  later is *not* this construct (it still works through upstream's flow math, see below).
- `text: { [codes.backslash]: backslashMathText }` — inline `\( … \)`.
- Preceding-backslash guard: `previousBackslash` (`$PRIM:10434-10440`) plus
  `tokenizeBackslashMathText` (`$PRIM:10441-10533`) — an escaped `\\(` is not math.

Net: **`$…$`, `$$…$$`, `\(…\)`, and `\[…\]` all render.** The delimiters a plugin would
have to satisfy are exactly these four families.

### 1.3 Two grammars: math is on when settled, off while streaming

This is the single most important behavioural detail, and it is deliberate.

The region doc comment, `$PRIM:10704-10711` (region `lib/types/markdown/parse.js`),
verbatim:

> The markdown renderer's two mdast grammars, one per rendering arm. Each
> arm is internally consistent — the incremental tail parses, the one-shot
> parses, and the plain-text projection of a given grammar always agree on
> where blocks start and end — and the settled grammar is the streaming one
> plus the math extensions, so the arms differ only where TeX delimiters
> begin a math construct (a `$$` block is a paragraph while streaming and a
> math block once settled, by design).

The two functions, verbatim (`$PRIM:10713-10741`):

```js
10713: /**
10714: * Parse GFM markdown (the streaming arm's grammar: no math, so incomplete
10715: * TeX never flashes KaTeX errors mid-stream).
10716: * @param text - Markdown source.
10717: * @returns The mdast root.
10718: */
10719: function parseGfm(text) {
10720: 	return recoverLocalImages(fromMarkdown(text, {
10721: 		extensions: [gfm(), cjkFriendlyStrong()],
10722: 		mdastExtensions: [gfmFromMarkdown()]
10723: 	}), text);
10724: }
10725: /**
10726: * Parse GFM markdown plus TeX math with the compatibility delimiters
10727: * (the settled arm's grammar).
10728: * @param text - Markdown source.
10729: * @returns The mdast root.
10730: */
10731: function parseGfmWithMath(text) {
10732: 	return recoverLocalImages(fromMarkdown(text, {
10733: 		extensions: [
10734: 			gfm(),
10735: 			cjkFriendlyStrong(),
10736: 			mathCompatibility(),
10737: 			math()
10738: 		],
10739: 		mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()]
10740: 	}), text);
10741: }
```

So the two grammars differ **only** by `mathCompatibility()` and `math()` (and the
matching `mathFromMarkdown()`), and the difference is confined to where TeX delimiters
begin a construct.

The intended user-visible consequence is stated in the doc comment itself: a `$$` block
is a paragraph while streaming and a math block once settled, "by design".

The practical rule a plugin copying this behaviour must reproduce: **parse without math
while text is arriving, re-parse with math once it has settled.**

### 1.4 Rendering, error handling, and what it will *not* do

`renderTexToReact(value, displayMode)` at `$PRIM:11004-11029`, verbatim:

```js
11004: function renderTexToReact(value, displayMode) {
11005: 	let html;
11006: 	try {
11007: 		html = katex.renderToString(value, {
11008: 			displayMode,
11009: 			throwOnError: true
11010: 		});
11011: 	} catch (error) {
11012: 		try {
11013: 			html = katex.renderToString(value, {
11014: 				displayMode,
11015: 				strict: "ignore",
11016: 				throwOnError: false
11017: 			});
11018: 		} catch {
11019: 			/* v8 ignore next 8 */
11020: 			return jsx("span", {
11021: 				className: "katex-error",
11022: 				style: { color: "#cc0000" },
11023: 				title: String(error),
11024: 				children: value
11025: 			});
11026: 		}
11027: 	}
11028: 	return [...new DOMParser().parseFromString(html, "text/html").body.childNodes].map(domToReact);
11029: }
```

Three graded fallbacks: strict render → lenient render (`strict: "ignore"`) → a red
`<span class="katex-error">` showing the raw TeX with the parse error in `title`.

The region's own doc block (`$PRIM:10951-10966`) explains the lineage and the trust
model, verbatim — and it is the best single paragraph in the artifact for understanding
what DSH thinks it is doing with math:

> TeX-to-React via KaTeX, replicating the rehype-katex pipeline this renderer
> replaced: the same three-arm error chain (strict render, `strict: 'ignore'`
> retry, error span) and a DOM-identical element tree, so settled math keeps
> its exact markup. KaTeX emits an HTML string; the browser's own HTML parser
> (`DOMParser`, applying the spec's SVG/MathML foreign-content attribute
> adjustments KaTeX output relies on) turns it into a tree this module maps
> onto React elements — KaTeX output is a static span/MathML/SVG vocabulary
> with no raw user HTML, the same trust shiki's tree gets in CodeBlock.

Two more constraints worth quoting from that block and from `$PRIM:11174-11180`:

- KaTeX output is re-parsed through `DOMParser` and mapped with `domToReact` because
  "React 18 has no MathML support, so the `.katex-mathml` subtree's elements land in the
  HTML namespace — exactly as they did under the replaced hast-util-to-jsx-runtime
  pipeline" (`$PRIM:10961-10963`). The a11y MathML mirror is in the DOM but is not a
  React-managed subtree; the visual arm is the `.katex-html` span tree.
- "KaTeX runs without trusted commands" (`$PRIM:11178`) — no `trust` option is passed, so
  `\href`, `\includegraphics`, and friends are inert. Same paragraph, on raw HTML:
  "raw HTML renders as literal text (no HTML enters the DOM)" (`$PRIM:11177`).

Note the phrase "**a static span/MathML/SVG vocabulary**": KaTeX already emits **SVG**
into the DOM on this page — that is how stretchy delimiters (`\left(`, `\sqrt` over tall
content) are drawn, via `DOMParser`'s foreign-content attribute adjustments (the
`xlink:href` / camelCase handling). A plugin drawing its own SVG charts is therefore in
company the markdown layer already depends on.

Node dispatch, in `render.js` (`$PRIM:11334-11335`):

```js
11334: case "math": return jsx(Fragment$1, { children: renderTexToReact(node.value, true) }, key);
11335: case "inlineMath": return jsx(Fragment$1, { children: renderTexToReact(node.value, false) }, key);
```

### 1.5 The undocumented-in-help fifth syntax: a ```math fence

`renderCode` (`$PRIM:11352-11365`) special-cases exactly one fence language:

```js
11352: function renderCode(node, key, context) {
11353: 	const language = node.lang ?? void 0;
11354: 	if (node.value === "") return jsx("pre", { children: jsx("code", { className: language === void 0 ? void 0 : `language-${language}` }) }, key);
11355: 	const lang = language === void 0 ? void 0 : /^[\w-]+/.exec(language)?.[0];
11356: 	if (!context.streaming && lang === "math") return jsx(Fragment$1, { children: renderTexToReact(`${node.value}\n`, true) }, key);
11357: 	return jsx(CodeBlock, { … }, key);
11358-11364: …
11365: }
```

So a ```` ```math ```` block renders as display math **once settled** (the
`!context.streaming` guard), and `math` is the only language DSH intercepts. There is no
mermaid, diff, graphviz, or chart special case here — `json` and `diff` get their own
components but through other paths (`JsonBlock`, `DiffBlock`). A grep for `lang ===`
across the whole bundle returns only `$PRIM:7609`, `:7846`, `:7886`, `:10787`, `:10808`
(highlighting cache keys and alias resolution) and `:11356` (this one).

### 1.6 Is math optional or plugin-activated? **No.**

`MarkdownText` itself (`$PRIM:11814`), verbatim:

```js
11814: const MarkdownText = memo(function MarkdownText({ text, streaming = false, labels, fileMentions, pathImages, variant = "body" }) {
```

There is **no `math`, `tex`, `katex`, or `enableMath` prop**. There is no settings key, no
config gate, no feature flag: a grep for `\bmath\b` over the whole 12 383-line bundle
returns the four imports/registrations of §1.2–1.4 plus unrelated `Math.min` / `Math.max`
numeric helpers (`$PRIM:3554`, `:4003-4004`, `:4377`, `:4424`, `:4478-4479`, `:4709`,
`:5016-5042`). Math is simply part of the settled markdown grammar.

Nor does the layering distinguish a "math-enabled" caller: every consumer that renders
markdown calls the same component. Files referring to `MarkdownText`, from a grep over
`$PKG` for `*.js`:

```
dsh-client-ui-chat/lib/client.js
dsh-client-ui-agent-preset/lib/client.js
dsh-client-ui-deliverables/lib/client.js
dsh-client-ui-trajectory/lib/client.js
dsh-client-ui-tool/lib/client.js
dsh-client-ui-sidebar-documentpreview/lib/client.js
dsh-client-ui-user-questions/lib/client.js
dsh-client-ui-plan/lib/client.js
dsh-client-ui-primitives/lib/index.js
dsh-web-frontend/dist/assets/index-5SrrfWpU.js
```

So math renders in the chat transcript, tool call bodies, plan text, deliverables,
user questions, document preview, and the trajectory — anywhere official markdown
appears. That is the same component a third-party plugin is forbidden from importing
(see §4.2).

### 1.7 Where the CSS and fonts come from — and why that matters for a plugin

`import "katex/dist/katex.min.css"` (`$PRIM:64`) is compiled into
`$DIST\assets\vendor-BNsW4eBh.css`:

| Measurement on `$DIST\assets\vendor-BNsW4eBh.css` | Value |
| --- | --- |
| File size | 29 288 bytes |
| Occurrences of `.katex` | 393 |
| `@font-face` rules | 20 |
| `KaTeX_` family references | 105 |

First rule, verbatim:

```css
.katex{font: 1.21em KaTeX_Main,Times New Roman,serif;line-height:1.2;position:relative;text-indent:0;text-rendering:auto}
.katex .katex-version:after{content:"0.16.47"}
```

Font URLs are **document-relative**, verbatim from the first `@font-face`:

```css
@font-face{font-display:block;font-family:KaTeX_AMS;font-style:normal;font-weight:400;
  src:url(./fonts/KaTeX_AMS-Regular-BQhdFMY1.woff2) format("woff2"),
      url(./fonts/KaTeX_AMS-Regular-DMm9YOAa.woff) format("woff"),
      url(./fonts/KaTeX_AMS-Regular-DRggAlZN.ttf) format("truetype")}
```

On disk under `$DIST\assets\fonts\`: 63 files, 1 263 052 bytes total, of which
**KaTeX is 59 files / 1 072 948 bytes** (20 `.ttf` = 513 664 B, 20 `.woff` = 303 116 B,
22 `.woff2` = 441 872 B).

Crucially, all of this loads on **every** page, whether or not anything renders math.
`$DIST\index.html`, verbatim and complete in its `<head>` links:

```html
<script type="module" crossorigin src="./assets/index-5SrrfWpU.js"></script>
<link rel="modulepreload" crossorigin href="./assets/vendor-CCJJTK99.js">
<link rel="stylesheet" crossorigin href="./assets/vendor-BNsW4eBh.css">
<link rel="stylesheet" crossorigin href="./assets/index-BPHePDI_.css">
```

Consequence for a plugin: **the KaTeX stylesheet and font files are already on the page
and already fetched.** A plugin that emits KaTeX's HTML (the same class names,
`.katex`, `.katex-display`, …) inherits correct typography *for free* and does **not**
need to ship 1.05 MB of fonts or 29 KB of CSS. It needs only the KaTeX JavaScript.

Two more facts about where the library physically sits:

- The KaTeX **JavaScript** is inside `$DIST\assets\vendor-CCJJTK99.js` — the
  `modulepreload`ed vendor chunk — confirmed by the minified error constructor
  `class L extends Error { constructor(t,n){ var r="KaTeX parse error: " …`. The same
  chunk carries upstream `micromark-extension-math` (`function p5(e){return{flow:{36:Qg},text:{36:t4()}}}`)
  and `mathFromMarkdown` (`m5()`). Note its upstream flow token is hard-coded to `36`,
  the dollar sign — that is the "dollar-only" the DSH layer extends.
- The DSH compatibility layer is re-bundled a second time into
  `$DIST\assets\index-5SrrfWpU.js`, which contains the same `case"inlineMath"` and
  `lang==="math"` code paths.

### 1.8 Size of the dependency

| Component | Size |
| --- | --- |
| KaTeX CSS (as compiled into `vendor-BNsW4eBh.css`, a 29 288 B file that also holds other vendor CSS) | ~29 KB |
| KaTeX fonts, all three formats, on disk | 1 072 948 B |
| KaTeX JS (minified, inside the shared `vendor-CCJJTK99.js` vendor chunk) | not separable from that chunk; upstream minified `katex.min.js` for 0.16.x is ~270 KB |
| `micromark-extension-math` + `mdast-util-math` | part of the micromark stack imported at `$PRIM:51,53` |

The layer's full build-time dependency list is `$PKG\dsh-client-ui-primitives\package.json:25-54`.
The math- and markdown-relevant pins, verbatim:

```
33: "katex": "^0.16.47",
34: "micromark-core-commonmark": "^2.0.3",
35: "micromark-util-character": "^2.1.1",
36: "micromark-util-classify-character": "^2.0.1",
37: "micromark-util-symbol": "^2.0.1",
38: "micromark-util-types": "^2.0.2",
39: "shiki": "^4.3.1",
40: "@shikijs/langs": "^4.3.1",
42: "micromark-factory-space": "^2.0.1",
43: "micromark-extension-math": "^3.1.0",
44: "mdast-util-from-markdown": "^2.0.3",
45: "mdast-util-gfm": "^3.1.0",
46: "mdast-util-math": "^3.0.0",
47: "micromark-extension-gfm": "^3.0.0",
48: "micromark-util-sanitize-uri": "^2.0.1",
49: "simple-icons": "16.31.0",
32: "anser": "^2.3.5",
30: "diff": "^9.0.0",
29: "clsx": "^2.0.0",
```

These are `devDependencies` (`package.json:25`) — build-time only, bundled into the
artifacts above. `"license": "MIT"` (`:24`), and the package description (`:3`) is a good
one-line statement of what the layer is:

> `"Pure React atoms for the dsh web UI: controls, icons, markdown, and JSON inspectors (zero cordis)"`

`peerDependencies` is only `{ "@deepseek-ai/cordis": "~4.0.4" }` (`:60-62`).

Finally, markdown styling glue that a copy would want, from
`$PRIM`-adjacent `dsh-client-ui-primitives\lib\markdown\MarkdownText.module.css`
(cited in `dsh-chat-reuse.md`): `.markdown :global(.katex-display){max-width:100%;overflow-x:auto;overflow-y:hidden}`
(L181-185), `.compact :global(.katex){font-size:1em}` (L430-432),
`.compact :is(p,h1..h6,ul,ol):has(:global(.katex)){overflow-x:auto;overflow-y:hidden;padding-bottom:1px}`
(L435-440), `.compact :global(.katex-display){margin:4px 0}` (L442-444). Display math is
made horizontally scrollable rather than allowed to blow out a narrow column — a detail a
plugin canvas will want to copy.

## 2. Mermaid — **DSH renders mermaid nowhere**

Case-insensitive grep for `mermaid` across the entire extraction
(`C:\Users\haoch\AppData\Local\Temp\dsh-asar\`, 12 967 files) returns **exactly three
hits, none of them a renderer, a loader, or a mention to the model**:

1. `$DIST\assets\langs\asciidoc-Ve4PFQV2.js:1` — a Shiki TextMate grammar. `mermaid` is
   in the asciidoc language's keyword/regex blob. It is a syntax-highlighting token
   definition, not a diagram engine.
2. `$ASAR\node_modules\mime-db\db.json:4163` — the MIME registry entry
   `"application/vnd.mermaid": { … }`, i.e. `mime-db` knows the media type. Nothing in
   DSH looks it up.
3. `$ASAR\node_modules\undici\docs\docs\api\api-lifecycle.md:48` — a ```mermaid fence in
   a vendored copy of undici's own documentation for browsing on GitHub.

Corroborating negatives:

- `$ASAR\dsh\desktop-runtime.json`, the complete shipped-file inventory: **0 matches**
  for `mermaid`, `diagram`, `graphviz`, `cytoscape`, `nomnoml`, `jsxgraph`.
- No Shiki grammar for mermaid exists: `$DIST\assets\langs\` contains
  `markdown-Cvjx9yec.js` and `latex-B4C7GdlO.js` (grammars only — see the warning below)
  but no `mermaid-*.js`.
- `renderCode` intercepts only `lang === "math"` (`$PRIM:11356`); a ```mermaid fence
  falls through to `CodeBlock` (`$PRIM:11357`).

**Conclusion: there is no mermaid in DSH 0.2.0-rc.2.** A ```mermaid fence in markdown is
displayed as a highlighted source block with a copy button and nothing else. No loader
exists to find, because there is no library to load — answering "bundled, dynamic import,
or script tag?" with: **none of the three; it is not present at all.**

The answer is robust because it rests on a file inventory, not a grep pattern: the
runtime manifest lists every shipped file, and mermaid is not among them.

⚠️ **Do not be misled by `langs/latex-B4C7GdlO.js`.** It is a Shiki grammar for
*syntax-highlighting LaTeX source code*. It renders nothing. Likewise
`langs/markdown-Cvjx9yec.js` is the grammar for highlighting markdown-as-code. The word
`latex` appearing in `$DIST\assets\langs\` is not math support; math support is §1
and lives in `$PRIM`.

## 3. Charts — **there is no charting library and no chart rendering of any kind**

This is a negative answer, and a valuable one. It is stated at three levels of
increasing strength.

### 3.1 No chart library is installed

Grep over the whole extraction and over all 696 packages in `$ASAR\dsh\node_modules\`:

| Searched for | Result |
| --- | --- |
| `chart.js`, `chartjs` | 0 |
| `recharts` | 0 |
| `vega`, `vega-lite` | 0 (only substring noise in `sharp/src/pipeline.cc`, `zod/v4/mini/schemas.js`, `brotli/dec/dictionary.bin.js`) |
| `plotly` | 0 |
| `highcharts` | 0 |
| `apexcharts` | 0 |
| `victory` | 0 |
| `billboard`, `chartist`, `dygraphs`, `c3.js` | 0 |
| `nivo`, `visx` | 0 (substring noise only) |
| `d3-scale`, `d3-shape` (and `d3-` generally) | 0 |
| `echarts` | **1 file**: `$PKG\libreoffice-kit-win32-x64\program\share\registry\writer.xcd` — an unrelated LibreOffice Writer registry XML |
| `mermaid` | see §2 — 3 unrelated hits |

No **package name** in `$ASAR\dsh\node_modules\` matches
`chart|plot|graph|vega|d3|echart|katex|math|mermaid|viz|sparkline`.

### 3.2 No chart library or chart file ships in the runtime

`$ASAR\dsh\desktop-runtime.json` — the complete shipped-file inventory with hashes —
returns **0 matches** for each of `chart`, `plot`, `echarts`, `vega`, `d3-`, `mermaid`,
`diagram`, `graphviz`, `cytoscape`, `nomnoml`, `jsxgraph`. (For contrast, its `katex`
matches enumerate all 59 KaTeX font files, and its `latex` match points at the Shiki
grammar — the manifest is precise enough to be trusted as an absence proof.)

### 3.3 Nowhere in DSH is anything drawn as a chart

Every plausible site was opened, not guessed:

- **The Excel preview detects charts and refuses to draw them.** This is the most
  decisive evidence in the whole search, and it is in prose that anticipates exactly this
  question. `$PKG\dsh-client-ui-sidebar-documentpreview\README.md:85`, verbatim:

  > Charts, drawings/images, pivot tables, conditional formatting, editing, recalculation, and export are unsupported

  And `README.md:73`, verbatim:

  > A notice above the table lists detected charts, images, shapes, and conditional formatting that are **not displayed**, and recommends opening the workbook in a system application.

  The i18n strings for that notice are `charts: "图表"` and `charts: "charts"` at
  `$PKG\dsh-client-ui-sidebar-documentpreview\lib\client.js:5821` and `:5839`. So the
  product's position on charts is explicit: **detect, label, decline.**
- **The spreadsheet engine's chart code is locale strings only.** All 50 `\bcharts?\b`
  hits in `$PKG\dsh-client-ui-sidebar-documentpreview\lib\client.excel.js` are
  FortuneSheet locale/tooltip text (`"Generate sparklines line chart"`,
  `"Sparklines chart settings"`, …), inherited from Luckysheet. **This is the answer to
  "is there a sparkline?" — the string exists, the renderer does not.**
- **The trajectory "timing overview" is a text histogram, not a drawn one.**
  `$PKG\dsh-client-ui-trajectory\lib\client.js:7794`, verbatim, is a doc comment:

  > `/** Wall-span duration + tool histogram, e.g. `1.5 s bash×6`. */`

  The histogram is the `×6` in a string. A grep for `\bchart` in that file returns
  nothing at all.
- **No `line`, `bar`, `pie`, `polyline`, `heatmap`, or `gauge` chart code** exists in any
  DSH package. `polyline` appears only in pdf.js, SheetJS, and Shiki grammars.
- **There is no `dsh-client-ui-session-stats` package.** Session statistics live in the
  host-side `dsh-session-stats`, and token accounting in host-side `dsh-token-meter`;
  neither ships any rendering.
- `chart` / `diagram` return **0 hits** across `dsh-system-prompt`, `dsh-agent-preset`,
  `dsh-persona`, and `dsh-agent-instructions`.

### 3.4 Is any of it reachable from a third-party plugin?

**No — and it would not matter if the code existed.** Two independent barriers, either
of which is fatal:

1. A chart library is not in the platform module seed (see §4.1), so a plugin's client
   half cannot `require` it.
2. `docs/research/dsh-plugin-contract.md` §9 records that
   `$PKG\dsh-agent-preset\skills\cordis-plugin-development\references\practices.md:35`
   forbids requiring any Harness client package, so a plugin may not reach the official
   client halves either.

So the honest summary for §3 is: **DSH ships no chart capability that a plugin can use,
and no chart capability at all.**

## 4. What is actually reachable for a chart

### 4.1 The seed is nine modules and contains nothing chart-shaped

From `docs/research/dsh-plugin-contract.md` §11, the platform module table a client
plugin's factory receives is a frozen nine-entry allowlist, seeded in
`$DIST\assets\index-5SrrfWpU.js` (the function `function rM(){return{...}}`):

```
react
react/jsx-runtime
react-dom
react-dom/client
@deepseek-ai/cordis
@deepseek-ai/dsh-client-store
@deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives
@deepseek-ai/dsh-client-ui-dockkit
```

A `require` that misses this table throws
`client-modules: require("…") missed the module table …`. What the seed gives a
chart-drawing plugin: **React 18 (including `jsx-runtime`), ReactDOM, the slot system,
the store, dockkit, and the primitives layer.** That is enough to draw SVG with React —
and nothing more.

Nor can a plugin reach a chart library by another route: a package-local lazy chunk must
be a DSH-served chunk under the naming rule
`/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` that self-registers through
`window.__ModuleLoader__.load({ id, chunk, factory })` (see `dsh-plugin-contract.md` §11
and `dsh-client-rendering.md`). That mechanism lets a plugin *ship its own* code — it
does not grant access to libraries the product does not have. There is no mermaid, no
`echarts`, no `d3` to point it at.

### 4.2 What is inside `@deepseek-ai/dsh-client-ui-primitives`

`$PRIM`'s final statement is one `export { … };` at line **12381**, naming **282 symbols,
92 of which are not `Icon*`**. The complete non-icon export list, verbatim:

```
BrandWordmark, Button, CODE_HIGHLIGHT_EXTENSIONS, Checkbox, CodeBlock, ConnectionIndicator,
DEFAULT_DIFF_MAX_LINES, DEFAULT_READ_MAX_LINES, DEFAULT_SEARCH_MAX_LINES,
DEFAULT_TERMINAL_MAX_LINES, DiffBlock, DisclosureRow, FISH_LOGO_PATH, FISH_LOGO_VIEWBOX,
FileTypeIcon, FishLogo, GuideArtworkBrowser, GuideArtworkFiles, HoverCard, ImageLightbox,
Input, JsonBlock, JsonTree, LinkIconMedium, LinkIconRegular, MarkdownDelegateProvider,
MarkdownText, Menu, MenuGroup, MenuItemButton, MenuSurface, Modal, PathLabel,
PermissionIconFullAccessMedium, PermissionIconFullAccessRegular, PermissionIconReadOnlyMedium,
PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteMedium, PermissionIconWorkspaceWriteRegular,
Pill, PluginArtworkDefault, PluginArtworkLoop, PluginArtworkSearch, PluginArtworkSubagent,
PluginArtworkTerminal, ReadBlock, ReferenceIconMedium, ReferenceIconRegular, RiskConfirmation,
SHIELD_OUTLINE_PATH, SearchBlock, SegmentedControl, SegmentedTabs, SettingsForm,
SettingsFormModel, SettingsSecretField, SettingsValueField, ShortcutKeys, StateDot, Switch,
Tag, TerminalBlock, TextShimmer, Toast, Tooltip, WebBlock, classifyFileType, classifyLinkPath,
closeTopModal, diffTotals, extractMarkdownPlainText, fileExtension, fileSizeText,
focusWithoutRing, isBehindModal, isDarwinDesktop, languageForPath, modalSelector,
observeComposition, observeStickyMenuGroups, pointerModality, projectUserText, rankByName,
relativeTime, settingsNumberField, settingsTextField, useAnchoredMaxHeight,
useAnchoredPosition, useCodeHighlighter, useDismissOnOutsidePointer, useModalLayer, writeClipboard
```

**Answer to "does the seed give a plugin anything chart-shaped?" — no.** There is no
plot, axis, scale, series, legend, or sparkline component. What the list does contain that
is relevant to a canvas:

| Group | Exports | Relevance |
| --- | --- | --- |
| Markdown **with math** | `MarkdownText`, `MarkdownDelegateProvider`, `extractMarkdownPlainText` | Would give §1 for free — but §4.3 |
| Code | `CodeBlock`, `useCodeHighlighter`, `CODE_HIGHLIGHT_EXTENSIONS` | Shiki highlighting, toolbars |
| Structured data | `JsonBlock`, `JsonTree`, `DiffBlock`, `TerminalBlock`, `ReadBlock`, `SearchBlock`, `WebBlock` | Precedent for "a block type that renders a payload" |
| Chrome | `Button`, `Menu*`, `Modal`, `Tooltip`, `Pill`, `Tag`, `Switch`, `SegmentedControl`, `SettingsForm*`, `Toast`, `HoverCard`, `ImageLightbox`, `ShortcutKeys` | The house component vocabulary |
| Icons + hand-written SVG | ~190 `Icon*`, plus `FishLogo`, `BrandWordmark`, `GuideArtworkBrowser`, `GuideArtworkFiles`, `PluginArtwork*`, `FISH_LOGO_PATH`, `SHIELD_OUTLINE_PATH` | See below |
| Utilities | `writeClipboard`, `relativeTime`, `fileSizeText`, `fileExtension`, `classifyFileType`, `rankByName`, `settingsTextField`, `settingsNumberField`, `useAnchoredPosition`, `useModalLayer`, `focusWithoutRing`, `pointerModality`, `diffTotals`, … | Clipboard and formatting helpers a chart block would want |

The artwork exports are worth a hard look, because they are **the house precedent for
exactly the kind of graphic a chart is**. `GuideArtworkBrowser`, `GuideArtworkFiles`,
`PluginArtwork*`, and `FishLogo` are not icons from a set — they are hand-authored SVG
written directly in the bundle as JSX with literal paths and literal colours, e.g. at
`$PRIM:12361-12379`:

```js
jsxs("svg", { viewBox: "0 0 36 36", … children: [
  jsx("path", { d: "M10.7603 27.922H…", stroke: "#FFCD78", strokeWidth: "1.97886" })
] })
```

DSH draws its own small graphics as **plain React-rendered `<svg>` with hand-written
geometry** — no charting library, no drawing library. A plugin chart drawn as SVG is not
a workaround around the framework; it is the same technique the framework itself uses.

### 4.3 The one shortcut that works and is forbidden

A plugin *can* `require('@deepseek-ai/dsh-client-ui-primitives')` — it is in the seed, and
the module resolves. Doing so would give `MarkdownText`, and therefore §1's math, for
free, at zero bundle cost. It would also give `CodeBlock`, `JsonBlock`, and the whole
component vocabulary.

But `practices.md:35` forbids it (recorded in `dsh-plugin-contract.md` §9), and
`dsh-client-rendering.md` documents that a plugin's own page has no shell chrome. The
plugin-facing rule the framework states is: copy the markup/CSS/behaviour you need, keep
only the `--dsw-alias-*` theme tokens, and do not import Harness client packages. This
document treats that rule as binding and does not recommend the shortcut — but a reader
deciding policy should know the shortcut is *technically* available, so the constraint is
a convention rather than a hard wall here. (Contrast `dsh-chat-reuse.md` §D3-b: obtaining
`renderSlot` for `conversation.chat.node` is a genuine ownership lock, not a convention.)

### 4.4 One adjacent finding worth recording

Turndown is bundled — on the **host** side, for `web_fetch`:
`$PKG\dsh-tool-web\lib\index.js:328` describes "The shared HTML→markdown converter:
turndown over its bundled domino DOM". That is a markdown *producer*, and it is not
client-reachable, but it means the framework already converts HTML to markdown rather
than rendering HTML. Consistent with `MarkdownText`'s doc (`$PRIM:11810-11812`): "raw HTML
and unsafe protocols are disabled" — **DSH markdown does not render raw HTML**, so a
plugin cannot smuggle a chart in as an inline `<svg>` element in a message either.

## 5. Does the Agent know? **No — the model is never told about math delimiters, mermaid, or charts**

### 5.1 The evidence

| Searched | Scope | Result |
| --- | --- | --- |
| `mermaid` | whole extraction (12 967 files) | 3 hits, all in §2 — none agent-facing |
| `mermaid` | `dsh-system-prompt`, `dsh-agent-preset`, `dsh-persona`, `dsh-agent-instructions`, all `dsh-tool-*` | **0** |
| `katex` | `dsh-system-prompt`, `dsh-agent-preset`, `dsh-persona`, `dsh-agent-instructions` | **0** |
| `chart` | same four trees | **0** |
| `diagram` | same four trees | **0** |
| `$$` (literal) | `$PKG` | only `dsh-client-ui-primitives/lib/index.js` (the math code itself), `dsh-tool-bash`, `dsh-subprocess-local`, `dsh-home-paths`, and two vendored client chunks — all shell/JS template literals or PID expansions, none prompt text |
| `math` | `dsh-agent-instructions/lib/index.js` | 2 hits, both numeric: `Math.max` (`:123`), `Math.floor` (`:279`) — not prompt text. (Verified with a 30-character context window; the earlier 60-character window returned nothing.) |
| `math` | `$PKG\dsh-util-code-language\lib\index.js` | 1 hit: `Math.max` at `:232` — the extension→language map, not prompt text |
| `latex` | `$PKG\dsh-util-code-language\lib\index.js` | the extension→language map (highlighting), not prompt text |
| `markdown` (either case) | `dsh-system-prompt\lib`, `dsh-persona\lib`, `dsh-agent-preset\lib` | **0** |
| `format`, `` ``` ``, `code block`, `quote`, `heading` | same three `lib` dirs | **0** |
| `table` | `dsh-system-prompt\lib\index.js` | 2 hits, both JSDoc `@param` prose (`:246`, `:254`) — not prompt text |

Only six files under `$PKG` mention "Markdown" (capital M) in a `lib/index.js`, and none
of them is a prompt the model reads about *output* formatting: they are UI clients
(`dsh-client-ui-chat`, `-plan`, `-tool`, `-user-questions`, `-trajectory`,
`-agent-preset`, `-deliverables`, `-sidebar-documentpreview`), the primitives layer
itself, and `dsh-tool-web/lib/index.js` — where the word appears only in tool
*descriptions* telling the model to "cite the relevant URLs as markdown links"
(`:77`, `:259`) and in host-side conversion comments (`:328`, `:370`, `:530`).

### 5.2 The structural proof: no output-format section exists

The strongest form of the negative is not a grep but the prompt's own table of contents.
`$PKG\dsh-system-prompt\lib\index.js` is the registry that orders every section the model
receives. `SECTION_ORDERS` (`:11-43`) and `CONTEXT_ORDERS` (`:44-48`) enumerate the complete
taxonomy, verbatim in structure:

```
11: const SECTION_ORDERS = {
12: 	HARNESS_IDENTITY: -1e3,
13: 	DEPLOYMENT_PERSONA_PREFIX: 0,
14: 	PLAN_POLICY: 500,
15: 	TEAM_POLICY: 600,
16: 	PTC_ONLY: 800,
17: 	FILE_REFERENCE: 900,
18: 	TOOL_BASH: 1e3,
19: 	TOOL_PWSH: 1010,
20: 	TOOL_READ: 1100,
21: 	TOOL_WRITE: 1200,
22: 	TOOL_EDIT: 1300,
23: 	TOOL_GLOB: 1400,
24: 	TOOL_GREP: 1500,
25: 	TOOL_JOBS: 1600,
26: 	TOOL_PTY: 1700,
27: 	TOOL_WEB_SEARCH: 2e3,
28: 	TOOL_WEB_FETCH: 2100,
29: 	TOOL_LSP: 2200,
30: 	TOOL_SESSION_QUERY: 2300,
31: 	TOOL_GOAL: 2400,
32: 	TOOL_WORKFLOW: 2600,
33: 	TOOL_RALPH: 2700,
34: 	TOOL_SUBAGENT: 2800,
35: 	TOOL_REPORT: 2900,
36: 	TOOL_COMPUTER_USE: 3e3,
37: 	MCP_SERVERS: 3100,
38: 	TOOLS_SDK: 5e3,
39: 	DELIVERABLE_FILE_REFERENCES: 9e3,
40: 	STRUCTURED_OUTPUT: 9900,
41: 	HARNESS_SOURCE: 1e4,
42: 	WEB_SURFACE: 10100,
43: 	DEPLOYMENT_PERSONA_SUFFIX: 10200
44: };
```

There is **no `OUTPUT_FORMAT`, no `MARKDOWN`, no `MATH`, no `DIAGRAM` section** — and no
order number left for one to occupy. The model is told about tools, policies, the file
system, and the Web surface; it is never told about output syntax.

### 5.3 The Web-surface prompt, read in full

The one section that orients the model to this GUI is `app:web-surface`, registered in
`$PKG\dsh-web-app\lib\index.js:180-184` at order `WEB_SURFACE` and built by
`webSurfacePrompt(...)` (`:183`), defined at `:91-93`. Its **entire** text, verbatim
(`:92`):

> `You are interacting with the user through the DeepSeek Harness Web GUI at ${webUrl}. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. The browser provides no implicit DOM, route, or screenshot context. The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while `pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. Starting another server does not update this GUI. The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.`

Zero mentions of markdown, math, mermaid, charts, or rendering of any kind.

### 5.4 What this means

The model emits `$…$`, tables, and fences because general-purpose models write markdown
by habit — **not because DSH instructs it to**. There is no affordance the model is
offered and no capability it is told about. This has a direct design consequence for a
plugin: if a plugin wants to render `$$…$$` or a ```chart fence from model output, it
cannot rely on the model having been primed to produce it; it must either say so in its
own prompt contribution (a plugin can add a system section — that is how `app:web-surface`
itself is contributed) or accept whatever markdown happens to arrive.

### 5.5 What would settle the remaining unknown

§5 answers the question for **the harness's own prompt text**, which is all this artifact
contains. It cannot observe the **server-side** chat template applied by the DeepSeek API
or the desktop host's own request assembly, which may append formatting guidance outside
the asar. Settling that would require capturing an actual request payload (the session's
wire log or an API proxy) and inspecting the system message that leaves the machine.

## 6. Search ledger — what was searched, so the negatives can be re-tested

Reproduce any negative above with:

```powershell
$ASAR = 'C:\Users\haoch\AppData\Local\Temp\dsh-asar\'
$PKG  = "$ASAR\dsh\node_modules\@deepseek-ai\"
$DIST = "$PKG\dsh-web-frontend\dist\"

# §2 — mermaid, whole extraction
rg -i --no-messages -n mermaid $ASAR

# §3 — chart libraries, whole extraction
rg -i --no-messages -n 'chart\.js|chartjs|recharts|vega-lite|plotly|highcharts|apexcharts|victory|billboard|chartist|dygraphs|d3-scale|d3-shape|echarts' $ASAR

# §3.2 — complete runtime file inventory (the strong negative)
rg -i --no-messages -o '[^"\s]*(chart|plot|graphviz|cytoscape|nomnoml|jsxgraph|mermaid|diagram|d3-|vega|echarts)[^"\s]*' "$ASAR\dsh\desktop-runtime.json"

# §5 — is the model ever told?
rg -i --no-messages -n 'mermaid|katex|chart|diagram' "$PKG\dsh-system-prompt\lib" "$PKG\dsh-persona\lib" "$PKG\dsh-agent-preset\lib" "$PKG\dsh-agent-instructions\lib"

# §1 — the delimiter extension
rg -n -o 'lang === .{0,60}' "$PKG\dsh-client-ui-primitives\lib\index.js"
```

Caution when reproducing: a wide-context (`-o` with a large `.{0,N}` window) grep against
`$DIST\assets\index-5SrrfWpU.js` produces enormous output — the bundle is minified onto few
lines. Use `-c` or narrow windows there.

## 7. Recommendation

### 7.1 For a plugin that draws its own canvas and wants bar / line / pie

Ranked by realistic cost, cheapest first. All four are compatible with the platform seed
(§4.1) and with `practices.md:35` (§4.3).

**Option 1 — Render it yourself as SVG with React. Cost: low, and it is the house style.**
This is the recommended option, and it is cheaper than it sounds.

- You already have React 18 and `react/jsx-runtime` in the seed. `<svg><rect/><polyline/><path/><text/></svg>`
  is all a bar, line, or pie chart is.
- The framework itself does exactly this for its non-icon artwork, in the same bundle a
  plugin's consumers look at: `GuideArtworkBrowser`, `FishLogo`, `PluginArtwork*` are
  hand-written `jsxs("svg", { viewBox: …, children: [jsx("path", { d: "M10.7603 27.922H…", … })] })`
  at `$PRIM:12361-12379` — literal path data, literal colours, no library. A chart drawn
  this way is not a hack around DSH; it is DSH's own technique.
- Concretely, the work is: (a) a scale function mapping value→pixel (a `min`/`max` and a
  divide — a few lines); (b) one `<rect>` per bar with a `<text>` label, or a single
  `<polyline points="…">` for a line, or `<path d="M cx cy L x1 y1 A r r 0 0 1 x2 y2 Z">`
  arcs for a pie; (c) axis ticks as `<line>`+`<text>`; (d) a `viewBox` plus
  `width: 100%` so it scales to the panel; (e) colours read from the `--dsw-alias-*`
  tokens so it themes correctly. **Estimated at a few hundred lines for a respectable
  bar+line+pie trio, zero dependencies, zero bundle weight, nothing to load
  asynchronously, and no version-drift risk.** The genuinely fiddly parts are axis tick
  selection and pie label placement, and both can be simplified away for a first version.
- Bonus: because the same page always loads `$DIST\assets\vendor-BNsW4eBh.css`, you
  inherit the shell's font stack and tokens without shipping anything.

**Option 2 — Vendor a small charting library into a package-local lazy chunk. Cost: moderate,
and mostly integration rather than code.**

- `dsh-client-rendering.md` establishes that this route works and is precedented: a
  package-local chunk named `client.<name>.js`, loaded via
  `require.async("./client.<name>.js")`, self-registering through
  `window.__ModuleLoader__.load({ id, chunk, factory })`, served by the plugin's own
  `/plugins`-style route. There is no size cap, and the precedent
  `docpreview/client.pdf.js` is **7 108 786 bytes**.
- So a chart library is *technically* shippable. But: DSH ships none (§3), so you must
  vendor one yourself — adding hundreds of KB to your plugin and a licensing/upgrade
  burden — to obtain what Option 1 gets in a few hundred lines you fully control. The
  only good reasons to pick this are capabilities SVG-by-hand does not cover well
  (zooming/tooltips over thousands of points, axes with time-scale semantics, brushing).

**Option 3 — `require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText` and emit math
or tables instead of a chart. Cost: trivial, but it violates the stated plugin rule.**
Listed for completeness and priced deliberately last-but-one: it is the cheapest
technically and the only option here that breaks `practices.md:35`. It buys markdown —
which is not a chart. Reject it for a chart; consider it only if the plugin's actual need
turns out to be math (§7.2) and policy is reconsidered.

**Option 4 — Anchor an SVG chart in an image or deliverable and reference it. Cost: high
latency, poor interactivity, not recommended for live data.** The host can rasterize
(LibreOfficeKit/PDFium are the only bundled rasterizers per `dsh-plugin-contract.md` §9;
`sharp` is present but plugin-unreachable), and `/api/file` serves images. This is a
reasonable way to show a *static* figure, and a bad way to show a chart that responds to
data.

**Ranked answer: 1 > 2 > 4 > 3.** Option 1 unless the chart needs real interactivity over
large datasets; Option 2 only then; do not build on Option 3.

### 7.2 What math support would cost, given what the framework already ships

The framework ships everything except the JavaScript, and the JavaScript is the small part.

| Component | Status in DSH | A plugin's cost |
| --- | --- | --- |
| KaTeX **CSS** | Shipped and **loaded on every page** (`$DIST\index.html` → `vendor-BNsW4eBh.css`, 29 288 B, 393 `.katex` rules) | **0** — just use KaTeX's class names |
| KaTeX **fonts** | Shipped, 59 files / 1 072 948 B, at `$DIST\assets\fonts\`, referenced by **document-relative** `./fonts/KaTeX_*.woff2` URLs | **0** — already fetched, already resolvable from the plugin's page |
| KaTeX **JS** | Shipped inside the shared `vendor-CCJJTK99.js` vendor chunk — **not** in the platform seed, **not** importable by a plugin | **the only real cost**: vendor `katex` (~270 KB minified) into a package-local lazy chunk (Option 2's machinery), **or** copy the ~150 lines of DSH's own tokenizer/render glue and accept KaTeX JS as a vendored dependency of your chunk |
| Micromark math grammar | `micromark-extension-math` + `mdast-util-math` (`package.json:43,46`) | Vendor alongside, or reimplement the trivial `$$` scanning if the plugin controls its own input format |
| DSH's delimiter extension (`\(…\)`, `\[…\]`, same-line `$$…$$`) | `$PRIM:10683-10701` — about 20 lines of extension wiring plus a ~90-line tokenizer (`:10441-10533`) | **Low** — this is the one piece worth copying rather than reinventing, and it is small |
| Streaming behaviour | `parseGfm` (no math) while streaming → `parseGfmWithMath` once settled (`$PRIM:10704-10741`) | **Low, but do not skip it**: without the two-grammar split, half-typed TeX flashes red KaTeX errors mid-stream. This is a design lesson the framework learned, and copying it is free |
| Error fallback | strict → `strict:"ignore"` → red `.katex-error` span with the parse error in `title` (`$PRIM:11004-11029`) | **Low** — three lines of try/catch, and it prevents a canvas crash on malformed TeX |
| Security posture | `trust` never passed — no `\href`/`\includegraphics` (`$PRIM:11178`); raw HTML disabled (`$PRIM:11810-11812`) | **0** — but adopt it: KaTeX HTML must be inserted via a re-parse (`DOMParser` → React elements, `$PRIM:11028`) rather than `dangerouslySetInnerHTML` for untrusted input |

**Bottom line: math support costs a plugin one vendored JavaScript file.** The 1.05 MB of
fonts and 29 KB of CSS are already shipped and already loaded on the page the plugin draws
into, so the marginal cost of math is KaTeX's JS plus a small amount of copyable glue — not
a rendering stack. That is a materially better deal than charts, where the framework ships
**nothing** and the plugin must either draw SVG itself (§7.1 Option 1) or vendor an entire
charting library (§7.1 Option 2).

The asymmetry is the actionable conclusion of this research: **DSH gives math away for
free and gives charts not at all.**
