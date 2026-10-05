# 参与开发

面向**维护者**的说明。想先知道这是什么、长什么样，看 [`README.md`](README.md)。

---

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

## 测试

```bash
npm test        # 400 个测试，node:test，无框架
npm run verify  # 测试 + 确认 host 半导出 apply()
```

## 目录结构

```
src/index.js        host 半入口：apply(ctx)，两个投影，常驻大纲
src/model.js        场景模型：schema、块/箭头/region 词汇表、areas 解析、hash 编码
src/fold.js         日志原生折叠：模型是 board_apply 调用序列的折叠结果
src/schema.js       文档 schema 与 wire schema（投影到浏览器的形状）
src/schema-dsl.js   手写的 JSON Schema 编译器（原因见下）
src/tools.js        四个工具的定义与渲染
src/activity.js     活动流投影
src/uml.js          从 mermaid 源码里读出节点表（块内锚点用）
src/diagnose.js     宿主侧的 mermaid 廉价校验（折叠时同步跑）
src/runtime.js      浏览器侧运行时路由：mermaid、pdf.js、渲染失败上报
src/pdf.js          宿主侧 PDF 解析：文本层与归一化坐标，供块内锚点使用
src/preset.js       预设内的角色提示词（`dsh-superboard/preset` 子路径导出）
src/skill.js        Agent 面向的文档提供者（`dsh-superboard/skill` 子路径导出）
skills/             技能正文，一个目录一个技能
src/client.js       client 半入口：看板视图、阅读栏、框选反馈，原样下发
cordis.patch.yml    把本 bundle 插进 profile 的层栈，并声明三个 agent 预设
docs/design/        设计树、模型契约、里程碑计划
docs/research/      针对真实 DSH 0.2.0-rc.2 验证过的约束与 API 调研
docs/assets/        文档与 README 里引用的图（含宣传片的 GIF 与海报）
scripts/            开发工具（官方包参考提取、vendor 重建）
test/               400 个测试
video/              发布宣传片的工程（分镜、场景、配乐合成、构建）
vendor/             随包发布的第三方运行时：mermaid、pdf.js、React
```

## Agent 怎么学到看板怎么排版：`board-layout` 技能

四个工具描述**就是** Agent 免费拿到的全部文档面，而它们要**每个请求**都发一遍。所以那里只放
「调用之前必须知道的事」，放不下「写完之后会长成什么样」。而后者恰恰是问题所在：一个 Agent
可以完全按 schema 写出一块合法看板，却因为**看不到画布**而排得很难看——标题和它的列表变成两张
互不相干的卡、短卡旁边留着大片空白、靠「相邻」表达归属而一换窗口就散架。

`skills/board-layout/SKILL.md` 就是这份文档。它以**技能**形式注册（`src/skill.js` 自己实现
provider，不 `import` 官方包），所以目录里只多一行 `name: description`，正文只在 Agent 决定要看
时才被拉取——写一次的成本由真正画看板的那次会话付。

里面写的是从渲染器里读出来的、schema 看不出来的东西：每种模板真实的 CSS、**group 自己也是排版容器而且能嵌套**、哪个字段会让卡高等高、行优先还是列优先、`columns` 的列数按页面宽度而不是卡片宽度夹取、`region` 其实不包住任何东西、哪些字段**完全没有视觉效果**，以及一条「调用
`set_layout` 之前的自查清单」。

改这份技能时注意：`test/skill.test.js` 会把它的关键论断逐条钉住。**这不是形式主义**——这份文档
是 Agent 唯一会读到的排版说明，它和渲染器漂移的代价是一整类排得难看的看板，而且没人会收到报错。
所以补一条新论断时，顺手补一条测试。

## 三个 agent 预设

`cordis.patch.yml` 除了挂载插件本体，还声明三个**看板专属**的预设：`engineer`、`teacher`、
`researcher`。它们必须依赖看板——教师在上面讲课、研究员在上面给结论、工程师被引导正确上手
——所以和插件装在同一个 bundle 里，而不是各自独立发包。

三条实现约束，都是实测出来的：

- **必须是新行，不能覆盖官方的 `preset-standard` / `preset-ptc`。** 覆盖会替换整个 `config`
  （`editing-cordis-compositions/SKILL.md:56`），而这个仓已经为此付过账：profile 里那份
  billion-context 覆盖的注释就写着「DSH upgrades that change those presets will NOT merge into
  these overrides」。新 id 让官方预设保持原样，DSH 升级时照常生效。
- **`insert` 塞不进官方预设的 `plugins` 列表。** 预设行不是 `group: true` 行，Loader 会回
  `patch insert: entry "preset-standard" is not a group`。所以每个预设都得把所依据的官方插件表
  重述一遍——这是「基于官方模式」的代价。共用的大块用 YAML **锚点**（实测锚点能穿过 Loader 的
  解析与 patch 组合），所以只写一次。
- **三个预设都不带 `compaction` 组。** 本 profile 用 billion-context 取代官方压缩，而它够不到
  自己没有声明的预设行——这正是 profile 自己也重述那两个预设的原因。副作用是：**在没有
  billion-context 的 profile 里，这三个预设的 agent 将完全没有压缩。** 换 profile 时要把
  `compaction` 组从上游预设里抄回来。

角色提示词走 `dsh-superboard/preset` 这个子路径导出，在预设**内部**调
`ctx.systemPrompt.section()`——因为它是 scope 绑定的，所以那段话只对**本预设**的 agent 可见，
不会污染其它预设或普通部署。用 `section` 而不是 `context`：后者每步重算并以 user 快照追加在
历史末尾，而「这个角色怎么工作」是静态的，属于系统前缀。

**教师预设目前是未完成的**：TTS 留待后续，而且它与另外两个预设的「回复前检查看板」差异还没有
明确结论（要么补上，要么写清为什么不需要）。见看板 `stage5` 页。

## 四条源码约束

- **没有构建步骤，而且短期内不打算要。** client 半是手写的浏览器 JavaScript，用 `React.createElement` 构造元素——`dsh.client` 是**原样**下发 `src/client.js` 的，所以你改的就是跑的。只有需要代码分割（UML 那块）或类型检查时，打包器才变得必要。
- **`.ref/` 不进版本库。** 它存放官方包的只读提取物，调研结论都是对着它验证的。用 `node scripts/extract-dsh-ref.mjs` 重新生成。
- **`src/schema-dsl.js` 是手写的，不是偷懒。** `ctx.tools.register` 接收的是**已编译**的 JSON Schema，而官方的 `defineTool` 编译器在一个本插件不能导入的包里。所以这个 DSL 手工产出编译后的形状，测试再把每一份定义喂给 DSH 自己的 `assertSupportedJsonSchema` / `validateJsonSchemaValue`（直接从装好的应用里加载），确保它真的是 DSH 认的形状——包括它**不**支持的子集（`minItems`、`type` 数组等）。
- **派生数据不进模型，只进投影或宿主侧易失存储。** `areas` 解析出的格子、`nodeHints` 读出的节点表都走前者；`RenderReports`（浏览器观测）与 `PdfFacts`（宿主解析出的文本层和页数）走后者。原因不是洁癖：投影的 `apply` 是**同步**的，而 PDF 解析是 I/O；就算异步算完写回 state，投影也只在 `apply` 返回新值时才重新发布，那个改动是隐形的。删掉 `pdf-page.pageCount` 就是为了这条——它是「模型里存了一个谁也写不进去的字段」。

## 文档索引

`docs/design/` 是设计与契约，`docs/research/` 是针对真实 DSH 0.2.0-rc.2 **逐条验证过**的调研。
后者的价值在于「每条论断都带 `file:line` 证据」，所以不要在没有证据的情况下改它们。

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [`docs/design/design-tree.md`](docs/design/design-tree.md) | 设计访谈的四轮问题与 15 条决定，含被否决的选项和原因 | 活文档（头部日期与第 13 条已过时） |
| [`docs/design/board-model.md`](docs/design/board-model.md) | 模型契约：块、容器、模板、箭头锚点、region、revision 语义 | **活文档**，唯一跟上了代码的一份；但 §3 写着「五个工具」，实际是四个 |
| [`docs/design/build-plan.md`](docs/design/build-plan.md) | 里程碑划分与各自的验收标准 | **历史**：停在 M5 / 82 个测试，之后的 UML、PDF、图片、文字选择、masonry 都没进去 |
| [`docs/research/dsh-plugin-contract.md`](docs/research/dsh-plugin-contract.md) | 逐条行号引用的框架约束清单（最容易踩的那些） | 活文档（是下面那份的浓缩） |
| [`docs/research/dsh-plugin-api.md`](docs/research/dsh-plugin-api.md) | DSH 插件 API 全量调研：slot、服务、事件 | 活文档 |
| [`docs/research/dsh-host-plugin-api.md`](docs/research/dsh-host-plugin-api.md) | 宿主侧 API：导出形态、加载链、打包安装 | 活文档 |
| [`docs/research/dsh-client-api.md`](docs/research/dsh-client-api.md) | 客户端 API：slot 属性合并顺序、standard kit、hook | 活文档 |
| [`docs/research/dsh-render-runtime.md`](docs/research/dsh-render-runtime.md) | 渲染运行时：能 require 什么、能栅格化什么 | 活文档（§11 已被下面那份取代） |
| [`docs/research/dsh-client-rendering.md`](docs/research/dsh-client-rendering.md) | 同上，更长：loader、bundle 路由、CSP、文档预览的字节路径 | 活文档（引用请用这一份） |
| [`docs/research/dsh-markdown-capabilities.md`](docs/research/dsh-markdown-capabilities.md) | DSH 原生 markdown 就渲染什么（KaTeX、mermaid、图表） | 活文档 |
| [`docs/research/dsh-chat-reuse.md`](docs/research/dsh-chat-reuse.md) | 为什么复用不了官方对话渲染，以及绕行方案 | 活文档（阅读栏的设计依据） |
| [`docs/research/dsh-image-to-model.md`](docs/research/dsh-image-to-model.md) | 工具能不能把图片交回模型：`ImageBlock` 与 `output.render` | 活文档（`board_snapshot(region)` 的闸门） |
| [`docs/research/dsh-composer-attachments.md`](docs/research/dsh-composer-attachments.md) | 怎么把自定义内容塞进输入框并随消息发出去 | **调研已用尽**：它得出的结论是「草稿这条路走不通」。留作那条结论的证据 |
| [`skills/board-layout/SKILL.md`](skills/board-layout/SKILL.md) | 给 Agent 看的排版说明 | 活文档，**且比 `docs/` 更新**——以它为准 |
| [`docs/assets/`](docs/assets/) | 文档与 README 引用的图（含宣传片的 GIF 与海报） | — |
| [`video/README.md`](video/README.md) | 宣传片工程：分镜、真实渲染做法、复现步骤 | 活文档 |

**已知的漂移**（记在这里，改的时候顺手修）：`README.md` 曾写「357 个测试」，实际 400；
`board-model.md:750` 的「五个工具」里包含一个从未实现的 `board_feedback`；`board-model.md` §4.5
自己承认那张模板表是评审前的、已被 `skills/board-layout/SKILL.md:42-49` 取代。
