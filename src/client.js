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
    function Block({ block }) {
      return h(
        'article',
        {
          className: `sb-card${block.kind === 'group' ? ' sb-group' : ''}`,
          'data-block-id': block.id,
          'data-block-slug': block.slug,
        },
        h('div', { className: 'sb-slug' }, block.slug),
        h('div', { className: 'sb-kind' }, block.kind),
        renderBlockBody(block),
      )
    }

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
      const pageBlocks = activePage?.blocks ?? []
      const blockIds = new Set(pageBlocks.map((block) => block.id))
      const pageEdges = (model.edges ?? []).filter(
        (edge) => blockIds.has(edge.from.blockId) && blockIds.has(edge.to.blockId),
      )

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
          { className: 'sb-canvas', ref: containerRef, 'data-superboard-canvas': '' },
          pageBlocks.length === 0
            ? h('div', { className: 'sb-empty' }, hasBlocks ? 'This page is empty.' : 'The board is empty.')
            : h(
                'div',
                { className: layoutClass(activePage?.layout, width), style: layoutStyle(activePage?.layout) },
                pageBlocks.map((block) => h(Block, { key: block.id, block })),
              ),
          pageEdges.length > 0 &&
            h(EdgeLayer, { containerRef, blocks: pageBlocks, edges: pageEdges }),
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
    }
  },
})
