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
      // The root carries `data-conversation-composer-overlay`, and that one attribute is what
      // makes this a full-bleed view: the host gives the view area `flex:1 1 0; overflow:hidden`
      // and floats the composer over the bottom instead of sticking it in the flow, and hides the
      // transcript width handles (ConversationRoot.module.css:464-501 and :329). Fixed height +
      // `overflow:hidden` is the other half of the contract — without it the scroll body grows to
      // fit this view and the whole page scrolls, which is exactly the bug this fixes.
      '.sb-root{display:flex;flex:1;flex-direction:column;gap:10px;min-width:0;height:100%;min-height:0;overflow:hidden;box-sizing:border-box;color:var(--dsw-alias-label-primary);}',
      '.sb-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.sb-title{font-size:13px;font-weight:600;line-height:18px;}',
      '.sb-rev{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;}',
      '.sb-spacer{flex:1;}',
      '.sb-pages{display:flex;align-items:center;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l2);}',
      '.sb-page{font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;border-bottom:2px solid transparent;padding:4px 8px;}',
      '.sb-pageOn{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600;}',
      '.sb-pageCount{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:4px;}',
      '.sb-canvas{position:relative;flex:1;min-height:0;overflow:auto;padding:2px;}',
      '.sb-flow{display:flex;flex-direction:column;gap:12px;}',
      '.sb-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));align-items:start;}',
      '.sb-columns{display:grid;gap:12px;align-items:start;}',
      '.sb-row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;}',
      '.sb-row>.sb-card{flex:1 1 220px;min-width:0;}',
      // The waterfall. `columns` is a multi-column container, which is the only way to get
      // column-major filling in this runtime — and column-major filling *is* the definition of a
      // waterfall. `break-inside:avoid` is what keeps a card whole: probed in Edge, a card taller
      // than the balanced column height is moved to a column of its own rather than sliced.
      //
      // Spacing is `margin-bottom` on the cards, not `gap`, because `gap` does not apply to a
      // multi-column container. Declared here rather than inline so the inline style only ever
      // carries the column count and width.
      '.sb-masonry{display:block;}',
      '.sb-masonry>.sb-card,.sb-masonry>.sb-groupBox{break-inside:avoid;margin-bottom:12px;}',
      // The free-placement template. Nothing generic is positioned any more — pixel coordinates
      // belong to things whose nature is spatial, so this reserves a containing block for the
      // arrow layer and for whatever spatial block kind joins it.
      //
      // It declares no arrangement, but it still spaces its children: an `article` is block-level
      // with no margin, so without this its cards stack border-to-border and read as one broken
      // card. "Arranges nothing" was meant as "does not choose geometry", not "does not space".
      '.sb-absBox{position:relative;min-height:120px;}',
      '.sb-absBox>.sb-card,.sb-absBox>.sb-groupBox{margin-bottom:12px;}',
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
      '.sb-mediaBox{display:flex;flex-direction:column;gap:6px;min-width:0;}',
    '.sb-media{display:block;max-width:100%;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}',
    // A rendered page is a canvas the width of its card, and it is the one thing on the board that
    // can be taller than the screen. It gets a frame and a scroll ceiling for the same reason the
    // diagram does.
    '.sb-pdfPage{display:block;max-width:100%;height:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);}',
    '.sb-pdfPending{visibility:hidden;}',
      '.sb-missing{color:var(--dsw-alias-label-tertiary);font-size:12px;font-style:italic;}',
      '.sb-group{border-style:dashed;padding-left:14px;}',
      '.sb-edges{position:absolute;inset:0;pointer-events:none;overflow:visible;}',
      // An edge's label used to live only in an SVG `<title>`, which is hover-only — invisible in a
      // screenshot, in the film, and to anyone who does not happen to rest the pointer on the line.
      // It rides the curve's midpoint instead: the stroke is the board's own text colour at 10px, so
      // a label reads as an annotation on the arrow rather than as content competing with the cards.
      '.sb-edgeLabel{fill:var(--dsw-alias-label-secondary);font-size:10px;font-weight:600;letter-spacing:.02em;}',
      // The label's plate, which is also what keeps it from colliding with the line under it. The
      // card colour rather than the page's: an arrow crosses cards, and a plate that matches what is
      // behind it is the only way the text stays legible on both.
      '.sb-edgeLabelChip{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-border-l2);stroke-width:.8;}',
      // The honest signal that arrows leave this page. Two endpoints, one page: a reader could not
      // otherwise tell "there is no such edge" from "it is drawn on another page".
      '.sb-crossPage{font-size:10px;line-height:14px;padding:0 6px;border-radius:999px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);}',
      '.sb-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:12px 0;}',
      // Marquee: while a rectangle drag is in flight the canvas owns the gesture, so the browser's
      // text selection must be suppressed or the drag would select the board's own prose.
      //
      // This class is applied ONLY to a drag that began somewhere that is not rendered text (see
      // `originAt`). That distinction is the whole feature: the rule used to go on at every
      // pointerdown, which is why not one word on the board could be selected or copied. It also
      // has to be added imperatively, at pointerdown, and never during a drag — putting
      // `user-select:none` on an element whose text is already selected deletes that selection.
      '.sb-picking,.sb-picking *{user-select:none;cursor:crosshair;}',
      // The card's chrome — slug, kind, region tag — is a label, not content. Without this it is
      // included in whatever gets copied, so a three-word selection arrives with the block's slug
      // glued to it. It doubles as marquee area: chrome that cannot be selected is chrome a
      // rectangle drag may start on.
      '.sb-cardHead,.sb-groupHead{user-select:none;}',
      '.sb-marquee{position:absolute;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);opacity:.12;pointer-events:none;border-radius:2px;}',
      '.sb-cardSel{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary);}',
      // A single row, only while something is selected. No idle state at all.
      //
      // The bar is the one thing on this view that is not the board, so it is assembled from the
      // same primitives every other surface in DSH uses, with the geometry copied from them rather
      // than invented: Pill for the chips (Pill.module.css:1-14), Input for the field
      // (Input.module.css:1-38), Button for the actions (Button.module.css:1-77). It used to be
      // bare `button` and `input` elements with no rules at all, so the chrome was the browser's —
      // which is exactly why it read as a form bolted onto the board. Elevation is what separates
      // it from the board underneath; a top border was doing that job badly. The fill is the
      // composer's own surface (`bg-layer-1`), not the popover grey, so the bar sits in the same
      // plane as the composer directly below it.
      '.sb-selbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);}',
      '.sb-selbarCount{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.sb-selbarChips{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;}',
      // The chip fill is the framework's translucent neutral tint, not `bg-layer-2`. In light mode
      // `bg-layer-1` and `bg-layer-2` are *both* pure white, so a Pill-shaped chip on this bar was
      // invisible — the geometry copied from Pill.module.css survived, the fill did not.
      '.sb-chip{display:inline-flex;align-items:center;height:24px;max-width:160px;padding:0 8px;border-radius:999px;corner-shape:round;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.sb-selbarField{display:inline-flex;align-items:center;flex:1 1 220px;min-width:0;height:32px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);}',
      '.sb-selbarField:focus-within{border-color:var(--dsw-alias-state-business-primary);}',
      '.sb-input{flex:1;min-width:0;border:none;outline:none;background:transparent;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);}',
      '.sb-input::placeholder{color:var(--dsw-alias-label-dimmed);}',
      // Shared with the reading column's "加载更早", which had the same problem: an unstyled native
      // button sized by its own text.
      '.sb-button{display:inline-flex;align-items:center;justify-content:center;gap:4px;box-sizing:border-box;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer;white-space:nowrap;}',
      '.sb-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.sb-button:disabled{cursor:not-allowed;opacity:.4;}',
      // Filled with the blue the composer's own send control uses, not with the Button primitive's
      // `primary` fill: that one resolves to `brand-primary`, which is near-black in light and
      // near-white in dark — right for a dialog's confirm, wrong for an action sitting inside a
      // text row, where the interface's one saturated blue is what reads as "this does something".
      // A static hover shade cannot work here because the fill itself flips between themes, so the
      // hover darkens whatever is currently there.
      '.sb-buttonPrimary{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:500;}',
      '.sb-buttonPrimary:hover:not(:disabled){filter:brightness(.92);}',
      '.sb-buttonOutline{border:0.5px solid var(--dsw-alias-border-l3);}',
      '.sb-selbarError{flex:1 0 100%;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);}',
      '.sb-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}',
      // The board and the reading column share the tab. They have to: only the active
      // conversation.view renders, so while the board is open the transcript is nowhere else.
      // The composer floats over this view's bottom edge, so the band it occupies is reserved
      // here rather than letting the selection bar sit underneath it where it cannot be clicked.
      // `--dsh-composer-height` is published by the host's own ResizeObserver
      // (ConversationContent.tsx:53-67); 152px is its resting height.
      '.sb-main{display:flex;align-items:stretch;flex:1;min-height:0;min-width:0;padding-bottom:calc(var(--dsh-composer-height,152px) + 10px);}',
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
      '.sb-mdProse{color:var(--dsw-alias-label-secondary);}',
      '.sb-mdH{margin:2px 0 0;font-weight:600;}',
      '.sb-mdH1{font-size:17px;line-height:24px;}',
      '.sb-mdH2{font-size:15px;line-height:22px;}',
      '.sb-mdH3,.sb-mdH4,.sb-mdH5,.sb-mdH6{font-size:13px;line-height:20px;}',
      '.sb-mdList{margin:0;padding-left:20px;}',
      '.sb-mdList li{margin:1px 0;}',
      // A table wider than the column scrolls sideways rather than squeezing its cells into
      // unreadable columns.
      '.sb-mdTableWrap{max-width:100%;overflow-x:auto;}',
      '.sb-mdTable{border-collapse:collapse;font-size:12px;line-height:18px;}',
      '.sb-mdTable th,.sb-mdTable td{border:1px solid var(--dsw-alias-border-l2);padding:3px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere;}',
      '.sb-mdTable th{background:var(--dsw-alias-bg-layer-2);font-weight:600;white-space:nowrap;}',
      '.sb-mdAlignRight{text-align:right;}',
      '.sb-mdAlignCenter{text-align:center;}',
      '.sb-mdQuote{margin:0;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}',
      '.sb-mdInner{font-size:12px;line-height:19px;}',
      '.sb-mdCode,.sb-code{margin:0;overflow-x:auto;}',
      '.sb-codeLang{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px;}',
      '.sb-inlineCode{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-1);border-radius:4px;padding:0 4px;}',
      '.sb-link{color:var(--dsw-alias-brand-primary);text-decoration:underline;}',
      // A diagram is the one block whose content has its own intrinsic size and cannot be wrapped,
      // so the card scrolls instead of pushing the grid column wider than the page.
      '.sb-diagram{display:flex;justify-content:center;max-height:560px;overflow:auto;}',
      '.sb-diagramImage{max-width:100%;height:auto;object-fit:contain;}',
      '.sb-diagramWait{min-width:0;}',
      '.sb-diagramNote{margin:6px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}',
      '.sb-diagramError{margin:6px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-brand-primary));overflow-wrap:anywhere;}',
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
        case 'masonry':
          return 'sb-masonry'
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
        // `areas` fixes the column count; the host resolves the template into `cols` on the way out,
        // so the named placement and the grid's own width can never disagree. Without it, auto-fill
        // with a minimum card width is responsive by construction — the browser fits as many as the
        // current width allows, so no breakpoint is needed or wanted.
        const fixed = Number(layout.params?.cols)
        const named = layout.params?.cells !== undefined
        if (named) {
          // A named cell is a slot: a card spanning two rows fills them rather than sitting at the
          // top of the first one, which is what `.sb-grid`'s `align-items:start` would do.
          //
          // This is keyed on `cells` rather than on `cols` on purpose. Keying it on `cols` made
          // every `grid` with a column count stretch its cards to the tallest in the row, which is
          // how a one-line card becomes a large empty box — and `cols` reads as a *column count*,
          // so nothing in the tool surface warned that it also changed card height.
          style.gridTemplateColumns = `repeat(${Math.max(1, Math.trunc(fixed) || 1)}, minmax(0, 1fr))`
          style.alignItems = 'stretch'
        } else if (layout.params?.cols !== undefined && Number.isFinite(fixed)) {
          // A fixed count without named cells: still a grid, but cards keep their own height.
          style.gridTemplateColumns = `repeat(${Math.max(1, Math.trunc(fixed) || 1)}, minmax(0, 1fr))`
        } else {
          const requested = Number(layout.params?.minCardWidth ?? 260)
          const safe = Number.isFinite(requested) ? requested : 260
          const min = Math.max(120, Math.min(Math.trunc(safe) || 260, 640))
          style.gridTemplateColumns = `repeat(auto-fill, minmax(${min}px, 1fr))`
        }
      }

      if (layout?.template === 'masonry') {
        // A fixed count, or as many columns as a card's minimum width allows — the same two shapes
        // `grid` has, because an Agent reasons about both the same way.
        const fixed = Number(layout.params?.cols)
        if (layout.params?.cols !== undefined && Number.isFinite(fixed)) {
          const cols = Math.max(1, Math.min(Math.trunc(fixed) || 1, 6))
          style.columnCount = String(cols)
        } else {
          const requested = Number(layout.params?.minCardWidth ?? 260)
          const safe = Number.isFinite(requested) ? requested : 260
          const min = Math.max(120, Math.min(Math.trunc(safe) || 260, 640))
          // `column-width` is a *hint*: the browser fits as many columns of at least this width as
          // the container allows, which is the responsive behaviour `auto-fill` gives a grid.
          style.columnWidth = `${min}px`
        }
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
     * Turn a resolved grid cell into a style.
     *
     * `areas` is resolved on the host, into explicit `grid-row` / `grid-column` line spans. The
     * client never sees the template, only the answer, so a CJK slug needs no escaping and an
     * invalid template cannot reach the browser — where a bad `grid-template-areas` declaration
     * would be dropped in silence and collapse the layout with nothing to report.
     *
     * @param cell - `{row, col, rowSpan, colSpan}`, 1-based, or none.
     * @returns a style object, or undefined when the block flows into the next free cell.
     */
    function cellStyle(cell) {
      if (cell === null || cell === undefined || typeof cell !== 'object') return undefined
      const span = (value) => Math.max(1, Math.trunc(Number(value) || 1))
      return {
        gridRow: `${Math.max(1, Math.trunc(Number(cell.row) || 1))} / span ${span(cell.rowSpan)}`,
        gridColumn: `${Math.max(1, Math.trunc(Number(cell.col) || 1))} / span ${span(cell.colSpan)}`,
      }
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
     * @param base - where this run starts in the *field's* text. Only a `text` anchor reads it: a
     *   character range has to name a position, and the run's own text does not say where in the
     *   paragraph it sits — `**根因**: 说明` parses into three nodes, and node two begins at
     *   character 4 of the source, not at 0.
     * @returns React children.
     */
    function renderInline(nodes, keyPrefix = 'md', base = 0) {
      let at = base
      return nodes.map((node, position) => {
        const key = `${keyPrefix}-${position}`
        const from = at
        at += inlineTextLength(node)
        switch (node.type) {
          case 'strong':
            return h('strong', { key, 'data-superboard-from': from }, renderInline(node.children, key, from))
          case 'em':
            return h('em', { key, 'data-superboard-from': from }, renderInline(node.children, key, from))
          case 'code':
            return h('code', { key, className: 'sb-inlineCode', 'data-superboard-from': from }, node.text)
          case 'link':
            return h(
              'a',
              {
                key,
                className: 'sb-link',
                href: node.href,
                'data-superboard-from': from,
                // Board links leave the application; opening in a new tab keeps the session.
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              node.text,
            )
          default:
            return h('span', { key, 'data-superboard-from': from }, node.text)
        }
      })
    }

    /**
     * How many characters of the source one parsed inline node accounts for.
     *
     * The parser drops the markers, so a node's rendered text is shorter than the run it came from:
     * `**根因**` renders three characters from eight. A `text` anchor indexes the *source*, because
     * that is what `board_read` prints and therefore what an Agent can count, so every run has to be
     * advanced by what it consumed rather than by what it shows.
     *
     * @param node - one node from {@link parseInline}.
     * @returns its length in source characters.
     */
    function inlineTextLength(node) {
      if (node.type === 'strong') return 4 + sourceLengthOf(node.children)
      if (node.type === 'em') return 2 + sourceLengthOf(node.children)
      if (node.type === 'code') return 2 + node.text.length
      if (node.type === 'link') return node.text.length + 4 + node.href.length
      return node.text.length
    }

    /** The source length of a parsed run, which is what its children consumed. */
    function sourceLengthOf(nodes) {
      let total = 0
      for (const node of nodes) total += inlineTextLength(node)
      return total
    }

    /**
     * Render text that may contain inline markdown.
     *
     * @param props - `{ text, base }`, where `base` is the offset of `text` within the field it
     *   belongs to. A list item is the case that needs it: one `list` block holds several items, and
     *   a `text` anchor indexes the field's text, not the item's.
     * @returns a fragment of React children.
     */
    function RichText({ text, base }) {
      return h(React.Fragment, null, renderInline(parseInline(text), 'md', base ?? 0))
    }

    // -----------------------------------------------------------------------
    // Block rendering
    // -----------------------------------------------------------------------

    /**
     * The class a `<code>` element needs in order to be recognised as a language.
     *
     * `language-<lang>` is what every markdown renderer emits (GitHub, remark, marked), so
     * emitting it is just correct markup. It is also the *only* thing a mermaid plugin looks at:
     * `dsh-mermaid` accepts a `<code>` whose classList holds exactly
     * `/^language-(?:mermaid|mermaidjs|mmd)$/i`, and our code blocks carried no class at all —
     * which is why a diagram written as a fenced block rendered as plain source even on an
     * installation with the plugin enabled. Costs nothing, couples to nothing: with no plugin
     * installed the user sees the source, exactly as in the rest of DSH.
     *
     * @param lang - the declared language, possibly empty.
     * @returns the class name, or `undefined` when there is no language.
     */
    function codeClass(lang) {
      return lang === undefined || lang === '' ? undefined : `language-${lang}`
    }

    /**
     * Render one block.
     *
     * Every kind the model can hold is renderable except `uml`, which is data-only in v1 (Q-B):
     * it shows its source so the Agent and the user can at least see what is there, and the
     * error-feedback loop that will replace this arrives with the mermaid chunk.
     */

    // -----------------------------------------------------------------------
    // Diagrams
    // -----------------------------------------------------------------------

    /**
     * Where the host serves the vendored mermaid bundle.
     *
     * A plugin-owned host route rather than a plugin chunk. That is what both mermaid plugins in
     * this profile do, and `dsh-better-sidebar`'s own type declarations say why: the official
     * chunk route resolves a chunk id through the module loader, and "a chunk id is none of those"
     * things that resolver knows about, so resolution would be version-dependent. One file, served
     * with an ETag, loaded through a `<script>` tag — mermaid's browser bundle is an IIFE whose
     * entire published contract is the global it sets.
     */
    const MERMAID_URL = '/dsh-superboard/mermaid.min.js'

    /** Where a failed render goes, so it can reach the Agent even though the Agent cannot see it. */
    const RENDER_REPORT_URL = '/dsh-superboard/render-report'

    /**
     * pdf.js, and the three trees it fetches while rendering.
     *
     * All four are served by this plugin's own host routes out of `vendor/pdf`. The paths are
     * absolute and same-origin, which is what lets pdf.js hand them to a worker and to a `fetch`
     * without any base-URL reasoning.
     */
    const PDF_MODULE_URL = '/dsh-superboard/pdfjs/pdf.min.mjs'
    const PDF_WORKER_URL = '/dsh-superboard/pdfjs/pdf.worker.min.mjs'
    const PDF_CMAP_URL = '/dsh-superboard/pdfjs/assets/cmaps/'
    const PDF_FONT_URL = '/dsh-superboard/pdfjs/assets/standard_fonts/'
    const PDF_WASM_URL = '/dsh-superboard/pdfjs/assets/wasm/'

    /**
     * The widest a page is rasterised at, in CSS pixels.
     *
     * A page is drawn at the density of the screen and the width of the card, so a wide window
     * would otherwise turn one page into a canvas tens of megabytes large. Beyond this the extra
     * pixels buy nothing a reader can see.
     */
    const MAX_PAGE_WIDTH = 1600

    /**
     * The in-flight (or settled) load of the runtime.
     *
     * Shared by every diagram on the page: the bundle is 3.5 MB and is loaded once per document.
     * A rejection clears it, so a transient failure is retried by the next diagram instead of
     * every diagram in the session inheriting it.
     */
    let mermaidLoad

    function loadMermaid() {
      if (mermaidLoad !== undefined) return mermaidLoad
      mermaidLoad = new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = MERMAID_URL
        script.async = true
        script.onload = () => {
          const api = window.mermaid
          if (api === undefined || typeof api.render !== 'function') {
            reject(new Error(`${MERMAID_URL} loaded but exposed no mermaid`))
            return
          }
          resolve(api)
        }
        script.onerror = () => reject(new Error(`could not load ${MERMAID_URL}`))
        document.head.appendChild(script)
      })
      mermaidLoad.catch(() => {
        mermaidLoad = undefined
      })
      return mermaidLoad
    }

    /**
     * The in-flight (or settled) load of pdf.js, shared the way the mermaid bundle is.
     *
     * Loaded with a dynamic `import` rather than a `<script>` tag because it is a real ES module
     * with named exports, and because the module itself is what pulls in the worker it names.
     */
    let pdfjsLoad

    function loadPdfjs() {
      if (pdfjsLoad !== undefined) return pdfjsLoad
      pdfjsLoad = import(PDF_MODULE_URL).then((module) => {
        module.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL
        return module
      })
      pdfjsLoad.catch(() => {
        pdfjsLoad = undefined
      })
      return pdfjsLoad
    }

    /**
     * The open documents, by file path.
     *
     * Three page blocks of one PDF are one fetch and one parse, not three. A rejection is removed
     * again: the Agent may be correcting a path this very moment, and a remembered failure would
     * keep the card broken after the file appeared.
     */
    const pdfDocuments = new Map()

    function openDocument(pdfjs, src) {
      let pending = pdfDocuments.get(src)
      if (pending === undefined) {
        pending = pdfjs
          .getDocument({
            url: fileUrl(src),
            cMapUrl: PDF_CMAP_URL,
            cMapPacked: true,
            standardFontDataUrl: PDF_FONT_URL,
            wasmUrl: PDF_WASM_URL,
          })
          .promise
        pending.catch(() => pdfDocuments.delete(src))
        pdfDocuments.set(src, pending)
      }
      return pending
    }

    /** Whether the shell is in its dark theme. The shell marks it on `<body>`, not on a class. */
    function isDarkTheme() {
      if (typeof document === 'undefined' || document.body === null || document.body === undefined) return false
      return document.body.hasAttribute('data-ds-dark-theme')
    }

    // -----------------------------------------------------------------------
    // Diagram theming
    // -----------------------------------------------------------------------

    /** Clamp a CSS colour channel to the integer mermaid's parser is happiest with. */
    function channel(value) {
      const n = Math.round(Number(value))
      if (!Number.isFinite(n)) return undefined
      return String(Math.max(0, Math.min(255, n)))
    }

    /**
     * Reduce a computed CSS colour to a form mermaid accepts.
     *
     * Two measured facts make this necessary, and both were probed in a real browser rather than
     * assumed:
     *
     * 1. **`color-mix()` resolves to `color(srgb …)`, and mermaid rejects it.** Reading a mixed
     *    token through a throwaway element yields `color(srgb 0.635294 0.466667 1 / 0.4)`, and
     *    mermaid throws `Unsupported color format` on that string — the whole diagram fails to
     *    draw. `color-mix` is not exotic: the shell's own light/dark sheets use it for
     *    document-selection, deep-diving, tooltip-key and shimmer tokens. So the conversion is not
     *    defensive padding; it is what makes a mixed token usable at all.
     * 2. **Computed channels are fractional.** `color: #a277ff` computes to
     *    `rgb(162, 119, 255)` but the derived `cluster-label` text computed to
     *    `rgb(191.1413043478, 183.4782608695, 209.0217391304)`. Rounding keeps every value inside
     *    the integer form mermaid is known to parse.
     *
     * @param value - a computed CSS colour.
     * @returns a mermaid-safe colour, or `undefined` when the value is unusable.
     */
    function normaliseColour(value) {
      if (typeof value !== 'string') return undefined
      const text = value.trim()
      if (text === '') return undefined
      if (text === 'transparent') return 'transparent'

      const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/i.exec(text)
      if (srgb !== null) {
        const r = channel(Number(srgb[1]) * 255)
        const g = channel(Number(srgb[2]) * 255)
        const b = channel(Number(srgb[3]) * 255)
        if (r === undefined || g === undefined || b === undefined) return undefined
        const a = srgb[4] === undefined ? '1' : String(Number(srgb[4]))
        return `rgba(${r}, ${g}, ${b}, ${a})`
      }

      const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(text)
      if (rgb !== null) {
        const r = channel(rgb[1])
        const g = channel(rgb[2])
        const b = channel(rgb[3])
        if (r === undefined || g === undefined || b === undefined) return undefined
        const a = rgb[4] === undefined ? '1' : String(Number(rgb[4]))
        return `rgba(${r}, ${g}, ${b}, ${a})`
      }

      // Hex and `hsl()` pass through: mermaid parses both, and they need no rounding.
      if (/^#[0-9a-f]{3,8}$/i.test(text)) return text
      if (/^hsla?\(/i.test(text)) return text
      return undefined
    }

    /**
     * Resolve one CSS custom property to the colour the browser actually paints.
     *
     * `getComputedStyle(body).getPropertyValue('--x')` cannot be used directly: a token defined as
     * `var(--other)` comes back as that literal text (a chain), not a colour. Assigning it to a
     * throwaway element's `color` and reading *that* back makes the browser do the substitution,
     * including `color-mix()`. Probed: `--chain` → `var(--plain)` reads through as
     * `rgb(21, 20, 27)`, and an **absent** variable resolves to `rgb(0, 0, 0)` — indistinguishable
     * from a real black — which is exactly why presence is tested first and separately.
     */
    function readTokenColour(name) {
      if (typeof document === 'undefined' || document.body === null || document.body === undefined) return undefined
      if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return undefined
      const declared = window.getComputedStyle(document.body).getPropertyValue(name)
      if (declared === null || declared === undefined || declared.trim() === '') return undefined
      const probe = document.createElement('span')
      probe.style.display = 'none'
      try {
        document.body.appendChild(probe)
        probe.style.color = `var(${name})`
        return normaliseColour(window.getComputedStyle(probe).color)
      } catch {
        return undefined
      } finally {
        probe.remove()
      }
    }

    /**
     * The board's own surfaces, in the order each mermaid variable should try them.
     *
     * Every entry is a DSH alias token rather than a literal, which is the whole point: a theme
     * plugin registers its palette by overriding exactly these names — `@nonamelego/dsh-catppuccin`,
     * for one, remaps 101 `--dsw-alias-*` tokens through the official `theme.register()` API — so a
     * diagram built from them follows whatever the user picked without this file knowing that
     * plugin exists.
     */
    const DIAGRAM_TOKEN_SOURCES = Object.freeze({
      surface: ['--dsw-alias-bg-layer-2', '--dsw-alias-bg-base'],
      raised: ['--dsw-alias-bg-module-platform', '--dsw-alias-bg-layer-3'],
      overlay: ['--dsw-alias-bg-overlay', '--dsw-alias-bg-layer-3'],
      accent: ['--dsw-alias-state-business-primary', '--dsw-alias-brand-primary'],
      accentTint: ['--dsw-alias-state-business-tertiary'],
      text: ['--dsw-alias-label-primary'],
      textMuted: ['--dsw-alias-label-secondary', '--dsw-alias-label-tertiary'],
      textFaint: ['--dsw-alias-label-tertiary', '--dsw-alias-label-caption'],
      border: ['--dsw-alias-border-l2'],
      borderStrong: ['--dsw-alias-border-l3', '--dsw-alias-border-l4'],
      // The two ends of the palette's neutral ramp. Used as *candidates* for a label that has to sit
      // on top of a category colour, never as a surface: a theme defines these as its darkest and
      // lightest ink, so preferring them keeps a label on-brand when that already suffices.
      extremeDark: ['--dsw-static-neutral-bluish-1000', '--dsw-static-neutral-1000'],
      extremeLight: ['--dsw-static-neutral-bluish-00', '--dsw-static-neutral-00'],
    })

    /**
     * A categorical palette, borrowed from the syntax-highlighting tokens.
     *
     * That is not a shortcut: shiki's token colours are the one set a theme is *expected* to
     * define with distinct hues (`--shiki-token-*` are declared by the shell for light and dark,
     * and a theme plugin re-maps them to its own palette — catppuccin supplies 11 of them). So pie
     * slices and git commits come out in the user's own colours with no plugin-specific knowledge
     * here.
     *
     * Duplicates are dropped rather than kept. Measured on catppuccin mocha, these eight names
     * collapse to **six** distinct values — `--shiki-token-string` equals
     * `--shiki-token-string-expression`, and `--shiki-token-function` equals `--shiki-token-link`.
     * Keeping them would give two pie slices the same colour, which is worse than a shorter
     * palette: the reader cannot tell the slices apart at all.
     */
    const DIAGRAM_CATEGORICAL = Object.freeze([
      '--shiki-token-constant',
      '--shiki-token-string',
      '--shiki-token-keyword',
      '--shiki-token-function',
      '--shiki-token-parameter',
      '--shiki-token-link',
      '--shiki-token-string-expression',
      '--shiki-token-comment',
      '--shiki-token-punctuation',
    ])

    /**
     * Fallbacks for the categorical palette, from the static hue ramp.
     *
     * A theme that declines to define `--shiki-token-*` at all would otherwise leave every pie
     * slice and git branch one colour. These come from `--dsw-static-*`, the fixed hue ramp the
     * shell always defines and which catppuccin *does* remap (77 entries), so they follow the theme
     * as well as anything can when the theme offers no explicit categorical set. The ramp has only
     * four chromatic families (amber/blue/green/red), which is still four distinguishable hues.
     */
    const DIAGRAM_CATEGORICAL_FALLBACK = Object.freeze([
      '--dsw-static-blue-500',
      '--dsw-static-green-500',
      '--dsw-static-amber-500',
      '--dsw-static-red-500',
      '--dsw-static-deepseek-500',
    ])

    /** Read the first token of a group that resolves, so a missing one degrades instead of failing. */
    function firstColour(read, names) {
      for (const name of names) {
        const value = read(name)
        if (value !== undefined) return value
      }
      return undefined
    }

    /** Drop `undefined` entries so mermaid's own defaults show through instead of being blanked. */
    function compact(source) {
      const out = {}
      for (const [key, value] of Object.entries(source)) {
        if (value !== undefined) out[key] = value
      }
      return out
    }

    /**
     * Distinguishable colours for pie slices, git branches and plot series.
     *
     * Reads the syntax-highlighting tokens first and the static hue ramp second, dropping
     * duplicates across **both**. The dedupe is load-bearing rather than tidy: on catppuccin mocha
     * the nine shiki names collapse to six values, and on any theme they are a *syntax* palette,
     * whose two near-identical greens exist to distinguish a string from a template literal — a
     * distinction a pie chart cannot show and should not pretend to.
     *
     * @param read - `(tokenName) => colour | undefined`.
     * @returns the distinct colours that resolved, in preference order.
     */
    function categoricalPalette(read) {
      const colours = []
      for (const name of DIAGRAM_CATEGORICAL) {
        const value = read(name)
        if (value !== undefined && !colours.includes(value)) colours.push(value)
      }
      // Only widen when the theme gave us too little to tell slices apart.
      if (colours.length < 4) {
        for (const name of DIAGRAM_CATEGORICAL_FALLBACK) {
          const value = read(name)
          if (value !== undefined && !colours.includes(value)) colours.push(value)
        }
      }
      if (colours.length > 0) return colours
      // Nothing resolved. Returning `[undefined]` would be worse than returning nothing: `slice()`
      // would hand mermaid `undefined` and `plotColorPalette` would join to the literal
      // "undefined". An empty list lets every consumer fall back to mermaid's own defaults.
      const accent = firstColour(read, DIAGRAM_TOKEN_SOURCES.accent)
      return accent === undefined ? [] : [accent]
    }

    /**
     * Blend one colour toward another, returning a colour mermaid accepts.
     *
     * Written as an `rgb()` string rather than `color-mix(in srgb, …)`, which is the form the shell
     * itself would use, because **mermaid rejects `color-mix()`**: feeding the browser-resolved
     * `color(srgb 0.63 0.47 1 / 0.4)` to `mermaid.render` throws
     * `Unsupported color format` and loses the whole diagram, not just the one shape.
     *
     * `amount` is how far to move from `from` toward `to` (0 = `from`, 1 = `to`). An unresolved
     * input yields `undefined`, so the variable is simply left out and mermaid keeps its default —
     * the same degradation as everywhere else in this mapping. Only opaque colours are blended; a
     * translucent input would need compositing, and the tokens used here are the opaque surface and
     * text ladder.
     */
    function mix(from, to, amount) {
      const a = parseColourChannels(from)
      const b = parseColourChannels(to)
      if (a === undefined || b === undefined) return undefined
      const blend = (i) => channel(String(a[i] + (b[i] - a[i]) * amount))
      const r = blend(0)
      const g = blend(1)
      const bl = blend(2)
      if (r === undefined || g === undefined || bl === undefined) return undefined
      return `rgb(${r}, ${g}, ${bl})`
    }

    /**
     * `rgb()/rgba()` text to `[r, g, b]`, or `undefined` if it is not a readable colour.
     *
     * Only the forms `normaliseColour` emits reach here (it converts everything else to `rgba()`),
     * so this deliberately does not re-implement hex or `hsl()`; a value it cannot read is a value
     * `readTokenColour` already rejected.
     */
    function parseColourChannels(value) {
      const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(String(value ?? ''))
      if (m === null) return undefined
      // A translucent colour cannot be blended without knowing what is behind it, so it is refused
      // rather than silently treated as opaque — which would overstate its weight.
      if (m[4] !== undefined && Number(m[4]) < 1) return undefined
      const channels = [m[1], m[2], m[3]].map((s) => Number(s))
      return channels.some((c) => !Number.isFinite(c)) ? undefined : channels
    }

    /**
     * mermaid's own default `pieOpacity`, restated because the label contrast depends on it.
     *
     * Read out of the vendored bundle's pie-defaults block. If that default ever changes, the
     * contrast decision here changes with it — which is why it is a named constant rather than a
     * literal buried in an expression.
     */
    const PIE_OPACITY = 0.7

    /**
     * Composite a possibly-translucent colour over an opaque one, as the browser paints it.
     *
     * @param colour - the foreground, `rgb()` or `rgba()` text.
     * @param behind - the opaque background.
     * @param alpha - overrides the foreground's own alpha (for a token with no alpha that mermaid
     *   still draws at a reduced opacity).
     * @returns `rgb(…)` text, or `undefined` when either side cannot be read.
     */
    function compositeOver(colour, behind, alpha) {
      const fg = parseColourChannels(colour)
      const bg = parseColourChannels(behind)
      if (fg === undefined || bg === undefined) return undefined
      const a = alpha === undefined ? Number(/,\s*([\d.]+)\s*\)$/.exec(colour)?.[1] ?? 1) : alpha
      const blend = (i) => channel(String(fg[i] * a + bg[i] * (1 - a)))
      const r = blend(0)
      const g = blend(1)
      const b = blend(2)
      if (r === undefined || g === undefined || b === undefined) return undefined
      return `rgb(${r}, ${g}, ${b})`
    }

    /**
     * WCAG relative luminance of an opaque colour, or `undefined` for one that cannot be read.
     *
     * The sRGB→linear transfer is the standard one; the constants are from the WCAG 2.1 definition
     * and are not tunable.
     */
    function luminance(channels) {
      const linear = channels.map((value) => {
        const s = value / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    }

    /**
     * WCAG contrast ratio between two opaque colours, from 1 (identical) to 21 (black on white).
     *
     * Used to choose a text colour, which is why it returns `undefined` rather than a default when
     * either side is unreadable: a made-up ratio would silently pick a colour.
     */
    function contrastRatio(a, b) {
      const ca = parseColourChannels(a)
      const cb = parseColourChannels(b)
      if (ca === undefined || cb === undefined) return undefined
      const la = luminance(ca)
      const lb = luminance(cb)
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
    }

    /**
     * The candidate that is most legible across **every** one of `backgrounds`.
     *
     * Maximising the *minimum* ratio, not the average: a label colour that is superb on five slices
     * and invisible on the sixth is the failure being fixed, so the worst case is what decides.
     * Candidates or backgrounds that cannot be read are skipped rather than guessed at.
     *
     * @param candidates - text colours to choose between, best-guess order.
     * @param backgrounds - the fills the text will be painted on.
     * @returns `{ colour, worst }` — the winner and its worst-case ratio, or `undefined`.
     */
    function mostLegible(candidates, backgrounds) {
      const fills = backgrounds.filter((value) => value !== undefined)
      if (fills.length === 0) return undefined
      let best
      for (const candidate of candidates) {
        if (candidate === undefined) continue
        let worst = Infinity
        for (const fill of fills) {
          const ratio = contrastRatio(candidate, fill)
          if (ratio === undefined) { worst = undefined; break }
          if (ratio < worst) worst = ratio
        }
        if (worst === undefined || worst === Infinity) continue
        if (best === undefined || worst > best.worst) best = { colour: candidate, worst }
      }
      return best
    }

    /**
     * The colour a pie's percentage labels are painted in.
     *
     * Three measured facts shape this, all from the vendored bundle and a real browser:
     *
     *   - mermaid paints one `pieSectionTextColor` on **every** slice, so a palette ranging light to
     *     dark cannot be served by the theme's single label colour. Measured on dark Catppuccin
     *     Mocha: the board's own text colour scored **1.03–1.95** across the six fills — the
     *     percentages were essentially invisible while the chart itself looked fine.
     *   - slices are drawn at mermaid's default `pieOpacity` of 0.7 (the path carries `opacity: 0.7`,
     *     `fill-opacity: 1`), so the label sits on the **composite**, not on the token.
     *   - the theme's own ladder is preferred, but it is not always enough. Measured on light
     *     Catppuccin Latte the best theme-derived candidate reached **2.37** where an achromatic
     *     extreme reached **6.23** — 38% of the achievable ceiling. A theme's slice colours are
     *     chosen to be vivid against its background, which can leave every neutral it owns too close
     *     to them.
     *
     * So: try the theme's own ladder and its neutral extremes first, and fall back to black or white
     * only when even those cannot clear the floor. Legibility wins over hue purity, because a
     * percentage nobody can read is a percentage that was not drawn — but on a palette that can
     * supply a readable ink, that ink is used.
     *
     * @param candidates - the theme's own text colours, in preference order.
     * @param surface - the diagram background.
     * @param slices - the slice fills.
     * @returns a colour mermaid accepts, or `undefined` to keep mermaid's default.
     */
    function pieLabelColour(candidates, surface, slices) {
      const fills = slices.map((colour) => compositeOver(colour, surface, PIE_OPACITY))
      const preferred = mostLegible(candidates, fills)
      // See THEME_INK_MINIMUM: below the large-text bar an achromatic extreme displaces the palette.
      if (preferred !== undefined && preferred.worst >= THEME_INK_MINIMUM) return preferred.colour
      const extreme = mostLegible([BLACK, WHITE], fills)
      if (extreme === undefined) return preferred === undefined ? undefined : preferred.colour
      if (preferred === undefined) return extreme.colour
      return extreme.worst > preferred.worst ? extreme.colour : preferred.colour
    }

    /**
     * The ratio a *theme-supplied* label must clear before an achromatic extreme displaces it.
     *
     * 3.0 is WCAG AA for large text, and a pie's percentage labels are mermaid's `pieSectionTextSize`
     * of 17px in a bold-ish face — closer to large text than to body copy. The bar matters because of
     * what it prevents: on dark Catppuccin Mocha the palette's own darkest ink scores **3.83** where
     * pure black scores **4.29**. Demanding 4.5 would throw away the user's palette for a 12% gain
     * and paint every themed pie's labels in an unthemed black. Below 3.0 the trade flips — the label
     * stops being readable at all — and an extreme takes over.
     */
    const THEME_INK_MINIMUM = 3

    /**
     * How far each quadrant's fill is blended from the surface toward the text colour.
     *
     * Four evenly spaced steps, starting where the *first* step is already visible rather than at
     * zero: measured on dark Catppuccin Mocha the steps come out at contrast 1.07 between adjacent
     * quadrants, which is legible as a boundary because the fill difference is deliberate. Starting
     * the run at the surface itself would waste a step on an invisible difference.
     *
     * The last entry is `0` so the fourth quadrant is the true surface — the least busy cell is the
     * one the chart's own points are most likely to land in.
     */
    const QUADRANT_WEIGHTS = Object.freeze([0.16, 0.10, 0.05, 0])

    /** The two achromatic extremes, as the last resort for a label that cannot otherwise be read. */
    const BLACK = 'rgb(0, 0, 0)'
    const WHITE = 'rgb(255, 255, 255)'

    /**
     * Build mermaid's `themeVariables` from the shell's own colours.
     *
     * `theme: 'base'` is the only mermaid theme that honours a full variable set, and it is the
     * reason every diagram kind can be themed at once. `darkMode` is set *inside* `themeVariables`:
     * a top-level `darkMode` option was probed and does nothing, while this one flips the defaults
     * for the variables not named here.
     *
     * @param read - `(tokenName) => colour | undefined`; a fake in tests, `readTokenColour` in use.
     * @param dark - whether the shell is dark, which selects mermaid's derived defaults.
     * @returns the `themeVariables` object.
     */
    function diagramThemeVariables(read, dark) {
      const surface = firstColour(read, DIAGRAM_TOKEN_SOURCES.surface)
      const raised = firstColour(read, DIAGRAM_TOKEN_SOURCES.raised)
      const overlay = firstColour(read, DIAGRAM_TOKEN_SOURCES.overlay)
      const accent = firstColour(read, DIAGRAM_TOKEN_SOURCES.accent)
      const accentTint = firstColour(read, DIAGRAM_TOKEN_SOURCES.accentTint)
      const text = firstColour(read, DIAGRAM_TOKEN_SOURCES.text)
      const textMuted = firstColour(read, DIAGRAM_TOKEN_SOURCES.textMuted)
      const textFaint = firstColour(read, DIAGRAM_TOKEN_SOURCES.textFaint)
      const border = firstColour(read, DIAGRAM_TOKEN_SOURCES.border)
      const borderStrong = firstColour(read, DIAGRAM_TOKEN_SOURCES.borderStrong)

      const slices = categoricalPalette(read)
      // `slices` can legitimately be empty (a theme that defines neither the shiki tokens nor the
      // static ramp). Indexing into that would hand mermaid `undefined`, so fall back to a colour
      // that is merely *present*; absent keys are dropped by `compact` and mermaid keeps its own.
      const sliceAt = (index) => (slices.length === 0 ? undefined : slices[index % slices.length])

      // The colour a pie's percentage label is painted in. See `pieLabelColour` for why the theme's
      // ladder alone is not enough and when an achromatic extreme takes over. The theme's own neutral
      // extremes come first, so a label stays on-brand whenever that is already legible enough.
      const extremeDark = firstColour(read, DIAGRAM_TOKEN_SOURCES.extremeDark)
      const extremeLight = firstColour(read, DIAGRAM_TOKEN_SOURCES.extremeLight)
      const sectionLabel = pieLabelColour(
        [extremeDark, extremeLight, text, textMuted, surface],
        surface,
        slices,
      )

      return compact({
        darkMode: dark,
        // Core: every diagram kind draws nodes or actors on this surface.
        background: surface,
        primaryColor: accentTint ?? raised,
        primaryTextColor: text,
        primaryBorderColor: accent ?? borderStrong,
        secondaryColor: raised,
        tertiaryColor: overlay,
        lineColor: textFaint,
        textColor: text,
        edgeLabelBackground: surface,
        clusterBkg: overlay,
        clusterBorder: border,
        // Sequence.
        actorBkg: accentTint ?? raised,
        actorBorder: accent ?? borderStrong,
        actorTextColor: text,
        actorLineColor: textFaint,
        signalColor: text,
        signalTextColor: text,
        labelBoxBkgColor: raised,
        labelBoxBorderColor: border,
        labelTextColor: text,
        loopTextColor: text,
        noteBkgColor: raised,
        noteBorderColor: borderStrong,
        noteTextColor: text,
        activationBkgColor: accent ?? raised,
        activationBorderColor: accent ?? borderStrong,
        sequenceNumberColor: surface,
        // Pie: slices from the syntax palette, labels from the text ladder.
        pie1: sliceAt(0),
        pie2: sliceAt(1),
        pie3: sliceAt(2),
        pie4: sliceAt(3),
        pie5: sliceAt(4),
        pie6: sliceAt(5),
        pie7: sliceAt(6),
        pie8: sliceAt(7),
        pieTitleTextColor: text,
        // `pieSectionTextColor` is a *single* colour mermaid paints on every slice, so it cannot be
        // right for a palette that ranges light to dark. Measured on dark Catppuccin Mocha: the
        // board's own label colour scored **1.03–1.95** against the six slice fills, i.e. the
        // percentages were near-invisible. So the label is picked as the candidate with the best
        // *worst-case* contrast across all slices, compositing mermaid's own 0.7 `pieOpacity` first
        // (the text sits on the blend of slice over background, not on the token value).
        pieSectionTextColor: sectionLabel,
        pieLegendTextColor: text,
        pieStrokeColor: surface,
        pieOuterStrokeColor: border,
        // Git graph.
        git0: sliceAt(0),
        git1: sliceAt(1),
        git2: sliceAt(2),
        git3: sliceAt(3),
        git4: sliceAt(4),
        git5: sliceAt(5),
        git6: sliceAt(6),
        git7: sliceAt(7),
        commitLabelColor: text,
        commitLabelBackground: raised,
        tagLabelColor: surface,
        tagLabelBackground: accent ?? borderStrong,
        tagLabelBorder: borderStrong,
        branchLabelColor: textMuted,
        // Quadrant: four fills that must be four *different* colours.
        //
        // Measured before this was written: mapping these to `raised`/`overlay`/`accentTint`/`surface`
        // gave dark Catppuccin Mocha `49,50,68` twice (contrast ratio 1.00 between quadrant 1 and 2),
        // because `--dsw-alias-bg-layer-3` and `--dsw-alias-bg-overlay` hold the same value in that
        // theme. Two indistinguishable quadrants erase the only thing a quadrant chart says.
        //
        // So the fills are derived from one surface, blended toward the text colour by
        // `QUADRANT_WEIGHTS`. Blending toward the *text* is what makes this safe: a surface and a
        // text colour that are far enough apart to read text on are far enough apart to separate
        // four steps between them, in either colour scheme and whatever the theme's hues.
        quadrant1Fill: mix(surface, text, QUADRANT_WEIGHTS[0]),
        quadrant2Fill: mix(surface, text, QUADRANT_WEIGHTS[1]),
        quadrant3Fill: mix(surface, text, QUADRANT_WEIGHTS[2]),
        quadrant4Fill: mix(surface, text, QUADRANT_WEIGHTS[3]) ?? surface,
        quadrant1TextFill: text,
        quadrant2TextFill: text,
        quadrant3TextFill: text,
        quadrant4TextFill: text,
        quadrantPointFill: accent ?? borderStrong,
        quadrantPointTextFill: text,
        quadrantXAxisTextFill: textMuted,
        quadrantYAxisTextFill: textMuted,
        quadrantTitleFill: text,
        quadrantInternalBorderStrokeFill: border,
        quadrantExternalBorderStrokeFill: borderStrong,
        // XY chart: `plotColorPalette` is a comma-joined list, not an indexed variable.
        xyChart: compact({
          backgroundColor: surface,
          titleColor: text,
          dataLabelColor: text,
          legendTextColor: text,
          xAxisLabelColor: textMuted,
          xAxisTitleColor: textMuted,
          xAxisLineColor: border,
          xAxisTickColor: border,
          yAxisLabelColor: textMuted,
          yAxisTitleColor: textMuted,
          yAxisLineColor: border,
          yAxisTickColor: border,
          plotColorPalette: slices.length === 0 ? undefined : slices.join(', '),
        }),
      })
    }

    /** The theme values a diagram is drawn with, re-read whenever the shell's theme moves. */
    function readDiagramTheme() {
      const dark = isDarkTheme()
      return { dark, variables: diagramThemeVariables(readTokenColour, dark) }
    }

    /**
     * Follow the shell's theme, including a palette swap that keeps the same color scheme.
     *
     * Two signals, because one is not enough. `data-ds-dark-theme` on `<body>` covers a light/dark
     * flip — the same signal `dsh-mermaid` watches. It does **not** cover switching from one dark
     * palette to another, which is now a normal thing to do: a theme plugin restyles the page by
     * writing its tokens as inline custom properties on `<body>`, so the *style attribute* is what
     * changes while the dark attribute stays put. Observing both is what makes a palette swap
     * repaint the diagrams instead of waiting for a reload.
     *
     * The state holds a signature rather than the values, so an unrelated mutation on `<body>`
     * does not tear down and re-render every diagram on the page.
     *
     * @returns `{ dark, variables, signature }`.
     */
    function useDiagramTheme() {
      const [theme, setTheme] = React.useState(readDiagramTheme)
      React.useEffect(() => {
        if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return undefined
        const sync = () => {
          const next = readDiagramTheme()
          const signature = `${next.dark ? 'dark' : 'light'}|${JSON.stringify(next.variables)}`
          setTheme((current) =>
            current.signature === signature ? current : { ...next, signature },
          )
        }
        // Seed the signature so the first observer callback can compare against it.
        sync()
        const observer = new MutationObserver(sync)
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: ['style', 'data-ds-dark-theme'],
        })
        return () => observer.disconnect()
      }, [])
      return theme
    }

    /**
     * The URL for a file on disk.
     *
     * `/api/file` is DSH's own authenticated file route: one absolute path in the query string, the
     * bytes back, with the status codes to match (404/403 for missing or unreadable, 413 over the
     * byte limit). It is the same origin, so an `<img>` can point straight at it — no fetch, no
     * object URL to revoke, and the browser's own decoding and caching.
     *
     * The board stores paths rather than bytes, which is why a picture can stop existing. That is
     * a property of the design, not an accident: a path is the one thing `board_apply` can be given
     * without the plugin owning a copy of every file the user ever points at.
     *
     * @param path - an absolute path.
     * @returns the URL to read it from.
     */
    function fileUrl(path) {
      return `/api/file?path=${encodeURIComponent(path)}`
    }

    /**
     * The client's half of `renderInputKey` in `src/runtime.js`.
     *
     * A report is retired by comparing this to the block's current value, so it has to be exactly
     * what the host would compute. This file cannot import the host's copy — it is served as a
     * classic script through the plugin loader — so the three cases are written out twice on
     * purpose. Keep them in step.
     *
     * @param block - a board block.
     * @returns the key.
     */
    function renderInput(block) {
      if (block.kind === 'uml') return block.source
      if (block.kind === 'pdf-page') return `${block.src}#${block.page}`
      if (block.kind === 'image') return block.src
      return undefined
    }

    /**
     * Tell the host that this diagram did not draw.
     *
     * Fire and forget, and failures are swallowed: the user is already looking at the error on
     * screen, and a board that also throws because a telemetry POST failed would be a worse board.
     * The render input travels with the report because it is the key the report is retired by — the
     * host stops showing it the moment the block no longer has that input.
     */
    function reportRenderFailure(sessionId, block, message) {
      if (typeof fetch !== 'function') return
      const input = renderInput(block)
      if (typeof input !== 'string') return
      try {
        fetch(RENDER_REPORT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            blockId: block.id,
            blockSlug: block.slug,
            input,
            message,
          }),
        }).catch(() => {})
      } catch {
        // A synchronous throw here (a malformed URL, a blocked fetch) must not escape into React.
      }
    }

    /**
     * A renderer's error text, reduced to something the Agent can act on.
     *
     * It arrives with a caret diagram and a stack. The first line carries the position, which is
     * the part worth spending the Agent's attention on.
     */
    function renderErrorText(error) {
      const raw = error instanceof Error ? error.message : String(error)
      const firstLine = raw.split('\n')[0].trim()
      return (firstLine === '' ? raw.trim() : firstLine).slice(0, 600)
    }

    /**
     * Turn mermaid's SVG into an `<img>` source.
     *
     * The obvious way to show rendered SVG is to inject the string as markup, and this file is
     * under a standing rule not to — there is no `dangerouslySetInnerHTML` in this file, and
     * `test/markdown.test.js` fails the build if one appears. That rule is not theatre: every other
     * string rendered here is Agent-written prose, and React elements cannot execute.
     *
     * A data URL happens to be the *stronger* answer rather than a workaround. The SVG is decoded
     * into its own document, so nothing in it shares this page's DOM: script cannot run, `onload`
     * cannot fire, and a `<foreignObject>` cannot reach out. The parser is the browser's own, so
     * there is no hand-written SVG-to-elements conversion to get subtly wrong — and mermaid's
     * diagrams are self-contained anyway (`securityLevel: 'strict'` inlines the styling and strips
     * external references), so isolation costs the picture nothing.
     *
     * What it does cost: the diagram's text is not selectable and not searchable, and it cannot
     * inherit this page's CSS. The font is therefore passed to mermaid explicitly, read from the
     * page at render time so it still follows the shell's typography.
     *
     * @param svg - the SVG document mermaid produced.
     * @returns a `data:` URL.
     */
    function svgDataUrl(svg) {
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    }

    /** The page's own font stack, so a diagram's labels match the board's text. */
    function pageFontFamily() {
      if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 'sans-serif'
      const family = window.getComputedStyle(document.body).fontFamily
      return family === '' ? 'sans-serif' : family
    }

    /**
     * The box of every node in a rendered mermaid SVG, in the SVG's own user units.
     *
     * **Why the result is text rather than a measurement.** The diagram is a picture: mermaid's SVG
     * goes into an `<img>` through a `data:` URL, deliberately, because that is what isolates
     * Agent-authored diagram source from the board's own document. So the nodes are in no DOM the
     * arrow layer could walk — an `<img>`'s contents are sealed. What *is* available is the SVG's
     * own text, at the one moment it is already in hand, and an XML parse of it runs no scripts and
     * has no layout, which is exactly the amount of custody this needs. The table is then carried to
     * the arrow layer as an attribute, the same way every other measurement crosses a boundary here.
     *
     * `getBBox` is not available — a detached parsed document has no layout to measure — so a node's
     * box comes from its own `transform` and its shape element's declared attributes. Mermaid writes a
     * node as `<g class="node" id="<containerId>-<family>-<key>[-<n>]">` holding a
     * `rect`/`circle`/`ellipse`/`polygon`; the `<n>` is a global counter rather than anything to do
     * with the node, so the key is what remains once the container id, the family token and that
     * counter are off. That is the identifier the Agent wrote and the one `src/uml.js` publishes as
     * `nodeHints`, so the two agree by construction.
     *
     * Not every family draws nodes this way: sequence and class diagrams emit no `g.node` at all
     * (`<g id="A">` and `<g class="node">`-less class boxes), so their keys are not reachable here. A
     * key that is not found is not an error — the anchor falls back to the block box, which is a plain
     * and honest answer: the diagram is there, the node is not addressable.
     *
     * @param svg - the SVG document mermaid produced.
     * @param env - the parser to read it with, defaulting to the browser's. Injected for the same
     *   reason `originAt` takes its DOM: this is the one branch of the resolver that needs a host
     *   object, and a test can then drive it with a parsed document instead of a browser.
     * @returns `{ w, h, nodes }` with the SVG's own size, or `undefined` if the parse failed.
     */
    function diagramNodeTable(svg, env) {
      const Parser = env?.DOMParser ?? (typeof DOMParser === 'function' ? DOMParser : undefined)
      if (Parser === undefined) return undefined
      let root
      try {
        root = new Parser().parseFromString(svg, 'image/svg+xml').documentElement
      } catch {
        return undefined
      }
      if (root === null || root === undefined || root.localName !== 'svg') return undefined

      /** One length attribute. `px` with no unit is what mermaid writes. */
      const length = (raw) => {
        const value = Number.parseFloat(raw)
        return Number.isFinite(value) ? value : undefined
      }
      // The viewBox is the size that matters, not `width`/`height`: the picture is drawn with
      // `preserveAspectRatio: 'none'`, so the img box *is* the viewBox scaled, and mermaid writes
      // `width="100%"` on the root — a percentage that `parseFloat` would read as the number 100.
      const view = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
      const w = (Number.isFinite(view[2]) && view[2] > 0 ? view[2] : undefined) ?? length(root.getAttribute('width')) ?? 100
      const h = (Number.isFinite(view[3]) && view[3] > 0 ? view[3] : undefined) ?? length(root.getAttribute('height')) ?? 100

      // Mermaid names a node `<containerId>-<familyToken>-<key>[-<counter>]`, and the root carries the
      // container id, so the prefix comes off by identity rather than by guessing where it ends. Then
      // the family token, then the global counter: what is left is the identifier the Agent wrote.
      // Measured against mermaid 11: a flowchart is `flowchart-A-0`, a state diagram `state-Idle-0`, an
      // er entity `entity-CUSTOMER`. Sequence and class diagrams draw no `g.node` at all, so their keys
      // are not reachable this way and their anchors fall back to the block box.
      const container = root.getAttribute('id') ?? ''
      const nodeKey = (id, owner) => {
        const rest = owner !== '' && id.startsWith(`${owner}-`) ? id.slice(owner.length + 1) : id
        return rest.replace(/^(flowchart|state|entity)-/, '').replace(/-\d+$/, '')
      }

      const nodes = {}
      const write = (key, x, y, width, heightBox) => {
        if (key === undefined || key === '') return
        // `slice` rather than mutating the object literal: a second shape inside one node group (a
        // class box draws its own compartment lines) must not overwrite the first.
        nodes[key] = { x, y, w: width, h: heightBox }
      }
      for (const group of root.querySelectorAll('g.node')) {
        const id = group.getAttribute('id') ?? ''
        const key = nodeKey(id, container)
        const translated = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(group.getAttribute('transform') ?? '')
        if (translated === null) continue
        const x = Number(translated[1])
        const y = Number(translated[2])
        const shape = group.querySelector('rect, circle, ellipse, polygon')
        if (shape === null) continue
        const shapeName = shape.localName
        if (shapeName === 'circle') {
          const radius = length(shape.getAttribute('r')) ?? 0
          write(key, x - radius, y - radius, radius * 2, radius * 2)
        } else if (shapeName === 'ellipse') {
          const rx = length(shape.getAttribute('rx')) ?? 0
          const ry = length(shape.getAttribute('ry')) ?? 0
          write(key, x - rx, y - ry, rx * 2, ry * 2)
        } else if (shapeName === 'rect') {
          // mermaid clips a rounded rect to an 8px radius; the box is the same either way.
          write(key, x, y, length(shape.getAttribute('width')) ?? 0, length(shape.getAttribute('height')) ?? 0)
        } else {
          const numbers = (shape.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number)
          const xs = numbers.filter((_, at) => at % 2 === 0)
          const ys = numbers.filter((_, at) => at % 2 === 1)
          if (xs.length === 0 || ys.length === 0) continue
          write(key, x + Math.min(...xs), y + Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
        }
      }
      return { w, h, nodes }
    }

    /**
     * Render one `uml` block.
     *
     * Three states, and the failure one deliberately keeps the source visible: a user looking at a
     * diagram that will not draw needs to see what the Agent wrote, and the Agent needs the same
     * text to fix it. Blanking the card would hide the only thing either of them can act on.
     *
     * @param props - `{ block, sessionId }`.
     */
    function Diagram({ block, sessionId }) {
      const theme = useDiagramTheme()
      const [state, setState] = React.useState({ status: 'loading' })
      const source = block.source
      // The variables, not the whole theme object: the effect must not re-run because a new but
      // equivalent object was built. `variables` is itself rebuilt per render, so the signature is
      // what actually gates the effect — an unchanged palette re-renders nothing.
      const signature = theme.signature

      React.useEffect(() => {
        let cancelled = false
        setState({ status: 'loading' })
        loadMermaid()
          .then((mermaid) => {
            mermaid.initialize({
              startOnLoad: false,
              // mermaid's default, stated rather than assumed: every label in this diagram came
              // from the model, and strict is the level that encodes HTML in labels rather than
              // interpreting it.
              securityLevel: 'strict',
              // **Measured**: with mermaid's own default (`false`), a diagram that fails to parse
              // makes mermaid insert its "Syntax error in text" bomb graphic into `document.body`
              // — not into the card. The catch below still runs and the card still shows the real
              // reason, so the failure looks handled while a full-size graphic sits on top of the
              // whole board. Turning this on makes mermaid throw *instead*, which is the behaviour
              // the error path was always written against. It is in mermaid's `secure` list, so it
              // is settable from here.
              suppressErrorRendering: true,
              // `base` is the only mermaid theme that honours a full variable set; the built-in
              // `default`/`dark` themes ignore most of `themeVariables`, which is why the shells
              // own palette is passed through it instead of choosing between them.
              theme: 'base',
              themeVariables: theme.variables,
              fontFamily: pageFontFamily(),
              // SVG `<text>` rather than `<foreignObject>` labels. Nothing about the `<img>`
              // isolation requires it, but plain text elements are the form that renders
              // identically everywhere and the form that inherits the font above.
              flowchart: { htmlLabels: false },
            })
            return mermaid.render(`sb-uml-${block.id}`, source)
          })
          .then((result) => {
            if (!cancelled) {
              setState({ status: 'ready', src: svgDataUrl(result.svg), nodes: diagramNodeTable(result.svg) })
            }
          })
          .catch((error) => {
            if (cancelled) return
            const message = renderErrorText(error)
            setState({ status: 'failed', message })
            reportRenderFailure(sessionId, block, message)
          })
        return () => {
          cancelled = true
        }
        // `theme.variables` is deliberately absent: it is a fresh object every render, and the
        // signature is the value that changes exactly when the palette does.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [block.id, source, signature])

      if (state.status === 'ready') {
        return h(
          'div',
          {
            className: 'sb-diagram',
            'data-superboard-diagram': '',
            // Read by a `node` anchor, which is the only reason the node table is published at all.
            // On the wrapper rather than beside the picture so one lookup gets the container, the
            // image and the table; a diagram with no addressable nodes carries an empty table, and
            // its arrows fall back to the block box.
            'data-superboard-nodes': JSON.stringify(state.nodes),
          },
          h('img', {
            className: 'sb-diagramImage',
            src: state.src,
            alt: `${block.slug}：${block.engine} ${block.diagram} 图`,
            // Filled rather than letterboxed with the aspect ratio intact, so the picture's box *is*
            // the SVG's user-unit space scaled. A node's box is then a single multiplication and
            // needs no idea where the letterbox bars went — the one assumption the rest of this
            // conversion is allowed to make.
            preserveAspectRatio: 'none',
          }),
        )
      }

      return h(
        'div',
        { className: 'sb-diagramWait', 'data-superboard-diagram': '' },
        h('pre', { className: 'sb-code' }, h('code', { className: `language-${block.engine}` }, source)),
        state.status === 'loading'
          ? h('p', { className: 'sb-diagramNote' }, '正在渲染图…')
          : h('p', { className: 'sb-diagramError' }, `渲染失败：${state.message}`),
      )
    }

    /**
     * A picture the board points at.
     *
     * The block holds a path and the bytes belong to the filesystem, which means they can be moved,
     * replaced, or deleted between the write and the read. So "this picture is not there" is a
     * state this component has rather than an impossibility, and it is reported to the host the
     * same way a diagram that will not draw is — because to the Agent it is the same problem.
     *
     * @param props - `{ block, sessionId }`.
     */
    function Picture({ block, sessionId }) {
      const [failed, setFailed] = React.useState(false)
      const url = fileUrl(block.src)

      // A path the Agent corrects has to clear the failure it caused, or the card stays broken
      // until the view happens to remount.
      React.useEffect(() => {
        setFailed(false)
      }, [url])

      if (failed) {
        return h(
          'div',
          { className: 'sb-mediaBox' },
          h('p', { className: 'sb-diagramError' }, `读不到这张图：${block.src}`),
          h('p', { className: 'sb-diagramNote' }, '文件被移走、改名或删除了，也可能它超过了 /api/file 的读取上限。'),
        )
      }

      return h(
        'div',
        { className: 'sb-mediaBox' },
        h('img', {
          className: 'sb-media',
          src: url,
          alt: block.alt,
          // Read by a `rect`/`point` anchor: the frame those normalised coordinates are relative to
          // is this picture's own rendered box, which is the only thing the browser knows and the
          // only thing that stays right when the card is resized. A picture and a cropped PDF page
          // carry the same hook on purpose — an anchor's `(0,0)`–`(1,1)` box means "the picture I can
          // see" for both, and a second name for it would be a second thing to get wrong.
          'data-superboard-field': 'frame',
          onError: () => {
            setFailed(true)
            reportRenderFailure(sessionId, block, `读不到文件 ${block.src}`)
          },
        }),
      )
    }

    /**
     * The region of a PDF page a `pdf-page` block shows, or `undefined` for the whole page.
     *
     * Normalised fractions of the page (`src/schema.js:95`), which is the same frame the document
     * gives a `rect`/`point` anchor on such a block (`docs/design/board-model.md:306-308`) — so this
     * is not a display nicety, it is the coordinate frame, and the renderer and the resolver have to
     * read it the same way or the arrows point at a region the picture is not showing.
     *
     * `undefined` rather than an identity box for three cases at once — no crop, an unreadable crop,
     * and the whole page — because all three mean the same thing to the caller, and a malformed crop
     * should degrade to the whole page rather than to a blank canvas.
     *
     * @param value - `block.crop` as the model carries it.
     * @returns `{x, y, w, h}` in `[0, 1]`, or `undefined`.
     */
    function pageCrop(value) {
      if (typeof value !== 'object' || value === null) return undefined
      const x = fraction(unit(coordinate(value.x) ?? 0))
      const y = fraction(unit(coordinate(value.y) ?? 0))
      const w = coordinate(value.w)
      const h = coordinate(value.h)
      if (w === undefined || h === undefined || w <= 0 || h <= 0) return undefined
      // Clamped into the page rather than rejected: a crop that runs off the edge is a crop that
      // shows the edge, and an arrow measured against a region that is not on screen has no frame.
      const box = { x, y, w: fraction(Math.min(w, 1 - x)), h: fraction(Math.min(h, 1 - y)) }
      if (box.w <= 0 || box.h <= 0) return undefined
      return box.x === 0 && box.y === 0 && box.w === 1 && box.h === 1 ? undefined : box
    }

    /**
     * A normalised fraction, rounded the way the model rounds one.
     *
     * `src/model.js:325` quantises a crop to four decimals so float noise cannot reach the revision
     * hash. Clamping does the same thing to a different pair of numbers — `1 - 0.8` is
     * `0.19999999999999996` — and a rendered crop that disagreed with the hashed one in the seventh
     * decimal would be two descriptions of the same box, which is exactly what this file is here to
     * stop doing.
     */
    function fraction(value) {
      return Math.round(value * 1e4) / 1e4
    }

    /**
     * One page of a PDF.
     *
     * The bytes come from the host's own file route and the rasterisation happens here, in the
     * browser, for the same reason the diagram does: the alternative is a native PDF renderer in
     * the host process, and the price of that is a platform-specific binary in a plugin. DSH
     * itself draws PDFs this way.
     *
     * The page is a `<canvas>` at the screen's density and the card's width rather than a fixed
     * scale, because a page drawn at 1× on a wide card is visibly soft and one drawn at 3× on a
     * narrow card is a canvas nobody looks at closely enough to justify.
     *
     * @param props - `{ block, sessionId }`.
     */
    function PdfPage({ block, sessionId }) {
      const [state, setState] = React.useState({ status: 'loading' })
      const canvas = React.useRef(null)
      const src = block.src
      const number = block.page
      // Normalised once, in the render, so the attribute below and the rasteriser cannot describe
      // two different boxes — and so the effect depends on a string rather than on an object, which
      // would re-rasterise the page on every render.
      const crop = pageCrop(block.crop)
      const cropText = crop === undefined ? undefined : JSON.stringify(crop)

      React.useEffect(() => {
        let cancelled = false
        setState({ status: 'loading' })
        loadPdfjs()
          .then(async (pdfjs) => {
            const document = await openDocument(pdfjs, src)
            // pdf.js is the only thing that knows how many pages a file has, and asking for the
            // twelfth page of an eight-page document is the mistake this is most likely to see.
            if (number < 1 || number > document.numPages) {
              throw new Error(`这份 PDF 一共 ${document.numPages} 页，没有第 ${number} 页`)
            }
            const page = await document.getPage(number)
            const target = canvas.current
            if (cancelled || target === null || target === undefined) return
            const base = page.getViewport({ scale: 1 })
            const shown = crop ?? { x: 0, y: 0, w: 1, h: 1 }
            const density = window.devicePixelRatio || 1
            // A quarter-turned page shows the crop's *height* across the screen, so which of the
            // page's two dimensions the card's width is measured against depends on its rotation.
            const turn = (((base.rotation % 360) + 360) % 360)
            const across = turn === 90 || turn === 270 ? base.height * shown.h : base.width * shown.w
            const cssWidth = Math.min(target.parentElement?.clientWidth || across, MAX_PAGE_WIDTH)
            const scale = (cssWidth / across) * density
            const uncropped = page.getViewport({ scale })
            // The crop's two opposite corners, asked of pdf.js rather than derived here: where a
            // point of the page lands depends on the page's rotation and its `userUnit`, and
            // `convertToViewportPoint` is the module's own answer to that question.
            const viewBox = base.viewBox
            const left = viewBox[0] + shown.x * (viewBox[2] - viewBox[0])
            const top = viewBox[3] - shown.y * (viewBox[3] - viewBox[1])
            const [cornerX, cornerY] = uncropped.convertToViewportPoint(left, top)
            const [farX, farY] = uncropped.convertToViewportPoint(left + shown.w * (viewBox[2] - viewBox[0]), top - shown.h * (viewBox[3] - viewBox[1]))
            // `offsetX`/`offsetY` translate the finished viewport in device pixels whatever the
            // rotation — `PageViewport`'s transform puts them straight into its translation — so
            // moving the crop's corner to the canvas's origin is exactly this subtraction. The
            // viewport still *reports* the whole page's size, which is why the canvas is sized from
            // the two corners instead.
            const viewport = page.getViewport({ scale, offsetX: -cornerX, offsetY: -cornerY })
            const deviceWidth = Math.max(1, Math.abs(farX - cornerX))
            const deviceHeight = Math.max(1, Math.abs(farY - cornerY))
            target.width = Math.round(deviceWidth)
            target.height = Math.round(deviceHeight)
            target.style.width = `${Math.round(deviceWidth / density)}px`
            await page.render({ canvasContext: target.getContext('2d'), viewport }).promise
            if (!cancelled) setState({ status: 'ready' })
          })
          .catch((error) => {
            if (cancelled) return
            const message = renderErrorText(error)
            setState({ status: 'failed', message })
            reportRenderFailure(sessionId, block, message)
          })
        return () => {
          cancelled = true
        }
      }, [src, number, cropText])

      const canvasElement = h('canvas', {
        // Hidden until there is something on it: an untouched canvas is white in both themes, so
        // showing it while the page loads would flash a light rectangle into a dark board.
        className: state.status === 'ready' ? 'sb-pdfPage' : 'sb-pdfPage sb-pdfPending',
        ref: canvas,
        'data-superboard-pdf': `${src}#${number}`,
        // Read by a `rect`/`point` anchor: this canvas *is* the crop, so its own box is the frame a
        // normalised coordinate is measured in, and `crop` cannot be applied a second time here.
        'data-superboard-field': 'frame',
        // The crop the page was rasterised to, normalised, for whoever has to explain why an arrow
        // landed where it did: the frame is on screen but which part of the page it is, is not.
        'data-superboard-crop': cropText,
      })

      if (state.status === 'failed') {
        return h(
          'div',
          { className: 'sb-mediaBox' },
          h('p', { className: 'sb-diagramError' }, `这一页画不出来：${state.message}`),
          h('p', { className: 'sb-diagramNote' }, `${src} 第 ${number} 页`),
        )
      }

      return h(
        'div',
        { className: 'sb-mediaBox' },
        canvasElement,
        state.status === 'loading'
          ? h('p', { className: 'sb-diagramNote' }, `正在渲染 ${src} 第 ${number} 页…`)
          : null,
      )
    }

    /**
     * The kind-specific body of a block.
     *
     * Text-bearing kinds render inline markdown. Author-written prose is the whole point of a
     * board that doubles as a persistent display surface, and showing `**根因**` with its asterisks
     * intact reads as broken text rather than as emphasis. Structured kinds (code, diagram source)
     * stay literal on purpose — their content is verbatim by definition.
     */
    function renderBlockBody(block, sessionId) {
      switch (block.kind) {
        case 'heading':
          return h(
            `h${block.level}`,
            // The `text` field. A heading's rendered text is its field verbatim, so the inline
            // spans' own offsets are the field's.
            { className: `sb-h${block.level}`, 'data-superboard-field': 'text' },
            h(RichText, { text: block.text }),
          )
        case 'prose': {
          const blocks = parseMarkdownBlocks(block.markdown)
          // A table is not a line shape — it takes a header row *and* a separator row — so it can
          // only be found by parsing. Asking the parser rather than pattern-matching here keeps
          // one definition of what block structure is.
          if (blocks.length === 1 && blocks[0].type === 'paragraph') {
            // The one shape whose rendered text and field text are the same string, so a `text`
            // anchor lands on the exact character. `Markdown` below carries the same hook for every
            // other shape, where the offsets can only be as precise as the block they are in.
            return h(
              'p',
              { className: 'sb-p', 'data-superboard-field': 'text' },
              h(RichText, { text: block.markdown }),
            )
          }
          return h(Markdown, { text: block.markdown, className: 'sb-mdProse' })
        }
        case 'list':
          return h(
            block.ordered ? 'ol' : 'ul',
            { className: 'sb-list' },
            block.items.map((item) =>
              h(
                'li',
                {
                  key: item.id,
                  style: item.depth > 0 ? { marginLeft: item.depth * 12 } : undefined,
                  // Read by an `item` anchor, which names one row of a list and needs no index.
                  'data-superboard-item': item.id,
                },
                h(RichText, { text: item.text }),
              ),
            ),
          )
        case 'code':
          return h(
            'div',
            null,
            block.filename === undefined
              ? null
              // The `filename` field. It shares the `sb-slug` class with the card head, and the
              // field attribute is what keeps an anchor from pointing at the card's own slug.
              : h('div', { className: 'sb-slug', 'data-superboard-field': 'filename' }, block.filename),
            h(
              'pre',
              { className: 'sb-code' },
              h(
                'code',
                { className: codeClass(block.lang), 'data-superboard-field': 'code' },
                // One span per line, so `lines {from, to}` has a box per line to resolve against.
                // The newlines are sibling text nodes rather than part of a span: the code element's
                // text is then byte-for-byte what the block holds, which is what the board's own
                // "structured kinds stay literal" rule promises.
                codeLines(block.code),
              ),
            ),
          )
        case 'image':
          return h(
            'div',
            null,
            h(Picture, { block, sessionId }),
            block.caption === undefined
              ? null
              // The `caption` field; the picture above carries `frame`, which is the box a `rect`/
              // `point` anchor is measured in.
              : h('p', { className: 'sb-p', 'data-superboard-field': 'caption' }, h(RichText, { text: block.caption })),
          )
        case 'pdf-page':
          return h(
            'div',
            null,
            h(PdfPage, { block, sessionId }),
            block.caption === undefined
              ? null
              : h('p', { className: 'sb-p', 'data-superboard-field': 'caption' }, h(RichText, { text: block.caption })),
          )
        case 'uml':
          return h(Diagram, { block, sessionId })
        case 'group':
          return h(
            'div',
            null,
            block.title === undefined
              ? null
              : h('h3', { className: 'sb-h3', 'data-superboard-field': 'title' }, h(RichText, { text: block.title })),
            h('p', { className: 'sb-missing' }, `contains ${block.children.length} block(s)`),
          )
        default:
          return h('p', { className: 'sb-p' }, `unsupported block kind: ${block.kind}`)
      }
    }

    /**
     * A code block's text as one span per line.
     *
     * `lines {from, to}` is a 1-based inclusive range, so the span's index is the anchor's own
     * numbering and nothing has to be stored to translate between them.
     *
     * @param code - the code text, newlines included.
     * @returns the children of the `<code>` element.
     */
    function codeLines(code) {
      const parts = String(code ?? '').split('\n')
      const children = []
      parts.forEach((line, index) => {
        if (index > 0) children.push('\n')
        // Even an empty line gets a span: a blank line is a line, and a range that spans one would
        // otherwise have to be treated as an absence.
        children.push(h('span', { key: `ln${index}`, 'data-superboard-line': index + 1 }, line))
      })
      return children
    }

    // -----------------------------------------------------------------------
    // Edges
    // -----------------------------------------------------------------------

    /**
     * Resolve one anchor to a rectangle. Pure: no DOM, no measuring.
     *
     * **Why this is separate from the measuring.** `board_apply` has accepted nine anchor kinds since
     * the first layout grill, `src/schema.js` puts `at` on the wire, and `src/model.js` hashes it —
     * and until now the renderer measured whole blocks and threw every one of them away, so a
     * `{kind: 'node', key}` arrow and a `{kind: 'block'}` arrow drew identically. The nine kinds are
     * a promise the renderer now has to keep, and the part worth testing is which rectangle a given
     * descriptor names. Splitting it here is what makes that testable at all: this file's tests run
     * in a `vm` with no DOM.
     *
     * @param at - an `AnchorAt` from `src/schema.js:19-40`, or `undefined` for the whole block.
     * @param target - what the collector measured, in canvas content coordinates: `{ block, frame,
     *   fields, items, children, lines, text, nodes, diagram }`. Every member is optional.
     * @returns `{left, top, width, height}` in canvas content coordinates.
     */
    function anchorRect(at, target) {
      const block = target?.block
      // A missing block box is the one case with nothing to fall back to (the block is not
      // rendered). A zero rect is the honest answer: the caller has already dropped the edge.
      if (block === undefined) return { left: 0, top: 0, width: 0, height: 0 }

      try {
        if (at === undefined || at === null) return block
        const kind = at.kind
        if (kind === 'block') return block
        if (kind === 'field') return (target.fields ?? {})[at.field] ?? block
        if (kind === 'item') return (target.items ?? {})[at.itemId] ?? block
        if (kind === 'child') return (target.children ?? {})[at.childId] ?? block
        if (kind === 'rect') return anchorInFrame(at, target) ?? block
        if (kind === 'point') return anchorInFrame({ x: at.x, y: at.y, w: 0, h: 0 }, target) ?? block
        if (kind === 'lines') return linesRect(at, target) ?? block
        if (kind === 'text') return textRect(at, target) ?? block
        if (kind === 'node') return nodeRect(at, target) ?? block
        return block
      } catch {
        // The fold enforces which kinds may appear on which blocks, but a renderer that throws on a
        // value it did not expect takes the whole pane down to a blank rectangle. An arrow drawn at
        // the block box is a worse arrow and a much better failure.
        return block
      }
    }

    /** A usable coordinate, or `undefined` for anything that is not a finite number. */
    function coordinate(value) {
      const number = typeof value === 'number' ? value : Number.NaN
      return Number.isFinite(number) ? number : undefined
    }

    /** Clamp to `[0, 1]`, which is the domain a normalised anchor is defined over. */
    function unit(value) {
      const number = coordinate(value)
      if (number === undefined) return 0
      return Math.min(1, Math.max(0, number))
    }

    /**
     * A normalised `rect` or `point`, mapped onto the box it is relative to.
     *
     * For an `image` that box is the picture's own rendered box. For a `pdf-page` it is the crop
     * region, rasterised into the canvas — which is the whole reason `crop` stops being an inert
     * field here: `docs/design/board-model.md:306-308` defines the coordinates as relative to the
     * crop, and a page whose crop is set would otherwise place every anchor in the wrong part of the
     * frame. The collector has already resolved that box; this only scales into it.
     *
     * @returns the rectangle, or `undefined` when one of the four numbers is not a number at all.
     *   A `point` with an unreadable `x` is not "at the origin" — it is not a point, and clamping it
     *   would put an arrowhead in the corner of the card and call that success.
     */
    function anchorInFrame(at, target) {
      const x = coordinate(at.x)
      const y = coordinate(at.y)
      if (x === undefined || y === undefined) return undefined
      const w = at.w === undefined ? 0 : coordinate(at.w)
      const h = at.h === undefined ? 0 : coordinate(at.h)
      if (w === undefined || h === undefined) return undefined
      const frame = target.frame ?? target.block
      return {
        left: frame.left + unit(x) * frame.width,
        top: frame.top + unit(y) * frame.height,
        width: unit(w) * frame.width,
        height: unit(h) * frame.height,
      }
    }

    /** The bounding box of a 1-based, inclusive line range, or `undefined` if no line is there. */
    function linesRect(at, target) {
      const lines = target.lines
      if (lines === undefined) return undefined
      // `Number` first: the schema enforces numbers, but a renderer that trusted it would be one
      // malformed value away from `from <= NaN` being false and the arrow landing at line 0.
      const from = Number(at.from)
      const to = Number(at.to)
      if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined
      const wanted = []
      for (let number = Math.min(from, to); number <= Math.max(from, to); number += 1) {
        const rect = lines[number]
        if (rect !== undefined) wanted.push(rect)
      }
      return unionRect(wanted)
    }

    /**
     * The box of a character range within a field's text.
     *
     * A range on one rendered line is exact. A range that wraps has no single box that means "these
     * characters", and neither does a field whose blocks could not all be placed — for both, the
     * element's whole box is the answer. That is a real approximation and it is stated here rather
     * than hidden: an anchor is a pointer, and a pointer to the right paragraph beats no pointer.
     */
    function textRect(at, target) {
      const spans = target.text
      if (spans === undefined || spans.length === 0) return undefined
      const startAt = coordinate(at.start)
      const endAt = coordinate(at.end)
      if (startAt === undefined || endAt === undefined) return undefined
      const length = Math.max(...spans.map((span) => span.at + span.length))
      const start = Math.min(Math.max(Math.min(startAt, endAt), 0), length)
      const end = Math.min(Math.max(Math.max(startAt, endAt), 0), length)
      const wanted = []
      if (start === end) {
        // A caret, not a range: it belongs to one run — the one whose text it sits at the head of,
        // or the last one when the caret is at the very end — and it is one pixel wide so there is
        // something to draw at the position.
        const span = spans.find((candidate) => candidate.at === start) ?? spans[spans.length - 1]
        return { left: span.rect.left, top: span.rect.top, width: 1, height: span.rect.height }
      }
      for (const span of spans) {
        const from = Math.max(start, span.at)
        const to = Math.min(end, span.at + span.length)
        // A run the range only touches at its boundary contributes nothing: `end` is exclusive.
        if (to <= from) continue
        const spanLength = span.length === 0 ? 1 : span.length
        wanted.push({
          left: span.rect.left + ((from - span.at) / spanLength) * span.rect.width,
          top: span.rect.top,
          width: ((to - from) / spanLength) * span.rect.width,
          height: span.rect.height,
        })
      }
      return unionRect(wanted)
    }

    /**
     * A `node` anchor, mapped from the SVG's user units onto the picture's box.
     *
     * The `<img>` is rendered filled (`preserveAspectRatio="none"`), so there is no letterbox to
     * account for and no offset: user units scale by width and height independently. A node the
     * table does not name — another diagram family, a key the Agent mistyped, a diagram that has not
     * drawn yet — resolves to nothing, and the caller falls back to the block box.
     */
    function nodeRect(at, target) {
      const nodes = target.nodes
      const diagram = target.diagram
      if (nodes === undefined || diagram === undefined) return undefined
      const node = nodes.nodes[at.key]
      if (node === undefined) return undefined
      const sx = nodes.w === 0 ? 1 : diagram.width / nodes.w
      const sy = nodes.h === 0 ? 1 : diagram.height / nodes.h
      return {
        left: diagram.left + node.x * sx,
        top: diagram.top + node.y * sy,
        width: node.w * sx,
        height: node.h * sy,
      }
    }

    /** The smallest box containing all of these, or `undefined` when there are none. */
    function unionRect(rects) {
      if (rects.length === 0) return undefined
      let left = Infinity
      let top = Infinity
      let right = -Infinity
      let bottom = -Infinity
      for (const rect of rects) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.left + rect.width)
        bottom = Math.max(bottom, rect.top + rect.height)
      }
      return { left, top, width: right - left, height: bottom - top }
    }

    /** Parse a JSON attribute, or `undefined` when it is absent or unusable. */
    function jsonAttribute(element, name) {
      const raw = element.getAttribute(name)
      if (raw === null || raw === undefined || raw === '') return undefined
      try {
        return JSON.parse(raw)
      } catch {
        return undefined
      }
    }

    /**
     * Every element matching `selector` inside `element` that belongs to `element`'s own block.
     *
     * "Its own" stops at the next `[data-block-id]`, and that boundary is the whole point: a group's
     * box contains its children's headings, captions and code, so a lookup that descended into them
     * would let a `{kind: 'field'}` anchor on the container resolve to a descendant's text — an arrow
     * that lands somewhere plausible and is wrong. A nested block has its own target, collected when
     * its turn comes.
     */
    function findWithin(element, selector) {
      if (element.querySelectorAll === undefined) return []
      // Comparing owners rather than requiring `element` itself to be the block: the diagram's own
      // wrapper is searched for its `<img>` and is not a `[data-block-id]`.
      const owner = element.closest?.('[data-block-id]') ?? null
      return [...element.querySelectorAll(selector)].filter((candidate) => candidate.closest('[data-block-id]') === owner)
    }

    /**
     * Measure a `text` field into runs that a character range can be resolved against.
     *
     * Two things are read: the `data-superboard-from` offset the inline renderer stamped on each
     * span, and the element's own `text-base`. The second is what makes a nested run work — the
     * `<div>` inside a `quote` starts where the quote's own source started, not at zero.
     *
     * @param root - the element carrying `data-superboard-field="text"`.
     * @param canvas - the canvas to measure against.
     * @returns `[{at, length, rect}]` in document order.
     */
    function textSpansOf(root, canvas) {
      const base = Number(root.getAttribute('data-superboard-text-base') ?? '0')
      const spans = []
      const walk = (element) => {
        for (const child of element.childNodes ?? []) {
          if (child.nodeType === 3) {
            // The offset is the owning element's, and the root's own text sits at its base.
            const at = element === root ? base : Number(element.getAttribute('data-superboard-from') ?? base)
            spans.push({ at, length: (child.data ?? '').length, rect: rectWithin(element, canvas) })
          } else if (child.nodeType === 1 && child.getAttribute('data-superboard-field') !== 'text') {
            // A nested field boundary ends this field's runs: the offsets on the other side of it
            // belong to a different field, and mixing them would place a range in the wrong place.
            walk(child)
          }
        }
      }
      walk(root)
      return spans
    }

    /**
     * Collect what an anchor can point at inside one block.
     *
     * One pass over the block, once per measurement, producing plain data. Nothing here tries to be
     * clever about what *should* be present: a kind that is not on this block contributes nothing
     * and the resolver falls back, which is what keeps a `lines` anchor on a heading from being a
     * crash rather than a slightly wrong arrow.
     *
     * @param canvas - the canvas element, which defines the coordinate space.
     * @param element - the block's own `[data-block-id]` element.
     * @returns the target object {@link anchorRect} reads.
     */
    function collectTarget(canvas, element) {
      const fields = {}
      for (const field of findWithin(element, '[data-superboard-field]')) {
        const name = field.getAttribute('data-superboard-field')
        // `frame` is not a field an anchor addresses: it is the box a normalised coordinate is
        // measured in, and it is read from the element below so the resolver has it as its own key.
        if (name === 'frame') continue
        fields[name] = rectWithin(field, canvas)
      }
      const text = []
      for (const field of findWithin(element, '[data-superboard-field="text"]')) {
        // Only the outermost: a nested one carries its own base and is reached by the walk inside.
        if (field.parentElement?.closest?.('[data-superboard-field="text"]') != null) continue
        text.push(...textSpansOf(field, canvas))
      }
      const items = {}
      for (const item of findWithin(element, '[data-superboard-item]')) {
        items[item.getAttribute('data-superboard-item')] = rectWithin(item, canvas)
      }
      const lines = []
      for (const line of findWithin(element, '[data-superboard-line]')) {
        lines[Number(line.getAttribute('data-superboard-line'))] = rectWithin(line, canvas)
      }

      const frameElement = findWithin(element, '[data-superboard-field="frame"]')[0]
      const diagramRoot = findWithin(element, '[data-superboard-diagram]')[0]
      const frame = frameElement === undefined ? undefined : rectWithin(frameElement, canvas)

      return {
        block: rectWithin(element, canvas),
        // The box a `rect`/`point` anchor is measured in, and the whole of it: a cropped `pdf-page`
        // rasterises only the crop and sizes the canvas to it, so the frame and the crop are the
        // same rectangle on screen. Mapping `crop` through the frame a second time — which is what
        // this used to do for the picture's intrinsic size — would have shrunk the frame by the
        // crop it already is.
        frame,
        fields,
        items,
        text,
        lines,
        children: {},
        nodes: diagramRoot === undefined ? undefined : jsonAttribute(diagramRoot, 'data-superboard-nodes'),
        diagram: diagramRoot === undefined ? undefined : rectWithin(findWithin(diagramRoot, 'img')[0] ?? diagramRoot, canvas),
      }
    }

    /**
     * Which block boxes each block's `child` anchor may resolve to. Pure.
     *
     * A `child` anchor names a block *inside* a group, so the answer comes from the model: only the
     * ids a group lists as its own children are reachable through it. A `childId` that names no
     * child of that group is left out, and the resolver's fallback to the group's own box is the
     * honest answer — pointing at whatever other card on the page happens to carry that id would be
     * an arrow that looks right and is about something else.
     *
     * This is also the shape that was wrong when it was written inline: walking one map of
     * `[id, target]` pairs and assigning `target.children[id]` gives every block an entry for itself
     * and for nothing else, because `id` moves with `target`. Hence a function with a test.
     *
     * @param blocks - the page's blocks; a group carries its children's ids.
     * @param boxes - a `Map` of block id to the box measured for it.
     * @returns a `Map` of block id to `{[childId]: box}`, for the blocks that own children.
     */
    function childrenByParent(blocks, boxes) {
      const owned = new Map()
      for (const block of blocks) {
        const ids = block.children ?? []
        if (ids.length === 0) continue
        const children = {}
        for (const childId of ids) {
          const box = boxes.get(`${childId}`)
          if (box !== undefined) children[`${childId}`] = box
        }
        owned.set(`${block.id}`, children)
      }
      return owned
    }

    /**
     * One element's box, in the canvas's content coordinates.
     *
     * The same conversion the block measurement uses: viewport rect minus the canvas's own rect,
     * plus the scroll offset, so the numbers stay right while the canvas is scrolled.
     */
    function rectWithin(element, canvas) {
      const box = element.getBoundingClientRect()
      const base = canvas.getBoundingClientRect()
      return {
        left: box.left - base.left + canvas.scrollLeft,
        top: box.top - base.top + canvas.scrollTop,
        width: box.width,
        height: box.height,
      }
    }

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
          const targets = new Map()
          for (const element of container.querySelectorAll('[data-block-id]')) {
            targets.set(element.getAttribute('data-block-id'), collectTarget(container, element))
          }
          // A `child` anchor names a block *inside* the group; `childrenByParent` decides which ids
          // that is, from the model. The DOM only knows the blocks nest.
          const boxes = new Map()
          for (const [id, target] of targets) boxes.set(id, target.block)
          for (const [id, children] of childrenByParent(blocks, boxes)) {
            const target = targets.get(id)
            if (target !== undefined) target.children = children
          }

          const paths = []
          for (const edge of edges) {
            const fromTarget = targets.get(edge.from.blockId)
            const toTarget = targets.get(edge.to.blockId)
            // An edge whose endpoint is on another page is simply not drawn here. That is counted
            // in the page header rather than logged, so a reader can tell "no such edge" from
            // "drawn elsewhere".
            if (fromTarget === undefined || toTarget === undefined) continue
            const from = anchorRect(edge.from.at, fromTarget)
            const to = anchorRect(edge.to.at, toTarget)
            paths.push({ edge, d: routeBetween(from, to, edge.waypoints), label: pathMidpoint(from, to, edge.waypoints) })
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
        state.paths.map(({ edge, d, label }) =>
          h(
            'g',
            { key: edge.id },
            h(
              'path',
              {
                // Names the path so anyone inspecting a rendered board can tell which edge drew which
                // line. The label below is a plain `<text>` at the curve's midpoint rather than a
                // `textPath` riding this path, so nothing references the id — see that element for
                // why.
                id: edgePathId(edge.id),
                d,
                fill: 'none',
                stroke: 'var(--dsw-alias-label-tertiary)',
                strokeWidth: 1.5,
                strokeDasharray: edge.style === 'dashed' ? '6 4' : edge.style === 'dotted' ? '2 3' : undefined,
                markerEnd: 'url(#sb-arrow)',
              },
              // Kept as well as the visible label below: the `<title>` is what a screen reader and a
              // hover announce, and the chip is what a screenshot and a film show. Neither replaces
              // the other.
              edge.label === undefined ? null : h('title', null, edge.label),
            ),
            edge.label === undefined || label === undefined
              ? null
              : h(
                  'text',
                  {
                    className: 'sb-edgeLabel',
                    x: round(label.x),
                    y: round(label.y),
                    textAnchor: 'middle',
                    // Centred on the curve's midpoint rather than riding a `textPath`. A textPath
                    // squeezes its glyphs through a tight bend and turns a short label into a smear,
                    // and the board's arrows bend a lot; a label that stops being readable to prove
                    // it follows the line is the wrong trade. Text also reads best upright, so it is
                    // not rotated onto the tangent.
                    dominantBaseline: 'central',
                  },
                  h('rect', {
                    className: 'sb-edgeLabelChip',
                    // A plate, sized from the text: `0.62em` is a hair over half an em per glyph,
                    // which is right for a mixed Chinese/Latin label and errs wide rather than tight.
                    x: round(-0.31 * edge.label.length * 10 - 3),
                    y: -8,
                    width: round(0.62 * edge.label.length * 10 + 6),
                    height: 16,
                    rx: 8,
                  }),
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
        // The label's own position too: a label whose endpoint moved would otherwise keep the chip
        // where the label used to be, which reads as a label belonging to the wrong arrow.
        if (left[index].label?.x !== right[index].label?.x || left[index].label?.y !== right[index].label?.y) return false
      }
      return true
    }

    /** A stable DOM id for one edge's path, so a label can address it. */
    function edgePathId(edgeId) {
      return `sb-edge-${String(edgeId).replace(/[^A-Za-z0-9_-]/g, '')}`
    }

    /**
     * The points an arrow with `waypoints` calls at, in canvas coordinates, in order.
     *
     * A waypoint is normalised to **the box spanning the two endpoint rectangles**
     * (`docs/design/board-model.md`'s edge section, and `src/tools.js`'s `add_edge`), not to either
     * endpoint and not to the canvas: the author is saying "and on the way, through here", where
     * "here" is a place in the gap between the two cards. Normalising to that gap is what keeps a
     * waypoint attached to the two blocks it joins rather than to the page, so a re-layout that
     * moves both cards moves the detour with them.
     *
     * @param from - the source box, in canvas content coordinates.
     * @param to - the target box.
     * @param waypoints - `[{x, y}]` in `[0, 1]`, or `undefined`.
     * @returns the mapped points, dropping any that are not two finite numbers.
     */
    function viaPoints(from, to, waypoints) {
      if (!Array.isArray(waypoints)) return []
      const gap = unionRect([from, to])
      if (gap === undefined) return []
      const points = []
      for (const waypoint of waypoints) {
        const x = coordinate(waypoint?.x)
        const y = coordinate(waypoint?.y)
        // One unreadable waypoint is dropped rather than taken as the origin: a detour through the
        // corner of the gap is a visible lie, and the rest of the author's waypoints are still
        // exactly where they were asked to be.
        if (x === undefined || y === undefined) continue
        points.push({ x: gap.left + unit(x) * gap.width, y: gap.top + unit(y) * gap.height })
      }
      return points
    }

    /**
     * Route an arrow between two boxes.
     *
     * A cubic curve leaving the source's nearest side and arriving at the target's facing side,
     * which reads well for both a vertical flow and a side-by-side pair without needing a
     * general graph router.
     *
     * With waypoints the curve is replaced by straight segments through them. A corner at a waypoint
     * is the point of a waypoint — it is the one place on the board where the author said exactly
     * where the line goes — and a curve smoothed through them would move the line off the place it
     * was put. The departure and arrival points are the same either way, so an edge gains a detour
     * without changing where it leaves or lands.
     *
     * @param from - the source box, in canvas content coordinates.
     * @param to - the target box.
     * @param waypoints - `[{x, y}]` in `[0, 1]` of the box spanning `from` and `to`, or `undefined`.
     * @returns the SVG path data.
     */
    function routeBetween(from, to, waypoints) {
      const curve = curvePoints(from, to)
      if (curve === undefined) return ''
      const via = viaPoints(from, to, waypoints)
      if (via.length === 0) {
        const { start, c1, c2, end } = curve
        return `M ${round(start.x)} ${round(start.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(end.x)} ${round(end.y)}`
      }
      const points = [curve.start, ...via, curve.end]
      return `M ${round(points[0].x)} ${round(points[0].y)} ${points
        .slice(1)
        .map((point) => `L ${round(point.x)} ${round(point.y)}`)
        .join(' ')}`
    }

    /**
     * The point halfway along a polyline, measured along it rather than by counting vertices.
     *
     * The label of an edge with waypoints has to sit on the line the way the curved one does, and
     * "halfway" for a broken line is half its *length*: halfway between the first and last vertex is
     * not on the line at all once there is a detour in it.
     *
     * @param points - the vertices, in order. At least two.
     * @returns `{x, y}`, or `undefined` for a line of no length.
     */
    function polylineMidpoint(points) {
      if (points.length < 2) return undefined
      const legs = []
      let total = 0
      for (let index = 1; index < points.length; index += 1) {
        const length = Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y)
        legs.push(length)
        total += length
      }
      if (total === 0) return undefined
      let want = total / 2
      for (let index = 0; index < legs.length; index += 1) {
        if (want <= legs[index]) {
          const share = legs[index] === 0 ? 0 : want / legs[index]
          return {
            x: points[index].x + (points[index + 1].x - points[index].x) * share,
            y: points[index].y + (points[index + 1].y - points[index].y) * share,
          }
        }
        want -= legs[index]
      }
      return points[points.length - 1]
    }

    /**
     * Which edges a page draws and which ones it can only allude to.
     *
     * An edge is drawn here only when **both** endpoints are blocks of this page, and an edge with
     * exactly one endpoint here is the case that used to be invisible. It is not a defect of the
     * model — a cross-page edge is a legitimate thing to write, and `board_query` answers for it —
     * but a reader looking at the page could not tell "the Agent wrote no such edge" from "the edge
     * is drawn on the page the other block lives on". Those are different states of the board and
     * they must not look the same.
     *
     * @param edges - every edge in the model.
     * @param blockIds - the ids of the blocks on this page.
     * @returns `{ drawn, cross }`.
     */
    function countEdges(edges, blockIds) {
      let drawn = 0
      let cross = 0
      for (const edge of edges) {
        const from = blockIds.has(edge.from.blockId)
        const to = blockIds.has(edge.to.blockId)
        if (from && to) drawn += 1
        else if (from || to) cross += 1
      }
      return { drawn, cross }
    }

    /**
     * A cubic curve leaving the source's nearest side and arriving at the target's facing side.
     *
     * The control points, not the path string: an edge is drawn *and* annotated, and a label placed
     * from a second, separately derived curve would eventually sit somewhere the line does not go.
     *
     * @returns `{start, c1, c2, end, vertical}`, or `undefined` when both boxes have the same centre.
     */
    function curvePoints(from, to) {
      const fromCenter = { x: from.left + from.width / 2, y: from.top + from.height / 2 }
      const toCenter = { x: to.left + to.width / 2, y: to.top + to.height / 2 }
      const dx = toCenter.x - fromCenter.x
      const dy = toCenter.y - fromCenter.y
      if (dx === 0 && dy === 0) return undefined
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
      return { start, c1, c2, end, vertical }
    }

    /**
     * Where an edge's label sits.
     *
     * The curve's own midpoint — the point at `t = 0.5`, not the midpoint of the straight line
     * between the endpoints. On a bowed arrow those are visibly different: the chord's midpoint can
     * sit a third of the arrow's length off the line it is supposed to annotate.
     *
     * Halfway is where the arrowhead is not. The `refX: 9` marker is drawn at the end, and a label
     * anywhere near it would either collide with it or read as part of it.
     *
     * @returns `{x, y}`, or `undefined` for two boxes with the same centre — a degenerate curve has
     *   no midpoint worth naming.
     */
    function curveMidpoint(from, to) {
      const curve = curvePoints(from, to)
      if (curve === undefined) return undefined
      // A cubic Bezier at t = 1/2 is (P0 + 3P1 + 3P2 + P3) / 8.
      return {
        x: (curve.start.x + 3 * curve.c1.x + 3 * curve.c2.x + curve.end.x) / 8,
        y: (curve.start.y + 3 * curve.c1.y + 3 * curve.c2.y + curve.end.y) / 8,
      }
    }

    /**
     * Where an edge's label sits, for whichever route the edge takes.
     *
     * One function rather than a choice at the call site: the label and the line it annotates are
     * derived from the same route or the label ends up beside the arrow instead of on it, and the
     * caller should not have to know which shape it asked for to know where the middle is.
     *
     * @param waypoints - as {@link routeBetween}.
     * @returns `{x, y}`, or `undefined` for a route with no middle worth naming.
     */
    function pathMidpoint(from, to, waypoints) {
      const via = viaPoints(from, to, waypoints)
      if (via.length > 0) {
        const curve = curvePoints(from, to)
        return curve === undefined ? undefined : polylineMidpoint([curve.start, ...via, curve.end])
      }
      return curveMidpoint(from, to)
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
     * Which gesture a drag that starts here should mean: text, or a marquee.
     *
     * The user asked for origin dispatch — start on text and you get a text selection, start
     * anywhere else and you get the rectangle. Getting "on text" right is the whole problem,
     * because the obvious test is wrong twice over:
     *
     *   1. `caretRangeFromPoint` **always snaps to the nearest text node**, so a card's padding,
     *      its gutter and the blank run below it all report a caret sitting in real prose. Measured
     *      on a card whose paragraph is one line: a point 3px inside the card's bottom edge
     *      classified as text.
     *   2. The caret's node is not the thing being hit. A point 4px to the left of a paragraph
     *      reported that paragraph's own text node.
     *
     * So the answer has to be "is this point inside a *rendered line box* of that text", not "is
     * there text nearby". The line boxes come from a `Range` over the text node's host element,
     * which is what the browser actually laid out — no font metrics are guessed, and a wrapped
     * paragraph contributes one rect per line, so the gap between two wrapped lines correctly
     * counts as blank.
     *
     * Three outcomes, and the middle one is why this returns a reason rather than a boolean:
     * `text` starts the browser's selection, `marquee` draws the rectangle, and `chrome` is a
     * marquee whose pointer is over a card's label — the same thing, but it says so.
     *
     * @param clientX - pointer x in viewport coordinates.
     * @param clientY - pointer y in viewport coordinates.
     * @param env - the DOM to read, defaulting to the real one. Injected because this is the one
     *   classifier here that cannot be pure, and the failure worth pinning is reading the *wrong*
     *   thing rather than throwing — a fake that records which reads happened is the only way to
     *   test that without a browser.
     * @returns `{ mode, card }` where mode is `'text' | 'marquee' | 'chrome'`.
     */
    function originAt(clientX, clientY, env) {
      const doc = env?.document ?? (typeof document === 'undefined' ? undefined : document)
      const styles = env?.getComputedStyle ?? (typeof getComputedStyle === 'undefined' ? undefined : getComputedStyle)
      if (doc === undefined) return { mode: 'marquee', card: null }
      const target = doc.elementFromPoint(clientX, clientY)
      const card = target?.closest?.('[data-block-id]') ?? null
      if (card === null) return { mode: 'marquee', card: null }
      // Chrome that is deliberately unselectable is marquee area by construction.
      if (target.closest?.('.sb-cardHead, .sb-groupHead') != null) return { mode: 'chrome', card }
      const caret = doc.caretRangeFromPoint?.(clientX, clientY) ?? null
      if (caret === null) return { mode: 'marquee', card }
      const node = caret.startContainer
      // A caret in an element rather than a text node means there is no character under the
      // pointer — an image, a diagram's frame, the gap between two cards.
      if (node.nodeType !== 3 || String(node.data).trim() === '') return { mode: 'marquee', card }
      const host = node.parentElement
      if (host === null) return { mode: 'marquee', card }
      if (styles(host).userSelect === 'none') return { mode: 'marquee', card }
      const line = doc.createRange()
      line.selectNodeContents(host)
      for (const rect of line.getClientRects()) {
        // The 1px slack absorbs sub-pixel rounding at the ends of a line; without it a click on
        // the very first character could fall outside the rect it belongs to.
        if (clientY >= rect.top && clientY <= rect.bottom && clientX >= rect.left - 1 && clientX <= rect.right + 1) {
          return { mode: 'text', card }
        }
      }
      return { mode: 'marquee', card }
    }

    /**
     * The blocks a live selection covers, for the bar and the payload.
     *
     * `Range.intersectsNode` is the honest test: it is true when the range touches any part of the
     * element, including a bare newline between two cards. That is what "selecting text auto-selects
     * the blocks it touches" means, and across cards it is exactly the behaviour asked for.
     *
     * @param selection - a `Selection`, or null.
     * @param root - the element to search within.
     * @returns the set of block ids the selection touches.
     */
    function textSelectionBlocks(selection, root) {
      const hits = new Set()
      if (selection === null || selection === undefined) return hits
      if (selection.rangeCount === 0 || selection.isCollapsed || root === null) return hits
      const range = selection.getRangeAt(0)
      for (const element of root.querySelectorAll('[data-block-id]')) {
        if (range.intersectsNode(element)) hits.add(element.getAttribute('data-block-id'))
      }
      return hits
    }

    /**
     * Read the live selection as text, normalised.
     *
     * `toString()` on a selection that crosses two cards yields the newline-and-indent soup between
     * them, so the whitespace is collapsed as it is read. The exact characters matter — this text is
     * what a copy puts on the clipboard and what the Agent is told the user pointed at.
     *
     * @param selection - a `Selection`, or null.
     * @returns the selected text, or `''`.
     */
    function textSelectionText(selection) {
      // Anything that is not a real selection still has an inherited `Object.prototype.toString`,
      // which returns the genuine string "[object Object]" — so checking the *result* is not enough
      // to keep that literal text out of the Agent's feedback. The interface is checked instead:
      // `rangeCount` is what a `Selection` has and a stray object does not.
      if (typeof selection?.rangeCount !== 'number') return ''
      const raw = selection.toString()
      if (typeof raw !== 'string') return ''
      return raw.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
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
      // The exact characters, when the user dragged over text. This is the whole point of the text
      // gesture: the Agent otherwise has to guess which sentence inside a block was meant, and a
      // one-line block is the only case where the block *is* the answer.
      if (typeof item.text === 'string' && item.text.trim() !== '') {
        lines.push('选中文字：')
        lines.push(
          item.text
            .trim()
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        )
      }
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

      // A table needs two lines to exist, so it cannot be recognised from one — it is a
      // lookahead, not a line shape. Only the header-plus-separator pair starts one.
      const isTableStart = (at) =>
        at + 1 < lines.length &&
        splitTableRow(lines[at]) !== null &&
        isTableSeparator(lines[at + 1])

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

        if (isTableStart(index)) {
          const header = splitTableRow(lines[index])
          const align = tableAlignments(lines[index + 1])
          index += 2
          const rows = []
          while (index < lines.length && lines[index].trim() !== '') {
            const cells = splitTableRow(lines[index])
            if (cells === null) break
            rows.push(cells)
            index += 1
          }
          blocks.push({ type: 'table', header, align, rows })
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
        while (
          index < lines.length &&
          lines[index].trim() !== '' &&
          !startsBlock(lines[index]) &&
          !isTableStart(index)
        ) {
          paragraph.push(lines[index])
          index += 1
        }
        if (paragraph.length > 0) blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
      }

      return blocks
    }

    /**
     * Split one table row into cells, or null when the line is not a row at all.
     *
     * A row must contain a pipe; requiring one is what keeps a bare `---` a thematic break
     * instead of an empty table. An escaped `\|` belongs to its cell and does not split.
     *
     * @param line - the raw line.
     * @returns the trimmed cells, or null.
     */
    function splitTableRow(line) {
      if (!String(line).includes('|')) return null
      const trimmed = String(line).trim().replace(/^\|/u, '').replace(/\|$/u, '')
      if (trimmed === '') return null
      return trimmed.split(/(?<!\\)\|/u).map((cell) => cell.replace(/\\\|/gu, '|').trim())
    }

    /**
     * Whether a line is the `|---|:--:|` row that makes the line above it a header.
     *
     * This is the whole table rule: without a separator there is no table, and the pipe lines
     * stay literal text. Fail inert.
     *
     * @param line - the candidate separator line.
     * @returns whether every cell is a dash run with optional colons.
     */
    function isTableSeparator(line) {
      const cells = splitTableRow(line)
      if (cells === null || cells.length === 0) return false
      return cells.every((cell) => /^:?-+:?$/u.test(cell))
    }

    /**
     * Per-column alignment, read from the separator row's colons.
     *
     * @param line - the separator line.
     * @returns one of `'left'`, `'right'`, `'center'` per column.
     */
    function tableAlignments(line) {
      return (splitTableRow(line) ?? []).map((cell) => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        if (left && right) return 'center'
        return right ? 'right' : 'left'
      })
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
     * @param props - `{ text, className, base }`, where `base` is the offset of `text` within the
     *   field it belongs to, so a nested run's character offsets are the field's.
     * @returns the rendered element.
     */
    function Markdown({ text, className, base }) {
      const blocks = parseMarkdownBlocks(text)
      let at = base ?? 0
      const rendered = blocks.map((block, index) => {
        const element = renderMarkdownBlock(block, `md${index}`, at)
        at += markdownSourceLength(block)
        return element
      })
      return h(
        'div',
        {
          className: className === undefined ? 'sb-md' : `sb-md ${className}`,
          // Read by a `text` anchor. `text-base` is where this container's rendered text starts in
          // the *field's* text — non-zero only for a run nested inside another, such as a quote.
          'data-superboard-field': 'text',
          'data-superboard-text-base': base ?? 0,
        },
        rendered,
      )
    }

    /**
     * How many characters of the source one markdown block accounts for.
     *
     * Used to advance a `text` anchor's origin past each block. Only a paragraph, a heading and a
     * single-line list item are the block's own text; everything else — the pipes of a table, a
     * quote's nested source — has no single character range that means anything, so those report an
     * upper bound. The price of being generous is that an anchor inside a *later* block of a
     * multi-block card lands somewhere in the right paragraph rather than exactly on the word, which
     * is why the renderer's job is to be close and the resolver's job is to be honest about it.
     */
    function markdownSourceLength(block) {
      if (block.type === 'paragraph') return block.text.length
      if (block.type === 'heading') return block.text.length
      if (block.type === 'code') return block.text.length
      if (block.type === 'list') return block.items.reduce((total, item) => total + item.text.length, 0)
      return JSON.stringify(block).length
    }

    /** Render one block descriptor. */
    function renderMarkdownBlock(block, key, base) {
      const from = base ?? 0
      switch (block.type) {
        case 'code':
          return h(
            'pre',
            { className: 'sb-code', key },
            block.lang === '' ? null : h('div', { className: 'sb-codeLang' }, block.lang),
            h('code', { className: codeClass(block.lang), 'data-superboard-from': from }, block.text),
          )
        case 'heading': {
          const level = Math.min(Math.max(block.level, 1), 6)
          return h(
            `h${level}`,
            { className: `sb-mdH sb-mdH${level}`, key },
            renderInline(parseInline(block.text), key, from),
          )
        }
        case 'quote':
          return h(
            'blockquote',
            { className: 'sb-mdQuote', key },
            h(Markdown, { text: block.text, className: 'sb-mdInner', base: from }),
          )
        case 'list': {
          let itemAt = from
          return h(
            block.ordered ? 'ol' : 'ul',
            { className: 'sb-mdList', key },
            block.items.map((item, position) => {
              const element = h(
                'li',
                { key: `${key}-${position}`, style: item.depth > 0 ? { marginLeft: item.depth * 14 } : undefined },
                renderInline(parseInline(item.text), `${key}-${position}`, itemAt),
              )
              itemAt += item.text.length
              return element
            }),
          )
        }
        case 'table': {
          // Ragged tables are normal in the wild, so the grid is as wide as its widest row and
          // a short row is padded rather than silently clipped.
          const width = block.rows.reduce(
            (widest, row) => Math.max(widest, row.length),
            block.header.length,
          )
          const alignClass = (position) =>
            block.align[position] === 'right'
              ? 'sb-mdAlignRight'
              : block.align[position] === 'center'
                ? 'sb-mdAlignCenter'
                : undefined
          const cell = (content, position, tag) =>
            h(
              tag,
              { key: `${key}-${tag}${position}`, className: alignClass(position) },
              renderInline(parseInline(content), `${key}-${tag}${position}`),
            )
          const columns = Array.from({ length: width }, (unused, position) => position)
          return h(
            'div',
            { className: 'sb-mdTableWrap', key },
            h('table', { className: 'sb-mdTable' }, [
              h(
                'thead',
                { key: `${key}-head` },
                h(
                  'tr',
                  null,
                  columns.map((position) => cell(block.header[position] ?? '', position, 'th')),
                ),
              ),
              h(
                'tbody',
                { key: `${key}-body` },
                block.rows.map((row, rowIndex) =>
                  h(
                    'tr',
                    { key: `${key}-row${rowIndex}` },
                    columns.map((position) => cell(row[position] ?? '', position, 'td')),
                  ),
                ),
              ),
            ]),
          )
        }
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
      // Two selectors, and the split is load-bearing.
      //
      // `nodes` is a *stable* keyed store: the Chat builder hands back the same
      // `MutableChatNodeStore` instance on every publication — `snapshot()` returns
      // `{ order: this.order, nodes: this.store, … }` and `this.store` is created once in the
      // constructor (`chat-snapshot-builder.ts:1172-1184`). So a selector over `nodes` compares
      // equal forever, React bails out of the re-render, and the column only caught up when
      // something *else* remounted it. That is the "switch tabs and come back" the user sees, and
      // it is also why removing the old `generation` counter appeared to break nothing until now.
      //
      // `order` is rebuilt whenever the visible node set changes — prepending a page of history is
      // exactly that (`replace()` at `chat-snapshot-builder.ts:1084-1090`), and the official chat
      // view subscribes to it for the same reason (`ChatView.tsx:106`).
      //
      // The store is still read live through `values()`, which is why it does not need to change
      // identity. The memo must depend on `order` as well, or it would keep serving the old list
      // out of its cache even when the render does happen.
      const order = typeof useChat === 'function' ? useChat((snapshot) => snapshot?.order) : undefined
      const nodeStore = typeof useChat === 'function' ? useChat((snapshot) => snapshot?.nodes) : undefined
      const [loading, setLoading] = React.useState(false)
      const scrollRef = React.useRef(null)
      const pinnedRef = React.useRef(true)

      const turns = React.useMemo(
        () => dialogueFromChat(nodeStore === undefined ? undefined : { nodes: nodeStore }),
        [nodeStore, order],
      )
      void sessionId

      // A boolean, not a getter: the caller reads it from the session snapshot, so a page landing
      // re-renders this on its own.
      const canLoadOlder = hasOlder === true

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
                className: 'sb-button sb-buttonOutline sb-readerMore',
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
      useSession,
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
      /**
       * The user's exact text selection, or `''`.
       *
       * Held in state rather than read from the DOM at send time because the selection is gone by
       * then: the bar's own input takes focus, and focusing another element collapses the
       * document's selection. The text has to be captured while it is still live.
       */
      const [selectedText, setSelectedText] = React.useState('')
      /** Whether the current selection came from dragging over text, for the bar's wording. */
      const [byText, setByText] = React.useState(false)
      /**
       * Set when the pointer is down on a rectangle drag, so `selectionchange` does not fight it.
       *
       * A marquee drag through prose makes the browser try to select that prose as well (the
       * suppression class stops the *result* but not the caret work), and each of those events
       * would otherwise clear the block selection the rectangle is about to establish.
       */
      const marqueeRef = React.useRef(false)
      /**
       * Swallow the `selectionchange` caused by our own `removeAllRanges()`.
       *
       * That event is delivered *after* the pointerup handler has returned, at which point
       * `marqueeRef` is already false and a collapsed selection looks exactly like a click that
       * should clear the selection — so the rectangle's own result would be erased a tick after it
       * was computed. Only armed when there really was a selection to drop, so a no-op removal
       * cannot leave the flag set and eat a later, genuine event.
       */
      const ignoreSelectionRef = React.useRef(false)
      /** The question the user is writing about the current selection. */
      const [note, setNote] = React.useState('')
      /** Set while a selection is being handed to the composer. */
      const [sending, setSending] = React.useState(false)
      const [sendError, setSendError] = React.useState(null)
      // Read at the top because hooks cannot live inside the handler. Appending rather than
      // replacing matters: the user may already have been typing when they marqueed. The snapshot
      // is guarded because `useInput` resolves to the composer's shell state, which is `undefined`
      // until the composer mounts — and a throw here would blank the whole pane.
      const draft = typeof useInput === 'function' ? useInput((snapshot) => snapshot?.draft) : undefined
      // Whether older history remains. Read through the hook rather than off the session object:
      // the object's field only changes on a re-render something else caused, which is why the
      // button used to do nothing until the user left the tab and came back.
      const hasOlder = typeof useSession === 'function' ? useSession((snapshot) => snapshot?.hasMore === true) : false

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
        setSelectedText('')
        setByText(false)
        setMarquee(null)
      }, [pageId])

      /**
       * Mirror the browser's own text selection into the board's selection state.
       *
       * This is the bridge that makes "select text" and "select blocks" one gesture instead of two.
       * The browser owns the highlight; this only observes it. Measured, one drag over three cards
       * fires six `selectionchange` events, so the bar tracks the highlight live rather than
       * appearing only on release.
       *
       * The rectangle drag has to be excluded by hand: `sb-picking` stops the browser from painting
       * a selection, but the events still fire with a collapsed range, and acting on them would
       * clear the very selection the rectangle is computing.
       */
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onSelectionChange = () => {
          if (marqueeRef.current) return
          if (ignoreSelectionRef.current) {
            ignoreSelectionRef.current = false
            return
          }
          const selection = document.getSelection()
          const root = containerRef.current
          if (root === null) return
          const inside =
            selection !== null &&
            selection.rangeCount > 0 &&
            root.contains(selection.getRangeAt(0).commonAncestorContainer)
          // A selection that lives outside the canvas (the reading column, the bar's own note field,
          // the composer) is not the board's business. Without this, clicking into the note field
          // would collapse the document selection and clear the selection the bar is describing.
          if (!inside) return
          const text = textSelectionText(selection)
          const hits = textSelectionBlocks(selection, root)
          // A collapsed caret is a click. Inside the canvas that means "clear", which is the
          // conventional meaning and what the marquee path does for a click too — but only when
          // something is actually selected, so the state is not rewritten on every idle click.
          if (text === '' && hits.size === 0) {
            setSelected((current) => (current.size === 0 ? current : new Set()))
            setSelectedText((current) => (current === '' ? current : ''))
            setByText(false)
            return
          }
          setSelected(hits)
          setSelectedText(text)
          setByText(true)
        }
        document.addEventListener('selectionchange', onSelectionChange)
        return () => document.removeEventListener('selectionchange', onSelectionChange)
      }, [pageId])

      const pageBlocks = activePage?.blocks ?? []
      const blockIds = new Set(pageBlocks.map((block) => block.id))
      // The arrows this page can actually draw: both endpoints here. The header reports the ones it
      // cannot — see `countEdges` — because "drawn on another page" and "not an edge" must not look
      // the same.
      const pageEdges = (model?.edges ?? []).filter(
        (edge) => blockIds.has(edge.from.blockId) && blockIds.has(edge.to.blockId),
      )
      const edgeCounts = countEdges(model?.edges ?? [], blockIds)
      const slugOf = (id) => pageBlocks.find((block) => block.id === id)?.slug ?? id

      /** Block id to block, for resolving a container's children without rescanning. */
      const byId = new Map(pageBlocks.map((block) => [block.id, block]))
      /** Region id to region, for toning a block without a lookup per block. */
      const regions = new Map((model?.regions ?? []).map((region) => [region.id, region]))

      /**
       * Resolve a block address across the whole board, not just the visible page.
       *
       * A selection can include an edge whose other endpoint lives on another page, and printing
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
       * Clamp and remember the reading column's width.
       *
       * `Splitter` reports an absolute width in pixels, already derived from the pointer position.
       * The cap is a **fraction of the pane** rather than a fixed number, so the board keeps the
       * majority of the width at every window size — the column is a reference beside the board,
       * not a second board. Persisting on every move is deliberate: a drag is already a burst of
       * pointer events, and one `localStorage` write per frame costs less than losing the width
       * when the drag ends outside the window.
       */
      const resizeColumn = (next) => {
        const total = containerRef.current?.clientWidth ?? 0
        const cap = total > 0 ? Math.max(COLUMN_MIN_WIDTH, Math.round(total * COLUMN_MAX_FRACTION)) : next
        const clamped = Math.min(Math.max(Math.round(next), COLUMN_MIN_WIDTH), cap)
        setColumnWidth(clamped)
        writeNumber(COLUMN_WIDTH_KEY, clamped)
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
        // Origin dispatch (the user's chosen gesture): a drag beginning on rendered text is the
        // browser's selection and is left completely alone — no rectangle, no suppression, and no
        // `preventDefault`. Starting anywhere else owns the gesture, and the canvas draws a
        // rectangle.
        //
        // The class goes on here, imperatively, rather than through React state: it must be in
        // effect before the browser begins extending a selection on the first `pointermove`, and a
        // state update would land a frame late. It is also only ever *added* at pointerdown —
        // measured, adding `user-select:none` to an element whose text is already selected wipes
        // that selection, so setting it mid-drag would destroy the highlight under the user's
        // cursor.
        const origin = originAt(event.clientX, event.clientY)
        if (origin.mode === 'text') {
          dragRef.current = null
          return
        }
        containerRef.current?.classList.add('sb-picking')
        marqueeRef.current = true
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
        // A text drag has no rectangle to resolve; the browser already did the work, and
        // `onSelectionChange` mirrors it into the selection state.
        if (drag === null) {
          containerRef.current?.classList.remove('sb-picking')
          marqueeRef.current = false
          return
        }
        if (drag.pointerId !== event.pointerId) return
        dragRef.current = null
        marqueeRef.current = false
        containerRef.current?.classList.remove('sb-picking')
        const rect = normaliseRect(drag.start, canvasPoint(event))
        setMarquee(null)

        // A click rather than a drag clears the selection, which is the conventional meaning.
        if (rect.width < 4 && rect.height < 4) {
          setSelected(new Set())
          setSelectedText('')
          setByText(false)
          return
        }

        // The rectangle replaces any text selection, including the highlight the browser may have
        // painted while the drag passed over prose. The flag suppresses the `selectionchange` this
        // causes, which would otherwise arrive after `marqueeRef` was already cleared and be read as
        // a click — erasing the selection computed just below.
        const live = document.getSelection()
        if (live !== null && live.rangeCount > 0) {
          ignoreSelectionRef.current = true
          live.removeAllRanges()
        }
        setSelectedText('')
        setByText(false)

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
        // The user's exact characters, when there are any. Carried in the payload as its own field
        // rather than folded into a block's text: the Agent has to be able to tell "the user pointed
        // at this sentence" from "this whole block is the answer".
        if (selectedText.trim() !== '') payload.text = selectedText
        // The same shape the clipboard copy used, so what the Agent reads inline and what it would
        // have received as text cannot drift apart.
        const summary = formatFeedback({
          pageSlug: activePage?.slug ?? '',
          rev: model?.rev ?? '',
          blocks: blocks.map((block) => block.slug),
          edges,
          note,
          text: selectedText,
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
          setSelectedText('')
          setByText(false)
        } catch (error) {
          setSendError(error instanceof Error ? error.message : String(error))
        } finally {
          setSending(false)
        }
      }

      if (model === undefined) {
        return h(
          'div',
          { className: 'sb-root', 'data-superboard': '', 'data-conversation-composer-overlay': '' },
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
        { className: 'sb-root', 'data-superboard': '', 'data-conversation-composer-overlay': '' },
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
              // Only when there is one to report. A badge that is always present, and usually reads
              // zero, is furniture; this one appears exactly when the page is not showing everything
              // it is part of, which is when a reader needs to know.
              edgeCounts.cross > 0 &&
                h(
                  'span',
                  { className: 'sb-crossPage' },
                  `${edgeCounts.cross} 条边连到其他页`,
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
                    sessionId,
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
              text: selectedText,
              byText,
              onSend: () => void stageFeedback(),
              onCancel: () => {
                document.getSelection()?.removeAllRanges?.()
                setSelected(new Set())
                setSelectedText('')
                setByText(false)
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
    function Block({ block, selected, region, cell, sessionId }) {
      // A region is annotation, so it tints the block and adds its label — it never moves anything.
      const tone = region?.tone === undefined || region.tone === 'neutral' ? '' : ` sb-tone-${region.tone}`
      return h(
        'article',
        {
          className: `sb-card${selected ? ' sb-cardSel' : ''}${tone}`,
          // A named cell is placement by the container's own template. It is spread last so it wins
          // over nothing in particular — the card carries no geometry of its own by design.
          style: cellStyle(cell),
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
        renderBlockBody(block, sessionId),
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
     * @param props - `{ blocks, layout, width, selected, byId, regions, sessionId }`.
     * @returns the rendered level.
     */
    function BlockTree({ blocks, layout, width, selected, byId, regions, sessionId }) {
      const roots = rootBlocksOf(blocks)
      const cells = layout?.params?.cells
      return h(
        'div',
        {
          className: layoutClass(layout),
          style: layoutStyle(layout, width),
        },
        roots.map((block) =>
          h(BlockNode, {
            key: block.id,
            block,
            width,
            selected,
            byId,
            regions,
            sessionId,
            cell: cells?.[block.id],
          }),
        ),
      )
    }

    /** One node of the tree: a container, or a leaf block. */
    function BlockNode({ block, width, selected, byId, regions, cell, sessionId }) {
      const region = block.regionId === undefined ? undefined : regions.get(block.regionId)

      if (block.kind !== 'group') return h(Block, { block, selected: selected.has(block.id), region, cell, sessionId })

      const children = (block.children ?? []).map((id) => byId.get(id)).filter((child) => child !== undefined)
      const innerCells = block.layout?.params?.cells
      return h(
        'section',
        {
          // Exactly one element per group carries the layout: the body below, which is the one
          // that arranges the children. The box stays a plain flex column so its two rows — the
          // head and the body — behave the same whatever the children are arranged with.
          className: 'sb-groupBox',
          // A group is itself a child of something, so the cell it was given belongs on the box.
          style: cellStyle(cell),
          'data-block-id': block.id,
          'data-block-slug': block.slug,
          'data-superboard-group': '',
        },
        h(
          'div',
          { className: 'sb-groupHead' },
          h(
            'span',
            {
              className: 'sb-slug',
              // A slug is the address and a title is the label; when the Agent uses the same words
              // for both, printing them twice reads as a rendering fault rather than as information
              // — so this span is what prints the title in that case, and it is the `title` field
              // for the same reason the span below is when the two differ.
              'data-superboard-field': block.title !== undefined && block.title === block.slug ? 'title' : undefined,
            },
            block.slug,
          ),
          block.title !== undefined &&
            block.title !== block.slug &&
            h('span', { className: 'sb-groupTitle', 'data-superboard-field': 'title' }, block.title),
          h('span', { className: 'sb-kind' }, `${children.length} 项`),
          region?.label !== undefined && h('span', { className: `sb-regionTag sb-tone-${region.tone ?? 'neutral'}` }, region.label),
        ),
        // A group with no layout of its own still needs to arrange its children somehow, which is
        // what the default `flow` class is for.
        h(
          'div',
          {
            className: `sb-groupBody ${layoutClass(block.layout)}`,
            style: layoutStyle(block.layout, width),
          },
          children.map((child) =>
            h(BlockNode, {
              key: child.id,
              block: child,
              width,
              selected,
              byId,
              regions,
              sessionId,
              cell: innerCells?.[child.id],
            }),
          ),
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
    function SelectionBar({ count, slugs, note, setNote, sending, error, onSend, onCancel, text, byText }) {
      if (count === 0) return null

      // A long selection must not turn the bar into a wall of chips. The overflow count keeps the
      // summary honest and the full list stays reachable through the title.
      const CHIP_LIMIT = 4
      const shown = slugs.slice(0, CHIP_LIMIT)
      const hidden = slugs.length - shown.length
      const hasText = typeof text === 'string' && text.trim() !== ''
      // A text selection is reported in characters, because that is the unit the user dragged over
      // and the unit the Agent receives. Blocks alone would say "3 blocks" for what may be one
      // clause, which understates what was pointed at.
      const countLabel =
        byText && hasText ? `选中 ${text.trim().length} 字 · ${count} 个块` : `已选 ${count} 个块`

      return h(
        'div',
        { className: 'sb-selbar', 'data-superboard-selection': '' },
        h('span', { className: 'sb-selbarCount' }, countLabel),
        h(
          'div',
          { className: 'sb-selbarChips', title: slugs.join('、') },
          shown.map((slug) => h('span', { key: slug, className: 'sb-chip' }, slug)),
          hidden > 0 && h('span', { className: 'sb-chip' }, `+${hidden}`),
        ),
        h(
          'label',
          { className: 'sb-selbarField' },
          h('input', {
            className: 'sb-input',
            value: note,
            'aria-label': '对这个选区提问或说明',
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
        ),
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
                      // Returns whether a page was actually requested, so the view can tell a
                      // real load from a no-op. Whether older history *remains* is deliberately not
                      // answered here: that is state, and it arrives as the standard `useSession`
                      // prop below, because a plain field read off this object never re-renders.
                      loadOlder: async () => {
                        if (session === undefined) return false
                        await session.loadOlder()
                        return true
                      },
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
      curvePoints,
      curveMidpoint,
      // An edge with waypoints is a different shape with a different middle, so both the route and
      // the label are pure functions of the two boxes and the detour, and both are testable here.
      viaPoints,
      polylineMidpoint,
      pathMidpoint,
      // Anchor resolution and the edge census. The resolver is the pure half of a split that exists
      // so this can be tested at all: nine anchor kinds whose whole promise is *which* rectangle a
      // descriptor names, and the arc that made a page's missing arrows visible instead of absent.
      anchorRect,
      // Which blocks a `child` anchor may name. Pure, and the reason is a bug rather than a style:
      // the inline version gave every block a `children` map containing only itself.
      childrenByParent,
      countEdges,
      // The crop a `pdf-page` is rasterised to. Pure, and separated from the rasteriser for the same
      // reason the resolver is: the arithmetic is what decides which part of a page an arrow points
      // into, and the pdf.js call around it is the part that cannot be tested here.
      pageCrop,
      // What a rendered mermaid SVG says its nodes are, and a code block's text split into the lines
      // an anchor counts. Both pure: one parses text, the other builds elements.
      diagramNodeTable,
      codeLines,
      layoutClass,
      layoutStyle,
      // The tree and the tree flattening. DOM-free, so the rules that decide *what sits at the top
      // level* and *which cell the host resolved for a child* are both checked.
      rootBlocksOf,
      cellStyle,
      BlockTree,
      // Selection geometry and the feedback payload. Also DOM-free, so the parts that decide
      // *which* blocks a marquee means and *what text* the Agent receives are both checked.
      normaliseRect,
      rectsIntersect,
      // Which gesture a drag means, and what the browser's own selection covers. The classifier is
      // pure apart from its DOM reads, so a stub element lets the tests pin the three outcomes —
      // and `textSelectionText` is pure, which is what its normalisation needs.
      originAt,
      textSelectionBlocks,
      textSelectionText,
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
      // The components themselves. Exported so a test can actually *render* them with a stubbed
      // React: every pure helper above can be green while the view still throws on mount, and a
      // throw inside a slot takes the whole pane down to a blank rectangle with no message.
      BoardView,
      ReadingColumn,
      SelectionBar,
      // The stylesheet itself. Exported because the rules that decide *what a drag means* live here
      // as much as in the handlers — a marquee is only possible on chrome the browser will not
      // select — and a rendered card is the only way to check a rule against real layout.
      BoardStyles,
      BlockNode,
      Block,
      Markdown,
      // The diagram card and the class it puts on a code element. Exported for the same reason as
      // the rest: the failure this milestone fixes was invisible to every pure helper.
      Diagram,
      codeClass,
      svgDataUrl,
      // The diagram theming seam. `diagramThemeVariables` takes its reader as an argument so a
      // test can drive it with a fake token table — the real one needs a browser, and the mapping
      // is the part worth pinning.
      diagramThemeVariables,
      categoricalPalette,
      normaliseColour,
      // The colour arithmetic behind the two measured defects (collapsed quadrant fills, unreadable
      // pie labels). Exported so the tests can pin the formula itself, not only its effect.
      parseColourChannels,
      compositeOver,
      contrastRatio,
      mostLegible,
      pieLabelColour,
      mix,
      DIAGRAM_TOKEN_SOURCES,
      DIAGRAM_CATEGORICAL,
      DIAGRAM_CATEGORICAL_FALLBACK,
      // The picture card and the two things it shares with the host: the file URL and the key a
      // render report is retired by.
      Picture,
      fileUrl,
      renderInput,
      // The PDF page card and its shared document cache, exported so a test can drive the cache's
      // failure rule — a remembered rejection would keep a corrected path broken.
      PdfPage,
      openDocument,
    }
  },
})
