# DSH Web Client API — build reference for plugin authors

Verified against **built JS on disk**, not against docs. Every claim carries `file:line`.
Doc READMEs are quoted only where they agree with the code; where a README's wording could mislead,
the code wins and the discrepancy is called out.

## 0. Sources and how to read the paths

| Path under `E:\Dev\dsh-superboard\.ref\` | What it is |
|---|---|
| `dsh-official\dsh-client-ui-slots\lib\index.js` | Pure slot registry (React-free). `standardHookPropName` lives here. |
| `dsh-official\dsh-client-ui-renderer\lib\client.js` | **The** React slot renderer: where props are composed. |
| `dsh-official\dsh-client-ui-layout\lib\client.js` | AppFrame, `ctx.layout`, root registration that declares `main`. |
| `dsh-official\dsh-client-ui-sidebar\lib\client.js` | Left sidebar; declares & renders `sidebar.panellist`. |
| `dsh-official\dsh-client-ui-sidebar-right\lib\client.js` | Right pane, tab system, `ctx.sidebarRight`, `ctx.sidebarRightTabs`. |
| `dsh-official\dsh-client-ui-session\lib\client.js` | The session-scope standard kit (`sessionId`, `useSession`, `useProjection`). |
| `dsh-official\dsh-client-ui-conversation\lib\client.js` | Registers the `main` key `conversation`, and `conversation.*` slots. |
| `dsh-official\dsh-client-ui-chat\lib\client.js` | Chat content; consumes `ctx.sidebarRight.openTab`. |
| `dsh-official\dsh-client-ui-sidebar-documentpreview\lib\client.js` | **The reference third-party tab type** (id/kind/body/title). |
| `dsh-official\dsh-client-ui-theme\lib\client.js` | Token stylesheets + theme service. |
| `dsh-official\dsh-client-ui-primitives\lib\index.js` | 282 public exports. |
| `dsh-official\cordis-plugin-development\` | Official plugin-authoring skill: `SKILL.md`, `references\*.md`, `templates\`. |

The `dsh-official\` tree was produced by piping `@electron/asar extract-file` for each package.
Reproduce with (run from a scratch dir):

```powershell
npx --yes @electron/asar extract-file "C:\Users\haoch\AppData\Local\Programs\DeepSeek Harness\resources\app.asar" `
  "dsh\node_modules\@deepseek-ai\dsh-client-ui-renderer\lib\client.js"
```

> **Path form matters:** the extractor only accepts **backslashes** and **no leading separator**
> (`dsh\node_modules\...`). `dsh/...` and `\dsh\...` both throw `"…was not found in this archive"`.

---

## Q1 — Slot component props

### 1.1 The exact merge order (the whole answer in one snippet)

`.ref/dsh-official/dsh-client-ui-renderer/lib/client.js:771-789` — `renderEntry`, the single place a
registered component is instantiated:

```js
function renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext) {
    if (slotInjected.slotHookFactories === void 0) return (0, react_jsx_runtime.jsx)(Comp, {
        ...kit,
        ...injected,
        ...slotInjected.props,
        ...ownerProps
    });
```

and the branch used whenever the slot declared deferred hooks
(`.ref/dsh-official/dsh-client-ui-renderer/lib/client.js:752-769`, `ContextualEntry`):

```js
return (0, react_jsx_runtime.jsx)(Comp, {
    ...kit, ...injected, ...slotInjected.props, ...contextual, ...ownerProps
});
```

**Five shares, last one wins, in this order:**

| # | Share | Source | Notes |
|---|---|---|---|
| 1 | **standard kit** (`kit`) | framework | see 1.2 — always present |
| 2 | **entry inject** (`injected`) | your own `register({ inject })` | see 1.3 |
| 3 | **slot inject props** (`slotInjected.props`) | the slot *declarer*'s `inject` | e.g. `sidebar` adds `selectPanel`/`startSession` |
| 4 | **contextual hooks** (`useTabInfo`, …) | the slot declarer's deferred hook factories | only on slots that declare one |
| 5 | **owner props** | the parent's `renderSlot(key, ownerProps, opts)` call | **spread flat — there is no `ownerProps` key** |

Overlap is a hard error, not a silent override, but only where the framework can check it
(`.ref/dsh-official/dsh-client-ui-renderer/lib/client.js:922-924`):

```js
function assertNoPropOverlap(owner, provided, received) {
    for (const name of Object.keys(received)) if (Object.hasOwn(provided, name)) throw new SlotAssemblyError(`${owner} received duplicate prop '${name}'`);
}
```

It is asserted for factory occurrences/local slots (`:896`, `:901`, `:1005`, `:1011`) — **not** for
ordinary slot registrations, where owner props simply win.

### 1.2 The standard kit — the complete list

`.ref/dsh-official/dsh-client-ui-renderer/lib/client.js:715-746`:

```js
const kit = { ...standard, renderFactorySlot: boundRenderFactorySlot(entry) };
if (entry.locale !== void 0) { … kit["t"] = localeSeat(face, entry.locale); }
const store = host.storeOf(entry, scopedStoreBinding);
if (store !== void 0) { kit["useStore"] = observableHook(store); kit["actions"] = store.actions; }
if (entry.children !== void 0) {
    kit["renderSlot"] = boundRenderSlot(host, entry);
    if (… spec.kind === "chain") kit["renderSlotChain"] = boundRenderSlotChain(host, entry);
    if (… spec.scope !== "root") kit["SessionProvider"] = scopeAreaProvider(adapter);
}
```

So a component receives, when applicable:

| Prop | Condition | Meaning |
|---|---|---|
| `renderFactorySlot(name, inputProps, { slots, fallback })` | always | render a declared Factory child |
| `renderSlot(key, ownerProps, opts)` | you declared `children` | render a declared child slot |
| `renderSlotChain(key, ownerProps, opts)` | you declared a `chain` child | only added when a chain child exists |
| `SessionProvider` | you declared a child whose `scope !== 'root'` | wraps a subtree in a session scope |
| `t(key)` | `register({ locale: '<ns>' })` | namespace-bound translate, identity changes per locale revision |
| `useStore(selector)` + `actions` | `register({ store })` | store seat: read via hook, write via baked actions |
| `use<Name>(selector)` | root/session standard sources | see 1.4 |
| `use<Name>(key)` | keyed standard sources | e.g. `useProjection(viewKey)` |
| `sessionId` | **plain prop**, session scope only | the scope key |
| `useTabInfo()` | only slots that declare the deferred hook | tab seats |

`renderSlot` options (`opts`) — `.ref/dsh-official/dsh-client-ui-renderer/lib/client.js:1106-1196`:

- `entryKey` — keyed dispatch (`:1154`, `spec.kind === "keyed"` → `.find(e => e.options.key === opts?.entryKey)`).
- `only` — list filter, `:1194` `if (opts?.only !== void 0) list = list.filter((item) => item.id === opts.only);`
- `fallback` — rendered when the slot is empty / the key is unregistered (`:1150`, `:1155`, `:1195`).
- `hookContext` — required whenever the slot declares injected hook factories (`:754` throws otherwise).
- `overlay` — chain-only, keeps the fallback mounted behind the elected entry (`:1199-1206`).

Unregistered key vs. crashed entry is distinguishable: a *dead cell* renders
`<div data-slot-error="<slotKey>">` (`:1147`).

### 1.3 What `inject` contributes, and how it merges

Two different `inject`s exist. Do not confuse them.

**(a) Entry-level `inject` — your own registration.**
`.ref/dsh-official/dsh-client-ui-renderer/lib/client.js:415-439`:

```js
function runInject(entry, binding, actions) {
    const inject = entry.inject;
    if (!inject) return EMPTY_INJECTED_PROPS;
    const args = [];
    if (binding !== void 0) args.push(binding.key);   // session scope → sessionId
    if (actions !== void 0) args.push(actions);       // only when the entry declared a store
    return bindInjectSources(inject(...args));
}
```

- **Root scope:** `inject()` — no arguments.
- **Session scope:** `inject(sessionId)` — and `inject(sessionId, actions)` when the entry also declared `store`.
- **Caching:** root entries memoize per entry; session entries memoize per *(entry × session binding)*
  (`:479-512`, `rootInjectCache` / `sessionInjectCache` / `sessionMaybeInjectCache`). The face is built
  **once per scope**, not per render.
- **`hooks` / `keyedHooks` inside the returned face are rewritten into hook props**
  (`:424-439`): `{ hooks: { myThing: source } }` becomes prop `useMyThing`, and the raw `hooks` key is
  stripped. Values are bare observable sources — `{ getSnapshot, subscribe }` only; **hooks never cross
  the host contract**, the renderer binds them (`:710-713`).
- Everything else in the returned object is spread as a plain prop, then overridden by the slot
  inject and the owner props.

Real example, entry-level inject returning both plain props and hooks
(`.ref/dsh-official/dsh-client-ui-sidebar/lib/client.js:471-486`):

```js
const injectProps = () => ({
    startSession: (workspaceId) => { workspaceNavigation.startSession(workspaceId); },
    toggleSidebar: () => { ctx.layout.toggleSidebar(); },
    selectPanel: (id) => { … ctx.layout.selectPanel(id); },
    hooks: { panels, shortcuts: ctx.shortcuts.catalog }
});
```

emits props `startSession`, `toggleSidebar`, `selectPanel`, `usePanels`, `useShortcuts`.

**(b) Slot-level `inject` — owned by the parent that declares the slot.**
It is `{ props?, hooks? }` in the `children` spec. Two flavours:

- static source → bound to a hook prop: `inject: { hooks: { tabInfo: tabInfoFactory } }`
  (`sidebar-right:9157`) — here the value is a **function**, so it is treated as a *factory*.
- factory `(standard, hookContext) => hook` — resolved per render occurrence
  (`.ref/dsh-official/dsh-client-ui-renderer/lib/client.js:471-478`):

```js
function bindSlotHookFactories(factories, standard, hookContext) {
    const hooks = {};
    for (const [name, factory] of Object.entries(factories)) {
        const hookName = standardHookPropName(name);
        hooks[hookName] = factory(standard, hookContext);
    }
    return hooks;
}
```

### 1.4 `standardHookPropName` / the `use<Name>` prop

`.ref/dsh-official/dsh-client-ui-slots/lib/index.js:7-9` — the entire implementation:

```js
function standardHookPropName(name) {
    return `use${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;
}
```

A registered **source name** `foo` becomes the prop **`useFoo`**. Applied in the renderer at `:431`,
`:435`, `:457`, `:474`, `:650`, `:654`, and on the session-source side at
`dsh-client-ui-session/lib/client.js:453`.

**The real inventory of standard sources in this build:**

| Where | Declaration | Props produced |
|---|---|---|
| `dsh-client-ui-session/lib/client.js:469-475` | `ctx.slots.provideRoot({ hooks: { sessions: ctx.sessions.list, sessionStatus: service.sessionStatus }, keyedHooks: { sessionRetainInfo: (key) => ctx.sessions.retainInfo(key) } })` | `useSessions`, `useSessionStatus`, `useSessionRetainInfo(key)` |
| `dsh-client-ui-session/lib/client.js:121-130` | `BUILTIN_SOURCE = { hooks: ["session"], keyedHooks: ["projection"], props: ["sessionId"] }` | `useSession`, `useProjection(key)`, **`sessionId`** |
| `dsh-client-ui-layout/lib/client.js:599` | `ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } })` | `usePanelInfo` |

Any plugin may add more session-scope sources through `ctx.uiSession.provide(descriptor)`
(`dsh-client-ui-session/lib/client.js:215-234`), with the descriptor shape
`{ hooks: [...names], keyedHooks: [...], props: [...], resolve(binding) }`; undeclared members throw
(`:436`), duplicate prop names throw (`:452-455`).

**Real consumption example — `usePanelInfo`** (`.ref/dsh-official/dsh-client-ui-layout/lib/client.js:56-58, 117-118`):

```js
function MainPanel({ usePanelInfo, renderSlot }) {
    return renderSlot("main", {}, { entryKey: usePanelInfo((info) => info.activePanelId) ?? "conversation" });
}
```

and per-row in the sidebar (`.ref/dsh-official/dsh-client-ui-sidebar/lib/client.js:173-174`):

```js
function PanelRow({ id, label, wide, usePanelInfo, selectPanel, renderSlot }) {
    const active = usePanelInfo((info) => info.activePanelId === id);
```

**`useSidebarRightPaneTab` does not exist in this build** — a repo-wide grep finds zero occurrences
(both `.ref/dsh-official` and the other extracted bundles). The right-pane equivalent is
**`useTabInfo()`**, injected by the slot declarer, not by `standardHookPropName`:

`.ref/dsh-official/dsh-client-ui-sidebar-right/lib/client.js:8964-9001` (the factory) and `:9150-9163`
(where the slot declares it):

```js
const tabInfoFactory = (standard, context) => {
    const { sessionId } = standard;
    const { tabId, title, fullscreen, active, signal, actions, useStore, useTabNavigation, shortcuts } = context;
    return function useTabInfo() {
        const layout = useStore((state) => state.bySession[sessionId]?.layout);
        const navigation = useTabNavigation(tabId);
        return (0, react.useMemo)(() => {
            const tab = layout?.tabs[tabId];
            if (layout === void 0 || tab === void 0 || navigation === void 0) throw new Error(`sidebarRight: tab "${tabId}" is not committed in session "${sessionId}"`);
            const pane = findTabPane(layout, tabId);
            return {
                sidebar: { expanded: layout.expanded, fullscreen },
                panel: { id: pane.id },
                tab: { ...tab, visible: …, navigation, signal, actions, refreshShortcut: … }
            };
        }, […]);
    };
};
```

Consumption (`.ref/dsh-official/dsh-client-ui-sidebar-documentpreview/lib/client.js:595-598`):

```js
function TextPreview({ useTabInfo, useResource, useStore, actions, loadPage, …, renderSlot, t, … }) {
    const { tab } = useTabInfo();
    const { navigation, signal } = tab;
    const meta = useResource(tab.contentId);
```

### 1.5 Owner props actually passed, per slot

`ownerProps` is whatever the parent passes as the **2nd** argument of `renderSlot`. Verified values:

| Slot | Owner props | Evidence |
|---|---|---|
| `root` | `{}` | renderer `:1503` "the shell supplies `{}`" |
| `sidebar` | `{ collapsed, width }` | `layout:300-302` |
| **`main`** | **`{}`** | `layout:118` `renderSlot("main", {}, { entryKey: … })` |
| `rightbar` | `{ width, viewportWidth, canShow }` | `layout:338-342` |
| `shell.overlay`, `shell.leading` | `{}` | `layout:312-313` |
| `sidebar.panellist` (list, rendered per row) | `{ size, active }` + `only: id` | `sidebar:190-193` |
| `main.conversation` | `{}` | `conversation:16354` |
| `conversation.header` | `{}` | `conversation:16021` |
| `conversation.session` | **`{}`** | `conversation:16202` `renderSlot("conversation.session", {})` |
| `conversation.content` (Factory input props) | `{ variant: "main", phase, hero }` + `{ slots: CONTENT_SLOTS }` | `conversation:16021-16025` |
| **`sidebar.right.pane.tab`** | **`{}`** | `sidebar-right:5550` `renderSlot(seat, {}, { entryKey, fallback, hookContext })` |
| **`sidebar.right.pane.tab.title`** | **`{}`** (same call site) | `sidebar-right:5550-5554` |
| `sidebar.right.tab.menu.item` | `{ tab, dismiss }` | `sidebar-right:5699-5702` |
| `sidebar.right.tab.guide.entry` | `{ entryId, kind, title, description? }`, `entryKey: providerId` | `sidebar-right:517-524` |

**Consequence:** for `main`, `conversation.session`, and both tab seats, *nothing* arrives through
owner props. Those components are driven entirely by the standard kit + their own `inject` +
(in the tab case) `useTabInfo()`.

### 1.6 Is there a standard `scope` / `sessionId` / `ownerProps` / `store` prop set?

Enumerated exactly, from `standardKit` (`renderer:715-746`), `materializeStandardBinding`
(`:646-657`) and `BUILTIN_SOURCE` (`session:121-130`):

- `scope` — **NO.** There is no `scope` prop. Scope is a registration *option* on the slot
  declaration (`children: { key: { kind, scope } }`, values `"root" | "session" | "session-maybe"`),
  and it selects *which* standard sources you get; the component is never told its scope by name.
- `sessionId` — **YES**, plain prop, session scope only (and `undefined` under `session-maybe` before a
  session arrives; see `materializeAbsent`, `session:398-414`).
- `ownerProps` — **NO such prop.** Owner props are spread flat (the "owner wins" line).
- `store` — **NO such prop.** The store seat arrives as the pair `useStore` + `actions`.
- `useTabInfo` — yes, on the two tab seats and guide seats.

Registered option surface, for completeness (`.ref/dsh-official/dsh-client-ui-slots/lib/index.js:163-219`):

```js
register(options, component)   // name, key*, id*, order*, label*, priority*, select*, inject*, children, store, locale, registrant
```

with the loud failures at `:165` (undeclared slot), `:176` (keyed without `key`), `:182` (list without
`id`), `:188` (chain without `select`), `:193` (child slot already declared). `label` is
`string | (() => string)` and resolved at read time by `resolveSlotLabel` (`slots:27-29`).

---

## Q2 — Putting a panel in `main`

### 2.1 How the layout renders `main`

`main` is declared as a **keyed, root-scoped** child of the `root` registration
(`.ref/dsh-official/dsh-client-ui-layout/lib/client.js:601-627`):

```js
const disposeRegistration = ctx.slots.register({
    name: "root",
    locale: "common",
    children: {
        "sidebar": { kind: "single", scope: "root" },
        "main":    { kind: "keyed",  scope: "root" },
        "rightbar": { kind: "single", scope: "root" },
        "shell.overlay": { kind: "list", scope: "root" },
        "shell.leading": { kind: "single", scope: "root" }
    },
    store
}, AppFrame);
```

and rendered with the **selected panel id as the key**, defaulting to `conversation`
(`.ref/dsh-official/dsh-client-ui-layout/lib/client.js:116-119`):

```js
/** Subscribe to the main key without subscribing the column frame to each panel id. */
function MainPanel({ usePanelInfo, renderSlot }) {
    return renderSlot("main", {}, { entryKey: usePanelInfo((info) => info.activePanelId) ?? "conversation" });
}
```

`usePanelInfo` is this package's own root hook (`:599`), fed by the root store field
`panelInfo.activePanelId` (`:388`) which starts `null` (`:401-403`).

### 2.2 The id → `main` key mapping (the exact code)

The mapping is **the shared string itself** — the sidebar row's `options.id` *is* the `main` entry's
`options.key`. Three pieces:

**(a) The sidebar collects panellist entries by id/order/label** —
`.ref/dsh-official/dsh-client-ui-sidebar/lib/client.js:452-469`:

```js
const syncPanels = () => {
    const next = ctx.slots.entriesOfSlot("sidebar.panellist").map(({ options }) => {
        const id = options.id;
        return { id, order: options.order ?? 0, label: resolveSlotLabel(options.label) ?? id };
    }).sort((a, b) => a.order - b.order);
    …
};
ctx.effect(() => ctx.slots.subscribe("sidebar.panellist", syncPanels), "ui-sidebar: panel entries");
```

**(b) The row hands that id straight to `ctx.layout.selectPanel`** —
`.ref/dsh-official/dsh-client-ui-sidebar/lib/client.js:173-199` and `:478-481`:

```js
onClick: () => { selectPanel(id); },        // PanelRow
…
selectPanel: (id) => {
    if (id === "plugins" || id === "schedules") ctx.get("productAnalytics")?.track(…);
    ctx.layout.selectPanel(id);
},
```

**(c) The layout validates the id against the live `main` registry** —
`.ref/dsh-official/dsh-client-ui-layout/lib/client.js:592-595` and `:462-466`:

```js
const layout = new LayoutController(instance.actions, (id) => ctx.slots.entries("main").some((entry) => entry.options.key === id), { … });
…
/** Select a global panel or return to the Conversation. */
selectPanel(panelId) {
    if (panelId !== null && !this.hasMainPanel(panelId)) throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`);
    this.navigation.abort();
    this.panels.selectPanel(panelId);
}
```

`retainMainPanels` (`:592-593`, `:663-664`) drops the selection back to `null` whenever the selected
key leaves the registry.

The official sidebar README states the same contract in prose
(`.ref/dsh-official/dsh-client-ui-sidebar/README.md:38`): *"Plugins add an icon component to the
root-scoped `sidebar.panellist` list with an `id`, optional `order`, and a string or locale-aware
`label`. The same id addresses the component registered in the layout's root-scoped `main` keyed
slot… The shipped composition registers no example panel."*

### 2.3 What a plugin must register — the checklist

For a new selectable main panel beside `conversation`:

1. **Panel body — `main`, keyed, key = your id** (the `conversation` precedent,
   `.ref/dsh-official/dsh-client-ui-conversation/lib/client.js:18435-18443`):

```js
slots.inject("main", function* () {
    yield slots.register({
        name: "main",
        key: "conversation",
        children: { "main.conversation": { kind: "single", scope: "session-maybe" } }
    }, ConversationPanel);
    …
});
```

   `ctx.slots.inject(key, cb)` is a **declaration wait**, not a read
   (`.ref/dsh-official/dsh-client-ui-renderer/lib/client.js:1343-1401`): on subscribe and on every
   declaration-epoch change it resolves `specDynamic(key)`; while the slot is undeclared it does
   nothing, and once it exists it runs `ctx.effect(callback, "slots.inject(<key>): declaration")`, so
   the callback's returned disposer is its cleanup and it is re-run on redeclaration. `cb` may be a
   **generator** yielding several disposers — that is how `ui-conversation` registers a panel plus six
   slots in one call (`conversation:18435-18450`). Use it because `main` may not be declared yet at your
   `apply` time. For a **root-scope**
   panel (no session), declare `scope: "root"` children; for a session-bound one, `"session-maybe"` like
   the conversation. Owner props are `{}` — get data from the standard kit.

2. **Sidebar row — `sidebar.panellist`, list, `id` = the same string:**

```js
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: "my-panel",          // === the main entry's key
    order: 30,               // lower renders first
    label: () => t("panel.title")   // string or locale-aware thunk
}, MyPanelGlyph));           // receives { size, active }
```

   The glyph component gets owner props `{ size: 16|18, active: boolean }` and is rendered with
   `only: id` (`sidebar:190-193`), so it must be a **bare icon-ish component**, not a row.

3. **Select it** from code with `ctx.layout.selectPanel("my-panel")`; `ctx.layout.selectPanel(null)`
   returns to the Conversation without changing the session.

The shipped composition registers **no** main panel besides `conversation`. Both ids observed in the
analytics call (`"plugins"`, `"schedules"` at `sidebar:479`) are *not* registered in this build.

---

## Q3 — The right pane tab system

### 3.1 What a "tab kind" is, and where `tab.kind` is resolved to a key

A tab record carries `{ id, kind, contentId, title }`. Rendering dispatches through the tab-type
registry, then through the **keyed** slot `sidebar.right.pane.tab`.
`.ref/dsh-official/dsh-client-ui-sidebar-right/lib/client.js:5519-5554` — `TabSlot`:

```js
function TabSlot({ renderSlot, occurrence, useTabTypes, useTabNavigation, useStore, fullscreen, shortcuts, active, retainTab, tab, seat, fallback }) {
    const { id, signal, tabActions } = occurrence(tab);
    const definition = useTabTypes((types) => types.find((definition) => definition.kind === tab.kind));
    const retained = seat === "sidebar.right.pane.tab" && definition?.keepMounted === true;
    …
    const content = renderSlot(seat, {}, {
        entryKey: definition?.id ?? tab.kind,
        fallback,
        hookContext
    });
```

**So: `tab.kind` → registered definition → `definition.id` → the keyed entry key.** If the kind is
unregistered the fallback key is the kind string itself (still misses, and the `fallback` renders:
`<p data-sidebar-right-unavailable>` "Nothing here can view this kind of content yet.",
`:5580-5584`).

The two seats are declared with their hook factory in one place
(`.ref/dsh-official/dsh-client-ui-sidebar-right/lib/client.js:9150-9168`):

```js
"sidebar.right.pane.tab":       { kind: "keyed", scope: "session", inject: { hooks: { tabInfo: tabInfoFactory } } },
"sidebar.right.pane.tab.title": { kind: "keyed", scope: "session", inject: { hooks: { tabInfo: tabInfoFactory } } },
"sidebar.right.tab.menu.item":  { kind: "list",  scope: "session" }
```

`bodiesFor` / `titlesFor` (`:5574-5595`) are what dockkit calls; the title falls back to
`tab.title` (the string captured at open time).

### 3.2 Opening a tab of your own kind — the exact API

Service face: **`ctx.sidebarRight`**. Methods (`sidebar-right:6385-6397`):

```js
openResource(address, options = {})   // address must start with "dsh-resource://"
openTab(kind, options = {})           // page type, addressed internally
```

Both throw when there is no on-screen, adopted session (`require()`, `:6744-6752`:
`"sidebarRight: no session surface is mounted"`) and when the kind/address is unclaimed
(`:6445`, `:6451`: `no tab type is registered as "<kind>"`).

Options are **placement only** (`:6460-6489`), never a type property:

| Option | Effect |
|---|---|
| `paneId` | target dock pane; default = active docked pane (`:6462`) |
| `replaceTab` | close that tab first; takes precedence and disables `preferNewPane` |
| `preferNewPane` | ask the target pane to split if the budget/room allow, else fall back (`:6464`) |
| `revealIfOpened` | `false` disables focus-the-existing-tab dedup for resource tabs (pages always dedup per pane) |
| `params` | JSON-shaped navigation params, delivered as `tab.navigation.params`, `revision` stepped |

There is also the tab-scoped variant reachable from inside a body: `tab.actions.openTab(kind, opts)`
and `tab.actions.openResource(address, opts)` (the guide uses it —
`sidebar-right:530` `tab.actions.openTab(selected.kind, { replaceTab: true })`), which route to the
owning session, not the on-screen one.

Minimal open call:

```js
ctx.sidebarRight.openTab("my-panel-kind", { params: { id: 42 }, revealIfOpened: false });
```

### 3.3 Registering a type: body, title, icon, menu items

The canonical two-stage path, from the **shipped extension** that proves it
(`.ref/dsh-official/dsh-client-ui-sidebar-documentpreview/lib/client.js:6811, 6822-6855`):

```js
// stage 1 — the type
ctx.effect(() => ctx.sidebarRightTabs.register(textDefinition()), "ui-sidebar-documentpreview: text type");

// stage 2a — the body, keyed by definition.id
ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: TEXTPREVIEW_ID,
    locale: NS,
    store,
    children: { … },
    inject: (sessionId, actions) => ({ ...face(sessionId, actions), hooks: { documentPreviews: source } })
}, TextPreview)), "ui-sidebar-documentpreview: text body");

// stage 2b — the chip title, same key
ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
    name: "sidebar.right.pane.tab.title",
    key: TEXTPREVIEW_ID
}, TextTitle)), "ui-sidebar-documentpreview: text title");
```

with the type definition (`:1079-1088`):

```js
function textDefinition() {
    return {
        id: TEXTPREVIEW_ID,                                  // "@deepseek-ai/dsh-client-ui-sidebar-documentpreview"
        kind: TEXTPREVIEW_KIND,                              // "text"
        patterns: ["dsh-resource://file/**"],
        priority: "fallback",
        canOpen: (address) => parseFileAddress(address)?.scope === "session",
        title: basenameOf
    };
}
```

**Icon.** There is no `icon` field on a *tab*. The chip is drawn by the title seat, so the icon goes
inside your title component. The shipped guide does exactly this
(`.ref/dsh-official/dsh-client-ui-sidebar-right/lib/client.js:432-435`):

```js
function GuideTitle({ useTabInfo }) {
    const { tab } = useTabInfo();
    return (0, react_jsx_runtime__WEBPACK…)(Fragment, { children: [CompassGlyph({ className: …titleIcon }), tab.title] });
}
```

For the **guide's entry cards** (`guide: [{ id, kind, title, description?, icon?, order, commandId? }]`)
there *is* an `icon` component slot — `EntryBox` at `:460-461`:

```js
const Icon = entry.icon ?? CubeGlyph;
```

rendered `<Icon size={22|26} className={entry.icon === undefined ? placeholderInk : undefined} />`
(`:474-477`). Guide entries are flattened with `kind` and `providerId` injected
(`:8844-8848`).

**Menu items.** Seat `sidebar.right.tab.menu.item` (list, session scope), appended after the kit's own
layout actions. Owner props `{ tab, dismiss }` (`:5699-5702`). Register with `id` + `order`:

```js
ctx.slots.inject("sidebar.right.tab.menu.item", () => ctx.slots.register({
    name: "sidebar.right.tab.menu.item", id: "my-action", order: 10
}, ({ tab, dismiss, t }) => /* your MenuItemButton */ null));
```

**No shipped package registers this seat** (grep: 0 hits outside the sidebar-right declaration), so its
props are the only contract you get.

Other extension seats (`sidebar-right:9200-9225`): `sidebar.right.tab.guide` (chain — replaces the
guide body without replacing the tab) and `sidebar.right.tab.guide.entry` (keyed by `providerId`).

Keep-alive: a type may declare `keepMounted: true`; the seat then retains visited bodies across tab,
session, collapse and docking (`:5522-5528`, and the `keepMounted` predicate handed to dockkit at `:5698`).

**Multiple instances:** declare `multiple: true` on the definition; each open then gets a distinct
address (`placeTab`, `:6452`: `` `${pageAddress(kind)}/${randomUUID()}` ``).

**Close cleanup:** `ctx.sidebarRight.registerCloseHandler(kind, handler)` (`:6345-6351`) — one handler
per kind, duplicate registration throws, a thrown handler preserves the tab (`:6439-6442`).

### 3.4 Persistence — yes, per session, in `localStorage`

`.ref/dsh-official/dsh-client-ui-sidebar-right/lib/client.js:4911-4914` and `:4998-5045`:

```js
/** Persistence namespace shared by scoped stores and startup discovery. */
const sidebarPersistence = "dsh.sidebar-right.v1";
…
raw = localStorage.getItem(`${sidebarPersistence}.${sessionId}`);
…
localStorage.setItem(`${sidebarPersistence}.${sessionId}`, JSON.stringify(saved));
…
localStorage.removeItem(`${sidebarPersistence}.${sessionId}`);
```

Startup discovery enumerates the same prefix (`:6196-6198`:
`if (key === null || !key.startsWith("dsh.sidebar-right.v1.")) continue;`). What is stored: layout,
tab identities, selection, split ratios, floating rectangles, presentation and the identity counter
(`README.md:74`). Undo history is memory-only. Field types, node membership, selection, identity
counters and the one/two-pane shape are validated before adoption; invalid data clears **only its
session key** (`README.md:74`).

### 3.5 Can a plugin embed the real Conversation in a right-pane tab?

**No — and the premise is false: the slot `sidebar.chat.conversation` does not exist in this build.**
A grep for `sidebar.chat` across every extracted bundle and official package returns **zero** matches.
The conversation's real slot surface is `main` key `conversation` → `main.conversation` →
`conversation.header` / `conversation.content` (Factory) → `conversation.session`, plus
`conversation.view`, `conversation.composer.*`, `conversation.input.dock`,
`conversation.session.header.*` (`.ref/dsh-official/dsh-client-ui-conversation/lib/client.js:18143-18450`).

Who registers the conversation: `ui-conversation`, gated on the layout's `main` declaration
(`conversation:18435-18443`, quoted in §2.3). It is registered as a **keyed entry under `main`**, and a
keyed slot renders exactly one entry per key.

Why a plugin cannot reuse it: `renderSlot` only accepts keys **you declared in your own registration's
`children` table** — otherwise it throws `SlotOwnershipError` (`renderer:332`,
``slot '${key}' is not declared by this entry's children``), and the registry rejects a second
declaration of an already-declared slot (`slots:191-194`). A right-pane tab body renders under
`rightbar.session` scope with key `definition.id`; it has no path to the conversation's subtree.
The only shipped way to reach the conversation is `ctx.layout.selectPanel(null)` — i.e. *replace* the
center column, not embed it.

### 3.6 Collapse / expand / show / hide, programmatically

Two layers exist; pick by intent.

**(a) The right-column face — `ctx.sidebarRight`** (`sidebar-right:6494-6522`):

| Call | Effect |
|---|---|
| `isExpanded()` | `mountedSurface()?.layout.expanded ?? false` |
| `toggleExpanded()` | collapse, or expand **and focus the active dock pane after render**; throws with no on-screen session |
| `toggleFullscreen(target)` | the chrome button's action; needs a captured dock target (`:6644-6651`) |
| `focus(tabId)`, `split(paneId?)`, `float(tabId, rect?)`, `dock(paneId)`, `close(tabId)`, `active()` | layout operations, each recorded like the gesture it stands in for |
| `openTabs` | observable inventory of open tabs across saved + adopted sessions (`:6333`, `:6292`) |
| `mounted` | observable of the on-screen session (selected session while the conversation fills the center; `undefined` when a global panel replaces it) (`:6335`, `:6368`) |
| `_undo()` / `_redo()` | `@internal`, tests only |

Note there is **no `expand()`/`collapse()` pair** — only `toggleExpanded()` and `isExpanded()`; and
`split`/`float`/`dock`/`focus`/`toggleFullscreen` require a live mounted surface
(`require()`, `:6744`) or a captured target.

**(b) The frame face — `ctx.layout`** (`.ref/dsh-official/dsh-client-ui-layout/lib/client.js:481-488`):

```js
/** Report the right panel's track and fullscreen presentation. */
openRightbar(track, fullscreen) { this.panels.openRightbar(track, fullscreen); }
/** Report the right panel as hidden: no track, no handle. */
closeRightbar() { this.panels.closeRightbar(); }
```

Store semantics (`layout:426-439`): `openRightbar` sets `rightbarShown = true`, `rightbarTrack = track`,
`rightbarFullscreen = fullscreen`, defaults the pixel width to
`max(300, round(viewportWidth * RIGHTBAR_DEFAULT_RATIO))`, and auto-collapses a manually expanded left
sidebar below 1024px. `closeRightbar` clears shown/track/fullscreen. **The right column's occupant is
the one that reports presentation** — ui-sidebar-right calls these from its injected
`syncPresentation` (`sidebar-right:9112-9115`), and the frame never injects that package
(`layout README:48`). A plugin that opens tabs does *not* need to call them: `openTab` expands the
column itself (`README.md:93`, "the panel expands, because content the user cannot see is not opened").

Left sidebar, for symmetry: `ctx.layout.toggleSidebar()` (`layout:477-480`).

---

## Q4 — The tab kind registry / controller

Two services, both provided by `ui-sidebar-right` in one effect and torn down with it
(`sidebar-right:9073-9079`):

```js
const disposeRegistry = ctx.reflect.provide("sidebarRightTabs", tabs);
const disposeService  = ctx.reflect.provide("sidebarRight", controller);
ctx.effect(() => () => { controller.tabDomain.dispose(); disposeService(); disposeRegistry(); }, "ui-sidebar-right: service faces");
```

### 4.1 `ctx.sidebarRightTabs` — `SidebarRightTabRegistry`

Declared `.ref/dsh-official/dsh-client-ui-sidebar-right/lib/client.js:8665-8851`. Fields:
`kinds: Map`, `ids: Set`, `listeners: Set`, `registrations`, `cached`, `guideEntries`.

| Method | Signature | Behaviour |
|---|---|---|
| `register` | `register(definition) → disposer` | `:8690-8721`. Effect-scoped; lives as long as your plugin. |
| `active()` | `→ entry[]` | every kind's *in-force* registration, in registration order (`:8749-8751`) |
| `entries()` | `→ definition[]` | reference-stable cache (`:8756-8758`) |
| `guide()` | `→ guideEntry[]` | flattened `{ ...entry, kind, providerId }` sorted by `order` (`:8763-8765`, `:8844-8848`) |
| `get(kind)` | `→ definition \| undefined` | the type in force for a kind (`:8771-8773`) |
| `candidates(address)` | `→ definition[]` | best-first ranking by band → matched-pattern length → registration order, minus `canOpen` vetoes (`:8782-8798`) |
| `claim(address, kind?)` | `→ { kind, contentId, title }` | with `kind`: that type, globs skipped, `canOpen` still honoured; without: best candidate. Throws when nothing claims (`:8812-8830`) |
| `subscribe(listener)` | `→ unsubscribe` | low-frequency invalidation (`:8836-8841`) |

**Definition shape** (`README.md:83` + `:8690-8707`):
`{ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted?, multiple? }`.

- `id` — this implementation's identity; **unique across every registration**; also the key your body
  and title register under (`:8695` throws on a duplicate id). Use your package name.
- `kind` — the discriminator the tab record stores. A kind holds at most one `builtin` and one
  `extension`; `coexists()` decides, the higher band is in force and the other is shadowed
  (`:8723-8747`). Any other collision throws (`:8697`).
- `priority` — band literal: `"extension"` (highest, the default when none is named) > `"builtin"` >
  `"fallback"`. The bands are plain string literals so another package needs no runtime import
  (`README.md:86`).
- `patterns` — globs over `dsh-resource://` addresses (picomatch is bundled in the file). A pattern
  containing `:` matches the whole address; one without matches the URI path at any depth,
  case-insensitively. Page types name none and are opened by kind.
- `title(address)` — the chip text, **captured when the tab opens** (`:8820`, `:6456`). A live title
  comes only from the title seat (`README.md:146`).
- `guide` — `[{ id, kind, title, description?, icon?, order, commandId? }]`; entry ids must be unique
  within their provider (`:8693`).

The bands and their coexistence rule are literal (`.ref/dsh-official/dsh-client-ui-sidebar-right/lib/client.js:8618-8632`):

```js
/** Rank of each band, highest first. */
const RANKS = { extension: 3, builtin: 2, fallback: 1 };
/** The band a definition that names none is in. */
const DEFAULT_BAND = "extension";
function coexists(slot, band) {
    return band !== "fallback" && slot.inForce.band !== "fallback" && slot.inForce.band !== band && slot.shadowed === void 0;
}
```

So an `extension` may take over a `builtin`'s kind; a `fallback` shares its kind with nothing.

### 4.2 `ctx.sidebarRight` — `SidebarRightController`

Declared `:6329-6753`. Constructor `(tabs, pin, host, sessions)`; public surface:

| Member | Kind | Line |
|---|---|---|
| `openResource(address, options?)` | method | `:6385` |
| `openTab(kind, options?)` | method | `:6394` |
| `close(tabId)` | method | `:6494` |
| `active()` | method | `:6501` |
| `isExpanded()` | method | `:6511` |
| `toggleExpanded()` | method | `:6515` |
| `focus(tabId)` | method | `:6527` |
| `focusedTarget(element?)` / `commandTarget(element?)` | method | `:6537` / `:6546` |
| `openTabFromTarget(kind, target)` | method | `:6569` |
| `canCloseTarget(target)` / `closeTarget(target)` | method | `:6589` / `:6598` |
| `isTargetCurrent(target)` | method | `:6615` |
| `splitBlock(target)` | method | `:6630` |
| `toggleFullscreen(target)` | method | `:6644` |
| `split(paneId?)` | method | `:6657` |
| `float(tabId, rect?)` / `dock(paneId)` | method | `:6679` / `:6690` |
| `_undo()` / `_redo()` | `@internal` | `:6702` / `:6711` |
| `registerCloseHandler(kind, handler)` | method | `:6345` |
| `tabsIn(sessionId)` | method | `:6377` |
| `mounted` | observable | `:6335` |
| `openTabs` | observable | `:6333` |
| `tabDomain` | internal-ish, used by the seat | `:6356` |
| `openResourceIn` / `openTabIn` / `closeIn` | **not** part of `ISidebarRight` — the Tab domain's session-scoped path | `:6406` / `:6418` / `:6429` |
| `adopt` | deliberately **absent** from the public controller (`README.md:104`) | — |

Command helpers throw rather than write into a surface nobody draws
(`:6747` `"sidebarRight: no session surface is mounted"`).

Consumption example from a sibling package (`.ref/dsh-official/dsh-client-ui-chat/lib/client.js:12334-12335, 12436`):

```js
ctx.inject(["sidebarRightTabs"], (scope) => {
    const tabs = scope.sidebarRightTabs;
    …
    if (linkOpening.getSnapshot() === "sidebar" && ctx.get("sidebarRightTabs")?.get("browser") !== undefined)
        ctx.sidebarRight.openTab("browser", { params: { url } });
```

---

## Q5 — UI primitives inventory

Package `@deepseek-ai/dsh-client-ui-primitives`, built as a **single flat ESM** with exactly one
export statement — `.ref/dsh-official/dsh-client-ui-primitives/lib/index.js:12381`
(`export { … }`) — **282 public names**, zero Cordis, zero slot knowledge.
`package.json` exposes only `"."` (plus `./src/*` for the workspace): there is **no `icons/*` subpath**;
icons are flat named exports.

### 5.1 Layout / containers

**No dedicated layout primitives.** There is **no** `Stack`, `Grid`, `Box`, `Panel`, `Card`, or
`ScrollArea`. Found, and only these:

- `DisclosureRow` — the one structural row (H24, title + content side by side).
- `Modal` — top-layer dialog with a viewport mask.
- `MenuSurface` — the shared translucent card material for menus and menu-like surfaces.
- `MenuGroup`, `observeStickyMenuGroups` — grouped sections with sticky headings.

> **Resize / split pane: NOT PRESENT.** `IconCompareSplitOutlineRegular/Medium` is an *icon*. Split
> panes in the right sidebar come from the external package `@deepseek-ai/dsh-client-ui-dockkit`
> (`DockLayout`, `canSplit`, `getPane`, `dockPaneIds`, `findTabPane`, `findContentTab`,
> `activeDockPaneId` — see `sidebar-right:5686-5712, 6462`). The layout's own column divider is a private
> `DragHandle` (`layout:136-205`) that is not exported. The dockkit package is **not in the asar
> listing** (see Appendix B).
>
> **Scroll container: NOT PRESENT.** Scrolling is plain CSS; `useAnchoredMaxHeight(ref, cap, signal, margin)`
> (`:4418`) is the only related helper — it computes a max height for an anchored surface.

### 5.2 Form & input

`Button` (`:3216`, `variant: primary|ghost|outline|toolbar`, `size: md|sm`, `icon`),
`Input` (`:3529`, `forwardRef`, `icon`, cleared on unmount),
`Checkbox` (`:3507`, `checked, onChange, label, disabled, title`),
`Switch` (`:3394`, `checked, onChange, label, disabled, title`; 36×20),
`SegmentedControl` (`:3444`, `id, value, options, onChange, label, disabled`),
`SegmentedTabs` (`:3261`, `items, value, onChange, label`),
`SettingsForm` (`:6918`), `SettingsValueField` (`:6973`), `SettingsSecretField` (`:7052`),
`RiskConfirmation` (`:5273`).

**No `Textarea`, no `Select`, no `Radio`, no `Slider`.**

### 5.3 Feedback & overlay

`Modal` (`:5210`), `Tooltip` (`:4674`), `HoverCard` (`:4916`), `Toast` (`:6831`),
`Menu` (`:3927`), `MenuItemButton` (`:3830`), `MenuSurface` (`:3782`), `MenuGroup` (`:4283`),
`ImageLightbox` (`:11077`), `ConnectionIndicator` (`:5331`),
`Pill` (`:3236`), `Tag` (`:3327`, 8 `tone` palettes), `StateDot` (`:3060`, `appearance: dot|step`),
`DisclosureRow` (`:3156`), `PathLabel` (`:3344`), `TextShimmer` (`:3116`), `ShortcutKeys` (`:3763`).

Key prop signatures (verbatim):

```js
function Menu({ open, anchor, items = [], children, selectedId, selectedIds, onSelect, onClose,
                align = "start", side = "bottom", portal = false, closeOnPointerLeave = false,
                dense = false, compact = false, autoFocus = false, selection = "check",
                getAnchorRect, footer, className, listClassName })          // :3927
function Tooltip({ label, shortcutKeys, side = "right", align = "center", delayMs = 0,
                   focusDelayMs = 0, gap = 8, disabled = false, portal = false, maxWidth,
                   openOnClick = false, children })                          // :4674
function Modal({ open, onClose, title, closeLabel, description, children, footer, className,
                 contentClassName, onKeyDownCapture, headless = false, backdropBlur = true,
                 shortcutModal })                                            // :5210
```

### 5.4 Output / content renderers

`MarkdownText`, `MarkdownDelegateProvider`, `CodeBlock`, `JsonTree`, `JsonBlock`,
`TerminalBlock`, `ReadBlock`, `DiffBlock`, `SearchBlock`, `WebBlock`,
`projectUserText`, `extractMarkdownPlainText`, `diffTotals`,
`DEFAULT_READ_MAX_LINES`, `DEFAULT_DIFF_MAX_LINES`, `DEFAULT_SEARCH_MAX_LINES`,
`DEFAULT_TERMINAL_MAX_LINES`, `CODE_HIGHLIGHT_EXTENSIONS`.

### 5.5 Icons and artwork

Naming convention: **`Icon<Name><Shape><Weight>`** where `<Shape>` ∈ `Outline | Fill` and
`<Weight>` ∈ `Regular` (1 px artwork) | `Medium` (1.3 px stroke); rendered size comes from the `size`
prop, not the name. Pairs are exported deliberately so callers can switch emphasis
(README.md:87). Weight constants: `ICON_REGULAR_STROKE`, `ICON_MEDIUM_STROKE`.

Full icon set found in the export list (`primitives-exports.txt`, names only, pairs collapsed):

```
AgentPresetOutline, AlarmClockOutline, ApiOutline, ArchiveCheckOutline, ArchiveOffOutline,
ArchiveOutline, BranchOutline, BrowseOutline, CheckCircleFill, CheckCircleOutline, CheckOutline,
ChecklistOutline, ChevronDownOutline, ChevronLeftOutline, ChevronRightOutline, ChevronUpOutline,
ChevronsUpDownOutline, ClockOutline, CloseCircleFill, CloseFill, CloseOutline, CodeOutline,
CompactOutline, CompareSplitOutline, ContextInjectionOutline, CopyOutline, CordisPluginOutline,
DarkOutline, DataOutline, DatabaseOutline, DeliverDoc, DislikeFill, DislikeOutline, DownloadOutline,
EditOutline, EllipsisOutline, EnhanceOutline, FlatListOutline, FolderClose, FolderOpen,
FolderOpenOutline, FollowsystemOutline, FullscreenOutline, GaugeOutline, GlobeOutline, GoalOutline,
InfoOutline, InspectOutline, LightOutline, LikeFill, LikeOutline, LinkOutline, ListPenOutline,
LoadingOutline, MicrophoneOutline, NewChatOutline, NowrapFill, PanelLeftOutline, PaperPlaneOutline,
PaperclipOutline, PauseOutline, PersonalizationOutline, PinFill, PinOutline, PlanOutline, PlayOutline,
PluginPinwheelOutline, PlusOutline, ProjectAddOutline, QuestionOutline, QueueOutline, RefreshOutline,
RightUpOutline, SearchOutline, SendOutline, SettingsOutline, ShareOutline, ShieldOutline, SkillOutline,
SlidersTwoOutline, Sparkle, StopFill, ThinkOutline, TrashOutline, TreeCorner, TriangleRightFill,
UnarchiveOutline, UserOutline, UsersOutline, WarningOutline, WarningTriangleOutline,
WorkspaceTreeOutline, WrapFill, WrapLinesOutline
```

Non-`Icon*` artwork: `FishLogo`, `BrandWordmark`, `FISH_LOGO_PATH`, `FISH_LOGO_VIEWBOX`,
`SHIELD_OUTLINE_PATH`, `ReferenceIconRegular`/`Medium`, `LinkIconRegular`/`Medium`,
`PermissionIconReadOnly|WorkspaceWrite|FullAccess` × `Regular|Medium`,
`PluginArtworkTerminal|Loop|Subagent|Search|Default`, `GuideArtworkBrowser|Files`,
`FileTypeIcon`.

### 5.6 Exported plain functions / hooks / constants (complete)

```
classifyFileType(path, context)          :6207      fileExtension(path)                  :6194
classifyLinkPath(path)                   :6522      fileSizeText(bytes)                  :6891
closeTopModal(document)                  :3677      isBehindModal(anchor)                :3687
diffTotals(diffs)                        :9716      isDarwinDesktop()                    :8070
extractMarkdownPlainText(markdown, opts) :12106     pointerModality()                    :4607
focusWithoutRing(element, options)       :3648      rankByName(items, rawQuery)          :8036
observeComposition(document)             :3593      relativeTime(at, now)                :7950
observeStickyMenuGroups(viewport)        :4309      writeClipboard(text)  (async)        :4551
projectUserText(text, sessionLabels, slashNames, slashKind, reference)  :6700
useAnchoredMaxHeight(ref, cap, signal, margin)   :4418
useAnchoredPosition(options)                     :4459
useDismissOnOutsidePointer(root, open, setOpen, portal)  :4525
useModalLayer(dialog, open, onClose)             :3703
useCodeHighlighter(language)                     :7931
SettingsFormModel (class)                        :7151
settingsNumberField(field) :7110   settingsTextField(field) :7131
constants: modalSelector :3670, ICON_REGULAR_STROKE :? , ICON_MEDIUM_STROKE, FISH_LOGO_PATH,
           FISH_LOGO_VIEWBOX, SHIELD_OUTLINE_PATH, CODE_HIGHLIGHT_EXTENSIONS (re-exported from
           @deepseek-ai/dsh-util-code-language), DEFAULT_*_MAX_LINES
```

`languageForPath` is **re-exported** from `@deepseek-ai/dsh-util-code-language`
(`import { CODE_HIGHLIGHT_EXTENSIONS, languageForPath } from "@deepseek-ai/dsh-util-code-language";` —
`:40`); it appears in the export list without a local definition.

### 5.7 Portal / overlay helpers

**No exported `Portal` component.** `createPortal` is imported from `react-dom` (`:17`) and used
internally by `Menu` (`:4272`, `:3802`), `Tooltip` (`:4887`), `HoverCard` (`:5184`), `Modal` (`:5214`),
`ImageLightbox` (`:6857`), and one more surface (`:11099`). Two components expose the behaviour as a
prop instead — `portal` on **`Tooltip`** and **`Menu`**:

```js
children: [anchor, portal ? list !== false && createPortal(list, document.body) : list]   // Menu :4272
}), portal ? content !== false && createPortal(content, document.body) : content]         // Tooltip :4887
```

So a plugin that needs a body-level overlay should use `Tooltip`/`Menu` with `portal`, or call
`createPortal` from its own React import.

---

## Q6 — Theme tokens

### 6.1 Naming convention and where tokens are defined

Convention: **`--dsw-<layer>-<group>-<name>`**, plus a handful of `--dsh-*` runtime/frame variables.

The whole token system is emitted from `@deepseek-ai/dsh-client-ui-theme` as **injected `<style>` text**,
not as a separate `.css` file. In the built bundle each stylesheet is one long string constant:

| Line in `.ref/dsh-official/dsh-client-ui-theme/lib/client.js` | Constant | Defines |
|---|---|---|
| `1142` | `base_css_default` | `:root` fonts, easings, **radii** |
| `1145` | (`--dsw-corner-shape`) | `superellipse(1.5)` |
| `1148` | `design_platform_css_default` | **all `--dsw-static-*` palette ramps and all `--dsw-alias-*` semantic tokens** — light in `body{…}`, dark in `body[data-ds-dark-theme]{…}` |
| `1151` | `focus_css_default` | `--dsw-focus-ring-width` (2px), `--dsw-focus-ring-color` |
| `1154` | `onboarding_css_default` | onboarding accents/gradients |
| `1157` | `scrollbar_css_default` | `--dsh-scrollbar-*` |
| `1160` | `gradient_shadow_text_css_default` | shadows, elevation, `--dsw-menu-backdrop-filter`, `--dsw-mask-blur`, `--dsh-content-font-*` |
| `1163` | `shiki_css_default` | `--shiki-*` code colours |

Proof of the definition site (`:1148`): `body{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00);…}`
and later in the same line `body[data-ds-dark-theme]{…--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950);…}`.

**Runtime application.** The theme snapshot is written onto `document.body` as inline custom properties
by the layout's `ThemePresenter` — `.ref/dsh-official/dsh-client-ui-layout/lib/client.js:532-548`:

```js
const scheme = snapshot.active.colorScheme;
document.documentElement.style.colorScheme = scheme;
document.documentElement.setAttribute(THEME_SOURCE_ATTRIBUTE, snapshot.preference === "system" ? "system" : scheme);
const body = document.body;
if (scheme === "dark") body.setAttribute(DARK_ATTRIBUTE, "");
else body.removeAttribute(DARK_ATTRIBUTE);                    // DARK_ATTRIBUTE = "data-ds-dark-theme"  (:499)
body.style.setProperty(CONTENT_FONT_SIZE_VARIABLE, `${snapshot.fontSize}px`);   // "--dsh-content-font-size" (:511)
for (const name of this.appliedTokens) body.style.removeProperty(name);
for (const [name, value] of Object.entries(snapshot.active.tokens)) body.style.setProperty(name, value);
```

So: **use the variables, never hard-code colours** — that is what makes a plugin follow light/dark
automatically. Third-party themes register alias-layer overrides via
`ctx.theme.overrideTokens(source, tokens)` (`theme:1474-1477`, validation at `:1540-1542`).

### 6.2 Inventory size (measured)

Distinct `--dsw-*` / `--dsh-*` names found across the theme bundle and every
`dsh-client-ui-primitives\lib\**\*.module.css`: **425**, split as
`dsw-font-*` 182 · `dsw-alias-*` 109 · `dsw-static-*` 77 · `dsw-other` 15 · `dsh-*` 19 ·
`dsw-elevation/shadow/gradient` 17 · `dsw-radius-*` 6.

### 6.3 The ~25 tokens that matter for building a panel

All names below were grepped from the files above; values are the **light** definition from
`theme:1148` with the **dark** value after the slash where the two differ.

**Surfaces / backgrounds**

| Token | Use | Value (light / dark) |
|---|---|---|
| `--dsw-alias-bg-base` | page & panel ground (the conversation's ground) | `--dsw-static-neutral-bluish-00` `#fff` / `#151517` |
| `--dsw-alias-bg-layer-1` | raised card, first layer | `bluish-00` `#fff` / `#232324` |
| `--dsw-alias-bg-layer-2` | second layer (settings cards use it via `--dsw-alias-settings-card-fill`) | `bluish-00` / `#2c2c2e` |
| `--dsw-alias-bg-layer-3` | third layer | `bluish-00` / `#353638` |
| `--dsw-alias-bg-overlay` | inset wells, chips, inactive fields | `bluish-150` / `bluish-700` `#61666b` |
| `--dsw-alias-bg-module-platform` | segmented-control / stepper track | `bluish-60` `#f5f6f7` / `bluish-800` `#353638` |
| `--dsw-alias-bg-skeleton` | loading shimmer | `#0000000a` / `#ffffff14` |
| `--dsw-alias-bg-mask-1` / `-2` / `-3` | modal / soft / strong scrims | `#0000003d` / `#00000080`; `#0000001f` / `#0003`; `#0000007a` both |
| `--dsw-menu-surface-fill` | menu card material (also exposed as `--dsw-specific-menu`) | `#f8f9fa94` (dark overrides via `[data-menu-material]`) |

**Labels**

| Token | Use | Value (light / dark) |
|---|---|---|
| `--dsw-alias-label-primary` | body text | `bluish-1000` `#0f1115` / `bluish-50` |
| `--dsw-alias-label-secondary` | supporting text (the expand button uses it, `sidebar-right:540`) | `bluish-700` / `bluish-300` |
| `--dsw-alias-label-tertiary` | captions/descriptions | `bluish-600` / `bluish-400` |
| `--dsw-alias-label-caption` | smallest captions, disabled-ish text | `bluish-400` / `bluish-600` |
| `--dsw-alias-label-primary-foreground` | text on a filled brand surface | `bluish-00` / `bluish-1000` |
| `--dsw-alias-label-dimmed` | de-emphasised fill-level text | `bluish-200` / `bluish-750` |

**Borders & interaction fills**

| Token | Use | Value (light / dark) |
|---|---|---|
| `--dsw-alias-border-l1` | faintest divider | `#0000000a` / `#ffffff0f` |
| `--dsw-alias-border-l2` | standard divider (theme rows use it: `theme:26`) | `#0000001a` / `#ffffff1f` |
| `--dsw-alias-border-l3` | stronger border | `#0000001f` / `#ffffff29` |
| `--dsw-alias-border-l4` | card/cube stroke | `#00000029` / `#fff3` |
| `--dsw-alias-interactive-bg-hover` | hover fill on any row/control | `#2631480f` / `#ffffff14` |
| `--dsw-alias-interactive-bg-active` | pressed fill | `#2631481a` / `#ffffff24` |

**Brand / accent / semantic**

| Token | Use | Value (light / dark) |
|---|---|---|
| `--dsw-alias-brand-primary` | brand fill (primary button track) | `bluish-1000` / `bluish-50` |
| `--dsw-alias-button-primary-fill` | primary button background | `= --dsw-alias-brand-primary` |
| `--dsw-alias-button-primary-hover` | primary button hover | `bluish-750` / `bluish-100` |
| `--dsw-alias-link` | links | `deepseek-500` / `deepseek-400` |
| `--dsw-alias-state-error-primary` | errors, destructive icons | `red-600` / `red-400` |
| `--dsw-alias-state-warn-primary` | warnings | `amber-500` |
| `--dsw-alias-state-success-primary` | success/done dot | `green-500` |
| `--dsw-alias-state-business-primary` | focus ring + business accent | `deepseek-500` / `deepseek-400` |
| `--dsw-alias-state-idle-primary` | idle dot | `neutral-300` / `neutral-600` |
| `--dsw-alias-scrollbar-bg-l1` / `--dsw-alias-scrollbar-hover-l1` | wired to `--dsh-scrollbar-thumb(-hover)` at `theme:1157` | `neutral-200`/`neutral-300`; `neutral-700`/`neutral-600` |

**Radii, elevation, spacing, type**

| Token | Value | Source |
|---|---|---|
| `--dsw-radius-xs` | `4px` | `theme:1142` |
| `--dsw-radius-sm` | `8px` (Button `sm` is R8) | `theme:1142` |
| `--dsw-radius-md` | `12px` (Button `md` is R12; MenuGroup headings outside darwin) | `theme:1142` |
| `--dsw-radius-lg` | `16px` | `theme:1142` |
| `--dsw-radius-xl` | `20px` (the "R20" guide cards / theme cubes) | `theme:1142` |
| `--dsw-radius-panel` | `28px` | `theme:1142` |
| `--dsw-elevation-panel` / `-prominent` / `-soft` / `-stroke` | composed shadow stacks built from `--dsw-elevation-stroke-color` | `theme:1160` |
| `--dsw-menu-backdrop-filter` | `blur(40px) saturate(150%)` | `theme:1160` |
| `--dsh-content-font-size` | user content font size in px, set by the presenter | `layout:511,539` |
| `--dsh-content-font-size-secondary` | derived secondary size | `theme:1160` |
| `--dsh-scrollbar-width` | `5px` | `theme:1157` |
| `--dsw-focus-ring-width` | `2px` | `theme:1151` |
| `--dsw-corner-shape` | `superellipse(1.5)` | `theme:1145` |

> **No spacing scale exists.** There is no `--dsw-space-*` / `--dsw-gap-*` token family; official
> stylesheets hard-code px (e.g. `padding:16px 0; gap:8px` in `theme:26`). Control heights are likewise
> literal (`Button` H36 `md` / H28 `sm`, `Switch` 36×20, `DisclosureRow` H24 — README.md:44,56,116).

### 6.4 Frame tokens (published by the layout package, not theme tokens)

These are set on the frame element / root, not by the theme:
`--dsh-frame-top-clearance` (48 px reserved strip), `--dsh-frame-overlay-top` (+20 px for dialogs/menus),
`--dsh-frame-chrome-top` (0 in fullscreen), `--dsh-frame-leading-clearance` (macOS traffic-light band),
`--dsh-windows-content-radius`, `--dsh-windows-sidebar-width`
(`.ref/dsh-official/dsh-client-ui-layout/lib/client.js:319`, README.md:37-41). A main panel that reaches
the top-left corner should pad by the leading/top clearance; plain browser documents publish none of them.

---

## Appendix A — the shipped plugin skeleton

Official template, `.ref/dsh-official/cordis-plugin-development/templates/decoration/client.js:1-22`
(this is the exact browser bundle format: the `id` equals the package name, React comes from the
browser module table):

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Decoration() { return h('svg', { … }); }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
        }, Decoration));
      },
    };
  },
});
```

Companion guidance (`.ref/dsh-official/cordis-plugin-development/references/ui-plugin.md:1-13`):
the `package.json` adds a `dsh.client` section (`platform`, `immediately`, `inject`) plus a `./client`
export; `index.js` exports `apply()`; register timers/listeners/styles inside `apply` with
`ctx.effect` / `ctx.on` and return cleanups; route visible text through the locale service; **do not**
replace the app root, append a second app to `document.body`, or read another plugin's DOM to fake
placement — choose a slot that already allocates space.

## Appendix B — UNVERIFIED / not found (do not treat as API)

1. **`useSidebarRightPaneTab`** — zero occurrences anywhere. Use `useTabInfo()`.
2. **`sidebar.chat.conversation`** — zero occurrences anywhere. The conversation's slot is `main`
   key `conversation` (+ `main.conversation`). Not reachable from a right-pane tab.
3. **`@deepseek-ai/dsh-client-ui-dockkit`** — `require`d by `sidebar-right:33` but **absent from the
   asar listing** (0 hits for "dockkit" in the 15 578-line listing) and not inlined. Its real API
   (`DockLayout`, `canSplit`, `getPane`, `findTabPane`, `findContentTab`, `dockPaneIds`,
   `activeDockPaneId`) is known only from call sites. UNVERIFIED beyond those signatures; it resolves
   through the client module loader.
4. **`@deepseek-ai/dsh-client-ui-dockkit` internals** — the package is absent (see 3); only the
   call-site signatures are attested. Everything else about the tab registry *is* verified
   (bands `extension:3 / builtin:2 / fallback:1`, `DEFAULT_BAND = "extension"`,
   `coexists` — `sidebar-right:8618-8632`).
5. **Radio/Select/Textarea/Slider/ScrollArea/SplitPane primitives** — do not exist; absence verified by
   grep for `Split|Resize|Scroll|Portal|Textarea` in the primitives bundle.
6. **`--dsw-space-*`, `--dsw-gap-*`, control-height tokens** — no such families found; spacing and
   heights are literal px in official stylesheets.
7. **`--dsw-hovercard-bg`** — used with a fallback in `HoverCard.module.css` (`#2C2C2E`) but no
   definition site was found in the inspected files.
8. **`dsh-experimental-client-ui-agent-team`, `dsh-client-ui-subagent`** — bundles exist under
   `.ref/dsh-official/` but were not analysed for this report (arrived while it was being written).
