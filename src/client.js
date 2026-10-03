/**
 * Client half of `dsh-superboard`.
 *
 * This file is served to the browser as-is: a plain classic script that registers one lazy
 * factory. There is no build step at M0, and per `docs/research/dsh-plugin-contract.md` §2.1
 * the factory receives **only** `require` — no `ctx`, no `host`, no `fetch` shim. The only
 * modules it may resolve are the frozen nine platform seeds plus other plugins' client
 * halves; a miss throws.
 *
 * How the board tab appears, verified against the shipped UI:
 *   `conversation.view` is a `list` slot declared by `dsh-client-ui-conversation` on
 *   `conversation.session` (`lib/client.js:18209-18214`). The conversation's own header
 *   enumerates its entries and renders them as a `role="tablist"` whenever there is more
 *   than one (`:16460`, `:16512-16526`), and only the active one is rendered (`:16412-16421`).
 *   So registering here IS the integration — the host builds the tab button, and because the
 *   central panel stays `conversation`, `activePanelId` stays null and the right sidebar is
 *   unaffected. The shipped chat view registers exactly this way at
 *   `dsh-client-ui-chat/lib/client.js:12390-12407`.
 *
 * Styling uses only `--dsw-alias-*` theme tokens, and no host component library is imported:
 * a throwing primitive would blank the whole slot entry (`practices.md:35`).
 */

window.__ModuleLoader__.load({
  id: 'dsh-superboard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * The board's stylesheet.
     *
     * Rendered as a child element rather than injected through a service, which is the
     * officially suggested form: *"Component-local styles can render as React elements so
     * unmounting removes them"* (`references/ui-plugin.md`). It also avoids depending on a
     * style service existing — the client half has only eight services, and `styles` is not
     * among them.
     *
     * Only `--dsw-alias-*` tokens are used, never literal colours: a renamed token degrades
     * appearance, while a literal colour is wrong the moment the user switches theme.
     */
    function BoardStyles() {
      return h('style', null, BOARD_CSS)
    }

    const BOARD_CSS = [
      '.sb-root{display:flex;flex-direction:column;gap:12px;min-width:0;color:var(--dsw-alias-label-primary);}',
      '.sb-head{display:flex;align-items:baseline;gap:8px;}',
      '.sb-title{font-size:14px;font-weight:600;line-height:20px;}',
      '.sb-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}',
      '.sb-body{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;align-items:start;}',
      '.sb-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px;min-width:0;}',
      '.sb-cardTitle{margin:0 0 6px;font-size:13px;font-weight:600;line-height:18px;}',
      '.sb-card p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}',
    ].join('')

    /**
     * The board view, mounted inside the conversation page while its tab is active.
     *
     * Session-scoped slot entries receive the session standard kit; `sessionId` is the plain
     * prop we need (`dsh-client-ui-session/lib/client.js:123-128`). `useBoard` will hold the
     * board projection once M1 exists.
     */
    function BoardView({ sessionId }) {
      const board = useBoard(sessionId)

      return h(
        'div',
        { className: 'sb-root', 'data-superboard': '' },
        h(BoardStyles),
        h(
          'header',
          { className: 'sb-head' },
          h('span', { className: 'sb-title' }, 'Superboard'),
          h(
            'span',
            { className: 'sb-sub' },
            board === undefined ? 'waiting for the session projection' : 'board projection attached',
          ),
        ),
        h(
          'div',
          { className: 'sb-body' },
          h(
            'article',
            { className: 'sb-card' },
            h('h2', { className: 'sb-cardTitle' }, '架构图'),
            h(
              'p',
              null,
              'M0 placeholder. This card stands in for the first real block so the tab can be ',
              'seen rendering inside DSH before any of the scene model exists.',
            ),
          ),
          h(
            'article',
            { className: 'sb-card' },
            h('h2', { className: 'sb-cardTitle' }, '风险-1'),
            h('p', null, 'Session: ', h('code', null, String(sessionId))),
          ),
        ),
      )
    }

    /**
     * Reserve the board projection's read path.
     *
     * M1 registers a `ctx.sessionProjections` unit whose `wire` face reaches the client
     * through the ordinary control frame; the client then reads it with `useProjection(key)`
     * (`dsh-client-ui-session/lib/client.js:121-130`). Until that projection exists the hook
     * is absent, so this returns `undefined` and the view renders its waiting state rather
     * than crashing — which is also what keeps M0 loadable.
     *
     * @param _sessionId - the session whose board is being shown.
     * @returns the board view value, or `undefined` while no projection is registered.
     */
    function useBoard(_sessionId) {
      return undefined
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                {
                  name: 'conversation.view',
                  id: 'board',
                  order: 20,
                  label: () => '看板',
                },
                BoardView,
              ),
            ),
          'dsh-superboard: board tab',
        )
      },
    }
  },
})
