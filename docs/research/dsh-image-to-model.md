# Can a board tool return a picture to the model?

Research into DSH Desktop **0.2.0-rc.2**, answering whether a plugin's tool can return an
image the model actually sees, and under what limits. This decides whether `dsh-superboard`
can offer "show me what the board looks like" as a tool the Agent calls.

Builds on two earlier documents and does not repeat them:

- [dsh-plugin-contract.md](dsh-plugin-contract.md) — host/plugin framework constraints.
- [dsh-composer-attachments.md](dsh-composer-attachments.md) — how the composer mints attachments.

**Sources.** The app ships as one asar at
`C:\Users\haoch\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`; a full extraction
lives at `C:\Users\haoch\AppData\Local\Temp\dsh-asar\`. Paths below are relative to
`C:\Users\haoch\AppData\Local\Temp\dsh-asar\dsh\node_modules\@deepseek-ai\` unless absolute.
Where a README and the code disagree, the code wins and this document says so.

**Answer in one line: yes.** A tool's `output.render` may return an `ImageBlock` alongside its
text, and the DeepSeek adapter explicitly supports images in tool results. `read_image` in
`@deepseek-ai/dsh-tool-fs` is the working precedent, and it is the template to copy.

---

## 1. Can a tool return an image to the model?

**Yes.** The content-block vocabulary a tool result may carry includes `image`, and the tool
result assembly path does not narrow it.

### 1.1 The content-block vocabulary

`dsh-tool-cordis/lib/types/api-catalog.js:4787-4788`:

```ts
export interface ContentBlockMap { 'text': TextBlock; 'reasoning': ReasoningBlock; 'image': ImageBlock; 'file': FileBlock; 'tool-call': ToolCallBlock; 'tool-addition': ToolAdditionBlock; 'tool-removal': ToolRemovalBlock; }
```

Seven kinds. `image` is one of them. The image block and its reference, verbatim,
`dsh-tool-cordis/lib/types/api-catalog.js:5263-5272`:

```ts
ImageAttachmentRef { attachmentId: AttachmentId; mediaType: ImageMediaType; bytes: number; width: number; height: number; name?: string; originalDimensions?: { width; height } }
export interface ImageBlock { type: 'image'; attachment: ImageAttachmentRef; offloaded?: true; }
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
```

`offloaded?: true` is the history-degradation marker described in §4; a tool never sets it.

### 1.2 `output.render` is typed to return content blocks

`dsh-tool-cordis/lib/types/api-catalog.js:7587-7588`:

```ts
export interface ToolOutputDefinition { readonly schema: JsonSchemaNode; render(args: unknown, value: JsonValue): ContentBlock[]; presentationMeta?(args: unknown, value: JsonValue): JsonValue; }
```

`render` returns `ContentBlock[]` — the full union, not a text-only subset. `presentationMeta` is
optional and, in the registry, explicitly may be absent
(`dsh-tools/lib/index.js:2881`, quoted in §1.4).

### 1.3 The assembly path

`dsh-tools/lib/index.js:3540-3571` (`createSuccessResult`):

1. `validateJsonSchemaValue(tool.output.schema, detached, "value")` — the returned *value* must
   satisfy the tool's output schema.
2. `deepFreeze` the value.
3. `rendered = tool.output.render(exec.arguments, value)` (`dsh-tools/lib/index.js:3548`).
4. `content = snapshotProjection(tool.name, "render", rendered)` (`dsh-tools/lib/index.js:3552`).

`snapshotProjection` (`dsh-tools/lib/index.js:2564-2573`) only requires the render output to be
lossless JSON; it throws `ToolOutputError(toolName, ["output.render returned non-lossless JSON"])`
otherwise. Note that "lossless JSON" here is strict — a key whose value is `undefined` fails the
whole call, it does not silently drop. See §6 for the consequence when building an image block.
It does **not** inspect block types — nothing in the host framework narrows a tool's
render output to text. The only gate on an image block is downstream, in the LLM adapter.
`materializeFinalResult` (`dsh-tools/lib/index.js:3591-3610`) then copies that array to
`presentation.content`.

Failure results are always text: `toolErrorResult` (`dsh-tools/lib/index.js:3616-3630`) shapes
them as `content: [{ type: "text", text: \`Error: ${message}\` }], isError: true, error: { message, …info }`.
So an image is a *success* shape only.

### 1.4 What registration permits

`dsh-tools/lib/index.js:2878-2887` (`register`):

```js
if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
assertSupportedJsonSchema(output.schema);
```

So: `output.schema` and `output.render` are mandatory; `presentationMeta` is free to omit. The
schema is checked against the supported subset, but the *rendered blocks* are not schema-checked
at all — which means an `ImageBlock` shape is a runtime contract with the adapter, not a compile-
or register-time one.

### 1.5 The adapter accepts images in tool results

`dsh-llm-deepseek/lib/index.js:1415-1416`:

```js
if (model?.inputModalities?.includes("image") !== true || attachments === void 0) throw new LlmError("DeepSeek Messages image input requires a vision model and attachment service", "UNSUPPORTED_CONTENT");
if (messages.some((message) => message.role !== "user" && message.role !== "tool" && contentHasImage(message.content))) throw new LlmError("DeepSeek Messages supports images only in user messages and tool results", "UNSUPPORTED_CONTENT");
```

`user` and `tool` are the only two roles allowed to carry an image — tool-result images are
named in the guard, not tolerated by accident. `imageRefs` (`dsh-llm-deepseek/lib/index.js:1395-1397`)
is the extractor the request path uses:

```js
function* imageRefs(blocks) { for (const block of blocks) if (block.type === "image") yield block.attachment; }
```

### 1.6 One asymmetry worth knowing: PTC mode

A tool reached through `run_code` (PTC mode) gets different handling. `dsh-tools/lib/index.js:1384-1387`:

```js
if (!result.isError && result.content.some((block) => block.type === "image")) exec.deferContext(createUserMessage({
  content: result.content,
  source: { kind: "ptc-mode" }
}));
```

A sub-dispatch returning an image is re-injected as a **user message** rather than flowing back
as an ordinary tool result. That is still model-visible — arguably more visible — but it is not
the same event shape. The root tool-call path has no such special case: `dsh-agent-loop/lib/index.js`
reads only `result.additionalContexts` (`:572`) and contains no `image` branch.

---

## 2. The existing tool that returns a picture: `read_image`

Registered by `@deepseek-ai/dsh-tool-fs`, gated on a mounted `ctx.attachments`. Implementation:
`dsh-tool-fs/lib/index.js:973-1057` (`applyReadImageTool`).

### 2.1 Definition, verbatim

- `name: "read_image"`; description (`dsh-tool-fs/lib/index.js:975-976`):
  > Read a PNG/JPEG/WebP/GIF file and return the image itself. Large images are downscaled automatically; do not install image libraries or create thumbnails to inspect an image.
- parameters (`dsh-tool-fs/lib/index.js:977-981`): `{ file_path: { type: "string", required: true } }`
- output schema (`dsh-tool-fs/lib/index.js:834-881`, `IMAGE_VALUE_SCHEMA`):
  `{ attachmentId: string, mediaType: enum[png|jpeg|webp|gif], bytes: integer, width: integer, height: integer, name?: string, originalDimensions?: { width, height } }`, every object `additionalProperties: false`
- `render: (_args, value) => imageReadContent(value)` (`dsh-tool-fs/lib/index.js:994`)
- `presentationMeta: (_args, value) => ({ path: value.path })` (`dsh-tool-fs/lib/index.js:995`)

### 2.2 The content it emits, verbatim

`imageReadContent` (`dsh-tool-fs/lib/index.js:955-963`) returns exactly two blocks:

```js
[{ type: "text", text: formatImageReadOutput(value.path, value.image) }, { type: "image", attachment: imageRefFromValue(value.image) }]
```

`formatImageReadOutput` (`dsh-tool-fs/lib/index.js:936-949`) produces the text envelope:

```
<path>…</path>
<type>image</type>
<content>
<mediaType> image, <w>x<h> px, <bytes> bytes<scaled>
</content>
```

`<scaled>` is empty unless `image.originalDimensions` is present, in which case it is built at
`:938-943` as:

```
 (downscaled from <ow>x<oh> px; multiply coordinates by <x> to locate features in the original file)
```

with the advice splitting into `multiply x coordinates by <x> and y coordinates by <y>` when the
two ratios differ. **That is the design detail worth stealing for a board snapshot:** the model is
told how to map a coordinate it reads off the rendered image back onto the original artifact. A
board picture scaled to fit the token budget needs the same affordance.

`imageRefFromValue` (`dsh-tool-fs/lib/index.js:917-927`) re-brands the value into a durable
reference — `AttachmentId(image.attachmentId)` for the opaque brand, with `name` and
`originalDimensions` spread in only when defined, so no `undefined` key ever lands in the block.

The envelope is not cosmetic: the client-side image card uses it as its recognition gate (§7.1).

### 2.3 What `execute` does

`dsh-tool-fs/lib/index.js:1008-1046`:

1. `byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)`
   (`:1008-1009`) — read no more than the smaller of the two byte limits.
2. `data = ctx.fs.readBytes(target, exec.signal, byteCap)`
3. `ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })`
   (`:1015-1019`)
4. returns `{ path: target.displayPath, image: { attachmentId: ref.attachmentId, mediaType, bytes, width, height, name?, originalDimensions? } }` (`:1035-1046`)

Format is established twice over: by extension (`IMAGE_EXTENSIONS`, `dsh-tool-fs/lib/index.js:792-798`:
`.png`→`image/png`, `.jpg`/`.jpeg`→`image/jpeg`, `.webp`→`image/webp`, `.gif`→`image/gif`) and by
signature sniffing (`sniffImageMediaType`, `dsh-tool-fs/lib/index.js:828-833`: PNG_SIGNATURE
`[137,80,78,71,13,10,26,10]` at `:799-808`, JPEG_SIGNATURE `[255,216,255]` at `:809-813`,
`GIF87a`/`GIF89a`, and `RIFF` at offset 0 plus `WEBP` at offset 8). Extension and bytes must
agree or the call fails.

### 2.4 It refuses on a non-vision route

`assertImageCapableRoute(ctx, exec, requestedPath)` (`dsh-tool-fs/lib/index.js:898-906`), verbatim:

```js
async function assertImageCapableRoute(ctx, exec, requestedPath) {
	const routed = exec.agent?.session.requestHeader()?.config;
	const provider = routed?.provider ?? exec.agent?.options.provider;
	const model = routed?.model ?? exec.agent?.options.model;
	const llm = ctx.get("llm");
	if (provider === void 0 || model === void 0 || llm === void 0) throw new Error(`cannot read "${requestedPath}" as an image: the current model route could not be resolved`);
	const active = await llm.resolveModelInfo(provider, model, exec.signal);
	if (active.inputModalities === void 0 || !active.inputModalities.includes("image")) throw new Error(`cannot read "${requestedPath}" as an image: model "${model}" does not declare image input; switch to an image-capable model to read images`);
}
```

Note the resolved-route source: the session's latest *routed* provider/model from the request
header config, falling back to the agent's static options — and `exec.signal` is threaded into the
resolution. This is the single most important design decision to copy: **the tool checks the route
before it commits an image to durable history.** The README states the intent
(`dsh-tool-fs/README.md:40`):

> `read_image` registers only while a durable `ctx.attachments` service is mounted; execution additionally refuses on a route whose exact model does not declare image input, so a text route's durable history stays free of image blocks.

Full error-string family, for parity if `dsh-superboard` mimics it:
`cannot read "<p>" as an image: the current model route could not be resolved`;
`cannot read "<p>" as an image: model "<model>" does not declare image input; switch to an image-capable model to read images`;
`cannot read "<p>" as an image: no attachment service is mounted`;
`cannot read "<p>": <mt> images are not accepted by this deployment`;
`cannot read "<p>": at least one image side exceeds the <maxImageDimension>px limit; downscale…`;
`cannot read "<p>": the image exceeds the <maxImagePixels>-pixel decoded-size limit; downscale…`;
`…within the deployment's byte limits; downscale…`;
`…the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`;
`…the <ext> extension declares <type>, but the bytes use a different image format; rename…`;
`…the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF`.

### 2.5 README, for the record

`dsh-tool-fs/README.md:196`:

> A successful `read_image` returns `<path><displayPath></path>`, `<type>image</type>`, and a `<content>` envelope naming the media type, normalized dimensions, and byte size, followed by the image itself as a native image block. The result is logged with its durable reference before the next model request.

README and code agree here.

---

## 3. The hard limits

### 3.1 The limits interface

`dsh-tool-cordis/lib/types/api-catalog.js:5259-5260`:

```ts
export interface ImageAttachmentLimits { maxImageBytes; maxImagesPerMessage; maxMessageImageBytes; maxImagePixels; maxImageDimension; mediaTypes: readonly ImageMediaType[] }
```

`ctx.attachments.imageLimits` (`dsh-tool-cordis/lib/types/api-catalog.js:350`) exposes it, which is
how a tool discovers the deployment's numbers instead of hardcoding them.

### 3.2 Effective defaults in this profile

`attachment-local` is enabled with **no config** (`dsh-base/cordis.patch.yml:138-139`), so its
constructor defaults apply
(`dsh-attachment-local/lib/index.js:998-1015`, all `?? defaults`), backed by named constants at
`dsh-attachment-local/lib/index.js:896-918`:

| Limit | Value | Constant |
| --- | --- | --- |
| `maxImageBytes` | 20971520 (20 MiB) | `DEFAULT_MAX_IMAGE_BYTES = 20*1024*1024` |
| `maxImagesPerMessage` | 20 | `DEFAULT_MAX_IMAGES_PER_MESSAGE = 20` |
| `maxMessageImageBytes` | 209715200 (200 MiB) | `DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 200*1024*1024` |
| `maxImagePixels` | 64e6 | `DEFAULT_MAX_IMAGE_PIXELS = 64e6` |
| `maxImageDimension` | 8192 | `DEFAULT_MAX_IMAGE_DIMENSION = 8192` |
| `mediaTypes` | `["image/png","image/jpeg","image/webp","image/gif"]` | — |

Normalization policy, verbatim (`dsh-attachment-local/lib/index.js:1011-1015`):

```js
{ maxPixels: config.normalizedImageMaxPixels ?? 4194304, maxDimension: config.normalizedImageMaxDimension ?? 8192, maxBytes: config.normalizedImageMaxBytes ?? 4194304 }
```

So the *storage* target is **4 MiB / 4,194,304 px / 8192 px per side**
(`DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS = 2048*2048`, `DEFAULT_NORMALIZED_IMAGE_MAX_BYTES = 4*1024*1024`).
Compression is bounded by `DEFAULT_IMAGE_COMPRESSION_CONCURRENCY = 2`, ceiling
`MAX_IMAGE_COMPRESSION_CONCURRENCY = 8`.

Batch validation, `dsh-attachment/lib/index.js:217-222` (only `saveImages` runs it, `:228-232`;
`saveImage` itself does not enforce the count):

- `AttachmentError("Image batch exceeds the configured image-count limit.", "TOO_MANY_IMAGES")` at `:219`
- `AttachmentError("Image batch exceeds the configured aggregate image-byte limit.", "IMAGES_TOO_LARGE")`
- `Image type ${input.mediaType} is not accepted by this deployment.` with code `"UNSUPPORTED_IMAGE_TYPE"`

### 3.3 Re-encoding: is the stored file the same file?

Not necessarily. `canPassThroughNormalization` (`dsh-attachment-local/lib/index.js:212-214`) passes
bytes through **only** when every one of these holds: `detected.mediaType !== "image/gif"`,
`!detected.animated`, `!detected.carriesMetadata`, `detected.depth === "uchar"`,
`detected.space === "srgb"`, `bytes <= policy.maxBytes`, `width*height <= policy.maxPixels`,
`max(w,h) <= policy.maxDimension`.

A clean ≤4 MiB 8-bit sRGB non-animated PNG with no metadata is therefore stored byte-identically.
Anything else goes through `normalizeImage` (`dsh-attachment-local/lib/index.js:255-271`), which
re-encodes with sharp via `.rotate().toColourspace("srgb").resize({fit:"inside", withoutEnlargement:true})`
and a quality ladder. A 16-bit PNG that cannot be converted fails the write with
`ATTACHMENT_WRITE_FAILED` and a message containing `16-bit PNG`. `saveImage` runs `prepareImageFile`
inside a `CompressionLimiter` (`dsh-attachment-local/lib/index.js:1031-1034`).

Practical consequence for a board renderer: emit an 8-bit sRGB PNG (or JPEG) with no metadata,
under 4 MiB and 4,194,304 px, and the bytes you hand to `saveImage` are the bytes the model is
shown.

### 3.4 Per-request downscale and budget (DeepSeek)

The stored image is *not* what the model receives. `dsh-llm-deepseek/lib/index.js:219-245`:

- `REQUEST_IMAGE_MAX_DIMENSION = 4096`
- `resolveRequestImageMaxBytes(model)` = `model.imageMaxBytes ?? 2097152` — **2 MiB**
- `resolveRequestImageTarget(model, source)` projects through `deepSeekRequestImageDimensions`,
  then, if `Math.max(projected.width, projected.height) > 4096`, through `longEdgeDimensions(…, 4096)`

`dsh-attachment/lib/index.js:338-341` exposes `readImageRequest(ref, target, signal)`, which derives
deterministic route-sized variants for `ImageRequestTarget = { width, height, maxBytes }`
(`dsh-tool-cordis/lib/types/api-catalog.js:5275-5276`); its reject code is
`"ATTACHMENT_PROJECTION_UNSUPPORTED"`. `dsh-attachment-local/lib/index.js:1056-1076`
(`requestVersion`) singleflights variant generation under `requestImageVariantId(ref, target)`.
README (`dsh-attachment-local/README.md:88`):

> `readImageRequest` scales without enlargement to the route-chosen target, resizing by the long edge only so the encoder derives the short edge as the route predicts, then applies a separate encoded-byte target through the same alpha routing and quality ladder.

**Vision-token cost is capped.** `dsh-llm-deepseek/lib/index.js:60-78`: the provider scales an image
below 544×544 total pixels *up*, aligns to a 14px patch grid, downsamples 3:1 per axis into token
cells, and caps one image at **`MAX_IMAGE_TOKENS = 1024`**. Constants: `PATCH_SIZE = 14`,
`DOWNSAMPLE_RATIO = 3`, `CELL_SIZE = 42`, `MIN_PIXELS = 544*544`. The comment at
`dsh-llm-deepseek/lib/index.js:62-65` says the count is exact for this configuration — "no
alignment pad and no aspect-ratio clamp. Actual usage remains authoritative."

**So one board image costs at most 1024 vision tokens, whatever its pixel size.** Output
dimensions below ~1344×1344 buy nothing.

### 3.5 Request-level budgets and the offload trigger

`bounds(connection, representation)` (`dsh-llm-deepseek/lib/index.js:1386-1394`):

- `"raw"` (Files references): `maxRequestFilesBytes`, default 134217728 = **128 MiB** (`:398`)
- `"base64"` (inline fallback): `maxInlineRequestImageBytes`, `DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES = 20*1024*1024` (`:23`)
- `maxImagesPerRequest`, default **600** (`:325`, `:402`)

`assertImagesFit` (`dsh-llm-deepseek/lib/index.js:1435-1438`) throws
`LlmError("… request images exceed the route budget; ${offloadImages} more oldest occurrence(s) must be offloaded.", IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages })`
when the budget is exceeded.

### 3.6 What a text-only route does with a returned image

It is replaced by deterministic placeholder text, never dropped. `dsh-llm/lib/index.js:558-560`:

> `[image omitted because this model accepts text only; attachment sha256:${String(ref.attachmentId).slice(7,15)}]`

applied by `projectImagesForTextModel` (`dsh-llm/lib/index.js:745-754`, called at `:2311` only when
the model lacks `"image"`).

### 3.7 Which models are vision-capable here

`dsh-llm-deepseek/lib/index.js:42-54`: `deepseek-flash` declares `inputModalities: ["text", "image"]`;
`deepseek-v4-pro` omits the field, which defaults to `["text"]` (`:303`, `:494`). The catalog is
advisory — "deployments may replace the catalog" (`:41`) — and `inputModalities` is validated to
contain only `"text"`/`"image"`, non-empty, no duplicates (`:349-353`).

**This session runs `deepseek-flash`, so the image path is live.**

### 3.8 The spill policy does not fight images

`dsh-spill-policy` is enabled with `maxInlineTokens: 12500` (`dsh-base/cordis.patch.yml:407-410`,
schema `dsh-spill-policy/lib/index.js:127`). Its `retainable` predicate
(`dsh-spill-policy/lib/index.js:129-131`) accepts only `text` and `image` blocks:

```js
function retainable(content) { return content.every((block) => block.type === "text" || block.type === "image"); }
```

and for a root call it returns early unless the content actually has images
(`if (exec.parent !== void 0 && !hasImages) return decision;`, `:237-255`), skipping `read`
entirely. Images are priced through `ctx.get("llm")?.imageRequestPricing(provider, model)`
(`:153`). A text-plus-one-image board result will not approach 12,500 tokens, so spill never
engages on it.

---

## 4. The image-offload path

`@deepseek-ai/dsh-compaction-image-offload`, panel id `image-offload`, enabled with no config
(`dsh-base/cordis.patch.yml:427-428`). The whole plugin is 154 lines,
`dsh-compaction-image-offload/lib/index.js`.

- `offloadOldestImages(session, sourceEventSeqs, count)` (`:14-44`) walks the failed request's
  input events in order, skips anything that is not `user/message` or `tool/result` (`:19`),
  counts *every* image occurrence including already-offloaded ones (`imageIndex += 1` for all;
  only un-offloaded ones go into `imageIndexes`, `:26-32`), then `session.append("image/offload", { targets })` (`:42`).
- `offloadMessageImages(message, indexes)` (`:55-84`) sets `offloaded: true` on the selected
  occurrences and returns a frozen copy.
- The projection `imageOffloadProjection` (`:97-121`), registered via
  `ctx.sessions.registerMessageProjection(imageOffloadProjection)` (`:140`), validates that targets
  cite a current surface node whose source type is `user/message` or `tool/result` (`:110`) and that
  indexes strictly increase (`:113`).
- Recovery listeners (`:141-151`): on `agent/request-error` with `failure.code === IMAGE_OFFLOAD_REQUIRED_CODE`
  it calls `offloadOldestImages(agent.session, agent.session.surface.nodes, failure.offloadImages)`
  and returns `{ kind: "retry" }`; on `compaction/summary-error` it does the same and returns `true`.

**Effect on what a tool may return: none.** Offload only rewrites *logged history*, marking
occurrences `offloaded: true`. It never constrains what a tool is permitted to emit. A returned
image is real image bytes until some later request exceeds the route budget, at which point the
oldest occurrences degrade to placeholder text via `offloadedImageText`
(`dsh-llm/lib/index.js:581-585`):

> `[image omitted to fit request image limits; ${imageIdentity(ref)}. Normalized copy (read-only; may be resized or re-encoded): …]`

Substitution machinery: `projectOffloadedImages` (`dsh-llm/lib/index.js:674-680`),
`replaceOffloadedImages` (`:659-672`), `requiredImageOffload` (`:720-728`). The LLM README
(`dsh-llm/README.md:108`) states the contract: an image-capable adapter "projects durable
references into route-specific request versions"; a text-only route "receives deterministic
per-image placeholders, including tool-role result images, without rewriting append-only session
history"; and "An image occurrence derived with `offloaded: true` reaches every route as
placeholder text through `projectOffloadedImages()`."

Practical reading: a board snapshot stays visible for many turns and degrades only under budget
pressure, oldest-first. Nothing to build for it.

---

## 5. Path on disk → content block

The only sanctioned route is the **attachment service**. Raw bytes go in, a durable reference
comes out, and the reference is what the `ImageBlock` carries:

```js
const ref = await ctx.attachments.saveImage({ data, mediaType, name })
// then: [{ type: 'image', attachment: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, name: ref.name } }]
```

Signatures, verbatim, `dsh-tool-cordis/lib/types/api-catalog.js`:

- `:387` `abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>`
- `:6231-6232` `export interface SaveImageAttachment { data: Uint8Array; mediaType: ImageMediaType; name?: string; }`
- `:355` `abstract validateImage(input: SaveImageAttachment): Promise<void>`
- `:361` `async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>`
- `:393` `abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>`
- `:432-435` `readImageRequest(ref, target, signal?)` → `Promise<RequestImageAttachment>`
- `:350` `abstract readonly imageLimits: ImageAttachmentLimits`

**You do not need a file on disk.** `saveImage` takes `Uint8Array`, so a renderer that produces a
`Buffer` in memory can go straight to a durable reference. The file-path route is the fallback:
`ctx.fs.readBytes(target, exec.signal, byteCap)` followed by `saveImage`, which is exactly what
`read_image` does (`dsh-tool-fs/lib/index.js:1008-1046`, §2.3). Both are working examples; the
in-memory one is shorter.

**No image library is declared by the plugin.** The `read_image` description tells the *model*
"do not install image libraries or create thumbnails to inspect an image"
(`dsh-tool-fs/lib/index.js:975-976`); that is guidance to the model, not a capability limit on a
plugin. Separately, `sharp` is genuinely reachable at runtime: it is a dependency of
`dsh-attachment-local` (`dsh-attachment-local/package.json:34-35`, `"sharp": "^0.35.3"`) and is
hoisted to the profile root at `C:\Users\haoch\.dsh\profiles\desktop\node_modules\sharp`, because
`dsh-superboard` is linked into that profile as `dsh-superboard`. It is **not** declared by
`E:\Dev\dsh-superboard\package.json` (whose only runtime dependency is `zod`, line 34-36), so
importing it would be leaning on a hoisted sibling. `dsh-attachment-local` itself treats it as
optional: `createLazyRequire("sharp", import.meta.url)` (`dsh-attachment-local/lib/index.js:118`),
resolved at first use. A board renderer should either declare its own renderer dependency or
encode PNG by hand; do not assume sharp.

---

## 6. Cheapest correct implementation for `dsh-superboard`

The plugin already exposes the exact seam. `E:\Dev\dsh-superboard\src\schema-dsl.js:123-135`:

```js
export function defineBoardTool({ name, description, parameters, outputSchema, render, execute, isConcurrencySafe }) {
  return {
    name, description, parameters,
    output: { schema: outputSchema, render: (args, value) => render(args, value) },
    ...(isConcurrencySafe === undefined ? {} : { isConcurrencySafe }),
    execute,
  }
}
```

and `textResult(text)` (`E:\Dev\dsh-superboard\src\schema-dsl.js:149-151`) already returns
`[{ type: 'text', text }]` — the exact content-block array. An image-returning tool is therefore
**one extra block**, not a new pipeline:

1. `outputSchema: { path: string, image: IMAGE_VALUE_SCHEMA }` — copy `IMAGE_VALUE_SCHEMA` from
   `dsh-tool-fs/lib/index.js:834-881` (all `additionalProperties: false`).
2. `render: (_args, value) => [textBlock(envelope(value)), { type: 'image', attachment: imageRef(value.image) }]`,
   where `imageRef` copies `dsh-tool-fs/lib/index.js:917-927` — dropping, not passing through, the
   optional keys that are absent. See the warning below; this is not stylistic.
3. `execute` renders the board region to bytes, calls `ctx.attachments.saveImage({ data, mediaType: 'image/png', name })`,
   returns the ref fields.
4. `presentationMeta: (_args, value) => ({ path: value.path })` — optional. `E:\Dev\dsh-superboard\src\schema-dsl.js:123-135`
   currently omits it entirely, which is legal. Only the `read_image` client card consumes `path`
   (§7.1), so it is worth adding purely to make a future client view a one-line change.

#### Warning: `undefined` in a content block kills the whole call

`snapshotProjection` (`dsh-tools/lib/index.js:3552`, `:2564-2573`) runs the render output through
`snapshotJsonValue` (`dsh-util-values/lib/index.js:159-161`), which **returns `undefined` for any
`undefined` value anywhere in the tree** — `typeof current !== "object"` at
`dsh-util-values/lib/index.js:109` catches it, and the caller turns that into
`ToolOutputError(toolName, ["output.render returned non-lossless JSON"])`. It is not a lenient
JSON round-trip: a present key with an `undefined` value is a hard failure, not an omitted key.
That is exactly why `imageRefFromValue` is written as
`...image.name === void 0 ? {} : { name: image.name }` (`dsh-tool-fs/lib/index.js:924-925`) rather
than `name: image.name`.

So build the block with conditional spreads:

```js
{ type: 'image', attachment: {
  attachmentId: ref.attachmentId, mediaType: ref.mediaType,
  bytes: ref.bytes, width: ref.width, height: ref.height,
  ...ref.name === undefined ? {} : { name: ref.name },
  ...ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } },
} }
```

The same applies to the *value* `execute` returns: it is validated against `output.schema` with
`additionalProperties: false` (`dsh-tools/lib/index.js:467-468`: `"<path>" is not a declared
property (additionalProperties: false)`), and an undefined-valued key is an undeclared-property
violation, not an absent one.

### Limits a caller must respect

| Requirement | Value | Source |
| --- | --- | --- |
| Media type | one of png/jpeg/webp/gif | `dsh-tool-cordis/lib/types/api-catalog.js:5271-5272` |
| Per-image stored bytes | ≤ 4 MiB to avoid re-encoding; hard cap 20 MiB | `dsh-attachment-local/lib/index.js:896-918`, `998-1015` |
| Stored pixels | ≤ 4,194,304 total, ≤ 8192 per side | `dsh-attachment-local/lib/index.js:1011-1015` |
| Request-side | ≤ 2 MiB, ≤ 4096 px long edge (auto-applied) | `dsh-llm-deepseek/lib/index.js:219-245` |
| Vision tokens | ≤ 1024 per image, regardless of size | `dsh-llm-deepseek/lib/index.js:70-78` |
| Route | model must declare `inputModalities` ⊇ `"image"` | `dsh-llm-deepseek/lib/index.js:1415` |
| Per request | ≤ 600 images aggregated | `dsh-llm-deepseek/lib/index.js:325`, `402` |
| Format for byte-identity | 8-bit sRGB, non-animated, no metadata | `dsh-attachment-local/lib/index.js:212-214` |
| JS shape | no `undefined` anywhere in value or render output | `dsh-util-values/lib/index.js:109`, `159-161`; `dsh-tools/lib/index.js:2564-2573` |

**Target: an 8-bit sRGB PNG, no metadata, ≤ 4 MiB, ≤ 4,194,304 px, long edge ≤ 4096.** Below
1344×1344 nothing is gained — 1024 tokens is the ceiling either way.

### Check the route first

Copy `assertImageCapableRoute` verbatim from `dsh-tool-fs/lib/index.js:898-906` (quoted in full in
§2.4). Without it, the tool burns a render on a route that will
replace the result with `[image omitted because this model accepts text only; …]`
(`dsh-llm/lib/index.js:558-560`), and the durable history gains an image block nobody can see.
Gate registration on `ctx.attachments` being mounted, as `read_image` does
(`dsh-tool-fs/README.md:40`): `dsh-tool-fs/lib/index.js:1204-1206` is the exact shape —

```js
ctx.inject(["attachments"], (imageCtx) => { applyReadImageTool(imageCtx); });
```

with `const attachments = ctx.get("attachments");` inside the tool body
(`dsh-tool-fs/lib/index.js:1003`). `E:\Dev\dsh-superboard\src\index.js:98-100` already uses the
same pattern for `tools` (`ctx.inject(['tools'], (scope) => { registerBoardTools(scope, projections) })`),
so `board_snapshot` can be registered from a second `ctx.inject(['tools', 'attachments'], …)` block
and simply not exist in profiles without an attachment service.

### Beware the PTC asymmetry

If the Agent calls a board tool through `run_code`, an image result is re-injected as a **user
message** (`dsh-tools/lib/index.js:1384-1387`) instead of returning as the tool result. Still
model-visible, different shape — worth a note in the tool description.

---

## 7. Client rendering (secondary)

Not required for the deliverable, recorded because it affects what the *user* sees.

### 7.1 The gallery card is hard-coded to `read_image`

`dsh-client-ui-tool/lib/client.js:2825`:

```js
if (call?.name !== "read_image") return null;
```

A custom `board_snapshot` tool returning a well-formed image block will **not** get the image
gallery card — it falls through to the generic flattened card. The card also requires
`fullyRendered` (`:2800-2804`: every block is a text-or-image object), a valid reference shape
(`imageReferences`, `:2735-2768`), and the envelope regex (`:2784`) — `IMAGE_ENVELOPE` at `:2684`:

```js
/^<path>[^\n]*<\/path>\n<type>image<\/type>\n<content>\n[\s\S]*\n<\/content>$/u
```

Matching that envelope is cheap and costs nothing, so emit it anyway; it makes a future
registration a one-line change rather than a content rewrite. `imageMeta` (`:2713-2718`) reads
`presentationMeta.path`. `dsh-client-ui-tool/README.md:46` documents the `loadImage` loader a
tool-view needs "for a view whose result carries durable images".

### 7.2 The model does not need any of this

None of §7 affects whether the model sees the picture. It does not.

---

## 8. What is genuinely undeterminable here

- **Whether an alternative attachment store (not `attachment-local`) accepts the same bytes.** The
  `AttachmentService` is an abstract interface (`dsh-tool-cordis/lib/types/api-catalog.js:350-393`)
  and this profile mounts `attachment-local`. Code against `imageLimits` and `saveImage`, not
  against 4 MiB.
- **Whether a deployment replaces the DeepSeek catalog** with different `inputModalities` or
  `imageMaxBytes`. The catalog is explicitly advisory (`dsh-llm-deepseek/lib/index.js:41`); resolve
  through `llm.resolveModelInfo` at call time rather than assuming `deepseek-flash`.
- **Whether `presentationMeta` survives a nested (`run_code`) call.** The client comment at
  `dsh-client-ui-tool/lib/client.js:2813-2815` says a nested `read_image` "persists no
  presentationMeta, so its label falls back to the call's own `file_path` argument" — i.e. it does
  not. Settle it by calling a board snapshot through `run_code` and inspecting the settled block.

---

## 9. Conclusion

**Yes — a plugin tool can return a rendered picture of a board region to the model.** The
framework imposes no block-type restriction: `output.render` is typed `(args, value) => ContentBlock[]`
(`dsh-tool-cordis/lib/types/api-catalog.js:7587-7588`), the `image` block is a first-class member of
the union (`:4787-4788`, `:5267-5268`), the assembly path only requires lossless JSON
(`dsh-tools/lib/index.js:3552`, `:2564-2573`), and the DeepSeek adapter names tool results as an
allowed image role in its guard (`dsh-llm-deepseek/lib/index.js:1416`).

**Cheapest correct implementation:** a fifth board tool — call it `board_snapshot` — built with the
existing `defineBoardTool` seam, whose `execute` renders the requested region to an **8-bit sRGB
PNG under 4 MiB and 4,194,304 px with a long edge ≤ 4096**, hands those bytes to
`ctx.attachments.saveImage({ data, mediaType: 'image/png', name })`, and whose `render` returns the
two-block array `[text, image]` — the text being the `<path>/<type>image</type>/<content>` envelope
`read_image` emits. Gate registration and execution on a mounted `ctx.attachments` and a route whose
model declares `inputModalities ⊇ "image"`, exactly as `read_image` does
(`dsh-tool-fs/lib/index.js:898-906`). No framework code changes, no client changes required, and the
whole cost to one call is at most **1024 vision tokens** (`dsh-llm-deepseek/lib/index.js:70-78`).

**Limits a caller must respect:** png/jpeg/webp/gif only; ≤ 4 MiB stored bytes (20 MiB hard) and
≤ 4,194,304 px / 8192 px per side, or the store silently re-encodes; the request layer then caps at
2 MiB and 4096 px long edge; ≤ 600 images per request; a text-only route replaces the image with
`[image omitted because this model accepts text only; …]`; and an image returned through `run_code`
arrives as a user message rather than a tool result. Image-offload (§4) never restricts what a tool
may return — it only rewrites logged history when a later request exceeds the budget.
