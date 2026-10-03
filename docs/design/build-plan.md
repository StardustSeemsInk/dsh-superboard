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

### M1 · 场景模型与 log 原生折叠 ✅ 已完成

**交付**：
- `src/model.js` —— 场景模型、id 推导、slug 生成与查重、量化、手写哈希编码。
- `src/fold.js` —— 14 个 op 的事务性施加、引用解析（`id → slug → alias`）、两阶段事件配对、`foldBoard` 主入口。
- `src/schema.js` —— zod 的 checkpoint 校验 schema 与客户端 wire schema。
- `src/index.js` —— 注册 `ctx.sessionProjections`，并把常驻大纲接到 M0 占好的 `systemPrompt.context()` 位置。
- `test/fold.test.js` —— 15 个测试，全部通过。

**验收标准**：`npm test` 全绿；host 半从 profile 可导入。✅

**实现中发现的三件事（契约里没写、但会咬人）**：

1. **失败批绝不能抛异常。** `apply` 运行在投影的事件推进里，抛出去会**中止所有已注册 key 的折叠**，不只是我们这一个。契约说「失败批整体丢弃」是对的，但实现上必须是**捕获**而非抛出。现在捕获后记进 `lastOpError`，大纲可以提前提一句。
2. **sessionId 只能从 `init` 拿，但折叠要用它。** `apply` 的签名是 `(state, event)`，没有 session。所以 sessionId 存在 state 里（会被 checkpoint 一起持久化），且**不参与内容哈希**。
3. **两条路径的 `arguments` 类型不同**：普通路径是**字符串**（需 `JSON.parse` 且容忍失败——DSH 故意把非法 JSON 原文保留），PTC 路径**已是对象**。测试直接对比两条路径折出的内容哈希。

**契约与实现对不上的两处**（以实现为准，已记）：
- 契约「单分支 + `kind` enum，由 execute 校验条件必填」的取舍在这里体现为 `buildBlock` 按 kind 分派并逐个校验必填字段。
- `uniqSlug` 的冲突后缀是**叠加在整个 base 上**（`风险-1` → `风险-1-2`），不是递增尾号（`风险-3`）。按契约伪代码实现，并在测试里写明理由。

---

### M2 · 工具面与常驻大纲 ✅ 已完成

**交付**：`src/schema-dsl.js`（手写编译后的 JSON Schema）、`src/tools.js`（四个工具）、`test/tools.test.js`（27 个测试）。42 个测试全绿。

**验收标准**：`board_outline` 能读回 `board_apply` 刚写的东西；过期 revision 被拒且回带当前 rev；失败 op 报出位置、原因、合法取值、下一步。✅

**这一步最重要的决定：不用 `defineTool`。** `ctx.tools.register` 要的是**编译后的 JSON Schema**，它自己不做作者规格转换（`dsh-tools/lib/index.js:2878-2887`）；而官方编译器 `defineTool` 在 `@deepseek-ai/dsh-tools` 里，属于**运行时不能 import** 的包（本地副本会变成宿主的第二实例）。所以 `src/schema-dsl.js` 直接产出编译形态。

这个选择的回报是：测试可以把每个定义喂给 **DSH 自己的** `assertSupportedJsonSchema` 与 `validateJsonSchemaValue`（从已安装的应用里加载），而不是只对着自己的预期断言。这查出了两个真缺陷：

- **`add_block` 的 `page` 被覆盖了。** 该分支平铺了所有 kind 的内容字段，而 `pdf-page` 的 `page` 是 integer 页码——于是「所属页的 slug」被当成整数校验。改名 `pdfPage`；`update_block` 上仍接受 `page`，因为那里没有冲突。
- **`minItems` 不在 DSH 的强制子集里**（支持集是 `type/oneOf/properties/required/additionalProperties/items/enum/const` + 注记）。

**另有四个缺陷来自工具测试**：`uniqSlug` 被传错了集合（显式 slug 永不判冲突）；空看板把标题和页名渲染进**每一个**请求；slug 冲突警告比较错了对象；`execute` 返回 `{ value }` 而注册表要的是被 `output.schema` 校验的那个裸值。

**与契约的一处差异**：契约 §3.2.3 的表把 `add_page` 的参数写作 `page` 且标为 slug，但 §2.2 的 op 表写的是 `slug`。两者都接受了（`slug ?? page ?? title`）。同理 `set_region` 的 `region` 在 schema 里是可选的（有 `region` 就更新，没有就新建）。

---

### M3 · 渲染器（下一步）

**交付**：自建 DOM/SVG 层——世界坐标容器 + CSS `transform` 做平移缩放；块流布局（Q-E 的模板优先：`flow` / `columns` / `grid` / `tree`，Agent 只声明结构与关系）；箭头为 SVG path，锚在块锚点上；显式多页与页签栏（Q-C）。

**验收标准**：Agent 建的两页看板能在页签间切换；箭头正确连到目标块并在窗口缩放后仍正确；切到「对话」标签再切回来，看板内容不变（证明状态确实不在 React 里）。

**读路径已经就绪**：M1 注册的投影带 `wire` 面，客户端用 `useProjection('board')` 零 RPC 读取——M0 的 `BoardView` 已经留好了这个钩子。

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
