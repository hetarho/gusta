import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// Full-gate (batch/group) rounds per session, shared by every worktree of a clone next to
// checks.json and timings.json. A standalone coordinator is refused once GATE_CAP rounds have
// failed — a success does not reset the count, as in the loop. The loop host only records here:
// it decides with its own counter (--max-gate-attempts), so one round is never counted twice.
export const GATE_CAP = 3
// A key nobody gated for this long belongs to finished work: the next session counts afresh.
export const GATE_IDLE_MS = 12 * 3600000
export function improvingGate(previous, current) {
  if (!previous || (previous.plan ?? previous.command) !== (current.plan ?? current.command) || previous.evidence !== current.evidence || !previous.failureSetComplete || !current.failureSetComplete || previous.timedOut || current.timedOut || previous.stale || current.stale) return false
  const was = previous.identities ?? previous.failedTests, now = current.identities ?? current.failedTests
  if (!Array.isArray(was) || !Array.isArray(now) || [...was, ...now].some((id) => typeof id !== 'string' || !id.trim())) return false
  const before = new Set(was), after = new Set(now)
  if (before.size !== was.length || after.size !== now.length) return false
  return after.size > 0 && after.size < before.size && [...after].every((id) => before.has(id))
}
const FILE = 'gates.json'
const normalized = (command) => command.trim().replace(/\s+/g, ' ')

// --tag names the session; without it the branch is the session (a detached checkout is its own).
export const gateKey = ({ tag, branch, root }) => tag ? `tag:${tag}` : branch ? `branch:${branch}` : `detached:${root}`

export async function readGates(runtime) {
  try {
    const store = JSON.parse(await readFile(path.join(runtime, FILE), 'utf8'))
    return store?.schemaVersion === 1 && store.entries && typeof store.entries === 'object' ? store : { schemaVersion: 1, entries: {} }
  } catch { return { schemaVersion: 1, entries: {} } }
}

export function gateCount(entry, now = Date.now()) {
  const live = entry && now - Date.parse(entry.at) <= GATE_IDLE_MS
  return live ? { attempts: entry.attempts, failures: entry.failures, last: entry.last ?? null } : { attempts: 0, failures: 0, last: null }
}

// One round is one pass over one tree: the commands run on that tree join it and it fails once,
// however many of them fail, so a two-command gate is not charged twice. Running a command again
// on the same tree is a new round — a rerun is a new attempt.
export function addRun(entry, run, now = Date.now()) {
  const { attempts, failures, last } = gateCount(entry, now)
  const joins = Boolean(last && last.tree === run.tree && !last.commands.some((step) => normalized(step.command) === normalized(run.command)))
  const failedBefore = joins && last.commands.some((step) => !step.ok)
  const step = { command: run.command, ok: run.ok, log: run.log ?? null }
  return { attempts: attempts + (joins ? 0 : 1), failures: failures + (!run.ok && !failedBefore ? 1 : 0), at: new Date(now).toISOString(),
    last: { tree: run.tree, commit: run.commit, commands: [...(joins ? last.commands : []), step].slice(-10) } }
}

export const gateView = (key, count) => ({ key, attempts: count.attempts, failures: count.failures, cap: GATE_CAP, left: Math.max(0, GATE_CAP - count.failures) })

// Callers hold the clone's heavy lock while they record, so read-modify-write does not race.
async function write(runtime, store) {
  await mkdir(runtime, { recursive: true })
  const temporary = path.join(runtime, `gates.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(store)}\n`)
  await rename(temporary, path.join(runtime, FILE))
}

export async function recordGateRun(runtime, key, run, now = Date.now()) {
  const store = await readGates(runtime)
  const entry = addRun(store.entries[key], run, now)
  store.entries[key] = entry
  await write(runtime, store)
  return gateCount(entry, now)
}

// Only a person lifts the cap (vibe check --reset-gate); no unattended instruction does.
export async function resetGate(runtime, key, now = Date.now()) {
  const store = await readGates(runtime)
  const previous = gateCount(store.entries[key], now)
  if (Object.hasOwn(store.entries, key)) { delete store.entries[key]; await write(runtime, store) }
  return previous
}
