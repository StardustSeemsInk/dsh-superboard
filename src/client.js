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
      '.sb-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;min-width:0;position:relative;}',
      '.sb-cardSel{border-color:var(--dsw-alias-brand-primary);}',
      '.sb-kind{position:absolute;top:6px;right:8px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;letter-spacing:.04em;text-transform:uppercase;}',
      '.sb-slug{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;margin-bottom:4px;}',
      '.sb-h1{margin:0;font-size:18px;font-weight:600;line-height:26px;}',
      '.sb-h2{margin:0;font-size:15px;font-weight:600;line-height:22px;}',
      '.sb-h3{margin:0;font-size:13px;font-weight:600;line-height:20px;}',
      '.sb-p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;}',
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
      '.sb-tray{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px;}',
      '.sb-trayHead{display:flex;align-items:center;gap:8px;}',
      '.sb-trayTitle{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em;}',
      '.sb-chip{display:flex;align-items:flex-start;gap:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;}',
      '.sb-chipBody{flex:1;min-width:0;}',
      '.sb-chipRefs{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}',
      '.sb-chipNote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;}',
      '.sb-button{font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:3px 8px;}',
      '.sb-button:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
      '.sb-button:disabled{opacity:.5;cursor:default;}',
      '.sb-input{font:inherit;font-size:12px;line-height:18px;flex:1;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:4px 8px;}',
      '.sb-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}',
    ].join('')

    /** Render the stylesheet as a component so unmounting removes it. */
    function BoardStyles() {
      return h('style', null, BOARD_CSS)
    }

    // -----------------------------------------------------------------------
    // Layout templates
    // -----------------------------------------------------------------------

    /**
     * Map a layout template to the class that arranges blocks.
     *
     * This is the whole of "the engine decides geometry" for v1: the Agent names a template, CSS
     * lays the blocks out, and the arrows follow by measurement. `canvas` deliberately falls
     * through to the flow default — freeform placement is the exception (Q-E), and honouring
     * explicit coordinates properly needs the measured-position machinery that lands with it.
     */
    function layoutClass(layout) {
      const template = layout?.template
      if (template === 'grid') return 'sb-grid'
      if (template === 'columns') return 'sb-columns'
      return 'sb-flow'
    }

    /**
     * Inline grid-template-columns for the `columns` template, which needs a count.
     *
     * Degrades to a single column in a narrow pane: the Agent asked for a shape, not for a
     * specific pixel width, so the shape should survive a resize.
     */
    function layoutStyle(layout, width) {
      if (layout?.template !== 'columns') return undefined
      // `??`, not `||`: an explicit 0 is a request, not an absence — and it clamps to 1.
      const requested = Number(layout.params?.cols ?? 2)
      const safe = Number.isFinite(requested) ? requested : 2
      const cols = Math.max(1, Math.min(Math.trunc(safe) || 1, width < 720 ? 1 : 4))
      return { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
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

    /** The kind-specific body of a block. */
    function renderBlockBody(block) {
      switch (block.kind) {
        case 'heading':
          return h(`h${block.level}`, { className: `sb-h${block.level}` }, block.text)
        case 'prose':
          return h('p', { className: 'sb-p' }, block.markdown)
        case 'list':
          return h(
            block.ordered ? 'ol' : 'ul',
            { className: 'sb-list' },
            block.items.map((item) =>
              h('li', { key: item.id, style: item.depth > 0 ? { marginLeft: item.depth * 12 } : undefined }, item.text),
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
            block.caption === undefined ? null : h('p', { className: 'sb-p' }, block.caption),
          )
        case 'pdf-page':
          // Rendering a PDF page needs rasterisation in the host document (an iframe would lose
          // the theme and locale), which is a subsystem of its own. Until then, say what it is.
          return h(
            'div',
            null,
            h('p', { className: 'sb-missing' }, `PDF page ${block.page} of ${block.src} — not rendered yet`),
            block.caption === undefined ? null : h('p', { className: 'sb-p' }, block.caption),
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
            block.title === undefined ? null : h('h3', { className: 'sb-h3' }, block.title),
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
    function BoardView({ sessionId, useProjection }) {
      const board = useProjection('board')
      const containerRef = React.useRef(null)
      const [pageId, setPageId] = React.useState(null)
      const [width, setWidth] = React.useState(1200)

      /** Marquee rectangle in canvas content coordinates, or null when not dragging. */
      const [marquee, setMarquee] = React.useState(null)
      const dragRef = React.useRef(null)
      /** Block ids currently selected, on the active page. */
      const [selected, setSelected] = React.useState(() => new Set())
      /** The staged feedback entries — the tray. */
      const [tray, setTray] = React.useState([])
      const [note, setNote] = React.useState('')
      const [copied, setCopied] = React.useState(false)

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
       * A selection can include an edge whose other endpoint lives on another page, and saying
       * `bl_9c02e1` instead of that block's name would make the feedback harder to act on than the
       * board it came from.
       */
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

      const stageFeedback = () => {
        if (selected.size === 0) return
        const ids = [...selected]
        setTray((current) => [
          ...current,
          {
            id: `fb-${current.length + 1}-${Date.now()}`,
            pageSlug: activePage?.slug ?? '',
            rev: model?.rev ?? '',
            blockIds: ids,
            blocks: ids.map(slugOf),
            edges: describeSelectedEdges(model?.edges ?? [], selected, boardSlugOf),
            note,
          },
        ])
        setNote('')
        setSelected(new Set())
        setCopied(false)
      }

      const copyTray = () => {
        const text = tray.map(formatFeedback).join('\n\n')
        // The client half is a classic script in the real page global, so the async clipboard is
        // available; a failure simply leaves the button as it was.
        const done = () => setCopied(true)
        const fallback = () => {
          try {
            const area = document.createElement('textarea')
            area.value = text
            area.setAttribute('readonly', '')
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            document.body.removeChild(area)
            done()
          } catch {
            /* leave the button enabled; the user can select the text manually */
          }
        }
        const clipboard = globalThis.navigator?.clipboard
        if (clipboard?.writeText === undefined) {
          fallback()
          return
        }
        clipboard.writeText(text).then(done, fallback)
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
            : h(
                'div',
                { className: layoutClass(activePage?.layout), style: layoutStyle(activePage?.layout, width) },
                pageBlocks.map((block) => h(Block, { key: block.id, block, selected: selected.has(block.id) })),
              ),
          pageEdges.length > 0 && h(EdgeLayer, { containerRef, blocks: pageBlocks, edges: pageEdges }),
          marquee !== null &&
            h('div', {
              className: 'sb-marquee',
              style: { left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height },
            }),
        ),
        h(FeedbackTray, {
          tray,
          note,
          setNote,
          selectedCount: selected.size,
          selectedSlugs: [...selected].map(slugOf),
          copied,
          onStage: stageFeedback,
          onCopy: copyTray,
          onClear: () => {
            setTray([])
            setCopied(false)
          },
          onRemove: (id) => {
            setTray((current) => current.filter((entry) => entry.id !== id))
            setCopied(false)
          },
        }),
      )
    }

    /** One block, with its selection state. */
    function Block({ block, selected }) {
      return h(
        'article',
        {
          className: `sb-card${block.kind === 'group' ? ' sb-group' : ''}${selected ? ' sb-cardSel' : ''}`,
          'data-block-id': block.id,
          'data-block-slug': block.slug,
        },
        h('div', { className: 'sb-slug' }, block.slug),
        h('div', { className: 'sb-kind' }, block.kind),
        renderBlockBody(block),
      )
    }

    /**
     * The feedback tray.
     *
     * This is where Q7 landed after the composer draft turned out to be both unreachable and
     * invisible while the board is open: a marquee stages an entry, each entry is individually
     * dismissable, and nothing is sent until the user copies it into the composer themselves.
     */
    function FeedbackTray({
      tray,
      note,
      setNote,
      selectedCount,
      selectedSlugs,
      copied,
      onStage,
      onCopy,
      onClear,
      onRemove,
    }) {
      if (tray.length === 0 && selectedCount === 0) {
        return h(
          'div',
          { className: 'sb-tray' },
          h(
            'div',
            { className: 'sb-hint' },
            '拖拽框选看板上的块，然后写下你的问题 —— 反馈会先留在这里，不会自动发出去。',
          ),
        )
      }

      return h(
        'div',
        { className: 'sb-tray' },
        h(
          'div',
          { className: 'sb-trayHead' },
          h('span', { className: 'sb-trayTitle' }, `反馈草稿 ${tray.length}`),
          h('span', { className: 'sb-spacer' }),
          tray.length > 0 && h('button', { className: 'sb-button', type: 'button', onClick: onClear }, '全部清除'),
          tray.length > 0 &&
            h('button', { className: 'sb-button', type: 'button', onClick: onCopy }, copied ? '已复制 ✓' : '复制到输入框'),
        ),
        tray.map((entry) =>
          h(
            'div',
            { className: 'sb-chip', key: entry.id },
            h(
              'div',
              { className: 'sb-chipBody' },
              h('div', { className: 'sb-chipRefs' }, `${entry.pageSlug} · ${entry.blocks.join('、')}`),
              entry.edges.length > 0 && h('div', { className: 'sb-chipRefs' }, entry.edges.join('；')),
              entry.note.trim() !== '' && h('div', { className: 'sb-chipNote' }, entry.note),
            ),
            h(
              'button',
              {
                className: 'sb-button',
                type: 'button',
                onClick: () => onRemove(entry.id),
                'aria-label': '删除这条反馈',
              },
              '删除',
            ),
          ),
        ),
        selectedCount > 0 &&
          h(
            'div',
            { className: 'sb-trayHead' },
            h('input', {
              className: 'sb-input',
              value: note,
              placeholder: `对选中的 ${selectedCount} 个块（${selectedSlugs.join('、')}）提问或说明`,
              onChange: (event) => setNote(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') onStage()
              },
            }),
            h('button', { className: 'sb-button', type: 'button', onClick: onStage }, '加入反馈'),
          ),
      )
    }

    /** The projection key the host half registers. */
    const PROJECTION_KEY = 'board'

    /** The address the board occupies in the conversation's view strip. */
    const VIEW_ID = 'board'

    return {
      inject: ['slots'],
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
      // Selection geometry and the feedback payload. Also DOM-free, so the parts that decide
      // *which* blocks a marquee means and *what text* the Agent receives are both checked.
      normaliseRect,
      rectsIntersect,
      describeSelectedEdges,
      formatFeedback,
    }
  },
})
