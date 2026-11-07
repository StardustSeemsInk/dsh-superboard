# 2IRR20 教学经验与教师 Skill 改进建议

**来源**：2026-10-05 至 10-27，用 SuperBoard + Markdown 双产物教 TU/e 2IRR20《计算机网络》整门课（10 单元、4 个 Lab、2 套真题），直到期末笔试。
**读者**：改教师技能（`teaching-on-the-board`）、教师预设（`preset_teacher`）、以及下一次接手同类任务的人。
**体裁**：一手记录 + 可执行建议。**不是**产品契约，也不是模型说明。

**为什么另写一份**：`E:\Dev\dsh-superboard\docs\suggestions\teaching-method-observations.md`（10-15 那轮，2IV60 图形学）已经把「四步式 / 符号先解释 / 检查题要能手算 / 答错即拆小」写透了。这一轮**没有推翻那些结论**，但暴露了那十条**完全没有覆盖**的一整类问题：**当教学目标是应试、而材料本身是错的、而讲解对象是有标准答案的外部考卷时，会发生什么。** 那十轮是「怎么讲」，这一轮更多是「讲之前要先做对什么」。下面只写**新增**的部分，与旧文重叠的不再重复。

---

## 一、这次教的是什么（判据与结果）

| 项 | 值 |
|---|---|
| 课时范围 | 9 个课件 deck（`00` `01a` `01b` `02` `03` `04` `05` `06` `07`），**没有 `08`** |
| 交付物 | 看板 6 页 + 单元讲义 10 份（3,436 行、59 张课件原页）+ 练习详解 8 份（5,525 行、61 个题面）+ 两份考点总结（1,000 行） |
| 学生自己动手做的题 | 21 道（Ch1/Ch2/Ch3），**大部分一次就对**，错的 3 道全是收尾代数 |
| 我犯的错 | **4 处**，其中 2 处是数值/逻辑错误，2 处是「说了一个自己没验证的结论」 |

**最重要的一条前提，也是这次最省时间的一步**：2023 旧卷 110 分里，**48 分属于今年不教的内容**。先做这件事再开口讲课，等于把复习量砍掉 44%。**这一步不是教学，但它决定了教学有没有意义。**

---

## 二、做对了什么（可复用，按复用价值排序）

### 1. 先裁决范围，再讲第一个字

2026 年这门课去掉了安全章节（deck `08` 整体不存在），但旧卷还在流传。我没有直接讲旧卷，而是先把 110 分逐题拆成「范围内 62 / 超纲 48」，并给出**每条判据**（哪张 deck 的哪页讲没讲这件事）。

**建议**：教学开始前如果存在**范围不明**（旧考卷、旧教材、多版本课件），第一个动作必须是**范围裁决 + 登记**，并且把结论放在看板首页，而不是埋在某一页。

### 2. 讲之前先核对「页码能不能信」

deck `02` 的 PDF 有 103 页，页脚却编到 105 —— 因为**删掉了 Slide 7 和 Slide 83**。所以：

```
Slide 2–6   → PDF 页 k
Slide 7–82  → PDF 页 k+1
Slide 84–105 → PDF 页 k+2
```

其余 8 份 deck 都是 1:1。**这个偏移是我用 PyMuPDF 逐页正则匹配页脚 `Slide (\d+)` 算出来的，不是猜的。**

如果没查出来，讲义里所有「课件 p.X」都是错的，而且**看起来完全正常**。

**建议**：把「教材/课件页码 ↔ 实际页号」当成一次**必须执行、必须留证据**的校验；1:1 也要验。写进 skill。

### 3. 文本层不可信，重要处一律渲染成图再读

这一轮从 PDF 文本层抓出来的题干，损坏率**高得离谱**，而且是**系统性的**：

| 损坏 | 出现次数 | 例子 |
|---|---|---|
| `>` → `7` | ≥4 | `4 S/R 7 S/R + RTT 7 2S/R` |
| `×` → `#` | 3 | `s = 2.5 # 108` |
| `<` → `6` | 1 | `Rc 6 Rs` |
| 图的坐标轴刻度词条**插进题干中间** | 1 | P40 的 `0 / 2 / 4 / … / Congestion window size` 落在 d 与 e 两小问之间 |
| 整张图的伪代码粘在题尾 | 1 | P7 尾部粘了 Figure 3.60 的接收方 FSM |
| 页眉粘在题尾 | 2 | `PROBLEMS 199`、`HOMEWORK PROBLEMS AND QUESTIONS 315` |
| 转发表被拍平成一行 | 2 | P9 / P10 的 `Prefix / Interface / 00 / 0 / 010 / 1 …` |

**关键发现**：这些损坏**不在 OCR 层，在 PDF 自己的文本层**。也就是说，任何「用文本层提取」的做法都会继承它们，而且不会报错。

**建议**：
- 只要内容会进到最终材料（题干、公式、表格、数值），**必须渲染页面图核对**，150–400 dpi 足够。
- 特别要盯这五个字符对：`>`/`7`、`×`/`#`、`<`/`6`、`–`/`—`、`.`/`。`
- 表格只要跨了两列以上，文本层几乎必然是坏的，**一律按图重建**。

### 4. 学生的答案里，最有价值的不是对错，是「他错在哪一步」

21 道题里错的 3 道：

| 题 | 错因 | 性质 |
|---|---|---|
| Ch1 P6g | 公式对（`m = s·L/R`），但 `1.2×10⁻³` 写成 `1.2×10⁻⁴` | 算术 |
| Ch1 P23b | 两个时间表达式都对，**过度约分**成 `T ≥ L/Rc − L/Rs` | 代数 |
| Ch2 P22 | 公式全对，**没列表** | 没读题 |

**三道全是收尾，没有一道是思路。** 这个模式比「你哪里不会」有用得多：它直接给出了复习动作 —— **算完再验一次量纲或数量级**，10 秒换一整题的分。

**建议**：批改时**不只标对错，要归类错因**（思路 / 算术 / 代数 / 读题 / 表达）。连续两题同类，就把那类单独抽出来讲一次。

### 5. 官方样卷里的「陷阱原话」比答案值钱

2026 官方样卷自己在 Q1(a) 后面写了：

> A typical student mistake would be to find 4 seconds by subtracting the total transmission time (~200 sec) from the total time (600 sec) and dividing this by the #packets (100). Obviously, this computation would give you roughly the RTT (which also happens to be 4 seconds by coincidence). As such, such an answer cannot be accepted as the correct answer.

**错的算法和正确的算法在这道题上都得出 4 秒。** 老师明确说这种答案**不给分**。

**建议**：讲真题时，**答案和「为什么错也得到同一个数」要一起讲**。只讲正确答案，学生在考场上仍然会用错的方法得到对的数，并且以为自己会了。

### 6. 双产物里，文档才是真正被读的那个

上一轮已经记过「文档评价高于当场讲解」。这一轮更明确：

- 用户读完了全部 10 份讲义，然后说「**我已经把现有的 markdown 看完了，接下来我们可以围绕练习题进行复习**」—— 讲义阶段是**一次读完**的，看板是**过程**。
- 到后期，用户直接说「**后面的题……你直接整理成详解版吧，我没有精力做了**」—— 需要的是**可离线读的成品**，不是互动。

**建议**：文档不是看板的备份，是**主产物**。看板负责「讲的时候看什么」，文档负责「考前一天看什么」。

### 7. 允许自己错，但更正必须落在材料里

这轮我错了 4 次，两次是真错：

**① 判断题期望值。** 我先写「猜的期望收益为零」。用脚本一算：2026 规则是 `w ≥ c → 0`，**下界被削平了**，所以纯猜一题期望是 **+0.05**，全蒙 5 题期望 **+0.27/1.0**。只有 2023 那套 `2(c−w)` 才是期望 0。改在 `教纲.md` 和看板两处。

**② SR 窗口。** 我写「重传的 `pkt0` 不在收方窗口里」。脚本一推：`k=2, N=3` 时收方窗口走 `{0,1,2} → {1,2,3} → {2,3,0} → {3,0,1}`，**`pkt0` 正在窗口里**，于是被当成新包接受 → 重复交付。规则是 `N ≤ 2^(k-1)`，`N=2` 才对。改在讲义和看板两处。

**共同点：两次都是「我说了一个我没验的结论」，而不是「我算错了」。**

**建议（这条我认为最重要）**：教师 skill 应加一条硬规则 —— **凡是「X 在不在集合里」「这个值的量级是多少」「这个算法会不会退化」这类断言，必须用脚本或手算核一次再写。** 判断「这句话需不需要验」的判据：**它有没有一个能被机器算出来的答案。**

### 8. 看板图**静默失败**过

`unit-map` 那张 mermaid 图根本没渲染出来，用户报「渲染失败/图没有加载出来」。查下来：

- mermaid 标签里只要出现 `<br/>`，它会往 XHTML 的 `foreignObject` 里写一个**未闭合的 `<br>`**
- superboard 把 SVG 通过 `data:image/svg+xml;charset=utf-8,...` 交给浏览器
- 浏览器按**严格 XML** 解析 → 解析失败 → `<img>` **静默不加载**

而 `mermaid.render()` 本身**成功了**，所以渲染失败上报**不会触发**，`board_outline` 里**一条诊断都没有**。

**修法**：标签写在一行里，用 `·` 和括号代替 `<br/>`。

**建议**：这是一类**「成功的失败」** —— 系统认为成功，用户看到空白。教师 skill 应提示：**看板上出现空白区域时，先怀疑渲染，不要怀疑自己没写。**

---

## 三、我做得不好的（诚实缺口）

### 1. 检查题做成了「每单元一题」，而 skill 写的是「每块一题」

`teaching-on-the-board` 的原文是 `One question per concept`，我实际执行的是**每个单元末尾一题**（单元 1、2、3、4 各一题，答完进下一单元）。

**结果没坏** —— 用户把单元 1–4 的检查题全答对了 —— 但这是**运气**：单元内容不多，一题正好覆盖。如果某个单元里有一块讲砸了，单元末那题**可能压根不考那一块**，我就收不到信号。

**正确做法**：单元内每 2–3 个概念块后停一次，而不是整单元一次。这条我建议**写进 skill 的反例**，因为「每单元一题」看起来很像对的做法，做起来也省事。

### 2. 前 4 个单元的讲义漏了「容易搞错」和「考点」

用户早就有 `学习教纲格式` 这个偏好，明确要求**每节末独立一段「容易搞错」，说明为什么会搞错，不只给结论**。单元 1–4 我**没有照做**，是写到单元 5 才发现，然后回头补的。

**教训**：**偏好文档要在开工前逐条对照一遍**，不能边写边回忆。特别是那种「格式类」偏好，漏了不是写得差一点，是**整批返工**。

### 3. 练习文档的形态，是被用户催了两次才对的

- 第一版：只有中文详解 + 标答
- 用户要：**加中英对照的标准答案**（考场要用正确英文写）
- 用户再要：**加题目原文和翻译**（「现在只有详解和标答」）

**这两次都是我先交了一个「够用但不是他要的」东西。**

**正确形态应该一次到位**：

```
### 题目原文   ← 教材/考卷逐字英文（引用块，子问各一行）
**题目翻译**   ← 中文全译
### 中文详解   ← 四步式
### English model answer  ← 考场直接抄
## 本章总结   ← 考点表
```

**建议**：写进 skill —— **只要材料有英文原文，第一版就必须带原文 + 翻译**，不要等学生来要。

### 4. 子代理的 briefing 里，我自己写错了三处

Ch5 那次我给的 brief 有错：

| 我给的 | 实际 | 后果 |
|---|---|---|
| P4 网络 12 条边（漏 `v–x = 3`） | 含 `v–x` | 漏掉会让 9 组最短路径偏大 |
| P14 网关 `3a` 面向 AS4 | `3c` 面向 AS4、`3a` 面向 AS1 | a、b 两问答案**整体反转** |
| P17 的 `Y` 视图在 Figure 5.13 里 | 是题干后**单独一张小图** | 整题立意失效 |

**救回来的唯一原因**：我 brief 里写了「**以 PDF 原件为准，我的说明可能有错**」，子代理真的去核了，并且**逐条报告了与 brief 的冲突**。

**建议**：派发提取类任务时，brief 里必须含这句授权，并要求回报「与 brief 不一致的地方」。这不是客套，这是**唯一能让错误在交付前暴露的机制**。

### 5. 有一次我差点自己捏造来源

子代理自查时发现自己写过「流传的答案里有 21 和 24 两个版本」「常见口述认为 3a 面向 AS4」—— **它并没有这些外部来源**。它删掉了。

同类风险我自己也有过：写 P40 时差点写成「多数解答认为 ssthresh 是 24」。**事实是**：教材那张图的数据点是 24，而严格 Reno 除法给 `42/2 = 21`，`24 = 21 + 3` 正好是 `cwnd = ssthresh + 3` 的快速恢复膨胀量。这是**图和公式的已知不一致**，不是「多数解答怎么认为」。

**建议**：禁止「某某资料说」「常见解法是」这类**无出处归因**。要么给可复核的依据（页码、行号、命令输出），要么明说「这是我的推断」。

---

## 四、对 `teaching-on-the-board` 技能的改进建议

按**改动价值**排序。每条都给了可以直接写进 SKILL.md 的措辞。

### 建议 A（最高价值）：加一节「教之前：范围与页码」

现在的 skill 从「先把地图放上看板」开始，**跳过了所有教学之前的核对工作**。建议在前面插一节：

```markdown
## Before the first block: scope and page numbers

If the material has a history — an older exam still circulating, a textbook edition
that differs from the slides, a deck that was revised — decide what is *in scope*
before teaching anything, and put that decision on the map page rather than in a
footnote. In one course this removed 48 of 110 exam points from the revision load.

Page numbers you cite must be verified against the file, not assumed. A deck can have
a footer numbering that differs from its PDF page count (deleted slides leave no gap
marker). Check every deck, including the ones that turn out to be 1:1, and record
how you checked.
```

### 建议 B：加一节「提取出来的文本要验」

```markdown
## Extracted text is a hypothesis, not a source

A PDF's own text layer — not just OCR — routinely corrupts exactly the characters a
technical question depends on: `>` becomes `7`, `×` becomes `#`, `<` becomes `6`.
Figure axes and code listings bleed into the middle of a question, and running
headers land at the end of it. None of this raises an error.

Render the page and read it before quoting anything that carries a number, a formula,
or a table. A table spanning more than two columns is almost always damaged.
```

### 建议 C：把「检查题每块一题」写成**反例**

现在的措辞是 `One question per concept`，太容易被理解成「一个概念一个大题」。建议改成：

```markdown
## A check question belongs at the end of its block

One question per concept, then stop. Pause every two or three concept blocks, not once
per unit: a single question at the end of a unit looks like compliance and tests almost
nothing — the unit's one question may not touch the block that was unclear.
```

### 建议 D：加「材料本身的错误」与「静默渲染失败」两节

```markdown
## When the material contradicts itself

Adjacency with the source is not the goal; correctness is. When a slide contradicts its
own figure, adjudicate with a third source, say which way you ruled, and keep the
correction in one findable place — not a footnote on the page it came from.

## A blank area may be a rendering failure

A diagram can fail to render while every API call reports success. On this board,
mermaid labels containing `<br/>` produce an unclosed `<br>` in the XHTML
`foreignObject`; the SVG is then served as a strict-XML `data:` URL and the image
silently never loads, with no diagnostic. Keep mermaid labels on one line. When
something looks empty, suspect the renderer before suspecting the content.
```

### 建议 E：写死练习/讲义文档的形态

```markdown
## The write-up's shape

A unit write-up and an exercise solution are different artifacts:

- Unit: four-step explanations, a 「容易搞错」 paragraph per section that explains *why*
  the mistake happens, a hand-computable check question, and a 考点 list.
- Exercise: the **verbatim original question**, its **translation**, then the working,
  then a model answer in the exam's own language.

Put the original text in from the first version. A solution that omits it will be sent
back.
```

### 建议 F：加「学生答错时的归因」

```markdown
## Grade the error, not just the answer

When a learner's answer is wrong, name the layer: reasoning, arithmetic, algebra,
misread question, or exposition. Three wrong answers that are all algebra is a
revision action ("recheck the magnitude after every derivation"), not three separate
gaps.
```

---

## 五、对 `preset_teacher` 的建议

1. **把「验证优先」写进 persona。** 现在的 persona 是讲解者；这一轮真正起作用的另一半是**校对者** —— 核对范围、核对页码、核对文本层、核对断言。建议在 prompt section 里加一条：*Before teaching a claim, decide whether that claim has a machine-checkable answer; if it does, check it.*

2. **给「我上一条讲错了」一个正式位置。** 旧文已经建议允许自我纠正。这一轮补充：**更正要写成材料里的一条（勘误块），并且要说明「原来错在哪」**，不是悄悄改掉。用户后来在勘误表里累计登记了 9 条，这是可复习的资产。

3. **禁止无出处归因。** 明确写：不要写「常见解法认为」「多数资料显示」。要么给页码/行号/命令输出，要么写「这是我的推断」。

4. **双产物的默认顺序。** 现在的默认是「看板是现场、文档是成品」。建议改成：**先保证文档能独立读，再把看板做成它的导览**。这一轮的顺序相反（先看板后文档），结果是文档后来被大改了三轮。

---

## 六、给下一次的三句话

1. **先裁决范围，再讲第一个字。** 旧考卷里可能有 40% 是今年不教的。
2. **凡是有机器可算答案的断言，都算一遍再写。** 我这一轮两次真错，都错在「没验就说」，不是「算错」。
3. **文字层的 PDF 是可疑证人，不是证据。** 渲染出来看一眼，比读一百行提取文本可靠。

---

## 附：这一轮的硬数字（供复核）

| 项 | 值 |
|---|---|
| 讲义 | 10 份 / 3,436 行 / 59 张图 |
| 练习详解 | 8 份 / 5,525 行 / 61 个题面块 |
| 考点总结 | 2 份 / 1,000 行 |
| 看板 | 6 页 / 15 条边 |
| 范围裁决 | 旧卷 110 分 → 范围内 **62**、超纲 **48** |
| 材料勘误 | **9** 条：课件印错 2、编号笔误 1、内容留白 1、教材补充 2、图被动画污染 1、幻灯片跳号 1、教材与课件范围优先级 1 |
| 我犯的错 | **4** 次（数值 2、未验证断言 2），全部已改在材料里 |
| 学生自做题 | 21 道，错 3 道，**全部是收尾** |
