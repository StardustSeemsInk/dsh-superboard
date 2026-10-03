/**
 * The board view — the project's own DOM/SVG renderer.
 *
 * Why hand-built rather than a canvas library (Q2, settled): the Agent can never see pixels, so
 * **the scene model is the real product and this is only a projection of it.** Owning the
 * projection keeps PDF page-space anchoring exact, keeps markdown blocks as real editable DOM,
 * and leaves the renderer replaceable without touching the model.
 *
 * Three structural decisions here:
 *
 *   1. **Layout is CSS, geometry is measured.** The Agent declares structure (Q-E) and a
 *      template decides the arrangement; the browser does the flow. Arrow endpoints are then
 *      *measured from the DOM* rather than computed in parallel, so a line cannot disagree with
 *      the box it points at — after a reflow, a font load, or a window resize.
 *   2. **Only the active view renders** (`conversation.view` renders one entry at a time), so the
 *      board must be able to rebuild itself from the projection alone. It holds no authority:
 *      pan/zoom/page selection are view state and are deliberately not persisted into the model.
 *   3. **No host component library.** Importing `@deepseek-ai/dsh-client-ui-primitives` is
 *      forbidden (`practices.md:35`) — a throwing component blanks the whole slot entry — so the
 *      stylesheet renders as a component-local `<style>` element and uses only `--dsw-alias-*`
 *      tokens.
 *
 * This file is served to the browser verbatim: plain classic script, `React.createElement`, no
 * JSX, no build step. The factory receives **only `require`** — no `ctx`, no `host`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-superboard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // -----------------------------------------------------------------------
    // Styles
    // -----------------------------------------------------------------------

    const BOARD_CSS = [
      '.sb-root{display:flex;flex-direction:column;gap:10px;min-width:0;height:100%;color:var(--dsw-alias-label-primary);}',
      '.sb-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.sb-title{font-size:13px;font-weight:600;line-height:18px;}',
      '.sb-rev{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;}',
      '.sb-spacer{flex:1;}',
      '.sb-pages{display:flex;align-items:center;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l2);}',
      '.sb-page{font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;border-bottom:2px solid transparent;padding:4px 8px;}',
      '.sb-pageOn{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600;}',
      '.sb-pageCount{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:4px;}',
      '.sb-canvas{position:relative;flex:1;min-height:0;overflow:auto;padding:2px;}',      '.sb-flow{display:flex;flex-direction:column;gap:12px;}',
      '.sb-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));align-items:start;}',
      '.sb-columns{display:grid;gap:12px;align-items:start;}',
      '.sb-row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;}',
      '.sb-row>.sb-card{flex:1 1 220px;min-width:0;}',
      // A container whose children are pinned needs to be a containing block itself.
      '.sb-anchored{position:relative;}',
      '.sb-absBox{position:relative;min-height:120px;}',
      // A pinned block leaves the flow entirely, so it never widens its container.
      '.sb-pinned{position:absolute;}',
      '.sb-groupBox{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px;min-width:0;}',
      '.sb-groupHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.sb-groupTitle{font-size:12px;font-weight:600;line-height:18px;}',
      '.sb-groupBody{min-width:0;}',
      '.sb-cardHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      // Regions annotate. Colour and a label, never a position.
      '.sb-regionTag{font-size:10px;line-height:14px;padding:0 6px;border-radius:999px;border:1px solid currentColor;opacity:.9;}',
      '.sb-tone-warn{border-left:3px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-brand-primary));}',
      '.sb-tone-danger{border-left:3px solid var(--dsw-alias-state-error-primary,var(--dsw-alias-brand-primary));}',
      '.sb-tone-ok{border-left:3px solid var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary));}',
      '.sb-tone-neutral{border-left:3px solid var(--dsw-alias-border-l2);}',
      '.sb-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;min-width:0;position:relative;}',
      '.sb-cardSel{border-color:var(--dsw-alias-brand-primary);}',
      '.sb-kind{position:absolute;top:6px;right:8px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;letter-spacing:.04em;text-transform:uppercase;}',
      '.sb-slug{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;margin-bottom:4px;}',
      '.sb-h1{margin:0;font-size:18px;font-weight:600;line-height:26px;}',
      '.sb-h2{margin:0;font-size:15px;font-weight:600;line-height:22px;}',
      '.sb-h3{margin:0;font-size:13px;font-weight:600;line-height:20px;}',
      '.sb-p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;}',
      // Inline markdown. Only token names and tokens: no literal colours, so a renamed token
      // degrades appearance rather than breaking the render.
      '.sb-p strong,.sb-list strong{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.sb-p em,.sb-list em{font-style:italic;}',
      '.sb-inlineCode{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-1);border-radius:4px;padding:1px 4px;}',
      '.sb-link{color:var(--dsw-alias-brand-primary);text-decoration:none;}',
      '.sb-link:hover{text-decoration:underline;}',
      '.sb-list{margin:0;padding-left:18px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.sb-code{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;background:var(--dsw-alias-bg-layer-1);border-radius:6px;padding:8px;}',
      '.sb-media{display:block;max-width:100%;border-radius:6px;}',
      '.sb-missing{color:var(--dsw-alias-label-tertiary);font-size:12px;font-style:italic;}',
      '.sb-group{border-style:dashed;padding-left:14px;}',
      '.sb-edges{position:absolute;inset:0;pointer-events:none;overflow:visible;}',
      '.sb-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:12px 0;}',
      // Marquee: the canvas owns the drag, so text selection inside it must be suppressed while
      // a selection gesture is in flight, or dragging would select the board's own prose.
      '.sb-picking,.sb-picking *{user-select:none;cursor:crosshair;}',
      '.sb-marquee{position:absolute;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);opacity:.12;pointer-events:none;border-radius:2px;}',
      '.sb-cardSel{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary);}',
      // A single row, only while something is selected. No idle state at all.
      '.sb-selbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px;}',
      '.sb-selbarCount{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.sb-selbarSlugs{color:var(--dsw-alias-label-tertiary);margin-left:6px;}',
      '.sb-selbarError{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary));}',
      '.sb-buttonPrimary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);font-weight:600;}',
      '.sb-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}',
      // The board and the reading column share the tab. They have to: only the active
      // conversation.view renders, so while the board is open the transcript is nowhere else.
      '.sb-main{display:flex;align-items:stretch;flex:1;min-height:0;min-width:0;}',
      '.sb-column{display:flex;flex-direction:column;gap:10px;flex:1;min-width:0;min-height:0;}',
      '.sb-reader{display:flex;flex-direction:column;gap:8px;flex:0 0 auto;position:relative;min-width:0;padding-left:10px;}',
      '.sb-readerHead{display:flex;align-items:center;gap:8px;}',
      '.sb-readerTitle{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em;}',
      '.sb-readerBody{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding-right:2px;}',
      '.sb-readerMore{align-self:center;}',
      '.sb-splitter{position:absolute;left:0;top:0;bottom:0;width:9px;margin-left:-4px;cursor:col-resize;border-radius:4px;touch-action:none;}',
      '.sb-splitter:hover,.sb-splitterOn{background:var(--dsw-alias-brand-primary);opacity:.35;}',
      '.sb-turn{display:flex;flex-direction:column;gap:3px;border-radius:8px;padding:8px 10px;min-width:0;}',
      '.sb-turn-user{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);} ',
      '.sb-turn-assistant{background:transparent;border:1px solid transparent;}',
      '.sb-turnRole{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);letter-spacing:.04em;}',
      '.sb-turnBody{min-width:0;}',
      '.sb-md{display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);min-width:0;}',
      '.sb-mdP{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;}',
      '.sb-mdH{margin:2px 0 0;font-weight:600;}',
      '.sb-mdH1{font-size:17px;line-height:24px;}',
      '.sb-mdH2{font-size:15px;line-height:22px;}',
      '.sb-mdH3,.sb-mdH4,.sb-mdH5,.sb-mdH6{font-size:13px;line-height:20px;}',
      '.sb-mdList{margin:0;padding-left:20px;}',
      '.sb-mdList li{margin:1px 0;}',
      '.sb-mdQuote{margin:0;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}',
      '.sb-mdInner{font-size:12px;line-height:19px;}',
      '.sb-mdCode,.sb-code{margin:0;overflow-x:auto;}',
      '.sb-codeLang{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px;}',
      '.sb-inlineCode{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-1);border-radius:4px;padding:0 4px;}',
      '.sb-link{color:var(--dsw-alias-brand-primary);text-decoration:underline;}',
    ].join('')

    /** Render the stylesheet as a component so unmounting removes it. */
    function BoardStyles() {
      return h('style', null, BOARD_CSS)
    }

    // -----------------------------------------------------------------------
    // Layout templates
    // -----------------------------------------------------------------------

    /**
     * Map a layout template to the class that arranges its children.
     *
     * This is the whole of "the engine decides geometry": the Agent names an arrangement, CSS does
     * the flow, and the arrows follow by measurement rather than by parallel computation. Each name
     * maps to a CSS concept the model has read a million times, which is the point — it cannot see
     * the canvas, so its vocabulary has to be one it already reasons in.
     *
     * @param layout - the layout spec, or none.
     * @returns the class name.
     */
    function layoutClass(layout) {
      switch (layout?.template) {
        case 'row':
          return 'sb-row'
        case 'grid':
          return 'sb-grid'
        case 'columns':
          return 'sb-columns'
        case 'canvas':
          return 'sb-absBox'
        default:
          return 'sb-flow'
      }
    }

    /**
     * The inline style a layout needs on top of its class.
     *
     * Widths are read from the container's own measurement rather than from a fixed breakpoint,
     * because the panel is resizable: dragging the reading column, or the window, changes how much
     * room a row of cards has. A shape the Agent asked for should survive that.
     *
     * @param layout - the layout spec.
     * @param width - the container's measured width in px.
     * @returns a style object, or undefined when the class already says everything.
     */
    function layoutStyle(layout, width) {
      const style = {}

      const gap = Number(layout?.params?.gap)
      if (Number.isFinite(gap) && gap >= 0) style.gap = `${Math.min(Math.trunc(gap), 64)}px`

      if (layout?.template === 'columns') {
        // `??`, not `||`: an explicit 0 is a request, not an absence — and it clamps to 1.
        const requested = Number(layout.params?.cols ?? 2)
        const safe = Number.isFinite(requested) ? requested : 2
        const cols = Math.max(1, Math.min(Math.trunc(safe) || 1, width < 720 ? 1 : 4))
        style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`
      }

      if (layout?.template === 'grid') {
        // auto-fill with a minimum card width is responsive by construction: the browser fits as
        // many as the current width allows, so no breakpoint is needed or wanted.
        const requested = Number(layout.params?.minCardWidth ?? 260)
        const safe = Number.isFinite(requested) ? requested : 260
        const min = Math.max(120, Math.min(Math.trunc(safe) || 260, 640))
        style.gridTemplateColumns = `repeat(auto-fill, minmax(${min}px, 1fr))`
      }

      return Object.keys(style).length === 0 ? undefined : style
    }

    /**
     * The blocks that no group claims.
     *
     * A block belongs to at most one container, so "which blocks sit at the top level" is exactly
     * "which blocks nobody lists as a child". Deriving it rather than storing it means the tree
     * cannot disagree with the page's own order, which is what keeps the renderer from needing a
     * second source of truth.
     *
     * @param blocks - the page's blocks.
     * @returns the top-level blocks, in page order.
     */
    function rootBlocksOf(blocks) {
      const claimed = new Set()
      for (const block of blocks) {
        if (block.kind !== 'group') continue
        for (const child of block.children ?? []) claimed.add(child)
      }
      return blocks.filter((block) => !claimed.has(block.id))
    }

    /**
     * Turn an explicit position into a style.
     *
     * The escape hatch, not the mechanism. A block with `at` leaves the flow and is placed against
     * its container, which is the only way to say "put this annotation *here*" — and it is also the
     * one thing the Agent cannot check afterwards, so it stays deliberately awkward to reach for.
     *
     * @param at - the position, or none.
     * @returns a style object, or undefined when the block flows normally.
     */
    function atStyle(at) {
      if (at === null || at === undefined || typeof at !== 'object') return undefined
      const x = Number(at.x)
      const y = Number(at.y)
      const style = {
        position: 'absolute',
        left: `${Math.trunc(Number.isFinite(x) ? x : 0)}px`,
        top: `${Math.trunc(Number.isFinite(y) ? y : 0)}px`,
      }
      if (Number.isFinite(Number(at.w))) style.width = `${Math.trunc(Number(at.w))}px`
      if (Number.isFinite(Number(at.h))) style.height = `${Math.trunc(Number(at.h))}px`
      return style
    }

    // -----------------------------------------------------------------------
    // Inline markdown
    // -----------------------------------------------------------------------

    /**
     * Whether a link target is one a board is willing to open.
     *
     * The Agent writes the board, and the Agent's own input includes whatever it has been reading —
     * so board content is untrusted by the time it renders. A `javascript:` href in a card would be
     * a scripting primitive handed to content, so anything that is not plainly a web address or a
     * same-page fragment is refused and rendered as literal text instead.
     *
     * @param href - the raw target from the source.
     * @returns the target when it is safe to link, otherwise `undefined`.
     */
    function safeHref(href) {
      const raw = String(href ?? '').trim()
      if (raw === '') return undefined
      // Scheme-relative and root-relative URLs carry no scheme to abuse.
      if (raw.startsWith('/') || raw.startsWith('#')) return raw
      const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(raw)
      if (scheme === null) return raw // a relative path
      const allowed = ['http', 'https', 'mailto']
      return allowed.includes(scheme[1].toLowerCase()) ? raw : undefined
    }

    /** Emphasis nesting deeper than this is treated as literal text. */
    const INLINE_MAX_DEPTH = 6

    /**
     * Split one line of text into inline markdown nodes.
     *
     * A deliberately small subset — strong, emphasis, code spans and links — because that is what a
     * board block actually needs, and because the renderer builds **React elements rather than an
     * HTML string**. There is no `dangerouslySetInnerHTML` anywhere in this file, so anything the
     * tokenizer fails to recognise stays inert text instead of becoming markup.
     *
     * Block-level markdown is not handled here at all: headings, lists and code are separate block
     * kinds, so a prose block has no block-level structure to parse.
     *
     * @param text - the source text.
     * @param depth - recursion guard for nested emphasis.
     * @returns a flat node list: `text`, `code`, `strong`, `em` (with `children`) and `link`.
     */
    function parseInline(text, depth = 0) {
      const source = String(text ?? '')
      const nodes = []
      let buffer = ''

      const flush = () => {
        if (buffer !== '') {
          nodes.push({ type: 'text', text: buffer })
          buffer = ''
        }
      }
      const nested = (inner) =>
        depth >= INLINE_MAX_DEPTH ? [{ type: 'text', text: inner }] : parseInline(inner, depth + 1)

      let index = 0
      while (index < source.length) {
        const char = source[index]

        // `code` — taken first, so emphasis markers inside a span stay literal.
        if (char === '`') {
          const end = source.indexOf('`', index + 1)
          if (end > index + 1) {
            flush()
            nodes.push({ type: 'code', text: source.slice(index + 1, end) })
            index = end + 1
            continue
          }
        }

        // **strong** — before single-marker emphasis, which would otherwise claim the first star.
        if (source.startsWith('**', index)) {
          const end = source.indexOf('**', index + 2)
          if (end > index + 2) {
            flush()
            nodes.push({ type: 'strong', children: nested(source.slice(index + 2, end)) })
            index = end + 2
            continue
          }
        }

        // *em* or _em_
        if (char === '*' || char === '_') {
          const end = source.indexOf(char, index + 1)
          if (end > index + 1) {
            flush()
            nodes.push({ type: 'em', children: nested(source.slice(index + 1, end)) })
            index = end + 1
            continue
          }
        }

        // [text](href)
        if (char === '[') {
          const close = source.indexOf(']', index + 1)
          if (close !== -1 && source[close + 1] === '(') {
            const paren = source.indexOf(')', close + 2)
            if (paren !== -1) {
              const href = safeHref(source.slice(close + 2, paren))
              const label = source.slice(index + 1, close)
              if (href !== undefined && label !== '') {
                flush()
                nodes.push({ type: 'link', href, text: label })
                index = paren + 1
                continue
              }
            }
          }
        }

        buffer += char
        index += 1
      }

      flush()
      return nodes
    }

    /**
     * Render parsed inline nodes.
     *
     * @param nodes - the node list from {@link parseInline}.
     * @param keyPrefix - a stable prefix so React can reconcile the list.
     * @returns React children.
     */
    function renderInline(nodes, keyPrefix = 'md') {
      return nodes.map((node, position) => {
        const key = `${keyPrefix}-${position}`
        switch (node.type) {
          case 'strong':
            return h('strong', { key }, renderInline(node.children, key))
          case 'em':
            return h('em', { key }, renderInline(node.children, key))
          case 'code':
            return h('code', { key, className: 'sb-inlineCode' }, node.text)
          case 'link':
            return h(
              'a',
              {
                key,
                className: 'sb-link',
                href: node.href,
                // Board links leave the application; opening in a new tab keeps the session.
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              node.text,
            )
          default:
            return h('span', { key }, node.text)
        }
      })
    }

    /**
     * Render text that may contain inline markdown.
     *
     * @param text - the source text.
     * @returns a fragment of React children.
     */
    function RichText({ text }) {
      return h(React.Fragment, null, renderInline(parseInline(text)))
    }

    // -----------------------------------------------------------------------
    // Block rendering
    // -----------------------------------------------------------------------

    /**
     * Render one block.
     *
     * Every kind the model can hold is renderable except `uml`, which is data-only in v1 (Q-B):
     * it shows its source so the Agent and the user can at least see what is there, and the
     * error-feedback loop that will replace this arrives with the mermaid chunk.
     */

    /**
     * The kind-specific body of a block.
     *
     * Text-bearing kinds render inline markdown. Author-written prose is the whole point of a
     * board that doubles as a persistent display surface, and showing `**根因**` with its asterisks
     * intact reads as broken text rather than as emphasis. Structured kinds (code, diagram source)
     * stay literal on purpose — their content is verbatim by definition.
     */
    function renderBlockBody(block) {
      switch (block.kind) {
        case 'heading':
          return h(`h${block.level}`, { className: `sb-h${block.level}` }, h(RichText, { text: block.text }))
        case 'prose':
          return h('p', { className: 'sb-p' }, h(RichText, { text: block.markdown }))
        case 'list':
          return h(
            block.ordered ? 'ol' : 'ul',
            { className: 'sb-list' },
            block.items.map((item) =>
              h(
                'li',
                { key: item.id, style: item.depth > 0 ? { marginLeft: item.depth * 12 } : undefined },
                h(RichText, { text: item.text }),
              ),
            ),
          )
        case 'code':
          return h(
            'div',
            null,
            block.filename === undefined ? null : h('div', { className: 'sb-slug' }, block.filename),
            h('pre', { className: 'sb-code' }, block.code),
          )
        case 'image':
          return h(
            'div',
            null,
            h('img', { className: 'sb-media', src: block.src, alt: block.alt }),
            block.caption === undefined ? null : h('p', { className: 'sb-p' }, h(RichText, { text: block.caption })),
          )
        case 'pdf-page':
          // Rendering a PDF page needs rasterisation in the host document (an iframe would lose
          // the theme and locale), which is a subsystem of its own. Until then, say what it is.
          return h(
            'div',
            null,
            h('p', { className: 'sb-missing' }, `PDF page ${block.page} of ${block.src} — not rendered yet`),
            block.caption === undefined ? null : h('p', { className: 'sb-p' }, h(RichText, { text: block.caption })),
          )
        case 'uml':
          return h(
            'div',
            null,
            h('div', { className: 'sb-slug' }, `${block.engine} · ${block.diagram}`),
            h('pre', { className: 'sb-code' }, block.source),
            h('p', { className: 'sb-missing' }, 'Diagram rendering arrives with the UML milestone.'),
          )
        case 'group':
          return h(
            'div',
            null,
            block.title === undefined ? null : h('h3', { className: 'sb-h3' }, h(RichText, { text: block.title })),
            h('p', { className: 'sb-missing' }, `contains ${block.children.length} block(s)`),
          )
        default:
          return h('p', { className: 'sb-p' }, `unsupported block kind: ${block.kind}`)
      }
    }

    // -----------------------------------------------------------------------
    // Edges
    // -----------------------------------------------------------------------

    /**
     * Draw the page's edges over the blocks.
     *
     * Endpoints are measured from the rendered DOM rather than computed from a second layout
     * model. That is the point: a parallel geometry calculation would be free to disagree with
     * what the browser actually laid out, and it eventually would.
     *
     * Geometry is recomputed when the canvas resizes, when a block resizes, and whenever the
     * model changes — so a reflow, a font load, or a new block cannot leave a stale arrow.
     *
     * The SVG is absolutely positioned at the canvas origin and therefore contributes nothing to
     * the canvas's scroll size; its extent is the visible area, which is all that can be seen.
     * Coordinates are taken relative to the canvas's *content* box (scroll offset added back in),
     * so they stay correct while the canvas is scrolled.
     */
    function EdgeLayer({ containerRef, blocks, edges }) {
      const [state, setState] = React.useState({ paths: [], width: 0, height: 0 })

      React.useEffect(() => {
        const container = containerRef.current
        if (container === null) return undefined

        let frame = null
        const measure = () => {
          frame = null
          const base = container.getBoundingClientRect()
          const boxes = new Map()
          for (const element of container.querySelectorAll('[data-block-id]')) {
            const rect = element.getBoundingClientRect()
            boxes.set(element.getAttribute('data-block-id'), {
              left: rect.left - base.left + container.scrollLeft,
              top: rect.top - base.top + container.scrollTop,
              width: rect.width,
              height: rect.height,
            })
          }

          const paths = []
          for (const edge of edges) {
            const from = boxes.get(edge.from.blockId)
            const to = boxes.get(edge.to.blockId)
            // An edge whose endpoint is on another page is simply not drawn here.
            if (from === undefined || to === undefined) continue
            paths.push({ edge, d: routeBetween(from, to) })
          }

          setState((previous) => {
            // Skip the state update when nothing moved, so scrolling does not churn the tree.
            if (samePaths(previous.paths, paths) && previous.width === container.clientWidth && previous.height === container.clientHeight) {
              return previous
            }
            return { paths, width: container.clientWidth, height: container.clientHeight }
          })
        }

        // Coalesce bursts of resize callbacks into one measurement per frame.
        const schedule = () => {
          if (frame !== null) return
          frame = requestAnimationFrame(measure)
        }

        schedule()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
        if (observer !== null) {
          observer.observe(container)
          for (const element of container.querySelectorAll('[data-block-id]')) observer.observe(element)
        }
        container.addEventListener('scroll', schedule, { passive: true })

        return () => {
          if (frame !== null) cancelAnimationFrame(frame)
          if (observer !== null) observer.disconnect()
          container.removeEventListener('scroll', schedule)
        }
      }, [containerRef, blocks, edges])

      return h(
        'svg',
        {
          className: 'sb-edges',
          width: state.width,
          height: state.height,
          viewBox: `0 0 ${Math.max(state.width, 1)} ${Math.max(state.height, 1)}`,
          'aria-hidden': 'true',
        },
        h(
          'defs',
          null,
          h(
            'marker',
            {
              id: 'sb-arrow',
              viewBox: '0 0 10 10',
              refX: '9',
              refY: '5',
              markerWidth: '6',
              markerHeight: '6',
              orient: 'auto-start-reverse',
            },
            h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'context-stroke' }),
          ),
        ),
        state.paths.map(({ edge, d }) =>
          h(
            'path',
            {
              // The id is referenced by the label's textPath, so the label rides the curve.
              id: edgePathId(edge.id),
              key: edge.id,
              d,
              fill: 'none',
              stroke: 'var(--dsw-alias-label-tertiary)',
              strokeWidth: 1.5,
              strokeDasharray: edge.style === 'dashed' ? '6 4' : edge.style === 'dotted' ? '2 3' : undefined,
              markerEnd: 'url(#sb-arrow)',
            },
            edge.label === undefined
              ? null
              : h(
                  'title',
                  null,
                  edge.label,
                ),
          ),
        ),
      )
    }

    /** Whether two path lists describe the same drawing. */
    function samePaths(left, right) {
      if (left.length !== right.length) return false
      for (let index = 0; index < left.length; index += 1) {
        if (left[index].edge.id !== right[index].edge.id || left[index].d !== right[index].d) return false
      }
      return true
    }

    /** A stable DOM id for one edge's path, so a label can address it. */
    function edgePathId(edgeId) {
      return `sb-edge-${String(edgeId).replace(/[^A-Za-z0-9_-]/g, '')}`
    }

    /**
     * Route an arrow between two boxes.
     *
     * A cubic curve leaving the source's nearest side and arriving at the target's facing side,
     * which reads well for both a vertical flow and a side-by-side pair without needing a
     * general graph router.
     */
    function routeBetween(from, to) {
      const fromCenter = { x: from.left + from.width / 2, y: from.top + from.height / 2 }
      const toCenter = { x: to.left + to.width / 2, y: to.top + to.height / 2 }
      const dx = toCenter.x - fromCenter.x
      const dy = toCenter.y - fromCenter.y
      const vertical = Math.abs(dy) >= Math.abs(dx)

      const start = vertical
        ? { x: fromCenter.x, y: dy > 0 ? from.top + from.height : from.top }
        : { x: dx > 0 ? from.left + from.width : from.left, y: fromCenter.y }
      const end = vertical
        ? { x: toCenter.x, y: dy > 0 ? to.top : to.top + to.height }
        : { x: dx > 0 ? to.left : to.left + to.width, y: toCenter.y }

      const bow = Math.max(18, Math.min(60, Math.abs(vertical ? dy : dx) / 3))
      const c1 = vertical ? { x: start.x, y: start.y + (end.y > start.y ? bow : -bow) } : { x: start.x + (end.x > start.x ? bow : -bow), y: start.y }
      const c2 = vertical ? { x: end.x, y: end.y - (end.y > start.y ? bow : -bow) } : { x: end.x - (end.x > start.x ? bow : -bow), y: end.y }
      return `M ${round(start.x)} ${round(start.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(end.x)} ${round(end.y)}`
    }

    /** One decimal is plenty for a path and keeps the DOM diff stable. */
    function round(value) {
      return Math.round(value * 10) / 10
    }

    // -----------------------------------------------------------------------
    // Selection and the feedback tray
    // -----------------------------------------------------------------------

    /**
     * Normalise two drag points into a rectangle, whichever way the user dragged.
     *
     * @param start - where the pointer went down, in canvas content coordinates.
     * @param end - where it is now.
     * @returns `{ left, top, width, height }`, always non-negative.
     */
    function normaliseRect(start, end) {
      return {
        left: Math.min(start.x, end.x),
        top: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      }
    }

    /** Whether two axis-aligned rectangles overlap at all. */
    function rectsIntersect(a, b) {
      return (
        a.left < b.left + b.width &&
        b.left < a.left + a.width &&
        a.top < b.top + b.height &&
        b.top < a.top + a.height
      )
    }

    /**
     * Build the structured payload the user hands to the Agent (Q-H).
     *
     * Deliberately the *structure*, not a bitmap: the Agent reads the board model directly, so
     * what it cannot get on its own is which blocks a human meant and what a human said about
     * them. Visual grounding, when it arrives, is a bitmap query the Agent initiates.
     *
     * @param item - one tray entry.
     * @returns a clipboard-ready text block.
     */
    function formatFeedback(item) {
      const lines = [`[看板反馈 · ${item.pageSlug} · ${item.rev}]`]
      lines.push(`选中块：${item.blocks.join('、')}`)
      if (item.edges.length > 0) {
        lines.push(`其间关系：${item.edges.join('；')}`)
      }
      if (item.note.trim() !== '') lines.push(`说明：${item.note.trim()}`)
      return lines.join('\n')
    }

    /**
     * Describe the edges wholly inside a selection.
     *
     * An edge with one endpoint outside the selection is still meaningful, but reporting it as
     * "between these blocks" would overstate what the user selected, so it is described as
     * leaving the selection instead.
     */
    function describeSelectedEdges(edges, selectedIds, slugOf) {
      const described = []
      for (const edge of edges) {
        const fromIn = selectedIds.has(edge.from.blockId)
        const toIn = selectedIds.has(edge.to.blockId)
        if (!fromIn && !toIn) continue
        const rel = edge.rel === undefined ? '关联' : edge.rel
        const from = slugOf(edge.from.blockId)
        const to = slugOf(edge.to.blockId)
        if (fromIn && toIn) described.push(`${from} -[${rel}]-> ${to}`)
        else if (fromIn) described.push(`${from} -[${rel}]-> ${to}（目标在选区外）`)
        else described.push(`${from}（源在选区外）-[${rel}]-> ${to}`)
      }
      return described
    }

    // -----------------------------------------------------------------------
    // Markdown
    // -----------------------------------------------------------------------

    /**
     * Split markdown into block-level pieces.
     *
     * A deliberately small subset — headings, fenced code, quotes, lists, paragraphs. That is what
     * an Agent's reply actually consists of, and those five are exactly the line between "reads
     * like a document" and "a wall of text". Inline emphasis is handled separately by
     * {@link parseInline}, because a prose block has no block-level structure of its own.
     *
     * The official markdown renderer lives in the platform seed
     * `@deepseek-ai/dsh-client-ui-primitives`, which `practices.md:35` forbids requiring, and
     * there is no standalone markdown package to copy. So this is hand-written, and it is written
     * to fail inert: anything it does not recognise stays literal text.
     *
     * @param source - the raw markdown.
     * @returns block descriptors, in order.
     */
    function parseMarkdownBlocks(source) {
      const lines = String(source ?? '').replace(/\r\n?/gu, '\n').split('\n')
      const blocks = []
      let index = 0

      /** Whether a line would start a new block, which ends a paragraph. */
      const startsBlock = (line) =>
        /^\s*(```|~~~)/u.test(line) ||
        /^#{1,6}\s+/u.test(line) ||
        /^\s*>/u.test(line) ||
        LIST_ITEM.test(line)

      while (index < lines.length) {
        const line = lines[index]
        if (line.trim() === '') {
          index += 1
          continue
        }

        const fence = /^\s*(```|~~~)\s*([^\s`]*)\s*$/u.exec(line)
        if (fence !== null) {
          const marker = fence[1]
          const body = []
          index += 1
          while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`, 'u').test(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          // An unclosed fence runs to the end rather than swallowing the rest as text.
          if (index < lines.length) index += 1
          blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') })
          continue
        }

        const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
        if (heading !== null) {
          blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
          index += 1
          continue
        }

        if (/^\s*>/u.test(line)) {
          const body = []
          while (index < lines.length && /^\s*>/u.test(lines[index])) {
            body.push(lines[index].replace(/^\s*>\s?/u, ''))
            index += 1
          }
          blocks.push({ type: 'quote', text: body.join('\n') })
          continue
        }

        const item = LIST_ITEM.exec(line)
        if (item !== null) {
          const ordered = /\d/u.test(item[2])
          const items = []
          while (index < lines.length) {
            const next = LIST_ITEM.exec(lines[index])
            // A switch between bullet and number starts a different list rather than mixing.
            if (next === null || /\d/u.test(next[2]) !== ordered) break
            items.push({ depth: Math.min(Math.floor(next[1].length / 2), 3), text: next[3] })
            index += 1
          }
          blocks.push({ type: 'list', ordered, items })
          continue
        }

        // A paragraph consumes until a blank line or the start of another block. The first line
        // always qualifies, so this cannot fail to advance.
        const paragraph = []
        while (index < lines.length && lines[index].trim() !== '' && !startsBlock(lines[index])) {
          paragraph.push(lines[index])
          index += 1
        }
        if (paragraph.length > 0) blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
      }

      return blocks
    }

    /** One list item: indent, marker, text. */
    const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u

    /**
     * Render markdown to React elements.
     *
     * Always elements, never an HTML string — there is no `dangerouslySetInnerHTML` in this file.
     * Board content is written by the Agent, and the Agent's input includes whatever it has been
     * reading, so a card's text is untrusted by the time it renders; building elements means
     * anything the tokenizer does not recognise stays inert.
     *
     * @param props - `{ text, className }`.
     * @returns the rendered element.
     */
    function Markdown({ text, className }) {
      const blocks = parseMarkdownBlocks(text)
      return h(
        'div',
        { className: className === undefined ? 'sb-md' : `sb-md ${className}` },
        blocks.map((block, index) => renderMarkdownBlock(block, `md${index}`)),
      )
    }

    /** Render one block descriptor. */
    function renderMarkdownBlock(block, key) {
      switch (block.type) {
        case 'code':
          return h(
            'pre',
            { className: 'sb-code', key },
            block.lang === '' ? null : h('div', { className: 'sb-codeLang' }, block.lang),
            h('code', null, block.text),
          )
        case 'heading': {
          const level = Math.min(Math.max(block.level, 1), 6)
          return h(`h${level}`, { className: `sb-mdH sb-mdH${level}`, key }, renderInline(parseInline(block.text), key))
        }
        case 'quote':
          return h(
            'blockquote',
            { className: 'sb-mdQuote', key },
            h(Markdown, { text: block.text, className: 'sb-mdInner' }),
          )
        case 'list':
          return h(
            block.ordered ? 'ol' : 'ul',
            { className: 'sb-mdList', key },
            block.items.map((item, position) =>
              h(
                'li',
                { key: `${key}-${position}`, style: item.depth > 0 ? { marginLeft: item.depth * 14 } : undefined },
                renderInline(parseInline(item.text), `${key}-${position}`),
              ),
            ),
          )
        default:
          return h('p', { className: 'sb-mdP', key }, renderInline(parseInline(block.text), key))
      }
    }

    // -----------------------------------------------------------------------
    // Reading the conversation
    // -----------------------------------------------------------------------

    /**
     * Extract text from a content-block array.
     *
     * Two shapes reach us and they disagree on the discriminator. A user message's blocks are the
     * raw message content and carry `type` (`{type:'text', text}`); an assistant *view* node's
     * blocks are chat's own published shape and carry `kind` (chat filters them with
     * `block.kind === 'text'` in `assistantText`, `dsh-client-ui-chat/lib/client.js:6523-6525`).
     * Accepting both is what makes one extractor work for the whole transcript.
     *
     * Reasoning and tool-call blocks are simply not text, so they drop out — which is the "dialogue
     * only, no tool noise" the user asked for, with no extra filtering.
     *
     * @param blocks - the block array, of either shape.
     * @returns the concatenated text, trimmed.
     */
    function textFromBlocks(blocks) {
      if (!Array.isArray(blocks)) return ''
      const parts = []
      for (const block of blocks) {
        if (block === null || typeof block !== 'object') continue
        const discriminator = typeof block.kind === 'string' ? block.kind : block.type
        if (discriminator === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join('\n\n').trim()
    }

    /**
     * Turn the chat snapshot's nodes into a dialogue-only list.
     *
     * Reads `useChat`'s node stream, which is the same store the official transcript renders from —
     * so the column and the chat tab cannot disagree about what was said. Chat's own node shape is
     * `{key, kind, id, target, anchorSeq, location, visibility, data}` (`chatNode`,
     * `dsh-client-ui-chat/lib/client.js:7211-7222`); `user` nodes carry `data.content` and
     * `assistant-step` nodes carry `data.blocks`.
     *
     * @param chat - the chat snapshot.
     * @returns `[{ key, role, seq, text }]`, oldest first.
     */
    function dialogueFromChat(chat) {
      const nodes = chat?.nodes?.values?.()
      if (!Array.isArray(nodes)) return []
      const turns = []
      for (const node of nodes) {
        if (node === null || typeof node !== 'object') continue
        // A hidden node exists only to keep a key alive across a cleared stream; chat does not
        // render it, so neither do we.
        if (node.visibility === 'hidden') continue
        if (node.kind !== 'user' && node.kind !== 'assistant-step') continue
        const text = node.kind === 'user' ? textFromBlocks(node.data?.content) : textFromBlocks(node.data?.blocks)
        if (text === '') continue
        turns.push({
          key: String(node.key ?? node.id ?? turns.length),
          role: node.kind === 'user' ? 'user' : 'assistant',
          seq: Number(node.anchorSeq ?? 0),
          text,
        })
      }
      turns.sort((left, right) => left.seq - right.seq)
      return turns
    }

    // -----------------------------------------------------------------------
    // The reading column
    // -----------------------------------------------------------------------

    /** Where the column remembers its width, in px. */
    const COLUMN_WIDTH_KEY = 'dsh.superboard.columnWidth'

    /** Bounds for the dragged width, so the board cannot be squeezed out. */
    const COLUMN_MIN_WIDTH = 260
    const COLUMN_MAX_FRACTION = 0.62

    /** Read a stored number, tolerating a hostile or absent storage. */
    function readNumber(key, fallback) {
      try {
        const raw = globalThis.localStorage?.getItem(key)
        const value = raw === null || raw === undefined ? Number.NaN : Number(raw)
        return Number.isFinite(value) ? value : fallback
      } catch {
        return fallback
      }
    }

    /** Store a number, tolerating a hostile or absent storage. */
    function writeNumber(key, value) {
      try {
        globalThis.localStorage?.setItem(key, String(value))
      } catch {
        /* private mode or no storage at all — the width simply is not remembered */
      }
    }

    /**
     * The conversation, beside the board.
     *
     * Only the active `conversation.view` renders, so while the board is open the transcript is
     * nowhere on screen. This column is the answer: it reads the same chat store the official
     * transcript does, filters to dialogue, and pages further back through the session service —
     * the pattern `dsh-client-ui-trajectory` establishes for a third-party view (it registers its
     * own `conversation.view` and supplies `loadOlder` in the slot's `inject`).
     *
     * It is read-only on purpose. The composer is right below it and is the place to type.
     */
    function ReadingColumn({ sessionId, useChat, loadOlder, hasOlder, width, onResize }) {
      const chat = typeof useChat === 'function' ? useChat((snapshot) => snapshot.nodes) : undefined
      const [loading, setLoading] = React.useState(false)
      // Bumped after a page loads so `hasOlder()` is re-read; the session keeps it as a plain
      // field, so there is nothing to subscribe to.
      const [generation, setGeneration] = React.useState(0)
      const scrollRef = React.useRef(null)
      const pinnedRef = React.useRef(true)

      const turns = React.useMemo(() => dialogueFromChat(chat === undefined ? undefined : { nodes: chat }), [chat])
      void generation
      void sessionId

      const canLoadOlder = typeof hasOlder === 'function' ? hasOlder() : false

      // Keep the view pinned to the newest turn unless the user has scrolled up to read.
      React.useEffect(() => {
        const element = scrollRef.current
        if (element === null || !pinnedRef.current) return
        element.scrollTop = element.scrollHeight
      }, [turns.length])

      const requestOlder = React.useCallback(async () => {
        if (typeof loadOlder !== 'function' || loading) return
        setLoading(true)
        try {
          await loadOlder()
          setGeneration((value) => value + 1)
        } finally {
          setLoading(false)
        }
      }, [loadOlder, loading])

      const onScroll = (event) => {
        const element = event.currentTarget
        pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
        // Reading upward is the natural way to ask for more, so reaching the top loads a page.
        if (element.scrollTop < 24 && canLoadOlder && !loading) void requestOlder()
      }

      return h(
        'aside',
        {
          className: 'sb-reader',
          'data-superboard-reader': '',
          'aria-label': '对话记录',
          style: width === undefined ? undefined : { width: `${width}px` },
        },
        h(Splitter, { onResize }),
        h(
          'div',
          { className: 'sb-readerHead' },
          h('span', { className: 'sb-readerTitle' }, '对话'),
          h('span', { className: 'sb-spacer' }),
          h('span', { className: 'sb-rev' }, `${turns.length} 条`),
        ),
        h(
          'div',
          { className: 'sb-readerBody', ref: scrollRef, onScroll },
          canLoadOlder &&
            h(
              'button',
              {
                type: 'button',
                className: 'sb-button sb-readerMore',
                onClick: () => void requestOlder(),
                disabled: loading,
              },
              loading ? '加载中…' : '加载更早的对话',
            ),
          turns.length === 0
            ? h('div', { className: 'sb-hint' }, '这段对话还没有消息。')
            : turns.map((turn) =>
                h(
                  'article',
                  { className: `sb-turn sb-turn-${turn.role}`, key: turn.key },
                  h('div', { className: 'sb-turnRole' }, turn.role === 'user' ? '你' : 'Agent'),
                  h(Markdown, { text: turn.text, className: 'sb-turnBody' }),
                ),
              ),
        ),
      )
    }

    /** The drag handle between the board and the column. */
    function Splitter({ onResize }) {
      const [dragging, setDragging] = React.useState(false)

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setDragging(true)
      }

      const onPointerMove = (event) => {
        if (!dragging) return
        const container = event.currentTarget.parentElement?.parentElement
        const total = container === null || container === undefined ? 0 : container.clientWidth
        // The column grows as the pointer moves left, so the delta is inverted.
        const next = total - (event.clientX - (container?.getBoundingClientRect().left ?? 0))
        onResize(next)
      }

      const stop = (event) => {
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        setDragging(false)
      }

      return h('div', {
        className: `sb-splitter${dragging ? ' sb-splitterOn' : ''}`,
        role: 'separator',
        'aria-orientation': 'vertical',
        onPointerDown,
        onPointerMove,
        onPointerUp: stop,
        onPointerCancel: stop,
        onDoubleClick: () => onResize(420),
      })
    }
    // -----------------------------------------------------------------------
    // The view
    // -----------------------------------------------------------------------

    /**
     * The board view, mounted inside the conversation page while its tab is active.
     *
     * `useProjection` is injected by the session slot kit and reads a projection's wire value —
     * the same mechanism the shipped goal indicator uses (`dsh-client-ui-goal/lib/client.js`,
     * `GoalDock`). It is always defined and returns `undefined` while the key carries no value,
     * so this renders a waiting state rather than crashing before the host half loads.
     */
    function BoardView({
      sessionId,
      useProjection,
      useChat,
      useInput,
      inputActions,
      attachFeedback,
      loadOlder,
      hasOlder,
    }) {
      const board = useProjection('board')
      // Persisted so the column the user chose survives a tab switch and a reload.
      const [columnWidth, setColumnWidth] = React.useState(() => readNumber(COLUMN_WIDTH_KEY, 420))
      const containerRef = React.useRef(null)
      const [pageId, setPageId] = React.useState(null)
      const [width, setWidth] = React.useState(1200)

      /** Marquee rectangle in canvas content coordinates, or null when not dragging. */
      const [marquee, setMarquee] = React.useState(null)
      const dragRef = React.useRef(null)
      /** Block ids currently selected, on the active page. */
      const [selected, setSelected] = React.useState(() => new Set())
      /** The question the user is writing about the current selection. */
      const [note, setNote] = React.useState('')
      /** Set while a selection is being handed to the composer. */
      const [sending, setSending] = React.useState(false)
      const [sendError, setSendError] = React.useState(null)
      // Read at the top because hooks cannot live inside the handler. Appending rather than
      // replacing matters: the user may already have been typing when they marqueed.
      const draft = typeof useInput === 'function' ? useInput((snapshot) => snapshot.draft) : undefined

      const model = board?.model
      const pages = model?.pages ?? []
      const activePage = pages.find((page) => page.id === pageId) ?? pages[0]

      // Track the canvas width so the `columns` template can degrade on a narrow pane.
      React.useEffect(() => {
        const container = containerRef.current
        if (container === null || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(() => setWidth(container.clientWidth))
        observer.observe(container)
        setWidth(container.clientWidth)
        return () => observer.disconnect()
      }, [])

      // If the selected page disappears (the Agent deleted it), fall back rather than render
      // nothing — the view holds no authority over what exists.
      React.useEffect(() => {
        if (pageId !== null && !pages.some((page) => page.id === pageId)) setPageId(null)
      }, [pageId, pages])

      // A selection means "these blocks on this page", so switching pages clears it.
      React.useEffect(() => {
        setSelected(new Set())
        setMarquee(null)
      }, [pageId])

      const pageBlocks = activePage?.blocks ?? []
      const blockIds = new Set(pageBlocks.map((block) => block.id))
      const pageEdges = (model?.edges ?? []).filter(
        (edge) => blockIds.has(edge.from.blockId) && blockIds.has(edge.to.blockId),
      )
      const slugOf = (id) => pageBlocks.find((block) => block.id === id)?.slug ?? id

      /**
       * Resolve a block address across the whole board, not just the visible page.
       *
       * A selection can include an edge whose other endpoint lives on another page, and printing
       * `bl_9c02e1` instead of that block's name would make the feedback harder to act on than the
       * board it came from.
       */
      /** Block id to block, for resolving a container's children without rescanning. */
      const byId = new Map(pageBlocks.map((block) => [block.id, block]))
      /** Region id to region, for toning a block without a lookup per block. */
      const regions = new Map((model?.regions ?? []).map((region) => [region.id, region]))

      const boardSlugOf = (id) => {
        for (const page of pages) {
          const block = page.blocks.find((candidate) => candidate.id === id)
          if (block !== undefined) return block.slug
        }
        return id
      }

      /**
       * Where a pointer event sits in the canvas's content coordinates.
       *
       * The scroll offset is added back so a selection stays anchored to the blocks even if the
       * canvas scrolls mid-drag.
       */
      const canvasPoint = (event) => {
        const container = containerRef.current
        if (container === null) return { x: 0, y: 0 }
        const base = container.getBoundingClientRect()
        return {
          x: event.clientX - base.left + container.scrollLeft,
          y: event.clientY - base.top + container.scrollTop,
        }
      }

      const onPointerDown = (event) => {
        // Only the primary button, and never when the gesture starts on a control.
        if (event.button !== 0) return
        if (event.target.closest('button, input, textarea, a') !== null) return
        const start = canvasPoint(event)
        dragRef.current = { start, pointerId: event.pointerId }
        setMarquee({ ...start, width: 0, height: 0 })
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        setMarquee(normaliseRect(drag.start, canvasPoint(event)))
      }

      const onPointerUp = (event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        dragRef.current = null
        const rect = normaliseRect(drag.start, canvasPoint(event))
        setMarquee(null)

        // A click rather than a drag clears the selection, which is the conventional meaning.
        if (rect.width < 4 && rect.height < 4) {
          setSelected(new Set())
          return
        }

        // Measure the blocks from the DOM, the same source the arrows use, so a block is selected
        // exactly when it visually intersects the rectangle.
        const container = containerRef.current
        if (container === null) return
        const base = container.getBoundingClientRect()
        const hits = new Set()
        for (const element of container.querySelectorAll('[data-block-id]')) {
          const box = element.getBoundingClientRect()
          const content = {
            left: box.left - base.left + container.scrollLeft,
            top: box.top - base.top + container.scrollTop,
            width: box.width,
            height: box.height,
          }
          if (rectsIntersect(rect, content)) hits.add(element.getAttribute('data-block-id'))
        }
        setSelected(hits)
      }

      /** The text of one block, so the Agent need not re-read the board to act on a selection. */
      const blockTextOf = (slug) => {
        for (const page of pages) {
          for (const block of page.blocks) {
            if (block.slug !== slug) continue
            if (block.kind === 'heading') return block.text
            if (block.kind === 'prose') return block.markdown
            if (block.kind === 'code') return block.code
            if (block.kind === 'list') return block.items.map((item) => item.text).join('\n')
            if (block.kind === 'uml') return block.source
            return ''
          }
        }
        return ''
      }

      /**
       * Hand the selection to the composer as an attachment.
       *
       * Two things travel, because each covers what the other cannot. The draft gets a compact
       * readable summary, so the Agent knows what was selected the moment it reads the message
       * rather than after opening a file. The attachment gets the structured payload — stable ids
       * and each block's full text — since JSON is the only non-image attachment the platform can
       * express (the online content type is text / image / file, with no text-attachment form).
       *
       * Nothing is submitted here. The user presses send, the same gesture as for every other
       * message, which is what keeps a stray marquee from spending a turn.
       */
      const stageFeedback = async () => {
        if (selected.size === 0 || sending) return
        const blocks = [...selected].map((id) => {
          const slug = boardSlugOf(id)
          return { id, slug, text: blockTextOf(slug) }
        })
        const edges = describeSelectedEdges(model?.edges ?? [], selected, boardSlugOf)
        const payload = {
          kind: 'board-selection',
          page: activePage?.slug ?? '',
          rev: model?.rev ?? '',
          blocks,
          edges,
        }
        // The same shape the clipboard copy used, so what the Agent reads inline and what it would
        // have received as text cannot drift apart.
        const summary = formatFeedback({
          pageSlug: activePage?.slug ?? '',
          rev: model?.rev ?? '',
          blocks: blocks.map((block) => block.slug),
          edges,
          note,
        })

        setSending(true)
        setSendError(null)
        try {
          const ids = await attachFeedback({ payload })
          inputActions?.addAttachments?.(ids)
          if (inputActions?.setDraft !== undefined) {
            const existing = typeof draft === 'string' ? draft : ''
            inputActions.setDraft(
              existing.trim() === '' ? summary : `${existing.replace(/\s+$/u, '')}\n\n${summary}`,
            )
          }
          setNote('')
          setSelected(new Set())
        } catch (error) {
          setSendError(error instanceof Error ? error.message : String(error))
        } finally {
          setSending(false)
        }
      }

      if (model === undefined) {
        return h(
          'div',
          { className: 'sb-root', 'data-superboard': '' },
          h(BoardStyles),
          h(
            'div',
            { className: 'sb-empty' },
            sessionId === undefined
              ? 'The board needs a session.'
              : 'No board yet. Ask the agent to write one, or it will appear as soon as it does.',
          ),
        )
      }

      const hasBlocks = pages.some((page) => page.blocks.length > 0)

      return h(
        'div',
        { className: 'sb-root', 'data-superboard': '' },
        h(BoardStyles),
        // The board and the strip share the tab. They have to: only the active `conversation.view`
        // renders, so while the board is open the transcript is not on screen anywhere else, and a
        // right-pane tab cannot host the main conversation (S14).
        h(
          'div',
          { className: 'sb-main' },
          h(
            'div',
            { className: 'sb-column' },
            h(
              'header',
              { className: 'sb-head' },
              h('span', { className: 'sb-title' }, model.title ?? 'Board'),
              h('span', { className: 'sb-rev' }, model.rev),
              h('span', { className: 'sb-spacer' }),
              h(
                'span',
                { className: 'sb-rev' },
                `${pages.reduce((sum, page) => sum + page.blocks.length, 0)} block(s) · ${(model.edges ?? []).length} edge(s)`,
              ),
            ),
            pages.length > 1 &&
              h(
                'nav',
                { className: 'sb-pages', role: 'tablist' },
                pages.map((page) =>
                  h(
                    'button',
                    {
                      key: page.id,
                      type: 'button',
                      role: 'tab',
                      'aria-selected': page.id === (activePage?.id ?? ''),
                      className: `sb-page${page.id === (activePage?.id ?? '') ? ' sb-pageOn' : ''}`,
                      onClick: () => setPageId(page.id),
                    },
                    page.slug,
                    h('span', { className: 'sb-pageCount' }, String(page.blocks.length)),
                  ),
                ),
              ),
            h(
              'div',
              {
                className: `sb-canvas${marquee === null ? '' : ' sb-picking'}`,
                ref: containerRef,
                'data-superboard-canvas': '',
                onPointerDown,
                onPointerMove,
                onPointerUp,
                onPointerCancel: onPointerUp,
              },
              pageBlocks.length === 0
                ? h('div', { className: 'sb-empty' }, hasBlocks ? 'This page is empty.' : 'The board is empty.')
                : h(BlockTree, {
                    blocks: pageBlocks,
                    layout: activePage?.layout,
                    width,
                    selected,
                    byId,
                    regions,
                  }),
              pageEdges.length > 0 && h(EdgeLayer, { containerRef, blocks: pageBlocks, edges: pageEdges }),
              marquee !== null &&
                h('div', {
                  className: 'sb-marquee',
                  style: { left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height },
                }),
            ),
            h(SelectionBar, {
              count: selected.size,
              slugs: [...selected].map(slugOf),
              note,
              setNote,
              sending,
              error: sendError,
              onSend: () => void stageFeedback(),
              onCancel: () => {
                setSelected(new Set())
                setNote('')
                setSendError(null)
              },
            }),
          ),
          h(ReadingColumn, {
            sessionId,
            useChat,
            loadOlder,
            hasOlder,
            width: columnWidth,
            onResize: resizeColumn,
          }),
        ),
      )
    }

    /** One block, with its selection state. */
    function Block({ block, selected, region }) {
      // A region is annotation, so it tints the block and adds its label — it never moves anything.
      const tone = region?.tone === undefined || region.tone === 'neutral' ? '' : ` sb-tone-${region.tone}`
      return h(
        'article',
        {
          className: `sb-card${selected ? ' sb-cardSel' : ''}${tone}`,
          'data-block-id': block.id,
          'data-block-slug': block.slug,
        },
        h(
          'div',
          { className: 'sb-cardHead' },
          h('span', { className: 'sb-slug' }, block.slug),
          h('span', { className: 'sb-kind' }, block.kind),
          region?.label !== undefined && h('span', { className: `sb-regionTag${tone}` }, region.label),
        ),
        renderBlockBody(block),
      )
    }

    /**
     * Render one level of the layout tree.
     *
     * A container is a `group`, and groups nest — so this recurses. A group that carries a layout
     * arranges its own children; a page arranges whatever no group claimed. Nothing else decides
     * geometry, which is what makes "the Agent declares structure, the engine decides where things
     * go" true rather than aspirational.
     *
     * @param props - `{ blocks, layout, width, selected, byId, regions }`.
     * @returns the rendered level.
     */
    function BlockTree({ blocks, layout, width, selected, byId, regions }) {
      const roots = rootBlocksOf(blocks)
      // Any absolutely positioned child needs a positioned ancestor, or `at` would be measured
      // against the page instead of against the container it was written for.
      const needsAnchor = roots.some((block) => block.at !== undefined)
      return h(
        'div',
        {
          className: `${layoutClass(layout)}${needsAnchor ? ' sb-anchored' : ''}`,
          style: layoutStyle(layout, width),
        },
        roots.map((block) => h(BlockNode, { key: block.id, block, width, selected, byId, regions })),
      )
    }

    /** One node of the tree: a container, or a leaf block. */
    function BlockNode({ block, width, selected, byId, regions }) {
      const at = atStyle(block.at)
      const region = block.regionId === undefined ? undefined : regions.get(block.regionId)

      if (block.kind !== 'group') return h(Block, { block, selected: selected.has(block.id), region })

      const children = (block.children ?? []).map((id) => byId.get(id)).filter((child) => child !== undefined)
      const innerNeedsAnchor = children.some((child) => child.at !== undefined)
      return h(
        'section',
        {
          className: `sb-groupBox ${layoutClass(block.layout)}${innerNeedsAnchor ? ' sb-anchored' : ''}${at === undefined ? '' : ' sb-pinned'}`,
          style: { ...layoutStyle(block.layout, width), ...(at ?? {}) },
          'data-block-id': block.id,
          'data-block-slug': block.slug,
          'data-superboard-group': '',
        },
        h(
          'div',
          { className: 'sb-groupHead' },
          h('span', { className: 'sb-slug' }, block.slug),
          block.title !== undefined && h('span', { className: 'sb-groupTitle' }, block.title),
          h('span', { className: 'sb-kind' }, `${children.length} 项`),
          region?.label !== undefined && h('span', { className: `sb-regionTag sb-tone-${region.tone ?? 'neutral'}` }, region.label),
        ),
        // A group with no layout of its own still needs to arrange its children somehow.
        h(
          'div',
          {
            className: `sb-groupBody ${layoutClass(block.layout)}${innerNeedsAnchor ? ' sb-anchored' : ''}`,
            style: layoutStyle(block.layout, width),
          },
          children.map((child) => h(BlockNode, { key: child.id, block: child, width, selected, byId, regions })),
        ),
      )
    }

    /**
     * The bar that appears once something is selected.
     *
     * It shows nothing at all when nothing is selected — the previous always-on instruction was
     * noise on every visit, and the gesture it described is discovered in one try. Marquee, type,
     * attach: the selection becomes an attachment in the composer, where the user can see it, edit
     * the note beside it, and remove it with a control they already recognise.
     */
    function SelectionBar({ count, slugs, note, setNote, sending, error, onSend, onCancel }) {
      if (count === 0) return null

      return h(
        'div',
        { className: 'sb-selbar', 'data-superboard-selection': '' },
        h(
          'span',
          { className: 'sb-selbarCount' },
          `已选 ${count} 个块`,
          h('span', { className: 'sb-selbarSlugs' }, slugs.join('、')),
        ),
        h('input', {
          className: 'sb-input',
          value: note,
          placeholder: '对这个选区提问或说明（可留空）',
          disabled: sending,
          onChange: (event) => setNote(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              onSend()
            }
            if (event.key === 'Escape') onCancel()
          },
        }),
        h(
          'button',
          { className: 'sb-button sb-buttonPrimary', type: 'button', onClick: onSend, disabled: sending },
          sending ? '附加中…' : '附加到输入框',
        ),
        h('button', { className: 'sb-button', type: 'button', onClick: onCancel, disabled: sending }, '取消'),
        error !== null && error !== undefined && h('span', { className: 'sb-selbarError' }, `附加失败：${error}`),
      )
    }

    /** The projection key the host half registers. */
    const PROJECTION_KEY = 'board'

    /** The address the board occupies in the conversation's view strip. */
    const VIEW_ID = 'board'

    return {
      // 'sessions' is what makes history paging possible: the real loader is
      // ctx.sessions.binding(id).session.loadOlder(), not anything the chat package owns.
      // 'conversation' mints the attachment; 'sessions' drives history paging.
      inject: ['slots', 'sessions', 'conversation'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                {
                  name: 'conversation.view',
                  id: VIEW_ID,
                  order: 20,
                  label: () => '看板',
                  // The shape dsh-client-ui-trajectory uses for its own view: resolve the session
                  // binding here, expose a plain loader, and let the component stay presentational.
                  inject: (sessionId) => {
                    const session = ctx.sessions?.binding?.(sessionId)?.session
                    return {
                      loadOlder: async () => {
                        if (session === undefined) return
                        await session.loadOlder()
                      },
                      // Not a store: the session keeps paging state as plain fields, so this is
                      // re-read after each load rather than subscribed to.
                      hasOlder: () => session?.hasMore === true,
                      // The research's recommendation: an attachment is pure public API, touches
                      // no official slot, and yields the official card with its delete button.
                      attachFeedback: async ({ payload }) => {
                        const conversation = ctx.get('conversation')
                        if (conversation === undefined) throw new Error('conversation service unavailable')
                        const file = new File([JSON.stringify(payload, null, 2)], `board-selection-${Date.now()}.json`, {
                          type: 'application/json',
                        })
                        // createDrafts returns draft *descriptors*, not ids — the official call site
                        // maps .id before handing them on (conversation:18389-18390). Passing the
                        // descriptors through would add nothing and report no error: addAttachments
                        // does no validation, and a bad id is pruned silently.
                        const drafts = conversation.createDrafts(sessionId, [file])
                        const ids = drafts.map((draft) => draft.id)
                        if (ids.length === 0) throw new Error("attachment rejected")
                        return ids
                      },
                    }
                  },
                },
                BoardView,
              ),
            ),
          'dsh-superboard: board tab',
        )
      },
      // Exposed for tests and for anyone inspecting the page. The browser ignores extra keys.
      PROJECTION_KEY,
      // Pure geometry and template selection: testable without a DOM, which matters because a
      // wrong bezier still renders — it just points somewhere unhelpful, silently.
      routeBetween,
      layoutClass,
      layoutStyle,
      // The tree, the escape hatch and the tree flattening. DOM-free, so the rules that decide
      // *what sits at the top level* and *where a pinned block lands* are both checked.
      rootBlocksOf,
      atStyle,
      BlockTree,
      // Selection geometry and the feedback payload. Also DOM-free, so the parts that decide
      // *which* blocks a marquee means and *what text* the Agent receives are both checked.
      normaliseRect,
      rectsIntersect,
      describeSelectedEdges,
      formatFeedback,
      // Markdown and transcript extraction. DOM-free, so the two pieces most likely to be subtly
      // wrong — what counts as a block, and what counts as dialogue — are both checked by tests.
      parseMarkdownBlocks,
      parseInline,
      safeHref,
      textFromBlocks,
      dialogueFromChat,
      readNumber,
      writeNumber,
      // Inline markdown. The tokenizer and the link guard are the security-relevant halves, so they
      // are checked without a DOM: board content is written by the Agent, which makes it untrusted
      // by the time it renders.
      parseInline,
      safeHref,
    }
  },
})
