import { mkdir, readFile, writeFile, copyFile, cp, open, access, rm, rmdir, chmod } from 'node:fs/promises'
import { writeSync, constants } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { inspectWorkspace, git } from './workspace.mjs'
import { runtimeRoot, canonicalDestination } from './work-runtime.mjs'
import { atomicJSON, processAlive, controlTransaction } from './loop-control.mjs'
import { executeAgentAdapter, compactUsage, agentPrompt } from './agent-adapter.mjs'
import { inspectProviders, availableProvider, providerFlags } from './work-providers.mjs'
import { readSetting, permissionMode } from './settings.mjs'
import { closeTasks } from './state-doc.mjs'
import { yymmdd } from './spec-format.mjs'
import { SkillPackageError } from './errors.mjs'
import { urlOf, readFeedback, approachLine } from './vibe-ab-hub.mjs'

// A/B comparison: one problem, 2..6 variants, each on its own branch, sibling worktree and
// port. Sessions build the variants; this host owns the mechanical parts a model should not
// spend turns on: worktrees, commits, servers, side-by-side measurements and cleanup.
const fail = (message, details) => { throw new SkillPackageError(message, details) }
const execFileAsync = promisify(execFile)
const NAMES = 'abcdef'
const BASE = 'base' // the scaffold's branch and worktree name; never a variant name
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
const exists = (file) => access(file).then(() => true, () => false)
const tailOf = (text) => text.trimEnd().split('\n').slice(-8)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const HUB = fileURLToPath(new URL('../bin/gusta-ab-hub.mjs', import.meta.url))

async function context(options) {
  const workspace = await inspectWorkspace(options)
  if (!workspace.git?.head) fail('커밋이 있는 Git checkout이 필요합니다.')
  const main = workspace.git.worktrees.find((tree) => !tree.bare)?.path ?? workspace.git.root
  const identity = `${path.basename(main)}-${createHash('sha256').update(workspace.git.commonDir).digest('hex').slice(0, 8)}`
  return { root: workspace.git.root, main, identity, runtime: runtimeRoot(workspace) }
}
const recordFile = (ctx, slug) => path.join(ctx.runtime, 'ab', `${slug}.json`)
const dirOf = (ctx, slug) => path.join(ctx.runtime, 'ab', slug)
const fileOf = (ctx, slug, name) => path.join(dirOf(ctx, slug), name)
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

// A worktree on its own branch ab/<slug>/<name>, with the untracked files the run needs copied in. A
// failed copy takes the worktree and branch away again: they are not in the record for stop to clean.
async function addTree(ctx, slug, name, from, copies) {
  const branch = `ab/${slug}/${name}`
  const destination = await canonicalDestination(path.join(path.dirname(ctx.main), '.gusta-worktrees', ctx.identity, `ab-${slug}-${name}`))
  await git(ctx.root, ['worktree', 'add', '-b', branch, destination, from])
  try {
    for (const file of copies) {
      if (!(await exists(path.join(ctx.root, file)))) continue
      await mkdir(path.dirname(path.join(destination, file)), { recursive: true })
      await copyFile(path.join(ctx.root, file), path.join(destination, file))
    }
  } catch (error) {
    await git(ctx.root, ['worktree', 'remove', '--force', destination]).catch(() => {})
    await git(ctx.root, ['branch', '-D', branch]).catch(() => {})
    throw error
  }
  return { branch, path: destination }
}
// A variant: a worktree on ab/<slug>/<name> from `from` and the first free port from `port` no other variant holds.
async function addVariant(ctx, record, name, from, copies, port) {
  const used = new Set(Object.values(record.variants).map((variant) => variant.port))
  while (used.has(port) || !(await portFree(port))) port++
  return { ...(await addTree(ctx, record.slug, name, from, copies)), port, server: null, runs: [] }
}
const setupResult = (entry) => entry.exitCode === 0 ? { ok: true, ms: entry.ms } : { ok: false, ms: entry.ms, tail: entry.tail, log: entry.log }
function relative(files = [], flag) {
  return files.map((file) => {
    const normal = path.posix.normalize(String(file).replaceAll('\\', '/')).replace(/\/+$/, '')
    if (path.posix.isAbsolute(normal) || normal === '.' || normal === '..' || normal.startsWith('../')) fail(`${flag}는 checkout 안의 상대 경로입니다: ${file}`)
    return normal
  })
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']
const committedBytes = (cwd, spec) => execFileAsync('git', ['-C', cwd, 'show', spec], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }).then((result) => result.stdout, () => null)
// Only git-ignored dirs: a copy over a tracked dir (src) would replace the variant's own files.
// check-ignore exits 128 for a path it cannot judge (beyond a symlinked dir): not ignored either.
async function ignoredDirs(root, dirs) {
  const tracked = []
  for (const dir of dirs) if ((await git(root, ['check-ignore', '-q', `${dir}/`], [1]).catch(() => null)) === null) tracked.push(dir)
  if (tracked.length) fail(`--reuse는 git이 무시하는 의존성 폴더(node_modules 등)만 받습니다: ${tracked.join(', ')}`)
  return dirs
}
// Every lockfile of the nearest directory at or above `dir` that has one, here or in `base`.
async function lockfilesNear(root, dir, base) {
  for (let parent = path.posix.dirname(dir); ; parent = path.posix.dirname(parent)) {
    const files = await Promise.all(LOCKFILES.map(async (name) => {
      const file = path.posix.join(parent, name)
      return { file, local: await readFile(path.join(root, file)).catch(() => null), committed: await committedBytes(root, `${base}:${file}`) }
    }))
    if (files.some((entry) => entry.local || entry.committed)) return files
    if (parent === '.') return []
  }
}
// A --reuse dir is reusable at `base` when it exists here and each of those lockfiles is byte-identical in
// `base` (or absent from both): the copy is then what they install. Returns why not, or null.
async function reuseBlocker(root, dir, base) {
  if (!(await exists(path.join(root, dir)))) return 'not in this checkout'
  const files = await lockfilesNear(root, dir, base)
  if (!files.length) return 'no lockfile'
  const changed = files.find((entry) => entry.local && entry.committed ? !entry.local.equals(entry.committed) : entry.local || entry.committed)
  return changed ? `${changed.file} differs at base` : null
}
const reuseBlockers = async (root, dirs, base) => Object.fromEntries(await Promise.all(dirs.map(async (dir) => [dir, await reuseBlocker(root, dir, base)])))
// Clone one dependency dir. fs.cp walks the tree in JS (minutes for a real node_modules), so the platform
// cp clones it natively first: macOS `/bin/cp -c` (clonefile; GNU cp first on PATH reads -c as
// --preserve=context), GNU `--reflink=auto`, both keeping relative symlinks as they are. BSD cp nests the
// source inside an existing destination, so that case is fs.cp.
export async function copyTree(source, destination, { platform = process.platform, run = execFileAsync } = {}) {
  await mkdir(path.dirname(destination), { recursive: true })
  const native = { darwin: ['/bin/cp', '-c', '-R'], linux: ['cp', '-R', '--reflink=auto', '--no-dereference'] }[platform]
  if (native && !(await exists(destination))) {
    try { await run(native[0], [...native.slice(1), source, destination]); return } catch { await rm(destination, { recursive: true, force: true }) }
  }
  await cp(source, destination, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true })
}
// Dependencies of one worktree: each reusable --reuse dir is cloned from this checkout. Never a symlink: an
// install in the variant would write into this checkout, and bundlers resolve real paths outside the
// worktree. With --setup, one blocked dir sends the worktree straight to setup (npm ci reinstalls anyway).
async function prepare(ctx, slug, prep, { name, path: cwd, port }, blockers) {
  const dirs = Object.keys(blockers), installs = Boolean(prep.setup) && dirs.some((dir) => blockers[dir])
  const reuse = []
  for (const dir of dirs) {
    let reason = blockers[dir] ?? (installs ? 'setup instead' : null)
    const started = Date.now()
    if (!reason) {
      try { await prep.copy(path.join(ctx.root, dir), path.join(cwd, dir)) } catch (error) { reason = `copy failed: ${error.code ?? error.message}` }
    }
    reuse.push(reason ? { dir, reused: false, reason } : { dir, reused: true, ms: Date.now() - started })
  }
  const install = prep.setup && (!reuse.length || reuse.some((entry) => !entry.reused))
  const setup = install ? await shell(prep.setup, cwd, port ? { PORT: String(port) } : {}, fileOf(ctx, slug, `${name}-setup.log`), Number(prep.timeoutMs ?? 1200000)) : null
  return { reuse, setup }
}
// start/add report: setup per worktree that ran it, reuse per worktree when --reuse was given.
function depsReport(prepared) {
  const entries = Object.entries(prepared)
  const setup = entries.filter(([, entry]) => entry.setup).map(([name, entry]) => [name, setupResult(entry.setup)])
  const reuse = entries.filter(([, entry]) => entry.reuse.length).map(([name, entry]) => [name, entry.reuse])
  return { ok: setup.every(([, entry]) => entry.ok), report: { ...(setup.length ? { setup: Object.fromEntries(setup) } : {}), ...(reuse.length ? { reuse: Object.fromEntries(reuse) } : {}) } }
}

async function sessionOptions(ctx, options, deps) {
  const timeoutMs = Number(options.timeoutMs ?? 3600000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('timeout-ms는 양의 정수입니다.')
  const provider = await availableProvider(options, deps.inspect)
  // Optional flags (e.g. Claude's static system prompt) let the variants' shared prefix hit one cache across worktrees.
  return { provider, model: options.model, timeoutMs, allowTools: options.allowTool ?? [], permissionMode: await permissionMode(options, ctx.root), headlessMcp: await readSetting({ root: ctx.root }, 'headless-mcp'),
    flags: await (deps.flags ?? providerFlags)(provider, { env: options.env ?? process.env }) }
}
// One headless session in a worktree. The transcript and the full prompt it got go to runtime files
// (results name their paths, never their content); the host commits, so the session needs no Git permission.
async function headless(execute, session, { role, cwd, prompt, log, subject }) {
  const started = Date.now()
  const job = { schemaVersion: 1, role, workspace: cwd, prompt, timeoutMs: session.timeoutMs, allowTools: session.allowTools, permissionMode: session.permissionMode, headlessMcp: session.headlessMcp }
  await mkdir(path.dirname(log), { recursive: true })
  const promptPath = log.replace(/\.log$/, '.prompt.md')
  await writeFile(promptPath, await agentPrompt(job).catch(() => prompt), { mode: 0o600 })
  await chmod(promptPath, 0o600)
  const file = await open(log, 'w', 0o600)
  let result
  try { result = await execute({ provider: session.provider, model: session.model, job, log: (text) => { try { writeSync(file.fd, text) } catch {} }, flags: session.flags }) } catch (error) {
    throw new SkillPackageError(error.message, [...(error.details ?? []).map((detail) => String(detail).slice(-2000)), `log: ${log}`])
  } finally { await file.close() }
  const changed = (await git(cwd, ['status', '--porcelain'])).trim() !== ''
  if (changed) {
    await git(cwd, ['add', '-A'])
    await git(cwd, ['commit', '-q', '-m', `${subject}: ${result.summary.split('\n')[0].slice(0, 72)}`])
  }
  const commit = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
  return { at: new Date().toISOString(), provider: session.provider, model: session.model ?? null, outcome: result.outcome, summary: result.summary, view: result.view, path: result.path ?? '',
    commit, changed, ms: Date.now() - started, usage: compactUsage(result.usage), log, promptPath }
}

const fields = (text) => text.split('\0').filter(Boolean)
const literal = (file) => `:(literal)${file}`
// Where the scaffold's lines sit in its version of a file, from -U0 hunk headers: "7", "4-5", or "after 9"
// where it removed lines. A binary file has none.
async function scaffoldLines(root, record, file) {
  const patch = await git(root, ['diff-tree', '-p', '-U0', '--no-renames', record.origin, record.scaffold, '--', literal(file)])
  return [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map(([, start, count = '1']) => {
    const from = Number(start), size = Number(count)
    return size === 0 ? `after ${from}` : size === 1 ? `${from}` : `${from}-${from + size - 1}`
  })
}
// What the scaffold commit added and which existing files it modified or deleted. A variant may edit a
// modified text file (editable: where the scaffold's lines are) but not those lines; every other scaffold
// path is read-only. Pick removes exactly the scaffold's lines and files.
async function scaffoldFiles(root, record) {
  const added = [], modified = [], edited = [], editable = {}
  if (record.scaffold) {
    const status = fields(await git(root, ['diff', '--name-status', '-z', '--no-renames', record.origin, record.scaffold]))
    for (let index = 0; index < status.length; index += 2) {
      const code = status[index], file = status[index + 1]
      ;(code === 'A' ? added : modified).push(file)
      if (code === 'M') edited.push(file)
      const lines = code === 'M' ? await scaffoldLines(root, record, file) : []
      if (lines.length) editable[file] = lines
    }
  }
  return { all: [...added, ...modified].sort(), added, modified, edited, editable }
}
// A scaffold that edited existing UI files may have edited the target screen itself, which the variants
// redesign: start names them for the coordinator to look at.
const UI_FILE = /\.(?:html|css|scss|jsx|tsx|vue|svelte|astro)$/i, UI_DIRS = new Set(['components', 'pages', 'app', 'routes', 'views'])
export function scaffoldWarnings(modified) {
  const ui = modified.filter((file) => UI_FILE.test(file) || file.toLowerCase().split('/').slice(0, -1).some((dir) => UI_DIRS.has(dir)))
  return ui.length ? [`scaffold modified likely UI files: ${ui.join(', ')} — redo the scaffold if it edited the target screen itself`] : []
}
// Paths whose net content differs between two commits.
const netChanges = async (cwd, from, to) => fields(await git(cwd, ['diff', '--name-only', '-z', '--no-renames', from, to]))

export async function abStart(options = {}, injected = {}) {
  const deps = { inspect: inspectProviders, execute: executeAgentAdapter, copy: copyTree, ...injected }
  const ctx = await context(options), slug = slugOf(options)
  if (await exists(recordFile(ctx, slug))) fail(`비교 ${slug}가 이미 있습니다. vibe ab status ${slug} 또는 stop --remove 후 다시 시작하세요.`)
  const count = Number(options.variants ?? 2)
  if (!Number.isInteger(count) || count < 2 || count > NAMES.length) fail(`variants는 2~${NAMES.length}입니다.`)
  if ((await git(ctx.root, ['status', '--porcelain'])).trim()) fail('미커밋 변경이 있습니다. 변형은 커밋된 기준에서 시작합니다 — 사용자 변경을 먼저 정리하세요.')
  const copies = relative(options.copy, '--copy'), reuse = await ignoredDirs(ctx.root, relative(options.reuse, '--reuse'))
  if (options.scaffold && options.scaffoldPrompt) fail('--scaffold(있는 커밋)와 --scaffold-prompt(새로 만들기) 중 하나만 줍니다.')
  const origin = (await git(ctx.root, ['rev-parse', '--verify', `${options.base ?? 'HEAD'}^{commit}`])).trim()
  let scaffold = options.scaffold ? (await git(ctx.root, ['rev-parse', '--verify', `${options.scaffold}^{commit}`])).trim() : null
  if (scaffold && (scaffold === origin || (await git(ctx.root, ['merge-base', '--is-ancestor', origin, scaffold], [1])) === null)) fail(`scaffold ${options.scaffold}는 기준(${options.base ?? 'HEAD'}) 위의 커밋이어야 합니다. --base로 그 기준을 주세요.`)
  const port = Number(options.basePort ?? 4101)
  if (!Number.isInteger(port) || port < 1024 || port > 65000) fail('base-port는 1024~65000입니다.')
  // Read now: the coordinator's temporary files may be gone before the variants run.
  const shared = options.sharedFile ? await readFile(path.resolve(options.sharedFile), 'utf8') : ''
  const brief = options.scaffoldPrompt ? await readFile(path.resolve(options.scaffoldPrompt), 'utf8') : null
  const session = brief ? await sessionOptions(ctx, options, deps) : null
  // How worktrees get their dependencies is kept: add uses it for a remix unless told otherwise.
  const record = { schemaVersion: 1, slug, base: origin, createdAt: new Date().toISOString(), variants: {}, prepare: { setup: options.setup ?? null, copy: copies, reuse }, ...(shared.trim() ? { shared } : {}) }
  const prep = { setup: options.setup, timeoutMs: options.timeoutMs, copy: deps.copy }
  // start owns the record until it returns; its writes still take the lock so none interleaves with another command's.
  const store = () => locked(ctx, slug, () => save(ctx, record))
  for (const name of ['feedback.json', 'hub.json']) await rm(fileOf(ctx, slug, name), { force: true })
  if (brief) {
    // One session makes the screen render from fixtures on ab/<slug>/base; every variant starts from its commit.
    const tree = record.scaffoldTree = await addTree(ctx, slug, BASE, origin, copies)
    await store()
    const prepared = depsReport({ [BASE]: await prepare(ctx, slug, prep, { name: BASE, path: tree.path }, await reuseBlockers(ctx.root, reuse, origin)) })
    if (!prepared.ok) return { schemaVersion: 1, ok: false, slug, origin, ...prepared.report }
    const prompt = [shared.trim() && `Comparison context (the variants build this; you build only the scaffold):\n${shared.trim()}`, brief].filter(Boolean).join('\n\n')
    const run = record.scaffoldRun = await headless(deps.execute, session, { role: 'scaffold', cwd: tree.path, prompt, log: fileOf(ctx, slug, `${BASE}-run.log`), subject: `ab ${slug}/${BASE}: scaffold` })
    if (run.outcome !== 'completed' || !run.changed) {
      await store()
      return { schemaVersion: 1, ok: false, slug, origin, error: 'scaffold가 완료되지 않았거나 변경이 없어 변형을 만들지 않았습니다. 확인 후 stop --remove.', scaffoldRun: run }
    }
    scaffold = run.commit
    await git(ctx.root, ['worktree', 'remove', tree.path])
    record.scaffoldTree = { branch: tree.branch }
  }
  if (scaffold) Object.assign(record, { base: scaffold, origin, scaffold })
  for (const name of NAMES.slice(0, count)) {
    record.variants[name] = await addVariant(ctx, record, name, record.base, copies, port)
    await store()
  }
  // Dependencies go into every worktree at once; a failure keeps the worktrees for a retry.
  const blockers = await reuseBlockers(ctx.root, reuse, record.base)
  const installed = depsReport(Object.fromEntries(await Promise.all(Object.entries(record.variants).map(async ([name, variant]) => [name, await prepare(ctx, slug, prep, { name, ...variant }, blockers)]))))
  const run = record.scaffoldRun
  const files = await scaffoldFiles(ctx.root, record), warnings = scaffoldWarnings(files.modified)
  return { schemaVersion: 1, ok: installed.ok, slug, base: record.base, ...(scaffold ? { origin, scaffold, scaffoldFiles: { added: files.added, modified: files.modified } } : {}),
    ...(warnings.length ? { scaffoldWarnings: warnings } : {}),
    ...(run ? { scaffoldRun: { summary: run.summary, view: run.view, path: run.path, ms: run.ms, usage: run.usage, log: run.log, promptPath: run.promptPath } } : {}),
    variants: Object.entries(record.variants).map(([name, variant]) => ({ variant: name, branch: variant.branch, path: variant.path, port: variant.port, url: urlOf(variant) })), ...installed.report }
}

// A remix ("a's layout with b's colours"): the next variant starts from <from>'s committed work on its own
// branch, worktree and port. It still descends from the base (and the scaffold), so pick works unchanged.
export async function abAdd(options = {}, injected = {}) {
  const deps = { copy: copyTree, ...injected }
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  if (!options.from) fail('--from <변형>이 필요합니다(새 변형이 이어받을 변형).')
  const [from] = pick(record, { variant: options.from })
  const name = [...NAMES].find((letter) => !record.variants[letter])
  if (!name) fail(`변형은 최대 ${NAMES.length}개입니다.`)
  // start's --setup/--copy/--reuse are the defaults; a flag given here replaces that one.
  const stored = record.prepare ?? {}, setup = options.setup ?? stored.setup ?? null
  const copies = options.copy ? relative(options.copy, '--copy') : stored.copy ?? []
  const reuse = options.reuse ? await ignoredDirs(ctx.root, relative(options.reuse, '--reuse')) : stored.reuse ?? []
  if (await dirty(record.variants[from])) fail(`변형 ${from}에 미커밋 변경이 있습니다 — 실행이 끝난 뒤 다시 하세요.`)
  const tip = (await git(ctx.root, ['rev-parse', `${record.variants[from].branch}^{commit}`])).trim()
  const variant = { ...(await addVariant(ctx, record, name, tip, copies, Math.min(...Object.values(record.variants).map((entry) => entry.port)))), from }
  await update(ctx, slug, (live) => { live.variants[name] = variant })
  const installed = depsReport({ [name]: await prepare(ctx, slug, { setup, timeoutMs: options.timeoutMs, copy: deps.copy }, { name, ...variant }, await reuseBlockers(ctx.root, reuse, tip)) })
  return { schemaVersion: 1, ok: installed.ok, slug, variant: name, from, branch: variant.branch, path: variant.path, port: variant.port, url: urlOf(variant), ...installed.report }
}

// The scaffold rule: read-only paths, editable files with where the scaffold's lines are (not their
// content), the scaffold session's notes and its data states.
function scaffoldRule(record, files) {
  if (!files.all.length) return ''
  const editable = Object.entries(files.editable), readOnly = files.all.filter((file) => !files.editable[file])
  return ['Shared mock scaffold: adopting a variant removes exactly its lines and files.', readOnly.length && `Read-only: ${readOnly.join(', ')}.`,
    editable.length && `You may edit ${editable.map(([file]) => file).join(', ')} except the scaffold's lines and the lines right around them (${editable.map(([file, lines]) => `${file}: ${lines.join(', ')}`).join('; ')}).`,
    record.scaffoldRun?.summary && `Scaffold notes: ${record.scaffoldRun.summary.trim()}`,
    'If it offers data states (e.g. ?mock=empty), design them too and name them in view. If you need different data, say so in summary.'].filter(Boolean).join(' ')
}

// [scaffold rule][shared text] then [variant line][approach][follow-up]: everything before the variant
// line is the same for every variant (one cacheable prefix), and a follow-up repeats the first run's
// prompt before what is new, so a fresh session knows the goal and the approach it continues.
function variantPrompt(record, name, files, { approach, followUp, note }) {
  const variant = record.variants[name], last = variant.runs.at(-1), others = Object.keys(record.variants).filter((other) => other !== name)
  // Worktrees share refs, so a remix can read what the other variants did without leaving its own.
  const remix = variant.from && `You start from variant ${variant.from}'s work (already on your branch). Other variants' changes: git diff ${record.base} ab/${record.slug}/<x>, x in ${others.join(', ')}.`
  return [scaffoldRule(record, files),
    record.shared?.trim(), `Variant ${name} of ${record.slug}. $PORT for this variant: ${variant.port}.`, remix, approach,
    ...(followUp === undefined ? [] : [last && `Your last run's summary: ${last.summary}`, note && `The person's note on this variant: ${note}`,
      `Your branch already contains this work; change only what is asked.\n\nFollow-up request:\n${followUp}`])].filter(Boolean).join('\n\n')
}

// One variant session: a first run with its approach or a follow-up on the same branch. The result is
// saved under the record lock as soon as the session ends.
async function runVariant(ctx, record, name, session, deps, { approach, followUp }) {
  const slug = record.slug, variant = record.variants[name]
  // Only a hub note written after the last run is news to the session.
  const hubNote = followUp === undefined ? null : (await readFeedback(fileOf(ctx, slug, 'feedback.json'))).notes[name]
  const note = hubNote && Date.parse(hubNote.at) > Date.parse(variant.runs.at(-1).at) ? hubNote.note : null
  const files = await scaffoldFiles(ctx.root, record)
  // The approach stays with the variant: a follow-up repeats it without the coordinator rewriting it.
  const prompt = variantPrompt(record, name, files, { approach: approach ?? variant.approach, followUp, note })
  const run = await headless(deps.execute, session, { role: 'variant', cwd: variant.path, prompt, log: fileOf(ctx, slug, `${name}-run-${variant.runs.length + 1}.log`), subject: `ab ${slug}/${name}` })
  if (followUp !== undefined) run.followUp = true
  const live = await update(ctx, slug, (current) => { current.variants[name].runs.push(run); if (approach !== undefined) current.variants[name].approach = approach })
  // A scaffold-line edit or copy is caught here, before the person compares: pick would refuse this variant.
  const adopted = record.scaffold ? await withoutScaffold(ctx, record, run.commit, files) : {}
  const touched = adopted.conflicts ?? [], residue = adopted.residue ?? []
  return { ok: run.outcome === 'completed' && !touched.length && !residue.length, variant: name, url: urlOf(live.variants[name]), ...run,
    ...(touched.length ? { scaffoldTouched: touched } : {}), ...(residue.length ? { scaffoldResidue: residue } : {}) }
}

export async function abRun(options = {}, injected = {}) {
  const deps = { inspect: inspectProviders, execute: executeAgentAdapter, ...injected }
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  if (options.all) return runAll(ctx, record, options, deps)
  if (options.promptDir) fail('--prompt-dir는 --all과 함께 씁니다.')
  if (!options.variant) fail('--variant가 필요합니다(모든 변형을 한 번에: --all --prompt-dir <dir>).')
  const [name] = pick(record, options), variant = record.variants[name]
  if (Boolean(options.promptFile) === Boolean(options.followUpFile)) fail('--prompt-file(이 변형의 접근) 또는 --follow-up-file(이어 고칠 요청) 중 하나가 필요합니다.')
  if (options.followUpFile && !variant.runs.length) fail(`변형 ${name}은 아직 실행되지 않았습니다. 먼저 --prompt-file로 실행하세요.`)
  const approach = options.promptFile ? await readFile(path.resolve(options.promptFile), 'utf8') : undefined
  const followUp = options.followUpFile ? await readFile(path.resolve(options.followUpFile), 'utf8') : undefined
  return { schemaVersion: 1, slug, ...(await runVariant(ctx, record, name, await sessionOptions(ctx, options, deps), deps, { approach, followUp })) }
}

// --all: every variant with <dir>/<v>.md runs at once in this one process, so a background launch wakes
// the coordinator once instead of once per variant. One failed session does not stop or drop the others.
async function runAll(ctx, record, options, deps) {
  if (options.variant || options.promptFile || options.followUpFile) fail('--all은 --prompt-dir의 <v>.md로만 실행합니다(--variant·--prompt-file·--follow-up-file 없이).')
  if (!options.promptDir) fail('--all에는 --prompt-dir <dir>가 필요합니다(변형마다 <v>.md).')
  const names = Object.keys(record.variants)
  const found = await Promise.all(names.map(async (name) => [name, await readFile(path.resolve(options.promptDir, `${name}.md`), 'utf8').catch(() => null)]))
  const approaches = found.filter(([, text]) => text !== null), skipped = found.filter(([, text]) => text === null).map(([name]) => name)
  if (!approaches.length) fail(`${options.promptDir}에 변형 프롬프트가 없습니다: ${names.map((name) => `${name}.md`).join(', ')}`)
  const session = await sessionOptions(ctx, options, deps)
  // The residue marks once, before the parallel runs that all check against them.
  if (record.scaffold) await scaffoldMarks(ctx, record, await scaffoldFiles(ctx.root, record))
  const variants = await Promise.all(approaches.map(([name, approach]) => runVariant(ctx, record, name, session, deps, { approach }).catch((error) =>
    ({ ok: false, variant: name, error: error.message, ...(error.details?.length ? { details: error.details } : {}) }))))
  return { schemaVersion: 1, ok: variants.every((entry) => entry.ok), slug: record.slug, variants, skipped }
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
  if (!up) return null
  // Some hosts map localhost only to IPv4 even when the dev server binds only ::1.
  // Prefer localhost, then publish the actual reachable loopback in every preview URL.
  delete variant.server.host
  const answer = await probe(urlOf(variant), Math.max(5000, deadline - Date.now()))
  if (!answer?.error) return answer
  for (const host of LOOPBACKS) {
    if (!(await connects(variant.port, host))) continue
    variant.server.host = host
    const alternate = await probe(urlOf(variant), Math.max(5000, deadline - Date.now()))
    if (!alternate?.error) return alternate
  }
  delete variant.server.host
  return answer
}

// The hub is detached like the dev servers and reports its own free port. Its URL uses localhost,
// which the variants also prefer for same-site cookies. The start decision
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
        env: { ...process.env, PORT: String(variant.port), GUSTA_AB_VARIANT: name }, stdio: ['ignore', file.fd, file.fd] })
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
  await update(ctx, slug, (current) => {
    for (const name of names) {
      const server = current.variants[name].server, checked = live.variants[name].server
      if (server?.pid !== checked?.pid) continue
      if (checked?.host) server.host = checked.host
      else if (server) delete server.host
    }
  })
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
      runs[name].push(await shell(options.command, variant.path, { PORT: String(variant.port), GUSTA_AB_VARIANT: name }, path.join(ctx.runtime, 'ab', slug, `${name}-exec-${round + 1}.log`), timeoutMs))
    }
  }
  const variants = names.map((name) => {
    const times = runs[name].map((entry) => entry.ms).sort((a, b) => a - b)
    const last = runs[name].at(-1)
    return { variant: name, exitCodes: runs[name].map((entry) => entry.exitCode), minMs: times[0], medianMs: times[Math.floor((times.length - 1) / 2)], maxMs: times.at(-1), tail: last.tail, log: last.log }
  })
  // The hub shows the latest measurement under each frame: numbers and the last output line, never the log.
  const at = new Date().toISOString()
  await update(ctx, slug, (live) => { for (const entry of variants) if (live.variants[entry.variant]) live.variants[entry.variant].exec = { at, command: options.command, repeat,
    medianMs: entry.medianMs, minMs: entry.minMs, exitCodes: entry.exitCodes, last: String(entry.tail.at(-1) ?? '').slice(0, 300) } })
  return { schemaVersion: 1, ok: variants.every((entry) => entry.exitCodes.every((code) => code === 0)), slug, command: options.command, repeat, variants }
}

export async function abStatus(options = {}) {
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  const variants = []
  for (const [name, variant] of Object.entries(record.variants)) {
    const ahead = Number((await git(ctx.root, ['rev-list', '--count', `${record.base}..${variant.branch}`]).catch(() => '0')).trim())
    const serving = Boolean(variant.server?.pid && processAlive(variant.server.pid))
    variants.push({ variant: name, ...(variant.from ? { from: variant.from } : {}), branch: variant.branch, path: variant.path, url: urlOf(variant), serving, commits: ahead, last: variant.runs.at(-1) ? { outcome: variant.runs.at(-1).outcome, summary: variant.runs.at(-1).summary, view: variant.runs.at(-1).view } : null })
  }
  // The hub's notes and choice are what the person said; a choice is intent, adopting stays pick.
  const hub = record.hub?.url && processAlive(record.hub.pid) ? record.hub.url : null
  return { schemaVersion: 1, ok: true, slug, base: record.base, ...(record.scaffold ? { origin: record.origin, scaffold: record.scaffold } : {}), createdAt: record.createdAt, hub, feedback: await readFeedback(fileOf(ctx, slug, 'feedback.json')), variants }
}

// Every worktree and branch the comparison made: the variants and the branch its scaffold session
// made (a reused --scaffold ref belongs to the caller and stays). A removed worktree has no path.
const made = (record) => [...Object.entries(record.variants), ...(record.scaffoldTree ? [[BASE, record.scaffoldTree]] : [])]
const dirty = async (tree) => Boolean(tree.path) && (await git(tree.path, ['status', '--porcelain']).catch(() => '')).trim() !== ''
// A dirty variant worktree may hold unfinished work, so removal refuses. The scaffold's worktree is
// left only when its session failed: that throwaway mock work goes with --force.
async function checkClean(trees) {
  const names = []
  for (const [name, tree] of trees) if (name !== BASE && await dirty(tree)) names.push(name)
  if (names.length) fail(`커밋되지 않은 변경이 있는 변형: ${names.join(', ')}. vibe ab run으로 끝내거나 직접 정리하세요.`)
}
async function removeWorktrees(ctx, trees) {
  await checkClean(trees)
  let discarded = false
  for (const [name, tree] of trees) {
    if (!tree.path) continue
    const force = name === BASE && await dirty(tree)
    await git(ctx.root, ['worktree', 'remove', ...(force ? ['--force'] : []), tree.path])
    discarded ||= force
  }
  return discarded
}
async function pruneBranches(ctx, trees) {
  for (const [, tree] of trees) await git(ctx.root, ['branch', '-D', tree.branch]).catch(() => {})
}
// Once a variant is picked or the comparison is dropped no variant branch is used again:
// they go by default (spec/SETTINGS.md prune-branches); --prune-branches forces it when that is false.
const pruning = async (ctx, options) => options.pruneBranches || await readSetting({ root: ctx.root }, 'prune-branches')
// After pick or stop --remove: the sibling folders the worktrees lived in go once empty (rmdir removes only
// an empty one), and under the same pruning rule the comparison's runtime folder (logs, feedback, prompts).
async function tidy(ctx, slug, trees, prune) {
  for (const dir of new Set(trees.filter(([, tree]) => tree.path).map(([, tree]) => path.dirname(tree.path)))) {
    if (await rmdir(dir).then(() => true, () => false)) await rmdir(path.dirname(dir)).catch(() => {})
  }
  if (prune) await rm(dirOf(ctx, slug), { recursive: true, force: true })
}

export async function abStop(options = {}) {
  const ctx = await context(options), slug = slugOf(options), record = await update(ctx, slug, stopAll)
  const trees = made(record)
  const prune = options.remove && await pruning(ctx, options)
  let discarded = false
  if (options.remove) {
    discarded = await removeWorktrees(ctx, trees)
    if (prune) await pruneBranches(ctx, trees)
    await rm(recordFile(ctx, slug), { force: true })
    await tidy(ctx, slug, trees, prune)
  }
  return { schemaVersion: 1, ok: true, slug, stopped: Object.keys(record.variants), removed: Boolean(options.remove), branches: prune ? [] : trees.map(([, tree]) => tree.branch),
    ...(discarded ? { note: '실패한 scaffold 세션이 남긴 미커밋 mock 변경은 버렸습니다.' } : {}) }
}

// git with a private index file, so a tree is built without touching any worktree or the real index.
function indexGit(cwd, index, args, input) {
  const running = execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', GIT_INDEX_FILE: index } })
  running.child.stdin.on('error', () => {})
  running.child.stdin.end(input)
  return running.then((result) => result.stdout)
}
// The scaffold's reverse patch (scaffold to origin) as bytes; plumbing diff-tree ignores the diff UI config
// (noprefix, color) git apply could not read back.
const reversePatch = async (root, record, file) => (await execFileAsync('git', ['-C', root, 'diff-tree', '-r', '-p', '--binary', '--full-index', '--no-renames',
  record.scaffold, record.origin, ...(file ? ['--', literal(file)] : [])], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })).stdout
// Git output that may be large (whole-file patches).
const gitOut = async (root, args) => (await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout
// Added and removed lines of a patch, trimmed; a file's ---/+++ header ends at its first hunk.
function patchLines(patch) {
  const sections = new Map()
  let current = null, hunk = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { current = sections.get(line) ?? { added: [], removed: [] }; sections.set(line, current); hunk = false }
    else if (line.startsWith('@@')) hunk = true
    else if (hunk && line[0] === '+') current.added.push(line.slice(1).trim())
    else if (hunk && line[0] === '-') current.removed.push(line.slice(1).trim())
  }
  return sections
}
// One -U0 diff between two trees, split by file: { file: { added, removed } }. A path git still quotes
// (control characters, quotes, backslashes) is not found by its header and gets a call of its own.
async function linesByFile(root, from, to, names) {
  const sections = patchLines(await gitOut(root, ['-c', 'core.quotePath=false', 'diff-tree', '-r', '-p', '-U0', '--no-renames', from, to]))
  const result = {}
  for (const name of names) {
    result[name] = sections.get(`diff --git a/${name} b/${name}`)
      ?? [...patchLines(await gitOut(root, ['diff-tree', '-p', '-U0', '--no-renames', from, to, '--', literal(name)])).values()][0] ?? { added: [], removed: [] }
  }
  return result
}
// Blank lines, lone braces or brackets and bare tags say nothing about where a line came from.
const TRIVIAL = /^(?:[\s{}()[\];,]*|<\/?[\w.:-]+>)$/
// The lines origin already has somewhere: common code (an import, a return), not scaffold wiring.
async function inOrigin(root, origin, lines) {
  if (!lines.length) return new Set()
  const running = execFileAsync('git', ['-C', root, 'grep', '-h', '-o', '-I', '-F', '-f', '-', origin], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
  running.child.stdin.on('error', () => {})
  running.child.stdin.end(`${lines.join('\n')}\n`)
  return new Set((await running.then((result) => result.stdout, (error) => error.code === 1 ? '' : Promise.reject(error))).split('\n').map((line) => line.trim()))
}
const stripExt = (text) => text.replace(/\.[^./]+$/, '')
const endsWithPath = (whole, tail) => whole === tail || whole.endsWith(`/${tail}`)
// What marks scaffold wiring, from origin and the scaffold alone:
// - lines: non-trivial lines the scaffold inserted into files origin had (a script tag, an entry import, an
//   alias line), not lines it moved and none origin has elsewhere. Files it added are its own code: their
//   boilerplate (hooks, returns) is everybody's, so they give path marks only.
// - paths: how code names a file it added. Tails of two or more segments, with and without the extension,
//   whose directory part origin lacks (mocks/handlers, never api/client); a */index.* also names its
//   directory. One-segment names (root files, a bare directory) count only inside a string ('./fixtures',
//   '../mocks'). A mark origin could resolve itself (the end of an origin file or directory path) is dropped.
async function computeMarks(root, record, files) {
  const listing = fields(await git(root, ['ls-tree', '-r', '-z', '--name-only', record.origin]))
  const dirExists = (dir) => listing.some((file) => file.startsWith(`${dir}/`) || file.includes(`/${dir}/`))
  const resolvable = (mark) => dirExists(mark) || listing.some((file) => endsWithPath(file, mark) || endsWithPath(stripExt(file), mark))
  const paths = new Map()
  const offer = (mark, quoted) => {
    if (!mark || paths.has(mark) || resolvable(mark) || (!quoted && dirExists(path.posix.dirname(mark)))) return
    paths.set(mark, { text: mark, quoted })
  }
  for (const file of files.added) {
    const parts = file.split('/')
    if (parts.length === 1) for (const mark of [file, stripExt(file)]) offer(mark, true)
    for (let size = 2; size <= parts.length; size++) for (const mark of [parts.slice(-size).join('/'), stripExt(parts.slice(-size).join('/'))]) offer(mark, false)
    if (parts.length > 1 && /^index\.[^./]+$/.test(parts.at(-1))) {
      const dir = parts.slice(0, -1)
      for (let size = 1; size <= dir.length; size++) offer(dir.slice(-size).join('/'), size === 1)
    }
  }
  const sections = await linesByFile(root, record.origin, record.scaffold, files.all)
  const moved = new Set(Object.values(sections).flatMap((entry) => entry.removed))
  const candidates = [...new Set(files.edited.flatMap((file) => sections[file]?.added ?? []).filter((line) => !TRIVIAL.test(line) && !moved.has(line)))]
  const common = await inOrigin(root, record.origin, candidates)
  return { lines: candidates.filter((line) => !common.has(line)), paths: [...paths.values()] }
}
// Marks depend only on origin and the scaffold: computed on first use and kept in the runtime under both SHAs.
async function scaffoldMarks(ctx, record, files) {
  const file = fileOf(ctx, record.slug, `marks-${record.origin.slice(0, 12)}-${record.scaffold.slice(0, 12)}.json`)
  const cached = await readFile(file, 'utf8').then(JSON.parse, () => null)
  if (cached) return cached
  const marks = await computeMarks(ctx.root, record, files)
  await atomicJSON(file, marks)
  return marks
}
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const markPattern = ({ text, quoted }) => new RegExp(quoted ? `(?<=['"\`/])${escaped(text)}(?=['"\`])` : `(?<![\\w-])${escaped(text)}(?![\\w-])`)
// Scaffold residue in an adopted tree: lines it adds over origin that repeat a scaffold wiring line or name a
// file the scaffold added (its mock <script> copied elsewhere, an import of its handlers). Adopted, that
// wiring would ship pointing at a deleted file.
async function scaffoldResidue(ctx, record, files, tree) {
  const marks = await scaffoldMarks(ctx, record, files)
  if (!marks.lines.length && !marks.paths.length) return []
  const lines = new Set(marks.lines), patterns = marks.paths.map(markPattern), found = new Map()
  const sections = await linesByFile(ctx.root, record.origin, tree, await netChanges(ctx.root, record.origin, tree))
  for (const [file, { added }] of Object.entries(sections)) {
    for (const line of added) if (line && (lines.has(line) || patterns.some((pattern) => pattern.test(line)))) found.set(`${file}\0${line}`, { file, line: line.slice(0, 200) })
  }
  return [...found.values()].slice(0, 20)
}
// A scaffold never ships: the adopted tree is the variant's with the scaffold's reverse patch applied in a
// private index, so exactly the scaffold's lines go. Its new files are deleted, files it deleted come back,
// and a file it modified keeps the variant's other edits. Direct apply first, then 3-way (an edit a few lines
// away changes the patch's context but still merges; `apply --cached --3way` needs Git 2.32+, and older Git
// refuses such edits too). Returns { tree, residue }, or { conflicts }: the scaffold paths the variant
// changed, or edited too close to the scaffold's lines, whose part of the patch no longer applies.
async function withoutScaffold(ctx, record, commit, files) {
  const index = fileOf(ctx, record.slug, `adopt-${randomUUID()}.index`)
  await mkdir(path.dirname(index), { recursive: true })
  const applies = async (patch) => {
    await indexGit(ctx.root, index, ['read-tree', commit])
    if (!patch.length) return true
    for (const mode of [[], ['--3way']]) {
      if (await indexGit(ctx.root, index, ['apply', '--cached', '--binary', '--whitespace=nowarn', ...mode, '-'], patch).then(() => true, () => false)) return true
    }
    return false
  }
  try {
    if (await applies(await reversePatch(ctx.root, record))) {
      const tree = (await indexGit(ctx.root, index, ['write-tree'])).trim()
      return { tree, residue: await scaffoldResidue(ctx, record, files, tree) }
    }
    // Only a scaffold path the variant changed can block its own part (a path's patch holds what lies under it).
    const changed = (await netChanges(ctx.root, record.scaffold, commit)).filter((file) => files.all.includes(file))
    const conflicts = []
    for (const file of changed) if (!(await applies(await reversePatch(ctx.root, record, file)))) conflicts.push(file)
    return { conflicts: conflicts.length ? conflicts : changed.length ? changed : files.all }
  } finally { await rm(index, { force: true }) }
}

const STATE = 'spec/STATE.md'

// Adoption merges exactly one variant into the checkout that started the comparison and logs it in
// STATE, uncommitted like vibe beat. gusta-update-ssot, when the choice changed a rule, stays with the skill.
export async function abPick(options = {}) {
  const ctx = await context(options), slug = slugOf(options), record = await load(ctx, slug)
  if (!options.variant) fail('--variant가 필요합니다.')
  const [name] = pick(record, options), trees = made(record), winner = record.variants[name]
  if (Object.values(record.variants).some((variant) => variant.path === ctx.root)) fail('변형 worktree가 아니라 비교를 시작한 checkout에서 실행하세요.')
  if ((await git(ctx.root, ['status', '--porcelain'])).trim()) fail('합칠 checkout에 미커밋 변경이 있습니다.')
  // Predictable refusals come before servers and the hub stop, so the comparison stays on screen.
  if (Number((await git(ctx.root, ['rev-list', '--count', `${record.base}..${winner.branch}`])).trim()) === 0) fail(`변형 ${name}에 커밋이 없습니다.`)
  const tip = (await git(ctx.root, ['rev-parse', `${winner.branch}^{commit}`])).trim(), files = await scaffoldFiles(ctx.root, record)
  const adopted = record.scaffold ? await withoutScaffold(ctx, record, tip, files) : null
  if (adopted?.conflicts) fail(`변형 ${name}이 scaffold의 줄·파일을 바꿨거나 그 줄에 너무 붙여 고쳐 scaffold를 뺄 수 없습니다 — 되돌리는 follow-up 뒤에 다시 고르세요. 현재 브랜치와 변형 브랜치는 그대로입니다.`, adopted.conflicts)
  // --accept-residue is the person's call after seeing the lines: they are adopted and listed in the result.
  if (adopted?.residue.length && !options.acceptResidue) fail(`변형 ${name}에 scaffold의 mock 줄·경로가 옮겨져 남습니다(합치면 지워진 파일을 가리킴) — 지우는 follow-up 뒤에 다시 고르세요(사용자가 그 줄을 보고 받아들이면 --accept-residue). 현재 브랜치와 변형 브랜치는 그대로입니다.`, adopted.residue.map(({ file, line }) => `${file}: ${line}`))
  if (adopted && adopted.tree === (await git(ctx.root, ['rev-parse', `${record.origin}^{tree}`])).trim()) fail(`변형 ${name}에 scaffold 밖 변경이 없습니다.`)
  await checkClean(trees)
  // The adopt commit (scaffold removed, on top of origin) is built before anything stops: an unexpected Git
  // failure leaves the comparison running.
  const summary = winner.runs.at(-1)?.summary.split('\n')[0].slice(0, 72) ?? ''
  const head = adopted ? (await git(ctx.root, ['commit-tree', adopted.tree, '-p', record.origin, '-m', `ab ${slug}/${name} without its mock scaffold${summary ? `: ${summary}` : ''}`])).trim() : tip
  await update(ctx, slug, stopAll)
  try { await git(ctx.root, ['merge', '--no-ff', '-m', `ab ${slug}: adopt ${name}`, head]) } catch (error) {
    await git(ctx.root, ['merge', '--abort']).catch(() => {})
    fail(`변형 ${name}을 합치지 못했습니다(충돌). 현재 브랜치는 그대로입니다.`, [String(error.stderr ?? error.message).slice(-2000)])
  }
  const merged = (await git(ctx.root, ['rev-parse', 'HEAD'])).trim()
  await removeWorktrees(ctx, trees)
  const prune = await pruning(ctx, options)
  if (prune) await pruneBranches(ctx, trees)
  await rm(recordFile(ctx, slug), { force: true })
  const state = await readFile(path.join(ctx.root, STATE), 'utf8').catch(() => null), approach = approachLine(options.approach ?? winner.approach ?? winner.runs.at(-1)?.summary)
  const logLine = state === null ? null : `- ${yymmdd()} ab ${slug}: adopt ${name}${approach ? ` — ${approach}` : ''}`
  if (logLine) await writeFile(path.join(ctx.root, STATE), closeTasks(state, [], { log: logLine }).text)
  await tidy(ctx, slug, trees, prune)
  return { schemaVersion: 1, ok: true, slug, adopted: name, merged, logLine, files: logLine ? [STATE] : [], summary: winner.runs.at(-1)?.summary ?? null, branches: prune ? [] : trees.map(([, tree]) => tree.branch),
    ...(adopted?.residue.length ? { scaffoldResidue: adopted.residue } : {}),
    ...(record.scaffold ? { scaffold: record.scaffold, scaffoldFiles: { added: files.added, modified: files.modified }, todo: '채택한 UI는 mock 데이터 위에서 만들어졌습니다(scaffold는 빠짐). 실제 데이터 연결이 남았습니다.' } : {}) }
}

export const AB_STEPS = { start: abStart, add: abAdd, run: abRun, serve: abServe, exec: abExec, status: abStatus, pick: abPick, stop: abStop }
