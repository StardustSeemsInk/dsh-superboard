# DSH 输入框「附件」与「引用」可行性调研

> **这份调研已经用尽（spent）。** 它得出的结论是**否定的**：走 composer 草稿那条路把结构化内容
> 追加进输入框不可行，所以框选反馈最后改成了「摘要写进草稿文本 + 选区作为 JSON 附件」。
> 留着它是因为**那条结论的证据全在这里**——不是因为它还需要被继续写下去。
> 现在的实现读 [`../../README.md`](../../README.md) 的「框选反馈」一节。

调研对象：DSH 0.2.0-rc.2 Desktop，asar 已解包到 `C:\Users\haoch\AppData\Local\Temp\dsh-asar\`。
方法：只读源码；每条结论附 `文件路径:行号` 与逐字代码。读不到或无法确证的写 **UNVERIFIED**。
下文所有 `lib/client.js` 若未写全路径，均指
`C:\Users\haoch\AppData\Local\Temp\dsh-asar\dsh\node_modules\@deepseek-ai\<包名>\lib\client.js`。

---

## 0. 先更正任务书里的两条前提

任务书把下面两条列为「已确认」，但它们不准确，会直接影响方案选择：

**(1) 「全安装里唯一发这些 `slash/input-*` 事件的三行就在 conversation 包自己内部 `:14263-14266`」——错误。**
官方有至少两个包在自己内部发这些事件：

- `dsh-client-ui-input-trigger/lib/client.js:712-728`（`@`/`/` 触发器的执行器）
- `dsh-client-ui-commands/lib/client.js:874` 与 `:1123`（发 `slash/input-consume-token`）

`dsh-client-ui-input-trigger` 就是「第三方包从 conversation 之外发这些事件」的官方先例。

**(2) 「`insertReference` 里草稿就是普通文本、chip 是扫描装饰」——把两个不同的通道混在一起了。**
`insertReference` **确实插入真正的 chip 节点**（见 §B2），
「普通字符 + 扫描装饰」说的是另一个方法 `insertText`（`lib/client.js:13798`），
它的 JSDoc 逐字为：

```
* Insert plain reference text over the pick-time span (scoped insert-text event
* listener body; the plain-text reference path). The editor gains ordinary
* characters — no chip node; the chip look is a scan-derived decoration, never state.
* @param text - the plain reference text to splice in (e.g. `/name `).
```

---

## A. 「附件」到底是什么、怎么产生的

### A1. `addAttachments(ids)` 里的 id 是「浏览器本地的草稿附件 id」

`ConversationController`（`ConversationController extends Service`，`super(ctx, "conversation")`，见 `lib/client.js:3341-3362`，注释称其为 *"root singleton, provided as `conversation`"*）持有一个**公开的普通 Map 字段**：

`dsh-client-ui-conversation/lib/client.js:3347-3348`
```js
fileUploads = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({});
draftAttachments = /* @__PURE__ */ new Map();
```

id 的产生地是 `createDrafts(sessionId, files)`，`dsh-client-ui-conversation/lib/client.js:3469-3494`（JSDoc `:3469-3476`：*"Create runtime-only draft attachments. Files whose browser MIME is an accepted image type become image drafts (object URL preview, bytes sent with the prompt); every other file becomes a file draft whose background upload starts immediately."*）：

```js
createDrafts(sessionId, files) {
    return files.map((file) => {
        if (isImageMediaType(file.type)) {
            const attachment = browserDraftAttachment(file);
            this.draftAttachments.set(attachment.id, attachment);
            probeDimensions(attachment);
            return attachment;
        }
        const attachment = {
            kind: "file",
            id: randomUUID(),
            file
        };
        this.draftAttachments.set(attachment.id, attachment);
        this.beginFileUpload(sessionId, attachment);
        return attachment;
    });
}
```

也就是说 `ids` 是 `draftAttachments` 这个 Map 的 key（`randomUUID()`），**不是** host 侧的任何 id。

两个描述符构造器：

`lib/client.js:3269-3277`
```js
/**
 * Create one browser-only image draft descriptor; only its id enters input state.
 */
function browserDraftAttachment(file) {
    return {
        kind: "image",
        id: randomUUID(),
        previewUrl: URL.createObjectURL(file),
        file
    };
}
```

`lib/client.js:3280-3294`
```js
function probeDimensions(attachment) {
    if (typeof Image !== "function") return;
    const probe = new Image();
    probe.onload = () => {
        attachment.width = probe.naturalWidth;
        attachment.height = probe.naturalHeight;
    };
    probe.src = attachment.previewUrl;
}
```

`addAttachments` 本身**不做任何校验**，`dsh-client-ui-conversation/lib/client.js:13554-13561` 逐字：

```js
/** Append ordered attachment ids unless an admission transaction is locked. */
addAttachments(ids) {
    if (this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;
    if (ids.length === 0) return true;
    this.attachmentIds = [...this.attachmentIds, ...ids];
    this.publish();
    return true;
}
```

注意它的 JSDoc 逐字只说 *"Append ordered attachment ids unless an admission transaction is locked."*——
**完全没有提到「校验 id」**，实现里也确实没有。对照同文件 `:13562-13574` 的 `addFiles(references, ids)`，
那一个才叫 *"Add **validated** file references and attachment ids while admission is editable."*，
并且多了一步 `if (!this.draftEditor.insertFileReferences(references)) return false;`。
两者都不要的 `ids` 校验由 `pruneAttachments` 事后补救（见下）。

注意：`addAttachments` 不校验 id 是否存在。真正清理坏 id 的是 InputBar 的一个 effect，
`lib/client.js:17298-17305` 逐字：

```js
react.useEffect(() => {
    if (input === void 0 || inputActions === void 0) return;
    if (attachments.length !== input.attachmentIds.length) inputActions.pruneAttachments(attachments.map((attachment) => attachment.id));
}, [attachments, input?.attachmentIds, inputActions]);
```

`pruneAttachments` 逐字（`:13588-13598`）：

```js
/**
 * Keep only ids that still resolve in the browser attachment registry.
 * @param available - live registry ids.
 */
pruneAttachments(available) {
    const keep = new Set(available);
    const next = this.attachmentIds.filter((id) => keep.has(id));
    if (next.length === this.attachmentIds.length) return;
    this.attachmentIds = next;
    this.publish();
}
```

`removeAttachment` 逐字（`:13575-13587`）：

```js
/**
 * Remove one attachment id from this draft. Busy admission phases refuse, like
 * {@link addAttachments}: a removal landing while a command submit serializes
 * would otherwise vanish from the rail yet still ride the in-flight send.
 */
removeAttachment(id) {
    if (this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;
    const next = this.attachmentIds.filter((candidate) => candidate !== id);
    if (next.length === this.attachmentIds.length) return false;
    this.attachmentIds = next;
    this.publish();
    return true;
}
```

而 `resolveDraftAttachments(ids)`（`:3601-3608`）只从 `draftAttachments` 里查：

```js
resolveDraftAttachments(ids) {
    const attachments = [];
    for (const id of ids) {
        const attachment = this.draftAttachments.get(id);
        if (attachment !== void 0) attachments.push(attachment);
    }
    return attachments;
}
```

**结论：任何不在 `draftAttachments` 里的 id 都会被静默丢弃，不会渲染出 chip。**

### A2. 附件的来源**不止**文件——但一定得是「字节」

有两条产生路径，都由 `createDrafts` 分派：

| `file.type` | 结果 |
|---|---|
| `image/png` / `image/jpeg` / `image/webp` / `image/gif` | `kind: "image"`，走 object URL 预览，提交时把 base64 内联进 prompt |
| 其它任何 MIME（含空串） | `kind: "file"`，立刻后台上传，提交时只带 `receiptId` |

判定函数 `isImageMediaType` 在 `lib/client.js:3740`。

**没有任何路径能产生「非字节」的附件**：描述符要么是 `{kind:"image", file}` 要么是 `{kind:"file", file}`，
两者都必须持有一个浏览器 `File`（`createDrafts` 的入参就是 `files: File[]`）。
唯一的例外是直接写 `conversation.draftAttachments.set(...)` 这个公开 Map，
但那仍然是「伪造一个带 `file` 的描述符」，而且下游 `serializeDraftAttachments` 需要真的上传回执（见 A4）。

`createDrafts` 之所以能用合成内容，是因为浏览器可以凭空造 `File`：
`new File([bytes], "board-selection.md", { type: "text/markdown" })`。
这条路径不需要用户真的选了文件。

### A3. `ctx.attachments`（host 侧）的契约：镜像只有 4 种，文件无限制

服务 key 与摘要，`dsh-tool-cordis/lib/types/api-catalog.js:345-347`
```js
{
    key: 'attachments',
    summary: 'Immutable binary attachment service.',
    description: 'Immutable binary attachment service. Implementations validate bytes before publishing a reference.',
```

**镜像类型确实只有 4 种**（逐字证据）：

`dsh-llm/lib/typert.host.js:333`
```
"declaration": "export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';"
```
`dsh-llm/lib/typert.host.js:325`
```
"declaration": "export interface ImageAttachmentRef {\n    attachmentId: AttachmentId;\n    mediaType: ImageMediaType;\n    bytes: number;\n    width: number;\n    height: number;\n    name?: string;\n    originalDimensions?: { width: number; height: number; };\n}"
```

**但同一个服务上有一条完全不受限的文件通道**，`dsh-tool-cordis/lib/types/api-catalog.js:406-411`
```js
{
    signature: 'saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef>',
    description: 'Durably commit one file byte-for-byte before its owning session event is appended. Files carry no admission limits: any byte content and length is accepted, and the stored object is the exact submitted bytes. Backends without verbatim file storage keep this default rejection.',
    parameters: [{ name: 'input', description: 'exact bytes and optional display name.' }],
    returns: 'the durable content-addressed file reference.',
},
```
`dsh-tool-cordis/lib/types/api-catalog.js:6223-6225`
```js
{
    name: 'SaveFileAttachment',
    declaration: 'export interface SaveFileAttachment {\n    data: Uint8Array;\n    name?: string;\n}',
},
```
`dsh-tool-cordis/lib/types/api-catalog.js:5111-5117`
```js
{
    name: 'FileAttachmentRef',
    declaration: 'export interface FileAttachmentRef {\n    attachmentId: AttachmentId;\n    name: string;\n    bytes: number;\n}',
},
{
    name: 'FileBlock',
    declaration: 'export interface FileBlock {\n    type: \'file\';\n    attachment: FileAttachmentRef;\n}',
},
```

另外 `admitPromptContent` 的三态就是「文本 / 图片 / 文件」，
`dsh-tool-cordis/lib/types/api-catalog.js:4387-4389`
```js
declaration: 'export type AdmittedPromptContentPart = {\n    readonly type: \'text\';\n    readonly text: string;\n} | {\n    readonly type: \'image\';\n    readonly attachment: ImageAttachmentRef;\n} | {\n    readonly type: \'file\';\n    readonly attachment: FileAttachmentRef;\n};',
```
`dsh-tool-cordis/lib/types/api-catalog.js:4547-4549`
```js
declaration: 'export type AttachmentAdmissionPart = PromptContentPart | {\n    readonly type: \'file\';\n    readonly attachment: FileAttachmentRef;\n};',
```
实现见 `dsh-attachment/lib/index.js:242-266`（`async admitPromptContent(content)`），
它逐字把 `part.type !== "image"` 的分支原样透传：text→`{type:"text",text}`、file→`{type:"file",attachment}`。

> **回答「能不能创建一个纯文本/JSON 的附件」：**
> 作为**附件（attachment）不行**——附件语义是「不可变字节对象」，没有 text 变体。
> 但作为**文件（file）可以**：任意 `Uint8Array`（例如看板选择的 JSON）通过 `saveFile` / 上传通道就是一个合法 file 附件，MIME 与大小都不设限。
> 纯文本**内容**想以文本形态进入消息，只能作为 `{type:'text'}` 部分，走 prompt 文本通道，不是附件。

### A4. 附件发出去之后以什么形式到达模型

**客户端侧**：提交时把草稿附件序列化成 `PromptContentPart[]`，
`dsh-client-ui-conversation/lib/client.js:3609-3632`
```js
/**
 * Serialize ordered draft attachments to command-submit wire payloads without
 * sending or releasing them. Images are encoded; generic files cite receipts
 * from their completed background uploads and never reread browser bytes.
 * @param attachmentIds - ordered draft-local attachment ids.
 * @returns wire payloads in id order.
 */
async serializeDraftAttachments(attachmentIds) {
    const attachments = this.resolveDraftAttachments(attachmentIds);
    if (attachments.length !== attachmentIds.length) throw new Error("conversation.serializeDraftAttachments: one or more draft attachments are no longer available");
    const uploads = this.fileUploads.getSnapshot();
    return { attachments: await Promise.all(attachments.map(async (attachment) => {
        if (attachment.kind === "image") return {
            type: "image",
            ...await this.encodeImage(attachment.file)
        };
        const upload = uploads[attachment.id];
        if (upload === void 0 || upload.status !== "ready") throw new Error("conversation.serializeDraftAttachments: one or more files have not finished uploading");
        return {
            type: "file",
            receiptId: upload.receiptId
        };
    })) };
}
```

`PromptContentPart` 的逐字定义（客户端运行时同一份声明也内嵌在 runner 里）：
`dsh-api-session-controller/lib/typert.host.js:1981`
```
"declaration": "export type PromptContentPart = { readonly type: 'text'; readonly text: string; } | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string; } | { readonly type: 'file'; readonly receiptId: Branded<'file-upload-receipt-id'>; };"
```
（同一字符串也在 `dsh-cordis-client-runner/lib/client.js:1987`。）

`sendSession(...)` 把它们和文本块拼在同一个 `ContentBlock[]` 里
（`dsh-client-ui-conversation/lib/client.js:3404-3466`，最终 `content` 为
`[...await serializeAttachments(), ...text === "" ? [] : [{type:"text", text}]]`，
附件在前、文本块在最后）。

**host 侧**：`ctx.attachments.admitPromptContent()` 把 image 换成 `ImageAttachmentRef`、file 原样透传，
结果是 `AdmittedPromptContentPart`（text / image+`ImageAttachmentRef` / file+`FileAttachmentRef`，见 A3 逐字）。

**到达模型的形态**：`ContentBlock` 家族里有 `ImageBlock` 与 `FileBlock`：
- `FileBlock { type: 'file'; attachment: FileAttachmentRef }`（`api-catalog.js:5115-5117`）
- `ImageBlock`（`api-catalog.js:5267`，其 `ImageAttachmentRef` 见 `dsh-llm/lib/typert.host.js:325`）

`dsh-attachment/README.md:106` 逐字描述了模型的体验：
> "A generic file never reaches the provider as bytes: every route receives one deterministic handle line naming the file, its byte size, its digest prefix, and the saved read-only path to read with file tools."

`dsh-attachment/README.md:40` 逐字：
> "Any non-image file attaches to a prompt as a generic file: the exact bytes are saved read-only under the harness home, the message records the file name, byte size, and content digest, and the model receives one line naming the saved path so it can read the content with its file tools only when needed. **There is no file-type whitelist and no size limit**; what you attach is stored verbatim."

`CommandInvocation` 也证明命令能拿到同一对类型，
`api-catalog.js:4687-4689`
```js
declaration: 'export interface CommandInvocation {\n    readonly commandId: CommandId;\n    readonly agent: Agent;\n    readonly rawInput: string;\n    readonly attachments: readonly (ImageBlock | FileBlock)[];\n    readonly signal: AbortSignal;\n}',
```

---

## B. 「引用」（reference）是什么、能否被第三方插入

### B1. 事件形状与类型定义

会话作用域事件注册处逐字，`dsh-client-ui-conversation/lib/client.js:14261-14275`
```js
actx.on("slash/input-begin-command", (req) => shell.beginCommand(req.claim, req.span) ? true : void 0)
actx.on("slash/input-insert-reference", (req) => shell.insertReference(req.reference, req.span) ? true : void 0)
actx.on("slash/input-consume-token", (req) => shell.consumeToken(req.guard) ? true : void 0)
actx.on("slash/input-insert-text", (req) => shell.insertText(req.text, req.span, req.continue === true) ? true : void 0)
```
（本文件原样为单行 `const offs = [actx.on(...), ...]`，此处按参数拆行便于阅读。）

所以 `req` 形状是：
- `{ claim, span }`
- `{ reference, span }`
- `{ guard }`
- `{ text, span, continue?: boolean }`

`reference` 的类型定义**不在对话包里**，它就是 chip 节点的 `insert` 载荷，字段由
`ReferenceChipNode` 的构造器读取（见 B2）。**没有名为 `dsh-session-reference` 的客户端 reference 类型**——
`dsh-session-reference` 是 host 侧「会话 @ 提及」的文本语法解析器（见 B4 末尾）。

### B2. 一个 reference 在草稿里变成什么

它变成**真正的 Lexical chip 节点**，不是纯文本。
`dsh-client-ui-conversation/lib/client.js:13317-13329`
```js
/**
 * Insert a reference chip with the existing trailing-space rule.
 * @param span - detect-coordinate splice target.
 * @param ref - the chip payload.
 * @param tail - the character that followed the span, used for the space rule.
 * @returns whether the edit applied.
 */
insertReference(span, ref, tail) {
    let applied = false;
    this.applyEdit(() => {
        applied = $replaceDetectSpanWithNodes(span, tail === " " ? [$createReferenceChipNode(ref)] : [$createReferenceChipNode(ref), Go(" ")]);
    });
    return applied;
}
```

chip 节点逐字（`lib/client.js:12390-12531`），关键部分：
```js
static getType() {
    return "reference-chip";
}
```
```js
createDOM(_config) {
    const el = document.createElement("span");
    el.setAttribute("data-composer-chip", this.__source);
    el.setAttribute("contenteditable", "false");
    return el;
}
```
```js
getTextContent() {
    return this.__clipboardText;
}
```
```js
decorate() {
    return /* @__PURE__ */ jsx(ReferenceChip, {
        label: this.__label,
        appearance: this.__appearance,
        invalid: this.__invalid
    });
}
```
构造器 `:12436-12448`
```js
constructor(insert, invalid = false, key) {
    super(key);
    this.__source = insert.source;
    this.__ref = insert.ref;
    this.__label = insert.label;
    this.__appearance = insert.appearance;
    this.__clipboardText = insert.clipboardText;
    this.__invalid = invalid;
}
```
字段语义逐字（`:12390-12410`）：
- `__source` — *"Owning source name (serializer routing key)"*
- `__ref` — *"Owner-scoped reference id"*
- `__label` — *"Inline display label (insert-time cache)"*
- `__appearance` — *"Optional domain glyph (insert-time cache)"*
- `__clipboardText` — *"Clipboard / persistence projection, e.g. `/name` (never the model form)"*

工厂 `:12533-12539`
```js
function $createReferenceChipNode(insert) {
    return new ReferenceChipNode(insert);
}
```

**用户看到的文本（clipboard/detect 投影）就是 `clipboardText`**，
官方 `@` 源的例子是 `@src/foo.ts`（见 B4）。

**`invalid` 位全安装从没被设置过**：`setInvalid(invalid)`（`:12499-12502`，JSDoc *"Flip the owner-resolution failure bit."*）
在整个安装里只有定义、没有调用点（grep `setInvalid` 命中 4 处，全在本文件，且都是定义/读取）。
因此 chip 插入时**不做任何 owner 存在性校验**，label 与 appearance 直接按传入值渲染。

### B3. 第三方能不能插入？能，需要三样东西

**插入调用**（`lib/client.js:13756-13768`）
```js
/**
 * Insert one reference chip over the pick-time span (the reference-chip path).
 * ...
 */
insertReference(ref, span) {
    if (this.snapshot.phase !== "plain" && this.snapshot.phase !== "claimed") return false;
    if (span.draftRev !== this.rev) return false;
    const tail = this.projection.detectText.slice(span.end, span.end + 1);
    return this.draftEditor.insertReference(span, ref, tail);
}
```
条件只有两条：phase 是 `plain`/`claimed`，且 `span.draftRev === this.rev`。**没有 owner 校验。**

**事件派发**：从会话作用域 ctx 上 `bail`。
`cordis/lib/index.js:284-302`
```js
/**
 * Run listeners in order, awaiting each, until one returns a bail value.
 * @returns the first bail value (see {@link isBailed}), if any.
 */
...
bail(...args) {
    for (const cb of this.dispatch("bail", args)) {
```
（`dispatch` 的第一个实参是派发主体 `thisArg`，见 `cordis/lib/index.js:261`
`if (!name.startsWith("internal/")) this.emit("internal/dispatch", type, name, args, thisArg);`。）

官方用法逐字，`dsh-client-ui-input-trigger/lib/client.js:705-728`
```js
/**
 * Execute a claim/insert/text outcome via the scoped input events (actx as
 * dispatch subject); true = the input applied it.
 */
execute(outcome, span) {
    const { actx } = this.deps;
    if (outcome === void 0 || outcome === "handled") return false;
    if ("claim" in outcome) return actx.bail(actx, "slash/input-begin-command", {
        claim: outcome.claim,
        span
    }) === true;
    if ("text" in outcome) return actx.bail(actx, "slash/input-insert-text", {
        text: outcome.text,
        span,
        ...outcome.continue === true ? { continue: true } : {}
    }) === true;
    return actx.bail(actx, "slash/input-insert-reference", {
        reference: outcome.insert,
        span
    }) === true;
}
```

**`span` 从哪来**：`inputActions.captureInsertion()`（见 C4），逐字
`dsh-client-ui-conversation/lib/client.js:13463-13466`
```js
captureInsertion: () => ({
    ...this.caretSpan(),
    draftRev: this.rev
}),
```
`caretSpan()`（`:13718-13720`）→ `this.draftEditor.caretSpan()`，
文档逐字：*"The live selection as a detect-coordinate span"*、*"an absent selection answers a collapsed span at the document end"*。
所以 span 就是 `{ start, end, draftRev }`。

**`claim` 是什么**：`beginCommand` 的载荷，`lib/client.js:13733-13753`
```js
beginCommand(claim, span) {
    if (this.snapshot.phase !== "plain" && this.snapshot.phase !== "claimed") return false;
    if (span.draftRev !== this.rev) return false;
    if (this.projection.detectText.slice(0, span.start).trim() !== "") return false;
    ...
    this.draftEditor.replaceText({ start: 0, end: span.end }, claim.token);
    ...
    this.dispatchRun({ type: "claim", claim });
    return true;
}
```
即 `/命令` 的独占首词。它有一条**前导守卫**：光标前必须为空（命令只能在开头），
而 `insertReference` 没有这条守卫。

**`guard` 是什么**：`consumeToken` 用来删掉触发词的票据，`lib/client.js:13770-13784`
```js
consumeToken(guard) {
    if (guard.kind === "span") {
        if (guard.span.draftRev !== this.rev || guard.span.start === guard.span.end) return false;
        this.draftEditor.replaceText(guard.span, "");
        return true;
    }
    if (guard.token === "" || this.projection.clipboardText.trim() !== guard.token) return false;
    this.setDraft("");
    return true;
}
```

**第三方插入一个 reference，最少需要：**
1. 一个会话作用域 ctx（`ctx.sessions.scope(sessionId)`，官方先例见 `:15683-15690`
   `const actx = ctx.sessions.scope(sessionId); const conversation = actx.get("conversation");`）
2. 一个 span（`inputActions.captureInsertion()`，或自己造 `{start,end,draftRev}` —— 但没有公开读 `rev` 的入口，
   所以**必须**用 `captureInsertion()`）
3. `actx.bail(actx, "slash/input-insert-reference", { reference, span })`

### B4. 官方先例：确实有包从 conversation 之外插入

**先例 1 —— `dsh-client-ui-input-trigger`**（`@` / `/` 触发器框架），见 B3 的 `execute` 逐字。
它自己 inject 的是 `["sessions", "locale"]`（`lib/client.js:1242`），并不 inject conversation。

**先例 2 —— `@` 文件/会话源本身就是**注册一个 source**，`dsh-client-ui-reference/lib/client.js`：
inject 列表逐字（`:139-147`）
```js
const inject = ["inputTriggers", "locale", "sessions", "remote", "remote.fileReferences", "remote.sessionReferenceResolver", "sidebarRight"];
```
source 定义逐字（关键部分，`:152-235`）
```js
const source = {
    trigger: "@",
    name: "reference",
    showGroupTitle: false,
    async candidates(session, { query, quoted, drilled, signal }) { ... },
    header(_session, req) { ... },
    onPick({ candidate, action }) { ... },
    openReference(session, { ref, appearance }) { ... },
    codec: {
        clipboardText: (ref) => ref,
        serialize: (ref) => Promise.resolve(ref)
    }
};
const inputTriggers = ctx.get("inputTriggers");
ctx.effect(() => inputTriggers.registerSource(source), "ui-reference: @ source");
```
`onPick` 返回的 `insert` 就是 B1 的 `reference`，逐字（`:198-220`）
```js
return {
    insert: {
        source: "reference",
        ref: value.mention,
        label: value.fileKind === "directory" ? `${value.label}/` : value.label,
        appearance: value.fileKind === "directory" ? "folder" : "file",
        clipboardText: value.mention
    }
};
```
（会话分支：`{ source: "reference", ref: value.mention, label: value.label, appearance: "session", clipboardText: value.mention }`；
目录下钻分支返回文本：`{ text: value.mention, continue: true }`。）

其中 `mention` 由 `formatFileMention` 生成，逐字（`:17-23`）
```js
const path = candidate.kind === "directory" ? `${candidate.path}/` : candidate.path;
if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return void 0;
if (!(preserveQuote || /\s/u.test(path))) return `@${path}`;
if (candidate.kind === "directory") return `@"${path}`;
return `@"${path}"`;
```
所以**普通 `@` 引用的最终文本形如 `@src/foo.ts`**（含空格路径则是 `@"my file.ts"`）。

**先例 3 —— `inputTriggers` 是一个真正的 cordis 服务**，`dsh-client-ui-input-trigger/lib/client.js:874-919`
```js
/**
 * InputTriggerService (`ctx.inputTriggers`): the root half of the trigger pipeline — the
 * stateless source registry plus the per-session controller map. ...
 */
var InputTriggerService = class extends _deepseek_ai_cordis.Service {
    static inject = ["sessions"];
    live = { sources: [], controllers: new WeakMapWithValues() };
    constructor(ctx) {
        super(ctx, "inputTriggers");
        ...
    }
    /**
     * Register one trigger source. Live session controllers are notified so a
     * source arriving after scope birth still warms and joins the lexicon.
     * @param src - the source; (trigger, name) must be unique — duplicates throw.
     * @returns the disposer (callers wrap registration in ctx.effect). ...
     */
    registerSource(src) {
        const { live } = this;
        if (live.sources.some((s) => s.trigger === src.trigger && s.name === src.name)) throw new Error(`slash source "${src.trigger}${src.name}" is already registered`);
        live.sources.push(src);
        ...
    }
```

**先例 4 —— `/skill` 源**（`dsh-client-ui-skill/lib/client.js:375-434`）是一个**没有 codec** 的源，
`onPick` 返回纯文本：`return { text: `/${candidate.name} ` };`，注册方式
```js
const inputTriggers = ctx.get("inputTriggers");
ctx.effect(() => {
    const unregister = inputTriggers.registerSource(source);
    return () => { unregister(); ... };
});
```
另有 `dsh-client-ui-chat/lib/client.js:12433`
```js
ctx.get("inputTriggers")?.sessionOf(scope).openReference("skill", { ref: `/${name}` });
```

### B5. ★ 关键机制：chip 在**提交时**被 owner 的 codec 换成模型形态

这是整份调研最有价值的一条，也是「让自定义内容跟着消息发出去」的官方正规通道。

`dsh-client-ui-conversation/lib/client.js:13943-13991`
```js
/**
 * Prompt serialization before the sink: expand each chip occurrence to its
 * owner's model form via the session controller's codec routing. Owner
 * missing or serialization failure rejects the detached send and restores
 * its editor snapshot. Chip-free drafts skip the async detour.
 */
sinkSerialized(attempt, draft, mode) {
    this.notifySubmission(attempt.submission);
    const attachmentIds = [...this.attachmentIds];
    this.attachmentIds = [];
    const occurrences = this.projection.occurrences;
    const record = { draft, occurrences, attachmentIds };
    this.detachedDrafts.set(attempt.seq, record);
    ...
    if (occurrences.length === 0) {
        this.settleSink(attempt, this.deps.defaultSink(draft.trim(), attachmentIds, mode, attempt.signal));
        return;
    }
    const inputTriggers = this.deps.inputTriggers?.();
    Promise.all(occurrences.map(async (o) => {
        if (inputTriggers === void 0) throw new Error(`no serializer for reference source "${o.source}"`);
        return {
            offset: o.offset,
            length: o.length,
            text: await inputTriggers.serializeReference(o.source, o.ref, attempt.signal)
        };
    })).then((parts) => {
        if (this.disposed) return;
        let out = "";
        let cursor = 0;
        for (const part of parts) {
            out += draft.slice(cursor, part.offset) + part.text;
            cursor = part.offset + part.length;
        }
        out += draft.slice(cursor);
        this.settleSink(attempt, this.deps.defaultSink(out.trim(), attachmentIds, mode, attempt.signal));
    }, (error) => { ... });
}
```

`occurrences` 里每条的 `offset` / `length` / `source` / `ref` 来自投影，
`dsh-client-ui-conversation/lib/client.js:12980-12997`
```js
function $projectComposer(idOf) {
    const layout = $composerLayout();
    const occurrences = [];
    for (const segment of layout.segments) {
        if (segment.kind !== "chip" || !$isReferenceChipNode(segment.node)) continue;
        const chip = segment.node;
        occurrences.push({
            occurrenceId: idOf(chip.getKey()),
            source: chip.getSource(),
            ref: chip.getReference(),
            offset: segment.clipboardStart,
            length: segment.clipboardLength,
            label: chip.getLabel(),
            ...chip.getAppearance() === void 0 ? {} : { appearance: chip.getAppearance() },
            clipboardText: chip.getTextContent(),
            ...chip.isInvalid() ? { invalid: true } : {}
        });
    }
    ...
}
```

路由实现逐字，`dsh-client-ui-input-trigger/lib/client.js:605-619`
```js
/**
 * Serialize one reference occurrence to its model form via the owning
 * source's codec (prompt serialization: registry → explicit
 * call → await). Owner missing or codec-less rejects — the submit attempt
 * blocks instead of silently downgrading to the clipboard text.
 * @param source - owning source name.
 * @param ref - owner-scoped reference id.
 * @param signal - the submit attempt's abort signal.
 * @returns the model representation (e.g. `<skill>name</skill>`).
 */
serializeReference(source, ref, signal) {
    const owner = this.deps.roster.all().find((s) => s.name === source);
    if (owner?.codec === void 0) return Promise.reject(/* @__PURE__ */ new Error(`slash: no serializer for reference source "${source}"`));
    return owner.codec.serialize(ref, signal);
}
```

**结论：注册一个自己的 input-trigger source（带 `codec.serialize`）之后，
草稿里属于你的 chip 的那一段文本，会在提交时被替换成你的 `codec.serialize(ref)` 返回值。
官方给的非文件形态示例是 `<skill>name</skill>`。这是「把任意结构化内容送进消息」的正规扩展点。**

### B6. 会话 `@` 提及的 host 语法（补充，便于设计 payload 文本）

`dsh-session-reference/lib/index.js:310-312`
```js
function formatSessionReferenceMention(reference) {
    return `@[${escapeLabel(reference.label ?? reference.sessionId)}](${encodeSessionReferenceUri(reference.sessionId)})`;
}
```
`parseSessionReferenceText(text)`（`:321-345`）负责反解；`lib/types/index.js:491` 里有
`const parsed = parseSessionReferenceText(block.text);` ——
**是「提交后的正文文本」触发会话召回上下文**，不是任何结构化字段。
错误码：`SESSION_REFERENCE_INVALID_REFERENCE`、`_SELF_REFERENCE`、`_TOO_MANY`
（逐字 *"a message may reference at most ${maxReferences} sessions"*）、`_BUDGET_EXCEEDED`、
`_CANCELLED`、`_READ_FAILED`、`_INVALID_CONFIG`；`maxReferences` 不超过 3，`referenceContextFraction` 在 [0,1]。
UNVERIFIED：这些限制是否也约束非会话来源的引用文本。

---

## C. 能不能把我自己的东西放进输入框区域

### C1. `conversation.input.attachments` 已被占用；冲突规则是「默认优先级抛异常，换优先级静默顶替」

声明处逐字，`dsh-client-ui-conversation/lib/client.js:18293-18300`
```js
ctx.slots.register({
    name: "conversation.composer.bar",
    locale: NS,
    children: {
        "conversation.input.attachments": {
            kind: "single",
            scope: "session-maybe"
        },
```
当前占用者（官方）：`dsh-client-ui-attachment/lib/client.js:874-875`
```js
ctx.slots.inject("conversation.input.attachments", () => ctx.slots.register({
    name: "conversation.input.attachments",
```
目录侧确认，`dsh-cordis-client-runner/lib/client.js:2967-2999`
```js
key: "conversation.input.attachments",
kind: "single",
scope: "session-maybe",
summary: "Optional draft-attachment rail and drop target.",
registerOptions: [],
ownerProps: ["...ComposerAttachmentsOwnerProps { attachments; canAcceptDrop; onAddFiles; onRemoveAttachment; uploads; onRetryFile; dropLimits? }"],
occupants: ["client-ui-attachment ComposerAttachments"],
replaceRisk: "shadows-shipped-ui",
```

冲突处理逐字，`dsh-client-ui-slots/lib/index.js:163-243`
```js
register(options, component) {
    const rec = this.records.get(options.name);
    if (!rec?.spec) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`);
    const spec = rec.spec;
    const priority = options.priority ?? 0;
    const occupantHint = (occupant) => `at priority ${priority}${occupant.registrant !== void 0 ? ` (registered by ${occupant.registrant})` : ""} — register at a different priority to shadow it (lowest renders)`;
    switch (spec.kind) {
        case "single": {
            const occupant = rec.entries.find((e) => (e.options.priority ?? 0) === priority);
            if (occupant) throw new Error(`single slot "${options.name}" already has a registration ${occupantHint(occupant)}`);
            break;
        }
        ...
    }
```
以及取用规则 `entriesOfSlot`（`dsh-client-ui-slots/lib/index.js:278-293`）：
*"single: the slot is one cell; keyed: one cell per `key`; list: one cell per `id` (winners keep ledger sequence; list renderers still refine display by `order`)."*
`reportEntryError`（`:455-463`）对 single/keyed/list 的 `info.abdicate` 会「一次性退位」。

> **结论（C1）：**
> - 用默认 `priority: 0` 注册 `conversation.input.attachments` → **抛异常**（`single slot ... already has a registration ... register at a different priority to shadow it (lowest renders)`）。
> - 用**别的** `priority`（如 `-1`）注册 → **不报错，静默顶替**官方 rail，官方附件卡片不再渲染。属于 `replaceRisk: "shadows-shipped-ui"` 的危险动作。

### C2. 第三方可用的 composer 槽清单（kind / scope / 是否已有 owner）

全部来自两个权威来源：`dsh-client-ui-conversation/lib/client.js` 的槽声明
（`registerConversationContent` 的 children 表 `:18150-18188`，其中 `"conversation.composer"` 是 `kind:"chain"` / `"conversation.composer.bar"` 是 `kind:"single"`；
`registerConversationSession` `:18209-18214` 声明 `"conversation.view"`；
`conversation.composer.bar` 自己的 children 表 `:18293-18333`，其余 `conversation.input.*` 与 `conversation.composer.dock` 都在这里），
以及 `dsh-cordis-client-runner/lib/client.js` 的 `CLIENT_SLOT_API` 目录（行号见下）。
「现有 owner」列为 grep 全安装得到的真实 `slots.inject` 调用点。

| 槽 | kind | scope | 现有 owner | replaceRisk |
|---|---|---|---|---|
| `conversation.composer` | chain | session | approval `:344`、subagent `:975`、user-questions `:1910` | `select` 必需 |
| `conversation.composer.bar` | single | session-maybe | conversation `InputBar` | `shadows-shipped-ui` |
| `conversation.composer.dock` | list | session | chat `:12497` | `none` |
| `conversation.input.attachments` | single | session-maybe | attachment `:874` | `shadows-shipped-ui` |
| `conversation.input.overlay` | list | session | commands `:1430`、input-trigger `:1261`、message-feedback `:837` | `none` |
| **`conversation.input.left`** | **list** | **session** | **无**（`occupants: []`, `replaceRisk: "none"`，目录 `:3062-3112`） | `none` |
| **`conversation.input.right`** | **list** | **session** | **无**（`occupants: []`, `replaceRisk: "none"`，目录 `:3279-3330`） | `none` |
| `conversation.input.plan` | single | session | plan `:700` | — |
| `conversation.input.permission` | single | session | permission-presets `:815` | — |
| `conversation.input.model` | single | session | model-selection `:1248` | — |
| `conversation.input.activity` | single | session | voice-input `:5793` | — |
| `conversation.input.dock` | list | session | conversation `:15677` & `:17752`、goal `:557` | `none` |

`conversation.input.left` 目录条目逐字（`dsh-cordis-client-runner/lib/client.js:3062-3112`）：
```js
key: "conversation.input.left",
kind: "list",
scope: "session",
summary: "Compact controls at the left of the composer tool row.",
registerOptions: [ { name: "id", requirement: "required", ... }, { name: "order", ... }, { name: "label", ... } ],
ownerProps: [],
standardProps: [
    "useResource: UseResource",
    "useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>",
    "usePanelInfo: UsePanelInfo",
    "useSessions: UseSessions",
    "useSessionStatus: UseSessionStatus",
    "useSessionRetainInfo: UseSessionRetainInfo",
    "useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>",
    "useChat: UseChat",
    "useConversation: UseConversation",
    "useInput: SnapshotSelectorHook<InputState>",
    "inputActions: InputActions",
    "useSession: SessionSnapshotSelector",
    "sessionId: SessionId",
    "useProjection: UseProjection",
    "useTrajectory: UseTrajectory"
],
declaredBy: "an entry in 'conversation.composer.bar' (client-ui-conversation), so it exists while that entry is mounted",
occupants: [],
replaceRisk: "none",
```
`conversation.input.right`（`:3279-3330`）逐字同构，只有 `summary` 不同：
*"Compact controls before the composer submit action."*

> **要点：`conversation.input.left` / `conversation.input.right` 目前零占用、`replaceRisk: "none"`、
> `kind: "list"`（可以用自己的 `id` 无限追加），而且组件**直接拿到 `inputActions: InputActions` 与 `sessionId: SessionId`**。
> 这是第三方在输入框工具行放自己 UI 的合法位置。**

渲染点（用于判断位置），`dsh-client-ui-conversation/lib/client.js`：
- `:17524` `input === void 0 || sessionId === void 0 ? null : renderSlot("conversation.input.left", {})` —— **props 为空对象**
- `:17532` `children: [input === void 0 || sessionId === void 0 ? null : renderSlot("conversation.input.right", {}), sessionId === void 0 ? null : renderSlot("conversation.input.model", { locked: modelSeatLocked })]` —— 同样空 props
- `:17522` `children: [sessionId === void 0 ? null : renderSlot("conversation.input.permission", { locked }), sessionId === void 0 ? null : renderSlot("conversation.input.plan", { locked })]`
- `:17536-17539` `children: renderSlot("conversation.input.activity", { locked, onActiveChange: setActivity })`
- `:17458-17473` `renderSlot("conversation.input.attachments", { attachments, canAcceptDrop, onAddFiles: intakeFiles, onRemoveAttachment: (id) => { removeAttachment?.(id); }, uploads, onRetryFile: (id) => { retryFileUpload?.(id); }, dropLimits: ... })`
- `:16309` `zone !== void 0 && renderSlot("conversation.input.dock", zone)`
- `:17452` `children: renderSlot("conversation.input.overlay", {})`

`conversation.input.attachments` 的 ownerProps 逐字（`dsh-cordis-client-runner/lib/client.js:2973`）：
```js
export interface ComposerAttachmentsOwnerProps {
  /** Browser-owned draft attachments in input order. */
  attachments: readonly ComposerAttachment[]
  /** Whether a document-level file drop may add attachments now. */
  canAcceptDrop: boolean
  onAddFiles: (files: readonly File[], directories?: ReadonlySet<File>) => void
  /** Remove one draft attachment through the Conversation service. */
  onRemoveAttachment: (id: DraftAttachmentId) => void
  /** Current per-draft upload states for file-kind attachments. */
  uploads: DraftFileUploads
  /** Restart one failed file upload. */
  onRetryFile: (id: DraftAttachmentId) => void
  /** Display-ready limits for the drop invitation. */
  dropLimits?: { readonly count: number; readonly size: string } | undefined
}
```

`conversation.view`（本插件已在用的槽）目录条目 `dsh-cordis-client-runner/lib/client.js:3722-3773`，
`standardProps` 里明确含 `inputActions: InputActions` 与 `sessionId: SessionId`，
`occupants: ["client-ui-chat ChatView id 'chat'", "client-ui-trajectory TrajectoryView id 'trajectory'"]`，`replaceRisk: "none"`。

### C3. 有没有可复用的官方附件 chip 组件？——没有

`dsh-client-ui-attachment/README.md:52` 逐字：
> "The plugin waits for `conversation.input.attachments`, `conversation.message.images`, `conversation.trajectory.images`, and `tool.call.images` through `ctx.slots.inject`. It then registers the composer rail, document drop target, shared history gallery ..., and original-image lightbox. **The presentation components are driven entirely by props: the slot owner supplies attachment data, image loading, callbacks, and the locale translator; the package entry exports no components.**"

同理 `dsh-client-ui-reference` 只注册 trigger source，不导出任何组件；
它引用的 `ui-primitives`（`README.md` 的 source map 列出 `ui-primitives/src/ImageLightbox.tsx`）按任务书是禁用依赖。

> **结论（C3）：官方 chip/卡片组件不可复用。想自定义外观必须自己写组件。**

### C4. `captureInsertion()` 返回什么

`dsh-client-ui-conversation/lib/client.js:13462-13485`（`SessionInputShell.actions` 公开面，逐字）
```js
actions = {
    captureInsertion: () => ({
        ...this.caretSpan(),
        draftRev: this.rev
    }),
    insertText: (text, span) => {
        if (this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting" || this.disposed) return false;
        if (span.draftRev !== this.rev) return false;
        return this.draftEditor.insertAsyncText(span, text);
    },
    setDraft: (text) => {
        this.setDraft(text);
    },
    addAttachments: (ids) => this.addAttachments(ids),
    removeAttachment: (id) => {
        this.removeAttachment(id);
    },
    pruneAttachments: (ids) => {
        this.pruneAttachments(ids);
    },
    submit: () => {
        this.submit("queue");
    }
};
```
配套文档（`:13455-13461`）：*"Insertion snapshot: the live caret/selection as a detect-coordinate span plus the draft revision that span belongs to. Every insert verb refuses a stale span, so callers capture immediately before inserting."*

> **是的：`captureInsertion()` 就是「记录当前插入点」的官方入口，
> 返回 `{ start, end, draftRev }`。所有 insert 动词都用 `draftRev` 做乐观并发检查。**

相关：`insertText` 的完整实现（`:13785-13807`）只查 `span.draftRev !== this.rev`，
没有 phase 检查、没有 chip —— 这就是「纯文本引用路径」。
`setDraft(text)` 是整体替换（`:13722` 区域），不是追加。

### C5. 附件为「合成内容」提供的具体通道（补充，A 的延伸）

客户端上传服务是一个真正的 cordis 服务：`FileUploadRuntime extends Service`，
`dsh-client-file-upload/lib/types/client/runtime.js:83-130`
```js
/** Cordis service that owns one background carrier per upload operation. */
export class FileUploadRuntime extends Service {
    ...
    constructor(ctx) {
        super(ctx, 'fileUpload');
        ...
    }
    /**
     * Store one file for a Session.
     * @param sessionId - Session that owns the staged receipt.
     * @param data - browser Blob, exact bytes, or a one-shot byte stream.
     * @param name - optional display name.
     * @param signal - optional cancellation for the active upload.
     * @param onProgress - optional byte-progress observer for background bodies.
     * @returns the staged receipt and durable file reference, or a business error.
     */
    async upload(sessionId, data, name, signal, onProgress) {
        if (!(data instanceof Uint8Array)) {
            ...
            return parseFileUploadResult(response.body);
        }
        return this.ctx.remote.fileUploads.upload(sessionId, {
            data: bytesToBase64(data),
            ...(name === undefined ? {} : { name }),
        }, signal);
    }
}
```
`parseFileUploadResult`（同文件 `:211-245`）返回 `{ok:true, value:{receiptId, file:{attachmentId,name,bytes}}}` 或 `{ok:false, error}`；
而 `Uint8Array` 分支直接返回 `FileUploadValue`。
**即 `data` 是 `Uint8Array` / `Blob` / `ReadableStream` 三选一，且 `name` 由调用方给定 —— 内容完全可以是合成的。**

`ConversationController.beginFileUpload(sessionId, attachment)`（`dsh-client-ui-conversation/lib/client.js:3517+`）
调用 `this.ctx.fileUpload.upload(sessionId, attachment.file, ...)`，成功时写入
`{status:"ready", receiptId: result.value.receiptId, file: result.value.file}`。
注意它读的是 `result.value.*`，与 `createDrafts` 的 `File`（Blob）分支一致。

**提交被上传状态阻塞**（这是好行为，不是坑）：
`dsh-client-ui-conversation/lib/client.js:17248`
```js
const uploadsPending = attachments.some((attachment) => attachment.kind === "file" && uploads[attachment.id]?.status !== "ready");
```
`:17403` `const primaryDisabled = primaryStops ? stop === void 0 : empty || disabled || machineBusy || uploadsPending;`
`:17415` `if (!empty && !disabled && !machineBusy && !uploadsPending) keyboard.submit(primarySubmitMode, "click");`
Enter 路径 `:16835-16838`
```js
if (g.uploadsPending) {
    g.showToast(g.t("file.stillUploading"));
    return;
}
```

---

## D. 可行方案排序

### 方案 1（推荐）：合成 `File` → `createDrafts` → `inputActions.addAttachments`

**调用链（全部是公开 API）**
1. 拿会话 id：本插件是 `conversation.view` 条目，标准 prop 里就有 `sessionId: SessionId`（目录 `:3762`）。
2. 拿 conversation 服务：`ctx.get("conversation")`（官方同款用法见 `dsh-client-ui-conversation/lib/client.js:14270`、`:14275`、`:15685`）。
3. 造一个 `File`：
   `const file = new File([JSON.stringify(selection)], "board-selection.json", { type: "application/json" });`
   —— 非图片 MIME ⇒ 走 `kind: "file"` 分支（`:3485-3492`）。
4. `const drafts = conversation.createDrafts(sessionId, [file]);` → 返回带 `id` 的描述符，并**立即开始后台上传**。
5. `inputActions.addAttachments(drafts.map((d) => d.id));`（`:13554-13561`，不做校验）。

**用户看到什么**：输入框上方立即出现官方样式的**文件卡片**——
`dsh-client-ui-attachment/README.md:32` 逐字：
> "draft rail = 64px-high items, image = 64px square thumbnail, generic file = 240px-wide card with gradient document glyph, filename, uppercase extension + byte size; hover/focus removal controls; retry on failure; click image opens original."

带上传进度；未就绪时发送键被禁用（`:17403`），按 Enter 会 toast `file.stillUploading`（`:16835`）。
卡片可删除（`removeAttachment`，`:13580-13587`）。
提交后模型拿到的是「一行句柄文本：文件名、字节数、digest 前缀、可读路径」
（`dsh-attachment/README.md:106`），需要时用文件工具读取。

**代价 / 不可靠之处**
- 附件形态只能是**字节**。想让 Agent 直接看到内容而不用去读文件，得把结构化内容**同时**放进草稿文本（`insertText`/`setDraft`）。
- 上传是异步的：`createDrafts` 只保证「已开始」，`serializeDraftAttachments` 在上传未就绪时**抛异常**
  `"conversation.serializeDraftAttachments: one or more files have not finished uploading"`（`:3626`）。
  实际交互中由 UI 挡住提交，但**若你自己调 `inputActions.submit()` 绕过 UI，就会撞这个错**。
  另有 `releaseDraftAttachment`（`:3637-3649`）会 abort 上传，草稿附件在会话切换时会被重新绑定/释放（`rebindDraftFiles` `:3511-3516`）。
- 依赖 `draftAttachments` 是「公开字段」这一事实吗？**不需要**——本方案全程只用 `createDrafts` + `addAttachments`，两者都是公开方法。
- `createDrafts` 需要网络/上传后端可用；离线（`customTransport`）下 `fileUpload` 可能失败，
  此时卡片会显示失败态并可重试（`retryFileUpload` `:3500-3505`）。

**为什么推荐**：这是唯一能**同时**满足「出现在输入框」「用户可删除」「跟着下一条消息发出去」「用户看得懂（官方卡片样式）」的方案，
而且不需要顶替任何官方槽、不需要注册新服务、不依赖未验证的 facade 行为。

### 方案 2：注册自己的 input-trigger source + 插入 reference chip（内容在草稿文本里，提交时由你的 codec 展开）

**调用链**
1. `const inputTriggers = ctx.get("inputTriggers");`
   `ctx.effect(() => inputTriggers.registerSource(source), "...")`，
   `source = { trigger: "@" | "/" | 你选的字符, name: "superboard", order: <n>, candidates, onPick, codec: { clipboardText: (ref) => ref, serialize: (ref) => Promise.resolve(modelText) } }`
   —— 形状逐字照抄 `dsh-client-ui-reference/lib/client.js:152-235`。
   `(trigger, name)` 必须唯一，否则 `registerSource` 抛 `slash source "..." is already registered`（`input-trigger:906`）。
2. 取 span：`const span = inputActions.captureInsertion();`
3. 派发：`const actx = ctx.sessions.scope(sessionId); actx.bail(actx, "slash/input-insert-reference", { reference: { source: "superboard", ref: <你的载荷>, label: "看板选区 ×3", appearance: "board", clipboardText: "@board-3" }, span }) === true`

**用户看到什么**：草稿文本里出现一个 chip（`data-composer-chip="superboard"`），
显示 `label` 与 `appearance` 字形，可复制（复制得到 `clipboardText`），
**不属于附件 rail**。提交时该 chip 的那一段被 `codec.serialize(ref)` 的返回值替换（`:13974`、`input-trigger:615-619`）。

**代价 / 不可靠之处**
- 不是「附件」，是「输入框里的一个 token」。用户要删它得按退格/选中删除。
- chip 插入时**不做 owner 校验**（`setInvalid` 全安装无调用），所以插入一定会成功；
  但**提交时**若 source 未注册或缺 `codec`，`serializeReference` **reject**，
  整个发送失败并回滚草稿（`:13986-13990` + JSDoc *"rejects the detached send and restores its editor snapshot"*）。
  也就是说：source 的生命周期必须覆盖提交时刻，插件被卸载而草稿里还有 chip 会导致发不出去。
- `appearance` 是**自由字符串**，但 `ReferenceChip` 组件如何把它映射成字形 **UNVERIFIED**（该组件的实现未在本轮读到）；
  传未知值可能不显示任何字形，只显示 `label`。
- 需要 `ctx.sessions.scope(sessionId)` 造一个会话作用域 ctx；
  另需确认本插件（静态 bundle）的 `ctx` 能否直接用 `ctx.sessions`——**UNVERIFIED**（但 `ctx.get("sessions")` 在目录里是已编目的可选查询，风险低）。
- 你自己的 source 会出现在 `@`/`/` 的候选菜单里（如果 `trigger` 与官方相同），可能造成菜单污染；需要仔细设计 `candidates` 或不用菜单。

### 方案 3：只用草稿文本（零附件、零 chip）

`inputActions.insertText(text, captureInsertion())`（`:13798-13801`）或 `inputActions.setDraft(...)`。
**用户看到什么**：纯文本被拼进草稿（例如追加一段 ```json 代码块```）。
**代价**：没有可删除的 chip，没有附件卡片，长内容会污染输入框；
但**最稳**——不依赖上传、不依赖 codec、没有失败模式。
适合「内容不大、只想要可编辑文本」的场景。

### 方案 4（备选，绕过输入框）：host 侧直接投递带附件的 prompt

本插件有 host 半（`src/index.js`），可以用
`ctx.attachments.saveFile({ data: Uint8Array, name })`（`api-catalog.js:406-411`、`6223-6225`）
或 `ctx.fileUploads.upload(agent, request, signal)`（`api-catalog.js:944`，*"Persist one encoded upload and stage it under the Agent receiver selected by Typert"*）
拿到 `{receiptId, file}`，再用
`ctx.sessionController.prompt(request: SessionPromptRequest, signal)`（`api-catalog.js:1929`，服务 key 见 `:1838`
*"Host service backing the generated `ctx.remote.session` namespace."*）
投递 `content: [{type:'file', receiptId}, {type:'text', text}]`。
`SessionPromptRequest` 逐字（`api-catalog.js:6703-6705`）
```js
export interface SessionPromptRequest {
    readonly requestId: SessionRequestId;
    readonly sessionId: SessionId;
    readonly mode: 'queue' | 'steer';
    readonly content: readonly PromptContentPart[];
    readonly clientTimeZone?: string;
}
```
**用户看到什么**：消息直接发出去，**输入框里什么都不出现**——不满足用户「附着在输入框上、可删除」的原始意图。
另外 `commands` 服务也有 `@Remote async execute(agent, line, submittedAttachments: readonly CommandSubmitAttachment[], signal)`
（`api-catalog.js:569`，服务 key `:540`），`CommandSubmitAttachment` 逐字 `api-catalog.js:4695-4697`
```js
export type CommandSubmitAttachment = ({
    readonly type: 'image';
} & EncodedImageAttachment) | {
    readonly type: 'file';
    readonly receiptId: string;
};
```
**列为备选而非推荐**：它是「不过输入框」的旁路，只在用户明确接受「点了就直接发」时才合适。

### 推荐结论

用户说「作为附件附着在输入框上，像附图一样，可删除，跟着下一条消息发出去」——
DSH 里**最接近的正规实现就是方案 1**：
`new File([...])` → `conversation.createDrafts(sessionId, [file])` → `inputActions.addAttachments(ids)`。
用户会看到官方附件卡片（文件名 + 扩展名 + 字节数 + 上传进度 + 删除按钮），
提交后模型收到一行可读句柄。**唯一需要放弃的期待是「纯文本附件」——附件必须是字节，但这不妨碍你把看板选区序列化成 JSON/Markdown 字节。**

如果想要**输入框内**的、带自定义字形的 token 感（而不是上方卡片），叠加方案 2；
如果只想让 Agent 立刻看到内容而不留痕，用方案 3（文本）或方案 4（直接投递）。

---

## 附：本轮未确证项（UNVERIFIED）

1. 静态安装的 `dsh-superboard` bundle 是否也套用 `dynamicCordisContext` 守卫
   （守卫定义 `dsh-cordis-client-runner/lib/client.js:328`，应用点 `:611`，构造点 `:6598`）。
   本报告推荐的方案 1 在「有守卫」和「无守卫」两种情况下都成立：
   只用 `ctx.get("conversation")`（守卫允许无声明查询）与 `inputActions`（标准 prop）。
2. `ReferenceChip` 组件如何把 `appearance` 映射为字形；传未知 `appearance` 的渲染结果。
3. 插件被卸载后草稿中残留 chip 在提交时的确切用户可见表现（已知会 reject 并回滚草稿，未读到 UI 文案）。
4. `commands`/`sessionController` 服务是否可从 client 半触达（它们是 host 服务；`ctx.remote.*` 命名空间见 `api-catalog.js:1839`）。
5. `conversation.createDrafts` 是否要求调用方 ctx 带会话作用域标签（其实现只用到 `sessionId` 形参，
   但 `ConversationController` 类内其它方法是 scope-addressed；本轮未读到 `scopeOf` 对 `createDrafts` 的检查）。
