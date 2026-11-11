import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, access, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fixture, git } from './helpers/vibe-fixture.mjs'
import { abStart, abRun, abServe, abExec, abStatus, abPick, abStop } from '../src/vibe-ab.mjs'
import { renderHub, viewPath, createHub, readFeedback, hubMain } from '../src/vibe-ab-hub.mjs'

const exists = (file) => access(file).then(() => true, () => false)
const providers = async () => ({ autoProvider: 'claude', providers: [{ provider: 'claude', compatible: true }] })
// A fake variant session: edits only its own worktree, streams a transcript and reports what to look at.
const session = (text, viewAt = '') => async ({ job, log }) => {
  log(`{"type":"system","variant":"${text}"}\n`)
  await writeFile(path.join(job.workspace, 'app.js'), `module.exports = ${JSON.stringify(text)}\n`)
  return { outcome: 'completed', summary: `${text} variant`, view: 'home', path: viewAt, usage: { input_tokens: 1, output_tokens: 2 } }
}
const post = (url, body, type = 'application/json') => fetch(url, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) })
const settle = () => new Promise((resolve) => setTimeout(resolve, 300))
// A tiny server that answers with the variant's app.js, listening on $PORT.
const SERVER = `node -e "require('http').createServer((q,s)=>s.end(require('./app.js'))).listen(process.env.PORT)"`
const PLAIN = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)"`
// After hooks run in registration order: the stop goes in before the fixture's cleanup removes the
// record, so a failed assertion cannot leak servers or the hub.
async function project(t, ...slugs) {
  let root = null
  t.after(async () => { for (const slug of root ? slugs : []) await abStop({ targetRoot: root, slug }).catch(() => {}) })
  const made = await fixture(t)
  root = made.root
  return made
}

test('variants get their own branch, worktree, port and host-made commit, then serve side by side', async (t) => {
  const { root, temporary } = await project(t, 'hero')
  await writeFile(path.join(root, '.env.local'), 'SECRET=1\n')
  await writeFile(path.join(root, '.gitignore'), '.env.local\n'); await git(root, 'add', '.gitignore'); await git(root, 'commit', '-q', '-m', 'ignore env')
  const started = await abStart({ targetRoot: root, slug: 'hero', variants: 2, basePort: 4731, copy: ['.env.local'], setup: 'node -e "require(\'fs\').writeFileSync(\'installed\',\'1\')"' })
  assert.equal(started.ok, true); assert.deepEqual(started.variants.map((entry) => entry.variant), ['a', 'b'])
  assert.notEqual(started.variants[0].port, started.variants[1].port)
  for (const entry of started.variants) {
    assert.ok(entry.path.startsWith(path.join(temporary, '.haeram-worktrees')))
    assert.equal(await readFile(path.join(entry.path, '.env.local'), 'utf8'), 'SECRET=1\n')
    assert.ok(await exists(path.join(entry.path, 'installed')))
  }
  await assert.rejects(abStart({ targetRoot: root, slug: 'hero' }), /이미/)
  for (const [variant, text, viewAt] of [['a', 'alpha', ''], ['b', 'beta', 'b-screen']]) {
    const promptFile = path.join(temporary, `${variant}.md`); await writeFile(promptFile, `Make it ${text}.`)
    let job
    const run = await abRun({ targetRoot: root, slug: 'hero', variant, promptFile }, { inspect: providers, execute: async (input) => { job = input.job; return session(text, viewAt)(input) } })
    assert.equal(run.ok, true); assert.equal(run.changed, true); assert.equal(job.role, 'variant'); assert.match(job.prompt, /Make it/)
    assert.equal(await git(root, 'log', '-1', '--format=%s', `ab/hero/${variant}`), `ab hero/${variant}: ${text} variant`)
    // Usage is kept; the transcript lives in a runtime file and the result names only its path.
    assert.deepEqual(run.usage, { input: 1, cacheWrite: 0, cacheRead: 0, output: 2 })
    assert.match(await readFile(run.log, 'utf8'), new RegExp(`"variant":"${text}"`))
    assert.ok(!JSON.stringify(run).includes('"type":"system"'))
    assert.equal(run.url, `http://localhost:${started.variants.find((entry) => entry.variant === variant).port}${viewAt ? `/${viewAt}` : ''}`)
  }
  assert.equal(await git(root, 'rev-parse', 'HEAD'), await git(root, 'rev-parse', 'main'))
  assert.equal(await git(root, 'status', '--porcelain'), '')
  const served = await abServe({ targetRoot: root, slug: 'hero', command: SERVER, readyTimeoutMs: 20000 })
  assert.equal(served.ok, true, JSON.stringify(served))
  assert.deepEqual(served.variants.map((entry) => entry.http.status), [200, 200])
  const bodies = await Promise.all(served.variants.map(async (entry) => (await fetch(entry.url)).text()))
  assert.deepEqual(bodies, ['alpha', 'beta'])
  // One hub page frames every variant at its view path; notes and the choice come back in status.
  const page = await (await fetch(served.hub)).text()
  for (const entry of served.variants) assert.ok(page.includes(`<iframe src="${entry.url}"`), entry.url)
  assert.equal((await post(`${served.hub}/note`, { variant: 'a', note: 'bigger title' })).status, 200)
  assert.equal((await post(`${served.hub}/choose`, { variant: 'b' })).status, 200)
  const status = await abStatus({ targetRoot: root, slug: 'hero' })
  assert.deepEqual(status.variants.map((entry) => [entry.serving, entry.commits]), [[true, 1], [true, 1]])
  assert.equal(status.hub, served.hub)
  assert.equal(status.feedback.notes.a.note, 'bigger title'); assert.equal(status.feedback.chosen.variant, 'b')
  const measured = await abExec({ targetRoot: root, slug: 'hero', command: 'node -e "console.log(require(\'./app.js\'))"', repeat: 2 })
  assert.equal(measured.ok, true); assert.deepEqual(measured.variants.map((entry) => entry.tail.at(-1)), ['alpha', 'beta'])
  assert.equal(measured.variants[0].exitCodes.length, 2); assert.ok(measured.variants[0].medianMs >= measured.variants[0].minMs)
  const before = await git(root, 'rev-parse', 'HEAD'), winner = await git(root, 'rev-parse', 'ab/hero/b')
  const adopted = await abPick({ targetRoot: root, slug: 'hero', variant: 'b' })
  assert.equal(adopted.adopted, 'b'); assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'module.exports = "beta"\n')
  assert.match(await git(root, 'log', '-1', '--format=%s'), /ab hero: adopt b/)
  assert.equal(await git(root, 'rev-parse', 'HEAD^1'), before); assert.equal(await git(root, 'rev-parse', 'HEAD^2'), winner)
  for (const entry of started.variants) assert.equal(await exists(entry.path), false)
  // prune-branches defaults to true: no variant branch outlives the pick.
  assert.deepEqual(adopted.branches, [])
  assert.equal(await git(root, 'branch', '--list', 'ab/hero/*'), '')
  await settle()
  await assert.rejects(fetch(served.variants[0].url))
  await assert.rejects(fetch(served.hub))
  await assert.rejects(abStatus({ targetRoot: root, slug: 'hero' }), /없습니다/)
})

test('start refuses uncommitted user changes; stop --remove keeps branches when prune-branches is false unless forced', async (t) => {
  const { root } = await fixture(t)
  await writeFile(path.join(root, 'dirty.txt'), 'x')
  await assert.rejects(abStart({ targetRoot: root, slug: 'nav' }), /미커밋/)
  await git(root, 'add', 'dirty.txt'); await git(root, 'commit', '-q', '-m', 'dirty')
  await assert.rejects(abStart({ targetRoot: root, slug: 'Bad Slug' }), /slug/)
  await assert.rejects(abStart({ targetRoot: root, slug: 'nav', variants: 7 }), /variants/)
  const started = await abStart({ targetRoot: root, slug: 'nav', variants: 3, basePort: 4761 })
  assert.equal(started.variants.length, 3)
  await writeFile(path.join(started.variants[0].path, 'pending.txt'), 'unfinished')
  await assert.rejects(abStop({ targetRoot: root, slug: 'nav', remove: true }), /커밋되지 않은 변경/)
  await git(started.variants[0].path, 'add', 'pending.txt'); await git(started.variants[0].path, 'commit', '-q', '-m', 'wip')
  await assert.rejects(abPick({ targetRoot: root, slug: 'nav', variant: 'b' }), /커밋이 없습니다/)
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- prune-branches: false\n'); await git(root, 'add', 'spec/SETTINGS.md'); await git(root, 'commit', '-q', '-m', 'keep branches')
  const stopped = await abStop({ targetRoot: root, slug: 'nav', remove: true })
  assert.deepEqual(stopped.branches, ['ab/nav/a', 'ab/nav/b', 'ab/nav/c'])
  assert.match(await git(root, 'branch', '--list', 'ab/nav/*'), /ab\/nav\/a/)
  const again = await abStart({ targetRoot: root, slug: 'nav2', variants: 2, basePort: 4771 })
  await abStop({ targetRoot: root, slug: 'nav2', remove: true, pruneBranches: true })
  assert.equal(await git(root, 'branch', '--list', 'ab/nav2/*'), '')
  assert.equal(again.ok, true)
})

test('a variant session gets the optional provider flags the installed CLI supports', async (t) => {
  const { root, temporary } = await fixture(t)
  await abStart({ targetRoot: root, slug: 'flags', variants: 2, basePort: 4801 })
  t.after(() => abStop({ targetRoot: root, slug: 'flags', remove: true }).catch(() => {}))
  const promptFile = path.join(temporary, 'flags.md'); await writeFile(promptFile, 'Make it plain.')
  let seen
  await abRun({ targetRoot: root, slug: 'flags', variant: 'a', promptFile }, { inspect: providers,
    flags: async (provider) => provider === 'claude' ? ['--exclude-dynamic-system-prompt-sections'] : [], execute: async (input) => { seen = input; return session('plain')(input) } })
  assert.deepEqual(seen.flags, ['--exclude-dynamic-system-prompt-sections'])
})

test('a server that never listens is reported with its log tail instead of a URL claim', async (t) => {
  const { root } = await project(t, 'crash')
  await abStart({ targetRoot: root, slug: 'crash', variants: 2, basePort: 4791 })
  const served = await abServe({ targetRoot: root, slug: 'crash', command: 'node -e "console.error(\'boom\'); process.exit(3)"', readyTimeoutMs: 5000 })
  assert.equal(served.ok, false)
  assert.ok(served.variants.every((entry) => !entry.ready && entry.exited && entry.tail.includes('boom')))
})

// /broken answers 500 (and logs why), /private redirects to sign-in, anything else answers its pid.
const PROBED = `node -e "require('http').createServer((q,s)=>{if(q.url==='/broken'){console.error('render failed');s.statusCode=500;return s.end('boom')}if(q.url==='/private'){s.writeHead(302,{location:'/login'});return s.end()}s.end(String(process.pid))}).listen(process.env.PORT)"`

test('serve is ready only when the view answers, keeps a live server unless --restart, and stop closes the hub', async (t) => {
  const { root, temporary } = await project(t, 'probe')
  await abStart({ targetRoot: root, slug: 'probe', variants: 2, basePort: 4811 })
  for (const [variant, viewAt] of [['a', '/broken'], ['b', '/private']]) {
    const promptFile = path.join(temporary, `${variant}.md`); await writeFile(promptFile, 'Build it.')
    await abRun({ targetRoot: root, slug: 'probe', variant, promptFile }, { inspect: providers, execute: session(variant, viewAt) })
  }
  const served = await abServe({ targetRoot: root, slug: 'probe', command: PROBED, readyTimeoutMs: 20000 })
  const [broken, redirected] = served.variants
  assert.equal(served.ok, false)
  assert.equal(broken.ready, false); assert.equal(broken.http.status, 500); assert.equal(broken.exited, false); assert.ok(broken.tail.includes('render failed'))
  assert.equal(redirected.ready, true); assert.equal(redirected.http.status, 302); assert.equal(redirected.http.location, '/login')
  assert.match(served.hub, /^http:\/\/localhost:\d+$/)
  const origin = new URL(broken.url).origin, pid = async () => (await fetch(origin)).text()
  const first = await pid()
  const kept = await abServe({ targetRoot: root, slug: 'probe', variant: 'a', command: PROBED, readyTimeoutMs: 20000 })
  assert.equal(kept.variants[0].kept, true); assert.equal(await pid(), first); assert.equal(kept.hub, served.hub)
  const restarted = await abServe({ targetRoot: root, slug: 'probe', variant: 'a', command: PROBED, restart: true, readyTimeoutMs: 20000 })
  assert.equal(restarted.variants[0].kept, undefined); assert.notEqual(await pid(), first)
  await abStop({ targetRoot: root, slug: 'probe' })
  await settle()
  await assert.rejects(fetch(served.hub)); await assert.rejects(fetch(origin))
  assert.equal((await abStatus({ targetRoot: root, slug: 'probe' })).hub, null)
})

test('hub page escapes session text and frames each variant at URL plus view path', () => {
  assert.deepEqual(['', '/', 'settings', '/a/b', 'http://localhost:3000/x?y=1', 'the settings page'].map(viewPath), ['', '', '/settings', '/a/b', '/x?y=1', ''])
  const html = renderHub({ slug: 'hero', feedback: { notes: { a: { note: 'larger <b>', at: 'now' } }, chosen: { variant: 'b', at: 'now' } }, variants: [
    { name: 'a', url: 'http://localhost:4101/settings', summary: 'cards <script>x</script>\nsecond line', view: 'settings tab', serving: true },
    { name: 'b', url: 'http://localhost:4102', summary: 'list', view: '', serving: false }] })
  assert.deepEqual([...html.matchAll(/<iframe src="([^"]+)"/g)].map((match) => match[1]), ['http://localhost:4101/settings', 'http://localhost:4102'])
  assert.ok(!html.includes('<script>x</script>')); assert.ok(html.includes('cards &lt;script&gt;'))
  assert.ok(html.includes('>larger &lt;b&gt;</textarea>')); assert.match(html, /data-variant="b" class="chosen"/)
  assert.match(html, /target="_blank"/); assert.match(html, /data-width="390"/); assert.match(html, /not serving/); assert.match(html, /blocks framing/)
})

test('hub records notes and a choice for known variants only, and ends with its comparison', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'haeram-ab-hub-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const recordFile = path.join(directory, 'hero.json'), feedbackFile = path.join(directory, 'hero', 'feedback.json')
  await writeFile(recordFile, JSON.stringify({ slug: 'hero', variants: { a: { port: 4101, runs: [{ summary: 'cards', view: 'home', path: '/home' }] }, b: { port: 4102, runs: [] } } }))
  const server = createHub({ recordFile, feedbackFile, alive: () => false, now: () => 'T' })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const hub = `http://127.0.0.1:${server.address().port}`
  await Promise.all([post(`${hub}/note`, { variant: 'a', note: ' bigger ' }), post(`${hub}/note`, { variant: 'b', note: 'too dense' })])
  assert.equal((await post(`${hub}/choose`, { variant: 'a' })).status, 200)
  assert.deepEqual(await readFeedback(feedbackFile), { notes: { a: { note: 'bigger', at: 'T' }, b: { note: 'too dense', at: 'T' } }, chosen: { variant: 'a', at: 'T' } })
  assert.equal((await post(`${hub}/note`, { variant: 'b', note: '' })).status, 200)
  assert.deepEqual(Object.keys((await readFeedback(feedbackFile)).notes), ['a'])
  assert.equal((await post(`${hub}/choose`, { variant: 'z' })).status, 400)
  assert.equal((await post(`${hub}/note`, { variant: 'a', note: 'x' }, 'text/plain')).status, 415)
  assert.equal((await post(`${hub}/note`, { variant: 'a', note: 'x'.repeat(20000) })).status, 413)
  // A rebound DNS name reaching the loopback port is refused.
  const rebound = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/', headers: { host: `attacker.example:${server.address().port}` } },
    (response) => { response.resume(); resolve(response.statusCode) }).on('error', reject))
  assert.equal(rebound, 403)
  const page = await (await fetch(hub)).text()
  assert.match(page, /<iframe src="http:\/\/localhost:4101\/home"/); assert.match(page, />bigger<\/textarea>/)
  await rm(recordFile)
  assert.equal((await fetch(hub)).status, 410)
})

test('the detached hub reports its port, answers on localhost and exits once its comparison is gone', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'haeram-ab-hub-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const recordFile = path.join(directory, 'hero.json'), readyFile = path.join(directory, 'hub.json')
  await writeFile(recordFile, JSON.stringify({ slug: 'hero', variants: { a: { port: 4101, runs: [] } } }))
  let exited
  const gone = new Promise((resolve) => { exited = resolve })
  const hub = await hubMain([recordFile, path.join(directory, 'feedback.json'), readyFile], { exit: exited, checkMs: 20 })
  t.after(() => hub.close())
  assert.deepEqual(JSON.parse(await readFile(readyFile, 'utf8')), { pid: process.pid, port: hub.port })
  assert.equal((await fetch(`http://localhost:${hub.port}`)).status, 200)
  await rm(recordFile)
  assert.equal(await gone, 0)
})

test('serve merges its servers into a run saved while it was starting them', async (t) => {
  const { root, temporary } = await project(t, 'race')
  await abStart({ targetRoot: root, slug: 'race', variants: 2, basePort: 4861 })
  const promptFile = path.join(temporary, 'late.md'); await writeFile(promptFile, 'Build it.')
  let late = true
  const served = await abServe({ targetRoot: root, slug: 'race', command: PLAIN, readyTimeoutMs: 20000 }, { spawnServer: async (command, options) => {
    if (late) { late = false; await abRun({ targetRoot: root, slug: 'race', variant: 'b', promptFile }, { inspect: providers, execute: session('late', '/late') }) }
    return spawn(command, options)
  } })
  assert.equal(served.ok, true, JSON.stringify(served)); assert.match(served.variants[1].url, /\/late$/)
  const status = await abStatus({ targetRoot: root, slug: 'race' })
  assert.equal(status.variants[1].last.summary, 'late variant'); assert.ok(status.variants.every((entry) => entry.serving))
})

const ipv6 = await new Promise((resolve) => { const server = net.createServer().once('error', () => resolve(false)).listen(0, '::1', () => server.close(() => resolve(true))) })
test('a dev server holding only ::1 (localhost on newer Node) keeps its port and is found ready', { skip: !ipv6 && 'no IPv6 loopback' }, async (t) => {
  const { root } = await project(t, 'six')
  const held = await new Promise((resolve) => { const server = net.createServer().once('error', () => resolve(null)).listen(4881, '::1', () => resolve(server)) })
  let started
  try { started = await abStart({ targetRoot: root, slug: 'six', variants: 2, basePort: 4881 }) } finally { held?.close() }
  assert.ok(started.variants.every((entry) => entry.port !== 4881), JSON.stringify(started.variants))
  const served = await abServe({ targetRoot: root, slug: 'six', command: `node -e "require('http').createServer((q,s)=>s.end('six')).listen(process.env.PORT,'::1')"`, readyTimeoutMs: 20000 })
  assert.equal(served.ok, true, JSON.stringify(served)); assert.deepEqual(served.variants.map((entry) => entry.http.status), [200, 200])
})
