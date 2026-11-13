import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeSync } from 'node:fs'
import path from 'node:path'
import { inspectWorkspace, git } from './workspace.mjs'
import { runtimeRoot, readRuntime } from './work-runtime.mjs'
import { workingTree, commitTree, checkKey, cachedPass, recordPass, withHeavyLock, recordTiming, timingKey } from './check-cache.mjs'
import { SkillPackageError } from './errors.mjs'
import { sections, tableRows, SESSION_TAG } from './spec-format.mjs'
import { readVerification } from './vibe-brief.mjs'
import { delegatedCheckout } from './work-policy.mjs'
import { GATE_CAP, gateKey, gateCount, gateView, readGates, recordGateRun, resetGate } from './gate-ledger.mjs'
import { readVerificationPlan, fingerprintVerificationCheck } from './verification-plan.mjs'

// A task check is the affected unit tests: minutes, not the suite. Longer runs are flagged.
export const TASK_SLOW_MS = 5 * 60000
const normalized = (command) => command.trim().replace(/\s+/g, ' ')
const park = (tag) => `vibe inbox add --kind parked${tag ? ` --tag ${tag}` : ''} --text "<remaining gate failures with their log paths>"`
const OUTSIDE = 'A problem found outside this failure is not fixed now: put it in the report limits and vibe inbox add --kind suggest.'

// What a failed full gate leaves the coordinator: the failed command as run (its inner steps are
// the project's, so only the log can name one), the narrow re-check, and the rounds left.
function failureNext(result, command, gate, tag) {
  const what = result.stale ? 'Code or HEAD changed while the gate ran, so it verified nothing: commit the candidate first and change nothing while a gate runs.'
    : result.timedOut ? `Timed out: ${command}. Log: ${result.log}`
    : result.failedTests.length ? `Failed (exit ${result.exitCode}): ${command}. Failing lines: failedTests. Log: ${result.log}`
    : `Failed (exit ${result.exitCode}): ${command}. No failing step identified; read the log: ${result.log}`
  if (!gate.left) return [what, `Gate cap reached (${gate.failures}/${gate.cap} rounds failed): do not run the full gate again. Record the remaining failures in the report and park them in one call: ${park(tag)}; then stop.`, OUTSIDE]
  return [what, `Fix only what failed and confirm it first with vibe check --tier task --diff-base ${result.commit} -- <the affected tests>; reproduce a build or e2e failure with --heavy, one run at a time and never alongside another check.`,
    result.plan ? `Resume vibe check --tier ${result.scope.TIER} --plan ${JSON.stringify(result.plan.source)}${tag ? ` --tag ${tag}` : ''}; unchanged successful checks are reused. ${gate.left} failed round(s) left of ${gate.cap}.`
      : `Then run the full gate once more: ${gate.left} failed round(s) left of ${gate.cap}.`, OUTSIDE]
}

function sessionTag(options) {
  const tag = options.tag ?? options.env?.GUSTA_VIBE_TAG ?? process.env.GUSTA_VIBE_TAG
  if (tag !== undefined && !SESSION_TAG.test(tag)) throw new SkillPackageError('--tag에는 영숫자 2-8자의 세션 tag가 필요합니다.')
  return tag
}

// The person's way to lift the cap after deciding what to do; unattended instructions never use it.
export async function resetVibeGate(options = {}, command) {
  if (command?.trim()) throw new SkillPackageError('--reset-gate는 검사 명령 없이 씁니다: vibe check --reset-gate [--tag <tag>]')
  const workspace = await inspectWorkspace(options)
  if (!workspace.git) throw new SkillPackageError('Git checkout이 필요합니다.')
  const key = gateKey({ tag: sessionTag(options), branch: workspace.git.branch, root: workspace.git.root })
  const previous = await resetGate(runtimeRoot(workspace), key)
  return { schemaVersion: 1, ok: true, exitCode: 0, reset: key, previous: { attempts: previous.attempts, failures: previous.failures, cap: GATE_CAP } }
}

export async function runVibeCheck(options = {}, command) {
  if (options.plan && command?.trim()) throw new SkillPackageError('--plan과 별도 검사 명령을 함께 쓰지 않습니다.')
  const workspace = await inspectWorkspace(options)
  if (!workspace.git?.head) throw new SkillPackageError('커밋이 있는 Git checkout이 필요합니다.')
  const root = workspace.git.root, runtime = runtimeRoot(workspace)
  const plan = options.plan ? await readVerificationPlan(root, options.plan) : !command?.trim() ? (await readVerification(root)).plan : null
  if (!plan && !command?.trim()) throw new SkillPackageError('vibe check [--plan <file>] [--tier task|batch] 또는 vibe check -- <command>')
  const saved = await readFile(path.join(workspace.git.gitDir, 'gusta-task-start.json'), 'utf8').then(JSON.parse).catch(() => null)
  const state = await readFile(path.join(root, 'spec/STATE.md'), 'utf8').catch(() => '')
  const stillActive = saved && tableRows(sections(state).get('tasks')).some(([id]) => id === saved.task)
  const taskStart = saved && (options.task === saved.task || (!options.task && stillActive)) ? saved : null
  const scope = { TIER: options.tier ?? options.env?.GUSTA_TIER ?? process.env.GUSTA_TIER ?? 'task', DIFF_BASE: options.diffBase ?? options.env?.GUSTA_DIFF_BASE ?? process.env.GUSTA_DIFF_BASE ?? taskStart?.diffBase ?? workspace.git.head,
    TASK: options.task ?? options.env?.GUSTA_TASK ?? process.env.GUSTA_TASK ?? taskStart?.task ?? '', TASKS: options.task ?? options.env?.GUSTA_TASKS ?? process.env.GUSTA_TASKS ?? taskStart?.task ?? '' }
  if (!['task', 'batch', 'unit', 'group', 'ci'].includes(scope.TIER)) throw new SkillPackageError('지원하지 않는 검증 tier입니다.')
  if (plan && !['task', 'batch'].includes(scope.TIER)) throw new SkillPackageError('검사 계획은 로컬 task 또는 batch 단계에서 실행합니다. CI 항목은 원격 검증용입니다.')
  const checks = plan ? plan.checks.filter((check) => check.tier === scope.TIER) : [{ command }]
  if (!checks.length) throw new SkillPackageError(`검사 계획에 ${scope.TIER} 단계의 검사가 없습니다.`)
  const label = plan ? `verification-plan:${plan.source}#${scope.TIER}` : command
  const env = { ...process.env, ...options.env, ...Object.fromEntries(Object.entries(scope).map(([key, value]) => [`GUSTA_${key}`, value])) }
  const final = ['batch', 'group'].includes(scope.TIER)
  // Every full gate counts against its session's cap (gate-ledger.mjs). The loop host passes
  // 'record' — it stops on its own counter — and design verification, a run the person asked for, false.
  const tag = final ? sessionTag(options) : undefined
  const ledger = final && options.gateLedger !== false ? gateKey({ tag, branch: workspace.git.branch, root }) : null
  if (final && !options.allowFinal) {
    const delegated = (options.env?.GUSTA_VIBE_UNIT ?? process.env.GUSTA_VIBE_UNIT) === '1' || delegatedCheckout(await readRuntime(runtime), root)
    if (delegated) throw new SkillPackageError('최종 검증은 조정자/호스트가 실행합니다. 워커·리뷰어는 태스크 검사만 실행하세요. 사용자가 별도 실행을 명시한 경우만 --allow-final을 사용하세요.')
  }
  // The full suite at every task is what turns ten tasks into hours of waiting.
  if (!plan && scope.TIER === 'task' && !options.allowFinal) {
    const verify = await readVerification(root), same = (entry) => normalized(entry) === normalized(command)
    if (verify.batch.some(same) && !verify.task.some(same)) throw new SkillPackageError('ARCH batch(최종 관문) 명령은 태스크 단계에서 실행하지 않습니다. 변경 영향 단위 테스트($GUSTA_DIFF_BASE 기준)와 빠른 검사만 실행하세요. 전체 스위트는 조정자가 push 직전 --tier batch로 한 번 실행합니다. 사용자가 별도 실행을 명시한 경우만 --allow-final.', [command])
  }
  await git(root, ['rev-parse', '--verify', `${scope.DIFF_BASE}^{commit}`])
  const timeout = Number(options.timeoutMs ?? 3600000)
  if (!Number.isFinite(timeout) || timeout <= 0) throw new SkillPackageError('--timeout-ms는 양수입니다.')
  const perform = async () => {
    const commit = (await git(root, ['rev-parse', 'HEAD'])).trim()
    const tree = await workingTree(root)
    // Design verification (vibe design verify) checks the uncommitted design before its one commit.
    if (final && !options.uncommitted && tree !== await commitTree(root, commit)) throw new SkillPackageError('최종 검증 전에 작업 트리를 커밋하세요. 조정자는 고정된 통합 결과를 검증합니다.')
    const prepared = []
    for (const check of checks) {
      // A plan's declared inputs are a cache boundary, never a blanket exclusion of docs/spec.
      // Legacy commands retain their conservative whole-tree identity.
      const identity = plan ? await fingerprintVerificationCheck(root, plan, check, { scope, env })
        : { key: `${checkKey(tree, check.command, scope)}\u0000${JSON.stringify(scope)}` }
      prepared.push({ check, identity, hit: !options.noCache && await cachedPass(runtime, identity.key) })
    }
    const counted = ledger ? gateCount((await readGates(runtime)).entries[ledger]) : null
    // A cache hit runs nothing, so it is not an attempt and is never refused.
    const allCached = prepared.every(({ hit }) => hit)
    if (!allCached && ledger && options.gateLedger !== 'record' && counted.failures >= GATE_CAP) {
      return { schemaVersion: 1, ok: false, exitCode: 1, cached: false, refused: 'gate-cap', key: ledger, attempts: counted.attempts, failures: counted.failures, cap: GATE_CAP, scope, commit, tree,
        ...(plan ? { plan: { source: plan.source, checks: checks.map(({ id }) => id) }, checks: prepared.map(({ check, hit }) => ({ id: check.id, command: check.command, status: hit ? 'cached' : 'not-run', ok: Boolean(hit), cached: Boolean(hit) })), failureSetComplete: false } : {}),
        lastFailure: counted.last ? { commit: counted.last.commit, failed: counted.last.commands.filter((step) => !step.ok) } : null,
        next: [`${counted.failures} of ${GATE_CAP} full-gate rounds failed for ${ledger}; this run was refused and the command did not run.`, `Record the remaining failures in the report and park them in one call: ${park(tag)}; then stop.`] }
    }
    const directory = path.join(runtime, 'logs')
    await mkdir(directory, { recursive: true })
    const start = Date.now()
    const results = []
    const observed = new Map()
    let stopped = null
    for (const preparedCheck of prepared) {
      const { check } = preparedCheck
      if (stopped || options.signal?.aborted) {
        const identity = preparedCheck.identity
        results.push({ ...(plan ? { id: check.id, command: check.command, inputs: identity.inputs, inputFingerprint: identity.inputFingerprint, executionFingerprint: identity.executionFingerprint } : {}),
          ok: false, status: 'not-run', cached: false, cancelled: options.signal?.aborted ?? false, reason: stopped ?? 'cancelled' })
        continue
      }
      // An earlier check may generate files another check consumes. Consult the current input
      // boundary at execution time instead of reusing a hit prepared before that generator ran.
      const identity = plan ? await fingerprintVerificationCheck(root, plan, check, { scope, env }) : preparedCheck.identity
      const hit = plan ? !options.noCache && await cachedPass(runtime, identity.key) : preparedCheck.hit
      const metadata = plan ? { id: check.id, command: check.command, inputs: identity.inputs, inputFingerprint: identity.inputFingerprint, executionFingerprint: identity.executionFingerprint } : {}
      if (hit) {
        if (plan) observed.set(check.id, identity.key)
        results.push({ ...metadata, ok: true, status: 'cached', exitCode: 0, cached: true, log: hit.log ?? null, tail: [], failedTests: [], ms: 0 })
        continue
      }
      if (ledger && options.gateLedger !== 'record' && counted.failures >= GATE_CAP) {
        stopped = 'gate-cap'
        results.push({ ...metadata, ok: false, status: 'not-run', cached: false, reason: stopped })
        continue
      }
      const remaining = timeout - (Date.now() - start)
      if (remaining <= 0) {
        stopped = 'timeout'
        results.push({ ...metadata, ok: false, status: 'not-run', cached: false, timedOut: true, reason: stopped })
        continue
      }
      const log = path.join(directory, `check-${randomUUID()}.log`), stepStart = Date.now()
      const ran = await executeCheck({ command: check.command, root, env, timeout: remaining, signal: options.signal, log })
      const ms = Date.now() - stepStart
      const stepCancelled = ran.cancelled || Boolean(options.signal?.aborted), inspect = !stepCancelled && !ran.timedOut
      const sameTree = inspect && await workingTree(root) === tree && (!final || (await git(root, ['rev-parse', 'HEAD'])).trim() === commit)
      const current = plan && inspect ? await fingerprintVerificationCheck(root, plan, check, { scope, env }) : null
      const sameInputs = plan ? inspect && identity.key === current.key : sameTree
      const stale = inspect && (final ? !sameTree : Boolean(plan && !sameInputs))
      const ok = ran.code === 0 && !stale && !stepCancelled && !ran.timedOut
      if (plan && ok) observed.set(check.id, identity.key)
      if (ok && sameInputs && (!final || sameTree)) await recordPass(runtime, identity.key, { command: check.command, ...(plan ? { id: check.id, inputs: identity.inputs, inputFingerprint: identity.inputFingerprint, executionFingerprint: identity.executionFingerprint } : {}), tree, scope, log, ms })
      if ((final || scope.TIER === 'task') && !stepCancelled && !ran.timedOut) await recordTiming(runtime, timingKey(final ? 'final' : 'task', check.command), ms)
      const slow = scope.TIER === 'task' && ms > TASK_SLOW_MS
      results.push({ ...metadata, ok, status: ok ? 'passed' : 'failed', exitCode: stale || stepCancelled ? ran.code || 1 : ran.code, cached: false, timedOut: ran.timedOut, cancelled: stepCancelled, stale, ms, log,
        failedTests: ran.failedTests, tail: ran.tail, cleanup: ran.cleanup,
        ...(slow ? { slow: true, hint: 'task check exceeded 5 min: run only the unit tests affected since GUSTA_DIFF_BASE; move integration/e2e/full suites to the batch gate.' } : {}) })
      if (stepCancelled || ran.timedOut || stale) stopped = stepCancelled ? 'cancelled' : ran.timedOut ? 'timeout' : 'stale'
    }
    // Later generators cannot leave earlier successes attesting to an input that no longer
    // exists. The old pass remains reusable only if that exact input returns in a future run.
    if (plan && !stopped && !options.signal?.aborted) for (const check of checks) {
      if (!observed.has(check.id)) continue
      const current = await fingerprintVerificationCheck(root, plan, check, { scope, env })
      if (current.key !== observed.get(check.id)) Object.assign(results.find((entry) => entry.id === check.id), { ok: false, status: 'failed', stale: true, exitCode: 1 })
    }
    if (plan && !stopped && !options.signal?.aborted) {
      // A task command can change the plan itself without touching any declared code input.
      // Its receipt belongs to the selected immutable definitions, not whatever replaced them.
      let currentPlan
      try { currentPlan = options.plan ? await readVerificationPlan(root, options.plan) : (await readVerification(root)).plan } catch {}
      if (!currentPlan || currentPlan.source !== plan.source || JSON.stringify(currentPlan.checks.filter((check) => check.tier === scope.TIER)) !== JSON.stringify(checks)) {
        Object.assign(results.at(-1), { ok: false, status: 'failed', stale: true, reason: 'plan-changed', exitCode: 1 })
      }
    }
    // Cache-only rounds still attest to the fixed candidate, even if another writer changed it
    // between the first snapshot and the last per-check lookup.
    const candidateChanged = final && !stopped && !options.signal?.aborted && (await workingTree(root) !== tree || (await git(root, ['rev-parse', 'HEAD'])).trim() !== commit)
    if (candidateChanged && !results.some((entry) => entry.stale)) Object.assign(results.at(-1), { ok: false, status: 'failed', stale: true, exitCode: 1 })
    const first = results.find((entry) => !entry.ok) ?? results[0]
    const cancelled = Boolean(options.signal?.aborted) || results.some((entry) => entry.cancelled), timedOut = results.some((entry) => entry.timedOut), stale = results.some((entry) => entry.stale)
    const ok = !cancelled && results.every((entry) => entry.ok), ms = Date.now() - start
    const result = { schemaVersion: 1, ok, exitCode: ok ? 0 : first.exitCode || 1, cached: results.every((entry) => entry.cached), timedOut, cancelled, stale, ms, scope, commit, tree,
      log: first.log ?? null, tail: first.tail ?? [], failedTests: results.flatMap((entry) => entry.failedTests ?? []).slice(0, 20),
      failureSetComplete: Boolean(plan && !cancelled && !timedOut && !stale && results.every((entry) => ['passed', 'failed', 'cached'].includes(entry.status))),
      ...(plan ? { plan: { source: plan.source, checks: checks.map(({ id }) => id) }, checks: results, failedCheckIds: results.filter((entry) => entry.status === 'failed').map(({ id }) => id) } : {}),
      ...(stopped === 'gate-cap' ? { refused: 'gate-cap', key: ledger, attempts: counted.attempts, failures: counted.failures, cap: GATE_CAP } : {}),
      ...(first.slow ? { slow: true, hint: first.hint } : {}), ...(first.cleanup ? { cleanup: first.cleanup } : {}) }
    // A run stopped from outside verified nothing and is not charged.
    if (!ledger || cancelled || stopped === 'gate-cap') return result
    const gate = gateView(ledger, allCached ? counted : await recordGateRun(runtime, ledger, { tree, commit, command: label, ok: result.ok, log: result.log }))
    // The loop reports its own counter and queues its own repair.
    if (options.gateLedger === 'record') return result
    return { ...result, gate, ...(result.ok ? {} : { next: failureNext(result, label, gate, tag) }) }
  }
  // Read the tree and cache only after acquiring the lock: a second caller reuses
  // the first caller's receipt instead of queuing a duplicate browser run.
  const result = final || options.heavy ? await withHeavyLock(runtime, label, perform, { timeoutMs: timeout, signal: options.signal }) : await perform()
  // Inside a loop unit the host hands each session its own ledger, so the unit's time
  // breakdown separates check time from model time.
  if (process.env.GUSTA_CHECK_LOG) await appendFile(process.env.GUSTA_CHECK_LOG, `${JSON.stringify({ tier: scope.TIER, command: label, ms: result.ms ?? 0, cached: result.cached, ok: result.ok })}\n`).catch(() => {})
  return result
}

// The shell and every child it leaves in the owned group share one lifecycle. A shell's exit
// does not prove its background children exited; clean the group on success and failure too.
async function executeCheck({ command, root, env, timeout, signal, log }) {
  const file = await open(log, 'w', 0o600)
  let tail = '', partial = '', failedTests = new Set()
  const collect = (chunk) => {
    writeSync(file.fd, chunk)
    const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '')
    tail = (tail + text).slice(-4000)
    const lines = (partial + text).split('\n'); partial = lines.pop().slice(-1000)
    for (const line of lines) if (/^\s*(?:FAIL\b|FAILED\b|✕|×|not ok\b|\d+\)\s*\[)/.test(line) && failedTests.size < 20) failedTests.add(line.trim().slice(0, 250))
  }
  try {
    return await new Promise((resolve) => {
      const child = spawn(command, { cwd: root, shell: true, detached: process.platform !== 'win32', env, stdio: ['ignore', 'pipe', 'pipe'] })
      let timedOut = false, cancelled = false, forced, finished = false
      const cleanup = { scope: process.platform === 'win32' ? 'process' : 'process-group', signalled: false, escalated: false }
      const kill = (name) => {
        try {
          const sent = process.platform === 'win32' ? child.kill(name) : (process.kill(-child.pid, name), true)
          if (sent) { cleanup.signalled = true; if (name === 'SIGKILL') cleanup.escalated = true }
        } catch {}
      }
      const clean = () => { if (!finished) { kill('SIGTERM'); forced ??= setTimeout(() => kill('SIGKILL'), 2000) } }
      const stop = () => { cancelled = true; clean() }
      const timer = setTimeout(() => { timedOut = true; clean() }, timeout)
      process.on('SIGINT', stop); process.on('SIGTERM', stop)
      signal?.addEventListener('abort', stop, { once: true })
      if (signal?.aborted) stop()
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      child.on('exit', clean)
      const finish = (code) => {
        if (finished) return
        finished = true
        kill('SIGKILL')
        clearTimeout(timer); clearTimeout(forced)
        process.off('SIGINT', stop); process.off('SIGTERM', stop); signal?.removeEventListener('abort', stop)
        resolve({ code: cancelled || timedOut ? code || 1 : code, timedOut, cancelled, cleanup, failedTests: [...failedTests], tail: tail.trimEnd().split('\n').slice(-8) })
      }
      child.on('error', () => finish(127))
      child.on('close', (code) => finish(code ?? 1))
    })
  } finally { await file.close() }
}
