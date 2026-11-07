# 已处理的建议：归档

这里放的是**处理完毕的一手记录**。它们不是待办，也不是契约。

每一份都对应着一批已经落进代码或文档的规则：

| 记录 | 变成了什么 |
|---|---|
| [`diagram-and-text-failure-visibility.md`](diagram-and-text-failure-visibility.md) | `wellFormedSvg` + `svgParses`（`src/client.js`）——后者让「渲染成功但产物不可用」有了一条回来的路；截断提示改成指令（`src/tools.js`）。§2.1「长文本被裁切」经实测**证伪**，证据留在原文里 |
| [`teaching-method-observations.md`](teaching-method-observations.md) | `skills/teaching-on-the-board/SKILL.md` 的四步式、检查题、材料裁决 |
| [`教学经验与教师skill改进建议-from-2IRR20.md`](教学经验与教师skill改进建议-from-2IRR20.md) | 同一份技能里的「讲之前」三件事：范围裁决、页码校验、文本层不可信 |
| [`教学经验与教师skill改进建议-from-2IV60-全解与综合卷.md`](教学经验与教师skill改进建议-from-2IV60-全解与综合卷.md) | 同一份技能里的「两种文体」判据、步骤级双语、检索块；教师预设 `board-guidance` 同步 |

**为什么归档而不是删掉。** 这里的每一份都是「当时实际发生了什么」，包括被证伪的那一条。删掉它
们，下一轮就会重新犯同样的错，或者重新花一轮去查同一个问题。所以它们原样保留，只是不再占用
`docs/suggestions/` 这个「待处理」的位置。

**为什么不为整齐去改它们。** 这些文档的价值在于**如实**：包括作者自己承认的缺口、算错的结论、
以及标着 UNVERIFIED 的猜测。把它们统一成一种口气、补齐成一致的结构，就等于把它们从证据改写成
了宣传。新增的复核结论以引用块的形式补在原文相应位置，不覆盖原话。

新建议请直接放在 `docs/suggestions/`（不要放进这里）；处理完之后再移进来。
