/**
 * Shared harness for the real-render scenes.
 *
 * It mounts the **shipped** `src/client.js` — the same file the plugin serves —
 * against the real board model and the real theme tokens, so a promo frame is an
 * actual render of the product rather than a drawing of it. Everything a scene
 * does to it afterwards (clicking a page tab, switching flavour, dragging a
 * marquee) goes through real DOM events, for the same reason.
 *
 * Loading order (a scene sets these up, then calls `startBoard`):
 *   1. `<script src="/vendor/react.production.min.js">` + react-dom
 *   2. `<script>window.__ModuleLoader__ = { load: (d) => { window.__sbDef = d } }</script>`
 *   3. `<script src="/repo/src/client.js"></script>`
 *   4. `<script src="/scenes/harness.js"></script>`
 *
 * The factory's RETURN VALUE is the module exports; `module.exports` is undefined
 * (dsh-client-modules `lib/client.js:31612`), which is the trap this file exists to
 * encode once instead of in every scene.
 */

const DATA = {
  board: '/scenes/data/board.json',
  tokens: (flavour) => `/scenes/data/tokens-${flavour}.json`,
  shiki: '/scenes/data/shiki-tokens.json',
}

/** Flavour → the `data-ds-dark-theme` value ThemePresenter would set. */
const DARK_FLAVOURS = new Set(['frappe', 'macchiato', 'mocha'])

/** Fetches already in flight or done, so several mounts share one copy. */
const JSON_CACHE = new Map()

async function json(url) {
  // `s2` mounts five board states in one page; without this it would fetch the 78 KB wire
  // value and four token tables five times over, which is most of its boot time.
  const cached = JSON_CACHE.get(url)
  if (cached !== undefined) return cached
  const pending = fetch(url).then((response) => {
    if (!response.ok) throw new Error(`fetch ${url} → ${response.status}`)
    return response.json()
  })
  JSON_CACHE.set(url, pending)
  return pending
}

/**
 * Apply a flavour exactly the way `ThemePresenter.apply` does.
 *
 * Measured contract (`dsh-client-ui-layout/lib/client.js:512-550`): set
 * `data-ds-dark-theme` from the active colour scheme on `<body>`, then write every
 * token as an INLINE custom property, removing the previous round's names. Writing
 * the attribute alone is not enough — switching between two dark flavours keeps the
 * attribute identical while the style changes, which is exactly why consumers must
 * read the DOM instead of the attribute.
 */
function applyFlavour(tokens, shiki, flavour) {
  const body = document.body
  if (body.dataset.sbFlavour !== undefined && body.dataset.sbFlavour !== flavour) {
    // Drop the previous round's names, as the real presenter does.
    for (const name of body.__sbApplied ?? []) body.style.removeProperty(name)
  }
  if (DARK_FLAVOURS.has(flavour)) body.setAttribute('data-ds-dark-theme', 'true')
  else body.removeAttribute('data-ds-dark-theme')

  const merged = { ...tokens, ...(shiki[flavour] ?? {}) }
  const names = []
  for (const [name, value] of Object.entries(merged)) {
    body.style.setProperty(name, value)
    names.push(name)
  }
  body.__sbApplied = names
  body.dataset.sbFlavour = flavour
}

/** Wait until `check()` is true, or throw. Uses timers, never rAF. */
async function until(check, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((done) => setTimeout(done, 25))
  }
}

/** A real click at an element's centre, so React's own handlers run. */
function clickElement(element) {
  const box = element.getBoundingClientRect()
  const options = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  }
  element.dispatchEvent(new PointerEvent('pointerdown', options))
  element.dispatchEvent(new PointerEvent('pointerup', { ...options, buttons: 0 }))
  element.dispatchEvent(new MouseEvent('click', { ...options, buttons: 0 }))
}

/**
 * The reading column's conversation, as a real external store.
 *
 * `ReadingColumn` (`src/client.js:2476-2485`) calls `useChat(selector)` **during its own
 * render** to pull `snapshot.order` and `snapshot.nodes`, so a stub that ignores the
 * selector returns `undefined` for both and the column renders 「这段对话还没有消息。」
 * forever — which is exactly what the first cut of the film did.
 *
 * Implementing it with `useSyncExternalStore` rather than "return a value" is what makes
 * the column able to *change* mid-scene: publishing a longer conversation re-renders every
 * subscriber, so a scene can add turns over `t` and watch the older ones scroll away.
 */
function createChatStore() {
  const listeners = new Set()
  return {
    snapshot: { order: [], nodes: emptyNodeStore() },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish(turns) {
      const map = new Map()
      turns.forEach((turn, index) => {
        const key = `t${index}`
        map.set(key, {
          key,
          id: key,
          // Chat's own node kinds: `user` and `assistant-step` (`client.js:2387-2388`).
          kind: turn.role === 'user' ? 'user' : 'assistant-step',
          anchorSeq: index + 1,
          visibility: 'visible',
          data:
            turn.role === 'user'
              ? { content: [{ kind: 'text', text: turn.text }] }
              : { blocks: [{ kind: 'text', text: turn.text }] },
        })
      })
      // A NEW `order` array every time, deliberately: `ReadingColumn`'s memo depends on
      // its identity, so handing back the same array would keep serving the old list
      // out of cache even though the render happened.
      this.snapshot = { order: [...map.keys()], nodes: nodeStore(map) }
      for (const listener of listeners) listener()
    },
  }
}

/**
 * The node store `useChat` hands to `dialogueFromChat`.
 *
 * **Measured, and the first attempt got it wrong**: the reader does
 * `const nodes = chat?.nodes?.values?.()` followed by `if (!Array.isArray(nodes)) return []`.
 * A real `Map`'s `values()` returns a *MapIterator*, so handing over a `Map` yields an
 * empty column with no error anywhere — the same silent failure the stub had. `values()`
 * must therefore return a genuine array.
 */
function nodeStore(map) {
  return {
    get size() {
      return map.size
    },
    get(key) {
      return map.get(key)
    },
    has(key) {
      return map.has(key)
    },
    values() {
      return [...map.values()]
    },
  }
}

function emptyNodeStore() {
  return nodeStore(new Map())
}

/**
 * Mount the real `BoardView`.
 *
 * @param options.sessionId  session id the view binds to.
 * @param options.flavour    theme flavour to apply (default `mocha`).
 * @param options.mutate     optional `(model) => model` to adapt the demo board.
 * @param options.chatTurns  turns for the reading column.
 * @param options.mountId    element id to mount into (default `mount`). Several
 *                           mounts can coexist so a scene can switch between two
 *                           board states by toggling visibility, which is far more
 *                           deterministic than re-mounting mid-scene.
 * @param options.tokensOverride  extra inline custom properties to apply.
 */
async function startBoard(options = {}) {
  const flavour = options.flavour ?? 'mocha'
  const [wire, tokens, shiki] = await Promise.all([
    json(DATA.board),
    json(DATA.tokens(flavour)),
    json(DATA.shiki),
  ])
  let model = wire.model
  if (typeof options.mutate === 'function') {
    model = options.mutate(structuredClone(model)) ?? model
  }
  const board = { modelVersion: wire.modelVersion, model, diag: options.diag ?? {} }
  if (options.flavour !== null) applyFlavour(tokens, shiki, flavour)

  const definition = window.__sbDef
  if (definition === undefined) throw new Error('client half never registered with __ModuleLoader__')
  const mod = definition.factory((name) => {
    if (name === 'react') return window.React
    throw new Error(`unexpected require(${name})`)
  })

  // The real stylesheet, through the real component — once per document. Several mounts
  // coexist in a scene like `s2` (one per board state, toggled by visibility), and
  // appending the same stylesheet five times is harmless but wasteful.
  if (window.__sbStylesHost === undefined) {
    const styleHost = document.createElement('div')
    document.head.appendChild(styleHost)
    window.__sbStylesHost = styleHost
    window.ReactDOM.createRoot(styleHost).render(window.React.createElement(mod.BoardStyles))
  }

  const mount = document.getElementById(options.mountId ?? 'mount')
  if (mount === null) throw new Error(`no #${options.mountId ?? 'mount'} element to mount into`)
  /**
   * Select **inside this mount**, never the document.
   *
   * Several board states live side by side, and they share every class name, so a
   * document-wide `querySelector('.sb-pageOn')` answers for whichever mount happens to
   * come first — which reads as "the click did nothing" rather than as a wrong query.
   */
  const scope = (selector) => mount.querySelector(selector)
  const scopeAll = (selector) => [...mount.querySelectorAll(selector)]
  const useProjection = (key) => (key === 'board' ? board : undefined)
  const chatStore = createChatStore()
  if (Array.isArray(options.chatTurns)) chatStore.publish(options.chatTurns)
  const useChat = (selector) => {
    const snapshot = window.React.useSyncExternalStore(
      (listener) => chatStore.subscribe(listener),
      () => chatStore.snapshot,
    )
    return typeof selector === 'function' ? selector(snapshot) : snapshot
  }
  const useInput = () => window.__input ?? { value: '', attachments: [] }
  const inputActions = {
    setValue: () => {},
    submit: () => {},
    addAttachment: () => {},
  }
  const useSession = () => ({ id: options.sessionId ?? 'promo', title: '宣传片' })

  const element = window.React.createElement(mod.BoardView, {
    sessionId: options.sessionId ?? 'promo-session',
    useProjection,
    useChat,
    useInput,
    inputActions,
    attachFeedback: async () => ['draft-1'],
    loadOlder: async () => false,
    useSession,
  })

  const root = window.ReactDOM.createRoot(mount)
  root.render(element)
  await until(
    () => scope('[data-superboard-canvas]') !== null,
    `the board canvas inside #${options.mountId ?? 'mount'}`,
  )

  const api = {
    mod,
    board,
    root,
    flavour,
    /** Re-apply a different flavour, as switching theme would. */
    async setFlavour(next) {
      const [nextTokens, nextShiki] = await Promise.all([json(DATA.tokens(next)), json(DATA.shiki)])
      applyFlavour(nextTokens, nextShiki, next)
      // Give mermaid-backed blocks a beat to re-render through their own observer.
      await new Promise((done) => setTimeout(done, 350))
    },
    /**
     * Click a page tab by slug, the way the user would.
     *
     * **Measured**: the client renders no tab strip at all when a board has a single page
     * — so on a one-page board there is no tab to click, and the request is already
     * satisfied. Throwing there would make a legitimate state look like a missing page.
     */
    async selectPage(slug) {
      const tabs = scopeAll('.sb-page')
      if (tabs.length === 0) return undefined
      const tab = tabs.find((button) => button.textContent.startsWith(slug))
      if (tab === undefined) throw new Error(`no page tab for ${slug} in #${options.mountId ?? 'mount'}`)
      clickElement(tab)
      await until(
        () => scope('.sb-pageOn')?.textContent.startsWith(slug),
        `page ${slug} in #${options.mountId ?? 'mount'}`,
      )
      return tab
    },
    activePage() {
      return scope('.sb-pageOn')?.textContent.replace(/\d+$/, '') ?? ''
    },
    blocks() {
      return scopeAll('[data-block-id]')
    },
    /**
     * Look a card up by the slug a reader would use.
     *
     * **Measured**: `data-block-id` holds the internal id (`bl_ccd8b5`), not the slug —
     * the slug is in a separate `data-block-slug` attribute. Selecting on the slug via
     * the id attribute silently matches nothing, which reads as "the block is not on
     * this page" rather than as a wrong selector.
     */
    blockBySlug(slug) {
      return document.querySelector(`[data-block-slug="${slug}"]`)
    },
    /**
     * Publish a conversation into the reading column.
     *
     * `turns` is `[{ role: 'user' | 'assistant', text }]`, oldest first. Publishing a
     * *longer* list is what makes the column scroll: `ReadingColumn` re-pins to the
     * bottom whenever the turn count changes, so the turns that no longer fit leave the
     * top of the view — which is the whole point of the shot.
     */
    setChat(turns) {
      chatStore.publish(turns)
      return until(
        () => document.querySelectorAll('[data-superboard-reader] .sb-turn').length === turns.length,
        'the reading column to catch up',
      )
    },
    /** The reading column's scroller, for a scene that wants a specific scroll position. */
    reader() {
      return document.querySelector('[data-superboard-reader] .sb-readerBody')
    },
    until,
    clickElement,
  }
  window.__board = api
  return api
}

window.SuperboardHarness = { startBoard, applyFlavour, until, clickElement, DATA }
