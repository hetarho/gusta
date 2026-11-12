import { readFile, writeFile, mkdir, rm, open, access, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { vibeStatus, vibeSession, vibePreflight, vibePush, vibeAwake, vibeCheckpoint, vibeSync, vibeClaim, specCloseIssues } from './vibe.mjs'
import { vibePrune } from './prune.mjs'
import { readVerification, vibeBrief } from './vibe-brief.mjs'
import { runVibeCheck } from './vibe-check.mjs'
import { vibeCIWait } from './vibe-ci.mjs'
import { git } from './workspace.mjs'
import { readTimings, recordTiming, timingKey, measured, workingTree } from './check-cache.mjs'
import { inspectWork } from './work-groups.mjs'
import { approvedTasks } from './work-policy.mjs'
import { appendInbox, taskRow } from './state-doc.mjs'
import { SESSION_TAG, TASK_ID } from './spec-format.mjs'
import { sections, tableRows, quoteLine, quoteFields } from './spec-format.mjs'
import { lintSpec } from './spec-lint.mjs'
import { validateAgentResult, compactUsage } from './agent-adapter.mjs'
import { adapterArgs, providerFlags } from './work-providers.mjs'
import { SkillPackageError } from './errors.mjs'
import { permissionMode, readSettings, SETTINGS } from './settings.mjs'
import { usageRun, finishUsageRun } from './usage-measurement.mjs'
import { acquireLoop, releaseLoop, bindLoopDirectory, atomicJSON, readJSON, readRequests, requestPath, requestControl, inspectLoop, loopEvent, finishedEvent, finishedSummary, judgmentItems, judgmentNotice, startLoopMonitor, controlTransaction, processAlive, notificationCapability, loopDeadline, requestedLoopConfig, loopHint } from './loop-control.mjs'
import { LoopMetadata, recoverLoopMetadata } from './loop-metadata.mjs'
import { timeBreakdown, timeLine } from './loop-time.mjs'

const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
const present = (file) => access(file).then(() => true, () => false)
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
// The closing reserve is what the last gate really costs: the measured suite, one repair
// unit and the suite's re-run, plus the measured CI wait when code is pushed. Only before
// the gate has ever been measured does a run fall back to a share of max-hours.
export const UNMEASURED_RESERVE_SHARE = 0.2
// A smaller count is insufficient: retries need complete, stable identities from the same gate.
export function improvingGate(previous, current) {
  if (!previous || (previous.plan ?? previous.command) !== (current.plan ?? current.command) || previous.evidence !== current.evidence || !previous.failureSetComplete || !current.failureSetComplete || previous.timedOut || current.timedOut || previous.stale || current.stale) return false
  const was = previous.identities ?? previous.failedTests, now = current.identities ?? current.failedTests
  if (!Array.isArray(was) || !Array.isArray(now) || [...was, ...now].some((id) => typeof id !== 'string' || !id.trim())) return false
  const before = new Set(was), after = new Set(now)
  if (before.size !== was.length || after.size !== now.length) return false
  return after.size > 0 && after.size < before.size && [...after].every((id) => before.has(id))
}

// Every command in the fixed plan must finish. Its exit receipt is authoritative even when its
// human-readable test output is not; a single command's internal shrinking failures need a typed adapter.
function gateEvidence(commands, round, head) {
  const failures = round.filter((entry) => !entry.checked.ok), first = failures[0]
  if (!first) return null
  const complete = round.length === commands.length && round.every(({ checked }) => typeof checked.ok === 'boolean' && !checked.timedOut && !checked.stale && !checked.cancelled)
  const tests = failures.every(({ checked }) => checked.failureSetComplete === true && Array.isArray(checked.failedTests) && checked.failedTests.length > 0)
  const identities = failures.flatMap(({ command, index, checked }) => tests ? checked.failedTests.map((id) => `${index}:${command}\n${id}`) : [`${index}:${command}`])
  return { head, command: first.command, plan: JSON.stringify(commands), log: first.checked.log ?? null,
    failedTests: failures.flatMap(({ checked }) => checked.failedTests ?? []).slice(0, 20), failedCommands: failures.map(({ command, index }) => ({ index, command })),
    identities, evidence: tests ? 'adapter-tests' : 'commands', failureSetComplete: complete && (tests || round.every(({ checked }) => checked.ok || Number.isInteger(checked.exitCode))),
    timedOut: round.some(({ checked }) => checked.timedOut), stale: round.some(({ checked }) => checked.stale), ms: round.reduce((sum, { checked }) => sum + (Number.isFinite(checked.ms) ? checked.ms : 0), 0) }
}
export function closingReserve({ timings, commands, push = false, hours, timeoutMs, optionHours }) {
  if (optionHours !== undefined) return { ms: optionHours * 3600000, source: 'option' }
  const gates = commands.map((command) => measured(timings, timingKey('final', command)))
  if (!commands.length || gates.includes(null)) return { ms: Math.round(hours * 60 * UNMEASURED_RESERVE_SHARE) * 60000, source: 'unmeasured' }
  const gateMs = gates.reduce((sum, ms) => sum + ms, 0)
  const fixMs = measured(timings, timingKey('unit')) ?? timeoutMs
  const ciMs = push ? measured(timings, timingKey('ci')) ?? 0 : 0
  return { ms: 2 * gateMs + fixMs + ciMs, source: 'measured', gateMs, fixMs, ciMs }
}
// A unit's time limit catches a stuck session; it does not end the run. A unit cut at the limit
// (or by the output cap) hands its snapshot to a fresh unit: continue, then split, then park.
const CUT = new Set(['unit-timeout', 'output-limit'])
// The rung for a task whose unit ended unfinished: continue from the snapshot, then split it once
// into tasks that fit a unit, then park it. A split restarts the count for the narrowed task.
export const nextRung = ({ cuts, split }) => cuts <= 1 ? 'interrupted' : !split && cuts === 2 ? 'split' : 'park'
// An explore unit runs its whole timebox, plus time to record the exit and commit.
export const EXPLORE_EXIT_MS = 30 * 60000
// Closer to the closing window than this, a new unit would only be cut: the window opens instead.
export const MIN_UNIT_MS = 10 * 60000
export const timeboxMs = (value) => {
  const match = String(value ?? '').match(/^(\d+(?:\.\d+)?)(m|h)$/)
  return match ? Number(match[1]) * (match[2] === 'h' ? 3600000 : 60000) : null
}
// The status a unit's assignment carries. A unit with a chosen task reads that task's brief: it gets
// the totals, the first few runnable/todo IDs and its own row, not every remaining row. A split or
// blocked recovery, which rewrites tasks and deps, keeps the full list.
export const UNIT_LISTED = 5
export function unitStatus(status, selected, recovery) {
  if (!selected || !status.remaining || ['split', 'blocked-task'].includes(recovery?.reason)) return status
  const { remaining, runnable = [], implementation, counts, ...rest } = status
  // The unit's own task leads a cut list, so the cut never hides it.
  const cut = (ids) => (ids.includes(selected) ? [selected, ...ids.filter((id) => id !== selected)] : ids).slice(0, UNIT_LISTED)
  return { ...rest, counts: { ...counts, runnable: runnable.length, todo: implementation?.todo?.length ?? 0 },
    task: remaining.find((task) => task.id === selected) ?? null, runnable: cut(runnable),
    ...(implementation ? { implementation: { ...implementation, todo: cut(implementation.todo ?? []) } } : {}),
    listed: `remaining rows omitted, runnable and implementation.todo cut to ${UNIT_LISTED}, task first (totals in counts): vibe status --tag ${status.tag} --no-fetch --json lists all` }
}
// A unit's "task completed" counts only with spec-close evidence: the file archived in tasks/done
// with done@date, its STATE row gone, and no lint error the unit added (baseline: errors before it).
// Lint warnings never block (they are drift, not structure).
const SPEC_GATE_LINT = 8
export async function specGate(root, id, { lint = lintSpec, baseline = [] } = {}) {
  const violations = []
  const archived = (await readdir(path.join(root, 'spec/tasks/done')).catch(() => [])).find((name) => name.startsWith(`${id}.`) && name.endsWith('.md'))
  if (!archived) violations.push(`spec/tasks/done/${id}.<slug>.md is missing (not archived)`)
  else {
    const st = quoteFields(quoteLine(await readFile(path.join(root, 'spec/tasks/done', archived), 'utf8')) ?? '').get('st')
    if (!/^done@\d{6}$/.test(st ?? '')) violations.push(`spec/tasks/done/${archived} has st:${st ?? '(none)'}, not done@<yymmdd>`)
  }
  const row = taskRow(await readFile(path.join(root, 'spec/STATE.md'), 'utf8').catch(() => ''), id)
  if (row) violations.push(`spec/STATE.md tasks row ${id} remains (st ${row.st})`)
  const known = new Set(baseline)
  const errors = (await lint({ targetRoot: root })).errors.filter((error) => !known.has(error))
  violations.push(...errors.slice(0, SPEC_GATE_LINT).map((error) => `lint: ${error}`), ...(errors.length > SPEC_GATE_LINT ? [`lint: ${errors.length - SPEC_GATE_LINT} more errors`] : []))
  return { ok: !violations.length, violations }
}
// A broken close does not release another session's claim. Read both current files because a
// malformed STATE row can hide a valid file owner; a stale doing claim also needs an explicit takeover.
async function specRepairOwner(root, id, tag, status) {
  // Remote claims remain authoritative even when a malformed local close replaced its doing row.
  const remote = (status.orphanDoing ?? []).find((task) => task.id === id && task.tag !== tag)
  if (remote) return remote.tag ?? 'unknown'
  const state = await readFile(path.join(root, 'spec/STATE.md'), 'utf8')
  const names = (await readdir(path.join(root, 'spec/tasks')).catch(() => [])).filter((name) => name.startsWith(`${id}.`) && name.endsWith('.md'))
  const claims = [taskRow(state, id)?.st, ...await Promise.all(names.map(async (name) =>
    quoteFields(quoteLine(await readFile(path.join(root, 'spec/tasks', name), 'utf8')) ?? '').get('st')))]
  const claimed = claims.find((st) => st?.startsWith('doing@') && st.split('.')[1] !== tag)
  return claimed ?? (status.others ?? []).find((row) => row.tag !== tag && !row.stale && row.doing === id)?.tag ?? null
}
// The last publication, compact: a later call that published nothing keeps an earlier push.
const published = (result, previous) => result.pushed || !previous?.pushed ? { pushed: result.pushed ?? null, target: result.target ?? null, ...(result.landed ? { landed: result.landed } : {}), ...(result.reason ? { reason: result.reason } : {}) } : previous
const depIds = (dep) => String(dep ?? '').split(/[\s,]+/).filter((id) => TASK_ID.test(id))
const positive = (value, fallback, label, integer = false) => {
  const n = Number(value ?? fallback)
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isSafeInteger(n))) throw new SkillPackageError(`${label}: 양수가 필요합니다.`)
  return n
}

// One adapter invocation is one new provider process. Logs and session IDs are
// persisted before parsing a result; retries never resume a previous context.
export async function executeVibeUnit(options, job, directory, limits = {}) {
  const id = randomUUID(), logPath = path.join(directory, `${id}.log`), sessionFile = path.join(directory, `${id}.session`), checkLog = path.join(directory, `${id}.checks.jsonl`)
  let config
  if (!options.adapter) config = { command: process.execPath, args: adapterArgs(options.provider, options.model, await providerFlags(options.provider, { env: { ...process.env, ...options.env } })) }
  else {
    const file = path.resolve(options.adapter)
    config = JSON.parse(await readFile(file, 'utf8'))
    if (!config?.command || !Array.isArray(config.args) || config.args.some((value) => typeof value !== 'string')) throw new SkillPackageError('adapter에는 command와 문자열 args 배열이 필요합니다.')
    if (config.command.includes('/') && !path.isAbsolute(config.command)) config.command = path.resolve(path.dirname(file), config.command)
  }
  // Append mode: host and adapter write to one file description without overwriting each other.
  const log = await open(logPath, 'a', 0o600)
  await writeFile(path.join(directory, `${id}.job.json`), JSON.stringify({ ...job, sessionFile }, null, 2))
  let output = '', forced, stopped = null, writing = Promise.resolve()
  // The unit log follows the session live: the adapter's stderr (provider events) goes straight to
  // the file and its stdout is appended in arrival order, not at the end.
  const append = (chunk) => { writing = writing.then(() => log.write(chunk)).catch(() => {}) }
  try {
    return await new Promise((resolve) => {
      const child = spawn(config.command, config.args, { cwd: job.workspace, env: { ...process.env, ...options.env,
        GUSTA_VIBE_UNIT: '1', GUSTA_VIBE_TAG: options.tag, GUSTA_DIFF_BASE: job.diffBase, GUSTA_TIER: 'task', GUSTA_CHECK_LOG: checkLog },
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', log.fd] })
      const kill = (signal) => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal) } catch {} }
      const stop = (reason) => { stopped ??= reason; kill('SIGTERM'); forced ??= setTimeout(() => kill('SIGKILL'), 2000) }
      const signal = () => stop('signal')
      process.on('SIGINT', signal); process.on('SIGTERM', signal)
      const abort = () => stop(limits.signal?.reason ?? 'stopped')
      limits.signal?.addEventListener('abort', abort, { once: true })
      if (limits.signal?.aborted) abort()
      const timeout = setTimeout(() => stop('unit-timeout'), limits.timeoutMs ?? 3600000)
      let checking = false
      const timer = setInterval(async () => {
        if (checking) return
        checking = true
        try {
          if (await present(limits.stopFile)) stop('stop-file')
          if (Date.now() >= limits.deadline) stop('max-hours')
        } catch { /* checkpoint errors do not discard the unit */ }
        finally { checking = false }
      }, 1000)
      const finish = async (code, error) => {
        if (stopped) kill('SIGKILL')
        clearInterval(timer); clearTimeout(timeout); clearTimeout(forced)
        process.off('SIGINT', signal); process.off('SIGTERM', signal)
        limits.signal?.removeEventListener('abort', abort)
        let result = null, usage = null
        if (code === 0 && !stopped) {
          try { const parsed = JSON.parse(output.trim().split('\n').at(-1)); result = validateAgentResult('unit', parsed); usage = compactUsage(parsed.usage) }
          catch (parseError) { error = parseError.message }
        }
        const session = await readFile(sessionFile, 'utf8').catch(() => null)
        const ran = (await readFile(checkLog, 'utf8').catch(() => '')).split('\n').flatMap((line) => { try { return line ? [JSON.parse(line)] : [] } catch { return [] } })
        const checks = { runs: ran.length, cached: ran.filter((entry) => entry.cached).length, ms: ran.reduce((total, entry) => total + (Number(entry.ms) || 0), 0) }
        resolve({ dispatch: id, exitCode: code, stopped, error: error ?? null, result, usage, checks, session: session?.trim() ?? null, log: logPath })
      }
      child.stdout.on('data', (chunk) => { append(chunk); output += chunk; if (output.length > 1024 * 1024) stop('output-limit') })
      child.on('error', (error) => finish(127, error.message))
      child.on('close', (code) => finish(code ?? 1))
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify({ ...job, sessionFile }))
    })
  } finally {
    await writing
    await log.close()
  }
}

export async function vibeLoop(options = {}, injected = {}) {
  if (!SESSION_TAG.test(options.tag ?? '')) throw new SkillPackageError('--tag에는 영숫자 2-8자가 필요합니다.')
  const control = ['stop', 'stopAfterUnit', 'configure', 'status', 'recoverMetadata'].filter((name) => options[name])
  if (control.length > 1) throw new SkillPackageError('loop 제어 동작은 하나만 지정하세요.')
  if (control.length && (options.dryRun || options.detach)) throw new SkillPackageError('실행 중 제어에는 --dry-run 또는 --detach를 함께 쓰지 않습니다.')
  if (!control.length && !options.adapter && !['claude', 'codex'].includes(options.provider)) throw new SkillPackageError('--provider claude|codex가 필요합니다.')
  if (options.permissionMode !== undefined && !SETTINGS['permission-mode'].accepts(options.permissionMode)) throw new SkillPackageError('--permission-mode는 bypass 또는 acceptEdits입니다.')
  if (options.notifyCommand !== undefined && (typeof options.notifyCommand !== 'string' || !options.notifyCommand.trim())) throw new SkillPackageError('--notify-command에는 실행 가능한 명령이 필요합니다.')
  const maxUnits = positive(options.maxUnits, 100, 'max-units', true)
  let hours = positive(options.maxHours, 8, 'max-hours')
  const maxGateAttempts = positive(options.maxGateAttempts, 3, 'max-gate-attempts', true)
  if (maxGateAttempts < 2 || maxGateAttempts > 5) throw new SkillPackageError('--max-gate-attempts에는 2-5 정수가 필요합니다.')
  const batchSize = positive(options.batchSize, 3, 'batch-size', true), timeoutMs = positive(options.timeoutMs, 3600000, 'timeout-ms')
  let optionHours = options.finalReserveHours === undefined ? undefined : Number(options.finalReserveHours)
  const scopeIds = options.tasks === undefined ? null : approvedTasks(Array.isArray(options.tasks) ? options.tasks : String(options.tasks).replaceAll(',', ' '))
  const context = await vibeSession(options), root = context.root
  // Units are headless: SETTINGS permission-mode (default bypass) unless this run names one.
  const mode = control.length ? null : await permissionMode(options, root)
  const settings = control.length ? null : (await readSettings({ root })).values
  const mcp = settings?.['headless-mcp'] ?? null
  const directory = path.join(context.runtime, 'loops', options.tag), stopFile = path.join(directory, 'STOP'), manifest = path.join(directory, 'loop.json')
  const lock = path.join(context.workspace.git.gitDir, 'gusta-vibe-loop.lock')
  const deps = { status: vibeStatus, preflight: vibePreflight, execute: executeVibeUnit, sync: vibeSync, claim: vibeClaim, push: vibePush, ci: vibeCIWait, check: runVibeCheck, checkpoint: vibeCheckpoint, prune: vibePrune, lint: lintSpec, closeIssues: specCloseIssues, now: Date.now, monitor: startLoopMonitor, fault: async () => {}, ...injected }
  const previous = await readJSON(manifest)
  if (previous && previous.cwd !== root) throw new SkillPackageError('이 tag는 다른 checkout 소유입니다.', [previous.cwd])
  if (options.stop) { await bindLoopDirectory(directory, root); await writeFile(stopFile, 'stop\n'); return { schemaVersion: 1, ok: true, stopFile, action: 'cancel' } }
  if (options.status || options.configure || options.stopAfterUnit) return requestControl(directory, root, options)
  if (options.recoverMetadata) {
    const owner = { pid: process.pid, host: os.hostname(), tag: options.tag, runId: randomUUID() }
    await acquireLoop(lock, owner)
    try {
      const state = await inspectLoop(directory, root)
      if (state.running) throw new SkillPackageError('실행 중인 loop의 메타데이터는 복구하지 않습니다.')
      try {
        const result = await recoverLoopMetadata(root, directory, state)
        await controlTransaction(path.join(directory, 'state'), () => atomicJSON(manifest, { ...state, running: false, ...(state.health === 'host-lost' ? { status: 'failed', reason: 'host-lost', error: state.error ?? 'loop host exited without finalization' } : {}), metadataRecoveredAt: new Date().toISOString(), recoveredErrors: state.operationalErrors, operationalErrors: [] }))
        const terminal = path.join(directory, 'terminal.json')
        if ((await readJSON(terminal))?.runId === state.runId) await rm(terminal, { force: true })
        await loopEvent(directory, state, 'metadata-recovered')
        return result
      } catch (caught) {
        await loopEvent(directory, state, 'metadata-error', { error: caught.message })
        throw caught
      }
    } finally { await releaseLoop(lock, owner.runId) }
  }
  const start = deps.now()
  let deadline = options.deadline === undefined ? start + hours * 3600000 : loopDeadline(options.deadline)
  hours = (deadline - start) / 3600000
  if (hours <= 0) throw new SkillPackageError('--deadline은 미래여야 합니다.')
  if (optionHours !== undefined && (!Number.isFinite(optionHours) || optionHours < 0 || optionHours >= hours)) throw new SkillPackageError('final-reserve-hours: 0 이상 실행 시간 미만이 필요합니다.')
  const state = await deps.status({ ...options, tag: options.tag })
  // --tasks: the run works only these tasks (and what it creates for them). Checked up front, so an
  // unattended night never waits on a prerequisite nobody is going to finish.
  const initialIds = new Set((state.remaining ?? []).map((task) => task.id))
  if (scopeIds) {
    const done = new Set((await readdir(path.join(root, 'spec/tasks/done')).catch(() => [])).map((name) => name.split('.')[0]))
    const rows = new Map((state.remaining ?? []).map((task) => [task.id, task]))
    const missing = scopeIds.filter((id) => !rows.has(id) && !done.has(id))
    if (missing.length) throw new SkillPackageError('--tasks: STATE tasks와 tasks/done에 없는 태스크입니다.', missing)
    const outside = scopeIds.flatMap((id) => depIds(rows.get(id)?.dep).filter((dep) => !scopeIds.includes(dep) && !done.has(dep)).map((dep) => `${id} → ${dep}`))
    if (outside.length) throw new SkillPackageError('--tasks: 범위 밖 선행 태스크가 끝나지 않았습니다. 범위에 넣거나 먼저 끝내세요.', outside)
  }
  let verify = await readVerification(root)
  let requiredVerificationTiers = Boolean(previous?.requiredVerificationTiers || previous?.verify?.declared || previous?.verify?.partial || verify.declared || verify.partial)
  const selectBatch = (verify) => {
    if (options.verify === undefined && requiredVerificationTiers && !verify.declared) throw new SkillPackageError('ARCH 검증 단계가 불완전합니다. task·batch·CI 단계를 고치거나 --verify를 명시하세요.')
    const commands = options.verify ?? verify.batch
    if (!Array.isArray(commands) || commands.some((command) => typeof command !== 'string' || !command.trim())) throw new SkillPackageError('--verify에는 실행 가능한 명령이 필요합니다.')
    return [...commands]
  }
  let batchVerify = selectBatch(verify)
  const refreshVerification = async () => {
    verify = await readVerification(root)
    requiredVerificationTiers ||= verify.declared || verify.partial
    batchVerify = selectBatch(verify)
  }
  // The tail of a timed run belongs to the closing gate (full suites, push, CI): no new work
  // starts inside it, so implementation time never eats the verification.
  const estimateReserve = async () => closingReserve({ timings: await readTimings(context.runtime), commands: batchVerify, push: Boolean(context.target), hours, timeoutMs, optionHours })
  let reserve = await estimateReserve()
  if (reserve.ms >= hours * 3600000) throw new SkillPackageError(`마감 관문 실측(전체 검증 2회+수정 1회+CI)이 ${(reserve.ms / 3600000).toFixed(2)}시간이라 max-hours 안에 구현 시간이 없습니다. --max-hours를 늘리거나 --final-reserve-hours를 지정하세요.`)
  const plan = { schemaVersion: 1, controlVersion: 1, tag: options.tag, provider: options.provider ?? 'command', permissionMode: mode, headlessMcp: mcp,
    cwd: root, concurrency: state.concurrency, route: state.route, limits: { maxUnits, maxHours: hours, batchSize, timeoutMs, exploreExitMs: EXPLORE_EXIT_MS, maxGateAttempts }, scope: scopeIds, reserve, verify, batchVerify, requiredVerificationTiers,
    deadline: new Date(deadline).toISOString(), workDeadline: new Date(deadline - reserve.ms).toISOString(), notification: notificationCapability(directory, options.notifyCommand),
    directory, stopFile, manifest, freshSessionPerUnit: true, pushEachUnit: Boolean(options.pushEachUnit), notifyCommand: options.notifyCommand ?? null }
  if (options.dryRun) return { ...plan, dryRun: true, modelRequests: 0 }
  if ((await inspectWork({ targetRoot: root })).mode !== 'single') throw new SkillPackageError('vibe loop는 단독 checkout에서 실행하세요. 활성 work 공간은 work run을 사용합니다.')
  await mkdir(directory, { recursive: true })
  await bindLoopDirectory(directory, root)
  if (options.detach) {
    const runId = randomUUID()
    const config = path.join(directory, `config-${randomUUID()}.json`)
    await writeFile(config, JSON.stringify({ ...options, targetRoot: root, detach: false, runId }), { mode: 0o600 })
    const logPath = path.join(directory, 'host.log'), log = await open(logPath, 'a')
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/gusta-vibe-loop.mjs', import.meta.url)), config], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], env: options.env ?? process.env })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
      const readyUntil = Date.now() + 10000
      while (Date.now() < readyUntil) {
        const ready = await readJSON(manifest)
        if (ready?.runId === runId) return { ...plan, limits: ready.limits, deadline: ready.deadline, workDeadline: ready.workDeadline, reserve: ready.reserve, ok: true, detached: true, runId, pid: child.pid, ready: true, status: ready.status, log: logPath }
        if (child.exitCode !== null) throw new SkillPackageError('loop host failed before ownership acknowledgement', [logPath])
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new SkillPackageError('loop host ownership acknowledgement timed out; inspect status before retry', [logPath])
    } finally { await log.close() }
  }
  const runId = options.runId ?? randomUUID()
  const measurementRun = usageRun(settings?.['usage-measurement'], context.runtime, runId)
  let measurement
  await acquireLoop(lock, { pid: process.pid, host: os.hostname(), tag: options.tag, runId })
  const report = `spec/reports/${new Date(start).toISOString().slice(2, 10).replaceAll('-', '')}-${options.tag}.md`
  const reportPath = path.join(root, report)
  let initialized = false, awake = false, stopped = false, reason = null, error = null, base = context.workspace.git.head, pending = [], failureStreak = 0, noProgress = 0, count = 0, codePushed = false, pruned = null, publication = null
  let lastBatchPlan = JSON.stringify(batchVerify)
  // scope grows with the tasks this run creates for scoped work (a split, a prerequisite, a repair).
  const scope = scopeIds ? new Set(scopeIds) : null
  const inScope = (id) => !scope || scope.has(id)
  // A task that did not exist when the run started joins the scope when it depends on a scoped task
  // or a scoped task depends on it. Tasks other sessions planned meanwhile stay out.
  const growScope = (tasks) => {
    for (let grew = true; grew;) {
      grew = false
      for (const task of tasks) {
        if (scope.has(task.id) || initialIds.has(task.id)) continue
        if (depIds(task.dep).some((id) => scope.has(id)) || tasks.some((other) => scope.has(other.id) && depIds(other.dep).includes(task.id))) { scope.add(task.id); grew = true }
      }
    }
  }
  let priorityTask = /^T\d+$/.test(previous?.priorityTask ?? '') && inScope(previous.priorityTask) ? previous.priorityTask : null
  // repairTask: the gate/CI repair this run queued. failedGate: the code a gate last failed on.
  let repairTask = null, failedGate = null, gateFailures = 0, gateAttempts = 0, gateRetryAllowed = true, gateStopReason = null, verifiedCommit = null
  // One spec-close repair per task survives a restart of the same helper run.
  const specRepairs = new Map(Object.entries(previous?.specRepairs ?? {}).filter(([id, count]) => TASK_ID.test(id) && Number.isSafeInteger(count) && count > 0))
  const specRejected = new Map(Object.entries(previous?.specRejected ?? {}).filter(([id, violations]) => TASK_ID.test(id) && Array.isArray(violations) && violations.every((value) => typeof value === 'string')))
  let lintBlocked = null
  let recovery = ['blocked-task', 'interrupted', 'split', 'spec-gate'].includes(previous?.recovery?.reason) && /^T\d+$/.test(previous.recovery.taskId ?? '') && inScope(previous.recovery.taskId) ? previous.recovery : null
  // ladder: per task, units that ended before finishing it since its last split, and whether it was
  // split. snapshots: the uncommitted work those units left.
  const ladder = new Map(recovery?.cuts ? [[recovery.taskId, { cuts: recovery.cuts, split: Boolean(recovery.split) }]] : [])
  const snapshots = recovery?.snapshot ? [{ ...recovery.snapshot, task: recovery.taskId }] : []
  const dispatches = [], batches = []
  const operationalErrors = [], configHistory = []
  const appliedConfig = { pushEachUnit: Boolean(options.pushEachUnit), ...(options.deadline === undefined ? {} : { deadline: new Date(deadline).toISOString() }), ...(optionHours === undefined ? {} : { finalReserveHours: optionHours }) }
  let requestedConfig = { ...appliedConfig }, phase = 'preflight', heartbeatAt = new Date().toISOString(), supervisor = null, closing = false
  const metadata = new LoopMetadata(root, directory, report, options.tag, runId, { fault: deps.fault })
  const controller = new AbortController()
  let stopReason = null, watching = null, checkpointAt = start
  const event = async (type, detail = {}) => {
    try { await loopEvent(directory, { runId, tag: options.tag, cwd: root, notifyCommand: options.notifyCommand }, type, detail) }
    catch (caught) { operationalErrors.push({ operation: 'event-write', error: caught.message }); process.stderr.write(`loop event-write failed: ${caught.message}\n`) }
  }
  // Notices for the owner (judgment waiting, run finished) never hold up or fail the run: the hook
  // runs alongside the next unit, a write error only reaches stderr, and the run waits for them once.
  const deliveries = []
  const notify = (send) => {
    const sent = send().catch((caught) => { process.stderr.write(`loop notification failed: ${caught.message}\n`) })
    deliveries.push(sent)
    return sent
  }
  const stateFile = path.join(root, 'spec/STATE.md')
  const metadataStep = async (operation, run) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { await metadata.applyOperation(); return await run() }
      catch (caught) {
        await event('metadata-retry', { operation, attempt, error: caught.message })
        if (attempt === 2) { operationalErrors.push({ operation, error: caught.message }); await event('metadata-error', { operation, error: caught.message }); throw caught }
      }
    }
  }
  const checkpoint = async () => {
    if (initialized && !stopped && deps.now() - checkpointAt >= 3600000) {
      checkpointAt = deps.now()
      await deps.checkpoint({ ...options, targetRoot: root, tag: options.tag }).catch(async (caught) => {
        operationalErrors.push({ operation: 'checkpoint', error: caught.message })
        await event('metadata-error', { operation: 'checkpoint', error: caught.message })
      })
    }
  }
  const stop = (why) => { stopped = true; stopReason ??= why; controller.abort(stopReason) }
  const interrupted = () => stop('signal')
  const gateState = () => ({ attempts: gateAttempts, failures: gateFailures, maxFailedAttempts: maxGateAttempts, retryAllowed: gateRetryAllowed, stopReason: gateStopReason,
    verifiedCommit, failedCommit: failedGate?.head ?? null, failedTests: failedGate?.failedTests ?? [], failedCommands: failedGate?.failedCommands ?? [], evidence: failedGate?.evidence ?? null, failureSetComplete: failedGate?.failureSetComplete ?? null,
    pendingRepairTasks: repairTask ? [repairTask] : [] })
  const continuation = () => {
    const remainingMs = Math.max(0, deadline - deps.now()), remainingUnits = Math.max(0, maxUnits - count)
    const hardStop = remainingMs === 0 || remainingUnits === 0 || ['max-hours', 'max-units', 'stop-file', 'signal', 'stop-after-unit', 'cancelled'].includes(stopReason ?? reason)
    return { objectiveComplete: false, recoverable: !hardStop, hardStop, reason, remainingMs, remainingUnits, deadline: new Date(deadline).toISOString(),
      pendingRepairTasks: [...new Set([repairTask, ...specRejected.keys(), recovery?.reason === 'spec-gate' ? recovery.taskId : null].filter(Boolean))], next: hardStop ? 'report stop and preserve remaining work' : reason === 'needs-sketch' ? 'report that the owner plans the untasked SSOT deltas, reviews or ideation with /gusta-sketch; do not plan them in this session' : repairTask ? 'delegate the pending repair within the existing session budget, then verify before publication' : 'reconcile the result with the user objective and continue within the existing session budget' }
  }
  const snapshot = () => ({ ...plan, verify, batchVerify, requiredVerificationTiers, limits: { ...plan.limits, maxHours: hours }, runId, host: os.hostname(), pid: process.pid, startedAt: new Date(start).toISOString(), deadline: new Date(deadline).toISOString(), workDeadline: new Date(deadline - reserve.ms).toISOString(), reserve, heartbeatAt,
    status: closing ? error || operationalErrors.length || reason === 'session-failures' ? 'failed' : controller.signal.aborted ? 'cancelled' : 'stopped' : phase,
    ...(closing ? { endedAt: new Date().toISOString() } : {}),
    report, pruned, publication, units: count, dispatches, batches, time: timeBreakdown({ dispatches, batches, totalMs: deps.now() - start }), ...(measurement ? { measurement } : {}), priorityTask, recovery, specRepairs: Object.fromEntries(specRepairs), specRejected: Object.fromEntries(specRejected), gate: gateState(), continuation: continuation(), scope: scope ? [...scope] : null, snapshots, reason, ...(loopHint(reason) ? { hint: loopHint(reason) } : {}), stopReason, error, operationalErrors, requestedConfig, appliedConfig, configHistory, supervisor, running: !closing })
  let saving = Promise.resolve()
  const save = () => {
    saving = saving.catch(() => {}).then(async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await deps.fault('manifest-write')
          await controlTransaction(path.join(directory, 'state'), () => atomicJSON(manifest, snapshot()))
          return
        } catch (caught) {
          if (attempt === 2) { operationalErrors.push({ operation: 'manifest-write', error: caught.message }); await event('metadata-error', { operation: 'manifest-write', error: caught.message }); throw caught }
        }
      }
    })
    return saving
  }
  const watcher = setInterval(() => {
    if (watching) return
    watching = (async () => {
      if (await present(stopFile) && (await readFile(stopFile, 'utf8')).trim() !== 'stop-after-unit') stop('stop-file')
      if (deps.now() >= deadline) stop('max-hours')
      if (supervisor?.pid && !processAlive(supervisor.pid)) throw new Error('independent loop supervisor exited')
      heartbeatAt = new Date().toISOString()
      await save()
    })().catch(async (caught) => { operationalErrors.push({ operation: 'heartbeat', error: caught.message }); stop('operational-error'); await event('failed', { error: caught.message }) }).finally(() => { watching = null })
  }, 1000)
  const metadataCommit = (message) => metadataStep('metadata-commit', () => metadata.commit(message))
  const updateReport = async (closing = false) => {
    let text = await readFile(reportPath, 'utf8')
    if (closing) text = text.replace(/\bto:-/, `to:${new Date(deps.now()).toISOString()}`)
    const outcome = (entry) => entry.specGate?.ok === false ? 'rejected by spec gate' : entry.result?.outcome ?? (CUT.has(entry.stopped) ? `cut (${entry.stopped})` : entry.stopped ? `cancelled (${entry.stopped})` : 'failed')
    const lines = pending.map((entry) => `- ${entry.result?.kind ?? 'session'} ${entry.result?.id ?? entry.task ?? '-'}: ${outcome(entry)}${entry.leftover ? ` · uncommitted work → ${entry.leftover.ref}` : ''}${entry.parked ? ' · parked' : ''} (${entry.head.slice(0, 12)})`).filter((line) => !text.includes(line))
    if (lines.length) text = text.replace('\n## decided', `${lines.join('\n')}\n\n## decided`)
    const current = await deps.status({ ...options, targetRoot: root, section: 'inbox', fetch: false })
    for (const kind of ['decided', 'parked']) {
      const entries = current.inbox?.filter((entry) => entry.kind === kind).map((entry) => entry.line) ?? []
      const next = kind === 'decided' ? 'parked' : 'checks'
      const fresh = entries.filter((line) => !text.includes(line))
      if (fresh.length) text = text.replace(`\n## ${next}`, `${fresh.join('\n')}\n\n## ${next}`)
    }
    const checks = batches.map((entry) => entry.ci ? `- CI ${entry.ci.commit ?? '-'}: ${entry.ci.outcome}${entry.ci.outcome === 'unchecked' ? ` (${entry.ci.reason})` : ''} ${entry.ci.runUrl ?? entry.ci.checkUrl ?? ''}`.trimEnd()
      : entry.errors ? `- ${entry.command}: fail (${entry.errorCount} errors; first: ${entry.errors[0]})` : `- ${entry.command}: ${entry.cancelled ? 'cancelled' : entry.ok ? 'pass' : 'fail'} (${entry.log ?? '-'})`)
      .filter((line) => !text.includes(line))
    if (checks.length) text = text.replace('\n## next', `${checks.join('\n')}\n\n## next`)
    // Where the run's time went, once, when the run closes (a reopened report gets a fresh line).
    if (closing) text = text.replace(/^- time: .*\n/m, '').replace('\n## next', `${timeLine(timeBreakdown({ dispatches, batches, totalMs: deps.now() - start }))}\n\n## next`)
    if (closing && measurement?.summary) text = text.replace(/^- usage: .*\n/m, '').replace('\n## next', `- usage: ${measurement.summary} ${measurement.reportLink ?? 'Human-readable usage report unavailable.'}\n\n## next`)
    const kept = snapshots.filter((snapshot) => !snapshot.dropped).map((snapshot) => `- uncommitted work kept: ${snapshot.ref} (${snapshot.task ?? '-'}, ${snapshot.fileCount} files)\n`).join('')
    // CI the run could not read waits for the owner, not for the run.
    const ciLater = batches.filter((entry) => entry.ci?.outcome === 'unchecked').map((entry) => `- check CI later: ${entry.ci.commit ?? '-'} ${entry.ci.checkUrl ?? ''}`.trimEnd() + '\n').join('')
    if (closing) text = text.replace(/## next[\s\S]*$/, `## next\n- loop stopped: ${reason}${loopHint(reason) ? ` — ${loopHint(reason)}` : ''}\n- verification: ${gateAttempts} rounds, ${gateFailures} failed, failed-round cap ${maxGateAttempts}; pending repair: ${repairTask ?? '-'}; code pushed: ${codePushed}\n${priorityTask ? `- priority task: ${priorityTask}\n` : ''}${ciLater}${kept}`)
    await metadata.writeReport(text)
  }
  const recordReport = (closing) => metadataStep('report-write', () => updateReport(closing))
  const ensureActive = async () => {
    if (await present(stopFile) && (await readFile(stopFile, 'utf8')).trim() !== 'stop-after-unit') stop('stop-file')
    if (controller.signal.aborted || deps.now() >= deadline) { stopReason ??= deps.now() >= deadline ? 'max-hours' : 'cancelled'; throw new Error('loop publication cancelled') }
  }
  const applyRequests = async () => {
    for (const request of await readRequests(directory, runId)) {
      if (request.status !== 'pending') continue
      if (request.type === 'stop-after-unit') {
        // Like STOP, a graceful user stop persists across explicit invocations.
        await writeFile(stopFile, 'stop-after-unit\n')
        await atomicJSON(requestPath(directory, request), { ...request, status: 'applied', appliedAt: new Date().toISOString(), afterUnit: count })
        reason = 'stop-after-unit'
        return
      }
      if (request.type !== 'configure') throw new Error('invalid loop configuration request')
      requestedConfig = requestedLoopConfig(request.requested ?? {})
      await save()
      // Faults before/after mutation remain in this same host; no worker handoff.
      await deps.fault('config-before-apply')
      let nextDeadline = deadline, nextHours = hours, nextReserve = reserve
      const timingChanged = requestedConfig.deadline !== undefined || requestedConfig.finalReserveHours !== undefined
      if (timingChanged) {
        nextDeadline = requestedConfig.deadline === undefined ? deadline : loopDeadline(requestedConfig.deadline)
        nextHours = (nextDeadline - start) / 3600000
        const nextOption = requestedConfig.finalReserveHours ?? optionHours
        nextReserve = closingReserve({ timings: await readTimings(context.runtime), commands: batchVerify, push: Boolean(context.target), hours: nextHours, timeoutMs, optionHours: nextOption })
        if (nextDeadline <= deps.now() || nextReserve.ms >= nextDeadline - deps.now()) {
          await atomicJSON(requestPath(directory, request), { ...request, status: 'failed', reason: 'deadline leaves insufficient final reserve at unit boundary', afterUnit: count, actual: { ...appliedConfig, deadline: new Date(deadline).toISOString(), workDeadline: new Date(deadline - reserve.ms).toISOString(), reserve } })
          await event('configuration-rejected', { requestId: request.id, afterUnit: count })
          continue
        }
      }
      deadline = nextDeadline; hours = nextHours; reserve = nextReserve
      if (requestedConfig.finalReserveHours !== undefined) optionHours = requestedConfig.finalReserveHours
      Object.assign(appliedConfig, requestedConfig)
      const acknowledgement = { ...request, status: 'applied', actual: { ...appliedConfig, ...(timingChanged ? { deadline: new Date(deadline).toISOString(), workDeadline: new Date(deadline - reserve.ms).toISOString(), reserve } : {}) }, appliedAt: new Date().toISOString(), afterUnit: count }
      configHistory.push(acknowledgement)
      await save()
      await deps.fault('config-after-apply')
      await atomicJSON(requestPath(directory, request), acknowledgement)
      await event('configuration-applied', { requestId: request.id, actual: appliedConfig, afterUnit: count })
    }
  }
  const codeChanged = async (from, to) => (await git(root, ['diff', '--name-only', from, to])).trim().split('\n').filter(Boolean).some((file) => !/^(spec\/|docs\/)|\.md$/i.test(file))
  // A failed gate or CI run is work for the next unit, not a request for a person: persist a
  // concrete repair task with its evidence and keep it ahead of the normal queue, even though
  // its ID was allocated last. The fresh session needs no output from this conversation.
  const queueRepair = async (slug, title, goal, notes) => {
    const file = path.join(root, 'spec/STATE.md')
    let text = await readFile(file, 'utf8')
    const names = [...await readdir(path.join(root, 'spec/tasks')).catch(() => []), ...await readdir(path.join(root, 'spec/tasks/done')).catch(() => [])]
    const id = `T${String(Math.max(0, ...names.map((name) => Number(name.match(/^T(\d+)\./)?.[1] ?? 0))) + 1).padStart(3, '0')}`
    const rev = tableRows(sections(text).get('ssot')).find(([id]) => id === 'ARCH')?.[1] ?? '1'
    const taskPath = `spec/tasks/${id}.${slug}.md`
    await writeFile(path.join(root, taskPath), `# ${id} ${title}\n> st:todo | ssot:- | base:ARCH@${rev} | dep:-\n\n## goal\n${goal}\n\n## acceptance\n- [ ] The failed checks pass with a regression test where appropriate.\n\n## impl notes\n${notes.map((note) => `- ${note}`).join('\n')}\n\n## result\n`)
    text = text.replace(/(## tasks\n[\s\S]*?)(?=\n## |$)/, (section) => `${section.trimEnd()}\n| ${id} | ${title} | ARCH | - | todo |\n`)
    text = text.replace(/## next\n[\s\S]*?(?=\n## |$)/, `## next\n- gusta-implement-task ${id}\n`)
    await writeFile(file, text)
    await git(root, ['add', '--', file, taskPath])
    await git(root, ['commit', '--quiet', '--only', '-m', `gusta-create-task ${id}: ${title}`, '--', file, taskPath])
    priorityTask = repairTask = id
    scope?.add(id)
  }
  // An unfinished unit's uncommitted changes must block neither the next unit nor the gate. They are
  // kept as a commit on a local ref (never on the branch, never pushed; a staged-only version is its
  // second parent), the tree returns to HEAD, and the next fresh unit gets the snapshot to restore.
  const keepLeftover = async (task, cause) => {
    if (!(await git(root, ['status', '--porcelain', '--untracked-files=all'])).trim()) return null
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim(), tree = await workingTree(root)
    const index = (await git(root, ['write-tree']).catch(() => '')).trim()
    const parents = [head]
    if (index && index !== tree && index !== (await git(root, ['rev-parse', 'HEAD^{tree}'])).trim()) parents.push((await git(root, ['commit-tree', index, '-p', head, '-m', `vibe ${options.tag} unit ${count}: staged`])).trim())
    const commit = (await git(root, ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', `vibe ${options.tag} unit ${count} ${task ?? '-'}: ${cause}`])).trim()
    const ref = `refs/gusta/units/${options.tag}/${runId.slice(0, 8)}-${count}`
    await git(root, ['update-ref', ref, commit])
    const files = (await git(root, ['diff', '--name-only', head, commit])).trim().split('\n').filter(Boolean)
    // Only the untracked paths git reports: a clean of the whole tree would also drop empty directories
    // that were there before the unit (git cannot see them, so the snapshot cannot hold them).
    const untracked = (await git(root, ['status', '--porcelain', '-z', '--untracked-files=normal'])).split('\0').filter((entry) => entry.startsWith('?? ')).map((entry) => entry.slice(3))
    await git(root, ['reset', '--hard', '--quiet', 'HEAD'])
    if (untracked.length) await git(root, ['clean', '-f', '-d', '--quiet', '--', ...untracked])
    const snapshot = { ref, commit, base: head, task, cause, unit: count, files: files.slice(0, 20), fileCount: files.length }
    snapshots.push(snapshot)
    await event('unit-leftover', { unit: count, task, cause, ref, files: files.length })
    return snapshot
  }
  // The last rung: a task still unfinished after a continuation and a split waits for the owner.
  // why replaces that reason for other repeated failures (a spec close that failed its repair).
  const parkTask = async (id, snapshot, why = null) => {
    const file = path.join(root, 'spec/STATE.md')
    const date = new Date(deps.now()).toISOString().slice(2, 10).replaceAll('-', '')
    const line = `- ${date} parked ${id}: ${why ?? `units kept ending before finishing it, after a continuation and a split${snapshot ? `; last attempt kept at ${snapshot.ref}` : ''}. Needs a smaller split or a longer --timeout-ms.`}`
    await writeFile(file, appendInbox(await readFile(file, 'utf8'), line))
    await git(root, ['add', '--', file])
    await git(root, ['commit', '--quiet', '--only', '-m', `vibe ${options.tag}: park ${id}`, '--', file])
    await event('task-parked', { task: id, snapshot: snapshot?.ref ?? null, ...(why ? { why } : {}) })
  }
  // A spec close the gate rejected gets one repair unit; a second rejection parks the task.
  const specFailed = async (id, violations) => {
    const repaired = specRepairs.get(id) ?? 0
    await event('spec-gate', { task: id, violations, next: repaired ? 'parked' : 'spec-gate' })
    if (repaired) {
      await parkTask(id, null, `reported completed, but its spec close still failed after a repair unit (${violations[0]}). Close it with gusta-implement-task (vibe task done) and run lint.`)
      if (priorityTask === id) priorityTask = null
      return null
    }
    specRepairs.set(id, repaired + 1)
    priorityTask = id
    return { reason: 'spec-gate', taskId: id, violations }
  }
  // Reconcile actual artifacts repaired by the originating session, without requiring a new
  // completed child report or discarding the earlier rejection history.
  const reconcileSpecRejected = async (knownLint = null) => {
    if (!specRejected.size) return
    const lint = knownLint ?? await deps.lint({ targetRoot: root })
    for (const id of specRejected.keys()) {
      const checked = await specGate(root, id, { lint: async () => lint })
      if (!checked.ok) { specRejected.set(id, checked.violations); continue }
      specRejected.delete(id)
      if (recovery?.reason === 'spec-gate' && recovery.taskId === id) recovery = null
      if (priorityTask === id) priorityTask = null
      await event('spec-gate-reconciled', { task: id, evidence: 'archive, dated status, STATE removal, lint' })
      batches.push({ command: `spec close ${id} reconciled`, ok: true })
    }
  }
  // A batch boundary only records the report. Batch suites, the push and the CI wait run when
  // the work runs out or in the closing window. Per-unit publication requires an explicit option.
  // Returns false when the gate failed and a repair was queued (closing throws instead).
  const flush = async (closing = false, publish = closing) => {
    if (publish) await ensureActive()
    await recordReport(closing)
    await metadataCommit(`vibe ${options.tag}: ${closing ? 'close report' : 'batch report'}`)
    await metadata.assertClean()
    if (publish && context.target) await deps.sync({ ...options, targetRoot: root })
    if (closing || publish) { await refreshVerification(); reserve = await estimateReserve() }
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
    // Spec structure is part of every publication's gate, code or not: a run never ends as if
    // the work were settled (no-work) while lint has errors, and never pushes them.
    if (closing || publish) {
      const lint = await deps.lint({ targetRoot: root })
      await reconcileSpecRejected(lint)
      const issues = await deps.closeIssues(root)
      const errors = [...lint.errors, ...issues.map((issue) => `${issue.where} ${issue.id}: ${issue.reason ?? `invalid st:${issue.st ?? '(none)'}`}`), ...[...specRejected].map(([id, violations]) => `${id}: reported completion remains rejected (${violations[0] ?? 'spec-close evidence missing'})`)]
      if (errors.length) {
        const entry = { command: lint.errors.length ? 'spec lint' : 'spec close', ok: false, errors: errors.slice(0, 10), errorCount: errors.length }
        if (JSON.stringify(batches.findLast((check) => check.command === entry.command)) !== JSON.stringify(entry)) batches.push(entry)
        await recordReport(closing)
        await metadataCommit(`vibe ${options.tag}: record checks`)
        lintBlocked = (await git(root, ['rev-parse', 'HEAD'])).trim()
        if (closing) throw new SkillPackageError(`${entry.command} 실패`, entry.errors)
        return false
      }
    }
    const code = await codeChanged(base, head)
    const needsGate = code || lastBatchPlan !== JSON.stringify(batchVerify)
    if (needsGate && publish) {
      if (!batchVerify.length) throw new SkillPackageError('코드 push 전 묶음 검증이 없습니다. ARCH batch 단계 또는 --verify를 지정하세요.')
      // The same code already failed: re-running the suite cannot pass.
      if (failedGate && failedGate.plan === JSON.stringify(batchVerify) && !(await codeChanged(failedGate.head, head))) {
        if (closing) throw new SkillPackageError(`묶음 검증 실패: ${failedGate.command}`, [failedGate.log ?? ''])
        return false
      }
      gateAttempts++
      const round = []
      for (const [index, command] of batchVerify.entries()) {
        await ensureActive()
        let checked
        // The gate may use its whole reserve even when a unit's timeout is shorter.
        try { checked = await deps.check({ targetRoot: root, tier: 'batch', diffBase: base, heavy: true, signal: controller.signal, timeoutMs: Math.min(Math.max(timeoutMs, reserve.ms), Math.max(1, deadline - deps.now())) }, command) }
        catch (caught) { batches.push({ command, ok: false, cancelled: controller.signal.aborted, error: caught.message }); throw caught }
        batches.push({ command, ...checked, ...(!checked.ok && controller.signal.aborted ? { cancelled: true } : {}) })
        round.push({ command, index, checked })
        await ensureActive()
      }
      const current = gateEvidence(batchVerify, round, head)
      if (current) {
        const improved = improvingGate(failedGate, current)
        const gateMs = reserve.gateMs ?? (current.ms > 0 ? current.ms : timeoutMs)
        const retryFits = deadline - deps.now() > gateMs + (reserve.fixMs ?? timeoutMs) + (reserve.ciMs ?? 0)
        failedGate = current; gateFailures++
        gateRetryAllowed = gateFailures < 2 || (gateFailures < maxGateAttempts && improved && retryFits)
        gateStopReason = gateRetryAllowed ? null : gateFailures >= maxGateAttempts ? 'attempt-limit' : !improved ? 'failure-set-not-improving' : 'insufficient-time'
        await queueRepair('fix-gate', 'Fix final gate failure', `Make the failed final-gate commands pass on ${head}; preserve existing contracts.`,
          round.filter(({ checked }) => !checked.ok).flatMap(({ command, checked }) => [`Command: ${command}`, `Log: ${checked.log ?? '-'}`, `Failed tests: ${JSON.stringify(checked.failedTests ?? [])}`, `Tail: ${JSON.stringify(checked.tail ?? [])}`]))
        await recordReport(closing)
        await metadataCommit(`vibe ${options.tag}: record checks`)
        if (closing) throw new SkillPackageError(`묶음 검증 실패: ${current.command}`, [current.log ?? ''])
        return false
      }
      verifiedCommit = head; lastBatchPlan = JSON.stringify(batchVerify); failedGate = null; gateRetryAllowed = true; gateStopReason = null
    }
    await recordReport(closing)
    await metadataCommit(`vibe ${options.tag}: record checks`)
    // base stays at the last published commit, so the next publish still sees this code.
    if (!publish) { pending = []; await save(); return true }
    await ensureActive()
    await metadata.assertClean()
    const pushed = await deps.push({ ...options, targetRoot: root, ...(needsGate ? { verifiedCommit: head } : {}) })
    if (pushed.ok === false) throw new SkillPackageError('묶음 push 실패')
    publication = published(pushed, publication)
    if (pushed.pushed && code) {
      codePushed = true
      const ci = await deps.ci({ ...options, targetRoot: root, signal: controller.signal, timeoutMs: Math.max(1, deadline - deps.now()), commit: pushed.pushed, branch: pushed.target ?? context.target, diffBase: base })
      batches.push({ ci })
      if (!ci.ok && ci.outcome === 'cancelled') throw new SkillPackageError('CI 대기가 중지됐습니다.')
      if (!['skipped', 'cancelled', 'unchecked'].includes(ci.outcome) && Number.isFinite(ci.ms)) await recordTiming(context.runtime, timingKey('ci'), ci.ms)
      if (!ci.ok) await queueRepair('fix-ci', 'Fix CI failure', `Fix the failing checks for ${pushed.pushed}; preserve existing contracts.`, [`CI: ${ci.runUrl ?? '-'}`, `Jobs: ${JSON.stringify(ci.jobs ?? [])}`])
    }
    // The last CI result (and any repair queued at a limit) arrives after the
    // code push. Persist it in the closing report and publish that metadata too.
    if (closing && pushed.pushed && code) {
      await recordReport(true)
      await metadataCommit(`vibe ${options.tag}: final CI result`)
      await ensureActive()
      await metadata.assertClean()
      const final = await deps.push({ ...options, targetRoot: root, verifiedCommit: head })
      if (final.ok === false) throw new SkillPackageError('마감 보고서 push 실패')
      publication = published(final, publication)
    }
    base = (await git(root, ['rev-parse', 'HEAD'])).trim(); pending = []
    await save()
    return true
  }
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted)
  try {
    await save()
    if (await present(stopFile)) { stop('stop-file'); throw new Error('loop stopped before preflight') }
    try { supervisor = await deps.monitor(directory, runId) }
    catch (caught) { await event('supervisor-error', { error: caught.message }); throw caught }
    await event('started', { notification: plan.notification, deadline: new Date(deadline).toISOString(), workDeadline: new Date(deadline - reserve.ms).toISOString() })
    if (!options.notifyCommand) process.stderr.write(`vibe loop ${options.tag}: user notification unavailable; parent must await this run or read ${plan.notification.terminalEvent}\n`)
    // Never adopt pre-existing source, SSOT, STATE, report or index changes.
    if ((await git(root, ['status', '--porcelain'])).trim()) throw new SkillPackageError('loop 시작 전 미커밋 변경을 보존합니다. 먼저 정리하세요.')
    const allowTool = [...new Set(['Bash(git *)', `Bash(${process.execPath} ${cli} *)`, ...(options.allowTool ?? [])])]
    const probe = options.probe ?? `git status --porcelain${context.target ? ` && git push --dry-run ${quote(context.remote)} ${quote(`HEAD:refs/heads/${context.target}`)}` : ''}`
    const preflight = await deps.preflight({ ...options, permissionMode: mode, targetRoot: root, signal: controller.signal, probe, allowTool, probeWorkspace: 'current', probeTimeoutMs: Math.min(Number(options.probeTimeoutMs ?? 900000), Math.max(1, deadline - deps.now())) })
    await writeFile(path.join(directory, 'preflight.json'), JSON.stringify(preflight, null, 2))
    if (!preflight.ok) throw new SkillPackageError('맡김 preflight 실패', preflight.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`))
    if (state.git?.behind) await vibeSync({ ...options, targetRoot: root })
    base = (await git(root, ['rev-parse', 'HEAD'])).trim()
    await mkdir(path.dirname(reportPath), { recursive: true })
    await metadata.initialize()
    initialized = true
    await metadataStep('active-start', () => metadata.beat())
    if (await present(reportPath)) {
      const previous = await readFile(reportPath, 'utf8')
      await metadataStep('report-open', () => metadata.writeReport(previous.replace(/\bto:[^|\n]+/, 'to:- ')))
    } else await metadataStep('report-open', () => metadata.writeReport(`# REPORT ${path.basename(report, '.md')}\n> mode:autopilot | host:${os.hostname()} | from:${new Date(start).toISOString()} | to:- | push:${context.push}\n\n## done\n\n## decided\n\n## parked\n\n## checks\n\n## next\n- continue remaining work\n`))
    await metadataCommit(`vibe ${options.tag}: session presence`)
    if (process.platform === 'darwin') { const receipt = await vibeAwake({ targetRoot: root, hours: Math.min(hours, 72) }); awake = receipt.ok && !receipt.reused }
    for (;;) {
      if (stopped) { reason = stopReason; break }
      if (await present(stopFile)) { reason = 'stop-file'; break }
      if (deps.now() >= deadline) { reason = 'max-hours'; break }
      if (count >= maxUnits) { reason = 'max-units'; break }
      // Extra repair is earned only by complete strictly shrinking failures, within the hard cap.
      if (!gateRetryAllowed) { reason = 'gate-failures'; break }
      phase = 'boundary'
      await refreshVerification()
      await applyRequests()
      if (reason) break
      let status = await deps.status({ ...options, targetRoot: root, tag: options.tag })
      if (status.git?.fetchError) throw new SkillPackageError('원격 판정 실패', [status.git.fetchError])
      // A design opened in this checkout meanwhile: its edits wait for the user, not for units.
      if (status.route === 'design') { reason = 'design'; break }
      if (priorityTask && status.remaining && !status.remaining.some((task) => task.id === priorityTask)) priorityTask = null
      if (repairTask && status.remaining && !status.remaining.some((task) => task.id === repairTask)) repairTask = null
      await reconcileSpecRejected()
      // A spec repair outlives its STATE row: a hand close may have deleted it.
      if (recovery && recovery.reason !== 'spec-gate' && status.remaining && !status.remaining.some((task) => task.id === recovery.taskId)) recovery = null
      if (recovery?.reason === 'spec-gate' && await specRepairOwner(root, recovery.taskId, options.tag, status)) {
        if (priorityTask === recovery.taskId) priorityTask = null
        recovery = null
      }
      if (scope) growScope(status.remaining ?? [])
      // An st outside FORMAT (a hand close from before this run) is repaired like a rejected close:
      // one repair unit, then parked. The closing lint still reports what stays broken.
      if (!recovery && status.issues?.length) {
        const inbox = await deps.status({ ...options, targetRoot: root, section: 'inbox', fetch: false })
        const parked = new Set((inbox.inbox ?? []).filter((entry) => entry.kind === 'parked').flatMap((entry) => entry.refs))
        let issue
        for (const id of new Set(status.issues.filter((entry) => !parked.has(entry.id) && inScope(entry.id)).map((entry) => entry.id))) {
          if (!await specRepairOwner(root, id, options.tag, status)) { issue = status.issues.find((entry) => entry.id === id); break }
        }
        if (issue) {
          recovery = await specFailed(issue.id, status.issues.filter((entry) => entry.id === issue.id).map((entry) => entry.reason === 'missing-state-row' ? `task file ${entry.id} has no spec/STATE.md tasks row (st:${entry.st ?? '(none)'})` : entry.reason === 'stale-done-row' ? `spec/STATE.md tasks row ${entry.id} remains after done@date` : entry.reason === 'unarchived-done' ? `task file ${entry.id} has done@date but remains outside spec/tasks/done` : `${entry.where === 'STATE' ? 'spec/STATE.md tasks row' : 'task file'} ${entry.id} has st:${entry.st ?? '(none)'}, outside FORMAT (todo|doing@date.tag|done@date|blocked@date)`))
          if (!recovery) continue
        }
      }
      if (!recovery && status.implementation?.blocked?.length) {
        const inbox = await deps.status({ ...options, targetRoot: root, section: 'inbox', fetch: false })
        const parked = new Set((inbox.inbox ?? []).filter((entry) => entry.kind === 'parked').flatMap((entry) => entry.refs))
        const taskId = status.implementation.blocked.find((id) => !parked.has(id) && inScope(id))
        if (taskId) { recovery = { reason: 'blocked-task', taskId }; priorityTask = taskId }
      }
      // The closing window, re-measured at every boundary. Not a cancellation: nothing new starts,
      // unpublished code goes through the gate, push and CI now, and a failure queues one repair
      // whose unit must leave room for the gate's re-run.
      reserve = await estimateReserve()
      let repairMs = null
      if (deps.now() >= deadline - reserve.ms - MIN_UNIT_MS) {
        const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
        if (head !== base && head !== lintBlocked && !(failedGate && failedGate.plan === JSON.stringify(batchVerify) && !(await codeChanged(failedGate.head, head)))) { await flush(false, true); continue }
        repairMs = deadline - deps.now() - (reserve.gateMs ?? (failedGate?.ms > 0 ? failedGate.ms : 0)) - (reserve.ciMs ?? 0)
        if (!repairTask || !status.runnable?.includes(repairTask) || repairMs <= 0) { reason = 'final-window'; break }
      }
      const runnable = (status.runnable ?? []).filter(inScope)
      const scoped = scope && !runnable.length ? ((status.remaining ?? []).some((task) => scope.has(task.id)) ? 'scope-blocked' : 'scope-done') : null
      // A unit only executes an existing task: with nothing runnable (and no repair to try below)
      // the run ends. Untasked SSOT deltas, reviews and ideation are the owner's /gusta-sketch.
      const untasked = ['pending', 'reviews', 'ideation'].some((key) => status.sketch?.[key]?.length)
      const idle = !runnable.length && !status.issues?.length
      const finished = scoped ?? (status.parkedOnly ? 'parked-only' : idle ? untasked ? 'needs-sketch' : 'no-work' : null)
      if (finished && !recovery) {
        // Publish before deciding there is no more work: CI can add a repair task.
        const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
        if (head !== base && head !== lintBlocked) { await flush(false, true); if (priorityTask || recovery) continue }
        reason = finished; break
      }
      // A unit ends inside the work window. An explore unit needs its whole timebox, so it starts
      // only when the timebox still fits; any other task fits and is cut at the window if need be.
      const workLeft = deadline - reserve.ms - deps.now()
      const exploreMs = new Map((status.implementation?.explore ?? []).map(({ id, timebox }) => [id, timeboxMs(timebox)]).filter(([, ms]) => ms))
      const unitLimit = (id) => exploreMs.has(id) ? Math.max(timeoutMs, exploreMs.get(id) + EXPLORE_EXIT_MS) : timeoutMs
      const nextTask = status.next?.[0]?.match(/^- gusta-implement-task (T\d+)\b/)?.[1]
      const queued = [priorityTask, ...(status.implementation?.resume ?? []), nextTask, ...runnable].filter((id) => id && runnable.includes(id))
      const selected = repairMs !== null ? repairTask : recovery?.taskId ?? queued.find((id) => !exploreMs.has(id) || unitLimit(id) <= workLeft) ?? null
      if (selected === null && queued.length) { reason = 'explore-no-time'; break }
      // Do not turn an unavailable repair into an unscoped planning unit that could take it anyway.
      if (selected === null && status.route === 'repair' && !recovery) { reason = 'spec-repair-unavailable'; break }
      // Every unit has its task: no unit plans untasked work on its own.
      if (selected === null) { reason = untasked ? 'needs-sketch' : 'no-work'; break }
      const limitMs = repairMs !== null ? Math.min(timeoutMs, Math.max(1, repairMs)) : Math.min(unitLimit(selected), Math.max(1, workLeft))
      if (status.concurrency === 'strict' && context.target) {
        await metadataCommit(`vibe ${options.tag}: session presence`)
        // Repair reserves active.doing atomically while preserving the malformed task row.
        // This also keeps ordinary workers and other repair sessions from claiming the same task.
        await deps.claim({ ...options, targetRoot: root, task: selected, ...(recovery?.reason === 'spec-gate' ? { repairTask: true } : {}) })
        // The claim fetched and pushed the target just now: re-read locally.
        status = await deps.status({ ...options, targetRoot: root, tag: options.tag, fetch: false })
      }
      if (recovery?.reason === 'spec-gate' && await specRepairOwner(root, selected, options.tag, status)) {
        if (priorityTask === selected) priorityTask = null
        recovery = null
        continue
      }
      const before = { head: (await git(root, ['rev-parse', 'HEAD'])).trim(), state: await readFile(path.join(root, 'spec/STATE.md'), 'utf8') }
      await metadata.assertClean()
      // A hand-closed task may have no file left to brief; its repair works from the violations.
      const brief = selected ? await vibeBrief({ targetRoot: root, task: selected, diffBase: before.head }).catch((caught) => { if (recovery?.reason === 'spec-gate') return null; throw caught }) : null
      // What lint already reports is not this unit's doing: the spec gate looks only for new errors.
      const lintBefore = (await deps.lint({ targetRoot: root })).errors
      const dispatched = recovery
      const job = { schemaVersion: 1, role: 'unit', mode: 'autopilot', workspaceMode: 'single', workspace: root, tag: options.tag, report, status: unitStatus(status, selected, recovery), brief,
        cliCommand: [process.execPath, cli], allowTools: allowTool, permissionMode: mode, headlessMcp: mcp, diffBase: before.head, hostManaged: true,
        ...(measurementRun ? { usageMeasurement: measurementRun, unit: count + 1, ...(selected ? { taskId: selected } : {}) } : {}),
        timeLimit: { minutes: Math.max(1, Math.round(limitMs / 60000)), cutAt: new Date(Date.now() + limitMs).toISOString() },
        ...(recovery ? { recovery } : {}) }
      // A continuation consumes its snapshot; once the task is done the ref is dropped.
      if (dispatched?.snapshot && dispatched.reason !== 'split') for (const snapshot of snapshots) if (snapshot.ref === dispatched.snapshot.ref) snapshot.handed = true
      phase = 'unit'; await save()
      const unitStart = deps.now()
      const receipt = await deps.execute({ ...options, ...appliedConfig }, job, directory, { stopFile, deadline, signal: controller.signal, timeoutMs: limitMs })
      count++
      const after = { head: (await git(root, ['rev-parse', 'HEAD'])).trim(), state: await readFile(path.join(root, 'spec/STATE.md'), 'utf8') }
      const cut = CUT.has(receipt.stopped)
      const failed = receipt.exitCode !== 0 || !receipt.result
      const taskId = selected || receipt.result?.id || null
      // Only an unfinished unit's changes are presumed its own attempt and kept aside. A user stop
      // leaves the tree for the user; changes after a unit that reported success may be the owner's,
      // so they stay in place and stop the run (the boundary's assertClean).
      const leftover = failed && (cut || !receipt.stopped) ? await keepLeftover(taskId, receipt.stopped ?? 'failed') : null
      const entry = { ...receipt, unit: count, task: taskId, head: after.head, at: new Date(deps.now()).toISOString(), ms: deps.now() - unitStart, ...(leftover ? { leftover: { ref: leftover.ref, files: leftover.fileCount } } : {}) }
      dispatches.push(entry); pending.push(entry)
      await checkpoint()
      // A real unit's duration sizes the repair buffer of the closing reserve.
      if (!failed) await recordTiming(context.runtime, timingKey('unit'), deps.now() - unitStart)
      const kept = (snapshot) => snapshot && { ref: snapshot.ref, commit: snapshot.commit, base: snapshot.base, files: snapshot.files, fileCount: snapshot.fileCount }
      if (!failed) {
        // A unit owns planning as well as implementation. Give a blocked task a
        // fresh planning unit even if its STATE row is no longer runnable.
        recovery = receipt.result.outcome === 'blocked' && /^T\d+$/.test(taskId ?? '')
          ? { reason: 'blocked-task', taskId, previousResult: receipt.result } : null
        if (recovery) priorityTask = taskId
        if (receipt.result.outcome === 'parked' && taskId === priorityTask) priorityTask = null
        // A completed split narrows the task: its count restarts, and it is not split again.
        if (dispatched?.reason === 'split' && receipt.result.outcome !== 'blocked') ladder.set(dispatched.taskId, { cuts: 0, split: true })
        const assignedTask = selected && !['split', 'blocked-task'].includes(dispatched?.reason) ? selected : null
        if (receipt.result.outcome === 'completed' && (receipt.result.kind === 'task' || (receipt.result.kind === 'fix' && assignedTask))) {
          // The assignment is authoritative; a mismatched receipt cannot close another task or
          // bypass the gate with kind fix or an invalid ID.
          const id = selected ?? receipt.result.id
          if (!TASK_ID.test(id ?? '')) throw new SkillPackageError('completed task receipt has no valid assigned task ID', [String(receipt.result.id)])
          entry.specGate = await specGate(root, id, { lint: deps.lint, baseline: lintBefore })
          if (receipt.result.id !== id) {
            entry.specGate.violations.unshift(`reported task id ${receipt.result.id || '(none)'} does not match assigned task ${id}`)
            entry.specGate.ok = false
          }
          if (!entry.specGate.ok) {
            specRejected.set(id, entry.specGate.violations)
            recovery = await specFailed(id, entry.specGate.violations)
            if (!recovery) entry.parked = true
          } else {
            specRejected.delete(id)
            for (const snapshot of snapshots) if (snapshot.task === id && snapshot.handed && !snapshot.dropped) { await git(root, ['update-ref', '-d', snapshot.ref]); snapshot.dropped = true }
          }
        }
      } else if ((cut || leftover) && /^T\d+$/.test(taskId ?? '')) {
        // An unfinished unit is work for the next fresh unit, not the end of the run.
        const rung = { ...(ladder.get(taskId) ?? { cuts: 0, split: false }) }
        rung.cuts++
        ladder.set(taskId, rung)
        const snapshot = kept(leftover ?? (dispatched?.taskId === taskId ? dispatched.snapshot : null))
        const step = nextRung(rung)
        if (step === 'park') {
          await parkTask(taskId, snapshot)
          entry.parked = true; recovery = null
          if (priorityTask === taskId) priorityTask = null
        } else {
          recovery = { reason: step, cause: receipt.stopped ?? 'failed', taskId, cuts: rung.cuts, split: rung.split, ...(snapshot ? { snapshot } : {}) }
          priorityTask = taskId
        }
      }
      // A unit cut while it was changing things was working, not failing: only an idle cut counts.
      const progressed = before.head !== after.head || before.state !== after.state || Boolean(leftover)
      failureStreak = failed && !(cut && progressed) ? failureStreak + 1 : 0
      noProgress = progressed ? 0 : noProgress + 1
      await save()
      // At most one notice per unit, only when it left the owner something to judge (after any park).
      const judged = judgmentItems(before.state, await readFile(stateFile, 'utf8').catch(() => before.state), receipt.result)
      if (judged.length) notify(() => loopEvent(directory, { runId, tag: options.tag, cwd: root, notifyCommand: options.notifyCommand }, 'needs-judgment', judgmentNotice(count, taskId, judged)))
      if (cut) await event('unit-cut', { unit: count, task: taskId, cause: receipt.stopped, ms: entry.ms, snapshot: leftover?.ref ?? null, next: recovery?.taskId === taskId ? recovery.reason : entry.parked ? 'parked' : null })
      else if (receipt.stopped) {
        reason = receipt.stopped
        if (['stop-file', 'signal', 'max-hours'].includes(reason)) stop(reason)
        else { error = receipt.error ?? `unit stopped: ${reason}`; await event('failed', { reason, error }) }
        break
      }
      if (await present(stopFile)) stop('stop-file')
      if (stopped) { reason = stopReason; break }
      // The full boundary is host-owned: receipt -> metadata -> config -> next unit.
      phase = 'boundary'
      await recordReport(false)
      await metadataCommit(`vibe ${options.tag}: unit report`)
      await metadata.assertClean()
      await applyRequests()
      if (reason) break
      if (failureStreak >= 2) { reason = 'session-failures'; break }
      if (noProgress >= 2) { reason = 'no-progress'; break }
      if (failed) continue
      // Local rows only; the next boundary's status fetches before any remote-dependent decision.
      const afterStatus = await deps.status({ ...options, targetRoot: root, tag: options.tag, fetch: false })
      if (priorityTask && afterStatus.remaining && !afterStatus.remaining.some((task) => task.id === priorityTask)) priorityTask = null
      if (count >= maxUnits) { reason = 'max-units'; break }
      const completed = pending.filter((entry) => ['task', 'fix'].includes(entry.result?.kind) && entry.result.outcome === 'completed' && entry.specGate?.ok !== false).length
      if (appliedConfig.pushEachUnit || completed >= batchSize || !afterStatus.runnable?.length) await flush(false, Boolean(appliedConfig.pushEachUnit && context.target))
    }
  } catch (caught) {
    if (controller.signal.aborted || stopReason) reason = stopReason ?? 'cancelled'
    else { reason = 'failed'; error = caught.message; await event('failed', { error }) }
  }
  finally {
    if (initialized) {
      try {
        phase = 'finalizing'
        await metadataStep('active-end', () => metadata.beat(true))
        // Failed units left nothing behind (keepLeftover), so the work earlier units committed
        // still goes through the gate and out. Only a host error or a cancellation skips it.
        if (!error && !controller.signal.aborted && deps.now() < deadline) await flush(true)
      } catch (caught) {
        if (controller.signal.aborted || stopReason) reason = stopReason ?? reason
        else { error ??= caught.message; reason = 'failed'; await event('failed', { error: caught.message }) }
      }
    }
    // Also report preflight/no-work exits, before the owned spec report exists.
    if (measurementRun) measurement = await finishUsageRun(measurementRun, dispatches.length)
    if (initialized) {
      // Always persist the final reason and commit the owned report, including failures.
      try { await recordReport(true); await metadataCommit(`vibe ${options.tag}: stopped (${reason})`) }
      catch { /* metadataStep recorded a separate operational error and durable journal */ }
    }
    if (awake) await vibeAwake({ targetRoot: root, stop: true }).catch(async (caught) => {
      operationalErrors.push({ operation: 'awake-end', error: caught.message })
      await event('metadata-error', { operation: 'awake-end', error: caught.message })
    })
    // After the last push: this loop's wip/<tag> and merged work leftovers (prune-branches). A failed
    // loop keeps its snapshot for recovery; a prune error is reported, never a loop failure.
    if (initialized && !error) pruned = await deps.prune({ ...options, targetRoot: root, tag: options.tag }).catch((caught) => ({ ok: false, error: caught.message }))
    clearInterval(watcher)
    if (watching) await watching
    closing = true
    try {
      await controlTransaction(path.join(directory, 'requests-control'), async () => {
        for (const request of await readRequests(directory, runId)) {
          if (request.status !== 'pending') continue
          const applied = configHistory.find((entry) => entry.id === request.id)
          await atomicJSON(requestPath(directory, request), applied ?? { ...request, status: 'cancelled', reason })
        }
        await save()
      })
      if (reason === 'session-failures') await event('failed', { reason })
      await event('stopped', { reason, error })
    } catch (caught) {
      operationalErrors.push({ operation: 'final-state', error: caught.message })
      await event('failed', { operation: 'final-state', error: caught.message })
      // Separate fallback lets status/supervision recognize a failed final manifest write.
      await atomicJSON(path.join(directory, 'terminal.json'), { ...snapshot(), running: false, status: 'failed', error: error ?? caught.message })
    } finally { process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted); await releaseLoop(lock, runId) }
    // Every terminal state ends with one summary for the owner, after the lock is free.
    await Promise.all(deliveries)
    const closed = { ...snapshot(), report: await present(reportPath) ? report : null }
    await notify(async () => finishedEvent(directory, { runId, tag: options.tag, cwd: root, notifyCommand: options.notifyCommand }, finishedSummary(closed, await readFile(stateFile, 'utf8').catch(() => ''))))
  }
  const terminalEvent = await readJSON(plan.notification.terminalEvent).catch(() => null)
  return { ...plan, verify, batchVerify, requiredVerificationTiers, limits: { ...plan.limits, maxHours: hours }, deadline: new Date(deadline).toISOString(), workDeadline: new Date(deadline - reserve.ms).toISOString(), reserve, gate: gateState(), objectiveComplete: false, continuation: continuation(), notification: { ...plan.notification, ...(terminalEvent?.runId === runId ? { delivery: terminalEvent.delivery, deliveredToHook: terminalEvent.deliveredToHook, receipt: terminalEvent.receipt } : {}) }, runId, ok: !error && !operationalErrors.length && reason !== 'session-failures', reason, ...(loopHint(reason) ? { hint: loopHint(reason) } : {}), stopReason, error, operationalErrors, appliedConfig, configHistory, units: count, report, pruned, codePushed, priorityTask, recovery, manifest,
    time: timeBreakdown({ dispatches, batches, totalMs: deps.now() - start }), ...(measurement ? { measurement } : {}) }
}
