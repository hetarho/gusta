import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { startWork, claimNextWork, submitWork, finishWork, workBoard, workHistory } from '../src/work-groups.mjs'
import { nextWork } from '../src/work-wait.mjs'
import { finishReview } from '../src/work-review.mjs'
import { git, checkFile, laneFixture, complete, deliver } from './helpers/work-fixture.mjs'

test('lane은 한 공간에서 순서대로 구현하고 lane 단위로 리뷰·통합한다', async (t) => {
  const setup = await laneFixture(t, [['T001', '-', '-'], ['T002', 'T001', 'a'], ['T003', 'T002', 'a'], ['T004', 'T001', 'b'], ['T005', 'T003 T004', '-']])
  const group = await startWork({ ...setup, name: 'lanes' })
  let board = await workBoard({ ...setup, work: group.id })
  assert.deepEqual(board.units.map((unit) => [unit.key, unit.waitingOn, unit.claimable]), [
    ['T001', [], true], ['lane:a', ['T001'], false], ['lane:b', ['T001'], false], ['T005', ['T003', 'T004'], false]])
  const base = await claimNextWork({ ...setup, work: group.id, owner: 'a' })
  assert.deepEqual(base.tasks, ['T001'])
  assert.equal((await claimNextWork({ ...setup, work: group.id, owner: 'b' })).reason, 'no-eligible-task')
  await complete(base.workspace, 'T001')
  await submitWork({ ...setup, attempt: base.id, verify: [checkFile('T001.txt')] })
  await deliver(setup, base, [checkFile('T001.txt')])

  const laneA = await claimNextWork({ ...setup, work: group.id, owner: 'a' })
  assert.deepEqual([laneA.lane, laneA.tasks, laneA.taskId], ['a', ['T002', 'T003'], 'T002'])
  assert.match(laneA.branch, /^lane\/lanes\/a-/)
  const laneB = await claimNextWork({ ...setup, work: group.id, owner: 'b' })
  assert.deepEqual(laneB.tasks, ['T004'])
  const first = await complete(laneA.workspace, 'T002')
  // No host check at a lane step: the worker's impact-selected tests stay its evidence.
  const step = await submitWork({ ...setup, attempt: laneA.id })
  assert.deepEqual([step.status, step.taskId, step.steps.map((entry) => entry.commit)], ['doing', 'T003', [first]])
  assert.equal((await workBoard({ ...setup, work: group.id })).tasks.find((entry) => entry.id === 'T003').runtimeStatus, 'doing')
  await assert.rejects(submitWork({ ...setup, attempt: laneA.id }), /T003: .*acceptance/)
  const last = await complete(laneA.workspace, 'T003')
  const ready = await submitWork({ ...setup, attempt: laneA.id, verify: [checkFile('T003.txt')] })
  assert.deepEqual([ready.status, ready.verifiedCommit], ['ready', last])
  const integrated = await deliver(setup, laneA, [checkFile('T002.txt'), checkFile('T003.txt')])
  assert.match(await git(group.path, 'log', '-1', '--format=%s').then((out) => out.stdout), /Integrate lane a \(T002 T003\)/)
  const archived = await readFile(path.join(group.path, 'spec/tasks/done/T002.lane.md'), 'utf8')
  assert.match(archived, new RegExp(`at: ${first}`))
  assert.match(archived, /verified: worker ran T002 tests; integration "node -e/)
  assert.match(await readFile(path.join(group.path, 'spec/tasks/done/T003.lane.md'), 'utf8'), new RegExp(`at: ${last}\\n- verified: "node -e .*T003.txt.*; integration`))
  const state = await readFile(path.join(group.path, 'spec/STATE.md'), 'utf8')
  assert.ok(!/\| T00[23] \|/.test(state))
  assert.match(state, /- \d{6} T002 T003 integrated/)
  assert.equal(integrated.status, 'integrated')

  await complete(laneB.workspace, 'T004')
  await submitWork({ ...setup, attempt: laneB.id })
  await deliver(setup, laneB, [checkFile('T004.txt')])
  const last5 = await claimNextWork({ ...setup, work: group.id, owner: 'c' })
  assert.deepEqual(last5.tasks, ['T005'])
  await assert.rejects(finishWork({ ...setup, work: group.id, verify: [checkFile('T001.txt')] }), /통합되지 않은/)
  await complete(last5.workspace, 'T005')
  await submitWork({ ...setup, attempt: last5.id })
  await deliver(setup, last5, [checkFile('T005.txt')])
  assert.equal((await nextWork({ ...setup, work: group.id, owner: 'x' })).action, 'complete')
  await assert.rejects(finishWork({ ...setup, work: group.id, verify: [checkFile('missing.txt')] }), /검증 실패/)
  const finished = await finishWork({ ...setup, work: group.id, verify: ['T001.txt', 'T002.txt', 'T003.txt', 'T004.txt', 'T005.txt'].map(checkFile) })
  assert.equal(finished.snapshotError, undefined)
  board = await workBoard({ ...setup, work: group.id })
  assert.equal(board.verified.commit, finished.verified.commit)
  assert.equal(board.verified.current, true)
  assert.equal(JSON.parse(await readFile(path.join(group.path, 'spec/work/lanes.json'), 'utf8')).group.verified.commit, finished.verified.commit)
  const { history } = await workHistory({ ...setup, work: group.id, task: 'T003' })
  assert.ok(history.some((entry) => entry.attemptId === laneA.id && entry.status === 'integrated'))
})

test('서로 기다리는 lane 계획은 배정 전에 거부한다', async (t) => {
  // The reported deadlock: T009 (lane c) waits for T005 (lane b), and T006 (lane b) waits for T009.
  const setup = await laneFixture(t, [['T005', '-', 'b'], ['T006', 'T009', 'b'], ['T009', 'T005', 'c']])
  const group = await startWork({ ...setup, name: 'deadlock' })
  const board = await workBoard({ ...setup, work: group.id })
  assert.ok(board.errors.some((error) => error.includes('lane 순환')), JSON.stringify(board.errors))
  await assert.rejects(claimNextWork({ ...setup, work: group.id, owner: 'a' }), /태스크\/STATE/)
})

test('세션 루프: 기반 → 리뷰 → 백그라운드 통합 → 줄기 분담 → 묶음 검증까지 자동으로 진행한다', async (t) => {
  const setup = await laneFixture(t, [['T001', '-', '-'], ['T002', 'T001', 'a'], ['T003', 'T002', 'a'], ['T004', 'T001', 'b'], ['T005', 'T003 T004', '-']])
  const log = path.join(setup.temporary, 'tiers.log')
  const record = `node -e "require('fs').appendFileSync('${log}', [process.env.GUSTA_TIER, process.env.GUSTA_TASK || '-', process.env.GUSTA_DIFF_BASE].join(' ') + String.fromCharCode(10))"`
  const tiers = { taskVerify: [record], verify: [record], groupVerify: [record, checkFile('T005.txt')], reviewers: 2 }
  const session = (owner, extra = {}) => nextWork({ ...setup, owner, pollMs: 100, ...extra })
  const review = async (assignment) => {
    assert.equal(assignment.action, 'review', JSON.stringify(assignment))
    await finishReview({ ...setup, review: assignment.review.id, result: { verdict: 'approved', summary: 'reviewed', findings: [] } })
  }
  // A lane is implemented to its last task and submitted once.
  const deliver = async (attempt) => {
    for (const id of attempt.tasks) await complete(attempt.workspace, id)
    const submitted = await submitWork({ ...setup, attempt: attempt.id })
    assert.equal(submitted.status, 'ready')
    return submitted
  }

  // Session A starts the group from the main checkout and takes the foundation first.
  const first = await session('a', { start: true, ...tiers })
  assert.deepEqual([first.action, first.attempt.tasks], ['implement', ['T001']])
  const work = first.work
  assert.equal((await session('b')).reason, 'no-eligible-task')
  await deliver(first.attempt)
  const alone = await session('a', { wait: 60 })
  assert.deepEqual([alone.action, alone.reason], ['wait', 'needs-reviewer'])
  // Session B reviews the foundation; the CLI integrates it in the background.
  await review(await session('b', { wait: 60 }))
  const ofB = await session('b', { wait: 120 })
  const ofA = await session('a', { wait: 60 })
  assert.deepEqual([ofB.attempt.lane, ofA.attempt.lane], ['a', 'b'])
  const readyA = await deliver(ofB.attempt)
  await deliver(ofA.attempt)
  await review(await session('a', { wait: 60 }))
  await review(await session('b', { wait: 60 }))
  // Both lanes integrate one after the other; the second approval survives the first.
  const last = await session('a', { wait: 180 })
  assert.deepEqual(last.attempt.tasks, ['T005'])
  await deliver(last.attempt)
  await review(await session('b', { wait: 60 }))
  const done = await session('a', { wait: 180 })
  assert.equal(done.action, 'complete', JSON.stringify(done))
  assert.equal(done.verified.current, true)
  assert.equal((await session('b')).action, 'complete')

  const board = await workBoard({ ...setup, work })
  assert.deepEqual(board.doneIds, ['T001', 'T002', 'T003', 'T004', 'T005'])
  assert.ok(board.attempts.every((entry) => entry.status === 'integrated' && !entry.reviewHistory), JSON.stringify(board.attempts.map((entry) => [entry.status, entry.reason, entry.reviewHistory])))
  const lines = (await readFile(log, 'utf8')).trim().split('\n').map((line) => line.split(' '))
  assert.deepEqual(readyA.steps.map((entry) => [entry.taskId, entry.commit]), [['T002', readyA.verifiedCommit], ['T003', readyA.verifiedCommit]])
  assert.ok(lines.some(([tier, id, base]) => tier === 'task' && id === 'T003' && base === ofB.attempt.startCommit), JSON.stringify(lines))
  assert.equal(lines.filter(([tier]) => tier === 'task').length, 4)
  assert.equal(lines.filter(([tier]) => tier === 'unit').length, 4)
  assert.deepEqual(lines.filter(([tier]) => tier === 'group').map(([, , base]) => base), [board.group.baseCommit])
})
