/**
 * Schema helpers for the board tools.
 *
 * `ctx.tools.register` takes **compiled JSON Schema** — it runs no author-spec conversion of
 * its own (`dsh-tools/lib/index.js:2878-2887`). The official `defineTool` helper does that
 * compilation, but it lives in `@deepseek-ai/dsh-tools`, and this plugin deliberately imports
 * nothing from `@deepseek-ai/*` at runtime: those packages must be the host's instances, and
 * a local copy would be a second one.
 *
 * So these helpers emit the compiled form directly. Two things they enforce on the caller's
 * behalf, both of which are silent traps otherwise:
 *
 *   1. **The enforced subset.** `assertSupportedJsonSchema` rejects anything outside
 *      `type/oneOf/properties/required/additionalProperties/items/enum/const` plus
 *      annotations, rejects type arrays, and requires `additionalProperties` to be a boolean
 *      wherever an object is described (`dsh-tools/lib/index.js:196-260`).
 *   2. **`const` as the discriminator.** Inside `oneOf`, every branch must match exactly once.
 *      A discriminator declared as `enum` can match two branches and fail `oneOf` — with an
 *      error the model cannot act on, because it is the schema walk's text, not ours.
 *
 * @module dsh-superboard/schema-dsl
 */

/**
 * A string property.
 *
 * @param description - model-facing explanation.
 * @param extra - `enum`, `const`, etc.
 * @returns the property schema.
 */
export function str(description, extra = {}) {
  return { type: 'string', description, ...extra }
}

/** A numeric property. */
export function int(description, extra = {}) {
  return { type: 'integer', description, ...extra }
}

/** A boolean property. */
export function bool(description, extra = {}) {
  return { type: 'boolean', description, ...extra }
}

/**
 * A string property constrained to a fixed vocabulary.
 *
 * @param description - model-facing explanation.
 * @param values - the allowed values.
 * @returns the property schema.
 */
export function oneOfStrings(description, values) {
  return { type: 'string', description, enum: [...values] }
}

/**
 * A discriminated-union branch, keyed on `op`.
 *
 * The `const` matters: `oneOf` requires exactly one branch to match, and an `enum`
 * discriminator can match several at once.
 *
 * @param op - the op name this branch accepts.
 * @param properties - the branch's own properties (the discriminator is added here).
 * @param required - branch-local required keys, excluding `op` which is always required.
 * @returns the branch schema.
 */
export function opBranch(op, properties, required = []) {
  return closedObject({ op: { const: op, type: 'string' }, ...properties }, ['op', ...required])
}

/**
 * An object schema with `additionalProperties: false`.
 *
 * The flag is explicit because the subset requires it rather than defaulting it, and because
 * an unknown field is worth rejecting loudly — it is almost always a typo in a field name,
 * and silently dropping it would leave the Agent believing it set something.
 *
 * @param properties - the object's properties.
 * @param required - which of them are required.
 * @param description - optional model-facing explanation.
 * @returns the object schema.
 */
export function closedObject(properties, required = [], description = undefined) {
  return {
    type: 'object',
    ...(description === undefined ? {} : { description }),
    properties,
    required: [...required],
    additionalProperties: false,
  }
}

/**
 * An array-of-strings schema.
 *
 * @param description - model-facing explanation.
 * @param items - the item schema; defaults to a plain string.
 * @returns the array schema.
 */
export function arrayOf(description, items = { type: 'string' }) {
  return { type: 'array', description, items }
}

/**
 * An open object schema, for values the plugin does not constrain.
 *
 * @param description - model-facing explanation.
 * @returns the object schema.
 */
export function openObject(description) {
  return { type: 'object', description, additionalProperties: true }
}

/**
 * Assemble a registry-ready tool definition.
 *
 * `ctx.tools.register` requires `output` to carry both `schema` and `render`
 * (`dsh-tools/lib/index.js:2881`), and validates the schema against the same subset.
 *
 * @param options - name, description, parameters, output schema, execute, and optional render.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function defineBoardTool({ name, description, parameters, outputSchema, render, execute, isConcurrencySafe }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => render(args, value),
    },
    ...(isConcurrencySafe === undefined ? {} : { isConcurrencySafe }),
    execute,
  }
}

/**
 * Wrap the model-visible text of a successful call.
 *
 * @param text - the rendered text.
 * @returns the content-block array a tool returns.
 */
export function textResult(text) {
  return { content: [{ type: 'text', text }] }
}
