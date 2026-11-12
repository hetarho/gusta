import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, archiveTask, execute } from './helpers/vibe-fixture.mjs'
import { upsertActive, closeTasks, activeRows } from '../src/state-doc.mjs'
import { vibeStatus, vibeClaim } from '../src/vibe.mjs'
import { vibeLoop } from '../src/vibe-loop.mjs'

const tag = 'bbbb'
const passed = async () => ({ ok: true, checks: [] })
const deps = { preflight: passed, monitor: passed, check: passed, prune: passed, push: passed }
const options = (root) => ({ targetRoot: root, tag, provider: 'codex', maxUnits: 4 })
async function setOwner(root, { row = 'todo', file = 'done', active, stale = false } = {}) {
  const stateFile = path.join(root, 'spec/STATE.md')
  let state = (await readFile(stateFile, 'utf8')).replace('| T001 | example | ARCH | - | todo |', `| T001 | example | ARCH | - | ${row} |`)
  if (active) {
    const at = new Date(Date.now() - (stale ? 3 * 3600000 : 0)).toISOString()
    state = upsertActive(state, { tag: active, host: 'other-host', mode: 'autopilot', since: at, at, doing: 'T001' })
  }
  await writeFile(stateFile, state)
  const task = path.join(root, 'spec/tasks/T001.example.md')
  await writeFile(task, (await readFile(task, 'utf8')).replace('st:todo', `st:${file}`))
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'task ownership and invalid close')
}
async function archiveWithActive(root, id) {
  await archiveTask(root, id)
  const file = path.join(root, 'spec/STATE.md')
  await writeFile(file, closeTasks(await readFile(file, 'utf8'), [id]).text)
}

for (const [name, owner, repair] of [
  ['another live claim', { row: 'doing@261112.aaaa', active: 'aaaa' }, false],
  ['another stale claim', { row: 'doing@261112.aaaa', active: 'aaaa', stale: true }, false],
  ['an orphan claim', { row: 'doing@261112.aaaa' }, false],
  ['a file owner behind an invalid STATE status', { row: 'done', file: 'doing@261112.aaaa' }, false],
  ['another active session with malformed statuses', { row: 'done', active: 'aaaa' }, false],
  ['this session claim', { row: 'doing@261112.bbbb' }, true],
  ['an unclaimed task with a stale active row', { active: 'aaaa', stale: true }, true],
]) test(`spec repair respects ${name}`, async (t) => {
  const { root } = await fixture(t, 1)
  await setOwner(root, owner)
  const before = await readFile(path.join(root, 'spec/tasks/T001.example.md'), 'utf8')
  const jobs = []
  const result = await vibeLoop(options(root), { ...deps, execute: async (_config, job) => {
    jobs.push(job)
    await archiveWithActive(root, 'T001')
    await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'repair task close')
    return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: 'implementation' } }
  } })
  assert.equal(jobs.length, repair ? 1 : 0)
  if (repair) {
    assert.equal(result.ok, true, result.error)
    assert.equal(jobs[0].recovery.reason, 'spec-gate')
  } else {
    assert.equal(result.ok, false)
    assert.match(result.error, /spec (lint|close) 실패/)
    assert.equal(await readFile(path.join(root, 'spec/tasks/T001.example.md'), 'utf8'), before)
    const saved = JSON.parse(await readFile(result.manifest, 'utf8'))
    assert.deepEqual(saved.specRepairs, {})
  }
})

test('an unavailable spec repair leaves another task runnable without an unscoped planning unit', async (t) => {
  const { root } = await fixture(t, 2)
  await setOwner(root, { row: 'doing@261112.aaaa', active: 'aaaa' })
  const jobs = []
  const result = await vibeLoop(options(root), { ...deps, execute: async (_config, job) => {
    jobs.push(job.brief?.taskId)
    assert.equal(job.brief.taskId, 'T002')
    await archiveTask(root, 'T002')
    await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'complete available task')
    return { exitCode: 0, result: { kind: 'task', id: 'T002', outcome: 'completed', pushed: false, next: 'implementation' } }
  } })
  assert.deepEqual(jobs, ['T002'])
  assert.equal(result.ok, false)
  assert.match(await readFile(path.join(root, 'spec/STATE.md'), 'utf8'), /T001.*doing@261112\.aaaa/)
})

test('spec repair rechecks ownership after a strict repair claim merges a newer owner', async (t) => {
  const { root } = await fixture(t, 1)
  await setOwner(root, { row: 'done' })
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: true\n')
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'publication enabled')
  let claims = 0, units = 0
  const result = await vibeLoop(options(root), { ...deps, sync: passed,
    status: async (config) => ({ ...await vibeStatus(config), concurrency: 'strict' }),
    claim: async (config) => {
      claims++
      assert.equal(config.task, 'T001'); assert.equal(config.repairTask, true)
      const stateFile = path.join(root, 'spec/STATE.md')
      let state = (await readFile(stateFile, 'utf8')).replace('| T001 | example | ARCH | - | done |', '| T001 | example | ARCH | - | doing@261112.aaaa |')
      const at = new Date().toISOString()
      state = upsertActive(state, { tag: 'aaaa', host: 'other-host', mode: 'autopilot', since: at, at, doing: 'T001' })
      await writeFile(stateFile, state)
      await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'merge newer task owner')
      return { ok: true }
    },
    execute: async () => { units++; assert.fail('the newer owner retains the repair') },
  })
  assert.equal(claims, 1); assert.equal(units, 0)
  assert.equal(result.ok, false)
  assert.match(await readFile(path.join(root, 'spec/STATE.md'), 'utf8'), /T001.*doing@261112\.aaaa/)
})

test('a resumed rejected close cannot repair a task now claimed by another session', async (t) => {
  const { root } = await fixture(t, 1)
  const config = { ...options(root), maxUnits: 1 }
  const first = await vibeLoop(config, { ...deps, execute: async () => ({ exitCode: 0,
    result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: 'implementation' } }) })
  assert.equal(first.ok, false)
  await setOwner(root, { row: 'doing@261112.aaaa', file: 'doing@261112.aaaa', active: 'aaaa' })
  const resumed = await vibeLoop(config, { ...deps, execute: () => assert.fail('another session owns the persisted repair') })
  assert.equal(resumed.ok, false)
  assert.deepEqual(resumed.continuation.pendingRepairTasks, ['T001'])
  assert.match(await readFile(path.join(root, 'spec/STATE.md'), 'utf8'), /T001.*doing@261112\.aaaa/)
})

for (const stale of [false, true]) test(`a malformed local close cannot take a remote claim with ${stale ? 'stale' : 'missing'} active presence`, async (t) => {
  const { root, temporary } = await fixture(t, 1)
  await setOwner(root, { row: 'doing@261112.aaaa', file: 'doing@261112.aaaa', ...(stale ? { active: 'aaaa', stale: true } : {}) })
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: true\n')
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'publication enabled')
  const remote = path.join(temporary, 'remote.git')
  await execute('git', ['init', '-q', '--bare', remote])
  await git(root, 'remote', 'add', 'origin', remote)
  await git(root, 'push', '-qu', 'origin', 'main')
  for (const relative of ['spec/STATE.md', 'spec/tasks/T001.example.md']) {
    const file = path.join(root, relative)
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll('doing@261112.aaaa', 'done'))
  }
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'malformed local close')
  const status = await vibeStatus({ targetRoot: root, tag, fetch: false })
  assert.equal(status.concurrency, 'strict')
  assert.deepEqual(status.orphanDoing.map(({ id, tag: owner }) => [id, owner]), [['T001', 'aaaa']])
  let claims = 0, units = 0
  const result = await vibeLoop(options(root), { ...deps, sync: passed,
    claim: async (config) => { claims++; return vibeClaim(config) },
    execute: async () => { units++; assert.fail('remote doing ownership survives the local close') },
  })
  assert.equal(claims, 0); assert.equal(units, 0)
  assert.equal(result.ok, false)
  const published = await git(root, 'show', 'origin/main:spec/STATE.md')
  assert.match(published, /T001.*doing@261112\.aaaa/)
})

for (const remoteSt of ['todo', 'done']) test(`a spec repair reserves a remote ${remoteSt} task against ordinary and repair workers`, async (t) => {
  const { root, temporary } = await fixture(t, 1)
  const stateFile = path.join(root, 'spec/STATE.md')
  const at = new Date().toISOString()
  await writeFile(stateFile, upsertActive(await readFile(stateFile, 'utf8'), { tag: 'aaaa', host: 'other-host', mode: 'autopilot', since: at, at, doing: '-' }))
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: true\n')
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'unclaimed task and concurrent session')
  if (remoteSt === 'done') await setOwner(root, { row: 'done' })
  const remote = path.join(temporary, 'remote.git')
  await execute('git', ['init', '-q', '--bare', remote])
  await git(root, 'remote', 'add', 'origin', remote)
  await git(root, 'push', '-qu', 'origin', 'main')
  if (remoteSt === 'todo') await setOwner(root, { row: 'done' })
  const claims = []
  let units = 0
  const result = await vibeLoop({ ...options(root), maxUnits: 1 }, { ...deps, sync: passed,
    claim: async (config) => { claims.push(config.task); return vibeClaim(config) },
    execute: async () => {
      units++
      const remoteState = await git(root, 'show', 'origin/main:spec/STATE.md')
      assert.match(remoteState, new RegExp(`T001.*${remoteSt}`))
      assert.equal(activeRows(remoteState).find((row) => row.tag === tag)?.doing, 'T001')
      await assert.rejects(vibeClaim({ targetRoot: root, tag: 'aaaa', task: 'T001' }), /다른 세션이 선점/)
      await assert.rejects(vibeClaim({ targetRoot: root, tag: 'aaaa', task: 'T001', repairTask: true }), /다른 세션이 선점/)
      await archiveWithActive(root, 'T001')
      await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'repair task close')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: 'implementation' } }
    },
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(units, 1)
  assert.deepEqual(claims, ['T001'])
})
