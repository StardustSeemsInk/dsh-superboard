/**
 * Preset-declaration tests: the three agent presets this bundle ships.
 *
 * These are not unit tests of a function. The presets are *data* in `cordis.patch.yml`, and the
 * failure modes that matter are the ones a typo produces at activation time, in a profile, with a
 * diagnostic that arrives long after the edit:
 *
 *   - a plugin list that restates the shipped one but silently drops a row, so the agent is missing
 *     a tool nobody notices until it is needed;
 *   - a duplicate child id, which the Loader rejects at mount;
 *   - a `!!js` scalar that a plain YAML parse turns into a string, so an OS-conditional row stops
 *     being conditional;
 *   - guidance that is attached to the wrong preset, or to no preset, leaving a role unguided.
 *
 * So this file parses the real patch with the Loader's own dialect — including the `!!js` tag — and
 * asserts the *composition*, not the text. Where it checks wording it checks for the two things the
 * user asked for by name: that the engineer preset steers to `grilling`, and that nothing mentions
 * billion-context.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

/** DSH's own js-yaml, when the extracted application is available. */
const DSH_YAML = 'C:/Users/haoch/AppData/Local/Temp/dsh-asar/dsh/node_modules/js-yaml/index.js'

/**
 * The Loader's entry-list dialect.
 *
 * `cordis-plugin-include/lib/index.js:15-29` builds `JSON_SCHEMA.extend(JsExpr)`, and this is the
 * same construction. The distinction matters: a plain `yaml.load` throws
 * `unknown tag !<tag:yaml.org,2002:js>` on every `disabled: !!js …` row, so a test that skipped this
 * would have to strip them — and would then be blind to exactly the class of mistake above.
 */
async function entryListSchema() {
  const yaml = (await import(`file:///${DSH_YAML}`)).default
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
    represent: (data) => data['__jsExpr'],
  })
  return { yaml, schema: yaml.JSON_SCHEMA.extend(JsExpr) }
}

const haveDsh = existsSync(DSH_YAML)

/** The three presets, their derived-from mode, and the child ids that mode requires. */
const PRESETS = [
  { rowId: 'preset-engineer', id: 'engineer', order: 10 },
  { rowId: 'preset-teacher', id: 'teacher', order: 11 },
  { rowId: 'preset-researcher', id: 'researcher', order: 12 },
]

/**
 * The rows every one of the three presets must carry, because all three derive from the shipped
 * `standard` preset (`dsh-web-app/presets/standard.patch.yml:10-146`).
 */
const SHARED_PLUGIN_IDS = [
  'persona',
  'agent-instructions',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-jobs',
  'skill-filesystem',
  'tool-skill',
  'command-goal',
  'tool-goal',
  'planning',
  'delegation',
  'tool-ask-user',
  'tool-todo',
  'tool-web',
  'present',
  'tool-plugin-manager',
]

/**
 * Find a child row anywhere in a plugin list, including inside a `cordis:group`.
 *
 * The nested groups are the reason this exists: `workflow-ptc` and `tool-workflow` live inside the
 * `delegation` group's `config`, not at the top level of `plugins`. A flat `find` returns
 * `undefined` for them, and asserting on `undefined.disabled` fails in a way that reads like a
 * missing row rather than a wrong lookup.
 *
 * @param plugins - a preset's plugin list.
 * @param id - the child row id to find.
 * @returns the row, or `undefined`.
 */
function findPlugin(plugins, id) {
  for (const plugin of plugins) {
    if (plugin?.id === id) return plugin
    if (Array.isArray(plugin?.config)) {
      const nested = findPlugin(plugin.config, id)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Load and parse the patch exactly as the Loader would. */
async function loadPatch() {
  const { yaml, schema } = await entryListSchema()
  const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const doc = yaml.load(text, { schema })
  assert.ok(Array.isArray(doc), 'cordis.patch.yml must be a top-level array of patch entries')
  return { doc, text }
}

/** Every inserted declaration row, flattened across `insert` blocks. */
function insertedRows(doc) {
  const rows = []
  for (const patch of doc) for (const row of patch.insert ?? []) rows.push(row)
  return rows
}

test('the patch mounts the board itself, once', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const mounts = insertedRows(doc).filter((row) => row.name === 'dsh-superboard')
  assert.equal(mounts.length, 1, 'exactly one row should mount the plugin')
  assert.equal(mounts[0].id, 'dsh-superboard')
})

test('the patch declares exactly the three presets, as new rows', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc).filter((row) => row.name === '@deepseek-ai/dsh-agent-preset')
  assert.deepEqual(
    rows.map((row) => row.id),
    PRESETS.map((p) => p.rowId),
    'one declaration per preset, under the conventional preset-<id> row id',
  )
  // A patch with an `id` and no `insert` targets the id, and would therefore *replace* a shipped
  // preset rather than add one. None of these may be an override.
  const overrides = doc.filter((patch) => patch.insert === undefined)
  for (const patch of overrides) {
    assert.ok(
      !PRESETS.some((p) => p.rowId === patch.id),
      `preset ${patch.id} must be inserted, not overridden`,
    )
  }
})

test('each preset carries its declared identity and roster order', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc)
  for (const preset of PRESETS) {
    const row = rows.find((candidate) => candidate.id === preset.rowId)
    assert.ok(row, `${preset.rowId} is missing`)
    assert.equal(row.config.id, preset.id, `${preset.rowId} preset identity`)
    assert.equal(row.config.order, preset.order, `${preset.rowId} roster order`)
    assert.equal(typeof row.config.name, 'string', `${preset.rowId} needs a display name`)
    assert.equal(typeof row.config.description, 'string', `${preset.rowId} needs a description`)
  }
})

test('roster orders are unique and clear of the shipped presets', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const orders = insertedRows(doc)
    .filter((row) => row.name === '@deepseek-ai/dsh-agent-preset')
    .map((row) => row.config.order)
  assert.equal(new Set(orders).size, orders.length, 'two presets share a roster order')
  // The shipped presets occupy 1..4 (standard 1, ptc 2, minimal 3, cordis 4). Starting at 10 keeps
  // the three additions visibly grouped at the end of the roster and leaves room for a future
  // shipped preset without a reshuffle.
  for (const order of orders) {
    assert.ok(order > 4, `roster order ${order} would interleave with the shipped presets`)
  }
})

test('each preset restates the shipped standard plugin list', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc)
  for (const preset of PRESETS) {
    const row = rows.find((candidate) => candidate.id === preset.rowId)
    const ids = row.config.plugins.map((plugin) => plugin.id)
    for (const required of SHARED_PLUGIN_IDS) {
      assert.ok(
        ids.includes(required),
        `${preset.rowId} is missing the "${required}" row that the shipped standard preset has`,
      )
    }
  }
})

test('no preset declares a duplicate child id', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc)
  for (const preset of PRESETS) {
    const ids = rows
      .find((candidate) => candidate.id === preset.rowId)
      .config.plugins.map((plugin) => plugin.id)
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
    assert.deepEqual(duplicates, [], `${preset.rowId} repeats child id(s): the Loader rejects these`)
  }
})

test('the two group rows keep their isolate realms', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc)
  for (const preset of PRESETS) {
    const plugins = rows.find((candidate) => candidate.id === preset.rowId).config.plugins
    const planning = plugins.find((plugin) => plugin.id === 'planning')
    const delegation = plugins.find((plugin) => plugin.id === 'delegation')
    assert.equal(planning.group, true, `${preset.rowId}: planning must stay a group`)
    assert.deepEqual(planning.isolate, { planMode: true }, `${preset.rowId}: planning realm`)
    assert.equal(delegation.group, true, `${preset.rowId}: delegation must stay a group`)
    assert.deepEqual(
      delegation.isolate,
      { workflowEngine: true },
      `${preset.rowId}: delegation realm`,
    )
  }
})

test('the OS-conditional shell rows survive as !!js expressions', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc)
  for (const preset of PRESETS) {
    const plugins = rows.find((candidate) => candidate.id === preset.rowId).config.plugins
    // `tool-bash` is disabled on win32 and `tool-pwsh` off it. If the dial ect lost the tag these
    // would be the *strings* "process.platform === 'win32'" — truthy, so both shells would be
    // disabled everywhere, and the agent would have no shell at all.
    assert.ok(
      JSON.stringify(plugins).includes('__jsExpr'),
      `${preset.rowId}: !!js expressions were flattened, so the shell rows stopped being conditional`,
    )
    const bash = plugins.find((plugin) => plugin.id === 'tool-bash')
    const pwsh = plugins.find((plugin) => plugin.id === 'tool-pwsh')
    assert.equal(typeof bash.disabled?.__jsExpr, 'string', `${preset.rowId}: tool-bash predicate`)
    assert.equal(typeof pwsh.disabled?.__jsExpr, 'string', `${preset.rowId}: tool-pwsh predicate`)
    assert.match(bash.disabled.__jsExpr, /win32/)
    assert.match(pwsh.disabled.__jsExpr, /win32/)
  }
})

test('the researcher preset inherits the PTC delegation shape', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc)
  const researcher = rows.find((row) => row.id === 'preset-researcher')
  const plugins = researcher.config.plugins
  // These three live inside the `delegation` group, so a flat search would not find them.
  const workflow = findPlugin(plugins, 'workflow-ptc')
  const toolWorkflow = findPlugin(plugins, 'tool-workflow')
  assert.ok(workflow, 'preset-researcher must declare workflow-ptc')
  assert.ok(toolWorkflow, 'preset-researcher must declare tool-workflow')
  assert.equal(workflow.disabled, true, 'the PTC mode disables workflow-ptc')
  assert.equal(toolWorkflow.disabled, true, 'the PTC mode disables tool-workflow')
  const presentation = findPlugin(plugins, 'tool-presentation')
  assert.ok(presentation, 'the PTC mode mounts tool-presentation')
  assert.equal(presentation.config.mode, 'ptc')

  // The other two derive from `standard`, where the workflow rows are enabled and there is no
  // presentation row at all.
  for (const rowId of ['preset-engineer', 'preset-teacher']) {
    const other = rows.find((row) => row.id === rowId).config.plugins
    assert.equal(
      findPlugin(other, 'workflow-ptc').disabled,
      undefined,
      `${rowId} derives from standard, where workflow-ptc is enabled`,
    )
    assert.ok(
      findPlugin(other, 'tool-presentation') === undefined,
      `${rowId} derives from standard, which has no tool-presentation row`,
    )
  }
})

test('every preset mounts exactly one guidance row, pointing at this bundle', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc)
  for (const preset of PRESETS) {
    const plugins = rows.find((candidate) => candidate.id === preset.rowId).config.plugins
    const guidance = plugins.filter((plugin) => plugin.id === 'board-guidance')
    assert.equal(guidance.length, 1, `${preset.rowId} needs exactly one guidance row`)
    // `dsh-superboard/preset` is the exports subpath this bundle declares; a typo here would resolve
    // to nothing and the preset's activation would fail.
    assert.equal(guidance[0].name, 'dsh-superboard/preset')
    assert.ok(
      typeof guidance[0].config.section === 'string' && guidance[0].config.section.trim().length > 0,
      `${preset.rowId} guidance must be non-empty`,
    )
  }
})

test('the guidance is about the board, and each role reads differently', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc)
  const sections = {}
  for (const preset of PRESETS) {
    const plugins = rows.find((candidate) => candidate.id === preset.rowId).config.plugins
    sections[preset.id] = plugins.find((plugin) => plugin.id === 'board-guidance').config.section
    // Every preset should name the tools, or the guidance is not actionable.
    for (const tool of ['board_outline', 'board_read', 'board_apply']) {
      assert.ok(
        sections[preset.id].includes(tool),
        `${preset.rowId} guidance should name ${tool}`,
      )
    }
  }
  // Distinct prose per role: the three are not one shared block pasted three times.
  const distinct = new Set(Object.values(sections))
  assert.equal(distinct.size, 3, 'each preset needs its own guidance text')
})

test('the engineer preset steers to the grilling skill', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc)
  const engineer = rows
    .find((row) => row.id === 'preset-engineer')
    .config.plugins.find((plugin) => plugin.id === 'board-guidance').config.section
  assert.match(engineer, /grilling/, 'the user asked for the engineer preset to name grilling')
  // And it must be framed as conditional on the skill existing, not as an assumption.
  assert.match(
    engineer,
    /available|if /i,
    'the guidance should treat optional capabilities as conditional',
  )
})

test('no preset guidance names billion-context, which supplies its own prompt', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc)
  // The user was explicit: billion-context already carries a complete prompt of its own, so a
  // mention in the *guidance* would only add noise. This checks the text that reaches a model —
  // the patch's own explanatory comments are documentation and may name it.
  const guidance = []
  for (const preset of PRESETS) {
    const plugins = rows.find((candidate) => candidate.id === preset.rowId).config.plugins
    guidance.push(plugins.find((plugin) => plugin.id === 'board-guidance').config.section)
  }
  for (const section of guidance) {
    assert.ok(!/billion/i.test(section), 'preset guidance must not mention billion-context')
  }
  // Nor should any other model-facing string in the declarations.
  const modelFacing = JSON.stringify(
    rows.filter((row) => row.name === '@deepseek-ai/dsh-agent-preset').map((row) => row.config),
  )
  assert.ok(!/billion/i.test(modelFacing), 'no model-facing preset field should mention billion-context')
})

test('no preset guidance tells the model to position blocks numerically', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc)
  // The board's whole layout model is "declare a template, never a position". Guidance that told an
  // agent to place blocks would contradict the tool surface it is onboarding to.
  for (const preset of PRESETS) {
    const plugins = rows.find((candidate) => candidate.id === preset.rowId).config.plugins
    const section = plugins.find((plugin) => plugin.id === 'board-guidance').config.section
    assert.ok(
      !/\bpx\b|left:\s*\d|top:\s*\d|\bx:\s*\d|\by:\s*\d/.test(section),
      `${preset.rowId} guidance must not suggest numeric positioning`,
    )
    // The positive half of the same rule: the guidance should say layout is declared.
    assert.match(
      section,
      /declared|template/i,
      `${preset.rowId} guidance should say layout is declared through a template`,
    )
  }
})

test('the YAML anchors expand, so no preset is missing a shared block', async () => {
  if (!haveDsh) return
  const { doc } = await loadPatch()
  const rows = insertedRows(doc)
  // The three presets share `persona`, `planning` and `delegation` through anchors. An anchor that
  // failed to expand would leave `undefined` entries, which JSON.stringify would drop silently.
  for (const preset of PRESETS) {
    const plugins = rows.find((candidate) => candidate.id === preset.rowId).config.plugins
    assert.ok(plugins.every((plugin) => plugin !== null && typeof plugin === 'object'))
    assert.ok(plugins.every((plugin) => typeof plugin.id === 'string' && plugin.id.length > 0))
    assert.equal(plugins.filter((plugin) => plugin.id === 'persona').length, 1)
    const persona = plugins.find((plugin) => plugin.id === 'persona')
    assert.match(persona.config.prefix, /\{\{model\}\}/, 'persona interpolates the model name')
    assert.ok(!persona.config.complete, 'complete would suppress the harness tool guidance')
  }
})
