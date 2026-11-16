import test from 'node:test'
import { vibeLoop, runVibeCheck } from './helpers/unit-policy.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, archiveTask } from './helpers/vibe-fixture.mjs'


const options = (root) => ({ targetRoot: root, tag: 'reliable', provider: 'codex', maxUnits: 8, pushEachUnit: true })
const passed = async () => ({ ok: true, checks: [] })
async function complete(root, id, n) {
  await archiveTask(root, id)
  await writeFile(path.join(root, 'app.js'), `// implementation ${n}\n`)
  await git(root, 'add', 'spec', 'app.js'); await git(root, 'commit', '-qm', `complete ${id}`)
  return { exitCode: 0, result: { kind: 'task', id, outcome: 'completed', pushed: false, next: 'implementation' } }
}
async function publishing(root) {
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: true\n')
  await git(root, 'add', 'spec/SETTINGS.md'); await git(root, 'commit', '-qm', 'publication settings')
}
const failure = (ids, extra = {}) => ({ ok: false, failedTests: ids, ms: 100, ...extra })

test('a repaired final gate publishes after earlier failed rounds', async (t) => {
  const { root } = await fixture(t, 1); await publishing(root)
  let checks = 0, units = 0, pushes = 0
  const result = await vibeLoop(options(root), { preflight: passed, sync: passed,
    execute: async (config, job) => complete(root, job.brief.taskId, ++units),
    check: async () => ++checks === 1 ? failure(['FAIL alpha', 'FAIL beta', 'FAIL gamma']) : checks === 2 ? failure(['FAIL beta']) : { ok: true },
    push: async () => { pushes++; return { ok: true, pushed: await git(root, 'rev-parse', 'HEAD') } }, ci: async () => ({ ok: true, outcome: 'success' }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(checks, 3); assert.equal(units, 3); assert.ok(pushes)
  assert.equal(result.gate.attempts, 3); assert.equal(result.gate.failures, 2); assert.equal(result.objectiveComplete, false)
  const terminal = JSON.parse(await readFile(result.notification.terminalEvent, 'utf8'))
  assert.equal(terminal.verification.attempts, 3); assert.equal(terminal.push.pushed, true)
  assert.equal(terminal.objectiveComplete, false); assert.equal(terminal.delivery, 'recorded-locally')
})

test('failed final gates keep queuing repairs past three failures until the candidate passes', async (t) => {
  const { root } = await fixture(t, 1); await publishing(root)
  let checks = 0, units = 0, pushes = 0
  const seen = []
  const result = await vibeLoop({ ...options(root), verify: ['check alpha', 'check beta'] }, { preflight: passed, sync: passed,
    execute: async (config, job) => complete(root, job.brief.taskId, ++units),
    check: async (config, command) => {
      const round = Math.floor(checks++ / 2); seen.push([round, command])
      // The same failure four rounds in a row, then a passing candidate.
      const ok = command === 'check alpha' || round >= 4
      return { ok, exitCode: ok ? 0 : 1, failedTests: ok ? [] : ['FAIL beta'], ms: 10 }
    },
    push: async () => { pushes++; return { ok: true, pushed: await git(root, 'rev-parse', 'HEAD') } }, ci: async () => ({ ok: true, outcome: 'success' }),
  })
  assert.equal(result.ok, true, result.error); assert.ok(pushes)
  assert.equal(units, 5); assert.equal(result.gate.attempts, 5); assert.equal(result.gate.failures, 4)
  assert.deepEqual(seen, Array.from({ length: 5 }, (_, n) => [[n, 'check alpha'], [n, 'check beta']]).flat())
})

test('repairs after a failed gate run until the deadline, which ends the loop without publishing', async (t) => {
  const { root } = await fixture(t, 1); await publishing(root)
  const start = Date.now(); let now = start, checks = 0, units = 0
  const result = await vibeLoop({ ...options(root), maxHours: 2, timeoutMs: 60000 }, { preflight: passed, sync: passed, now: () => now,
    // Each unit takes 70 minutes: the repair after the first failed gate ends past the deadline.
    execute: async (config, job) => { now += 70 * 60000; return complete(root, job.brief.taskId, ++units) },
    check: async () => { checks++; return failure(['FAIL alpha'], { ms: 30000 }) },
    push: () => assert.fail('failed code cannot publish'),
  })
  assert.deepEqual([checks, units, result.reason, result.codePushed], [1, 2, 'max-hours', false])
  assert.equal(result.continuation.deadline, new Date(start + 2 * 3600000).toISOString())
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /verification: 1 rounds, 1 failed; pending repair: T\d+; code pushed: false/)
})

test('live deadline and reserve apply at the next boundary in the same host with exact receipt', async (t) => {
  const { root } = await fixture(t)
  const start = Date.now(), deadline = new Date(start + 4 * 3600000).toISOString(); let units = 0, request, firstStart
  const result = await vibeLoop({ ...options(root), maxUnits: 2, pushEachUnit: false }, { preflight: passed,
    execute: async (config, job, directory, limits) => {
      units++
      if (units === 1) {
        const queued = await vibeLoop({ targetRoot: root, tag: 'reliable', configure: true, deadline, finalReserveHours: 0.5 })
        request = queued.receipt; assert.equal(queued.applied, false); assert.equal(queued.effectiveAt, 'unit-boundary')
        const pending = await vibeLoop({ targetRoot: root, tag: 'reliable', status: true }); firstStart = pending.startedAt
        assert.notEqual(pending.deadline, deadline); assert.equal(pending.requestedConfig.deadline, deadline)
      } else {
        const receipt = JSON.parse(await readFile(request, 'utf8'))
        assert.equal(receipt.status, 'applied'); assert.equal(receipt.afterUnit, 1)
        assert.equal(receipt.actual.deadline, deadline); assert.equal(receipt.actual.reserve.ms, 0.5 * 3600000)
        assert.equal(limits.deadline, Date.parse(deadline)); assert.ok(limits.timeoutMs <= Date.parse(deadline) - Date.now())
        const applied = await vibeLoop({ targetRoot: root, tag: 'reliable', status: true }); assert.equal(applied.startedAt, firstStart); assert.equal(applied.pid, process.pid)
      }
      return complete(root, job.brief.taskId, units)
    }, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.deadline, deadline)
  assert.equal(result.workDeadline, new Date(Date.parse(deadline) - 0.5 * 3600000).toISOString())
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
  assert.equal(manifest.limits.maxHours, (Date.parse(deadline) - Date.parse(firstStart)) / 3600000)
  assert.equal(result.continuation.remainingUnits, 0); assert.equal(result.continuation.hardStop, true); assert.equal(result.continuation.recoverable, false)
})

test('a requested deadline that expires during a child is rejected, never acknowledged as applied', async (t) => {
  const { root } = await fixture(t)
  let now = Date.now(), request
  const result = await vibeLoop({ ...options(root), maxUnits: 1, pushEachUnit: false }, { preflight: passed, now: () => now,
    execute: async (config, job) => {
      const queued = await vibeLoop({ targetRoot: root, tag: 'reliable', configure: true, deadline: new Date(now + 60000).toISOString(), finalReserveHours: 0 })
      request = queued.receipt; now += 120000
      return complete(root, job.brief.taskId, 1)
    }, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error)
  const rejected = JSON.parse(await readFile(request, 'utf8'))
  assert.equal(rejected.status, 'failed'); assert.match(rejected.reason, /unit boundary/)
  assert.equal(result.configHistory.length, 0)
})

test('deadline options require an explicit timezone and preserve local-only notification truth', async (t) => {
  const { root } = await fixture(t)
  await assert.rejects(vibeLoop({ ...options(root), dryRun: true, deadline: '2030-01-01T07:00:00' }), /시간대/)
  const plan = await vibeLoop({ ...options(root), dryRun: true, deadline: '2030-01-01T07:00:00+09:00' })
  assert.equal(plan.deadline, '2029-12-31T22:00:00.000Z'); assert.equal(plan.notification.userDelivery, 'unavailable')
  assert.equal(plan.notification.hookConfigured, false); assert.equal(plan.notification.externalDelivered, false)
})

test('the real checker keeps failing lines, bounded to twenty', async (t) => {
  const { root } = await fixture(t)
  const normal = await runVibeCheck({ targetRoot: root }, `node -e 'console.log("not ok 12 - alpha");process.exit(1)'`)
  assert.deepEqual(normal.failedTests, ['not ok 12 - alpha'])
  const many = await runVibeCheck({ targetRoot: root }, `node -e 'for(let n=0;n<21;n++)console.log("FAIL case "+n);process.exit(1)'`)
  assert.equal(many.failedTests.length, 20)
})
