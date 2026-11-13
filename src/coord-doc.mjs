// SESSIONS.md: what running sessions coordinate on — who is working, which task each holds, the
// owner's inbox, the log and the finished tasks not landed yet. It lives alone on the coordination
// branch (src/coord-branch.mjs), not in spec/STATE.md. Everything here is text in, text out.
import { createHash } from 'node:crypto'
import { SkillPackageError } from './errors.mjs'
import { tableRows, yymmdd, INBOX_LINE, ISO_UTC, SESSION_TAG, TASK_ID } from './spec-format.mjs'
import { SESSION_ACTIVE_HEADER, parseState, renderState, upsertActive, appendInbox, closeTasks, mergeState } from './state-doc.mjs'

export const SESSIONS_FILE = 'SESSIONS.md'
export const EMPTY_SESSIONS = '# SESSIONS\n> Running sessions, their claims, the inbox and the log. Written by the gusta CLI on its own branch; never merged into a code branch.\n'
export const UNLANDED_HEADER = ['| id | tag | branch | commit | at |', '|---|---|---|---|---|']
export const STALE_MINUTES = 90
// A heartbeat that only moves `at` is committed once the row is this old: well before the row
// would read as stale elsewhere, and rarely enough that heartbeats do not fill the branch.
export const REFRESH_MINUTES = STALE_MINUTES / 3
export const isoMinute = (date = new Date()) => `${new Date(date).toISOString().slice(0, 16)}Z`
// The tag of the unlanded rows a work group leaves (src/work-groups.mjs): no session may take it,
// or the group's finished tasks would read as that session's own.
export const GROUP_TAG = 'work'
export const RESERVED_TAGS = [GROUP_TAG]

const WIDE = { header: SESSION_ACTIVE_HEADER }
const INTEGRATION_ACTIVE_HEADER = ['| tag | host | mode | since | at | doing | branch | commit | session |', '|---|---|---|---|---|---|---|---|---|']
const wide = (row) => row.session ? { header: INTEGRATION_ACTIVE_HEADER } : WIDE
const ACTIVE_KEYS = ['tag', 'host', 'mode', 'since', 'at', 'doing', 'branch', 'commit']
const UNLANDED_KEYS = ['id', 'tag', 'branch', 'commit', 'at']
const need = (ok, message, details = []) => { if (!ok) throw new SkillPackageError(message, details) }
const timed = (now) => { need(ISO_UTC.test(now ?? ''), 'now는 ISO UTC 시각(2026-10-13T07:44Z)이어야 합니다.'); return now }
const dated = (now) => yymmdd(new Date(timed(now)))
// A table cell holds no `|` and no whitespace run that would break the row.
const cell = (value) => `${value ?? '-'}`.trim().replace(/[|\s]+/g, '-') || '-'
const rowLine = (values) => `| ${values.join(' | ')} |`
const padded = (row, width) => [...row, ...Array(width).fill('-')].slice(0, width).map((value) => value || '-')
const record = (keys) => (row) => Object.fromEntries(padded(row, keys.length).map((value, index) => [keys[index], value]))

// A task this session may not take. owner is the tag holding it, reason how: `claimed` (a live
// session is doing it) or `unlanded` (finished, waiting to land). lost: the claim was made here
// and the remote had the task first.
export class ClaimError extends SkillPackageError {
  constructor(message, { task, owner, reason, row = null, lost = false }) {
    super(message, [task, owner])
    Object.assign(this, { name: 'ClaimError', task, owner, reason, row, lost })
  }
}

// The four sections as data. A six-cell active row (carried over from STATE) reads with `-` in
// the cells it lacks.
export function readSessions(text) {
  const blocks = parseState(text ?? '')
  const body = (name) => blocks.find((block) => block.name === name)?.body ?? []
  const bullets = (name) => body(name).map((line) => line.trimEnd()).filter((line) => line.startsWith('- '))
  return { active: tableRows(body('active')).map((row) => ({ ...record(ACTIVE_KEYS)(row), ...(row[8] && row[8] !== '-' ? { session: row[8] } : {}) })), inbox: bullets('inbox'), log: bullets('log'),
    unlanded: tableRows(body('unlanded')).map(record(UNLANDED_KEYS)) }
}

const sectionPattern = (name) => new RegExp(`^##[ \\t]+${name}[ \\t]*(?:\\r?\\n|(?![\\s\\S]))[\\s\\S]*?(?=^##[ \\t]|(?![\\s\\S]))`, 'm')

// The sections a STATE text still keeps from before they moved to SESSIONS.md.
export const LEGACY_SECTIONS = ['active', 'inbox', 'log']
export const legacySections = (stateText) => LEGACY_SECTIONS.filter((name) => sectionPattern(name).test(stateText ?? ''))

// What a project that has not moved those sections yet coordinates on: SESSIONS first, then what
// only STATE says — a session row SESSIONS lacks (marked legacy), inbox and log lines it lacks.
// Lines come from `stateText`; rows also from `activeFrom` (another copy of STATE, e.g. the
// remote's), earlier texts first.
export function mergeLegacy(doc, stateText, { activeFrom = [] } = {}) {
  const merged = { active: [...doc.active], inbox: [...doc.inbox], log: [...doc.log], unlanded: [...doc.unlanded] }
  for (const text of [...activeFrom, stateText]) {
    for (const row of readSessions(text ?? '').active) if (!merged.active.some((entry) => entry.tag === row.tag)) merged.active.push({ ...row, legacy: true })
  }
  const old = readSessions(stateText ?? '')
  merged.inbox.push(...old.inbox.filter((line) => !merged.inbox.includes(line)))
  const stamp = (line) => line.match(/^- (\d{6})\b/)?.[1] ?? ''
  merged.log = [...merged.log, ...old.log.filter((line) => !merged.log.includes(line))].map((line, index) => ({ line, index }))
    .sort((a, b) => stamp(b.line).localeCompare(stamp(a.line)) || a.index - b.index).map(({ line }) => line)
  return merged
}

// Inbox lines as data. id names a line without quoting it (`vibe inbox resolve --id`).
export const lineId = (line) => createHash('sha1').update(line.trim()).digest('hex').slice(0, 8)
export const inboxEntries = (lines) => lines.map((line) => line.trim().match(INBOX_LINE)).filter(Boolean)
  .map(([line, date, kind, refs, text]) => ({ id: lineId(line), line, date, kind, refs: refs.split(/\s+/), text }))

// Take active, inbox and log out of a STATE text. `state` keeps every other byte (a section cut
// from the end takes the blank line before it along); `sessions` is the SESSIONS.md they make,
// active widened to eight cells; `moved` names the sections found. rows: false and line(text) →
// false leave those rows and inbox·log lines out of `sessions` (they still leave STATE).
export function splitState(stateText, { rows: withRows = true, line: keepLine = () => true } = {}) {
  const source = parseState(stateText)
  const from = (name) => source.find((block) => block.name === name)?.body ?? []
  let state = stateText
  const moved = []
  for (const name of LEGACY_SECTIONS) {
    const found = state.match(sectionPattern(name))
    if (!found) continue
    moved.push(name)
    const before = state.slice(0, found.index)
    const after = state.slice(found.index + found[0].length)
    state = after ? before + after : before.replace(/(\r?\n)(?:[ \t]*\r?\n)+$/, '$1')
  }
  const blocks = parseState(EMPTY_SESSIONS)
  const rows = withRows ? tableRows(from('active')) : []
  if (rows.length) {
    const width = rows.some((row) => row.length > ACTIVE_KEYS.length) ? ACTIVE_KEYS.length + 1 : ACTIVE_KEYS.length
    blocks.push({ name: 'active', body: [...(width === 9 ? INTEGRATION_ACTIVE_HEADER : SESSION_ACTIVE_HEADER), ...rows.map((row) => rowLine(padded(row, width)))] })
  }
  for (const name of ['inbox', 'log']) {
    const lines = from(name).filter((line) => line.trim() !== '' && (!line.startsWith('- ') || keepLine(line.trimEnd())))
    if (lines.length) blocks.push({ name, body: lines })
  }
  return { state, sessions: renderState(blocks), moved }
}

// Three-way merge of SESSIONS.md by the STATE section rules (log and inbox lines unioned, rows by
// ID, the later `at` wins a row both sides moved), with nothing left for a person to resolve:
// what no rule settles goes to theirs. One task held on both sides is theirs too — the remote is
// who claimed first. Our session lets go (doing `-`) and is reported in `lost` with the owner,
// whether the remote holds the task in active or already finished it into unlanded.
export function mergeSessions(base, ours, theirs) {
  let { text } = mergeState(base ?? '', ours || EMPTY_SESSIONS, theirs || EMPTY_SESSIONS, { prefer: 'theirs' })
  const remote = readSessions(theirs)
  const backed = (row) => remote.active.some((other) => other.tag === row.tag && other.doing === row.doing)
  const holders = readSessions(text).active.filter((row) => row.doing !== '-')
  const lost = []
  for (const row of holders.filter((entry) => !backed(entry))) {
    const owner = holders.find((other) => other.tag !== row.tag && other.doing === row.doing && backed(other))
    const done = remote.unlanded.find((entry) => entry.id === row.doing && entry.tag !== row.tag)
    if (!owner && !done) continue
    lost.push({ task: row.doing, owner: owner?.tag ?? done.tag, tag: row.tag, reason: owner ? 'claimed' : 'unlanded' })
    text = upsertActive(text, { ...row, doing: '-' }, WIDE)
  }
  return { text, lost }
}

// No sign of life for STALE_MINUTES. A row whose `at` cannot be read is not called stale.
export const isStale = (row, now) => (Date.parse(now) - Date.parse(row.at)) / 60000 > STALE_MINUTES
const liveness = (live, now) => typeof live === 'function' ? live
  : live ? (row) => [...live].includes(row.tag)
  : (row) => !isStale(row, now)

// Whether a beat that changed nothing but `at` is still worth a commit: the session's row is
// REFRESH_MINUTES old (a session back after a pause, or one that keeps beating through a long task).
export function refreshDue(text, tag, now) {
  const row = readSessions(text).active.find((entry) => entry.tag === tag)
  return Boolean(row) && (Date.parse(now) - Date.parse(row.at)) / 60000 >= REFRESH_MINUTES
}

// Rows of sessions that are gone — stale and holding no task — leave when another session
// writes. `keep` is the writer's own tag (or tags: also a session whose hold this write just
// released, so the row that says who had the task outlives the write). A stale row still holding a
// task stays: it says who to ask, and claimTask releases it when someone takes the task.
export function sweepStale(text, { now, keep = [] } = {}) {
  timed(now)
  const kept = new Set([keep].flat())
  let next = text
  const removed = []
  for (const row of readSessions(text).active) {
    if (kept.has(row.tag) || row.doing !== '-' || !isStale(row, now)) continue
    next = upsertActive(next, { tag: row.tag }, { ...WIDE, remove: true })
    removed.push(row.tag)
  }
  return { text: next, removed }
}

// Take a task for this session (its row is created or moved like a beat: host and mode for a new
// row, branch and commit when known). Refused with a ClaimError while another live session is
// doing it, or while another session's finished copy waits in unlanded. `live` decides who is
// alive — a predicate on the active row, or the live tags; by default a row whose `at` is within
// STALE_MINUTES of now. A dead session's hold is released, named in `released` and logged
// (`released stale <tag> from <task>`): whoever finds the task taken over can tell who had it.
export function claimTask(text, { tag, task, now, live, host, mode, branch, commit, session } = {}) {
  need(SESSION_TAG.test(tag ?? '') && TASK_ID.test(task ?? ''), '선점에는 세션 tag와 태스크 T###가 필요합니다.')
  timed(now)
  const doc = readSessions(text)
  const done = doc.unlanded.find((row) => row.id === task && row.tag !== tag)
  if (done) throw new ClaimError(`${task}는 ${done.tag} 세션이 끝냈고 아직 반영되지 않았습니다(${done.branch} ${done.commit}).`, { task, owner: done.tag, reason: 'unlanded', row: done })
  const holders = doc.active.filter((row) => row.tag !== tag && row.doing === task)
  const owner = holders.find(liveness(live, now))
  if (owner) throw new ClaimError(`${task}는 ${owner.tag} 세션이 선점했습니다.`, { task, owner: owner.tag, reason: 'claimed', row: owner })
  let next = text || EMPTY_SESSIONS
  for (const row of holders) {
    next = upsertActive(next, { ...row, doing: '-' }, WIDE)
    next = applyEvent(next, { type: 'log', text: `released stale ${row.tag} from ${task}`, now }).text
  }
  const beat = applyEvent(next, { type: 'beat', tag, now, doing: task, host, mode, branch, commit, session })
  return { text: beat.text, changed: beat.changed || holders.length > 0, released: holders.map((row) => row.tag) }
}

// Replace the unlanded table. An empty table leaves no section; a new one goes before log.
function writeUnlanded(text, rows) {
  const blocks = parseState(text)
  const index = blocks.findIndex((block) => block.name === 'unlanded')
  const body = [...UNLANDED_HEADER, ...rows.map((row) => rowLine(UNLANDED_KEYS.map((key) => row[key])))]
  if (!rows.length) { if (index !== -1) blocks.splice(index, 1) }
  else if (index !== -1) blocks[index].body = body
  else {
    const log = blocks.findIndex((block) => block.name === 'log')
    blocks.splice(log === -1 ? blocks.length : log, 0, { name: 'unlanded', body })
  }
  return renderState(blocks)
}

const EVENTS = {
  // This session's row. `changed` is false when only `at` moved: the text carries the new time,
  // and the caller decides whether a bare heartbeat is worth a commit.
  beat(text, { tag, now, host, mode, doing, branch, commit, session }) {
    need(SESSION_TAG.test(tag ?? ''), '세션 tag는 영숫자 2-8자입니다.')
    timed(now)
    need(mode === undefined || ['pair', 'autopilot'].includes(mode), 'mode는 pair 또는 autopilot입니다.')
    need(doing === undefined || doing === '-' || TASK_ID.test(doing), 'doing은 T### 또는 -입니다.')
    need(session === undefined || /^[0-9a-f]{24}$/.test(session), 'session은 통합 참여자의 정확한 ID여야 합니다.')
    const previous = readSessions(text).active.find((row) => row.tag === tag)
    need(previous || (host && mode), '새 세션 행에는 host와 mode가 필요합니다.')
    const row = { tag, host: cell(host ?? previous.host), mode: mode ?? previous.mode, since: previous?.since ?? now, at: now,
      doing: doing ?? previous?.doing ?? '-', branch: cell(branch ?? previous?.branch), commit: cell(commit ?? previous?.commit), ...(session ?? previous?.session ? { session: session ?? previous.session } : {}) }
    const changed = !previous || [...ACTIVE_KEYS, 'session'].some((key) => key !== 'at' && row[key] !== previous[key])
    if (!changed && previous.at === now) return { text, changed }
    return { text: upsertActive(text, row, wide(row)), changed }
  },
  // With a task: let go of that task only. Without: the session ended, its row goes.
  release(text, { tag, task, now }) {
    const row = readSessions(text).active.find((entry) => entry.tag === tag)
    if (!row || (task && row.doing !== task)) return { text, changed: false }
    return { text: upsertActive(text, task ? { ...row, doing: '-', at: now ?? row.at } : { tag }, { ...WIDE, remove: !task }), changed: true }
  },
  // `line`, or kind·refs·text·now to build it. A line already there is not added twice.
  'inbox-add'(text, { line, kind, refs, text: note, now }) {
    const entry = line ?? `- ${dated(now)} ${kind} ${[refs].flat().join(' ') || '-'}: ${note}`
    need(INBOX_LINE.test(entry) && !/[\r\n]/.test(entry), 'inbox 줄 형식 오류 (- YYMMDD decided|parked|suggest <refs>: <text>)', [entry])
    if (readSessions(text).inbox.includes(entry)) return { text, changed: false }
    return { text: appendInbox(text, entry), changed: true }
  },
  // The owner settled a line: it goes (the caller logs it).
  'inbox-resolve'(text, { line }) {
    const blocks = parseState(text)
    const block = blocks.find((entry) => entry.name === 'inbox')
    const kept = block?.body.filter((entry) => entry.trim() !== `${line ?? ''}`.trim()) ?? []
    if (!block || kept.length === block.body.length) return { text, changed: false }
    if (kept.some((entry) => entry.trim() !== '')) block.body = kept
    else blocks.splice(blocks.indexOf(block), 1)
    return { text: renderState(blocks), changed: true }
  },
  // `line`, or text·now to build it. Newest on top, the STATE log limit kept.
  log(text, { line, text: note, now }) {
    const entry = line ?? `- ${dated(now)} ${note}`
    need(/^- \d{6} \S/.test(entry) && !/[\r\n]/.test(entry), 'log 줄 형식 오류 (- YYMMDD <text>)', [entry])
    return { text: closeTasks(text, [], { log: entry }).text, changed: true }
  },
  // A finished task waits in unlanded until it lands; the session's hold on it ends.
  'task-done'(text, { tag, task, branch, commit, now }) {
    need(SESSION_TAG.test(tag ?? '') && TASK_ID.test(task ?? ''), 'task-done에는 세션 tag와 태스크 T###가 필요합니다.')
    timed(now)
    const doc = readSessions(text)
    const row = { id: task, tag, branch: cell(branch), commit: cell(commit), at: now }
    let next = text
    const session = doc.active.find((entry) => entry.tag === tag)
    if (session?.doing === task) next = upsertActive(next, { ...session, doing: '-', at: now, ...(branch ? { branch: row.branch } : {}), ...(commit ? { commit: row.commit } : {}) }, WIDE)
    const previous = doc.unlanded.find((entry) => entry.id === task)
    if (!previous) next = writeUnlanded(next, [...doc.unlanded, row])
    else if (UNLANDED_KEYS.some((key) => previous[key] !== row[key])) next = writeUnlanded(next, doc.unlanded.map((entry) => entry === previous ? row : entry))
    return { text: next, changed: next !== text }
  },
  // The land branch holds these tasks now: their unlanded rows go.
  landed(text, { task, tasks = task ? [task] : [] }) {
    const rows = readSessions(text).unlanded
    const kept = rows.filter((row) => !tasks.includes(row.id))
    return kept.length === rows.length ? { text, changed: false } : { text: writeUnlanded(text, kept), changed: true }
  },
}

// One coordination event applied to SESSIONS.md → { text, changed }. An event that changes
// nothing returns the text it was given, so a compare-and-swap writer has nothing to commit.
export function applyEvent(text, event) {
  need(Object.hasOwn(EVENTS, event?.type ?? ''), `알 수 없는 조정 사건입니다: ${event?.type}`, Object.keys(EVENTS))
  return EVENTS[event.type](text || EMPTY_SESSIONS, event)
}
