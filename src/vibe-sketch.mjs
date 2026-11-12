import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rm, appendFile, open, stat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectWorkspace, git } from './workspace.mjs'
import { runtimeRoot } from './work-runtime.mjs'
import { atomicJSON, processAlive, readJSON, controlTransaction } from './loop-control.mjs'
import { SkillPackageError } from './errors.mjs'

// Sketches: a planning skill (gusta-sketch) writes one self-contained HTML page under the checkout's
// .tmp/sketch/<slug>/ and this host serves it on one loopback port, so no session hand-rolls a server.
// Records live in the clone's runtime; every server leaves by itself after its TTL.
const fail = (message, details) => { throw new SkillPackageError(message, details) }
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
const TTL_MS = 8 * 60 * 60 * 1000
const MAX_TIMER_MS = 2 ** 31 - 1 // a longer setTimeout fires at once
const HEADER = 'x-gusta-sketch' // the serving pid: reuse checks the port still answers as the recorded server
const SERVE = fileURLToPath(new URL('../bin/gusta-sketch-serve.mjs', import.meta.url))
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const sketchUrl = (port) => `http://127.0.0.1:${port}/`

// Static files under dir only: `/` (and any `…/`) is index.html, a directory is never listed, an
// extension outside TYPES is 404, and a path that resolves outside dir (`..`, encoded or through a
// symlink) is refused. Only loopback Host names are served, so a rebound DNS name cannot read it.
export function sketchHandler(dir) {
  let base = null
  return async (request, response) => {
    const send = (status, headers, body) => {
      response.writeHead(status, { 'cache-control': 'no-store', [HEADER]: String(process.pid), ...headers })
      response.end(request.method === 'HEAD' ? undefined : body)
    }
    const text = (status, message) => send(status, { 'content-type': 'text/plain; charset=utf-8' }, `${message}\n`)
    try {
      const port = request.socket.localPort
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(request.headers.host ?? '').toLowerCase())) return text(403, 'unexpected host')
      if (!['GET', 'HEAD'].includes(request.method)) return send(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, 'GET only\n')
      let route
      try { route = decodeURIComponent(new URL(request.url, 'http://sketch').pathname) } catch { return text(400, 'bad path') }
      if (route.includes('\0')) return text(400, 'bad path')
      if (route.endsWith('/')) route += 'index.html'
      base ??= await realpath(path.resolve(dir))
      const inside = (file) => file.startsWith(`${base}${path.sep}`)
      const file = path.resolve(base, `.${route}`), type = TYPES[path.extname(file).toLowerCase()]
      if (!type || !inside(file)) return text(404, 'not found')
      const real = await realpath(file).catch(() => null)
      if (!real || !inside(real) || !(await stat(real)).isFile()) return text(404, 'not found')
      const body = await readFile(real)
      send(200, { 'content-type': type, 'content-length': body.length }, body)
    } catch (error) { text(500, error.message) }
  }
}

// Detached entry (bin/gusta-sketch-serve.mjs): binds 127.0.0.1 only (port 0: any free one), tells the CLI
// its port through the ready file and exits by itself after ttlMs, so a forgotten sketch never lingers.
export async function sketchServeMain([dir, port = '0', readyFile, ttlMs = String(TTL_MS)], { exit = (code) => process.exit(code) } = {}) {
  if (!dir) throw new Error('usage: gusta-sketch-serve <dir> <port> <readyFile> <ttlMs>')
  const server = http.createServer(sketchHandler(dir))
  await new Promise((resolve, reject) => server.once('error', reject).listen(Number(port), '127.0.0.1', () => { server.off('error', reject); resolve() }))
  const bound = server.address().port
  const close = () => { clearTimeout(timer); server.close(); server.closeAllConnections() }
  const timer = setTimeout(() => { close(); exit(0) }, Math.min(Math.max(Number(ttlMs) || TTL_MS, 1), MAX_TIMER_MS))
  if (readyFile) await atomicJSON(readyFile, { pid: process.pid, port: bound })
  return { port: bound, close }
}

// True when the port still answers as the recorded server: a reused pid or a stranger on the port does not.
async function answersAs(url, pid) {
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    return response.headers.get(HEADER) === String(pid)
  } catch { return false }
}

// One detached server, its output in a log beside the record; ready once it names its own pid and port.
async function startServer({ records, slug, dir, port, ttlMs, readyMs }) {
  const ready = path.join(records, `${slug}.ready.json`), log = path.join(records, `${slug}.log`)
  await mkdir(records, { recursive: true })
  await rm(ready, { force: true })
  const file = await open(log, 'w', 0o600)
  let child
  try {
    child = spawn(process.execPath, [SERVE, dir, String(port), ready, String(ttlMs)], { detached: process.platform !== 'win32', stdio: ['ignore', file.fd, file.fd] })
    child.once('error', () => {})
    child.unref()
  } finally { await file.close() }
  for (const until = Date.now() + readyMs; Date.now() < until && processAlive(child.pid); await sleep(50)) {
    const answer = await readJSON(ready).catch(() => null)
    if (answer?.pid === child.pid) { await rm(ready, { force: true }); return { pid: child.pid, port: answer.port } }
  }
  if (processAlive(child.pid)) try { process.kill(child.pid, 'SIGTERM') } catch {}
  await rm(ready, { force: true })
  const tail = (await readFile(log, 'utf8').catch(() => '')).trimEnd().split('\n').slice(-8)
  fail(`스케치 서버가 ${readyMs}ms 안에 준비되지 않았습니다(포트 ${port || '자동'}). 로그를 확인하세요.`, [log, ...tail])
}

// SIGTERM to a live pid only, SIGKILL if it is still there after 2 s. True when something was running.
async function halt(pid, { alive, kill }) {
  if (!alive(pid)) return false
  try { kill(pid, 'SIGTERM') } catch {}
  for (const until = Date.now() + 2000; Date.now() < until && alive(pid); await sleep(50));
  if (alive(pid)) try { kill(pid, 'SIGKILL') } catch {}
  return true
}

const DEFAULTS = { inspect: inspectWorkspace, git, alive: processAlive, probe: answersAs, start: startServer, kill: (pid, signal) => process.kill(pid, signal), readyMs: 10000, now: () => new Date().toISOString() }

async function context(options, deps) {
  const workspace = await deps.inspect(options)
  if (!workspace.git) fail('Git checkout 안에서 실행하세요.', workspace.warnings ?? [])
  return { root: workspace.git.root, records: path.join(runtimeRoot(workspace), 'sketch') }
}
const recordFile = (ctx, slug) => path.join(ctx.records, `${slug}.json`)
const recorded = async (ctx) => (await readdir(ctx.records).catch(() => []))
  .filter((name) => name.endsWith('.json') && SLUG.test(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort()
// One serve/stop decision per slug at a time, so two calls never start two servers for it.
const locked = (ctx, slug, run) => controlTransaction(`${recordFile(ctx, slug)}.lock`, run)
function slugOf(slug, usage) {
  if (!SLUG.test(slug ?? '')) fail(`스케치 이름(slug)은 소문자·숫자·하이픈 40자 이내입니다: ${usage}`)
  return slug
}
function integer(value, flag, min, max, fallback) {
  if (value === undefined) return fallback
  const number = Number(value)
  if (String(value).trim() === '' || !Number.isInteger(number) || number < min || number > max) fail(`--${flag}는 ${min}~${max} 정수입니다: ${value}`)
  return number
}

// .tmp/ stays out of git status without touching a tracked file: when it is not ignored yet, one line goes
// to info/exclude. A linked worktree reads the clone's shared exclude file, so its path comes from --git-path.
async function ensureIgnored(root, run) {
  if (await run(root, ['check-ignore', '-q', '.tmp/'], [1]) !== null) return
  const exclude = path.resolve(root, (await run(root, ['rev-parse', '--git-path', 'info/exclude'])).replace(/\r?\n$/, ''))
  await mkdir(path.dirname(exclude), { recursive: true })
  const text = await readFile(exclude, 'utf8').catch(() => '')
  await appendFile(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}/.tmp/\n`)
}

const served = (record, reused) => ({ schemaVersion: 1, ok: true, slug: record.slug, dir: record.dir, url: sketchUrl(record.port), port: record.port, pid: record.pid, reused })

export async function sketchServe(options = {}, injected = {}) {
  const deps = { ...DEFAULTS, ...injected }
  const slug = slugOf(options.slug, 'vibe sketch serve <slug>')
  const port = integer(options.port, 'port', 0, 65535, 0), ttlMs = integer(options.ttlMs, 'ttl-ms', 1000, MAX_TIMER_MS, TTL_MS)
  const ctx = await context(options, deps)
  const dir = path.join(ctx.root, '.tmp', 'sketch', slug)
  await mkdir(dir, { recursive: true })
  await ensureIgnored(ctx.root, deps.git)
  const file = recordFile(ctx, slug)
  return locked(ctx, slug, async () => {
    const current = await readJSON(file).catch(() => null)
    if (current && deps.alive(current.pid) && await deps.probe(sketchUrl(current.port), current.pid)) {
      // The runtime is shared by the clone's worktrees: another checkout's sketch of this name stays theirs.
      if (current.dir !== dir) fail(`다른 checkout이 스케치 ${slug}를 서빙 중입니다. 다른 이름을 쓰거나 vibe sketch stop ${slug} 후 다시 시작하세요.`, [current.dir])
      if (!port || port === current.port) return served(current, true)
      await halt(current.pid, deps) // another port was asked for: this server makes way
    }
    const { pid, port: bound } = await deps.start({ records: ctx.records, slug, dir, port, ttlMs, readyMs: deps.readyMs })
    const record = { schemaVersion: 1, slug, dir, port: bound, pid, startedAt: deps.now() }
    await atomicJSON(file, record)
    return served(record, false)
  })
}

export async function sketchStop(options = {}, injected = {}) {
  const deps = { ...DEFAULTS, ...injected }
  if (Boolean(options.all) === Boolean(options.slug)) fail('vibe sketch stop <slug> 또는 vibe sketch stop --all')
  const ctx = await context(options, deps)
  const slugs = options.all ? await recorded(ctx) : [slugOf(options.slug, 'vibe sketch stop <slug>')]
  const stopped = []
  for (const slug of slugs) {
    await locked(ctx, slug, async () => {
      const file = recordFile(ctx, slug)
      const record = await readJSON(file).catch(() => ({})) // unreadable: nothing to signal, the record still goes
      if (!record) return
      await halt(record.pid, deps)
      await rm(file, { force: true })
      await rm(path.join(ctx.records, `${slug}.log`), { force: true })
      stopped.push(slug)
    })
  }
  return { schemaVersion: 1, ok: true, stopped }
}

export async function sketchStatus(options = {}, injected = {}) {
  const deps = { ...DEFAULTS, ...injected }
  const ctx = await context(options, deps)
  const sketches = []
  for (const slug of await recorded(ctx)) {
    if (options.slug && slug !== options.slug) continue
    const record = await readJSON(recordFile(ctx, slug)).catch(() => null)
    if (record) sketches.push({ slug, dir: record.dir, url: sketchUrl(record.port), port: record.port, pid: record.pid, startedAt: record.startedAt, alive: deps.alive(record.pid) })
  }
  return { schemaVersion: 1, ok: true, sketches }
}

export const SKETCH_STEPS = { serve: sketchServe, stop: sketchStop, status: sketchStatus }

// The line a person reads without --json.
export function renderSketch(step, result) {
  if (step === 'serve') return `스케치 ${result.slug}: ${result.url}${result.reused ? ' (실행 중인 서버 재사용)' : ''}\n  ${path.join(result.dir, 'index.html')}을 고치고 새로고침하면 바로 보입니다.\n`
  if (step === 'stop') return result.stopped.length ? `정지: ${result.stopped.join(', ')}\n` : '정지할 스케치 서버가 없습니다.\n'
  if (!result.sketches.length) return '기록된 스케치 서버가 없습니다.\n'
  return result.sketches.map((entry) => `${entry.slug}  ${entry.url}  ${entry.alive ? '실행 중' : '멈춤'}  ${entry.dir}`).join('\n') + '\n'
}
