import test from 'node:test'
import { vibeLoop, vibePush, vibeTask } from './helpers/unit-policy.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, archiveTask } from './helpers/vibe-fixture.mjs'

import { vibeStatus, vibeBeat, vibeClaim, vibeCheckpoint } from '../src/vibe.mjs'

import { vibeInbox } from '../src/vibe-inbox.mjs'
import { readSessions, ClaimError } from '../src/coord-doc.mjs'
import { upsertActive } from '../src/state-doc.mjs'
import { lintSpec } from '../src/spec-lint.mjs'

// What a loop coordinates on: the session's row, its claims, the inbox and the finished tasks live
// on the coordination branch (SESSIONS.md), never in the working tree or in a commit of STATE.
const passed = async () => ({ ok: true, checks: [] })
const opts = (root, tag = 't060') => ({ targetRoot: root, tag, provider: 'claude', maxUnits: 6 })
const sessions = async (root) => readSessions(await git(root, 'show', 'gusta:SESSIONS.md').catch(() => ''))
const movedSections = async (root) => (await readFile(path.join(root, 'spec/STATE.md'), 'utf8')).match(/^## (active|inbox|log)\b/gm) ?? []
const events = async (result) => (await readFile(path.join(path.dirname(result.manifest), 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// gusta-implement-task §5 through the real CLI: start, check acceptance, fill the result, done, commit.
async function lifecycleClose(root, id, tag) {
  await vibeTask({ step: 'start', task: id, tag, targetRoot: root })
  const name = (await readdir(path.join(root, 'spec/tasks'))).find((file) => file.startsWith(`${id}.`))
  const file = path.join(root, 'spec/tasks', name)
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('- [ ]', '- [v]').replace(/## result\n*$/, '## result\n- outcome: implemented\n- at: -\n- verified: node --test (task tier)\n- limits: -\n'))
  await writeFile(path.join(root, `${id}.js`), `// ${id}\n`)
  await vibeTask({ step: 'done', task: id, tag, targetRoot: root })
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', `${id} done`)
  return { exitCode: 0, result: { kind: 'task', id, outcome: 'completed', pushed: false, next: 'implementation' } }
}
async function completeTask(root, id) {
  await archiveTask(root, id)
  await writeFile(path.join(root, `${id}.js`), `// ${id}\n`)
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', `${id} done`)
  return { exitCode: 0, result: { kind: 'task', id, outcome: 'completed', pushed: false, next: 'implementation' } }
}

test('loops in two worktrees of one clone never take the same task: the claim is one compare-and-swap, the finished task stays held', async (t) => {
  const { root, temporary } = await fixture(t, 4)
  const other = path.join(temporary, 'other')
  await git(root, 'worktree', 'add', '-q', '-b', 'other', other)
  const taken = { [root]: [], [other]: [] }
  const run = (checkout, tag) => vibeLoop(opts(checkout, tag), { preflight: passed, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
    execute: async (options, job) => {
      taken[checkout].push(job.brief.taskId)
      // Both worktrees show every task todo; only the coordination branch says who has which.
      assert.equal((await sessions(checkout)).active.find((row) => row.tag === tag)?.doing, job.brief.taskId)
      await pause(150)
      return lifecycleClose(checkout, job.brief.taskId, tag)
    } })
  const [first, second] = await Promise.all([run(root, 'aaaa'), run(other, 'bbbb')])
  assert.equal(first.ok, true, first.error); assert.equal(second.ok, true, second.error)
  const all = [...taken[root], ...taken[other]]
  assert.deepEqual([...all].sort(), ['T001', 'T002', 'T003', 'T004'])
  assert.ok(taken[root].length && taken[other].length, JSON.stringify(taken))
  // Neither landed: each one's finished tasks wait in unlanded under its own tag, so the other
  // checkout — which still lists them todo — has nothing left to run.
  const doc = await sessions(root)
  assert.deepEqual(doc.active, [])
  assert.deepEqual(doc.unlanded.map((row) => `${row.id} ${row.tag} ${row.branch}`).sort(), [...taken[root].map((id) => `${id} aaaa main`), ...taken[other].map((id) => `${id} bbbb other`)].sort())
  const left = await vibeStatus({ targetRoot: root, tag: 'aaaa', fetch: false })
  assert.deepEqual([left.runnable, left.held.map((entry) => `${entry.id} ${entry.tag} ${entry.reason}`).sort()], [[], taken[other].map((id) => `${id} bbbb unlanded`).sort()])
  for (const checkout of [root, other]) assert.deepEqual([await movedSections(checkout), await git(checkout, 'status', '--porcelain')], [[], ''])
})

test('a refused claim skips that task for the run and goes on to the next; nothing is parked or repaired for it', async (t) => {
  const { root } = await fixture(t)
  // Another session registered and took T001 after this checkout last looked.
  await vibeBeat({ targetRoot: root, tag: 'aaaa', mode: 'pair' })
  const claims = [], units = []
  let reads = 0
  const result = await vibeLoop(opts(root), { preflight: passed, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
    status: async (options) => {
      const status = await vibeStatus(options)
      // The race: the first boundary's status (the read after the host's setup) does not show the
      // other session's claim yet.
      if (++reads === 2) await vibeClaim({ targetRoot: root, tag: 'aaaa', task: 'T001' })
      return status
    },
    claim: async (options) => { claims.push(options.task); return vibeClaim(options) },
    execute: async (options, job) => { units.push(job.brief.taskId); assert.equal(await git(root, 'status', '--porcelain'), ''); return completeTask(root, job.brief.taskId) } })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual([claims, units], [['T001', 'T002', 'T003'], ['T002', 'T003']])
  assert.equal(result.reason, 'no-work')
  const refused = (await events(result)).filter((event) => event.type === 'claim-refused')
  assert.deepEqual(refused.map(({ task, owner, reason }) => ({ task, owner, reason })), [{ task: 'T001', owner: 'aaaa', reason: 'claimed' }])
  assert.deepEqual(JSON.parse(await readFile(result.manifest, 'utf8')).refused, [{ task: 'T001', owner: 'aaaa', reason: 'claimed' }])
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /^- held by another session: T001 \(aaaa, claimed\)$/m)
  // The other session still holds T001; this run left it alone: todo here, no inbox line about it.
  const doc = await sessions(root)
  assert.deepEqual([doc.active.map((row) => `${row.tag} ${row.doing}`), doc.inbox], [['aaaa T001'], []])
  assert.match(await readFile(path.join(root, 'spec/STATE.md'), 'utf8'), /^\| T001 \| example \| ARCH \| - \| todo \|$/m)
})

test('a recovery whose claim is refused is dropped, not run, parked or counted as a spent repair', async (t) => {
  const { root } = await fixture(t, 1)
  const stateFile = path.join(root, 'spec/STATE.md'), taskFile = path.join(root, 'spec/tasks/T001.example.md')
  await writeFile(stateFile, (await readFile(stateFile, 'utf8')).replace('| todo |', '| blocked@261020 |'))
  await writeFile(taskFile, (await readFile(taskFile, 'utf8')).replace('st:todo', 'st:blocked@261020'))
  await git(root, 'add', 'spec'); await git(root, 'commit', '-q', '-m', 'existing blocker')
  const claims = []
  const result = await vibeLoop(opts(root), { preflight: passed, execute: () => assert.fail('another session finished it; nothing to run'),
    claim: async ({ task, repairTask }) => { claims.push([task, repairTask]); throw new ClaimError(`${task} waits to land`, { task, owner: 'cccc', reason: 'unlanded' }) } })
  // A recovery takes its task whatever the row says (blocked here): the claim carries repairTask.
  assert.deepEqual(claims, [['T001', true]])
  assert.deepEqual([result.ok, result.units, result.recovery, result.priorityTask], [true, 0, null, null])
  assert.deepEqual(JSON.parse(await readFile(result.manifest, 'utf8')).refused, [{ task: 'T001', owner: 'cccc', reason: 'unlanded' }])
  assert.deepEqual((await sessions(root)).inbox, [])
})

test('the loop releases its session row before it prunes: its wip snapshot goes with the run, and what it finished lands off the unlanded table', async (t) => {
  const { root } = await fixture(t, 2)
  // Land is this branch and nothing is pushed: what the run commits has landed.
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: false\n')
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'land on main')
  const waiting = []
  const result = await vibeLoop(opts(root), { preflight: passed, check: async () => ({ ok: true }),
    execute: async (options, job) => {
      await vibeCheckpoint({ targetRoot: root, tag: options.tag })
      const done = await lifecycleClose(root, job.brief.taskId, options.tag)
      waiting.push((await sessions(root)).unlanded.map((row) => row.id).join())
      return done
    },
    push: async (options) => vibePush(options) })
  assert.equal(result.ok, true, result.error); assert.equal(result.units, 2)
  assert.deepEqual(waiting, ['T001', 'T001,T002'])
  assert.deepEqual(result.pruned.pruned, ['wip/t060'])
  assert.deepEqual(result.pruned.kept, [])
  assert.equal(await git(root, 'branch', '--list', 'wip/*'), '')
  const doc = await sessions(root)
  assert.deepEqual([doc.active, doc.unlanded], [[], []])
  assert.deepEqual(await movedSections(root), [])
})

test('the loop host beats every REFRESH_MINUTES while a unit runs, so a long quiet unit stays alive elsewhere; a failed beat does not break the run', async (t) => {
  const { root } = await fixture(t, 1)
  let offset = 0
  const clock = () => Date.now() + offset
  const beats = []
  let failNext = false
  const result = await vibeLoop(opts(root), { preflight: passed, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }), now: clock,
    beat: async (options) => {
      const label = options.end ? 'end' : options.mode ?? 'refresh'
      try {
        if (label === 'refresh' && failNext) { failNext = false; throw new Error('coordination remote down') }
        return await vibeBeat(options, { coord: { now: () => new Date(clock()) } })
      } finally { beats.push(label) }
    },
    execute: async (options, job) => {
      // 31 minutes of silence from the unit: the host refreshes the row on its own.
      offset += 31 * 60000
      for (let waited = 0; !beats.includes('refresh') && waited < 5000; waited += 100) await pause(100)
      const row = (await sessions(root)).active.find((entry) => entry.tag === options.tag)
      assert.ok(Date.parse(row.at) >= Date.now() + 30 * 60000, `row at ${row.at} was not refreshed`)
      assert.equal(row.doing, job.brief.taskId)
      // The next refresh fails (remote down, a lock): the loop goes on.
      failNext = true
      offset += 31 * 60000
      for (let waited = 0; beats.filter((beat) => beat === 'refresh').length < 2 && waited < 5000; waited += 100) await pause(100)
      return lifecycleClose(root, job.brief.taskId, options.tag)
    } })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual([result.units, result.operationalErrors], [1, []])
  assert.deepEqual(beats, ['autopilot', 'refresh', 'refresh', 'end'])
  assert.ok((await git(root, 'log', '--format=%s', 'gusta')).split('\n').includes('gusta t060: beat'))
  const failed = (await events(result)).filter((event) => event.type === 'coord-beat-error')
  assert.deepEqual(failed.map((event) => event.error), ['coordination remote down'])
  assert.deepEqual((await sessions(root)).active, [])
})

test('a project that has not moved its STATE sections yet still runs: the old rows and lines are read, nothing new is written there', async (t) => {
  const { root } = await fixture(t)
  const stateFile = path.join(root, 'spec/STATE.md')
  const at = `${new Date().toISOString().slice(0, 16)}Z`
  // STATE as an older version left it: another live session doing T001, T002 parked, a log.
  let legacy = (await readFile(stateFile, 'utf8')).replace('| T001 | example | ARCH | - | todo |', '| T001 | example | ARCH | - | doing@261112.aaaa |')
    .replace('## ssot', '## inbox\n- 261112 parked T002: needs production credentials\n\n## ssot') + '\n## log\n- 261112 gusta-create-task ARCH\n'
  legacy = upsertActive(legacy, { tag: 'aaaa', host: 'other-host', mode: 'autopilot', since: at, at, doing: 'T001' })
  await writeFile(stateFile, legacy)
  const task = path.join(root, 'spec/tasks/T001.example.md')
  await writeFile(task, (await readFile(task, 'utf8')).replace('st:todo', 'st:doing@261112.aaaa'))
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'state from before the coordination branch')
  assert.deepEqual((await lintSpec({ targetRoot: root })).errors, [])
  const before = await vibeStatus({ targetRoot: root, tag: 't060', fetch: false })
  assert.deepEqual([before.coordination.legacy, before.runnable, before.others.map((row) => `${row.tag} ${row.doing}`)], [['active', 'inbox', 'log'], ['T003'], ['aaaa T001']])
  const units = []
  const result = await vibeLoop(opts(root), { preflight: passed, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
    execute: async (options, job) => {
      units.push(job.brief.taskId)
      await vibeInbox({ targetRoot: root, step: 'add', tag: options.tag, kind: 'decided', ref: ['T003'], text: 'retry twice (alt: once)' })
      return lifecycleClose(root, job.brief.taskId, options.tag)
    } })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual([units, result.reason], [['T003'], 'parked-only'])
  // The old sections are exactly as they were (gusta migrate moves them); everything this run
  // recorded went to the branch, and the report lists both inboxes.
  const state = await readFile(stateFile, 'utf8')
  for (const kept of ['| aaaa | other-host | autopilot |', '## inbox\n- 261112 parked T002: needs production credentials\n\n## ssot', '## log\n- 261112 gusta-create-task ARCH\n']) assert.ok(state.includes(kept), kept)
  assert.doesNotMatch(state, /t060|T003 done|retry twice/)
  const doc = await sessions(root)
  assert.deepEqual([doc.active, doc.inbox.map((line) => line.replace(/^- \d{6} /, '')), doc.unlanded.map((row) => row.id)], [[], ['decided T003: retry twice (alt: once)'], ['T003']])
  const report = await readFile(path.join(root, result.report), 'utf8')
  assert.match(report, /## decided\n- \d{6} decided T003: retry twice \(alt: once\)\n/)
  assert.match(report, /## parked\n- 261112 parked T002: needs production credentials\n/)
  assert.equal(await git(root, 'status', '--porcelain'), '')
})
