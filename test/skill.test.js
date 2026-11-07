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

test('the skill names the fields that have no visual effect, and only those', async () => {
  const { skill } = await load('board-layout')
  // Two fields are still accepted, stored and hashed and change nothing on screen. An Agent that
  // spends a round on either has lost a round.
  for (const field of ['rel', 'anchors']) {
    assert.ok(skill.content.includes(field), `the skill does not mention the no-op field ${field}`)
  }
  // The list used to be five. Three were removed from the model rather than implemented, and the
  // section has to keep saying so: the reason the old list existed is that an Agent cannot tell a
  // field the renderer ignores from a field it simply has not used yet.
  assert.match(skill.content, /were \*\*removed\*\* from the model/)
  // The other two went the opposite way and are now load-bearing.
  assert.match(skill.content, /now real/)
})

test('the skill describes masonry as the waterfall it is, not as a grid', async () => {
  const { skill } = await load('board-layout')
  assert.match(skill.content, /waterfall/)
  // The one consequence an Agent must know: multi-column filling is column-major.
  assert.match(skill.content, /column by column/i)
})

test('the skill says a group carries its own layout, and that groups nest', async () => {
  const { skill } = await load('board-layout')
  // The gap this pins: the renderer has always let a group arrange its children with the same six
  // templates a page takes, and let those groups nest (`src/client.js:3196-3201` gives the body its
  // layout, `:3202-3213` recurses). Nothing in the skill said so, so an Agent could reasonably
  // conclude that arrangement is a page-level idea only — and a card cannot then hold two shapes.
  assert.match(skill.content, /A group is a layout container in its own right/)
  assert.match(skill.content, /groups nest/)
  assert.match(skill.content, /nothing is inherited downward/i)
  // And the reason this was invisible for so long, which is the part that stops a false negative:
  // a template over one child renders identically to no template at all.
  assert.match(skill.content, /A template over a single child is invisible/)
})

test('the skill warns that `columns` clamps against the page, not the group', async () => {
  const { skill } = await load('board-layout')
  // `layoutStyle` is handed the canvas width for every container (`src/client.js:281`), so a narrow
  // group still computes its column count from the whole page. `grid`/`masonry` delegate to CSS and
  // are unaffected — the asymmetry is exactly what an Agent cannot guess.
  assert.match(skill.content, /clamped against the \*\*page's\*\* width/)
  assert.match(skill.content, /auto-fill/)
})

test('the skill says `areas` works on a group, not only on a page', async () => {
  const { skill } = await load('board-layout')
  // `applyAreas` resolves named cells for every container as it folds (`src/model.js:674-680`), so
  // a spanning cell inside one card is available and costs the Agent nothing extra.
  assert.match(skill.content, /`areas` works on a `group` just as it does on a page/)
})

test('the teaching skill tells the two write-up forms apart, and says which request maps to which', async () => {
  const { skill } = await load('teaching-on-the-board')
  // The expensive failure: answering "show me how to solve this" with the form that explains why
  // the answer is correct. Twenty-three worked solutions were rewritten for it. The skill has to
  // name both requests and both forms, because either alone reads as "there is one best shape".
  assert.match(skill.content, /explain this to me/)
  assert.match(skill.content, /show me how to solve this/)
  assert.match(skill.content, /reproduce/i)
  // And the mechanical check, which is what makes it enforceable rather than aspirational.
  assert.match(skill.content, /substituting gives/)
})

test('the teaching skill says bilingual means step-aligned, not a summary paragraph', async () => {
  const { skill } = await load('teaching-on-the-board')
  // An `English model answer` paragraph ticks a checklist box while missing the point: the reader
  // copies the English step for step in the exam hall, and cannot do that with prose.
  assert.match(skill.content, /step-aligned/)
  assert.match(skill.content, /same numbered steps/)
  // The distinction that produced the rule.
  assert.match(skill.content, /English of the \*\*answer\*\*, not of the \*\*process\*\*/)
})

test('the teaching skill requires the retrieval block and bounds it', async () => {
  const { skill } = await load('teaching-on-the-board')
  // It is not a definition and not a warning: it maps a word in the question to a tool. Without a
  // bound it grows into background, which is the whole reason it needs stating.
  assert.match(skill.content, /怎么下手/)
  assert.match(skill.content, /cannot be absorbed into the derivation/)
})

test('the teaching skill keeps guard rails out of worked solutions', async () => {
  const { skill } = await load('teaching-on-the-board')
  assert.match(skill.content, /Guard rails belong where the reader already has a path/)
  // The reason is about the reader's state, not about the quality of the traps: before the route
  // exists, a list of ways to fail raises anxiety instead of lowering it.
  assert.match(skill.content, /do not require them in worked solutions/)
})

test('the teaching skill says one document may hold two shapes on purpose', async () => {
  const { skill } = await load('teaching-on-the-board')
  // The trap this prevents: reading the derivation rule as "convert everything", which turns a
  // concept chapter into a procedure chapter nobody asked for. It nearly happened.
  assert.match(skill.content, /two shapes, on purpose/i)
  assert.match(skill.content, /Do not "unify" the body/)
})

test('the teaching skill puts scope, page numbers and text-layer damage before teaching', async () => {
  const { skill } = await load('teaching-on-the-board')
  // These are not teaching, and they decide whether the teaching is about the right material.
  assert.match(skill.content, /48 of 110 exam points/)
  assert.match(skill.content, /Slide 7–82/)
  // The corruption table's whole point: the damage is in the PDF's own text layer, not in OCR.
  assert.match(skill.content, /own text layer/)
  assert.match(skill.content, /`>` → `7`/)
})

test('the teaching skill makes "is this checkable" the trigger for checking a claim', async () => {
  const { skill } = await load('teaching-on-the-board')
  // Every real error in one round was an unchecked claim, not an arithmetic slip. The rule has to
  // give a decision procedure, because "verify things" is advice nobody can act on.
  assert.match(skill.content, /does the sentence have an answer a script/i)
  assert.match(skill.content, /N ≤ 2\^\(k−1\)/)
})

test('the teaching skill keeps a check question at its block, not at the end of the unit', async () => {
  const { skill } = await load('teaching-on-the-board')
  // "One question per concept" read as "one per unit" looks like compliance and tests almost
  // nothing. Doing it that way once was survivable only because the units were short.
  assert.match(skill.content, /Pause every two or three concept blocks, not once per unit/)
  assert.match(skill.content, /Never put the solution's skeleton in the question/)
})

test('the teaching skill forbids an attribution nobody can produce', async () => {
  const { skill } = await load('teaching-on-the-board')
  assert.match(skill.content, /Never write an attribution you cannot produce/)
  assert.match(skill.content, /this is my inference/)
})

test('the teaching skill requires the original question text in an exercise write-up', async () => {
  const { skill } = await load('teaching-on-the-board')
  // A solution without the verbatim question was sent back twice in one round.
  assert.match(skill.content, /verbatim original question/)
  assert.match(skill.content, /Put the original text in from the first version/)
})

test('the teaching skill warns that a blank area may be the renderer', async () => {
  const { skill } = await load('teaching-on-the-board')
  assert.match(skill.content, /A blank area may be a rendering failure/)
  assert.match(skill.content, /suspect the renderer before suspecting the content/)
})

test('the teaching skill budgets the smallest repeatable unit, not the file', async () => {
  const { skill } = await load('teaching-on-the-board')
  // A range the exemplar itself violates is a trap that makes every writer look non-compliant.
  assert.match(skill.content, /Budget the smallest repeatable unit/)
  assert.match(skill.content, /Freeze the shape on one example before delegating/)
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
