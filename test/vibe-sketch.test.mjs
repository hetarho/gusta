import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execute, git } from './helpers/vibe-fixture.mjs'
import { sketchServe, sketchStop, sketchStatus, sketchServeMain } from '../src/vibe-sketch.mjs'
import { processAlive } from '../src/loop-control.mjs'
import { SkillPackageError } from '../src/errors.mjs'

const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
const exists = (file) => access(file).then(() => true, () => false)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const gone = async (pid, ms = 5000) => { for (const until = Date.now() + ms; Date.now() < until && processAlive(pid); await sleep(50)); return !processAlive(pid) }

// A committed checkout with nothing else in it. The after hook stops every recorded sketch server
// before the folder goes, so a failed assertion cannot leak a server.
async function repo(t) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-sketch-')))
  const root = path.join(temporary, 'project')
  t.after(async () => {
    await sketchStop({ targetRoot: root, all: true }).catch(() => {})
    await rm(temporary, { recursive: true, force: true })
  })
  await mkdir(root)
  await git(root, 'init', '-q', '-b', 'main')
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) await git(root, 'config', key, value)
  await writeFile(path.join(root, 'README.md'), '# project\n')
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', 'init')
  return { root, temporary, common: path.join(root, '.git') }
}
// A raw request: fetch would normalize `..` before it reached the server.
const request = (port, target, { method = 'GET', host = `127.0.0.1:${port}` } = {}) => new Promise((resolve, reject) => {
  const sent = http.request({ host: '127.0.0.1', port, path: target, method, headers: { host }, agent: false }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk)).on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
  })
  sent.on('error', reject).end()
})

test('the server serves only static files under its folder, never a listing or a path outside it', async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-sketch-files-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const dir = path.join(temporary, 'home')
  await mkdir(path.join(dir, 'sub'), { recursive: true })
  const files = { 'index.html': '<h1>home</h1>', 'style.css': 'h1{}', 'app.js': 'void 0', 'logo.svg': '<svg/>', 'data.json': '{}', 'photo.png': 'png', 'photo.jpg': 'jpg', 'notes.txt': 'secret', 'sub/index.html': '<p>sub</p>' }
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text)
  await writeFile(path.join(temporary, 'outside.html'), 'outside')
  await symlink(path.join(temporary, 'outside.html'), path.join(dir, 'link.html'))
  const readyFile = path.join(temporary, 'ready.json')
  const server = await sketchServeMain([dir, '0', readyFile, '60000'], { exit: () => {} })
  t.after(() => server.close())
  assert.deepEqual(JSON.parse(await readFile(readyFile, 'utf8')), { pid: process.pid, port: server.port })

  const root = await request(server.port, '/')
  assert.equal(root.status, 200); assert.equal(root.body, '<h1>home</h1>')
  assert.equal(root.headers['content-type'], 'text/html; charset=utf-8'); assert.equal(root.headers['cache-control'], 'no-store')
  assert.equal(root.headers['x-gusta-sketch'], String(process.pid))
  const types = { '/style.css': 'text/css; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8', '/logo.svg': 'image/svg+xml', '/data.json': 'application/json; charset=utf-8', '/photo.png': 'image/png', '/photo.jpg': 'image/jpeg', '/sub/': 'text/html; charset=utf-8' }
  for (const [route, type] of Object.entries(types)) {
    const answer = await request(server.port, route)
    assert.equal(answer.status, 200, route); assert.equal(answer.headers['content-type'], type, route); assert.equal(answer.headers['cache-control'], 'no-store', route)
  }
  // An edit shows on the next request: nothing is cached on either side.
  await writeFile(path.join(dir, 'index.html'), '<h1>edited</h1>')
  assert.equal((await request(server.port, '/index.html')).body, '<h1>edited</h1>')
  // Unknown types, directories, missing files and every way out of the folder are 404.
  for (const route of ['/notes.txt', '/sub', '/missing.html', '/../outside.html', '/%2e%2e/outside.html', '/sub/..%2F..%2Foutside.html', '/link.html']) {
    const answer = await request(server.port, route)
    assert.equal(answer.status, 404, route); assert.doesNotMatch(answer.body, /outside|secret/, route)
  }
  assert.equal((await request(server.port, '/%00.html')).status, 400)
  assert.equal((await request(server.port, '/%E0%A4%A.html')).status, 400)
  const head = await request(server.port, '/', { method: 'HEAD' })
  assert.equal(head.status, 200); assert.equal(head.body, '')
  assert.equal((await request(server.port, '/', { method: 'POST' })).status, 405)
  assert.equal((await request(server.port, '/', { host: `localhost:${server.port}` })).status, 200)
  assert.equal((await request(server.port, '/', { host: 'evil.example' })).status, 403)
  // Loopback IPv4 only.
  const reachable = await new Promise((resolve) => net.connect(server.port, '::1').once('connect', function () { this.destroy(); resolve(true) }).once('error', () => resolve(false)))
  assert.equal(reachable, false)
})

test('the server exits by itself after its TTL', async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-sketch-ttl-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  let exited
  const done = new Promise((resolve) => { exited = resolve })
  const server = await sketchServeMain([temporary, '0', null, '30'], { exit: exited })
  t.after(() => server.close())
  assert.equal(await done, 0)
  await assert.rejects(fetch(`http://127.0.0.1:${server.port}/`))
})

test('serve starts one detached server per slug, reuses it, keeps .tmp/ out of git status, and stop ends it', async (t) => {
  const { root, common } = await repo(t)
  const exclude = path.join(common, 'info', 'exclude')
  await rm(exclude, { force: true }) // a clone without the template file still gets one
  const first = await sketchServe({ targetRoot: root, slug: 'home' })
  const dir = path.join(root, '.tmp', 'sketch', 'home')
  assert.deepEqual(first, { schemaVersion: 1, ok: true, slug: 'home', dir, url: `http://127.0.0.1:${first.port}/`, port: first.port, pid: first.pid, reused: false })
  assert.ok(processAlive(first.pid))
  const record = JSON.parse(await readFile(path.join(common, 'gusta', 'v1', 'sketch', 'home.json'), 'utf8'))
  assert.deepEqual(Object.keys(record).sort(), ['dir', 'pid', 'port', 'schemaVersion', 'slug', 'startedAt'])
  assert.deepEqual({ ...record, startedAt: null }, { schemaVersion: 1, slug: 'home', dir, port: first.port, pid: first.pid, startedAt: null })

  assert.equal((await fetch(first.url)).status, 404) // nothing written yet
  await writeFile(path.join(dir, 'index.html'), '<h1>v1</h1>')
  assert.equal(await (await fetch(first.url)).text(), '<h1>v1</h1>')
  await writeFile(path.join(dir, 'index.html'), '<h1>v2</h1>')
  const refreshed = await fetch(first.url)
  assert.equal(await refreshed.text(), '<h1>v2</h1>'); assert.equal(refreshed.headers.get('cache-control'), 'no-store')

  // Ignored through info/exclude only: no tracked file changes, and the line is not added twice.
  assert.equal(await git(root, 'status', '--porcelain'), '')
  assert.equal(await exists(path.join(root, '.gitignore')), false)
  assert.equal(await readFile(exclude, 'utf8'), '/.tmp/\n')

  const again = await sketchServe({ targetRoot: root, slug: 'home' })
  assert.deepEqual(again, { ...first, reused: true })
  assert.equal(await readFile(exclude, 'utf8'), '/.tmp/\n')

  const other = await sketchServe({ targetRoot: root, slug: 'settings', ttlMs: '60000' })
  assert.notEqual(other.port, first.port)
  const status = await sketchStatus({ targetRoot: root })
  assert.deepEqual(status.sketches.map((entry) => [entry.slug, entry.alive, entry.url]), [['home', true, first.url], ['settings', true, other.url]])

  assert.deepEqual(await sketchStop({ targetRoot: root, slug: 'home' }), { schemaVersion: 1, ok: true, stopped: ['home'] })
  assert.ok(await gone(first.pid)); assert.ok(processAlive(other.pid))
  assert.equal(await exists(path.join(common, 'gusta', 'v1', 'sketch', 'home.json')), false)
  assert.equal(await readFile(path.join(dir, 'index.html'), 'utf8'), '<h1>v2</h1>') // the sketch itself stays
  assert.deepEqual((await sketchStop({ targetRoot: root, slug: 'home' })).stopped, [])
  assert.deepEqual((await sketchStop({ targetRoot: root, all: true })).stopped, ['settings'])
  assert.ok(await gone(other.pid))
  assert.deepEqual((await sketchStatus({ targetRoot: root })).sketches, [])
})

test('an existing ignore rule is left alone and a started server leaves after a short TTL', async (t) => {
  const { root, common } = await repo(t)
  await writeFile(path.join(root, '.gitignore'), '.tmp/\n'); await git(root, 'add', '.gitignore'); await git(root, 'commit', '-q', '-m', 'ignore tmp')
  const before = await readFile(path.join(common, 'info', 'exclude'), 'utf8').catch(() => '')
  const served = await sketchServe({ targetRoot: root, slug: 'brief', ttlMs: '1000' })
  assert.equal(await readFile(path.join(common, 'info', 'exclude'), 'utf8').catch(() => ''), before)
  assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), '.tmp/\n')
  assert.ok(await gone(served.pid, 8000), 'the server outlived its TTL')
  assert.deepEqual((await sketchStatus({ targetRoot: root })).sketches.map((entry) => [entry.slug, entry.alive]), [['brief', false]])
  // A dead record is replaced, not reused.
  const fresh = await sketchServe({ targetRoot: root, slug: 'brief' })
  assert.equal(fresh.reused, false); assert.notEqual(fresh.pid, served.pid)
})

test('a linked worktree serves from its own folder through the clone-wide exclude and record', async (t) => {
  const { root, temporary, common } = await repo(t)
  const tree = path.join(temporary, 'tree')
  await git(root, 'worktree', 'add', '-q', '-b', 'side', tree)
  const served = await sketchServe({ targetRoot: tree, slug: 'flow' })
  assert.equal(served.dir, path.join(tree, '.tmp', 'sketch', 'flow'))
  assert.ok(await exists(path.join(common, 'gusta', 'v1', 'sketch', 'flow.json')))
  await writeFile(path.join(served.dir, 'index.html'), 'tree')
  assert.equal(await git(tree, 'status', '--porcelain'), '')
  await mkdir(path.join(root, '.tmp')); await writeFile(path.join(root, '.tmp', 'x.html'), 'x')
  assert.equal(await git(root, 'status', '--porcelain'), '')
  // The same name from another checkout of the clone is that checkout's server: refused, not taken over.
  await assert.rejects(sketchServe({ targetRoot: root, slug: 'flow' }), (error) => error instanceof SkillPackageError && /다른 checkout/.test(error.message) && error.details[0] === served.dir)
  assert.ok(processAlive(served.pid))
  assert.deepEqual((await sketchStatus({ targetRoot: root })).sketches.map((entry) => entry.dir), [served.dir])
})

test('names, ports and TTLs are checked before anything starts', async (t) => {
  const { root } = await repo(t)
  for (const slug of [undefined, '', 'Home', '-home', 'a_b', 'a'.repeat(41), '../x']) {
    await assert.rejects(sketchServe({ targetRoot: root, slug }), SkillPackageError, String(slug))
  }
  for (const port of ['-1', '65536', '1.5', 'x', '']) await assert.rejects(sketchServe({ targetRoot: root, slug: 'home', port }), /--port/)
  for (const ttlMs of ['0', '999', String(2 ** 31), 'x']) await assert.rejects(sketchServe({ targetRoot: root, slug: 'home', ttlMs }), /--ttl-ms/)
  await assert.rejects(sketchStop({ targetRoot: root }), SkillPackageError)
  await assert.rejects(sketchStop({ targetRoot: root, slug: 'home', all: true }), SkillPackageError)
  await assert.rejects(sketchStop({ targetRoot: root, slug: 'Bad' }), SkillPackageError)
  assert.equal(await exists(path.join(root, '.tmp')), false)
})

test('reuse needs a live pid that still answers on its port; another port restarts; stop signals only a live pid', async (t) => {
  const { root, common } = await repo(t)
  const starts = [], kills = []
  let pid = 2 ** 30 // above any pid_max: the cleanup hook can never signal a real process
  const start = async (input) => { starts.push(input); pid += 1; return { pid, port: input.port || 5000 + starts.length } }
  const kill = (target, signal) => kills.push([target, signal])
  const first = await sketchServe({ targetRoot: root, slug: 'home' }, { start, alive: () => false })
  assert.equal(first.reused, false)
  assert.deepEqual({ ...starts[0], records: null }, { records: null, slug: 'home', dir: first.dir, port: 0, ttlMs: 8 * 60 * 60 * 1000, readyMs: 10000 })
  assert.equal(starts[0].records, path.join(common, 'gusta', 'v1', 'sketch'))
  const reused = await sketchServe({ targetRoot: root, slug: 'home' }, { start, alive: () => true, probe: async (url, live) => url === first.url && live === first.pid })
  assert.equal(reused.reused, true); assert.equal(starts.length, 1)
  const stranger = await sketchServe({ targetRoot: root, slug: 'home' }, { start, alive: () => true, probe: async () => false, kill })
  assert.equal(stranger.reused, false); assert.equal(starts.length, 2); assert.deepEqual(kills, [])
  const moved = await sketchServe({ targetRoot: root, slug: 'home', port: '5999' }, { start, alive: () => !kills.length, probe: async () => true, kill })
  assert.deepEqual(kills, [[stranger.pid, 'SIGTERM']]); assert.equal(moved.port, 5999); assert.equal(starts.length, 3)
  const same = await sketchServe({ targetRoot: root, slug: 'home', port: '5999' }, { start, alive: () => true, probe: async () => true })
  assert.equal(same.reused, true)

  assert.deepEqual((await sketchStatus({ targetRoot: root }, { alive: () => false })).sketches.map((entry) => entry.alive), [false])
  kills.length = 0
  assert.deepEqual((await sketchStop({ targetRoot: root, slug: 'home' }, { alive: () => false, kill })).stopped, ['home'])
  assert.deepEqual(kills, [])
  // An unreadable record has nothing to signal but still goes.
  await writeFile(path.join(common, 'gusta', 'v1', 'sketch', 'broken.json'), '{')
  assert.deepEqual((await sketchStop({ targetRoot: root, all: true }, { kill })).stopped, ['broken'])
  assert.deepEqual(kills, [])
})

test('a server that cannot listen fails with its log instead of a URL', async (t) => {
  const { root } = await repo(t)
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  t.after(() => blocker.close())
  await assert.rejects(sketchServe({ targetRoot: root, slug: 'busy', port: String(blocker.address().port) }),
    (error) => error instanceof SkillPackageError && /준비되지 않았습니다/.test(error.message) && error.details.some((line) => /EADDRINUSE/.test(line)))
  assert.deepEqual((await sketchStatus({ targetRoot: root })).sketches, [])
})

test('vibe sketch on the command line: JSON with --json, one line without, listed in vibe --help', async (t) => {
  const { root } = await repo(t)
  const run = (...args) => execute(process.execPath, [cli, 'vibe', 'sketch', ...args, '--target', root], { encoding: 'utf8' })
  const served = JSON.parse((await run('serve', 'home', '--json')).stdout)
  assert.equal(served.ok, true); assert.equal(served.reused, false); assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  const line = (await run('serve', 'home')).stdout
  assert.ok(line.includes(served.url)); assert.match(line, /재사용/)
  const listed = JSON.parse((await run('status', '--json')).stdout)
  assert.deepEqual(listed.sketches.map((entry) => [entry.slug, entry.alive]), [['home', true]])
  const refused = await run('serve', 'Bad', '--json').catch((error) => error)
  assert.equal(refused.code, 1); assert.equal(JSON.parse(refused.stdout).ok, false)
  assert.equal((await run('nope').catch((error) => error)).code, 1)
  assert.deepEqual(JSON.parse((await run('stop', '--all', '--json')).stdout), { schemaVersion: 1, ok: true, stopped: ['home'] })
  assert.ok(await gone(served.pid))
  assert.match((await run('status')).stdout, /없습니다/)
  const help = (await execute(process.execPath, [cli, 'vibe', '--help'], { encoding: 'utf8' })).stdout
  for (const usage of ['vibe sketch serve <slug> [--port 0] [--ttl-ms 28800000] [--json]', 'vibe sketch stop <slug> | --all [--json]', 'vibe sketch status [--json]']) assert.ok(help.includes(usage), usage)
})
