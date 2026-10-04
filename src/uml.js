/**
 * The node table for a diagram.
 *
 * **Why this exists.** A `uml` block holds one string and renders to one picture. That makes it the
 * only block on the board whose insides nobody can see: `board_read` can quote its source back, but
 * "which parts of this diagram are there" is a question only the diagram knows. The anchor kind
 * `{kind: 'node', key}` has been in the model since the first layout grill and has never been
 * usable for exactly that reason — there was no key to name.
 *
 * So: parse the source here, on the host, and put the result on the block as `nodeHints`. It is
 * **derived data**, in the same category as an `areas` grid's resolved cells: it never enters the
 * document, never moves the revision, and is recomputed from the source on every committed batch.
 * `src/model.js` excludes it from the content hash (see the `case 'uml'` arm) and that exclusion is
 * what makes it safe to improve this parser without rewriting history.
 *
 * **What it is not.** It is not a mermaid parser, and it does not pretend to be one. Mermaid's real
 * grammar needs a DOM, and a second implementation of it would be a second thing to be wrong. What
 * this reads is the part of the syntax that names things — which is precisely the part an anchor
 * needs — and it reads it **conservatively**: when a line does not clearly name a node, it is
 * skipped rather than guessed at, because a node list that is visibly wrong is worse than a short
 * one. Five families are read (flowchart, sequence, class, state, er). Everything else — `pie`,
 * `gantt`, `mindmap`, `timeline` — yields no table at all, which is reported as "unknown" rather
 * than as "empty".
 *
 * **Nothing is ever rejected on the strength of this.** An anchor naming a key that is not in the
 * table is still accepted; the table is a reading aid, not a whitelist. A parser bug must be able to
 * cost a wrong line in a listing, never a refused write.
 *
 * @module dsh-superboard/uml
 */

/**
 * The families this file can read, tested against the **first** meaningful line.
 *
 * Mermaid requires the diagram keyword to open the document, so looking only there is both correct
 * and the cheapest way to avoid matching a keyword that appears inside a label.
 */
const FAMILIES = [
  ['sequence', /^sequenceDiagram\b/],
  ['class', /^classDiagram(?:-v2)?\b/],
  ['state', /^stateDiagram(?:-v2)?\b/],
  ['er', /^erDiagram\b/],
  ['flowchart', /^(?:flowchart|graph)\b/],
]

/**
 * A link between two flowchart nodes.
 *
 * The middle is a run of hyphens, dots, or equals signs, and the run may begin with either a hyphen
 * or a dot: mermaid writes a dotted edge as `-.->`, and an inline edge label as `A-. text .->B`,
 * where the closing run starts with the dot. A pattern that knows only one of those two spellings
 * misses the other entirely, and what the scanner does then is worse than failing — it steps over
 * the run a character at a time and reads the edge's label as a node.
 */
const FLOW_LINK = /[<ox]?(?:[.-]{2,}|={2,})[>ox]?/

/** Punctuation a shape wraps its label in. Stripped from both ends of whatever was inside. */
const OPEN_JUNK = new Set(['[', '(', '{', '/', '\\'])
const CLOSE_JUNK = new Set([']', ')', '}', '/', '\\'])

/**
 * Split one physical line into statements.
 *
 * `;` separates statements in mermaid, and it is common enough (`flowchart TD; A-->B`) that a
 * parser which only splits on newlines reads that whole diagram as its own keyword line and then
 * finds nothing after it. Quotes are honoured, because a label is allowed to contain one.
 *
 * @param line - one trimmed, comment-free line.
 * @returns its statements.
 */
function splitStatements(line) {
  const out = []
  let current = ''
  let quoted = false
  for (const char of line) {
    if (char === '"') quoted = !quoted
    if (char === ';' && !quoted) {
      out.push(current)
      current = ''
      continue
    }
    current += char
  }
  out.push(current)
  return out.flatMap((part) => {
    const trimmed = part.trim()
    return trimmed === '' ? [] : [trimmed]
  })
}

/**
 * The meaningful lines of a source, with comments and frontmatter removed.
 *
 * `%%` is mermaid's line comment and `%%{ … }%%` its init directive; both are stripped rather than
 * parsed. Frontmatter is a `---` block before the diagram keyword, and it is the one place a `---`
 * line is not a link.
 *
 * @param source - the diagram source.
 * @returns trimmed, non-empty statements.
 */
function meaningfulLines(source) {
  const raw = String(source ?? '').split('\n')
  let index = 0
  const first = raw.findIndex((line) => line.trim() !== '')
  if (first !== -1 && raw[first].trim() === '---') {
    const close = raw.findIndex((line, at) => at > first && line.trim() === '---')
    index = close === -1 ? raw.length : close + 1
  }
  const lines = []
  for (; index < raw.length; index += 1) {
    const line = raw[index].trim()
    if (line === '' || line.startsWith('%%')) continue
    lines.push(...splitStatements(line))
  }
  return lines
}

/**
 * Read an identifier at a position.
 *
 * A hyphen belongs to the identifier when a word character follows it, and does not when another
 * hyphen or an arrowhead does. That one rule is what lets `dash-status` stay whole while `A-->B`
 * still splits into `A`, a link, and `B` — the two cases a naive pattern gets wrong in opposite
 * directions.
 *
 * @param text - the statement.
 * @param at - the offset to read from.
 * @returns the identifier, or `undefined` when there is not one here.
 */
function readId(text, at) {
  if (!/[A-Za-z_]/.test(text[at] ?? '')) return undefined
  let end = at + 1
  while (end < text.length) {
    const char = text[end]
    if (/[A-Za-z0-9_]/.test(char)) {
      end += 1
      continue
    }
    if (char === '-' && /[A-Za-z0-9_]/.test(text[end + 1] ?? '')) {
      end += 1
      continue
    }
    break
  }
  return text.slice(at, end)
}

/**
 * Strip the punctuation a shape wraps its label in.
 *
 * `["读/写"]` is quoted and taken verbatim; `[/text/]`, `[(text)]` and `((text))` are the same
 * label wearing different shapes, and the shape is not part of what it says.
 *
 * @param raw - the text between the outermost shape brackets.
 * @returns the label.
 */
function cleanLabel(raw) {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1)
  let start = 0
  let end = trimmed.length
  while (start < end && OPEN_JUNK.has(trimmed[start])) start += 1
  while (end > start && CLOSE_JUNK.has(trimmed[end - 1])) end -= 1
  return trimmed.slice(start, end).trim()
}

/**
 * Read a shape — `[label]`, `(label)`, `{label}`, `>label]`, `[[label]]`, `[(label)]`, … — if one
 * starts here.
 *
 * Deliberately bracket-counting rather than a table of the twenty shapes mermaid accepts: they are
 * all a label wrapped in matched punctuation, and the differences that remain are cosmetic, which is
 * what `cleanLabel` is for. Quotes are honoured so a label may contain its own brackets.
 *
 * @param text - the statement.
 * @param at - the offset just past the identifier.
 * @returns `{label, end}` or `undefined` when no shape starts here.
 */
function readShape(text, at) {
  const opener = text[at]
  const closer = opener === '(' ? ')' : opener === '{' ? '}' : opener === '[' || opener === '>' ? ']' : undefined
  if (closer === undefined) return undefined

  let depth = 1
  let quoted = false
  let end = at + 1
  while (end < text.length) {
    const char = text[end]
    if (quoted) {
      if (char === '"') quoted = false
    } else if (char === '"') {
      quoted = true
    } else if (char === closer) {
      depth -= 1
      if (depth === 0) {
        const label = cleanLabel(text.slice(at + 1, end))
        return { label: label === '' ? undefined : label, end: end + 1 }
      }
    } else if (char === opener) {
      depth += 1
    }
    end += 1
  }
  return undefined
}

/**
 * Read mermaid 11's object shape — `A@{ shape: rect, label: "Text" }` — if one starts here.
 *
 * @param text - the statement.
 * @param at - the offset just past the identifier.
 * @returns `{label, end}` or `undefined`.
 */
function readObjectShape(text, at) {
  const match = /^@\{([^}]*)\}/.exec(text.slice(at))
  if (match === null) return undefined
  const label = /\blabel\s*:\s*("([^"]*)"|[^,}]+)/.exec(match[1])
  if (label === null) return { label: undefined, end: at + match[0].length }
  const value = label[2] === undefined ? label[1].trim() : label[2]
  return { label: value === '' ? undefined : value, end: at + match[0].length }
}

/**
 * Was this link an *opening* run rather than a whole link?
 *
 * Mermaid writes an inline edge label as `A -- text --> B`, which is two link runs with a word
 * between them. So after an opening run, a bare word followed by another link is the label, not a
 * node — while after a complete link (`-->`, `---`, `-.-`) a bare word is an endpoint, which is what
 * makes the chain `A --> B --> C` three nodes rather than one node called `B`.
 *
 * @param link - the link text just consumed.
 * @returns whether it opens a labelled edge.
 */
function isOpeningLink(link) {
  return !/[>ox]$/.test(link) && /^(?:-{2}|={2}|-\.)$/.test(link)
}

/**
 * Collect the nodes of a flowchart.
 *
 * @param statements - the source lines after the diagram keyword.
 * @returns an ordered `[key, label]` list.
 */
function flowchartNodes(statements) {
  const found = new Map()
  const record = (key, label) => {
    if (key === undefined || key === '') return
    const before = found.get(key)
    // A node first seen as an endpoint has no label. If a later statement declares one, it wins.
    if (before === undefined) found.set(key, label)
    else if (before === undefined || before === key) found.set(key, label ?? before)
  }

  /** Statements this file must not read as node declarations. */
  const SKIP = /^(?:subgraph|end|direction|style|classDef|class|click|linkStyle|accTitle|accDescr)\b/

  for (const statement of statements) {
    if (SKIP.test(statement)) continue
    let at = 0
    let afterOpening = false
    while (at < statement.length) {
      const char = statement[at]
      if (char === ' ' || char === '\t' || char === '&' || char === ',') {
        at += 1
        continue
      }

      const link = FLOW_LINK.exec(statement.slice(at))
      if (link !== null && link.index === 0) {
        at += link[0].length
        afterOpening = isOpeningLink(link[0])
        const pipe = /^\s*\|[^|]*\|/.exec(statement.slice(at))
        if (pipe !== null) at += pipe[0].length
        continue
      }

      const key = readId(statement, at)
      if (key === undefined) {
        at += 1
        continue
      }
      at += key.length

      const shape = readShape(statement, at) ?? readObjectShape(statement, at)
      if (shape !== undefined) at = shape.end

      if (shape === undefined && afterOpening) {
        // `A -- text --> B`: the word between the two link runs is the edge's label. The whitespace
        // in front of the closing link has to be stepped over first — `FLOW_LINK` is unanchored, so
        // testing it against the rest of the statement would match a link three spaces away and
        // call it a continuation.
        const ahead = statement.slice(at)
        const gap = /^\s*/.exec(ahead)[0].length
        const next = FLOW_LINK.exec(ahead.slice(gap))
        if (next !== null && next.index === 0) continue
      }
      record(key, shape?.label)
      afterOpening = false
    }
  }
  return [...found.entries()]
}

/**
 * Collect the participants of a sequence diagram.
 *
 * @param statements - the source lines after the diagram keyword.
 * @returns an ordered `[key, label]` list.
 */
function sequenceNodes(statements) {
  const found = new Map()
  const record = (key, label) => {
    if (key === undefined || key === '' || key === '[*]') return
    if (!found.has(key)) found.set(key, label)
    else if (found.get(key) === undefined && label !== undefined) found.set(key, label)
  }

  for (const statement of statements) {
    const declared = /^(?:participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/i.exec(statement)
    if (declared !== null) {
      record(declared[1], declared[2]?.trim())
      continue
    }
    // `A->>B: text`. The colon is what separates a message from every other statement in the
    // grammar — `loop`, `alt`, `activate`, `Note over` and the rest have no arrow before one.
    const colon = statement.indexOf(':')
    if (colon <= 0) continue
    const parts = /^(\S+?)\s*[-<>=xo()|+*]{2,}\s*(\S+)$/.exec(statement.slice(0, colon).trim())
    if (parts === null) continue
    record(parts[1])
    record(parts[2])
  }
  return [...found.entries()]
}

/**
 * Collect the classes of a class diagram.
 *
 * @param statements - the source lines after the diagram keyword.
 * @returns an ordered `[key, label]` list.
 */
function classNodes(statements) {
  const found = new Map()
  const record = (key) => {
    if (key !== undefined && key !== '' && !found.has(key)) found.set(key, undefined)
  }
  for (const statement of statements) {
    const declared = /^class\s+([A-Za-z_]\w*)/.exec(statement)
    if (declared !== null) {
      record(declared[1])
      continue
    }
    // `Animal <|-- Dog : eats`, and the same line without the trailing label.
    const relation = /^([A-Za-z_]\w*)\s*(?:\{[\w\s]*\}|[<>|*o.+\-~()]{2,})\s*([A-Za-z_]\w*)/.exec(statement)
    if (relation !== null) {
      record(relation[1])
      record(relation[2])
      continue
    }
    // `Animal : +int age` — a member line names its class on the left.
    const member = /^([A-Za-z_]\w*)\s*:/.exec(statement)
    if (member !== null) record(member[1])
  }
  return [...found.entries()]
}

/**
 * Collect the states of a state diagram.
 *
 * @param statements - the source lines after the diagram keyword.
 * @returns an ordered `[key, label]` list.
 */
function stateNodes(statements) {
  const found = new Map()
  const record = (key, label) => {
    if (key === undefined || key === '' || key === '[*]') return
    if (!found.has(key)) found.set(key, label)
    else if (found.get(key) === undefined && label !== undefined) found.set(key, label)
  }
  for (const statement of statements) {
    const named = /^state\s+"([^"]*)"\s+as\s+(\S+)/.exec(statement)
    if (named !== null) {
      record(named[2], named[1])
      continue
    }
    const declared = /^state\s+(\S+)/.exec(statement)
    if (declared !== null) {
      record(declared[1])
      continue
    }
    const transition = /^(\[\*\]|[A-Za-z_][\w.]*)\s*-->\s*(\[\*\]|[A-Za-z_][\w.]*)/.exec(statement)
    if (transition !== null) {
      record(transition[1])
      record(transition[2])
    }
  }
  return [...found.entries()]
}

/**
 * Collect the entities of an entity-relationship diagram.
 *
 * @param statements - the source lines after the diagram keyword.
 * @returns an ordered `[key, label]` list.
 */
function erNodes(statements) {
  const found = new Map()
  const record = (key) => {
    if (key !== undefined && key !== '' && !found.has(key)) found.set(key, undefined)
  }
  for (const statement of statements) {
    // `CUSTOMER ||--o{ ORDER : places`
    const relation = /^([A-Za-z_][\w-]*)\s+[|}o{]{1,2}--[|}o{]{1,2}\s+([A-Za-z_][\w-]*)/.exec(statement)
    if (relation !== null) {
      record(relation[1])
      record(relation[2])
      continue
    }
    // `ORDER { string id }` — an entity block names its entity on the opening line.
    const declared = /^([A-Za-z_][\w-]*)\s*\{$/.exec(statement)
    if (declared !== null) record(declared[1])
  }
  return [...found.entries()]
}

const READERS = {
  flowchart: flowchartNodes,
  sequence: sequenceNodes,
  class: classNodes,
  state: stateNodes,
  er: erNodes,
}

/**
 * The node table for one diagram source.
 *
 * @param source - the diagram source.
 * @returns `[{key, label}]`, or `undefined` when this file cannot read the family.
 */
export function nodeHintsFor(source) {
  const lines = meaningfulLines(source)
  if (lines.length === 0) return undefined
  const family = FAMILIES.find(([, test]) => test.test(lines[0]))
  if (family === undefined) return undefined

  const found = READERS[family[0]](lines.slice(1))
  // A label is required by the schema, and for the families that have no display name separate from
  // the key — a class, an entity — the key is the name. Saying so is better than an empty string.
  return found.map(([key, label]) => ({ key, label: label ?? key }))
}

/** Whether two node tables say the same thing, so an unchanged block keeps its identity. */
function sameHints(before, after) {
  if (before.length !== after.length) return false
  return before.every((entry, at) => entry.key === after[at].key && entry.label === after[at].label)
}

/**
 * Attach the derived node tables to every `uml` block in a model.
 *
 * Returns the same model when nothing moved, so a board with no diagrams — or one whose diagrams
 * have not changed — costs nothing and keeps its object identity.
 *
 * @param model - the board model, after a committed batch.
 * @returns the model with `nodeHints` set, or the model itself.
 */
export function attachNodeHints(model) {
  let touchedAny = false
  const pages = model.pages.map((page) => {
    let touched = false
    const blocks = page.blocks.map((block) => {
      if (block.kind !== 'uml') return block
      const hints = nodeHintsFor(block.source)
      const present = Array.isArray(block.nodeHints)
      if (hints === undefined) {
        if (!present) return block
        const { nodeHints, ...without } = block
        touched = true
        return without
      }
      if (present && sameHints(block.nodeHints, hints)) return block
      touched = true
      return { ...block, nodeHints: hints }
    })
    if (!touched) return page
    touchedAny = true
    return { ...page, blocks }
  })
  return touchedAny ? { ...model, pages } : model
}
