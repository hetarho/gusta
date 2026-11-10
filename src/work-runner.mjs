import { readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtInAdapter } from './work-providers.mjs'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { inspectWork, claimNextWork, commitWorkerWork, submitWork, integrateWork, finishWork, workBoard, syncWork, workInternals } from './work-groups.mjs'
import { claimReview, finishReview, releaseReview, resumeWork } from './work-review.mjs'
import { readRuntime, transaction } from './work-runtime.mjs'
import { workLimits, activeAttempt } from './work-policy.mjs'
import { workingTree } from './check-cache.mjs'
import { stateMergeArgs } from './git-merge.mjs'
import { git } from './workspace.mjs'
import { pruneWork } from './prune.mjs'

const { repository, groupOf, attemptOf, now, fail, requireStopped, commands, tierChecks, briefFor } = workInternals
// A session carries its context into the next lane task, correction or answered decision,
// up to this many times in a row; then a fresh one starts. A unit may file this many decisions.
const MAX_RESUMES = 4
const MAX_DECISIONS = 3
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const positive = (value, fallback, name) => {
  const number = Number(value ?? fallback)
  if (!Number.isSafeInteger(number) || number < 1) fail(`${name}: 양의 정수가 필요합니다.`)
  return number
}

export async function recoverRunner(options) {
  const context = await repository(options)
  return transaction(context.root, (state) => {
    const group = groupOf(state, options.work)
    if (!group.runner) fail('복구할 runner 기록이 없습니다.')
    requireStopped(group.runner)
    for (const entry of Object.values(state.attempts)) {
      const dispatch = entry.dispatch
      if (dispatch?.runner !== group.runner.id || !['starting', 'running'].includes(dispatch.status)) continue
      if (!dispatch.pid) fail('시작 중 중단된 실행의 PID를 확인할 수 없습니다. 실행기 프로세스를 수동으로 확인해야 합니다.', [dispatch.id])
      requireStopped(dispatch)
      dispatch.status = 'interrupted'
      if (entry.status === 'doing') { entry.status = 'blocked'; entry.reason = 'runner interrupted; inspect worker before resuming' }
      // A review claim remains explicit: review-release after confirming the reviewer stopped.
    }
    group.lastRun = { ...group.runner, stoppedAt: now(), outcome: 'recovered' }
    delete group.runner
    return group.lastRun
  })
}

async function adapterConfig(options) {
  let config
  const providerOptions = ['provider', 'providers', 'reviewerProvider', 'model', 'reviewerModel']
  if (options.adapter) {
    if (providerOptions.some((key) => options[key] !== undefined)) fail('--adapter와 --provider/--model 옵션을 함께 지정할 수 없습니다.')
    const filename = path.resolve(options.adapter)
    config = JSON.parse(await readFile(filename, 'utf8'))
    const builtin = config?.provider !== undefined || config?.providers !== undefined || config?.workers !== undefined
    if (builtin && config.command) fail('어댑터 설정은 provider/workers 또는 command 중 하나만 지정하세요.')
    if (builtin) config = await builtInAdapter({ ...config, targetRoot: options.targetRoot, env: options.env })
    else {
      if (!config || typeof config.command !== 'string' || !config.command || !Array.isArray(config.args) || config.args.some((value) => typeof value !== 'string')) fail('어댑터 설정에는 command와 문자열 args 배열이 필요합니다.')
      config.kind = 'custom'
      if (config.command.includes('/') && !path.isAbsolute(config.command)) config.command = path.resolve(path.dirname(filename), config.command)
    }
  } else config = await builtInAdapter(options)
  for (const [key, fallback] of [['timeoutMs', 3600000], ['maxDispatches', 200], ['maxTaskRuns', 3]]) {
    config[key] = Number(options[key] ?? config[key] ?? fallback)
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) fail(`${key}: 양의 정수가 필요합니다.`)
  }
  return config
}

// Three verification tiers: taskVerify at every task submission (optional, fast),
// verify at every unit integration, groupVerify once after the last integration.
export async function runWork(options) {
  for (const key of ['verify', 'taskVerify', 'groupVerify']) if (options[key] !== undefined) commands(options, key, true)
  const config = await adapterConfig(options)
  // Autopilot: nobody answers. Planning decisions are filed for the coordinator, and the
  // runner waits for them (no model calls) instead of ending while they are open.
  const autopilot = Boolean(options.autopilot)
  const decisionWaitMs = positive(options.decisionWaitMs, (autopilot ? 15 : 120) * 60 * 1000, 'decision-wait-ms')
  const checkpointMs = positive(options.checkpointMs, 30 * 60 * 1000, 'checkpoint-ms')
  const pollMs = positive(options.pollMs, 5000, 'poll-ms')
  const context = await repository(options)
  const stored = groupOf(await readRuntime(context.root), options.work)
  const verify = tierChecks(options, stored, 'unit')
  const taskVerify = options.taskVerify ?? stored.verify?.task ?? []
  const groupVerify = options.groupVerify ?? stored.verify?.group ?? []
  if (options.dryRun) {
    const group = groupOf(await readRuntime(context.root), options.work)
    return { schemaVersion: 1, dryRun: true, work: group.id, limits: workLimits(group.limits), adapter: config, verify, taskVerify, groupVerify, autopilot, decisionWaitMs, modelRequests: 0 }
  }
  const run = { adapter: config.kind, providers: config.roles ? Object.fromEntries(Object.entries(config.roles).map(([role, entry]) => [role, { provider: entry.provider, model: entry.model, version: entry.version }])) : null,
    workers: config.workers?.map((entry) => ({ provider: entry.provider, model: entry.model, version: entry.version })) ?? null,
    id: randomUUID(), pid: process.pid, host: os.hostname(), startedAt: now(), autopilot, decisionWaitMs }
  const group = await transaction(context.root, (state) => {
    const group = groupOf(state, options.work)
    if (group.runner) fail('작업 묶음에 runner가 이미 있습니다. 종료 후 runner-recover로 확인하세요.', [JSON.stringify(group.runner)])
    group.runner = run
    return structuredClone(group)
  })
  const limits = workLimits(group.limits)
  const jobs = new Map()
  const failures = []
  const integrationFailures = new Set()
  const integrationTries = new Map()
  // A repaired, resubmitted attempt is eligible again; retry limits belong to its submission.
  const integrationKey = (entry) => `${entry.id}:${entry.submissionId ?? entry.verifiedCommit}`
  const counts = new Map()
  let dispatched = 0
  let stopping = false
  let interrupted = false
  const abort = new AbortController()
  let heartbeatError = null
  let snapshot = null, snapshotError = null, finish = null, finishError = null, pruned = null, pruneError = null
  const decisions = []
  let lastActivity = Date.now()
  let decisionTimedOut = false
  let integrationStalled = false
  const outcomeFor = (board) => interrupted || heartbeatError ? 'interrupted' : board.tasks.length === 0 && !finishError ? 'completed'
    : board.tasks.every((task) => task.mainSession) && !finishError ? 'main-session' : integrationStalled ? 'needs-attention' : dispatched >= config.maxDispatches ? 'dispatch-limit'
      : decisionTimedOut ? 'decision-wait' : 'needs-attention'
  const recordDecisionWait = async (attempts) => {
    if (JSON.stringify(run.decisionWait?.attempts ?? []) === JSON.stringify(attempts)) return
    if (attempts.length) run.decisionWait = { startedAt: now(), deadlineAt: new Date(lastActivity + decisionWaitMs).toISOString(), attempts }
    else delete run.decisionWait
    await transaction(context.root, (state) => {
      const runner = groupOf(state, group.id).runner
      if (runner?.id !== run.id) fail('runner ownership changed')
      if (run.decisionWait) runner.decisionWait = run.decisionWait
      else delete runner.decisionWait
    })
    if (run.decisionWait) process.stderr.write(`[work run] decision-wait ${JSON.stringify(run.decisionWait)}\n`)
  }
  // Keep a Mac awake for exactly as long as this runner lives.
  let awake = null
  if (process.platform === 'darwin' && (options.env ?? process.env).HAERAM_NO_AWAKE !== '1') {
    awake = spawn('caffeinate', ['-i', '-m', '-s', '-w', String(process.pid)], { detached: true, stdio: 'ignore' })
    awake.on('error', () => {})
    awake.unref()
  }
  // Worker workspaces are snapshotted onto a ref every checkpointMs and before a timeout kill,
  // so an experiment cut short keeps its files (and, with --push, shows on wip/<attempt>).
  let checkpoints = Promise.resolve()
  const checkpointWorkspace = async (job) => {
    job.checkpointAt = Date.now()
    const ref = `refs/haeram/checkpoints/${job.attempt}`
    const tree = await workingTree(job.workspace)
    const previous = (await git(job.workspace, ['rev-parse', '--verify', '--quiet', ref], [1]))?.trim() || null
    if (previous && (await git(job.workspace, ['rev-parse', `${previous}^{tree}`])).trim() === tree) return previous
    const headCommit = (await git(job.workspace, ['rev-parse', 'HEAD'])).trim()
    const parents = previous ? [previous] : []
    if (!previous || (await git(job.workspace, ['merge-base', '--is-ancestor', headCommit, previous], [1])) === null) parents.push(headCommit)
    const commit = (await git(job.workspace, ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', `checkpoint ${job.taskId} ${now()}`])).trim()
    await git(job.workspace, ['update-ref', ref, commit])
    if (group.push) await git(context.cwd, ['push', '--quiet', group.remote ?? 'origin', `${commit}:refs/heads/wip/${job.attempt.slice(0, 8)}`], [1, 128])
    return commit
  }
  // Partial work becomes a commit on the attempt branch so the next run starts clean from it.
  const commitProgress = async (workspace, message) => {
    if (!(await workInternals.clean(workspace))) {
      await git(workspace, ['add', '--all'])
      await git(workspace, ['commit', '-q', '-m', message])
    }
    return (await git(workspace, ['rev-parse', 'HEAD'])).trim()
  }
  const kill = (job) => {
    if (!job.child || job.settled) return
    try { if (process.platform === 'win32') job.child.kill('SIGTERM'); else process.kill(-job.child.pid, 'SIGTERM') } catch {}
  }
  const stop = () => { interrupted = true; stopping = true; abort.abort(); for (const job of jobs.values()) kill(job) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  let heartbeat = Promise.resolve()
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(() => transaction(context.root, (state) => {
      if (state.groups[group.id]?.runner?.id !== run.id) fail('runner ownership changed')
      state.groups[group.id].runner.heartbeatAt = now()
      for (const job of jobs.values()) {
        const entry = state.attempts[job.attempt]
        if (entry?.dispatch?.id !== job.id || job.settled) continue
        entry.heartbeatAt = now()
        if (job.review && entry.review?.id === job.review.id) entry.review.heartbeatAt = now()
      }
    })).catch((error) => { heartbeatError = error.message; stop() })
    for (const job of jobs.values()) {
      if (job.role !== 'worker' || job.settled || Date.now() - (job.checkpointAt ?? job.startedAt) < checkpointMs) continue
      job.checkpointAt = Date.now()
      checkpoints = checkpoints.then(() => checkpointWorkspace(job)).catch(() => {})
    }
  }, 10000)
  timer.unref()

  const orphaned = (entry) => /^[0-9a-f-]{36}\/worker-\d+$/.test(entry.owner ?? '') && !entry.owner.startsWith(`${run.id}/`) &&
    !['starting', 'running'].includes(entry.dispatch?.status)
  const adopt = (entry, owner) => transaction(context.root, (state) => {
    const live = attemptOf(state, entry.id)
    if (live.status !== 'doing' || live.owner !== entry.owner) return null
    live.contributors = [...new Set([...(live.contributors ?? [live.owner]), owner])]
    live.owner = owner
    return live
  })

  const launch = async (role, attempt, slot, review) => {
    if (stopping) {
      if (review) await releaseReview({ ...options, review: review.id, reason: 'runner stopped before launch' })
      else await transaction(context.root, (state) => { Object.assign(attemptOf(state, attempt.id), { status: 'blocked', reason: 'runner stopped before launch' }) })
      return
    }
    await recordDecisionWait([])
    const workspace = review?.workspace ?? attempt.workspace
    let expectedHead = null
    const live = await readRuntime(context.root)
    const current = attemptOf(live, attempt.id)
    const liveGroup = groupOf(live, group.id)
    try {
      if (config.kind === 'builtin') await workInternals.requireClean(workspace)
      // An answered decision changed planning: bring the group branch (SSOT, inbox) in first.
      if (role === 'worker' && current.directive && current.directive.kind !== 'timeout') {
        try { await git(workspace, [...await stateMergeArgs(workspace, context.root), 'merge', '--no-edit', '--quiet', `refs/heads/${group.branch}`]) } catch (error) {
          await git(workspace, ['merge', '--abort'], [128]).catch(() => {})
          fail(`기획 브랜치를 워커 공간에 합치지 못했습니다: ${(error.stderr || error.message).trim().slice(-400)}`)
        }
      }
      if (config.kind === 'builtin' && role === 'worker') expectedHead = await workInternals.head(workspace)
    } catch (error) {
      failures.push({ attempt: attempt.id, role, error: error.message })
      if (review) await releaseReview({ ...options, review: review.id, reason: error.message })
      await transaction(context.root, (state) => { Object.assign(attemptOf(state, attempt.id), { status: 'blocked', reason: error.message }) })
      return
    }
    const id = randomUUID()
    const adapter = role === 'worker' && config.workers?.length ? config.workers[(slot - 1) % config.workers.length] : config.roles?.[role] ?? config
    const provider = adapter.provider ?? 'custom'
    const resume = role === 'worker' && current.session?.provider === provider && (current.resumes ?? 0) < MAX_RESUMES ? current.session.id : null
    const directive = role === 'worker' ? current.directive ?? null : null
    const job = { id, role, attempt: attempt.id, taskId: attempt.taskId, slot, review, expectedHead, provider, startedAt: Date.now(), workspace: review?.workspace ?? attempt.workspace, settled: false,
      sessionFile: role === 'worker' ? path.join(os.tmpdir(), `haeram-session-${id}`) : null }
    await transaction(context.root, (state) => {
      const entry = attemptOf(state, attempt.id)
      entry.dispatch = { id, runner: run.id, role, slot, provider, model: adapter.model ?? null, status: 'starting', pid: null, host: os.hostname(), startedAt: now() }
      if (role === 'worker') {
        entry.resumes = resume ? (entry.resumes ?? 0) + 1 : 0
        delete entry.directive
      }
    })
    jobs.set(id, job)
    dispatched += 1
    lastActivity = Date.now()
    const key = role === 'worker' ? `worker:${attempt.id}:${attempt.taskId}` : `reviewer:${attempt.id}`
    // Resuming after an answered decision is progress, not a retry; decisions have their own limit.
    if (!(directive && directive.kind !== 'timeout')) counts.set(key, (counts.get(key) ?? 0) + 1)
    const payload = { schemaVersion: 1, dispatchId: id, role, slot, provider: adapter.provider ?? 'custom', model: adapter.model ?? null, group: group.id, attempt: attempt.id,
      taskId: attempt.taskId, tasks: attempt.tasks ?? [attempt.taskId], lane: attempt.lane ?? null, workspace: job.workspace, groupBranch: group.branch,
      cliCommand: [process.execPath, fileURLToPath(new URL('../bin/haeram-spec-creator.mjs', import.meta.url))],
      boardCommand: ['work', 'board', '--work', group.id, '--json'],
      verify, taskVerify, review: review ?? null, correction: attempt.correction ?? null,
      mode: autopilot ? 'autopilot' : 'pair', resume, directive, sessionFile: job.sessionFile, allowTools: role === 'worker' ? liveGroup.allowTools ?? [] : [],
      brief: role === 'worker' ? await briefFor(context, liveGroup, current).catch(() => null) : null, risk: role === 'reviewer' ? current.risk ?? null : null,
      instruction: role === 'worker'
        ? 'Use implement-task. Implement only taskId (or fix review findings) in this workspace, run the checks this task adds or affects, check acceptance, fill result, and commit. Full suites run at unit integration. Return JSON {"outcome":"completed","summary":"..."}. The runner owns submit and dispatches the next lane task to this workspace; do not submit, integrate, or claim another task. For a blocker return {"outcome":"blocked","summary":"reason"}; when only a planning decision blocks you, add "decision":{"question":"...","options":["..."],"recommendation":"..."} and commit your partial work.'
        : 'Use review-task. Review the pinned commit against baseCommit, every task in tasks, and SSOT. Do not edit or commit. Return JSON {"verdict":"approved|changes_requested","summary":"...","findings":[{"priority":"P1|P2|P3","where":"file:line","message":"..."}]}. The runner owns review-finish.' }
    if (config.kind === 'builtin' && role === 'worker') payload.instruction = 'Use implement-task to edit and verify only taskId, running the checks this task adds or affects; full suites run at unit integration. Do not commit or submit; the host runner validates scope, commits, submits and dispatches the next lane task. Return JSON with outcome completed|blocked, summary and decision (empty unless a planning decision blocks you).'
    const child = spawn(adapter.command, adapter.args, { cwd: job.workspace, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: { ...(options.env ?? process.env), HAERAM_ROLE: role, HAERAM_ATTEMPT: attempt.id, HAERAM_DISPATCH: id } })
    job.child = child
    let output = '', stderr = '', overflow = false
    job.promise = new Promise((resolve) => {
      let completed = false
      const finish = (error) => { if (completed) return; completed = true; clearTimeout(timeout); job.settled = true; job.error = error; job.output = output; job.stderr = stderr; resolve(job) }
      const timeout = setTimeout(() => {
        job.timedOut = true
        // Snapshot first: the files an experiment wrote so far survive the kill.
        const saved = role === 'worker' ? checkpointWorkspace(job).catch(() => null) : Promise.resolve()
        saved.finally(() => { kill(job); setTimeout(() => { if (job.settled) return; try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL') } catch {} }, 2000).unref() })
      }, config.timeoutMs)
      child.stdout.on('data', (data) => { output += data; if (output.length > 1024 * 1024) { overflow = true; output = output.slice(0, 1024 * 1024); kill(job) } })
      child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-16000) })
      child.on('error', (error) => finish(error.message))
      child.on('close', (code, signal) => finish(job.timedOut ? 'adapter timeout' : overflow ? 'adapter output exceeded 1 MiB' : code === 0 ? null : `adapter exited ${code ?? signal}`))
      child.stdin.on('error', () => {})
      child.stdin.end(`${JSON.stringify(payload)}\n`)
    })
    await transaction(context.root, (state) => {
      const dispatch = attemptOf(state, attempt.id).dispatch
      if (dispatch.id !== id) fail('dispatch ownership changed')
      Object.assign(dispatch, { pid: child.pid ?? null, status: child.pid ? 'running' : 'failed' })
    })
  }

  // A worker that needs a planning decision files it and frees its slot; its partial work
  // is committed so the resumed session continues from it.
  const fileDecision = async (job, result) => {
    const live = attemptOf(await readRuntime(context.root), job.attempt)
    if ((live.decisions ?? 0) >= MAX_DECISIONS) fail(`결정 요청 한도(${MAX_DECISIONS})를 넘었습니다 — 태스크를 다시 분해해야 합니다: ${result.decision.question}`)
    if (config.kind === 'builtin') await commitProgress(job.workspace, `WIP ${job.taskId}: waiting for a planning decision`)
    await transaction(context.root, (state) => {
      const entry = attemptOf(state, job.attempt)
      Object.assign(entry, { status: 'blocked', reason: `decision: ${result.decision.question}`, decision: { ...result.decision, summary: result.summary, at: now() }, decisions: (entry.decisions ?? 0) + 1 })
    })
    decisions.push({ attempt: job.attempt, taskId: job.taskId, question: result.decision.question })
  }

  const settle = async (job) => {
    lastActivity = Date.now()
    if (job.sessionFile) {
      const session = (await readFile(job.sessionFile, 'utf8').catch(() => '')).trim()
      await rm(job.sessionFile, { force: true })
      if (session) await transaction(context.root, (state) => { attemptOf(state, job.attempt).session = { id: session, provider: job.provider } })
    }
    try {
      if (job.error) fail(job.error, [job.stderr])
      const result = JSON.parse(job.output)
      job.summary = result.summary ?? null
      if (job.role === 'reviewer') await finishReview({ ...options, review: job.review.id, result })
      else {
        if (result.outcome !== 'completed' && result.decision?.question) return await fileDecision(job, result)
        if (result.outcome !== 'completed') fail(result.summary || 'worker did not complete')
        if (config.kind === 'builtin') await commitWorkerWork({ ...options, attempt: job.attempt, expectedHead: job.expectedHead, signal: abort.signal })
        await submitWork({ ...options, attempt: job.attempt, verify: taskVerify, signal: abort.signal })
      }
    } catch (error) {
      job.resultError = error.message
      failures.push({ attempt: job.attempt, role: job.role, error: error.message })
      if (job.role === 'reviewer') {
        await releaseReview({ ...options, review: job.review.id, reason: error.message }).catch(() => {})
      } else {
        await transaction(context.root, (state) => {
          const entry = attemptOf(state, job.attempt)
          if (['doing', 'blocked'].includes(entry.status)) Object.assign(entry, { status: 'blocked', reason: error.message })
        })
        // Out of time, unattended: keep what was done as a commit and continue it in the same
        // session. Attended runs leave the workspace as it is for a person to inspect (the
        // pre-kill snapshot ref holds its files either way).
        if (job.timedOut && config.kind === 'builtin' && autopilot) {
          try {
            const commit = await commitProgress(job.workspace, `WIP ${job.taskId}: checkpoint after the time limit`)
            await transaction(context.root, (state) => {
              const entry = attemptOf(state, job.attempt)
              if (entry.status !== 'blocked') return
              entry.checkpoint = commit
              Object.assign(entry, { status: 'doing', reason: null, directive: { kind: 'timeout', at: now(),
                note: `The run reached its time limit. Your work so far is committed as ${commit}. Continue from it, and record measurements in result as you go.` } })
            })
          } catch {}
        }
      }
    } finally {
      await transaction(context.root, (state) => {
        const entry = attemptOf(state, job.attempt)
        if (entry.dispatch?.id === job.id) Object.assign(entry.dispatch, { status: 'finished', finishedAt: now(), error: job.resultError ?? job.error ?? null, summary: job.summary ?? null, stderr: job.stderr })
      })
      jobs.delete(job.id)
    }
  }

  try {
    while (!stopping) {
      for (const job of [...jobs.values()]) if (job.settled) await settle(job)
      if (stopping) break
      let state = await readRuntime(context.root)
      const entries = () => Object.values(state.attempts).filter((entry) => entry.group === group.id)
      const approved = entries().find((entry) => entry.status === 'approved' && !integrationFailures.has(integrationKey(entry)))
      if (approved && !groupOf(state, group.id).operation) {
        await recordDecisionWait([])
        const key = integrationKey(approved)
        try { await integrateWork({ ...options, attempt: approved.id, verify, signal: abort.signal }) } catch (error) {
          const current = (await readRuntime(context.root)).attempts[approved.id]
          // A planning commit or another landing can move the branch mid-check: try again a few times.
          const transient = (error.details ?? []).some((detail) => /이동했습니다|미커밋·미추적|기획 공간의 HEAD/.test(String(detail)))
          const tries = (integrationTries.get(key) ?? 0) + 1
          integrationTries.set(key, tries)
          if (current.status !== 'ready' && (current.status !== 'approved' || !transient || tries >= 3)) {
            integrationFailures.add(key)
            failures.push({ attempt: approved.id, submissionId: approved.submissionId, commit: approved.verifiedCommit, role: 'integration', error: error.message })
          }
          else if (current.status === 'approved') await sleep(pollMs)
        }
        continue
      }
      if (dispatched < config.maxDispatches) {
        for (let slot = 1; slot <= limits.workers && !stopping && dispatched < config.maxDispatches; slot += 1) {
          if ([...jobs.values()].some((job) => job.role === 'worker' && job.slot === slot)) continue
          const owner = `${run.id}/worker-${slot}`
          // A submitted lane step leaves the attempt doing with its next task in the same workspace.
          // A lane left between tasks by an earlier, finished runner is adopted the same way.
          let attempt = entries().find((entry) => entry.status === 'doing' && ![...jobs.values()].some((job) => job.attempt === entry.id) &&
            (entry.owner === owner || orphaned(entry)))
          if (attempt && attempt.owner !== owner) attempt = await adopt(attempt, owner)
          attempt ??= await resumeWork({ ...options, owner })
          if (attempt.idle) attempt = await claimNextWork({ ...options, owner, workspace: 'new' })
          if (attempt.idle) continue
          if ((counts.get(`worker:${attempt.id}:${attempt.taskId}`) ?? 0) >= config.maxTaskRuns) {
            await transaction(context.root, (live) => { Object.assign(attemptOf(live, attempt.id), { status: 'blocked', reason: 'worker retry limit; inspect review findings' }) })
            failures.push({ attempt: attempt.id, error: 'worker retry limit' }); continue
          }
          await launch('worker', attempt, slot)
        }
        for (let slot = 1; slot <= limits.reviewers && !stopping && dispatched < config.maxDispatches; slot += 1) {
          if ([...jobs.values()].some((job) => job.role === 'reviewer' && job.slot === slot)) continue
          let review
          try { review = await claimReview({ ...options, owner: `${run.id}/reviewer-${slot}` }) } catch (error) { failures.push({ role: 'reviewer', error: error.message }); continue }
          if (review.idle) continue
          if ((counts.get(`reviewer:${review.attempt}`) ?? 0) >= config.maxTaskRuns) {
            await releaseReview({ ...options, review: review.id, reason: 'review retry limit' })
            await transaction(context.root, (live) => { Object.assign(attemptOf(live, review.attempt), { status: 'blocked', reason: 'review retry limit; inspect submission' }) })
            failures.push({ attempt: review.attempt, error: 'review retry limit' }); continue
          }
          state = await readRuntime(context.root)
          await launch('reviewer', attemptOf(state, review.attempt), slot, review)
        }
      }
      if (!jobs.size) {
        state = await readRuntime(context.root)
        const pendingIntegrations = entries().filter((entry) => entry.status === 'approved')
        // A coordinator may have resubmitted while slots were being filled. Try the fresh
        // submission first; a failed submission cannot make progress by waiting for a decision.
        if (pendingIntegrations.length) {
          await recordDecisionWait([])
          if (!groupOf(state, group.id).operation && pendingIntegrations.some((entry) => !integrationFailures.has(integrationKey(entry)))) continue
          integrationStalled = true
          break
        }
        // Unattended, a filed decision is answered by the coordinator: wait for it instead of ending.
        const waiting = entries().filter((entry) => entry.status === 'blocked' && entry.decision && !entry.decision.answeredAt)
          .map((entry) => ({ attempt: entry.id, taskId: entry.taskId, question: entry.decision.question, requestedAt: entry.decision.at }))
        if (!autopilot || !waiting.length || stopping) break
        await recordDecisionWait(waiting)
        if (Date.now() - lastActivity > decisionWaitMs) { decisionTimedOut = true; break }
        await sleep(pollMs)
        continue
      }
      await Promise.race([...jobs.values()].map((job) => job.promise))
    }
  } finally {
    for (const job of jobs.values()) kill(job)
    clearInterval(timer)
    await heartbeat
    await checkpoints
    if (awake?.pid) try { process.kill(awake.pid) } catch {}
    // Terminate only children created by this runner. Claims and files remain inspectable.
    const forced = setTimeout(() => { for (const job of jobs.values()) if (!job.settled) { try { if (process.platform === 'win32') job.child.kill('SIGKILL'); else process.kill(-job.child.pid, 'SIGKILL') } catch {} } }, 2000)
    await Promise.all([...jobs.values()].map((job) => job.promise))
    clearTimeout(forced)
    for (const job of [...jobs.values()]) { job.error ??= 'runner stopped before accepting result'; await settle(job) }
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
    let finalBoard = await workBoard(options).catch(() => null)
    if (groupVerify.length && !interrupted && !heartbeatError && finalBoard && !finalBoard.tasks.some((task) => !task.st?.startsWith('blocked@') && !task.mainSession) &&
        !finalBoard.attempts.some(activeAttempt)) {
      try { finish = (await finishWork({ ...options, verify: groupVerify, runnerId: run.id, signal: abort.signal })).verified } catch (error) {
        finishError = error.message
        failures.push({ role: 'finish', error: error.message, details: error.details ?? [] })
      }
      finalBoard = await workBoard(options).catch(() => null)
    }
    // Every child has stopped: integrated units no longer need their workspace or branch (prune-branches).
    // This runs while the runner record still holds the group, so no session reads a unit mid-cleanup
    // as live work. The group itself stays for the coordinator; vibe prune closes it at session end.
    try { pruned = await pruneWork({ ...options, work: group.id }) } catch (error) { pruneError = error.message }
    await transaction(context.root, (state) => {
      const current = groupOf(state, group.id)
      if (current.runner?.id === run.id) { current.lastRun = { ...run, stoppedAt: now(), dispatched, failures, outcome: finalBoard ? outcomeFor(finalBoard) : 'needs-attention' }; delete current.runner }
    })
    try { snapshot = await syncWork(options) } catch (error) { snapshotError = error.message; failures.push({ role: 'snapshot', error: error.message, details: error.details ?? [] }) }
  }
  const board = await workBoard(options)
  const status = await inspectWork(options)
  const attempts = status.attempts.filter((entry) => entry.group === group.id)
  return { schemaVersion: 1, run: run.id, dispatched, failures, decisions, heartbeatError, snapshot, snapshotError, finish, finishError, pruned, pruneError, summary: board.summary,
    outcome: outcomeFor(board),
    remaining: board.tasks.map(({ id, waitingOn, runtimeStatus, attempt }) => ({ id, waitingOn, runtimeStatus, attempt: attempt?.id ?? null })),
    attempts: attempts.map(({ id, taskId, status, reason }) => ({ id, taskId, status, reason })) }
}
