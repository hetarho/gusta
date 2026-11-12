import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { assembleBrief, commitSource, renderBrief, specBrief } from '../src/spec-context.mjs'
import { decisionBlocks, parseSsot, references } from '../src/spec-format.mjs'
import { vibeBrief } from '../src/vibe-brief.mjs'
import { lintSpec } from '../src/spec-lint.mjs'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
const git = async (cwd, ...args) => (await execute('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim()

// AUTH-1 is cited by T001 and pulls a chain: requires AUTH-4 → requires SEC-2, canonical SEC-1
// (which requires AUTH-1 back: a cycle), related AUTH-6 (left out). AUTH-2 carries only legacy
// references: a `/` list, a `–` range, a whole domain, a bare mention, a rejected and a missing target.
const AUTH = `# AUTH authentication
> r3 | sign-in and sessions

## decisions
- AUTH-1 [o] password sign-in is the only sign-in method →!AUTH-4 →=SEC-1 →~AUTH-6
- AUTH-2 [o] session cookie lifetime 30 d, sliding (→PAY-1/2, →PAY-3–4, →PAY) shares PAY-5 storage, replaces →AUTH-3
  - renewal only on a request with a valid session
- AUTH-3 [x] magic-link sign-in
- AUTH-4 [o] rate limit per account ← abuse without blocking shared offices →!SEC-2
  - login 5/min, password reset 3/hour
  - over limit ⇒ 429 + retry-after, never a silent drop

| tier | limit |
|---|---|
| staff | 20/min |
- AUTH-6 [o] sign-in screen copy lives with the web pages
- AUTH-7 [?] second factor for staff accounts
- AUTH-8 [o] lockout follows a dangling legacy reference →AUTH-99

## flow
- sign-in: form → verify(ok|fail) → session

## constraints
- passwords are never logged, not even hashed

## chg
- r3 261010 AUTH-4✎ login limit 10/min→5/min
- r2 261005 AUTH-2✎ lifetime 14 d→30 d
- r1 261001 initial
`

const SEC = `# SEC security
> r1 | secrets and abuse

## decisions
- SEC-1 [o] passwords are hashed with argon2id and must never be stored raw →!AUTH-1
- SEC-2 [o] every 429 response carries retry-after in seconds
- SEC-3 [o] API keys rotate every 90 days →!SEC-99

## chg
- r1 261001 initial
`

const PAY = `# PAY payments
> r1 | billing

## decisions
- PAY-1 [o] refunds within 14 days only →PAY-6
- PAY-2 [o] invoices are immutable once sent
- PAY-3 [o] currency is KRW
- PAY-4 [o] prices include VAT
- PAY-5 [o] payment tokens live in the vault
- PAY-6 [o] refund approvals need a second operator

## chg
- r1 261001 initial
`

const ARCH = `# ARCH architecture
> r1 | stack

## decisions
- ARCH-1 [o] runtime: node 20 LTS only
- ARCH-2 [o] tests: \`node --test\`, every task adds one
- ARCH-3 [x] runtime: deno

## chg
- r1 261001 initial
`

const task = (id, ssot, base, extra = '') => `# ${id} example
> st:todo | ssot:${ssot} | base:${base} | dep:-

## goal
implement ${id}

## acceptance
- [ ] works${extra}

## impl notes
- -

## result
`

// Most tests pin the precise scope (cfg brief: cited); the default (domain) has its own test.
const STATE = (cfg = '- brief: cited\n') => `# STATE

## cfg
- level: expert
- lang: ko
- docs: en
- push: -
${cfg}
## ssot
| id | rev | tasked | pending | [?] |
|---|---|---|---|---|
| ARCH | 1 | 1 | - | 0 |
| AUTH | 3 | 3 | - | 1 |
| PAY | 1 | 1 | - | 0 |
| SEC | 1 | 1 | - | 0 |

## inbox
- 261011 decided AUTH-4 T001: limit per account → per account (alt: per IP)
- 261011 parked PAY-6: approval flow needs the owner

## tasks
| id | title | ssot | dep | st |
|---|---|---|---|---|
| T001 | example | AUTH | - | todo |
| T002 | example | AUTH | - | todo |
| T003 | example | AUTH | - | todo |
| T004 | example | AUTH | - | todo |

## next
- gusta-implement-task T001

## log
`

async function project(t, { cfg, files = {} } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'gusta-brief-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'project')
  const write = async (relative, content) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    await writeFile(path.join(root, relative), content)
  }
  await mkdir(root)
  await git(root, 'init', '-q', '-b', 'main')
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) await git(root, 'config', key, value)
  await write('spec/FORMAT.md', await readFile(new URL('../skills/gusta-create-architecture/assets/FORMAT.md', import.meta.url), 'utf8'))
  await write('spec/STATE.md', STATE(cfg))
  for (const [id, text] of Object.entries({ ARCH, AUTH, PAY, SEC })) await write(`spec/ssot/${id}.md`, text)
  await write('spec/tasks/T001.example.md', task('T001', 'AUTH-1', 'AUTH@3'))
  await write('spec/tasks/T002.example.md', task('T002', 'AUTH-2', 'AUTH@3'))
  await write('spec/tasks/T003.example.md', task('T003', 'AUTH-3 AUTH-7', 'AUTH@3'))
  await write('spec/tasks/T004.example.md', task('T004', 'AUTH-4', 'AUTH@1', '\n- [ ] keeps SEC-2 headers'))
  await mkdir(path.join(root, 'spec/tasks/done'), { recursive: true })
  for (const [relative, content] of Object.entries(files)) await write(relative, content)
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '-m', 'spec')
  return root
}

const brief = (root, roots, extra = {}) => specBrief({ targetRoot: root, roots, ...extra })
const ids = (result) => result.decisions.map((entry) => entry.id)
const via = (result, id) => result.decisions.find((entry) => entry.id === id)?.via.map((entry) => `${entry.kind}:${entry.from}`)

test('references: arrow kinds, / lists, – ranges, whole domains and bare mentions; code spans are skipped', () => {
  const found = references('a →!AUTH-1 b →=SEC-2/3 c →~PAY-4 d →PAY-5–7 e →PAY f PAY-9 g `→!AUTH-8` h UTF-8')
  assert.deepEqual(found.map((ref) => `${ref.kind}:${ref.domain}-${ref.number}${ref.mention ? '*' : ''}`), [
    'requires:AUTH-1', 'canonical:SEC-2', 'canonical:SEC-3', 'related:PAY-4', 'unclassified:PAY-5', 'unclassified:PAY-6', 'unclassified:PAY-7',
    'unclassified:PAY-null', 'unclassified:PAY-9*', 'unclassified:UTF-8*',
  ])
})

test('decision blocks keep every line up to the next decision: sub-lines, blank lines and unindented tables', () => {
  const block = decisionBlocks(AUTH).get('AUTH-4')
  assert.equal(block, AUTH.slice(AUTH.indexOf('- AUTH-4'), AUTH.indexOf('- AUTH-6')).trimEnd())
  for (const needle of ['5/min', '3/hour', '429', 'retry-after', 'never a silent drop', '| staff | 20/min |', '← abuse']) assert.ok(block.includes(needle), needle)
  const doc = parseSsot(AUTH)
  assert.deepEqual([doc.decisions.get('AUTH-4').start, doc.decisions.get('AUTH-4').end], [9, 15])
  assert.equal(doc.rev, 3)
})

test('a cited decision pulls its requires and canonical chain, transitively and once, and leaves related out', async (t) => {
  const root = await project(t)
  const result = await brief(root, ['T001'])
  assert.equal(result.complete, true, JSON.stringify(result.issues))
  assert.deepEqual(ids(result), ['AUTH-1', 'ARCH-1', 'ARCH-2', 'AUTH-4', 'SEC-1', 'SEC-2'])
  assert.deepEqual(via(result, 'AUTH-1'), ['cited:T001', 'requires:SEC-1'])
  assert.deepEqual(via(result, 'AUTH-4'), ['requires:AUTH-1'])
  assert.deepEqual(via(result, 'SEC-1'), ['canonical:AUTH-1', 'referrer:AUTH-1'])
  assert.deepEqual(via(result, 'SEC-2'), ['requires:AUTH-4'])
  assert.deepEqual(result.refs.related, [{ id: 'AUTH-6', from: ['AUTH-1'] }])
  // the global default carries ARCH but never its rejected decision as a rule
  assert.deepEqual(result.refs.rejected, [{ id: 'ARCH-3', from: ['cfg'] }])
  assert.deepEqual(result.always, { source: 'default', ids: ['ARCH'] })
})

test('policy questions answered from the brief alone: conditions, exceptions, numbers, units, negations, obligations', async (t) => {
  const root = await project(t)
  const text = renderBrief(await brief(root, ['T001']))
  // Each question lists the evidence the full SSOT gives; the brief must carry all of it.
  const questions = {
    'over the login limit, may a request be dropped silently?': ['over limit ⇒ 429 + retry-after, never a silent drop'],
    'what are the exact limits and their units?': ['login 5/min, password reset 3/hour', '| staff | 20/min |'],
    'what must a 429 response carry?': ['every 429 response carries retry-after in seconds'],
    'may a password be stored or logged raw?': ['must never be stored raw', 'passwords are never logged, not even hashed'],
    'is any other sign-in method allowed?': ['password sign-in is the only sign-in method'],
    'which runtime versions are allowed?': ['node 20 LTS only'],
  }
  for (const [question, evidence] of Object.entries(questions)) for (const line of evidence) assert.ok(text.includes(line), `${question} — missing: ${line}`)
  // The pre-0.7 brief (cited blocks only) could not answer most of them.
  const old = decisionBlocks(AUTH).get('AUTH-1')
  assert.equal(Object.values(questions).flat().filter((line) => old.includes(line)).length, 1)
})

test('flow and constraints of every domain the brief draws from are included whole', async (t) => {
  const root = await project(t)
  const result = await brief(root, ['T001'])
  assert.deepEqual(result.sections.map((entry) => `${entry.domain} ${entry.name}`), ['AUTH flow', 'AUTH constraints'])
  assert.equal(result.sections[1].text, '- passwords are never logged, not even hashed')
  assert.deepEqual(result.sections[1].lines, [24, 24])
})

test('legacy references: one hop from the cited block, then listed as unfollowed; rejected and missing are reported', async (t) => {
  const root = await project(t)
  const result = await brief(root, ['T002'])
  assert.deepEqual(ids(result), ['AUTH-2', 'ARCH-1', 'ARCH-2', 'PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5'])
  assert.deepEqual(via(result, 'PAY-5'), ['unclassified:AUTH-2'])
  // PAY-6 is a second unclassified hop, the whole PAY domain a domain reference: listed, not pulled in
  assert.deepEqual(result.refs.unfollowed, [{ id: 'PAY', from: ['AUTH-2'] }, { id: 'PAY-6', from: ['PAY-1'] }])
  assert.deepEqual(result.refs.rejected.find((entry) => entry.id === 'AUTH-3'), { id: 'AUTH-3', from: ['AUTH-2'] })
  assert.equal(result.complete, true)

  const deep = await brief(root, ['T002'], { deep: true })
  assert.ok(ids(deep).includes('PAY-6'))
  assert.deepEqual(deep.refs.unfollowed, [])

  const dangling = await brief(root, ['AUTH-8'])
  assert.equal(dangling.complete, false)
  assert.deepEqual(dangling.issues.map((entry) => entry.code), ['missing-ref'])
})

test('a missing required target makes the brief incomplete instead of shrinking it', async (t) => {
  const root = await project(t)
  const result = await brief(root, ['SEC-3'])
  assert.equal(result.complete, false)
  assert.equal(result.issues[0].code, 'missing-decision')
  assert.match(result.issues[0].message, /SEC-99/)
  const text = renderBrief(result)
  assert.match(text, /complete:no/)
  assert.match(text, /- error missing-decision: /)
})

test('rejected and open decisions keep their status and are flagged, never served as rules', async (t) => {
  const root = await project(t)
  const result = await brief(root, ['T003'])
  assert.deepEqual(result.decisions.slice(0, 2).map((entry) => [entry.id, entry.status]), [['AUTH-3', 'rejected'], ['AUTH-7', 'open']])
  assert.deepEqual(result.issues.map((entry) => entry.code), ['rejected-decision', 'open-decision'])
  assert.ok(result.decisions[0].text.startsWith('- AUTH-3 [x]'))
  assert.equal(result.complete, true)
})

test('a stale base brings the chg lines since that rev; <ID>@rev asks for them directly with the changed decisions', async (t) => {
  const root = await project(t)
  const result = await brief(root, ['T004'])
  assert.deepEqual(result.history, [{ domain: 'AUTH', from: 1, to: 3, lines: ['- r3 261010 AUTH-4✎ login limit 10/min→5/min', '- r2 261005 AUTH-2✎ lifetime 14 d→30 d'], missing: [] }])
  assert.deepEqual(result.refs.changed, [{ id: 'AUTH-2', from: ['AUTH@1'] }])
  assert.deepEqual(result.issues.map((entry) => entry.code), ['stale-base'])
  assert.ok(ids(result).includes('SEC-2')) // named in the task body: one hop
  assert.deepEqual(via(result, 'SEC-2'), ['requires:AUTH-4', 'mention:T004'])

  const since = await brief(root, ['AUTH@2'])
  assert.deepEqual(since.history[0].lines, ['- r3 261010 AUTH-4✎ login limit 10/min→5/min'])
  assert.deepEqual(ids(since), ['AUTH-4', 'SEC-2'])
  assert.equal(since.always, null)
})

test('a gap in chg makes a history request incomplete', async (t) => {
  const root = await project(t, { files: { 'spec/ssot/AUTH.md': AUTH.replace('- r2 261005 AUTH-2✎ lifetime 14 d→30 d\n', '') } })
  const result = await brief(root, ['T004'])
  assert.equal(result.complete, false)
  assert.deepEqual(result.history[0].missing, [2])
  assert.ok(result.issues.some((entry) => entry.code === 'history-gap'))
})

test('cfg always names the global rules; - means none; an unknown entry is an error', async (t) => {
  const narrow = await project(t, { cfg: '- brief: cited\n- always: ARCH-2  # global rules\n' })
  assert.deepEqual(ids(await brief(narrow, ['T001'])), ['AUTH-1', 'ARCH-2', 'AUTH-4', 'SEC-1', 'SEC-2'])
  const none = await project(t, { cfg: '- brief: cited\n- always: -\n' })
  assert.deepEqual(ids(await brief(none, ['T001'])).filter((id) => id.startsWith('ARCH')), [])
  const unknown = await project(t, { cfg: '- brief: cited\n- always: ARCH-9\n' })
  const result = await brief(unknown, ['T001'])
  assert.equal(result.complete, false)
  assert.ok(result.issues.some((entry) => entry.code === 'always-unknown'))
  assert.ok((await lintSpec({ targetRoot: unknown })).errors.some((error) => error.includes('cfg always의 ARCH-9')))
})

test('the working tree and a fixed commit are separate sources, never mixed', async (t) => {
  const root = await project(t)
  const head = await git(root, 'rev-parse', 'HEAD')
  await writeFile(path.join(root, 'spec/ssot/SEC.md'), SEC.replace('in seconds', 'in milliseconds'))
  await writeFile(path.join(root, 'spec/tasks/T001.example.md'), task('T001', 'AUTH-1', 'AUTH@3', '\n- [ ] new check'))
  const tree = await brief(root, ['T001'])
  assert.deepEqual([tree.source.kind, tree.source.head, tree.source.dirty], ['worktree', head, ['spec/ssot/SEC.md', 'spec/tasks/T001.example.md']])
  assert.match(tree.decisions.find((entry) => entry.id === 'SEC-2').text, /milliseconds/)
  assert.match(tree.tasks[0].content, /new check/)
  const fixed = await brief(root, ['T001'], { ref: 'HEAD' })
  assert.deepEqual([fixed.source.kind, fixed.source.commit, fixed.source.dirty], ['commit', head, []])
  assert.match(fixed.decisions.find((entry) => entry.id === 'SEC-2').text, /in seconds/)
  assert.doesNotMatch(fixed.tasks[0].content, /new check/)
  assert.notEqual(tree.domains.find((entry) => entry.id === 'SEC').sha256, fixed.domains.find((entry) => entry.id === 'SEC').sha256)
})

test('provenance and order are deterministic: path, rev, hashes, line ranges', async (t) => {
  const root = await project(t)
  const first = await brief(root, ['T001', 'T002'])
  const second = await brief(root, ['T001', 'T002'])
  assert.equal(renderBrief(first), renderBrief(second))
  const auth = first.domains.find((entry) => entry.id === 'AUTH')
  assert.deepEqual([auth.path, auth.rev, auth.sha256.length], ['spec/ssot/AUTH.md', 3, 64])
  const block = first.decisions.find((entry) => entry.id === 'AUTH-4')
  assert.deepEqual([block.path, block.lines, block.sha256.length], ['spec/ssot/AUTH.md', [9, 15], 64])
  // cited first in citation order, then by domain and number; a decision is never repeated
  assert.deepEqual(ids(first).slice(0, 2), ['AUTH-1', 'AUTH-2'])
  assert.equal(new Set(ids(first)).size, ids(first).length)
  assert.deepEqual(first.inbox, ['- 261011 decided AUTH-4 T001: limit per account → per account (alt: per IP)'])
})

test('a top-level bullet that is not a decision stays with the decision above it and is reported', async (t) => {
  const root = await project(t, { files: { 'spec/ssot/SEC.md': SEC.replace('- SEC-2 [o]', '- also applies to service accounts\n- SEC-2 [o]') } })
  const result = await brief(root, ['SEC-1'])
  assert.match(result.decisions[0].text, /also applies to service accounts/)
  assert.ok(result.issues.some((entry) => entry.code === 'malformed-line'))
  assert.equal(result.complete, false)
})

test('vibe brief CLI prints markdown ending in an end line, JSON on --json, and keeps the single-task fields', async (t) => {
  const root = await project(t)
  const { stdout } = await execute(process.execPath, [cli, 'vibe', 'brief', 'T001', '--target', root])
  assert.match(stdout, /^# BRIEF T001\n> source:worktree head:[0-9a-f]{12} \| complete:yes/)
  assert.match(stdout, /\nend T001 sha256:[0-9a-f]{12} chars:\d+\n$/)
  assert.ok(stdout.indexOf('- AUTH-4 [o]') < stdout.indexOf('## why'))
  const json = JSON.parse((await execute(process.execPath, [cli, 'vibe', 'brief', 'T001', '--target', root, '--json'])).stdout)
  assert.equal(json.taskId, 'T001')
  assert.deepEqual(json.freshness, [{ domain: 'AUTH', base: 3, current: 3, stale: false }])
  const several = await execute(process.execPath, [cli, 'vibe', 'brief', 'AUTH-4', 'PAY@0', '--target', root, '--ref', 'HEAD'])
  assert.match(several.stdout, /^# BRIEF AUTH-4 PAY@0\n> source:commit:/)
  await assert.rejects(execute(process.execPath, [cli, 'vibe', 'brief', 'SEC-3', '--target', root]), (error) => error.code === 1 && /complete:no/.test(error.stdout))
})

test('vibe brief for one task keeps the task-start diff base and reads ARCH tiers from the same source', async (t) => {
  const root = await project(t)
  const head = await git(root, 'rev-parse', 'HEAD')
  const result = await vibeBrief({ targetRoot: root, task: 'T004' })
  assert.equal(result.diffBase, head)
  assert.deepEqual(result.freshness, [{ domain: 'AUTH', base: 1, current: 3, stale: true }])
  assert.equal(result.history.length, 1)
  assert.equal(result.task.id, 'T004')
  assert.equal(result.tasks.length, 1)
})

test('a commit source reads the same blocks as git show', async (t) => {
  const root = await project(t)
  const head = await git(root, 'rev-parse', 'HEAD')
  const result = await assembleBrief({ source: commitSource(root, head), roots: ['SEC-1'] })
  assert.equal(result.decisions[0].text, decisionBlocks(await git(root, 'show', `${head}:spec/ssot/SEC.md`)).get('SEC-1'))
  assert.deepEqual(result.referrers, [{ id: 'SEC-1', decisions: [{ id: 'AUTH-1', kind: 'canonical' }], tasks: [] }])
})

test('default scope (no cfg brief) carries the current rules of every cited domain whole, without chg', async (t) => {
  const root = await project(t, { cfg: '' })
  const result = await brief(root, ['T001'])
  assert.deepEqual(result.scope, { value: 'domain', source: 'default' })
  assert.deepEqual(ids(result), ['AUTH-1', 'ARCH-1', 'ARCH-2', 'AUTH-2', 'AUTH-4', 'AUTH-6', 'AUTH-7', 'AUTH-8', 'SEC-1', 'SEC-2'])
  assert.deepEqual(via(result, 'AUTH-7'), ['domain:T001'])
  assert.deepEqual(result.refs.rejected.map((entry) => entry.id), ['ARCH-3', 'AUTH-3'])
  const text = renderBrief(result)
  assert.match(text, /scope:domain \(default\)/)
  assert.doesNotMatch(text, /- r2 261005/) // history stays out unless a base is stale
  // a domain block hops nowhere: AUTH-2's legacy references stay listed, not pulled in
  assert.ok(!ids(result).some((id) => id.startsWith('PAY-')))
  assert.ok(result.refs.unfollowed.some((entry) => entry.id === 'PAY-1'))
})

test('a decision that points at a cited one applies it elsewhere, so it is carried as a referrer', async (t) => {
  const root = await project(t)
  const result = await brief(root, ['T004'])
  // AUTH-1 is in as a referrer; its canonical owner SEC-1 comes with it and requires AUTH-1 back
  assert.deepEqual(via(result, 'AUTH-1'), ['requires:SEC-1', 'referrer:AUTH-4'])
  assert.ok(ids(result).includes('SEC-1'))
})

test('an unknown cfg brief scope falls back to domain and makes the brief incomplete', async (t) => {
  const root = await project(t, { cfg: '- brief: blocks\n' })
  const result = await brief(root, ['T001'])
  assert.equal(result.scope.value, 'domain')
  assert.equal(result.complete, false)
  assert.ok(result.issues.some((entry) => entry.code === 'bad-scope'))
  assert.ok((await lintSpec({ targetRoot: root })).errors.some((error) => error.includes('cfg brief')))
})
