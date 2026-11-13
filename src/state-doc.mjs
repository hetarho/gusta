// STATE.md as ordered blocks: the preamble (title and quote lines) and one block per ## section.
// Sessions on different clones push the same STATE, so it merges by section instead of by line.

export const ACTIVE_HEADER = ['| tag | host | mode | since | at | doing |', '|---|---|---|---|---|---|']
// SESSIONS.md (the coordination branch) also says where a session works: its branch and last commit.
export const SESSION_ACTIVE_HEADER = ['| tag | host | mode | since | at | doing | branch | commit |', '|---|---|---|---|---|---|---|---|']
const LOG_LIMIT = 20

export function parseState(text) {
  const blocks = [{ name: null, body: [] }]
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) blocks.push({ name: heading[1], body: [] })
    else blocks.at(-1).body.push(line)
  }
  for (const block of blocks) {
    while (block.body.length && block.body.at(-1).trim() === '') block.body.pop()
    while (block.name && block.body.length && block.body[0].trim() === '') block.body.shift()
  }
  return blocks
}

export function renderState(blocks) {
  const parts = blocks.map((block) => (block.name === null ? block.body : [`## ${block.name}`, ...block.body]).join('\n'))
  return `${parts.filter((part) => part !== '').join('\n\n')}\n`
}

const cells = (line) => line.trim().split('|').slice(1, -1).map((cell) => cell.trim())
const isRow = (line) => line.trim().startsWith('|')
const isSeparator = (line) => isRow(line) && cells(line).every((cell) => /^:?-+:?$/.test(cell))

// A table section is its header (column names + separator) and rows keyed by the first cell.
function splitTable(body) {
  const header = []
  const rows = []
  const rest = []
  for (const line of body) {
    if (!isRow(line)) rest.push(line)
    else if (header.length < 2 && (header.length === 0 || isSeparator(line))) header.push(line)
    else rows.push(line)
  }
  return { header, rows, rest }
}

const rowKey = (line) => cells(line)[0]

// A six-cell row (STATE) keeps its six fields; a wider row (SESSIONS) adds branch and commit.
export function activeRows(text) {
  const block = parseState(text).find((entry) => entry.name === 'active')
  if (!block) return []
  return splitTable(block.body).rows.map(cells).map(([tag, host, mode, since, at, doing, ...place]) =>
    ({ tag, host, mode, since, at, doing, ...(place.length ? { branch: place[0] || '-', commit: place[1] || '-' } : {}), ...(place[2] && place[2] !== '-' ? { session: place[2] } : {}) }))
}

// Append one inbox line, keeping every other byte. A new section goes after cfg and active.
export function appendInbox(text, line) {
  const section = text.match(/^## inbox[ \t]*\n[\s\S]*?(?=^## |(?![\s\S]))/m)
  if (section) {
    const tail = text.slice(section.index + section[0].length)
    return `${text.slice(0, section.index)}${section[0].trimEnd()}\n${line}\n${tail ? '\n' : ''}${tail}`
  }
  const index = text.search(/^## (?!cfg\b|active\b)/m)
  return index < 0 ? `${text.trimEnd()}\n\n## inbox\n${line}\n` : `${text.slice(0, index)}## inbox\n${line}\n\n${text.slice(index)}`
}

// Write, update or remove this session's row. A new section goes right after cfg. The table is
// as wide as its header: `header` is the one a new section gets, and a table narrower than it
// (six-cell STATE rows carried into SESSIONS) is widened with `-` in the missing cells.
export function upsertActive(text, row, { remove = false, header = ACTIVE_HEADER } = {}) {
  const blocks = parseState(text)
  let block = blocks.find((entry) => entry.name === 'active')
  if (!block) {
    if (remove) return text
    block = { name: 'active', body: [...header] }
    const cfg = blocks.findIndex((entry) => entry.name === 'cfg')
    blocks.splice(cfg === -1 ? 1 : cfg + 1, 0, block)
  }
  const table = splitTable(block.body)
  const current = table.header.length === 2 ? table.header : header
  const wanted = cells(header[0]).length
  const head = wanted > 6 && cells(current[0]).length < wanted ? header : current
  const width = Math.max(cells(head[0]).length, 6)
  if (width > 6) table.rows = table.rows.map((line) => cells(line).length >= width ? line : `| ${[...cells(line), ...Array(width).fill('-')].slice(0, width).join(' | ')} |`)
  const index = table.rows.findIndex((line) => rowKey(line) === row.tag)
  const previous = index === -1 ? null : cells(table.rows[index])
  if (remove) {
    if (index !== -1) table.rows.splice(index, 1)
  } else {
    const line = `| ${[row.tag, row.host, row.mode ?? previous?.[2], previous?.[3] ?? row.since, row.at, row.doing ?? previous?.[5] ?? '-',
      row.branch ?? previous?.[6] ?? '-', row.commit ?? previous?.[7] ?? '-', row.session ?? previous?.[8] ?? '-'].slice(0, width).map(String).join(' | ')} |`
    if (index === -1) table.rows.push(line)
    else table.rows[index] = line
  }
  if (!table.rows.length) blocks.splice(blocks.indexOf(block), 1)
  else block.body = [...head, ...table.rows, ...table.rest]
  return renderState(blocks)
}

const taskBlock = (blocks) => blocks.find((entry) => entry.name === 'tasks')
const rowIndex = (block, id) => block?.body.findIndex((line) => isRow(line) && !isSeparator(line) && rowKey(line) === id) ?? -1

// One STATE tasks row `id|title|ssot|dep|st`, or null.
export function taskRow(text, id) {
  const block = taskBlock(parseState(text))
  const index = rowIndex(block, id)
  if (index === -1) return null
  const [, title, ssot, dep, st] = cells(block.body[index])
  return { id, title, ssot, dep, st }
}

// Set one task row's st; null when the row is missing.
export function setTaskSt(text, id, st) {
  const blocks = parseState(text)
  const block = taskBlock(blocks)
  const index = rowIndex(block, id)
  if (index === -1) return null
  const row = cells(block.body[index])
  row[4] = st
  block.body[index] = `| ${row.join(' | ')} |`
  return renderState(blocks)
}

// Finished tasks leave STATE: their rows go, an active row doing one of them goes back to `-`,
// one log line goes on top (LOG_LIMIT kept) and next is replaced when given (lines, or a
// function of the current lines). Returns the text and the IDs that had no row.
export function closeTasks(text, ids, { log, next } = {}) {
  const blocks = parseState(text)
  const found = new Set()
  const block = taskBlock(blocks)
  if (block) {
    block.body = block.body.filter((line) => {
      const hit = isRow(line) && ids.includes(rowKey(line))
      if (hit) found.add(rowKey(line))
      return !hit
    })
  }
  const active = blocks.find((entry) => entry.name === 'active')
  if (active) {
    active.body = active.body.map((line) => {
      const row = isRow(line) ? cells(line) : []
      if (row.length < 6 || !ids.includes(row[5])) return line
      row[5] = '-'
      return `| ${row.join(' | ')} |`
    })
  }
  const section = (name) => {
    let entry = blocks.find((candidate) => candidate.name === name)
    if (!entry) {
      entry = { name, body: [] }
      const log = blocks.findIndex((candidate) => candidate.name === 'log')
      blocks.splice(name === 'next' && log !== -1 ? log : blocks.length, 0, entry)
    }
    return entry
  }
  if (next) {
    const entry = section('next')
    entry.body = typeof next === 'function' ? next(entry.body.filter((line) => line.startsWith('- '))) : next
  }
  if (log) {
    const entry = section('log')
    entry.body = [log, ...entry.body.filter((line) => line.startsWith('- '))].slice(0, LOG_LIMIT)
  }
  return { text: renderState(blocks), missing: ids.filter((id) => !found.has(id)) }
}

const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
const dated = (line) => line.match(/^- (\d{6})\b/)?.[1] ?? ''

// Lines that either side added survive; a line one side deleted stays deleted.
function unionLines(base = [], ours = [], theirs = []) {
  const removed = new Set(base.filter((line) => !theirs.includes(line)))
  const kept = ours.filter((line) => !removed.has(line))
  const added = theirs.filter((line) => !base.includes(line) && !ours.includes(line))
  return [...kept, ...added]
}

function mergeLog(base, ours, theirs) {
  const lines = unionLines(base, ours, theirs).filter((line) => line.trim() !== '')
  // Newest on top; lines with the same date keep their relative order.
  return lines.map((line, index) => ({ line, index })).sort((a, b) => dated(b.line).localeCompare(dated(a.line)) || a.index - b.index)
    .map(({ line }) => line).slice(0, LOG_LIMIT)
}

// Rows merge by ID. Two different edits of one row are a conflict, except presence rows
// (active, unlanded, work) where the most recent timestamp wins. With `prefer` nothing is left
// as a conflict: an edit beats a deletion, and two edits no rule settles go to the preferred side.
function mergeTable(name, base = [], ours = [], theirs = [], prefer) {
  const [b, o, t] = [base, ours, theirs].map(splitTable)
  const map = (rows) => new Map(rows.map((line) => [rowKey(line), line]))
  const [mb, mo, mt] = [b.rows, o.rows, t.rows].map(map)
  const keys = [...new Set([...o.rows.map(rowKey), ...t.rows.map(rowKey)])]
  const latest = { active: 4, unlanded: 4, work: 8 }[name]
  const rows = []
  for (const key of keys) {
    const [rb, ro, rt] = [mb.get(key), mo.get(key), mt.get(key)]
    if (same(ro, rt)) { if (ro) rows.push(ro); continue }
    if (same(rb, ro)) { if (rt) rows.push(rt); continue }
    if (same(rb, rt)) { if (ro) rows.push(ro); continue }
    if (latest !== undefined && ro && rt) {
      rows.push((cells(rt)[latest] ?? '') > (cells(ro)[latest] ?? '') ? rt : ro)
      continue
    }
    if (!prefer) return null
    rows.push(ro && rt ? (prefer === 'theirs' ? rt : ro) : ro ?? rt)
  }
  // One side may still carry the six-cell active table: the wider header stays.
  const wider = name === 'active' && cells(t.header[0] ?? '').length > cells(o.header[0] ?? '').length
  const header = wider ? t.header : o.header.length ? o.header : t.header
  return [...header, ...rows, ...unionLines(b.rest, o.rest, t.rest)]
}

// cfg lines are `- key: value  # note`; each key merges on its own.
function mergeCfg(base = [], ours = [], theirs = []) {
  const key = (line) => line.match(/^-\s+([\w-]+):/)?.[1] ?? line
  const map = (lines) => new Map(lines.map((line) => [key(line), line]))
  const [mb, mo, mt] = [base, ours, theirs].map(map)
  const result = []
  for (const name of [...new Set([...ours.map(key), ...theirs.map(key)])]) {
    const [rb, ro, rt] = [mb.get(name), mo.get(name), mt.get(name)]
    if (same(ro, rt)) { if (ro) result.push(ro); continue }
    if (same(rb, ro)) { if (rt) result.push(rt); continue }
    if (same(rb, rt)) { if (ro) result.push(ro); continue }
    return null
  }
  return result
}

const TABLES = new Set(['active', 'ideation', 'ssot', 'review', 'tasks', 'work', 'unlanded'])

function mergeSection(name, base, ours, theirs, prefer) {
  if (name === 'log') return mergeLog(base, ours, theirs)
  if (name === 'inbox' || name === 'next') return unionLines(base, ours, theirs)
  if (name === 'cfg') return mergeCfg(base, ours, theirs)
  if (TABLES.has(name)) return mergeTable(name, base, ours, theirs, prefer)
  return null
}

// Three-way merge of STATE.md. Returns the merged text and the sections that conflicted;
// a conflicted section keeps both versions between Git-style markers. `prefer` ('ours' or
// 'theirs') is for a document nobody resolves by hand (SESSIONS.md): what the rules cannot
// settle goes to that side, a repeated section keeps its first copy, and nothing conflicts.
export function mergeState(baseText, oursText, theirsText, { prefer } = {}) {
  const index = (blocks) => {
    const map = new Map()
    for (const block of blocks) {
      if (!map.has(block.name)) map.set(block.name, block.body)
      else if (!prefer) return null
    }
    return map
  }
  const [base, ours, theirs] = [baseText, oursText, theirsText].map((text) => index(parseState(text ?? '')))
  if (!base || !ours || !theirs) return { text: oursText, conflicts: ['(duplicate sections)'] }
  const order = [...ours.keys()]
  const theirOrder = [...theirs.keys()]
  for (const [position, name] of theirOrder.entries()) {
    if (order.includes(name)) continue
    // We removed it and they left it alone: it stays removed.
    if (base.has(name) && same(base.get(name), theirs.get(name))) continue
    // A section they added (or changed after we removed it) goes after the section that precedes it on their side.
    const before = theirOrder.slice(0, position).reverse().find((entry) => order.includes(entry))
    order.splice(before === undefined ? order.length : order.indexOf(before) + 1, 0, name)
  }
  const conflicts = []
  const blocks = []
  for (const name of order) {
    const [b, o, t] = [base.get(name), ours.get(name), theirs.get(name)]
    let body
    if (same(o, t)) body = o
    else if (same(b, o)) body = t
    else if (same(b, t)) body = o
    else {
      body = mergeSection(name, b ?? [], o ?? [], t ?? [], prefer)
      if (!body && prefer) body = prefer === 'theirs' ? t ?? o : o ?? t
      else if (!body) {
        conflicts.push(name ?? '(preamble)')
        body = ['<<<<<<< ours', ...(o ?? []), '=======', ...(t ?? []), '>>>>>>> theirs']
      }
    }
    if (body === undefined) continue
    blocks.push({ name, body })
  }
  return { text: renderState(blocks), conflicts }
}
