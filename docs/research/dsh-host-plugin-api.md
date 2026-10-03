# DSH HOST-side plugin API — authoring, building, packaging, installing

**Target runtime:** DeepSeek Harness **0.2.0-rc.2** (Desktop build).
Verified from `C:\Users\haoch\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
(version read from `dsh\package.json`: `"name": "@deepseek-ai/dsh-desktop-runtime", "version": "0.2.0-rc.2"`).

**Path conventions.** `ASAR\` = `C:\Users\haoch\AppData\Local\Temp\dsh-asar\`, a full read-only extraction of
`app.asar` (15578 entries). Inside it, official packages live at
`ASAR\dsh\node_modules\@deepseek-ai\<pkg>\`. A **second root** `ASAR\node_modules\@deepseek-ai\` also exists and
holds only build-time leftovers (`cordis`, `cosmokit`, `dsh-api-gateway`, `dsh-brand`, `dsh-deque`, `dsh-timeout`,
`dsh-typert-protocol`, `schemastery`) — the only two `tsdown.config.ts` files in the whole archive are there.
`PROFILE\` = `C:\Users\haoch\.dsh\profiles\desktop\`.

**Method.** Every code block below was read from a real file on this machine; nothing is reconstructed from memory.
Paths are given relative to `ASAR\` or `PROFILE\` unless absolute. Line numbers are the real ones. Anything I could
not verify is marked **UNVERIFIED** inline and collected at the end.

---

## Q1 — Host plugin module shape

### 1.1 The four accepted exports

The authoritative statement is the shipped authoring skill, `dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md` **L47–54**:

> ## Host plugin export forms
>
> `index.js` exports one of these forms; do not mix them:
>
> - `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
> - A service class as the default export.
>
> Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup. A plugin that declares `Config` validates the row's `config` at activation; query `Config.listConfigs` for an installed plugin's schema before writing its `config`, and follow `$defs` references in the returned document.

Note what is **not** in that list: there is no `export const name` requirement, and no Cordis `Context` object export. The
module namespace object itself is the plugin.

### 1.2 A real third-party host entry, both halves

`dshmarket` is the only third-party host+client plugin installed here, and it ships source and compiled output. Its
hand-written source (`PROFILE\node_modules\dshmarket\src\index.ts`) is the clearest real example of the shape:

```ts
// src/index.ts L6
import type { Context } from '@deepseek-ai/cordis'
...
// src/index.ts L16
export const name = 'dsh-market'

// src/index.ts L18-19
/** Optional cordis.yml configuration; profile defaults to `web`. */
export type Config = Partial<Pick<MarketConfig, 'profile' | 'allowRestart' | 'maxSnapshots' | 'buildEnv'>>
...
// src/index.ts L180
export function apply(ctx: Context, config?: Config): void {
```

Four facts fall out of this file, each of which the loader confirms independently:

| Export | Kind | Real example | Loader use |
|---|---|---|---|
| `apply` | **required** | `src/index.ts:180` | the executable callback |
| `Config` | optional | `src/index.ts:19` — declared as a **TypeScript type only**, not a value | `runtime.Config`, validated at activation |
| `name` | optional | `src/index.ts:16` | `runtime.name`, diagnostics only |
| `inject` | optional | *absent here*; the market instead calls `ctx.inject([...])` at runtime (`src/index.ts:181`, `:289`) | gates activation |

Its compiled entry `PROFILE\node_modules\dshmarket\lib\index.js` begins with the same doc comment and the same
`export const name = 'dsh-market';` and ends with `}` closing `export function apply(ctx, config)`. Because
`Config` is a type, it is erased — the compiled file has **no `Config` value export at all**. That is legal:
`Config` is read off the module namespace and is simply `undefined` when absent.

> **Trap.** `export type Config` and `export const Config` are different things. A plugin that wants its `config:`
> row validated must export a **runtime value** (a schemastery schema object) — see Q3's `dsh-tool-todo`, which does
> `const Config = z.object({...})` and `export { Config, apply, inject, name }`.
> `dshmarket` deliberately exports only the *type*, so no validation happens for it.

### 1.3 The loader contract, end to end

The chain is `EntryTree` → `Loader.unwrapExports` → `ctx.registry.plugin()` → `Fiber`.

**Step 1 — import and unwrap.** `ASAR\dsh\node_modules\@deepseek-ai\cordis-plugin-loader\src\config\entry.ts` **L221–235**:

```ts
  private async _init() {
    let exports: any
    try {
      exports = await this.parent.tree.import(this.options.name, this.getOuterStack)
    } catch (error) {
      this.ctx.logger.error(error)
      return
    } finally {
      this._initTask = undefined
    }
    const plugin = this.loader.unwrapExports(exports)
    this._patchContext([])
    this.loader.showLog(this, 'apply')
    this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack).ctx.fiber
  }
```

and `...\cordis-plugin-loader\src\index.ts` **L200–208**:

```ts
  /** Normalize ESM/CJS/default export shapes before applying a plugin. */
  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    // https://github.com/evanw/esbuild/issues/2623
    // https://esbuild.github.io/content-types/#default-interop
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
```

**Step 2 — shape resolution.** `ASAR\dsh\node_modules\@deepseek-ai\cordis\lib\index.js` **L1446–1448** and **L1533–1538**:

```js
function isApplicable(object) {
	return object && typeof object === "object" && typeof object.apply === "function";
}
```

```js
	resolve(plugin) {
		try {
			if (typeof plugin === "function") return plugin;
			if (isApplicable(plugin)) return plugin.apply;
		} catch {}
	}
```

**Step 3 — runtime record and fiber.** Same file, `RegistryService.plugin()` **L1619–1641**:

```js
	plugin(plugin, config, getOuterStack = buildOuterStack()) {
		const callback = this.resolve(plugin);
		if (!callback) throw new Error("invalid plugin, expect function or object with an \"apply\" method, received " + typeof plugin);
		this.ctx.fiber.assertActive();
		let runtime = this._internal.get(callback);
		if (!runtime) {
			let name = plugin.name;
			if (name === "apply") name = void 0;
			runtime = {
				name,
				callback,
				fibers: new DisposableList(),
				Config: plugin.Config
			};
			this._internal.set(callback, runtime);
		}
		const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack);
		const wrapper = Object.create(fiber);   // (abridged: `.then` shim in the real source)
		return wrapper;
	}
```

**Step 4 — the callback invocation.** `Fiber`'s runner, same file **L1063–1074**:

```js
			this._runner = {
				epoch: INACTIVE,
				getOuterStack,
				execute: function() {
					if (isConstructor(runtime.callback)) {
						const instance = new runtime.callback(this.ctx, this.config);
						for (const hook of instance?.[symbols.initHooks] ?? []) hook();
						return instance?.[symbols.init]?.();
					} else return runtime.callback(this.ctx, this.config);
				},
				collect
			};
```

### Answers

**Which fields are required?** Only an executable. Concretely, one of:
`export function apply(...)`, `export default function (...)`, `export default class { ... }`, or an object with an
`apply` method. `name`, `inject`, `Config` are all optional. Omitting everything executable throws
`invalid plugin, expect function or object with an "apply" method, received <typeof>` (`cordis\lib\index.js:1621`).

**What does `apply(ctx)` receive?** `runtime.callback(this.ctx, this.config)` — i.e. `(ctx, config)` where

- `ctx` is the **fiber's own Cordis context** (`this.ctx = this.context = parent.extend({ fiber: this })`,
  `cordis\lib\index.js:1054`) — a per-plugin child context, not the root. This is why `ctx.effect(...)` inside `apply`
  is disposed when the plugin unloads, and why scoped registrations (`ctx.systemPrompt.section(...)`) land in that
  plugin's scope.
- `config` is the **validated** config (see below), already defaulted.

**What is `Config`, and how is it declared?** `Config` is a runtime value on the module namespace, held as
`runtime.Config`, and used only for config validation. `cordis\lib\index.js` **L956–962**:

```js
function resolveConfig(runtime, config) {
	if (!runtime.Config) return config;
	const result = runtime.Config["~standard"].validate(config);
	if ("then" in result) throw new TypeError("Async config validation is not supported");
	if (result.issues) throw new ValidationError(result.issues);
	else return result.value;
}
```

So the contract is **Standard Schema** (`~standard.validate`), *not* schemastery specifically — schemastery just
implements it. Evidence: `ASAR\dsh\node_modules\@deepseek-ai\schemastery\lib\index.mjs` **L52**:

```js
Object.defineProperty(Schema.prototype, "~standard", { get() {
```

Every shipped package declares it with schemastery (`import z from "@deepseek-ai/schemastery"`), but the loader would
accept any Standard Schema. Async validation is rejected outright. A plain object with no `~standard` property would
throw a `TypeError` on property access — **UNVERIFIED**: no shipped plugin does this, since all either omit `Config`
or use schemastery.

**What does `inject` mean?** It is a *dependency gate*, normalised by `Inject.resolve` (`cordis\lib\index.js` **L1491–1501**):

```js
	function resolve(inject, result = Object.create(null)) {
		if (!inject) return result;
		if (Array.isArray(inject)) for (const name of inject) result[name] = null;
		else if (Reflect.has(inject, symbols.checkProto)) {
			Object.assign(result, resolve(Object.getPrototypeOf(inject)));
			for (const name of Object.keys(inject)) result[name] = inject[name] ?? null;
		} else for (const name of Object.keys(inject)) result[name] = inject[name] ?? null;
		return result;
	}
```

Three accepted forms: array of names, plain object (name → intercept config), or a class whose static `inject` is
inherited via the `checkProto` marker (what `@Inject` writes, L1460–1480). The gate is enforced in
`Fiber._refresh()` (`cordis\lib\index.js` **L1317–1324**):

```js
	_refresh() {
		let epoch = false;
		epoch = "";
		for (const name of Object.keys(this.inject)) {
			const impl = this._store[name];
			if (!impl) {
				epoch = INACTIVE;
				break;
			}
```

i.e. **any declared inject service that is not yet provided leaves the fiber inactive**; it activates later when the
service appears. That is the whole semantics: `inject` never fails loudly, it defers. It also feeds
`systemPrompt`'s and `tools`' per-scope registries, which throw on duplicates with scope-specific hints — e.g.
`dsh\node_modules\@deepseek-ai\dsh-system-prompt\lib\index.js` **L190**:

```js
		this.sections = new NamedEntries((name) => /* @__PURE__ */ new Error(scope === void 0 ? `prompt section "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)` : `prompt section "${name}" is already registered in this scope`));
```

**How a plugin reaches a service it did not declare.** `ctx.get(name)` returns `unknown | undefined` and never gates
activation; `dshmarket` uses exactly this for optional hosts (`src/index.ts:183` `ctx.get('desktopProfiles')`,
`:189` `ctx.get('profileContext')`, `:133` `ctx.get('agents')`). The prescribed combination — from the live access
recipes — is: hard dependency → `inject: ['svc']` then `ctx.svc`; optional → `ctx.get('svc')` **plus an undefined
check**. `dshmarket/src/index.ts:150` `useTrustedHosts` is the worked example of why the optional form must be read
lazily, not at mount time.

---

## Q2 — The `dsh` package.json field

### 2.1 The complete public key set

The type package is `@deepseek-ai/dsh-package-manifest` (version `0.2.0-rc.2`). Its runtime entry is literally
`export {};` (`ASAR\dsh\node_modules\@deepseek-ai\dsh-package-manifest\lib\index.js`), so all content is types.
Its README is therefore the normative list; `README.md` **L46–57**:

> `DshPackageManifest` describes the package.json fields used by DSH, with required `name` and `version`; it is not an exhaustive npm schema. Local profile readers use `Partial<DshPackageManifest>` because profiles need no published version. `DshManifest` describes only public author fields under `dsh`. `DshBundleManifest.patch` is one patch file path or an ordered list of them, each relative to the package root; the launcher applies a list in order as one bundle layer.
>
> […]
>
> | Field | Meaning |
> |---|---|
> | `dsh.manifestVersion` | Manifest format identifier; the declared format is `1`, independent of the npm package version and Session format version. |
> | `engines.dsh` | Author-declared compatible DSH versions as a SemVer range, including exact prerelease versions. […]
>
> Public composition declarations are defined in [`src/types.ts`](src/types.ts). Internal `configTrees`, `sessionFormatMigration`, and generated `moduleFallback` metadata remain owned by their image-packer, catalog, and launcher readers; the public types do not expose them.

And **L93**:

> - **Compatibility is declarative.** Current installers and loaders do not enforce `dsh.manifestVersion` or `engines.dsh`; declaring a range does not reject incompatible hosts or validate SemVer syntax.

Every key below was confirmed against the code that actually reads it.

| Key | Shape | Required? | Read by |
|---|---|---|---|
| `dsh.manifestVersion` | `1` | optional, **not enforced** | declared only; no reader found |
| `dsh.bundle.patch` | `string` or `string[]`, relative to package root | optional; this is what makes a package a *bundle* | `dsh-app-boot\lib\index.js:495-509`; `dsh-plugin-manager\lib\index.js:228`, `:405` |
| `dsh.client.platform` | `string` (must be `"web"` to be served) | **required if `dsh.client` present** | `dsh-client-modules\lib\index.js:65`, `:714` |
| `dsh.client.inject` | `string[]` of package names | optional | `dsh-client-modules\lib\index.js:66` |
| `dsh.client.external` | `string[]` of exact module requests | optional | `dsh-client-modules\lib\index.js:67` |
| `dsh.client.immediately` | `boolean` | optional | `dsh-client-modules\lib\index.js:68` |
| `dsh.profile.bundles` | `string[]`, **ordered** | profile `package.json` only | `dsh-app-boot\lib\index.js:858`, `:921`, `:1064`, `:1112` |
| top-level `icon` | path relative to manifest dir | optional | `host-plugin.md:45` |
| `engines.dsh` | SemVer range | optional, **not enforced** | `dsh-package-manifest\README.md:53`, `:93` |

`dsh.client` parsing, verbatim, `ASAR\dsh\node_modules\@deepseek-ai\dsh-client-modules\lib\index.js` **L63–74**:

```js
	if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
```

and the `./client` export requirement, same file **L713–719**:

```js
		const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
		if (decl === void 0 || decl.platform !== "web") {
			…
		}
		if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
```

Real `dsh.client` declarations, all from shipped `package.json` files — note `external` always names a **subpath**:

```
@deepseek-ai/dsh-api-gateway:            {"inject":["@deepseek-ai/dsh-typert-registry","@deepseek-ai/dsh-client-connection"],"platform":"web","immediately":true}
@deepseek-ai/dsh-api-job-controller:     {"external":["@deepseek-ai/dsh-api-gateway/client"],"inject":["@deepseek-ai/dsh-api-gateway","@deepseek-ai/dsh-client-connection"],"platform":"web"}
@deepseek-ai/dsh-experimental-client-ui-voice-input: {"inject":[…],"platform":"web","external":["@deepseek-ai/dsh-api-gateway/client"]}
```

### 2.2 How `dsh.profile.bundles` composes with each bundle's `cordis.patch.yml`

The full statement of the composition, `ASAR\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js` **L462–482**:

```js
/**
* Profile discovery, initialization, and patch-layer composition for the
* `dsh --profile` launcher family.
*
* A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
* `package.json` (out-of-tree plugin dependencies plus the profile manifest
* `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
* (the user's own patch layer, applied after every bundle layer). Bundles are
* npm packages whose manifest declares
* `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` (one file, or an
* ordered list of files); the tree is composed by applying each bundle's patch
* lists in `dsh.profile.bundles` order over an empty entry list, then the
* profile's own patches, then any launcher layers (`--patch` files and
* flag-derived patches).
*
* Module resolution is two-anchor by construction: a bundle name resolves
* first from the dsh installation (the launcher's own package), then from the
* profile directory. Pnpm-managed entries in the profile's `node_modules`
* resolve first. The runtime resolution supplies packages carried by the
* installation and selected bundles to Node's ESM and CommonJS resolvers.
* @module @deepseek-ai/dsh-app-boot/profile
*/
```

The actual layer assembly, same file **L1025–1033**:

```js
	const patches = structuredClone([
		...profile.layers.flatMap((layer) => layer.patches),
		...initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? [],
		...loadOptionalPatches(binName, join(context.home, "cordis.patch.yml")) ?? [],
```

So the effective order is:

```
bundle[0].patch … bundle[n].patch   (in dsh.profile.bundles order)
  → <profile>/cordis.patch.yml     (the user layer)
  → ~/.dsh/cordis.patch.yml        (home layer)
  → --patch files / launcher flag patches
applied over an empty entry list
```

Two more details that matter when authoring a bundle:

- **A bundle's `patch` may be a list.** `dsh-app-boot\lib\index.js` **L495–509**:

  ```js
  function bundlePatchFiles(bundle) {
  	const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
  	if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string")) throw new Error("dsh.bundle.patch must be a file path or a list of file paths");
  	return declared;
  }
  ```

- **A package with a conventional root `cordis.patch.yml` is picked up even without `dsh.bundle.patch`.** `dshmarket` relies on this for the loader half (`PROFILE\node_modules\dshmarket\src\patch.ts:276-286`): *"a package may ship cordis.patch.yml at its root without declaring dsh.bundle.patch (the loader probes it too)."* **UNVERIFIED** — I did not locate the probe itself in `dsh-app-boot`; I only have dshmarket's comment plus its `bundlePatchInsertedIds`/`parsePatchRows` fallback logic.

The live profile under test, `PROFILE\package.json`, is exactly this shape:

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@openviking/dsh-memory-plugin": "0.5.13",
    "dshmarket": "^1.66.8",
    "mattpocock-skills-dsh": "0.1.8"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-auto-review",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "dshmarket",
        "@openviking/dsh-memory-plugin",
        "mattpocock-skills-dsh"
      ]
    }
  }
}
```

and `PROFILE\cordis.yml` is an empty entry list (the composition is entirely patches).

### 2.3 The exact patch semantics

`applyEntryPatches` is described in-source as *"THE patch semantics of this include, shared by mounting (`applyPatches`) and offline config tooling (`dsh --dump-config`) so a dump can never drift from what boots."*
`ASAR\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js` **L61–110**, verbatim:

```js
function applyEntryPatches(data, patches, warn) {
	if (!patches?.length) return [...data];
	data = structuredClone(data);
	const entryMap = /* @__PURE__ */ new Map();
	const buildMap = (entries) => {
		for (const entry of entries) {
			if (entry.id) entryMap.set(entry.id, entry);
			if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
		}
	};
	buildMap(data);
	for (const patch of patches) {
		const { id, insert, name, ...overrides } = patch;
		if (insert) {
			if (id) {
				const target = entryMap.get(id);
				if (!target) {
					warn("patch insert: entry %C not found", id);
					continue;
				}
				if (!target.group) {
					warn("patch insert: entry %C is not a group", id);
					continue;
				}
				if (!Array.isArray(target.config)) target.config = [];
				target.config.push(...insert);
			} else data.push(...insert);
			buildMap(insert);
			continue;
		}
		if (!id) {
			warn("patch: id is required for non-insert patches");
			continue;
		}
		const target = entryMap.get(id);
		if (!target) {
			warn("patch: entry %C not found", id);
			continue;
		}
		if (name && name !== target.name) {
			warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name);
			continue;
		}
		for (const [key, value] of Object.entries(overrides)) {
			if (key === "id") continue;
			target[key] = value;
		}
	}
	return data;
}
```

The generated JSON Schema restates the same rules — same file **L2755–2762**:

```js
function patchStructure() {
	return {
		type: "object",
		allOf: [ref("entryMetadata")],
		properties: { insert: ref("entryList") },
		description: "An insert appends entries, optionally inside the group identified by id. Other patches replace supplied fields; config is replaced wholesale, not deep-merged. A truthy name asserts the existing plugin name rather than renaming it. Unknown targets and non-insert patches without a nonempty id are warned and skipped."
	};
}
```

And the per-row metadata vocabulary, same file **L2721–2753**:

```js
function metadata() {
	return {
		id: {
			type: "string",
			description: "Entry id. Loader generates an id when an entry omits it; patches use the configured id."
		},
		name: {
			type: "string",
			description: "Plugin module specifier. Inserted relative plugin paths are anchored beside their patch file."
		},
		config: {},
		group: {
			type: ["boolean", "null"],
			description: "Allows patch indexing and insertion into an entry-list config; does not select the plugin implementation."
		},
		disabled: {
			anyOf: [{ type: ["boolean", "null"] }, ref("loaderExpression")],
			description: "Boolean or !!js expression. The Loader coerces other truthy values as disabled; this schema rejects them."
		},
		inject: { anyOf: [
			{
				type: "array",
				items: { type: "string" }
			},
			{ type: "object" },
			{ type: "null" }
		] },
		intercept: { type: ["object", "null"] },
		isolate: {
			type: ["object", "null"],
			additionalProperties: { anyOf: [{ const: true }, { type: "string" }] }
		}
	};
}
```

#### Patch entry forms

| Form | YAML | Effect |
|---|---|---|
| **Insert at root** | `- insert: [ {id, name, config?}, … ]` | rows appended to the entry list |
| **Insert into a group** | `- insert: [ … ]` + `id: <group row id>` | rows appended to that group's `config` array; warns `patch insert: entry %C not found` / `… is not a group` |
| **Override by id** | `- id: <row id>` + any of `config`, `disabled`, `inject`, `intercept`, `isolate`, `group` | each supplied field **replaces** the target's field. `config` is replaced **wholesale, never deep-merged** |
| **Disable** | `- id: <row id>` + `disabled: true` | stops the entry and its descendants |
| **Force-enable** | `- id: <row id>` + `disabled: false` | re-enables a row a lower layer disabled |
| **Dynamic disable** | `- id: X` + `disabled: !!js "!ctx.get('profileContext')"` | evaluated against the loader context at every mount decision |
| **Name assertion** | `- id: <row id>` + `name: <pkg>` | *asserts* — a mismatch warns `patch: name mismatch for %C (expected %C, got %C), skipping` and skips. It does **not** rename |
| **Group row** | `- id: g, name: cordis:group, group: true, config: [ …rows… ]` | `config` becomes a nested entry list; patchable by `id` |
| **Include** | `- id: i, name: cordis:include, config: {path: …}` | loads a literal YAML/JSON entry list |

There is **no `- disable: [...]` form and no `- remove:` form**; the only disable form is an id-targeted row with
`disabled: true`. `patch.ts` in dshmarket searches for exactly two shapes and nothing else
(`PROFILE\node_modules\dshmarket\src\patch.ts:158`, `:168-172`) — `/^- insert:\s*$/u` for the insert block, and
`/^- id: ([A-Za-z0-9_.-]+)\s*$/u` followed by `/^ {2}disabled: true\s*$/u` or `/^ {2}disabled: false\s*$/u`.

Two authored-form rules from the shipped composition reference
(`dsh-agent-preset\skills\cordis-composition-reference\SKILL.md` **L10–25**):

> A profile composes an ordered list of patch layers over the bundle entry lists. Each patch is a mapping:
>
> - `insert: [rows]` appends rows; with an `id` naming an existing `group: true` row, the rows are appended inside that group's `config` list.
> - A patch with an `id` and no `insert` targets the existing row with that id. Supplied fields replace the row's fields; `config` is replaced wholesale, never deep-merged, so restate every field the row needs. A truthy `name` asserts the existing plugin name rather than renaming it.
> - Non-insert patches without a nonempty `id`, and targets that match no row, are warned about and skipped.
>
> A row has `id`, `name` (the plugin package specifier; inserted relative paths are anchored beside their patch file), optional `config`, and optional `disabled`, `inject`, `intercept`, and `isolate`.
>
> - `group: true` with `name: cordis:group` makes `config` a nested entry list and allows patches to insert into it by id. `cordis:include` loads a literal YAML or JSON entry list from `config.path`.
> - `disabled` accepts a boolean, null, or a `!!js` expression evaluated against the Loader context at every mount decision. A disabled row omits required `config` unless `group: true` forces activation.
> - `!!js` scalars are Loader expressions, never `!js`. Inside `config` they are evaluated after the row's declared injections activate, against that plugin's context (`ctx.<service>`), so `!!js dshHomePath('sessions')` and `!!js "!ctx.get('profileContext')"` are valid. Other row metadata stays literal.
> - `isolate` maps service names to `true` or a realm label; a preset plugin that provides a service isolates the provider and all consumers together. Scope controls contributions and event visibility; `isolate` controls service instances.

#### Real patch files

The two-file minimum, `dsh-agent-preset\skills\cordis-plugin-development\templates\decoration\`:

```yaml
# cordis.patch.yml
- insert:
    - id: my-decoration
      name: '@local/my-decoration'
```

The `mcp` template shows a row with config, `templates\mcp\cordis.patch.yml`:

```yaml
- insert:
    - id: demo-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: demo
        transport: streamable-http
        url: http://127.0.0.1:3000/mcp
        failOnStartupError: true
```

`dsh-experimental-auto-review\cordis.patch.yml` is the whole file, one row.

`dsh-base\cordis.patch.yml` shows `disabled` and `!!js`, and states the no-deep-merge rule in its own header
(**L5–7**):

```yaml
# A patch replaces the targeted row's whole `config` rather than merging into
# it, so a row whose value differs by mode does NOT live here: it belongs to
# each mode bundle, keeping any single row down to one bundle layer plus the
# user's.
…
- insert:
    - id: tool-plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager/tools'
      disabled: true

    - id: plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager'
      disabled: !!js "!ctx.get('profileContext')"

    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'

    # Profile configuration reloads by default; module roots are opt-in.
    - id: hmr
      name: '@deepseek-ai/dsh-hmr'
      disabled: !!js "!ctx.get('profileContext')"
      config:
        root: []
```

### 2.4 Enabling, disabling, and version compatibility

`ASAR\dsh\node_modules\@deepseek-ai\dsh-plugin-manager\README.md` **L40**:

> A plugin toggle updates only `disabled` in the last matching override in the profile's `cordis.patch.yml`, or appends an override when none matches. Matching uses the entry id and any module-name assertion. A bundle toggle changes `package.json`'s ordered `dsh.profile.bundles` list. Disabling retains the dependency; **enabling appends the bundle at the end, which can change configuration precedence.** Installation enables a new bundle by default. Home and invocation patches retain their higher priority.

Same file **L63** (peer checking) and **L65** (exemptions):

> An install command that names packages (`add`, or `install` with specs) is checked before pnpm runs: a local path is read from its own `package.json`, and a registry spec is resolved through pnpm's registry lookup for the version its range selects and the peers that version declares. An incompatible DSH peer rejects the operation before pnpm runs, so nothing is downloaded and no build script runs; […]
>
> An exemption is an exact `package-name@version` mapped to a list of exact DSH runtime versions in the profile's own `compatibility.json`, beside `package.json` and `cordis.patch.yml`. […]

`compatibility.json` is absent from `PROFILE\` in this install, so no exemptions are in force.

**Module resolution consequence (important for authoring).** A profile-installed plugin's bare
`@deepseek-ai/*` imports resolve through an in-memory routing table the host installs on Node's loaders —
`dsh-app-boot\lib\index.js` **L1156–1158**:

```js
//#region lib/types/profile-resolution/resolver.js
/** In-memory profile package routing for Node's default ESM and CommonJS loaders. */
const WORKER_RESOLUTION_KEY = "@deepseek-ai/dsh-app-boot/profile-resolution";
```

Installed at **L1637**: *"Install one runtime resolution as the interception on Node's default ESM and CommonJS resolvers."*
That is why a plugin declares its `@deepseek-ai/*` needs as **peerDependencies** and can still `import` them at
runtime — proven by `dshmarket`, whose *compiled* `PROFILE\node_modules\dshmarket\lib\settings.js:70` contains
`import z from '@deepseek-ai/schemastery';` while `package.json` lists schemastery only under
`peerDependencies` + `devDependencies`.

---

## Q3 — Tool registration

### 3.1 The minimal real tool, verbatim and complete

`@deepseek-ai/dsh-tool-todo` is the smallest shipped tool plugin (6602 bytes, 196 lines) and is a complete worked
example. `ASAR\dsh\node_modules\@deepseek-ai\dsh-tool-todo\lib\index.js`:

```js
// L1-3 — imports. NOTE: `defineTool` is the shipped authoring helper.
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
```

```js
// L5-24
/**
* Model-facing whole-list replacement. Each call appends a `todo/write` snapshot to the calling
* agent's session; replay is last-write-wins, and UIs render from session events. A non-agent
* caller has no owning list and is rejected. Named exports preserve loader injection metadata.
* @module @deepseek-ai/dsh-tool-todo
*/
const name = "tool-todo";
const inject = ["tools", "sessionProjections"];
/** The valid {@link TodoItem} statuses, as a runtime set for input narrowing. */
const STATUSES = [
	"pending",
	"in_progress",
	"completed"
];
/** Schemastery configuration for the todo tool consumer. */
const Config = z.object({ allowParallelInProgress: z.boolean().required() });
const DESCRIPTION_HEAD = "Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. ";
const DESCRIPTION_PARALLEL = "While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. ";
const DESCRIPTION_SINGLE = "While work remains, keep exactly one todo `in_progress`. ";
const DESCRIPTION_TAIL = "Mark each todo `completed` as soon as it is done.";
```

```js
// L78-95 — apply(), the session projection, and the start of the tool registration
function apply(ctx, config) {
	const allowParallel = config.allowParallelInProgress;
	ctx.sessionProjections.register({
		key: "todos",
		stateSchema: todosProjectionSchema,
		init: () => null,
		apply: (state, event) => {
			if (event.type === "todo/write") return event.data.todos;
			if (event.type === "turn/start") return null;
			return state;
		},
		wire: {
			viewSchema: todosProjectionSchema,
			view: (state) => state
		},
		stateVersion: 2
	});
	ctx.tools.register(defineTool({
		name: "todo_write",
		description: describe(allowParallel),
```

```js
// L98-119 — `parameters`: the author-facing schema SPEC, not raw JSON Schema and not zod
		parameters: { todos: {
			type: "array",
			required: true,
			description: "The COMPLETE task list, replacing any previous list.",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					content: {
						type: "string",
						required: true,
						description: "What the task is — a short imperative line."
					},
					status: {
						type: "string",
						required: true,
						enum: [...STATUSES],
						description: "pending (not started) | in_progress (now) | completed (done)."
					}
				}
			}
		} },
```

```js
// L120-169 — `output`: schema + render. `render` PRODUCES the model-visible content blocks.
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					todos: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								content: {
									type: "string",
									required: true
								},
								status: {
									type: "string",
									required: true,
									enum: [...STATUSES]
								}
							}
						}
					},
					counts: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							pending: {
								type: "integer",
								required: true
							},
							inProgress: {
								type: "integer",
								required: true
							},
							completed: {
								type: "integer",
								required: true
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`
			}]
		},
```

```js
// L170-193 — execute + presentCall, closing the register() call
		execute(args, exec) {
			const todos = toTodoList(args.todos, allowParallel);
			if (!exec.agent) throw new Error("todo_write requires an owning agent session");
			exec.agent.session.append("todo/write", { todos });
			const count = (status) => todos.filter((t) => t.status === status).length;
			return Promise.resolve({
				todos: todos.map((todo) => ({
					content: todo.content,
					status: todo.status
				})),
				counts: {
					pending: count("pending"),
					inProgress: count("in_progress"),
					completed: count("completed")
				}
			});
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Update todo list",
			kind: "other",
			rawInput: args.todos
		})
	}));
}
```

```js
// L195-196
//#endregion
export { Config, apply, inject, name };
```

Note `parameters: {}` is valid for a no-argument tool — `dsh-tool-goal\lib\index.js:267` does exactly that for
`get_goal`.

### 3.2 `defineTool` — the actual field list and what it enforces

`defineTool` is the shipped way to build a definition. `ASAR\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js`
**L831–887**, verbatim:

```js
/**
* Define a first-party tool with inferred arguments and strict execution
* validation. Replay-only presenters validate softly and fall back to generic
* rendering for obsolete logged arguments.
* @param options - typed definition and optional finalizer and presenters.
* @returns A registry-ready definition.
*/
function defineTool(options) {
	const userExecute = options.execute;
	const userFinalizeContent = options.finalizeContent;
	const userProjectContent = options.projectContent;
	const userRender = options.output.render;
	const userPresentationMeta = options.output.presentationMeta;
	const userPresentCall = options.presentCall;
	const userPresentResult = options.presentResult;
	const userIsConcurrencySafe = options.isConcurrencySafe;
	if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validate = (args) => validateJsonSchemaValue(parameters, args, "");
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render(args, value) {
				return userRender(args, value);
			},
			...userPresentationMeta !== void 0 ? { presentationMeta(args, value) {
				return userPresentationMeta(args, value);
			} } : {}
		},
		...options.deferLoading === true ? { deferLoading: options.deferLoading } : {},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	if (userProjectContent) tool.projectContent = (exec, result) => userProjectContent(exec, result);
	if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
	if (userPresentCall) tool.presentCall = (args) => {
		if (validate(args).length > 0) return void 0;
		return userPresentCall(args);
	};
	if (userPresentResult) tool.presentResult = (args, result) => {
		if (validate(args).length > 0) return void 0;
		return userPresentResult(args, result);
	};
	if (userIsConcurrencySafe) tool.isConcurrencySafe = (args) => {
		if (validate(args).length > 0) return false;
		return userIsConcurrencySafe(args);
	};
	return tool;
}
```

So the accepted options are: `name`, `description`, `parameters`, `output.schema`, `output.render`,
`output.presentationMeta?`, `deferLoading?`, `timeoutMs?`, `execute`, `projectContent?`, `finalizeContent?`,
`presentCall?`, `presentResult?`, `isConcurrencySafe?`.

Consequences worth knowing:

- `execute` is wrapped in `async`, so returning a plain object or a Promise both work.
- `presentCall` / `presentResult` / `isConcurrencySafe` run validation **softly**: invalid or obsolete logged
  arguments make them return `undefined`/`false` instead of throwing. That is what makes replay of old sessions safe.
- `timeoutMs` must be a positive finite number or `defineTool` throws synchronously.

### 3.3 Which schema library builds `parameters`? None — it is DSH's own author-facing spec

This is the most commonly mis-guessed part. `parameters` is **not** zod, **not** schemastery, and **not** raw JSON
Schema. It is an *author-facing spec* that DSH compiles to JSON Schema at `defineTool` time.

- `parameterSchemaSpecToJsonSchema` — `dsh-tools\lib\index.js` **L797–811**:

  ```js
  /**
  * Compile the implicit open parameter object into raw JSON Schema.
  * @param spec - per-property parameter definitions.
  * @returns An object-rooted raw schema with no implicit-root openness override.
  */
  function parameterSchemaSpecToJsonSchema(spec) {
  	const compiled = compilePropertyMap(spec, "parameters");
  	const schema = {
  		type: "object",
  		properties: compiled.properties,
  		...compiled.required === void 0 ? {} : { required: compiled.required }
  	};
  	assertSupportedJsonSchema(schema);
  	return schema;
  }
  ```

- `parameters` is a **bare property map** — there is no top-level `type: "object"`. You write
  `parameters: { todos: { type: "array", required: true, … } }`, and DSH supplies the object wrapper and hoists
  `required: true` per property into the JSON-Schema `required` array. That is why the todo example has
  `required: true` **inside each property**.

- Two `type` vocabularies exist: the **author** vocabulary and the **wire** (JSON Schema) vocabulary. From
  `runSchemaCompiler`'s `switch`, same file: author types are `string`, `number`, `integer`, `boolean`, `null`,
  `array`, `object`, `json`, plus `oneOf`. The default arm is **L751**:

  ```js
  			default: authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
  ```

  and the per-type allowed author keys come from `assertAuthorKeys`, e.g. for `array` (**L714–718**) `type` + `items`
  only, for scalars (**L737–742**) `type` + `enum` + `const`, for `object` also `properties` +
  `additionalProperties`. `description` is one of the shared `authorKeys`. `json` is the author-only escape hatch that
  becomes an annotation-only schema (`valueSchemaSpecToJsonSchema` doc, L786–796).

- `output.schema` goes through `valueSchemaSpecToJsonSchema` (L792–796), which compiles a **value** root (so
  `type` is expected at the root) and calls `assertSupportedJsonSchema`.

- zod appears in the todo plugin **only** for the `sessionProjections` wire schema (`z$1`), and schemastery only for
  `Config`. Neither is the tool-parameter language.

### 3.4 `execute` — what it receives, what it must return

**Receives** `(args, exec)` where `args` has already been validated against the compiled parameter schema
(`defineTool` L866–870), and `exec` is the DSH `ToolRunContext`. From the real code: `exec.agent` exists and is
`undefined` for an agentless call (`dsh-tool-todo:172`), and `exec.agent.session.append(type, data)` is the session
log write (`:173`). The full `ToolExecutionInput`/`ToolRunContext` member list (`callId`, `rootCallId`, `name`,
`schema`, `arguments`, `agent`, `parent`, `signal`, `deferContext`, `concludeTurn`) comes from the prior session's
live `Service.listService({service:'tools'})` inspect — **the `.d.ts` that declares it is not present in this install**
(see Q7), so treat the member list as inspected-live rather than re-read here. `exec.signal` and `exec.agent` are the
two members I re-confirmed from shipped code in this session.

**Must return** a value matching `output.schema`. `createSuccessResult` (`dsh-tools\lib\index.js` **L3540–3552**)
snapshots it, validates it, deep-freezes it, then calls `output.render(exec.arguments, value)` to produce the
model-visible blocks:

```js
	createSuccessResult(exec, tool, candidate) {
		const detached = snapshotToolValue(tool.name, candidate);
		const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
		if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
		const value = deepFreeze(detached);
		let rendered;
		try {
			rendered = tool.output.render(exec.arguments, value);
		} catch (error) {
			throw projectionError(tool.name, "render", error);
		}
```

The **content-block shape** is therefore `ContentBlock[]`, and the only form used by every shipped tool is
`{ type: "text", text: string }` — see the todo `render` above, which returns exactly that.

### 3.5 How to return an ERROR the model can see

**Throw an `Error` from `execute`.** The pipeline converts it. `dsh-tools\lib\index.js` **L3616–3630**, verbatim:

```js
function toolErrorResult(error) {
	const info = errorInfo(error);
	const message = errorMessage(error);
	return {
		content: [{
			type: "text",
			text: `Error: ${message}`
		}],
		isError: true,
		error: {
			message,
			...info ? { info } : {}
		}
	};
}
```

So `throw new Error("todo_write requires an owning agent session")` reaches the model as a text block reading
`Error: todo_write requires an owning agent session`, with `isError: true`. This is why every shipped tool body uses
plain `throw new Error(...)` — e.g. `dsh-tool-todo:51`, `:52`, `:60`, `:172`.

Argument validation failures take the same route with a dedicated error class, **L812–821**:

```js
/** Invalid model-generated arguments for a typed tool. */
var ToolArgsError = class extends HarnessError {
	/** Individual violations in schema-walk order. */
	violations;
	constructor(violations) {
		super(`invalid arguments: ${violations.join("; ")}`, "INVALID_ARGS");
		this.name = "ToolArgsError";
		this.violations = violations;
	}
};
```

Cancellation has its own canned texts, `toolAbortedResult` (**L3676–3693**) → `Error: tool call aborted`, and
`toolAbortedBeforeDispatchResult` (**L3695–3712**) → `Error: tool call aborted before dispatch`.

A plugin can also *block* another tool's result into an error from the `tools/post-execute` waterfall
(**L3506–3513**), but that is intervention, not the normal error path.

### 3.6 Registration gate and collisions

- Reserved name — `dsh-tools\lib\index.js` **L2885**:

  ```js
  		if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
  ```

- Duplicate within one scope — same file **L2634**:

  ```js
  		this.tools = new NamedEntries((name) => /* @__PURE__ */ new Error(scope === void 0 ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` : `tool "${name}" is already registered in this scope`));
  ```

- `register` returns *the exact disposer that unregisters the tool*; scoped registrations shadow globals.

### 3.7 Presentation vocabulary (`presentCall` / `presentResult`)

Observed `card` values across all shipped tools (exhaustive grep for `card: "…"`):

`"generic"` (the overwhelming default), `"read"`, `"diff"`, `"search"`, `"terminal"`, `"web"`.

Real per-card examples: `dsh-tool-fs\lib\index.js:376` `card: "read"`, `:603` `card: "diff"`;
`dsh-tool-fs-search\lib\index.js:485` `card: "search"`; `dsh-tool-bash\lib\index.js:257` `card: "terminal"`;
`dsh-tool-web\lib\index.js:168` `card: "web"`.

The other two fields are free-form: `title` is the display label and `kind` is a sub-operation label
(`"read"`, `"execute"`, `"foreground"`, `"background"`, `"search"`, `"head"`, `"tail"`, `"tool"`, `"present"`, …).
`rawInput` carries the raw arguments for the detail view. The canonical minimal helper, verbatim from
`dsh-tool-goal\lib\index.js` **L248–255**:

```js
function present(title, kind, rawInput) {
	return {
		card: "generic",
		title,
		kind,
		...rawInput === void 0 ? {} : { rawInput }
	};
}
```

**UNVERIFIED:** the closed enum for `card` is not declared anywhere I could read (the type module
`dsh-tools\lib\types\presentation.js` is types-only and its `.d.ts` is stripped). The six values above are the
complete observed set, and nothing enforces them at runtime — an unknown `card` degrades to generic rendering.

---

## Q4 — Context injection into the model's context

### 4.1 The service

`ctx.systemPrompt` is provided by `@deepseek-ai/dsh-system-prompt`. Access is hard (`inject = ["systemPrompt"]`,
as `dsh-persona\lib\index.js:21` does) or soft (`ctx.inject(["systemPrompt"], scope => …)`, as
`dsh-sandbox-policy\lib\index.js:121` does).

Full member list, from `dsh-system-prompt\lib\index.js`:

| Method | Line | Signature |
|---|---|---|
| `section` | 240 | `section(section: PromptSection): () => void` |
| `context` | 266 | `context(context: PromptContext): () => void` |
| `variable` | 297 | `variable(name: string, provider: (context: AssembleContext) => string \| undefined): () => void` |
| `tools` | 286 | `tools(provider: (context: AssembleContext) => ToolProviderResult): () => void` |
| `suppressRuntimeContext` | 276 | `suppressRuntimeContext(): () => void` |
| `getSectionOrder` | 249 | `getSectionOrder(name: string): number` |
| `getContextOrder` | 257 | `getContextOrder(name: string): number` |
| `assemble` | 310 | `async assemble(context = {}): Promise<PromptAssembly>` |

Doc comments verbatim:

```js
// L232-243
	/**
	* Register an ordered prompt section in the calling context's scope. A scoped
	* section shadows a global section with the same name; duplicates within one
	* layer and non-finite orders throw. Registration and disposal emit
	* `system-prompt/change`.
	* @param section - the section to register.
	* @returns the exact Cordis effect disposer.
	*/
	section(section) {
		if (!Number.isFinite(section.order)) throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
		return this.layers.effect(this.ctx, (layer) => layer.sections.insert(section.name, section), { label: "systemPrompt.section()" });
	}
```

```js
// L260-269
	/**
	* Register ordered dynamic context in the calling context's scope. Scoped
	* entries shadow global entries with the same name.
	* @param context - the context contribution to register.
	* @returns the exact Cordis effect disposer.
	*/
	context(context) {
		if (!Number.isFinite(context.order)) throw new TypeError(`prompt context "${context.name}" order must be a finite number`);
		return this.layers.effect(this.ctx, (layer) => layer.contexts.insert(context.name, context), { label: "systemPrompt.context()" });
	}
```

### 4.2 The shapes

There is no `.d.ts` in this install (Q7), so the shapes are read off `assemble()` and the renderers, which are
authoritative. `dsh-system-prompt\lib\index.js` **L338–354**:

```js
		const assembly = {
			sections: sectionDefinitions.map((section) => {
				const assembled = {
					name: section.name,
					text: typeof section.text === "function" ? section.text(context) : section.text,
					...section.interpolate !== void 0 ? { interpolate: section.interpolate } : {}
				};
				if (section.complete === true) completeSection = { ...assembled };
				return assembled;
			}),
			contexts: runtimeContextSuppressed ? [] : [...contextByName.values()].sort((a, b) => a.order - b.order).map((entry) => ({
				name: entry.name,
				text: typeof entry.text === "function" ? entry.text(context) : entry.text
			})),
			tools: orderTools(collected, this.toolOrder, knownNames),
			variables
		};
```

and the ordering comparator, **L97–99**:

```js
function comparePromptSections(a, b) {
	return a.order - b.order || compareNames(a.name, b.name);
}
```

So, verified from real reads:

```ts
// Verified fields (assembled section view, L339-346)
interface PromptSection {
  name: string                                  // required; uniqueness key within one layer
  order: number                                 // required; must be finite
  text: string | ((context: AssembleContext) => string)   // required
  interpolate?: boolean                         // default true; false keeps {{}} literal
  complete?: boolean                            // only ONE active complete section is allowed
}

interface PromptContext {
  name: string
  order: number
  text: string | ((context: AssembleContext) => string)
}
```

- `interpolate` is **only** on sections, never on contexts — `assemble()` copies it for sections only, and
  `interpolate(input, variables, kind)` is called for contexts with no such flag (L149).
- Contexts sort by `order` **only** — no name tiebreaker (L348), unlike sections.
- `complete` — at most one active complete section, else **L335–336**:

  ```js
  		const completeSections = sectionDefinitions.filter((section) => section.complete === true);
  		if (completeSections.length > 1) throw new Error(`multiple complete prompt sections are active: ${completeSections.map((section) => JSON.stringify(section.name)).join(", ")}`);
  ```

  and when one is active it becomes the *sole* prompt section (L356–361). `dsh-persona` is the real user:
  `Config.complete` (`dsh-persona\lib\index.js:26`) → `...config.complete ? { complete: true } : {}` (`:40`).

`AssembleContext` — from the call `installContext` at `dsh-system-prompt\lib\index.js` **L355** and the sandbox
consumer below, the object carries at least `scope` and `agent`. Concretely, a context render function receives a
`context` whose `.agent?.session` is meaningful — see the verified usage in 4.4.

### 4.3 Section vs context — the real difference is *where the text lands*

Two different renderers, two different destinations. `dsh-system-prompt\lib\index.js` **L104–115** and **L117–136**,
verbatim:

```js
/**
* Interpolate strict `{{variable}}` references, drop empty sections, and join
* the rest with blank lines. Sections with `interpolate: false` retain literal
* text. Malformed, unknown, or undefined references in other sections throw;
* a lone `{{` without any later `}}` is literal prose, and substituted values
* are not scanned again.
* @param assembly - the assembly whose sections and variables to render.
* @returns the rendered prompt, or `''` when all sections are empty.
*/
function renderPrompt(assembly) {
	return assembly.sections.map((section) => section.interpolate === false ? section.text : interpolate(section, assembly.variables, "section")).filter((text) => text.length > 0).join("\n\n");
}
```

```js
/**
* The model-facing snapshot text for an already-rendered section list.
*
* A caller that also needs the sections renders them once and joins here, so a
* request does not interpolate every context twice.
* @param sections - sections from {@link renderContextSections}.
* @returns the current full snapshot, or `''` when no context is active.
*/
function joinContextSections(sections) {
	const body = sections.map((section) => section.text).join("\n\n");
	if (body.length === 0) return "";
	return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`;
}
```

| | `section()` | `context()` |
|---|---|---|
| Output | the **system prompt** — `renderPrompt` joins sections with blank lines, nothing prepended | a **runtime-context snapshot** — joined and prefixed with `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.` |
| Stability | intended to be the stable prefix (hence the ~30 fixed `SECTION_ORDERS`) | explicitly labelled *dynamic* and *superseding* — a fresh snapshot each step |
| `interpolate: false` | supported | not supported |
| `complete` | supported (sole-section override) | not supported |
| Suppressed by | — | `suppressRuntimeContext()` empties **all** contexts (L313, L348, L360) |
| Typical use | tool guidance, persona, policy prose | state that changes per session/step (sandbox mode, approval policy) |

Ordering constants, verbatim, `dsh-system-prompt\lib\index.js` **L10–48**:

```js
const SECTION_ORDERS = {
	HARNESS_IDENTITY: -1e3,
	DEPLOYMENT_PERSONA_PREFIX: 0,
	PLAN_POLICY: 500,
	TEAM_POLICY: 600,
	PTC_ONLY: 800,
	FILE_REFERENCE: 900,
	TOOL_BASH: 1e3,
	TOOL_PWSH: 1010,
	TOOL_READ: 1100,
	TOOL_WRITE: 1200,
	TOOL_EDIT: 1300,
	TOOL_GLOB: 1400,
	TOOL_GREP: 1500,
	TOOL_JOBS: 1600,
	TOOL_PTY: 1700,
	TOOL_WEB_SEARCH: 2e3,
	TOOL_WEB_FETCH: 2100,
	TOOL_LSP: 2200,
	TOOL_SESSION_QUERY: 2300,
	TOOL_GOAL: 2400,
	TOOL_WORKFLOW: 2600,
	TOOL_RALPH: 2700,
	TOOL_SUBAGENT: 2800,
	TOOL_REPORT: 2900,
	TOOL_COMPUTER_USE: 3e3,
	MCP_SERVERS: 3100,
	TOOLS_SDK: 5e3,
	DELIVERABLE_FILE_REFERENCES: 9e3,
	STRUCTURED_OUTPUT: 9900,
	HARNESS_SOURCE: 1e4,
	WEB_SURFACE: 10100,
	DEPLOYMENT_PERSONA_SUFFIX: 10200
};
const CONTEXT_ORDERS = {
	SANDBOX_POLICY: 110,
	APPROVAL_POLICY: 115,
	SUBAGENT_DELEGATION: 120
};
```

Use `ctx.systemPrompt.getSectionOrder("TOOL_GOAL")` rather than hard-coding `2400` — that is what every shipped
consumer does, so the number can move without breaking a plugin.

Variable interpolation (`interpolate`, **L152–177**) is strict: names must match `VARIABLE_NAME`
(`/^[a-z][a-z0-9_]*$/`, L59) and an unknown or valueless reference **throws**:

```js
			throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: ${known.length > 0 ? known.join(", ") : "(none)"}`);
```

```js
		if (value === void 0) throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (${kind} "${input.name}")`);
```

Substituted values are deliberately **not** rescanned (L108–109).

### 4.4 Real usages, verbatim

**(a) Two global sections, from config** — `ASAR\dsh\node_modules\@deepseek-ai\dsh-persona\lib\index.js`
**L29–48**:

```js
/**
* Register the persona prefix and suffix sections for the mounting context's scope.
* @param ctx - an agent scope context; an unscoped context collides with the
* prompt registry's own persona registration and rejects.
* @param config - the prefix, suffix, and complete-prompt policy.
*/
function apply(ctx, config) {
	ctx.effect(() => ctx.systemPrompt.section({
		name: PERSONA_PREFIX_SECTION,
		order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
		text: config.prefix,
		...config.complete ? { complete: true } : {}
	}), "persona.section()");
	ctx.effect(() => ctx.systemPrompt.section({
		name: PERSONA_SUFFIX_SECTION,
		order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX"),
		text: config.suffix ?? ""
	}), "persona.suffix()");
	if (!(config.includeRuntimeContext ?? true)) ctx.systemPrompt.suppressRuntimeContext();
}
```

Two things to copy here: the `name` is a **shared constant** (`PERSONA_PREFIX_SECTION`, imported from
`dsh-system-prompt`) precisely so a higher layer can *replace* rather than duplicate the section — see the constant's
doc at `dsh-system-prompt\lib\index.js` **L49–55** — and every registration is wrapped in `ctx.effect(..., label)`
so it disposes with the plugin.

**(b) A tool-guidance section alongside tool registration** — `dsh-tool-goal\lib\index.js` **L256–263**:

```js
/** Register the three Codex-shaped goal tools and their shared policy section. */
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	ctx.systemPrompt.section({
		name: "tool:goal",
		order: ctx.systemPrompt.getSectionOrder("TOOL_GOAL"),
		text: guidance(resolved.blockedAfterConsecutiveRounds)
	});
```

Note there is **no** `ctx.effect` wrapper and no `inject` in this file's `apply` beyond its own declaration — a
registration inside `apply` is already owned by the plugin's fiber.

**(c) A per-session dynamic context with a function `text`** — this is the closest real template for "inject text
into the context per step", `ASAR\dsh\node_modules\@deepseek-ai\dsh-sandbox-policy\lib\index.js` **L114–130**:

```js
		ctx.sessionProjections.register({
			key: "sandboxMode",
			stateVersion: 1,
			stateSchema: sandboxModeStateSchema,
			init: () => null,
			apply: (state, event) => event.type === "sandbox/mode" ? event.data.mode : state
		});
		ctx.inject(["systemPrompt"], (scope) => {
			scope.systemPrompt.context({
				name: "sandbox:policy",
				order: scope.systemPrompt.getContextOrder("SANDBOX_POLICY"),
				text: (context) => {
					const session = context.agent?.session;
					return session === void 0 ? "" : renderPolicyContext(this.resolve({ session }));
				}
			});
		});
```

This is the pattern to copy for per-step, session-aware text: `ctx.inject(["systemPrompt"], cb)` to defer until the
service exists, a **function** `text`, read the session off `context.agent?.session`, and return `""` when there is
nothing to say (empty text is filtered out, L150).

### 4.5 Scoping one registration to a session/agent

Scoping is **implicit in the context you register from** — there is no `scope:` parameter. The mechanism is
`ScopedLayers.effect(ctx, …)`, and it derives the scope from `ctx`: `ASAR\dsh\node_modules\@deepseek-ai\dsh-scope\lib\index.js`
**L182–218**:

```js
	/**
	* Attach one synchronous layer mutation to its registration context.
	* @param ctx - context that determines both scope visibility and effect ownership.
	* @param action - atomic mutation returning its synchronous undo.
	* @param options - Cordis effect label and optional change notification.
	* @returns the exact disposer returned by `ctx.effect()`.
	*/
	effect(ctx, action, options) {
		const scope = scopeOf(ctx);
		const notify = options.notify ?? true;
		return ctx.effect(function* () {
			let layer;
			let created = false;
			if (scope === void 0) layer = this.global;
			else {
				const existing = this.scoped.get(scope);
				if (existing === void 0) {
					layer = this.createLayer(scope);
					this.scoped.set(scope, layer);
					created = true;
				} else layer = existing;
			}
```

`scopeOf(ctx)` returns `undefined` for a global registration → the `global` layer; otherwise an opaque scope key →
a per-scope layer. Visibility is **downward**: `ASAR\dsh\node_modules\@deepseek-ai\dsh-scope\lib\index.js` **L170–181**:

```js
	/**
	* Materialize global named entries followed by scope-chain shadows,
	* farthest ancestor first, so the nearest scope's entry wins a name.
	* @param scope - viewing scope, or `undefined` for the global view.
	* @param pick - select the named table from a layer.
	* @returns an insertion-ordered effective map.
	*/
	merge(scope, pick) {
		const merged = new Map(pick(this.global).entries());
		for (const layer of this.chainLayers(scope)) for (const [name, value] of pick(layer).entries()) merged.set(name, value);
		return merged;
	}
```

And the nesting relation, `dsh-scope\lib\index.js` **L232–239**:

```js
/**
* The enclosing scope of each key. One relation powers both directions of
* scope nesting: registration views inherit DOWN the chain (a child scope
* sees its ancestors' layers — {@link ScopedLayers}), and event admission
* extends UP it (a listener tagged with an ancestor receives events dispatched
* to a descendant key — {@link scopeTarget}).
*/
```

**Practical rules:**

1. Registering from your plugin's `apply(ctx)` context with no scope → **global**, applies to every agent.
2. Registering from an **agent's scope context** → applies to that agent and its descendants only, and *shadows* a
   same-named global.
3. The named duplicate error tells you which you are in — `prompt section "X" is already registered (for a per-agent
   override, register through that agent's \`agent.ctx\` instead)` vs `… is already registered in this scope`
   (`dsh-system-prompt\lib\index.js:190`). The correct call for a per-agent registration is therefore
   `agent.ctx.systemPrompt.section({...})`.
4. Real child-scope registrations: `dsh-subagent\lib\index.js:512` (`childCtx.systemPrompt.context({...})`) and
   `:517` (`childCtx.systemPrompt.section({...})`); `dsh-subagent-in-process-driver\lib\index.js:80`
   (`childCtx.systemPrompt.section({...})`); `dsh-tool-subagent\lib\index.js:576`
   (`runtimeCtx.systemPrompt.section({...})`); `dsh-experimental-tool-agent-team\lib\index.js:237`
   (`scoped.systemPrompt.section({...})`).
5. Disposal is by the owning fiber: disposing the agent's fiber removes its scope layer
   (`dsh-scope\lib\index.js:211–215`).

---

## Q5 — Durable, session-scoped plugin state

Three mechanisms exist. Only one is the supported home for a plugin-owned JSON blob per session, and one of the three
is a hard **no**.

### 5.1 The session event log — **no, you cannot put plugin state here**

`@deepseek-ai/dsh-session-persistence` is the durable log seam, but it is append-only, format-versioned, and
vocabulary-closed. Its README **L65**:

> An event type unknown to this build refuses unless its envelope marks it `ignorable`, and committed-prefix corruption rejects as `SessionPersistenceCorruptionError`.

and **L151**:

> - **Only handle-acquired sessions persist** — `ctx.sessions.create` + `session/flush` alone stores nothing; agent-loop is the production acquisition point, and tests seed storage through `create`/`append`/`close`.

The authoring rules are explicit. `dsh-agent-preset\skills\cordis-plugin-development\references\practices.md` **L21**
(quoted in the prior report; the rule is corroborated by the persistence README above):

> Do not append session events with a new `type`. Readers accept an unknown stored event only when its envelope carries `ignorable: true`, and live `Session.append()` cannot set that marker, so the Session would refuse to reopen. Derive state from existing events, or keep plugin-owned data in a storage service found through inspection.

**Conclusion: there is no supported API for storing an arbitrary plugin-owned JSON blob in the session log.**
A plugin may *append to an existing* documented event type (todo does: `exec.agent.session.append("todo/write", { todos })`,
`dsh-tool-todo:173`), and the write is durable because the session is. Inventing a type is what breaks reopen.

### 5.2 Session projections — derived per-session state, durable only *through the log*

`ctx.sessionProjections.register(unit)` folds existing session events into a per-session value that also reaches the
client. Real, complete usage — `dsh-tool-todo\lib\index.js` **L80–94**:

```js
	ctx.sessionProjections.register({
		key: "todos",
		stateSchema: todosProjectionSchema,
		init: () => null,
		apply: (state, event) => {
			if (event.type === "todo/write") return event.data.todos;
			if (event.type === "turn/start") return null;
			return state;
		},
		wire: {
			viewSchema: todosProjectionSchema,
			view: (state) => state
		},
		stateVersion: 2
	});
```

This is the right tool for **state derivable from events you already emit**, and wrong for a private blob: it has
`init`/`apply`/`stateSchema`/`stateVersion`/`wire` and no `put`/`set`. `@deepseek-ai/dsh-session-projection` declares
`peerDependencies: {"@deepseek-ai/dsh-session":"0.2.0-rc.2","@deepseek-ai/cordis":"~4.0.4"}`.

### 5.3 The storage domain — **yes, this is the canonical durable path, and `per-record` layout is the per-session form**

`ctx.storageDomain.open(spec)` opens a schema-validated, durable, change-emitting KV domain. The README,
`ASAR\dsh\node_modules\@deepseek-ai\dsh-storage-domain\README.md` **L12** and **L28–58**:

> Use this package to declare schema-validated key-value domains and open them through `ctx.storageDomain` over a configured storage backend. Reads return synchronously from validated in-memory state, while each write becomes durable before it resolves and emits `domain/changed` in order. Product packages use domain handles instead of accessing storage backends directly. **This host-side state does not add tools, prompts, or session events, so it remains invisible to the model and agent loop.**
>
> […]
>
> Use this package when a host package keeps durable, schema-validated records — **workspace records, session sidecar metadata**. The owning package declares the domain once; consumers open it and get synchronous reads and durable, change-emitting writes without ever touching a backend.
>
> ### Declaring a domain
>
> The owning package declares the domain once with `defineDomain` — name, version, and zod record schemas — and exports it. `defineDomain` fails loudly at module load on a bad name, a version that is not a non-negative integer, or a global schema that accepts `null`.
>
> ```text
> // Owning package, once:
> const workspaceSpec = defineDomain({
>   name: 'workspace',
>   version: 1,
>   tables: { workspaces: domainTable(workspaceRecordSchema) },
> })
> ```
>
> ### Opening and using a domain
>
> A consumer opens the declared domain through `ctx.storageDomain` and keeps the returned handle; reads are synchronous, writes are durable:
>
> ```text
> const domain = await ctx.storageDomain.open(workspaceSpec)
> await domain.table('workspaces').put(id, { path: '/work/demo' })
> const record = domain.table('workspaces').get(id) // synchronous, from memory
> domain.table('workspaces').update(id, (r) => ({ ...r, path: newPath }))
> ```
>
> The caller owns the handle's lifecycle and releases it with `domain.close()` when the feature shuts down (typically its own `ctx.effect` disposer); domains still open when the plugin unmounts are closed by the facility.

#### The canonical per-session example, verbatim

`@deepseek-ai/dsh-session-projection-cache` is the official plugin that persists **one JSON document per session**.
`ASAR\dsh\node_modules\@deepseek-ai\dsh-session-projection-cache\lib\index.js` **L66–102**:

```js
/**
* The session-projcache domain spec. The `per-record` layout scopes version
* bumps per session: after a bump, a stale session document is discarded on
* open (cache semantics — a stale or unreadable cache costs a longer tail
* replay, never a wrong value) while the rest of the domain stays usable,
* instead of rejecting the whole medium. […]
*
* `invalidRecords: 'backup-and-skip'`: a stored record that fails the schema
* anyway is disposable derived data, so it must never cost the boot — the
* domain layer moves the document aside as `<key>.json.bak.<stamp>`, logs
* the concrete validation failure, and serves the session as uncached (a
* cold read rebuilds and rewrites it).
*/
const projectionCacheDomainSpec = defineDomain({
	name: "session_projcache",
	version: 7,
	compatibleVersions: [
		3,
		4,
		5,
		6
	],
	invalidRecords: "backup-and-skip",
	layout: "per-record",
	tables: { sessions: domainTable(checkpointRecord) }
});
```

and its service open + teardown, same file **L136–156**:

```js
var SessionProjectionCache = class extends Service {
	config;
	static inject = [
		"storageDomain",
		"sessionProjections",
		"sessions"
	];
	static Config = Config;
	table;
	dirty = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx, "sessionProjectionCache");
		this.config = config;
	}
	/** Open the domain and install the write-behind listeners. */
	async [Service.init]() {
		const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec);
		this.ctx.effect(() => () => domain.close(), "sessionProjectionCache.domainClose");
		this.table = domain.table("sessions");
		this.installWritePath();
	}
```

That is the whole recipe: `static inject = ["storageDomain"]`, `await ctx.storageDomain.open(spec)`, register the close
as an effect, keep the table handle, key records by session id.

#### It is really durable, on disk

`dsh-base\cordis.patch.yml` **L161–176** wires the stack, verbatim:

```yaml
    # Durable KV storage: the storage hub, the json backend, and the
    # schema-validated domain form over them. Session-layer persistence (the
    # projection cache below; workspace in web layers)
    # routes through this stack, so it belongs to the shared base.
    - id: storage
      name: '@deepseek-ai/dsh-storage'

    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')

    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
```

On this machine that resolves to real files — `C:\Users\haoch\.dsh\storages\session_projcache\sessions\` contains
one `.json` per session (35+), plus `C:\Users\haoch\.dsh\storages\workspace.json` for the single-layout `workspace`
domain. Head of a real record (`session-0583f614-…json`, 51889 bytes):

```json
{
  "version": 7,
  "record": {
    "identity": {
      "formatVersion": 4,
      "createdAt": 1790910840732,
      "cwd": "C:\\Users\\haoch",
      "isSeeded": false,
      "inheritedEventCount": 0
    },
    "rows": {
      "title": {
        "ver": 1,
        "seq": 1066,
        "val": "危险星系附近中高威胁RES查询"
      },
```

and `workspace.json`, showing the other layout (`layout: 'single'` → one file per domain with a `global`):

```json
{
  "unit": {
    "name": "workspace",
    "version": 2
  },
  "global": {
    "initialized": true,
    "workspaceIds": [
      "81f9da59-d153-4947-90e3-1cbdee57d20e",
      ...
```

#### The exact call surface

`defineDomain` validation, `dsh-storage-domain\lib\index.js` **L61–76**:

```js
function defineDomain(spec) {
	if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`);
	if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`);
	for (const compat of spec.compatibleVersions ?? []) if (!Number.isInteger(compat) || compat < 0 || compat >= spec.version) throw new Error(`domain '${spec.name}' compatibleVersions entries must be non-negative integers below version ${spec.version}, got ${compat}`);
	if (spec.layout !== void 0) {
		const layout = spec.layout;
		if (layout !== "single" && layout !== "per-record") throw new Error(`domain '${spec.name}' layout must be 'single' or 'per-record', got ${layout}`);
	}
	if (spec.invalidRecords !== void 0) {
		const policy = spec.invalidRecords;
		if (policy !== "backup-and-skip") throw new Error(`domain '${spec.name}' invalidRecords must be 'backup-and-skip' when present, got ${policy}`);
	}
	for (const table of Object.keys(spec.tables)) if (!UNIT_NAME_RE.test(table)) throw new Error(`domain '${spec.name}' table name '${table}' must match ${UNIT_NAME_RE}`);
	if (spec.global !== void 0 && spec.global.schema.safeParse(null).success) throw new Error(`domain '${spec.name}' global schema must not accept null: null is the medium's "never written" sentinel, so a stored null could not round-trip`);
	return spec;
}
```

`UNIT_NAME_RE` is `/^[a-z][a-z0-9_]*$/` (`dsh-storage\lib\index.js` **L80**). Table handle API,
`dsh-storage-domain\lib\index.js` **L241–296**: `get(key)` (sync), `entries()`, `keys()`, `size`, `put(key, value)`,
`delete(key) → Promise<boolean>`, `update(key, fn) → Promise<next>` — `update` on an absent key throws
`DomainError("missing-key", …)` (L280). Global handle, **L177–180** and **L157–173**: `domain.global.get()` /
`domain.global.set(value)`, throwing `domain '<name>' declares no global` when the spec has none.

The facility's `Config` and its two routing fields, **L308–315**:

```js
/** Cordis plugin name. */
const name = "storage-domain";
/** The storage hub must be present before the form can mount. */
const inject = ["storage"];
const Config = z.object({
	backend: z.string().required(),
	routes: z.dict(z.string()).default({})
});
```

Errors carry stable codes (`dsh-storage-domain\README.md` **L73**): `already-open`, `facet-unsupported`,
`invalid-record`, `missing-key`, `closed`, plus pass-through backend codes such as `version-mismatch`.

### 5.4 Answer to "can a plugin persist a blob of JSON per session?"

**Yes — `ctx.storageDomain` with `layout: 'per-record'` and the session id as the table key.** That is exactly what
`session_projcache` does in production: `name: "session_projcache"`, `layout: "per-record"`,
`tables: { sessions: domainTable(checkoutRecord) }`, keyed by session id, landing as
`~/.dsh/storages/<domain>/<table>/<key>.json`.

Caveats to carry into a design:

1. **The domain name is global and single-open.** `defineDomain` name must be unique across the process, and a second
   `open()` of the same name rejects `already-open`. Namespace it (e.g. `superboard_state`, not `state`).
2. **Version mismatch rejects at open** unless you list `compatibleVersions` or declare `invalidRecords:
   'backup-and-skip'`. There is no data migration (README L153).
3. **Single-process change visibility** — `domain/changed` is in-process (README L151).
4. **No cross-table transactions, no secondary indexes, no multi-segment keys** (README L152) — one record per write.
5. **Availability is composition-dependent.** The `storage` / `storage-json` / `storage-domain` rows live in
   `dsh-base`, so every base-backed profile has them — but `PROFILE_TEMPLATES["sdk-minimal"]` is
   `["@deepseek-ai/dsh-sdk-minimal"]` with **no** `dsh-base` (`dsh-app-boot\lib\index.js:534`). Declare
   `inject: ['storageDomain']` and never assume the service is present.
6. `open()` is `async`; do it in a service `[Service.init]()` (as the projection cache does) or in an async
   `apply`, not synchronously at registration time.

---

## Q6 — Minimal working plugin skeleton: `dsh-superboard`

### 6.1 Scaffold provenance — what actually exists

There is **no `create-dsh-plugin`**. A full-text scan of the 15578-entry archive listing for
`scaffold`, `template`, `create-dsh`, `create-` returns exactly one DSH authoring template set:

```
dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\
├── SKILL.md
├── references\{host-plugin,ui-plugin,practices,user-actions,verification,mcp-bundle}.md
└── templates\
    ├── decoration\{package.json,cordis.patch.yml,index.js,client.js}
    └── mcp\{package.json,cordis.patch.yml}
```

(every other `create-*` / `template` hit is a `@babel`, `@smithy`, `@octokit`, `@swc`, `typebox`, or `libreoffice-kit`
internal). The skeleton below therefore follows **this** skill's conventions, extended with the TypeScript/build layer
that `dshmarket` demonstrates.

Verified template contents, verbatim:

```json
// templates\decoration\package.json
{
  "name": "@local/my-decoration",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

```js
// templates\decoration\index.js — the whole host half
/** Host half of the decoration bundle; the Client module owns the rendering. */
export function apply() {}
```

```yaml
# templates\decoration\cordis.patch.yml
- insert:
    - id: my-decoration
      name: '@local/my-decoration'
```

```json
// templates\mcp\package.json
{
  "name": "@local/demo-mcp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

### 6.2 Version ranges, taken from real packages

| Dependency | Official DSH packages declare | Third-party precedent | Use for a plugin |
|---|---|---|---|
| `@deepseek-ai/cordis` | `~4.0.4` (`dsh-tool-todo`, `dsh-tools`, `dsh-system-prompt`, `dsh-experimental-auto-review`, `dsh-package-manifest` — all of them) | `^4.0.1` (`dshmarket\package.json:43`) | `~4.0.4` (matches the installed `4.0.4`) |
| `@deepseek-ai/schemastery` | `~3.18.4` (`dsh-tool-todo\package.json:41`, a `dependencies` entry) | `^3.18.1` peer + dev (`dshmarket\package.json:45`, `:90`) | `~3.18.4` |
| `@deepseek-ai/dsh-tools` | exact `0.2.0-rc.2` (`dsh-tool-todo\package.json:49`) | — | `0.2.0-rc.2` |
| `@deepseek-ai/dsh-system-prompt` | exact `0.2.0-rc.2` (`dsh-tool-todo\package.json:61`, dev) | — | `0.2.0-rc.2` |
| `@deepseek-ai/dsh-session-projection` | exact `0.2.0-rc.2` | — | `0.2.0-rc.2` |
| `@deepseek-ai/dsh-storage-domain` | exact `0.2.0-rc.2` for `dsh-storage` | — | `0.2.0-rc.2` |
| zod (record schemas only) | `^4.4.3` (`dsh-tool-todo\package.json:40`) | — | `^4.4.3` if used |

A third-party host-only plugin's real manifest, for range style —
`PROFILE\node_modules\@openviking\dsh-memory-plugin\package.json`:

```json
  "peerDependencies": {
    "@deepseek-ai/dsh-llm": ">=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1 || ^0.1.7-rc.2",
    "@deepseek-ai/dsh-mcp-client": ">=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1 || ^0.1.7-rc.2",
    "@deepseek-ai/dsh-skill-filesystem": ">=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1 || ^0.1.7-rc.2"
  },
```

Note those ranges **exclude** the installed `0.2.0-rc.2`, yet the plugin is installed and composed — so the
install-time peer gate (Q2.4) evidently did not block it here. Do not copy that style: it documents intent that the
gate cannot read.

### 6.3 `package.json`

```json
{
  "name": "dsh-superboard",
  "version": "0.1.0",
  "private": true,
  "description": "Superboard: a toy host plugin for DSH — one tool plus one prompt context.",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "src",
    "cordis.patch.yml",
    "README.md"
  ],
  "license": "MIT",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.4",
    "@deepseek-ai/dsh-system-prompt": "0.2.0-rc.2",
    "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
    "@deepseek-ai/schemastery": "~3.18.4"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "~4.0.4",
    "@deepseek-ai/dsh-system-prompt": "0.2.0-rc.2",
    "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
    "@deepseek-ai/schemastery": "~3.18.4",
    "@types/node": "^26.2.0",
    "typescript": "^7.0.2"
  }
}
```

Notes, each grounded in an artifact:

- `"type": "module"` + `"main": "lib/index.js"` — same as `dshmarket\package.json:5-6`, `dsh-tool-todo\package.json:13-14`.
- `exports["."]` uses the `types`/`default` pair — the shape **every** official package uses
  (`dsh-tool-todo\package.json:16-20`).
- `dsh.bundle.patch` is the only required `dsh` key for a host-side bundle (Q2.1).
- No `dsh.client` — this is a host-only plugin, so no client half and no `./client` export.
- `private: true` follows the shipped template; drop it only to publish.
- `peerDependencies` are duplicated into `devDependencies` exactly as `dshmarket` does
  (`package.json:42-46` vs `:83-90`) — the peer is supplied by the host at runtime, the dev entry is for local
  typecheck only.

### 6.4 `cordis.patch.yml`

```yaml
# One insert row. The id is what the profile's user patch layer and the Plugins
# page address; `name` must resolve from the profile directory or the dsh
# installation. No `config:` here — omit it and the row's config is `undefined`,
# which is what an all-defaults plugin wants.
- insert:
    - id: superboard
      name: 'dsh-superboard'
```

To give it config, use the form from `templates\mcp\cordis.patch.yml`:

```yaml
- insert:
    - id: superboard
      name: 'dsh-superboard'
      config:
        greeting: 'hello from superboard'
```

Remember Q2.3: a later patch that supplies `config` **replaces it wholesale**. A profile user who wants to change one
field must restate every field.

### 6.5 `src/index.ts`

```ts
/**
 * dsh-superboard host half: one model-facing tool and one prompt context.
 *
 * Shape per the shipped authoring skill
 * (@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md L47-54):
 * `export function apply(ctx, config)` plus optional `inject`, `Config`, `name`.
 * Do not mix these with a default-exported service class.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Runtime plugin name; diagnostics only (cordis RegistryService.plugin, lib/index.js:1625-1632). */
export const name = 'superboard'

/**
 * Hard dependencies. Any service named here that is not yet provided leaves this
 * plugin inactive until it appears (cordis Fiber._refresh, lib/index.js:1317-1324).
 */
export const inject = ['tools', 'systemPrompt']

/** Schemastery config schema. Validated through Config["~standard"] at activation. */
export const Config = z.object({
  greeting: z.string().default('hello from superboard'),
})

/** Inferred config type for the module's own signatures. */
export type Config = z.infer<typeof Config>

export function apply(ctx: Context, config: Config): void {
  // ---- one prompt section: stable text in the system prompt -----------------
  // A section lands in `renderPrompt` (dsh-system-prompt/lib/index.js:113-115);
  // a context would land in the per-step runtime snapshot instead (:132-136).
  ctx.systemPrompt.section({
    name: 'superboard:guidance',
    // Resolve the placement from the registry instead of hard-coding a number.
    order: ctx.systemPrompt.getSectionOrder('TOOL_REPORT'),
    text: `${config.greeting}. Use the superboard_echo tool to echo a message.`,
  })

  // ---- one prompt context: session-aware text, re-rendered each step -------
  // Real template: dsh-sandbox-policy/lib/index.js:121-130.
  ctx.systemPrompt.context({
    name: 'superboard:context',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    text: (context) => {
      const session = (context as { agent?: { session?: unknown } }).agent?.session
      return session === undefined ? '' : 'A superboard session is active.'
    },
  })

  // ---- one toy tool --------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'superboard_echo',
    description: 'Echo a message back. A toy tool that demonstrates the host tool contract.',
    // `parameters` is a bare property map in DSH's author schema spec — no
    // top-level `type: "object"`, and `required` sits on the property itself.
    // dsh-tools/lib/index.js:797-811 compiles it; dsh-tool-todo:98-119 is the model.
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'The message to echo.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          echoed: { type: 'string', required: true },
        },
      },
      // `render` returns the model-visible ContentBlock[].
      render: (_args, value) => [{ type: 'text', text: `Echo: ${value.echoed}` }],
    },
    execute(args) {
      // Throwing reaches the model as a text block "Error: <message>"
      // (dsh-tools/lib/index.js:3616-3630). Never invent an error result shape.
      if (args.message.trim() === '') throw new Error('message must be a non-empty string')
      return { echoed: args.message }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Echo a message',
      kind: 'other',
      rawInput: args.message,
    }),
  }))
}
```

The `order` values chosen here (`TOOL_REPORT` = 2900, `SUBAGENT_DELEGATION` = 120) are real members of
`SECTION_ORDERS` / `CONTEXT_ORDERS` (Q4.3) — reusing an existing slot keeps a third-party plugin in a sane position
without hard-coding an integer.

### 6.6 Build

**The officially supported authoring path needs no build at all.** `host-plugin.md` **L7**:

> A Host-only bundle needs no dependencies, install scripts, or build tool.

The TypeScript layer in 6.5 is a convenience; the shipped scaffold (`templates\decoration\index.js`) is plain ESM
JavaScript and installs directly.

**If you do compile, know what is and is not shipped:**

- DSH's own build tooling is **not reusable**. Its only two `tsdown.config.ts` files are internal to the repo and
  import a preset that is not in the archive. `ASAR\node_modules\@deepseek-ai\dsh-api-gateway\tsdown.config.ts` is
  the entire file:

  ```ts
  import { clientBundle } from '../../client/tsdown.client.ts'

  export default clientBundle('@deepseek-ai/dsh-api-gateway', ['lib/types/index.js'])
  ```

  `../../client/tsdown.client.ts` **does not exist** in the archive. Likewise every shipped `tsconfig.json` extends a
  repo-relative `../../../tsconfig.base.json` (see `dsh-api-gateway\tsconfig.host.json` and `tsconfig.client.json`,
  which use project `references` to `../../boot/cmdline`, `../../../vendor/cordis`, …) — none of which a
  third-party package has.

- `dshmarket`'s published tarball ships **no** `tsdown.config.ts` and **no** `tsconfig*.json`. Its `files` array
  (`package.json:74-82`) lists `locale`, `lib`, `src`, `client`, `UPDATE-API-V1.md`, `cordis.patch.yml`, `LICENSE`
  only, and a recursive listing of `PROFILE\node_modules\dshmarket\` confirms none are present. Its build is
  reproducible only from its own repo (`scripts`: `"build": "tsc -p tsconfig.json && npm run build:client"`,
  `"build:client": "tsdown && node scripts/normalize-client-banner.mjs"`, `package.json:25-26`).

Therefore the following is a **standalone** config, not copied from any artifact — it is offered because the task
requires build instructions, and it is labelled accordingly:

```jsonc
// tsconfig.json — NOT from any DSH artifact; a plain standalone host-half config.
// The shipped tsconfigs extend an unpublished ../../../tsconfig.base.json and use
// project references, so none of them can be reused out of tree.
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": ["src/**/*.ts"]
}
```

```jsonc
// tsdown.config.ts — NOT from any DSH artifact; only needed for a CLIENT half.
// A host-only plugin can ship plain ESM and skip this entirely (host-plugin.md L7).
// The observed output contract it must satisfy is: the package's `main` points at
// the emitted host entry, `./client` at a single browser file registered through
// window.__ModuleLoader__.load({ id: '<package name>', factory(require) {...} }),
// and `dsh.client.platform` is "web" (dsh-client-modules/lib/index.js:714).
export default {
  entry: ['src/index.ts', 'src/client/index.ts'],
  outDir: 'lib',
  format: 'esm',
  dts: true,
  clean: false,
}
```

**Emit-target contract**, if you build: `main` → `lib/index.js`, `types` →
`lib/types/index.d.ts`, and (client half only) a `./client` export resolving to one self-registering
browser bundle. `dshmarket`'s real emitted client begins
`window.__ModuleLoader__.load({ id: "dshmarket", factory: (require) => {...} })` and returns
`{ name, inject, apply }` — and the `id` **must equal the package name** (`dsh-client-modules\README.md` L38:
*"`<id>/client` and the bare id resolve to the same exports, because a plugin bundle is its package's client half"*).

### 6.7 Install and verify

Per `dsh-agent-preset\skills\cordis-plugin-development\SKILL.md` **L8–10**:

> For implementation, use ordinary workspace files to author a bundle, then `plugin_manager` with `action: install_bundle` and the absolute package directory as `target` to install it in the current profile. Changes affect every session in that profile and survive restart.
>
> Do not write the profile's `package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in the profile directory: `install_bundle` performs those steps, and each hand-made write outside the workspace needs its own approval.

So:

1. Author the package in the workspace (e.g. `E:\Dev\dsh-superboard\`).
2. `plugin_manager` → `install_bundle`, `target` = the absolute package directory. Every `plugin_manager` action needs
   `danger-full-access` or approval (`dsh-plugin-manager\README.md:31`).
3. Read `application` and `warnings` from the result, then confirm the row with `cordis_inspect_query`
   (`SKILL.md:25`).
4. `applied` = live via HMR. `restart-required` means *"replacing an installed package requires restart to load a
   fresh JavaScript module generation"* (`host-plugin.md:60`).
5. A `disabled: true` row in `dsh-base` is the standard way a shipped bundle leaves a plugin off; a workspace bundle
   re-enables it with `- id: <row>` + `disabled: false` (`SKILL.md:18`).

---

## Q7 — Type declaration packages

### 7.1 Critical finding: the Desktop asar ships **no** `.d.ts` files at all

A count over the complete 15578-entry archive listing:

```
($l | Select-String -Pattern '\.d\.ts$').Count   →   0
```

Every package still *declares* them. Example, `dsh-tool-todo\package.json:16-20`:

```json
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
```

but the `files` entry `"lib/types/**/*.d.ts"` (`:36`) is not present in the archive — only `lib/types/**/*.js`
(which are `export {};` stubs, e.g. `dsh-tools\lib\types\presentation.js`) survived the packer.

**Consequence for a plugin author:** you cannot get types from the installed application. You must
`npm i -D` the `@deepseek-ai/*` packages from the registry into your own package's `devDependencies`. `@deepseek-ai/*`
is published (`"publishConfig": { "access": "public" }` in every manifest, and `dsh-tool-todo\package.json:5-7`).

### 7.2 The packages, with exact versions and where their types live

All versions are the real installed ones, read from each `package.json`:

| Package | Version | `types` / `exports["."].types` | Declares `peerDependencies` on |
|---|---|---|---|
| `@deepseek-ai/cordis` | **4.0.4** | `lib/types/index.d.ts` | `cordis-plugin-loader ~1.0.5`, `cordis-plugin-include ~1.0.9` |
| `@deepseek-ai/schemastery` | **3.18.4** | `lib/types/index.d.ts` | *(none)* |
| `@deepseek-ai/dsh-tools` | **0.2.0-rc.2** | `lib/types/index.d.ts` | `cordis ~4.0.4`, `dsh-session`, `dsh-agent`, `dsh-llm`, `dsh-system-prompt`, `dsh-invariants`, `dsh-user-approval`, `dsh-ptc-runtime`, `dsh-sandbox-policy`, `dsh-sandbox`, `dsh-scope` — all `0.2.0-rc.2` |
| `@deepseek-ai/dsh-system-prompt` | **0.2.0-rc.2** | `lib/types/index.d.ts` | `cordis ~4.0.4`, `dsh-invariants`, `dsh-scope`, `dsh-llm` (all `0.2.0-rc.2`) |
| `@deepseek-ai/dsh-storage-domain` | **0.2.0-rc.2** | `lib/types/index.d.ts` | `cordis ~4.0.4`, `dsh-storage 0.2.0-rc.2`, `dsh-invariants 0.2.0-rc.2` |
| `@deepseek-ai/dsh-storage` | **0.2.0-rc.2** | `lib/types/index.d.ts` | `cordis ~4.0.4` |
| `@deepseek-ai/dsh-session-projection` | **0.2.0-rc.2** | `lib/types/index.d.ts` | `cordis ~4.0.4`, `dsh-session 0.2.0-rc.2` |
| `@deepseek-ai/dsh-session` | **0.2.0-rc.2** | `lib/types/index.d.ts` | `cordis ~4.0.4`, `dsh-scope 0.2.0-rc.2` |
| `@deepseek-ai/dsh-agent` | **0.2.0-rc.2** | `lib/types/index.d.ts` | `cordis ~4.0.4` + 10 `dsh-*` peers |
| `@deepseek-ai/dsh-package-manifest` | **0.2.0-rc.2** | `lib/types/index.d.ts` | `cordis ~4.0.4` |
| `@deepseek-ai/dsh-scope` | **0.2.0-rc.2** | `lib/types/index.d.ts` | `cordis ~4.0.4`, `dsh-invariants 0.2.0-rc.2` |
| `@deepseek-ai/dsh-invariants` | **0.2.0-rc.2** | `lib/types/index.d.ts` | `cordis ~4.0.4` |

### 7.3 Which are `peerDependencies` vs `devDependencies`

The rule, grounded in three real manifests:

**`peerDependencies` = "the host provides this at runtime."** This is not decoration: the host installs an in-memory
routing table on Node's ESM and CommonJS resolvers
(`dsh-app-boot\lib\index.js:1156-1158`, installed at `:1637`), which is how a profile-installed package resolves a
bare `@deepseek-ai/*` specifier it does not physically depend on. The proof is `dshmarket`:

- `PROFILE\node_modules\dshmarket\package.json:42-46` declares `@deepseek-ai/schemastery` as a **peer** (and
  `:109-115` marks it `optional`), with `:90` repeating it in `devDependencies`;
- its **compiled** `lib/settings.js:70` contains `import z from '@deepseek-ai/schemastery';`
- and it has no `dependencies` entry for it (`:38-41` is only `js-yaml` and `undici`).

So: a runtime `import` of a host-provided package is declared as a **peer**, and repeated in **devDependencies** for
local typechecking.

**`devDependencies` only = "types and tests."** Type-only imports are erased and create no runtime request, so a
package needed solely for types does not need to be a peer. `dsh-tool-todo` demonstrates the split precisely: it
lists `@deepseek-ai/dsh-system-prompt` **only** under `devDependencies` (`:61`) — it never imports it at runtime —
while `@deepseek-ai/dsh-tools` is a **peer** (`:49`) because `lib/index.js:3` really does
`import { defineTool } from "@deepseek-ai/dsh-tools"`.

**Concrete recommendation for `dsh-superboard`:**

| Package | Section | Why |
|---|---|---|
| `@deepseek-ai/cordis` | **peer** + dev | `import type { Context }` is erased, but the plugin's runtime contract *is* cordis; every official package and `dshmarket` peer it |
| `@deepseek-ai/dsh-tools` | **peer** + dev | runtime `import { defineTool }` (`dsh-tool-todo:3`) |
| `@deepseek-ai/dsh-system-prompt` | **peer** + dev | needed if you import its constants; type-only otherwise → dev only |
| `@deepseek-ai/schemastery` | **peer** + dev | runtime `import z` for `Config` |
| `@deepseek-ai/dsh-storage-domain` | **peer** + dev | runtime `import { defineDomain, domainTable }` when persisting (Q5) |
| `zod` | **dependency** | record schemas inside a domain spec are zod, and it is a plain library the host does not provide — `dsh-tool-todo\package.json:40` puts `zod ^4.4.3` in `dependencies` |
| `@deepseek-ai/dsh-session-projection`, `dsh-session`, `dsh-agent` | dev only | needed only if you name their types in your own signatures |

`@deepseek-ai/dsh-package-manifest` is **dev-only** and optional: it is a pure type package (`lib/index.js` is
`export {}`) for `DshPackageManifest`/`DshClientManifest`, and its own README **L28** says *"Use a development
dependency when only checking your own source; use a production dependency if your published declarations reference
these types."*

### 7.4 How `ctx.tools` / `ctx.systemPrompt` get their types — **UNVERIFIED**

The expected mechanism is Cordis module augmentation (`declare module '@deepseek-ai/cordis' { interface Context { … } }`)
inside each service package's `.d.ts`, which would make depending on `@deepseek-ai/dsh-tools` sufficient to type
`ctx.tools`. **I could not verify this**: the augmentation block lives in a `.d.ts` file, and this install contains
none (7.1). A full-text scan of the archive finds no `declare module` augmentation source either.

What *is* verified is that the services are reached as **plain properties** at runtime:
`ctx.tools.register(...)` (`dsh-tool-todo:95`), `ctx.systemPrompt.section(...)` (`dsh-persona:36`),
`ctx.sessionProjections.register(...)` (`dsh-tool-todo:80`), `ctx.storageDomain.open(...)`
(`dsh-session-projection-cache:152`), `ctx.sessionPersistence.*` (`dsh-session-persistence\README.md:39-44`).
The resolution of plain property reads happens in the Cordis context proxy
(`cordis\lib\index.js:1644-1651`: *"A context is a proxy: normal property reads go through the service resolver"*),
and `ctx.get(name)` is the explicitly-typed fallback used by `dshmarket` for optional services.

**Action required before writing typed plugin code:** run `npm i -D @deepseek-ai/cordis@4.0.4
@deepseek-ai/dsh-tools@0.2.0-rc.2 @deepseek-ai/dsh-system-prompt@0.2.0-rc.2 @deepseek-ai/schemastery@3.18.4`
and then read the installed `lib/types/index.d.ts` of `dsh-tools` and `dsh-system-prompt` to confirm the augmentation
and the exact `ToolDefinition` / `PromptSection` / `PromptContext` declarations. Until then, treat every TypeScript
signature in this report as *behaviourally verified at runtime* and *not* type-verified.

---

## UNVERIFIED / open items

1. **`ctx.tools` / `ctx.systemPrompt` type augmentation** — the declaring `.d.ts` is absent from this install (0 of
   15578 entries). Must be confirmed after installing from the registry. §7.4.
2. **`PromptSection` / `PromptContext` / `AssembleContext` / `ToolDefinition` exact TS declarations** — shapes here
   are reconstructed from runtime code (`assemble()`, `defineTool`, the renderers) and real call sites. Behaviourally
   certain; the *declared* types are not quoted from an artifact.
3. **`AssembleContext` members** — only `scope` (`dsh-system-prompt:311`) and `agent` (via
   `dsh-sandbox-policy:126`) are confirmed. `signal` is asserted by the prior session's live inspect but not re-read.
4. **The closed `card` enum for `presentCall`/`presentResult`** — six values observed (`generic`, `read`, `diff`,
   `search`, `terminal`, `web`); no enum declaration reachable, no runtime enforcement.
5. **`ToolExecutionInput` / `ToolRunContext` member list** — `exec.agent` and `exec.signal` confirmed from shipped
   code; the rest comes from the prior session's live `Service.listService` inspect, not from a file read here.
6. **The conventional root `cordis.patch.yml` probe** — dshmarket's comment
   (`src/patch.ts:276-286`) says the loader probes it even without `dsh.bundle.patch`; I did not find the probe in
   `dsh-app-boot`.
7. **DSH's build tooling** — `tsdown.config.ts` presets (`../../client/tsdown.client.ts`) and `tsconfig.base.json`
   are repo-internal and absent. The tsconfig/tsdown in §6.6 are standalone suggestions, explicitly **not** quoted
   from any artifact. `dshmarket`'s own build config is not published in its tarball.
8. **`PLATFORM_MODULES` contents** (client-side baseline module table) — unchanged from the prior report; not
   investigated here as out of scope for host-side authoring.
9. **`dsh.manifestVersion`** — `1` is documented as "the declared format" but I found no reader enforcing or even
   reading it; the README itself says it is not enforced.
10. **`@openviking/dsh-memory-plugin`'s unsatisfied peers** — its ranges exclude `0.2.0-rc.2` yet it is installed and
    composed, and `PROFILE\compatibility.json` does not exist. The gate's behaviour on that install path is
    unexplained by the README, which claims a pre-pnpm rejection.
11. **Second asar root `ASAR\node_modules\@deepseek-ai\`** — 8 build-time packages with no `dsh/` prefix. Its role in
    packaging is not established.
