# DSH plugin contract — verified constraints

**Status:** verified against DSH **0.2.0-rc.2** Desktop, 2026. Every claim here is backed by
an artifact named inline. This file is the short list of *rules we must obey*; the long-form
survey with 90 slot keys and full evidence tables is in
[`../research/dsh-plugin-api.md`](../research/dsh-plugin-api.md).

Two independent sources back this file:

1. The **official authoring skill** shipped inside DSH, extracted verbatim to
   `.ref/dsh-official/cordis-plugin-development/` by `scripts/extract-dsh-ref.mjs`.
   `SKILL.md`, `references/{host-plugin,ui-plugin,practices,user-actions,verification}.md`,
   and `templates/` are the Harness authors' own instructions to plugin authors — the
   highest-authority artifact available.
2. The **generated inspection catalogs** in
   `@deepseek-ai/dsh-cordis-client-runner/lib/client.js`, which back the live
   `cordis_inspect` providers.

> `.ref/` is gitignored. Run `node scripts/extract-dsh-ref.mjs` to regenerate it.

---

## 1. Package shape

A plugin is an ordinary npm package plus a `dsh` manifest block, with two independently
optional halves. Both are plain ESM; **a hand-written plugin needs no build step and, for a
host-only bundle, no dependencies at all** (`host-plugin.md` L55).

```jsonc
{
  "name": "@local/my-plugin",
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // host half: inserts Loader entries
    "client": {                                     // client half: browser UI
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```
`templates/decoration/package.json`.

- **Host half** exports *either* `export function apply(ctx, config)` (+ optional
  `inject`, `Config`) *or* a service class as default — **never both** (`host-plugin.md` L47–52).
- **Client half** is delivered as a lazy factory whose id **equals the package name**
  (`ui-plugin.md` L9):
  ```js
  window.__ModuleLoader__.load({
    id: '@local/my-plugin',
    factory(require) {
      const React = require('react')      // React comes from the browser module table
      return { inject: ['slots'], apply(ctx) { /* register into slots */ } }
    },
  })
  ```
  `templates/decoration/client.js`. Factories must be **side-effect free** — all resources
  (styles, timers, listeners) are registered inside `apply` via `ctx.effect`/`ctx.on` and
  return cleanups (`ui-plugin.md` L13).
- `dsh.client.external` declares non-baseline runtime imports.
- `cordis.patch.yml` inserts the plugin into a profile's layer stack:
  ```yaml
  - insert:
      - id: my-plugin
        name: '@local/my-plugin'
        config: {}
  ```
- `peerDependencies` on `@deepseek-ai/*` are **enforced before install** (an incompatible
  DSH peer rejects with `incompatible-version`). `engines.dsh` is **declarative only and not
  enforced** (`dsh-package-manifest/README.md` L93).
- Enabling a *bundle* appends to `dsh.profile.bundles`, **which silently changes config
  precedence** (`dsh-plugin-manager/README.md` L40).

## 2. Client builtins — the whole surface

`CLIENT_BUILTIN_INSPECTION`, live `cordis_inspect_query`:

| Builtin | Contract |
|---|---|
| `ctx` | restricted Cordis Context: `get(name)`, `on(name, fn)`, `provide(name, value)`, `effect(cb, label?)` |
| `React` | React runtime **without JSX transformation** — use `React.createElement` |
| `host` | `host.call(method, args?) → Promise<JsonValue>` — package-private JSON-RPC to *your own* host half |
| `styles` | `styles.insert(css) → disposer` |
| `console` | package-tagged logging |

Browser timers, Node builtins, and `fetch` are removed and redirect to cordis services.
There are only **8 client Services** (`layout`, `locale`, `sessions`, `slots`, `theme`,
`timer`, `uiWorkspace`, `workspaces`) and **4 client Events** (`connection/reset`,
`locale/change`, `slots/changed`, `theme/change`). There is **no generic plugin event bus**.

## 3. Slots

A Slot is a parent-owned typed position: kind `single` | `list` | `keyed` | `chain`, scope
`root` | `session` | `session-maybe`. Registering into an **undeclared** slot throws;
declaring a slot claims it exclusively. The idiom is always two calls:

```js
ctx.slots.inject(ownerKey, () => ctx.slots.register({ name, id?, key?, order?, label?, /* … */ }, Component))
```

Duplicate cell at the same priority throws — `"register at a different priority to shadow it
(lowest renders)"` (`dsh-client-ui-slots/lib/index.js` L168–189). Registration returns a
disposer. 90 slot keys are catalogued in the research report.

## 4. Where a full-surface panel can live

This is the load-bearing question for a canvas that replaces the conversation as the main UI.
Both placements are reachable, and they are **different mechanisms**:

**A. Central main panel.** `main` is a keyed, root-scoped slot with keyDomain
`"Central panel selected by sidebar entry id"`. Occupants today: `ConversationPanel`
(key `conversation`), `PluginManagerPage`, `TaskManagerPage`. The left rail's
`sidebar.panellist` (list, root) entries are *"global panel icons whose list `id` addresses
the matching `main` panel"*. The client `layout` service drives it:

```
selectPanel(panelId: MainPanelId | null): void
beginNavigation(): AbortSignal
toggleSidebar(): void
openRightbar(track, fullscreen): void
closeRightbar(): void
```

So a canvas registered at `main` key `<id>` + a `sidebar.panellist` entry with that same
`id` becomes a **first-class main panel that swaps with the conversation** — `selectPanel`
is the swap. *(The exact mapping code and the `MainPanelId` type are not yet confirmed
first-hand; see §9.)*

**B. Right-sidebar tab.** A tab type is two registrations inside one `ctx.effect`:

```js
ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)
```

`id` **is** the slot key, and **the package name is the natural value** — the shipped browser
tab uses `const BROWSER_ID = "@deepseek-ai/dsh-client-ui-sidebar-browser"` as its id. The body
reads `{ sidebar, panel, tab }` from the injected `useTabInfo()` and also receives the session
standard kit (`useChat, useConversation, useSession, sessionId, useSessions, …`). Open with
`ctx.sidebarRight.openTab(kind, opts)` / `openResource(dshResourceAddress, opts)`; unknown
kind throws. Bands: `extension` (third-party, default) > `builtin` > `fallback`.

Existing right-pane tabs (9 bodies / 7 titles): browser, files, terminal, text preview,
guide, plan, schedule, subagent chat, deliverables review.

**Consequence for the design.** The "canvas replaces chat, but the two can swap" behaviour
does not require inventing anything: main-panel registration + `layout.selectPanel()` +
`openRightbar`/`closeRightbar` are the mechanism. That makes it cheaper than it looked in
the first design round — but it also means the swap is a *shell navigation*, not a custom
layout, so the canvas must behave correctly when unmounted and remounted.

## 5. Host: tools

```ts
ctx.tools.register(definition: ToolDefinition): () => void
```
`parameters` is **plain JSON Schema** (`Record<string, unknown>`) — no zod required.
`ToolDefinition = { name, description, parameters, output: { schema, render(args, value),
presentationMeta? }, execute(args, exec), projectContent?, finalizeContent?, timeoutMs?,
isConcurrencySafe?, presentCall?, presentResult? }`. Scoped registrations shadow globals;
`run_code` is reserved. Tools may also return `additionalContexts: UserMessage[]` or call
`exec.deferContext(msg)`.

## 6. Host: context injection — two supported routes only

1. `ctx.systemPrompt.section({ name, order, text, interpolate? })` for prompt text, plus
   `.context()`, `.variable()`, `.tools()`, `.suppressRuntimeContext()`.
2. **`agent.inject({ content, source: { kind: 'plugin', plugin } })`** — adds model-facing
   context **without waking the driver**, logged durably as `agent/inbox/spliced`.

`followup()` and `steer()` wake the agent; `inject()` does not. **Do not** listen to
`system-prompt/assemble` to add or remove tools or text (`practices.md` L18).

> This is exactly the lever the "Agent pulls context instead of receiving the whole board"
> requirement needs: `inject()` can wait in the inbox until other input arrives, so a board
> outline can be attached to the turn that needs it without burning a turn of its own.

## 7. Host: durability and the source-of-truth rule

`practices.md` L7, principle 1:

> **The session log is the only source of truth.** Anything the model sees must be
> reconstructable from committed session events; fork, resume, and replay derive from the
> log. Plugin memory is a derived cache.

And L21:

> Do not append session events with a new `type`. Readers accept an unknown stored event only
> when its envelope carries `ignorable: true`, and live `Session.append()` cannot set that
> marker, so the Session would refuse to reopen. **Derive state from existing events, or keep
> plugin-owned data in a storage service found through inspection.**

Storage: `ctx.storage` (`mount(form, facility)`, `form(form)`, `backend: BackendRegistry`) and
`ctx.storageDomain` (`open(spec: DomainSpec) → Promise<Domain<S>>`, `get(name)`, `closeAll()`);
`'domain/changed'` fires *"once per write strictly after the backend acknowledged durability."*

**This is the central architectural tension of the project**, and it is now a concrete design
question rather than a vibe:

- Tool calls and results *are* committed session events, so **a board expressed as the fold of
  its own `board_apply` tool calls is fully compliant** — replay, fork, and resume work for
  free, and the model's view is exactly what the log says.
- A board held in plugin-owned `storageDomain` is a derived cache by the framework's rules, so
  it must be *reconstructable* to stay honest.
- Reconstructability is also what makes "Agent queries the board instead of receiving it"
  cheap: if the board is a fold over the log, the outline is computable per step.

## 8. Per-session derived state

`practices.md` L26–28: keep per-session state derived from the log in a `ctx.sessionProjections`
unit rather than subscribing to `session/event` and rescanning. `apply(state, event)` must be
**pure and synchronous** and return the same reference for ignored events. Keep state plain
JSON and bump `stateVersion` on field/semantics change so the cache checkpoints properly.

Host events worth using (`Event.listEvents`, live): `tools/{pre-execute,execute,post-execute,
result,change}`, `agent/{created,pre-step,request,request-error,turn-stopping,assistant-stream,
status,error}`, `session/{created,event,flush,disposed}`, `fs/{write-intent,edit-intent,observed}`,
`domain/changed`, `system-prompt/{assemble,change}`. Modes: `emit` | `serial` | `parallel` |
`waterfall`. A waterfall listener that does not own the decision **must return `next()`**.

## 9. UI rules that constrain the renderer

- **No iframes for plugin pages** (`practices.md` L33): *"an iframe document does not receive
  the host's theme tokens, light/dark switching, or `ctx.locale`."* Render React components in
  a slot. → A canvas that must show PDF pages has to rasterize into the host document, not
  embed a viewer frame.
- **Do not `require('@deepseek-ai/dsh-client-ui-primitives')`** or any other Harness Client
  package as a module (`practices.md` L35). They change without notice, plain-JS plugins get
  no type check, and *a throwing component blanks the slot entry*. Copy markup/CSS/behaviour
  instead, rename classes under the plugin's own prefix, and keep **only `--dsw-alias-*` token
  references**. 403 `--dsw-*` tokens exist; `--dsw-alias-*` is the semantic family.
  `theme.overrideTokens` requires `{ light, dark }` pairs — a bare string throws.
- Style with `--dsw-alias-*`; literal colours are for artwork only. A renamed token degrades
  appearance but never breaks rendering.
- Route visible text through the client `locale` service.
- Do not replace the app root or append a second application to `document.body`.
- Choose the rendering surface **before** writing any view — later styling inside the wrong
  surface cannot recover consistency.

## 10. Open / unverified

Carried forward from the research report's UNVERIFIED list, plus what this file still needs:

- Whether a plugin may **register a new client Service**.
- `wire.view` declaration syntax for host projections.
- `PLATFORM_MODULES` member list (what `require(...)` resolves for a client plugin).
- The exact `MainPanelId` type and the code mapping a `sidebar.panellist` id to a `main` key.
- `settings.plugin.item` is used by dshmarket but is absent from the current catalog —
  `slots.inject` degrades silently rather than throwing, so this is a live-plugin-authoring
  hazard worth remembering.
- Licensing posture of copied primitive markup.
