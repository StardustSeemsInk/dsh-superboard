# 2IV60 全解与综合卷：讲解形态的经验与 Skill 改进建议

**来源**：2026-10-30 至 11-04，用 SuperBoard + Markdown 双产物给 TU/e 2IV60《计算机图形学》做期末复习资料：16 份单元讲义（含 26 道检查题）、13 份历年卷全解、1 份综合卷（78 填空 + 23 大题）、1 份全课知识点总结、1 份勘误台账。
**读者**：改教师技能（`teaching-on-the-board`）、教师预设（`preset_teacher`）、以及下一次做「有标准答案的应试材料」的人。
**体裁**：一手记录 + 可执行建议。不是产品契约。

**为什么又写一份**：`docs/suggestions/` 下已有两份——`teaching-method-observations.md`（10-15 那轮，讲四步式与符号解释）与`教学经验与教师skill改进建议-from-2IRR20.md`（讲**讲之前**要先做对什么：范围裁决、页码校验、文本层不可信、材料矛盾）。这一轮**没有推翻它们**，但从用户嘴里拿到了一条那两份都没覆盖、而且比它们都更硬的判据：**讲解的形态本身就是正确性的一部分**。

用户的原话（2026-11-04）：

> 填空题都没啥问题。但是你给的大题的讲解基本上对我应试复习没有太多用处——你给的讲解基本上是类似于「证明为什么答案是对的」，但是我需要的是「如何推导/解答以得到答案」，另外，对于简答题和大题，我需要中英对照的解题过程。

这条反馈把我此前认为「写得很扎实」的 23 道大题全部推翻了。下面只写新增的部分。

**这份文档后来追加了一节（第二节第 5 条）**，因为它差点被上面这条反馈引向一个错误的推而广之：把讲义**正文**也改成推导式。用户最后的裁定是「不加」，理由是一句话——**正文是为了理解知识，不是为了理解怎么答题**。这条边界比前面四条都更容易被踩到，所以单独立了一节，并在建议里加了 G、H 两条。

---

## 一、这次交付了什么，以及错在哪一步

| 项 | 首版 | 用户判定 | 重写后 |
|---|---|---|---|
| 填空题 78 题 | 答案 + 一句理由 + 出处 | **没问题** | 未改 |
| 大题 23 道 | 答案 + 四步式 + 易错 + 官方英文答案 | **对应试没用** | 怎么下手 → 推导 → 答案 → English solution → Answer |
| 单元讲义 **检查题** 16 份 | 多数只有「题 + 答案」，单元 5 甚至**完全没有答案** | 同上一条反馈追溯适用 | 同一套五块结构，16/16 中英步骤严格对齐 |
| 单元讲义 **正文** 16 份 | 四步式 + 易错 + 课件原页图 | **用户明确说不用改** | **未改** |
| 全解 13 份 | 题面 + 翻译 + 详解 + 英文答案 | 未评价 | 未改 |

同一份讲义里，**检查题改了、正文没改**——这是用户最后拍板的边界，也是这份文档后来才补上的最重要一条（见第二节第 5 条）。

**关键的不对称**：同一套写法，用在填空上用户满意，用在大题上用户说没用。区别不在详略，在**读者拿它做什么**。

- 填空题：读者只需要在考场上**回忆一个词**。答案 + 一句理由就够了。
- 大题：读者需要在考场上**复现一整条推导**。给他「答案以及为什么这个答案对」，等于给他一份验尸报告——能看懂尸体是怎么死的，但没法让他自己走一遍这条路。

我当时的四步式（场景 → 算一遍 → 命名 → 用途）是**为了讲懂一个概念**设计的，它在讲概念时很好。但大题不是概念，是**流程**。流程需要的是步骤编号、每步的输入输出、以及「看到题面哪个词该想到哪个工具」。

---

## 二、这一轮真正新增的五条判据

### 1. 「证明为什么对」与「怎么得到」是两种文体，且不可互相替代

同一个结论，两种写法：

**核对式**（我首版写的）
> 答案是 `a = 1`。验证：把 `a = 1` 代入 `P'(1/2) = (3/4)(−P₀ − P₁ + P₂ + P₃)` 得 `(0, 4.5)`，与 `AD` 方向 `(0,3)` 叉积为 0，故平行。

这段**没错**，甚至很严谨。但它不回答「我坐在考场上，题目只说『令中点切向平行于 AD』，我第一步该写什么」。

**推导式**（重写后）
> **怎么下手**：题目给了「切向平行于某条边」，Bézier 的切向有闭式解，先写出 `P'(t)` 的通式，再代 `t = 1/2`。平行 ⟺ 叉积为零，这是唯一判据。
>
> **推导**
> 1. 已知 `P₀ = A`、`P₃ = C`、`P₁ = A + aU`、`P₂ = C − aU`（(c) 问的结论）。
> 2. 三次 Bézier 求导 `P'(t) = 3(1−t)²(P₁−P₀) + 6(1−t)t(P₂−P₁) + 3t²(P₃−P₂)`。
> 3. 代 `t = 1/2`，三个权重都是 `3/4`：`P'(1/2) = (3/4)(−P₀ − P₁ + P₂ + P₃)`。
> 4. 把第 1 步的四个控制点代进去 …

差别不在长度，在**第 2 步存在与否**。核对式里没有第 2 步——它从「已知公式」直接跳到「代入得」，而那个公式正是读者缺的。

**建议**：把这条写成硬判据放进 skill —— **凡是要求「解题过程」的产出，禁止以「验证」为主体**。验证最多作为最后一行自检。判据可以机械检查：如果一段讲解里出现「验证」「不难看出」「代入可得」而没有对应的编号步骤，就是核对式。

### 2. 中英对照的落点是**步骤**，不是段落

用户要「中英对照的解题过程」。我的第一反应是给每道大题加一段 `### English model answer`——这是错的，而且我在 13 份全解里一直是这么做的。

段落级对照的问题：中文说了 6 步，英文一段话说完，读者在考场上**没法把英文摊回步骤**。他需要的是一份「第 1 步英文怎么写、第 2 步英文怎么写」的清单。

重写后的形态：

```
**推导**
1. 已知 P₀ = A、P₃ = C，中间两点由 (c) 问的 a 参数化。
2. 三次 Bézier 求导：P'(t) = 3(1−t)²(P₁−P₀) + …

**English solution**
1. We have P₀ = A and P₃ = C; the two inner points are parameterized by a from part (c).
2. Differentiating the cubic Bézier: P'(t) = 3(1−t)²(P₁−P₀) + …
```

编号严格一一对应。这不是翻译，是**同一份推导的两种语言排布**。

**建议**：skill 里写死「双语解答的编号必须一一对应」，并给一个反例（一段汇总英文段落）。

### 3. 「怎么下手」是独立的一块，不能被推导吸收

我首版根本没有这一块。写手们（子代理）也没有——因为我的规格里没有要求。

这一块回答的是**检索问题**：读者在考场上看到题面，脑子里要能触发正确的工具。它不是定义，不是背景，是「哪个词 → 哪个工具」的映射。

实例：

| 题面里出现 | 该想到 |
|---|---|
| `tangent direction` / `tangent to` | 求导，且只约束方向（1 个自由度） |
| `tangent vector` | 求导且约束长度（2 个自由度） |
| `degrees of freedom` | 控制点数 × 2 − 已用约束数 |
| `passes through the center` | ⚠ 对 Bézier 常常是恒等式，定不了参数 |
| `N tiles across the width` | 先确认 N 对应哪个参数，再写 `s = N·(u−u₀)/(u₁−u₀)` |
| `orthogonal projection onto a plane` | 先求法向，再 `M = I − nnᵀ/(n·n)` |

最后两行是这一轮的真实收获——**「过中心」那一条我一开始也上当了**，用它去解参数得到恒等式，才发现只有切向能定。

**建议**：skill 里给「怎么下手」一个明确的定义和长度上限（1–2 句），并说明它**不是**定义、不是背景、不是易错提醒。

### 4. 我原来最自豪的「易错」段，恰恰是大题里最没用的部分

首版 23 道大题，每道都有「易错」段，格式统一、内容也确实是我从材料里挖出来的真陷阱。用户说这些「对应试复习没有太多用处」。

原因：易错段是**防守性**的，它告诉你别踩哪个坑；但读者当前的问题是**不知道路怎么走**。在还没有路径的时候给他一堆「这里会摔」，只会增加焦虑。

易错不是没用——它在**单元讲义**里很有用，因为那里读者已经有了概念，需要的是边界。它在大题里没用，因为大题要的是流程。

**建议**：把「易错」从「大题解答」的必备件里去掉，只在概念性章节（讲义、知识点总结）保留。

### 5. 同一份文件里可以有两种文体，而且**应该**有两种

这是这一轮最后才定下来、也最容易被忽略的一条。

上面四条判据（推导式、步骤级双语、检索块、去掉易错）很容易被读成「所有讲解都该改成推导式」。**错。** 用户的最终裁定是：

> 不加。单元讲义的正文是为了理解知识，不是为了理解怎么答题。当前挺好的。

所以 16 份单元讲义现在是**混血**的：

| 部位 | 文体 | 理由 |
|---|---|---|
| 正文（概念展开） | 四步式：场景 → 算一遍 → 命名 → 一条用途 | 读者在这里要把一个**概念**装进脑子，不需要步骤编号 |
| 末尾检查题 | 推导式：怎么下手 → 推导 → 答案 → English solution → Answer | 读者要把它当成**考场上的动作序列** |
| 综合卷大题 | 推导式（同上） | 同上 |
| 全解 | 题面 + 翻译 + 详解 + 英文答案 | 按整卷练手时对答案 |

**同一个 `.md` 文件，前半是概念文体，末尾是流程文体**——这不是前后不一致，是分工。判断依据始终是同一句：**读者拿这一段做什么**。

**建议**：skill 里明确写出「一份文档可以有两种文体」，并给出上面这张对照表。否则读到的规则是「推导式更好」，下一轮会把讲义正文也改坏。

⚠ 这一条我差点做错：我一度准备把 16 份讲义正文也改成推导式，已经在动手前问了用户，才被告知不用。**「统一形态」的冲动是错的**——不一致的形态如果各自服务于不同的用途，那正是对的形态。

---

## 三、我做得不好的（诚实缺口）

### 1. 交付前没有拿用户的原话校准过「讲解」这个词

用户要的是「讲解」，我交的是「解析」。这两个词在中文里很近，但在应试语境下差得很远：解析是「这题怎么回事」，讲解是「这题怎么做」。

我在开工前应当问一句：「大题你要的是**能照着走一遍的步骤**，还是**能读懂为什么的说明**？」——这一句问题可以省掉 23 道大题的返工。

### 2. 把「有官方英文答案」当成了「满足中英对照」

13 份全解每份都有 `### English model answer`，我在交付时把它当成交付项打了勾。但那是**答案**的英文，不是**过程**的英文。用户要的是过程。

这是一个典型的「指标通过但目标未达」：我在检查清单上有一项「English model answer 段齐全」，它一直是绿的。

### 3. 同一份材料写了两遍大题，第一次的 882 行全部作废

`_src/syn/part2_v1_backup.md` 882 行。返工成本主要不在写，在**三个子代理已经按旧规格各写了一轮**——规格错了，委派就越快越浪费。

**教训**：规格本身要先拿一道题做样板给用户看，确认形态再分发。这一轮我确实是这么做的（`v2_exemplar.md`），但那是**返工之后**才做的；首版是直接分发的。

### 4. 我在审子代理产出时改错过一次结论

`全解-2014-04-14.md` 第 2 题 (d)，子代理报「官方答案错了两处」。我核对了 p.32 的官方原文，认为它无冲突，把它的正确结论改成了「已核对无冲突」。

实际上 p.32 是**第 4 题 (d)** 的页码，第 2 题 (d) 在 p.29。子代理是对的，我错了。它反过来纠正了我，我又改回来。

**教训**：子代理报「材料有错」时，**先独立验算再改**；改别人结论前先确认页码对得上题号。这条已写进那一轮的勘误台账，但更该写进 skill——因为 `teaching-on-the-board` 明确说了「当材料自相矛盾时要裁决」，却没说要**先验页码**。

---

## 四、对 `teaching-on-the-board` 技能的改进建议

### 建议 A（最高价值）：加一节「讲解的形态由读者要拿它做什么决定」

```markdown
## What the write-up is for decides its shape

Two requests sound alike and are not:

- "explain this to me" → the reader wants to UNDERSTAND. Scenario, worked
  example, then the name, then one use. This is the four-step form.
- "show me how to solve this" → the reader wants to REPRODUCE it under exam
  conditions. Numbered steps, each with its arithmetic visible, then the
  answer, then the same steps in the exam's language.

The failure mode is answering the second request with the first form: an
explanation of why the answer is correct, which the reader can follow but
cannot reproduce. Check for it mechanically — if the derivation contains
"substituting gives" or "it is easily seen" without a numbered step that
does the substitution, it is the wrong form.
```

### 建议 B：把「双语对照」写死为步骤级

```markdown
## Bilingual means step-aligned, not summarised

If the exam is in English and the reader studies in another language, the
English must be laid out against the same numbered steps as the first
language — not as a summary paragraph at the end. The reader copies the
English step for step in the exam hall; a paragraph cannot be copied step
by step.

Bad:  **English model answer**
      The tangent must be parallel to AD, so we differentiate and solve.

Good: **English solution**
      1. We have P₀ = A and P₃ = C.
      2. Differentiating the cubic Bézier gives P'(t) = …
      3. At t = 1/2 all three weights equal 3/4, so …
```

### 建议 C：加一节「检索块」——`怎么下手`

```markdown
## The retrieval block

Before the steps, one or two sentences answering: seeing which word in the
question should trigger which tool? This is not a definition and not a
warning. It is the mapping the reader needs in the first ten seconds.

Keep it to the mapping. If it grows into background, it has become an
explanation and belongs in a different block.
```

### 建议 D：把「易错」限定在概念性章节

```markdown
## Guard rails belong where the reader already has a path

An "easy to get wrong" note is valuable once the reader knows the route and
needs its edges. Before the route exists, a list of ways to fail increases
anxiety rather than reducing it. Keep these in concept chapters; do not
require them in worked solutions.
```

### 建议 E：加一条「材料里的官方答案也可能是错的」

这一轮从 13 份卷子里查出**八处官方印刷错误**，其中 2014-04-14 Q2(d) 是**双重错误**——即使用官方自己印的系数，也算不出官方自己写的结果。

```markdown
## The answer key is a source, not the truth

Official solutions get misprinted. When a supplied answer fails its own
internal check — a normal that is not perpendicular to the surface it
belongs to, a derivation whose printed coefficients do not produce the
printed result — recompute from the definitions and record the correction.
Never paper over it, and never quietly copy the printed version.

Rule of thumb: verify the answer against a second, independent route
(differentiate vs. eliminate the parameter; geometric vs. algebraic).
```

这条与 `from-2IRR20` 那份的「材料矛盾」一节相邻但不重复：那份讲课件矛盾，这条讲**答案册**矛盾。

### 建议 F：写「先给一道样板，再分发」

```markdown
## Freeze the shape on one example before delegating

When several units are written in parallel, write ONE unit to the agreed
shape, show it, and only then fan out. A wrong shape multiplied by four
writers is four rewrites, and the writers' work is not the expensive part —
re-reading and re-verifying it is.
```

### 建议 G：一份文档可以有两种文体——别为了「统一」把概念章节也改成流程

```markdown
## One document, two shapes, on purpose

A single write-up may legitimately mix two forms, because different parts
serve different reading:

- The body explains a CONCEPT. Use the four-step form: scenario, worked
  number, then the name, then one use. No step numbering needed.
- The worked exercises at the end are for REPRODUCTION under exam
  conditions. Use numbered steps, then the same steps in the exam's
  language.

Do not "unify" the body into the exercise form. That is not consistency; it
is turning a concept chapter into a procedure chapter the reader did not ask
for. The test for each part is still: what will the reader DO with this?

Ask before converting a body section. The user's words when offered this
change were: "不加。单元讲义的正文是为了理解知识，不是为了理解怎么答题。"
```

### 建议 H：篇幅上限要按「最小单位」写，不要按「整份文件」写

这一轮的规格写了「每道大题 60–100 行」，而我自己写的标杆范例是 177 行 / 4 小问 = **44 行/问**——按整题算，范例本身就超上限 74%。三个写手全都「超标」，其中一个明确回报「60–100 行与中英双语 + 每问 4 步在这几道题上互斥」，并请我裁决。

**规格和范例互相矛盾，错在规格。** 修法是把上限挂到最小单位上：

```markdown
## Budget the smallest repeatable unit, not the file

State the length limit per smallest unit (per sub-question, per block), and
let the file length follow from the count. "60–100 lines per question" is
ambiguous when questions have 1–6 sub-questions; "20–50 lines per
sub-question" is not. A range the exemplar itself violates is not a budget —
it is a trap that makes every writer look non-compliant.
```

---

## 五、对 `preset_teacher` 的建议

1. **开工时问一句文体**：这次要的是「讲懂」还是「能照着做」？两者都写也可以，但必须分开成两节，不能混在一段里。
2. **交付前拿用户的原话回读一遍**：用户说的是「讲解」「解题过程」「中英对照」，这三个词都要落成可检查的形态，不能只落成一个标题。
3. **官方答案是素材，不是标准**：遇到与定义冲突的先验算，把裁决写进台账。
4. **不要顺手「统一格式」**：改一部分之前先问这部分是否也在抱怨范围内。这一轮用户只抱怨了大题和检查题，正文没有；我差点把正文也改掉。
5. **规格里的数字要能被自己的范例满足**：写上限之前，先量一遍自己的范例。
---

## 六、给下一次的三句话

1. **先问读者拿它做什么，再决定写多细。** 同一份文件里，正文和练习可以而且应该用两种文体。
2. **双语对照是步骤级的事。** 段落级英文答案只对「抄答案」有用，对「抄过程」没用。
3. **规格先在一道题上冻住，篇幅上限挂到最小单位上。** 分发得越快，规格错了赔得越多；上限写错单位，所有写手都会「违规」。

---

## 附：这一轮的硬数字

| 项 | 数 |
|---|---|
| 单元讲义 | 16 份 / **6,886 行** / 114 张课件原页图 |
| 讲义检查题 | **26 道**，16/16 份中英步骤严格一一对应 |
| 历年卷全解 | 13 份 / 8,651 行 / 120 张考卷原页图 |
| 综合卷 | 4,388 行；78 题填空（9 板块）+ 23 道大题（7 类）/ **95 个小问**中英对照 |
| 全课知识点总结 | 1,295 行 |
| 勘误台账 | 417 行 / 16 节 / **8 处官方印刷错误** |
| 查出的官方错误 | 8 处，其中 1 处双重错误、1 处连自洽都做不到 |
| 我改错又改回 | 1 次（页码错认） |
| 首版大题作废 | 882 行 + 3 个子代理各一轮 |
| 规格与范例矛盾 | 1 次（整题 60–100 行 vs 范例 44 行/问），3 个写手全部「违规」，错在规格 |
| 差点做错的一次 | 准备把讲义正文也改成推导式，问过用户后被告知不用 |
