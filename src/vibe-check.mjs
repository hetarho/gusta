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
    `Then run the full gate once more: ${gate.left} failed round(s) left of ${gate.cap}.`, OUTSIDE]
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
  if (!command?.trim()) throw new SkillPackageError('vibe check -- <command>')
  const workspace = await inspectWorkspace(options)
  if (!workspace.git?.head) throw new SkillPackageError('커밋이 있는 Git checkout이 필요합니다.')
  const root = workspace.git.root, runtime = runtimeRoot(workspace)
  const saved = await readFile(path.join(workspace.git.gitDir, 'gusta-task-start.json'), 'utf8').then(JSON.parse).catch(() => null)
  const state = await readFile(path.join(root, 'spec/STATE.md'), 'utf8').catch(() => '')
  const stillActive = saved && tableRows(sections(state).get('tasks')).some(([id]) => id === saved.task)
  const taskStart = saved && (options.task === saved.task || (!options.task && stillActive)) ? saved : null
  const scope = { TIER: options.tier ?? process.env.GUSTA_TIER ?? 'task', DIFF_BASE: options.diffBase ?? process.env.GUSTA_DIFF_BASE ?? taskStart?.diffBase ?? workspace.git.head,
    TASK: options.task ?? process.env.GUSTA_TASK ?? taskStart?.task ?? '', TASKS: options.task ?? process.env.GUSTA_TASKS ?? taskStart?.task ?? '' }
  if (!['task', 'batch', 'unit', 'group', 'ci'].includes(scope.TIER)) throw new SkillPackageError('지원하지 않는 검증 tier입니다.')
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
  if (scope.TIER === 'task' && !options.allowFinal) {
    const verify = await readVerification(root), same = (entry) => normalized(entry) === normalized(command)
    if (verify.batch.some(same) && !verify.task.some(same)) throw new SkillPackageError('ARCH batch(최종 관문) 명령은 태스크 단계에서 실행하지 않습니다. 변경 영향 단위 테스트($GUSTA_DIFF_BASE 기준)와 빠른 검사만 실행하세요. 전체 스위트는 조정자가 push 직전 --tier batch로 한 번 실행합니다. 사용자가 별도 실행을 명시한 경우만 --allow-final.', [command])
  }
  await git(root, ['rev-parse', '--verify', `${scope.DIFF_BASE}^{commit}`])
  const timeout = Number(options.timeoutMs ?? 3600000)
  if (!Number.isFinite(timeout) || timeout <= 0) throw new SkillPackageError('--timeout-ms는 양수입니다.')
  const perform = async () => {
    const commit = (await git(root, ['rev-parse', 'HEAD'])).trim()
    // A script may read GUSTA_* internally even if its invocation does not name
    // them. Standalone cache identity always includes the effective scope.
    const tree = await workingTree(root), key = `${checkKey(tree, command, scope)}\u0000${JSON.stringify(scope)}`
    // Design verification (vibe design verify) checks the uncommitted design before its one commit.
    if (final && !options.uncommitted && tree !== await commitTree(root, commit)) throw new SkillPackageError('최종 검증 전에 작업 트리를 커밋하세요. 조정자는 고정된 통합 결과를 검증합니다.')
    const hit = !options.noCache && await cachedPass(runtime, key)
    const counted = ledger ? gateCount((await readGates(runtime)).entries[ledger]) : null
    // A cache hit runs nothing, so it is not an attempt and is never refused.
    if (hit) return { schemaVersion: 1, ok: true, exitCode: 0, cached: true, scope, commit, tree, log: hit.log ?? null, tail: [], failedTests: [], ...(ledger ? { gate: gateView(ledger, counted) } : {}) }
    if (ledger && options.gateLedger !== 'record' && counted.failures >= GATE_CAP) {
      return { schemaVersion: 1, ok: false, exitCode: 1, cached: false, refused: 'gate-cap', key: ledger, attempts: counted.attempts, failures: counted.failures, cap: GATE_CAP, scope, commit, tree,
        lastFailure: counted.last ? { commit: counted.last.commit, failed: counted.last.commands.filter((step) => !step.ok) } : null,
        next: [`${counted.failures} of ${GATE_CAP} full-gate rounds failed for ${ledger}; this run was refused and the command did not run.`, `Record the remaining failures in the report and park them in one call: ${park(tag)}; then stop.`] }
    }
    const directory = path.join(runtime, 'logs')
    await mkdir(directory, { recursive: true })
    const log = path.join(directory, `check-${randomUUID()}.log`)
    let tail = '', failedTests = new Set(), partial = ''
    const collect = (chunk) => {
      const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '')
      tail = (tail + text).slice(-4000)
      const lines = (partial + text).split('\n'); partial = lines.pop().slice(-1000)
      for (const line of lines) if (/^\s*(?:FAIL\b|FAILED\b|✕|×|not ok\b|\d+\)\s*\[)/.test(line)) {
        if (failedTests.size < 20) failedTests.add(line.trim().slice(0, 250))
      }
    }
    const run = async () => {
      const file = await open(log, 'w', 0o600)
      try {
        return await new Promise((resolve) => {
          const child = spawn(command, { cwd: root, shell: true, detached: process.platform !== 'win32', env: { ...process.env, ...options.env, ...Object.fromEntries(Object.entries(scope).map(([key, value]) => [`GUSTA_${key}`, value])) }, stdio: ['ignore', 'pipe', 'pipe'] })
          let timedOut = false, interrupted = false, forced
          const kill = (signal) => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal) } catch {} }
          const stop = () => { interrupted = true; kill('SIGTERM'); forced ??= setTimeout(() => kill('SIGKILL'), 2000) }
          const timer = setTimeout(() => { timedOut = true; stop() }, timeout)
          process.on('SIGINT', stop); process.on('SIGTERM', stop)
          options.signal?.addEventListener('abort', stop, { once: true })
          if (options.signal?.aborted) stop()
          // File writes are synchronous OS descriptors; only a bounded tail stays in memory.
          const output = (chunk) => { writeSync(file.fd, chunk); collect(chunk) }
          child.stdout.on('data', output); child.stderr.on('data', output)
          const finish = (code) => { if (interrupted) kill('SIGKILL'); clearTimeout(timer); clearTimeout(forced); process.off('SIGINT', stop); process.off('SIGTERM', stop); options.signal?.removeEventListener('abort', stop); resolve({ code: interrupted ? code || 1 : code, timedOut }) }
          child.on('error', () => finish(127))
          child.on('close', (code) => finish(code ?? 1))
        })
      } finally { await file.close() }
    }
    const start = Date.now()
    const { code, timedOut } = await run()
    const unchanged = await workingTree(root) === tree && (!final || (await git(root, ['rev-parse', 'HEAD'])).trim() === commit)
    if (code === 0 && unchanged) await recordPass(runtime, key, { command, tree, scope, log, ms: Date.now() - start })
    const stale = final && !unchanged, ms = Date.now() - start
    // A closing gate's real duration sizes the next timed run's reserve; a task check's shows which
    // command is too slow for every task (vibe status, the loop report). A stopped run measured nothing.
    if ((final || scope.TIER === 'task') && !options.signal?.aborted) await recordTiming(runtime, timingKey(final ? 'final' : 'task', command), ms)
    const slow = scope.TIER === 'task' && ms > TASK_SLOW_MS
    const result = { schemaVersion: 1, ok: code === 0 && !stale, exitCode: stale ? 1 : code, cached: false, timedOut, stale, ms, scope, commit, tree, log,
      // Human-readable output is diagnostic evidence, never an authoritative complete failure set.
      // Only an explicit check adapter with structured identities may certify completeness.
      failedTests: [...failedTests], failureSetComplete: false, tail: tail.trimEnd().split('\n').slice(-8),
      ...(slow ? { slow: true, hint: 'task check exceeded 5 min: run only the unit tests affected since GUSTA_DIFF_BASE; move integration/e2e/full suites to the batch gate.' } : {}) }
    // A run stopped from outside verified nothing and is not charged.
    if (!ledger || options.signal?.aborted) return result
    const gate = gateView(ledger, await recordGateRun(runtime, ledger, { tree, commit, command, ok: result.ok, log }))
    // The loop reports its own counter and queues its own repair.
    if (options.gateLedger === 'record') return result
    return { ...result, gate, ...(result.ok ? {} : { next: failureNext(result, command, gate, tag) }) }
  }
  // Read the tree and cache only after acquiring the lock: a second caller reuses
  // the first caller's receipt instead of queuing a duplicate browser run.
  const result = final || options.heavy ? await withHeavyLock(runtime, command, perform, { timeoutMs: timeout, signal: options.signal }) : await perform()
  // Inside a loop unit the host hands each session its own ledger, so the unit's time
  // breakdown separates check time from model time.
  if (process.env.GUSTA_CHECK_LOG) await appendFile(process.env.GUSTA_CHECK_LOG, `${JSON.stringify({ tier: scope.TIER, command, ms: result.ms ?? 0, cached: result.cached, ok: result.ok })}\n`).catch(() => {})
  return result
}
