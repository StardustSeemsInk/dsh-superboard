# 构建计划

**前置文档**：[`design-tree.md`](./design-tree.md)（15 条已定决策）、[`board-model.md`](./board-model.md)（可照着实现的契约）、[`../research/dsh-plugin-contract.md`](../research/dsh-plugin-contract.md)（已验证的框架约束）。

原则：**每个里程碑都以「能在运行中的 DSH 里观察到的东西」结束**。不写看不见的代码——这套插件最大的风险不是逻辑写错，而是假设错了框架行为，而这类错误只有在真页面上才会暴露。

---

## 里程碑

### M0 · 骨架可见 ✅ 已写完，待验证

**交付**：`package.json`（含 `dsh.bundle` + `dsh.client`）、`cordis.patch.yml`、`src/index.js`（host 半，注册一个空的 `systemPrompt.context`）、`src/client.js`（client 半，注册 `conversation.view` 的 `board` 标签页，渲染写死的两块 markdown 卡片）。

**验收标准**：在运行中的 DSH 里打开任一对话，能看到第三个标签页「看板」，点开后是两张卡片。

**这一步真正在验什么**：
1. bundle 能被 profile 加载（`dsh.bundle.patch` 的 insert 生效）。
2. `dsh.client` 的 client 半被服务并注册成懒加载工厂。
3. `conversation.view` 的 `list` 槽注册能让 DSH 自动生成第三个标签按钮（设计树 S15 的直接检验）。
4. `useProjection('board')` 在投影不存在时返回 `undefined` 而不是崩溃（M1 的读路径前提）。

**已知未做**：没有构建步骤（纯 ESM + 浏览器端 `React.createElement`）；文案未走 locale 服务；样式只用 `--dsw-alias-*` token 且内联为 `<style>` 元素（不用 `styles` 服务——client 半只有 8 个服务，其中没有它）。

---

### M1 · 场景模型与 log 原生折叠

**交付**：
- `src/model/` —— `Board` / `Page` / `Block` / `Edge` / `Anchor` / `Region` 的纯 JSON 形状，以及 slug 生成与查重（`board-model.md` §1）。
- `src/fold.js` —— 把 `board_apply` 的 op 序列折叠成看板状态的纯函数（`board-model.md` §2.2/§2.3）。
- `ctx.sessionProjections.register({ key: 'board', … })` —— 折叠的挂载点，`apply(state, event)` 保持纯同步、对忽略的事件返回同一引用。

**必须处理两条事件路径**（`dsh-plugin-contract.md` §10）：

| | 普通 agent 调用 | PTC `run_code` 子调用 |
|---|---|---|
| 事件 | `tool/call` + `tool/result` | `tool/ptc-dispatch-start` + `tool/ptc-dispatch` |
| `arguments` | **字符串**，需 `JSON.parse` 且容忍失败 | **对象**，直接用 |

配对规则：`tool/result` **不带工具名**，所以必须两阶段——在 `tool/call` 上按 `name === 'board_apply'` 把 ops 存进 `state.pending[callId]`，在 `tool/result` 上且 `isError !== true` 时才真正折叠。这个配对顺带白送了「失败批不生效」。

**验收标准**：手工在会话里让 Agent 调一次 `board_apply`（M2 的工具），刷新页面后看板仍显示同样的内容——即状态确实来自 log 而非内存。

**风险**：投影的 `apply(state, event)` 签名里**没有 session**，所以不能回读日志。把 `pending` 放进投影状态是可行的但不优雅（`board-model.md` §8 R2），评审时值得再看一眼。

---

### M2 · 工具面与常驻大纲

**交付**：
- `board_outline` / `board_read` / `board_apply` / `board_query`，参数用 DSH 的**裸属性表**（不是 zod、不是 JSON Schema：无顶层 `type: "object"`，`required: true` 写在每个属性上）。
- `board_apply` 带 `expected_revision`，`isConcurrencySafe: false`。
- 常驻大纲接进 M0 已经占好的 `systemPrompt.context()` 位置。

**验收标准**：让 Agent「在看板上写下三个块并用箭头连起来」，然后 `board_outline` 能读回它刚写的东西；故意传一个过期 revision，Agent 收到可理解的错误并自行重读重试。

**注意**：`board_apply` 的 schema 有 14 个 `oneOf` 分支约 70 个属性，常驻请求头估计 4–6k 字符（~2–3k token），**比常驻大纲更硬**——大纲可以降级，schema 不能。`deferLoading` 或许能省掉它，属待验项。

---

### M3 · 渲染器

**交付**：自建 DOM/SVG 层——世界坐标容器 + CSS `transform` 做平移缩放；块流布局（Q-E 的模板优先：`flow` / `columns` / `grid` / `tree`，Agent 只声明结构与关系）；箭头为 SVG path，锚在块锚点上；显式多页与页签栏（Q-C）。

**验收标准**：Agent 建的两页看板能在页签间切换；箭头正确连到目标块并在窗口缩放后仍正确；切到「对话」标签再切回来，看板内容不变（证明状态确实不在 React 里）。

---

### M4 · 框选反馈入草稿

**交付**：框选（矩形选择区域内的块）+ 写一句话 → 变成 composer 草稿里一个**可见、可删除**的上下文对象；`Ctrl+Enter` 直接发。

**前置待验**：**插件如何把上下文对象追加进 composer 草稿。** composer 的草稿由 `dsh-client-ui-conversation` 通过内部 share 持有（`inputActions.setDraft`、`bindDraftMirror`、`useInput`、`useStore`），那些不是公开 API；`conversation.input.*` 槽族是可能的公开路径。**这是 M4 的阻塞项，动工前必须先验。**

**验收标准**：框选三个块并写下问题，草稿里出现一个可删除的引用对象；发送后 Agent 的回答显示它确实收到了那三个块。

---

### M5 · 精简对话条

**交付**：折叠态一行——Agent 状态点 + 最新消息首行 + 未读计数；展开态——最近几轮只读（Q-K）。

**前置待验**：客户端如何读取实时会话数据。client 半没有插件事件总线，且**没有 `host.call`**——通道是 HTTP：`fetch` 打 host 用 `ctx.webServer.register` 注册的路由，host 用 SSE 推回（抄 `dsh-client-hmr`）。另外 `wire.view` 投影是更便宜的读路径。

**验收标准**：看板为主时，Agent 开始/结束运行能在对话条上看到状态变化，不需要切标签。

---

## v1 之后（已设计、刻意推迟）

| 项 | 已定的关键约束 |
|---|---|
| **UML + 错误反馈回路** | mermaid 必须作为**包内 chunk** 懒加载（`require.async("./client.mermaid.js")`）——静态模块表是冻结的 9 项，`external` 扩不了它。官方先例：documentpreview 用同法加载 7MB pdf.js。错误要 (i) 就地错误卡、(ii) 结构化诊断进工具返回值、(iii) `board_render` 干跑、(iv) 渲染后**几何检查**溢出/裁切 |
| **PDF 与图片锚定** | **禁止 iframe**（丢主题 token 与 locale）→ 必须在宿主文档里栅格化；这才是「从页面某点拉箭头」需要的精确页空间坐标 |
| **Agent 主动发起的位图查询** | Q-H 的后半段。需要宿主文档内栅格化；`sharp` 在依赖里但能否 SVG→PNG 待验 |
| **`.dsh-superboard/` 只读镜像** | 位置待定：`cwd` 还是 `~/.dsh/superboard/<sessionId>/` |

---

## 待验清单（按触发时机）

| 何时需要 | 要验什么 |
|---|---|
| M0 装上时 | 标签页真的出现（其余都是静态校验） |
| M2 | `board_apply` 作为 PTC 子调用时，错误文本是否仍按设计到达模型 |
| **M4 动工前** | **插件如何把上下文对象追加进 composer 草稿**（阻塞项） |
| M4 | 反馈载荷落在哪条既有事件上（候选：`user/message` 附件、`feedback/message-put`、`feedback/record`） |
| M2/M3 | `board_apply` 的 schema 能否用 `deferLoading` 省掉常驻开销 |

---

## 工程约定

- **不引入构建步骤，直到确有必要。** 官方明确「Host-only bundle 不需要依赖、安装脚本或构建工具」，而 M0 的 client 半直接写浏览器端 `React.createElement` 即可。需要 TS 或打包时（多半是 M3 的 SVG 布局、或 UML 的 chunk）再引入，那时的产出必须匹配 `window.__ModuleLoader__.load({ id, factory })` 格式。
- **只依赖 `--dsw-alias-*` token。** 不 `require('@deepseek-ai/dsh-client-ui-primitives')`——组件抛错会清空整个 slot。
- **`.ref/` 不入库**，用 `node scripts/extract-dsh-ref.mjs` 重新生成。
- 每个里程碑单独提交，提交信息写清「这一步在验什么」。
