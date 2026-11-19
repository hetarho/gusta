import test from 'node:test'
import { vibeLoop, runVibeCheck } from './helpers/unit-policy.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, archiveTask } from './helpers/vibe-fixture.mjs'
import { closingReserve } from '../src/vibe-loop.mjs'
import { phaseGatePlan, prepareNeeded, runPhaseGate, removePhaseWorktree } from '../src/loop-phase.mjs'
import { readTimings, recordTiming, measured, timingKey } from '../src/check-cache.mjs'

const passed = async () => ({ ok: true, checks: [] })
const opts = (root) => ({ targetRoot: root, tag: 't070', provider: 'claude', maxUnits: 10, maxHours: 10 })
const runtime = (root) => path.join(root, '.git/gusta/v1')
// The fixture's batch command, measured once: phase gates have an estimate to fit before the window.
const seed = (root, ms = 60000) => recordTiming(runtime(root), timingKey('final', 'node --version'), ms)
async function completeTask(root, id, code = `// ${id}\n`) {
  await archiveTask(root, id)
  await writeFile(path.join(root, 'app.js'), code)
  await git(root, 'add', 'spec', 'app.js')
  await git(root, 'commit', '-q', '-m', `${id} done`)
  return { exitCode: 0, result: { kind: 'task', id, outcome: 'completed', pushed: false, next: 'implementation' } }
}
async function until(predicate) {
  for (let i = 0; i < 2000 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(predicate(), 'condition not reached')
}
const events = async (result, type) => (await readFile(path.join(path.dirname(result.manifest), 'events.jsonl'), 'utf8')).split('\n').filter(Boolean)
  .map((line) => JSON.parse(line)).filter((event) => event.runId === result.runId && event.type === type)
const phaseEntries = async (result) => JSON.parse(await readFile(result.manifest, 'utf8')).batches.filter((entry) => entry.phase)
const worktrees = async (root) => (await git(root, 'worktree', 'list', '--porcelain')).match(/^worktree /gm).length
// The phase check waits for the next unit to start, so it provably runs beside that unit.
function beside() {
  let release
  const started = new Promise((resolve) => { release = resolve })
  return { release, started }
}
const failing = { ok: false, exitCode: 1, log: '/phase/log', failedTests: ['FAIL cart total'], tail: ['1 failed'] }

test('the closing window hands unpublished work to the shared gate once, at the close, without spinning', async (t) => {
  const { root } = await fixture(t)
  let now = Date.now(), boundaries = 0, integrations = 0, calls = 0
  const deadline = now + 10 * 3600000
  const result = await vibeLoop(opts(root), { preflight: passed, now: () => now,
    execute: async (options, job) => { calls++; now += 3 * 3600000; return completeTask(root, job.brief.taskId, `// ${calls}\n`) },
    // A boundary that repeats without a unit is a spin: past a few, the clock jumps to the deadline.
    syncLand: async () => { if (++boundaries > 8) now = deadline; return { ok: true, action: 'none' } },
    integration: async () => { integrations++; assert.ok(now < deadline); return { ok: true, verified: true, landed: null, pushed: null } },
    check: async () => assert.fail('the shared gate runs the suite'),
  })
  // Units at 0h, 3h, 6h; the unmeasured reserve (2h) opens the window at 7h50m.
  assert.equal(calls, 3)
  assert.equal(result.reason, 'final-window', result.error)
  assert.equal(integrations, 1)
  assert.equal(boundaries, 4)
})

test('a phase gate checks the frozen commit in its own worktree after N completed tasks, beside the next unit', async (t) => {
  const { root } = await fixture(t, 5)
  await seed(root)
  let now = Date.now()
  const jobs = [], phases = [], gates = [], unit = beside()
  const result = await vibeLoop(opts(root), { preflight: passed, now: () => now,
    execute: async (options, job) => {
      jobs.push(job.brief.taskId)
      if (jobs.length === 4) { unit.release(); await until(() => phases.length === 1) }
      now += 10 * 60000
      return completeTask(root, job.brief.taskId, `// ${jobs.length}\n`)
    },
    check: async (options) => {
      if (!options.phase) { gates.push(options.targetRoot); return { ok: true } }
      await unit.started
      phases.push({ ...options, head: (await git(options.targetRoot, 'rev-parse', 'HEAD')).trim() })
      return { ok: true }
    },
    push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(jobs, ['T001', 'T002', 'T003', 'T004', 'T005'])
  // One phase after T001-T003 (none after T005: the closing gate follows), on that commit, elsewhere.
  const [started] = await events(result, 'phase-gate-start')
  assert.equal(phases.length, 1); assert.equal(started.phase, 1)
  assert.equal(phases[0].head, started.sha); assert.notEqual(phases[0].targetRoot, root)
  assert.match(phases[0].targetRoot, /phase-t070$/)
  assert.equal(await git(root, 'show', `${started.sha}:app.js`), '// 3')
  assert.deepEqual([phases[0].tier, phases[0].allowFinal, phases[0].host, phases[0].heavy], ['batch', true, true, true])
  assert.deepEqual((await events(result, 'phase-gate-result')).map((event) => [event.phase, event.outcome, event.repairTask]), [[1, 'pass', null]])
  assert.deepEqual((await phaseEntries(result)).map((entry) => [entry.phase, entry.outcome]), [[1, 'pass']])
  assert.deepEqual(gates, [root]); assert.equal(result.time.phases, 1)
  assert.match(await readFile(path.join(root, result.report), 'utf8'), new RegExp(`- phase gate 1 ${started.sha.slice(0, 8)}: pass`))
  // The run removed its phase worktree.
  assert.equal(await worktrees(root), 1)
})

test('a phase failure that repeats becomes one fix-gate task that runs next', async (t) => {
  const { root } = await fixture(t, 5)
  await seed(root)
  let now = Date.now()
  const jobs = [], phases = [], unit = beside()
  const result = await vibeLoop(opts(root), { preflight: passed, now: () => now,
    execute: async (options, job) => {
      jobs.push(job.brief.taskId)
      if (jobs.length === 4) { unit.release(); await until(() => phases.length === 2) }
      now += 10 * 60000
      return completeTask(root, job.brief.taskId, `// ${jobs.length}\n`)
    },
    check: async (options) => { if (!options.phase) return { ok: true }; await unit.started; phases.push(options.targetRoot); return failing },
    push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error)
  // Failed, ran again, failed: T006 is queued at the next boundary and wins the selection.
  assert.deepEqual(jobs, ['T001', 'T002', 'T003', 'T004', 'T006', 'T005'])
  assert.equal(phases.length, 2)
  const [started] = await events(result, 'phase-gate-start')
  const fix = await readFile(path.join(root, 'spec/tasks/done/T006.fix-gate.md'), 'utf8')
  assert.match(fix, /# T006 Fix phase 1 gate failure/); assert.match(fix, /First run only the named failing tests on HEAD/)
  for (const line of ['- Phase: 1', `- Candidate: ${started.sha}`, '- Command: node --version', '- Log: /phase/log', 'FAIL cart total', '1 failed']) assert.ok(fix.includes(line), line)
  assert.deepEqual((await events(result, 'phase-gate-result')).map((event) => [event.outcome, event.repairTask, event.failedTests]), [['fail', 'T006', ['FAIL cart total']]])
  assert.deepEqual((await phaseEntries(result)).map((entry) => [entry.outcome, entry.ok, entry.log]), [['fail', false, '/phase/log']])
})

test('a phase failure that passes when run again queues nothing', async (t) => {
  const { root } = await fixture(t, 5)
  await seed(root)
  let now = Date.now()
  const jobs = [], phases = [], unit = beside()
  const result = await vibeLoop(opts(root), { preflight: passed, now: () => now,
    execute: async (options, job) => {
      jobs.push(job.brief.taskId)
      if (jobs.length === 4) { unit.release(); await until(() => phases.length === 2) }
      now += 10 * 60000
      return completeTask(root, job.brief.taskId, `// ${jobs.length}\n`)
    },
    check: async (options) => { if (!options.phase) return { ok: true }; await unit.started; phases.push(options.targetRoot); return phases.length === 1 ? failing : { ok: true } },
    push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(jobs, ['T001', 'T002', 'T003', 'T004', 'T005'])
  assert.equal(phases.length, 2)
  assert.deepEqual((await readdir(path.join(root, 'spec/tasks/done'))).filter((name) => name.includes('fix-gate')), [])
  assert.deepEqual((await events(result, 'phase-gate-result')).map((event) => [event.outcome, event.ok, event.repairTask]), [['flaky', true, null]])
})

test('no phase gate starts inside the closing window', async (t) => {
  const { root } = await fixture(t, 5)
  await seed(root, 30 * 60000)
  let now = Date.now(), gates = 0
  const jobs = []
  // The window opens at 6h50m (3h reserve); the third unit ends at 7h30m, at the first batch boundary.
  const result = await vibeLoop({ ...opts(root), finalReserveHours: 3 }, { preflight: passed, now: () => now,
    execute: async (options, job) => { jobs.push(job.brief.taskId); now += 150 * 60000; return completeTask(root, job.brief.taskId, `// ${jobs.length}\n`) },
    check: async (options) => { assert.ok(!options.phase, 'no phase inside the window'); gates++; return { ok: true } },
    push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.reason, 'final-window'); assert.deepEqual(jobs, ['T001', 'T002', 'T003']); assert.equal(gates, 1)
  assert.deepEqual(await events(result, 'phase-gate-start'), [])
})

test('a phase gate still running is aborted and awaited before the closing gate', async (t) => {
  const { root } = await fixture(t, 4)
  await seed(root)
  let now = Date.now()
  const jobs = [], order = []
  const result = await vibeLoop(opts(root), { preflight: passed, now: () => now,
    execute: async (options, job) => {
      jobs.push(job.brief.taskId)
      if (jobs.length === 4) await until(() => order.includes('phase-start'))
      now += 10 * 60000
      return completeTask(root, job.brief.taskId, `// ${jobs.length}\n`)
    },
    check: async (options) => {
      assert.ok(options.phase, 'the shared gate runs the suite')
      order.push('phase-start')
      await new Promise((resolve) => options.signal.aborted ? resolve() : options.signal.addEventListener('abort', resolve, { once: true }))
      order.push('phase-aborted')
      await new Promise((resolve) => setTimeout(resolve, 50))
      order.push('phase-returned')
      return { ok: false, cancelled: true, status: 'not-run' }
    },
    integration: async () => { order.push('integration'); return { ok: true, verified: true, landed: null, pushed: null } },
  })
  assert.equal(result.reason, 'no-work', result.error)
  assert.deepEqual(order, ['phase-start', 'phase-aborted', 'phase-returned', 'integration'])
  assert.deepEqual((await phaseEntries(result)).map((entry) => entry.outcome), ['cancelled'])
  assert.equal(await worktrees(root), 1)
})

test('phase samples have their own key: the closing reserve reads only closing runs', async (t) => {
  const { root } = await fixture(t)
  assert.equal((await runVibeCheck({ targetRoot: root, tier: 'batch', allowFinal: true, phase: true }, 'node -e "0"')).ok, true)
  const command = 'node -e "0"', base = { commands: [command], hours: 10, timeoutMs: 3600000 }
  let timings = await readTimings(runtime(root))
  assert.ok(measured(timings, timingKey('phase', command)) >= 0)
  assert.equal(measured(timings, timingKey('final', command)), null)
  assert.equal(closingReserve({ ...base, timings }).source, 'unmeasured')
  await recordTiming(runtime(root), timingKey('final', command), 5 * 60000)
  await recordTiming(runtime(root), timingKey('phase', command), 50 * 60000)
  timings = await readTimings(runtime(root))
  assert.equal(closingReserve({ ...base, timings }).gateMs, 5 * 60000)
  // A phase estimate prefers its own (slower, beside units) samples.
  assert.deepEqual(phaseGatePlan({ timings, commands: [command], every: 3, workMs: 3600000 }), { every: 3, enabled: true, estimateMs: 50 * 60000 })
})

test('phase gate plan: the dry run says whether phases run and why not', async (t) => {
  const { root } = await fixture(t)
  assert.deepEqual((await vibeLoop({ ...opts(root), dryRun: true })).phaseGates, { every: 3, enabled: false, why: 'unmeasured' })
  await seed(root)
  assert.deepEqual((await vibeLoop({ ...opts(root), dryRun: true, batchSize: 2 })).phaseGates, { every: 2, enabled: true, estimateMs: 60000 })
  const timings = await readTimings(runtime(root))
  assert.deepEqual(phaseGatePlan({ timings, commands: [], every: 3, workMs: 1 }), { every: 3, enabled: false, why: 'no-batch-checks' })
  assert.deepEqual(phaseGatePlan({ timings, commands: ['node --version'], every: 3, workMs: 60000 }), { every: 3, enabled: false, why: 'no-time', estimateMs: 60000 })
  assert.deepEqual(['package-lock.json', 'web/pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'api/package.json', 'src/clock.js', 'src/app.js', 'lockout.md'].map((file) => prepareNeeded([file])),
    [true, true, true, true, true, false, false, false])
})

test('a phase worktree follows each commit and is prepared when created and again only for new dependencies', async (t) => {
  const { root, temporary } = await fixture(t)
  const directory = path.join(temporary, 'phase-x'), prepared = []
  const commit = async (file, text) => { await writeFile(path.join(root, file), text); await git(root, 'add', file); await git(root, 'commit', '-qm', file); return (await git(root, 'rev-parse', 'HEAD')).trim() }
  const run = async (sha, tree) => runPhaseGate({ root, directory, sha, runs: [{ command: 'node --version' }], prepare: ['npm ci --offline'], tree, deadline: Date.now() + 60000,
    check: async (options) => ({ ok: (await git(options.targetRoot, 'rev-parse', 'HEAD')).trim() === sha }),
    prepareWorkspace: async (where, commands) => { prepared.push(commands); return { ok: true, root: where, steps: [] } } })
  const first = await run((await git(root, 'rev-parse', 'HEAD')).trim(), null)
  assert.deepEqual([first.outcome, first.created, first.prepared], ['pass', true, true])
  // What a check left in the worktree does not reach the next phase.
  await writeFile(path.join(directory, 'leftover.txt'), 'x')
  const second = await run(await commit('app.js', '// 2\n'), first.tree)
  assert.deepEqual([second.outcome, second.created, second.prepared], ['pass', false, false])
  await assert.rejects(readFile(path.join(directory, 'leftover.txt')))
  const third = await run(await commit('package-lock.json', '{}\n'), second.tree)
  assert.deepEqual([third.outcome, third.prepared], ['pass', true])
  assert.equal(prepared.length, 2)
  await removePhaseWorktree(root, directory)
  assert.equal(await worktrees(root), 1)
})
