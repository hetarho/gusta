import test from 'node:test'
import { vibeLoop, vibeTask } from './helpers/unit-policy.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, archiveTask } from './helpers/vibe-fixture.mjs'
import { nextRung, timeboxMs, EXPLORE_EXIT_MS } from '../src/vibe-loop.mjs'
import { vibeStatus } from '../src/vibe.mjs'
import { readSessions } from '../src/coord-doc.mjs'
import { appendInbox } from '../src/state-doc.mjs'
import { recoveryText } from '../src/agent-adapter.mjs'

import { lintSpec } from '../src/spec-lint.mjs'

// Units that end unfinished or close badly: continuation, split, park, the spec gate and its repair.
// (Split from vibe-loop.test.mjs: node --test runs files in parallel, tests in a file in order.)
const passed = async () => ({ ok: true, checks: [] })
const opts = (root) => ({ targetRoot: root, tag: 't060', provider: 'claude', maxUnits: 3 })
async function completeTask(root, id, code = `// ${id}\n`) {
  await archiveTask(root, id)
  await writeFile(path.join(root, 'app.js'), code)
  await git(root, 'add', 'spec', 'app.js')
  await git(root, 'commit', '-q', '-m', `${id} done`)
  return { exitCode: 0, result: { kind: 'task', id, outcome: 'completed', pushed: false, next: 'implementation' } }
}
// What the run left for other sessions: SESSIONS.md on the coordination branch, and the STATE
// sections that moved there (none may come back).
const sessions = async (root) => readSessions(await git(root, 'show', 'gusta:SESSIONS.md').catch(() => ''))
const movedSections = async (root) => (await readFile(path.join(root, 'spec/STATE.md'), 'utf8')).match(/^## (active|inbox|log)\b/gm) ?? []

const cutUnit = () => ({ exitCode: 1, stopped: 'unit-timeout', result: null })
const published = () => ({ check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }) })

test('a unit cut at its limit hands its uncommitted work to a fresh continuation unit; the run goes on and publishes', async (t) => {
  const { root } = await fixture(t)
  const jobs = []
  let checks = 0, pushes = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 10 }, { preflight: passed,
    execute: async (options, job, directory, limits) => {
      jobs.push({ task: job.brief?.taskId, recovery: job.recovery, timeLimit: job.timeLimit, timeoutMs: limits.timeoutMs, clean: await git(root, 'status', '--porcelain') === '' })
      if (jobs.length === 1) {
        await writeFile(path.join(root, 'app.js'), '// half of T001\n')
        await mkdir(path.join(root, 'notes'), { recursive: true }); await writeFile(path.join(root, 'notes/partial.txt'), 'measured\n')
        return cutUnit()
      }
      if (jobs.length === 2) {
        await git(root, 'checkout', job.recovery.snapshot.commit, '--', 'notes/partial.txt')
        assert.equal(await readFile(path.join(root, 'notes/partial.txt'), 'utf8'), 'measured\n')
      }
      return completeTask(root, job.brief.taskId)
    },
    check: async () => { checks++; return { ok: true } }, push: async () => { pushes++; return { ok: true, pushed: null } },
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'no-work')
  assert.deepEqual(jobs.map((job) => job.task), ['T001', 'T001', 'T002', 'T003'])
  assert.ok(jobs.every((job) => job.clean), 'every unit starts from a clean tree')
  assert.equal(jobs[0].recovery, undefined); assert.equal(jobs[0].timeoutMs, 3600000); assert.equal(jobs[0].timeLimit.minutes, 60)
  assert.equal(jobs[1].recovery.reason, 'interrupted'); assert.equal(jobs[1].recovery.cause, 'unit-timeout'); assert.equal(jobs[1].recovery.taskId, 'T001')
  assert.deepEqual(jobs[1].recovery.snapshot.files, ['app.js', 'notes/partial.txt'])
  // The continuation finished the task, so its snapshot ref is gone.
  assert.equal(await git(root, 'for-each-ref', 'refs/gusta/units'), '')
  const events = await readFile(path.join(path.dirname(result.manifest), 'events.jsonl'), 'utf8')
  assert.match(events, /"type":"unit-cut"/); assert.doesNotMatch(events, /"type":"failed"/)
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /T001: cut \(unit-timeout\) · uncommitted work → refs\/gusta\/units\/t060\//)
  assert.equal(checks, 1); assert.ok(pushes >= 1)
})

test('a task that keeps getting cut is continued, split once, then parked; other tasks still run', async (t) => {
  const { root } = await fixture(t)
  const seen = []
  const result = await vibeLoop({ ...opts(root), maxUnits: 12 }, { preflight: passed, ...published(),
    execute: async (options, job) => {
      const id = job.brief?.taskId
      seen.push(`${id}:${job.recovery?.reason ?? '-'}`)
      if (id !== 'T001') return completeTask(root, id)
      if (job.recovery?.reason === 'split') {
        const file = path.join(root, 'spec/tasks/T001.example.md')
        await writeFile(file, (await readFile(file, 'utf8')).replace('Fix example.', 'Fix the first half of example.'))
        await git(root, 'commit', '-qam', 'narrow T001')
        return { exitCode: 0, result: { kind: 'planning', id: 'T001', outcome: 'completed', pushed: false, next: 'implementation' } }
      }
      await writeFile(path.join(root, 'app.js'), `// attempt ${seen.length}\n`)
      return cutUnit()
    },
  })
  assert.deepEqual(seen, ['T001:-', 'T001:interrupted', 'T001:split', 'T001:-', 'T001:interrupted', 'T002:-', 'T003:-'])
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'parked-only')
  // The park is one inbox line on the coordination branch: no STATE edit and no commit of its own.
  assert.match((await sessions(root)).inbox.join('\n'), /^- \d{6} parked T001: .*refs\/gusta\/units\/t060\/\S+-5\b/m)
  assert.deepEqual([await movedSections(root), await git(root, 'log', '--format=%s', '--grep', 'park T001')], [[], ''])
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /## parked\n- \d{6} parked T001: units kept ending/)
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /uncommitted work kept: refs\/gusta\/units\/t060\/\S+-5 \(T001, 1 files\)/)
})

test('an idle cut counts as a session failure; two stop the run, which still publishes committed work', async (t) => {
  const { root } = await fixture(t)
  let calls = 0, checks = 0, pushes = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 10 }, { preflight: passed,
    execute: async (options, job) => ++calls === 1 ? completeTask(root, job.brief.taskId) : cutUnit(),
    check: async () => { checks++; return { ok: true } }, push: async () => { pushes++; return { ok: true, pushed: null } },
  })
  assert.equal(result.reason, 'session-failures'); assert.equal(result.ok, false); assert.equal(calls, 3)
  assert.equal(checks, 1); assert.ok(pushes >= 1)
  assert.equal(await git(root, 'status', '--porcelain'), '')
})

async function exploreFixture(t) {
  const made = await fixture(t)
  const file = path.join(made.root, 'spec/tasks/T001.example.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('touches:src/', 'touches:src/ | explore:2h').replace('## impl notes', '- [ ] exit: record the best measured setting.\n\n## impl notes'))
  await git(made.root, 'commit', '-qam', 'explore T001')
  return made
}

test('an explore unit runs its timebox plus exit time; units end inside the work window; an explore that no longer fits yields', async (t) => {
  const { root } = await exploreFixture(t)
  const roomy = []
  await vibeLoop({ ...opts(root), maxUnits: 1 }, { preflight: passed, ...published(),
    execute: async (options, job, directory, limits) => { roomy.push([job.brief.taskId, limits.timeoutMs]); return completeTask(root, job.brief.taskId) } })
  assert.deepEqual(roomy, [['T001', 2 * 3600000 + EXPLORE_EXIT_MS]])

  const { root: late } = await exploreFixture(t)
  let now = 0
  const jobs = []
  // 8h run, unmeasured reserve 96m: from 5h the work window has 84m left, too short for 2h30m.
  const result = await vibeLoop({ ...opts(late), tag: 't061', maxUnits: 10 }, { preflight: async () => { now = 5 * 3600000; return passed() }, now: () => now, ...published(),
    execute: async (options, job, directory, limits) => { jobs.push([job.brief.taskId, limits.timeoutMs]); now += 30 * 60000; return completeTask(late, job.brief.taskId) } })
  assert.deepEqual(jobs, [['T002', 3600000], ['T003', 54 * 60000]])
  assert.equal(result.reason, 'explore-no-time')
})

test('--tasks runs only the scoped tasks and what the run creates for them, then closes', async (t) => {
  const { root } = await fixture(t)
  const state = path.join(root, 'spec/STATE.md')
  await writeFile(state, (await readFile(state, 'utf8')).replace('| T003 | example | ARCH | - | todo |', '| T003 | example | ARCH | T002 | todo |').replace(/## next\n[\s\S]*?(?=\n## |$)/, '## next\n- gusta-implement-task T001\n'))
  await git(root, 'commit', '-qam', 'T003 after T002')
  await assert.rejects(vibeLoop({ ...opts(root), tasks: 'T009', dryRun: true }), /tasks\/done에 없는/)
  await assert.rejects(vibeLoop({ ...opts(root), tasks: 'T003', dryRun: true }), /범위 밖 선행/)
  assert.deepEqual((await vibeLoop({ ...opts(root), tasks: 'T003,T002', dryRun: true })).scope, ['T003', 'T002'])
  const seen = []
  const result = await vibeLoop({ ...opts(root), maxUnits: 10, tasks: 'T003,T002' }, { preflight: passed, ...published(),
    execute: async (options, job) => {
      const id = job.brief.taskId
      seen.push(id)
      if (id === 'T002') {
        await writeFile(path.join(root, 'spec/tasks/T004.example.md'), '# T004 Follow-up\n> st:todo | ssot:ARCH-1 | base:ARCH@1 | dep:T002 | touches:src/\n\n## goal\nFollow up.\n\n## acceptance\n- [ ] Works.\n\n## impl notes\n- -\n\n## result\n')
        await writeFile(state, (await readFile(state, 'utf8')).replace('\n\n## next', '\n| T004 | follow-up | ARCH | T002 | todo |\n\n## next'))
      }
      return completeTask(root, id)
    },
  })
  assert.deepEqual(seen, ['T002', 'T003', 'T004'])
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'scope-done')
  assert.match(await readFile(state, 'utf8'), /^\| T001 \| example \| ARCH \| - \| todo \|$/m)
  assert.deepEqual(JSON.parse(await readFile(result.manifest, 'utf8')).scope, ['T003', 'T002', 'T004'])
})

test('ladder, timebox, inbox and recovery prompt helpers', () => {
  assert.equal(nextRung({ cuts: 1, split: false }), 'interrupted')
  assert.equal(nextRung({ cuts: 2, split: false }), 'split')
  assert.equal(nextRung({ cuts: 2, split: true }), 'park')
  assert.equal(nextRung({ cuts: 3, split: false }), 'park')
  assert.equal(timeboxMs('2h'), 7200000); assert.equal(timeboxMs('90m'), 5400000); assert.equal(timeboxMs('-'), null)
  assert.equal(appendInbox('# STATE\n\n## cfg\n- level: expert\n\n## ssot\n| id |\n', '- 261110 parked T001: x'),
    '# STATE\n\n## cfg\n- level: expert\n\n## inbox\n- 261110 parked T001: x\n\n## ssot\n| id |\n')
  assert.equal(appendInbox('## cfg\n- a\n\n## inbox\n- 261101 decided ARCH-1: q → a\n\n## ssot\n', '- 261110 parked T001: x'),
    '## cfg\n- a\n\n## inbox\n- 261101 decided ARCH-1: q → a\n- 261110 parked T001: x\n\n## ssot\n')
  const snapshot = { commit: 'abc', base: 'def' }
  assert.match(recoveryText({ reason: 'interrupted', cause: 'unit-timeout', taskId: 'T001', snapshot }), /git checkout abc -- <paths>/)
  assert.match(recoveryText({ reason: 'split', taskId: 'T001', snapshot }), /Do not implement it now/)
  assert.match(recoveryText({ reason: 'blocked-task', taskId: 'T001' }), /read the blocker/)
})

// The smoke run's units closed tasks with sed: `st:done` without a date, `[x]`, free text, a `| done |` row.
async function handClose(root, id, n) {
  const name = (await readdir(path.join(root, 'spec/tasks'))).find((file) => file.startsWith(`${id}.`))
  const file = path.join(root, 'spec/tasks', name), state = path.join(root, 'spec/STATE.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('st:todo', 'st:done').replaceAll('- [ ]', '- [x]').replace(/## result\n*$/, '## result\nImplemented and tested.\n'))
  await writeFile(state, (await readFile(state, 'utf8')).replace(`| ${id} | example | ARCH | - | todo |`, `| ${id} | example | ARCH | - | done |`))
  await writeFile(path.join(root, 'app.js'), `// ${id} ${n}\n`)
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', `${id} by hand`)
  return { exitCode: 0, result: { kind: 'task', id, outcome: 'completed', pushed: false, next: 'implementation' } }
}
// gusta-implement-task §5 through the real CLI: start, check acceptance, fill the four result lines, done.
async function lifecycleClose(root, id, tag) {
  await vibeTask({ step: 'start', task: id, tag, targetRoot: root })
  const name = (await readdir(path.join(root, 'spec/tasks'))).find((file) => file.startsWith(`${id}.`))
  const file = path.join(root, 'spec/tasks', name)
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('- [ ]', '- [v]').replace(/## result\n*$/, '## result\n- outcome: implemented\n- at: -\n- verified: node --test (task tier)\n- limits: -\n'))
  await writeFile(path.join(root, 'app.js'), `// ${id}\n`)
  await vibeTask({ step: 'done', task: id, tag, targetRoot: root })
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', `${id} done`)
  return { exitCode: 0, result: { kind: 'task', id, outcome: 'completed', pushed: false, next: 'implementation' } }
}
const events = async (result) => (await readFile(path.join(path.dirname(result.manifest), 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))

test('a task closed by hand is not done: one spec repair unit names the violations, a second rejection parks it, the rest runs and the close fails on lint', async (t) => {
  const { root } = await fixture(t)
  const jobs = []
  const result = await vibeLoop({ ...opts(root), maxUnits: 10 }, { preflight: passed, ...published(),
    execute: async (options, job) => {
      const id = job.recovery?.taskId ?? job.brief.taskId
      jobs.push({ id, recovery: job.recovery?.reason ?? null, violations: job.recovery?.violations ?? null })
      return id === 'T001' ? handClose(root, id, jobs.length) : completeTask(root, id)
    } })
  assert.deepEqual(jobs.map(({ id, recovery }) => [id, recovery]), [['T001', null], ['T001', 'spec-gate'], ['T002', null], ['T003', null]])
  const violations = jobs[1].violations
  assert.ok(violations.includes('spec/tasks/done/T001.<slug>.md is missing (not archived)'), violations)
  assert.ok(violations.includes('spec/STATE.md tasks row T001 remains (st done)'), violations)
  assert.ok(violations.some((line) => /^lint: T001: st 형식 오류: done/.test(line)), violations)
  assert.match((await sessions(root)).inbox.join('\n'), /^- \d{6} parked T001: reported completed, but its spec close still failed after a repair unit/m)
  assert.deepEqual(await movedSections(root), [])
  assert.deepEqual((await events(result)).filter((event) => event.type === 'spec-gate').map((event) => event.next), ['spec-gate', 'parked'])
  // The close never reads as settled work: the failed lint check replaces no-work / parked-only.
  assert.equal(result.ok, false); assert.equal(result.reason, 'failed'); assert.match(result.error, /spec lint 실패/)
  const report = await readFile(path.join(root, result.report), 'utf8')
  assert.equal(report.match(/- task T001: rejected by spec gate/g).length, 2)
  assert.match(report, /- task T002: completed/)
  assert.match(report, /- spec lint: fail \(\d+ errors; first: /)
  assert.doesNotMatch(report, /loop stopped: (no-work|parked-only)/)
  const status = await vibeStatus({ targetRoot: root, tag: 't060' })
  assert.equal(status.route, 'repair'); assert.equal(status.settled, false)
})

test('a task closed through the lifecycle passes the spec gate with no extra unit; the session, its claims and the finished tasks are on the coordination branch only', async (t) => {
  const { root } = await fixture(t)
  const jobs = [], seen = []
  const result = await vibeLoop({ ...opts(root), maxUnits: 10 }, { preflight: passed, ...published(),
    execute: async (options, job) => {
      const id = job.brief.taskId
      jobs.push([id, job.recovery?.reason ?? null])
      // Every unit starts on a clean tree with the host's row already holding its task...
      seen.push([await git(root, 'status', '--porcelain'), (await sessions(root)).active.map((row) => `${row.tag} ${row.mode} ${row.doing}`).join()])
      // ...so the unit's own `vibe task start` is a claim of a registered session, not a skipped one.
      const started = await vibeTask({ step: 'start', task: id, tag: options.tag, targetRoot: root })
      assert.deepEqual([started.coordination.skipped, started.coordination.branch], [undefined, 'gusta'])
      return lifecycleClose(root, id, options.tag)
    } })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'no-work'); assert.equal(result.units, 3)
  assert.deepEqual(jobs, [['T001', null], ['T002', null], ['T003', null]])
  assert.deepEqual(seen, ['T001', 'T002', 'T003'].map((id) => ['', `t060 autopilot ${id}`]))
  assert.ok(!(await events(result)).some((event) => event.type === 'spec-gate'))
  assert.equal((await lintSpec({ targetRoot: root })).errors.length, 0)
  // After the run: no session row, the finished tasks wait in unlanded (this push landed nothing),
  // the log has their lines — and STATE got none of the sections that moved, in any commit.
  const doc = await sessions(root)
  assert.deepEqual([doc.active, doc.unlanded.map((row) => `${row.id} ${row.tag} ${row.branch}`), doc.log.map((line) => line.replace(/^- \d{6} /, ''))],
    [[], ['T001 t060 main', 'T002 t060 main', 'T003 t060 main'], ['T003 done', 'T002 done', 'T001 done']])
  assert.deepEqual(await movedSections(root), [])
  assert.equal(await git(root, 'log', '--format=%H', '-G', '^## (active|inbox|log)', '--', 'spec/STATE.md'), '')
  assert.equal(await git(root, 'status', '--porcelain'), '')
})

test('a hand-closed task from before the run gets one repair unit first; a correct repair closes it', async (t) => {
  const { root } = await fixture(t)
  await handClose(root, 'T002', 0)
  const jobs = []
  const result = await vibeLoop({ ...opts(root), maxUnits: 10 }, { preflight: passed, ...published(),
    execute: async (options, job) => {
      const id = job.recovery?.taskId ?? job.brief.taskId
      jobs.push([id, job.recovery?.reason ?? null])
      if (job.recovery?.reason === 'spec-gate') {
        // Undo the hand close as the repair text says, then close through the lifecycle.
        const file = path.join(root, 'spec/tasks/T002.example.md'), state = path.join(root, 'spec/STATE.md')
        await writeFile(file, (await readFile(file, 'utf8')).replace('st:done', 'st:todo').replaceAll('- [x]', '- [ ]').replace(/## result\n[\s\S]*$/, '## result\n'))
        await writeFile(state, (await readFile(state, 'utf8')).replace('| T002 | example | ARCH | - | done |', '| T002 | example | ARCH | - | todo |'))
      }
      return lifecycleClose(root, id, options.tag)
    } })
  assert.deepEqual(jobs, [['T002', 'spec-gate'], ['T001', null], ['T003', null]])
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'no-work')
})
