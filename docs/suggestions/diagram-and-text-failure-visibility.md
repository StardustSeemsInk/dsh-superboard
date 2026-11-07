# 一份改进建议：图形与长文本的失败不可见（2026-10-30）

> 来源：一个外部使用会话。该会话在一块 **17 页 / 63 边**的看板上工作，其中 7 张 `uml` 块，用户报告其中 4 张渲染失败。下面写的每一条都在这套代码上**实测过**，不是读出来的推测。
>
> 标注：**[实测]** = 我跑了代码并核对了输出；**[实读]** = 只读了代码，没跑。

---

## 结论先说

**四张图渲染失败，根因是一个字符：mermaid 输出的 `<br>` 没有闭合。** 但真正值得改的不是那个字符，是**这类失败为什么会完全静默**——

> 只要渲染函数**返回了** SVG，无论它是不是良构，看板都认为成功。而看板把 SVG 交给 `<img>` 的方式（`data:` URL）要求它是**严格 XML**。两者之间没有任何检查。

**同一形状的失败对长文本同样成立**，而且是更常见的那个：超过高度上限被折叠的块、被截断的 `maxChars`、被丢掉的 `created[]`——都是「渲染函数成功了，产物不可用」。

---

## 1. 缺陷本身：`<br>` 让 SVG 不是良构 XML

### 1.1 现象与定位 [实测]

| 块 | 源码里的 `<br>` 数 | mermaid 输出 | 严格 XML 解析 |
|---|---|---|---|
| `toolkit-design/td-tree` | 12 | 含未闭合 `<br>` | **MALFORMED** |
| `main/proof-uml` | 5 | 同上 | **MALFORMED** |
| `necessity/n-uml` | 7 | 同上 | **MALFORMED** |
| `deps/d-uml` | 6 | 同上 | **MALFORMED** |
| `positioning/p-uml` | 0 | 无 `<br>` | ok |
| `protocol/pr-layers` | 0 | 无 `<br>` | ok |
| `chain/ch-tri` | 0 | 无 `<br>` | ok |

**相关性 4/4 与 0/3。** 用仓库自带的 mermaid **11.17.2** 在 Node 里复现（需要 jsdom + `CSSStyleSheet` + `getComputedStyle` + `SVGElement.prototype.getBBox`/`getComputedTextLength` 四个 polyfill，缺一个就报 `CSSStyleSheet is not defined` 或 `r.node(...)?.getBBox is not a function`）。

**实际输出片段**（注意 `htmlLabels: false` 已设，仍然如此）：

```html
<foreignObject width="0" height="0"><div ... xmlns="http://www.w3.org/1999/xhtml">
<span class="nodeLabel"><p>Q1 范围<br>引擎内部不动</p></span></div></foreignObject>
```

`htmlLabels: false` **并不能阻止 mermaid 输出 `foreignObject`**（两种模式下 `fo=true` 都成立）。所以这个开关不是出路。

### 1.2 为什么完全静默 [实读]

`src/client.js:1956` 的 `mermaid.render(...)` **成功返回**，`:1960` 进入 `status: 'ready'`；只有**抛出**才会走到 `:1963-1968` 的 `reportRenderFailure`。而失败发生在更后面一步——`svgDataUrl`（`:1794`）把它编码成 `data:` URL，交给 `<img>` 时浏览器按严格 XML 解析，失败。**`<img>` 的解码失败没有任何回调能进到看板的状态机里。**

### 1.3 修法 [实测]

在 `svgDataUrl` 里把 `<br>` 规范成 `<br/>`：

```js
function wellFormedSvg(svg) {
  // A tag that already ends in `/` is left untouched: `<br />` must not become `<br //>`.
  return svg.replace(/<br(\s[^>]*)?>/gi, (tag, attrs) =>
    (attrs !== undefined && attrs.trimEnd().endsWith('/') ? tag : `<br${attrs ?? ''}/>`))
}
```

**实测验证**：7 张真实图中 4 张 `raw=MALFORMED → fixed=ok`，3 张无 `<br>` 的 `raw=ok → fixed=ok`（**不回归**）。`test/render.test.js` 加了 2 条，全量 **491 个用例通过**。

**注意那个 `endsWith('/')` 判断不是防御性编程**：第一版正则写成 `<br(\s[^>]*)?>` → `<br$1/>`，把 `<br />` 变成了 `<br //>`。**是我自己新写的回归测试当场抓到的**——见第 3 节。

### 1.4 试过但无效的方案（省得别人重走）

| 方案 | 结果 |
|---|---|
| `XMLSerializer` 重序列化 | `<br>` 确实变成 `<br />`，**但整份文档仍然 MALFORMED**。不是出路 |
| 标签内改用真实换行 `A["第一行\n第二行"]` | mermaid 照样生成 `<br>`，仍然 MALFORMED |
| 用 `htmlLabels: false` 关掉 HTML 标签 | 无效，仍然输出 `foreignObject` + 未闭合 `<br>` |
| 在 `mermaid.render()` 前面包 try/catch | 无效，它根本不抛 |
---

## 2. 更要紧的：这一类失败有同一个形状

把上面那件事抽象一下，形状是：

> **一个「产出物」被函数成功返回了，但它的可用性取决于一件没有任何人检查的事。**

看板上有**至少四种**这种情况。第一种就是刚才那张图。

| # | 产出物 | 可用性取决于 | 今天的检查 |
|---|---|---|---|
| **A** | mermaid 的 SVG | 是不是严格 XML | **无** |
| **B** | 一行超长文本 / 一个超出卡片高度的块 | 有没有被 `overflow` 或高度上限裁掉 | **无** |
| **C** | `board_read` 返回的字符串 | 有没有被 `maxChars` 截断 | 有 `truncated` 字段，但**只有调用方去看它才生效** |
| **D** | `board_apply` 的 `created[]` | id 是否可用 | 有（`board-bugs.md` I8 已修） |

**A 和 B 是同一类**：渲染出来之后，**没有任何人回头看一眼它到底长什么样**。

### 2.1 B 类：长文本被裁剪，而且裁得看不出来

我在这次会话里遇到过：一个 `prose` 块写满之后被容器截断，**没有省略号、没有「展开」入口**。读者看到的是「话说完了」，而不是「话被切了」。

这条我没有逐行核对 `src/` 的溢出规则——**所以它是本文件里唯一的 UNVERIFIED 条目**——但它的判据与第 1 节完全相同：*失败必须是可观测的*。建议很朴素：**内容超出容器时，必须有可见的截断标记**（渐变、省略号、或「还有 N 行」）。

> **2026-11-07 复核：这条在本仓库的渲染器上不成立，建议不改。**
>
> 用 `video/scenes/_probe-clipping.html` 实测了四种会把盒子尺寸交给容器的布局——`flow`、命名格子的 `grid`（`areas`，卡片被拉成槽位）、`grid`、`masonry`——每张卡片都量了 `clientHeight` / `scrollHeight` / `overflowY`：
>
> | 布局 | 40 段文字的卡片 | 裁切？ |
> |---|---|---|
> | `flow` | `1872 / 1872`，`overflow-y: visible` | 否 |
> | `areas` 槽位 | `2672 / 2672` | 否 |
> | `grid` | `2672 / 2672` | 否 |
> | `masonry cols:3` | **`4272 / 4272`** | 否 |
>
> 全部 `scrollHeight === clientHeight`，**卡片长到内容那么高**，再由 `.sb-canvas`（`overflow:auto`）滚动。整份样式表里带高度上限的只有 `.sb-diagram`（`max-height:560px`，且它自己也 `overflow:auto`）。
>
> 阅读栏是唯一会「滚动着藏起来」的容器（`clientHeight 702 / scrollHeight 5348`），但它**有滚动条**，所以那是「往下翻」，不是「话说完了」——与第 1 节那个静默失败不同类。
>
> 也就是说：**「渲染成功、产物不可用」这个形状对长文本不成立**，它成立的地方是别的——`maxChars` 截断的读取结果（§2.2）、以及真正会抛掉内容的容器。这条保留在文档里是因为**它被证伪本身有用**：下一次有人怀疑同一件事，先看这张表，不要再花一轮去查。

### 2.2 C 类：`truncated` 是一个「需要调用方自觉」的契约

`board_read` 与 `board_outline` 都返回 `truncated` 与 `omitted`。**这比静默截断好得多**，但它属于「调用方必须去看」的那一类——一个 Agent 完全可能在 `truncated: true` 的情况下继续按不完整的列表工作。

不需要改结构，只需要一条使用约定：**任何 `truncated: true` 的读取结果，都必须先降页或降 `maxChars` 重读，再下结论。**

> **2026-11-07 已按这条改了 `renderOutlineText`。** 原来被截断的文本只以 `… truncated at N characters` 收尾——那是一句脚注，而 `truncated: true` 是一个模型**要记得去读**的字段。被防的那个失败是「看板读起来就像到此为止」，而模型接下来那句话是根据它刚读到的东西写的。
>
> 现在那句话是一条指令：「… N line(s) are NOT shown above, so this is not the whole board. Do not draw conclusions about what is absent (deletions, gaps, empty pages) from this. Call this tool again with a larger maxChars, or read a specific page with board_read, before editing.」
>
> 特意点名「不要从缺失去推断」：截断之后，一个**不存在**的块和一块**没显示出来**的块在读到的文本里长得一样，而删除、留白、空页这三类判断全靠这个区别。

---

## 3. 三条更一般的建议

### 3.1 让「产物不可用」有一条回来的路

现在渲染的状态机只有 `loading / ready / failed`，而 `failed` 只由**抛出**触发。建议加一种：`ready-but-unusable`——渲染函数返回了，但产物过了一道**可用性检查**没过。

对 SVG 这一格，检查很便宜：**用 `DOMParser` 以 `image/svg+xml` 解析一次，看有没有 `parsererror`**。一次同步调用、几毫秒，就能把「静默空卡」变成「显示源码 + 一句为什么」。

### 3.2 每个「成功」都该有一个「产物长什么样」的检查

第 1 节的 bug 之所以活到现在，是因为**测试全是纯函数测试**：`svgDataUrl` 的旧测试断言的是「URL 里没有 `<` 和引号」——它测的是**转义**，不是**产物能不能用**。

**新加的测试换了个问法**：不是「输出里有什么」，而是「把输出解回来，它还是不是一份能用的文档」。这一条对 `diagramNodeTable`、`fileUrl`、以及将来的 PDF 渲染都成立。

### 3.3 我踩到的一处文档缺口

`docs/design/board-design-notes.md:114` 已经写清楚「图用 `<img src="data:image/svg+xml…">` 呈现」，**但没有写下半句**：这意味着 SVG 必须过**严格 XML**，而不是浏览器那种宽松的 HTML 解析。

这半句是这类 bug 的全部成因。**建议补上**，并顺手记下「`htmlLabels: false` 不能解决它」——我自己就先试了那个开关。

---

## 4. 复现与验证（供维护者复核）

| 步骤 | 做法 | 期望 |
|---|---|---|
| 复现 | 用 jsdom 起 `document`，补 `CSSStyleSheet` / `getComputedStyle` / `getBBox` / `getComputedTextLength` 四个 polyfill，`mermaid.render` 一张含 `<br/>` 的流程图，再用 `DOMParser` 以 `image/svg+xml` 解析 | `parsererror`，原文 `unexpected close tag` |
| 验证修法 | 对同一 SVG 跑第 1.3 节的正则，再解析一次 | 通过 |
| 回归 | `npm test` | 491 通过 |

**改动的文件**：`src/client.js`（新增 `wellFormedSvg`，`svgDataUrl` 调用它，exports 导出）、`test/render.test.js`（新增 2 条）。**未提交**——工作区改动留给你审。
