import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, archiveTask } from './helpers/vibe-fixture.mjs'
import { vibeLoop, executeVibeUnit, closingReserve, unitStatus, UNIT_LISTED } from '../src/vibe-loop.mjs'
import { timingKey } from '../src/check-cache.mjs'
import { vibeStatus } from '../src/vibe.mjs'
import { vibeInbox } from '../src/vibe-inbox.mjs'
import { readSessions } from '../src/coord-doc.mjs'
import { lintSpec } from '../src/spec-lint.mjs'

const passed = async () => ({ ok: true, checks: [] })
const unit = (outcome = 'completed') => ({ exitCode: 0, result: { kind: 'task', id: 'T001', outcome, pushed: false, next: 'implementation' } })
const opts = (root) => ({ targetRoot: root, tag: 't060', provider: 'claude', maxUnits: 3 })
async function completeTask(root, id, code = `// ${id}\n`) {
  await archiveTask(root, id)
  await writeFile(path.join(root, 'app.js'), code)
  await git(root, 'add', 'spec', 'app.js')
  await git(root, 'commit', '-q', '-m', `${id} done`)
  return { exitCode: 0, result: { kind: 'task', id, outcome: 'completed', pushed: false, next: 'implementation' } }
}
// What the run left for other sessions: SESSIONS.md on the coordination branch, and the STATE
// sections that moved there (none may come back). After a run its own session row is gone.
const sessions = async (root) => readSessions(await git(root, 'show', 'gusta:SESSIONS.md').catch(() => ''))
const movedSections = async (root) => (await readFile(path.join(root, 'spec/STATE.md'), 'utf8')).match(/^## (active|inbox|log)\b/gm) ?? []
const sessionGone = async (root, tag = 't060') => assert.deepEqual([(await sessions(root)).active.filter((row) => row.tag === tag), await movedSections(root)], [[], []])
async function fakeAdapter(temporary, body) {
  const file = path.join(temporary, 'fake-provider.cjs'), config = path.join(temporary, 'adapter.json')
  await writeFile(file, `const fs=require('node:fs'),cp=require('node:child_process');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const job=JSON.parse(input);${body}});`)
  await writeFile(config, JSON.stringify({ command: process.execPath, args: [file] }))
  return config
}

test('dry-run has zero model calls or mutations; options and ARCH tier plan are visible', async (t) => {
  const { root, initial } = await fixture(t)
  const result = await vibeLoop({ ...opts(root), dryRun: true }, { execute: () => assert.fail('no model'), preflight: () => assert.fail('no probe') })
  assert.equal(result.modelRequests, 0); assert.equal(result.freshSessionPerUnit, true)
  assert.equal(result.limits.batchSize, 3)
  assert.equal(result.permissionMode, 'bypass')
  assert.equal(await git(root, 'rev-parse', 'HEAD'), initial)
  assert.equal(await git(root, 'status', '--porcelain'), '')
  // Units are headless: SETTINGS permission-mode decides, an explicit flag wins for this run.
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- permission-mode: acceptEdits\n')
  assert.equal((await vibeLoop({ ...opts(root), dryRun: true })).permissionMode, 'acceptEdits')
  assert.equal((await vibeLoop({ ...opts(root), dryRun: true, permissionMode: 'bypass' })).permissionMode, 'bypass')
  await assert.rejects(vibeLoop({ ...opts(root), dryRun: true, permissionMode: 'plan' }), /--permission-mode/)
})

test('command adapter runs one new process/session per task, preflights once, and shares one report/tag', async (t) => {
  const { root, temporary } = await fixture(t)
  const records = path.join(temporary, 'records.jsonl')
  const adapter = await fakeAdapter(temporary, `
    fs.appendFileSync(${JSON.stringify(records)},JSON.stringify({pid:process.pid,tag:job.tag,report:job.report,base:job.diffBase,resume:job.resume,mode:job.permissionMode})+'\\n');
    fs.writeFileSync(job.sessionFile,'session-'+process.pid);
    const stateFile='spec/STATE.md';let state=fs.readFileSync(stateFile,'utf8');
    const id=job.brief.taskId;state=state.split('\\n').filter(line=>!line.startsWith('| '+id+' |')).join('\\n');fs.writeFileSync(stateFile,state);
    fs.writeFileSync('spec/tasks/done/'+id+'.example.md',fs.readFileSync('spec/tasks/'+id+'.example.md','utf8').replace('st:todo','st:done@261112'));fs.rmSync('spec/tasks/'+id+'.example.md');
    cp.execFileSync('git',['add','spec']);cp.execFileSync('git',['commit','-q','-m',id+' done']);
    console.log(JSON.stringify({kind:'task',id,outcome:'completed',pushed:false,next:'implementation'}));`)
  let preflights = 0, pushes = 0
  const result = await vibeLoop({ ...opts(root), adapter, provider: undefined }, { preflight: async (options) => { preflights++; assert.equal(options.probeWorkspace, 'current'); assert.equal(options.permissionMode, 'bypass'); return passed() }, push: async () => { pushes++; return { ok: true, pushed: null } } })
  assert.equal(result.ok, true, result.error); assert.equal(result.units, 3); assert.equal(preflights, 1)
  const rows = (await readFile(records, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(new Set(rows.map((row) => row.pid)).size, 3)
  assert.equal(new Set(rows.map((row) => row.report)).size, 1)
  assert.ok(rows.every((row) => row.tag === 't060' && row.resume === undefined && row.mode === 'bypass'))
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
  assert.equal(new Set(manifest.dispatches.map((row) => row.session)).size, 3)
  assert.equal(manifest.dispatches.filter((row) => row.log).length, 3)
  assert.ok(pushes <= 2)
  await sessionGone(root)
  assert.doesNotMatch(await readFile(path.join(root, result.report), 'utf8'), /to:-/)
})

for (const [name, execute, expected] of [
  ['unchanged HEAD/STATE', async () => ({ exitCode: 0, result: { kind: 'none', id: '', outcome: 'no_work', pushed: false, next: 'implementation' } }), 'no-progress'],
  ['repeated session errors', async () => ({ exitCode: 1, result: null }), 'session-failures'],
]) test(`loop stops after two ${name}`, async (t) => {
  const { root } = await fixture(t)
  const result = await vibeLoop({ ...opts(root), maxUnits: 10 }, { preflight: passed, execute })
  assert.equal(result.reason, expected); assert.equal(result.units, 2)
  await sessionGone(root)
})

test('stop file and parked-only route stop without dispatching a model', async (t) => {
  const { root } = await fixture(t)
  await vibeLoop({ targetRoot: root, tag: 't060', stop: true })
  const stopped = await vibeLoop(opts(root), { preflight: () => assert.fail('already stopped'), execute: () => assert.fail('no model') })
  assert.equal(stopped.reason, 'stop-file'); assert.equal(stopped.units, 0)
  const parked = await vibeLoop({ ...opts(root), tag: 't061' }, { preflight: passed, status: async () => ({ route: 'implementation', parkedOnly: true }), execute: () => assert.fail('parked') })
  assert.equal(parked.reason, 'parked-only')
})

test('no-work and max-hours routes terminate, closing report once', async (t) => {
  const { root } = await fixture(t, 0)
  const noWork = await vibeLoop(opts(root), { preflight: passed, execute: () => assert.fail('no work') })
  assert.equal(noWork.reason, 'no-work'); assert.equal(noWork.units, 0); assert.equal(noWork.hint, undefined)
  let now = 0
  const timed = await vibeLoop({ ...opts(root), tag: 't062', maxHours: 1 }, { preflight: async () => { now = 3600001; return passed() }, now: () => now, execute: () => assert.fail('time limit') })
  assert.equal(timed.reason, 'max-hours')
})

// Planning belongs to the owner's /gusta-sketch: execution never opens a unit without a task.
test('untasked SSOT deltas end the loop as needs-sketch without a unit; tasks no unit can take end as no-work', async (t) => {
  const { root, arch } = await fixture(t, 0)
  const stateFile = path.join(root, 'spec/STATE.md')
  await writeFile(stateFile, (await readFile(stateFile, 'utf8')).replace('| ARCH | 1 | 1 | - | 0 |', '| ARCH | 2 | 1 | ARCH-3+ | 0 |'))
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), arch.replace('> r1 |', '> r2 |').replace('\n\n## chg\n', '\n- ARCH-3 [o] Logs are JSON lines.\n\n## chg\n- r2 261020 ARCH-3+ log format\n'))
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'untasked planning')
  const status = await vibeStatus({ targetRoot: root, tag: 't060' })
  assert.equal(status.route, 'sketch-first'); assert.deepEqual(status.sketch.pending.map((row) => row.id), ['ARCH'])
  const result = await vibeLoop(opts(root), { preflight: passed, execute: () => assert.fail('no planning unit') })
  assert.equal(result.ok, true, result.error); assert.equal(result.units, 0)
  assert.equal(result.reason, 'needs-sketch'); assert.equal(result.hint, '/gusta-sketch로 태스크까지 만든 뒤 다시 실행하세요')
  assert.match(result.continuation.next, /\/gusta-sketch/)
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /^- loop stopped: needs-sketch — \/gusta-sketch로 태스크까지 만든 뒤 다시 실행하세요$/m)
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
  assert.equal(manifest.hint, result.hint)
  const notices = await readdir(path.join(path.dirname(result.manifest), 'notifications'))
  const finished = (await Promise.all(notices.map(async (name) => JSON.parse(await readFile(path.join(path.dirname(result.manifest), 'notifications', name), 'utf8'))))).find((event) => event.type === 'finished')
  assert.deepEqual([finished.reason, finished.level, finished.hint], ['needs-sketch', 'attention', result.hint])
  // A todo waiting on another session's task is not this loop's to run, nor a reason to plan.
  const header = '## tasks\n| id | title | ssot | dep | st |\n|---|---|---|---|---|\n'
  await writeFile(stateFile, (await readFile(stateFile, 'utf8')).replace('| ARCH | 2 | 1 | ARCH-3+ | 0 |', '| ARCH | 2 | 2 | - | 0 |')
    .replace(header, `${header}| T001 | first | ARCH | - | doing@261020.zz99 |\n| T002 | second | ARCH | T001 | todo |\n`))
  for (const [id, st, dep] of [['T001', 'doing@261020.zz99', '-'], ['T002', 'todo', 'T001']]) {
    await writeFile(path.join(root, `spec/tasks/${id}.example.md`), `# ${id} Example\n> st:${st} | ssot:ARCH-3 | base:ARCH@2 | dep:${dep} | touches:src/\n\n## goal\nLog JSON.\n\n## acceptance\n- [ ] Works with a regression test.\n\n## impl notes\n- -\n\n## result\n`)
  }
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'tasked, held by another session')
  assert.deepEqual([(await vibeStatus({ targetRoot: root, tag: 't061' })).route, (await lintSpec({ targetRoot: root })).errors], ['implementation', []])
  const waiting = await vibeLoop({ ...opts(root), tag: 't061' }, { preflight: passed, execute: () => assert.fail('no unit for a waiting todo') })
  assert.equal(waiting.reason, 'no-work'); assert.equal(waiting.units, 0)
})

test('closing reserve is the measured gate twice, one repair unit and CI; unmeasured runs fall back once', () => {
  const store = (entries) => ({ schemaVersion: 1, entries: Object.fromEntries(Object.entries(entries).map(([key, samples]) => [key, { samples }])) })
  const min = 60000, base = { commands: ['npm test', 'npm run e2e'], hours: 10, timeoutMs: 3600000 }
  const timings = store({ [timingKey('final', 'npm  test')]: [20 * min, 25 * min], [timingKey('final', 'npm run e2e')]: [5 * min], [timingKey('unit')]: [15 * min], [timingKey('ci')]: [10 * min] })
  // gate = max of recent samples per command: 25 + 5 = 30 min; reserve = 30 + 15 (repair) + 30 (re-run) + 10 (CI)
  assert.deepEqual(closingReserve({ ...base, timings, push: true }), { ms: 85 * min, source: 'measured', gateMs: 30 * min, fixMs: 15 * min, ciMs: 10 * min })
  assert.equal(closingReserve({ ...base, timings }).ms, 75 * min)
  assert.deepEqual(closingReserve({ ...base, timings: store({ [timingKey('final', 'npm test')]: [min] }) }), { ms: 120 * min, source: 'unmeasured' })
  assert.deepEqual(closingReserve({ ...base, timings, optionHours: 1 }), { ms: 60 * min, source: 'option' })
})

test('the closing window starts no new work and still runs the one gate and push', async (t) => {
  const { root } = await fixture(t)
  const start = Date.now()
  let now = start, calls = 0, checks = 0, pushes = 0
  // Nothing measured yet: the first run reserves 20% of 10 hours.
  const result = await vibeLoop({ ...opts(root), maxUnits: 10, maxHours: 10 }, { preflight: passed, now: () => now,
    execute: async (options, job) => { calls++; now += 3 * 3600000; return completeTask(root, job.brief.taskId, `// ${calls}\n`) },
    check: async (options) => { checks++; assert.equal(options.tier, 'batch'); assert.ok(options.timeoutMs <= 3600000); return { ok: true } },
    push: async () => { pushes++; return { ok: true, pushed: null } },
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.reason, 'final-window'); assert.equal(calls, 3)
  assert.equal(checks, 1); assert.ok(pushes >= 1)
  assert.equal(result.reserve.source, 'unmeasured')
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
  assert.equal(Date.parse(manifest.workDeadline), start + 8 * 3600000)
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /node --version: pass/)
  await assert.rejects(vibeLoop({ ...opts(root), tag: 't063', maxHours: 2, finalReserveHours: 2, dryRun: true }), /final-reserve-hours/)
  // The unit durations of this run are now measured; the gate is not (the check was injected).
  assert.equal((await vibeLoop({ ...opts(root), tag: 't063', maxHours: 8, dryRun: true })).reserve.ms, 96 * 60000)
})

for (const fixed of [true, false]) test(`a failed closing gate queues one repair inside the reserve, then re-runs the gate (fixed=${fixed})`, async (t) => {
  const { root } = await fixture(t)
  let now = Date.now(), checks = 0, pushes = 0
  const jobs = []
  const result = await vibeLoop({ ...opts(root), maxUnits: 10, maxHours: 10 }, { preflight: passed, now: () => now,
    execute: async (options, job, directory, limits) => {
      jobs.push({ task: job.brief?.taskId, timeoutMs: limits.timeoutMs })
      if (job.brief?.taskId === 'T004') { now += 30 * 60000; return completeTask(root, 'T004') }
      now += 3 * 3600000; return completeTask(root, job.brief.taskId, `// ${jobs.length}\n`)
    },
    check: async () => { checks++; return checks === 1 || !fixed ? { ok: false, log: '/test/log', failedTests: ['FAIL checkout total'], tail: ['1 failed'] } : { ok: true } },
    push: async () => { pushes++; return { ok: true, pushed: null } },
  })
  // Units at 0h, 3h, 6h; the window opens at 8h; the repair gets the time left before the deadline.
  assert.deepEqual(jobs.map((job) => job.task), ['T001', 'T002', 'T003', 'T004'])
  assert.ok(jobs[3].timeoutMs <= 3600000)
  assert.match(await readFile(path.join(root, 'spec/tasks/done/T004.fix-gate.md'), 'utf8'), /FAIL checkout total/)
  if (fixed) {
    assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'final-window'); assert.equal(checks, 2); assert.ok(pushes >= 1)
  } else {
    // The repair did not help: no third run, no code push, the next repair waits for the next run.
    assert.equal(result.ok, false); assert.match(result.error, /묶음 검증 실패/); assert.equal(checks, 2)
    assert.equal(result.priorityTask, 'T005')
  }
})

test('batch gate and CI run once for multiple task commits, entirely outside model dispatch', async (t) => {
  const { root } = await fixture(t)
  let calls = 0, checks = 0, waits = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 2 }, { preflight: passed,
    execute: async (options, job) => { calls++; return completeTask(root, job.brief.taskId, `// ${calls}\n`) },
    check: async (options) => { checks++; assert.equal(options.tier, 'batch'); return { ok: true } },
    push: async () => ({ ok: true, pushed: await git(root, 'rev-parse', 'HEAD') }),
    ci: async () => { waits++; assert.equal(calls, 2); return { ok: true, outcome: 'success', jobs: [] } },
  })
  assert.equal(result.ok, true, result.error); assert.equal(checks, 1); assert.equal(waits, 1)
})

test('failed batch gate prevents code push and preserves commits and logs', async (t) => {
  const { root } = await fixture(t)
  const result = await vibeLoop({ ...opts(root), maxUnits: 1 }, { preflight: passed,
    execute: async (options, job) => { return completeTask(root, job.brief.taskId, '// changed\n') },
    check: async () => ({ ok: false, log: '/test/log' }), push: () => assert.fail('gate failed'),
  })
  assert.equal(result.ok, false); assert.match(result.error, /묶음 검증 실패/)
  assert.match(await readFile(path.join(root, 'app.js'), 'utf8'), /changed/)
})

test('CI failure at the unit limit preserves a prioritized fix task with evidence for resumption', async (t) => {
  const { root } = await fixture(t)
  const result = await vibeLoop({ ...opts(root), maxUnits: 1 }, { preflight: passed,
    execute: async (options, job) => { return completeTask(root, job.brief.taskId, '// code\n') },
    check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: await git(root, 'rev-parse', 'HEAD') }),
    ci: async () => ({ ok: false, outcome: 'failure', runUrl: 'https://example.test/run/1', jobs: [{ name: 'unit', conclusion: 'failure', failedSteps: ['Regression'] }] }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'max-units'); assert.equal(result.priorityTask, 'T004')
  assert.match(await readFile(path.join(root, 'spec/tasks/T004.fix-ci.md'), 'utf8'), /Regression/)
  assert.match(await readFile(path.join(root, 'spec/STATE.md'), 'utf8'), /gusta-implement-task T004/)
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /priority task: T004/)
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /CI .*failure https:\/\/example.test\/run\/1/)
  assert.equal((await readFile(path.join(root, result.report), 'utf8')).match(/task T001: completed/g).length, 1)
  assert.equal(JSON.parse(await readFile(result.manifest, 'utf8')).priorityTask, 'T004')
})

test('unchecked CI (nobody can read it) neither stops the run nor queues a repair; the report asks the owner to check later', async (t) => {
  const { root } = await fixture(t)
  const result = await vibeLoop({ ...opts(root), maxUnits: 1 }, { preflight: passed,
    execute: async (options, job) => { return completeTask(root, job.brief.taskId, '// code\n') },
    check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: await git(root, 'rev-parse', 'HEAD') }),
    ci: async ({ commit }) => ({ ok: true, outcome: 'unchecked', reason: 'no-ci-access', commit, runUrl: null, checkUrl: `https://github.com/owner/project/commit/${commit}`, jobs: [] }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'max-units'); assert.equal(result.priorityTask, null)
  assert.ok(!(await readdir(path.join(root, 'spec/tasks'))).some((name) => name.includes('fix-ci')))
  const report = await readFile(path.join(root, result.report), 'utf8')
  assert.match(report, /- CI \w+: unchecked \(no-ci-access\) https:\/\/github.com\/owner\/project\/commit\//)
  assert.match(report, /## next[\s\S]*- check CI later: \w+ https:\/\/github.com\/owner\/project\/commit\//)
})

test('a pending CI repair keeps priority when the same loop is restarted after a limit', async (t) => {
  const { root } = await fixture(t)
  const deps = { preflight: passed, check: async () => ({ ok: true }),
    push: async () => ({ ok: true, pushed: await git(root, 'rev-parse', 'HEAD') }) }
  const first = await vibeLoop({ ...opts(root), maxUnits: 1 }, { ...deps,
    execute: async (options, job) => completeTask(root, job.brief.taskId),
    ci: async () => ({ ok: false, outcome: 'failure', jobs: [] }),
  })
  assert.equal(first.priorityTask, 'T004')
  const resumed = await vibeLoop({ ...opts(root), maxUnits: 1 }, { ...deps,
    execute: async (options, job) => { assert.equal(job.brief.taskId, 'T004'); return completeTask(root, 'T004') },
    ci: async () => ({ ok: true, outcome: 'success', jobs: [] }),
  })
  assert.equal(resumed.ok, true, resumed.error); assert.equal(resumed.priorityTask, null)
})

test('batch boundaries only record the report; the gate, push and CI run once the work runs out', async (t) => {
  const { root } = await fixture(t)
  const selected = []; let waits = 0, checks = 0, probes = 0, pushes = 0
  const result = await vibeLoop({ ...opts(root), batchSize: 1, maxUnits: 6 }, {
    preflight: async () => { probes++; return passed() },
    execute: async (options, job) => {
      const id = job.brief.taskId; selected.push(id)
      if (id === 'T004') assert.match(await readFile(path.join(root, 'spec/tasks/T004.fix-ci.md'), 'utf8'), /Regression/)
      return completeTask(root, id)
    },
    check: async () => { checks++; return { ok: true } },
    push: async () => { pushes++; return { ok: true, pushed: await git(root, 'rev-parse', 'HEAD') } },
    ci: async () => ++waits === 1
      ? { ok: false, outcome: 'failure', runUrl: 'https://example.test/run/1', jobs: [{ name: 'unit', failedSteps: ['Regression'] }] }
      : { ok: true, outcome: 'success', jobs: [] },
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'no-work')
  // The CI repair still runs before the loop ends, without another preflight.
  assert.deepEqual(selected, ['T001', 'T002', 'T003', 'T004'])
  assert.equal(probes, 1); assert.equal(checks, 2); assert.equal(waits, 2)
  assert.ok(pushes <= 3, `pushes: ${pushes}`)
  assert.equal(result.priorityTask, null)
})

test('CI failure on the last task creates new work and repairs it before no-work termination', async (t) => {
  const { root } = await fixture(t, 1)
  const selected = []; let waits = 0, checks = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 5 }, { preflight: passed,
    execute: async (options, job) => { selected.push(job.brief.taskId); return completeTask(root, job.brief.taskId) },
    check: async () => { checks++; return { ok: true } },
    push: async () => ({ ok: true, pushed: await git(root, 'rev-parse', 'HEAD') }),
    ci: async () => ++waits === 1
      ? { ok: false, outcome: 'failure', runUrl: 'https://example.test/run/1', jobs: [{ name: 'unit', failedSteps: ['Regression'] }] }
      : { ok: true, outcome: 'success', jobs: [] },
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'no-work')
  assert.deepEqual(selected, ['T001', 'T002']); assert.equal(checks, 2); assert.equal(waits, 2)
  assert.equal(result.priorityTask, null)
  await sessionGone(root)
})

test('a blocked-only task gets a planning recovery unit, then resumes implementation', async (t) => {
  const { root } = await fixture(t, 1)
  let calls = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 5 }, { preflight: passed,
    execute: async (options, job) => {
      calls++; assert.equal(job.brief.taskId, 'T001')
      // A task unit gets its own row and totals; the planning recovery keeps every remaining row.
      if (calls === 2) assert.deepEqual(job.status.remaining.map((task) => task.id), ['T001'])
      else { assert.equal(job.status.remaining, undefined); assert.equal(job.status.task.id, 'T001'); assert.equal(job.status.counts.remaining, 1) }
      const stateFile = path.join(root, 'spec/STATE.md'), taskFile = path.join(root, 'spec/tasks/T001.example.md')
      if (calls === 1) {
        await writeFile(stateFile, (await readFile(stateFile, 'utf8')).replace('| todo |', '| blocked@261020 |'))
        await writeFile(taskFile, (await readFile(taskFile, 'utf8')).replace('st:todo', 'st:blocked@261020') + '- outcome: blocked: choose the approved prerequisite order\n')
        await git(root, 'add', 'spec'); await git(root, 'commit', '-q', '-m', 'record blocker')
        return unit('blocked')
      }
      if (calls === 2) {
        assert.equal(job.status.parkedOnly, true)
        assert.equal(job.recovery.reason, 'blocked-task'); assert.equal(job.recovery.taskId, 'T001')
        await writeFile(stateFile, (await readFile(stateFile, 'utf8')).replace('blocked@261020', 'todo'))
        await vibeInbox({ targetRoot: root, step: 'add', tag: options.tag, kind: 'decided', ref: ['T001'], text: 'approved prerequisite first (alt: wait) — no implementation dependency' })
        await writeFile(taskFile, (await readFile(taskFile, 'utf8')).replace('blocked@261020', 'todo'))
        await git(root, 'add', 'spec'); await git(root, 'commit', '-q', '-m', 'resolve planning')
        return { exitCode: 0, result: { kind: 'planning', id: 'T001', outcome: 'completed', pushed: false, next: 'implementation' } }
      }
      assert.equal(job.recovery, undefined)
      return completeTask(root, 'T001')
    },
    check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'no-work'); assert.equal(calls, 3)
  // The decision the unit recorded is on the coordination branch and in the report, not in STATE.
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /^- \d{6} decided T001: approved prerequisite first/m)
  assert.deepEqual((await sessions(root)).inbox.map((line) => line.replace(/^- \d{6} /, '')), ['decided T001: approved prerequisite first (alt: wait) — no implementation dependency'])
  await sessionGone(root)
})

test('parked authorization affects only that task while other runnable tasks continue', async (t) => {
  const { root } = await fixture(t, 2)
  const selected = []
  const result = await vibeLoop({ ...opts(root), maxUnits: 5 }, { preflight: passed,
    execute: async (options, job) => {
      const id = job.brief.taskId; selected.push(id); assert.equal(job.recovery, undefined)
      if (id === 'T002') return completeTask(root, id)
      // Parking is one inbox line on the coordination branch: no file, no commit — and still progress.
      await vibeInbox({ targetRoot: root, step: 'add', tag: options.tag, kind: 'parked', ref: ['T001'], text: 'production deploy needs authorization' })
      assert.equal(await git(root, 'status', '--porcelain'), '')
      return unit('parked')
    }, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'parked-only')
  assert.deepEqual(selected, ['T001', 'T002'])
  assert.match((await sessions(root)).inbox.join('\n'), /parked T001: production deploy needs authorization/)
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /## parked\n- \d{6} parked T001: production deploy needs authorization/)
  await sessionGone(root)
})

test('recovery still stops repeated blocked units with no progress', async (t) => {
  const { root } = await fixture(t, 1)
  let calls = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 10 }, { preflight: passed,
    execute: async (options, job) => { if (++calls === 2) assert.equal(job.recovery.taskId, 'T001'); return unit('blocked') },
  })
  assert.equal(result.reason, 'no-progress'); assert.equal(calls, 2)
})

test('an existing blocked task is recovered even without a previous loop manifest', async (t) => {
  const { root } = await fixture(t, 1)
  const stateFile = path.join(root, 'spec/STATE.md'), taskFile = path.join(root, 'spec/tasks/T001.example.md')
  await writeFile(stateFile, (await readFile(stateFile, 'utf8')).replace('| todo |', '| blocked@261020 |'))
  await writeFile(taskFile, (await readFile(taskFile, 'utf8')).replace('st:todo', 'st:blocked@261020'))
  await git(root, 'add', 'spec'); await git(root, 'commit', '-q', '-m', 'existing blocker')
  const result = await vibeLoop({ ...opts(root), maxUnits: 1 }, { preflight: passed,
    execute: async (options, job) => { assert.equal(job.recovery.taskId, 'T001'); return completeTask(root, 'T001') },
    check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.units, 1)
})

test('metadata-only units do not run batch suites or wait on CI', async (t) => {
  const { root } = await fixture(t)
  let calls = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 3 }, { preflight: passed,
    execute: async () => {
      const file = path.join(root, 'spec/STATE.md')
      await writeFile(file, (await readFile(file, 'utf8')) + `\n- planning step ${++calls}\n`)
      await git(root, 'add', 'spec/STATE.md'); await git(root, 'commit', '-q', '-m', 'planning')
      return { exitCode: 0, result: { kind: 'planning', id: '', outcome: 'completed', pushed: false, next: 'implementation' } }
    }, check: () => assert.fail('no code batch'), ci: () => assert.fail('no code CI'),
    push: async () => ({ ok: true, pushed: await git(root, 'rev-parse', 'HEAD') }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(calls, 3)
})

test('a stop marker terminates an active command adapter rather than starting another session', async (t) => {
  const { root, temporary, initial } = await fixture(t)
  const adapter = await fakeAdapter(temporary, 'setTimeout(()=>{},20000);')
  const directory = path.join(temporary, 'logs'); await mkdir(directory)
  const stopFile = path.join(directory, 'STOP'); await writeFile(stopFile, 'stop')
  const r = await executeVibeUnit({ adapter, tag: 't060' }, { workspace: root, role: 'unit', diffBase: initial }, directory, { stopFile, deadline: Date.now() + 10000, timeoutMs: 10000 })
  assert.equal(r.stopped, 'stop-file'); assert.equal(r.result, null)
  assert.ok(await readFile(r.log, 'utf8') !== undefined)
})

test('the unit log follows the adapter live, before the unit process exits', async (t) => {
  const { root, temporary, initial } = await fixture(t)
  const directory = path.join(temporary, 'logs'); await mkdir(directory)
  const release = path.join(temporary, 'release')
  // The adapter answers only after the host has the progress lines on disk; a buffered log times out (exit 3).
  const adapter = await fakeAdapter(temporary, `process.stdout.write('progress-out\\n');process.stderr.write('progress-err\\n');const started=Date.now();
    const wait=()=>{if(fs.existsSync(${JSON.stringify(release)}))console.log(JSON.stringify({kind:'task',id:'T001',outcome:'completed',pushed:false,next:'implementation'}));else if(Date.now()-started>5000)process.exit(3);else setTimeout(wait,10)};wait();`)
  const running = executeVibeUnit({ adapter, tag: 't060' }, { workspace: root, role: 'unit', diffBase: initial }, directory, { stopFile: path.join(directory, 'STOP'), deadline: Date.now() + 60000, timeoutMs: 60000 })
  let seen = ''
  for (let i = 0; i < 250 && !(seen.includes('progress-out') && seen.includes('progress-err')); i++) {
    const name = (await readdir(directory)).find((entry) => entry.endsWith('.log'))
    seen = name ? await readFile(path.join(directory, name), 'utf8') : ''
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const live = seen.includes('progress-out')
  await writeFile(release, 'go')
  const r = await running
  assert.ok(live, 'adapter stdout reached the unit log while the unit ran')
  assert.equal(r.result?.id, 'T001', r.error)
  assert.match(await readFile(r.log, 'utf8'), /progress-out[\s\S]*"kind":"task"/)
})

test('a built-in Claude unit carries the optional flags the installed CLI lists', async (t) => {
  const { root, temporary, initial } = await fixture(t)
  const bin = path.join(temporary, 'bin'); await mkdir(bin)
  const flag = '--exclude-dynamic-system-prompt-sections', args = path.join(temporary, 'claude-args.json')
  await writeFile(path.join(bin, 'claude'), `#!${process.execPath}\nconst a=process.argv.slice(2);if(a.includes('--help'))console.log('--print ${flag}');else{process.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(args)},JSON.stringify(a));console.log(JSON.stringify({type:'result',is_error:false,structured_output:{kind:'none',id:'',outcome:'no_work',pushed:false,next:'stop'}}))})}`, { mode: 0o755 })
  const directory = path.join(temporary, 'logs'); await mkdir(directory)
  const r = await executeVibeUnit({ provider: 'claude', tag: 't060', env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } }, { workspace: root, role: 'unit', diffBase: initial }, directory, { stopFile: path.join(directory, 'STOP'), deadline: Date.now() + 60000, timeoutMs: 60000 })
  assert.equal(r.result?.outcome, 'no_work', r.error)
  assert.ok(JSON.parse(await readFile(args, 'utf8')).includes(flag))
})

test('detached host survives parent return and writes its final manifest with one shared report', async (t) => {
  const { root, temporary } = await fixture(t)
  const bin = path.join(temporary, 'bin'); await mkdir(bin)
  await writeFile(path.join(bin, 'claude'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({structured_output:{ran:true,exitCode:0,denied:false,note:'fake main checkout probe'}})));`, { mode: 0o755 })
  const adapter = await fakeAdapter(temporary, "console.log(JSON.stringify({kind:'none',id:'',outcome:'no_work',pushed:false,next:'stop'}));")
  // The detached host delivers its own finished summary through the notification hook.
  const hook = path.join(temporary, 'notify.cjs'), notified = path.join(temporary, 'notified.jsonl')
  await writeFile(hook, `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>require('node:fs').appendFileSync(process.argv[2],input));`)
  const notifyCommand = [process.execPath, hook, notified].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ')
  const result = await vibeLoop({ ...opts(root), adapter, provider: undefined, detach: true, notifyCommand, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } })
  assert.equal(result.detached, true); assert.ok(result.pid)
  t.after(() => { try { process.kill(-result.pid, 'SIGTERM') } catch {} })
  let state
  for (let i = 0; i < 150; i++) {
    try { state = JSON.parse(await readFile(result.manifest, 'utf8')) } catch {}
    if (state?.reason) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(state?.reason, 'no-progress', await readFile(result.log, 'utf8'))
  assert.equal(state.units, 2)
  assert.doesNotMatch(await readFile(path.join(root, state.report), 'utf8'), /to:-/)
  // The reason is written before the host and its supervisor finish their last event
  // writes; removing the fixture under them races (ENOTEMPTY). Wait for both to exit.
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  for (let i = 0; i < 200 && [result.pid, state.supervisor?.pid].some((pid) => pid && alive(pid)); i++) await new Promise((resolve) => setTimeout(resolve, 50))
  const notices = (await readFile(notified, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(notices.map(({ type, level, reason, units, report }) => ({ type, level, reason, units, report })), [{ type: 'finished', level: 'info', reason: 'no-progress', units: 2, report: state.report }])
})

for (const pushEachUnit of [false, true]) test(`strict concurrency runs one final gate by default; per-unit push=${pushEachUnit}`, async (t) => {
  const { root } = await fixture(t)
  const file = path.join(root, 'spec/STATE.md')
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: true\n'); await git(root, 'add', 'spec/SETTINGS.md'); await git(root, 'commit', '-qam', 'push branch')
  let checks = 0, pushes = 0, n = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 3, pushEachUnit }, { preflight: passed,
    status: async (options) => ({ ...await vibeStatus(options), concurrency: 'strict' }),
    claim: async () => ({ ok: true }),
    execute: async (_options, job) => completeTask(root, job.brief.taskId, `// ${++n}\n`),
    sync: async () => ({ ok: true }),
    check: async () => { checks++; return { ok: true } }, push: async (options) => { pushes++; assert.ok(options.verifiedCommit); return { ok: true, pushed: null } },
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(checks, pushEachUnit ? 3 : 1)
  assert.equal(pushes, pushEachUnit ? 3 : 1)
})

test('unit assignment status: a task unit drops the remaining rows, a split or blocked recovery keeps them', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `T00${i + 1}`)
  const status = { tag: 't060', route: 'implementation', parkedOnly: false, concurrency: 'solo', next: ['- gusta-implement-task T001'],
    counts: { inbox: 2, parked: 0, remaining: 8 }, remaining: ids.map((id) => ({ id, title: `task ${id}`, dep: '-', st: 'todo' })), runnable: ids,
    implementation: { todo: ids, resume: [], blocked: [], explore: [{ id: 'T008', timebox: '1h' }] }, sketch: { pending: [], reviews: [], ideation: [] } }
  const trimmed = unitStatus(status, 'T007', null)
  assert.equal(trimmed.remaining, undefined)
  assert.deepEqual(trimmed.task, { id: 'T007', title: 'task T007', dep: '-', st: 'todo' })
  // The cut keeps the unit's own task (past the first five here) at the head of each list.
  const head = ['T007', ...ids.slice(0, UNIT_LISTED - 1)]
  assert.deepEqual(trimmed.runnable, head); assert.deepEqual(trimmed.implementation.todo, head)
  assert.deepEqual(unitStatus(status, 'T002', null).runnable, ['T002', 'T001', 'T003', 'T004', 'T005'])
  assert.deepEqual(trimmed.counts, { inbox: 2, parked: 0, remaining: 8, runnable: 8, todo: 8 })
  assert.deepEqual(trimmed.implementation.explore, status.implementation.explore)
  assert.match(trimmed.listed, /vibe status --tag t060 --no-fetch --json/)
  for (const key of ['route', 'parkedOnly', 'concurrency', 'next', 'sketch']) assert.deepEqual(trimmed[key], status[key])
  // A continuation still implements its task; a split and a blocked recovery rewrite tasks and deps.
  assert.equal(unitStatus(status, 'T007', { reason: 'interrupted', taskId: 'T007' }).remaining, undefined)
  for (const [selected, recovery] of [[null, null], ['T007', { reason: 'split', taskId: 'T007' }], ['T007', { reason: 'blocked-task', taskId: 'T007' }]]) assert.equal(unitStatus(status, selected, recovery), status)
  const stub = { route: 'implementation', parkedOnly: true }
  assert.equal(unitStatus(stub, 'T001', null), stub)
})

test('one fetch per unit boundary: every unit claims on that read, and the post-unit status stays local', async (t) => {
  const { root } = await fixture(t)
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: true\n'); await git(root, 'add', 'spec/SETTINGS.md'); await git(root, 'commit', '-qam', 'push branch')
  const calls = []
  const result = await vibeLoop({ ...opts(root), maxUnits: 3 }, { preflight: passed,
    status: async (options) => { calls.push(options.fetch === false ? 'local' : 'fetch'); return vibeStatus(options) },
    claim: async (options) => { calls.push(`claim ${options.task}`); assert.equal(options.mode, 'autopilot'); return { ok: true } },
    execute: async (options, job) => { calls.push('unit'); return completeTask(root, job.brief.taskId) },
    sync: async () => ({ ok: true }), check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.units, 3)
  // The first read is the host's setup; each boundary then fetches once and claims on that read.
  // The claim changes nothing in the tree, so nothing is read again before the unit.
  assert.deepEqual(calls.slice(1), ['fetch', 'claim T001', 'unit', 'local', 'fetch', 'claim T002', 'unit', 'local', 'fetch', 'claim T003', 'unit', 'local'])
})

test('hourly snapshots span fresh unit sessions instead of resetting at each launch', async (t) => {
  const { root } = await fixture(t, 4)
  let now = Date.now(), n = 0, snapshots = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 4, maxHours: 5 }, { preflight: passed, now: () => now,
    execute: async (_options, job) => { now += 30 * 60000; return completeTask(root, job.brief.taskId, `// ${++n}\n`) },
    checkpoint: async () => { snapshots++ }, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.units, 4); assert.equal(snapshots, 2)
})

test('time breakdown separates model, task-check, gate, CI and host time and names the slowest unit', async () => {
  const { timeBreakdown, timeLine } = await import('../src/loop-time.mjs')
  const task = (id, ms, checkMs, kind = 'task') => ({ unit: Number(id.slice(1)), ms, checks: { runs: 2, cached: 0, ms: checkMs }, usage: { input: 1, cacheWrite: 10, cacheRead: 100, output: 5 }, result: { kind, id, outcome: 'completed' } })
  const time = timeBreakdown({ totalMs: 300 * 60000, batches: [{ command: 'npm test', ok: true, ms: 30 * 60000 }, { command: 'npm test', ok: true, cached: true }, { ci: { outcome: 'success', ms: 6 * 60000 } }],
    dispatches: [task('T001', 90 * 60000, 20 * 60000), task('T002', 60 * 60000, 10 * 60000), task('P1', 40 * 60000, 0, 'planning'), { unit: 4, ms: 5 * 60000, exitCode: 1, result: null }] })
  assert.deepEqual(time.units.implementation, { units: 2, ms: 150 * 60000, checkMs: 30 * 60000, modelMs: 120 * 60000 })
  assert.equal(time.units.planning.units, 1); assert.equal(time.units.failed.ms, 5 * 60000)
  assert.equal(time.gateMs, 30 * 60000); assert.equal(time.ciMs, 6 * 60000); assert.equal(time.hostMs, (300 - 195 - 36) * 60000)
  assert.deepEqual(time.tokens, { input: 3, cacheWrite: 30, cacheRead: 300, output: 15 })
  assert.equal(time.slowest[0].id, 'T001')
  assert.equal(timeLine(time), '- time: 5h00m — implementation 2h30m/2 (model 2h00m, task checks 30m), planning 40m/1, failed 5m/1, gate 30m, CI 6m, host 1h09m; slowest T001 1h30m; input 0.0M tokens, cache read 90%')
  assert.doesNotMatch(timeLine({ ...time, tokens: null }), /cache read/)
})

test('the loop result, manifest and closing report carry the time breakdown', async (t) => {
  const { root } = await fixture(t)
  let calls = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 2 }, { preflight: passed,
    execute: async (_options, job) => ({ ...(await completeTask(root, job.brief.taskId, `// ${++calls}\n`)),
      checks: { runs: 1, cached: 0, ms: 1000 }, usage: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 } }),
    check: async () => ({ ok: true, ms: 120000 }),
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.time.units.implementation.units, 2); assert.equal(result.time.units.implementation.checkMs, 2000)
  assert.equal(result.time.gateMs, 120000); assert.deepEqual(result.time.tokens, { input: 2, cacheWrite: 4, cacheRead: 6, output: 8 })
  assert.equal(JSON.parse(await readFile(result.manifest, 'utf8')).time.units.implementation.units, 2)
  const report = await readFile(path.join(root, result.report), 'utf8')
  assert.equal(report.match(/^- time: /gm)?.length, 1); assert.match(report, /- time: .*implementation \d+m\/2.*gate 2m/)
})

test('a unit session records its vibe check runs and token usage for the breakdown', async (t) => {
  const { root, temporary, initial } = await fixture(t)
  const cli = path.resolve('bin/gusta.mjs')
  const adapter = await fakeAdapter(temporary, `
    cp.execFileSync(process.execPath,[${JSON.stringify(cli)},'vibe','check','--tier','task','--','node -e "setTimeout(()=>{},50)"'],{stdio:'ignore'});
    console.log(JSON.stringify({kind:'task',id:'T001',outcome:'completed',pushed:false,next:'implementation',usage:{input_tokens:3,cache_creation_input_tokens:4,cache_read_input_tokens:5,output_tokens:6,iterations:[]}}));`)
  const directory = path.join(temporary, 'logs'); await mkdir(directory)
  const r = await executeVibeUnit({ adapter, tag: 't060' }, { workspace: root, role: 'unit', diffBase: initial }, directory, { stopFile: path.join(directory, 'STOP'), deadline: Date.now() + 60000, timeoutMs: 60000 })
  assert.equal(r.result.id, 'T001'); assert.deepEqual(r.usage, { input: 3, cacheWrite: 4, cacheRead: 5, output: 6 })
  assert.equal(r.checks.runs, 1); assert.equal(r.checks.cached, 0); assert.ok(r.checks.ms >= 50)
})
