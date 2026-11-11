import { mkdir, readFile, copyFile, open, access, rm } from 'node:fs/promises'
import { writeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { inspectWorkspace, git } from './workspace.mjs'
import { runtimeRoot, canonicalDestination } from './work-runtime.mjs'
import { atomicJSON, processAlive } from './loop-control.mjs'
import { executeAgentAdapter, compactUsage } from './agent-adapter.mjs'
import { inspectProviders, availableProvider, providerFlags } from './work-providers.mjs'
import { readSetting, permissionMode } from './settings.mjs'
import { SkillPackageError } from './errors.mjs'

// A/B comparison: one problem, 2..6 variants, each on its own branch, sibling worktree and
// port. Sessions build the variants; this host owns the mechanical parts a model should not
// spend turns on: worktrees, commits, servers, side-by-side measurements and cleanup.
const fail = (message, details) => { throw new SkillPackageError(message, details) }
const NAMES = 'abcdef'
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
const exists = (file) => access(file).then(() => true, () => false)
const tailOf = (text) => text.trimEnd().split('\n').slice(-8)

async function context(options) {
  const workspace = await inspectWorkspace(options)
  if (!workspace.git?.head) fail('커밋이 있는 Git checkout이 필요합니다.')
  const main = workspace.git.worktrees.find((tree) => !tree.bare)?.path ?? workspace.git.root
  const identity = `${path.basename(main)}-${createHash('sha256').update(workspace.git.commonDir).digest('hex').slice(0, 8)}`
  return { root: workspace.git.root, main, identity, runtime: runtimeRoot(workspace) }
}
const recordFile = (ctx, slug) => path.join(ctx.runtime, 'ab', `${slug}.json`)
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
function pick(record, options) {
  const names = options.variant ? [options.variant] : Object.keys(record.variants)
  for (const name of names) if (!record.variants[name]) fail(`변형 ${name}이 없습니다: ${Object.keys(record.variants).join(', ')}`)
  return names
}
const urlOf = (variant) => `http://localhost:${variant.port}`

async function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer().once('error', () => resolve(false)).once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}
async function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) }).once('error', () => resolve(false))
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false) })
  })
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

function stopServer(variant) {
  const pid = variant.server?.pid
  if (pid && processAlive(pid)) {
    try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM') } catch {}
    setTimeout(() => { try { if (processAlive(pid)) process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL') } catch {} }, 2000).unref()
  }
  variant.server = null
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
  let result
  try { result = await deps.execute({ provider, model: options.model, job, log: () => {}, flags: await (deps.flags ?? providerFlags)(provider, { env: options.env ?? process.env }) }) } catch (error) {
    throw new SkillPackageError(error.message, (error.details ?? []).map((detail) => String(detail).slice(-2000)))
  }
  // The host commits, so the session needs no Git permission and the branch holds exactly this variant.
  const changed = (await git(variant.path, ['status', '--porcelain'])).trim() !== ''
  if (changed) {
    await git(variant.path, ['add', '-A'])
    await git(variant.path, ['commit', '-q', '-m', `ab ${slug}/${name}: ${result.summary.split('\n')[0].slice(0, 72)}`])
  }
  const commit = (await git(variant.path, ['rev-parse', 'HEAD'])).trim()
  const run = { at: new Date().toISOString(), provider, model: options.model ?? null, outcome: result.outcome, summary: result.summary, view: result.view, commit, changed, ms: Date.now() - started, usage: compactUsage(result.usage) }
  const live = await load(ctx, slug)
  live.variants[name].runs.push(run)
  await save(ctx, live)
  return { schemaVersion: 1, ok: result.outcome === 'completed', slug, variant: name, url: urlOf(variant), ...run }
}

export async function abServe(options = {}) {
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  if (!options.command) fail('--command가 필요합니다(개발 서버 명령, 포트는 $PORT).')
  const names = pick(record, options), readyMs = Number(options.readyTimeoutMs ?? 120000)
  for (const name of names) {
    const variant = record.variants[name]
    stopServer(variant)
    if (!(await portFree(variant.port))) fail(`포트 ${variant.port}를 다른 프로세스가 쓰고 있습니다 (변형 ${name}).`)
    const log = path.join(ctx.runtime, 'ab', slug, `${name}-server.log`)
    await mkdir(path.dirname(log), { recursive: true })
    const file = await open(log, 'a', 0o600)
    const child = spawn(options.command, { cwd: variant.path, shell: true, detached: process.platform !== 'win32',
      env: { ...process.env, PORT: String(variant.port), HAERAM_AB_VARIANT: name }, stdio: ['ignore', file.fd, file.fd] })
    child.unref()
    await file.close()
    variant.server = { pid: child.pid, command: options.command, log, startedAt: new Date().toISOString() }
  }
  await save(ctx, record)
  const deadline = Date.now() + readyMs
  const results = []
  for (const name of names) {
    const variant = record.variants[name]
    let ready = false
    while (!ready && Date.now() < deadline && processAlive(variant.server.pid)) {
      ready = await listening(variant.port)
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const tail = ready ? [] : tailOf(await readFile(variant.server.log, 'utf8').catch(() => ''))
    results.push({ variant: name, url: urlOf(variant), ready, view: variant.runs.at(-1)?.view ?? null, ...(ready ? {} : { exited: !processAlive(variant.server.pid), tail, log: variant.server.log }) })
  }
  return { schemaVersion: 1, ok: results.every((entry) => entry.ready), slug, variants: results }
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
  return { schemaVersion: 1, ok: true, slug, base: record.base, createdAt: record.createdAt, variants }
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
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  const names = Object.keys(record.variants)
  for (const name of names) stopServer(record.variants[name])
  await save(ctx, record)
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
  for (const other of names) stopServer(record.variants[other])
  await save(ctx, record)
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
