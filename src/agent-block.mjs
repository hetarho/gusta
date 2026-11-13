import { lstat, readFile, readlink, realpath, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SkillPackageError } from './errors.mjs'
import { installedAgents } from './installer.mjs'
import { readSetting } from './settings.mjs'

// The block gusta keeps in a target project's agent instruction file (CLAUDE.md / AGENTS.md).
// Only the lines from the begin marker to the end marker are ours; the rest belongs to the project.
// Markers are found by the begin prefix and the end line alone, so the notice may be reworded
// between versions. Claude Code strips block-level HTML comments before loading the file: the
// notice costs no context and is seen only by whoever opens the file to edit it.
export const BEGIN_PREFIX = '<!-- gusta:begin'
export const END_MARKER = '<!-- gusta:end -->'
const BEGIN = `${BEGIN_PREFIX} managed by gusta: do not edit inside this block (gusta-update rewrites it with "gusta agent-block"); write project rules outside it -->`
// Loaded into every session of the target project: short, agent-neutral, nothing project-specific.
const BODY = [
  '## GUSTA',
  '',
  'This project is built spec-first with GUSTA. `spec/` is the source of truth and code follows it.',
  '',
  '- Implement only on a child branch; `gusta-start`, `gusta-self-improve` and `gusta-self-improve-remote` require a dedicated worktree. Plan with `gusta-sketch`.',
  '- Do not change behavior covered by a `spec/ssot/` decision without updating the spec first.',
  '- Branch, push, deploy and version behavior comes from `spec/SETTINGS.md` (the `gusta-preference` skill); never assume branch names.',
]
const fail = (message, details = []) => { throw new SkillPackageError(message, details) }
const eolOf = (text) => text.includes('\r\n') ? '\r\n' : '\n'

export function renderBlock(eol = '\n') {
  return [BEGIN, ...BODY, '', END_MARKER].join(eol)
}

// A fenced code block opens with three or more backticks or tildes (up to three spaces in) and
// closes with a run of the same character at least as long and nothing after it.
const FENCE = /^ {0,3}(`{3,}|~{3,})/
function fenceStep(open, line) {
  const run = line.replace(/\r$/, '').match(FENCE)?.[1]
  if (!open) return run && !(run[0] === '`' && line.slice(line.indexOf(run) + run.length).includes('`')) ? run : null
  return run && run[0] === open[0] && run.length >= open.length && !line.replace(/\r$/, '').slice(line.indexOf(run) + run.length).trim() ? null : open
}

// missing: no marker · current: one pair holding this version's block · stale: one pair holding
// anything else · broken: a marker without its partner, repeated, or out of order. A marker inside
// a fenced code block is an example someone wrote down, not the block.
export function inspectBlock(text) {
  const begin = [], end = []
  let offset = 0, fence = null
  for (const [index, raw] of (text ?? '').split('\n').entries()) {
    const line = raw.trim()
    const mark = { line: index + 1, start: offset, stop: offset + raw.replace(/\r$/, '').length }
    const inside = fence
    fence = fenceStep(fence, raw)
    offset += raw.length + 1
    if (inside || fence) continue
    if (line.startsWith(BEGIN_PREFIX) && !/[\w-]/.test(line[BEGIN_PREFIX.length] ?? '')) begin.push(mark)
    else if (line === END_MARKER) end.push(mark)
  }
  if (!begin.length && !end.length) return { status: 'missing' }
  const reason = begin.length > 1 || end.length > 1 ? 'duplicate markers' : !end.length ? 'begin marker without end'
    : !begin.length ? 'end marker without begin' : end[0].start < begin[0].start ? 'end marker before begin' : null
  if (reason) return { status: 'broken', reason, lines: [...begin, ...end].map((mark) => mark.line).sort((a, b) => a - b) }
  const [start, stop] = [begin[0].start, end[0].stop]
  return { status: text.slice(start, stop) === renderBlock(eolOf(text)) ? 'current' : 'stale', start, stop }
}

function located(text) {
  const found = inspectBlock(text)
  if (found.status === 'broken') fail('gusta 블록 마커가 훼손돼 추측해서 고치지 않습니다.', [`${found.reason} (line ${found.lines.join(', ')})`])
  return found
}

// The text with this version's block: replaced between the markers, or appended after one blank
// line. null (no file) gives the block alone. Nothing outside the markers changes.
export function applyBlock(text) {
  if (!text) return `${renderBlock()}\n`
  const found = located(text), eol = eolOf(text)
  if (found.status === 'current') return text
  if (found.status === 'stale') return text.slice(0, found.start) + renderBlock(eol) + text.slice(found.stop)
  const gap = text.endsWith(eol + eol) ? '' : text.endsWith('\n') ? eol : eol + eol
  return `${text}${gap}${renderBlock(eol)}${eol}`
}

// The text without the block, its line ending and the blank line apply put before it.
export function removeBlock(text) {
  const found = located(text)
  if (found.status === 'missing') return text
  let before = text.slice(0, found.start)
  const after = text.slice(found.stop).replace(/^\r?\n/, '')
  if (/(^|\n)\r?\n$/.test(before) && (!after || /^\r?\n/.test(after))) before = before.replace(/\r?\n$/, '')
  return before + after
}

const IO = { lstat, readFile, readlink, realpath, unlink, writeFile, installedAgents, readSetting }
const CLAUDE_FILES = ['CLAUDE.md', '.claude/CLAUDE.md']
const AGENTS_FILE = 'AGENTS.md'
const absent = (error) => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error }
const portable = (root, file) => path.relative(root, file).split(path.sep).join('/')

// Where a candidate really is: a symlink is followed (to its own target when that does not exist
// yet). `problem` marks what is never read or written: outside the project, or not a regular file.
async function locate(root, name, deps) {
  const file = path.join(root, name)
  const stats = await deps.lstat(file).catch(absent)
  if (!stats) return { name, file, real: file, exists: false }
  const real = await deps.realpath(file).catch(absent) ?? path.resolve(path.dirname(file), await deps.readlink(file))
  const relative = path.relative(root, real)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { name, file, real, exists: true, problem: 'resolves outside the project' }
  const target = real === file ? stats : await deps.lstat(real).catch(absent)
  return { name, file, real, exists: true, ...(target && !target.isFile() ? { problem: 'not a regular file' } : {}) }
}

// A Claude Code `@path` import (outside fenced code) that resolves to `wanted`.
function importsFile(text, directory, wanted) {
  let fence = null
  for (const line of text.split('\n')) {
    const inside = fence
    fence = fenceStep(fence, line)
    if (!inside && !fence) for (const [, target] of line.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
      if (!target.startsWith('~') && path.resolve(directory, target.replace(/[.,;:)]+$/, '')) === wanted) return true
    }
  }
  return false
}

const readText = (file, deps) => deps.readFile(file, 'utf8').catch(absent)
const shown = (root, entry) => ({ path: entry.problem ? entry.name : portable(root, entry.real), file: entry.real, ...(entry.problem ? { problem: entry.problem } : {}) })

// The files that carry the block, one per real file. Claude: the root CLAUDE.md, else
// .claude/CLAUDE.md — unless that file is a link to AGENTS.md or imports it, where AGENTS.md alone
// carries it. Codex: AGENTS.md. `candidates` are all three, for removal.
export async function agentBlockTargets(targetRoot = process.cwd(), injected = {}) {
  const deps = { ...IO, ...injected }
  const root = await deps.realpath(path.resolve(targetRoot))
  const agents = await deps.installedAgents(root)
  const candidates = []
  for (const name of [...CLAUDE_FILES, AGENTS_FILE]) candidates.push(await locate(root, name, deps))
  const shared = candidates[2], picks = []
  if (agents.includes('claude')) {
    const own = candidates.slice(0, 2).find((entry) => entry.exists)
    const deferred = own && !own.problem && (own.real === shared.real || importsFile(await readText(own.real, deps) ?? '', path.dirname(own.file), shared.file))
    // With no CLAUDE.md, Claude Code reads AGENTS.md; creating a CLAUDE.md would stop that and drop the project's rules.
    picks.push(['claude', own && !deferred ? own : own || shared.exists ? shared : candidates[0]])
  }
  if (agents.includes('codex')) picks.push(['codex', shared])
  const targets = []
  for (const [agent, entry] of picks) {
    const same = targets.find((target) => target.file === entry.real)
    if (same) same.agents.push(agent)
    else targets.push({ ...shown(root, entry), agents: [agent] })
  }
  return { root, agents, targets, candidates }
}

// gusta agent-block [--check] [--remove]: keep the block in the target files. Writing needs the
// owner's recorded approval (SETTINGS agent-block true) — these are the project's own documents.
// --check only reports (and shows the block, for gusta-init to ask with); it fails when the
// setting is true and a target is not current. --remove needs no setting and clears every
// candidate. A broken target stops the run before any write.
export async function agentBlock(options = {}, injected = {}) {
  const deps = { ...IO, ...injected }
  if (options.check && options.remove) fail('--check와 --remove는 함께 쓸 수 없습니다.')
  const mode = options.remove ? 'remove' : options.check ? 'check' : 'apply'
  const targetRoot = path.resolve(options.targetRoot ?? process.cwd())
  const setting = await deps.readSetting({ targetRoot }, 'agent-block')
  const result = { schemaVersion: 1, mode, setting }
  if (mode === 'apply' && setting !== true) return { ...result, ok: true, skipped: `agent-block: ${setting}`, files: [] }
  const { root, targets, candidates } = await agentBlockTargets(targetRoot, deps)
  if (mode !== 'remove' && setting === true && !targets.length) fail('설치된 gusta 스킬이 없습니다. 먼저 gusta install을 실행하세요.')
  const chosen = mode !== 'remove' ? targets
    : [...new Map(candidates.filter((entry) => entry.exists && !entry.problem).map((entry) => [entry.real, shown(root, entry)])).values()]
  const files = []
  for (const { file, problem, ...entry } of chosen) {
    const text = problem ? null : await readText(file, deps)
    const { status, reason, lines } = problem ? { status: 'broken', reason: problem, lines: [] } : inspectBlock(text)
    files.push({ file, text, entry: { ...entry, status, ...(reason ? { reason, lines } : {}) } })
  }
  const listed = files.map(({ entry }) => entry)
  const broken = listed.some((entry) => entry.status === 'broken')
  if (mode === 'check') return { ...result, ok: setting !== true || listed.every((entry) => entry.status === 'current'), files: listed, block: renderBlock() }
  if (broken) return { ...result, ok: false, files: listed }
  for (const { file, text, entry } of files) {
    const next = mode === 'remove' ? removeBlock(text ?? '') : applyBlock(text)
    entry.before = entry.status
    entry.status = mode === 'remove' ? 'missing' : 'current'
    entry.changed = next !== (text ?? '')
    if (!entry.changed) continue
    // A file left empty was ours alone; an empty CLAUDE.md would still hide AGENTS.md from Claude Code.
    if (mode === 'remove' && !next.trim()) { await deps.unlink(file); entry.deleted = true }
    else await deps.writeFile(file, next)
    if (text === null) entry.created = true
  }
  return { ...result, ok: true, files: listed }
}
