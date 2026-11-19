// Phase gates of a timed loop: every N completed tasks the batch suite runs on that frozen commit in
// a worktree of its own while units go on, so a failure becomes a repair long before the closing
// gate. The loop decides when to start, harvest and abort; this module plans and runs one phase.
import { git } from './workspace.mjs'
import { measured, timingKey } from './check-cache.mjs'

// A phase is worth starting only when it ends before the closing window: its estimate is, per
// command, the slowest recent phase run, else the slowest recent closing run. Pure.
export function phaseGatePlan({ timings, commands, every, workMs }) {
  if (!commands.length) return { every, enabled: false, why: 'no-batch-checks' }
  const each = commands.map((command) => measured(timings, timingKey('phase', command)) ?? measured(timings, timingKey('final', command)))
  if (each.includes(null)) return { every, enabled: false, why: 'unmeasured' }
  const estimateMs = each.reduce((sum, ms) => sum + ms, 0)
  return workMs > estimateMs ? { every, enabled: true, estimateMs } : { every, enabled: false, why: 'no-time', estimateMs }
}

// ARCH prepare declares no inputs: a changed manifest or lockfile (or prepare command) runs it again.
const DEPENDENCY_FILE = /(^|\/)(package\.json|[^/]*[._-]lock(file)?(\.[^/]*)?|[^/]*\.lockb?|go\.(mod|sum)|Cargo\.toml|pyproject\.toml|requirements[^/]*\.txt|Gemfile|composer\.json)$/i
export const prepareNeeded = (changed) => changed.some((file) => DEPENDENCY_FILE.test(file))

const registered = async (root, directory) => (await git(root, ['worktree', 'list', '--porcelain'])).split('\n')
  .filter((line) => line.startsWith('worktree ')).some((line) => line.slice(9) === directory)
// A check needs the commit's exact tree: what an earlier check left (not ignored files) goes.
const moveTo = async (directory, sha) => {
  await git(directory, ['checkout', '--quiet', '--force', '--detach', sha])
  await git(directory, ['clean', '-fdq'])
}
const inconclusive = ({ checked }) => Boolean(checked.cancelled || checked.timedOut || checked.status === 'not-run')
// What failed (not what a stop or the time budget left unrun).
export const phaseFailures = (entries) => entries.filter((entry) => !entry.checked.ok && !inconclusive(entry))

// runs: [{ command } | { plan }]. check(options, command) is the loop's batch check bound to this
// phase; tree is what the previous phase left ({ prepareKey, preparedAt }). Never throws for a
// failing check: the outcome is pass | flaky | fail | environment | cancelled | timed-out.
export async function runPhaseGate({ root, directory, sha, runs, prepare = [], tree = null, signal, deadline, check, prepareWorkspace, now = Date.now }) {
  const created = !await registered(root, directory)
  if (created) {
    await git(root, ['worktree', 'prune'])
    await git(root, ['worktree', 'add', '--quiet', '--detach', directory, sha])
  } else await moveTo(directory, sha)
  const prepareKey = JSON.stringify(prepare)
  const prepared = Boolean(prepare.length) && (created || !tree || tree.prepareKey !== prepareKey
    || prepareNeeded((await git(root, ['diff', '--name-only', tree.preparedAt, sha])).split('\n').filter(Boolean)))
  if (prepared) {
    const ready = await prepareWorkspace(directory, prepare, { signal, deadline })
    const changed = ready.ok && (await git(directory, ['status', '--porcelain', '--untracked-files=all'])).trim()
    if (!ready.ok || changed) return { ok: false, outcome: signal?.aborted ? 'cancelled' : 'environment', created, prepared, prepare: ready.steps, first: [], round: [], tree: null }
  }
  const state = { prepareKey, preparedAt: prepared || !tree ? sha : tree.preparedAt }
  const round = async (list) => {
    const entries = []
    for (const [index, item] of list.entries()) {
      const remaining = deadline - now()
      if (signal?.aborted || remaining <= 0) {
        entries.push({ command: item.command ?? `verification-plan:${item.plan}#batch`, index: item.index ?? index, checked: { ok: false, status: 'not-run', ...(signal?.aborted ? { cancelled: true } : { timedOut: true }) } })
        continue
      }
      const checked = await check({ targetRoot: directory, timeoutMs: remaining, signal, ...(item.plan ? { plan: item.plan } : {}) }, item.command)
      if (item.plan && Array.isArray(checked.checks)) {
        for (const [i, entry] of checked.checks.entries()) entries.push({ command: entry.command, id: entry.id, index: i, checked: { ...entry, cancelled: checked.cancelled || entry.cancelled, timedOut: checked.timedOut || entry.timedOut } })
      } else entries.push({ command: item.command ?? `verification-plan:${item.plan}#batch`, index: item.index ?? index, checked })
    }
    return entries
  }
  const result = (outcome, first, final) => ({ ok: ['pass', 'flaky'].includes(outcome), outcome, created, prepared, first, round: final, tree: state })
  const stopped = () => signal?.aborted ? 'cancelled' : 'timed-out'
  const first = await round(runs), failed = phaseFailures(first)
  if (!failed.length) return result(first.some(inconclusive) ? stopped() : 'pass', first, first)
  if (failed.every(({ checked }) => checked.exitCode === 127)) return result('environment', first, first)
  // A suite that runs beside units can fail from their load: a failure counts only when it repeats.
  // A plan runs again whole (its passed checks are reused from the cache); commands, only the failed.
  const planned = runs.some((item) => item.plan)
  await moveTo(directory, sha)
  const again = await round(planned ? runs : failed.map(({ command, index }) => ({ command, index })))
  const final = planned ? again : first.map((entry) => again.find((retry) => retry.index === entry.index) ?? entry)
  if (phaseFailures(again).length) return result('fail', first, final)
  return result(again.some(inconclusive) ? stopped() : 'flaky', first, final)
}

export async function removePhaseWorktree(root, directory) {
  if (await registered(root, directory)) await git(root, ['worktree', 'remove', '--force', directory])
}
