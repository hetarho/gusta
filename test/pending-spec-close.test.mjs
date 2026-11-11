import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, archiveTask } from './helpers/vibe-fixture.mjs'
import { vibeStatus } from '../src/vibe.mjs'
import { vibeLoop } from '../src/vibe-loop.mjs'

const passed = async () => ({ ok: true, checks: [] })

test('an active task remains a repair issue after its STATE row disappears, even with a valid status', async (t) => {
  const { root } = await fixture(t, 1)
  const state = path.join(root, 'spec/STATE.md'), file = path.join(root, 'spec/tasks/T001.example.md')
  await writeFile(state, (await readFile(state, 'utf8')).split('\n').filter((line) => !line.startsWith('| T001 |')).join('\n'))
  for (const st of ['todo', 'done']) {
    await writeFile(file, (await readFile(file, 'utf8')).replace(/st:[^\s|]+/, `st:${st}`))
    const status = await vibeStatus({ targetRoot: root, fetch: false })
    assert.equal(status.settled, false); assert.equal(status.route, 'repair')
    assert.deepEqual(status.issues, [{ id: 'T001', where: 'file', st, reason: 'missing-state-row' }])
  }
})

test('a present task file missing st is invalid rather than treated as an absent optional file', async (t) => {
  const { root } = await fixture(t, 1)
  const file = path.join(root, 'spec/tasks/T001.example.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('st:todo | ', ''))
  const status = await vibeStatus({ targetRoot: root, fetch: false })
  assert.equal(status.route, 'repair'); assert.equal(status.settled, false)
  assert.deepEqual(status.issues, [{ id: 'T001', where: 'file', st: null }])
})

test('a valid dated done status still needs archival and removal of its STATE row', async (t) => {
  const { root } = await fixture(t, 1)
  const file = path.join(root, 'spec/tasks/T001.example.md'), state = path.join(root, 'spec/STATE.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('st:todo', 'st:done@261112'))
  await writeFile(state, (await readFile(state, 'utf8')).replace('| todo |', '| done@261112 |'))
  const status = await vibeStatus({ targetRoot: root, fetch: false })
  assert.equal(status.route, 'repair'); assert.equal(status.settled, false)
  assert.deepEqual(status.issues.map(({ reason }) => reason), ['stale-done-row', 'unarchived-done'])
})

for (const [kind, claimed, planning] of [['fix', 'T001'], ['task', 'T999'], ['task', 'invalid'], ['task', 'T999', true]]) {
  test(`a completed ${kind} receipt with id ${claimed} cannot bypass the selected task close${planning ? ' during planning recovery' : ''}`, async (t) => {
    const { root } = await fixture(t, 1)
    if (planning) {
      for (const file of ['spec/STATE.md', 'spec/tasks/T001.example.md']) {
        const name = path.join(root, file)
        await writeFile(name, (await readFile(name, 'utf8')).replaceAll('todo', 'blocked@261112'))
      }
      await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'blocked task needs planning recovery')
    }
    const jobs = []
    const result = await vibeLoop({ targetRoot: root, tag: 'close01', provider: 'codex', maxUnits: 3 }, {
      preflight: passed, check: async () => ({ ok: true }),
      execute: async (_config, job) => {
        jobs.push(job)
        const id = job.brief?.taskId ?? job.recovery?.taskId
        assert.equal(id, 'T001')
        if (jobs.length === 2) await archiveTask(root, id)
        await writeFile(path.join(root, 'app.js'), `// attempt ${jobs.length}\n`)
        await git(root, 'add', 'spec', 'app.js'); await git(root, 'commit', '-qm', `attempt ${jobs.length}`)
        return { exitCode: 0, result: { kind: jobs.length === 1 ? kind : 'task', id: jobs.length === 1 ? claimed : id, outcome: 'completed', pushed: false, next: 'implementation' } }
      },
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(jobs.length, 2); assert.equal(jobs[1].recovery.reason, 'spec-gate')
    assert.equal(jobs[1].recovery.taskId, 'T001')
    const saved = JSON.parse(await readFile(result.manifest, 'utf8'))
    assert.equal(saved.dispatches[0].task, 'T001'); assert.equal(saved.dispatches[0].specGate.ok, false)
    assert.equal(saved.dispatches[1].specGate.ok, true)
  })
}

test('final closing lint runs with push disabled and no code change', async (t) => {
  const { root } = await fixture(t, 0)
  const arch = path.join(root, 'spec/ssot/ARCH.md')
  await writeFile(arch, (await readFile(arch, 'utf8')).replace('## decisions', '## invalid'))
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'invalid spec')
  const result = await vibeLoop({ targetRoot: root, tag: 'close01', provider: 'codex', maxUnits: 1 }, {
    preflight: passed, execute: () => assert.fail('settled work has no task unit'), push: () => assert.fail('invalid spec cannot publish'),
  })
  assert.equal(result.ok, false); assert.match(result.error, /spec lint 실패/)
  assert.equal(result.reason, 'failed'); assert.equal(result.codePushed, false)
})

test('a rejected close cannot publish valid-todo artifacts when the unit budget ends', async (t) => {
  const { root } = await fixture(t, 1)
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: true\n')
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'publication enabled')
  const result = await vibeLoop({ targetRoot: root, tag: 'close01', provider: 'codex', maxUnits: 1 }, {
    preflight: passed, sync: passed, check: async () => ({ ok: true }),
    push: () => assert.fail('a rejected completion is not final publication'),
    execute: async () => {
      await writeFile(path.join(root, 'app.js'), '// unfinished task\n')
      await git(root, 'add', 'app.js'); await git(root, 'commit', '-qm', 'unfinished implementation')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: 'implementation' } }
    },
  })
  assert.equal(result.ok, false); assert.equal(result.codePushed, false)
  assert.match(result.error, /spec close 실패/)
  assert.deepEqual(result.continuation.pendingRepairTasks, ['T001'])
  const saved = JSON.parse(await readFile(result.manifest, 'utf8'))
  assert.ok(saved.specRejected.T001.length)
  // The originating session can repair the actual artifacts. A later inspection reconciles that
  // evidence without a manufactured completed child report or a second implementation.
  await archiveTask(root, 'T001')
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'originating session repaired close')
  const reconciled = await vibeLoop({ targetRoot: root, tag: 'close01', provider: 'codex', maxUnits: 1 }, {
    preflight: passed, sync: passed, check: async () => ({ ok: true }),
    push: async () => ({ ok: true, pushed: await git(root, 'rev-parse', 'HEAD') }),
    execute: () => assert.fail('valid current artifacts need no new child report'),
  })
  assert.equal(reconciled.ok, true, reconciled.error)
  assert.deepEqual(reconciled.continuation.pendingRepairTasks, [])
  const current = JSON.parse(await readFile(reconciled.manifest, 'utf8'))
  assert.deepEqual(current.specRejected, {})
  assert.ok((await readFile(path.join(path.dirname(reconciled.manifest), 'events.jsonl'), 'utf8')).includes('spec-gate-reconciled'))
})
