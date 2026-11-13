// Session coordination for the vibe commands. Who is working on what, the owner's inbox, the log
// and the finished tasks not landed yet live in SESSIONS.md on the coordination branch
// (src/coord-branch.mjs): written there by compare-and-swap, never in the working tree, and
// pushed at every event so another machine sees work that has not been pushed yet. A project that
// still keeps the old STATE sections is read with them merged in; writes go to the branch only.
// Every function takes the session context vibe.mjs builds (vibeSession).
import { readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git } from './workspace.mjs'
import { readRuntime } from './work-runtime.mjs'
import { readJSON, atomicJSON } from './loop-control.mjs'
import { openCoord } from './coord-branch.mjs'
import { readSessions, applyEvent, claimTask, sweepStale, refreshDue, mergeLegacy, legacySections, isStale, isoMinute, ClaimError, RESERVED_TAGS } from './coord-doc.mjs'
import { delegatedCheckout } from './work-policy.mjs'
import { activeRows, taskRow } from './state-doc.mjs'
import { quoteLine, quoteFields, TASK_ID } from './spec-format.mjs'
import { SkillPackageError } from './errors.mjs'
import { openIntegration } from './integration-gate.mjs'
import { sessionWorkspacePolicy } from './session-workspace.mjs'

const fail = (message, details = []) => { throw new SkillPackageError(message, details) }
export const hostName = () => os.hostname().replace(/\.local$/, '').replace(/[|\s]/g, '-') || 'host'
const RECORD = 'coord.json'
const compact = (result) => ({ pushed: result.pushed, ...(result.reason ? { reason: result.reason } : {}), ...(result.backoff ? { backoff: result.backoff } : {}), ...(result.error ? { error: result.error } : {}) })
// How many sessions' registrations (host·mode) the clone remembers.
const REGISTRATIONS = 50
// A new session row with no mode given and none remembered is a person's session.
const DEFAULT_MODE = 'pair'

async function registerIntegration(context, options, injected) {
  const policy = await sessionWorkspacePolicy({ targetRoot: context.root, workspace: context.workspace })
  if (!policy.allowed) return { registered: false, reason: policy.reason }
  const store = await openIntegration(context, injected.integration)
  return store.register({ tag: options.tag, ...(options.host ? { host: options.host } : {}) })
}

// Tags no session may take: `work` names the unlanded rows a work group leaves.
export function assertSessionTag(tag) {
  if (RESERVED_TAGS.includes(tag)) fail(`세션 tag ${tag}는 예약어입니다(작업 묶음이 통합한 태스크의 unlanded 행 tag). 다른 tag를 쓰세요.`, [tag])
}

// The coordination store of this clone. SETTINGS lives in the tree, so two branches can name two
// coordination branches: the name this clone first wrote under is kept in the shared runtime, and
// while that branch still serves (it exists here and is a coordination branch) a checkout that
// says otherwise stops instead of splitting the sessions over two branches.
export async function coordFor(context, injected = {}) {
  const { coord: branch, coordPush: push } = context.branches
  // A name the settings give to code is refused before any branch exists; a branch that already
  // holds code under this name is refused by the store itself.
  const code = [context.branches.land, context.branches.deploy, context.branches.plan].filter(Boolean)
  if (code.includes(branch)) fail(`조정 브랜치 이름 ${branch}은(는) land·deploy·plan 브랜치와 같습니다. spec/SETTINGS.md coord를 다른 이름으로 고치세요(/gusta-preference).`, code)
  const file = path.join(context.runtime, RECORD)
  const record = (await readJSON(file)) ?? {}
  const open = (name) => openCoord({ cwd: context.root, branch: name, push, remote: context.remote }, injected.coord)
  if (record.branch && record.branch !== branch) {
    const serving = await (await open(record.branch)).read().then((state) => state.commit !== null, () => false)
    if (serving) fail(`이 clone의 조정 브랜치는 ${record.branch}인데 이 checkout의 spec/SETTINGS.md coord는 ${branch}입니다. 어느 쪽인지 추측하지 않습니다 — SETTINGS coord를 ${record.branch}로 맞추세요(이름을 바꾸려면 모든 브랜치의 SETTINGS를 고친 뒤 ${record.branch} 브랜치를 지웁니다).`, [file])
  }
  return { store: await open(branch), branch, push, file }
}

// Keep the branch name (from the first write on), the last publish result and the sessions this
// clone registered (session: { tag, row } remembers its host and mode, { tag, forget } drops them).
async function remember(coord, { publish, session } = {}) {
  const current = (await readJSON(coord.file)) ?? {}
  const sessions = { ...current.sessions }
  const known = session && sessions[session.tag]
  if (session?.row && (known?.host !== session.row.host || known?.mode !== session.row.mode)) sessions[session.tag] = { host: session.row.host, mode: session.row.mode, at: isoMinute() }
  else if (session?.forget) delete sessions[session.tag]
  const kept = Object.entries(sessions).sort(([, x], [, y]) => `${y.at}`.localeCompare(`${x.at}`)).slice(0, REGISTRATIONS)
  const next = { schemaVersion: 1, ...current, branch: coord.branch, since: current.since ?? isoMinute(), ...(publish ? { publish } : {}), sessions: Object.fromEntries(kept) }
  if (!kept.length) delete next.sessions
  if (JSON.stringify(next) !== JSON.stringify({ schemaVersion: 1, ...current })) await atomicJSON(coord.file, next)
}
// The host and mode this clone last registered `tag` with, or null.
const registration = async (coord, tag) => ((await readJSON(coord.file)) ?? {}).sessions?.[tag] ?? null

// One coordination event: applied to SESSIONS.md by compare-and-swap, the rows of sessions long
// gone swept with it, then published. mutate(text, { now }) → { text, changed?, released?, ... };
// an event that changed nothing (a heartbeat that only moved `at`) leaves no commit.
// Only a writer that knows its own tag sweeps: a write without one (an inbox line, the landed
// record of vibe push) could take its own session's row. The sessions whose hold this write
// released stay too, so the row naming who had the task outlives the write.
// publish: 'changed' pushes what this event committed; 'always' also when it committed nothing
// (a claim must learn what the remote holds); false leaves it for the next event. Publishing
// never throws: `unpublished` says the remote still lacks what this clone holds.
export async function coordWrite(context, mutate, { tag = null, message, publish = 'changed', injected = {}, coord: opened } = {}) {
  const coord = opened ?? await coordFor(context, injected)
  const written = await coord.store.update(async (text, at) => {
    const value = await mutate(text, at)
    if (value.changed === false || value.text === text || !tag) return { ...value, text: value.changed === false ? text : value.text }
    const swept = sweepStale(value.text, { now: at.now, keep: [tag, ...(value.released ?? [])] })
    return { ...value, text: swept.text, swept: swept.removed }
  }, { message })
  const pushed = publish === 'always' || (publish === 'changed' && written.changed) ? await coord.store.publish() : null
  const row = tag ? rowOf(written.text, tag) : null
  await remember(coord, { ...(pushed ? { publish: { at: isoMinute(), ...compact(pushed) } } : {}), ...(row ? { session: { tag, row } } : {}) })
  const lost = tag ? (pushed?.lost ?? []).filter((entry) => entry.tag === tag).map(({ task, owner, reason }) => ({ task, owner, reason })) : []
  return { value: written.value, changed: written.changed, store: coord.store,
    coordination: { branch: coord.branch, changed: written.changed, push: pushed ? compact(pushed) : { pushed: false, reason: written.changed ? 'deferred' : 'unchanged' },
      lost, unpublished: await coord.store.unpublished(), ...(written.value.swept?.length ? { swept: written.value.swept } : {}) } }
}

// Work-group workers and reviewers do not write coordination: their progress is the runtime's,
// and what the owner must see goes through the coordinator.
export async function assertCoordinator(context, command) {
  if (delegatedCheckout(await readRuntime(context.runtime), context.root)) {
    fail(`작업 묶음의 워커·리뷰어 checkout에서는 vibe ${command}를 쓰지 않습니다. 진행은 work update로 남기고, 결정·주차는 조정자가 기록합니다.`, [context.root])
  }
}
export const isDelegated = async (context) => delegatedCheckout(await readRuntime(context.runtime), context.root)

// Where the session works: its branch and the commit it stands on (`-` before the first commit).
async function place(context) {
  return { branch: context.branch ?? '-', commit: (await git(context.root, ['rev-parse', '--verify', '--quiet', '--short=12', 'HEAD^{commit}'], [1, 128]))?.trim() || '-' }
}
const rowOf = (text, tag) => readSessions(text).active.find((row) => row.tag === tag) ?? null
// A new row's host and mode: what the call says, else the row this tag has in STATE's old active
// table (a project that has not moved it yet), else what this clone registered it with before
// (`known`: its row was swept while it sat idle, and it comes back as what it was).
function identity(context, text, options, known = null) {
  const row = rowOf(text, options.tag) ?? activeRows(context.state ?? '').find((entry) => entry.tag === options.tag)
  return { host: options.host ?? row?.host ?? known?.host ?? hostName(), mode: options.mode ?? row?.mode ?? known?.mode }
}
const commitTime = async (root, ref) => (await git(root, ['log', '-1', '--format=%cI', ref, '--'], [128]))?.trim() || null
// The newest snapshot a session left on wip/<tag>, here or on the remote as last fetched.
export async function wipTime(context, tag) {
  const times = await Promise.all([`refs/heads/wip/${tag}`, ...(context.remote ? [`refs/remotes/${context.remote}/wip/${tag}`] : [])].map((ref) => commitTime(context.root, ref)))
  return times.filter(Boolean).map((value) => new Date(Date.parse(value)).toISOString()).sort().at(-1) ?? null
}

// A beat or a repeated claim that moved nothing but `at`: left uncommitted while the row is
// fresh, committed once it is old enough to be a sign of life (coord-doc REFRESH_MINUTES).
const heartbeat = (result, text, tag, now) => result.changed ? result : { ...result, changed: refreshDue(text, tag, now) }

function lostClaim(coordination, task) {
  const lost = coordination.lost.find((entry) => entry.task === task)
  if (lost) throw new ClaimError(`${task}는 ${lost.owner} 세션이 원격에 먼저 올렸습니다. 이 세션의 선점은 풀렸습니다.`, { task, owner: lost.owner, reason: lost.reason, lost: true })
}

// vibe beat: this session's row — created, moved or (end) removed. `--doing T###` takes the task
// like a claim; a beat that only moves `at` is not committed until the row needs refreshing.
export async function beatSession(context, options, injected = {}) {
  const { tag } = options
  assertSessionTag(tag)
  const coord = await coordFor(context, injected)
  if (options.end) {
    const ended = await coordWrite(context, (text, { now }) => applyEvent(text, { type: 'release', tag, now }), { tag, message: `gusta ${tag}: session end`, injected, coord })
    await remember(coord, { session: { tag, forget: true } })
    return { schemaVersion: 1, tag, removed: ended.changed, coordination: ended.coordination }
  }
  const where = await place(context)
  const task = TASK_ID.test(options.doing ?? '') ? options.doing : null
  const known = await registration(coord, tag)
  const written = await coordWrite(context, (text, { now }) => {
    const who = identity(context, text, options, known)
    if (!rowOf(text, tag) && !who.mode) fail('새 세션 행에는 --mode가 필요합니다.')
    return heartbeat(task ? claimTask(text, { tag, task, now, ...who, ...where })
      : applyEvent(text, { type: 'beat', tag, now, ...who, doing: options.doing, ...where }), text, tag, now)
  }, { tag, message: `gusta ${tag}: ${task ? `claim ${task}` : 'beat'}`, injected, coord })
  if (task) lostClaim(written.coordination, task)
  return { schemaVersion: 1, row: rowOf((await written.store.read()).text, tag), changed: written.changed, coordination: written.coordination,
    integration: await registerIntegration(context, options, injected) }
}

// The task's own st — this checkout's row and file, and the land branch's row as last fetched: a
// doing tag that is not ours means another session owns it there, whatever SESSIONS says.
async function foreignOwner(context, task, tag, landState) {
  const names = (await readdir(path.join(context.root, 'spec/tasks')).catch(() => [])).filter((name) => name.startsWith(`${task}.`) && name.endsWith('.md'))
  const files = await Promise.all(names.map((name) => readFile(path.join(context.root, 'spec/tasks', name), 'utf8')))
  const statuses = [taskRow(context.state ?? '', task)?.st, taskRow(landState ?? '', task)?.st, ...files.map((text) => quoteFields(quoteLine(text) ?? '').get('st'))]
  return statuses.find((st) => st?.startsWith('doing@') && st.split('.')[1] !== tag) ?? null
}

// vibe claim: take a task for this session — one compare-and-swap on the coordination branch, so
// of two worktrees exactly one wins, with no push and no clean tree needed. The task's
// `doing@date.tag` st stays the working tree's (vibe task start writes it; the caller commits).
// check: also refuse what the task's own st says (off for a caller that checked it).
// A session without a row — never registered, or swept while it sat idle — is registered first
// (its remembered host and mode, else this host and `pair`): a claim is never skipped, or two
// worktrees could both start the task.
export async function claimSession(context, options, { landState = null, check = true, injected = {} } = {}) {
  const { tag, task } = options
  assertSessionTag(tag)
  if (task && check) {
    const row = taskRow(context.state ?? '', task)
    if (!options.repairTask) {
      if (!row) fail('이 checkout의 STATE tasks 표에 선점할 태스크가 없습니다. 기획 기준을 먼저 가져오세요(vibe plan-sync).', [task])
      if (row.st !== 'todo' && !row.st?.endsWith(`.${tag}`)) fail('다른 세션이 선점했거나 실행할 수 없는 태스크입니다.', [task, row.st])
    }
    const owner = await foreignOwner(context, task, tag, landState)
    if (owner) throw new ClaimError('다른 세션이 선점했거나 소유자를 확인해야 하는 태스크입니다.', { task, owner: owner.split('.')[1] ?? owner, reason: 'claimed' })
  }
  const coord = await coordFor(context, injected)
  const before = (await coord.store.read()).text
  const known = await registration(coord, tag)
  // Sessions seen holding the task and still snapshotting: alive whatever their row's `at` says.
  const legacy = task ? mergeLegacy(readSessions(''), context.state, { activeFrom: [landState] }).active.filter((row) => row.tag !== tag && row.doing === task) : []
  const snapshots = new Map()
  for (const row of task ? [...readSessions(before).active.filter((entry) => entry.tag !== tag && entry.doing === task), ...legacy] : []) snapshots.set(row.tag, await wipTime(context, row.tag))
  const where = await place(context)
  const written = await coordWrite(context, (text, { now }) => {
    const who = identity(context, text, options, known)
    who.mode ??= DEFAULT_MODE
    if (!task) return heartbeat(applyEvent(text, { type: 'beat', tag, now, ...who, ...where }), text, tag, now)
    const live = (row) => !isStale(row, now) || (snapshots.get(row.tag) ? !isStale({ at: snapshots.get(row.tag) }, now) : false)
    // A project that has not moved its active table yet: a live row there holds the task too.
    const old = legacy.find((row) => !rowOf(text, row.tag) && live(row))
    if (old) throw new ClaimError(`${task}는 ${old.tag} 세션이 선점했습니다.`, { task, owner: old.tag, reason: 'claimed', row: old })
    return heartbeat(claimTask(text, { tag, task, now, live, ...who, ...where }), text, tag, now)
  }, { tag, message: `gusta ${tag}: claim ${task ?? 'session'}`, publish: 'always', injected, coord })
  if (task) lostClaim(written.coordination, task)
  return { schemaVersion: 1, ok: true, tag, task: task ?? null, claimed: Boolean(task), released: written.value.released ?? [],
    row: rowOf((await written.store.read()).text, tag), unpublished: written.coordination.unpublished, coordination: written.coordination,
    integration: await registerIntegration(context, options, injected) }
}

// vibe task done: the finished task waits in unlanded until the land branch holds it (so no other
// session picks it up again from a branch that still shows it todo), and the log gets its line.
export async function recordTaskDone(context, { tag, task, commit, log }, injected = {}) {
  const where = await place(context)
  return (await coordWrite(context, (text, { now }) => {
    const done = applyEvent(text, { type: 'task-done', tag, task, branch: where.branch, commit: commit ?? where.commit, now })
    return log ? { text: applyEvent(done.text, { type: 'log', line: log }).text, changed: true } : done
  }, { tag, message: `gusta ${tag}: ${task} done`, injected })).coordination
}

// vibe push · vibe deploy: `commit` is on the land branch now. The unlanded tasks whose archived
// file its tree holds have landed. null when nothing was waiting (no write, no branch created).
export async function recordLanded(context, commit, injected = {}) {
  const coord = await coordFor(context, injected)
  const waiting = readSessions((await coord.store.read()).text).unlanded
  if (!waiting.length) return null
  const names = (await git(context.root, ['ls-tree', '--name-only', '-z', `${commit}:spec/tasks/done`], [128]))?.split('\0').map((name) => path.basename(name)) ?? []
  const tasks = waiting.map((row) => row.id).filter((id) => names.some((name) => name.startsWith(`${id}.`)))
  if (!tasks.length) return { branch: coord.branch, landed: [], waiting: waiting.map((row) => row.id) }
  const written = await coordWrite(context, (text) => applyEvent(text, { type: 'landed', tasks }), { message: `gusta: landed ${tasks.join(' ')}`, injected, coord })
  return { ...written.coordination, landed: tasks, waiting: waiting.map((row) => row.id).filter((id) => !tasks.includes(id)) }
}

// vibe checkpoint: an event of its own — the row's commit and `at` move even when nothing else
// did, so a long task does not read as a dead session elsewhere. A session without a row here is
// registered as vibe claim registers it: a snapshot is a sign of life.
export async function recordCheckpoint(context, tag, injected = {}) {
  assertSessionTag(tag)
  const coord = await coordFor(context, injected)
  const known = await registration(coord, tag)
  const where = await place(context)
  const written = await coordWrite(context, (text, { now }) => {
    const who = rowOf(text, tag) ? {} : { ...identity(context, text, { tag }, known) }
    if (!rowOf(text, tag)) who.mode ??= DEFAULT_MODE
    const beat = applyEvent(text, { type: 'beat', tag, now, ...who, ...where })
    return { text: beat.text, changed: beat.text !== text }
  }, { tag, message: `gusta ${tag}: checkpoint`, injected, coord })
  return written.coordination
}

// What a session reads of the coordination: SESSIONS — synced with the remote first unless fetch
// is off — merged with the old sections this checkout's STATE still has (legacy names them;
// `sessions` is SESSIONS alone). activeFrom: other copies of STATE whose old active rows count
// too (the remote's).
// A coordination branch that cannot be used (its name is taken by a code branch, or SETTINGS
// coord disagrees with the clone's) does not stop a read: `error` says why, and the view is what
// STATE alone says. Writes are what stop.
// backoff: the remote is left alone until `until` after an auth, timeout or network failure.
// writable: also check that a write would succeed here (ref name free, branch not checked out,
// a Git identity) — preflight asks, so a loop does not die at its first coordination write.
export async function coordView(context, { fetch = true, tag = null, activeFrom = [], writable = false, injected = {} } = {}) {
  const legacy = legacySections(context.state)
  try {
    const coord = await coordFor(context, injected)
    const synced = fetch ? await coord.store.sync().catch((error) => ({ action: 'none', reason: 'error', error: error.message, lost: [] })) : { action: 'none', reason: 'no-fetch', lost: [] }
    if (synced.action !== 'none') await remember(coord)
    const { text, commit } = await coord.store.read()
    const record = (await readJSON(coord.file)) ?? {}
    const { remote } = coord.store
    const sessions = readSessions(text)
    const backoff = await coord.store.backoff()
    return { doc: mergeLegacy(sessions, context.state, { activeFrom }), sessions, commit, branch: coord.branch, legacy,
      lost: tag ? synced.lost.filter((entry) => entry.tag === tag).map(({ task, owner, reason }) => ({ task, owner, reason })) : [],
      sync: { action: synced.action, ...(synced.reason ? { reason: synced.reason } : {}), ...(synced.error ? { error: synced.error } : {}) },
      push: { enabled: coord.push && Boolean(remote), remote, ...(!coord.push ? { reason: 'disabled' } : !remote ? { reason: 'no-remote' } : {}), unpublished: await coord.store.unpublished(), last: record.publish ?? null, ...(backoff ? { backoff } : {}) },
      ...(writable ? { writable: await coord.store.writable() } : {}) }
  } catch (error) {
    if (!(error instanceof SkillPackageError)) throw error
    const sessions = readSessions('')
    return { doc: mergeLegacy(sessions, context.state, { activeFrom }), sessions, commit: null, branch: context.branches.coord, legacy, lost: [],
      sync: { action: 'none', reason: 'error' }, push: { enabled: false, remote: context.remote ?? null, reason: 'error', unpublished: false, last: null },
      error: [error.message, ...(error.details ?? [])].join(' ') }
  }
}

// Whether a commit another session stands on is on the remote, as far as this clone knows:
// true, false ("not pushed yet"), or null when that cannot be told (no remote, no commit named,
// or a commit this clone lacks with nothing fetched to compare).
export async function commitOnRemote(context, commit, fetched) {
  if (!context.remote || !commit || commit === '-') return null
  const full = (await git(context.root, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], [1, 128]))?.trim()
  if (!full) return fetched ? false : null
  return Boolean((await git(context.root, ['for-each-ref', '--count=1', '--format=%(refname)', '--contains', full, `refs/remotes/${context.remote}`], [1, 128, 129]))?.trim())
}
