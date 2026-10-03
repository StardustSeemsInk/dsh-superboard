# DSH 官方对话渲染能否被第三方插件复用（可行性调研）

- **调研对象**：DSH 0.2.0-rc.2 Desktop（`C:\Users\haoch\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`）
- **证据来源**（两处内容一致，行号已验证相同）：
  - 解包树：`C:\Users\haoch\AppData\Local\Temp\dsh-asar\dsh\node_modules\@deepseek-ai\<pkg>\`
  - 副本：`E:\Dev\dsh-superboard\.ref\dsh-official\<pkg>\lib\client.js`
- **路径清单**：`C:\Users\haoch\AppData\Local\Temp\asar-list.txt`
- 本文所有结论均附 **文件路径 + 行号 + 逐字代码**。凡未能读到证据的，显式标注 **UNVERIFIED**。
- 行号基准：`.ref\dsh-official\dsh-client-ui-chat\lib\client.js` = 12516 行 / 563047 字节；asar 解包同一文件同为 12516 行。其余未列入 `.ref` 的包一律引用 asar 解包树路径。

---

## 结论速览

| 问题 | 结论 |
|---|---|
| 1. 能否 `require("@deepseek-ai/dsh-client-ui-chat")` 拿到 `ChatView`？ | **能 require 到模块，但拿不到任何组件。** 该模块只导出 5 个符号，全是 `inject`/`apply`/类型守卫常量和空快照，**没有 `ChatView`，没有任何 React 组件，没有任何 markdown 渲染器**。 |
| 2. 有没有第三方可用的路径复用官方 markdown 渲染？ | **有一条技术上可行但被官方规范明文禁止的路**（`require("@deepseek-ai/dsh-client-ui-primitives")` → `MarkdownText`，它是 9 个平台种子模块之一，模块解析必然命中）。**官方从未有第三方这么干**：`.ref\dsh-official\` 下 32 处跨包 `require` 全部只指向 5 个平台种子模块，零个业务插件 client 半被跨包 require。官方给的答案是把 markup/CSS/行为**抄进自己的插件**。 |
| 3. 第三方能否驱动会话历史分页？ | **能。** `ChatView` 的 `loadOlder`/`loadThrough` props 只是 `ctx.sessions.binding(sessionId).session.loadOlder()` 的转发，而 `sessions` 是第三方可用服务之一。`loadOlder()` 实体定义在 `dsh-api-session-controller/lib/client.js:1867`。 |
| 4. 最省力的可行方案？ | **不要复用，也不要整体抄。** 官方自己在 `dsh-client-ui-trajectory` 里对同一个需求（新增一个会话历史阅读标签）选择的是**自建 view + 自建 event definitions + 自建 snapshot builder**（8778 行），只复用平台种子 primitives。推荐路径：**窄接口自写只读阅读栏 + 驱动 `session.loadOlder()` 分页 + 用自写/轻量 markdown**；若必须逐像素一致，再从 chat 的 `lib/client.js` 逐字提取 CSS（可行，见 §B5）。 |

---

## A. `dsh-client-ui-chat` 的 client 半能否被第三方 require？它导出了什么？

### A1. 导出清单（逐字）

`E:\Dev\dsh-superboard\.ref\dsh-official\dsh-client-ui-chat\lib\client.js:12507-12512`：

```js
exports.EMPTY_CHAT_SNAPSHOT = EMPTY_CHAT_SNAPSHOT;
exports.apply = apply;
exports.inject = inject;
exports.isRunningTool = isRunningTool;
exports.isSettledTool = isSettledTool;
return module.exports;
```

**恰好 5 项。** 没有 `ChatView`、没有任何组件、没有 markdown 渲染器、没有 `ChatSnapshotBuilder`、没有 `EMPTY_CHAT_SNAPSHOT` 之外的任何快照工具。

对照：`ChatView` 定义在同文件 `5130` 行，`AssistantMarkdown` 在 `5896`，`ChatNodeSeat` 在 `1668` —— 全部是 factory 闭包内的局部 `const`，**没有被挂到 `exports` 上**。

### A2. 注册 id = 包名

`E:\Dev\dsh-superboard\.ref\dsh-official\dsh-client-ui-chat\lib\client.js:1-6`：

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-chat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
```

→ 注册 id **就是包名**。按 `dsh-client-modules/lib/client.js:696-705` 的解析顺序（平台种子表 → 已物化记录 → boot 图中的行 → 已注册的工厂），`require("@deepseek-ai/dsh-client-ui-chat")` **能命中**这个已注册工厂，并拿到上面那 5 项。**但命中不等于有用。**

### A3. `package.json` 的 `dsh.client` 块

从 asar 抽取的 chat `package.json`（另存于 `E:\Dev\dsh-superboard\.ref\_asar_tmp\chat-package.json`）：

```json
{
  "name": "@deepseek-ai/dsh-client-ui-chat",
  "version": "0.2.0-rc.2",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-api-workspace-controller",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-input-trigger",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-ui-workspace"
      ]
    }
  }
}
```

`dsh.client` 块**只有 `platform` 与 `inject` 两个键**：没有 `external`，没有 `immediately`。`exports` 有子路径（`"."` / `"./client"` / `"./src/*"` / `"./package.json"`），但那是 Node 包解析语义，**与 `window.__ModuleLoader__` 的运行期解析无关**（后者按 id 精确匹配）。

### A4. 结论（关键）

> **如果它只导出 `{inject, apply}`，那第三方就拿不到 `ChatView`。**
> 事实比这更弱：它导出的是 5 个符号，`ChatView` 不在其中。
> **结论：第三方无法通过 `require` 拿到官方对话渲染组件。** 这条路关闭。

---

## B. 官方 markdown 渲染在哪、用什么、能否单独取用？

### B1. markdown 组件名与位置

| 项 | 位置 | 逐字 |
|---|---|---|
| 真正的 markdown 组件 | 平台种子包 `@deepseek-ai/dsh-client-ui-primitives` | `MarkdownText` |
| chat 中的引用 | `dsh-client-ui-chat/lib/client.js:33` | `let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");` |
| chat 中的调用点 | `dsh-client-ui-chat/lib/client.js:312`、`5820`、`5911` | `(0, _deepseek_ai_dsh_client_ui_primitives.MarkdownText)(...)` |
| 委托容器 | `dsh-client-ui-chat/lib/client.js:5280` | `MarkdownDelegateProvider` |
| chat 自带的 `AssistantMarkdown` | `dsh-client-ui-chat/lib/client.js:5896` | `const AssistantMarkdown = (0, react.memo)(function AssistantMarkdown({ blocks, streaming, interrupted, renderMessageImages, groupPart, useDisclosure, reasoningHidden = false, usePresentation, revealProcess, mentions, t }) {` —— **未导出** |
| markdown 词典适配 | `dsh-client-ui-chat/lib/client.js:198` | `markdownLabels(t)`，返回 `{ footnotes: t("markdown.footnotes"), ... }` |

### B2. 是否存在于独立的官方 markdown 渲染包？——**不存在**

`C:\Users\haoch\AppData\Local\Temp\asar-list.txt` 里 grep `markdown` 只命中 4 条：

```
\dsh\node_modules\@deepseek-ai\dsh-client-ui-primitives\lib\markdown\CodeBlock.module.css
\dsh\node_modules\@deepseek-ai\dsh-client-ui-primitives\lib\markdown\JsonBlock.module.css
\dsh\node_modules\@deepseek-ai\dsh-client-ui-primitives\lib\markdown\MarkdownText.module.css
\dsh\node_modules\@deepseek-ai\dsh-web-frontend\dist\assets\langs\markdown-Cvjx9yec.js
```

`C:\Users\haoch\AppData\Local\Temp\dsh-asar\dsh\node_modules\@deepseek-ai\` 下的 200+ 个包中**没有任何 `dsh-client-ui-markdown`**。markdown 的唯一实现位置是 `dsh-client-ui-primitives`。

`dsh-client-ui-primitives` 的本来面目：

- 是 **ESM 包，不是 `lib/client.js` factory 包**：`"type": "module"`、`"main": "lib/index.js"`、`lib/index.js` 530719 字节。
- ESM 出口在 `dsh-client-ui-primitives/lib/index.js:12381`，单行 `export { ... }`，逐字包含 **`MarkdownDelegateProvider`、`MarkdownText`、`extractMarkdownPlainText`**（同表还有 `BrandWordmark, Button, CODE_HIGHLIGHT_EXTENSIONS, Checkbox, CodeBlock, ConnectionIndicator, DiffBlock, DisclosureRow, FishLogo, HoverCard, JsonBlock` 等）。
- 依赖栈（`dsh-client-ui-primitives/package.json:32-49` devDependencies）：`micromark-core-commonmark` ^2.0.3、`mdast-util-from-markdown` ^2.0.3、`mdast-util-gfm` ^3.1.0、`micromark-extension-gfm` ^3.0.0、`micromark-extension-math` ^3.1.0、`mdast-util-math` ^3.0.0、`katex` ^0.16.47、`shiki` ^4.3.1、`@shikijs/langs` ^4.3.1、`anser` ^2.3.5、`diff` ^9.0.0、`simple-icons` 16.31.0。
- `dsh-client-ui-primitives/lib/index.js:1-30` 是 ESM import（`react/jsx-runtime`, `clsx`, `react`, `react-dom`, `simple-icons`, `@deepseek-ai/dsh-util-workspace-path`, 以及各 `*.module.css`）——即这些依赖在构建时被**打进了 web frontend 的种子表**，`lib/index.js` 本身不 `require` 它们。

### B3. 有没有通过平台种子表暴露？——**有，`primitives` 本身就是种子模块**

平台种子表 `PLATFORM_MODULES` 是**冻结的 9 项**（`dsh-web-frontend/dist/assets/index-5SrrfWpU.js` 的 `rM()`）：

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis, @deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

**`@deepseek-ai/dsh-client-ui-primitives` 在其中 ⇒ `require("@deepseek-ai/dsh-client-ui-primitives")` 必然解析成功**，且 `MarkdownText` 确实在它的导出表里。

**但是，官方规范明文禁止第三方这么做。** `E:\Dev\dsh-superboard\.ref\dsh-official\cordis-plugin-development\references\practices.md:35` 逐字：

> Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module; `dsh.client.inject` entries only order activation and stay allowed. They change without notice, a plain-JS plugin has no type check, and a throwing component blanks your slot entry (console: `slot entry crashed in '<slot>'`). Write your own controls and match the host instead: copy markup, CSS, and behavior from the primitive into the plugin (`src/*.tsx` and `*.module.css` in a DSH source checkout, or the installed package's `lib/index.js` and `lib/**/*.css`), or inspect the rendered host control in the connected page. Rename copied classes under your plugin's prefix, keep only `--dsw-alias-*` token references, and keep the behavior that users rely on, such as Modal focus and Escape handling, `role="switch"` with `aria-checked`, and Tooltip placement. Tokens then remain the only shared styling dependency.

要点：**禁止** require primitives 或任何其它 Harness Client 包；理由是它们随时会变、纯 JS 插件没有类型检查、**抛错的组件会清空整个 slot 条目**（`slot entry crashed in '<slot>'`）。官方**推荐**的做法是把 markup + CSS + 行为抄进自己的插件，只保留 `--dsw-alias-*` token 作为共享样式依赖。

### B4. 【重要】跨包 require 官方 client 半的实践先例 —— **零**

对 `E:\Dev\dsh-superboard\.ref\dsh-official\**\*.js` grep `require("@deepseek-ai/`，共 **32 处**命中，**全部只指向那 5 个平台种子模块**：

| 被 require 的模块 | 命中位置 |
|---|---|
| `@deepseek-ai/cordis` | `dsh-client-ui-session/lib/client.js:7`、`dsh-client-ui-conversation/lib/client.js:32`、`dsh-client-ui-renderer/lib/client.js:15`、`dsh-client-ui-sidebar-files/lib/client.js:8` |
| `@deepseek-ai/dsh-client-store` | 多个包 |
| `@deepseek-ai/dsh-client-ui-slots` | `session:9`、`sidebar:8`、`conversation:31`、`renderer:14` |
| `@deepseek-ai/dsh-client-ui-primitives` | `sidebar:10`、`sidebar-documentpreview:9`、`sidebar-browser:9`、`sidebar-right:30`、`sidebar-terminal:7`、`sidebar-files:7`、`subagent:10`、`theme:8`、`message-feedback:9`、`conversation:29`、`chat:33`、`experimental-client-ui-agent-team:10` |
| `@deepseek-ai/dsh-client-ui-dockkit` | `sidebar-right:33` |

**结论：零个包 require 另一个业务插件的 client 半。** 唯一被实践过的跨包 require 就是平台种子模块。「复用别的包的 client 半」**不是一条被实践过的路**。

补充：`dsh-client-ui-trajectory/lib/client.js:34` 也 require 了 primitives，并在 4697 / 5171 / 6309 使用 `MarkdownText`、4504/4531/4904 使用 `JsonTree`、5344 使用 `CodeBlock`、3771 使用 `extractMarkdownPlainText`。**但 trajectory 是仓库内官方包，不是第三方插件，不受 practices.md:35 约束。**

### B5. 【补充发现】CSS 可以逐字提取 —— 官方推荐的「抄」路线确实可执行

`dsh-client-ui-chat/lib/client.js` 内含 **18 个 `//#region \0dsh-css:` 区段、17 个 `const css$N = "..."` 常量**。每个区段后跟如下注入代码（以 ChatView 的 `css$13` 为例，源标记逐字为 `#region \0dsh-css:D:\develop\dsh-harness-windows-x64\packages\client\ui-chat\src\client\chat\ChatView.module.css.mjs`）：

```js
const tagId$13 = <id>;
if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$13) + "]") === null) {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-chat";
    tag.dataset.pluginCss = tagId$13;
    tag.textContent = css$13;
    document.head.appendChild(tag);
}
```

类名是哈希化的 CSS-module 名，逐字示例（`ChatView_module_css_default`，起始行 1632）：

```js
{ "callRow": "xz4KEq_callRow", "column": "xz4KEq_column", "flowItem": "xz4KEq_flowItem",
  "frame": "xz4KEq_frame", "hint": "xz4KEq_hint", "modalAction": "xz4KEq_modalAction",
  "older": "xz4KEq_older", "openError": "xz4KEq_openError", "root": "xz4KEq_root",
  "running": "xz4KEq_running", "runningContent": "xz4KEq_runningContent",
  "runningDivider": "xz4KEq_runningDivider", ... }
```

`AssistantMarkdown_module_css_default`（起始行 5868）= `{ "actions": "v5IAXa_actions", "body": "v5IAXa_body", "root": "v5IAXa_root", "stopped": "v5IAXa_stopped" }`。

17 个 CSS-module 对象起始行：223 MessageItem、330 ContextBody、887 ContextInjectionRow、1102 MessageIconActions、1632 ChatView、2169 ChatGroupSeat、3575 TurnNavigator、3896 accessibility、5753 ReasoningRow、5868 AssistantMarkdown、6026 GenericCommandCard、6216 TurnProcessNodeView、6411 TurnUsagePanel、6427 stat_dialog、6552 TurnTailNodeView、6685 TurnTriggerNodeView、6902 StatsPills、11958 PreferenceRow。

**关键佐证：asar 里 chat 包只有 6 个文件，没有 .css**（`asar-list.txt:2289-2297`：目录、LICENSE、README.i18n.yaml、README.md、README.zh.md、`lib\client.js`、`lib\index.js`、`package.json`）。且 `dsh-web-frontend/dist/assets/index-BPHePDI_.css`（76338 字节）与 `index-5SrrfWpU.js`（633245 字节）都**不含** `xz4KEq`。

→ **CSS 的唯一来源就是各包自己的 `lib/client.js`，且可被逐字提取。** 该性质是构建管线的通用行为，非 chat 独有：`dsh-client-ui-trajectory/lib/client.js` 有 4 个 `dsh-css` 区段、`dsh-client-ui-tool/lib/client.js` 有 6 个。

---

## C. 会话分页：第三方能不能驱动 `loadOlder`？

### C1. `ChatView` 完整 props 列表（逐字）

`E:\Dev\dsh-superboard\.ref\dsh-official\dsh-client-ui-chat\lib\client.js:5130`：

```js
function ChatView({ useSession, useChat, useChatNode, useChatNodeProcess, useChatGroup, useConversation, useSessions, useStore, actions, renderSlot, sessionId, openFile, openSkill, openExternalLink, loadOlder, loadThrough, loadImage, inspectCall, chatScroll, forkAt, fileMentions, usePresentation, useProjection, t }) {
```

逐项核对：

| 名字 | 是否 props | 证据 |
|---|---|---|
| `loadOlder` | **是** | 5130 |
| `loadThrough` | **是** | 5130 |
| `hasMore` | **不是** | 来自 `useSession`，`5158-5162`：`const hasMore = useSession((s) => s.hasMore);` |
| `loadingOlder` | **不是** | 来自 `useSession`，`5158-5162`：`const loadingOlder = useSession((s) => s.loadingOlder);` |
| `firstSeq` | **不是** | 局部量，`5218-5219`：`const firstKey = order[0]; const firstSeq = firstKey === void 0 ? null : nodeStore.get(firstKey)?.anchorSeq ?? null;` |

### C2. 这些 props 由谁提供（逐字）

唯一提供方 = chat 自己的 `conversation.view` 注册，`dsh-client-ui-chat/lib/client.js:12439-12442`：

```js
loadOlder: () => {
    session.loadOlder();
},
loadThrough: (seq) => session.loadThrough(seq),
```

其中 `session` 来自同文件 `12410-12412`：

```js
const binding = ctx.sessions.binding(sessionId);
...
const session = binding.session;
```

→ **`loadOlder` 只是 `ctx.sessions.binding(sessionId).session.loadOlder()` 的转发。** 而 `sessions` 是第三方可用的 8 个客户端服务之一（layout / locale / **sessions** / slots / theme / timer / uiWorkspace / workspaces）。

`session.loadOlder()` 的实体定义在服务实现里，`C:\Users\haoch\AppData\Local\Temp\dsh-asar\dsh\node_modules\@deepseek-ai\dsh-api-session-controller\lib\client.js:1867-1883`：

```js
async loadOlder() {
    if (this.openState !== "open" || !this.hasMore || this.loadingOlder) return;
    ...
    this.loadingOlder = true;
    ...
    if (!(0, _deepseek_ai_dsh_api_gateway_client.isRemoteFailure)(error)) console.error("[session-controller] loadOlder failed:", error);
    ...
    this.loadingOlder = false;
```

同文件 `1886-1887`（跳转式加载，带 seq 目标）：

```js
/** Jump loader: page backwards until the window covers seq (see ISession.loadThrough). */
loadThrough(seq) {
    if (this.openState !== "open" || !this.hasMore || this.baseSeq <= seq) return Promise.resolve();
```

同文件状态字段：`hasMore = false;`（1577）、`loadingOlder = false;`（1584）；发布到快照处 `2289-2290`：`hasMore: this.hasMore, loadingOlder: this.loadingOlder`。

→ `hasMore` / `loadingOlder` 是**服务侧可观察状态**；`useSession((s) => s.hasMore)` 读的就是它。第三方若自己注册 `conversation.view` 条目，只要在自己的 `inject` 里放一个 hook 源即可同样拿到。

### C3. provide 描述符 vs 私有注入

**`loadOlder` 不是 provide 出来的。** 它只出现在 chat 自己 `conversation.view` 注册的 `inject` 返回值里（12439-12442）⇒ **只对 chat 自己的 view 条目可见**，第三方条目的 props 里不会自动出现 `loadOlder`。

第三方要分页，两条路都可：

1. **自己在 `conversation.view` 的 `inject` 里转发**（官方 trajectory 的做法，见 §C6）：
   `loadOlder: async () => { await ctx.sessions.binding(sessionId)?.session.loadOlder(); }`
2. **走 uiConversation 的 scoped 面**：`ConversationController.loadOlder()`，`dsh-client-ui-conversation/lib/client.js:3671-3673`：
   ```js
   /** Pull one older history page for the scoped Session. */
   async loadOlder() {
       await this.scopedSession("loadOlder").loadOlder();
   }
   ```
   `scopedSession(op)`（3675-3686）→ `this.requireSessions().binding(id).session`；错误文案逐字 `` `conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation` ``。

### C4. `useChat` 快照的精确形状

`dsh-client-ui-chat/lib/client.js:138-160`（`EMPTY_CHAT_SNAPSHOT`，逐字）：

```js
const EMPTY_CHAT_SNAPSHOT = {
    order: EMPTY_LIST$1,
    nodes: { get: () => void 0, source: () => EMPTY_NODE_SOURCE, turnDataSource: () => EMPTY_TURN_NODE_SOURCE, processSource: () => EMPTY_NODE_PROCESS_SOURCE, values: () => EMPTY_LIST$1 },
    locations: { getTurn: () => EMPTY_LIST$1, getStep: () => EMPTY_LIST$1 },
    navigation: { items: () => EMPTY_LIST$1 },
    timeline: EMPTY_TIMELINE,
    legacy: { nodes: EMPTY_LIST$1, turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: EMPTY_LIST$1 }
};
```

逐项回答：

| 问题 | 答案 |
|---|---|
| `order` 是轮次数组吗？ | **不是。** 它是 **nodeKey 的扁平数组**（`order[0]` 取首个 key、`order.at(-1)` 取末个 key，见 5218/5220）。轮次/步骤分组走另一条路：`useConversation((snapshot) => snapshot.views.grouped("chat")?.entries)`（5132）。 |
| `nodes.get(id)` 返回什么？ | node 对象，chat 实际读过的字段：`.kind`（`isActive` 里 `snapshot.nodes.get(key)?.kind !== "command"`，8852-8856）、`.anchorSeq`（5219）、`.data`（`ChatNodeSeat` 的 fallback 里 `routedNode.data`）、`.location`。完整类型 UNVERIFIED（未读到 `.d.ts`）。 |
| 有「已加载范围」概念吗？ | 有，但**不在快照里**：`firstSeq` 由 ChatView 自己从 `order[0]` + `anchorSeq` 算出（5218-5219）；「还有更早」是服务侧 `hasMore`。快照里没有 `firstSeq`/`lastSeq` 字段。 |
| `positions`/`navigation` | `navigation.items()`（5138）给轮次导航条；`locations.getTurn/getStep` 给定位。 |

### C5. `dsh-client-ui-chat` 里的 `ctx.remote.*` 与 `uiConversation.*` 调用

- **`ctx.remote.*`：chat 的 client 半里 0 处调用。** chat 的 `inject` 数组（12258-12269）确实列了 `"remote"` 与 `"remote.session"`，但没有观测到任何 `ctx.remote.` 调用点。分页不经过 remote。
- **`ctx.uiConversation.*` 调用点**（chat client.js）：
  - `12283`-`12315` `chatSource(binding)` 内：`const target = ctx.uiConversation.binding(binding).target("chat");`（12307），返回 `{ getSnapshot: () => target.getSnapshot() ?? EMPTY_CHAT_SNAPSHOT, subscribe: (listener) => target.subscribe(listener) }`。
  - `8862` `ctx.uiConversation.views.register(chatViewDefinition);`
  - 16 处 `ctx.uiConversation.events.register(...)`：7690, 9076, 9123, 9150(`registerFallback`), 9241, 9242, 9327, 9328, 9429, 9430, 9519, 9810, 9896, 9960, 10162, 10490。
  - `forkAt` 里用 `[...chat.getSnapshot().timeline.turns.values()].find((turn) => turn.end?.seq === seq)?.data.get("turn-tail")?.closing?.finalNode.messageId`（12443-12470 区间内）。
- **chat 的 provide 通道**（`dsh-client-ui-chat/lib/client.js:12317-12320`）逐字：
  ```js
  ctx.uiSession.provide({
      hooks: ["chat"],
      resolve: (binding) => ({ hooks: { chat: chatSource(binding) } })
  });
  ```
  → 由 `dsh-client-ui-session/lib/client.js:215-234` 的 `provide` + `378-397` 的 `materialize(binding)`，经 `dsh-client-ui-renderer/lib/client.js:646-656` 的 `materializeStandardBinding`，按 `standardHookPropName`（`dsh-client-ui-slots/lib/index.js:7-9` = `` `use${name[0]?.toUpperCase() ?? ""}${name.slice(1)}` ``）改名 ⇒ **每个 session 作用域 slot 条目的 props 里都会有 `useChat`**。第三方 `conversation.view` 条目是 session 作用域（`ui-conversation` 18209-18246 声明 `{ "conversation.view": { kind: "list", scope: "session" } }`；`dsh-client-ui-session/lib/client.js:467-477` 执行 `ctx.slots.installScope("session", service.adapter)`）⇒ **第三方确实拿得到 `useChat`。**

### C6. 【决定性先例】`dsh-client-ui-trajectory` —— 官方对同一需求的标准答案

`C:\Users\haoch\AppData\Local\Temp\dsh-asar\dsh\node_modules\@deepseek-ai\dsh-client-ui-trajectory\package.json` 的自述逐字：

```json
"description": "Trajectory event ledger with an interactive timing overview: pure-consumer plugin registering into the conversation ViewMap (no service)",
```

它 `dsh.client`（同文件）：

```json
"dsh": { "client": { "inject": [
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-session"
], "platform": "web" } }
```

`dsh-client-ui-trajectory/lib/client.js:8736-8769` —— **这正是「另开一个会话历史标签并驱动分页」的官方模板**：

```js
ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "trajectory",
    order: 10,
    locale: NS,
    label: () => t("view.trajectory"),
    children: { "conversation.trajectory.images": {
        kind: "single",
        scope: "session"
    } },
    inject: (sessionId) => {
        const session = ctx.sessions.binding(sessionId)?.session;
        if (session === void 0) throw new Error(`ui-trajectory: session "${sessionId}" is unavailable`);
        const trajectory = ctx.uiConversation.binding(sessionId).target("trajectory");
        return {
            hooks: { duration },
            jsonStringWrapping: { ... },
            loadOlder: async () => {
                const before = trajectory.getSnapshot();
                await session.loadOlder();
                return trajectory.getSnapshot() !== before;
            },
            loadImage: Object.assign((attachment) => ctx.uiConversation.imageUrl(sessionId, attachment), { peek: (attachment) => ctx.uiConversation.peekImageUrl(sessionId, attachment) }),
            setActualDuration: (value) => { duration.set(value); }
        };
    }
}, TrajectoryView));
```

同文件 `8732-8735` 的 provide：

```js
ctx.uiSession.provide({
    hooks: ["trajectory"],
    resolve: (binding) => ({ hooks: { trajectory: trajectorySource(binding) } })
});
```

同文件 `8322` 的 view props（逐字）：

```js
function TrajectoryView({ useSession, useTrajectory, useDuration, loadOlder, loadImage, setActualDuration, viewRequest, completeViewRequest, renderSlot, t, jsonStringWrapping }) {
```

同文件 `8612-8616` 的消费方式：

```js
const loadEarlierHistory = (0, react.useCallback)(async () => {
    if (!hasResidentOlderHistory && !await loadOlder()) return false;
    setHistoryNodeLimit((limit) => limit + HISTORY_PAGE_NODES);
    return true;
}, [hasResidentOlderHistory, loadOlder]);
```

同文件 `8705-8731` 的 `apply`：自己注册 6 组 event definitions、自己 `views.register`（1645）、自己 provide、自己注册 view 条目。

**三条硬结论：**

1. **第三方插件完全可以用与 trajectory 完全相同的姿势**：自己的 `conversation.view` 标签、自己的 `inject`、自己的 `loadOlder` 转发、自己的 provide hook、自己的 `views.register` / `events.register`。
2. **分页是可驱动的**：`await ctx.sessions.binding(sessionId)?.session.loadOlder()`。
3. **官方自己面对同一需求时，选择的是自建渲染，而不是复用 chat 的组件**（trajectory 8778 行，未 require chat）。

---

## D. 「把对话界面复制一份」这个想法本身

### D1. 成本粗估

`dsh-client-ui-chat/lib/client.js` = **12516 行 / 563047 字节**，含：

- **25 个 `react.memo)(function ...)` 组件**
- **82 个 `//#region lib/types/` 区段**
- 17 个 CSS-module 对象 + 18 个 `dsh-css` 区段
- 16 条 `conversation.chat.node` keyed entry 注册（`registerChatNodeRenderers`，6778 起）

要渲染的节点组件及其 props 签名（全部逐字）：

```js
1446: const UserMessageNodeView = (0, react.memo)(function UserMessageNodeView({ node, renderMessageImages, openFile, openSkill, t }) {
1468: const ContextMessageNodeView = (0, react.memo)(function ContextMessageNodeView({ node, t }) {
1479: const CompactionNodeView = (0, react.memo)(function CompactionNodeView({ node, t }) {
1486: const RetryNodeView = (0, react.memo)(function RetryNodeView({ node, t }) {
1495: const TurnErrorNodeView = (0, react.memo)(function TurnErrorNodeView({ node, t }) {
1502: const TurnMaxTokensNodeView = (0, react.memo)(function TurnMaxTokensNodeView({ t }) {
1506: const UnknownNodeView = (0, react.memo)(function UnknownNodeView({ node, t }) {
1668: const ChatNodeSeat = (0, react.memo)(function ChatNodeSeat({ nodeKey, groupPart, useChatNode, useChatNodeProcess, usePresentation, cwd, openFile, openSkill, inspectCall, forkAt, loadImage, renderMessageImages, fileMentions, useStore, actions, renderSlot, t }) {
2289: const ChatGroupSeat = (0, react.memo)(function ChatGroupSeat({ groupKey, useChatGroup, ...props }) {
3858: const TurnNavigator = (0, react.memo)((0, react.forwardRef)(TurnNavigatorRail));
5896: const AssistantMarkdown = (0, react.memo)(function AssistantMarkdown({ blocks, streaming, interrupted, renderMessageImages, groupPart, useDisclosure, reasoningHidden = false, usePresentation, revealProcess, mentions, t }) {
5978: const AssistantNodeView = (0, react.memo)(function AssistantNodeView({ node, groupPart, useDisclosure, useTurnData, turnProcess, openFile, renderMessageImages, fileMentions, usePresentation, t }) {
6134: const CommandNodeView = (0, react.memo)(function CommandNodeView({ node, renderSlot, t }) {
6149: const ManualCompactionNodeView = (0, react.memo)(function ManualCompactionNodeView({ node, t }) {
6198: const SystemPromptNodeView = (0, react.memo)(function SystemPromptNodeView({ node, t }) {
6225: const TurnProcessNodeView = (0, react.memo)(function TurnProcessNodeView({ node, turnProcess, t }) {
6567: const TurnTailNodeView = (0, react.memo)(function TurnTailNodeView({ node, openFile, forkAt, renderSlot, t, useChat, usePerformanceUsage }) {
```

`registerChatNodeRenderers`（6778 起）的 16 条 keyed entry：

`user`→`UserMessageNodeView`(6779-6783)、`steering`→`UserMessageNodeView`(6784-6788)、`context`→`ContextMessageNodeView`、`turn-trigger`→`TurnTriggerNodeView`、`system-prompt`→`SystemPromptNodeView`、`assistant-step`→`AssistantNodeView`（带 `inject: () => ({ hooks: { presentation } })`）、`command`→`CommandNodeView`（children `conversation.chat.commandview` keyed/session）、`manual-compaction`→`ManualCompactionNodeView`、`compaction`→`CompactionNodeView`、`model-retry`→`RetryNodeView`、`turn-error`→`TurnErrorNodeView`、`turn-max-tokens`→`TurnMaxTokensNodeView`、`turn-process`→`TurnProcessNodeView`、`turn-tail`→`TurnTailNodeView`（children `conversation.chat.turnTail`+`conversation.chat.assistant-actions`）、`unknown`→`UnknownNodeView`。

**估算法：**

- **整体照抄（等价于官方 chat）**：≈12500 行 JS + ~17 份 CSS，加上自己对 definitions（13 个 `buildViewNode` 站点：7671, 9059, 9111, 9143, 9303, 9368, 9414, 9497, 9785, 9875, 9942, 10147, 10480）与 view definition 的重建。**不现实**，且 markdown 那一层抄不动（`MarkdownText` 依赖 micromark + katex + shiki + anser + diff，见 §B2）。
- **只抄「只读阅读栏」子集**：`ChatNodeSeat`(113 行) + `UserMessageNodeView`(~125 行) + `AssistantNodeView`(~48 行) + `AssistantMarkdown`(~82 行) + `TurnProcessNodeView`/`TurnTailNodeView` 简化版 + markdown 轻量替代 ≈ **400–800 行**。这是唯一量级可控的方案。
- **参考上界**：官方 `dsh-client-ui-trajectory` 自建整条渲染链（含 definitions、snapshot builder、虚拟滚动、CSS）用了 **8778 行**；`dsh-client-ui-tool`（只做 tool 卡片）用了 **4582 行**。

### D2. 它实际读取的 useChat 快照字段（我们确实拿得到）

chat client.js:5131-5238 逐字：

```js
5131: const order = useChat((s) => s.order);
5137: const nodeStore = useChat((s) => s.nodes);
5138: const turnNavigationItems = useChat((s) => s.navigation.items());
5140: const runningStartTime = useChatNode(latestTurnAnchor ?? "", (node) => {...});
```

外加 `ChatNodeSeat` 的 `useChatNode(key)` / `useChatNodeProcess(key)`（12418-12422 的 keyedHooks 定义：`chatNode: (key) => chat.getSnapshot().nodes.source(key)`、`chatNodeProcess: (key) => chat.getSnapshot().nodes.processSource(key)`），以及 `ChatGroupSeat` 的 `useChatGroup(key)`（12423：`chatGroup: (key) => conversation.snapshot.getSnapshot().views.grouped("chat")?.groupSource(key)`）。

快照字段全集（见 §C4）：`order`、`nodes.{get,source,turnDataSource,processSource,values}`、`locations.{getTurn,getStep}`、`navigation.items()`、`timeline`、`legacy.{nodes,turnTimings,turnEnds,partial,runningCalls}`。

**这些都是 `useChat` 暴露的，而 `useChat` 通过 `uiSession.provide` 注入每个 session 作用域条目 ⇒ 第三方拿得到。** 数据不是瓶颈。**瓶颈是渲染。**

### D3. 有没有更窄的复用点？—— 两个方向，一死一活

#### D3-a【否证】`uiConversation.events.register` 的 definition **没有 `render`**

这是我原本最有希望的一条路，实测**不存在**。

- 注册表：`ConversationDefinitionRegistry`（`dsh-client-ui-conversation/lib/client.js:2587`），公开方法 `entries()`（2601，返回 registration order 的 reference-stable Definitions）、`subscribe(listener)`（2609）、`registerDefinition(key, definition, duplicateMessage, effectName)`（2623）。`ConversationEventRegistry extends` 它（2647）：`register(definition)`（2654）、`registerFallback(definition)`（2663）、字段 `fallback`。
- `UiConversation` 类（`dsh-client-ui-conversation/lib/client.js:3028`）`extends _deepseek_ai_cordis.Service`，`super(ctx, "uiConversation")`（3043）；公开字段 `this.events`（3045）、`this.views`（3046）、`this.groups`（3047）；公开方法 `binding(source)`（3079）、`imageUrl(sessionId, attachment)`（3108）、`peekImageUrl(...)`（3117）。
  → **`ctx.uiConversation.events.entries()` 确实可枚举**，第三方拿得到全部 definition 对象。
- **但 definition 的契约里没有 `render`。** `assistantDefinition`（chat client.js:7625-7684）的键**只有**：`kind: "assistant-step"`, `target: "chat"`, `match`, `start`, `update`, `publication`, `buildLocationData`, `buildViewNode`。
- 守卫逐字，`assertDefinitionTarget`（`dsh-client-ui-conversation/lib/client.js:2688`）：
  ```js
  throw new Error(`conversation Definition "${definition.kind}" must declare target and buildViewNode together`)
  ```
- **definitions 是纯状态折叠器（fold），`buildViewNode` 只产出数据（view node），不产出 React 元素。**
  → **「取出 definition 的 `render` 并调用」这条最有希望的路不存在。** 这条路关闭。

#### D3-b【真实机制】渲染走 **keyed slot**，且该 slot 的 `renderSlot` 第三方永远拿不到

节点渲染的真实调用点，`dsh-client-ui-chat/lib/client.js:1768-1780`（`ChatNodeSeat` 内）逐字：

```js
children: renderSlot("conversation.chat.node", routedOwner, {
    entryKey: routedNode.kind,
    hookContext,
    fallback: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
        label: t("message.unknownSurface", { type: routedNode.kind }),
        payload: routedNode.data,
        truncatedLabel: (total) => t("json.truncated", { total })
    })
})
```

即：**谁拿到 session 作用域的 `renderSlot`，谁就能按 `entryKey = kind` 渲染官方节点组件。**

那么第三方能不能拿到一个能渲染 `conversation.chat.node` 的 `renderSlot`？**不能。** 证据链：

1. `renderSlot` 只在 entry 声明了 children 时才被注入，`dsh-client-ui-renderer/lib/client.js:715-746` `standardKit(...)`：
   ```js
   717: const kit = { ...standard, renderFactorySlot: boundRenderFactorySlot(entry) };
   732: if (entry.children !== void 0) {
   733:     kit["renderSlot"] = boundRenderSlot(host, entry);
   ```
2. 且只对该 entry 自己声明过的 key 放行，`boundRenderSlot`（`dsh-client-ui-renderer/lib/client.js:326-343`）：
   ```js
   330: if (!host.isLive(entry)) throw new StaleAuthorizationError(`renderSlot('${key}') from a disposed registration`);
   331: const declared = entry.children?.[key];
   332: if (declared === void 0) throw new SlotOwnershipError(`slot '${key}' is not declared by this entry's children`);
   ```
3. ctx 级入口被硬编码禁止，`dsh-client-ui-renderer/lib/client.js:1506-1507`：
   ```js
   renderSlot(key, owner) {
       if (key !== "root") throw new Error(`ctx-level renderSlot only renders 'root' (got "${key}"); child slots render through the component props face`);
   ```
4. Factory 路径同理被锁，`boundFactoryRenderSlot`（`dsh-client-ui-renderer/lib/client.js:371-387`）376-377 行：
   ```js
   const declared = definition.children?.[key]; if (declared === void 0) throw new SlotOwnershipError('slot \'' + key + '\' is not declared by this Factory');
   ```
   （chat 里 `registerFactory` / `slots.factory` 出现 **0 次**，此路对 chat 也无对象。）
5. **`conversation.chat.node` 已被 chat 声明**（`dsh-client-ui-chat/lib/client.js:12390-12407`，在 chat 自己 `conversation.view` 注册的 `children` 里）。逐字：
   ```js
   12390: ctx.slots.inject("conversation.view", () => {
   12391:     return ctx.slots.register({
   12392:         name: "conversation.view",
   12393:         id: "chat",
   12394:         order: 0,
   12395:         label: () => t("view.chat"),
   12396:         locale: NS,
   12397:         children: {
   12398:             "conversation.chat.node": {
   12399:                 kind: "keyed",
   12400:                 scope: "session",
   12401:                 inject: CHAT_NODE_INJECT
   12402:             },
   12403:             "conversation.message.images": {
   12404:                 kind: "single",
   12405:                 scope: "session"
   12406:             }
   12407:         },
   12408:         store: chatStore,
   12409:         inject: (sessionId) => {
   12410:             const binding = ctx.sessions.binding(sessionId);
   12411:             if (binding === void 0) throw new Error(`ui-chat: unknown session "${sessionId}"`);
   ```
   第三方若再声明它，`dsh-client-ui-slots/lib/index.js:191-194` 会抛：
   ```js
   if (options.children) for (const childKey of Object.keys(options.children)) {
       const childRec = this.records.get(childKey);
       if (childRec?.spec) throw new Error(`slot "${childKey}" is already declared (by ${childRec.declaredBy ?? "an unknown entry"})`);
   }
   ```
   即：要么第三方注册失败，要么第三方抢先注册导致 **chat 自己的注册抛错**（破坏官方对话界面）。

→ **第三方永远拿不到渲染 `conversation.chat.node` 的 `renderSlot`。** 这条路**彻底关闭**。

旁证：`dsh-client-ui-slots/lib/index.js` 的导出清单（575 行）逐字只有
```js
export { SlotCore, SlotOwnershipError, StaleAuthorizationError, resolveSlotLabel, standardHookPropName };
```
**没有 `SlotOutlet`、没有 renderer**；`renderOutletContent` / `SlotOutlet` / `StandardKit` 全是 `dsh-client-ui-renderer/lib/client.js` 的内部闭包，未导出。

#### D3-c【活路】往 `conversation.chat.node` **注册自己的 key** —— 官方已在这么做

**注册新 key 不需要声明该 slot**，这两件事在 slots 实现里是分开的（重复 key 守卫在 `dsh-client-ui-slots/lib/index.js:175-179`：同 key 同 priority 抛错，不同 priority 可共存，派发用排序后 `.find` 取第一个 ⇒ `priority: -1` 甚至可以 shadow 官方 entry）。

官方先例逐字，`C:\Users\haoch\AppData\Local\Temp\dsh-asar\dsh\node_modules\@deepseek-ai\dsh-client-ui-tool\lib\client.js:4543-4564`：

```js
const inject = ["slots", "remote"];
function apply(ctx) {
    const hostInfo = {
        getSnapshot: () => ctx.remote.$host,
        subscribe: (listener) => ctx.on("connection/reset", listener)
    };
    const toolInject = () => ({ hooks: { hostInfo } });
    ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
        name: "conversation.chat.node",
        key: "tool-call",
        locale: CONVERSATION_NS,
        children: { "tool.call.toolview": {
            kind: "keyed",
            scope: "session",
            inject: { hooks: { toolCallArgumentsPartial: bindToolCallArgumentsPartial } }
        } },
        inject: toolInject
    }, ToolCallTree));
```

→ **一个独立官方包自愿往 `conversation.chat.node` 里加 key `tool-call`，并声明自己的子槽 `tool.call.toolview`。** 这是**被实践过的、第三方同样可用的**扩展点。

但它解决的是「**在官方对话流里多渲染一种节点**」，**不是**「在别人的标签页里独立渲染官方对话」。对本次需求（自建看板标签里的只读阅读栏），它只能在「直接嵌进官方 chat 标签」的前提下用。

### D4. 三条路的最终对比

| 路线 | 可行性 | 证据 | 代价 |
|---|---|---|---|
| **① 直接复用官方 chat 渲染** | **不可行** | §A4（只导出 5 项）、§D3-b（`renderSlot` 授权死锁） | 无 |
| **② 抄窄接口**（自建只读阅读栏，`useChat` 读数据 + `session.loadOlder()` 分页 + 自写/轻量 markdown；需要时逐字提取 chat 的 CSS 并改前缀） | **可行，推荐** | §C6（官方 trajectory 同姿势）、§C2（分页转发）、§C5（`useChat` 注入路径）、§B5（CSS 可逐字提取） | 400–800 行（只读子集） |
| **③ 全部自己写**（对齐 trajectory 的完整做法：自建 definitions + view definition + snapshot builder） | 可行 | `dsh-client-ui-trajectory/lib/client.js`（8778 行，自建全套） | 数千行；但与官方架构完全一致，最稳 |
| ④ 往官方 chat 加 keyed entry | 可行但答非所问 | `dsh-client-ui-tool/lib/client.js:4543-4564` | 小；但只在官方 chat 标签内生效 |

**推荐：②，必要时局部升级到 ③。** 明确**不要**走 ①。

---

## 附录 A：可复现命令

抽取单文件（**必须先切到临时目录**——`@electron/asar extract-file` 会把文件写到 CWD，本次调研中曾因此覆盖掉仓库根的 `package.json`）：

```powershell
Set-Location $env:TEMP
npx --yes @electron/asar extract-file "C:\Users\haoch\AppData\Local\Programs\DeepSeek Harness\resources\app.asar" "dsh\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\client.js"
```

定位 CSS 内嵌区段与导出表：

```powershell
$c = "C:\Users\haoch\AppData\Local\Temp\dsh-asar\dsh\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\client.js"
$ct = Get-Content $c -Raw
([regex]::Matches($ct, '#region \\0dsh-css:')).Count   # → 18
([regex]::Matches($ct, 'const css\$\d+ = "')).Count     # → 17
```

## 附录 B：未验证项（UNVERIFIED）

- `useChat` 快照 node 对象的**完整**字段类型（只观测到 chat 实际读过的 `.kind`/`.data`/`.location`/`.anchorSeq`）；未读 `lib/types/**/*.d.ts`。
- `dsh-client-ui-renderer` 是否为**每个** slot entry 通用注入 `renderSlot`（`standardKit` 只在 `entry.children !== void 0` 时注入，这一条已读实；但第三方 `conversation.view` 条目若不声明 children 是否另有路径注入，未穷尽验证）。
- `ctx.uiConversation.binding(id).conversation` 这一具体属性名未逐字确认；已确认的是 `ConversationController`（`dsh-client-ui-conversation/lib/client.js:3341`）拥有 `loadOlder()`（3671）与 `scopedSession(op)`（3675），以及 `BoundConversation`（2920）提供 `target`/`activate`/`rebuild`/`replace`/`accept`。
- `dsh-client-ui-chat/lib/client.js` 的 `ctx.remote.*` 使用点：检索为 **0 处**，但未逐 token 穷举 `ctx["remote"]` 之类的间接写法。
