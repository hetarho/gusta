import { mkdir, readFile, copyFile, open, access, rm } from 'node:fs/promises'
import { writeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectWorkspace, git } from './workspace.mjs'
import { runtimeRoot, canonicalDestination } from './work-runtime.mjs'
import { atomicJSON, processAlive, controlTransaction } from './loop-control.mjs'
import { executeAgentAdapter, compactUsage } from './agent-adapter.mjs'
import { inspectProviders, availableProvider } from './work-providers.mjs'
import { readSetting, permissionMode } from './settings.mjs'
import { SkillPackageError } from './errors.mjs'
import { urlOf, readFeedback } from './vibe-ab-hub.mjs'

// A/B comparison: one problem, 2..6 variants, each on its own branch, sibling worktree and
// port. Sessions build the variants; this host owns the mechanical parts a model should not
// spend turns on: worktrees, commits, servers, side-by-side measurements and cleanup.
const fail = (message, details) => { throw new SkillPackageError(message, details) }
const NAMES = 'abcdef'
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
const exists = (file) => access(file).then(() => true, () => false)
const tailOf = (text) => text.trimEnd().split('\n').slice(-8)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const HUB = fileURLToPath(new URL('../bin/haeram-ab-hub.mjs', import.meta.url))

async function context(options) {
  const workspace = await inspectWorkspace(options)
  if (!workspace.git?.head) fail('커밋이 있는 Git checkout이 필요합니다.')
  const main = workspace.git.worktrees.find((tree) => !tree.bare)?.path ?? workspace.git.root
  const identity = `${path.basename(main)}-${createHash('sha256').update(workspace.git.commonDir).digest('hex').slice(0, 8)}`
  return { root: workspace.git.root, main, identity, runtime: runtimeRoot(workspace) }
}
const recordFile = (ctx, slug) => path.join(ctx.runtime, 'ab', `${slug}.json`)
const fileOf = (ctx, slug, name) => path.join(ctx.runtime, 'ab', slug, name)
function slugOf(options) {
  if (!SLUG.test(options.slug ?? '')) fail('비교 이름(slug)은 소문자·숫자·하이픈 40자 이내입니다: vibe ab <step> <slug>')
  return options.slug
}
async function load(ctx, slug) {
  const record = await readFile(recordFile(ctx, slug), 'utf8').then(JSON.parse).catch(() => null)
  if (!record) fail(`비교 ${slug}가 없습니다. vibe ab start ${slug}로 시작하세요.`)
  return record
}
const save = (ctx, record) => atomicJSON(recordFile(ctx, record.slug), record)
// Variant runs and serves change the record from separate processes: every change is a short
// load-change-save under the record's lock, so none drops another's run or server.
const locked = (ctx, slug, run) => controlTransaction(`${recordFile(ctx, slug)}.lock`, run)
const update = (ctx, slug, change) => locked(ctx, slug, async () => {
  const live = await load(ctx, slug)
  await change(live)
  await save(ctx, live)
  return live
})
function pick(record, options) {
  const names = options.variant ? [options.variant] : Object.keys(record.variants)
  for (const name of names) if (!record.variants[name]) fail(`변형 ${name}이 없습니다: ${Object.keys(record.variants).join(', ')}`)
  return names
}

// A dev server bound to `localhost` may hold only ::1 (Node 17+ on macOS, Vite by default), so a
// port is checked on both loopbacks. A host without IPv6 cannot bind ::1 at all: that is not "in use".
const LOOPBACKS = ['127.0.0.1', '::1']
const bindable = (port, host) => new Promise((resolve) => {
  const server = net.createServer().once('error', (error) => resolve(['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code))).once('listening', () => server.close(() => resolve(true)))
  server.listen(port, host)
})
const connects = (port, host) => new Promise((resolve) => {
  const socket = net.connect(port, host)
  socket.once('connect', () => { socket.destroy(); resolve(true) }).once('error', () => resolve(false))
  socket.setTimeout(1000, () => { socket.destroy(); resolve(false) })
})
const listening = async (port) => (await Promise.all(LOOPBACKS.map((host) => connects(port, host)))).some(Boolean)
async function portFree(port) {
  for (const host of LOOPBACKS) if (!(await bindable(port, host))) return false
  return !(await listening(port))
}

// One shell command in a variant worktree; output goes to a log, only a tail is returned.
async function shell(command, cwd, env, log, timeoutMs) {
  await mkdir(path.dirname(log), { recursive: true })
  const file = await open(log, 'w', 0o600)
  const started = Date.now()
  let tail = ''
  try {
    const code = await new Promise((resolve) => {
      const child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      const kill = (signal) => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal) } catch {} }
      const timer = setTimeout(() => { kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 2000).unref() }, timeoutMs)
      const output = (chunk) => { writeSync(file.fd, chunk); tail = (tail + chunk).slice(-4000) }
      child.stdout.on('data', output); child.stderr.on('data', output)
      child.on('error', () => { clearTimeout(timer); resolve(127) })
      child.on('close', (value) => { clearTimeout(timer); resolve(value ?? 1) })
    })
    return { exitCode: code, ms: Date.now() - started, tail: tailOf(tail), log }
  } finally { await file.close() }
}

// A server or hub runs as its own process group; true when something was running.
function stopProcess(pid) {
  if (!pid || !processAlive(pid)) return false
  const group = process.platform === 'win32' ? pid : -pid
  try { process.kill(group, 'SIGTERM') } catch {}
  setTimeout(() => { try { if (processAlive(pid)) process.kill(group, 'SIGKILL') } catch {} }, 2000).unref()
  return true
}
function stopServer(variant) {
  const stopped = stopProcess(variant.server?.pid)
  variant.server = null
  return stopped
}
function stopAll(record) {
  for (const variant of Object.values(record.variants)) stopServer(variant)
  stopProcess(record.hub?.pid)
  record.hub = null
}

export async function abStart(options = {}) {
  const ctx = await context(options), slug = slugOf(options)
  if (await exists(recordFile(ctx, slug))) fail(`비교 ${slug}가 이미 있습니다. vibe ab status ${slug} 또는 stop --remove 후 다시 시작하세요.`)
  const count = Number(options.variants ?? 2)
  if (!Number.isInteger(count) || count < 2 || count > NAMES.length) fail(`variants는 2~${NAMES.length}입니다.`)
  if ((await git(ctx.root, ['status', '--porcelain'])).trim()) fail('미커밋 변경이 있습니다. 변형은 커밋된 기준에서 시작합니다 — 사용자 변경을 먼저 정리하세요.')
  const copies = options.copy ?? []
  for (const file of copies) if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) fail(`--copy는 checkout 안의 상대 경로입니다: ${file}`)
  const base = (await git(ctx.root, ['rev-parse', '--verify', `${options.base ?? 'HEAD'}^{commit}`])).trim()
  let port = Number(options.basePort ?? 4101)
  if (!Number.isInteger(port) || port < 1024 || port > 65000) fail('base-port는 1024~65000입니다.')
  const record = { schemaVersion: 1, slug, base, createdAt: new Date().toISOString(), variants: {} }
  for (const name of ['feedback.json', 'hub.json']) await rm(fileOf(ctx, slug, name), { force: true })
  for (const name of NAMES.slice(0, count)) {
    while (!(await portFree(port))) port++
    const branch = `ab/${slug}/${name}`
    const destination = await canonicalDestination(path.join(path.dirname(ctx.main), '.haeram-worktrees', ctx.identity, `ab-${slug}-${name}`))
    await git(ctx.root, ['worktree', 'add', '-b', branch, destination, base])
    for (const file of copies) {
      if (!(await exists(path.join(ctx.root, file)))) continue
      await mkdir(path.dirname(path.join(destination, file)), { recursive: true })
      await copyFile(path.join(ctx.root, file), path.join(destination, file))
    }
    record.variants[name] = { branch, path: destination, port: port++, server: null, runs: [] }
    await save(ctx, record)
  }
  // Dependencies install in every worktree at once; a failure keeps the worktrees for a retry.
  const setup = options.setup ? Object.fromEntries(await Promise.all(Object.entries(record.variants).map(async ([name, variant]) =>
    [name, await shell(options.setup, variant.path, { PORT: String(variant.port) }, path.join(ctx.runtime, 'ab', slug, `${name}-setup.log`), Number(options.timeoutMs ?? 1200000))]))) : null
  const ok = !setup || Object.values(setup).every((entry) => entry.exitCode === 0)
  return { schemaVersion: 1, ok, slug, base, variants: Object.entries(record.variants).map(([name, variant]) => ({ variant: name, branch: variant.branch, path: variant.path, port: variant.port, url: urlOf(variant) })),
    ...(setup ? { setup: Object.fromEntries(Object.entries(setup).map(([name, entry]) => [name, entry.exitCode === 0 ? { ok: true, ms: entry.ms } : { ok: false, ms: entry.ms, tail: entry.tail, log: entry.log }])) } : {}) }
}

export async function abRun(options = {}, injected = {}) {
  const deps = { inspect: inspectProviders, execute: executeAgentAdapter, ...injected }
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  if (!options.variant) fail('--variant가 필요합니다.')
  const [name] = pick(record, options), variant = record.variants[name]
  if (!options.promptFile) fail('--prompt-file이 필요합니다(이 변형의 목표·접근·지킬 결정).')
  const prompt = await readFile(path.resolve(options.promptFile), 'utf8')
  const timeoutMs = Number(options.timeoutMs ?? 3600000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('timeout-ms는 양의 정수입니다.')
  const provider = await availableProvider(options, deps.inspect)
  const started = Date.now()
  const job = { schemaVersion: 1, role: 'variant', workspace: variant.path, prompt: `Variant ${name} of ${slug}. $PORT for this variant: ${variant.port}.\n\n${prompt}`, timeoutMs,
    allowTools: options.allowTool ?? [], permissionMode: await permissionMode(options, ctx.root) }
  // The session transcript goes to a runtime file; results name its path, never its content.
  const log = fileOf(ctx, slug, `${name}-run-${variant.runs.length + 1}.log`)
  await mkdir(path.dirname(log), { recursive: true })
  const file = await open(log, 'w', 0o600)
  let result
  try { result = await deps.execute({ provider, model: options.model, job, log: (text) => { try { writeSync(file.fd, text) } catch {} } }) } catch (error) {
    throw new SkillPackageError(error.message, [...(error.details ?? []).map((detail) => String(detail).slice(-2000)), `log: ${log}`])
  } finally { await file.close() }
  // The host commits, so the session needs no Git permission and the branch holds exactly this variant.
  const changed = (await git(variant.path, ['status', '--porcelain'])).trim() !== ''
  if (changed) {
    await git(variant.path, ['add', '-A'])
    await git(variant.path, ['commit', '-q', '-m', `ab ${slug}/${name}: ${result.summary.split('\n')[0].slice(0, 72)}`])
  }
  const commit = (await git(variant.path, ['rev-parse', 'HEAD'])).trim()
  const run = { at: new Date().toISOString(), provider, model: options.model ?? null, outcome: result.outcome, summary: result.summary, view: result.view, path: result.path ?? '',
    commit, changed, ms: Date.now() - started, usage: compactUsage(result.usage), log }
  const live = await update(ctx, slug, (current) => { current.variants[name].runs.push(run) })
  return { schemaVersion: 1, ok: result.outcome === 'completed', slug, variant: name, url: urlOf(live.variants[name]), ...run }
}

// Ready means the screen answers: after the port listens, one GET of the variant's view path. A 5xx
// or no answer is not ready; 3xx/4xx is (sign-in redirects are normal) and its status is reported.
export async function probeView(url, timeoutMs) {
  const started = Date.now()
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    await response.body?.cancel().catch(() => {})
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    return { ok: response.status < 500, status: response.status, ms: Date.now() - started, ...(location ? { location } : {}) }
  } catch (error) {
    return { ok: false, error: error.name === 'TimeoutError' ? 'timeout' : String(error.cause?.code ?? error.message), ms: Date.now() - started }
  }
}

async function readiness(variant, deadline, probe) {
  let up = false
  while (!up && Date.now() < deadline && processAlive(variant.server?.pid)) {
    up = await listening(variant.port)
    if (!up) await sleep(500)
  }
  return up ? probe(urlOf(variant), Math.max(5000, deadline - Date.now())) : null
}

// The hub is detached like the dev servers and reports its own free port. Its URL uses localhost,
// the variants' host, so their cookies stay same-site inside the hub's frames. The start decision
// is made under the record lock, so two concurrent serves share one hub.
async function ensureHub(ctx, slug) {
  const ready = fileOf(ctx, slug, 'hub.json')
  const hub = await locked(ctx, slug, async () => {
    const live = await load(ctx, slug)
    if (live.hub?.pid && processAlive(live.hub.pid)) return live.hub
    const log = fileOf(ctx, slug, 'hub.log')
    await mkdir(path.dirname(log), { recursive: true })
    await rm(ready, { force: true })
    const file = await open(log, 'a', 0o600)
    const child = spawn(process.execPath, [HUB, recordFile(ctx, slug), fileOf(ctx, slug, 'feedback.json'), ready], { detached: process.platform !== 'win32', stdio: ['ignore', file.fd, file.fd] })
    child.unref()
    await file.close()
    live.hub = { pid: child.pid, log, startedAt: new Date().toISOString() }
    await save(ctx, live)
    return live.hub
  })
  if (hub.url) return hub
  for (const until = Date.now() + 5000; Date.now() < until && processAlive(hub.pid); await sleep(100)) {
    const port = await readFile(ready, 'utf8').then((text) => { const value = JSON.parse(text); return value.pid === hub.pid ? value.port : null }, () => null)
    if (port) return (await update(ctx, slug, (live) => { if (live.hub?.pid === hub.pid) live.hub = { ...live.hub, port, url: `http://localhost:${port}` } })).hub
  }
  stopProcess(hub.pid)
  await update(ctx, slug, (live) => { if (live.hub?.pid === hub.pid) live.hub = null })
  return null
}

export async function abServe(options = {}, injected = {}) {
  const deps = { probe: probeView, spawnServer: spawn, ...injected }
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  if (!options.command) fail('--command가 필요합니다(개발 서버 명령, 포트는 $PORT).')
  const names = pick(record, options), readyMs = Number(options.readyTimeoutMs ?? 120000)
  const changed = {}
  try {
    for (const name of names) {
      const variant = record.variants[name]
      // A live server of the same command keeps serving (hot reload shows a rerun); --restart replaces it.
      if (!options.restart && variant.server?.command === options.command && processAlive(variant.server.pid)) continue
      if (stopServer(variant)) for (const until = Date.now() + 5000; Date.now() < until && !(await portFree(variant.port));) await sleep(200)
      changed[name] = null
      if (!(await portFree(variant.port))) fail(`포트 ${variant.port}를 다른 프로세스가 쓰고 있습니다 (변형 ${name}).`)
      const log = fileOf(ctx, slug, `${name}-server.log`)
      await mkdir(path.dirname(log), { recursive: true })
      const file = await open(log, 'a', 0o600)
      const child = await deps.spawnServer(options.command, { cwd: variant.path, shell: true, detached: process.platform !== 'win32',
        env: { ...process.env, PORT: String(variant.port), HAERAM_AB_VARIANT: name }, stdio: ['ignore', file.fd, file.fd] })
      child.unref()
      await file.close()
      changed[name] = variant.server = { pid: child.pid, command: options.command, log, startedAt: new Date().toISOString() }
    }
  } finally {
    // Merge into the live record: a variant run may have finished while servers started.
    if (Object.keys(changed).length) await update(ctx, slug, (live) => { for (const [name, server] of Object.entries(changed)) live.variants[name].server = server })
  }
  const live = await load(ctx, slug), deadline = Date.now() + readyMs
  const results = await Promise.all(names.map(async (name) => {
    const variant = live.variants[name], answer = await readiness(variant, deadline, deps.probe)
    const ready = Boolean(answer?.ok), { ok, ...http } = answer ?? {}
    const tail = ready ? [] : tailOf(await readFile(variant.server?.log ?? '', 'utf8').catch(() => ''))
    return { variant: name, url: urlOf(variant), ready, ...(Object.hasOwn(changed, name) ? {} : { kept: true }), ...(answer ? { http } : {}), view: variant.runs.at(-1)?.view ?? null,
      ...(ready ? {} : { exited: !processAlive(variant.server?.pid), tail, log: variant.server?.log ?? null }) }
  }))
  const hub = await ensureHub(ctx, slug)
  return { schemaVersion: 1, ok: Boolean(hub) && results.every((entry) => entry.ready), slug, hub: hub?.url ?? null, ...(hub ? {} : { hubLog: fileOf(ctx, slug, 'hub.log') }), variants: results }
}

// Variants run one after another and alternate per repetition (a b a b ...), so drift in the
// machine's load is spread across them instead of favouring whichever ran first.
export async function abExec(options = {}) {
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  if (!options.command) fail('--command가 필요합니다(측정·검사 명령).')
  const names = pick(record, options), repeat = Number(options.repeat ?? 1), timeoutMs = Number(options.timeoutMs ?? 1800000)
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) fail('repeat는 1~20입니다.')
  const runs = Object.fromEntries(names.map((name) => [name, []]))
  for (let round = 0; round < repeat; round++) {
    for (const name of names) {
      const variant = record.variants[name]
      runs[name].push(await shell(options.command, variant.path, { PORT: String(variant.port), HAERAM_AB_VARIANT: name }, path.join(ctx.runtime, 'ab', slug, `${name}-exec-${round + 1}.log`), timeoutMs))
    }
  }
  const variants = names.map((name) => {
    const times = runs[name].map((entry) => entry.ms).sort((a, b) => a - b)
    const last = runs[name].at(-1)
    return { variant: name, exitCodes: runs[name].map((entry) => entry.exitCode), minMs: times[0], medianMs: times[Math.floor((times.length - 1) / 2)], maxMs: times.at(-1), tail: last.tail, log: last.log }
  })
  return { schemaVersion: 1, ok: variants.every((entry) => entry.exitCodes.every((code) => code === 0)), slug, command: options.command, repeat, variants }
}

export async function abStatus(options = {}) {
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  const variants = []
  for (const [name, variant] of Object.entries(record.variants)) {
    const ahead = Number((await git(ctx.root, ['rev-list', '--count', `${record.base}..${variant.branch}`]).catch(() => '0')).trim())
    const serving = Boolean(variant.server?.pid && processAlive(variant.server.pid))
    variants.push({ variant: name, branch: variant.branch, path: variant.path, url: urlOf(variant), serving, commits: ahead, last: variant.runs.at(-1) ? { outcome: variant.runs.at(-1).outcome, summary: variant.runs.at(-1).summary, view: variant.runs.at(-1).view } : null })
  }
  // The hub's notes and choice are what the person said; a choice is intent, adopting stays pick.
  const hub = record.hub?.url && processAlive(record.hub.pid) ? record.hub.url : null
  return { schemaVersion: 1, ok: true, slug, base: record.base, createdAt: record.createdAt, hub, feedback: await readFeedback(fileOf(ctx, slug, 'feedback.json')), variants }
}

async function removeWorktrees(ctx, record, names) {
  const dirty = []
  for (const name of names) if ((await git(record.variants[name].path, ['status', '--porcelain']).catch(() => '')).trim()) dirty.push(name)
  if (dirty.length) fail(`커밋되지 않은 변경이 있는 변형: ${dirty.join(', ')}. vibe ab run으로 끝내거나 직접 정리하세요.`)
  for (const name of names) await git(ctx.root, ['worktree', 'remove', record.variants[name].path])
}
async function pruneBranches(ctx, record, names) {
  for (const name of names) await git(ctx.root, ['branch', '-D', record.variants[name].branch]).catch(() => {})
}
// Once a variant is picked or the comparison is dropped no variant branch is used again:
// they go by default (spec/SETTINGS.md prune-branches); --prune-branches forces it when that is false.
const pruning = async (ctx, options) => options.pruneBranches || await readSetting({ root: ctx.root }, 'prune-branches')

export async function abStop(options = {}) {
  const ctx = await context(options), slug = slugOf(options), record = await update(ctx, slug, stopAll)
  const names = Object.keys(record.variants)
  const prune = options.remove && await pruning(ctx, options)
  if (options.remove) {
    await removeWorktrees(ctx, record, names)
    if (prune) await pruneBranches(ctx, record, names)
    await rm(recordFile(ctx, slug), { force: true })
  }
  return { schemaVersion: 1, ok: true, slug, stopped: names, removed: Boolean(options.remove), branches: prune ? [] : names.map((name) => record.variants[name].branch) }
}

// Adoption merges exactly one variant into the checkout that started the comparison. Recording the
// decision (update-ssot when a rule changed, STATE log otherwise) stays with the calling skill.
export async function abPick(options = {}) {
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  if (!options.variant) fail('--variant가 필요합니다.')
  const [name] = pick(record, options), names = Object.keys(record.variants)
  if (names.some((other) => record.variants[other].path === ctx.root)) fail('변형 worktree가 아니라 비교를 시작한 checkout에서 실행하세요.')
  if ((await git(ctx.root, ['status', '--porcelain'])).trim()) fail('합칠 checkout에 미커밋 변경이 있습니다.')
  await update(ctx, slug, stopAll)
  const winner = record.variants[name]
  if (Number((await git(ctx.root, ['rev-list', '--count', `${record.base}..${winner.branch}`])).trim()) === 0) fail(`변형 ${name}에 커밋이 없습니다.`)
  try { await git(ctx.root, ['merge', '--no-ff', '-m', `ab ${slug}: adopt ${name}`, winner.branch]) } catch (error) {
    await git(ctx.root, ['merge', '--abort']).catch(() => {})
    fail(`변형 ${name}을 합치지 못했습니다(충돌). 현재 브랜치는 그대로입니다.`, [String(error.stderr ?? error.message).slice(-2000)])
  }
  const merged = (await git(ctx.root, ['rev-parse', 'HEAD'])).trim()
  await removeWorktrees(ctx, record, names)
  const prune = await pruning(ctx, options)
  if (prune) await pruneBranches(ctx, record, names)
  await rm(recordFile(ctx, slug), { force: true })
  return { schemaVersion: 1, ok: true, slug, adopted: name, merged, summary: winner.runs.at(-1)?.summary ?? null, branches: prune ? [] : names.map((other) => record.variants[other].branch) }
}

export const AB_STEPS = { start: abStart, run: abRun, serve: abServe, exec: abExec, status: abStatus, pick: abPick, stop: abStop }
