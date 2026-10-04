# dsh-superboard

An agent-editable board for [DeepSeek Harness](https://github.com/deepseek-ai) — 一块**超级看板**，把对话框从 UI 主体的位置换下来。

看板是 Agent 思考的地方：markdown 块、关系箭头、渲染出的图表、钉住的 PDF 页与图片。它是**对话 / 轨迹旁边的第三个标签页**，所以聊天保留自己的家；同时它也是一块**常驻显示面**——钉在看板上的答案不会滚进历史里再被重新读一遍。

> **状态：v1 完成并在用。** 230 个测试通过；模型版本 3；已以 `link:` 方式装进 `desktop` profile。
> 设计访谈与技术决定见 [`docs/design/design-tree.md`](docs/design/design-tree.md)，
> 可照着实现的模型契约见 [`docs/design/board-model.md`](docs/design/board-model.md)，
> 逐条验证过的框架约束见 [`docs/research/dsh-plugin-contract.md`](docs/research/dsh-plugin-contract.md)，
> 里程碑与验收标准见 [`docs/design/build-plan.md`](docs/design/build-plan.md)。

## The idea

今天的**对话记录本身就是界面**。Agent 推理出的每一张图、每一个计划、每一条关系，都只能变成滚动列里的一段散文。这个插件把它反过来：

- **画布是主体。** 一个对话一块看板，一块看板多页。
- **Agent 直接编辑它。** Agent 看不到像素，它读写的是一个结构化场景模型——因为 Agent 的母语是树，不是坐标。
- **用户用手指东西。** 框选一块区域、写一句问题，就变成下一条消息里有据可依的上下文。
- **内容是拉取而不是推送。** Agent 先看大纲，再按需读它真正需要的区域，整块场景从不整个塞进上下文。

## 现在能做什么

### 看板

- **多页看板**，作用域是**对话**（一个对话一块看板）。
- **八种块**：标题 / 正文 / 列表 / 代码 / UML / 图片 / PDF 页 / 分组。
- **容器可嵌套**：`group` 里可以再放 `group`，层级不限。
- **五种排版模板**：`flow`（竖排）/ `row`（横排换行）/ `columns`（N 等分列）/ `grid`（卡片填满宽度）/ `canvas`（不排版，只做个盒子）。
  **没有任何块带坐标**——容器声明它怎么安排子块，坐标不是块的事。
- **`grid` 上的 `areas`**：用名字声明格子，从而表达跨行跨列。

  ```jsonc
  { "template": "grid",
    "params": { "areas": ["导航 正文 正文 正文",
                          "导航 侧栏 页脚 工具条",
                          "日志 备注 状态 状态",
                          "图表 图表 图表 图表"] } }
  ```

  单元格里写的是**子块引用**（slug / 别名 / id），`.` 是空位。每行格子数必须相同，同一个名字必须占一个**实心矩形**。这是用来表达「让正文横跨两列、让导航竖跨两行」这类排版的。
- **有向语义箭头**，端点可以精确到块的内部——九种锚点：整块 / 字段（`title`、`code`、`caption`、`filename`）/ 列表项 / 代码行段 / 文本区间（带引文）/ 子块 / UML 节点 / 矩形 / 点。
- **region**：只做标注和底色，**不参与排版**（要排版请用 `group`）。一个块最多属于一个 region。
- **revision 闸**：每次写入都要带 `expected_revision`，并发写会被拒绝而不是静默覆盖。

### 工具（刻意只有四个）

| 工具 | 作用 |
| --- | --- |
| `board_outline` | 整块看板的骨架：页面、块、箭头、失败渲染 |
| `board_read` | 按需读取真正的文本——页面、块、箭头、region |
| `board_apply` | **唯一写入口**，一批有序操作原子生效 |
| `board_query` | 沿箭头提问（谁依赖 X、X 指向谁、两点之间怎么走） |

支撑它们的还有：**常驻大纲**（每步注入一小段，细节由 Agent 按需拉取，所以从没打开过看板的对话不会为此花掉提示预算），以及两个投影（`board`、`boardActivity`）。

### 读对话（看板右侧的阅读栏）

- 与看板**同屏**的对话阅读栏，可拖宽，宽度持久化。
- **只显示对话**：`user` 与 `assistant` 的文本。思考过程和工具调用被过滤掉——不是靠设置，而是这两种节点本来就不带文本块。
- **自带 markdown 渲染**：标题、列表、引用、围栏代码、表格、行内样式与链接。渲染器只构造 React 元素，**从不拼 HTML 字符串**——看板文本是 Agent 写的，而 Agent 读到的内容不受控。
- **「加载更早」直接生效**，不需要切走标签页再切回来。

### 框选反馈

- 在看板上拖框选中 → 浮动输入条出现 → 写一句问题 → **追加到输入框**（不是替用户发送）。
- 追加时做两件事：把一段**可读摘要**写进草稿，让 Agent 不用花一次工具调用去开附件就知道用户选中了什么；同时把**结构化选区**作为 JSON 附件带上。
- **永不代替用户发送。**

## 刻意推迟（已设计，未实现）

UML 渲染与错误反馈回路 · PDF 栅格化与页空间锚定 · 图片钉住 · Agent 主动发起的位图查询 · `.dsh-superboard/` 只读镜像。

## 安装（开发期）

本仓库作为 DSH bundle 装进某个 profile（当前装在 `desktop`）。

**必须先做成链接，不能靠 `file:`。** 这条是踩过坑的：

profile 的 `pnpm-workspace.yaml` 里写着 **`nodeLinker: hoisted`**。在 hoisted 模式下，`file:` 指向本地目录时 pnpm 是把文件**复制**进 `node_modules` 的——**每次 install 都是那一刻的快照**。所以「改完源码刷新页面即可生效」是**错的**：源码改了、profile 里还是旧副本，而且症状是「标签页在、但内容是旧的」，很容易误判成插件没加载。（这个坑真的发生过：安装里躺着的是 M0 脚手架，而仓库已经到 v1。）

profile 的 `package.json` 里依赖要写成 **`link:`**（pnpm 对 `link:` 始终建符号链接，从不复制）：

```
"dsh-superboard": "link:E:/Dev/dsh-superboard"
```

然后在 profile 目录跑一次 `pnpm install --no-frozen-lockfile`。之后 `node_modules/dsh-superboard` 是一个指向本仓库的 **Junction**，改代码立即反映在 profile 里。

**但 host 半是启动期加载的**，desktop profile 不是 live reload——改完 **host 半**（`src/index.js`、`model.js`、`fold.js`、`schema*.js`、`tools.js`、`activity.js`）需要**重启 DSH**。client 半（`src/client.js`）刷新页面通常就够。

**改完怎么自查**（不用开浏览器）：在 profile 目录跑

```powershell
node --input-type=module -e "
const m = await import('dsh-superboard')
const p = [], t = []
m.apply({ inject: (names, cb) => cb(Object.fromEntries(names.map(n => [n, {
  sessionProjections: { register: (d) => p.push(d.key) },
  tools: { register: (d) => (t.push(d.name), () => {}) },
  systemPrompt: { context: () => {} },
}[n]]))) })
console.log('投影:', p, '工具:', t)
"
```

应输出两个投影（`board`、`boardActivity`）与四个工具。**注意**：只看导出列表是不够的——M0 脚手架导出的 `PLUGIN_NAME` 和 `apply` 与 v1 完全一样，所以那种检查曾经给过假的安心。要证明注册发生了，就得真的调一次 `apply`。

卸载：从 profile 的 `dsh.profile.bundles` 与 `dependencies` 里移除 `dsh-superboard` 那一行，重跑一次 `pnpm install`。

**注意**：bundle 被启用时会追加到 bundle 列表末尾，而这会改变配置优先级——DSH 的已知行为。

**另一个坑**：`exports` 里要声明 `./package.json` 和 `./cordis.patch.yml`。DSH 读插件清单的主路径是按目录找 `package.json`（不看 `exports`），但存在一条 `require.resolve('<pkg>/package.json')` 的回退路径，缺了它那条路会静默失败。所有能工作的第三方插件都声明了它。

## 开发

```bash
npm test        # 230 个测试，node:test，无框架
npm run verify  # 测试 + 确认 host 半导出 apply()
```

### 目录结构

```
src/index.js        host 半入口：apply(ctx)，两个投影，常驻大纲
src/model.js        场景模型：schema、块/箭头/region 词汇表、areas 解析、hash 编码
src/fold.js         日志原生折叠：模型是 board_apply 调用序列的折叠结果
src/schema.js       文档 schema 与 wire schema（投影到浏览器的形状）
src/schema-dsl.js   手写的 JSON Schema 编译器（原因见下）
src/tools.js        四个工具的定义与渲染
src/activity.js     活动流投影
src/client.js       client 半入口：看板视图、阅读栏、框选反馈，原样下发
cordis.patch.yml    把本 bundle 插进 profile 的层栈
docs/design/        设计树、模型契约、里程碑计划
docs/research/      针对真实 DSH 0.2.0-rc.2 验证过的约束与 API 调研
scripts/            开发工具（官方包参考提取）
test/               230 个测试
```

### 三条源码约束

- **没有构建步骤，而且短期内不打算要。** client 半是手写的浏览器 JavaScript，用 `React.createElement` 构造元素——`dsh.client` 是**原样**下发 `src/client.js` 的，所以你改的就是跑的。只有需要代码分割（UML 那块）或类型检查时，打包器才变得必要。
- **`.ref/` 不进版本库。** 它存放官方包的只读提取物，调研结论都是对着它验证的。用 `node scripts/extract-dsh-ref.mjs` 重新生成。
- **`src/schema-dsl.js` 是手写的，不是偷懒。** `ctx.tools.register` 接收的是**已编译**的 JSON Schema，而官方的 `defineTool` 编译器在一个本插件不能导入的包里。所以这个 DSL 手工产出编译后的形状，测试再把每一份定义喂给 DSH 自己的 `assertSupportedJsonSchema` / `validateJsonSchemaValue`（直接从装好的应用里加载），确保它真的是 DSH 认的形状——包括它**不**支持的子集（`minItems`、`type` 数组等）。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [`docs/design/design-tree.md`](docs/design/design-tree.md) | 设计访谈的四轮问题与 15 条决定，含被否决的选项和原因 |
| [`docs/design/board-model.md`](docs/design/board-model.md) | 模型契约：块、容器、模板、箭头锚点、region、revision 语义 |
| [`docs/design/build-plan.md`](docs/design/build-plan.md) | 里程碑划分与各自的验收标准 |
| [`docs/research/dsh-plugin-contract.md`](docs/research/dsh-plugin-contract.md) | 逐条行号引用的框架约束清单（最容易踩的那些） |
| [`docs/research/dsh-plugin-api.md`](docs/research/dsh-plugin-api.md) | DSH 插件 API 全量调研：slot、服务、事件 |
| [`docs/research/dsh-host-plugin-api.md`](docs/research/dsh-host-plugin-api.md) | 宿主侧 API |
| [`docs/research/dsh-client-api.md`](docs/research/dsh-client-api.md) | 客户端 API |
| [`docs/research/dsh-render-runtime.md`](docs/research/dsh-render-runtime.md) | 渲染运行时 |
| [`docs/research/dsh-chat-reuse.md`](docs/research/dsh-chat-reuse.md) | 为什么复用不了官方对话渲染，以及绕行方案 |
| [`docs/research/dsh-composer-attachments.md`](docs/research/dsh-composer-attachments.md) | 怎么把自定义内容塞进输入框并随消息发出去 |
