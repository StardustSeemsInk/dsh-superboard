# DSH 渲染运行时可行性验证

> **先读哪一份。** 本文是**冻结的可行性调研**（2026-10-05）。加载器那一节是 **§A4**——它曾被写成
> 「本文的 §11」，那是把契约的节号误记到了这里，本文没有 §11。它的结论已被
> [`dsh-client-rendering.md`](./dsh-client-rendering.md) 用加载器源码重新推导过：**要引用「mermaid 怎么
> 作为包内 chunk 懒加载」请引那一份**；host 光栅化那一节（§B）同样被那份的 §4 覆盖。
>
> 本文保留别处没有的东西：六条加载路径的对照表、`chunkUrl` 的逐字推导、§B3 的 `ctx.subprocess` 契约、
> §C3 的同步回退方案、以及自己的 UNVERIFIED 清单。所以留着，但**不再更新**——新结论写进
> `dsh-client-rendering.md` 或 [`dsh-plugin-contract.md`](./dsh-plugin-contract.md)。

**验证对象**：DSH (DeepSeek Harness) `0.2.0-rc.2` Desktop
**证据来源**（全部为直接读到的字节）：
- 解包 asar：`C:\Users\haoch\AppData\Local\Temp\dsh-asar\`（15578 条目；下文简写 `<ASAR>`）
- 已安装的第三方插件源码：`C:\Users\haoch\.dsh\profiles\desktop\node_modules\dshmarket\`（**带完整 TypeScript 源码**，是最好的第三方样本）
- 机器生成的 API 目录：`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-tool-cordis\lib\types\api-catalog.js`（8188 行，由 `scripts/gen-cordis-api.ts` 从 AST 生成，`pnpm run verify-cordis-api` 门禁保证不漂移）

**规则**：每条结论附文件路径 + 行号 + 逐字代码。读不到的一律写 `UNVERIFIED`。**没有编造任何 API 名称。**

---

## A. 客户端还能 require 到什么

### A1. 模块表解析：标识符全集与失败行为

#### 解析实现（逐字）

`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-client-modules\lib\client.js:696-715`：

```js
		/** Build the synchronous module-table require and its asynchronous chunk operation. */
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

**未知标识符 → 同步抛 `Error`**（不是返回 `undefined`）。原文措辞：`missed the module table`。这是设计上的「build-time bundle purity gate 的运行时镜像」，见 `lib/client.js:27-28` 的注释：

```js
		* Resolution branch order (import): seed word → shell instance; memoized
		* record → exports; graph row → register its dependency factories and own
		* factory → registered factory → materialize; anything else → throw (loud —
		* the runtime mirror of the build-time bundle purity gate).
```

`stripClientSuffix` 让 `<pkg>/client` 与裸 `<pkg>` 等价，`lib/client.js:98-100`：

```js
		function stripClientSuffix(spec) {
			return spec.endsWith("/client") ? spec.slice(0, -7) : spec;
		}
```

#### 静态种子表（`PLATFORM_MODULES`）——**共 9 个条目，这是全集**

README 只说了「React, Cordis, and static UI libraries」（`<ASAR>\...\dsh-client-modules\README.md:46`）。真实表在 Web 外壳 bundle 里，函数名 `rM()`。

`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-web-frontend\dist\assets\index-5SrrfWpU.js:126`（该文件是压缩后的单行文件，`function rM()` 位于字符偏移 628285，第 126 行）：

```js
function rM(){return{react:Ef,"react/jsx-runtime":If,"react-dom":Rf,"react-dom/client":Df,"@deepseek-ai/cordis":sf,"@deepseek-ai/dsh-client-store":lh,"@deepseek-ai/dsh-client-ui-slots":hh,"@deepseek-ai/dsh-client-ui-primitives":sE,"@deepseek-ai/dsh-client-ui-dockkit":XS}}
```

同一行（字符偏移 630925）把它作为 `staticModules` 传入 `create()`：

```js
this.modules=o.create({boot:n.__DSH_BOOT__,staticModules:rM(),...s?.loadBundle===void 0?{}:{loadBundle:s.loadBundle},...this.seams})
```

**`require(...)` 能解析到的标识符全集 = 以下三类并集：**

**(1) 静态种子表（9 个，永远可用，不需要任何声明）**

| 标识符 |
|---|
| `react` |
| `react/jsx-runtime` |
| `react-dom` |
| `react-dom/client` |
| `@deepseek-ai/cordis` |
| `@deepseek-ai/dsh-client-store` |
| `@deepseek-ai/dsh-client-ui-slots` |
| `@deepseek-ai/dsh-client-ui-primitives` |
| `@deepseek-ai/dsh-client-ui-dockkit` |

**(2) 任何「已注册 factory」的包 id**——即 boot graph 里的行（`client.js:704`）。graph 行来自宿主对已启用 Loader 条目的扫描（`lib/index.js:701-731` `resolveMeta`），条件是包的 `package.json` 里有 `dsh.client.platform === 'web'` **且** `exports["./client"]` 有值。

**(3) 自己包的**包内 chunk**：`<ownerId>/client.<name>.js`**（`client.js:717-742` `importChunk`）。只能通过 `require.async("./client.<name>.js")` 到达，见 A4。

**(4) 已物化的模块**：`loadCache`（`client.js:702-703`）——包含引导模块本身 `@deepseek-ai/dsh-client-modules`。

**不在上面任何一类的标识符 → 抛错。**注意：一个 npm 包的**子路径**（如 `lodash/get`）如果在 graph 里没有对应的包行，同样抛错。

#### 补充：`__ModuleLoader__` 门面的确切形态

`<ASAR>\...\dsh-client-modules\lib\index.js:453-475`（宿主注入到 `<head>` 的内联脚本，逐字）：

```js
	const queue = `(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id===${JSON.stringify(CLIENT_MODULES_ID)})
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${CLIENT_MODULES_ID}/client.js")
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${CLIENT_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed')
    })
    ...
```

`factory(require)` **只拿一个参数**（`require`），见 `client.js:683`：

```js
						exports: registered.factory(this.makeRequire(ownerId, edges)),
```

#### 关键机制：插件 bundle 是**经典 `<script>`**，跑在页面真实全局作用域

`client.js:450-464`：

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

没有 `type="module"`、没有沙箱、没有 `with` 包装。**因此正常安装的插件 client 半拥有完整的浏览器全局**（`fetch` / `setTimeout` / `EventSource` / `WebSocket` / `document` / `ResizeObserver` …）。这一点在 A4 里用第三方插件源码正面证实。

> **重要区分**：`<ASAR>\...\dsh-cordis-client-runner\README.md:32` 说的「browser globals like `fetch` and `setTimeout` are unavailable」**只适用于 `dsh-tool-cordis` 在运行时动态编写并 eval 的插件**（`evaluator.ts` 把源码当 async function body 求值，参数是符号表）。**不适用于 `dsh.client` 声明的普通插件 bundle。**

---

### A2. `react-dom` 与 `react/jsx-runtime` 为何可用

**确切机制：它们就在 A1 的静态种子表里。** 不需要 `dsh.client.external`，不需要 graph 行，不需要宿主做任何事。

`index-5SrrfWpU.js:126` 的 `rM()` 里逐字含 `"react/jsx-runtime":If`、`"react-dom":Rf`、`"react-dom/client":Df`。

**dshmarket 的实证**：`C:\Users\haoch\.dsh\profiles\desktop\node_modules\dshmarket\package.json:47-59` **完全没有 `external` 键**：

```json
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-theme"
      ],
      "platform": "web"
    }
  },
```

而它的构建产物 `<dshmarket>\client\client.js:31-35`（字符偏移 1532/1580）逐字：

```js
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		_deepseek_ai_dsh_client_ui_primitives = __toESM(_deepseek_ai_dsh_client_ui_primitives, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom = require("react-dom");
```

**「无 JSX 转换」的含义澄清**：约束是**不给你 `React.createElement` 之外的语法糖编译器**——但 `react/jsx-runtime` 本身可用，所以 dshmarket 在源码里写 `.tsx`，由它自己的 **tsdown/rolldown 构建期**编译成 `react_jsx_runtime.jsx(...)` 调用（见 `<dshmarket>\src\client\MarketSection.tsx` 374KB + `package.json:102` `"tsdown": "^0.22.14"`）。JSX 是**构建期**问题，不是运行期限制。

---

### A3. `dsh.client.external` 的语义

#### 值形态（逐字，校验器实现）

`<ASAR>\...\dsh-client-modules\lib\client.js:61-75`：

```js
		function parseDshClient(pkgName, value) {
			if (value === void 0) return void 0;
			if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
			const decl = value;
			if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
			const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
			const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
			if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
			return {
				platform: decl.platform,
				...inject !== void 0 ? { inject } : {},
				...external !== void 0 ? { external } : {},
				...decl.immediately !== void 0 ? { immediately: decl.immediately } : {}
			};
		}
```

`optionalStringArray` 保证 `external` **必须是 string 数组**（`client.js:47-51`）。

**所以 `dsh.client` 下只有 4 个合法键**：`platform`（必填，string）、`inject`（string[]）、`external`（string[]）、`immediately`（boolean）。**没有其他键。**

#### `external` 做什么：只加**模块图边**，不改解析结果

`<ASAR>\...\dsh-client-modules\lib\index.js:405-437`（逐字，含 JSDoc）：

```js
/**
* Order composed rows so every requested dynamic package precedes its
* consumers. An `external` specifier is either the package row it names
* (`<pkg>/client` aliases the bare package) or a static-table name that adds no
* graph edge.
* @param entries - composed rows in scan order.
* @returns the same rows reordered; scan order breaks every tie.
* @throws {Error} when a row requests itself or when the module graph has a
* cycle; the message lists the packages on it.
*/
function orderByModuleGraph(entries) {
	const rowsById = /* @__PURE__ */ new Map();
	for (const entry of entries) rowsById.set(entry.id, entry);
	const ordered = [];
	const placed = /* @__PURE__ */ new Set();
	const open = [];
	const visit = (entry) => {
		if (placed.has(entry.id)) return;
		const cycleStart = open.indexOf(entry.id);
		if (cycleStart !== -1) throw new Error(`client-modules: module graph cycle ${[...open.slice(cycleStart), entry.id].join(" -> ")} — a requested package row must precede its consumers, and factory-form CJS cannot deliver partial exports`);
		open.push(entry.id);
		for (const name of entry.external ?? []) {
			const dependency = rowsById.get(name) ?? rowsById.get(stripClientSuffix(name));
			if (dependency === entry) throw new Error(`client-modules: "${entry.id}" requests module "${name}" that it answers itself — a row must not declare its own package in dsh.client.external`);
			if (dependency !== void 0) visit(dependency);
		}
		open.pop();
		placed.add(entry.id);
		ordered.push(entry);
	};
	for (const entry of entries) visit(entry);
	return ordered;
}
```

**运行时效果**（`lib/client.js:644-661` `arriveGraphRow`）：消费者被加载时，对每个 `external` 请求先确保提供方的 factory 已注册：

```js
			async arriveGraphRow(row, open = [], visited = /* @__PURE__ */ new Set()) {
				const cycleStart = open.indexOf(row.id);
				if (cycleStart !== -1) throw new Error(`client-modules: module arrival cycle ${[...open.slice(cycleStart), row.id].join(" -> ")} (the host must reject this graph before serving it)`);
				if (visited.has(row.id)) return;
				visited.add(row.id);
				const next = [...open, row.id];
				for (const request of row.external) {
					const id = stripClientSuffix(request);
					if (this.seed.has(request) || this.loadCache.has(id)) continue;
					const dependency = this.graphRows.get(id);
					if (dependency !== void 0) await this.arriveDependency(row.id, dependency, next, visited);
				}
				for (const packageName of row.inject) {
					const dependency = this.graphRows.get(packageName);
					if (dependency !== void 0) await this.arriveDependency(row.id, dependency, [], visited);
				}
				await this.arrive(row);
			}
```

**三条可证伪的结论：**

1. **命名一个静态表键（如 `"react-dom"`）= 无效操作**（`if (this.seed.has(request) ...) continue;`）。种子词本来就能 require，声明它只增加噪音。
2. **命名一个存在的 graph 行 → 加一条排序 + 预到达边。**这是 `external` 的真正用途：让**非基线**的 Harness Client 包在使用前到位。
3. **命名一个不存在的提供方 → 组合期不报错，运行期抛错。**`orderByModuleGraph` 里 `if (dependency !== void 0) visit(dependency);`——提供方缺失时**静默跳过**，不加边、不抛。要到该模块真正被 `require` 时才炸，抛 A1 里那句 `missed the module table`。**README 说的 "Composition rejects malformed requests, missing suppliers..."**（`README.md:46`）在 `lib/index.js` 的 compose 路径上**我没找到对应校验代码**——就 `external` 项而言这条 README 声明与实现不符。

#### 真实声明样例（逐字）

`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-experimental-client-ui-voice-input\package.json:76-93`：

```json
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-primitives",
        "@deepseek-ai/dsh-api-gateway",
        "@deepseek-ai/dsh-client-ui-plugin-manager"
      ],
      "platform": "web",
      "external": [
        "@deepseek-ai/dsh-api-gateway/client"
      ]
    }
  }
```

注意：`"@deepseek-ai/dsh-api-gateway/client"` 用子路径形式，被 `stripClientSuffix` 归一成包行 `@deepseek-ai/dsh-api-gateway`。

声明了 `external` 的已发布包共 5 个（grep `package.json` 全树）：`dsh-api-job-controller`、`dsh-api-session-controller`、`dsh-api-terminal-controller`、`dsh-api-workspace-controller`、`dsh-experimental-client-ui-voice-input`。

---

### A4. 【最关键】第三方插件能否在运行时把 mermaid 加载进宿主页面？

**答案：能。而且有一条已被官方包自己走通的路径 —— 打包成「包内 chunk」，用 `require.async("./client.<name>.js")` 懒加载。**

#### 决定性先例 1：pdf.js（7 MB）与 SheetJS（7 MB）

`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-client-ui-sidebar-documentpreview\lib\` 目录列出：

```
client.excel.js 7060788
client.js        268957
client.pdf.js   7108786
```

`client.pdf.js` 开头逐字（许可证头 + 注册调用）：

```
//! Bundled PDF.js license notices
...
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
	chunk: "client.pdf.js",
	factory: (require) => {
```

`client.excel.js` 开头逐字：`//! Bundled spreadsheet license notices` / `// Copyright (c) 2022 Suzhou Ruilisi Technology Co., Ltd`（SheetJS）。

**依赖来源**：`<ASAR>\...\dsh-client-ui-sidebar-documentpreview\package.json:47-63` 把它们列为 **devDependencies**（构建期打进去）：

```json
  "devDependencies": {
    "@fortune-sheet/core": "1.0.4",
    "@fortune-sheet/react": "1.0.4",
    ...
    "exceljs": "4.4.0",
    ...
    "pdfjs-dist": "6.3.289",
    ...
    "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz",
```

`package.json:85-90` 确认 chunk 被发布：

```json
  "files": [
    "lib/index.js",
    "lib/client.js",
    "lib/client.*.js",
    "lib/types/**/*.d.ts"
  ],
```

**消费侧（逐字）**，`<ASAR>\...\dsh-client-ui-sidebar-documentpreview\lib\client.js:4883`：

```js
		const LoadedPdfBody = (0, react.lazy)(async () => ({ default: (await require.async("./client.pdf.js")).PdfBody }));
```

`<ASAR>\...\dsh-client-ui-sidebar-documentpreview\lib\client.js:5790`：

```js
		const LoadedExcelBody = (0, react.lazy)(async () => ({ default: (await require.async("./client.excel.js")).ExcelBody }));
```

#### 决定性先例 2：xterm（686 KB）

`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-client-ui-sidebar-terminal\lib\`：`client.js` 19869 字节，`client.terminal.js` 685927 字节。

`<ASAR>\...\dsh-client-ui-sidebar-terminal\lib\client.js:165-167`（逐字）：

```js
		//#region lib/types/client/LazyTerminalBody.js
		/** Load xterm only after a terminal body is mounted. */
		const LoadedTerminalBody = (0, react.lazy)(async () => ({ default: (await require.async("./client.terminal.js")).TerminalBody }));
```

#### chunk 的传输路径（逐字）

1. 文件名白名单，`dsh-client-modules\lib\client.js:470`：
```js
		const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;
```
2. URL 由包自身的单资源 combo URL 推导，`client.js:479-486`：
```js
		/** Resolve a sibling chunk against the package's one-resource URL and current revision. */
		function chunkUrl(row, fileName, rev) {
			const url = atRevision(row.url, rev);
			const resourceStart = url.indexOf("/??");
			const revisionStart = url.indexOf("&rev=", resourceStart + 3);
			if ((resourceStart < 0 || revisionStart < 0 ? void 0 : url.slice(resourceStart + 3, revisionStart)) !== `${row.id}/client.js`) throw new Error(`client-modules: cannot resolve chunk ${JSON.stringify(fileName)} from bundle URL ${url}`);
			return `${url.slice(0, resourceStart)}/${row.id}/${fileName}?${url.slice(revisionStart + 1)}`;
		}
```
   即 `/plugins/<pkg>/client.<name>.js?rev=<rev>`。
3. **仍然走 `<script src>`，不是 fetch**——`importChunk` 调 `this.loadBundle(url)`（`client.js:728`），默认实现是 A1 里的 `defaultLoadBundle`（经典 script 标签）。
4. 服务端只对 `GET` 读文件并缓存，`dsh-client-modules\lib\index.js:74`（README）：「The Host does not scan or preload sibling chunks: an exact `/plugins/<package>/client.<name>.js?rev=<rev>` request reads and caches that script」。

#### `fetch` 到底可用吗？——**可用**

背景约束里「`fetch` 被移除」只属于 `dsh-cordis-client-runner` 那条**动态插件**路径（`<ASAR>\...\dsh-cordis-client-runner\README.md:32`：「It receives a fixed set of names — `React`, `console`, `styles`, and `host` — while browser globals like `fetch` and `setTimeout` are unavailable」）。那是 `dsh-tool-cordis` 让模型在运行时**写并 eval** 一个插件时的沙箱。

**正常安装的插件的 client 半没有这个沙箱。** 第三方实证——`dshmarket` 的 TypeScript 源码里大量直接调用裸 `fetch`：

`C:\Users\haoch\.dsh\profiles\desktop\node_modules\dshmarket\src\client\MarketSection.tsx:2284`：

```ts
    return fetch(api('/dsh-market/registry'), { cache: 'no-store' })
```

`<dshmarket>\src\client\RecoveryPanel.tsx:94`：

```ts
    const response = await fetch(api('/dsh-market/recovery'), { cache: 'no-store' })
```

其构建产物 `<dshmarket>\client\client.js` 字符偏移 116511/116605 处逐字：

```js
					const timer = setTimeout(() => {
						controller.abort();
					}, 6e3);
					try {
						const res = await fetch(candidate.url, { signal: controller.signal });
```

（50+ 处 `fetch(` 调用，覆盖 `MarketSection.tsx`、`SettingsCard.tsx`、`snapshot-panel.tsx`、`preset-panel.tsx`、`self-check.ts`、`Diagnostics.tsx`。）

**`EventSource` 同样可用**，见 D3。

#### 结论：mermaid 的可行路径

| 路径 | 可行性 | 证据 |
|---|---|---|
| **① 随包自带，构建期打进 `lib/client.mermaid.js`，运行期 `await require.async("./client.mermaid.js")`** | **可行，官方先例** | pdf.js 7 MB / SheetJS 7 MB / xterm 686 KB 三个官方包都这么做（上文逐字）。文件名需匹配 `CLIENT_CHUNK`，`package.json.files` 要含 `lib/client.*.js` |
| **② 随包自带，直接打进 `lib/client.js` 主体，同步 `require` 自己包内的相对模块** | 需构建器内联；**推荐用 ①**，因为 README `client.js:68` 明说「entry and chunk outputs cannot synchronously require another relative `client*.js` output」 | `<ASAR>\...\dsh-client-modules\README.md:68`：「This protocol supports self-contained chunks only: entry and chunk outputs cannot synchronously require another relative `client*.js` output.」 |
| **③ `dsh.client.external` 声明 mermaid 为一个包行** | **不可行**（对第三方）。它只加图边，提供方必须是另一个已启用的 DSH 插件包；`external` 不能让 npm 包凭空进入模块表。而且 mermaid 若是自己的依赖，正确做法是 ① | A3 |
| **④ 动态 `import("mermaid")`** | **不可行**。构建产物里的 `import()` 被 tsdown 编译成 `require.async("./client.<name>.js")`（README `client.js:38`：「A source `import()` split by tsdown compiles to `require.async("./client.<name>.js")`」），于是又回到 ①；写成非相对的 `require.async("mermaid")` 会走 `this.import(spec)`，要求 `mermaid` 是 boot graph 行，否则抛错 | `client.js:707-713`、`client.js:743-757` |
| **⑤ `webServer.register` 提供静态 .js 再由 client 用 `<script>` 加载** | **可行但没必要**（等价于自己重造 ①的传输层）。契约见 B1；注意插件包目录不在 SPA dist 里，`dsh-host-frontend-static` 只服务 SPA dist（该包 README 未逐字读，标 UNVERIFIED） | B1 |
| **⑥ `webServer.register` 提供静态资源 + `fetch` 拉文本，再用 `new Function` / `eval` 求值** | 技术上可行（`fetch` 与 `eval` 都在；经典 script 无 CSP 限制记录），但**没有官方先例**，且绕过了 HMR/版本/样式归属机制 | 无先例，**不推荐** |

**因此：mermaid 能否用在客户端 → 能，路径 ①。** 唯一注意事项：
- 文件名必须匹配 `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`（`client.js:470`）→ `client.mermaid.js` ✓
- `package.json.files` 必须包含 `lib/client.*.js`
- 只能用 `require.async("./client.mermaid.js")`（**相对路径 + `./` 前缀**），非相对形式会失败
- chunk 是「自包含」的：它**可以** `require("react")` 等种子词，但**不能**同步 require 另一个相对 `client*.js`

---

## B. 服务端能否渲染图形

### B1. `ctx.webServer.register(route)` 完整契约

#### 类型（逐字，来自机器生成的 API 目录）

`<ASAR>\...\dsh-tool-cordis\lib\types\api-catalog.js:7847-7853`：

```js
    {
        name: 'WebRoute',
        declaration: 'export interface WebRoute {\n    kind: WebRouteKind;\n    path: string;\n    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;\n}',
    },
    {
        name: 'WebRouteKind',
        declaration: 'export type WebRouteKind = \'exact\' | \'prefix\';',
    },
```

`api-catalog.js:7887-7889`：

```js
    {
        name: 'WebUpgradeRoute',
        declaration: 'export interface WebUpgradeRoute {\n    path: string;\n    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;\n}',
    },
```

**注意：`handler` 收的是原生 Node `IncomingMessage` / `ServerResponse`，不是 Web `Request`/`Response`。返回值是 `void | Promise<void>`——你直接写 `res`，不返回 Response。**

#### 服务方法（逐字，来自 api-catalog 的 SERVICE_API 区）

`<ASAR>\...\dsh-tool-cordis\lib\types\api-catalog.js:3422-3444`（`webServer` 服务条目，逐字）：

```js
    {
        key: 'webServer',
        summary: 'The browser HTTP carrier service.',
        description: 'The browser HTTP carrier service. Activation listens immediately. Route registration order does not affect requests because configured named routes must be distinct, and the fallback handler answers anything not yet claimed during startup with 404 until its owner registers. A listen failure rejects initialization, and the boot process reports the failed fiber.',
        methods: [
            {
                signature: 'register(route: WebRoute): () => void',
                description: 'Register a named route. Duplicate (kind, path) throws — route patterns are a composition-level contract, so a collision is a misconfiguration.',
                parameters: [{ name: 'route', description: 'kind, path, and the owning handler.' }],
                returns: 'the disposer removing the route.',
            },
            {
                signature: 'registerUpgrade(route: WebUpgradeRoute): () => void',
                description: 'Register an exact-path HTTP upgrade route. Duplicate paths throw because one socket can have only one protocol owner.',
                parameters: [{ name: 'route', description: 'pathname and handler owning negotiation plus socket use.' }],
                returns: 'the disposer removing the route.',
            },
            {
                signature: 'registerFallback(handler: WebRoute[\'handler\']): () => void',
                description: 'Claim the fallback seat: the handler answering every request no named route matches (the SPA dist server in the shipped Web composition). One owner only — a second registration throws, because two fallbacks cannot compose.',
                parameters: [{ name: 'handler', description: 'owns the full response lifecycle of unmatched requests.' }],
                returns: 'the disposer releasing the seat.',
            },
```

同区域还有 `tapIndex` / `applyIndexTaps` / `collectIndexInjections` / `renderIndex`，逐字 `api-catalog.js:3445-3469`：

```js
            {
                signature: 'tapIndex(transform: (html: string) => string): () => void',
                description: 'Register a raw-HTML index transform, the escape hatch for markup no IndexInjection row expresses: renderIndex applies taps in registration order after rendering the structured rows.',
```

```js
            {
                signature: 'collectIndexInjections(): IndexInjection[]',
                description: 'Gather the structured injection table: one `webserver/index-inject` emit, every subscriber pushes its current rows. Fresh per call, so subscribers read live state (module graph, theme preference) at emit time.',
                parameters: [],
                returns: 'rows in subscriber activation order.',
            },
            {
                signature: 'renderIndex(html: string): string',
                description: 'Render one index.html body: the structured injection table first, then the raw `tapIndex` transforms over the result.',
```

`registerUpgrade` 的实现行：`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-host-webserver\lib\index.js:191`（逐字）`	registerUpgrade(route) {`。

绑定语义（`<ASAR>\...\dsh-host-webserver\README.md:45`，逐字）：

> `register(route)` adds a named `exact` or `prefix` HTTP route, `registerUpgrade(route)` adds an upgrade route for an exact pathname, and both return a disposer that removes the registration. A duplicate path within either table throws — route patterns are a composition-level contract, so a collision is a misconfiguration. HTTP matching is exact over the whole table, then longest prefix, then the fallback handler; upgrades match exactly and unmatched connections are closed.

以及 `README.md:55`：「An HTTP request whose handler throws is answered 400 — or the socket destroyed when headers are already out — and logged as a warning; it never exits the process.」

#### 真实调用样例（dshmarket `src/routes.ts`）

`C:\Users\haoch\.dsh\profiles\desktop\node_modules\dshmarket\src\routes.ts` 里 `webServer.register` 出现约 45 次。第一个样例，`src/routes.ts:1650-1672`（逐字）：

```ts
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/api/v1/capabilities',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        const canRestart = restartAllowed(config)
        sendJson(response, 200, {
          schema: UPDATE_API_V1_SCHEMA,
          apiVersion: 1,
          // Machine-readable, because a policy that lives only in a markdown
          // file is one a client never reads. `beta` says the shape may still
          // change; 
```

异步 handler，`src/routes.ts:1702-1720`（逐字）：

```ts
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/api/v1/updates/summary',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const { channelFor, onlineSourceFor, catalogNpmByRepo } = await updateCheckInputs()
          const updates = await checkUpdates(config.profile, forceCheckFrom(request), activeProfileDir, channelFor, onlineSourceFor, catalogNpmByRepo)
```

`sendJson` 助手，`<dshmarket>\src\http.ts:10`（逐字）：

```ts
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
```

#### 服务如何拿到

`<dshmarket>\src\index.ts:181`（逐字）：

```ts
  ctx.inject(['webServer', 'loader'], (hostCtx: Context) => {
```

`<dshmarket>\src\routes.ts:105`（逐字）：

```ts
  webServer: WebServerService
```

**客户端侧消费者用裸 `fetch` 打这些路由**（A4 已证）。这是第三方插件在 DSH 里做 host↔client 数据通道的**实际做法**。

---

### B2. host 侧产出 SVG / PNG 字节

#### `sharp` 是**真实存在**的宿主依赖

- 目录存在：`C:\Users\haoch\AppData\Local\Temp\dsh-asar\dsh\node_modules\sharp\`（**asar 内**）
- 预编译二进制存在：`<ASAR>\dsh\node_modules\@img\sharp-win32-x64\package.json`
- 版本：`<ASAR>\dsh\node_modules\sharp\package.json:4` → `"version": "0.35.5"`
- 描述（逐字，`sharp\package.json:3`）：`"High performance Node.js image processing, the fastest module to resize JPEG, PNG, WebP, GIF, AVIF and TIFF images"`

**声明它的 DSH 包（两个）**：

- `<ASAR>\dsh\node_modules\@deepseek-ai\dsh-attachment-local\package.json`
- `<ASAR>\dsh\node_modules\@deepseek-ai\dsh-spill-policy\package.json`

`dsh-attachment-local` 的用法（逐字），`<ASAR>\...\dsh-attachment-local\lib\index.js:115-118`：

```js
//#region lib/types/sharp.js
const requireSharp = createLazyRequire("sharp", import.meta.url);
```

`lib\index.js:168-170`：

```js
	const sharp = requireSharp();
		return await imageMetadata(sharp(data, {
```

`lib\index.js:222-226`：

```js
function preparedPipeline(sharp, data, width, height) {
	return sharp(data, {
	...
	}).rotate().toColourspace("srgb").resize({
```

它的 README 明确说 sharp 是版本化的编码器（`<ASAR>\...\dsh-attachment-local\README.md:139`）：

> **Encoder output is versioned** — the installed Sharp/libvips build pins normalization and request bytes

#### sharp 能否吃 SVG？

`<ASAR>\dsh\node_modules\sharp\dist\input.cjs` 的输入参数表里逐字含 `'svg'`：

```js
const inputStreamParameters = [
  // Limits and error handling
  'failOn', 'limitInputPixels', 'limitInputChannels', 'unlimited',
  // Format-generic
  'animated', 'autoOrient', 'density', 'ignoreIcc', 'page', 'pages', 'sequentialRead',
  // Format-specific
  'jp2', 'openSlide', 'pdf', 'raw', 'svg', 'tiff',
  // Deprecated
  'openSlideLevel', 'pdfBackground', 'tiffSubifd'
];
```

**即 sharp 的 API 接受 `svg` 输入选项。** 实际位图化依赖 libvips 是否带 librsvg——我**没有在运行时验证过**这一点，标 `UNVERIFIED`（`input.cjs` 里搜不到 `librsvg` 字面量）。

**但 `ctx.attachments` 本身不接受 SVG**。`<ASAR>\...\dsh-attachment\README.md:32`（逐字）：

> Supported source formats are PNG, JPEG, WebP, and GIF

#### 没有的东西（全部逐字确认缺失）

在三个 npm 根（`<ASAR>\dsh\node_modules`、`C:\Users\haoch\.dsh\profiles\desktop\node_modules`、`C:\Users\haoch\.dsh\profiles\node_modules`）里检查目录存在性：

| 包 | 结果 |
|---|---|
| `sharp` | **存在**（asar + profiles） |
| `@napi-rs/canvas` | 不存在 |
| `canvas` | 不存在 |
| `resvg` / `@resvg/resvg-js` | 不存在 |
| `puppeteer` / `puppeteer-core` | 不存在 |
| `playwright` / `playwright-core` | 不存在 |
| `svg2png` | 不存在 |
| **`mermaid`** | **不存在** |

`mermaid` 在**整个 asar 路径清单**（`C:\Users\haoch\AppData\Local\Temp\asar-list.txt`，1 026 832 字节）里**零命中**（大小写不敏感）。在 `C:\Users\haoch\.dsh\profiles\node_modules` 下按目录名搜 `*mermaid*` 也是零命中。

（`skia` 有 1 处命中，是 `libreoffice-kit-win32-x64\program\share\skia\skia_denylist_vulkan.xml`——LibreOffice 自带的配置文件，与 Node 图像库无关。）

#### `dsh-tool-present` 不产出图像

`<ASAR>\...\dsh-tool-present\lib\index.js` 只注册一个 `present` 工具，把**已存在的文件路径**写进一个 `deliverables/presented` 会话事件（`lib\index.js:116`）。逐字约束（`lib\index.js:92-96`）：

```js
				if (entry !== void 0 && entry.type !== "file") throw new Error(`Cannot present ${file.path}: not a regular file`);
				if (info === void 0) throw new FsError(`Cannot present ${file.path}: file not found. Check the path, create the file if needed, and retry.`, "FS_NOT_FOUND");
```

**它不生成任何字节，也不涉及图像格式。**

#### 结论（B2）

- **host 能产出 PNG 字节**：`sharp` 已在 asar 里、已被官方包依赖，`toFormat('png')` / `.png()` 是 sharp 的公开 API（`sharp\dist\output.cjs` 存在）。**但这是 sharp 的能力，DSH 没有为插件暴露任何「渲染图像」的服务接口——插件需要自己把 sharp 列为依赖并直接 `import('sharp')`。**
- **host 侧的 SVG → PNG 光栅化**：sharp 接受 `svg` 输入选项（逐字）。运行时是否真的能光栅化 = `UNVERIFIED`（取决于 libvips 的 librsvg 构建）。
- **mermaid 渲染服务：不存在。** mermaid 既不在 asar，也不在任何已安装插件的依赖里。**服务端没有任何现成的 mermaid 渲染能力，也没有无头浏览器。**
- `ctx.attachments` 的图片通道只接受 PNG/JPEG/WebP/GIF，**不接受 SVG**。

---

### B3. `ctx.subprocess` 做外部进程渲染

#### 真实签名（逐字，`README.md:43-53`）

`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-subprocess\README.md:43-53`：

```text
const executable = await ctx.subprocess.resolveExecutable('bash')
const handle = ctx.subprocess.spawn({
  argv: [executable, '-c', 'echo hello'],
  cwd: '/workspace',
  stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: 'inherit' },
  graceMs: 5000,
})
const { exitCode, signal } = await handle.done
const output = handle.collected.stdout?.readFrom(0)
```

#### 契约要点（逐字摘录）

`README.md:41`：

> The request is fully explicit: the program and arguments, the working directory, one stdio disposition per stream, a termination grace, an optional abort signal, and optional environment overrides. Target and managed-range identities remain provider-private. `done` resolves with the direct command's exit facts (`exitCode` and `signal`) and rejects for spawn or provider failures; collected output stays readable after exit.

`README.md:57-59`（stdout 三种模式）：

> - `'pipe'` hands you the raw stream for your own protocol framing — JSON-RPC for the LSP host, ndjson for the ACP backend.
> - `'inherit'` lets the child write to the parent's own stream, for pass-through diagnostics.
> - A collect object buffers a bounded in-memory tail; add a `spill` cap and the complete stream is also recoverable from a spill file.

`README.md:61`：

> Reads are offset-based and non-consuming: a background reader and a final batch read can share one stream without stealing each other's bytes.

`README.md:70`：

> Termination and waiting use one provider-managed range. `terminate()` starts the provider's documented procedure, is idempotent, and becomes a no-op after that range is empty; the request's abort signal starts the same procedure. `waitForExit()` observes the same range and resolves only after the provider proves it quiescent...

`README.md:114`：

> `argv` is never shell-interpreted; a consumer that wants a shell passes `['bash', '-c', command]` itself.

`README.md:32`：

> One provider registers `ctx.subprocess` per composition; load it beside the consumers that spawn through it... Loading a second provider fails loudly (one service per context, Cordis standard).

`README.md:80`（环境净化）：

> Children never inherit the harness's ambient secrets: credential-shaped names and ambient `DSH_*` facts are scrubbed, and the caller's explicit `env` merges after that scrub.

**stdout 是 Buffer 还是 string**：`handle.collected.stdout?.readFrom(0)` 返回的是字节读数的形态——`README.md:110` 说「offsets are whole-stream byte coordinates」，所以是**字节**；具体是 `Buffer` 还是 `Uint8Array` = `UNVERIFIED`（我没有读 `types.ts` 的 `SubprocessOutcome` 声明）。

#### `ctx.subprocess` 能否用来渲染图形？

**契约上可以起任意 argv 进程。** 但宿主环境里**没有任何可用的渲染器**：没有 mermaid CLI、没有 `@mermaid-js/mermaid-cli`、没有 Chromium（无 puppeteer/playwright）。唯一存在的重型二进制工具是 `libreoffice-kit-win32-x64`（Office → PDF，`dsh-office-to-pdf`）。**因此用 subprocess 渲染 mermaid 需要自己随包携带 mermaid CLI + 一个无头浏览器，体积与可行性都不可接受。** 标 `UNVERIFIED` 的部分：我没有枚举机器上是否装了全局 `mmdc`/`chrome`。

---

## C. 上下文注入的真实语义

### C1. `ctx.systemPrompt.context()` 完整契约

#### 服务类声明（逐字，机器生成目录）

`<ASAR>\...\dsh-tool-cordis\lib\types\api-catalog.js:7327-7329`：

```js
    {
        name: 'SystemPrompt',
        declaration: 'export class SystemPrompt extends Service {\n    static Config: z<Config>;\n    constructor(ctx: Context, config: Config);\n    section(section: PromptSection): () => void;\n    getSectionOrder(name: PromptSectionOrderName): number;\n    getContextOrder(name: PromptContextOrderName): number;\n    context(context: PromptContext): () => void;\n    suppressRuntimeContext(): () => void;\n    tools(provider: (context: AssembleContext) => ToolProviderResult): () => void;\n    variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void;\n    async assemble(context: AssembleContext = {}): Promise<PromptAssembly>;\n}',
    },
```

#### `PromptContext` 全字段（逐字，**只有 3 个字段**）

`api-catalog.js:5999-6001`：

```js
    {
        name: 'PromptContext',
        declaration: 'export interface PromptContext {\n    readonly name: string;\n    readonly order: number;\n    readonly text: string | ((context: AssembleContext) => string);\n}',
    },
```

对照 `PromptSection`，`api-catalog.js:6011-6013`：

```js
    {
        name: 'PromptSection',
        declaration: 'export interface PromptSection {\n    readonly name: string;\n    readonly order: number;\n    readonly text: string | ((context: AssembleContext) => string);\n    readonly interpolate?: boolean;\n    readonly complete?: boolean;\n}',
    },
```

**差异：`PromptContext` 没有 `interpolate`，也没有 `complete`。**

#### `AssembleContext` 的声明 vs 运行时实际形态

目录里的声明（`api-catalog.js:4511-4513`）：

```js
    {
        name: 'AssembleContext',
        declaration: 'export interface AssembleContext {\n    scope?: ScopeKey;\n    signal?: AbortSignal;\n}',
    },
```

**但这个声明不完整/未合并。** 运行时真实对象由 `assembleContextFor` 构造，`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-agent\lib\types\dispatch.js:85-94`（逐字）：

```js
/**
 * Build the prompt assembly context with agent and scope set together, so
 * agent-scoped prompt and tool contributions cannot be silently omitted.
 * @param agent - the agent the assembly is for.
 * @param signal - the current turn's explicit control signal, when assembly belongs to a turn.
 * @returns the context to pass to `assemble()`.
 */
export function assembleContextFor(agent, signal) {
    return { agent, scope: agent, ...signal === undefined ? {} : { signal } };
}
```

**所以实际字段是 `{ agent, scope, signal? }`——`agent` 在运行时存在。** 真实使用样例（逐字），`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-user-approval\lib\index.js:78-89`：

```js
		const effective = (agent) => this.effectivePolicy(agent.session);
		ctx.inject(["systemPrompt"], (scope) => {
			scope.systemPrompt.context({
				name: "approval:policy",
				order: scope.systemPrompt.getContextOrder("APPROVAL_POLICY"),
				text: (context) => {
					const agent = context.agent;
					if (agent === void 0) return "";
					return effective(agent) === "never" ? NEVER_SENTENCE : ASK_SENTENCE;
				}
			});
		});
```

**能否按 session/agent 区分：能。** 两条路：
1. 在 text 回调里读 `context.agent`（上例逐字）。
2. 通过 `agent.ctx`（agent 作用域上下文）注册——作用域层 shadow 全局层。实现见 `dsh-system-prompt\lib\index.js:317-318` 的 `this.layers.merge(scope, ...)`，以及 `lib\index.js:190-192` 的重复名错误信息逐字：

```js
		this.contexts = new NamedEntries((name) => /* @__PURE__ */ new Error(scope === void 0 ? `prompt context "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)` : `prompt context "${name}" is already registered in this scope`));
```

#### **求值频率：`context()` 每次 `assemble()` 重新求值 —— 逐字证明**

`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-system-prompt\lib\index.js:310-355`（逐字，`assemble` 主体）：

```js
	async assemble(context = {}) {
		const scope = context.scope;
		const scopeLayers = this.layers.chainLayers(scope);
		const runtimeContextSuppressed = !this.layers.global.runtimeContextSuppressors.isEmpty() || scopeLayers.some((layer) => !layer.runtimeContextSuppressors.isEmpty());
		const variables = {};
		for (const [name, provider] of this.layers.global.variables.entries()) variables[name] = provider(context);
		for (const layer of scopeLayers) for (const [name, provider] of layer.variables.entries()) variables[name] = provider(context);
		const sectionByName = this.layers.merge(scope, (layer) => layer.sections);
		const contextByName = this.layers.merge(scope, (layer) => layer.contexts);
		...
			contexts: runtimeContextSuppressed ? [] : [...contextByName.values()].sort((a, b) => a.order - b.order).map((entry) => ({
				name: entry.name,
				text: typeof entry.text === "function" ? entry.text(context) : entry.text
			})),
```

第 350 行 `typeof entry.text === "function" ? entry.text(context) : entry.text` —— **每次 `assemble()` 都调用一次**。没有任何记忆化/缓存。section 的 342 行同样处理：

```js
					text: typeof section.text === "function" ? section.text(context) : section.text,
```

**`assemble()` 多久被调一次：每一步。** `<ASAR>\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js:902-910`（逐字，`preStep`）：

```js
	async preStep(target, position) {
		/* v8 ignore next -- private callers establish the running phase before proposing a step */
		if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": pre-step outside running phase`);
		const signal = this.phase.abort.signal;
		const claimed = this.inbox.claim(target, position.turn);
		const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
		signal.throwIfAborted();
		const sections = renderContextSections(assembly);
		const context = this.runtimeContext.project(joinContextSections(sections), sections);
```

`preStep` 在 `turn()` 的每个 `while(true)` 迭代里被调用（`agent-loop\lib\index.js:951-957`）——**即每一步**。

#### 与 `.section()` 在缓存行为上的差异 —— **核心区别：落到历史里的位置不同**

`<ASAR>\...\dsh-system-prompt\README.md:96`（逐字）：

> Sections and dynamic contexts are separate inputs: sections become prompt text, while contexts become sourced user-role snapshots in model history under the loop.

即：
- **section → system-role 消息**（`createSystemMessage`，`<ASAR>\...\dsh-llm\lib\types\message.js:80-86`，`source: { kind: 'system-prompt' }`）
- **context → user-role 快照消息**（`createUserMessage`）

`RuntimeContextProjection.project`（逐字），`<ASAR>\...\dsh-agent-loop\lib\index.js:328-349`：

```js
	/**
	* Create an uncommitted snapshot only when the retained value differs.
	* @param current - fully rendered dynamic context.
	* @param sections - named contributions that formed the current snapshot.
	* @returns a candidate user message, or `undefined` when no update is needed.
	*/
	project(current, sections) {
		if (this.retained === void 0 && current.length === 0) return;
		const snapshot = current.length === 0 ? CLEARED : current;
		if (this.retained?.text === snapshot) return;
		return createUserMessage({
			content: [{
				type: "text",
				text: snapshot
			}],
			source: sections.length === 0 ? { kind: SOURCE } : {
				kind: SOURCE,
				form: "snapshot",
				sections
			}
		});
	}
```

其中 `const SOURCE = "runtime-context";`（`agent-loop\lib\index.js:218`），
`const CLEARED = "Current runtime context: none. Earlier runtime-context snapshots no longer apply.";`（`agent-loop\lib\index.js:219`），

以及 `joinContextSections` 的帧头（`dsh-system-prompt\lib\index.js:132-136`）：

```js
function joinContextSections(sections) {
	const body = sections.map((section) => section.text).join("\n\n");
	if (body.length === 0) return "";
	return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`;
}
```

**缓存行为总结（逐字可证）**：
- `context()` 每步重算，但**只在渲染结果与上一份保留快照不同时才追加**一条新的 user-role 消息（第 337 行 `if (this.retained?.text === snapshot) return;`）。
- 因为它是**追加**在历史末尾，**它不重写已发出的 system 前缀** → **不破坏前缀缓存**。README `dsh-system-prompt\README.md:151` 逐字：

> when the prepared call declares `systemPromptUpdate: 'in-history'`, the agent loop appends a non-empty changed prompt after the cached history inside a continuing request series, so the prefix through that history stays reusable

- **`section()` 的动态文本会重写 system 节点**（`SystemPromptProjection.project`，`agent-loop\lib\index.js:264-282`），逐字：

```js
	project(rendered, input) {
		const nodes = this.systemNodes();
		const head = nodes[0];
		if (head === void 0) return [{
			message: createSystemMessage(rendered),
			intent: { surfaceOp: "append" }
		}];
		const latest = nodes.findLast((node) => node.text !== "") ?? head;
		if (!input.inHistory || input.startsSeries || rendered.length === 0) {
			const updates = nodes.slice(1).filter((node) => node.text !== "").map((node) => this.replace(node.seq, ""));
			if (head.text !== rendered) updates.push(this.replace(head.seq, rendered));
			return updates;
		}
		if (latest.text === rendered) return [];
		return [{
			message: createSystemMessage(rendered),
			intent: { surfaceOp: "append" }
		}];
	}
```

**结论**：**`context()` 是「每步重新求值、但只在不变化时零成本」的机制，因此是安全的动态注入点；`section()` 里的动态文本则有重写 system 前缀、破坏 KV 缓存的风险。** `systemPromptUpdate: 'in-history'` 是**模型适配器能力**（`dsh-llm-deepseek\lib\index.js:47`：`systemPromptUpdate: "in-history",`），不是插件可用的开关。

---

### C2. `agent.inject({content, source})` 完整契约

#### **重要纠正：不存在 `agent.inject({content, source})` 这种签名**

**运行时实际签名是单参数的 `inject(input)`**，`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js:806-814`（逐字）：

```js
	followup(input) {
		this.send(input, "next-turn", true);
	}
	steer(input) {
		this.send(input, "next-step", true);
	}
	inject(input) {
		this.send(input, "next-step", false);
	}
```

`send`（`agent-loop\lib\index.js:800-805`）：

```js
	send(message, target, wakeup) {
		const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
		const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
		this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
		if (wakeup) this.wakeDriver(wakingAfterAbort);
	}
```

#### 两种等价调用形态（都有真实样例）

**(a) 文档形态**：`handle.agent.inject({ content: [...], source: {...} })`
`<ASAR>\...\dsh-agent\README.md:49-59`（逐字）：

```text
handle.agent.followup({
  content: [{ type: 'text', text: 'Summarize this workspace.' }],
  source: { kind: 'user' },
})
handle.agent.steer({
  content: [{ type: 'text', text: 'Focus on the tests.' }],
  source: { kind: 'plugin', plugin: 'my-plugin' },
})
await handle.agent.whenIdle()
```

**(b) 代码形态**：先 `createUserMessage(...)` 造一个带 id 的冻结消息，再 `inject(msg)`
`<ASAR>\...\dsh-user-approval\lib\index.js:102-108`（逐字）：

```js
		agent.inject(createUserMessage({
			content: [{
				type: "text",
				text: `The approval policy changed from "${previous}" to "${policy}" (changed by the user).`
			}],
			source: { kind: "user-approval" }
		}));
```

**为什么 (b) 更安全**：`ReactLoopInbox.mutate` 用 `message.id` 做去重（逐字，`agent-loop\lib\index.js:189-194`）：

```js
		const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted);
		const ids = /* @__PURE__ */ new Set();
		for (const message of target === "next-turn" ? [...candidate, ...state["next-step"]] : [...state["next-turn"], ...candidate]) {
			if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`);
			ids.add(message.id);
		}
```

没有 `id` 的对象两次注入会变成 `undefined === undefined` → 第二次抛 `message "undefined" is already pending`。**`createUserMessage` 是官方构造器**（`<ASAR>\...\dsh-llm\lib\types\message.js:53-58`）：

```js
export function createUserMessage(input) {
    return createMessage({
        ...input,
        role: 'user',
    });
}
```

`createMessage`（同文件 34-39）：

```js
export function createMessage(input) {
    return deepFreeze(structuredClone({
        ...input,
        id: brandString(randomUUID()),
    }));
}
```

#### `content` 的类型：`ContentBlock[]`（**不是 string**）

`<ASAR>\...\dsh-tool-cordis\lib\types\api-catalog.js:4787-4788`：

```js
        name: 'ContentBlockMap',
        declaration: 'export interface ContentBlockMap {\n    \'text\': TextBlock;\n    \'reasoning\': ReasoningBlock;\n    \'image\': ImageBlock;\n    \'file\': FileBlock;\n    \'tool-call\': ToolCallBlock;\n    \'tool-addition\': ToolAdditionBlock;\n    \'tool-removal\': ToolRemovalBlock;\n}',
```

所以 `content: [{ type: 'text', text: '...' }]`，**不传字符串**。（`TextBlock` 自身的声明我没有逐字读到 → `UNVERIFIED`。）

#### `source.kind` 允许的取值

**声明的映射**（逐字，`api-catalog.js:5727-5733`）：

```js
        name: 'MessageSourceMap',
        declaration: 'export interface MessageSourceMap {\n    user: {\n        kind: \'user\';\n    };\n    model: ModelMessageSource;\n    tool: ToolMessageSource;\n    \'system-prompt\': SystemPromptMessageSource;\n}',
```

**运行时实际观察到的 `kind` 值**（都是从真实代码里逐字读到的）：

| `kind` | 出处（逐字行） |
|---|---|
| `user` | `dsh-agent\README.md:52` |
| `plugin`（带 `plugin` 字段） | `dsh-agent\README.md:56` |
| `user-approval` | `dsh-user-approval\lib\index.js:107` |
| `model-selection`（带 `form: "notice"`, `summary`） | `dsh-agent\lib\index.js:141-145` |
| `runtime-context`（带 `form: "snapshot"`, `sections`） | `dsh-agent-loop\lib\index.js:218`, `343-347` |
| `tool`（带 `callId`） | `dsh-llm\lib\types\message.js:95` |
| `system-prompt` | `dsh-llm\lib\types\message.js:84` |

**结论：`source.kind` 是一个开放式字符串——运行时不校验。** `createMessage` 只有 `structuredClone` + 加 `id`，没有 schema 校验（`dsh-llm\lib\types\message.js:34-39`）。第三方插件可以自造 `{ kind: 'superboard', ... }`。`MessageSourceMap` 是供 TypeScript 声明合并扩展用的（这一点是**推断**，因为 `user-approval` / `runtime-context` 都不在那 4 个键里却出现在 `createUserMessage` 调用中 → 标 `UNVERIFIED`）。

#### 注入后是否立即可见于本步？**不是。**

`inject` → `send(input, "next-step", false)` → 目标是 `"next-step"` 且 **`wakeup === false`**（不唤醒驱动）。README `dsh-agent\README.md:47` 逐字：

> `inject()` adds model-facing context without waking the driver, so it lands in the next admitted step.

它被 `preStep` 的 `this.inbox.claim(target, position.turn)` 在**下一个步边界**取出（`agent-loop\lib\index.js:906`）。

#### session log 里留下什么事件

**两次 append，两个事件类型：**

1. **注入时**（`ReactLoopInbox.mutate`，`agent-loop\lib\index.js:196-206` 逐字）：

```js
		const splice = {
			target,
			start: actualStart,
			...actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount },
			inserted,
			...outcome === void 0 ? {} : { outcome }
		};
		const removed = inbox.slice(actualStart, actualStart + actualDeleteCount);
		const event = this.session.append("agent/inbox/spliced", splice);
```

→ 事件类型 **`agent/inbox/spliced`**。

2. **被 admit 进本步时**（`agent-loop\lib\index.js:1061` 逐字）：

```js
			if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", message, { surfaceOp: "append" });
```

→ 事件类型 **`user/message`**。

---

### C3. **回退路径（重要）：如何同步地为一个带 session id 的请求现算字符串？**

#### 硬约束：`text` 回调**必须是同步的**

`PromptContext.text: string | ((context: AssembleContext) => string)`（`api-catalog.js:6000`）——**返回 `string`，不是 `Promise<string>`**。`assemble()` 虽然是 `async`，但第 350 行是 `entry.text(context)`，**没有 `await`**。

**所以在 `context()` 里不能 `await host.call(...)`，也不能 `await` 任何 Remote 调用。** 题面里问的「官方的 SYNC 或 `@Remote` 机制」——**不存在**。

#### 「`SYNC` 机制」的搜索结果（逐字否证）

全树搜 `\bSYNC\b|@Sync|"sync"|RemoteScope`，只命中 8 处，与「同步取值机制」相关的**只有一类**，而且是 zod 内部代码：

`<ASAR>\...\dsh-api-remotes\lib\client.js`（以及 `dsh-client-ui-sidebar-right\lib\client.js`、`dsh-experimental-client-ui-voice-input\lib\client.js`）里的：

```js
					arg(this, { execution: "sync" });
```

上文上下文逐字（`dsh-api-remotes\lib\client.js`，位于 `//#region .../zod/v4/core/doc.js` 区段）：

```js
	var Doc = class {
		constructor(args = []) {
			this.content = [];
			this.indent = 0;
			if (this) this.args = args;
		}
		indented(fn) {
			this.indent += 1;
			fn(this);
			this.indent -= 1;
		}
		write(arg) {
			if (typeof arg === "function") {
				arg(this, { execution: "sync" });
				arg(this, { execution: "async" });
```

**这是 zod 的文档生成器，与 DSH 插件 API 无关。** 唯一另一处 `RemoteScope` 是 `@RemoteScope` 装饰器（`dsh-typert-protocol\lib\index.js:203-216`），它是给**作用域接收者**用的装饰器，不是同步机制：

```js
/**
* Create a decorator for a method resolved from one Remote Scope.
* @param key - scope key declared through the Context map.
* @param exportName - optional Remote export name; defaults to the method name.
* @returns a standard method decorator that records a versioned prototype descriptor.
*/
function RemoteScope(key, exportName) {
	validateName("Scope key", key);
	if (exportName !== void 0) validateName("Remote export name", exportName);
	return remoteDecorator({
		kind: "context",
		context: key
	}, void 0, exportName);
}
```

**结论：「官方 SYNC 机制」= 不存在。标 `UNVERIFIED` 的否定结论，证据是全树搜索只有 zod 内部命中。**

#### 唯一可行的同步路径：`ctx.sessionProjections` 的**同步读**

这是 DSH 官方为「在请求时刻同步取已缓存状态」提供的机制。逐字，`<ASAR>\...\dsh-tool-cordis\lib\types\api-catalog.js:2115-2126`：

```js
            {
                signature: 'snapshot( session: Session, keys?: readonly Extract<keyof SessionProjectionMap, string>[], ): ProjectionSnapshot',
                description: 'One consistent cut over every registered client-visible unit for one session, read from the watermark cache (missing cells fold lazily over the in-memory log). Fully synchronous — every value and `asOfSeq` reflect the same log position. Each value passes its unit\'s `viewSchema` before leaving.',
                parameters: [{ name: 'session', description: 'the session whose projection values are read.' }, { name: 'keys', description: 'optional client-visible outputs; state materialization remains complete.' }],
                returns: 'the snapshot; `values` is empty when no selected client-visible unit is registered.',
            },
            {
                signature: 'cachedSnapshot( session: Session, keys?: readonly Extract<keyof SessionProjectionMap, string>[], ): ProjectionSnapshot | undefined',
                description: 'Read only already-materialized client-visible cells without folding history. Values may trail the live Session and are therefore hints, not a complete baseline. Missing cells are omitted.',
                parameters: [{ name: 'session', description: 'attached Session whose cached cells are inspected.' }, { name: 'keys', description: 'optional wire keys to view.' }],
                returns: 'the lowest common cached cut, or `undefined` when no wire cell exists.',
            },
```

`api-catalog.js:2109-2114`：

```js
            {
                signature: 'stateOf<K extends keyof SessionProjectionStateMap>( session: Session, key: K, ): SessionProjectionStateMap[K] | undefined',
                description: 'Read one unit\'s current host state after materializing every registered unit at the Session cursor. Unrelated wire views are not produced. The returned value is live; callers must not mutate it.',
```

**关键逐字断言：`Fully synchronous — every value and asOfSeq reflect the same log position.`**

#### 可用的同步回退方案（按推荐度）

| 方案 | 机制 | 是否同步可证 | 证据 |
|---|---|---|---|
| **① `ctx.sessionProjections.snapshot(session, keys?)`** | 注册一个 projection 单元，其 `apply` 维护你要的事实；在 `context()` 里同步读 | **是，官方逐字说 Fully synchronous** | `api-catalog.js:2117` |
| **② `ctx.sessionProjections.stateOf(session, key)`** | 读单个单元的状态 | 是（返回 `T \| undefined`，非 Promise） | `api-catalog.js:2110` |
| **③ `ctx.sessionProjections.cachedSnapshot(session, keys?)`** | 只读已物化单元，不折历史 | 是 | `api-catalog.js:2122` |
| **④ `agent.session` 上的直接同步读** | `agent.session.header.cwd` 之类 | **UNVERIFIED** —— 我在 `dsh-agent\README.md:73` 读到 `({ agent }) => agent?.session.header.cwd` 这个变量 provider 样例（`README.md:73`），说明 `agent.session.header` 可同步读，但 `Session` 的完整同步接口没读 | `dsh-system-prompt\README.md:73` |
| **⑤ 自己在内存里维护一份 Map，用宿主事件同步更新，在 `context()` 里读** | 最简单、无依赖 | 是（纯 JS 对象读） | 无官方文档，但机制上无阻碍 |

**`session id` 从哪来**：`context.agent` → `Agent.id` 即 `SessionId`（`api-catalog.js:4396` 逐字：`export interface Agent {\n    readonly id: SessionId;\n}`）。

#### 不可行的路径（逐字否证）

- **在 `context()` 里 `await` 任何东西** → 类型上就是错的（`text` 返回 `string`），`assemble` 也不 await。
- **用 `@Remote` 在 `context()` 里同步取值** → `@Remote` 走的是 Client→Host RPC 载体（WebSocket `/api/remote.mux`），`ctx.remote.*` 返回 `Promise<RemoteResult<T>>`。见 D1。

---

## D. host 怎么主动把数据推给 client 端

### D1. `@Remote` / `@Remote({mode:'stream'})`

#### 需要哪个包：`@deepseek-ai/dsh-typert-protocol`

`<ASAR>\...\dsh-typert-protocol\README.md:35`（逐字）：

```text
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export class GoalService extends TypertRemoteService {
  @Remote
  async create(agentId: string, objective: string): Promise<GoalResult> {
    ...
  }
}
```

装饰器实现（逐字），`<ASAR>\...\dsh-typert-protocol\lib\index.js:198-202`：

```js
function remoteDecorator(invocation, mode, exportName) {
	return function(_method, context) {
		addMarkerInitializer(context, invocation, mode, exportName);
	};
}
```

#### 装饰器形态（三种，逐字）

1. **裸 `@Remote`** —— 导出名默认取方法名：
```js
    @Remote
    async create(agentId: string, objective: string): Promise<GoalResult> {
```
2. **`@Remote('exportName')`** —— 改导出名（`dsh-api-job-controller\lib\typert.host.js:209` 逐字）：
```js
            "signature": "@Remote('kill') kill(request: JobKillRequest): JobKillValue",
```
3. **`@Remote({ mode: 'stream' })`** —— 流式（`dsh-api-job-controller\lib\typert.host.js:195-202` 逐字）：
```js
            "signature": "@Remote({ mode: 'stream' }) list(request: JobListRequest, signal: AbortSignal): AsyncIterable<JobListFrame>",
            ...
            "signature": "@Remote({ mode: 'stream' }) follow(request: JobFollowRequest, signal: AbortSignal): AsyncIterable<JobFollowFrame>",
```

**唯一的选项键是 `mode`，唯一合法值是 `'stream'`** —— 逐字校验（`<ASAR>\...\dsh-typert-protocol\lib\types\index.js:74`）：

```js
            throw new TypeError('typert-protocol: Remote options must contain exactly mode: "stream"');
```

#### 真实带装饰器的服务方法（逐字，含类上下文）

`<ASAR>\...\dsh-tool-cordis\lib\types\api-catalog.js:7224`（`SubagentRuntime`，一个完整的真实类声明，装饰器逐字可见）：

```js
        declaration: 'export class SubagentRuntime extends TypertRemoteService {\n    static Config;\n    constructor(ctx: Context, private config: Config);\n    resolveMaxDepth(configured?: number | \'provider-managed\'): number | undefined;\n    async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;\n    async sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions): Promise<MessageId>;\n    interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void;\n    async drainContinuableDescendants(parents: readonly Agent[]): Promise<void>;\n    async drainContinuableChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void>;\n    listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]>;\n    listDescendants(rootSessionId: SessionId): Promise<SubagentDescendantListEntry[]>;\n    @Remote(\'prompt\')\n    async prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt>;\n    @Remote(\'interruptByParent\')\n    interruptByParent(childSessionId: SessionId, parentSessionId: SessionId, mode: \'continuable\'): SubagentInterruptReceipt;\n    registerProvider(provider: SubagentProvider): () => void;\n    getProvider(name: string): SubagentProvider | undefined;\n    list(): string[];\n    async start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;\n}',
```

以及逐字的装饰器初始化器（`<ASAR>\...\dsh-api-job-controller\lib\index.js:264-265`）：

```js
			_list_decorators = [Remote({ mode: "stream" })];
			_follow_decorators = [Remote({ mode: "stream" })];
```

`<ASAR>\...\dsh-api-account-controller\lib\index.js:69-70`：

```js
			_watchExpiry_decorators = [Remote({ mode: "stream" })];
			_watch_decorators = [Remote({ mode: "stream" })];
```

#### 客户端怎么调用：**`ctx.remote.<namespace>.<method>(...)`，不是 `host.call`**

`<ASAR>\...\dsh-api-gateway\README.md:12`（逐字）：

> The Host entry provides `ctx.typertGateway`, while `@deepseek-ai/dsh-api-gateway/client` provides `ctx.remote`

`README.md:56`（逐字，返回值形态）：

> Every unary call resolves to `RemoteResult<T>` — `{ ok: true, value }` or `{ ok: false, error }` — and never rejects for a carrier problem

**真实客户端调用样例（逐字）**：

`<ASAR>\...\dsh-client-ui-goal\lib\client.js:585`：

```js
							return await ctx.remote.goals.edit(sessionId, ref, { objective });
```

`<ASAR>\...\dsh-client-ui-plugin-manager\lib\client.js:1049`：

```js
							const result = await this.ctx.remote.pluginManager.setBundleEnabled(packageName, enabled);
```

`<ASAR>\...\dsh-client-ui-plugin-manager\lib\client.js:1236`：

```js
						const [bundles, plugins] = await Promise.all([this.ctx.remote.pluginManager.listBundles(), this.ctx.remote.pluginManager.listPlugins()]);
```

**流式调用的客户端样例**（逐字），`<ASAR>\...\dsh-client-product-analytics\lib\client.js:23`：

```js
					open: (signal) => ctx.remote.productAnalytics.watchPolicy(signal),
```

`README.md:54`（逐字，流句柄）：

> A generated stream method returns a `RemoteStreamHandle<Out, In>` from `dsh-typert-protocol` and opens one logical stream when it is called... The handle iterates the downlink once. `send(item)` queues an uplink item, sent after the `open` frame; `end()` half-closes the uplink; `dispose()` sends `cancel` unless a terminal frame has arrived and ends the iteration quietly.

`host.call` 是**另一套东西**——它只属于 `dsh-cordis-client-runner` 的动态插件沙箱（`<ASAR>\...\dsh-cordis-client-runner\README.md:32`：「Calling `host.call(method, args)` from the loaded half reaches its own host half.」）。**普通插件的 client 半没有 `host.call` 参数。**

#### ⚠️ 对第三方插件的可行性判断

`@Remote` **不能**被第三方插件直接使用，理由逐字：

1. `<ASAR>\...\dsh-api-gateway\README.md:29`：
```text
Strict mode reads generated invocation descriptors from `ctx.typert.local`.
```
   descriptor 由**构建流水线**（Typert generator）产出，第三方插件不在该流水线里。

2. `README.md:85`（逐字限制）：
```text
- Every Client-supplied field requires a strict generated codec when its contribution mounts. SRC markers have no Client type projection and are not normal Client contribution inputs.
```

3. 客户端侧还需要 `ctx.remote.$mount()` 装一个**生成的 `/remote` 贡献**（`dsh-api-remotes\README.md:32` 逐字：「The Client assembly mounts ... contributions」；`dsh-api-gateway\README.md:52`：「`ctx.remote.$mount()` validates and registers a generated Host-for-Client contribution」）。第三方插件没有生成产物。

**第三方插件的实际做法（dshmarket 的 45 个路由 + 裸 `fetch`）= `webServer.register` + `fetch`。** 见 B1 + A4。

---

### D2. `wire.view` 的精确语法 —— **本次已确认**

`wire` 是 `ProjectionDefinition` 的一个可选字段，用于把内部 projection state 投影成 client 可见的 view。

`<ASAR>\...\dsh-tool-cordis\lib\types\api-catalog.js:5988`（逐字，完整声明）：

```js
        declaration: 'export interface ProjectionDefinition<K extends keyof SessionProjectionStateMap, S extends SessionProjectionStateMap[K] = SessionProjectionStateMap[K]> {\n    key: K;\n    stateSchema: ZodType<S>;\n    init(header: SessionHeader, inheritedEventCount: SessionLogOffset): NoInfer<S>;\n    apply(state: NoInfer<S>, event: SessionEvent): NoInfer<S>;\n    wire?: K extends keyof SessionProjectionMap ? {\n        viewSchema: ZodType<SessionProjectionMap[K]>;\n        view(state: NoInfer<S>): SessionProjectionMap[K];\n    } : never;\n    stateVersion: number;\n}',
```

格式化后即：

```ts
export interface ProjectionDefinition<K extends keyof SessionProjectionStateMap, S extends SessionProjectionStateMap[K] = SessionProjectionStateMap[K]> {
    key: K;
    stateSchema: ZodType<S>;
    init(header: SessionHeader, inheritedEventCount: SessionLogOffset): NoInfer<S>;
    apply(state: NoInfer<S>, event: SessionEvent): NoInfer<S>;
    wire?: K extends keyof SessionProjectionMap ? {
        viewSchema: ZodType<SessionProjectionMap[K]>;
        view(state: NoInfer<S>): SessionProjectionMap[K];
    } : never;
    stateVersion: number;
}
```

**两个成员：`viewSchema`（Zod）与 `view(state)`（同步纯函数）。**

**真实使用样例（逐字，4 个）**：

`<ASAR>\...\dsh-goal\lib\index.js:449`：

```js
		viewSchema: goalProjectionSchema,
```

`<ASAR>\...\dsh-agent-loop\lib\index.js:58`：

```js
		viewSchema: inboxProjectionSchema,
```

`<ASAR>\...\dsh-tool-todo\lib\types\index.js:98`：

```js
        wire: { viewSchema: todosProjectionSchema, view: state => state },
```

`<ASAR>\...\dsh-permission-presets\lib\types\index.js:165`：

```js
                wire: { viewSchema: selectionSchema, view: state => ({ currentValue: this.derive(state) }) },
```

`<ASAR>\...\dsh-experimental-agent-team\lib\types\projection.js:325`：

```js
    wire: { viewSchema: teamProjectionSchema, view: teamProjectionView },
```

**注册时的强约束（逐字）**，`api-catalog.js:2092`：

```js
                signature: 'register< K extends keyof SessionProjectionMap, S extends SessionProjectionStateMap[K], >( definition: Omit<ProjectionDefinition<K, S>, \'wire\'> & { wire: NonNullable<ProjectionDefinition<K, S>[\'wire\']> }, ): () => void',
```

即 **client 可见单元必须带 `wire`**（`NonNullable<...>`）。

**读取点的逐字用法**（`<ASAR>\...\dsh-session-projection\lib\types\index.js:271`）：

```js
            values[def.key] = def.wire.viewSchema.parse(def.wire.view(state));
```

**报错（逐字）**，`<ASAR>\...\dsh-session-projection\lib\index.js:432`：

```js
		if (wire === void 0) throw new Error(`session projection ${JSON.stringify(registration.def.key)} has no wire view`);
```

**注意**：`wire.view` **不是**「host→client 推送」机制。它只定义「内部 state → client 可见 view」的投影，供 `snapshot()` / `cachedSnapshot()` / `viewCheckpoint()` 消费。

---

### D3. 其他推送机制 —— **`webServer.register` + SSE 是完整可用的做法**

#### `dsh-client-connection` 的 client 可见事件（题面给的 4 个）—— 这些不是通用推送

`dsh-client-connection` 提供的 `connection/reset`、`locale/change`、`slots/changed`、`theme/change` 我不再逐条复核（题面已确认）。**关键结论：没有通用 server→client push 事件。**

**但存在一条完整的、官方自用的推送通道：SSE。** 参考实现是 `dsh-client-hmr`。

#### Host 侧（逐字，完整可用样例）

`<ASAR>\dsh\node_modules\@deepseek-ai\dsh-client-hmr\lib\index.js:1-26`：

```js
import { statSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
//#region lib/types/events.js
/** System SSE endpoint pushing graph/rebuilt frames (wire protocol constant). */
const EVENTS_ENDPOINT = "/plugins/events";
EVENTS_ENDPOINT.slice(1);
//#endregion
//#region lib/types/index.js
...
/** Cordis plugin name. */
const name = "client-hmr";
/** Required services: the client graph and Web route registry. */
const inject = ["clientModules", "webServer"];
const Config = z.object({ pollIntervalMs: z.number().step(1).min(1).default(500) });
/** Serialize one frame as an SSE data line. */
function sseData(frame) {
	return `data: ${JSON.stringify(frame)}\n\n`;
}
```

`lib\index.js:116-152`（逐字，**这是「host 主动推」的完整骨架**）：

```js
	const connections = /* @__PURE__ */ new Set();
	const publishGraph = () => {
		const line = sseData({
			type: "graph",
			graph: ctx.clientModules.graph()
		});
		for (const res of connections) res.write(line);
	};
	const connect = (res) => {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			"connection": "keep-alive"
		});
		res.write(": connected\n\n");
		connections.add(res);
		res.write(sseData({
			type: "graph",
			graph: ctx.clientModules.graph()
		}));
		res.on("close", () => {
			connections.delete(res);
		});
	};
	ctx.effect(() => {
		const disposeRoute = ctx.webServer.register({
			kind: "exact",
			path: EVENTS_ENDPOINT,
			handler: (req, res) => {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405);
					res.end();
					return;
				}
				connect(res);
			}
		});
		const unsubscribeGraph = ctx.clientModules.onGraphChanged(publishGraph);
		const unsubscribe = ctx.clientModules.onRebuilt((id, rev) => {
			const line = sseData({
				type: "rebuilt",
				id,
				rev
			});
```

#### Client 侧（逐字，完整可用样例）

`<ASAR>\dsh-client-hmr\lib\client.js:41-88`：

```js
		/**
		* Document-relative form of {@link EVENTS_ENDPOINT} used by the browser half.
		* See .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md.
		*/
		const EVENTS_ROUTE = "/plugins/events".slice(1);
		//#endregion
		//#region lib/types/client/index.js
		/** Cordis plugin name. */
		const name = "client-hmr";
		/** Required service: the client module system whose entry controller handles received frames. */
		const inject = ["modules"];
		/**
		* Forward graph snapshots and rebuilds to the page's shared serial controller.
		* @param ctx - Plugin context with the client module system.
		*/
		function apply(ctx) {
			const entries = ctx.modules.entries;
			const handle = (frame) => {
				(frame.type === "graph" ? Promise.resolve().then(() => entries.sync(frame.graph)) : entries.reload(frame.id, frame.rev)).catch((error) => {
					ctx.logger.error(error);
				});
			};
			ctx.effect(() => {
				const source = new EventSource(EVENTS_ROUTE);
				source.addEventListener("message", (event) => {
					let value;
					try {
						value = JSON.parse(event.data);
					} catch {
						ctx.logger.warn(`client-hmr: unparseable event frame: ${event.data}`);
						return;
					}
					const parsed = parsePluginsEventFrame(value);
					if (parsed.kind === "invalid") ctx.logger.warn(`client-hmr: invalid event frame: ${event.data}`);
					else if (parsed.kind === "frame") handle(parsed.frame);
				});
				return () => {
					source.close();
				};
			}, "client-hmr: event source");
		}
```

**注意 `EVENTS_ROUTE = "/plugins/events".slice(1)`** —— 去掉前导 `/` 写成 **document-relative** 形式（`"plugins/events"`）。这是 2026-09-14 的架构决策（注释逐字引用了 Agent Note `web-document-relative-app-routes.md`）。`EventSource("plugins/events")` 会相对当前文档解析。

#### `registerUpgrade` + WebSocket

`<ASAR>\...\dsh-host-webserver\lib\index.js:191` 有 `registerUpgrade(route) {`，`api-catalog.js:3434` 逐字：

```js
                signature: 'registerUpgrade(route: WebUpgradeRoute): () => void',
```

**已使用它的包只有一个**：`dsh-api-gateway`（`<ASAR>\...\dsh-api-gateway\lib\index.js:642` 逐字）：

```js
					yield webCtx.webServer.registerUpgrade(route);
```

同文件 `lib\types\index.js:102` 同样一行。它服务的是 Remote 流多路复用端点 `/api/remote.mux`（`dsh-api-gateway\README.md:35` 逐字：「The Client opens the Gateway-owned `/api/remote.mux` WebSocket when its plugin activates」）。**第三方插件可以调用 `registerUpgrade`（它是公开服务方法），但没有官方第三方先例。**

#### 对本项目的推荐

**host→client 推送的正确做法 = 复制 `dsh-client-hmr` 的模式：**

1. host 半：`ctx.inject(['webServer'], ...)` → `ctx.webServer.register({ kind: 'exact', path: '/dsh-superboard/events', handler })`，handler 里 `res.writeHead(200, {'content-type':'text/event-stream', ...})`，把 `res` 存进一个 `Set`，`res.on('close', ...)` 清理。
2. 数据来源：任何 host 状态变化时，遍历 `Set` 写 `data: ${JSON.stringify(frame)}\n\n`。
3. client 半：`ctx.effect(() => { const es = new EventSource('dsh-superboard/events'); es.addEventListener('message', ...); return () => es.close() }, '...')`。
4. **双向**：client→host 用裸 `fetch('/dsh-superboard/api/...', {method:'POST', ...})`（dshmarket 的做法，45 个路由的规模证明可行）。

**为什么不推荐 `@Remote`/`wire.view`**：`@Remote` 需要 Typert 构建流水线产出的生成产物（D1），第三方插件拿不到；`wire.view` 只做 state→view 投影，不传输（D2）。

---

## 结论摘要（回答题面三个重点）

### 1. mermaid 能否用在客户端？

**能。** 但**不是**通过 `dsh.client.external`、也**不是**通过动态 `import()`。

**唯一可行且官方已验证的路径**：把 mermaid 作为**自己包的 devDependency**，构建期由 tsdown/rolldown 打进一个**包内 chunk** `lib/client.mermaid.js`，运行期用 `require.async("./client.mermaid.js")` 懒加载。

证据是三份逐字先例：`dsh-client-ui-sidebar-documentpreview` 把 **pdf.js 7 MB** 打成 `lib/client.pdf.js`、把 **SheetJS 7 MB** 打成 `lib/client.excel.js`（`lib/client.js:4883` / `:5790` 的 `require.async("./client.pdf.js")` / `require.async("./client.excel.js")`）；`dsh-client-ui-sidebar-terminal:167` 把 **xterm 686 KB** 打成 `lib/client.terminal.js`。它们的 chunk 注册格式是 `window.__ModuleLoader__.load({ id, chunk: "client.pdf.js", factory })`，传输走**经典 `<script src>`**（`dsh-client-modules/lib/client.js:451-464`），由宿主的 `/plugins` 前缀路由服务。

**三条硬约束**（逐字）：chunk 文件名必须匹配 `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`（`client.js:470`）；只能用 `./` 开头的相对形式（非相对形式会走 `this.import(spec)` 并要求它是 boot graph 行，否则抛错）；chunk 必须自包含——不能同步 require 另一个相对 `client*.js`（`dsh-client-modules/README.md:68`）。

**「`fetch` 被移除」不适用于你的插件。** 那条约束只属于 `dsh-cordis-client-runner` 的动态插件沙箱（`README.md:32`）。正常安装的插件 client 半是页面里的经典 script，跑在真实全局作用域：第三方实证是 dshmarket 的 `client.js` 里有 50+ 处裸 `fetch(...)` 调用（`MarketSection.tsx:2284`、`RecoveryPanel.tsx:94`、`SettingsCard.tsx:282` …），构建产物字符偏移 116511 处逐字可见 `setTimeout(() => {...}, 6e3)` 与 `await fetch(candidate.url, { signal })`。`EventSource` 同样可用（`dsh-client-hmr/lib/client.js:64`）。

**如果不能走客户端渲染的替代方案**：服务端**没有** mermaid，也没有无头浏览器（asar 全清单里 `mermaid`/`puppeteer`/`playwright`/`resvg`/`canvas` 全部零命中）。但 **`sharp` 0.35.5 确实在 asar 里**，且已被 `dsh-attachment-local`（`lib/index.js:118` `createLazyRequire("sharp", ...)`）和 `dsh-spill-policy` 依赖；`sharp/dist/input.cjs` 的 `inputStreamParameters` 逐字含 `'svg'`。所以「host 侧把 SVG 光栅化成 PNG」在依赖上可行，**但 `svg` 输入是否真能光栅化取决于 libvips 的 librsvg 构建，我未在运行时验证 = UNVERIFIED**；另外 `ctx.attachments` 的图片通道只收 PNG/JPEG/WebP/GIF（`dsh-attachment/README.md:32`），**不收 SVG**。`ctx.subprocess`（`dsh-subprocess/README.md:43-53`）可以起任意进程，但环境里没有任何渲染器，随包携带 mermaid-cli + Chromium 不现实。

### 2. host→client 推送的确切做法

**没有通用推送事件。** 但 **SSE + `webServer.register` 是官方自用的完整通道**，参考实现是 `dsh-client-hmr`：

- host：`ctx.webServer.register({ kind: 'exact', path: '/plugins/events', handler: (req, res) => {...} })`，`res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' })`，把 `res` 放进 `Set`，`res.on('close', () => set.delete(res))`，广播时 `res.write('data: ' + JSON.stringify(frame) + '\n\n')`（`dsh-client-hmr/lib/index.js:116-152`）。
- client：`const es = new EventSource('plugins/events')`（**document-relative，无前导斜杠**），`es.addEventListener('message', e => JSON.parse(e.data))`，`ctx.effect` 的清理函数里 `es.close()`（`dsh-client-hmr/lib/client.js:64-80`）。
- 反方向：client 用**裸 `fetch`** POST 到自己的 host 路由（dshmarket 的 45 个路由就是模板，`src/routes.ts:1650` 起）。
- `WebRoute` 契约逐字：`{ kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }`（`api-catalog.js:7847-7853`）——**原生 Node 对象，直接写 `res`，不返回 Response**。

**`@Remote({mode:'stream'})` 存在于 DSH**（`api-catalog.js:195-202` 逐字），客户端调 `ctx.remote.<ns>.<m>(...args)` 返回 `RemoteResult<T>` = `{ok:true,value} | {ok:false,error}`，流式返回 `RemoteStreamHandle<Out,In>`。**但第三方插件用不了**：strict 模式要读 `ctx.typert.local` 里由 Typert 构建流水线生成的 `InvocationDescriptor`，客户端还要 `ctx.remote.$mount()` 装一个生成的 `/remote` 贡献——这两样第三方都拿不到。`dshmarket` 就没用 `@Remote`，它用 `webServer.register` + `fetch`。

**`wire.view` 已确认**（此前标 UNVERIFIED）：它是 `ProjectionDefinition` 的可选字段 `wire?: { viewSchema: ZodType<SessionProjectionMap[K]>; view(state): SessionProjectionMap[K] }`，只做内部 state→client view 投影，**不是推送传输**。

### 3. 上下文注入能否同步求值？

**能同步求值，但必须先有同步可读的缓存状态。**

`ctx.systemPrompt.context()` 的 `text` 类型逐字是 `string | ((context: AssembleContext) => string)`——**返回 `string`，不是 Promise**；`assemble()` 里第 350 行是 `entry.text(context)`，**没有 await**。所以 `context()` **不能 await 任何东西**。

**不存在官方的 SYNC 或 `@Remote` 同步机制。** 全树搜 `\bSYNC\b|@Sync|"sync"` 只有 8 处命中，其中与「同步」相关的**全部是 zod 内部的文档生成器** `arg(this, { execution: "sync" })`（位于 `zod/v4/core/doc.js` 区段，见 `dsh-api-remotes/lib/client.js`）。`@RemoteScope` 是作用域接收者装饰器（`dsh-typert-protocol/lib/index.js:209`），不是同步机制。

**求值频率**：`context()` 的 `text(context)` **每次 `assemble()` 都调用一次**（`dsh-system-prompt/lib/index.js:350`），而 `assemble()` 由 `agent-loop` 的 `preStep` 在**每一步**调用（`dsh-agent-loop/lib/index.js:907`，位于 `turn()` 的 `while(true)` 内）。**所以 `context()` 是每步重新求值的——这正是它不破坏前缀缓存的原因。**

**缓存行为差异**（关键）：
- `context()` 的产物是 **user-role 快照消息**，追加在历史末尾，**只在渲染结果与上一份保留值不同时才追加**（`agent-loop/lib/index.js:337` `if (this.retained?.text === snapshot) return;`），帧头是 `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`（`dsh-system-prompt/lib/index.js:135`）。追加不重写 system 前缀 → **不破坏前缀缓存**。
- `section()` 的动态文本会**重写 system 节点**（`SystemPromptProjection.project`，`agent-loop/lib/index.js:264-282`），可能从第一个变化的 token 起失效。所以**动态数据应该走 `context()`，不要走 `section()`。**

**同步拿到「带 session id 的现算值」的唯一官方路径 = `ctx.sessionProjections`：**
- `snapshot(session, keys?)` —— 逐字：`Fully synchronous — every value and asOfSeq reflect the same log position.`（`api-catalog.js:2117`）
- `stateOf(session, key)` —— 同步，返回 `T | undefined`（`api-catalog.js:2110`）
- `cachedSnapshot(session, keys?)` —— 只读已物化单元，不折历史（`api-catalog.js:2122`）

session id 从 `context.agent.id` 拿（`Agent.id: SessionId`，`api-catalog.js:4396`；`agent` 字段由 `assembleContextFor(agent, signal)` 注入，`dsh-agent/lib/types/dispatch.js:92-93`）。**最省事的做法**是自己在内存维护一份 Map，用 host 事件同步更新，在 `context()` 里直接同步读——机制上无阻碍。

**另一个纠正**：`agent.inject` 的真实签名是**单参数** `inject(input)`（`dsh-agent-loop/lib/index.js:812-814` → `send(input, "next-step", false)`），`input` 是 `{ content: ContentBlock[]; source: { kind: string; ... } }` 或 `createUserMessage(...)` 的产物。`content` 是 **`ContentBlock[]`，不是 string**。`source.kind` 运行时不校验（`createMessage` 只做 `structuredClone` + 加 `id`），真实观察到 `user`/`plugin`/`user-approval`/`model-selection`/`runtime-context`/`tool`/`system-prompt` 七种。**注入后不在本步生效**——它落进 inbox 的 `next-step` 队列且**不唤醒驱动**，在**下一个步边界**被 `claim` 取出（`agent-loop/lib/index.js:906`、`:1061`）。session log 里留两个事件：注入时 `agent/inbox/spliced`，被 admit 时 `user/message`。

---

## UNVERIFIED 清单（明确未确认项）

1. `sharp` 的 `svg` 输入在**运行时**能否真的光栅化（依赖 libvips 是否带 librsvg；`input.cjs` 内搜不到 `librsvg` 字面量）。
2. `handle.collected.stdout.readFrom(0)` 的确切返回类型（`Buffer` vs `Uint8Array`）——未读 `dsh-subprocess/lib/types.ts`。
3. `TextBlock` 的完整字段声明。
4. `UserMessage.source` 在 TypeScript 里的确切字段类型（`MessageBase` 未在 api-catalog 里作为独立条目出现；运行时是开放式）。
5. `MessageSourceMap` 是否通过声明合并扩展（推断，非逐字）。
6. 本机是否装有全局 `mmdc` / `chrome`（未枚举 PATH，仅确认 asar 与两个 npm 根内不存在）。
7. `dsh-host-frontend-static` 是否提供通用静态文件服务方法（未读该包 README）。
8. README 声称的组合期会拒绝「missing suppliers」——**在 `dsh-client-modules/lib/index.js` 的 compose 路径上我未找到对应代码**；`orderByModuleGraph` 对缺失提供方静默跳过。此声明与实现不符（这是一个**已读到的负面发现**，不是 UNVERIFIED）。
