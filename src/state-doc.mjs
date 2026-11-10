// STATE.md as ordered blocks: the preamble (title and quote lines) and one block per ## section.
// Sessions on different clones push the same STATE, so it merges by section instead of by line.

export const ACTIVE_HEADER = ['| tag | host | mode | since | at | doing |', '|---|---|---|---|---|---|']
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

export function activeRows(text) {
  const block = parseState(text).find((entry) => entry.name === 'active')
  if (!block) return []
  return splitTable(block.body).rows.map(cells).map(([tag, host, mode, since, at, doing]) => ({ tag, host, mode, since, at, doing }))
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

// Write, update or remove this session's row. A new section goes right after cfg.
export function upsertActive(text, row, { remove = false } = {}) {
  const blocks = parseState(text)
  let block = blocks.find((entry) => entry.name === 'active')
  if (!block) {
    if (remove) return text
    block = { name: 'active', body: [...ACTIVE_HEADER] }
    const cfg = blocks.findIndex((entry) => entry.name === 'cfg')
    blocks.splice(cfg === -1 ? 1 : cfg + 1, 0, block)
  }
  const table = splitTable(block.body)
  const index = table.rows.findIndex((line) => rowKey(line) === row.tag)
  const previous = index === -1 ? null : cells(table.rows[index])
  if (remove) {
    if (index !== -1) table.rows.splice(index, 1)
  } else {
    const line = `| ${row.tag} | ${row.host} | ${row.mode ?? previous?.[2]} | ${previous?.[3] ?? row.since} | ${row.at} | ${row.doing ?? previous?.[5] ?? '-'} |`
    if (index === -1) table.rows.push(line)
    else table.rows[index] = line
  }
  if (!table.rows.length) blocks.splice(blocks.indexOf(block), 1)
  else block.body = [...(table.header.length === 2 ? table.header : ACTIVE_HEADER), ...table.rows, ...table.rest]
  return renderState(blocks)
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
// (active, work) where the most recent timestamp wins.
function mergeTable(name, base = [], ours = [], theirs = []) {
  const [b, o, t] = [base, ours, theirs].map(splitTable)
  const map = (rows) => new Map(rows.map((line) => [rowKey(line), line]))
  const [mb, mo, mt] = [b.rows, o.rows, t.rows].map(map)
  const keys = [...new Set([...o.rows.map(rowKey), ...t.rows.map(rowKey)])]
  const latest = { active: 4, work: 8 }[name]
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
    return null
  }
  const header = o.header.length ? o.header : t.header
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

const TABLES = new Set(['active', 'ideation', 'ssot', 'review', 'tasks', 'work'])

function mergeSection(name, base, ours, theirs) {
  if (name === 'log') return mergeLog(base, ours, theirs)
  if (name === 'inbox' || name === 'next') return unionLines(base, ours, theirs)
  if (name === 'cfg') return mergeCfg(base, ours, theirs)
  if (TABLES.has(name)) return mergeTable(name, base, ours, theirs)
  return null
}

// Three-way merge of STATE.md. Returns the merged text and the sections that conflicted;
// a conflicted section keeps both versions between Git-style markers.
export function mergeState(baseText, oursText, theirsText) {
  const index = (blocks) => {
    const map = new Map()
    for (const block of blocks) {
      if (map.has(block.name)) return null
      map.set(block.name, block.body)
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
      body = mergeSection(name, b ?? [], o ?? [], t ?? [])
      if (!body) {
        conflicts.push(name ?? '(preamble)')
        body = ['<<<<<<< ours', ...(o ?? []), '=======', ...(t ?? []), '>>>>>>> theirs']
      }
    }
    if (body === undefined) continue
    blocks.push({ name, body })
  }
  return { text: renderState(blocks), conflicts }
}
