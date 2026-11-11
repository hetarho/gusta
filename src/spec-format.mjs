export const TASK_ID = /^T\d{3,}$/
export const TASK_ST = /^(todo|doing@\d{6}(\.[A-Za-z0-9]{2,8})?|done@\d{6}|blocked@\d{6})$/

export function sections(markdown) {
  const map = new Map()
  let current = null
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      current = []
      map.set(heading[1], current)
    } else if (current) {
      current.push(line)
    }
  }
  return map
}

export function tableRows(lines = []) {
  const rows = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length === 0) continue
    if (cells.every((cell) => /^:?-+:?$/.test(cell) || cell === '')) continue
    rows.push(cells)
  }
  return rows.slice(1)
}

export function quoteLine(markdown) {
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('> ')) return line.slice(2).trim()
  }
  return null
}

export function quoteFields(quote) {
  const fields = new Map()
  for (const part of quote.split('|')) {
    const trimmed = part.trim()
    const colon = trimmed.indexOf(':')
    if (colon > 0) fields.set(trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim())
  }
  return fields
}

export function splitRefs(cell) {
  return (cell ?? '').split(/[\s,]+/).filter((ref) => ref && ref !== '-')
}

// Exploratory tasks carry a wall-clock timebox; `-` or absence means an ordinary task.
export const EXPLORE = /^\d+[mh]$/
export const exploreValue = (value) => value && value !== '-' ? value : null
export const EXIT_LINE = /^- \[[ v]\] exit: \S/

// FORMAT date: YYMMDD in UTC.
export const yymmdd = (date = new Date()) => date.toISOString().slice(2, 10).replaceAll('-', '')

// The `vibe task done` gate: a task's ## result counts only lines someone filled — blank lines and
// untouched template placeholders (`- outcome: <what works now>`) are empty. Lint keeps its own
// non-blank check: archived history is never re-judged.
const RESULT_PLACEHOLDER = /^- [\w-]+: <[^>]*>$/
export const resultLines = (content) => (sections(content).get('result') ?? []).map((line) => line.trim())
  .filter((line) => line !== '' && !RESULT_PLACEHOLDER.test(line))

// Unchecked acceptance lines. An explore task's exit line is the timebox fallback: checked, it
// closes the task by itself; unchecked, it is not owed.
export function openChecks(content) {
  const lines = (sections(content).get('acceptance') ?? []).map((line) => line.trim())
  if (lines.some((line) => EXIT_LINE.test(line) && line.startsWith('- [v]'))) return []
  return lines.filter((line) => line.startsWith('- [ ]') && !EXIT_LINE.test(line))
}

// Session presence and the owner's inbox (STATE ## active · ## inbox).
export const SESSION_TAG = /^[A-Za-z0-9]{2,8}$/
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/
export const INBOX_LINE = /^- (\d{6}) (decided|parked|suggest) ([^:]+?): (\S.*)$/
export const REPORT_FILE = /^(\d{6}-[A-Za-z0-9]{2,8})\.md$/
export const REPORT_SECTIONS = ['done', 'decided', 'parked', 'checks', 'next']

// Decision blocks by ID: the decision line plus its indented sub-lines and table rows.
export function decisionBlocks(markdown) {
  return new Map([...parseSsot(markdown).decisions].map(([id, block]) => [id, block.text]))
}

export const DECISION_HEAD = /^-\s+([A-Z]{2,6})-(\d+)\s+\[(o|x|\?)\]/
export const DECISION_STATUS = { o: 'decided', '?': 'open', x: 'rejected' }

function closedText(lines) {
  const kept = [...lines]
  while (kept.length && kept.at(-1).trim() === '') kept.pop()
  while (kept.length && kept[0].trim() === '') kept.shift()
  return kept.join('\n')
}

// One SSOT doc with line numbers. A decision block runs from its top-level bullet to the next
// top-level bullet or heading, whatever the lines in between look like — an unindented table or
// continuation line is still part of the decision, never silently cut off.
export function parseSsot(markdown) {
  const lines = markdown.split(/\r?\n/)
  const doc = { title: null, rev: null, sections: new Map(), decisions: new Map(), duplicates: [], malformed: [], orphans: [] }
  let section = null
  let block = null
  let lastDecision = null
  const close = () => {
    if (!block) return
    block.text = closedText(block.lines)
    delete block.lines
    block = null
  }
  for (const [index, line] of lines.entries()) {
    const number = index + 1
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      close()
      lastDecision = null
      section = { name: heading[1], start: number, end: number, lines: [] }
      if (!doc.sections.has(section.name)) doc.sections.set(section.name, section)
      continue
    }
    if (!section) {
      doc.title ??= line.match(/^#\s+(\S+)/)?.[1] ?? null
      if (doc.rev === null && line.startsWith('> ')) doc.rev = Number(line.slice(2).match(/^r(\d+)\b/)?.[1] ?? NaN)
      continue
    }
    section.lines.push(line)
    if (line.trim() !== '') section.end = number
    if (section.name !== 'decisions') continue
    if (/^-\s+\S/.test(line)) {
      close()
      const head = line.match(DECISION_HEAD)
      block = { id: head ? `${head[1]}-${head[2]}` : null, domain: head?.[1] ?? null, number: head ? Number(head[2]) : null,
        status: head ? DECISION_STATUS[head[3]] : null, start: number, end: number, lines: [line] }
      // A bullet that is not a decision line still sits under the decision before it.
      if (!head) doc.malformed.push(Object.assign(block, { after: lastDecision }))
      else if (doc.decisions.has(block.id)) doc.duplicates.push(block)
      else doc.decisions.set(block.id, block)
      if (head) lastDecision = block.id
    } else if (block) {
      block.lines.push(line)
      if (line.trim() !== '') block.end = number
    } else if (line.trim() !== '') doc.orphans.push(number)
  }
  close()
  for (const entry of doc.sections.values()) {
    entry.text = closedText(entry.lines)
    delete entry.lines
  }
  if (Number.isNaN(doc.rev)) doc.rev = null
  return doc
}

// References inside SSOT text. `→ID` is unclassified (every reference written before the kinds
// existed); `→!` requires, `→=` canonical owner, `→~` related. A marker covers its `/` list and
// `–`/`..` range, `→AUTH` is a whole domain, and a bare `AUTH-3` is a mention (treated as
// unclassified). Code spans are not read. Callers drop targets whose domain does not exist.
export const REF_KINDS = { '!': 'requires', '=': 'canonical', '~': 'related', '': 'unclassified' }
const ARROW_REF = /→([!=~]?)([A-Z]{2,6})(?:-(\d+)((?:\/\d+)*)(?:(?:–|\.\.)(\d+))?)?(?![A-Za-z0-9])/g
const MENTION_REF = /(?<![A-Za-z0-9_/@.–-])([A-Z]{2,6})-(\d+)((?:\/\d+)*)(?:(?:–|\.\.)(\d+))?(?![A-Za-z0-9])/g
const RANGE_MAX = 200

function targetNumbers(first, rest, last) {
  const numbers = [Number(first), ...(rest ? rest.split('/').filter(Boolean).map(Number) : [])]
  const end = last ? Number(last) : null
  const from = numbers.at(-1)
  if (end !== null && end > from && end - from <= RANGE_MAX) for (let number = from + 1; number <= end; number += 1) numbers.push(number)
  return [...new Set(numbers)]
}

export function references(text) {
  const found = []
  const masked = text.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length))
  const arrows = masked.replace(ARROW_REF, (raw, marker, domain, first, rest, last) => {
    const kind = REF_KINDS[marker]
    if (first === undefined) found.push({ kind, domain, number: null, raw })
    else for (const number of targetNumbers(first, rest, last)) found.push({ kind, domain, number, raw })
    return ' '.repeat(raw.length)
  })
  for (const match of arrows.matchAll(MENTION_REF)) {
    const [raw, domain, first, rest, last] = match
    for (const number of targetNumbers(first, rest, last)) found.push({ kind: 'unclassified', domain, number, raw, mention: true })
  }
  return found
}

export const refId = (ref) => ref.number === null ? ref.domain : `${ref.domain}-${ref.number}`
