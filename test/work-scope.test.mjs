import assert from 'node:assert/strict'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { fixture, git, execute } from './helpers/vibe-fixture.mjs'
import { startWork, configureWork, claimWork, claimNextWork, submitWork, integrateWork, finishWork, workBoard } from '../src/work-groups.mjs'
import { claimReview, finishReview } from '../src/work-review.mjs'
import { nextWork } from '../src/work-wait.mjs'
import { scopedBoard } from '../src/work-policy.mjs'

const cli = fileURLToPath(new URL('../bin/haeram-spec-creator.mjs', import.meta.url))
const checks = ['node --version']
async function setup(t) {
  const result = await fixture(t)
  const root = await realpath(result.root)
  return { root, targetRoot: root }
}

test('approved task scope prevents unrelated claims and finishes on the invoking branch', async (t) => {
  const local = await setup(t)
  const created = await execute(process.execPath, [cli, 'work', 'start', 'approved-local', '--workspace', 'current', '--tasks', 'T001', '--review', 'all', '--push', '-', '--verify', checks[0], '--group-verify', checks[0], '--target', local.root, '--json'])
  const group = JSON.parse(created.stdout)
  assert.equal(group.branch, 'main')
  assert.equal(group.path, local.root)
  assert.equal(group.push, null)
  await assert.rejects(claimWork({ ...local, work: group.id, task: 'T002', owner: 'outside' }))
  const attempt = await claimNextWork({ ...local, work: group.id, owner: 'worker' })
  assert.equal(attempt.taskId, 'T001')
  await assert.rejects(configureWork({ ...local, work: group.id, tasks: 'T002' }))
  const taskFile = path.join(attempt.workspace, 'spec/tasks/T001.example.md')
  const task = (await readFile(taskFile, 'utf8')).replace('- [ ]', '- [v]')
  await writeFile(taskFile, `${task}- outcome: synthetic fixture complete\n- at: -\n- verified: node --version\n- limits: -\n`)
  await writeFile(path.join(attempt.workspace, 'result.txt'), 'approved change\n')
  await git(attempt.workspace, 'add', 'spec/tasks/T001.example.md', 'result.txt')
  await git(attempt.workspace, 'commit', '-q', '-m', 'approved fixture')
  await submitWork({ ...local, attempt: attempt.id, verify: checks })
  await assert.rejects(integrateWork({ ...local, attempt: attempt.id, verify: checks }))
  const review = await claimReview({ ...local, work: group.id, owner: 'independent' })
  await finishReview({ ...local, review: review.id, result: { verdict: 'approved', summary: 'Synthetic fixture reviewed', findings: [] } })
  await integrateWork({ ...local, attempt: attempt.id, verify: checks })
  await finishWork({ ...local, work: group.id, verify: checks })
  const board = await workBoard({ ...local, work: group.id })
  assert.deepEqual(board.tasks, [])
  assert.deepEqual(board.excludedTasks, ['T002', 'T003'])
  assert.equal(board.summary.completed, 1)
  assert.equal((await nextWork({ ...local, work: group.id, owner: 'idle' })).action, 'complete')
  assert.equal(await readFile(path.join(local.root, 'result.txt'), 'utf8'), 'approved change\n')
  const state = await readFile(path.join(local.root, 'spec/STATE.md'), 'utf8')
  assert.ok(state.includes('| T002 |'))
  assert.ok(state.includes('| T003 |'))
  const snapshot = JSON.parse(await readFile(path.join(local.root, 'spec/work/approved-local.json'), 'utf8'))
  assert.deepEqual(snapshot.group.taskScope, ['T001'])
  await configureWork({ ...local, work: group.id, tasks: 'T001 T002' })
  assert.deepEqual((await workBoard({ ...local, work: group.id })).tasks.map((task) => task.id), ['T002'])
})

test('approval scope preserves external dependencies and refuses split lanes or unknown tasks', async (t) => {
  const task = (id, lane, deps = []) => ({ id, lane, deps })
  const board = { tasks: [task('T001', 'shared'), task('T002', 'shared'), task('T003', null, ['T001'])], doneIds: [] }
  assert.throws(() => scopedBoard(board, { taskScope: ['T001'] }))
  assert.throws(() => scopedBoard(board, { taskScope: ['T999'] }))
  assert.throws(() => scopedBoard(board, { taskScope: [] }))
  const local = await setup(t)
  const file = path.join(local.root, 'spec/tasks/T003.example.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('dep:-', 'dep:T001'))
  const state = path.join(local.root, 'spec/STATE.md')
  await writeFile(state, (await readFile(state, 'utf8')).replace('| T003 | example | ARCH | - | todo |', '| T003 | example | ARCH | T001 | todo |'))
  await git(local.root, 'add', 'spec')
  await git(local.root, 'commit', '-q', '-m', 'external dependency')
  const group = await startWork({ ...local, name: 'dependency-scope', workspace: 'current', tasks: ['T003'], verify: checks })
  assert.equal((await claimNextWork({ ...local, work: group.id, owner: 'worker' })).idle, true)
  assert.deepEqual((await workBoard({ ...local, work: group.id })).units[0].waitingOn, ['T001'])
  await assert.rejects(finishWork({ ...local, work: group.id, verify: checks }))
})
