import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git } from './helpers/vibe-fixture.mjs'
import { abStart, abRun, abServe, abExec, abStatus, abPick, abStop } from '../src/vibe-ab.mjs'

const exists = (file) => access(file).then(() => true, () => false)
const providers = async () => ({ autoProvider: 'claude', providers: [{ provider: 'claude', compatible: true }] })
// A fake variant session: edits only its own worktree and reports what to look at.
const session = (text) => async ({ job }) => {
  await writeFile(path.join(job.workspace, 'app.js'), `module.exports = ${JSON.stringify(text)}\n`)
  return { outcome: 'completed', summary: `${text} variant`, view: '/', usage: { input_tokens: 1, output_tokens: 2 } }
}
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
  for (const [variant, text] of [['a', 'alpha'], ['b', 'beta']]) {
    const promptFile = path.join(temporary, `${variant}.md`); await writeFile(promptFile, `Make it ${text}.`)
    let job
    const run = await abRun({ targetRoot: root, slug: 'hero', variant, promptFile }, { inspect: providers, execute: async (input) => { job = input.job; return session(text)(input) } })
    assert.equal(run.ok, true); assert.equal(run.changed, true); assert.equal(job.role, 'variant'); assert.match(job.prompt, /Make it/)
    assert.equal(await git(root, 'log', '-1', '--format=%s', `ab/hero/${variant}`), `ab hero/${variant}: ${text} variant`)
  }
  assert.equal(await git(root, 'rev-parse', 'HEAD'), await git(root, 'rev-parse', 'main'))
  assert.equal(await git(root, 'status', '--porcelain'), '')
  const served = await abServe({ targetRoot: root, slug: 'hero', command: SERVER, readyTimeoutMs: 20000 })
  assert.equal(served.ok, true, JSON.stringify(served))
  const bodies = await Promise.all(served.variants.map(async (entry) => (await fetch(entry.url)).text()))
  assert.deepEqual(bodies, ['alpha', 'beta'])
  const status = await abStatus({ targetRoot: root, slug: 'hero' })
  assert.deepEqual(status.variants.map((entry) => [entry.serving, entry.commits]), [[true, 1], [true, 1]])
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
  await new Promise((resolve) => setTimeout(resolve, 300))
  await assert.rejects(fetch(served.variants[0].url))
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
  const { root } = await fixture(t)
  await abStart({ targetRoot: root, slug: 'crash', variants: 2, basePort: 4791 })
  t.after(() => abStop({ targetRoot: root, slug: 'crash', remove: true }).catch(() => {}))
  const served = await abServe({ targetRoot: root, slug: 'crash', command: 'node -e "console.error(\'boom\'); process.exit(3)"', readyTimeoutMs: 5000 })
  assert.equal(served.ok, false)
  assert.ok(served.variants.every((entry) => !entry.ready && entry.exited && entry.tail.includes('boom')))
})
