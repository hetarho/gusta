import { activeAttempt, workerBusy, pendingReview, unitTasks } from './work-policy.mjs'

const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]))
export const progressChecks = (values) => values?.map((value) => pick(value, ['command', 'startedAt', 'finishedAt', 'cached']))
const checks = progressChecks
const step = (value) => ({ ...pick(value, ['taskId', 'commit', 'at']), verification: checks(value.verification) ?? [] })
const dispatch = (value) => value && pick(value, ['id', 'runner', 'role', 'slot', 'provider', 'model', 'status', 'startedAt', 'finishedAt', 'error', 'summary'])
const review = (value) => value && pick(value, ['id', 'owner', 'status', 'verdict', 'summary', 'findings', 'commit', 'baseCommit', 'submissionId', 'createdAt', 'finishedAt', 'releasedAt', 'invalidatedAt', 'invalidationReason', 'reason'])
const run = (value) => value && pick(value, ['id', 'adapter', 'providers', 'workers', 'startedAt', 'stoppedAt', 'dispatched', 'outcome', 'failures', 'autopilot', 'decisionWaitMs', 'decisionWait'])

export function progressAttempt(value) {
  return {
    ...pick(value, ['id', 'group', 'taskId', 'tasks', 'lane', 'owner', 'contributors', 'status', 'reason', 'error', 'createdAt', 'startCommit', 'verifiedCommit', 'submittedBase', 'submissionId', 'submittedAt', 'integratedCommit', 'integratedAt', 'releasedAt', 'cleanedAt', 'risk']),
    ...(value.dispatch ? { dispatch: dispatch(value.dispatch) } : {}),
    ...(value.review ? { review: review(value.review) } : {}),
    ...(value.reviewHistory?.length ? { reviewHistory: value.reviewHistory.map(review) } : {}),
    ...(value.steps?.length ? { steps: value.steps.map(step) } : {}),
    ...(value.verification ? { verification: checks(value.verification) } : {}),
    ...(value.integrationVerification ? { integrationVerification: checks(value.integrationVerification) } : {}),
  }
}

const progressGroup = (value) => ({ ...pick(value, ['id', 'branch', 'status', 'createdAt', 'limits', 'verified', 'push', 'review', 'pushed', 'taskScope']),
  ...(value.runner ? { runner: run(value.runner) } : {}), ...(value.lastRun ? { lastRun: run(value.lastRun) } : {}) })

// History and the latest state are committed by the same atomic runtime rename.
// Heartbeats, PIDs, local paths and command output are deliberately not history.
export function recordProgress(previous, state, at = new Date().toISOString()) {
  state.history ??= []
  for (const [collection, project, type] of [['groups', progressGroup, 'group'], ['attempts', progressAttempt, 'attempt']]) {
    for (const [id, entry] of Object.entries(state[collection])) {
      const old = Object.hasOwn(previous[collection], id) ? project(previous[collection][id]) : null
      const next = project(entry)
      if (JSON.stringify(old) === JSON.stringify(next)) continue
      const changes = Object.fromEntries([...new Set([...Object.keys(old ?? {}), ...Object.keys(next)])]
        .filter((key) => JSON.stringify(old?.[key]) !== JSON.stringify(next[key]))
        .map((key) => [key, next[key] ?? null]))
      state.history.push({ sequence: state.history.length + 1, at, type, group: type === 'group' ? id : entry.group,
        ...(type === 'attempt' ? { attemptId: id, taskId: entry.taskId, ...(unitTasks(entry).length > 1 ? { tasks: unitTasks(entry) } : {}) } : {}), previousStatus: old?.status ?? null, status: next.status, changes })
    }
  }
}

export function workSummary(board, attempts) {
  const completed = new Set(attempts.filter((entry) => entry.status === 'integrated').flatMap(unitTasks).filter((id) => board.doneIds.includes(id)))
  const live = attempts.filter((entry) => activeAttempt(entry) && unitTasks(entry).some((id) => board.tasks.some((task) => task.id === id)))
  const owning = (task) => live.find((entry) => unitTasks(entry).includes(task.id))
  // Counts are tasks, so a lane of three under review counts three.
  const count = (predicate) => board.tasks.filter((task) => owning(task) && predicate(owning(task))).length
  return { total: board.tasks.length + completed.size, completed: completed.size, remaining: board.tasks.length,
    running: count(workerBusy), review: count(pendingReview),
    blocked: count((entry) => ['blocked', 'changes_requested'].includes(entry.status)),
    unassigned: board.tasks.filter((task) => !owning(task)).length }
}

export function progressSnapshot(group, board, state) {
  const attempts = Object.values(state.attempts).filter((entry) => entry.group === group.id)
  return { schemaVersion: 1, snapshotAt: new Date().toISOString(), sourceCommit: board.commit,
    group: progressGroup(group), summary: workSummary(board, attempts),
    tasks: board.tasks.map((task) => ({ id: task.id, title: task.title, dep: task.deps, ...(task.lane ? { lane: task.lane } : {}),
      status: attempts.find((entry) => unitTasks(entry).includes(task.id) && activeAttempt(entry))?.status ?? task.st })),
    attempts: attempts.map(progressAttempt), history: (state.history ?? []).filter((entry) => entry.group === group.id) }
}

export function progressState(markdown, snapshot, file) {
  const { summary, group, snapshotAt } = snapshot
  const row = `| ${group.id} | ${group.limits?.workers ?? 4} | ${summary.total} | ${summary.completed} | ${summary.remaining} | ${summary.running} | ${summary.review} | ${summary.blocked} | ${snapshotAt} | [history](${file}) |`
  const header = '| id | workers | total | done | remaining | running | review | blocked | updated | history |\n|---|---|---|---|---|---|---|---|---|---|'
  const section = markdown.match(/^## work\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)
  if (!section) {
    const addition = `## work\n${header}\n${row}\n\n`
    return /^## next\b/m.test(markdown) ? markdown.replace(/^## next\b/m, `${addition}## next`) : `${markdown.trimEnd()}\n\n${addition}`
  }
  let replaced = false
  const lines = section[1].trimEnd().split('\n').map((line) => {
    if (new RegExp(`^\\|\\s*${group.id}\\s*\\|`).test(line)) { replaced = true; return row }
    return line
  })
  if (!replaced) lines.push(row)
  return markdown.replace(section[0], () => `## work\n${lines.join('\n')}\n\n`)
}
