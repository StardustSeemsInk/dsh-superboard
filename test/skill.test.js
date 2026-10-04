/**
 * Skill-provider tests: the board's Agent-facing documentation.
 *
 * The tool descriptions ride **every** request, so they are the wrong place for a page about what a
 * board looks like once it exists. A skill is the right place: the catalog advertises one line, and
 * the body is fetched only by sessions that actually write a board. That makes the skill the
 * plugin's real documentation surface for an Agent — which is exactly why it needs the same
 * treatment as the tool descriptions, and why these tests check the *content* and not just that a
 * file exists.
 *
 * The failure modes that matter:
 *
 *   - the provider never registers, so the skill is invisible and the documentation does not exist;
 *   - `list()` returns a summary but `get()` cannot produce the body, so the catalog advertises
 *     something the Agent cannot load;
 *   - the frontmatter is malformed in a way that yields an empty name or description, which the
 *     registry rejects — or worse, silently drops from the catalog;
 *   - the prose drifts from the renderer, which is the specific failure this skill was written to
 *     fix. A document that confidently describes behaviour the code does not have is worse than no
 *     document.
 *
 * Run with `node --test`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { registerBoardSkills, SHIPPED_SKILL_NAMES, SKILL_PROVIDER_NAME } from '../src/skill.js'
import { LAYOUT_TEMPLATES } from '../src/model.js'

/** A stand-in for `ctx` that captures the registered provider. */
function harness() {
  let provider
  const ctx = {
    skills: {
      registerProvider(factory) {
        provider = factory({})
      },
    },
  }
  registerBoardSkills(ctx)
  return { provider }
}

/** Load one skill through the provider's own two-step protocol. */
async function load(name) {
  const { provider } = harness()
  const summaries = await provider.list({})
  const summary = summaries.find((candidate) => candidate.name === name)
  assert.ok(summary, `${name} is not in the catalog`)
  const skill = await provider.get(summary, {})
  assert.ok(skill, `${name} advertised but get() returned nothing`)
  return { summary, skill }
}

test('the provider registers under its own name', () => {
  const { provider } = harness()
  assert.equal(provider.name, SKILL_PROVIDER_NAME)
  // A collision with DSH's own `filesystem` provider would shadow it or be shadowed by it.
  assert.notEqual(provider.name, 'filesystem')
})

test('the catalog advertises exactly the skills this package ships', async () => {
  const { provider } = harness()
  const summaries = await provider.list({})
  assert.deepEqual(
    summaries.map((summary) => summary.name).sort(),
    [...SHIPPED_SKILL_NAMES].sort(),
    'a skill added or removed without updating SHIPPED_SKILL_NAMES',
  )
})

test('every advertised skill is model-invocable and carries a description', async () => {
  const { provider } = harness()
  for (const summary of await provider.list({})) {
    // The catalog shows `name: description`, and the Agent decides from that line whether to load
    // the body. An empty description makes the skill unfindable even though it is listed.
    assert.equal(typeof summary.description, 'string')
    assert.ok(summary.description.length > 40, `${summary.name}: description is too thin to choose on`)
    assert.equal(summary.invocation.modelInvocable, true)
    assert.equal(summary.invocation.userInvocable, true)
    assert.equal(summary.provider, SKILL_PROVIDER_NAME)
  }
})

test('every advertised skill can actually be loaded', async () => {
  const { provider } = harness()
  for (const summary of await provider.list({})) {
    const skill = await provider.get(summary, {})
    assert.ok(skill, `${summary.name}: get() returned nothing`)
    assert.equal(skill.name, summary.name)
    assert.equal(skill.description, summary.description)
    assert.ok(skill.content.length > 500, `${summary.name}: body is too thin to be useful`)
    // A directory base is what makes a relative reference inside a skill resolvable.
    assert.equal(skill.resourceBase.kind, 'directory')
    assert.equal(skill.path.endsWith('SKILL.md'), true)
  }
})

test('the skill name is valid kebab-case, which the registry enforces', async () => {
  const { provider } = harness()
  for (const summary of await provider.list({})) {
    assert.match(summary.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${summary.name} is not a valid name`)
  }
})

test('frontmatter is parsed, and the body excludes it', async () => {
  const { skill } = await load('board-layout')
  assert.equal(skill.name, 'board-layout')
  assert.ok(skill.description.startsWith('How a board actually renders'))
  assert.equal(skill.content.includes('name: board-layout'), false, 'frontmatter leaked into the body')
  assert.ok(skill.content.startsWith('# Laying out a board'))
})

// ---------------------------------------------------------------------------
// The content, which is the point of the skill
// ---------------------------------------------------------------------------

test('the layout skill names every template the model can actually choose', async () => {
  const { skill } = await load('board-layout')
  // A template the renderer supports but the documentation never mentions is indistinguishable, to
  // an Agent, from one that does not exist. This is the same contract the tool descriptions are held
  // to, applied to the surface that has room to explain them.
  for (const template of LAYOUT_TEMPLATES) {
    assert.ok(
      skill.content.includes(`\`${template}\``),
      `the skill never names the \`${template}\` template`,
    )
  }
})

test('the skill teaches the two facts behind the ugly boards it exists to prevent', async () => {
  const { skill } = await load('board-layout')
  // 1. Every block is its own card, so a heading and its list need a group to read as one unit.
  assert.match(skill.content, /Every block is its own card/)
  assert.match(skill.content, /A `group` is the only thing that draws one box/)
  // 2. A grid fills row-major, and the column count depends on a width the Agent cannot see, so
  //    adjacency must never be used to express ownership.
  assert.match(skill.content, /row-major/)
  assert.match(skill.content, /Adjacency is not ownership/)
})

test('the skill warns about canvas, which arranges nothing', async () => {
  const { skill } = await load('board-layout')
  // The dangerous reading is "canvas = I can place things". Nothing on the board has coordinates.
  assert.match(skill.content, /`canvas` is not a free canvas/)
  assert.match(skill.content, /Nothing on the board has coordinates/)
})

test('the skill names the fields that have no visual effect', async () => {
  const { skill } = await load('board-layout')
  // These are accepted, stored and hashed, and change nothing on screen. An Agent that spends a
  // round on `collapsed` has lost a round.
  for (const field of ['collapsed', 'checked', 'naturalSize', 'crop', 'waypoints']) {
    assert.ok(skill.content.includes(field), `the skill does not mention the no-op field ${field}`)
  }
})

test('the skill describes masonry as the waterfall it is, not as a grid', async () => {
  const { skill } = await load('board-layout')
  assert.match(skill.content, /waterfall/)
  // The one consequence an Agent must know: multi-column filling is column-major.
  assert.match(skill.content, /column by column/i)
})

// ---------------------------------------------------------------------------
// The plugin surface
// ---------------------------------------------------------------------------

test('the package ships the skills directory and declares the subpath', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  // Without `skills` in `files`, an installed copy has no bodies and every `get()` returns nothing.
  assert.ok(manifest.files.includes('skills'), 'package.json `files` must ship the skills directory')
  assert.equal(manifest.exports['./skill'], './src/skill.js')
})
