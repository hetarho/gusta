import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git } from './helpers/vibe-fixture.mjs'
import { vibeLoop, executeVibeUnit, closingReserve } from '../src/vibe-loop.mjs'
import { timingKey } from '../src/check-cache.mjs'
import { vibeStatus } from '../src/vibe.mjs'
import { activeRows } from '../src/state-doc.mjs'

const passed = async () => ({ ok: true, checks: [] })
const unit = (outcome = 'completed') => ({ exitCode: 0, result: { kind: 'task', id: 'T001', outcome, pushed: false, next: 'implementation' } })
const opts = (root) => ({ targetRoot: root, tag: 't060', provider: 'claude', maxUnits: 3 })
async function completeTask(root, id) {
  const name = (await readdir(path.join(root, 'spec/tasks'))).find((name) => name.startsWith(`${id}.`))
  await git(root, 'mv', `spec/tasks/${name}`, `spec/tasks/done/${name}`)
  const file = path.join(root, 'spec/STATE.md')
  const state = (await readFile(file, 'utf8')).split('\n').filter((line) => !line.startsWith(`| ${id} |`)).join('\n')
  await writeFile(file, state)
  await writeFile(path.join(root, 'app.js'), `// ${id}\n`)
  await git(root, 'add', 'spec', 'app.js')
  await git(root, 'commit', '-q', '-m', `${id} done`)
  return { exitCode: 0, result: { kind: 'task', id, outcome: 'completed', pushed: false, next: 'implementation' } }
}
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
  assert.equal(await git(root, 'rev-parse', 'HEAD'), initial)
  assert.equal(await git(root, 'status', '--porcelain'), '')
})

test('command adapter runs one new process/session per task, preflights once, and shares one report/tag', async (t) => {
  const { root, temporary } = await fixture(t)
  const records = path.join(temporary, 'records.jsonl')
  const adapter = await fakeAdapter(temporary, `
    fs.appendFileSync(${JSON.stringify(records)},JSON.stringify({pid:process.pid,tag:job.tag,report:job.report,base:job.diffBase,resume:job.resume})+'\\n');
    fs.writeFileSync(job.sessionFile,'session-'+process.pid);
    const stateFile='spec/STATE.md';let state=fs.readFileSync(stateFile,'utf8');
    const id=job.brief.taskId;state=state.split('\\n').filter(line=>!line.startsWith('| '+id+' |')).join('\\n');fs.writeFileSync(stateFile,state);
    fs.renameSync('spec/tasks/'+id+'.example.md','spec/tasks/done/'+id+'.example.md');
    cp.execFileSync('git',['add','spec']);cp.execFileSync('git',['commit','-q','-m',id+' done']);
    console.log(JSON.stringify({kind:'task',id,outcome:'completed',pushed:false,next:'implementation'}));`)
  let preflights = 0, pushes = 0
  const result = await vibeLoop({ ...opts(root), adapter, provider: undefined }, { preflight: async (options) => { preflights++; assert.equal(options.probeWorkspace, 'current'); return passed() }, push: async () => { pushes++; return { ok: true, pushed: null } } })
  assert.equal(result.ok, true, result.error); assert.equal(result.units, 3); assert.equal(preflights, 1)
  const rows = (await readFile(records, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(new Set(rows.map((row) => row.pid)).size, 3)
  assert.equal(new Set(rows.map((row) => row.report)).size, 1)
  assert.ok(rows.every((row) => row.tag === 't060' && row.resume === undefined))
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
  assert.equal(new Set(manifest.dispatches.map((row) => row.session)).size, 3)
  assert.equal(manifest.dispatches.filter((row) => row.log).length, 3)
  assert.ok(pushes <= 2)
  assert.deepEqual(activeRows(await readFile(path.join(root, 'spec/STATE.md'), 'utf8')), [])
  assert.doesNotMatch(await readFile(path.join(root, result.report), 'utf8'), /to:-/)
})

for (const [name, execute, expected] of [
  ['unchanged HEAD/STATE', async () => unit(), 'no-progress'],
  ['repeated session errors', async () => ({ exitCode: 1, result: null }), 'session-failures'],
]) test(`loop stops after two ${name}`, async (t) => {
  const { root } = await fixture(t)
  const result = await vibeLoop({ ...opts(root), maxUnits: 10 }, { preflight: passed, execute })
  assert.equal(result.reason, expected); assert.equal(result.units, 2)
  assert.deepEqual(activeRows(await readFile(path.join(root, 'spec/STATE.md'), 'utf8')), [])
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
  assert.equal(noWork.reason, 'no-work'); assert.equal(noWork.units, 0)
  let now = 0
  const timed = await vibeLoop({ ...opts(root), tag: 't062', maxHours: 1 }, { preflight: async () => { now = 3600001; return passed() }, now: () => now, execute: () => assert.fail('time limit') })
  assert.equal(timed.reason, 'max-hours')
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
    execute: async () => { calls++; now += 3 * 3600000; await writeFile(path.join(root, 'app.js'), `// ${calls}\n`); await git(root, 'add', 'app.js'); await git(root, 'commit', '-q', '-m', 'task'); return unit() },
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
      now += 3 * 3600000; await writeFile(path.join(root, 'app.js'), `// ${jobs.length}\n`); await git(root, 'add', 'app.js'); await git(root, 'commit', '-q', '-m', 'task'); return unit()
    },
    check: async () => { checks++; return checks === 1 || !fixed ? { ok: false, log: '/test/log', failedTests: ['FAIL checkout total'], tail: ['1 failed'] } : { ok: true } },
    push: async () => { pushes++; return { ok: true, pushed: null } },
  })
  // Units at 0h, 3h, 6h; the window opens at 8h; the repair gets the time left before the deadline.
  assert.deepEqual(jobs.map((job) => job.task), ['T001', 'T001', 'T001', 'T004'])
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
    execute: async () => { calls++; await writeFile(path.join(root, 'app.js'), `// ${calls}\n`); await git(root, 'add', 'app.js'); await git(root, 'commit', '-q', '-m', 'task'); return unit() },
    check: async (options) => { checks++; assert.equal(options.tier, 'batch'); return { ok: true } },
    push: async () => ({ ok: true, pushed: await git(root, 'rev-parse', 'HEAD') }),
    ci: async () => { waits++; assert.equal(calls, 2); return { ok: true, outcome: 'success', jobs: [] } },
  })
  assert.equal(result.ok, true, result.error); assert.equal(checks, 1); assert.equal(waits, 1)
})

test('failed batch gate prevents code push and preserves commits and logs', async (t) => {
  const { root } = await fixture(t)
  const result = await vibeLoop({ ...opts(root), maxUnits: 1 }, { preflight: passed,
    execute: async () => { await writeFile(path.join(root, 'app.js'), '// changed\n'); await git(root, 'add', 'app.js'); await git(root, 'commit', '-q', '-m', 'task'); return unit() },
    check: async () => ({ ok: false, log: '/test/log' }), push: () => assert.fail('gate failed'),
  })
  assert.equal(result.ok, false); assert.match(result.error, /묶음 검증 실패/)
  assert.match(await readFile(path.join(root, 'app.js'), 'utf8'), /changed/)
})

test('CI failure at the unit limit preserves a prioritized fix task with evidence for resumption', async (t) => {
  const { root } = await fixture(t)
  const result = await vibeLoop({ ...opts(root), maxUnits: 1 }, { preflight: passed,
    execute: async () => { await writeFile(path.join(root, 'app.js'), '// code\n'); await git(root, 'add', 'app.js'); await git(root, 'commit', '-q', '-m', 'task'); return unit() },
    check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: await git(root, 'rev-parse', 'HEAD') }),
    ci: async () => ({ ok: false, outcome: 'failure', runUrl: 'https://example.test/run/1', jobs: [{ name: 'unit', conclusion: 'failure', failedSteps: ['Regression'] }] }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'max-units'); assert.equal(result.priorityTask, 'T004')
  assert.match(await readFile(path.join(root, 'spec/tasks/T004.fix-ci.md'), 'utf8'), /Regression/)
  assert.match(await readFile(path.join(root, 'spec/STATE.md'), 'utf8'), /implement-task T004/)
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /priority task: T004/)
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /CI .*failure https:\/\/example.test\/run\/1/)
  assert.equal((await readFile(path.join(root, result.report), 'utf8')).match(/task T001: completed/g).length, 1)
  assert.equal(JSON.parse(await readFile(result.manifest, 'utf8')).priorityTask, 'T004')
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
  assert.deepEqual(activeRows(await readFile(path.join(root, 'spec/STATE.md'), 'utf8')), [])
})

test('a blocked-only task gets a planning recovery unit, then resumes implementation', async (t) => {
  const { root } = await fixture(t, 1)
  let calls = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 5 }, { preflight: passed,
    execute: async (options, job) => {
      calls++; assert.equal(job.brief.taskId, 'T001')
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
        await writeFile(stateFile, (await readFile(stateFile, 'utf8')).replace('blocked@261020', 'todo').replace('## next', '## inbox\n- 261020 decided T001: approved prerequisite first (alt: wait) — no implementation dependency\n\n## next'))
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
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /decided T001/)
})

test('parked authorization affects only that task while other runnable tasks continue', async (t) => {
  const { root } = await fixture(t, 2)
  const selected = []
  const result = await vibeLoop({ ...opts(root), maxUnits: 5 }, { preflight: passed,
    execute: async (options, job) => {
      const id = job.brief.taskId; selected.push(id); assert.equal(job.recovery, undefined)
      if (id === 'T002') return completeTask(root, id)
      const file = path.join(root, 'spec/STATE.md')
      await writeFile(file, (await readFile(file, 'utf8')).replace('## next', '## inbox\n- 261020 parked T001: production deploy needs authorization\n\n## next'))
      await git(root, 'add', 'spec'); await git(root, 'commit', '-q', '-m', 'park deploy')
      return unit('parked')
    }, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'parked-only')
  assert.deepEqual(selected, ['T001', 'T002'])
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

test('detached host survives parent return and writes its final manifest with one shared report', async (t) => {
  const { root, temporary } = await fixture(t)
  const bin = path.join(temporary, 'bin'); await mkdir(bin)
  await writeFile(path.join(bin, 'claude'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({structured_output:{ran:true,exitCode:0,denied:false,note:'fake main checkout probe'}})));`, { mode: 0o755 })
  const adapter = await fakeAdapter(temporary, "console.log(JSON.stringify({kind:'none',id:'',outcome:'no_work',pushed:false,next:'stop'}));")
  const result = await vibeLoop({ ...opts(root), adapter, provider: undefined, detach: true, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } })
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
})

for (const pushEachUnit of [false, true]) test(`strict concurrency runs one final gate by default; per-unit push=${pushEachUnit}`, async (t) => {
  const { root } = await fixture(t)
  const file = path.join(root, 'spec/STATE.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('- push: -', '- push: main')); await git(root, 'commit', '-qam', 'push branch')
  let checks = 0, pushes = 0, n = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 3, pushEachUnit }, { preflight: passed,
    status: async (options) => ({ ...await vibeStatus(options), concurrency: 'strict' }),
    claim: async () => ({ ok: true }),
    execute: async () => { await writeFile(path.join(root, 'app.js'), `// ${++n}\n`); await git(root, 'add', 'app.js'); await git(root, 'commit', '-q', '-m', 'task'); return unit() },
    sync: async () => ({ ok: true }),
    check: async () => { checks++; return { ok: true } }, push: async (options) => { pushes++; assert.ok(options.verifiedCommit); return { ok: true, pushed: null } },
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(checks, pushEachUnit ? 3 : 1)
  assert.equal(pushes, pushEachUnit ? 3 : 1)
})

test('hourly snapshots span fresh unit sessions instead of resetting at each launch', async (t) => {
  const { root } = await fixture(t)
  let now = Date.now(), n = 0, snapshots = 0
  const result = await vibeLoop({ ...opts(root), maxUnits: 4, maxHours: 5 }, { preflight: passed, now: () => now,
    execute: async () => { now += 30 * 60000; await writeFile(path.join(root, 'app.js'), `// ${++n}\n`); await git(root, 'add', 'app.js'); await git(root, 'commit', '-q', '-m', 'task'); return unit() },
    checkpoint: async () => { snapshots++ }, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.units, 4); assert.equal(snapshots, 2)
})
