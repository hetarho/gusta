import { mkdir, readFile, copyFile, open, access, rm } from 'node:fs/promises'
import { writeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectWorkspace, git } from './workspace.mjs'
import { runtimeRoot, canonicalDestination } from './work-runtime.mjs'
import { atomicJSON, processAlive } from './loop-control.mjs'
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
const BASE = 'base' // the scaffold's branch and worktree name; never a variant name
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
// Another command (a variant run finishing) may have saved since this one loaded: change the live record.
async function update(ctx, slug, change) {
  const live = await load(ctx, slug)
  change(live)
  await save(ctx, live)
  return live
}
function pick(record, options) {
  const names = options.variant ? [options.variant] : Object.keys(record.variants)
  for (const name of names) if (!record.variants[name]) fail(`변형 ${name}이 없습니다: ${Object.keys(record.variants).join(', ')}`)
  return names
}

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

// A worktree on its own branch ab/<slug>/<name>, with the untracked files the run needs copied in.
async function addTree(ctx, slug, name, from, copies) {
  const branch = `ab/${slug}/${name}`
  const destination = await canonicalDestination(path.join(path.dirname(ctx.main), '.haeram-worktrees', ctx.identity, `ab-${slug}-${name}`))
  await git(ctx.root, ['worktree', 'add', '-b', branch, destination, from])
  for (const file of copies) {
    if (!(await exists(path.join(ctx.root, file)))) continue
    await mkdir(path.dirname(path.join(destination, file)), { recursive: true })
    await copyFile(path.join(ctx.root, file), path.join(destination, file))
  }
  return { branch, path: destination }
}
const setupResult = (entry) => entry.exitCode === 0 ? { ok: true, ms: entry.ms } : { ok: false, ms: entry.ms, tail: entry.tail, log: entry.log }

async function sessionOptions(ctx, options, deps) {
  const timeoutMs = Number(options.timeoutMs ?? 3600000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('timeout-ms는 양의 정수입니다.')
  return { provider: await availableProvider(options, deps.inspect), model: options.model, timeoutMs, allowTools: options.allowTool ?? [], permissionMode: await permissionMode(options, ctx.root) }
}
// One headless session in a worktree. The transcript goes to a runtime file (results name its path,
// never its content); the host commits, so the session needs no Git permission.
async function headless(execute, session, { role, cwd, prompt, log, subject }) {
  const started = Date.now()
  const job = { schemaVersion: 1, role, workspace: cwd, prompt, timeoutMs: session.timeoutMs, allowTools: session.allowTools, permissionMode: session.permissionMode }
  await mkdir(path.dirname(log), { recursive: true })
  const file = await open(log, 'w', 0o600)
  let result
  try { result = await execute({ provider: session.provider, model: session.model, job, log: (text) => { try { writeSync(file.fd, text) } catch {} } }) } catch (error) {
    throw new SkillPackageError(error.message, [...(error.details ?? []).map((detail) => String(detail).slice(-2000)), `log: ${log}`])
  } finally { await file.close() }
  const changed = (await git(cwd, ['status', '--porcelain'])).trim() !== ''
  if (changed) {
    await git(cwd, ['add', '-A'])
    await git(cwd, ['commit', '-q', '-m', `${subject}: ${result.summary.split('\n')[0].slice(0, 72)}`])
  }
  const commit = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
  return { at: new Date().toISOString(), provider: session.provider, model: session.model ?? null, outcome: result.outcome, summary: result.summary, view: result.view, path: result.path ?? '',
    commit, changed, ms: Date.now() - started, usage: compactUsage(result.usage), log }
}

// What the scaffold commit changed: read-only for the variants and dropped at pick.
const scaffoldFiles = async (root, record) => record.scaffold
  ? (await git(root, ['diff', '--name-only', '--no-renames', record.origin, record.scaffold])).split('\n').filter(Boolean) : []

export async function abStart(options = {}, injected = {}) {
  const deps = { inspect: inspectProviders, execute: executeAgentAdapter, ...injected }
  const ctx = await context(options), slug = slugOf(options)
  if (await exists(recordFile(ctx, slug))) fail(`비교 ${slug}가 이미 있습니다. vibe ab status ${slug} 또는 stop --remove 후 다시 시작하세요.`)
  const count = Number(options.variants ?? 2)
  if (!Number.isInteger(count) || count < 2 || count > NAMES.length) fail(`variants는 2~${NAMES.length}입니다.`)
  if ((await git(ctx.root, ['status', '--porcelain'])).trim()) fail('미커밋 변경이 있습니다. 변형은 커밋된 기준에서 시작합니다 — 사용자 변경을 먼저 정리하세요.')
  const copies = options.copy ?? []
  for (const file of copies) if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) fail(`--copy는 checkout 안의 상대 경로입니다: ${file}`)
  if (options.scaffold && options.scaffoldPrompt) fail('--scaffold(있는 커밋)와 --scaffold-prompt(새로 만들기) 중 하나만 줍니다.')
  const origin = (await git(ctx.root, ['rev-parse', '--verify', `${options.base ?? 'HEAD'}^{commit}`])).trim()
  let scaffold = options.scaffold ? (await git(ctx.root, ['rev-parse', '--verify', `${options.scaffold}^{commit}`])).trim() : null
  if (scaffold && (scaffold === origin || (await git(ctx.root, ['merge-base', '--is-ancestor', origin, scaffold], [1])) === null)) fail(`scaffold ${options.scaffold}는 기준(${options.base ?? 'HEAD'}) 위의 커밋이어야 합니다. --base로 그 기준을 주세요.`)
  let port = Number(options.basePort ?? 4101)
  if (!Number.isInteger(port) || port < 1024 || port > 65000) fail('base-port는 1024~65000입니다.')
  // Read now: the coordinator's temporary files may be gone before the variants run.
  const shared = options.sharedFile ? await readFile(path.resolve(options.sharedFile), 'utf8') : ''
  const brief = options.scaffoldPrompt ? await readFile(path.resolve(options.scaffoldPrompt), 'utf8') : null
  const session = brief ? await sessionOptions(ctx, options, deps) : null
  const record = { schemaVersion: 1, slug, base: origin, createdAt: new Date().toISOString(), variants: {}, ...(shared.trim() ? { shared } : {}) }
  for (const name of ['feedback.json', 'hub.json']) await rm(fileOf(ctx, slug, name), { force: true })
  const install = (cwd, env, name) => shell(options.setup, cwd, env, fileOf(ctx, slug, `${name}-setup.log`), Number(options.timeoutMs ?? 1200000))
  if (brief) {
    // One session makes the screen render from fixtures on ab/<slug>/base; every variant starts from its commit.
    const tree = record.scaffoldTree = await addTree(ctx, slug, BASE, origin, copies)
    await save(ctx, record)
    const setup = options.setup ? await install(tree.path, {}, BASE) : null
    if (setup && setup.exitCode !== 0) return { schemaVersion: 1, ok: false, slug, origin, setup: { [BASE]: setupResult(setup) } }
    const prompt = [shared.trim() && `Comparison context (the variants build this; you build only the scaffold):\n${shared.trim()}`, brief].filter(Boolean).join('\n\n')
    const run = record.scaffoldRun = await headless(deps.execute, session, { role: 'scaffold', cwd: tree.path, prompt, log: fileOf(ctx, slug, `${BASE}-run.log`), subject: `ab ${slug}/${BASE}: scaffold` })
    if (run.outcome !== 'completed' || !run.changed) {
      await save(ctx, record)
      return { schemaVersion: 1, ok: false, slug, origin, error: 'scaffold가 완료되지 않았거나 변경이 없어 변형을 만들지 않았습니다. 확인 후 stop --remove.', scaffoldRun: run }
    }
    scaffold = run.commit
    await git(ctx.root, ['worktree', 'remove', tree.path])
    record.scaffoldTree = { branch: tree.branch }
  }
  if (scaffold) Object.assign(record, { base: scaffold, origin, scaffold })
  for (const name of NAMES.slice(0, count)) {
    while (!(await portFree(port))) port++
    record.variants[name] = { ...(await addTree(ctx, slug, name, record.base, copies)), port: port++, server: null, runs: [] }
    await save(ctx, record)
  }
  // Dependencies install in every worktree at once; a failure keeps the worktrees for a retry.
  const setup = options.setup ? Object.fromEntries(await Promise.all(Object.entries(record.variants).map(async ([name, variant]) =>
    [name, await install(variant.path, { PORT: String(variant.port) }, name)]))) : null
  const ok = !setup || Object.values(setup).every((entry) => entry.exitCode === 0)
  const run = record.scaffoldRun
  return { schemaVersion: 1, ok, slug, base: record.base, ...(scaffold ? { origin, scaffold, scaffoldFiles: await scaffoldFiles(ctx.root, record) } : {}),
    ...(run ? { scaffoldRun: { summary: run.summary, view: run.view, path: run.path, ms: run.ms, usage: run.usage, log: run.log } } : {}),
    variants: Object.entries(record.variants).map(([name, variant]) => ({ variant: name, branch: variant.branch, path: variant.path, port: variant.port, url: urlOf(variant) })),
    ...(setup ? { setup: Object.fromEntries(Object.entries(setup).map(([name, entry]) => [name, setupResult(entry)])) } : {}) }
}

// [scaffold rule][shared text] then [variant line][approach][follow-up]: everything before the variant
// line is the same for every variant (one cacheable prefix), and a follow-up repeats the first run's
// prompt before what is new, so a fresh session knows the goal and the approach it continues.
async function variantPrompt(ctx, record, name, { approach, followUp, note }) {
  const variant = record.variants[name], files = await scaffoldFiles(ctx.root, record), last = variant.runs.at(-1)
  return [files.length && `Shared mock scaffold, read-only for variants (adopting a variant drops it): ${files.join(', ')}. If you need different data, say so in summary.`,
    record.shared?.trim(), `Variant ${name} of ${record.slug}. $PORT for this variant: ${variant.port}.`, approach,
    ...(followUp === undefined ? [] : [last && `Your last run's summary: ${last.summary}`, note && `The person's note on this variant: ${note}`,
      `Your branch already contains this work; change only what is asked.\n\nFollow-up request:\n${followUp}`])].filter(Boolean).join('\n\n')
}

export async function abRun(options = {}, injected = {}) {
  const deps = { inspect: inspectProviders, execute: executeAgentAdapter, ...injected }
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  if (!options.variant) fail('--variant가 필요합니다.')
  const [name] = pick(record, options), variant = record.variants[name]
  if (Boolean(options.promptFile) === Boolean(options.followUpFile)) fail('--prompt-file(이 변형의 접근) 또는 --follow-up-file(이어 고칠 요청) 중 하나가 필요합니다.')
  if (options.followUpFile && !variant.runs.length) fail(`변형 ${name}은 아직 실행되지 않았습니다. 먼저 --prompt-file로 실행하세요.`)
  // The approach stays with the variant: a follow-up repeats it without the coordinator rewriting it.
  const approach = options.promptFile ? await readFile(path.resolve(options.promptFile), 'utf8') : variant.approach
  const followUp = options.followUpFile ? await readFile(path.resolve(options.followUpFile), 'utf8') : undefined
  const note = followUp === undefined ? null : (await readFeedback(fileOf(ctx, slug, 'feedback.json'))).notes[name]?.note
  const prompt = await variantPrompt(ctx, record, name, { approach, followUp, note })
  const run = await headless(deps.execute, await sessionOptions(ctx, options, deps), { role: 'variant', cwd: variant.path, prompt, log: fileOf(ctx, slug, `${name}-run-${variant.runs.length + 1}.log`), subject: `ab ${slug}/${name}` })
  if (followUp !== undefined) run.followUp = true
  const live = await update(ctx, slug, (current) => { current.variants[name].runs.push(run); if (options.promptFile) current.variants[name].approach = approach })
  return { schemaVersion: 1, ok: run.outcome === 'completed', slug, variant: name, url: urlOf(live.variants[name]), ...run }
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
// the variants' host, so their cookies stay same-site inside the hub's frames.
async function startHub(ctx, slug) {
  const ready = fileOf(ctx, slug, 'hub.json'), log = fileOf(ctx, slug, 'hub.log')
  await mkdir(path.dirname(log), { recursive: true })
  await rm(ready, { force: true })
  const file = await open(log, 'a', 0o600)
  const child = spawn(process.execPath, [HUB, recordFile(ctx, slug), fileOf(ctx, slug, 'feedback.json'), ready], { detached: process.platform !== 'win32', stdio: ['ignore', file.fd, file.fd] })
  child.unref()
  await file.close()
  for (const until = Date.now() + 5000; Date.now() < until && processAlive(child.pid); await sleep(100)) {
    const port = await readFile(ready, 'utf8').then((text) => JSON.parse(text).port, () => null)
    if (port) return { pid: child.pid, port, url: `http://localhost:${port}`, log, startedAt: new Date().toISOString() }
  }
  stopProcess(child.pid)
  return null
}

export async function abServe(options = {}, injected = {}) {
  const deps = { probe: probeView, ...injected }
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
      const child = spawn(options.command, { cwd: variant.path, shell: true, detached: process.platform !== 'win32',
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
  const hub = live.hub?.pid && processAlive(live.hub.pid) ? live.hub : await startHub(ctx, slug)
  if (hub !== live.hub) await update(ctx, slug, (current) => { current.hub = hub })
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
  const hub = record.hub?.pid && processAlive(record.hub.pid) ? record.hub.url : null
  return { schemaVersion: 1, ok: true, slug, base: record.base, ...(record.scaffold ? { origin: record.origin, scaffold: record.scaffold } : {}), createdAt: record.createdAt, hub, feedback: await readFeedback(fileOf(ctx, slug, 'feedback.json')), variants }
}

// Every worktree and branch the comparison made: the variants and the branch its scaffold session
// made (a reused --scaffold ref belongs to the caller and stays). A removed worktree has no path.
const made = (record) => [...Object.entries(record.variants), ...(record.scaffoldTree ? [[BASE, record.scaffoldTree]] : [])]
async function removeWorktrees(ctx, trees) {
  const dirty = []
  for (const [name, tree] of trees) if (tree.path && (await git(tree.path, ['status', '--porcelain']).catch(() => '')).trim()) dirty.push(name)
  if (dirty.length) fail(`커밋되지 않은 변경이 있는 변형: ${dirty.join(', ')}. vibe ab run으로 끝내거나 직접 정리하세요.`)
  for (const [, tree] of trees) if (tree.path) await git(ctx.root, ['worktree', 'remove', tree.path])
}
async function pruneBranches(ctx, trees) {
  for (const [, tree] of trees) await git(ctx.root, ['branch', '-D', tree.branch]).catch(() => {})
}
// Once a variant is picked or the comparison is dropped no variant branch is used again:
// they go by default (spec/SETTINGS.md prune-branches); --prune-branches forces it when that is false.
const pruning = async (ctx, options) => options.pruneBranches || await readSetting({ root: ctx.root }, 'prune-branches')

export async function abStop(options = {}) {
  const ctx = await context(options), slug = slugOf(options), record = await update(ctx, slug, stopAll)
  const trees = made(record)
  const prune = options.remove && await pruning(ctx, options)
  if (options.remove) {
    await removeWorktrees(ctx, trees)
    if (prune) await pruneBranches(ctx, trees)
    await rm(recordFile(ctx, slug), { force: true })
  }
  return { schemaVersion: 1, ok: true, slug, stopped: Object.keys(record.variants), removed: Boolean(options.remove), branches: prune ? [] : trees.map(([, tree]) => tree.branch) }
}

// A scaffold never ships: the winner's own commits are replayed onto the start base without it, on a
// detached HEAD in its worktree, so a refusal leaves both the current branch and the variant branch as they were.
async function withoutScaffold(record, name, files) {
  const winner = record.variants[name], cwd = winner.path
  if ((await git(cwd, ['status', '--porcelain'])).trim()) fail(`변형 ${name} worktree에 미커밋 변경이 있습니다.`)
  const changed = (await git(cwd, ['diff', '--name-only', '--no-renames', record.scaffold, winner.branch])).split('\n').filter(Boolean)
  if (!changed.length) fail(`변형 ${name}에 scaffold 밖 변경이 없습니다.`)
  const touched = changed.filter((file) => files.includes(file))
  if (touched.length) fail(`변형 ${name}이 scaffold 파일을 고쳐 합치지 않았습니다. 현재 브랜치와 변형 브랜치는 그대로입니다.`, touched)
  await git(cwd, ['checkout', '-q', '--detach', winner.branch])
  try { await git(cwd, ['rebase', '-q', '--onto', record.origin, record.scaffold]) } catch (error) {
    const conflicts = (await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean)
    await git(cwd, ['rebase', '--abort']).catch(() => {})
    await git(cwd, ['checkout', '-q', winner.branch]).catch(() => {})
    fail(`변형 ${name}에서 scaffold를 빼지 못했습니다(rebase 충돌). 현재 브랜치와 변형 브랜치는 그대로입니다.`, conflicts.length ? conflicts : [String(error.stderr ?? error.message).slice(-2000)])
  }
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim()
}

// Adoption merges exactly one variant into the checkout that started the comparison. Recording the
// decision (update-ssot when a rule changed, STATE log otherwise) stays with the calling skill.
export async function abPick(options = {}) {
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  if (!options.variant) fail('--variant가 필요합니다.')
  const [name] = pick(record, options), trees = made(record)
  if (Object.values(record.variants).some((variant) => variant.path === ctx.root)) fail('변형 worktree가 아니라 비교를 시작한 checkout에서 실행하세요.')
  if ((await git(ctx.root, ['status', '--porcelain'])).trim()) fail('합칠 checkout에 미커밋 변경이 있습니다.')
  await update(ctx, slug, stopAll)
  const winner = record.variants[name]
  if (Number((await git(ctx.root, ['rev-list', '--count', `${record.base}..${winner.branch}`])).trim()) === 0) fail(`변형 ${name}에 커밋이 없습니다.`)
  const files = await scaffoldFiles(ctx.root, record)
  const head = record.scaffold ? await withoutScaffold(record, name, files) : winner.branch
  try { await git(ctx.root, ['merge', '--no-ff', '-m', `ab ${slug}: adopt ${name}`, head]) } catch (error) {
    await git(ctx.root, ['merge', '--abort']).catch(() => {})
    if (record.scaffold) await git(winner.path, ['checkout', '-q', winner.branch]).catch(() => {})
    fail(`변형 ${name}을 합치지 못했습니다(충돌). 현재 브랜치는 그대로입니다.`, [String(error.stderr ?? error.message).slice(-2000)])
  }
  const merged = (await git(ctx.root, ['rev-parse', 'HEAD'])).trim()
  await removeWorktrees(ctx, trees)
  const prune = await pruning(ctx, options)
  if (prune) await pruneBranches(ctx, trees)
  await rm(recordFile(ctx, slug), { force: true })
  return { schemaVersion: 1, ok: true, slug, adopted: name, merged, summary: winner.runs.at(-1)?.summary ?? null, branches: prune ? [] : trees.map(([, tree]) => tree.branch),
    ...(record.scaffold ? { scaffold: record.scaffold, scaffoldFiles: files, todo: '채택한 UI는 mock 데이터 위에서 만들어졌습니다(scaffold는 빠짐). 실제 데이터 연결이 남았습니다.' } : {}) }
}

export const AB_STEPS = { start: abStart, run: abRun, serve: abServe, exec: abExec, status: abStatus, pick: abPick, stop: abStop }
