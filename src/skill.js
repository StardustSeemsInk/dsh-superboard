/**
 * The board's own Agent-facing documentation, delivered as a skill.
 *
 * Why a skill rather than more prose in the tool descriptions:
 *
 *   - The four tool descriptions are the *entire* documentation surface an Agent gets for free,
 *     and they ride **every** request. That budget is for what a caller must know before calling
 *     anything; it cannot also carry a page about what a board looks like afterwards.
 *   - A skill is **opt-in**: the catalog advertises one line (`name: description`), and the body
 *     is fetched only when the Agent decides it needs it. So the cost of a thorough document is
 *     paid once, by the sessions that actually write a board.
 *   - Skills are a first-class Agent-facing channel, unlike `docs/` in the repository, which no
 *     Agent ever reads.
 *
 * The registration is **host-plane**: this plugin's row sits at the top level of the profile's
 * patch, so every agent preset's scope chain merges the provider. That is what makes the skill
 * available to the board presets *and* to a plain session.
 *
 * The provider is written by hand rather than by mounting `@deepseek-ai/dsh-skill-filesystem`,
 * because runtime code in this package never imports from `@deepseek-ai/*` — those must be the
 * host's own instances, and a local copy would be a second one. The protocol implemented here is
 * the one that package implements, and the one an already-installed third-party skill bundle
 * uses: `list()` returns candidate summaries, `get()` returns the full body.
 *
 * @module dsh-superboard/skill
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Provider name in `ctx.skills`; must not collide with DSH's own `filesystem`. */
export const SKILL_PROVIDER_NAME = 'dsh-superboard'

/** Where this package keeps its skill bodies: one directory per skill, each with a `SKILL.md`. */
const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url))

/**
 * Precedence among packaged providers.
 *
 * Below `BUNDLED_SKILL_RANK` (600), so a user's own bundled root can shadow a board skill if it
 * ever needs to. Above the runtime provider (250), because a packaged skill is the more specific
 * answer for a board question.
 */
const PACKAGED_SKILL_RANK = 550

/** The bucket these skills advertise under. */
const SOURCE = 'custom'

/**
 * Parse the YAML frontmatter of a `SKILL.md`.
 *
 * Deliberately small: it handles the scalar fields skill discovery consumes — `name`,
 * `description`, and optionally `whenToUse` — plus folded (`>`) and quoted scalars, and passes
 * anything else through verbatim. It is not a YAML parser and does not pretend to be one; these
 * files are authored in this repository, and the registry validates the result.
 *
 * @param text - the raw file contents.
 * @returns the parsed metadata and the body, or `undefined` when there is no frontmatter block.
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return undefined
  const end = text.indexOf('\n---', 3)
  if (end === -1) return undefined

  const metadata = {}
  let key = null
  let folded = false
  for (const raw of text.slice(3, end).split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (/^[ \t]/.test(line) && key !== null) {
      const value = line.trim()
      if (value !== '') metadata[key] = folded ? `${metadata[key]} ${value}` : `${metadata[key]}\n${value}`
      continue
    }
    const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line)
    if (match === null) {
      key = null
      folded = false
      continue
    }
    let value = match[2].trim()
    folded = value === '>' || value === '>-' || value === '>+'
    if (folded) {
      value = ''
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    metadata[match[1]] = value
    key = folded ? match[1] : null
  }

  return { metadata, body: text.slice(end + 4).replace(/^\n+/, '') }
}

/**
 * Read and parse one skill directory.
 *
 * @param skillDirectory - absolute path to the directory holding `SKILL.md`.
 * @param signal - optional cancellation.
 * @returns the parsed record, or `undefined` when the file is gone or malformed.
 */
async function readSkill(skillDirectory, signal) {
  let text
  try {
    text = await readFile(join(skillDirectory, 'SKILL.md'), 'utf8')
  } catch {
    return undefined
  }
  if (signal?.aborted) return undefined
  const parsed = parseFrontmatter(text)
  if (parsed === undefined) return undefined
  return {
    name: parsed.metadata.name ?? '',
    description: parsed.metadata.description ?? '',
    ...(parsed.metadata.whenToUse === undefined ? {} : { whenToUse: parsed.metadata.whenToUse }),
    body: parsed.body,
  }
}

/**
 * Discover the packaged skills.
 *
 * The body is read but not returned here: `list()` feeds the catalog, which shows one line per
 * skill, and holding every body in memory to answer a summary would be waste.
 *
 * @param signal - optional cancellation.
 * @returns the candidate summaries.
 */
async function discover(signal) {
  let entries
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true })
  } catch {
    return []
  }

  const candidates = []
  for (const entry of entries) {
    if (signal?.aborted) break
    if (!entry.isDirectory()) continue
    const skill = await readSkill(join(SKILLS_DIR, entry.name), signal)
    if (skill === undefined || skill.name === '' || skill.description === '') continue
    candidates.push({
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      // Model- and user-invocable. These are reference material, not a workflow that must be
      // opted into, so nothing here needs `disable-model-invocation`.
      invocation: { modelInvocable: true, userInvocable: true },
      source: SOURCE,
      provider: SKILL_PROVIDER_NAME,
      rank: PACKAGED_SKILL_RANK,
      locator: join(SKILLS_DIR, entry.name),
      path: join(SKILLS_DIR, entry.name, 'SKILL.md'),
    })
  }
  return candidates
}

/**
 * Register the board's skill provider on `ctx.skills`.
 *
 * @param ctx - the plugin's context, with `skills` injected.
 */
export function registerBoardSkills(ctx) {
  ctx.skills.registerProvider(() => ({
    name: SKILL_PROVIDER_NAME,
    list: (options) => discover(options?.signal),
    async get(candidate, options) {
      const skill = await readSkill(candidate.locator, options?.signal)
      if (skill === undefined) return undefined
      return {
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        invocation: { modelInvocable: true, userInvocable: true },
        source: SOURCE,
        provider: SKILL_PROVIDER_NAME,
        // Relative references inside a skill resolve against its own directory.
        resourceBase: { kind: 'directory', path: candidate.locator },
        path: candidate.path,
        content: skill.body,
      }
    },
  }))
}

/**
 * The names this package ships, for the suite.
 *
 * Reading the directory at test time would make the suite depend on the filesystem in a way that
 * hides a missing file behind an empty list; this makes the expectation explicit and lets a test
 * fail when a skill is added without being listed here.
 */
export const SHIPPED_SKILL_NAMES = Object.freeze(['board-layout'])
