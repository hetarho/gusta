import { readFile, writeFile, mkdir, rename, rm, readdir, appendFile, open } from 'node:fs/promises'
import { openSync, writeFileSync, closeSync, readFileSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { SkillPackageError } from './errors.mjs'

export const processAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
export async function readJSON(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export async function atomicJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, file) }
  finally { await rm(temporary, { force: true }) }
}

// Short control transactions serialize stale-owner reclamation with acquisition.
// Synchronous creation+write avoids exposing an empty lock to another JS turn.
export async function controlTransaction(lock, run) {
  const guard = `${lock}.control`, arbiter = `${lock}.arbiter`
  await mkdir(path.dirname(lock), { recursive: true })
  let acquired = false
  for (let attempt = 0; attempt < 100; attempt++) {
    let fd
    try {
      fd = openSync(arbiter, 'wx', 0o600)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      await new Promise((resolve) => setTimeout(resolve, 20))
      continue
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname() }))
      let owner = null
      try { owner = JSON.parse(readFileSync(guard, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (owner?.host === os.hostname() && !processAlive(owner.pid)) { unlinkSync(guard); owner = null }
      if (!owner) {
        const guardFD = openSync(guard, 'wx', 0o600)
        try { writeFileSync(guardFD, JSON.stringify({ pid: process.pid, host: os.hostname() })) } finally { closeSync(guardFD) }
        acquired = true
      }
    } finally { closeSync(fd); unlinkSync(arbiter) }
    if (acquired) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!acquired) throw new SkillPackageError('loop control transaction is busy; preserve abandoned control records for inspection', [guard, arbiter])
  try { return await run() } finally { await rm(guard, { force: true }) }
}

export async function acquireLoop(lock, owner) {
  return controlTransaction(lock, async () => {
    const previous = await readJSON(lock)
    if (previous && (previous.host !== os.hostname() || processAlive(previous.pid))) throw new SkillPackageError('이 checkout에서 vibe loop가 실행 중입니다.', [JSON.stringify(previous)])
    await atomicJSON(lock, owner)
    return previous
  })
}
export async function bindLoopDirectory(directory, root) {
  await controlTransaction(path.join(directory, 'tag'), async () => {
    const file = path.join(directory, 'binding.json')
    const binding = await readJSON(file), state = await readJSON(path.join(directory, 'loop.json'))
    const existing = binding?.cwd ?? state?.cwd
    if (existing && existing !== root) throw new SkillPackageError('이 tag는 다른 checkout 소유입니다.', [existing])
    await atomicJSON(file, { cwd: root })
  })
}
export async function releaseLoop(lock, runId) {
  await controlTransaction(lock, async () => { if ((await readJSON(lock))?.runId === runId) await rm(lock, { force: true }) })
}

export async function loopEvent(directory, state, type, detail = {}) {
  const event = { schemaVersion: 1, id: randomUUID(), runId: state.runId, tag: state.tag, at: new Date().toISOString(), type, ...detail }
  await appendFile(path.join(directory, 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 })
  // This local, durable outbox is the notification transport. No external delivery is claimed.
  if (['failed', 'host-lost', 'heartbeat-stale', 'metadata-error', 'supervisor-error'].includes(type)) {
    const receiptPath = path.join(directory, 'notifications', `${event.id}.json`)
    let receipt = { ...event, transport: state.notifyCommand ? 'command' : 'local-file', delivery: 'pending', deliveredToHook: false, externalDelivered: false }
    await atomicJSON(receiptPath, receipt)
    process.stderr.write(`vibe loop ${state.tag}: ${type}: ${detail.error ?? detail.reason ?? ''} (${directory})\n`)
    if (state.notifyCommand) {
      const log = await open(path.join(directory, 'notification.log'), 'a', 0o600)
      try {
        const acknowledged = await new Promise((resolve) => {
          const child = spawn(state.notifyCommand, { shell: true, cwd: state.cwd ?? directory, detached: process.platform !== 'win32', stdio: ['pipe', log.fd, log.fd] })
          let timedOut = false
          const timer = setTimeout(() => {
            timedOut = true
            try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch {}
          }, 10000)
          child.once('error', () => { clearTimeout(timer); resolve(false) })
          child.once('close', (code) => { clearTimeout(timer); resolve(code === 0 && !timedOut) })
          child.stdin.on('error', () => {})
          child.stdin.end(`${JSON.stringify(event)}\n`)
        })
        receipt = { ...receipt, delivery: acknowledged ? 'hook-acknowledged' : 'failed', deliveredToHook: acknowledged, attemptedAt: new Date().toISOString() }
      } finally { await log.close() }
      await atomicJSON(receiptPath, receipt)
    }
  }
  return event
}

export async function inspectLoop(directory, root) {
  let state = await readJSON(path.join(directory, 'loop.json'))
  if (!state) throw new SkillPackageError('loop 상태가 없습니다.', [directory])
  const terminal = await readJSON(path.join(directory, 'terminal.json'))
  if (terminal?.runId === state.runId) state = { ...state, ...terminal }
  if (state.cwd !== root) throw new SkillPackageError('이 tag는 다른 checkout 소유입니다.', [state.cwd])
  let health = state.running ? 'running' : 'stopped'
  if (state.running) {
    if (state.host && state.host !== os.hostname()) health = 'unknown-host'
    else if (!processAlive(state.pid)) health = 'host-lost'
    else if (!(Date.now() - Date.parse(state.heartbeatAt ?? state.startedAt) <= 60000)) health = 'heartbeat-stale'
  }
  const requests = await readRequests(directory, state.runId)
  if (['running', 'heartbeat-stale'].includes(health) && state.supervisor?.pid && !processAlive(state.supervisor.pid)) health = 'supervisor-lost'
  const requestedConfig = requests.filter((request) => request.status === 'pending' && request.type === 'configure').at(-1)?.requested ?? state.requestedConfig
  return { ...state, requestedConfig, health, running: health === 'host-lost' ? false : state.running, requests, ok: !['host-lost', 'heartbeat-stale', 'unknown-host', 'supervisor-lost'].includes(health) && state.status !== 'failed' && !state.error && !(state.operationalErrors?.length), notification: { transport: state.notifyCommand ? 'command' : 'local-file', directory: path.join(directory, 'notifications'), externalDelivered: false } }
}
export async function readRequests(directory, runId) {
  const dir = path.join(directory, 'requests')
  const names = await readdir(dir).catch((error) => { if (error.code === 'ENOENT') return []; throw error })
  const requests = []
  for (const name of names.filter((name) => name.endsWith('.json')).sort()) {
    const request = await readJSON(path.join(dir, name))
    if (request?.runId === runId) requests.push(request)
  }
  return requests
}
export const requestPath = (directory, request) => path.join(directory, 'requests', `${request.id}.json`)

export async function requestControl(directory, root, options) {
  const waitMs = Number(options.waitMs ?? 0)
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new SkillPackageError('--wait-ms에는 0 이상의 값이 필요합니다.')
  if (options.status) return inspectLoop(directory, root)
  const request = await controlTransaction(path.join(directory, 'requests-control'), async () => {
    const state = await inspectLoop(directory, root)
    if (state.controlVersion !== 1 || !state.runId) throw new SkillPackageError('이 호스트는 실행 중 제어를 지원하지 않습니다. 기존 실행을 보존하고 다음 명시적 실행부터 새 버전을 사용하세요.')
    if (!state.running || state.health !== 'running') throw new SkillPackageError('실행 중인 건강한 loop에만 요청할 수 있습니다.', [state.health])
    const type = options.stopAfterUnit ? 'stop-after-unit' : 'configure'
    if (type === 'configure' && typeof options.pushEachUnit !== 'boolean') throw new SkillPackageError('--configure에는 --push-each-unit 또는 --no-push-each-unit이 필요합니다.')
    const sequence = Math.max(0, ...state.requests.map((request) => request.sequence ?? 0)) + 1
    const request = { schemaVersion: 1, id: `${String(sequence).padStart(8, '0')}-${randomUUID()}`, sequence, runId: state.runId, type, requestedAt: new Date().toISOString(), status: 'pending', ...(type === 'configure' ? { requested: { pushEachUnit: options.pushEachUnit } } : {}) }
    await atomicJSON(requestPath(directory, request), request)
    return request
  })
  const until = Date.now() + waitMs
  let receipt = request
  while (receipt.status === 'pending' && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, until - Date.now())))
    receipt = await readJSON(requestPath(directory, request))
    const current = await inspectLoop(directory, root)
    if (!current.running) break
  }
  return { schemaVersion: 1, ok: !['cancelled', 'failed'].includes(receipt.status), runId: request.runId, request: receipt, applied: receipt.status === 'applied', receipt: requestPath(directory, request) }
}

// Independent process: observes a host, never restarts a worker or clears a stop request.
export async function watchLoop(directory, runId, { intervalMs = 1000 } = {}) {
  await atomicJSON(path.join(directory, `supervisor-${runId}.json`), { runId, pid: process.pid, ready: true })
  let warned = false
  for (;;) {
    const state = await readJSON(path.join(directory, 'loop.json'))
    if (!state || state.runId !== runId || !state.running) return
    if ((await readJSON(path.join(directory, 'terminal.json')))?.runId === runId) return
    if (state.host !== os.hostname()) throw new Error('supervisor host mismatch')
    if (!processAlive(state.pid)) {
      const stopped = await controlTransaction(path.join(directory, 'requests-control'), () => controlTransaction(path.join(directory, 'state'), async () => {
        const current = await readJSON(path.join(directory, 'loop.json'))
        if (current?.runId !== runId || !current.running) return null
        const stopped = { ...current, running: false, status: 'failed', reason: 'host-lost', error: 'loop host exited without finalization', endedAt: new Date().toISOString() }
        for (const request of await readRequests(directory, runId)) if (request.status === 'pending') await atomicJSON(requestPath(directory, request), { ...request, status: 'cancelled', reason: 'host-lost' })
        await atomicJSON(path.join(directory, 'loop.json'), stopped)
        return stopped
      }))
      if (stopped) await loopEvent(directory, stopped, 'host-lost', { error: stopped.error })
      return
    }
    if (!warned && Date.now() - Date.parse(state.heartbeatAt) > 60000) { warned = true; await loopEvent(directory, state, 'heartbeat-stale') }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
export async function startLoopMonitor(directory, runId) {
  const log = await open(path.join(directory, 'supervisor.log'), 'a', 0o600)
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/haeram-vibe-watch.mjs', import.meta.url)), directory, runId], { detached: true, stdio: ['ignore', log.fd, log.fd] })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref()
    const until = Date.now() + 5000
    while (Date.now() < until) {
      if ((await readJSON(path.join(directory, `supervisor-${runId}.json`)))?.ready) return { pid: child.pid, ready: true, log: path.join(directory, 'supervisor.log') }
      if (child.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('independent supervisor did not acknowledge readiness')
  } finally { await log.close() }
}
