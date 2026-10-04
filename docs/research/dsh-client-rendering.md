# DSH client rendering — what a client half can actually load

**Status:** verified against DSH **0.2.0-rc.2** Desktop, 2026.
**Question this answers:** can an agent-editable board plugin render UML diagrams and PDF pages, and by
what mechanism?
**Scope:** the client-module loader, the bundle-serving route, CSP, the document-preview byte path, and
what can rasterize inside the DSH process.

This file is the long-form companion to [`dsh-plugin-contract.md`](./dsh-plugin-contract.md). That file's
§11 already claimed "mermaid loads as a package-local chunk"; this file re-derives that claim from the
loader source and extends it to PDF. Where the two agree, this file supersedes nothing — it adds the
mechanism and the citations.

## Sources and citation convention

Every claim below is quoted or paraphrased from one of these, and every citation is `file:line`.

| Short name in this file | Absolute path |
| --- | --- |
| `<ASAR>/` | `C:\Users\haoch\AppData\Local\Temp\dsh-asar\dsh\node_modules\@deepseek-ai\` — full extraction of `C:\Users\haoch\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` |
| `client-modules/client.js` | `<ASAR>/dsh-client-modules/lib/client.js` (884 lines) — the in-page module loader |
| `client-modules/index.js` | `<ASAR>/dsh-client-modules/lib/index.js` (981 lines) — the host-side registry + bundle route |
| `webserver/index.js` | `<ASAR>/dsh-host-webserver/lib/index.js` (366 lines) |
| `connection/index.js` | `<ASAR>/dsh-client-connection/lib/index.js` (850 lines) |
| `docpreview/client.js` | `<ASAR>/dsh-client-ui-sidebar-documentpreview/lib/client.js` (6872 lines) |
| `docpreview/client.pdf.js` | `<ASAR>/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js` (32660 lines, 7 108 786 B) |
| `office/index.js` | `<ASAR>/dsh-office-to-pdf/lib/index.js` (659 lines) |
| `lokit/index.js` | `<ASAR>/libreoffice-kit/lib/index.js` (1929 lines) |
| `practices.md` | `<ASAR>/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md` (38 lines) |

The plugin itself is at `E:\Dev\dsh-superboard`; its client half is `src/client.js`.

**Method note:** `dsh-client-modules/lib/client.js` and `lib/index.js` were read in full, line by line. The
load-bearing statements below are verbatim. Where a conclusion depends on a name alone (a package called
"pdf" obviously renders PDFs) that is called out as inference rather than quoted.

---

## 1. Can a client half load a large third-party browser library?

**Yes, and the supported mechanism is a package-local chunk.** mermaid (~2 MB) and pdf.js (~1 MB) both fit
comfortably under the largest bundle DSH itself ships: a **7.1 MB** chunk.

### 1a. `dsh.client.external` — what the loader does with it

`dsh.client.external` is **not** a library-loading mechanism. It is a *graph edge between plugin packages*:
each entry names **another DSH plugin's client row** whose bundle must arrive first. It cannot name a
third-party npm package, and a name with no matching row is silently ignored.

The host parses it in `client-modules/index.js:61-75` (`parseDshClient` — `external` must be a string array)
and carries it into the row at `:725`:

```js
clientPath: join(dirname(pkgPath), clientRel),
external: decl.external ?? []
```

The ordering pass is `orderByModuleGraph`, whose own doc comment states the semantics
(`client-modules/index.js:406-409`, verbatim):

> Order composed rows so every requested dynamic package precedes its consumers. An `external` specifier
> is either the package row it names (`<pkg>/client` aliases the bare package) or a static-table name
> that adds no graph edge.

and its resolution body (`:426-430`) shows the silent skip:

```js
for (const name of entry.external ?? []) {
  const dependency = rowsById.get(name) ?? rowsById.get(stripClientSuffix(name));
  if (dependency === entry) throw new Error(`client-modules: "${entry.id}" requests module "${name}" that it answers itself — a row must not declare its own package in dsh.client.external`);
  if (dependency !== void 0) visit(dependency);
}
```

`row.external` also drives arrival order in the browser (`client-modules/client.js:644-655`, inside
`arriveGraphRow`): each named row is arrived before the consumer's own bundle is fetched. It is shipped to
the page as a plain string array alongside `inject` (`client-modules/client.js:125-134`).

**Consequence.** `external: ["mermaid"]` is a no-op — nothing throws, nothing loads. `external` is only
useful when the dependency is itself a DSH plugin with a `dsh.client.platform: "web"` block, and
`practices.md:35` separately forbids depending on another Harness client package as a module.

**Risk:** low but real — a silent no-op is easy to mistake for a working declaration. Never use `external`
to load a vendored library.

### 1b. Vendoring into the plugin's own shipped file — the route, and the size limit

This is the mechanism DSH itself uses for pdf.js and SheetJS, and there is **no size cap**.

**What serves a plugin's client half.** The host half registers one prefix route
(`client-modules/index.js:546-551`):

```js
webCtx.effect(() => webCtx.webServer.register({
  kind: "prefix",
  path: PLUGIN_ROUTE,
  handler: this.serveBundle
}), "client-modules: bundle route");
```

with `const PLUGIN_ROUTE = "/plugins";` (`:201`). The handler is a plain `node:http` writer with no body
inspection (`:973-978`):

```js
const serveBundle = async (req, res) => {
  const response = await this.bundleResource(req.method, req.url ?? "/");
  res.writeHead(response.status, response.headers);
  res.end(response.body);
};
```

**URL shape — the combo URL (a plugin's own half).** `comboSearch` (`:203-209`) and `comboUrl` build:

```
/plugins/??<pkg>/client.js&rev=<rev>            ← what the page actually requests
```

and `comboReference` (`:216-218`) strips the leading slash because app routes are document-relative. The
literal `client.js` inside the combo path is a **label, not a file name** — it is re-parsed by
`chunkUrl` (`client-modules/client.js:480-486`) purely to find the `/??` and `&rev=` offsets.

**URL shape — the package-local chunk (a vendored library).** `chunkUrl` (host, `:220-230`) yields:

```
/plugins/<pkg>/<client.*.js>?rev=<rev>
```

and the in-page loader builds exactly that (`client-modules/client.js:480-486`, verbatim):

```js
function chunkUrl(row, fileName, rev) {
  const url = atRevision(row.url, rev);
  const resourceStart = url.indexOf("/??");
  const revisionStart = url.indexOf("&rev=", resourceStart + 3);
  if ((resourceStart < 0 || revisionStart < 0 ? void 0 : url.slice(resourceStart + 3, revisionStart)) !== `${row.id}/client.js`) throw new Error(`client-modules: cannot resolve chunk ${JSON.stringify(fileName)} from bundle URL ${url}`);
  return `${url.slice(0, resourceStart)}/${row.id}/${fileName}?${url.slice(revisionStart + 1)}`;
}
```

The host accepts such a request in `chunkRequest` (`client-modules/index.js:914-932`, verbatim core):

```js
const prefix = `/plugins/${record.entry.id}/`;
if (!requestUrl.pathname.startsWith(prefix)) continue;
const requested = requestUrl.pathname.slice(prefix.length);
const sourceMap = requested.endsWith(".map");
const fileName = sourceMap ? requested.slice(0, -4) : requested;
if (!CLIENT_CHUNK.test(fileName)) return void 0;
if (resourceUrl !== chunkUrl(record.entry.id, fileName, record.entry.rev, sourceMap)) return void 0;
return { record, fileName, sourceMap, resourceUrl };
```

with `const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;` (`client-modules/index.js:169`,
identical constant at `client-modules/client.js:470`).

`chunkResponse` (`:933-957`) then resolves the **sibling file of the declared client bundle**:

```js
const clientPath = join(dirname(record.meta.clientPath), fileName);
if (!existsSync(clientPath)) return void 0;
```

and serves it as `contentType: "text/javascript; charset=utf-8"` with `cache-control:
public, max-age=31536000, immutable` (`IMMUTABLE_CACHE`, `:158-159`).

**Three facts that matter, all from the code above:**

1. **No declaration is needed.** Any file named `client.<something>.js` sitting next to the `./client`
   bundle is served on demand. There is no manifest list, no allowlist, no registration step.
2. **No size cap anywhere.** The 3072-byte limit is `MAX_COMBO_URL_BYTES = 3 * 1024` (`:161`) and applies
   to the **URL** only, enforced in `partitionComboRecords` (`:236-252`, throws
   `client-modules: <id> exceeds the 3072-byte combo URL limit`). Bodies are read whole
   (`initialBundleSnapshot`, `:811-822`, `readFileSync(clientPath)`) and written whole.
3. **The rev is filesystem-derived, not content-derived.** `artifactRevision` (`:192-199`) is
   `framedHash("plugin-artifact", [mtimeMs, ctimeMs, size])`. Rewriting a vendored chunk in place changes
   the rev; if a URL is stale the request 404s rather than serving old bytes.

**Precedent — the largest client bundles actually shipped (measured):**

| File | Bytes | Contents |
| --- | --- | --- |
| `docpreview/client.pdf.js` | **7 108 786** | pdf.js 6.3.289 (`pdf.mjs` + `pdf_viewer.mjs`), whole |
| `docpreview/client.excel.js` | **7 060 788** | SheetJS + FortuneSheet + formulajs + lodash + dayjs |
| `dsh-client-ui-settings-account/lib/client.js` | **5 279 763** | a *main* half, not even a chunk |
| `dsh-client-ui-sidebar-terminal/lib/client.terminal.js` | 685 927 | xterm.js |
| `dsh-client-ui-sidebar-documentpreview/lib/client.js` | 268 957 | the main half that owns the two 7 MB chunks |

So a 2 MB mermaid chunk is unremarkable here — smaller than the plugin's own neighbours. Both 7 MB chunks
are lazily fetched, i.e. they are *not* on the boot critical path.

**Risk:** the combination URL budget is fine, but a 2 MB chunk inline in the *main* half would be fetched at
boot for every session in every profile. Keep mermaid in a chunk and `require.async` it. Second risk: the
chunk must be a real sibling file of the declared `exports["./client"]` target — `exports["./client"]` may
point anywhere (`clientExportOf`, `:171-181`, accepts a string or `{default: string}`), but the chunk
directory is `dirname(that path)`.

### 1c. Injecting `<script src=…>` or calling dynamic `import(url)` at runtime

**`document` is reachable and nothing blocks either technique.**

The factory returned by a client half runs in the page's main world, not a worker and not a sandbox. The
proof is the loader's own default transport (`client-modules/client.js:450-464`, verbatim):

```js
/** Default bundle-load hook: same-origin external classic script. */
const defaultLoadBundle = (url) => new Promise((resolve, reject) => {
  const el = document.createElement("script");
  el.async = true;
  el.src = url;
  el.addEventListener("load", () => {
    el.remove();
    resolve();
  }, { once: true });
  el.addEventListener("error", () => {
    el.remove();
    reject(/* @__PURE__ */ new Error(`client-modules: bundle script ${url} failed to load`));
  }, { once: true });
  document.head.append(el);
});
```

The same file calls `document.querySelectorAll` directly (`:492-498` `claimStyles`, `:194-197`
`removeOwnedStyles`). A registered factory that reaches for `document` is doing exactly what the loader
does.

**CSP: none on the shell page.** A full sweep of the extraction for `Content-Security-Policy` found only:

- `docpreview/client.js:3845-3846` — a policy set on a **self-contained static-HTML iframe** the
  document-preview owner builds (`default-src 'none'; script-src 'none'; style-src 'unsafe-inline';
  img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; form-action 'none';
  base-uri 'none'`). That constrains *that iframe's document*, not the shell.
- `dsh-api-session-controller/lib/index.js:2342` — `"Content-Security-Policy": "sandbox; default-src 'none'"`
  on `/api/file` **responses** (see §3).
- `dsh-deepseek-account-platform/lib/index.js:1115` — a nonce policy on the sign-in page only.

There is **no CSP `<meta>` in the shell HTML and no `webRequest.onHeadersReceived` CSP in the Electron main
process** — a grep for `onHeadersReceived|contentSecurityPolicy` across the whole extraction hits only
pdf.js's own XHR internals. `app.asar/lib/main.js` sets only `webSecurity: true` (at `:6060`, `:7811`,
`:9353`, `:9698`, `:10698`, `:11104`) and `allowRunningInsecureContent: false` once (`:9699`).

Consequences, all safe: an injected `<script src="/plugins/…">` executes; a dynamically created
`<script>` executes; `import(url)` with an absolute same-origin path resolves; `new Worker(blobURL)` works
(such workers are governed by `worker-src` → `script-src` → `default-src`, none of which is set on the
shell). DSH itself relies on the Worker case: `docpreview/client.pdf.js:24707-24711` starts pdf.js's worker
from a Blob URL (`new Worker(url, { type: "module", name: "dsh-pdf" })`).

**Risk:** technique 1c bypasses the loader entirely, so nothing registers the script with the module table,
nothing is memoized, nothing participates in HMR invalidation, and `prune`/`invalidate` cannot clean it up.
It works; it is not the supported path. Prefer 1d.

### 1d. `window.__ModuleLoader__` — many modules per plugin, and the exact second-module protocol

**This is the supported route, and it does work for a vendored library. It needs no `package.json` change,
no `dsh.client.external` entry, and no host-side registration.**

**What the facade is.** Before any bundle runs, the host injects a queue-mode facade at the top of `<head>`
(`client-modules/index.js:454-475`; rendered as a `{kind:"script", placement:"head"}` row at `:478-482`).
It is a queue until the module system boots, then it becomes live. The handover is
`client-modules/client.js:559-566` (verbatim):

```js
const target = options.registrationTarget;
if (target.mode !== "queue") throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot");
const pending = target.pendingQueue.splice(0);
target.mode = "live";
target.load = (registration) => {
  this.register(registration);
};
for (const registration of pending) target.load(registration);
```

So `load()` stays callable **at any time after boot**, from any code — not only from a bundle script the
loader fetched. The precedent is the HMR/Cordis runtime path
(`dsh-cordis-client-runner/lib/client.js:556-563`), which calls it from arbitrary runtime code with a
synthetic id:

```js
const moduleId = moduleIdOf(half.pluginId);
this.env.modules.invalidate(moduleId);
const sink = globalThis.__ModuleLoader__;
if (sink === void 0) throw new Error("cordis-client-runner: window.__ModuleLoader__ is missing (booted outside the web shell?)");
sink.load({ id: moduleId, factory: () => surface });
```

**Can one plugin register more than one module? Yes.** `register` (`client-modules/client.js:568-581`,
verbatim):

```js
register(registration) {
  const ownerId = stripClientSuffix(registration.id);
  if (registration.chunk !== void 0 && !CLIENT_CHUNK.test(registration.chunk)) throw new Error(`client-modules: invalid package-local chunk ${JSON.stringify(registration.chunk)}`);
  const id = registration.chunk === void 0 ? ownerId : chunkId(ownerId, registration.chunk);
  if (this.bootstrapIds.has(id) || this.factories.has(id)) {
    const registrationName = registration.chunk === void 0 ? registration.id : id;
    throw new Error(`client-modules: duplicate factory registration for "${registrationName}" (bundle executed twice without invalidate?)`);
  }
  this.factories.set(id, {
    factory: registration.factory,
    rev: this.reloadTargets.get(ownerId)?.rev ?? this.graphRows.get(ownerId)?.rev
  });
}
```

Key line: **`const id = registration.chunk === void 0 ? ownerId : chunkId(ownerId, registration.chunk);`**
with `chunkId(ownerId, fileName)` = `` `${ownerId}/${fileName}` `` (`:476-478`). The chunk factory is stored
under the composite key `<your-pkg>/<client.x.js>` and inherits the owner's rev. One script may therefore
register N modules; `__ModuleLoader__.load` is an ordinary function, so it can be called N times from N
files.

**The resolution path a plugin uses.** `makeRequire` (`client-modules/client.js:696-715`, verbatim):

```js
makeRequire(ownerId, edges) {
  const require = (spec) => {
    edges.add(spec);
    if (this.seed.has(spec)) return this.seed.get(spec);
    const id = stripClientSuffix(spec);
    const record = this.loadCache.get(id);
    if (record !== void 0) return record.exports;
    if (this.factories.has(id)) return this.materialize(id).exports;
    throw new Error(`client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)`);
  };
  require.async = async (spec) => {
    edges.add(spec);
    if (!spec.startsWith("./")) return await this.import(spec);
    const fileName = spec.slice(2);
    if (!CLIENT_CHUNK.test(fileName)) throw new Error(`client-modules: invalid relative chunk request ${JSON.stringify(spec)}`);
    return await this.importChunk(ownerId, fileName);
  };
  return require;
}
```

**Note carefully: the synchronous `require` has no `./` branch.** `require("./client.mermaid.js")` strips a
`/client` suffix that isn't there and then looks for a factory literally named `./client.mermaid.js` — it
throws. **Only `require.async("./…")` handles relative chunks.** Nine seed words remain available
synchronously, plus any already-materialized module by bare name.

`importChunk` (`:716-742`, verbatim core) is the decisive routine:

```js
async importChunk(ownerId, fileName) {
  const id = chunkId(ownerId, fileName);
  const existing = this.loadCache.get(id);
  if (existing !== void 0) return existing.exports;
  if (!this.factories.has(id)) {
    const generation = this.generations.get(ownerId) ?? 0;
    const row = this.graphRows.get(ownerId);
    if (row === void 0) throw new Error(`client-modules: chunk owner "${ownerId}" is not a boot graph entry`);
    const url = chunkUrl(row, fileName, this.factories.get(ownerId)?.rev ?? this.reloadTargets.get(ownerId)?.rev ?? row.rev);
    let transport = this.pendingArrival.get(url);
    if (transport === void 0) {
      transport = this.loadBundle(url).finally(() => {
        this.pendingArrival.delete(url);
      });
      this.pendingArrival.set(url, transport);
    }
    await transport;
    if ((this.generations.get(ownerId) ?? 0) !== generation) {
      this.factories.delete(id);
      this.loadCache.delete(id);
      return await this.importChunk(ownerId, fileName);
    }
    if (!this.factories.has(id)) throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`);
  }
  return this.materialize(id, ownerId).exports;
}
```

Read it as a protocol. **The complete recipe for a vendored library is:**

1. Your client half calls `require.async("./client.mermaid.js")`.
2. The loader derives `id = "<your-pkg>/client.mermaid.js"`, looks up **your own boot graph row** (the row
   that exists because you declared `dsh.client.platform: "web"`), and computes
   `/plugins/<your-pkg>/client.mermaid.js?rev=<your rev>` — the rev is read from your already-registered
   factory, so you never have to know it, and it survives HMR (`client-modules/client.js:579`).
3. It appends `<script src="that url">` via `defaultLoadBundle` (`:450-464`).
4. That file must end by registering itself:
   `window.__ModuleLoader__.load({ id: "<your-pkg>", chunk: "client.mermaid.js", factory: (require) => { /* mermaid */ } })`.
5. Loader materializes it; you get `exports`. If the file ran but did not register that exact id, the
   loader throws `client-modules: bundle <url> loaded without registering "<id>" via __ModuleLoader__.load`.
6. A second call is served from `loadCache` — no second fetch. HMR invalidation clears both
   (`invalidate`, `:824-839`, deletes every key equal to `normalized` or starting with
   `` `${normalized}/client.` ``).

**You do not need a boot-graph row for the chunk** — only for the *owner*. `graphRows` is seeded from the
boot manifest (`const row of options.manifest.modules) this.graphRows.set(row.id, row);`, `:550`), and your
package is in it by virtue of `dsh.client.platform: "web"`. If it is not, step 2 throws
`client-modules: chunk owner "<id>" is not a boot graph entry`.

**A bare-name second module is also possible but weaker.** Registering
`{ id: "mermaid", factory }` (no `chunk`) puts the factory under the literal key `mermaid`, after which
`require("mermaid")` resolves via `this.factories.has(id)` (`:704`). Two problems: it is **global** — any
other plugin asking for `"mermaid"` gets your copy, and a second plugin doing the same throws
`duplicate factory registration for "mermaid"`. It also does not participate in package-scoped
invalidation. Use the `chunk` form.

**One hard rule from `register` (`:571-576`):** a script must not run twice. Loading the same chunk URL twice
is safe because `importChunk` memoizes on `loadCache`/`factories` *before* transporting, but injecting the
same `<script src>` by hand twice throws
`client-modules: duplicate factory registration for "<id>/<file>" (bundle executed twice without invalidate?)`.

**Risk.** The mechanism is exact but unforgiving in three ways:

- **The factory must be synchronous-CJS-shaped.** `materialize` runs
  `registered.factory(this.makeRequire(ownerId, edges))` (`:683`) and guards re-entrancy with
  `client-modules: require cycle through "<id>" (factory-form CJS cannot deliver partial exports)`
  (`:677`). If mermaid's bundle does a top-level `import` of something in your chunk, you must inline that
  too — a chunk cannot import a sibling chunk synchronously.
- **A mermaid chunk that injects a `<style>` at factory time will have those tags claimed by
  `claimStyles(ownerId)`.** That is the correct behaviour (it makes HMR cleanup work), but it means the
  styles are removed whenever your package is invalidated.
- **`CLIENT_CHUNK` is a pattern, not a suggestion.** `client.mermaid.js` ✓, `mermaid.js` ✗,
  `client.mermaid.mjs` ✗. A bad name throws at `load()` time with
  `client-modules: invalid package-local chunk "…"`.

### 1 answer, condensed

| Mechanism | Works? | Decisive citation | Risk |
| --- | --- | --- | --- |
| `dsh.client.external` | For **DSH plugin rows only** — silently no-ops for a library | `client-modules/index.js:426-430` | Silent no-op; mistakes look like success |
| Vendor into the main half | Yes | `/plugins` prefix route, `client-modules/index.js:546-551`, `:973-978` | Loaded at boot for every session |
| **Vendor as a package-local chunk** | **Yes — the supported path** | `client-modules/client.js:716-742` + `:568-581` | Chunk must be `client.*.js`, sibling of the client bundle, self-registering |
| Inject `<script src>` / `import(url)` by hand | Yes — `document` reachable, no CSP to stop it | `client-modules/client.js:450-464`; no CSP in shell HTML or `lib/main.js` | Outside the module table: no memoization, no HMR cleanup |
| `__ModuleLoader__.load` at runtime | Yes — callable after boot | `client-modules/client.js:562-564`; precedent `dsh-cordis-client-runner/lib/client.js:556-563` | A second execution of the same script throws on duplicate registration |
| Size ceiling | None found | `MAX_COMBO_URL_BYTES` (`:161`) constrains URLs; 7 108 786-byte chunk ships | — |

---

## 2. How does DSH itself render a PDF preview?

**It rasterizes.** DSH converts or accepts a PDF, hands the **bytes** to pdf.js in memory, and paints each
page into a React-owned `<canvas>` element in the main document. There is no `<embed>`, no viewer plugin, no
iframe, and no PDF-URL fetch.

### Which library, and which chunk

pdf.js **6.3.289** (Apache-2.0), vendored whole into a package-local chunk of the document-preview plugin.

- Chunk registration: `docpreview/client.pdf.js:944-947` —
  `window.__ModuleLoader__.load({ id: …, chunk: "client.pdf.js", factory })`.
- Loaded lazily by the main half: `docpreview/client.js:4883` —
  `require.async("./client.pdf.js")`.
- Provenance markers inside the chunk: `:1019` region
  `../../../node_modules/.pnpm/pdfjs-dist@6.3.289/node_modules/pdfjs-dist/build/pdf.mjs`; `:24412` header
  line `pdfjsVersion = 6.3.289`; `:24749` region `…/pdfjs-dist/web/pdf_viewer.mjs`.
- Globals handoff: `:24346` `globalThis.pdfjsLib = {` … `:24750`
  `const { AbortException, …, getDocument, … } = globalThis.pdfjsLib;`
- The Office-to-PDF sibling registers the same way: `docpreview/client.excel.js:312`.

### Where the bytes come from

Not from HTTP and not from a URL. Two sources, both client-side Remote calls over the DSH RPC transport:

**A plain PDF** — `docpreview/client.js:4128`:

```js
return ctx.remote.workspaceFiles.readBytes(file.sessionId, relativePath, { baseFile: file.path }, signal);
```

**An Office document** — converted on the host first. `docpreview/client.js:5700-5727` injects
`["remote", "remote.officeToPdf", "remote.workspaceFiles"]` and defines `convert` as:

```js
const result = await scope.remote.officeToPdf.render(file.sessionId, file.path, priority, signal);
```

wrapped in an `OfficePreviewCache` that separately calls `scope.remote.workspaceFiles.readBytes(…, {
range: { offset: 0, length: 1 } }, signal)` for authorization and
`scope.remote.workspaceFiles.stat(file.sessionId, file.path, signal)` for source-change detection. The cache
doc comment at `:5163` states the contract plainly:

> `@param convert - Host render Remote returning binary PDF bytes borrowed read-only by callers.`

**There is no `fetch(` call anywhere in `docpreview/client.js`.** That is a grep-level fact, not an
inference.

### Rasterization, not embedding

`renderPdfPage` (`docpreview/client.pdf.js:966-1017`) drives pdf.js's canvas renderer directly:

```js
const page = await document.getPage(pageNumber);
const viewport = page.getViewport({ scale: 96 / 72 });
const ratio = Math.min(pixelRatio, Math.sqrt(16777216 / (viewport.width * viewport.height)));
canvas.width = …; canvas.height = …;
const task = page.render({ canvas, viewport, transform: ratio === 1 ? void 0 : [ratio, 0, 0, ratio, 0, 0] });
… await Promise.all([task.promise, text?.promise]);
```

and the React component paints it into the host document (`:32609-32647`):

```js
return (0, react_jsx_runtime.jsxs)("div", {
  ref: host,
  className: PdfBody_module_css_default.page,
  "data-pdf-page": page,
  children: [ … (0, react_jsx_runtime.jsx)("canvas", {
    ref: canvas,
    className: PdfBody_module_css_default.canvas,
    role: "img",
    "aria-label": t("pageImage", { page })
  }), …
```

Because it is a real DOM `<canvas>` in the host page, **theme tokens and dark mode apply normally** (the
filter is CSS on the canvas, not a second rasterization). This is precisely the property `practices.md:33`
says iframes lose.

The worker is also inlined: `docpreview/client.pdf.js:24703-24738` slices the incoming bytes
(`const bytes = data.slice();`), builds a Blob-URL module Worker from an inlined source string
(`_dsh_pdf_worker_default`, `:24412`), and passes the document **in memory**:

```js
loading = getDocument$1({
  data: bytes,
  worker: bridge,
  BinaryDataFactory,
  cMapPacked: true,
  useWorkerFetch: false,
  enableXfa: false,
  stopAtErrors: true,
  isEvalSupported: false
});
```

`useWorkerFetch: false` plus `{ data: bytes }` means the viewer never fetches a PDF by URL — it cannot, since
it has no URL.

### Is any of it reachable or reusable from a third-party plugin?

**No — not reusable, and only partially reachable.**

- **Not reusable as components.** `docpreview/client.js` exports exactly two names
  (`:6866-6867`): `exports.apply = apply; exports.inject = inject;`. It is a Cordis plugin object, not a
  component library. `PdfBody`, `renderPdfPage`, and `pdfBodyDefinition` are all module-private. Nothing
  named `PdfBody` or `renderPdfPage` appears in the chunk's exports either.
- **The chunk is not addressable from another package.** `require.async("./client.pdf.js")` resolves
  against **your** owner id (`client-modules/client.js:712`, `importChunk(ownerId, fileName)`), yielding
  `/plugins/<your-pkg>/client.pdf.js` — which does not exist.
- **Bare-name import of the package is technically possible but forbidden.** `require.async("@deepseek-ai/dsh-client-ui-sidebar-documentpreview")`
  would go through `import(spec)` (`:743-757`), find the graph row, arrive it, and materialize it — handing
  you `{apply, inject}`, which is useless to you. And `practices.md:35` forbids exactly this move: *"Do not
  `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module;
  `dsh.client.inject` entries only order activation and stay allowed."*
- **One genuine extension point exists, and it is a service, not an import.** The package provides the
  `documentPreviews` client service: `docpreview/client.js:6809` — `const disposePreviews =
  ctx.reflect.provide("documentPreviews", previews);`. Its registry (`DocumentPreviewRegistry`,
  `:306-359`) accepts:

  ```js
  register(definition) {
    if (this.registered.has(definition.id)) throw new Error(`documentPreviews: duplicate implementation "${definition.id}"`);
    const declared = new Set(definition.extensions.map(normalizeSuffix));
    for (const extension of definition.binaryExtensions ?? []) if (!declared.has(normalizeSuffix(extension))) throw new Error(`documentPreviews: "${definition.id}" declares binary suffix "${extension}" outside its extensions`);
    …
  }
  ```

  The built-in definitions show the shape — PDF (`:4970-4980`):
  `{ id: PDF_BODY_ID, extensions: ["pdf"], binaryExtensions: ["pdf"], priority: "builtin", title, loading:
  "bytes-complete", wrap: false }`; Office (`:5657-5665`): `extensions: ["doc","docx","ppt","pptx"]`,
  `loading: "renderer"`; Excel (`:5860-5873`): `extensions: ["xlsx","xls","csv","tsv"]`,
  `binaryExtensions: ["xlsx","xls"]`. Priorities seen in the file are `"builtin"` (× 6) and `"fallback"`
  (× 1, `:1084`).

  A plugin that injects `documentPreviews` could register UML for `.mmd`/`.puml` and render it in its own
  keyed slot. Two caveats: it only exists when `dsh-client-ui-sidebar-documentpreview` is loaded, so the
  injection must be optional (`ctx.inject([...])`, per `practices.md:20`); and it composes your renderer into
  the *sidebar document tab*, which is not the same surface as a board page.

### The iframe question

`practices.md:33` says: *"Render plugin pages as React components in a slot. Do not serve an HTML page from
the Host and embed it in an iframe: an iframe document does not receive the host's theme tokens, light/dark
switching, or `ctx.locale`."*

**That constraint does not apply to the PDF path, because the PDF path uses no iframe.** The only iframe in
this package is a separate variant that delivers a *self-contained static HTML document* with its own
restrictive CSP (`docpreview/client.js:3845-3846`) — a different feature from document preview, and the
reason the rule exists. The PDF renderer is a React `<canvas>` in the main document. So "PDF in an iframe"
is not what DSH does, and copying DSH means not introducing the iframe problem at all.

**Q2 risk, stated plainly:** the reusable surface here is **the pattern, not the code.** A plugin cannot
borrow pdf.js from DSH; it must vendor its own copy of pdf.js into its own chunk (≈1 MB minified for
`pdf.mjs` + worker, before the viewer). The compensating fact is that DSH proves the pattern end to end at
7 MB with the exact same loader.

---

## 3. How do bytes travel from the host filesystem to the browser?

There are **two** transports, and one of them is a general "serve this local file" route a plugin can just
fetch.

### The general route: `GET /api/file?path=<absolute path>`

Registered by the session controller (`dsh-api-session-controller/lib/index.js:2394-2402`, verbatim):

```js
apply(ctx) {
  const maxBytes = ctx.attachments.imageLimits.maxImageBytes;
  ctx.effect(() => ctx.connection.fetch.register({
    path: "/api/file",
    methods: ["GET", "HEAD"],
    requestBody: "buffered",
    fetch: (request) => serveFile(request, ctx.fs, maxBytes)
  }), "session-controller: /api/file");
}
```

with its module doc (`:2333-2338`, verbatim):

> Authenticated GET/HEAD /api/file reads bounded file responses through the composed filesystem provider.
> Paths and MIME types do not restrict access; the connection service authenticates requests before this
> handler.

`serveFile` (`:2344-2369+`): reads `path` from the query string, rejects a missing path (400 `missing path`)
and a relative one (400 `absolute path required`), `fs.resolve`s it, looks up the MIME type with
`mime.lookup(target.displayPath) ?? "application/octet-stream"`, rejects non-files (403 `not a regular
file`), rejects oversize (413 `file exceeds byte limit`), supports `HEAD` with `Content-Length`, and sets:

```js
const BASE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'"
};
```

**URL shape:** `GET /api/file?path=<url-encoded absolute path>` — one file, one absolute path, agent-relevant
because the plugin already knows the workspace root.

**How routes reach the browser.** `ctx.connection.registerFetchRoute` (`connection/index.js:625-639`) stores
exact paths in `this.fetchRoutes`; the shared handler is mounted as a prefix route on `/api`
(`connection/index.js:829-843`, verbatim):

```js
const fetchHandler = connection.createSharedFetchHandler(API_PATH);
const route = {
  kind: "prefix",
  path: API_PATH,
  handler: async (req, res) => {
    const admission = connection.admit(req);
    if ("rejection" in admission) {
      res.writeHead(admission.rejection);
      res.end(admission.rejection === 401 ? "unauthorized" : "forbidden");
      return;
    }
    await webCtx.waterfall("connection/request", req, res, () => bridge(req, res, fetchHandler, maxRequestBodyBytes));
  }
};
webCtx.effect(() => webCtx.webServer.register(route), "client-connection: /api route");
```

with `const API_PATH = "/api";` (`:14`).

**Authentication is a cookie, not a header.** `connection/index.js` mints a signed, authority-bound browser
cookie from a process launch token (`TOKEN_QUERY = "token"` at `:226`, `cookieName(authority)` at `:284`,
`sessionCookie(...)` at `:407`, verification at `:429-437`, `admit(request)` at `:590-596`). For the desktop
the token arrives in the URL once and is exchanged for the cookie. **Consequence: from inside the shell
page, `fetch("/api/file?path=…")` is authenticated automatically** — same origin, cookie attached, no
header plumbing. A `fetch` from a plugin client half just works.

### The other transport: client-side Remotes (no HTTP in plugin code)

What the sidebar document preview actually uses. `docpreview/client.js:243`:

```js
return (sessionId, path, offset, signal) => remote.workspaceFiles.read(sessionId, path, { offset }, signal);
```

and `:4128` for binary reads. These are `@deepseek-ai/dsh-api-remotes` calls multiplexed over
`/api/remote.mux` (`dsh-api-gateway/lib/index.js:12`, `REMOTE_STREAM_MUX_PATH = "/api/remote.mux"`) — a
transport a third-party plugin cannot easily join, because it depends on generating Remote method metadata
via the Typert toolchain.

### Full inventory of `/api` routes in this installation

Found by grepping every `dsh.client`-adjacent route constant:

| Path | Registered by | Kind |
| --- | --- | --- |
| `/api/file` | `dsh-api-session-controller` | connection fetch register (exact) |
| `/api/remote.mux` | `dsh-api-gateway` | Remote multiplexer |
| `/api/session/uploadFileBinary` | `dsh-client-file-upload` (`lib/index.js:73`) | connection fetch register |
| `/api/changes.summary`, `/api/changes.diff`, `/api/changes.open` | `dsh-client-ui-deliverables` (`lib/index.js:4-8`) | connection fetch register |
| `/api/present.open`, `/api/present.host` | `dsh-client-ui-deliverables` (`lib/index.js:15-17`) | connection fetch register |
| `/api/session.export` | `dsh-session-log-export` (`lib/index.js:488`) | — |

`dsh-client-ui-deliverables` is the closest structural precedent to what a board plugin needs: one host
half registering a handful of exact `/api/...` routes (`lib/index.js:84`:
`for (const [path, methods, handler] of routes) ctx.connection.fetch.register({`), one client half that
fetches them.

### Non-`/api` routes: a plugin can register its own

`ctx.webServer` is the raw carrier (`webserver/index.js:97-101`, verbatim doc):

> `@deepseek-ai/dsh-host-webserver` — node:http route registration with optional gzip, index injection, and
> one fallback seat. It knows no harness concepts and serves no files; the composing application owns dist
> serving.

Its surface (`webserver/index.js`):

- `register(route)` (`:177-184`) — throws `webserver: duplicate <kind> route "<path>"`.
- `match(pathname)` (`:322-332`) — *"Longest-prefix-wins over the prefix table after an exact-table miss."*
  Verbatim: `if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;`.
- `registerUpgrade(route)` (`:191-197`), `registerFallback(handler)` (`:206-212`),
  `tapIndex(transform)` (`:220-226`), `renderIndex(html)` (`:361-363`).

`dsh-host-open-in-app` is the worked example of a plugin owning its own paths — three routes with explicit
auth (`lib/index.js:1271-1332`): `OPEN_IN_APP_APPS_PATH = "/open-in-app/apps"` (`:1126`),
`OPEN_IN_APP_ICON_PREFIX_PATH = "/open-in-app/icon"` (`:1129`), `OPEN_IN_APP_OPEN_PATH =
"/open-in-app/open"` (`:1132`), each starting with `if (rejected(req, res)) return;` where `rejected` calls
`connectionOf(ctx).requestRejection(req)` (`:1172`, `:1263-1270`). Note the icon route: a prefix route
streaming arbitrary bytes with `content-type` and `cache-control: public, max-age=3600`. **That is a
working template for "serve an image/PDF from a plugin's host half."**

### The browser panel is not a byte transport

`dsh-client-ui-sidebar-browser` renders an `<iframe>` (`lib/client.js:968`, `element.dataset.sidebarBrowserFrame
= "iframe"`) or, on desktop, an Electron `<webview>` (`:1336-1338`), navigating *live external URLs*
(`:653`, *"Owns the application-known URL history and the iframe observation state machine"*). It is for
visiting http(s) pages, not for moving local bytes, and it lives in the sidebar's right pane rather than a
plugin page.

**Q3 risk.** `/api/file` serves **any absolute path the composed filesystem provider will resolve** — its
own doc says paths and MIME types do not restrict access, and authorization is the cookie plus `ctx.fs`
policy. That is a powerful primitive for a plugin (an agent writes a PNG, the board fetches it) and it is
also a broad one, so a plugin should not widen it further. Two concrete gotchas: the response carries
`Content-Security-Policy: sandbox; default-src 'none'`, so **do not plan to put a `/api/file` PDF inside an
iframe the user is meant to scroll** — that policy plus `Cache-Control: private, no-store` make it an
`<img>`/`fetch`+bytes source, not a framed document. And the size ceiling is
`ctx.attachments.imageLimits.maxImageBytes`, which is an **image** limit applied to every file type; a
multi-megabyte board asset may exceed it (413).

---

## 4. Can the HOST half rasterize?

**Yes — and not through any JavaScript library.** The DSH process ships a **native LibreOfficeKit + PDFium
engine as a 178 MB standalone executable** and drives it as a child process. It can both convert Office
documents to PDF and rasterize pages to PNG. Nothing named `pdfjs-dist`, `sharp`, `canvas`, `@resvg/resvg-js`,
`playwright`, or `puppeteer` is used for this.

### What the binary is and where it lives

```
<ASAR>/libreoffice-kit-win32-x64/bin/libreoffice-kit.exe        178 581 480 B
<ASAR>/libreoffice-kit-win32-x64/program/program/*.ini           LibreOffice bootstrap data
<ASAR>/libreoffice-kit-win32-x64/program/program/services.rdb
<ASAR>/libreoffice-kit-win32-x64/program/share/*                 filters, fonts, config
<ASAR>/libreoffice-kit-win32-x64/prebuilds.json                  97 755 B manifest
<ASAR>/libreoffice-kit-win32-x64/licenses/LibreOffice-MPL-2.0.txt
```

Resolved at runtime, never hard-coded. `lokit/index.js:1267` `resolveEngine(resolvePackage = (name) =>
require.resolve(`${name}/package.json`), …)` locates the platform package, validates it at `:1302`
(`engine.kind !== backend`, `manifest.status !== "built"`, version and schema checks) and returns the pair
`{ programDirectory, executable }` (`:1307-1319`). It is spawned twice:

- **Conversion** — `lokit/index.js:582-601`: `spawn(engine.executable, ["--program-directory", …
  "--input-path", input, "--output-path", output, "--profile-directory", profile, "--max-output-bytes",
  …, "--max-image-resolution", …, "--format", operation.format, "--recalculate", …, …fonts.map(…), …
  "--font-file"…])` with `format: "pdf"` from the caller.
- **Rasterization** — `lokit/index.js:783-812`: `spawn(engine.executable, ["--operation", "render-images",
  "--program-directory", …, "--input-path", inputPath, "--scratch-directory", scratch, …])`, doc comment at
  `:782`: *"Run one native image batch and write final PNGs only after each bounded paint succeeds."* The
  region header at `:711` names the capability directly: *"Direct native LibreOfficeKit/PDFium rasterization
  through one operation-owned helper."*

### It genuinely runs inside the DSH process

This is not "happens to be installed on this machine." `@deepseek-ai/dsh-office-to-pdf/lib/index.js:1-9`
imports only Node builtins plus four DSH packages:

```js
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { createConverter } from "@deepseek-ai/libreoffice-kit";
import z from "@deepseek-ai/schemastery";
import { brandString } from "@deepseek-ai/dsh-brand";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { constants } from "node:fs";
```

and the desktop host goes out of its way to keep the native paths spawnable from inside the asar
(`dsh-desktop-host/lib/index.js:40-59`, verbatim):

```js
function installOfficeEngineResolution(runtimeDir) {
  if (runtimeArchivePath(runtimeDir) === void 0) return void 0;
  const root = realpathSync(runtimeDir);
  const archive = dirname(root);
  const source = pathToFileURL(join(root, "node_modules", "@deepseek-ai", "libreoffice-kit-")).href;
  const destination = pathToFileURL(join(`${archive}.unpacked`, relative(archive, root), "node_modules", "@deepseek-ai", "libreoffice-kit-")).href;
  return registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (!/^@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-/u.test(specifier)) return resolved;
    …
```

i.e. an ESM `resolve` hook rewrites the platform package's file URLs from `app.asar` to
`app.asar.unpacked`, because **a child process cannot execute a file inside an asar archive**. The engine is
a first-class part of the shipped product.

### How a plugin reaches it

**Not by importing `@deepseek-ai/libreoffice-kit`.** A plugin's host half resolves modules from its own
location (the profile's `node_modules`), not from the DSH runtime tree, so that import is not yours to make.

**Yes, through the host service.** `office/index.js:405-453` declares the service as a
`TypertRemoteService`:

```js
return class OfficeToPdf extends _classSuper {
  …
  _getGeneration_decorators = [Remote("generation")];
  …
  super(ctx, "officeToPdf");
```

`TypertRemoteService`'s constructor (`dsh-typert-protocol/lib/types/index.js:50-53`) is a plain Cordis
registration: `constructor(ctx, serviceKey, options = {}) { super(ctx, serviceKey); … }`. **So the host
service key is `officeToPdf`, and a plugin host half can `inject: ["officeToPdf"]` and call it directly.**
Two methods matter:

- `:500 async render(workspaceFileScope, path, priority, signal)` — the same entry point the client uses
  through `remote.officeToPdf.render`. It authorizes through the workspace, re-stats the source, and returns
  `{ absolutePath, version, offset, eof, bytes, data, missingFonts, generation }` where `data` is the PDF
  buffer (`:573-582`). Failures are classified: `:585` throws
  `new RemoteError("document-render/failed", "Office conversion failed.", { reason: cause.code })` with
  reasons `input-too-large` / `output-too-large` / `invalid-document` / `unsupported-format` /
  `invalid-output` / `timeout` / `unavailable` / `source-changed` (`:635-644`).
- `:589 async convertBytes(bytes, extension, signal)` — **takes raw bytes and an extension, with no
  workspace scope and no file on disk.** This is the one to reach for when the plugin already holds the
  bytes. It writes them to `mkdtemp(join(tmpdir(), "dsh-office-to-pdf-"))` as `source.<extension>`, calls
  `converter.render({ inputPath, outputPath }, signal)`, validates the result with `readPdf(outputPath,
  this.config.maxOutputBytes, signal)` and always `rm -rf`s the scratch directory (`:597-654`).

`readPdf` (`:62-86`) is a strict validator worth knowing: regular file, `O_RDONLY | O_NOFOLLOW`, size within
`limit`, then two content checks at `:81` — it must start with `%PDF-<digit>.<digit>` and its last 1 KB must
end, after trimming, with `%%EOF`.

**What is *not* available:** any JS-side rasterizer. `sharp` exists in the installation only as a
`dsh-attachment-local` dependency (0.35.5) for image attachments — it is not reachable from a plugin's
resolution path, and it cannot read PDFs without libvips' PDF support anyway. There is no `playwright`,
`puppeteer`, `canvas`, `@resvg/resvg-js`, `mutool`, `pdftoppm`, or ImageMagick wired into the DSH process.
The only bundled rasterizer is the LibreOfficeKit/PDFium executable, and it is only exposed through
`officeToPdf` for the *conversion* direction (the `render-images` PNG path at `lokit/index.js:783-812` is
used by `libreoffice-kit`'s own higher-level API, which a plugin cannot import; `dsh-office-to-pdf` calls
only `converter.render`, `:614-617`).

**Q4 risk.** Three real ones:

1. **The PNG raster path is not exposed.** `officeToPdf.convertBytes(bytes, extension, signal)` returns PDF
   bytes only. To turn a PDF into a PNG on the host you would have to render it on the *client* instead
   (pdf.js canvas — §2) or import `libreoffice-kit` yourself, which is not resolvable from a plugin.
2. **Sequential and slow.** Conversions occupy a slot (`const slot = this.slots.find((candidate) =>
   !candidate.busy)`, `:591`), spawn a 178 MB binary, and run under `maxOutputBytes`/timeout limits. This is
   a foreground user action, not a rendering primitive to call per board update.
3. **It is an importable-by-accident API surface.** `officeToPdf` and its `convertBytes` method carry no
   stability promise in the artifact; `practices.md:3` is the standing instruction — *"Confirm every Service
   method, Event name, and dispatch mode named here with `cordis_inspect_query`"* — and that check is cheap
   before depending on it.

### Cross-check: no JS rasterizer on either side

| Candidate | Client half | Host half |
| --- | --- | --- |
| `pdfjs-dist` | Code vendored at 6.3.289 inside `docpreview/client.pdf.js`; **no `pdfjs-dist` package exists** in `dsh/node_modules` | Not used |
| `mermaid` | Absent — not a package, not vendored | Absent |
| `@resvg/resvg-js` | Absent | Absent |
| `canvas` / `@napi-rs/canvas` | Referenced only inside pdf.js's Node-only canvas factory (`docpreview/client.pdf.js:9272`, `process.getBuiltinModule("module")…"@napi-rs/canvas"`) — dead code in a browser; `@napi-rs` is not installed | Absent |
| `sharp` | Absent | Present — `dsh/node_modules/sharp/package.json` = **0.35.5**, pulled in by `dsh-attachment-local` (`"sharp": "^0.35.3"`) for image attachments only |
| `playwright` / `puppeteer` | Absent | Absent |
| LibreOfficeKit + PDFium | Absent | **Present** — `libreoffice-kit-win32-x64/bin/libreoffice-kit.exe`, 178 581 480 B |

---

## Recommendation

**UML rendering: vendor mermaid as a package-local chunk and `require.async` it. Do not use `external`, do
not inject a `<script>` tag, do not put it in the main half.**

Concretely: ship `client.mermaid.js` next to the plugin's client bundle; have the main half call
`require.async("./client.mermaid.js")` on first render of a diagram; end that file with
`window.__ModuleLoader__.load({ id: "<plugin package name>", chunk: "client.mermaid.js", factory })`
returning mermaid's exports. Render the SVG string mermaid produces into a React element in a slot, and
style it with `--dsw-alias-*` tokens so it follows light/dark automatically. This is the same protocol DSH
uses for pdf.js (7 108 786 B), SheetJS (7 060 788 B), and xterm, it needs no `package.json` change beyond the
`dsh.client.platform: "web"` block the plugin already has, and it participates in HMR invalidation for
free. The only shape constraint is that the chunk is factory-form CJS with no synchronous sibling imports
(`client-modules/client.js:677`, `:683`), which a single self-contained mermaid bundle satisfies.

**PDF rasterization: vendor pdf.js into a second package-local chunk and rasterize to a `<canvas>` in the
plugin's own React tree. Do not use an iframe, and do not use `/api/file` as a viewer source.**

The pattern is DSH's own, verified at `docpreview/client.pdf.js:966-1017` (`page.render({ canvas, viewport,
transform })`) and `:32609-32647` (`<canvas role="img">` inside the host page). Bytes arrive the same way
either by `fetch("/api/file?path=<absolute>")` — authenticated automatically by the same-origin cookie
(`connection/index.js:829-843`, `:590-596`) — or, if the plugin later grows a host-side Remote, by the
document-preview cache pattern. Pass the bytes to pdf.js as `{ data: bytes }`, never as a URL: DSH itself
sets `useWorkerFetch: false` and starts the worker from a Blob URL
(`docpreview/client.pdf.js:24703-24738`), which is exactly what a `default-src`-free page permits (§1c).
For Office sources specifically, `inject: ["officeToPdf"]` on the host half and
`ctx.officeToPdf.convertBytes(bytes, extension, signal)` (`office/index.js:589`) turns `.docx`/`.pptx` into
PDF bytes inside the DSH process, backed by the bundled LibreOfficeKit engine — but treat that as a rare,
user-initiated action, not a live board feature.

**What would make this fail.** (1) A mermaid or pdf.js build that is not a single self-contained factory —
one that `import`s a sibling, or is ESM with top-level `await` — cannot be a chunk, because
`materialize` runs the factory synchronously and a require cycle is fatal by design
(`client-modules/client.js:677`). (2) Naming the chunk anything but `client.<name>.js`: the loader's
`CLIENT_CHUNK` pattern (`client-modules/client.js:470`) rejects it at registration time. (3) Serving the
chunk from a *different* directory than `exports["./client"]`'s sibling set —
`chunkResponse` joins `dirname(record.meta.clientPath)` and 404s otherwise
(`client-modules/index.js:933-957`). (4) A `/api/file` asset over
`ctx.attachments.imageLimits.maxImageBytes` returns 413 (§3). (5) For Office conversion, a
`maxOutputBytes` or timeout trip surfaces as `document-render/failed` with reason `output-too-large` or
`timeout` (`office/index.js:635-644`; client strings at `docpreview/client.js:5132-5134`). (6) Any future
DSH release adding a CSP to the shell HTML would break §1c's script injection but **not** the chunk route,
because the chunk is loaded through the same `defaultLoadBundle` the rest of DSH already depends on — which
is the strongest reason to prefer the chunk.

---

## Appendix — citation index

Load-bearing lines, in one place.

**Loader (client), `client-modules/client.js`**

| Line | What it establishes |
| --- | --- |
| `:450-464` | `defaultLoadBundle`: `document.createElement("script")` → `document.head`; `document` reachable |
| `:470` | `CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` |
| `:476-478` | `chunkId(ownerId, fileName)` = `` `${ownerId}/${fileName}` `` |
| `:480-486` | `chunkUrl(row, fileName, rev)` → `/plugins/<id>/<file>?<rev>` |
| `:492-498` | `claimStyles` — direct `document` use by the loader |
| `:548-550` | platform seed + `graphRows` from the boot manifest |
| `:559-566` | queue → live handover; `target.load` stays callable |
| `:568-581` | `register`; second module via `chunk`; duplicate throws |
| `:610-642` | `arrive`; failure text `loaded without registering "<id>" via __ModuleLoader__.load` |
| `:644-661` | `arriveGraphRow` — `row.external` then `row.inject` then self |
| `:671-695` | `materialize`; cycle guard `require cycle through "<id>"` |
| `:696-715` | `makeRequire`; **no `./` branch in sync require**; `require.async` |
| `:716-742` | **`importChunk` — the second-module protocol** |
| `:743-757` | `import(specifier)` — seed → memo → graph row → factory → throw |
| `:824-839` | `invalidate` clears `factories`/`loadCache` for `<id>` and `<id>/client.*` |
| `:108-173` | `parseBootManifest` — `id`/`url`/`rev`/`inject`/`external`/`immediately` |

**Loader (host), `client-modules/index.js`**

| Line | What it establishes |
| --- | --- |
| `:61-75` | `parseDshClient` — the 4 legal `dsh.client` keys |
| `:158-169` | `IMMUTABLE_CACHE`, `MAX_COMBO_URL_BYTES = 3072` (URL only), `CLIENT_CHUNK` |
| `:171-181` | `clientExportOf` — `exports["./client"]`, string or `{default}` |
| `:192-199` | `artifactRevision` — rev is mtime/ctime/size, not content |
| `:201-230` | `PLUGIN_ROUTE`, `comboSearch`/`comboUrl`/`comboReference`, `chunkUrl` |
| `:406-430` | `orderByModuleGraph` — `external` semantics; unmatched name silently skipped |
| `:453-498` | `bootInjections` — queue facade, `script-preload`, `script-src`, `__DSH_BOOT__` |
| `:546-551` | the `/plugins` prefix route registration |
| `:712-725` | `resolveMeta` — `platform: "web"` gate, `clientPath`, `external` |
| `:811-822` | `initialBundleSnapshot` — whole-file `readFileSync`, ENOENT → `MissingClientBundleError` |
| `:914-932` | **`chunkRequest`** — rev must match exactly or 404 |
| `:933-957` | **`chunkResponse`** — sibling file by name, no size cap |
| `:958-978` | `bundleResource` / `serveBundle` — plain `node:http`, 405 for non-GET/HEAD |

**Transport and serving**

| Citation | What it establishes |
| --- | --- |
| `webserver/index.js:177-184` | `register(route)`; duplicate `(kind, path)` throws |
| `webserver/index.js:322-332` | *"Longest-prefix-wins over the prefix table after an exact-table miss."* |
| `webserver/index.js:191-226` | `registerUpgrade`, `registerFallback`, `tapIndex` |
| `webserver/index.js:24-52` | `renderRow` — `script-preload` becomes `<link rel="preload" as="script">` |
| `connection/index.js:625-639` | `registerFetchRoute` — exact paths, duplicate throws |
| `connection/index.js:829-843` | `/api` prefix route, `connection.admit(req)` before the handler |
| `connection/index.js:226-437` | launch token → signed authority-bound cookie |
| `dsh-api-session-controller/lib/index.js:2339-2369` | `/api/file` headers, path rules, 400/403/413 |
| `dsh-host-open-in-app/lib/index.js:1126-1132`, `:1263-1332` | plugin-owned routes with auth — the template |

**PDF path**

| Citation | What it establishes |
| --- | --- |
| `docpreview/client.js:4883` | `require.async("./client.pdf.js")` |
| `docpreview/client.js:4128` | `ctx.remote.workspaceFiles.readBytes(...)` — no `fetch(` |
| `docpreview/client.js:5700-5727` | Office: `scope.remote.officeToPdf.render(...)` + `OfficePreviewCache` |
| `docpreview/client.js:3845-3846` | the self-contained-HTML iframe CSP (the source of `practices.md:33`) |
| `docpreview/client.js:6809` | `ctx.reflect.provide("documentPreviews", previews)` |
| `docpreview/client.js:333-346`, `:4970-4980` | `documentPreviews.register` shape; PDF definition |
| `docpreview/client.js:6866-6867` | only `apply` and `inject` are exported |
| `docpreview/client.pdf.js:944-947` | chunk registration |
| `docpreview/client.pdf.js:966-1017` | `renderPdfPage` — `page.render({ canvas, viewport, transform })` |
| `docpreview/client.pdf.js:24346`, `:24412` | `globalThis.pdfjsLib`; inlined worker source |
| `docpreview/client.pdf.js:24703-24738` | **Blob-URL module Worker; `getDocument({ data: bytes, … useWorkerFetch: false })`** |
| `docpreview/client.pdf.js:32609-32647` | React `<canvas role="img">` in the host document |

**Host rasterization**

| Citation | What it establishes |
| --- | --- |
| `office/index.js:1-9` | imports: Node builtins + `libreoffice-kit` + 3 DSH packages |
| `office/index.js:62-86` | `readPdf` — `%PDF-<d>.<d>` header and `%%EOF` tail validation |
| `office/index.js:405-453` | `TypertRemoteService`, `super(ctx, "officeToPdf")` |
| `office/index.js:500` | `async render(workspaceFileScope, path, priority, signal)` |
| `office/index.js:589-654` | **`convertBytes(bytes, extension, signal)` — no scope needed** |
| `office/index.js:635-644` | failure-code mapping |
| `lokit/index.js:711` | *"Direct native LibreOfficeKit/PDFium rasterization…"* |
| `lokit/index.js:582-601` | conversion spawn, `--format pdf --output-path` |
| `lokit/index.js:782-812` | `--operation render-images` → PNG |
| `lokit/index.js:1267-1319` | `resolveEngine` — package resolution + manifest validation |
| `dsh-desktop-host/lib/index.js:40-59` | asar → `app.asar.unpacked` resolve hook for the engine |
| `libreoffice-kit-win32-x64/bin/libreoffice-kit.exe` | 178 581 480 B, the actual rasterizer |
