import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fixture, git } from './helpers/vibe-fixture.mjs'
import { abStart, abRun, abServe, abExec, abStatus, abPick, abStop } from '../src/vibe-ab.mjs'
import { renderHub, viewPath, createHub, readFeedback } from '../src/vibe-ab-hub.mjs'

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

test('variants get their own branch, worktree, port and host-made commit, then serve side by side', async (t) => {
  const { root, temporary } = await fixture(t)
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
  t.after(() => abStop({ targetRoot: root, slug: 'hero' }).catch(() => {}))
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

test('a server that never listens is reported with its log tail instead of a URL claim', async (t) => {
  const { root } = await fixture(t)
  await abStart({ targetRoot: root, slug: 'crash', variants: 2, basePort: 4791 })
  t.after(() => abStop({ targetRoot: root, slug: 'crash', remove: true }).catch(() => {}))
  const served = await abServe({ targetRoot: root, slug: 'crash', command: 'node -e "console.error(\'boom\'); process.exit(3)"', readyTimeoutMs: 5000 })
  assert.equal(served.ok, false)
  assert.ok(served.variants.every((entry) => !entry.ready && entry.exited && entry.tail.includes('boom')))
  await abStop({ targetRoot: root, slug: 'crash' })
})

// /broken answers 500 (and logs why), /private redirects to sign-in, anything else answers its pid.
const PROBED = `node -e "require('http').createServer((q,s)=>{if(q.url==='/broken'){console.error('render failed');s.statusCode=500;return s.end('boom')}if(q.url==='/private'){s.writeHead(302,{location:'/login'});return s.end()}s.end(String(process.pid))}).listen(process.env.PORT)"`

test('serve is ready only when the view answers, keeps a live server unless --restart, and stop closes the hub', async (t) => {
  const { root, temporary } = await fixture(t)
  await abStart({ targetRoot: root, slug: 'probe', variants: 2, basePort: 4811 })
  t.after(() => abStop({ targetRoot: root, slug: 'probe', remove: true }).catch(() => {}))
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
  assert.match(html, /target="_blank"/); assert.match(html, /data-width="390"/); assert.match(html, /not serving/)
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
  const page = await (await fetch(hub)).text()
  assert.match(page, /<iframe src="http:\/\/localhost:4101\/home"/); assert.match(page, />bigger<\/textarea>/)
  await rm(recordFile)
  assert.equal((await fetch(hub)).status, 410)
})

// A fake scaffold session: fixtures in a new file, wired into the existing data module.
const scaffolding = async ({ job, log }) => {
  log('{"type":"system","scaffold":true}\n')
  await writeFile(path.join(job.workspace, 'fixtures.json'), '{"user":"Ada"}\n')
  await writeFile(path.join(job.workspace, 'data.js'), "module.exports = require('./fixtures.json')\n")
  return { outcome: 'completed', summary: 'fixtures for the profile screen', view: 'profile', path: '/profile', usage: { input_tokens: 1, output_tokens: 1 } }
}
const capture = (jobs, fake) => async (input) => { jobs.push(input.job); return fake(input) }

test('a scaffold session is the variants\' base, prompts share one prefix, follow-ups carry context, and pick drops the scaffold', async (t) => {
  const { root, temporary } = await fixture(t)
  await writeFile(path.join(root, 'data.js'), "module.exports = fetch('/api/user')\n"); await git(root, 'add', 'data.js'); await git(root, 'commit', '-q', '-m', 'data')
  const origin = await git(root, 'rev-parse', 'HEAD')
  const sharedFile = path.join(temporary, 'shared.md'), scaffoldPrompt = path.join(temporary, 'scaffold.md')
  await writeFile(sharedFile, 'Goal: a clearer profile screen. Keep ARCH-1.'); await writeFile(scaffoldPrompt, 'Screen: /profile needs a signed-in user.')
  const jobs = []
  const started = await abStart({ targetRoot: root, slug: 'mock', variants: 2, basePort: 4831, sharedFile, scaffoldPrompt }, { inspect: providers, execute: capture(jobs, scaffolding) })
  t.after(() => abStop({ targetRoot: root, slug: 'mock', remove: true }).catch(() => {}))
  // The shared file is copied into the record: the coordinator's temporary folder may go.
  await rm(sharedFile)
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal(jobs.length, 1); assert.equal(jobs[0].role, 'scaffold'); assert.match(jobs[0].prompt, /clearer profile/); assert.match(jobs[0].prompt, /signed-in user/)
  const scaffold = await git(root, 'rev-parse', 'ab/mock/base')
  assert.deepEqual([started.origin, started.scaffold, started.base], [origin, scaffold, scaffold])
  assert.equal(await git(root, 'rev-parse', `${scaffold}^`), origin)
  assert.deepEqual(started.scaffoldFiles, ['data.js', 'fixtures.json']); assert.equal(started.scaffoldRun.path, '/profile')
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
    runs[variant] = await abRun({ targetRoot: root, slug: 'mock', variant, promptFile: await promptFile(`${variant}.md`, `Approach: make it ${text}.`) }, { inspect: providers, execute: capture(seen, session(text)) })
    prompts[variant] = seen[0].prompt
  }
  // Everything before the variant line is identical: shared text and the scaffold's read-only files.
  const prefix = (variant) => prompts[variant].slice(0, prompts[variant].indexOf(`Variant ${variant} of mock`))
  assert.equal(prefix('a'), prefix('b')); assert.match(prefix('a'), /clearer profile/); assert.match(prefix('a'), /read-only.*data\.js, fixtures\.json/)
  assert.match(prompts.a, /\$PORT for this variant: \d+\.\n\nApproach: make it alpha\.$/)
  // A follow-up repeats the first prompt, then adds the last summary, the hub note and the request.
  await writeFile(path.join(path.dirname(runs.a.log), 'feedback.json'), JSON.stringify({ notes: { a: { note: 'bigger title', at: 'T' } }, chosen: null }))
  const seen = []
  const followed = await abRun({ targetRoot: root, slug: 'mock', variant: 'a', followUpFile: await promptFile('follow.md', 'Make the title bigger.') }, { inspect: providers, execute: capture(seen, session('alpha2')) })
  assert.equal(followed.followUp, true); assert.equal(followed.changed, true)
  const next = seen[0].prompt
  assert.ok(next.startsWith(prompts.a), 'follow-up keeps the first run prompt as its prefix')
  for (const part of [/Your last run's summary: alpha variant/, /note on this variant: bigger title/, /already contains this work/, /Make the title bigger\.$/]) assert.match(next, part)
  // Adoption replays a's commits onto the start base without the scaffold commit.
  const before = await git(root, 'rev-parse', 'HEAD')
  const adopted = await abPick({ targetRoot: root, slug: 'mock', variant: 'a' })
  assert.equal(await git(root, 'rev-parse', 'HEAD^1'), before)
  assert.equal(await git(root, 'diff', '--name-only', 'HEAD^1', 'HEAD'), 'app.js')
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'module.exports = "alpha2"\n')
  assert.equal(await readFile(path.join(root, 'data.js'), 'utf8'), "module.exports = fetch('/api/user')\n")
  assert.equal(await exists(path.join(root, 'fixtures.json')), false)
  assert.equal(adopted.scaffold, scaffold); assert.deepEqual(adopted.scaffoldFiles, ['data.js', 'fixtures.json']); assert.match(adopted.todo, /실제 데이터/)
  assert.equal(await git(root, 'branch', '--list', 'ab/mock/*'), '')
})

test('a reused --scaffold skips the session; a variant that edits a scaffold file is refused with both branches untouched', async (t) => {
  const { root, temporary } = await fixture(t)
  const origin = await git(root, 'rev-parse', 'HEAD')
  await git(root, 'checkout', '-q', '-b', 'mock-data')
  await writeFile(path.join(root, 'fixtures.json'), '{"user":"Ada"}\n'); await git(root, 'add', 'fixtures.json'); await git(root, 'commit', '-q', '-m', 'mock')
  const mock = await git(root, 'rev-parse', 'HEAD')
  await git(root, 'checkout', '-q', 'main')
  const never = async () => { throw new Error('no session for a reused scaffold') }
  await assert.rejects(abStart({ targetRoot: root, slug: 'reuse', scaffold: 'main' }, { inspect: never, execute: never }), /기준.*위의 커밋/)
  await assert.rejects(abStart({ targetRoot: root, slug: 'reuse', scaffold: 'mock-data', scaffoldPrompt: 'x' }), /하나만/)
  const started = await abStart({ targetRoot: root, slug: 'reuse', variants: 2, basePort: 4851, scaffold: 'mock-data' }, { inspect: never, execute: never })
  t.after(() => abStop({ targetRoot: root, slug: 'reuse', remove: true }).catch(() => {}))
  assert.deepEqual([started.origin, started.scaffold, started.base, started.scaffoldRun], [origin, mock, mock, undefined])
  assert.equal(await git(root, 'branch', '--list', 'ab/reuse/base'), '')
  const promptFile = path.join(temporary, 'a.md'); await writeFile(promptFile, 'Change the data.')
  const tamper = async ({ job }) => {
    await writeFile(path.join(job.workspace, 'fixtures.json'), '{"user":"Grace"}\n')
    await writeFile(path.join(job.workspace, 'app.js'), 'module.exports = 1\n')
    return { outcome: 'completed', summary: 'changed the fixtures', view: 'home', path: '' }
  }
  await abRun({ targetRoot: root, slug: 'reuse', variant: 'a', promptFile }, { inspect: providers, execute: tamper })
  const head = await git(root, 'rev-parse', 'HEAD'), tip = await git(root, 'rev-parse', 'ab/reuse/a')
  await assert.rejects(abPick({ targetRoot: root, slug: 'reuse', variant: 'a' }), (error) => /scaffold 파일/.test(error.message) && error.details.includes('fixtures.json'))
  assert.equal(await git(root, 'rev-parse', 'HEAD'), head); assert.equal(await git(root, 'status', '--porcelain'), '')
  assert.equal(await git(root, 'rev-parse', 'ab/reuse/a'), tip)
  assert.equal(await git(started.variants[0].path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'ab/reuse/a')
  // stop --remove prunes what the comparison made; the reused scaffold ref belongs to the caller.
  await abStop({ targetRoot: root, slug: 'reuse', remove: true })
  assert.equal(await git(root, 'branch', '--list', 'ab/reuse/*'), '')
  assert.equal(await git(root, 'rev-parse', 'mock-data'), mock)
})

test('a scaffold that does not finish creates no variants and stop --remove cleans its branch', async (t) => {
  const { root, temporary } = await fixture(t)
  const scaffoldPrompt = path.join(temporary, 'scaffold.md'); await writeFile(scaffoldPrompt, 'Screen: /profile.')
  const blocked = async () => ({ outcome: 'blocked', summary: 'needs a real service', view: '', path: '' })
  const started = await abStart({ targetRoot: root, slug: 'stuck', variants: 2, basePort: 4871, scaffoldPrompt }, { inspect: providers, execute: blocked })
  assert.equal(started.ok, false); assert.equal(started.scaffoldRun.summary, 'needs a real service'); assert.equal(started.variants, undefined)
  assert.equal((await abStatus({ targetRoot: root, slug: 'stuck' })).variants.length, 0)
  const stopped = await abStop({ targetRoot: root, slug: 'stuck', remove: true })
  assert.deepEqual(stopped.branches, [])
  assert.equal(await git(root, 'branch', '--list', 'ab/stuck/*'), '')
  assert.equal((await git(root, 'worktree', 'list')).includes('ab-stuck-base'), false)
})

test('records from before shared prompts keep working: plain prompt, follow-up without a stored approach', async (t) => {
  const { root, temporary } = await fixture(t)
  const started = await abStart({ targetRoot: root, slug: 'old', variants: 2, basePort: 4891 })
  t.after(() => abStop({ targetRoot: root, slug: 'old', remove: true }).catch(() => {}))
  const promptFile = path.join(temporary, 'a.md'); await writeFile(promptFile, 'Make it plain.')
  const seen = []
  const run = await abRun({ targetRoot: root, slug: 'old', variant: 'a', promptFile }, { inspect: providers, execute: capture(seen, session('plain')) })
  assert.equal(seen[0].prompt, `Variant a of old. $PORT for this variant: ${started.variants[0].port}.\n\nMake it plain.`)
  const recordFile = path.join(path.dirname(run.log), '..', 'old.json')
  const record = JSON.parse(await readFile(recordFile, 'utf8'))
  delete record.variants.a.approach
  await writeFile(recordFile, JSON.stringify(record))
  const followUpFile = path.join(temporary, 'f.md'); await writeFile(followUpFile, 'Tighten spacing.')
  await abRun({ targetRoot: root, slug: 'old', variant: 'a', followUpFile }, { inspect: providers, execute: capture(seen, session('plain2')) })
  assert.equal(seen[1].prompt, `Variant a of old. $PORT for this variant: ${started.variants[0].port}.\n\nYour last run's summary: plain variant\n\nYour branch already contains this work; change only what is asked.\n\nFollow-up request:\nTighten spacing.`)
  assert.equal((await abStatus({ targetRoot: root, slug: 'old' })).variants[0].commits, 2)
})
