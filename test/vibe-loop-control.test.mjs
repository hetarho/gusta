import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir, realpath, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fixture, git, execute } from './helpers/vibe-fixture.mjs'
import { vibeLoop } from '../src/vibe-loop.mjs'
import { atomicJSON, readJSON, watchLoop, acquireLoop, releaseLoop, loopEvent, judgmentItems, finishedSummary, finishedEvent } from '../src/loop-control.mjs'
import { activeRows, appendInbox } from '../src/state-doc.mjs'
import { vibePush } from '../src/vibe.mjs'

const options = (root) => ({ targetRoot: root, tag: 'ctrl01', provider: 'codex', maxUnits: 3 })
const passed = async () => ({ ok: true, checks: [] })
const receipt = { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: 'implementation' } }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`
// A real notification hook: appends each stdin payload as one JSONL line.
async function hook(temporary) {
  const handler = path.join(temporary, 'notify-append.cjs'), received = path.join(temporary, 'notified.jsonl')
  await writeFile(handler, `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>require('node:fs').appendFileSync(process.argv[2],input.trim()+'\\n'));`)
  return { command: [process.execPath, handler, received].map(shellQuote).join(' '), received: async () => (await readFile(received, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
}
async function code(root, n = 1) {
  await writeFile(path.join(root, 'app.js'), `// unit ${n}\n`)
  await git(root, 'add', 'app.js')
  await git(root, 'commit', '-q', '-m', `unit ${n}`)
  return structuredClone(receipt)
}

test('immediate cancellation after a successful unit never runs closing verification or dirties the report', async (t) => {
  const { root } = await fixture(t)
  let checks = 0
  const result = await vibeLoop(options(root), { preflight: passed,
    execute: async () => {
      const done = await code(root)
      await vibeLoop({ targetRoot: root, tag: 'ctrl01', stop: true })
      await pause(1150)
      return done
    },
    check: async ({ signal }) => { checks++; if (signal.aborted) throw new Error('heavy check stopped'); return { ok: true } },
  })
  assert.equal(result.reason, 'stop-file', result.error)
  assert.equal(result.ok, true, result.error)
  assert.equal(checks, 0)
  assert.equal(await git(root, 'status', '--porcelain'), '')
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /loop stopped: stop-file/)
})

test('unit completion -> owned report commit -> configuration acknowledgement -> exactly one next unit in the same host', async (t) => {
  const { root } = await fixture(t)
  const stateFile = path.join(root, 'spec/STATE.md')
  // Publication is a branch-strategy setting: land on main and push it.
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: true\n'); await git(root, 'add', 'spec/SETTINGS.md')
  await git(root, 'commit', '-qam', 'publication configuration')
  const seen = [], order = []; let request, originalStart, originalDeadline, pushedSHA, verifiedSHA, ciSHA, reportObserved = false
  const result = await vibeLoop({ ...options(root), maxUnits: 2 }, { preflight: passed,
    fault: async (point) => {
      if (point === 'metadata-commit' && order.includes('completed') && !reportObserved) {
        assert.match(await git(root, 'status', '--porcelain'), /spec\/reports/)
        reportObserved = true
      }
    },
    execute: async (config, job, directory, limits) => {
      const n = seen.length + 1; seen.push({ pid: process.pid, config: config.pushEachUnit, deadline: limits.deadline })
      if (n === 1) {
        const queued = await vibeLoop({ targetRoot: root, tag: 'ctrl01', configure: true, pushEachUnit: true })
        request = queued.receipt
        assert.equal(queued.applied, false)
        const status = await vibeLoop({ targetRoot: root, tag: 'ctrl01', status: true })
        assert.deepEqual(status.requestedConfig, { pushEachUnit: true }); assert.deepEqual(status.appliedConfig, { pushEachUnit: false })
        originalStart = status.startedAt; originalDeadline = status.deadline
        assert.equal(limits.signal.aborted, false)
        const done = await code(root, n)
        order.push('completed')
        return done
      }
      assert.equal(await git(root, 'status', '--porcelain'), '')
      const ack = await readJSON(request)
      assert.equal(ack.status, 'applied'); assert.equal(ack.afterUnit, 1)
      assert.equal(config.pushEachUnit, true); assert.equal(limits.signal.aborted, false)
      const status = await vibeLoop({ targetRoot: root, tag: 'ctrl01', status: true })
      assert.equal(status.startedAt, originalStart); assert.equal(status.deadline, originalDeadline)
      assert.match(await git(root, 'log', '-5', '--format=%s'), /unit report/)
      order.push('next')
      return code(root, n)
    },
    sync: async () => ({ ok: true }),
    check: async ({ signal }) => { assert.equal(signal.aborted, false); verifiedSHA = await git(root, 'rev-parse', 'HEAD'); order.push('verify'); return { ok: true } },
    push: async (config) => {
      assert.equal(config.verifiedCommit, verifiedSHA)
      assert.equal(await git(root, 'diff', '--name-only', verifiedSHA, 'HEAD', '--', 'app.js'), '')
      pushedSHA = await git(root, 'rev-parse', 'HEAD'); order.push('push'); return { ok: true, pushed: pushedSHA }
    },
    ci: async ({ commit }) => { ciSHA = commit; order.push('ci'); return { ok: true, outcome: 'success', commit } },
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.units, 2)
  assert.equal(reportObserved, true)
  assert.deepEqual(seen.map((entry) => entry.config), [false, true])
  assert.equal(new Set(seen.map((entry) => entry.pid)).size, 1)
  assert.equal(new Set(seen.map((entry) => entry.deadline)).size, 1)
  assert.deepEqual(order.slice(0, 5), ['completed', 'verify', 'push', 'ci', 'next'])
  assert.ok(ciSHA); assert.equal(await git(root, 'diff', '--name-only', ciSHA, pushedSHA, '--', 'app.js'), '')
  assert.equal(await git(root, 'status', '--porcelain'), '')
})

for (const file of ['app.js', 'spec/ssot/ARCH.md', 'spec/tasks/T001.example.md', 'spec/STATE.md', 'owner-notes.txt']) {
  test(`unknown changes are preserved and prevent publication/next unit: ${file}`, async (t) => {
    const { root } = await fixture(t)
    let calls = 0, expected
    const result = await vibeLoop(options(root), { preflight: passed,
      execute: async () => {
        calls++; await code(root)
        expected = (await readFile(path.join(root, file), 'utf8').catch(() => '')) + '\nuser content must survive\n'
        await writeFile(path.join(root, file), expected)
        return structuredClone(receipt)
      }, push: () => assert.fail('dirty work must not be pushed'),
    })
    assert.equal(result.ok, false); assert.equal(calls, 1)
    const after = await readFile(path.join(root, file), 'utf8')
    if (file === 'spec/STATE.md') assert.match(after, /user content must survive/)
    else assert.equal(after, expected)
    assert.match(await git(root, 'status', '--porcelain'), new RegExp(file.replaceAll('.', '\\.')))
    const committed = await git(root, 'show', `HEAD:${file}`).catch(() => '')
    assert.doesNotMatch(committed, /user content must survive/)
  })
}

test('graceful stop finishes the current unit and final validation without aborting either, and persists the user stop', async (t) => {
  const { root } = await fixture(t)
  let calls = 0, checks = 0, request
  const result = await vibeLoop(options(root), { preflight: passed,
    execute: async (config, job, directory, { signal }) => {
      calls++
      request = await vibeLoop({ targetRoot: root, tag: 'ctrl01', stopAfterUnit: true })
      assert.equal(signal.aborted, false)
      await pause(1050)
      assert.equal(signal.aborted, false)
      return code(root)
    },
    check: async ({ signal }) => { checks++; await pause(1100); assert.equal(signal.aborted, false); return { ok: true } },
    push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'stop-after-unit')
  assert.equal(calls, 1); assert.equal(checks, 1)
  assert.equal((await readJSON(request.receipt)).status, 'applied')
  await vibeLoop({ targetRoot: root, tag: 'ctrl01', recoverMetadata: true })
  const stopped = await vibeLoop(options(root), { execute: () => assert.fail('user stop must persist'), preflight: () => assert.fail('stop before preflight') })
  assert.equal(stopped.reason, 'stop-file')
})

for (const point of ['report-write', 'metadata-commit', 'state-write']) test(`transient ${point} retries only metadata and starts each unit once`, async (t) => {
  const { root } = await fixture(t)
  let injected = false, calls = 0
  const result = await vibeLoop({ ...options(root), maxUnits: 2 }, { preflight: passed,
    fault: async (name) => { if (calls === (point === 'state-write' ? 2 : 1) && name === point && !injected) { injected = true; throw new Error(`injected ${point}`) } },
    execute: async () => code(root, ++calls), check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(calls, 2)
  assert.equal(injected, true)
  assert.equal(await git(root, 'status', '--porcelain'), '')
})

for (const point of ['config-before-apply', 'config-after-apply']) test(`failure at ${point} leaves accurate configuration/receipt, releases ownership and never launches a duplicate`, async (t) => {
  const { root } = await fixture(t)
  let calls = 0, request
  const result = await vibeLoop(options(root), { preflight: passed,
    fault: async (name) => { if (name === point) throw new Error(`injected ${point}`) },
    execute: async () => { calls++; request = await vibeLoop({ targetRoot: root, tag: 'ctrl01', configure: true, pushEachUnit: true }); return code(root) },
    push: () => assert.fail('failed transition cannot publish'),
  })
  assert.equal(result.ok, false); assert.equal(calls, 1); assert.match(result.error, new RegExp(point))
  const ack = await readJSON(request.receipt), state = await readJSON(result.manifest)
  assert.equal(ack.status, point === 'config-after-apply' ? 'applied' : 'cancelled')
  assert.equal(state.appliedConfig.pushEachUnit, point === 'config-after-apply')
  assert.equal(state.running, false); assert.equal(state.units, 1)
  assert.equal(await git(root, 'status', '--porcelain'), '')
  await assert.rejects(readFile(path.join(root, '.git/haeram-vibe-loop.lock')), { code: 'ENOENT' })
})

test('exhausted metadata retries record a distinct operational error; explicit recovery commits only owned files', async (t) => {
  const { root } = await fixture(t)
  let calls = 0
  const result = await vibeLoop(options(root), { preflight: passed,
    fault: async (name) => { if (calls && name === 'metadata-commit') throw new Error('commit unavailable') },
    execute: async () => { calls++; return code(root) },
    push: () => assert.fail('metadata failure cannot publish'),
  })
  assert.equal(result.ok, false); assert.equal(calls, 1)
  assert.ok(result.operationalErrors.some((entry) => entry.operation === 'metadata-commit'))
  const directory = path.dirname(result.manifest)
  const notifications = await readdir(path.join(directory, 'notifications'))
  assert.ok(notifications.length)
  const notification = await readJSON(path.join(directory, 'notifications', notifications[0]))
  assert.equal(notification.externalDelivered, false); assert.equal(notification.delivery, 'pending')
  await writeFile(path.join(root, 'owner-notes.txt'), 'preserve me\n')
  const recovered = await vibeLoop({ targetRoot: root, tag: 'ctrl01', recoverMetadata: true })
  assert.equal(recovered.implementationRestarted, false)
  assert.equal(await git(root, 'status', '--porcelain'), '?? owner-notes.txt')
  assert.deepEqual(activeRows(await readFile(path.join(root, 'spec/STATE.md'), 'utf8')), [])
})

test('cancellation while validation runs records cancelled separately from failed validation', async (t) => {
  const { root } = await fixture(t)
  const result = await vibeLoop({ ...options(root), maxUnits: 1 }, { preflight: passed,
    execute: () => code(root),
    check: async ({ signal }) => {
      assert.equal(signal.aborted, false)
      await vibeLoop({ targetRoot: root, tag: 'ctrl01', stop: true })
      await pause(1150)
      return { ok: false, log: 'fake interrupted check' }
    }, push: () => assert.fail('cancelled validation cannot publish'),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'stop-file')
  const report = await readFile(path.join(root, result.report), 'utf8')
  assert.match(report, /node --version: cancelled/); assert.doesNotMatch(report, /node --version: fail/)
  assert.equal(await git(root, 'status', '--porcelain'), '')
})

test('configuration and metadata retries preserve elapsed time and unit limits', async (t) => {
  const { root } = await fixture(t)
  let now = Date.now(), calls = 0
  const start = now
  const result = await vibeLoop({ ...options(root), maxHours: 1, maxUnits: 10 }, { preflight: passed, now: () => now,
    execute: async () => { calls++; now += 31 * 60000; await vibeLoop({ targetRoot: root, tag: 'ctrl01', configure: true, pushEachUnit: calls === 1 }); return code(root, calls) },
    check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.reason, 'max-hours'); assert.equal(calls, 2)
  const state = await readJSON(result.manifest)
  assert.equal(Date.parse(state.startedAt), start); assert.equal(Date.parse(state.deadline), start + 3600000)
})

test('independent supervisor observes an actually killed isolated host and emits durable failure; it never restarts a worker', async (t) => {
  const { root, temporary } = await fixture(t)
  const helper = path.join(temporary, 'host.mjs'), notify = await hook(temporary)
  const module = new URL('../src/vibe-loop.mjs', import.meta.url).href
  await writeFile(helper, `import {vibeLoop} from ${JSON.stringify(module)}; await vibeLoop(${JSON.stringify({ ...options(root), notifyCommand: notify.command })}, {preflight:async()=>({ok:true,checks:[]}), execute:async()=>new Promise(()=>{})});`)
  const child = spawn(process.execPath, [helper], { stdio: 'ignore' })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  const directory = path.join(root, '.git/haeram/v1/loops/ctrl01'), manifest = path.join(directory, 'loop.json')
  let state
  for (let n = 0; n < 200; n++) { state = await readJSON(manifest); if (state?.status === 'unit') break; await pause(25) }
  assert.equal(state.status, 'unit'); assert.equal(state.supervisor.ready, true)
  const requested = await vibeLoop({ targetRoot: root, tag: 'ctrl01', configure: true, pushEachUnit: true })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGKILL'); await exited
  for (let n = 0; n < 150; n++) { state = await readJSON(manifest); if (!state.running) break; await pause(25) }
  assert.equal(state.running, false); assert.equal(state.reason, 'host-lost'); assert.equal(state.units, 0)
  assert.equal((await readJSON(requested.receipt)).status, 'cancelled')
  // The supervisor stops the manifest first and appends the event right after; under load that gap is visible.
  let events = '', notices = []
  for (let n = 0; n < 400; n++) {
    events = await readFile(path.join(directory, 'events.jsonl'), 'utf8')
    notices = await notify.received()
    if (notices.some((notice) => notice.type === 'finished')) break
    await pause(25)
  }
  assert.match(events, /host-lost/)
  // The lost host cannot close its run: the supervisor sends host-lost, then the one finished summary.
  assert.deepEqual(notices.map(({ type, level }) => [type, level]), [['host-lost', 'failure'], ['finished', 'failure']])
  const finished = notices[1]
  assert.equal(finished.status, 'failed'); assert.equal(finished.reason, 'host-lost'); assert.equal(finished.units, 0)
  assert.deepEqual(finished.push, { pushed: false, reason: 'failed' }); assert.equal(finished.report, state.report)
  assert.equal((await readdir(path.join(directory, 'notifications'))).length, 2)
  const result = await vibeLoop({ targetRoot: root, tag: 'ctrl01', recoverMetadata: true })
  assert.equal(result.implementationRestarted, false)
  assert.equal(await git(root, 'status', '--porcelain'), '')
  assert.equal((await readJSON(manifest)).units, 0)
})

test('stale heartbeat is reported without stealing a live host or restarting after a user stop', async (t) => {
  const { root } = await fixture(t)
  const directory = path.join(root, '.git/haeram/v1/loops/stale1')
  const state = { runId: 'isolated', tag: 'stale1', cwd: await realpath(root), host: os.hostname(), pid: process.pid, running: true, heartbeatAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString() }
  await atomicJSON(path.join(directory, 'loop.json'), state)
  const watching = watchLoop(directory, state.runId, { intervalMs: 20 })
  await pause(50)
  const status = await vibeLoop({ targetRoot: root, tag: 'stale1', status: true })
  assert.equal(status.health, 'heartbeat-stale'); assert.equal(status.ok, false)
  assert.match(await readFile(path.join(directory, 'events.jsonl'), 'utf8'), /heartbeat-stale/)
  await atomicJSON(path.join(directory, 'loop.json'), { ...state, running: false, reason: 'stop-file' })
  await watching
  assert.equal((await readJSON(path.join(directory, 'loop.json'))).reason, 'stop-file')
})

test('one checkout owner wins concurrent acquisition; tag controls cannot cross worktrees', async (t) => {
  const { root, temporary } = await fixture(t)
  const lock = path.join(root, '.git/test-loop.lock')
  const a = { runId: 'a', pid: process.pid, host: os.hostname() }, b = { ...a, runId: 'b' }
  const results = await Promise.allSettled([acquireLoop(lock, a), acquireLoop(lock, b)])
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1)
  const owner = await readJSON(lock)
  await releaseLoop(lock, owner.runId === 'a' ? 'b' : 'a')
  assert.equal((await readJSON(lock)).runId, owner.runId)
  await releaseLoop(lock, owner.runId)
  const worktree = path.join(temporary, 'other')
  await git(root, 'worktree', 'add', '-q', '-b', 'other', worktree)
  const directory = path.join(root, '.git/haeram/v1/loops/ctrl01')
  await atomicJSON(path.join(directory, 'loop.json'), { cwd: root, tag: 'ctrl01', running: true, host: os.hostname(), pid: process.pid })
  await assert.rejects(vibeLoop({ targetRoot: worktree, tag: 'ctrl01', stop: true }), /다른 checkout/)
  await assert.rejects(readFile(path.join(directory, 'STOP')), { code: 'ENOENT' })
})

test('official CLI accepts configuration and emits a durable acknowledgement receipt', async (t) => {
  const { root } = await fixture(t)
  const cli = new URL('../bin/haeram-spec-creator.mjs', import.meta.url).pathname
  const result = await vibeLoop({ ...options(root), maxUnits: 2 }, { preflight: passed,
    execute: async (config, job) => {
      if (!config.pushEachUnit) {
        const { stdout } = await execute(process.execPath, [cli, 'vibe', 'loop', '--target', root, '--tag', 'ctrl01', '--configure', '--push-each-unit', '--json'])
        assert.equal(JSON.parse(stdout).request.status, 'pending')
      }
      return code(root, config.pushEachUnit ? 2 : 1)
    }, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.appliedConfig.pushEachUnit, true)
})

for (const changeAfterVerification of [false, true]) test(`isolated bare publication preserves verification SHA and actual code-push CI contract; later code=${changeAfterVerification}`, async (t) => {
  const { root, temporary } = await fixture(t)
  const remote = path.join(temporary, 'remote.git')
  await git(root, 'init', '--bare', '-q', remote)
  await git(root, 'remote', 'add', 'origin', remote)
  const file = path.join(root, 'spec/STATE.md')
  // Publication is a branch-strategy setting: land on main and push it.
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: true\n'); await git(root, 'add', 'spec/SETTINGS.md')
  await git(root, 'commit', '-qam', 'publication configuration')
  await git(root, 'push', '-q', 'origin', 'main')
  const original = await git(root, 'rev-parse', 'HEAD')
  const verified = [], published = [], waited = []
  const result = await vibeLoop({ ...options(root), maxUnits: 2 }, { preflight: passed,
    execute: async (config) => {
      if (!config.pushEachUnit) await vibeLoop({ targetRoot: root, tag: 'ctrl01', configure: true, pushEachUnit: true })
      return code(root, config.pushEachUnit ? 2 : 1)
    },
    check: async ({ signal }) => {
      assert.equal(signal.aborted, false)
      verified.push(await git(root, 'rev-parse', 'HEAD'))
      if (changeAfterVerification) await code(root, 'changed-after-check')
      return { ok: true }
    },
    push: async (config) => {
      assert.equal(config.verifiedCommit, verified.at(-1))
      const pushed = await vibePush(config)
      published.push(pushed.pushed)
      assert.equal(pushed.pushed, await git(root, '--git-dir', remote, 'rev-parse', 'main'))
      assert.equal(await git(root, 'diff', '--name-only', config.verifiedCommit, pushed.pushed, '--', 'app.js'), '')
      return pushed
    },
    ci: async ({ commit }) => { waited.push(commit); assert.equal(commit, published.at(-1)); return { ok: true, outcome: 'success', commit } },
  })
  if (changeAfterVerification) {
    assert.equal(result.ok, false); assert.match(result.error, /코드가 변경/)
    assert.equal(await git(root, '--git-dir', remote, 'rev-parse', 'main'), original)
    assert.deepEqual(waited, [])
  } else {
    assert.equal(result.ok, true, result.error); assert.equal(result.units, 2)
    assert.equal(verified.length, 2); assert.equal(waited.length, 2)
    assert.equal(await git(root, 'show', `${waited.at(-1)}:app.js`), '// unit 2')
  }
})

for (const succeeds of [true, false]) test(`notification command consumes the actual failure event; acknowledgement=${succeeds}`, async (t) => {
  const { root, temporary } = await fixture(t)
  const handler = path.join(temporary, 'notify.cjs'), received = path.join(temporary, 'received.json')
  await writeFile(handler, `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{require('node:fs').writeFileSync(process.argv[2],input);process.exitCode=${succeeds ? 0 : 1};});`)
  const directory = path.join(root, '.git/notification-test')
  await atomicJSON(path.join(directory, 'fixture.json'), {})
  const event = await loopEvent(directory, { runId: 'isolated', tag: 'ctrl01', cwd: root, notifyCommand: [process.execPath, handler, received].map(shellQuote).join(' ') }, 'failed', { error: 'injected host failure' })
  assert.deepEqual(await readJSON(received), event)
  assert.equal(event.level, 'failure'); assert.equal(event.error, 'injected host failure')
  const receipt = await readJSON(path.join(directory, 'notifications', `${event.id}.json`))
  assert.equal(receipt.delivery, succeeds ? 'hook-acknowledged' : 'failed')
  assert.equal(receipt.deliveredToHook, succeeds)
  assert.equal(receipt.externalDelivered, false)
})

test('unknown report edits and staged STATE content are never adopted as host metadata', async (t) => {
  const { root } = await fixture(t)
  let staged
  const result = await vibeLoop(options(root), { preflight: passed,
    execute: async (config, job) => {
      await code(root)
      const file = path.join(root, 'spec/STATE.md'), text = await readFile(file, 'utf8')
      staged = `${text}\nunknown staged content\n`
      await writeFile(file, staged); await git(root, 'add', file); await writeFile(file, text)
      await writeFile(path.join(root, job.report), (await readFile(path.join(root, job.report), 'utf8')) + '\nunknown report content\n')
      return structuredClone(receipt)
    }, push: () => assert.fail('unknown metadata must not publish'),
  })
  assert.equal(result.ok, false)
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /unknown report content/)
  assert.equal(`${await git(root, 'show', ':spec/STATE.md')}\n`, staged)
  assert.doesNotMatch(await git(root, 'show', `HEAD:${result.report}`), /unknown report content/)
  await assert.rejects(vibeLoop({ targetRoot: root, tag: 'ctrl01', recoverMetadata: true }), /report recovery conflict/)
})

for (const permanent of [false, true]) test(`manifest write failure is retried without resetting units; permanent=${permanent}`, async (t) => {
  const { root } = await fixture(t)
  let calls = 0, failures = 0
  const result = await vibeLoop({ ...options(root), maxUnits: 2 }, { preflight: passed,
    fault: async (point) => { if (point === 'manifest-write' && calls === 1 && (permanent || failures === 0)) { failures++; throw new Error('injected manifest failure') } },
    execute: async () => code(root, ++calls), check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, !permanent, result.error)
  assert.equal(calls, permanent ? 1 : 2)
  const status = await vibeLoop({ targetRoot: root, tag: 'ctrl01', status: true })
  assert.equal(status.running, false); assert.equal(status.units, calls)
  if (permanent) { assert.equal(status.status, 'failed'); assert.ok(status.operationalErrors.length); assert.equal(status.ok, false) }
  assert.equal(await git(root, 'status', '--porcelain'), '')
})

test('wait-ms acknowledges actual boundary application and can disable per-unit publication', async (t) => {
  const { root } = await fixture(t)
  let waiting, calls = 0
  const result = await vibeLoop({ ...options(root), pushEachUnit: true, maxUnits: 2 }, { preflight: passed,
    execute: async (config) => {
      calls++
      if (calls === 1) {
        waiting = vibeLoop({ targetRoot: root, tag: 'ctrl01', configure: true, pushEachUnit: false, waitMs: 10000 })
        // Allow request persistence while this unit continues running.
        await pause(100)
      } else assert.equal(config.pushEachUnit, false)
      return code(root, calls)
    }, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error)
  const acknowledgement = await waiting
  assert.equal(acknowledgement.applied, true); assert.equal(acknowledgement.request.afterUnit, 1)
  assert.equal(acknowledgement.request.actual.pushEachUnit, false)
})

test('unit timeout is recorded, never a silent success; idle cuts end the run as session failures', async (t) => {
  const { root } = await fixture(t)
  let calls = 0
  const result = await vibeLoop(options(root), { preflight: passed,
    execute: async () => { calls++; return { exitCode: 1, stopped: 'unit-timeout', result: null } },
    check: () => assert.fail('no code to verify'), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, false); assert.equal(result.reason, 'session-failures'); assert.equal(calls, 2)
  const events = await readFile(path.join(path.dirname(result.manifest), 'events.jsonl'), 'utf8')
  assert.match(events, /"type":"unit-cut"/); assert.match(events, /"type":"failed"/)
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /cut \(unit-timeout\)/)
  assert.equal((await readJSON(result.manifest)).running, false)
  assert.equal(await git(root, 'status', '--porcelain'), '')
})

test('legacy hosts reject unsupported in-place requests without touching their execution', async (t) => {
  const { root } = await fixture(t)
  const file = path.join(root, '.git/haeram/v1/loops/legacy/loop.json')
  const legacy = { schemaVersion: 1, cwd: await realpath(root), tag: 'legacy', running: true, pid: process.pid, startedAt: new Date().toISOString() }
  await atomicJSON(file, legacy)
  await assert.rejects(vibeLoop({ targetRoot: root, tag: 'legacy', configure: true, pushEachUnit: true }), /지원하지 않습니다/)
  assert.deepEqual(await readJSON(file), legacy)
})

test('multiple configuration requests preserve acceptance order even within the same timestamp', async (t) => {
  const { root } = await fixture(t)
  let calls = 0
  const requests = []
  const result = await vibeLoop({ ...options(root), maxUnits: 2 }, { preflight: passed,
    execute: async (config) => {
      if (++calls === 1) {
        for (const pushEachUnit of [true, false, true, false]) requests.push(await vibeLoop({ targetRoot: root, tag: 'ctrl01', configure: true, pushEachUnit }))
      } else assert.equal(config.pushEachUnit, false)
      return code(root, calls)
    }, check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.configHistory.map((request) => request.sequence), [1, 2, 3, 4])
  assert.equal(result.appliedConfig.pushEachUnit, false)
  for (const request of requests) assert.equal((await readJSON(request.receipt)).status, 'applied')
})

test('a stop requested before host startup binds its tag to that checkout without stopping another worktree', async (t) => {
  const { root, temporary } = await fixture(t)
  const other = path.join(temporary, 'other')
  await git(root, 'worktree', 'add', '-q', '-b', 'other', other)
  await vibeLoop({ targetRoot: root, tag: 'ctrl01', stop: true })
  await assert.rejects(vibeLoop({ targetRoot: other, tag: 'ctrl01', stop: true }), /다른 checkout/)
  await assert.rejects(vibeLoop({ ...options(other), maxUnits: 1 }, { execute: () => assert.fail('another checkout must not use the tag') }), /다른 checkout/)
  const own = await vibeLoop(options(root), { execute: () => assert.fail('user stop retained') })
  assert.equal(own.reason, 'stop-file')
})

test('a passed verification retains its actual pass when cancellation arrives before publication', async (t) => {
  const { root } = await fixture(t)
  const result = await vibeLoop({ ...options(root), maxUnits: 1 }, { preflight: passed,
    execute: () => code(root),
    check: async ({ signal }) => {
      await vibeLoop({ targetRoot: root, tag: 'ctrl01', stop: true })
      await pause(1100)
      assert.equal(signal.aborted, true)
      return { ok: true, exitCode: 0 }
    }, push: () => assert.fail('cancelled host cannot publish'),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'stop-file')
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /node --version: pass/)
  assert.equal(await git(root, 'status', '--porcelain'), '')
})

test('a clean committed report with the generated name is preserved unless a previous host journal proves ownership', async (t) => {
  const { root } = await fixture(t)
  const now = Date.now(), report = `spec/reports/${new Date(now).toISOString().slice(2, 10).replaceAll('-', '')}-ctrl01.md`
  await mkdir(path.dirname(path.join(root, report)), { recursive: true })
  await writeFile(path.join(root, report), 'User-owned committed report\n')
  await git(root, 'add', report); await git(root, 'commit', '-q', '-m', 'owner report')
  const before = await git(root, 'rev-parse', 'HEAD')
  const result = await vibeLoop(options(root), { now: () => now, preflight: passed, execute: () => assert.fail('ownership conflict must be found before dispatch') })
  assert.equal(result.ok, false); assert.match(result.error, /exact journaled host ownership/)
  assert.equal(await readFile(path.join(root, report), 'utf8'), 'User-owned committed report\n')
  assert.equal(await git(root, 'rev-parse', 'HEAD'), before)
  assert.equal(await git(root, 'status', '--porcelain'), '')
})

test('judgment items are only what a unit added for the owner: decided/parked lines, new open decisions, a parked result', () => {
  const before = '# STATE\n\n## inbox\n- 261110 decided ARCH-1: old → a (alt: b)\n- 261110 suggest -: optional\n\n## ssot\n| id | rev | tasked | pending | [?] |\n|---|---|---|---|---|\n| ARCH | 1 | 1 | - | 1 |\n| AUTH | 2 | 2 | - | 0 |\n'
  const after = before.replace('- 261110 suggest -: optional', '- 261110 suggest -: optional\n- 261111 decided AUTH-3: Session length → 30 days (alt: 7 days | 1 day)\n- 261111 parked T004 AUTH-4: billing needs the owner\n- 261111 suggest -: next idea')
    .replace('| AUTH | 2 | 2 | - | 0 |', '| AUTH | 3 | 2 | AUTH-4+ | 2 |')
  assert.deepEqual(judgmentItems(before, after), [
    { kind: 'decided', refs: ['AUTH-3'], text: 'Session length → 30 days (alt: 7 days | 1 day)' },
    { kind: 'parked', refs: ['T004', 'AUTH-4'], text: 'billing needs the owner' },
    { kind: 'open', refs: ['AUTH'], count: 2 },
  ])
  assert.deepEqual(judgmentItems(after, after), [])
  // Resolved lines are not news; a parked result without its inbox line is, once.
  assert.deepEqual(judgmentItems(after, before, { kind: 'task', id: 'T009', outcome: 'parked' }), [{ kind: 'parked', refs: ['T009'] }])
  assert.equal(judgmentItems(before, after, { kind: 'task', id: 'T004', outcome: 'parked' }).filter((item) => item.kind === 'parked').length, 1)
  assert.deepEqual(judgmentItems(before, before, { kind: 'none', id: '', outcome: 'no_work' }), [])
  assert.equal(judgmentItems('', `## inbox\n- 261111 decided X-1: ${'long '.repeat(40)}`)[0].text.length, 80)
})

test('finished summary: level, waiting judgment capped with IDs, parked count and publication', () => {
  const text = `## inbox\n${Array.from({ length: 12 }, (_, n) => `- 261111 ${n % 3 ? 'decided' : 'parked'} T${100 + n}: item ${n}`).join('\n')}\n`
  const summary = finishedSummary({ status: 'stopped', reason: 'no-work', units: 4, report: 'spec/reports/261111-k3f9.md', publication: { pushed: 'abc123', target: 'main' } }, text)
  assert.equal(summary.level, 'attention'); assert.equal(summary.parked, 4)
  assert.deepEqual([summary.judgment.count, summary.judgment.items.length, summary.judgment.more], [12, 10, 2])
  assert.deepEqual(summary.judgment.items[0], { kind: 'parked', refs: ['T100'], text: 'item 0' })
  assert.deepEqual(summary.push, { pushed: true, commit: 'abc123', target: 'main' }); assert.equal(summary.report, 'spec/reports/261111-k3f9.md')
  assert.deepEqual(finishedSummary({ status: 'stopped', reason: 'max-units', units: 1, publication: { pushed: null, target: null, reason: 'land-unset' } }),
    { level: 'info', status: 'stopped', reason: 'max-units', units: 1, judgment: { count: 0, items: [], more: 0 }, parked: 0, push: { pushed: false, reason: 'land-unset' }, report: null })
  const failed = finishedSummary({ status: 'failed', reason: 'host-lost', error: 'loop host exited without finalization', units: 2 }, text)
  assert.equal(failed.level, 'failure'); assert.equal(failed.error, 'loop host exited without finalization'); assert.deepEqual(failed.push, { pushed: false, reason: 'failed' })
  assert.deepEqual(finishedSummary({ status: 'cancelled', reason: 'stop-file', units: 0, publication: { pushed: null, landed: 'def456', target: 'develop' } }).push, { pushed: false, reason: 'local', landed: 'def456', target: 'develop' })
  assert.deepEqual(finishedSummary({ status: 'stopped', reason: 'final-window', units: 3 }).push, { pushed: false, reason: 'not-attempted' })
})

test('a run has exactly one finished notice, whoever closes it', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'haeram-finished-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const state = { runId: 'run-1', tag: 'ctrl01' }
  const first = await finishedEvent(directory, state, { level: 'info', status: 'stopped', reason: 'no-work' })
  assert.equal(first.type, 'finished'); assert.equal(first.level, 'info')
  assert.equal(await finishedEvent(directory, state, { level: 'failure', status: 'failed', reason: 'host-lost' }), null)
  assert.equal((await readdir(path.join(directory, 'notifications'))).length, 1)
  assert.equal((await finishedEvent(directory, { ...state, runId: 'run-2' }, { level: 'info' })).runId, 'run-2')
})

for (const blocked of ['events.jsonl', 'notifications']) test(`a finished notice whose ${blocked} write fails stays retryable, then is sent once`, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'haeram-finished-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const state = { runId: 'run-1', tag: 'ctrl01' }
  // Injected write failure: a directory where the event log goes, or a file where the outbox goes.
  if (blocked === 'events.jsonl') await mkdir(path.join(directory, blocked)); else await writeFile(path.join(directory, blocked), '')
  await assert.rejects(finishedEvent(directory, state, { level: 'info', status: 'stopped', reason: 'no-work' }))
  await assert.rejects(readFile(path.join(directory, 'finished-run-1.claim')), { code: 'ENOENT' })
  await rm(path.join(directory, blocked), { recursive: true, force: true })
  const sent = await finishedEvent(directory, state, { level: 'info', status: 'stopped', reason: 'no-work' })
  assert.equal(sent.type, 'finished')
  assert.equal(await finishedEvent(directory, state, { level: 'failure', status: 'failed', reason: 'host-lost' }), null)
  assert.deepEqual(await readdir(path.join(directory, 'notifications')), [`${sent.id}.json`])
})

test('the hook gets one needs-judgment per unit that left judgment, none for others, and one finished summary', async (t) => {
  const { root, temporary } = await fixture(t)
  const notify = await hook(temporary), file = path.join(root, 'spec/STATE.md')
  let calls = 0
  const result = await vibeLoop({ ...options(root), maxUnits: 3, notifyCommand: notify.command }, { preflight: passed,
    execute: async () => {
      const n = ++calls
      let text = await readFile(file, 'utf8')
      if (n === 1) text = appendInbox(text, '- 261111 decided ARCH-3: Retry policy → exponential (alt: fixed)').replace('| ARCH | 1 | 1 | - | 0 |', '| ARCH | 1 | 1 | - | 1 |')
      if (n === 2) text = appendInbox(text, '- 261111 parked T002: needs production credentials')
      await writeFile(file, text); await writeFile(path.join(root, 'app.js'), `// unit ${n}\n`)
      await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', `unit ${n}`)
      return { exitCode: 0, result: { kind: 'task', id: `T00${n}`, outcome: n === 2 ? 'parked' : 'completed', pushed: false, next: 'implementation' } }
    }, check: async () => ({ ok: true }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.units, 3)
  const notices = await notify.received()
  assert.deepEqual(notices.map(({ type, level }) => [type, level]), [['needs-judgment', 'attention'], ['needs-judgment', 'attention'], ['finished', 'attention']])
  assert.deepEqual(notices.slice(0, 2).map(({ unit, task, count, items, more }) => ({ unit, task, count, items, more })), [
    { unit: 1, task: 'T001', count: 2, more: 0, items: [{ kind: 'decided', refs: ['ARCH-3'], text: 'Retry policy → exponential (alt: fixed)' }, { kind: 'open', refs: ['ARCH'], count: 1 }] },
    { unit: 2, task: 'T002', count: 1, more: 0, items: [{ kind: 'parked', refs: ['T002'], text: 'needs production credentials' }] },
  ])
  const { status, reason, units, judgment, parked, push, report } = notices[2]
  assert.deepEqual({ status, reason, units, count: judgment.count, parked, push, report }, { status: 'stopped', reason: 'max-units', units: 3, count: 3, parked: 1, push: { pushed: false, reason: 'land-unset' }, report: result.report })
  assert.deepEqual(judgment.items.map((item) => `${item.kind} ${item.refs.join(' ')}`), ['decided ARCH-3', 'parked T002', 'open ARCH'])
  const receipts = await Promise.all((await readdir(path.join(path.dirname(result.manifest), 'notifications'))).map((name) => readJSON(path.join(path.dirname(result.manifest), 'notifications', name))))
  assert.equal(receipts.length, 3); assert.ok(receipts.every((entry) => entry.delivery === 'hook-acknowledged' && entry.externalDelivered === false))
})

test('a failing or missing notification hook never fails the run', async (t) => {
  const { root, temporary } = await fixture(t)
  const result = await vibeLoop({ ...options(root), maxUnits: 1, notifyCommand: shellQuote(path.join(temporary, 'missing-hook')) }, { preflight: passed,
    execute: async () => {
      const file = path.join(root, 'spec/STATE.md')
      await writeFile(file, appendInbox(await readFile(file, 'utf8'), '- 261111 parked T001: owner decides'))
      await git(root, 'add', file)
      return code(root)
    }, check: async () => ({ ok: true }),
  })
  assert.equal(result.ok, true, result.error); assert.equal(result.reason, 'max-units')
  const directory = path.dirname(result.manifest)
  const receipts = await Promise.all((await readdir(path.join(directory, 'notifications'))).map((name) => readJSON(path.join(directory, 'notifications', name))))
  assert.deepEqual(receipts.map((entry) => entry.type).sort(), ['finished', 'needs-judgment'])
  assert.ok(receipts.every((entry) => entry.delivery === 'failed' && entry.deliveredToHook === false))
})
