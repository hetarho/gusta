import { readFile, writeFile, mkdir, rm, open, access, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { vibeStatus, vibeSession, vibePreflight, vibePush, vibeAwake, vibeCheckpoint, vibeSync, vibeClaim } from './vibe.mjs'
import { readVerification, vibeBrief } from './vibe-brief.mjs'
import { runVibeCheck } from './vibe-check.mjs'
import { vibeCIWait } from './vibe-ci.mjs'
import { git } from './workspace.mjs'
import { readTimings, recordTiming, timingKey, measured } from './check-cache.mjs'
import { inspectWork } from './work-groups.mjs'
import { SESSION_TAG } from './spec-format.mjs'
import { sections, tableRows } from './spec-format.mjs'
import { validateAgentResult } from './agent-adapter.mjs'
import { SkillPackageError } from './errors.mjs'
import { acquireLoop, releaseLoop, bindLoopDirectory, atomicJSON, readJSON, readRequests, requestPath, requestControl, inspectLoop, loopEvent, startLoopMonitor, controlTransaction, processAlive } from './loop-control.mjs'
import { LoopMetadata, recoverLoopMetadata } from './loop-metadata.mjs'

const cli = fileURLToPath(new URL('../bin/haeram-spec-creator.mjs', import.meta.url))
const adapter = fileURLToPath(new URL('../bin/haeram-agent-adapter.mjs', import.meta.url))
const present = (file) => access(file).then(() => true, () => false)
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
// The closing reserve is what the last gate really costs: the measured suite, one repair
// unit and the suite's re-run, plus the measured CI wait when code is pushed. Only before
// the gate has ever been measured does a run fall back to a share of max-hours.
export const UNMEASURED_RESERVE_SHARE = 0.2
export function closingReserve({ timings, commands, push = false, hours, timeoutMs, optionHours }) {
  if (optionHours !== undefined) return { ms: optionHours * 3600000, source: 'option' }
  const gates = commands.map((command) => measured(timings, timingKey('final', command)))
  if (!commands.length || gates.includes(null)) return { ms: Math.round(hours * 60 * UNMEASURED_RESERVE_SHARE) * 60000, source: 'unmeasured' }
  const gateMs = gates.reduce((sum, ms) => sum + ms, 0)
  const fixMs = measured(timings, timingKey('unit')) ?? timeoutMs
  const ciMs = push ? measured(timings, timingKey('ci')) ?? 0 : 0
  return { ms: 2 * gateMs + fixMs + ciMs, source: 'measured', gateMs, fixMs, ciMs }
}
const positive = (value, fallback, label, integer = false) => {
  const n = Number(value ?? fallback)
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isSafeInteger(n))) throw new SkillPackageError(`${label}: 양수가 필요합니다.`)
  return n
}

// One adapter invocation is one new provider process. Logs and session IDs are
// persisted before parsing a result; retries never resume a previous context.
export async function executeVibeUnit(options, job, directory, limits = {}) {
  const id = randomUUID(), logPath = path.join(directory, `${id}.log`), sessionFile = path.join(directory, `${id}.session`)
  let config = { command: process.execPath, args: [adapter, '--provider', options.provider, ...(options.model ? ['--model', options.model] : [])] }
  if (options.adapter) {
    const file = path.resolve(options.adapter)
    config = JSON.parse(await readFile(file, 'utf8'))
    if (!config?.command || !Array.isArray(config.args) || config.args.some((value) => typeof value !== 'string')) throw new SkillPackageError('adapter에는 command와 문자열 args 배열이 필요합니다.')
    if (config.command.includes('/') && !path.isAbsolute(config.command)) config.command = path.resolve(path.dirname(file), config.command)
  }
  const log = await open(logPath, 'w', 0o600)
  await writeFile(path.join(directory, `${id}.job.json`), JSON.stringify({ ...job, sessionFile }, null, 2))
  let output = '', forced, stopped = null
  try {
    return await new Promise((resolve) => {
      const child = spawn(config.command, config.args, { cwd: job.workspace, env: { ...process.env, ...options.env,
        HAERAM_VIBE_UNIT: '1', HAERAM_VIBE_TAG: options.tag, HAERAM_DIFF_BASE: job.diffBase, HAERAM_TIER: 'task' },
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
        let result = null
        if (code === 0 && !stopped) {
          try { result = validateAgentResult('unit', JSON.parse(output.trim().split('\n').at(-1))) }
          catch (parseError) { error = parseError.message }
        }
        const session = await readFile(sessionFile, 'utf8').catch(() => null)
        resolve({ dispatch: id, exitCode: code, stopped, error: error ?? null, result, session: session?.trim() ?? null, log: logPath })
      }
      child.stdout.on('data', (chunk) => { output += chunk; if (output.length > 1024 * 1024) stop('output-limit') })
      child.on('error', (error) => finish(127, error.message))
      child.on('close', (code) => finish(code ?? 1))
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify({ ...job, sessionFile }))
    })
  } finally {
    await log.writeFile(`\n${output.slice(-1024 * 1024)}\n`)
    await log.close()
  }
}

export async function vibeLoop(options = {}, injected = {}) {
  if (!SESSION_TAG.test(options.tag ?? '')) throw new SkillPackageError('--tag에는 영숫자 2-8자가 필요합니다.')
  const control = ['stop', 'stopAfterUnit', 'configure', 'status', 'recoverMetadata'].filter((name) => options[name])
  if (control.length > 1) throw new SkillPackageError('loop 제어 동작은 하나만 지정하세요.')
  if (control.length && (options.dryRun || options.detach)) throw new SkillPackageError('실행 중 제어에는 --dry-run 또는 --detach를 함께 쓰지 않습니다.')
  if (!control.length && !options.adapter && !['claude', 'codex'].includes(options.provider)) throw new SkillPackageError('--provider claude|codex가 필요합니다.')
  if (!['acceptEdits', 'bypass'].includes(options.permissionMode ?? 'acceptEdits')) throw new SkillPackageError('--permission-mode는 acceptEdits 또는 bypass입니다.')
  if (options.notifyCommand !== undefined && (typeof options.notifyCommand !== 'string' || !options.notifyCommand.trim())) throw new SkillPackageError('--notify-command에는 실행 가능한 명령이 필요합니다.')
  const maxUnits = positive(options.maxUnits, 100, 'max-units', true), hours = positive(options.maxHours, 8, 'max-hours')
  const batchSize = positive(options.batchSize, 3, 'batch-size', true), timeoutMs = positive(options.timeoutMs, 3600000, 'timeout-ms')
  const optionHours = options.finalReserveHours === undefined ? undefined : Number(options.finalReserveHours)
  if (optionHours !== undefined && (!Number.isFinite(optionHours) || optionHours < 0 || optionHours >= hours)) throw new SkillPackageError('final-reserve-hours: 0 이상 max-hours 미만이 필요합니다.')
  const context = await vibeSession(options), root = context.root
  const directory = path.join(context.runtime, 'loops', options.tag), stopFile = path.join(directory, 'STOP'), manifest = path.join(directory, 'loop.json')
  const lock = path.join(context.workspace.git.gitDir, 'haeram-vibe-loop.lock')
  const deps = { status: vibeStatus, preflight: vibePreflight, execute: executeVibeUnit, sync: vibeSync, claim: vibeClaim, push: vibePush, ci: vibeCIWait, check: runVibeCheck, checkpoint: vibeCheckpoint, now: Date.now, monitor: startLoopMonitor, fault: async () => {}, ...injected }
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
  const state = await deps.status({ ...options, tag: options.tag })
  const verify = await readVerification(root)
  const batchVerify = options.verify ?? verify.batch
  if (!Array.isArray(batchVerify) || batchVerify.some((command) => typeof command !== 'string' || !command.trim())) throw new SkillPackageError('--verify에는 실행 가능한 명령이 필요합니다.')
  // The tail of a timed run belongs to the closing gate (full suites, push, CI): no new work
  // starts inside it, so implementation time never eats the verification.
  const estimateReserve = async () => closingReserve({ timings: await readTimings(context.runtime), commands: batchVerify, push: Boolean(context.target), hours, timeoutMs, optionHours })
  let reserve = await estimateReserve()
  if (reserve.ms >= hours * 3600000) throw new SkillPackageError(`마감 관문 실측(전체 검증 2회+수정 1회+CI)이 ${(reserve.ms / 3600000).toFixed(2)}시간이라 max-hours 안에 구현 시간이 없습니다. --max-hours를 늘리거나 --final-reserve-hours를 지정하세요.`)
  const plan = { schemaVersion: 1, controlVersion: 1, tag: options.tag, provider: options.provider ?? 'command', permissionMode: options.permissionMode ?? 'acceptEdits',
    cwd: root, concurrency: state.concurrency, route: state.route, limits: { maxUnits, maxHours: hours, batchSize, timeoutMs }, reserve, verify, batchVerify,
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
      const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/haeram-vibe-loop.mjs', import.meta.url)), config], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], env: options.env ?? process.env })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
      const readyUntil = Date.now() + 10000
      while (Date.now() < readyUntil) {
        const ready = await readJSON(manifest)
        if (ready?.runId === runId) return { ...plan, ok: true, detached: true, runId, pid: child.pid, ready: true, status: ready.status, log: logPath }
        if (child.exitCode !== null) throw new SkillPackageError('loop host failed before ownership acknowledgement', [logPath])
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new SkillPackageError('loop host ownership acknowledgement timed out; inspect status before retry', [logPath])
    } finally { await log.close() }
  }
  const runId = options.runId ?? randomUUID()
  await acquireLoop(lock, { pid: process.pid, host: os.hostname(), tag: options.tag, runId })
  const start = deps.now(), deadline = start + hours * 3600000
  const report = `spec/reports/${new Date(start).toISOString().slice(2, 10).replaceAll('-', '')}-${options.tag}.md`
  const reportPath = path.join(root, report)
  let initialized = false, awake = false, stopped = false, reason = null, error = null, base = context.workspace.git.head, pending = [], failureStreak = 0, noProgress = 0, count = 0, codePushed = false
  let priorityTask = /^T\d+$/.test(previous?.priorityTask ?? '') ? previous.priorityTask : null
  // repairTask: the gate/CI repair this run queued. failedGate: the code a gate last failed on.
  let repairTask = null, failedGate = null, gateFailures = 0
  let recovery = previous?.recovery?.reason === 'blocked-task' && /^T\d+$/.test(previous.recovery.taskId ?? '') ? previous.recovery : null
  const dispatches = [], batches = []
  const operationalErrors = [], configHistory = []
  const appliedConfig = { pushEachUnit: Boolean(options.pushEachUnit) }
  let requestedConfig = { ...appliedConfig }, phase = 'preflight', heartbeatAt = new Date().toISOString(), supervisor = null, closing = false
  const metadata = new LoopMetadata(root, directory, report, options.tag, runId, { fault: deps.fault })
  const controller = new AbortController()
  let stopReason = null, watching = null, checkpointAt = start
  const event = async (type, detail = {}) => {
    try { await loopEvent(directory, { runId, tag: options.tag, cwd: root, notifyCommand: options.notifyCommand }, type, detail) }
    catch (caught) { operationalErrors.push({ operation: 'event-write', error: caught.message }); process.stderr.write(`loop event-write failed: ${caught.message}\n`) }
  }
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
  const snapshot = () => ({ ...plan, runId, host: os.hostname(), pid: process.pid, startedAt: new Date(start).toISOString(), deadline: new Date(deadline).toISOString(), workDeadline: new Date(deadline - reserve.ms).toISOString(), reserve, heartbeatAt,
    status: closing ? error || operationalErrors.length || reason === 'session-failures' ? 'failed' : controller.signal.aborted ? 'cancelled' : 'stopped' : phase,
    ...(closing ? { endedAt: new Date().toISOString() } : {}),
    report, units: count, dispatches, batches, priorityTask, recovery, reason, stopReason, error, operationalErrors, requestedConfig, appliedConfig, configHistory, supervisor, running: !closing })
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
    const lines = pending.map((entry) => `- ${entry.result?.kind ?? 'session'} ${entry.result?.id ?? '-'}: ${entry.result?.outcome ?? (entry.stopped ? `cancelled (${entry.stopped})` : 'failed')} (${entry.head.slice(0, 12)})`).filter((line) => !text.includes(line))
    if (lines.length) text = text.replace('\n## decided', `${lines.join('\n')}\n\n## decided`)
    const current = await deps.status({ ...options, targetRoot: root, section: 'inbox', fetch: false })
    for (const kind of ['decided', 'parked']) {
      const entries = current.inbox?.filter((entry) => entry.kind === kind).map((entry) => entry.line) ?? []
      const next = kind === 'decided' ? 'parked' : 'checks'
      const fresh = entries.filter((line) => !text.includes(line))
      if (fresh.length) text = text.replace(`\n## ${next}`, `${fresh.join('\n')}\n\n## ${next}`)
    }
    const checks = batches.map((entry) => entry.ci ? `- CI ${entry.ci.commit ?? '-'}: ${entry.ci.outcome} ${entry.ci.runUrl ?? ''}` : `- ${entry.command}: ${entry.cancelled ? 'cancelled' : entry.ok ? 'pass' : 'fail'} (${entry.log ?? '-'})`)
      .filter((line) => !text.includes(line))
    if (checks.length) text = text.replace('\n## next', `${checks.join('\n')}\n\n## next`)
    if (closing) text = text.replace(/## next[\s\S]*$/, `## next\n- loop stopped: ${reason}\n${priorityTask ? `- priority task: ${priorityTask}\n` : ''}`)
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
      if (request.type !== 'configure' || typeof request.requested?.pushEachUnit !== 'boolean') throw new Error('invalid loop configuration request')
      requestedConfig = { ...request.requested }
      await save()
      // Faults before/after mutation remain in this same host; no worker handoff.
      await deps.fault('config-before-apply')
      Object.assign(appliedConfig, requestedConfig)
      const acknowledgement = { ...request, status: 'applied', actual: { ...appliedConfig }, appliedAt: new Date().toISOString(), afterUnit: count }
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
    text = text.replace(/## next\n[\s\S]*?(?=\n## |$)/, `## next\n- implement-task ${id}\n`)
    await writeFile(file, text)
    await git(root, ['add', '--', file, taskPath])
    await git(root, ['commit', '--quiet', '--only', '-m', `create-task ${id}: ${title}`, '--', file, taskPath])
    priorityTask = repairTask = id
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
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
    const code = await codeChanged(base, head)
    if (code && publish) {
      if (!batchVerify.length) throw new SkillPackageError('코드 push 전 묶음 검증이 없습니다. ARCH batch 단계 또는 --verify를 지정하세요.')
      // The same code already failed: re-running the suite cannot pass.
      if (failedGate && !(await codeChanged(failedGate.head, head))) {
        if (closing) throw new SkillPackageError(`묶음 검증 실패: ${failedGate.command}`, [failedGate.log ?? ''])
        return false
      }
      for (const command of batchVerify) {
        await ensureActive()
        let checked
        // The gate may use its whole reserve even when a unit's timeout is shorter.
        try { checked = await deps.check({ targetRoot: root, tier: 'batch', diffBase: base, heavy: true, signal: controller.signal, timeoutMs: Math.min(Math.max(timeoutMs, reserve.ms), Math.max(1, deadline - deps.now())) }, command) }
        catch (caught) { batches.push({ command, ok: false, cancelled: controller.signal.aborted, error: caught.message }); throw caught }
        batches.push({ command, ...checked, ...(!checked.ok && controller.signal.aborted ? { cancelled: true } : {}) })
        await ensureActive()
        if (!checked.ok) {
          failedGate = { head, command, log: checked.log ?? null }; gateFailures++
          await queueRepair('fix-gate', 'Fix final gate failure', `Make \`${command}\` pass on ${head}; preserve existing contracts.`,
            [`Log: ${checked.log ?? '-'}`, `Failed tests: ${JSON.stringify(checked.failedTests ?? [])}`, `Tail: ${JSON.stringify(checked.tail ?? [])}`])
          await recordReport(closing)
          await metadataCommit(`vibe ${options.tag}: record checks`)
          if (closing) throw new SkillPackageError(`묶음 검증 실패: ${command}`, [checked.log ?? ''])
          return false
        }
      }
      failedGate = null; gateFailures = 0
    }
    await recordReport(closing)
    await metadataCommit(`vibe ${options.tag}: record checks`)
    // base stays at the last published commit, so the next publish still sees this code.
    if (!publish) { pending = []; await save(); return true }
    await ensureActive()
    await metadata.assertClean()
    const pushed = await deps.push({ ...options, targetRoot: root, ...(code ? { verifiedCommit: head } : {}) })
    if (pushed.ok === false) throw new SkillPackageError('묶음 push 실패')
    if (pushed.pushed && code) {
      codePushed = true
      const ci = await deps.ci({ ...options, targetRoot: root, signal: controller.signal, timeoutMs: Math.max(1, deadline - deps.now()), commit: pushed.pushed, branch: context.target, diffBase: base })
      batches.push({ ci })
      if (!ci.ok && ci.outcome === 'cancelled') throw new SkillPackageError('CI 대기가 중지됐습니다.')
      if (!['skipped', 'cancelled'].includes(ci.outcome) && Number.isFinite(ci.ms)) await recordTiming(context.runtime, timingKey('ci'), ci.ms)
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
    await event('started')
    // Never adopt pre-existing source, SSOT, STATE, report or index changes.
    if ((await git(root, ['status', '--porcelain'])).trim()) throw new SkillPackageError('loop 시작 전 미커밋 변경을 보존합니다. 먼저 정리하세요.')
    const allowTool = [...new Set(['Bash(git *)', `Bash(${process.execPath} ${cli} *)`, ...(options.allowTool ?? [])])]
    const probe = options.probe ?? `git status --porcelain${context.target ? ` && git push --dry-run ${quote(context.remote)} ${quote(`HEAD:refs/heads/${context.target}`)}` : ''}`
    const preflight = await deps.preflight({ ...options, targetRoot: root, signal: controller.signal, probe, allowTool, probeWorkspace: 'current', probeTimeoutMs: Math.min(Number(options.probeTimeoutMs ?? 900000), Math.max(1, deadline - deps.now())) })
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
      // The gate failed again after its repair: the closing flush reports it, nothing re-runs.
      if (gateFailures >= 2) { reason = 'gate-failures'; break }
      phase = 'boundary'
      await applyRequests()
      if (reason) break
      let status = await deps.status({ ...options, targetRoot: root, tag: options.tag })
      if (status.git?.fetchError) throw new SkillPackageError('원격 판정 실패', [status.git.fetchError])
      // A design opened in this checkout meanwhile: its edits wait for the user, not for units.
      if (status.route === 'design') { reason = 'design'; break }
      if (priorityTask && status.remaining && !status.remaining.some((task) => task.id === priorityTask)) priorityTask = null
      if (repairTask && status.remaining && !status.remaining.some((task) => task.id === repairTask)) repairTask = null
      if (recovery && status.remaining && !status.remaining.some((task) => task.id === recovery.taskId)) recovery = null
      if (!recovery && status.implementation?.blocked?.length) {
        const inbox = await deps.status({ ...options, targetRoot: root, section: 'inbox', fetch: false })
        const parked = new Set((inbox.inbox ?? []).filter((entry) => entry.kind === 'parked').flatMap((entry) => entry.refs))
        const taskId = status.implementation.blocked.find((id) => !parked.has(id))
        if (taskId) { recovery = { reason: 'blocked-task', taskId }; priorityTask = taskId }
      }
      // The closing window, re-measured at every boundary. Not a cancellation: nothing new starts,
      // unpublished code goes through the gate, push and CI now, and a failure queues one repair
      // whose unit must leave room for the gate's re-run.
      reserve = await estimateReserve()
      let repairMs = null
      if (deps.now() >= deadline - reserve.ms) {
        const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
        if (head !== base && !(failedGate && !(await codeChanged(failedGate.head, head)))) { await flush(false, true); continue }
        repairMs = deadline - deps.now() - (reserve.gateMs ?? 0)
        if (!repairTask || !status.runnable?.includes(repairTask) || repairMs <= 0) { reason = 'final-window'; break }
      }
      const finished = status.parkedOnly ? 'parked-only' : status.settled || status.route === 'ideation-first' ? 'no-work' : null
      if (finished && !recovery) {
        // Publish before deciding there is no more work: CI can add a repair task.
        if ((await git(root, ['rev-parse', 'HEAD'])).trim() !== base) { await flush(false, true); if (priorityTask || recovery) continue }
        reason = finished; break
      }
      const nextTask = status.next?.[0]?.match(/^- implement-task (T\d+)\b/)?.[1]
      const selected = repairMs !== null ? repairTask : recovery?.taskId ?? (status.runnable?.includes(priorityTask) ? priorityTask : null) ?? status.implementation?.resume?.find((id) => status.runnable?.includes(id)) ?? (status.runnable?.includes(nextTask) ? nextTask : null) ?? status.runnable?.[0]
      if (status.concurrency === 'strict' && context.target) {
        await metadataCommit(`vibe ${options.tag}: session presence`)
        await deps.claim({ ...options, targetRoot: root, task: selected })
        status = await deps.status({ ...options, targetRoot: root, tag: options.tag })
      }
      const before = { head: (await git(root, ['rev-parse', 'HEAD'])).trim(), state: await readFile(path.join(root, 'spec/STATE.md'), 'utf8') }
      await metadata.assertClean()
      const brief = selected ? await vibeBrief({ targetRoot: root, task: selected, diffBase: before.head }) : null
      const job = { schemaVersion: 1, role: 'unit', mode: 'autopilot', workspaceMode: 'single', workspace: root, tag: options.tag, report, status, brief,
        cliCommand: [process.execPath, cli], allowTools: allowTool, permissionMode: options.permissionMode ?? 'acceptEdits', diffBase: before.head, hostManaged: true,
        ...(recovery ? { recovery } : {}) }
      phase = 'unit'; await save()
      const unitStart = deps.now()
      const receipt = await deps.execute({ ...options, ...appliedConfig }, job, directory, { stopFile, deadline, signal: controller.signal, timeoutMs: Math.min(timeoutMs, Math.max(1, repairMs ?? deadline - deps.now())) })
      count++
      const after = { head: (await git(root, ['rev-parse', 'HEAD'])).trim(), state: await readFile(path.join(root, 'spec/STATE.md'), 'utf8') }
      const entry = { ...receipt, unit: count, head: after.head, at: new Date(deps.now()).toISOString() }
      dispatches.push(entry); pending.push(entry)
      await checkpoint()
      const failed = receipt.exitCode !== 0 || !receipt.result
      // A real unit's duration sizes the repair buffer of the closing reserve.
      if (!failed) await recordTiming(context.runtime, timingKey('unit'), deps.now() - unitStart)
      if (!failed) {
        const taskId = receipt.result.id || selected
        // A unit owns planning as well as implementation. Give a blocked task a
        // fresh planning unit even if its STATE row is no longer runnable.
        recovery = receipt.result.outcome === 'blocked' && /^T\d+$/.test(taskId ?? '')
          ? { reason: 'blocked-task', taskId, previousResult: receipt.result } : null
        if (recovery) priorityTask = taskId
        if (receipt.result.outcome === 'parked' && taskId === priorityTask) priorityTask = null
      }
      failureStreak = failed ? failureStreak + 1 : 0
      noProgress = before.head === after.head && before.state === after.state ? noProgress + 1 : 0
      await save()
      if (receipt.stopped) {
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
      const afterStatus = await deps.status({ ...options, targetRoot: root, tag: options.tag })
      if (priorityTask && afterStatus.remaining && !afterStatus.remaining.some((task) => task.id === priorityTask)) priorityTask = null
      if (count >= maxUnits) { reason = 'max-units'; break }
      const completed = pending.filter((entry) => ['task', 'fix'].includes(entry.result?.kind) && entry.result.outcome === 'completed').length
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
        if (!error && failureStreak === 0 && !controller.signal.aborted && deps.now() < deadline) await flush(true)
      } catch (caught) {
        if (controller.signal.aborted || stopReason) reason = stopReason ?? reason
        else { error ??= caught.message; reason = 'failed'; await event('failed', { error: caught.message }) }
      }
      // Always persist the final reason and commit the owned report, including failures.
      try { await recordReport(true); await metadataCommit(`vibe ${options.tag}: stopped (${reason})`) }
      catch { /* metadataStep recorded a separate operational error and durable journal */ }
    }
    if (awake) await vibeAwake({ targetRoot: root, stop: true }).catch(async (caught) => {
      operationalErrors.push({ operation: 'awake-end', error: caught.message })
      await event('metadata-error', { operation: 'awake-end', error: caught.message })
    })
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
  }
  return { ...plan, reserve, runId, ok: !error && !operationalErrors.length && reason !== 'session-failures', reason, stopReason, error, operationalErrors, appliedConfig, configHistory, units: count, report, codePushed, priorityTask, recovery, manifest }
}
