import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, access, mkdtemp, mkdir, rm, lstat, readlink, symlink, realpath, stat, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fixture, git } from './helpers/vibe-fixture.mjs'
import { abStart, abAdd, abRun, abServe, abExec, abStatus, abPick, abStop, copyTree, scaffoldWarnings } from '../src/vibe-ab.mjs'
import { renderHub, hubModel, viewPath, createHub, readFeedback, hubMain } from '../src/vibe-ab-hub.mjs'

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
// A fake scaffold session: fixtures in a new file, wired into the existing data module.
const scaffolding = async ({ job, log }) => {
  log('{"type":"system","scaffold":true}\n')
  await writeFile(path.join(job.workspace, 'fixtures.json'), '{"user":"Ada"}\n')
  await writeFile(path.join(job.workspace, 'data.js'), "module.exports = require('./fixtures.json')\n")
  return { outcome: 'completed', summary: 'fixtures for the profile screen', view: 'profile', path: '/profile', usage: { input_tokens: 1, output_tokens: 1 } }
}
const capture = (jobs, fake) => async (input) => { jobs.push(input.job); return fake(input) }
const noFlags = async () => []
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
    assert.ok(entry.path.startsWith(path.join(temporary, '.gusta-worktrees')))
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
  // The hub shows each variant's latest measurement next to its frame.
  const measuredPage = await (await fetch(served.hub)).text()
  for (const entry of measured.variants) assert.ok(measuredPage.includes(`median ${entry.medianMs} ms · exit 0,0 · <code>${entry.tail.at(-1)}</code>`), entry.variant)
  const before = await git(root, 'rev-parse', 'HEAD'), winner = await git(root, 'rev-parse', 'ab/hero/b')
  const adopted = await abPick({ targetRoot: root, slug: 'hero', variant: 'b' })
  assert.equal(adopted.adopted, 'b'); assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'module.exports = "beta"\n')
  // The adoption is logged in STATE and left for the session to commit.
  assert.match(adopted.logLine, /^- \d{6} ab hero: adopt b — Make it beta\.$/); assert.deepEqual(adopted.files, ['spec/STATE.md'])
  assert.equal(await git(root, 'status', '--porcelain'), 'M spec/STATE.md')
  assert.match(await git(root, 'log', '-1', '--format=%s'), /ab hero: adopt b/)
  assert.equal(await git(root, 'rev-parse', 'HEAD^1'), before); assert.equal(await git(root, 'rev-parse', 'HEAD^2'), winner)
  for (const entry of started.variants) assert.equal(await exists(entry.path), false)
  // The emptied sibling worktree folders go; with pruning, so do the comparison's logs, feedback and prompts.
  assert.equal(await exists(path.join(temporary, '.gusta-worktrees')), false)
  assert.equal(await exists(path.dirname(measured.variants[0].log)), false)
  // prune-branches defaults to true: no variant branch outlives the pick.
  assert.deepEqual(adopted.branches, [])
  assert.equal(await git(root, 'branch', '--list', 'ab/hero/*'), '')
  await settle()
  await assert.rejects(fetch(served.variants[0].url))
  await assert.rejects(fetch(served.hub))
  await assert.rejects(abStatus({ targetRoot: root, slug: 'hero' }), /없습니다/)
})

// A checkout with an ignored install matching the root lockfile at HEAD (the lockfile changed once before).
async function installed(root) {
  await writeFile(path.join(root, '.gitignore'), 'node_modules\n'); await writeFile(path.join(root, 'package-lock.json'), '{"lock":1}\n')
  await git(root, 'add', '.gitignore', 'package-lock.json'); await git(root, 'commit', '-q', '-m', 'lock 1')
  await writeFile(path.join(root, 'package-lock.json'), '{"lock":2}\n'); await git(root, 'commit', '-q', '-am', 'lock 2')
  await mkdir(path.join(root, 'node_modules/pkg'), { recursive: true }); await mkdir(path.join(root, 'node_modules/.bin'))
  await writeFile(path.join(root, 'node_modules/pkg/index.js'), 'module.exports = 2\n'); await symlink('../pkg/index.js', path.join(root, 'node_modules/.bin/pkg'))
  // A workspace package's install: no lockfile of its own, so the root one governs it.
  await mkdir(path.join(root, 'apps/web/node_modules'), { recursive: true }); await writeFile(path.join(root, 'apps/web/node_modules/web.js'), 'web\n')
}
const INSTALL = 'node -e "require(\'fs\').writeFileSync(\'installed\',\'1\')"'
const dirsOf = (entries) => entries.map((entry) => [entry.dir, entry.reused, entry.reason])

test('--reuse clones ignored dependency dirs whose lockfiles are unchanged at the base, and installs otherwise', async (t) => {
  const { root } = await project(t, 'deps', 'stale', 'mixed', 'broken')
  await installed(root)
  await assert.rejects(abStart({ targetRoot: root, slug: 'deps', reuse: ['../node_modules'] }), /--reuse/)
  // A tracked dir is never overwritten by a copy.
  await assert.rejects(abStart({ targetRoot: root, slug: 'deps', reuse: ['spec'] }), /무시하는.*spec/)
  const started = await abStart({ targetRoot: root, slug: 'deps', variants: 2, basePort: 4951, reuse: ['node_modules/', 'apps/web/node_modules'] })
  assert.equal(started.ok, true, JSON.stringify(started)); assert.equal(started.setup, undefined)
  for (const entry of started.variants) {
    assert.deepEqual(dirsOf(started.reuse[entry.variant]), [['node_modules', true, undefined], ['apps/web/node_modules', true, undefined]])
    // A real copy, never a link into this checkout: an install in the variant must not reach it.
    const copied = path.join(entry.path, 'node_modules')
    assert.ok((await lstat(copied)).isDirectory()); assert.equal(await readlink(path.join(copied, '.bin/pkg')), '../pkg/index.js')
    assert.equal(await readFile(path.join(entry.path, 'apps/web/node_modules/web.js'), 'utf8'), 'web\n')
    await writeFile(path.join(copied, 'pkg/index.js'), 'module.exports = "variant"\n')
  }
  assert.equal(await readFile(path.join(root, 'node_modules/pkg/index.js'), 'utf8'), 'module.exports = 2\n')
  // Started from the commit before the lockfile changed, the copy would be the wrong install: setup runs.
  const old = await abStart({ targetRoot: root, slug: 'stale', variants: 2, basePort: 4961, setup: INSTALL, reuse: ['node_modules'], base: 'HEAD~1' })
  assert.deepEqual(old.reuse.a, [{ dir: 'node_modules', reused: false, reason: 'package-lock.json differs at base' }]); assert.equal(old.setup.a.ok, true)
  for (const entry of old.variants) { assert.ok(await exists(path.join(entry.path, 'installed'))); assert.equal(await exists(path.join(entry.path, 'node_modules')), false) }
  // With --setup, one dir that cannot be reused sends the worktree to setup without copying the others.
  const copies = []
  const counted = async (source, destination) => { copies.push(destination); return copyTree(source, destination) }
  const mixed = await abStart({ targetRoot: root, slug: 'mixed', variants: 2, basePort: 4971, setup: INSTALL, reuse: ['node_modules', 'missing/node_modules'] }, { copy: counted })
  assert.deepEqual(dirsOf(mixed.reuse.b), [['node_modules', false, 'setup instead'], ['missing/node_modules', false, 'not in this checkout']])
  assert.deepEqual(copies, []); assert.equal(mixed.setup.b.ok, true)
  // A copy that fails falls back to setup for that worktree.
  const failing = async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) }
  const broken = await abStart({ targetRoot: root, slug: 'broken', variants: 2, basePort: 4981, setup: INSTALL, reuse: ['node_modules'] }, { copy: failing })
  assert.deepEqual(dirsOf(broken.reuse.a), [['node_modules', false, 'copy failed: ENOSPC']]); assert.equal(broken.setup.a.ok, true)
  assert.ok(await exists(path.join(broken.variants[0].path, 'installed')))
})

test('copyTree clones natively and falls back to fs.cp when the platform cp fails or is missing', async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-ab-copy-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'node_modules')
  await mkdir(path.join(source, 'pkg'), { recursive: true }); await mkdir(path.join(source, '.bin'))
  await writeFile(path.join(source, 'pkg/index.js'), 'x\n'); await symlink('../pkg/index.js', path.join(source, '.bin/pkg'))
  const calls = []
  const broken = async (command, args) => { calls.push([command, ...args]); throw new Error('cp failed') }
  for (const [name, options] of [['native', {}], ['fallback', { platform: 'darwin', run: broken }], ['other', { platform: 'win32', run: broken }]]) {
    const destination = path.join(directory, name, 'node_modules')
    await copyTree(source, destination, options)
    assert.equal(await readFile(path.join(destination, 'pkg/index.js'), 'utf8'), 'x\n'); assert.equal(await readlink(path.join(destination, '.bin/pkg')), '../pkg/index.js')
    assert.ok(!(await lstat(destination)).isSymbolicLink())
  }
  // Only darwin tried the platform cp, and only into a destination that did not exist yet.
  assert.deepEqual(calls, [['/bin/cp', '-c', '-R', source, path.join(directory, 'fallback', 'node_modules')]])
})

test('--reuse refuses a dir git cannot judge (beyond a symlinked dir) with the same message', async (t) => {
  const { root } = await fixture(t)
  await mkdir(path.join(root, 'apps')); await writeFile(path.join(root, 'apps/keep'), ''); await symlink('apps', path.join(root, 'linked'))
  await git(root, 'add', 'apps', 'linked'); await git(root, 'commit', '-q', '-m', 'linked')
  await assert.rejects(abStart({ targetRoot: root, slug: 'linked', reuse: ['linked/node_modules'] }), (error) => error.name === 'SkillPackageError' && /무시하는.*linked\/node_modules/.test(error.message))
})

test('start refuses uncommitted user changes; stop --remove keeps branches when prune-branches is false unless forced', async (t) => {
  const { root } = await fixture(t)
  await writeFile(path.join(root, 'dirty.txt'), 'x')
  await assert.rejects(abStart({ targetRoot: root, slug: 'nav' }), /미커밋/)
  await git(root, 'add', 'dirty.txt'); await git(root, 'commit', '-q', '-m', 'dirty')
  await assert.rejects(abStart({ targetRoot: root, slug: 'Bad Slug' }), /slug/)
  await assert.rejects(abStart({ targetRoot: root, slug: 'nav', variants: 7 }), /variants/)
  // A copy that fails after `git worktree add` takes that worktree and branch away again.
  await assert.rejects(abStart({ targetRoot: root, slug: 'nav', copy: ['spec'] }))
  assert.equal(await git(root, 'branch', '--list', 'ab/nav/*'), ''); assert.equal((await git(root, 'worktree', 'list')).includes('ab-nav-'), false)
  const started = await abStart({ targetRoot: root, slug: 'nav', variants: 3, basePort: 4761 })
  assert.equal(started.variants.length, 3)
  await writeFile(path.join(started.variants[0].path, 'pending.txt'), 'unfinished')
  await assert.rejects(abStop({ targetRoot: root, slug: 'nav', remove: true }), /커밋되지 않은 변경/)
  await git(started.variants[0].path, 'add', 'pending.txt'); await git(started.variants[0].path, 'commit', '-q', '-m', 'wip')
  await assert.rejects(abPick({ targetRoot: root, slug: 'nav', variant: 'b' }), /커밋이 없습니다/)
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- prune-branches: false\n'); await git(root, 'add', 'spec/SETTINGS.md'); await git(root, 'commit', '-q', '-m', 'keep branches')
  const logs = path.dirname((await abExec({ targetRoot: root, slug: 'nav', variant: 'a', command: 'node -e 1' })).variants[0].log)
  const stopped = await abStop({ targetRoot: root, slug: 'nav', remove: true })
  assert.deepEqual(stopped.branches, ['ab/nav/a', 'ab/nav/b', 'ab/nav/c'])
  assert.match(await git(root, 'branch', '--list', 'ab/nav/*'), /ab\/nav\/a/)
  // Without pruning the logs stay; the emptied worktree folder goes either way.
  assert.ok(await exists(logs)); assert.equal(await exists(path.dirname(started.variants[0].path)), false)
  const again = await abStart({ targetRoot: root, slug: 'nav2', variants: 2, basePort: 4771 })
  const logs2 = path.dirname((await abExec({ targetRoot: root, slug: 'nav2', variant: 'a', command: 'node -e 1' })).variants[0].log)
  await abStop({ targetRoot: root, slug: 'nav2', remove: true, pruneBranches: true })
  assert.equal(await git(root, 'branch', '--list', 'ab/nav2/*'), ''); assert.equal(await exists(logs2), false)
  assert.equal(again.ok, true)
})

test('run --all runs every variant with a prompt in --prompt-dir at once, saves each and keeps going past a failure', async (t) => {
  const { root, temporary } = await project(t, 'all')
  await abStart({ targetRoot: root, slug: 'all', variants: 4, basePort: 4981 })
  const promptDir = path.join(temporary, 'prompts'); await mkdir(promptDir)
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(promptDir, `${name}.md`), `Approach ${name}.`)
  await assert.rejects(abRun({ targetRoot: root, slug: 'all', all: true }), /--prompt-dir/)
  await assert.rejects(abRun({ targetRoot: root, slug: 'all', all: true, promptDir, followUpFile: path.join(promptDir, 'a.md') }), /--all/)
  await assert.rejects(abRun({ targetRoot: root, slug: 'all', all: true, promptDir: temporary }), /a\.md, b\.md, c\.md/)
  const finished = []
  const delays = { a: 400, b: 50 }
  const execute = async (input) => {
    const name = input.job.workspace.slice(-1)
    if (name === 'c') throw new Error('provider crashed')
    await new Promise((resolve) => setTimeout(resolve, delays[name]))
    const result = await session(`v${name}`)(input)
    finished.push(name)
    return result
  }
  const ran = await abRun({ targetRoot: root, slug: 'all', all: true, promptDir }, { inspect: providers, flags: noFlags, execute })
  assert.deepEqual(finished, ['b', 'a'])
  assert.equal(ran.ok, false); assert.deepEqual(ran.variants.map((entry) => [entry.variant, entry.ok]), [['a', true], ['b', true], ['c', false]])
  assert.equal(ran.variants[2].error, 'provider crashed'); assert.deepEqual(ran.skipped, ['d'])
  const status = await abStatus({ targetRoot: root, slug: 'all' })
  assert.deepEqual(status.variants.map((entry) => entry.last?.summary ?? null), ['va variant', 'vb variant', null, null])
})

test('variant and scaffold sessions get the optional provider flags the installed CLI supports', async (t) => {
  const { root, temporary } = await project(t, 'flags')
  const flags = async (provider) => provider === 'claude' ? ['--exclude-dynamic-system-prompt-sections'] : []
  const scaffoldPrompt = path.join(temporary, 'scaffold.md'); await writeFile(scaffoldPrompt, 'Screen: /profile.')
  const seen = []
  const record = (fake) => async (input) => { seen.push([input.job.role, input.flags]); return fake(input) }
  await abStart({ targetRoot: root, slug: 'flags', variants: 2, basePort: 4801, scaffoldPrompt }, { inspect: providers, flags, execute: record(scaffolding) })
  const promptFile = path.join(temporary, 'flags.md'); await writeFile(promptFile, 'Make it plain.')
  await abRun({ targetRoot: root, slug: 'flags', variant: 'a', promptFile }, { inspect: providers, flags, execute: record(session('plain')) })
  assert.deepEqual(seen, [['scaffold', ['--exclude-dynamic-system-prompt-sections']], ['variant', ['--exclude-dynamic-system-prompt-sections']]])
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
    { name: 'a', url: 'http://localhost:4101/settings', approach: 'Cards <first>', summary: 'cards <script>x</script>\nsecond line', view: 'settings tab', serving: true },
    { name: 'b', from: 'a', url: 'http://localhost:4102', summary: 'list', view: '', serving: false, exec: { command: 'bench', medianMs: 812, exitCodes: [0, 1], last: '<b>done</b>' } }] })
  assert.ok(html.includes('<p class="measure bad" title="bench">median 812 ms · exit 0,1 · <code>&lt;b&gt;done&lt;/b&gt;</code></p>'))
  // Numbers from different commands do not compare: then each line names its command.
  const exec = (command) => ({ command, medianMs: 5, exitCodes: [0], last: '' })
  const mixed = renderHub({ slug: 'hero', variants: [{ name: 'a', url: 'u', summary: '', view: '', exec: exec('npm run bench') }, { name: 'b', url: 'v', summary: '', view: '', exec: exec('npm test') }] })
  assert.ok(mixed.includes('<code>npm run bench</code> · median 5 ms') && mixed.includes('<code>npm test</code> · median 5 ms'))
  const same = renderHub({ slug: 'hero', variants: [{ name: 'a', url: 'u', summary: '', view: '', exec: exec('npm test') }, { name: 'b', url: 'v', summary: '', view: '' }] })
  assert.ok(!same.includes('<code>npm test</code>'))
  assert.deepEqual([...html.matchAll(/<iframe src="([^"]+)"/g)].map((match) => match[1]), ['http://localhost:4101/settings', 'http://localhost:4102'])
  assert.ok(!html.includes('<script>x</script>')); assert.ok(html.includes('cards &lt;script&gt;'))
  // The approach titles the variant; the latest summary (a follow-up's says only what changed) sits below it.
  assert.ok(html.includes('<p class="approach" title="Cards &lt;first&gt;">Cards &lt;first&gt;</p><p title="cards &lt;script&gt;'))
  assert.ok(!html.includes('class="approach" title=""'))
  const model = hubModel({ slug: 'hero', variants: { a: { port: 1, approach: '# Cards first\n\nThree columns.', runs: [{ summary: 'prices are bold now' }] } } }, {}, () => false)
  assert.deepEqual([model.variants[0].approach, model.variants[0].summary], ['Cards first', 'prices are bold now'])
  assert.ok(html.includes('>larger &lt;b&gt;</textarea>')); assert.match(html, /data-variant="b" class="chosen"/)
  assert.match(html, /target="_blank"/); assert.match(html, /data-width="390"/); assert.match(html, /not serving/); assert.match(html, /blocks framing/); assert.match(html, /<strong>b<\/strong><span class="muted">from a<\/span>/)
})

test('hub records notes and a choice for known variants only, and ends with its comparison', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gusta-ab-hub-'))
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

test('a scaffold session is the variants\' base, prompts share one prefix, follow-ups carry context, and pick drops the scaffold', async (t) => {
  const { root, temporary } = await project(t, 'mock')
  await writeFile(path.join(root, 'data.js'), "module.exports = fetch('/api/user')\n"); await git(root, 'add', 'data.js'); await git(root, 'commit', '-q', '-m', 'data')
  const origin = await git(root, 'rev-parse', 'HEAD')
  const sharedFile = path.join(temporary, 'shared.md'), scaffoldPrompt = path.join(temporary, 'scaffold.md')
  await writeFile(sharedFile, 'Goal: a clearer profile screen. Keep ARCH-1.'); await writeFile(scaffoldPrompt, 'Screen: /profile needs a signed-in user.')
  const jobs = []
  const started = await abStart({ targetRoot: root, slug: 'mock', variants: 2, basePort: 4831, sharedFile, scaffoldPrompt }, { inspect: providers, flags: noFlags, execute: capture(jobs, scaffolding) })
  // The shared file is copied into the record: the coordinator's temporary folder may go.
  await rm(sharedFile)
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal(jobs.length, 1); assert.equal(jobs[0].role, 'scaffold'); assert.match(jobs[0].prompt, /clearer profile/); assert.match(jobs[0].prompt, /signed-in user/)
  const scaffold = await git(root, 'rev-parse', 'ab/mock/base')
  assert.deepEqual([started.origin, started.scaffold, started.base], [origin, scaffold, scaffold])
  assert.equal(await git(root, 'rev-parse', `${scaffold}^`), origin)
  // Modified existing files are listed apart, so the coordinator can spot the target screen among them.
  assert.deepEqual(started.scaffoldFiles, { added: ['fixtures.json'], modified: ['data.js'] }); assert.equal(started.scaffoldRun.path, '/profile')
  for (const entry of started.variants) {
    assert.equal(await git(entry.path, 'rev-parse', 'HEAD'), scaffold)
    assert.ok(await exists(path.join(entry.path, 'fixtures.json')))
  }
  assert.equal((await git(root, 'worktree', 'list')).includes('ab-mock-base'), false)
  const promptFile = async (name, text) => { const file = path.join(temporary, name); await writeFile(file, text); return file }
  await assert.rejects(abRun({ targetRoot: root, slug: 'mock', variant: 'b', followUpFile: await promptFile('early.md', 'x') }, { inspect: providers }), /먼저 --prompt-file/)
  await assert.rejects(abRun({ targetRoot: root, slug: 'mock', variant: 'b', promptFile: await promptFile('both.md', 'x'), followUpFile: await promptFile('both2.md', 'x') }, { inspect: providers }), /하나가 필요/)
  const runs = {}, prompts = {}
  for (const [variant, text] of [['a', 'alpha'], ['b', 'beta']]) {
    const seen = []
    runs[variant] = await abRun({ targetRoot: root, slug: 'mock', variant, promptFile: await promptFile(`${variant}.md`, `Approach: make it ${text}.`) }, { inspect: providers, flags: noFlags, execute: capture(seen, session(text)) })
    prompts[variant] = seen[0].prompt
    assert.equal(runs[variant].ok, true); assert.equal(runs[variant].scaffoldTouched, undefined)
  }
  // Everything before the variant line is identical: shared text and the scaffold rule with its own notes.
  const prefix = (variant) => prompts[variant].slice(0, prompts[variant].indexOf(`Variant ${variant} of mock`))
  assert.equal(prefix('a'), prefix('b')); assert.match(prefix('a'), /clearer profile/); assert.match(prefix('a'), /Read-only: fixtures\.json\./)
  assert.match(prefix('a'), /You may edit data\.js except the scaffold's lines and the lines right around them \(data\.js: 1\)\./)
  assert.match(prefix('a'), /Scaffold notes: fixtures for the profile screen/); assert.match(prefix('a'), /data states.*name them in view/)
  // The full prompt each session got is kept next to its log, private; results carry only its path.
  for (const file of [runs.a.promptPath, started.scaffoldRun.promptPath]) assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal(runs.a.promptPath, runs.a.log.replace(/\.log$/, '.prompt.md'))
  assert.match(await readFile(runs.a.promptPath, 'utf8'), /^You build one variant[\s\S]*Approach: make it alpha\.$/)
  assert.match(await readFile(started.scaffoldRun.promptPath, 'utf8'), /^You build the shared mock scaffold[\s\S]*signed-in user\.$/)
  assert.ok(!JSON.stringify(runs.a).includes('You build one variant'))
  assert.match(prompts.a, /\$PORT for this variant: \d+\.\n\nApproach: make it alpha\.$/)
  // A follow-up repeats the first prompt, then adds the last summary, the hub note written since and the request.
  await writeFile(path.join(path.dirname(runs.a.log), 'feedback.json'), JSON.stringify({ notes: { a: { note: 'bigger title', at: new Date(Date.now() + 60000).toISOString() } }, chosen: null }))
  const seen = []
  const followed = await abRun({ targetRoot: root, slug: 'mock', variant: 'a', followUpFile: await promptFile('follow.md', 'Make the title bigger.') }, { inspect: providers, flags: noFlags, execute: capture(seen, session('alpha2')) })
  assert.equal(followed.followUp, true); assert.equal(followed.changed, true)
  const next = seen[0].prompt
  assert.ok(next.startsWith(prompts.a), 'follow-up keeps the first run prompt as its prefix')
  for (const part of [/Your last run's summary: alpha variant/, /note on this variant: bigger title/, /already contains this work/, /Make the title bigger\.$/]) assert.match(next, part)
  // Adoption is one commit on the start base: a's net change with every scaffold path as origin had it.
  const before = await git(root, 'rev-parse', 'HEAD')
  const adopted = await abPick({ targetRoot: root, slug: 'mock', variant: 'a' })
  assert.equal(await git(root, 'rev-parse', 'HEAD^1'), before); assert.equal(await git(root, 'rev-parse', 'HEAD^2^'), origin)
  assert.equal(await git(root, 'diff', '--name-only', 'HEAD^1', 'HEAD'), 'app.js')
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'module.exports = "alpha2"\n')
  assert.equal(await readFile(path.join(root, 'data.js'), 'utf8'), "module.exports = fetch('/api/user')\n")
  assert.equal(await exists(path.join(root, 'fixtures.json')), false)
  assert.equal(adopted.scaffold, scaffold); assert.deepEqual(adopted.scaffoldFiles, started.scaffoldFiles); assert.match(adopted.todo, /실제 데이터/)
  assert.equal(await git(root, 'branch', '--list', 'ab/mock/*'), '')
})

test('a scaffold that deletes an existing file or turns it into a directory gets it back in the adopted commit', async (t) => {
  const { root, temporary } = await project(t, 'gone')
  await writeFile(path.join(root, 'middleware.js'), 'module.exports = redirectToLogin\n'); await writeFile(path.join(root, 'session.js'), 'module.exports = realSession\n')
  await git(root, 'add', 'middleware.js', 'session.js'); await git(root, 'commit', '-q', '-m', 'auth')
  const scaffoldPrompt = path.join(temporary, 'scaffold.md'); await writeFile(scaffoldPrompt, 'Screen: / without sign-in.')
  const unguard = async ({ job }) => {
    await rm(path.join(job.workspace, 'middleware.js'))
    await rm(path.join(job.workspace, 'session.js')); await mkdir(path.join(job.workspace, 'session.js'))
    await writeFile(path.join(job.workspace, 'session.js', 'index.js'), 'module.exports = { user: "Ada" }\n')
    return { outcome: 'completed', summary: 'no sign-in redirect', view: 'home', path: '' }
  }
  const started = await abStart({ targetRoot: root, slug: 'gone', variants: 2, basePort: 4931, scaffoldPrompt }, { inspect: providers, flags: noFlags, execute: unguard })
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.deepEqual(started.scaffoldFiles, { added: ['session.js/index.js'], modified: ['middleware.js', 'session.js'] })
  const promptFile = path.join(temporary, 'a.md'); await writeFile(promptFile, 'Make it kept.')
  await abRun({ targetRoot: root, slug: 'gone', variant: 'a', promptFile }, { inspect: providers, flags: noFlags, execute: session('kept') })
  const before = await git(root, 'rev-parse', 'HEAD')
  const adopted = await abPick({ targetRoot: root, slug: 'gone', variant: 'a' })
  assert.deepEqual(adopted.scaffoldFiles, started.scaffoldFiles)
  assert.equal(await git(root, 'rev-parse', 'HEAD^1'), before); assert.equal(await git(root, 'diff', '--name-only', 'HEAD^1', 'HEAD'), 'app.js')
  assert.equal(await readFile(path.join(root, 'middleware.js'), 'utf8'), 'module.exports = redirectToLogin\n')
  assert.equal(await readFile(path.join(root, 'session.js'), 'utf8'), 'module.exports = realSession\n')
})

// A page whose entry the scaffold had to edit: one mock <script> line (line 7), the rest of the file the variants' to change.
const page = ({ head = '', body = '<body>', app = '<div id="app"></div>', mock = '', script = '<script src="app.js"></script>', after = '' } = {}) =>
  `<html>\n<head>\n<title>Profile</title>\n${head}</head>\n${body}\n${app}\n${mock}${script}\n${after}</body>\n</html>\n`
const MOCK = '<script src="mocks/mock.js"></script>\n'
const register = async ({ job }) => {
  await mkdir(path.join(job.workspace, 'mocks'), { recursive: true }); await writeFile(path.join(job.workspace, 'mocks/mock.js'), "import { ready } from '../util.js'\nif (window.mock) {\n  window.fetch = mockFetch\n}\n")
  await writeFile(path.join(job.workspace, 'index.html'), page({ mock: MOCK }))
  return { outcome: 'completed', summary: 'mock fetch; ?mock=empty shows no items', view: 'home', path: '' }
}
const edit = (parts, extra = {}) => async ({ job }) => {
  await writeFile(path.join(job.workspace, 'index.html'), page(parts))
  for (const [file, text] of Object.entries(extra)) await writeFile(path.join(job.workspace, file), text)
  return { outcome: 'completed', summary: 'edited', view: 'home', path: '' }
}
const AROUND = { head: '<style>.card{display:grid}</style>\n', body: '<body class="cards">', after: '<p>footer</p>\n' }

test('the scaffold lock is per line: edits with an unchanged line between adopt; edits on or next to its line and copies of it are refused', async (t) => {
  const { root, temporary } = await project(t, 'lines')
  await writeFile(path.join(root, 'index.html'), page()); await writeFile(path.join(root, 'util.js'), "export const ready = true\nimport { ready } from '../util.js'\n")
  await git(root, 'add', 'index.html', 'util.js'); await git(root, 'commit', '-q', '-m', 'page')
  const origin = await git(root, 'rev-parse', 'HEAD')
  const scaffoldPrompt = path.join(temporary, 'scaffold.md'); await writeFile(scaffoldPrompt, 'Screen: / with items.')
  const started = await abStart({ targetRoot: root, slug: 'lines', variants: 6, basePort: 5021, scaffoldPrompt }, { inspect: providers, flags: noFlags, execute: register })
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.deepEqual(started.scaffoldFiles, { added: ['mocks/mock.js'], modified: ['index.html'] }); assert.match(started.scaffoldWarnings[0], /likely UI files: index\.html/)
  const promptDir = path.join(temporary, 'prompts'); await mkdir(promptDir)
  for (const name of 'abcdef') await writeFile(path.join(promptDir, `${name}.md`), `Approach ${name}.`)
  const sessions = {
    // a: <style> in <head>, a class two lines above the mock line (3-way) and a line after the app script: one unchanged line between each.
    a: edit({ ...AROUND, mock: MOCK }),
    b: edit({ mock: '<script src="mocks/other.js"></script>\n' }), // the scaffold line itself
    c: edit({ app: '<div id="app" class="x"></div>', mock: MOCK }), // the line directly before it
    d: edit({ mock: MOCK, script: '<script src="app.js" defer></script>' }), // the line directly after it
    // e: copies the mock line into <head> and imports the mock file from a new file: both would ship pointing at a deleted file.
    e: edit({ head: MOCK, mock: MOCK }, { 'boot.js': "import './mocks/mock.js'\n" }),
    // f: a lone `}` and an import, both also lines of the scaffold's own new file: only its wiring lines and paths mark residue.
    f: edit({ mock: MOCK }, { 'app.css': '.card {\n  color: red;\n}\n', 'view.js': "import { ready } from '../util.js'\n" }),
  }
  const jobs = []
  const ran = await abRun({ targetRoot: root, slug: 'lines', all: true, promptDir }, { inspect: providers, flags: noFlags, execute: capture(jobs, (input) => sessions[input.job.workspace.slice(-1)](input)) })
  const result = Object.fromEntries(ran.variants.map((entry) => [entry.variant, entry]))
  assert.deepEqual(ran.variants.map((entry) => [entry.variant, entry.ok]), [['a', true], ['b', false], ['c', false], ['d', false], ['e', false], ['f', true]])
  for (const name of 'bcd') assert.deepEqual(result[name].scaffoldTouched, ['index.html'], name)
  assert.deepEqual(result.e.scaffoldResidue, [{ file: 'boot.js', line: "import './mocks/mock.js'" }, { file: 'index.html', line: MOCK.trim() }]); assert.equal(result.e.scaffoldTouched, undefined)
  for (const name of 'af') assert.equal(result[name].scaffoldResidue, undefined, name)
  assert.match(jobs.find((job) => job.workspace.endsWith('a')).prompt, /Read-only: mocks\/mock\.js\. You may edit index\.html except the scaffold's lines and the lines right around them \(index\.html: 7\)\./)
  const head = await git(root, 'rev-parse', 'HEAD')
  for (const name of 'bcd') await assert.rejects(abPick({ targetRoot: root, slug: 'lines', variant: name }), (error) => /scaffold의 줄·파일을 바꿨거나 그 줄에 너무 붙여/.test(error.message) && error.details.join() === 'index.html', name)
  await assert.rejects(abPick({ targetRoot: root, slug: 'lines', variant: 'e' }), (error) => /mock 줄·경로/.test(error.message) && error.details.join('|') === `boot.js: import './mocks/mock.js'|index.html: ${MOCK.trim()}`)
  // Every refusal came before anything stopped or moved.
  assert.equal(await git(root, 'rev-parse', 'HEAD'), head); assert.equal((await abStatus({ targetRoot: root, slug: 'lines' })).variants.length, 6)
  await abPick({ targetRoot: root, slug: 'lines', variant: 'a' })
  assert.equal(await git(root, 'rev-parse', 'HEAD^1'), head); assert.equal(await git(root, 'rev-parse', 'HEAD^2^'), origin)
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), page(AROUND))
  assert.equal(await exists(path.join(root, 'mocks')), false); assert.equal(await git(root, 'diff', '--name-only', 'HEAD^1', 'HEAD'), 'index.html')
})

// An app with real modules next to the scaffold's mock ones: residue marks must tell them apart.
const APP = { 'src/api/client.js': 'export const get = (url) => fetch(url)\n', 'src/data/index.js': 'export const rows = await get()\n',
  'src/app.js': "import { get } from './api/client'\nexport const app = get\n", 'src/main.js': "import './app'\n" }
const mocking = async ({ job }) => {
  const files = { 'src/mocks/api/client.js': 'export const get = async () => ({ items: [] })\n', 'src/mocks/data/index.js': 'export const rows = []\n',
    'src/mocks/AuthStub.jsx': "import { useEffect, useState } from 'react'\nexport function AuthStub({ children }) {\n  const [user, setUser] = useState(null)\n  useEffect(() => setUser({ name: 'Ada' }), [])\n  return children\n}\n",
    'src/mocks/handlers.js': 'export const handlers = []\n', 'src/mocks/index.js': "import { handlers } from './handlers'\nexport default handlers\n", 'fixtures.json': '{"user":"Ada"}\n',
    // The wiring: an entry import, plus an import origin already has elsewhere (common code, not a mark).
    'src/main.js': "import './mocks'\nimport { get } from './api/client'\nimport './app'\n" }
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(job.workspace, file)), { recursive: true }); await writeFile(path.join(job.workspace, file), text) }
  return { outcome: 'completed', summary: 'mock api, data and auth', view: 'home', path: '' }
}
const writing = (files) => async ({ job }) => {
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(job.workspace, file)), { recursive: true }); await writeFile(path.join(job.workspace, file), text) }
  return { outcome: 'completed', summary: 'built', view: 'home', path: '' }
}

test('residue marks the scaffold\'s wiring and paths, not imports of real modules or boilerplate in its new files', async (t) => {
  const { root, temporary } = await project(t, 'marks')
  for (const [file, text] of Object.entries(APP)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text) }
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', 'app')
  const scaffoldPrompt = path.join(temporary, 'scaffold.md'); await writeFile(scaffoldPrompt, 'Screen: /profile.')
  const started = await abStart({ targetRoot: root, slug: 'marks', variants: 4, basePort: 5061, scaffoldPrompt }, { inspect: providers, flags: noFlags, execute: mocking })
  assert.equal(started.ok, true, JSON.stringify(started))
  const promptDir = path.join(temporary, 'prompts'); await mkdir(promptDir)
  for (const name of 'abcd') await writeFile(path.join(promptDir, `${name}.md`), `Approach ${name}.`)
  const sessions = {
    // a: the real client (an alias swap probe), the real data/index, the stub's React boilerplate and an import origin already has.
    a: writing({ 'src/components/Profile.jsx': "import { useEffect, useState } from 'react'\nimport { get } from '../api/client'\nimport { rows } from '../data/index'\nexport function Profile({ children }) {\n  const [user, setUser] = useState(null)\n  useEffect(() => { get('/me').then(setUser) }, [])\n  return children\n}\n",
      'src/feed.js': "import { get } from './api/client'\nimport { rows } from './data/index'\nexport const feed = () => get('/feed')\n" }),
    b: writing({ 'src/components/List.jsx': "import { handlers } from '../mocks/handlers'\nexport const List = () => handlers\n" }),
    c: writing({ 'src/components/Boot.js': "import '../mocks'\n" }), // the mocks directory, through its index.js
    d: writing({ 'seed.js': "import data from './fixtures'\nexport default data\n" }), // a root fixture without its extension
  }
  const ran = await abRun({ targetRoot: root, slug: 'marks', all: true, promptDir }, { inspect: providers, flags: noFlags, execute: (input) => sessions[input.job.workspace.slice(-1)](input) })
  const result = Object.fromEntries(ran.variants.map((entry) => [entry.variant, entry]))
  assert.equal(result.a.ok, true, JSON.stringify(result.a.scaffoldResidue)); assert.equal(result.a.scaffoldResidue, undefined)
  assert.deepEqual(result.b.scaffoldResidue, [{ file: 'src/components/List.jsx', line: "import { handlers } from '../mocks/handlers'" }])
  assert.deepEqual(result.c.scaffoldResidue, [{ file: 'src/components/Boot.js', line: "import '../mocks'" }])
  assert.deepEqual(result.d.scaffoldResidue, [{ file: 'seed.js', line: "import data from './fixtures'" }])
  // Marks are computed once per origin and scaffold and kept in the runtime.
  const runtime = path.dirname(result.a.log)
  const cached = (await readdir(runtime)).filter((name) => name.startsWith('marks-'))
  assert.equal(cached.length, 1)
  const marks = JSON.parse(await readFile(path.join(runtime, cached[0]), 'utf8')), texts = marks.paths.map((mark) => mark.text)
  assert.deepEqual(marks.lines, ["import './mocks'"])
  for (const mark of ['mocks/handlers', 'mocks/api/client', 'mocks/data/index', 'fixtures', 'mocks']) assert.ok(texts.includes(mark), mark)
  for (const mark of ['api/client', 'data/index', 'data', 'index', 'handlers']) assert.ok(!texts.includes(mark), mark)
  assert.deepEqual(marks.paths.filter((mark) => mark.quoted).map((mark) => mark.text), ['fixtures.json', 'fixtures', 'mocks'])
  await assert.rejects(abPick({ targetRoot: root, slug: 'marks', variant: 'c' }), /--accept-residue/)
  await abPick({ targetRoot: root, slug: 'marks', variant: 'a' })
  assert.equal(await readFile(path.join(root, 'src/main.js'), 'utf8'), APP['src/main.js']); assert.equal(await exists(path.join(root, 'src/mocks')), false)
  assert.equal(await git(root, 'diff', '--name-only', 'HEAD^1', 'HEAD'), 'src/components/Profile.jsx\nsrc/feed.js')
})

test('pick --accept-residue adopts a variant despite residue the person accepted and lists it', async (t) => {
  const { root, temporary } = await project(t, 'accept')
  await mockBranch(root)
  await abStart({ targetRoot: root, slug: 'accept', variants: 2, basePort: 5081, scaffold: 'mock-data' }, { inspect: never, execute: never })
  const promptFile = path.join(temporary, 'a.md'); await writeFile(promptFile, 'Read the fixtures.')
  const run = await abRun({ targetRoot: root, slug: 'accept', variant: 'a', promptFile }, { inspect: providers, flags: noFlags, execute: writing({ 'app.js': "module.exports = require('./fixtures.json')\n" }) })
  const residue = [{ file: 'app.js', line: "module.exports = require('./fixtures.json')" }]
  assert.equal(run.ok, false); assert.deepEqual(run.scaffoldResidue, residue)
  await assert.rejects(abPick({ targetRoot: root, slug: 'accept', variant: 'a' }), (error) => error.details.join() === `app.js: ${residue[0].line}`)
  const adopted = await abPick({ targetRoot: root, slug: 'accept', variant: 'a', acceptResidue: true })
  assert.deepEqual(adopted.scaffoldResidue, residue); assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), "module.exports = require('./fixtures.json')\n")
  assert.equal(await exists(path.join(root, 'fixtures.json')), false)
})

test('a binary scaffold file comes back byte for byte; renaming a scaffold-modified file is refused', async (t) => {
  const { root, temporary } = await project(t, 'bin')
  const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255])
  await writeFile(path.join(root, 'logo.png'), logo); await writeFile(path.join(root, 'index.html'), page())
  await git(root, 'add', 'logo.png', 'index.html'); await git(root, 'commit', '-q', '-m', 'page')
  const scaffoldPrompt = path.join(temporary, 'scaffold.md'); await writeFile(scaffoldPrompt, 'Screen: / with photos.')
  const binary = async (input) => {
    await writeFile(path.join(input.job.workspace, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9, 0, 255]))
    await mkdir(path.join(input.job.workspace, 'mocks')); await writeFile(path.join(input.job.workspace, 'mocks/photo.png'), Buffer.from([0, 1, 0, 2, 255]))
    return register(input)
  }
  const started = await abStart({ targetRoot: root, slug: 'bin', variants: 2, basePort: 5041, scaffoldPrompt }, { inspect: providers, flags: noFlags, execute: binary })
  assert.deepEqual(started.scaffoldFiles, { added: ['mocks/mock.js', 'mocks/photo.png'], modified: ['index.html', 'logo.png'] })
  const promptFile = path.join(temporary, 'p.md'); await writeFile(promptFile, 'Build it.')
  const seen = []
  assert.equal((await abRun({ targetRoot: root, slug: 'bin', variant: 'a', promptFile }, { inspect: providers, flags: noFlags, execute: capture(seen, session('alpha')) })).ok, true)
  // A binary file has no line locations: it is read-only like the added files.
  assert.match(seen[0].prompt, /Read-only: logo\.png, mocks\/mock\.js, mocks\/photo\.png\. You may edit index\.html /)
  const moved = async ({ job }) => {
    await writeFile(path.join(job.workspace, 'main.html'), await readFile(path.join(job.workspace, 'index.html'))); await rm(path.join(job.workspace, 'index.html'))
    return { outcome: 'completed', summary: 'renamed the page', view: 'home', path: '' }
  }
  assert.deepEqual((await abRun({ targetRoot: root, slug: 'bin', variant: 'b', promptFile }, { inspect: providers, flags: noFlags, execute: moved })).scaffoldTouched, ['index.html'])
  await assert.rejects(abPick({ targetRoot: root, slug: 'bin', variant: 'b' }), (error) => error.details.join() === 'index.html')
  await abPick({ targetRoot: root, slug: 'bin', variant: 'a' })
  assert.deepEqual(await readFile(path.join(root, 'logo.png')), logo); assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), page())
  assert.equal(await exists(path.join(root, 'mocks')), false); assert.equal(await git(root, 'diff', '--name-only', 'HEAD^1', 'HEAD'), 'app.js')
})

test('scaffoldWarnings names modified files that look like UI or screen files', () => {
  assert.deepEqual(scaffoldWarnings(['src/data.js', 'vite.config.ts', 'pages', 'src/api/client.ts']), [])
  const [warning] = scaffoldWarnings(['index.html', 'src/data.js', 'styles/main.SCSS', 'src/Components/Card.ts', 'app/layout.js', 'src/views/x.svelte'])
  assert.match(warning, /: index\.html, styles\/main\.SCSS, src\/Components\/Card\.ts, app\/layout\.js, src\/views\/x\.svelte — redo the scaffold/)
})

// A scaffold commit made outside the comparison (mock-data on top of main), and sessions that edit it.
async function mockBranch(root) {
  await git(root, 'checkout', '-q', '-b', 'mock-data')
  await writeFile(path.join(root, 'fixtures.json'), '{"user":"Ada"}\n'); await git(root, 'add', 'fixtures.json'); await git(root, 'commit', '-q', '-m', 'mock')
  const mock = await git(root, 'rev-parse', 'HEAD')
  await git(root, 'checkout', '-q', 'main')
  return mock
}
const tamper = (text) => async ({ job }) => {
  await writeFile(path.join(job.workspace, 'fixtures.json'), '{"user":"Grace"}\n')
  await writeFile(path.join(job.workspace, 'app.js'), `module.exports = ${JSON.stringify(text)}\n`)
  return { outcome: 'completed', summary: 'changed the fixtures', view: 'home', path: '' }
}
const restore = async ({ job }) => {
  await writeFile(path.join(job.workspace, 'fixtures.json'), '{"user":"Ada"}\n')
  return { outcome: 'completed', summary: 'restored the fixtures', view: 'home', path: '' }
}
const never = async () => { throw new Error('no session for a reused scaffold') }

test('a reused --scaffold skips the session; a scaffold edit is flagged by run and refused by pick before anything stops', async (t) => {
  const { root, temporary } = await project(t, 'reuse')
  const origin = await git(root, 'rev-parse', 'HEAD'), mock = await mockBranch(root)
  await assert.rejects(abStart({ targetRoot: root, slug: 'reuse', scaffold: 'main' }, { inspect: never, execute: never }), /기준.*위의 커밋/)
  await assert.rejects(abStart({ targetRoot: root, slug: 'reuse', scaffold: 'mock-data', scaffoldPrompt: 'x' }), /하나만/)
  const started = await abStart({ targetRoot: root, slug: 'reuse', variants: 2, basePort: 4851, scaffold: 'mock-data' }, { inspect: never, execute: never })
  assert.deepEqual([started.origin, started.scaffold, started.base, started.scaffoldRun], [origin, mock, mock, undefined])
  assert.deepEqual(started.scaffoldFiles, { added: ['fixtures.json'], modified: [] })
  assert.equal(await git(root, 'branch', '--list', 'ab/reuse/base'), '')
  const promptFile = path.join(temporary, 'a.md'); await writeFile(promptFile, 'Change the data.')
  const run = await abRun({ targetRoot: root, slug: 'reuse', variant: 'a', promptFile }, { inspect: providers, flags: noFlags, execute: tamper('edited') })
  assert.equal(run.outcome, 'completed'); assert.equal(run.ok, false); assert.deepEqual(run.scaffoldTouched, ['fixtures.json'])
  const served = await abServe({ targetRoot: root, slug: 'reuse', command: PLAIN, readyTimeoutMs: 20000 })
  assert.equal(served.ok, true, JSON.stringify(served))
  const head = await git(root, 'rev-parse', 'HEAD'), tip = await git(root, 'rev-parse', 'ab/reuse/a')
  await assert.rejects(abPick({ targetRoot: root, slug: 'reuse', variant: 'a' }), (error) => /scaffold의 줄·파일/.test(error.message) && error.details.includes('fixtures.json'))
  // The refusal came first: servers and the hub still show the comparison, both branches are as they were.
  const status = await abStatus({ targetRoot: root, slug: 'reuse' })
  assert.equal(status.hub, served.hub); assert.ok(status.variants.every((entry) => entry.serving))
  assert.equal(await git(root, 'rev-parse', 'HEAD'), head); assert.equal(await git(root, 'status', '--porcelain'), '')
  assert.equal(await git(root, 'rev-parse', 'ab/reuse/a'), tip)
  // stop --remove prunes what the comparison made; the reused scaffold ref belongs to the caller.
  await abStop({ targetRoot: root, slug: 'reuse', remove: true })
  assert.equal(await git(root, 'branch', '--list', 'ab/reuse/*'), '')
  assert.equal(await git(root, 'rev-parse', 'mock-data'), mock)
})

test('add --from remixes a variant on its own branch, worktree and port, up to six, and pick adopts it without the scaffold', async (t) => {
  const { root, temporary } = await project(t, 'remix')
  const origin = await git(root, 'rev-parse', 'HEAD'), mock = await mockBranch(root)
  const started = await abStart({ targetRoot: root, slug: 'remix', variants: 2, basePort: 4971, scaffold: 'mock-data' }, { inspect: never, execute: never })
  const promptFile = path.join(temporary, 'p.md'); await writeFile(promptFile, 'Build it.')
  await abRun({ targetRoot: root, slug: 'remix', variant: 'a', promptFile }, { inspect: providers, flags: noFlags, execute: session('alpha') })
  await assert.rejects(abAdd({ targetRoot: root, slug: 'remix' }), /--from/)
  await assert.rejects(abAdd({ targetRoot: root, slug: 'remix', from: 'z' }), /변형 z/)
  const added = await abAdd({ targetRoot: root, slug: 'remix', from: 'a' })
  assert.equal(added.ok, true); assert.equal(added.variant, 'c'); assert.equal(added.from, 'a')
  assert.equal(await git(root, 'rev-parse', 'ab/remix/c'), await git(root, 'rev-parse', 'ab/remix/a'))
  assert.ok(!started.variants.some((entry) => entry.port === added.port))
  const seen = []
  await abRun({ targetRoot: root, slug: 'remix', variant: 'c', promptFile }, { inspect: providers, flags: noFlags, execute: capture(seen, session('gamma')) })
  assert.match(seen[0].prompt, new RegExp(`start from variant a's work.*git diff ${mock} ab/remix/<x>, x in a, b\\.\\n\\nBuild it\\.$`, 's'))
  for (const name of ['d', 'e', 'f']) assert.equal((await abAdd({ targetRoot: root, slug: 'remix', from: 'b' })).variant, name)
  await assert.rejects(abAdd({ targetRoot: root, slug: 'remix', from: 'a' }), /최대 6/)
  const status = await abStatus({ targetRoot: root, slug: 'remix' })
  assert.equal(new Set(status.variants.map((entry) => entry.url)).size, 6); assert.equal(status.variants[2].from, 'a')
  const adopted = await abPick({ targetRoot: root, slug: 'remix', variant: 'c' })
  assert.equal(adopted.adopted, 'c'); assert.equal(await git(root, 'rev-parse', 'HEAD^2^'), origin)
  assert.equal(await git(root, 'diff', '--name-only', 'HEAD^1', 'HEAD'), 'app.js')
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'module.exports = "gamma"\n')
  assert.equal(await exists(path.join(root, 'fixtures.json')), false)
})

test('add keeps start\'s setup and reuse, checks the lockfile at the remixed tip, and skips a port something else holds', async (t) => {
  const { root, temporary } = await project(t, 'tip')
  await installed(root)
  const started = await abStart({ targetRoot: root, slug: 'tip', variants: 2, basePort: 5011, setup: INSTALL, reuse: ['node_modules'] })
  assert.ok(started.reuse.a[0].reused && started.reuse.b[0].reused)
  // Variant a adds a dependency: its lockfile no longer matches this checkout's install.
  const promptFile = path.join(temporary, 'a.md'); await writeFile(promptFile, 'Add a dependency.')
  const lock = async ({ job }) => { await writeFile(path.join(job.workspace, 'package-lock.json'), '{"lock":"a"}\n'); return { outcome: 'completed', summary: 'new dependency', view: '', path: '' } }
  await abRun({ targetRoot: root, slug: 'tip', variant: 'a', promptFile }, { inspect: providers, flags: noFlags, execute: lock })
  const ports = started.variants.map((entry) => entry.port), held = Math.max(...ports) + 1
  const listener = await new Promise((resolve) => { const server = net.createServer().listen(held, '127.0.0.1', () => resolve(server)) })
  t.after(() => listener.close())
  const fromA = await abAdd({ targetRoot: root, slug: 'tip', from: 'a' })
  assert.deepEqual(fromA.reuse.c, [{ dir: 'node_modules', reused: false, reason: 'package-lock.json differs at base' }]); assert.equal(fromA.setup.c.ok, true)
  assert.ok(await exists(path.join(fromA.path, 'installed'))); assert.equal(await exists(path.join(fromA.path, 'node_modules')), false)
  assert.ok(![...ports, held].includes(fromA.port), String(fromA.port))
  const fromB = await abAdd({ targetRoot: root, slug: 'tip', from: 'b' })
  assert.equal(fromB.reuse.d[0].reused, true); assert.equal(fromB.setup, undefined)
  assert.equal(await readlink(path.join(fromB.path, 'node_modules/.bin/pkg')), '../pkg/index.js')
})

test('a scaffold edit reverted by a follow-up adopts cleanly; a merge conflict leaves the current branch and the comparison', async (t) => {
  const { root, temporary } = await project(t, 'revert')
  const origin = await git(root, 'rev-parse', 'HEAD')
  await mockBranch(root)
  await abStart({ targetRoot: root, slug: 'revert', variants: 2, basePort: 4911, scaffold: 'mock-data' }, { inspect: never, execute: never })
  const promptFile = path.join(temporary, 'a.md'), followUpFile = path.join(temporary, 'f.md')
  await writeFile(promptFile, 'Make it first.'); await writeFile(followUpFile, 'Put the fixtures back.')
  assert.deepEqual((await abRun({ targetRoot: root, slug: 'revert', variant: 'a', promptFile }, { inspect: providers, flags: noFlags, execute: tamper('first') })).scaffoldTouched, ['fixtures.json'])
  const reverted = await abRun({ targetRoot: root, slug: 'revert', variant: 'a', followUpFile }, { inspect: providers, flags: noFlags, execute: restore })
  assert.equal(reverted.ok, true); assert.equal(reverted.scaffoldTouched, undefined)
  // The current branch moved on and wrote app.js too: the adopt merge conflicts and is undone.
  await writeFile(path.join(root, 'app.js'), 'module.exports = "main"\n'); await git(root, 'add', 'app.js'); await git(root, 'commit', '-q', '-m', 'main app')
  const head = await git(root, 'rev-parse', 'HEAD'), tip = await git(root, 'rev-parse', 'ab/revert/a')
  await assert.rejects(abPick({ targetRoot: root, slug: 'revert', variant: 'a' }), /충돌/)
  assert.equal(await git(root, 'rev-parse', 'HEAD'), head); assert.equal(await git(root, 'status', '--porcelain'), '')
  assert.equal(await git(root, 'rev-parse', 'ab/revert/a'), tip)
  assert.equal((await abStatus({ targetRoot: root, slug: 'revert' })).variants[0].commits, 2)
  await git(root, 'reset', '-q', '--hard', 'HEAD~1')
  const adopted = await abPick({ targetRoot: root, slug: 'revert', variant: 'a' })
  assert.equal(await git(root, 'rev-parse', 'HEAD^1'), origin); assert.equal(adopted.merged, await git(root, 'rev-parse', 'HEAD'))
  assert.equal(await git(root, 'diff', '--name-only', 'HEAD^1', 'HEAD'), 'app.js')
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'module.exports = "first"\n')
  assert.equal(await exists(path.join(root, 'fixtures.json')), false)
})

test('a scaffold that does not finish creates no variants; stop --remove cleans its branch and discards a thrown session\'s mock work', async (t) => {
  const { root, temporary } = await project(t, 'stuck', 'thrown')
  const scaffoldPrompt = path.join(temporary, 'scaffold.md'); await writeFile(scaffoldPrompt, 'Screen: /profile.')
  const blocked = async () => ({ outcome: 'blocked', summary: 'needs a real service', view: '', path: '' })
  const started = await abStart({ targetRoot: root, slug: 'stuck', variants: 2, basePort: 4871, scaffoldPrompt }, { inspect: providers, flags: noFlags, execute: blocked })
  assert.equal(started.ok, false); assert.equal(started.scaffoldRun.summary, 'needs a real service'); assert.equal(started.variants, undefined)
  assert.equal((await abStatus({ targetRoot: root, slug: 'stuck' })).variants.length, 0)
  const stopped = await abStop({ targetRoot: root, slug: 'stuck', remove: true })
  assert.deepEqual(stopped.branches, []); assert.equal(stopped.note, undefined)
  assert.equal(await git(root, 'branch', '--list', 'ab/stuck/*'), '')
  assert.equal((await git(root, 'worktree', 'list')).includes('ab-stuck-base'), false)
  // A session that dies mid-edit leaves its worktree dirty: that mock work is thrown away, not guarded.
  const crash = async ({ job }) => { await writeFile(path.join(job.workspace, 'fixtures.json'), '{}\n'); throw new Error('provider crashed') }
  await assert.rejects(abStart({ targetRoot: root, slug: 'thrown', variants: 2, basePort: 4871, scaffoldPrompt }, { inspect: providers, flags: noFlags, execute: crash }), /provider crashed/)
  const dropped = await abStop({ targetRoot: root, slug: 'thrown', remove: true })
  assert.match(dropped.note, /scaffold/); assert.equal((await git(root, 'worktree', 'list')).includes('ab-thrown-base'), false)
  assert.equal(await git(root, 'branch', '--list', 'ab/thrown/*'), '')
})

test('records from before shared prompts keep working: plain prompt, follow-up without a stored approach or a new note', async (t) => {
  const { root, temporary } = await project(t, 'old')
  const started = await abStart({ targetRoot: root, slug: 'old', variants: 2, basePort: 4891 })
  const promptFile = path.join(temporary, 'a.md'); await writeFile(promptFile, 'Make it plain.')
  const seen = []
  const run = await abRun({ targetRoot: root, slug: 'old', variant: 'a', promptFile }, { inspect: providers, flags: noFlags, execute: capture(seen, session('plain')) })
  assert.equal(seen[0].prompt, `Variant a of old. $PORT for this variant: ${started.variants[0].port}.\n\nMake it plain.`)
  const recordFile = path.join(path.dirname(run.log), '..', 'old.json')
  const record = JSON.parse(await readFile(recordFile, 'utf8'))
  delete record.variants.a.approach
  await writeFile(recordFile, JSON.stringify(record))
  // A note older than the last run was already answered by it: the follow-up leaves it out.
  await writeFile(path.join(path.dirname(run.log), 'feedback.json'), JSON.stringify({ notes: { a: { note: 'stale', at: '2000-01-01T00:00:00.000Z' } }, chosen: null }))
  const followUpFile = path.join(temporary, 'f.md'); await writeFile(followUpFile, 'Tighten spacing.')
  await abRun({ targetRoot: root, slug: 'old', variant: 'a', followUpFile }, { inspect: providers, flags: noFlags, execute: capture(seen, session('plain2')) })
  assert.equal(seen[1].prompt, `Variant a of old. $PORT for this variant: ${started.variants[0].port}.\n\nYour last run's summary: plain variant\n\nYour branch already contains this work; change only what is asked.\n\nFollow-up request:\nTighten spacing.`)
  assert.equal((await abStatus({ targetRoot: root, slug: 'old' })).variants[0].commits, 2)
})

test('pick logs the adoption on top of a STATE log kept to 20 lines, and writes nothing without spec/', async (t) => {
  const { root, temporary } = await project(t, 'logged', 'bare')
  const state = await readFile(path.join(root, 'spec/STATE.md'), 'utf8')
  const old = Array.from({ length: 20 }, (_, index) => `- 2601${String(index + 10).padStart(2, '0')} entry ${index}`)
  await writeFile(path.join(root, 'spec/STATE.md'), `${state.trimEnd()}\n${old.join('\n')}\n`); await git(root, 'commit', '-q', '-am', 'full log')
  const promptFile = path.join(temporary, 'a.md'); await writeFile(promptFile, '# Cards first\n\nThree columns, price on top.')
  for (const slug of ['logged', 'bare']) {
    await abStart({ targetRoot: root, slug, variants: 2, basePort: 4991 })
    await abRun({ targetRoot: root, slug, variant: 'a', promptFile }, { inspect: providers, flags: noFlags, execute: session(slug) })
    if (slug === 'bare') { await git(root, 'rm', '-q', '-r', 'spec'); await git(root, 'commit', '-q', '-m', 'no spec') }
    // An English --approach wins over the stored one and is cut to about 100 characters.
    const adopted = await abPick({ targetRoot: root, slug, variant: 'a', ...(slug === 'logged' ? { approach: `Cards first, ${'very '.repeat(30)}clear` } : {}) })
    if (slug === 'bare') {
      assert.deepEqual([adopted.logLine, adopted.files], [null, []]); assert.equal(await exists(path.join(root, 'spec/STATE.md')), false)
      assert.equal(await git(root, 'status', '--porcelain'), '')
      continue
    }
    const approach = adopted.logLine.split(' — ')[1]
    assert.match(adopted.logLine, /^- \d{6} ab logged: adopt a — Cards first, very /); assert.equal(approach.length, 100); assert.ok(approach.endsWith('…'))
    const log = (await readFile(path.join(root, 'spec/STATE.md'), 'utf8')).split('## log\n')[1].trimEnd().split('\n')
    assert.deepEqual(log, [adopted.logLine, ...old.slice(0, 19)])
    await git(root, 'commit', '-q', '-am', 'log adoption')
  }
})

test('the detached hub reports its port, answers on localhost and exits once its comparison is gone', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gusta-ab-hub-'))
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
  assert.deepEqual(await Promise.all(served.variants.map(async ({ url }) => (await fetch(url)).text())), ['six', 'six'])
  const page = await (await fetch(served.hub)).text()
  for (const { url } of served.variants) assert.ok(page.includes(`<iframe src="${url}"`), url)
  assert.deepEqual((await abStatus({ targetRoot: root, slug: 'six' })).variants.map(({ url }) => url), served.variants.map(({ url }) => url))
  const restarted = await abServe({ targetRoot: root, slug: 'six', command: `node -e "require('http').createServer((q,s)=>s.end('four')).listen(process.env.PORT,'127.0.0.1')"`, restart: true, readyTimeoutMs: 20000 })
  assert.equal(restarted.ok, true, JSON.stringify(restarted))
  for (const { url } of restarted.variants) assert.match(url, /^http:\/\/localhost:/)
  assert.deepEqual(await Promise.all(restarted.variants.map(async ({ url }) => (await fetch(url)).text())), ['four', 'four'])
})
